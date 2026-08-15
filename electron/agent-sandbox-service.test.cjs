'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  AgentSandboxService,
  DISABLED_REASON,
  ISOLATION,
  installAgentSandboxIpc
} = require('./agent-sandbox-service.cjs')
const {
  applyAgentSandboxSessionPolicy,
  applyAgentSandboxWindowPolicy
} = require('./agent-sandbox-policy.cjs')

const owner = Object.freeze({ chatKey: 'chat:test', sessionId: 'session:test', runId: 'run:test' })
const pending = () => new Promise(() => {})
const tick = () => new Promise((resolve) => setImmediate(resolve))
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')

class MockSession extends EventEmitter {
  constructor (partition) {
    super()
    this.partition = partition
    this.webRequest = {
      onBeforeRequest: (filter, listener) => {
        this.requestFilter = filter
        this.beforeRequest = listener
      }
    }
  }

  setPermissionRequestHandler (handler) { this.permissionRequest = handler }
  setPermissionCheckHandler (handler) { this.permissionCheck = handler }
  setDevicePermissionHandler (handler) { this.devicePermission = handler }
  setDisplayMediaRequestHandler (handler) { this.displayMedia = handler }
  closeAllConnections () { this.connectionsClosed = true }
  clearStorageData () { this.storageCleared = true; return Promise.resolve() }
}

class MockWebContents extends EventEmitter {
  constructor (behavior, pid) {
    super()
    this.behavior = behavior
    this.pid = pid
    this.crashed = false
  }

  setWindowOpenHandler (handler) { this.openHandler = handler }
  closeDevTools () { this.devToolsClosed = true }
  getOSProcessId () { return this.pid }
  executeJavaScript (source, userGesture) {
    this.source = source
    this.userGesture = userGesture
    return this.behavior(this, source)
  }

  close (options) { this.closed = options }
  forcefullyCrashRenderer () { this.crashed = true }
}

const createHarness = ({ behaviors = [], limits = {}, timers = null, allowUnverifiedExecution = true } = {}) => {
  const windows = []
  const sessions = []
  let pid = 7100
  class MockBrowserWindow extends EventEmitter {
    constructor (options) {
      super()
      this.options = options
      this.destroyed = false
      const behavior = behaviors.shift() || (() => pending())
      this.webContents = new MockWebContents(behavior, ++pid)
      windows.push(this)
    }

    loadURL (url) { this.url = url; return Promise.resolve() }
    isDestroyed () { return this.destroyed }
    destroy () { this.destroyed = true }
  }
  const session = {
    fromPartition (partition, options) {
      const value = new MockSession(partition)
      value.options = options
      sessions.push(value)
      return value
    }
  }
  const timerApi = timers || { setTimer: setTimeout, clearTimer: clearTimeout }
  const service = new AgentSandboxService({
    BrowserWindow: MockBrowserWindow,
    session,
    allowUnverifiedExecution,
    limits,
    setTimer: timerApi.setTimer,
    clearTimer: timerApi.clearTimer
  })
  return { service, windows, sessions }
}

const completedEnvelope = (result, { checkpoint = null, hasCheckpoint = false, emitted = [] } = {}) => ({
  ok: true,
  result,
  checkpoint,
  hasCheckpoint,
  emitted,
  outputBytes: jsonBytes(result) + (hasCheckpoint ? jsonBytes(checkpoint) : 0) + emitted.reduce((total, value) => total + jsonBytes(value), 0)
})

