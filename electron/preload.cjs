// Bridge between the sandboxed renderer and the main process:
// - receiving .md files opened via file association / Explorer
// - writing those files back (live save), restricted in main to paths it
//   handed out itself
const { contextBridge, ipcRenderer } = require('electron')
const isE2E = ipcRenderer.sendSync('knote:e2e-status') === true
let brokerRequestSequence = 0
const nextBrokerRequestId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++brokerRequestSequence).toString(36)}`
const abortError = () => {
  const error = new Error('The broker request was aborted.')
  error.name = 'AbortError'
  return error
}
const brokerOptions = (value) => {
  if (typeof value === 'string') return { id: value, signal: null }
  if (value && typeof value.addEventListener === 'function' && typeof value.aborted === 'boolean') {
    return { id: '', signal: value }
  }
  return {
    id: typeof value?.id === 'string' ? value.id : '',
    signal: value?.signal && typeof value.signal.addEventListener === 'function' ? value.signal : null
  }
}
const invokeCancelableBroker = (channel, cancelChannel, payload, options, prefix) => {
  const normalized = brokerOptions(options)
  const id = normalized.id || (typeof payload.id === 'string' && payload.id) || nextBrokerRequestId(prefix)
  const request = { ...payload, id }
  const signal = normalized.signal
  if (signal?.aborted) return Promise.reject(abortError())
  const invocation = ipcRenderer.invoke(channel, request)
  if (!signal) return invocation
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn(value)
    }
    const onAbort = () => {
      void ipcRenderer.invoke(cancelChannel, { id }).catch(() => false)
      finish(reject, abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    invocation.then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error)
    )
  })
}
const activeAgentDownloads = new Map()
const invokeTrackedAgentDownload = (payload) => {
  const id = typeof payload.id === 'string' && payload.id ? payload.id : nextBrokerRequestId('agent-download')
  const entry = { id, done: null }
  const invocation = ipcRenderer.invoke('knote:agent-download', { ...payload, id })
  entry.done = invocation.finally(() => {
    if (activeAgentDownloads.get(id) === entry) activeAgentDownloads.delete(id)
  })
  activeAgentDownloads.set(id, entry)
  return entry.done
}
const cancelTrackedAgentDownload = async (idValue) => {
  const id = typeof idValue === 'string' ? idValue : ''
  const entry = activeAgentDownloads.get(id)
  await ipcRenderer.invoke('knote:agent-download-cancel', { id }).catch(() => false)
  if (!entry) return false
  let result
  try {
    result = await entry.done
  } catch {
    throw abortError()
  }
  if (result?.ok === true) return result
  throw abortError()
}

contextBridge.exposeInMainWorld('knoteDesktop', {
  isE2E,
  onOpenFile: (cb) => {
    ipcRenderer.on('knote:open-file', (_e, payload) => cb(payload))
  },
  // folder dropped onto the Knote icon / opened via argv
  onOpenFolder: (cb) => {
    ipcRenderer.on('knote:open-folder', (_e, payload) => cb(payload))
  },
  writeFile: (path, data) => ipcRenderer.invoke('knote:write-file', { path, data }),
  // folder-workspace fs (main confines every path to registered roots)
  fsList: (dir) => ipcRenderer.invoke('knote:fs-list', { dir }),
  fsRead: (path) => ipcRenderer.invoke('knote:fs-read', { path }),
  fsReadChunk: (path, offset, length, expected = {}) => ipcRenderer.invoke('knote:fs-read-chunk', {
    path,
    offset,
    length,
    expectedSize: expected.size,
    expectedMtimeMs: expected.mtimeMs
  }),
  fsExists: (path) => ipcRenderer.invoke('knote:fs-exists', { path }),
  // mtime probe for the external-change watcher (cheap change detection)
  fsStat: (path) => ipcRenderer.invoke('knote:fs-stat', { path }),
  readImageFile: (path) => ipcRenderer.invoke('knote:read-image-file', { path }),
  readFileBytes: (path) => ipcRenderer.invoke('knote:read-file-bytes', { path }),
  writeImageFile: (path, base64) => ipcRenderer.invoke('knote:write-image-file', { path, base64 }),
  // pick any local file with a native dialog and copy it into the current
  // doc's assets/ folder (or a user-chosen target folder from the restricted
  // attachment tree); returns { canceled } or { relative, name }
  importAttachment: (dir, target = '', sourceToken = '') => ipcRenderer.invoke('knote:import-attachment', { dir, target, source: sourceToken }),
  // pick any local file WITHOUT copying: returns its absolute path so the
  // renderer can insert a markdown link that references the file in place
  pickFileToLink: () => ipcRenderer.invoke('knote:pick-file-to-link'),
  // destination folders for an attachment copy, restricted to the document's
  // file tree (main validates every entry against the writable roots)
  attachmentDirs: (dir) => ipcRenderer.invoke('knote:attachment-dirs', { dir }),
  // pick the SOURCE file for an attachment copy (no copy yet)
  pickImportFile: (dir, target = '') => ipcRenderer.invoke('knote:pick-import-file', { dir, target }),
  // last-chosen attachment folder per document directory (persisted to disk)
  attachmentTargetGet: (dir) => ipcRenderer.invoke('knote:attachment-target-get', { dir }),
  attachmentTargetSet: (dir, target) => ipcRenderer.invoke('knote:attachment-target-set', { dir, target }),
  // create / rename attachment destination folders (restricted like the tree)
  attachmentMkdir: (dir, parent, name) => ipcRenderer.invoke('knote:attachment-mkdir', { dir, parent, name }),
  attachmentRenameDir: (dir, target, name) => ipcRenderer.invoke('knote:attachment-rename-dir', { dir, target, name }),
  // PDF layout sidecar (PaddleOCR / PP-Structure)
  pickOpen: (kind) => ipcRenderer.invoke('knote:pick-open', { kind }),
  pickSave: (defaultName) => ipcRenderer.invoke('knote:pick-save', { defaultName }),
  // Native web access uses the OS proxy. The optional final argument is
  // { id, signal }; AbortSignal stays in preload while only its request id
  // crosses IPC, and abort invokes main's real network-cancel endpoint.
  webSearch: (query, max, engine, region, options = {}) => invokeCancelableBroker(
    'knote:web-search',
    'knote:web-request-cancel',
    { query, max, engine, region },
    options,
    'web-search'
  ),
  webFetch: (url, max, options = {}) => invokeCancelableBroker(
    'knote:web-fetch',
    'knote:web-request-cancel',
    { url, max },
    options,
    'web-fetch'
  ),
  webRequestCancel: (id) => ipcRenderer.invoke('knote:web-request-cancel', { id }),
  // document text extraction (docx/pptx/xlsx) — runs in main process (Node.js)
  extractDoc: (name, bytes) => ipcRenderer.invoke('knote:extract-doc', { name, bytes }),
  pdfSidecarStatus: () => ipcRenderer.invoke('knote:pdf-sidecar-status'),
  pdfAnalyze: (imageBase64, minScore, mode) => ipcRenderer.invoke('knote:pdf-analyze', { imageBase64, minScore, mode }),
  // one-click environment install / reinstall / uninstall (streams progress)
  pdfEnvStatus: () => ipcRenderer.invoke('knote:pdf-env-status'),
  pdfEnvInstall: (opts) => ipcRenderer.invoke('knote:pdf-env-install', opts || {}),
  pdfEnvUninstall: () => ipcRenderer.invoke('knote:pdf-env-uninstall'),
  // user-configurable env dir / python interpreter (empty = defaults)
  pdfEnvGetConfig: () => ipcRenderer.invoke('knote:pdf-env-config-get'),
  pdfEnvSetConfig: (cfg) => ipcRenderer.invoke('knote:pdf-env-config-set', cfg || {}),
  onPdfEnvProgress: (cb) => {
    const h = (_e, line) => cb(line)
    ipcRenderer.on('knote:pdf-env-progress', h)
    return () => ipcRenderer.removeListener('knote:pdf-env-progress', h)
  },
  fsWrite: (path, data) => ipcRenderer.invoke('knote:fs-write', { path, data }),
  fsWriteIfUnchanged: (path, data, expectedContent) => ipcRenderer.invoke('knote:fs-write-if-unchanged', { path, data, expectedContent }),
  fsCreate: (path) => ipcRenderer.invoke('knote:fs-create', { path }),
  fsCreateExclusive: (path, data) => ipcRenderer.invoke('knote:fs-create-exclusive', { path, data }),
  fsDelete: (path) => ipcRenderer.invoke('knote:fs-delete', { path }),
  fsMkdir: (path) => ipcRenderer.invoke('knote:fs-mkdir', { path }),
  fsRename: (from, to) => ipcRenderer.invoke('knote:fs-rename', { from, to }),
  // Host process execution is forbidden. This becomes true only after a fixed,
  // attested AppContainer runtime bundle is installed and verified by main.
  agentCommandEnabled: false,
  agentCommandRun: (request) => ipcRenderer.invoke('knote:agent-command-run', request || {}),
  agentCommandCancel: (id) => ipcRenderer.invoke('knote:agent-command-cancel', { id }),
  // The Chromium task prototype is deliberately unavailable: its no-network
  // boundary cannot be proven. Main independently rejects direct IPC calls.
  agentSandboxEnabled: false,
  agentSandboxCapabilities: () => ipcRenderer.invoke('knote:agent-sandbox-capabilities', {}),
  agentSandboxStart: (owner, request) => ipcRenderer.invoke('knote:agent-sandbox-start', { owner, request }),
  agentSandboxStatus: (owner, taskId) => ipcRenderer.invoke('knote:agent-sandbox-status', { owner, taskId }),
  agentSandboxWait: (owner, taskId, waitMs) => ipcRenderer.invoke('knote:agent-sandbox-wait', { owner, taskId, waitMs }),
  agentSandboxCancel: (owner, taskId) => ipcRenderer.invoke('knote:agent-sandbox-cancel', { owner, taskId }),
  // Main independently validates the opaque folder grant, URL policy, type,
  // optional caller limit and exclusive destination. Cancellation waits for
  // main's cleanup; only an already committed verified publication wins.
  agentDownload: (request = {}) => invokeTrackedAgentDownload({
    id: request.id,
    url: request.url,
    workspaceGrantId: request.workspaceGrantId,
    relativePath: request.relativePath,
    maxBytes: request.maxBytes === undefined ? null : request.maxBytes,
    ...(typeof request.resumeId === 'string' && request.resumeId ? { resumeId: request.resumeId } : {})
  }),
  agentDownloadCancel: (id) => cancelTrackedAgentDownload(id),
  agentDownloadStatus: (resumeId, workspaceGrantId) => ipcRenderer.invoke('knote:agent-download-status', { resumeId, workspaceGrantId }),
  agentDownloadListAvailable: (workspaceGrantId) => ipcRenderer.invoke('knote:agent-download-list-available', { workspaceGrantId }),
  agentDownloadDiscard: (resumeId, workspaceGrantId) => ipcRenderer.invoke('knote:agent-download-discard', { resumeId, workspaceGrantId }),
  // Immutable, disk-backed document history. The main process stores this
  // under Electron userData, outside the replaceable installation directory.
  historyAdd: (identity, content, time, label) => ipcRenderer.invoke('knote:history-add', { identity, content, time, label }),
  historyList: (identity) => ipcRenderer.invoke('knote:history-list', { identity }),
  historyGet: (identity, id) => ipcRenderer.invoke('knote:history-get', { identity, id }),
  // Signed, app-private swap space for inactive editor tabs. The opaque ref
  // can only be consumed by the matching store; no filesystem path crosses
  // the sandbox boundary.
  tabBufferPut: (sessionId, tabId, content) => ipcRenderer.invoke('knote:tab-buffer-put', { sessionId, tabId, content }),
  tabBufferGet: (ref) => ipcRenderer.invoke('knote:tab-buffer-get', { ref }),
  tabBufferDrop: (ref) => ipcRenderer.invoke('knote:tab-buffer-drop', { ref }),
  tabBufferClearSession: (sessionId) => ipcRenderer.invoke('knote:tab-buffer-clear-session', { sessionId }),
  trash: (path, expected = null) => ipcRenderer.invoke('knote:trash', { path, expected }),
  reveal: (path) => ipcRenderer.invoke('knote:reveal', { path }),
  // open a workspace file with the OS default application (office docs)
  openPath: (path) => ipcRenderer.invoke('knote:open-path', { path }),
  reopen: (type, capability, requestId = '') => ipcRenderer.invoke('knote:reopen', { type, capability, requestId }),
  exportPdf: (defaultName) => ipcRenderer.invoke('knote:export-pdf', { defaultName }),
  // context-menu clipboard channel (navigator.clipboard permissions are
  // unreliable in the sandboxed shell)
  readClipboard: () => ipcRenderer.invoke('knote:clipboard-read-text'),
  writeClipboard: (text) => ipcRenderer.invoke('knote:clipboard-write-text', { text }),
  readClipboardImage: () => ipcRenderer.invoke('knote:clipboard-read-image'),
  readClipboardHtml: () => ipcRenderer.invoke('knote:clipboard-read-html'),
  writeClipboardImage: (dataUrl) => ipcRenderer.invoke('knote:clipboard-write-image', { dataUrl }),
  // Ctrl+wheel UI zoom — main applies Chromium-native zoom AND resizes the
  // native window-buttons strip to match the scaled title bar
  setZoom: (factor) => ipcRenderer.invoke('knote:ui-zoom', { factor }),
  setTitlebarTheme: (dark) => ipcRenderer.invoke('knote:titlebar-theme', { dark: dark === true }),
  // The renderer changes the animated title-bar treatment only while the
  // window is restored; maximized/fullscreen uses the quiet solid surface.
  getWindowState: () => ipcRenderer.invoke('knote:window-state'),
  onWindowState: (cb) => {
    const h = (_e, state) => cb(state)
    ipcRenderer.on('knote:window-state', h)
    return () => ipcRenderer.removeListener('knote:window-state', h)
  },
  // Main holds app.quit() until this async renderer barrier has flushed the
  // live editor, autosave queues and disk-backed tab residency. The nonce is
  // echoed verbatim; main additionally validates event.sender.
  onPrepareQuit: (cb) => {
    const h = async (_e, payload = {}) => {
      let result = { ok: true, recovered: 0 }
      try {
        const value = await cb(payload)
        if (value && typeof value === 'object') result = { ...result, ...value }
      } catch (error) {
        console.error('[renderer-quit-flush]', error)
        result.ok = false
      }
      ipcRenderer.send('knote:renderer-quit-ready', { token: String(payload.token || ''), ...result })
    }
    ipcRenderer.on('knote:prepare-quit', h)
    return () => ipcRenderer.removeListener('knote:prepare-quit', h)
  },
  onQuitCancelled: (cb) => {
    const h = () => cb()
    ipcRenderer.on('knote:quit-cancelled', h)
    return () => ipcRenderer.removeListener('knote:quit-cancelled', h)
  },
  // handshake: main holds the startup file until the app is mounted
  ready: () => ipcRenderer.send('knote:renderer-ready')
})
