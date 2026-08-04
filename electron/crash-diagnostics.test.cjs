const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const {
  CrashDiagnostics,
  attachCrashDiagnostics,
  resolveStorageRoot
} = require('./crash-diagnostics.cjs')

const roots = []

const fresh = async (options = {}) => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'knote-crash-diagnostics-'))
  roots.push(parent)
  const userData = path.join(parent, 'user-data')
  return { parent, userData, diagnostics: new CrashDiagnostics(userData, options) }
}

const readEvents = async (diagnostics) => {
  await diagnostics.flush()
  const text = await fs.promises.readFile(diagnostics.eventsFile, 'utf8')
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test.after(async () => {
  for (const root of roots) await fs.promises.rm(root, { recursive: true, force: true })
})

test('records only whitelisted, bounded, secret-safe fields', async () => {
  const { diagnostics } = await fresh({ maxStringLength: 64, now: () => Date.UTC(2026, 6, 30, 6, 49, 0) })
  const secret = 'sk-ant-THIS_SHOULD_NEVER_BE_WRITTEN'
  const document = 'private document paragraph that must not be logged'
  assert.equal(await diagnostics.record('child-process-gone', {
    processType: 'Utility',
    reason: 'crashed',
    exitCode: 7,
    serviceName: `pdf-worker api_key=${secret} ${'x'.repeat(200)}`,
    processName: 'utility',
    commandLine: `--api-key=${secret}`,
    apiKey: secret,
    documentContent: document,
    arbitrary: 'not allowed'
  }), true)
  const [event] = await readEvents(diagnostics)
  assert.deepEqual(Object.keys(event).sort(), [
    'event', 'exitCode', 'processName', 'processType', 'reason', 'schema',
    'sequence', 'serviceName', 'timestamp'
  ].sort())
  assert.match(event.serviceName, /\[REDACTED\]/)
  assert(event.serviceName.length <= 64)
  const stored = JSON.stringify(event)
  assert.equal(stored.includes(secret), false)
  assert.equal(stored.includes(document), false)
  assert.equal(stored.includes('commandLine'), false)
  assert.equal(stored.includes('apiKey'), false)
})

test('main exception records a fingerprint, never message or stack content', async () => {
  const { diagnostics } = await fresh()
  const error = new Error('document body sk-secret-value Authorization: Bearer top-secret')
  error.code = 'E_TEST'
  await diagnostics.recordMainException('uncaught-exception', error, 'uncaughtException')
  const [event] = await readEvents(diagnostics)
  assert.equal(event.event, 'main-uncaught-exception')
  assert.equal(event.errorName, 'Error')
  assert.equal(event.errorCode, 'E_TEST')
  assert.equal(event.errorMessageLength, error.message.length)
  assert.match(event.errorFingerprint, /^[a-f0-9]{64}$/)
  const stored = JSON.stringify(event)
  assert.equal(stored.includes('document body'), false)
  assert.equal(stored.includes('top-secret'), false)
  assert.equal(Object.hasOwn(event, 'message'), false)
  assert.equal(Object.hasOwn(event, 'stack'), false)
})

test('serializes concurrent writes into complete, ordered JSONL records', async () => {
  const { diagnostics } = await fresh()
  const count = 160
  const results = await Promise.all(Array.from({ length: count }, (_, index) => (
    diagnostics.record('renderer-process-gone', { reason: `reason-${index}`, exitCode: index })
  )))
  assert(results.every(Boolean))
  const events = await readEvents(diagnostics)
  assert.equal(events.length, count)
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: count }, (_, index) => index + 1))
  assert.deepEqual(events.map((event) => event.exitCode), Array.from({ length: count }, (_, index) => index))
})

test('repairs an interrupted final JSONL line before the next append', async () => {
  const { diagnostics } = await fresh()
  await fs.promises.mkdir(diagnostics.rootDir, { recursive: true })
  await fs.promises.writeFile(diagnostics.eventsFile, '{"previous":true}\n{"partial":', 'utf8')
  assert.equal(await diagnostics.record('window-unresponsive'), true)
  const text = await fs.promises.readFile(diagnostics.eventsFile, 'utf8')
  assert.equal(text.endsWith('\n'), true)
  const lines = text.trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(lines[0], { previous: true })
  assert.equal(lines[1].event, 'window-unresponsive')
})

test('creates nested storage and degrades safely when the directory is unwritable', async () => {
  const { parent, diagnostics } = await fresh()
  assert.equal(await diagnostics.record('window-responsive'), true)
  assert.equal((await readEvents(diagnostics)).length, 1)

  const blockingFile = path.join(parent, 'not-a-directory')
  await fs.promises.writeFile(blockingFile, 'block', 'utf8')
  const failures = []
  const broken = new CrashDiagnostics(blockingFile, {
    directoryName: 'diagnostics',
    onError: (failure) => failures.push(failure)
  })
  assert.equal(await broken.record('window-unresponsive'), false)
  assert.equal(await broken.flush(), true)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].operation, 'append-event')
  assert.match(failures[0].errorFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(Object.hasOwn(failures[0], 'message'), false)
})