test('policy denies permissions, network, navigation, windows, downloads, clipboard shortcuts, and devtools', () => {
  const sandboxSession = new MockSession('temporary')
  const removeSessionPolicy = applyAgentSandboxSessionPolicy(sandboxSession)
  assert.deepEqual(sandboxSession.requestFilter.urls, [
    'http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*'
  ])
  const { AGENT_SANDBOX_CSP } = require('./agent-sandbox-policy.cjs')
  assert.match(AGENT_SANDBOX_CSP, /webrtc 'block'/)
  let permission = true
  sandboxSession.permissionRequest(null, 'clipboard-read', (allowed) => { permission = allowed })
  assert.equal(permission, false)
  assert.equal(sandboxSession.permissionCheck(), false)
  assert.equal(sandboxSession.devicePermission(), false)
  let requestDecision = null
  sandboxSession.beforeRequest({ url: 'file:///secret.txt' }, (decision) => { requestDecision = decision })
  assert.deepEqual(requestDecision, { cancel: true })
  let downloadPrevented = false
  let downloadCancelled = false
  sandboxSession.emit('will-download', { preventDefault: () => { downloadPrevented = true } }, { cancel: () => { downloadCancelled = true } })
  assert.equal(downloadPrevented, true)
  assert.equal(downloadCancelled, true)

  const webContents = new MockWebContents(() => pending(), 1)
  const removeWindowPolicy = applyAgentSandboxWindowPolicy({ webContents })
  assert.deepEqual(webContents.openHandler({ url: 'https://example.com' }), { action: 'deny' })
  for (const eventName of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview', 'context-menu']) {
    let prevented = false
    webContents.emit(eventName, { preventDefault: () => { prevented = true } })
    assert.equal(prevented, true, eventName)
  }
  let shortcutPrevented = false
  webContents.emit('before-input-event', { preventDefault: () => { shortcutPrevented = true } }, { control: true, key: 'v' })
  assert.equal(shortcutPrevented, true)
  webContents.emit('devtools-opened')
  assert.equal(webContents.devToolsClosed, true)
  removeWindowPolicy()
  removeSessionPolicy()
})

test('production-default service is unavailable and direct IPC execution fails closed', async () => {
  const harness = createHarness({ allowUnverifiedExecution: false })
  const capabilities = harness.service.capabilities()
  assert.equal(capabilities.ok, true)
  assert.equal(capabilities.capabilities.available, false)
  assert.deepEqual(capabilities.capabilities.languages, [])
  assert.equal(capabilities.capabilities.reason_code, DISABLED_REASON.code)
  assert.equal(capabilities.capabilities.isolation.network, 'unverified')
  assert.throws(
    () => harness.service.start(owner, { language: 'javascript', code: 'return 1' }),
    (error) => error.code === 'SANDBOX_UNAVAILABLE'
  )

  const handlers = new Map()
  const sender = { isDestroyed: () => false }
  installAgentSandboxIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    service: harness.service,
    validateSender: (candidate) => candidate === sender
  })
  const direct = await handlers.get('knote:agent-sandbox-start')({ sender }, {
    owner,
    request: { language: 'javascript', code: 'return 1' }
  })
  assert.equal(direct.ok, false)
  assert.equal(direct.code, 'SANDBOX_UNAVAILABLE')
  assert.equal(harness.windows.length, 0)
})

test('each task uses a dedicated temporary Chromium renderer with the required webPreferences', async () => {
  const result = { answer: 42 }
  const harness = createHarness({ behaviors: [() => Promise.resolve(completedEnvelope(result))] })
  const started = harness.service.start(owner, { language: 'javascript', code: 'return { answer: 42 }', input: { value: 1 }, timeoutMs: 5000 })
  assert.match(started.task.taskId, /^sbx_[A-Za-z0-9_-]{43}$/)
  assert.equal(started.task.state, 'queued')
  assert.deepEqual(started.task.isolation, ISOLATION)
  await tick()
  await tick()

  const status = harness.service.status(owner, started.task.taskId).task
  assert.equal(status.state, 'completed')
  assert.deepEqual(status.result, result)
  assert.equal(harness.windows.length, 1)
  assert.equal(harness.sessions.length, 1)
  assert.equal(harness.sessions[0].partition.startsWith('persist:'), false)
  assert.equal(harness.sessions[0].options.cache, false)
  assert.equal(harness.windows[0].options.show, false)
  assert.deepEqual(harness.windows[0].options.webPreferences, {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    preload: undefined,
    partition: harness.sessions[0].partition,
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
  })
  assert.equal(harness.windows[0].webContents.userGesture, false)
  assert.equal(harness.windows[0].destroyed, true)
  assert.match(harness.windows[0].webContents.source, /new AsyncFunction/)
  assert.match(harness.windows[0].webContents.source, /fetch.*XMLHttpRequest.*WebSocket.*EventSource/)
  assert.doesNotMatch(harness.windows[0].webContents.source, /electron\/preload\.cjs/)
})

