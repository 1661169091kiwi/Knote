'use strict'
const path = require('node:path')
const jobs = new Map()
const phases = new Set(['images', 'parsing', 'sanitizing', 'diagrams', 'layout'])
const abortError = () => Object.assign(new Error('PDF export canceled'), { name: 'AbortError' })

// Private channels: only a registered printer's main frame may access its job.
const installDocumentPdfIpc = ipcMain => {
  const own = event => {
    const job = jobs.get(event.sender.id)
    if (!job || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid PDF renderer')
    return job
  }
  ipcMain.handle('knote:print-job', event => own(event).document)
  ipcMain.handle('knote:print-image', (event, resource) => own(event).readImage(resource))
  ipcMain.handle('knote:print-ready', (event, result) => {
    const job = own(event)
    if (result?.ok === true) job.resolve()
    else job.reject(new Error(String(result?.error || 'PDF preparation failed').slice(0, 1000)))
    return true
  })
  ipcMain.on('knote:print-progress', (event, value) => {
    try {
      const job = own(event)
      if (!phases.has(value?.stage) || !Number.isFinite(value.percent)) return
      job.onProgress({ stage: value.stage, percent: Math.max(8, Math.min(70, value.percent)), completed: Math.max(0, Number(value.completed) || 0), total: Math.max(0, Number(value.total) || 0) })
    } catch { /* unknown/stale renderer */ }
  })
}
const validatePrintDocument = document => {
  if (!document || typeof document.source !== 'string' || Buffer.byteLength(document.source) > 64 * 1024 * 1024) throw new Error('Invalid PDF document')
  if (document.preview != null && (typeof document.preview !== 'string' || Buffer.byteLength(document.preview) > 128 * 1024 * 1024)) throw new Error('Invalid PDF preview')
  for (const name of ['imageMappings', 'storedImages']) {
    const entries = document[name] || []
    if (!Array.isArray(entries) || entries.length > 20000 || entries.some(item => !Array.isArray(item) || item.length !== 2 || item.some(value => typeof value !== 'string'))) throw new Error('Invalid PDF image resources')
  }
  for (const name of ['stylesheets', 'inlineStyles']) if (document[name] && (!Array.isArray(document[name]) || document[name].length > 100 || document[name].some(value => typeof value !== 'string'))) throw new Error('Invalid PDF styles')
  return document
}
const renderDocumentPdf = async ({ BrowserWindow, document, readImage = async () => null, onProgress = () => {}, signal, timeoutMs = 300000 }) => {
  validatePrintDocument(document)
  if (signal?.aborted) throw abortError()
  const printer = new BrowserWindow({ show: false, width: 850, height: 1100, backgroundColor: '#ffffff', webPreferences: { preload: path.join(__dirname, 'pdf-print-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  printer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  printer.webContents.on('will-navigate', event => event.preventDefault())
  const printerId = printer.webContents.id
  let timer, abort, fail
  const prepared = new Promise((resolve, reject) => jobs.set(printerId, { document, readImage, onProgress, resolve, reject }))
  const interrupted = new Promise((_, reject) => {
    fail = reject
    abort = () => reject(abortError())
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => reject(new Error('PDF export timed out')), timeoutMs)
  })
  printer.webContents.once('render-process-gone', () => fail(new Error('PDF print renderer stopped')))
  const render = async () => {
    await printer.loadFile(path.join(__dirname, '..', 'dist', 'print.html'))
    await prepared
    if (signal?.aborted) throw abortError()
    // Chromium has no per-page percentage. Report an indeterminate stage.
    onProgress({ stage: 'printing', percent: 76, indeterminate: true })
    return printer.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 } })
  }
  try { return await Promise.race([render(), interrupted]) }
  finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    jobs.delete(printerId)
    if (!printer.isDestroyed()) printer.destroy()
  }
}
module.exports = { renderDocumentPdf, installDocumentPdfIpc, validatePrintDocument }
