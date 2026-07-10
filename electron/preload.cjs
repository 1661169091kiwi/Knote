// Bridge between the sandboxed renderer and the main process:
// - receiving .md files opened via file association / Explorer
// - writing those files back (live save), restricted in main to paths it
//   handed out itself
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('knoteDesktop', {
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
  fsExists: (path) => ipcRenderer.invoke('knote:fs-exists', { path }),
  readImageFile: (path) => ipcRenderer.invoke('knote:read-image-file', { path }),
  writeImageFile: (path, base64) => ipcRenderer.invoke('knote:write-image-file', { path, base64 }),
  // PDF layout sidecar (PaddleOCR / PP-Structure)
  pdfSidecarStatus: () => ipcRenderer.invoke('knote:pdf-sidecar-status'),
  pdfAnalyze: (imageBase64, minScore) => ipcRenderer.invoke('knote:pdf-analyze', { imageBase64, minScore }),
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
  fsDelete: (path) => ipcRenderer.invoke('knote:fs-delete', { path }),
  fsMkdir: (path) => ipcRenderer.invoke('knote:fs-mkdir', { path }),
  fsRename: (from, to) => ipcRenderer.invoke('knote:fs-rename', { from, to }),
  trash: (path) => ipcRenderer.invoke('knote:trash', { path }),
  reveal: (path) => ipcRenderer.invoke('knote:reveal', { path }),
  reopen: (type, path) => ipcRenderer.invoke('knote:reopen', { type, path }),
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
  // handshake: main holds the startup file until the app is mounted
  ready: () => ipcRenderer.send('knote:renderer-ready')
})