test('owner forgery is indistinguishable from an unknown opaque task id', async () => {
  const harness = createHarness({ behaviors: [() => pending()] })
  const id = harness.service.start(owner, { language: 'javascript', code: 'await sleep(1000)' }).task.taskId
  await tick()
  assert.throws(
    () => harness.service.status({ ...owner, runId: 'run:forged' }, id),
    (error) => error.code === 'TASK_NOT_FOUND'
  )
  assert.throws(
    () => harness.service.cancel(owner, 'sbx_' + 'a'.repeat(43)),
    (error) => error.code === 'TASK_NOT_FOUND'
  )
  harness.service.cancel(owner, id)
})

test('cancel and timeout destroy the complete renderer instead of trusting its event loop', async () => {
  const harness = createHarness({ behaviors: [() => pending(), () => pending()] })
  const cancelledId = harness.service.start(owner, { language: 'javascript', code: 'for (;;) {}', timeoutMs: 5000 }).task.taskId
  await tick()
  const cancelled = harness.service.cancel(owner, cancelledId).task
  assert.equal(cancelled.state, 'cancelled')
  assert.deepEqual(harness.windows[0].webContents.closed, { waitForBeforeUnload: false })
  assert.equal(harness.windows[0].destroyed, true)

  const timedId = harness.service.start(owner, { language: 'javascript', code: 'for (;;) {}', timeoutMs: 100 }).task.taskId
  await tick()
  const timed = await harness.service.wait(owner, timedId, 1000)
  assert.equal(timed.task.state, 'timed_out')
  assert.equal(timed.task.error.code, 'TIMED_OUT')
  assert.deepEqual(harness.windows[1].webContents.closed, { waitForBeforeUnload: false })
  assert.equal(harness.windows[1].destroyed, true)
})

test('OUTPUT_LIMIT is a failed task and never a truncated success', async () => {
  const harness = createHarness({ behaviors: [() => Promise.resolve({
    ok: false,
    error: { code: 'OUTPUT_LIMIT', message: 'Task output exceeded its safety budget.' }
  })] })
  const id = harness.service.start(owner, { language: 'javascript', code: 'emit("x".repeat(999999))' }).task.taskId
  await tick()
  await tick()
  const task = harness.service.status(owner, id).task
  assert.equal(task.state, 'failed')
  assert.equal(task.error.code, 'OUTPUT_LIMIT')
  assert.equal(Object.hasOwn(task, 'result'), false)
  assert.deepEqual(harness.windows[0].webContents.closed, { waitForBeforeUnload: false })
})

test('default concurrency is bounded and queued work starts only after a renderer exits', async () => {
  const harness = createHarness({
    limits: { maxConcurrent: 1, maxQueued: 1 },
    behaviors: [() => pending(), () => Promise.resolve(completedEnvelope('second'))]
  })
  const first = harness.service.start(owner, { language: 'javascript', code: 'await sleep(10000)', timeoutMs: 5000 }).task.taskId
  await tick()
  const second = harness.service.start(owner, { language: 'javascript', code: 'return "second"', timeoutMs: 5000 }).task.taskId
  assert.equal(harness.service.status(owner, first).task.state, 'running')
  assert.equal(harness.service.status(owner, second).task.state, 'queued')
  assert.equal(harness.windows.length, 1)
  assert.throws(
    () => harness.service.start(owner, { language: 'javascript', code: 'return 3' }),
    (error) => error.code === 'TASK_QUEUE_FULL'
  )
  harness.service.cancel(owner, first)
  await tick()
  await tick()
  assert.equal(harness.windows.length, 2)
  assert.equal(harness.service.status(owner, second).task.state, 'completed')
})

