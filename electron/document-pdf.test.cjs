const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { installDocumentPdfIpc, renderDocumentPdf, validatePrintDocument } = require('./document-pdf.cjs')
const handlers = new Map(), listeners = new Map()
installDocumentPdfIpc({ handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) })
let nextId = 0, active
const mockPrinter = mode => class extends EventEmitter {
  constructor(options) {
    super(); active = this; this.options = options; this.destroyed = false
    this.webContents = new EventEmitter()
    Object.assign(this.webContents, { id: ++nextId, mainFrame: {}, setWindowOpenHandler() {}, printToPDF: async () => Buffer.from('%PDF-1.7') })
    this.event = { sender: this.webContents, senderFrame: this.webContents.mainFrame }
  }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true }
  async loadFile(file) {
    assert.match(file, /dist[\\/]print\.html$/)
    assert.equal(this.options.webPreferences.nodeIntegration, false)
    assert.equal(this.options.webPreferences.sandbox, true)
    this.document = handlers.get('knote:print-job')(this.event)
    if (mode === 'hang') return
    listeners.get('knote:print-progress')(this.event, { stage: 'layout', percent: 999 })
    await handlers.get('knote:print-ready')(this.event, mode === 'fail' ? { ok: false, error: 'bad diagram' } : { ok: true })
  }
}
test('print document validation rejects unsafe shapes and oversized input', () => {
  for (const input of [null, {}, { source: 4 }, { source: '', imageMappings: [[2, 'x']] }, { source: '', stylesheets: [null] }]) assert.throws(() => validatePrintDocument(input))
  assert.equal(validatePrintDocument({ source: '# hello' }).source, '# hello')
})
test('isolated printer reports real phases and is always reclaimed', async () => {
  const phases = []
  const result = await renderDocumentPdf({ BrowserWindow: mockPrinter(), document: { source: '# hello' }, onProgress: value => phases.push(value) })
  assert.match(result.toString(), /%PDF/)
  assert.equal(phases[0].percent, 70)
  assert.equal(phases[1].stage, 'printing')
  assert.equal(phases[1].indeterminate, true)
  assert.equal(active.destroyed, true)
  assert.throws(() => handlers.get('knote:print-job')(active.event), /Invalid PDF renderer/)
})
test('foreign frames cannot read print source or private image resources', async () => {
  const controller = new AbortController()
  const task = renderDocumentPdf({ BrowserWindow: mockPrinter('hang'), document: { source: 'private' }, signal: controller.signal })
  assert.throws(() => handlers.get('knote:print-job')({ sender: active.webContents, senderFrame: {} }), /Invalid PDF renderer/)
  assert.throws(() => handlers.get('knote:print-image')({ sender: { id: -1 }, senderFrame: {} }, 'secret'), /Invalid PDF renderer/)
  controller.abort()
  await assert.rejects(task, { name: 'AbortError' })
  assert.equal(active.destroyed, true)
})
test('timeout and renderer preparation failures destroy the printer', async () => {
  await assert.rejects(renderDocumentPdf({ BrowserWindow: mockPrinter('hang'), document: { source: '' }, timeoutMs: 15 }), /timed out/)
  assert.equal(active.destroyed, true)
  await assert.rejects(renderDocumentPdf({ BrowserWindow: mockPrinter('fail'), document: { source: '' } }), /bad diagram/)
  assert.equal(active.destroyed, true)
})
