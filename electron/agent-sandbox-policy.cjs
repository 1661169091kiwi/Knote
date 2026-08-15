'use strict'

const AGENT_SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-eval'",
  "connect-src 'none'",
  "webrtc 'block'",
  "img-src 'none'",
  "media-src 'none'",
  "font-src 'none'",
  "style-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "child-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

const AGENT_SANDBOX_DOCUMENT_URL = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off"><meta http-equiv="Content-Security-Policy" content="${AGENT_SANDBOX_CSP}"><title>Knote isolated task</title>`
)}`

const BLOCKED_REQUEST_FILTER = Object.freeze({
  urls: [
    'http://*/*',
    'https://*/*',
    'ws://*/*',
    'wss://*/*',
    'file://*/*'
  ]
})

const agentSandboxWindowOptions = (partition) => ({
  show: false,
  width: 1,
  height: 1,
  skipTaskbar: true,
  focusable: false,
  paintWhenInitiallyHidden: false,
  backgroundColor: '#000000',
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    preload: undefined,
    partition,
    devTools: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    disableDialogs: true,
    safeDialogs: true,
    images: false,
    autoplayPolicy: 'document-user-activation-required',
    plugins: false,
    spellcheck: false,
    backgroundThrottling: false
  }
})

const applyAgentSandboxSessionPolicy = (sandboxSession) => {
  if (!sandboxSession || !sandboxSession.webRequest || typeof sandboxSession.webRequest.onBeforeRequest !== 'function') {
    throw new TypeError('A Chromium Session with webRequest support is required')
  }

  sandboxSession.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false))
  sandboxSession.setPermissionCheckHandler?.(() => false)
  sandboxSession.setDevicePermissionHandler?.(() => false)
  sandboxSession.setDisplayMediaRequestHandler?.((_request, callback) => callback({}))

  sandboxSession.webRequest.onBeforeRequest(BLOCKED_REQUEST_FILTER, (_details, callback) => {
    callback({ cancel: true })
  })

  const denyDownload = (event, item) => {
    event.preventDefault()
    try { item?.cancel() } catch { /* download is already denied */ }
  }
  sandboxSession.on?.('will-download', denyDownload)

  return () => {
    try { sandboxSession.removeListener?.('will-download', denyDownload) } catch { /* unique temporary session is being discarded */ }
    try { sandboxSession.webRequest.onBeforeRequest(null) } catch { /* unique temporary session is being discarded */ }
  }
}

const applyAgentSandboxWindowPolicy = (window) => {
  const webContents = window?.webContents
  if (!webContents || typeof webContents.setWindowOpenHandler !== 'function') {
    throw new TypeError('A BrowserWindow webContents is required')
  }

  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const denyNavigation = (event) => event.preventDefault()
  const denyWebView = (event) => event.preventDefault()
  const denyContextMenu = (event) => event.preventDefault()
  const denyRestrictedInput = (event, input = {}) => {
    const key = String(input.key || '').toLowerCase()
    const clipboardShortcut = (input.control || input.meta) && ['c', 'v', 'x', 'insert'].includes(key)
    const devToolsShortcut = key === 'f12' || ((input.control || input.meta) && input.shift && ['i', 'j', 'c'].includes(key))
    if (clipboardShortcut || devToolsShortcut) event.preventDefault()
  }
  const closeDevTools = () => {
    try { webContents.closeDevTools() } catch { /* already closed */ }
  }

  webContents.on('will-navigate', denyNavigation)
  webContents.on('will-redirect', denyNavigation)
  webContents.on('will-frame-navigate', denyNavigation)
  webContents.on('will-attach-webview', denyWebView)
  webContents.on('context-menu', denyContextMenu)
  webContents.on('before-input-event', denyRestrictedInput)
  webContents.on('devtools-opened', closeDevTools)

  return () => {
    webContents.removeListener?.('will-navigate', denyNavigation)
    webContents.removeListener?.('will-redirect', denyNavigation)
    webContents.removeListener?.('will-frame-navigate', denyNavigation)
    webContents.removeListener?.('will-attach-webview', denyWebView)
    webContents.removeListener?.('context-menu', denyContextMenu)
    webContents.removeListener?.('before-input-event', denyRestrictedInput)
    webContents.removeListener?.('devtools-opened', closeDevTools)
  }
}

module.exports = {
  AGENT_SANDBOX_CSP,
  AGENT_SANDBOX_DOCUMENT_URL,
  BLOCKED_REQUEST_FILTER,
  agentSandboxWindowOptions,
  applyAgentSandboxSessionPolicy,
  applyAgentSandboxWindowPolicy
}