test('a 30000ms wait returns the still-running task and latest checkpoint', async () => {
  const scheduled = []
  const timers = {
    setTimer (fn, ms) {
      const timer = { fn, ms, active: true }
      scheduled.push(timer)
      return timer
    },
    clearTimer (timer) { if (timer) timer.active = false }
  }
  const harness = createHarness({ behaviors: [() => pending()], timers })
  const id = harness.service.start(owner, { language: 'javascript', code: 'await sleep(30000)', timeoutMs: 300000 }).task.taskId
  await tick()
  const internal = harness.service.tasks.get(id)
  internal.checkpoint = { phase: 'polling' }
  internal.hasCheckpoint = true
  const waiting = harness.service.wait(owner, id, 30000)
  const waitTimer = scheduled.find((timer) => timer.active && timer.ms === 30000)
  assert.ok(waitTimer)
  waitTimer.fn()
  const response = await waiting
  assert.equal(response.task.state, 'running')
  assert.deepEqual(response.task.checkpoint, { phase: 'polling' })
  harness.service.cancel(owner, id)
})

test('IPC sender reload does not cancel a main-owned task, while the replacement sender can poll by exact owner', async () => {
  const harness = createHarness({ behaviors: [() => pending()] })
  const handlers = new Map()
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) }
  let currentSender = new EventEmitter()
  currentSender.isDestroyed = () => false
  installAgentSandboxIpc({ ipcMain, service: harness.service, validateSender: (sender) => sender === currentSender })

  const start = await handlers.get('knote:agent-sandbox-start')({ sender: currentSender }, {
    owner,
    request: { language: 'javascript', code: 'await sleep(10000)', timeoutMs: 5000 }
  })
  await tick()
  currentSender.emit('destroyed')
  assert.equal(harness.service.status(owner, start.task.taskId).task.state, 'running')

  currentSender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const status = await handlers.get('knote:agent-sandbox-status')({ sender: currentSender }, { owner, taskId: start.task.taskId })
  assert.equal(status.ok, true)
  assert.equal(status.task.state, 'running')
  harness.service.cancel(owner, start.task.taskId)
})

test('IPC schemas reject extra fields and application shutdown cancels every unfinished task', async () => {
  const harness = createHarness({ behaviors: [() => pending(), () => pending()] })
  const handlers = new Map()
  const sender = { isDestroyed: () => false }
  installAgentSandboxIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    service: harness.service,
    validateSender: (candidate) => candidate === sender
  })
  const invalid = await handlers.get('knote:agent-sandbox-start')({ sender }, {
    owner,
    request: { language: 'javascript', code: 'return 1', unexpected: true }
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'INVALID_REQUEST')

  const first = harness.service.start(owner, { language: 'javascript', code: 'await sleep(10000)', timeoutMs: 5000 }).task.taskId
  const second = harness.service.start(owner, { language: 'javascript', code: 'await sleep(10000)', timeoutMs: 5000 }).task.taskId
  await tick()
  await harness.service.cancelAll('APP_QUIT')
  assert.equal(harness.service.status(owner, first).task.state, 'cancelled')
  assert.equal(harness.service.status(owner, second).task.state, 'cancelled')
  assert.equal(harness.service.status(owner, first).task.error.code, 'APP_QUIT')
})

test('code and input have explicit byte budgets and are never present in public task snapshots', () => {
  const harness = createHarness()
  assert.throws(
    () => harness.service.start(owner, { language: 'javascript', code: 'x'.repeat(128 * 1024 + 1) }),
    (error) => error.code === 'CODE_LIMIT'
  )
  assert.throws(
    () => harness.service.start(owner, { language: 'javascript', code: 'return input', input: { value: 'x'.repeat(256 * 1024) } }),
    (error) => error.code === 'INPUT_LIMIT'
  )
  const started = harness.service.start(owner, { language: 'javascript', code: 'return input', input: { secret: 'not-public' } })
  assert.equal(Object.hasOwn(started.task, 'code'), false)
  assert.equal(Object.hasOwn(started.task, 'input'), false)
  harness.service.cancel(owner, started.task.taskId)
})