test('rejects storage paths that escape or replace userData', async () => {
  const { userData } = await fresh()
  assert.throws(() => resolveStorageRoot(userData, '..'), /child of Electron userData/)
  assert.throws(() => resolveStorageRoot(userData, '.'), /child of Electron userData/)
  assert.throws(() => resolveStorageRoot(userData, path.parse(userData).root), /child of Electron userData/)
})

test('attach enables local-only dumps and captures Electron lifecycle events', async () => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'knote-crash-attach-'))
  roots.push(parent)
  const userData = path.join(parent, 'user-data')
  const app = new EventEmitter()
  const win = new EventEmitter()
  win.webContents = new EventEmitter()
  const processEmitter = new EventEmitter()
  const paths = []
  const starts = []
  app.getPath = (name) => {
    assert.equal(name, 'userData')
    return userData
  }
  app.setPath = (name, value) => paths.push({ name, value })
  app.getVersion = () => '1.2.3'
  const diagnostics = attachCrashDiagnostics({
    app,
    processEmitter,
    captureUnhandledRejections: true,
    electronVersion: '43.0.0',
    crashReporter: { start: (options) => starts.push(options) }
  })
  assert.equal(diagnostics.attachWindow(win), true)
  assert.equal(diagnostics.attachWindow(win), false)

  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11, commandLine: '--secret' })
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'abnormal-exit', exitCode: 12, name: 'GPU Process' })
  win.emit('unresponsive')
  win.emit('responsive')
  processEmitter.emit('uncaughtExceptionMonitor', new Error('private editor text'), 'uncaughtException')
  processEmitter.emit('unhandledRejection', 'API key sk-do-not-store')
  const events = await readEvents(diagnostics)

  assert.deepEqual(paths, [{ name: 'crashDumps', value: diagnostics.dumpsDir }])
  assert.equal(path.relative(userData, diagnostics.dumpsDir).startsWith('..'), false)
  assert.equal(starts.length, 1)
  assert.equal(starts[0].uploadToServer, false)
  assert.equal(starts[0].compress, false)
  assert.equal(Object.hasOwn(starts[0], 'submitURL'), false)
  assert.deepEqual(events.map((event) => event.event), [
    'diagnostics-started',
    'renderer-process-gone',
    'child-process-gone',
    'window-unresponsive',
    'window-responsive',
    'main-uncaught-exception',
    'main-unhandled-rejection'
  ])
  assert.equal(events[0].crashReporterStarted, true)
  assert.equal(JSON.stringify(events).includes('private editor text'), false)
  assert.equal(JSON.stringify(events).includes('sk-do-not-store'), false)

  diagnostics.detach()
  const before = events.length
  win.emit('unresponsive')
  await diagnostics.flush()
  assert.equal((await readEvents(diagnostics)).length, before)
})

test('attach tolerates crash reporter setup failures without changing app behavior', async () => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'knote-crash-attach-failure-'))
  roots.push(parent)
  const app = new EventEmitter()
  const failures = []
  app.getPath = () => path.join(parent, 'user-data')
  app.setPath = () => { throw Object.assign(new Error('setPath failed with private detail'), { code: 'E_SET_PATH' }) }
  app.getVersion = () => '1.2.3'
  let reporterCalls = 0
  const diagnostics = attachCrashDiagnostics({
    app,
    processEmitter: new EventEmitter(),
    crashReporter: { start: () => { reporterCalls += 1 } },
    onError: (failure) => failures.push(failure)
  })
  const events = await readEvents(diagnostics)
  assert.equal(reporterCalls, 0)
  assert.equal(diagnostics.crashReporterStarted, false)
  assert.equal(events[0].event, 'diagnostics-started')
  assert.equal(events[0].crashReporterStarted, false)
  assert.equal(failures[0].operation, 'prepare-crash-dumps')
  assert.equal(JSON.stringify(failures).includes('private detail'), false)
})

test('attach does not change Node unhandled rejection behavior by default', async () => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'knote-crash-rejection-policy-'))
  roots.push(parent)
  const app = new EventEmitter()
  const processEmitter = new EventEmitter()
  app.getPath = () => path.join(parent, 'user-data')
  app.setPath = () => {}
  app.getVersion = () => '1.2.3'
  const diagnostics = attachCrashDiagnostics({ app, processEmitter })
  assert.equal(processEmitter.listenerCount('uncaughtExceptionMonitor'), 1)
  assert.equal(processEmitter.listenerCount('unhandledRejection'), 0)
  diagnostics.detach()
  assert.equal(processEmitter.listenerCount('uncaughtExceptionMonitor'), 0)
})
