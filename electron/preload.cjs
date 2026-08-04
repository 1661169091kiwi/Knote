// Bridge between the sandboxed renderer and the main process:
// - receiving .md files opened via file association / Explorer
// - writing those files back (live save), restricted in main to paths it
//   handed out itself
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('knoteDesktop', {
  isE2E: process.env.KNOTE_E2E === '1',
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
  // PDF layout sidecar (PaddleOCR / PP-Structure)
  pickOpen: (kind) => ipcRenderer.invoke('knote:pick-open', { kind }),
  pickSave: (defaultName) => ipcRenderer.invoke('knote:pick-save', { defaultName }),
  // native web search / fetch — uses the user's own network (OS proxy), no Jina
  webSearch: (query, max, engine, region) => ipcRenderer.invoke('knote:web-search', { query, max, engine, region }),
  webFetch: (url, max) => ipcRenderer.invoke('knote:web-fetch', { url, max }),
  // document text extraction (docx/pptx/xlsx) — runs in main process (Node.js)
  extractDoc: (name, bytes) => ipcRenderer.invoke('knote:extract-doc', { name, bytes }),
  pdfSidecarStatus: () => ipcRenderer.invoke('knote:pdf-sidecar-status'),
  pdfAnalyze: (imageBase64, minScore, mode) => ipcRenderer.invoke('knote:pdf-analyze', { imageBase64, minScore, mode }),
  // one-click environment install / reinstall / uninstall (streams progress)
  pdfEnvStatus: () => ipcRenderer.invoke('knote:pdf-env-status'),
  pdfEnvInstall: (opts) => ipcRenderer.invoke('knote:pdf-env-install', opts || {}),
  pdfEnvUninstall: () => ipcRenderer.invoke('knote:pdf-env-uninstall'),
  onPdfEnvProgress: (cb) => {
    const h = (_e, line) => cb(line)
    ipcRenderer.on('knote:pdf-env-progress', h)
    return () => ipcRenderer.removeListener('knote:pdf-env-progress', h)
  },
  fsWrite: (path, data) => ipcRenderer.invoke('knote:fs-write', { path, data }),
  fsCreate: (path) => ipcRenderer.invoke('knote:fs-create', { path }),
  fsDelete: (path) => ipcRenderer.invoke('knote:fs-delete', { path }),
  fsMkdir: (path) => ipcRenderer.invoke('knote:fs-mkdir', { path }),
  fsRename: (from, to) => ipcRenderer.invoke('knote:fs-rename', { from, to }),
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
  trash: (path) => ipcRenderer.invoke('knote:trash', { path }),
  reveal: (path) => ipcRenderer.invoke('knote:reveal', { path }),
  // open a workspace file with the OS default application (office docs)
  openPath: (path) => ipcRenderer.invoke('knote:open-path', { path }),
  reopen: (type, path, requestId = '') => ipcRenderer.invoke('knote:reopen', { type, path, requestId }),
  exportPdf: (defaultName) => ipcRenderer.invoke('knote:export-pdf', { defaultName }),
  // context-menu clipboard channel (navigator.clipboard permissions are
  // unreliable in the sandboxed shell)
  readClipboard: () => ipcRenderer.invoke('knote:clipboard-read-text'),
  readClipboardImage: () => ipcRenderer.invoke('knote:clipboard-read-image'),
  readClipboardHtml: () => ipcRenderer.invoke('knote:clipboard-read-html'),
  writeClipboardImage: (dataUrl) => ipcRenderer.invoke('knote:clipboard-write-image', { dataUrl }),
  // Ctrl+wheel UI zoom — main applies Chromium-native zoom AND resizes the
  // native window-buttons strip to match the scaled title bar
  setZoom: (factor) => ipcRenderer.invoke('knote:ui-zoom', { factor }),
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
