'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const {
  createRendererQuitHandshake,
  createQuitCleanupController,
  buildQuitFailureDetail,
  terminateProcessTree
} = require('./quit-cleanup.cjs')

class FakeApp extends EventEmitter {
  constructor () {
    super()
    this.quitCalls = 0
    this.allowedQuits = 0
  }

  fireBeforeQuit () {
    const event = {
      defaultPrevented: false,
      preventDefault () { this.defaultPrevented = true }
    }
    this.emit('before-quit', event)
    if (!event.defaultPrevented) this.allowedQuits += 1
    return event
  }

  quit () {
    this.quitCalls += 1
    return this.fireBeforeQuit()
  }
}

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('quit cleanup waits once and allows only its gated re-entry', async () => {
  const app = new FakeApp()
  const gate = deferred()
  let cleanupCalls = 0
  let marked = 0
  const controller = createQuitCleanupController({
    app,
    markQuitting: () => { marked += 1 },
    cleanup: () => { cleanupCalls += 1; return gate.promise },
    timeoutMs: 1000
  })
  controller.install()
  controller.install()

  assert.equal(app.fireBeforeQuit().defaultPrevented, true)
  assert.equal(app.fireBeforeQuit().defaultPrevented, true)
  await Promise.resolve()
  assert.equal(controller.getState(), 'running')
  assert.equal(cleanupCalls, 1)

  gate.resolve()
  await controller.whenSettled()

  assert.equal(cleanupCalls, 1)
  assert.equal(app.quitCalls, 1)
  assert.equal(app.allowedQuits, 1)
  assert.equal(controller.getState(), 'ready')
  assert.equal(marked, 3)
})

test('quit cleanup cancels exit after its deadline and remains retryable', async () => {
  const app = new FakeApp()
  const errors = []
  const started = Date.now()
  const controller = createQuitCleanupController({
    app,
    cleanup: () => new Promise(() => {}),
    timeoutMs: 40,
    onError: (error) => errors.push(error)
  })
  controller.install()

  assert.equal(app.fireBeforeQuit().defaultPrevented, true)
  await controller.whenSettled()

  assert.ok(Date.now() - started < 1000)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'QUIT_CLEANUP_TIMEOUT')
  assert.equal(app.quitCalls, 0)
  assert.equal(app.allowedQuits, 0)
  assert.equal(controller.getState(), 'idle')
})

test('a timed-out cleanup is aborted before its delayed work can perform stale side effects', async () => {
  const app = new FakeApp()
  const gate = deferred()
  let attempts = 0
  let staleEffects = 0
  const controller = createQuitCleanupController({
    app,
    cleanup: async ({ signal }) => {
      attempts += 1
      if (attempts === 1) {
        await gate.promise
        if (!signal.aborted) staleEffects += 1
      }
    },
    timeoutMs: 30
  })
  controller.install()
  app.fireBeforeQuit()
  await controller.whenSettled()
  gate.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(staleEffects, 0)

  app.fireBeforeQuit()
  assert.equal(await controller.whenSettled(), true)
  assert.equal(attempts, 2)
  assert.equal(app.allowedQuits, 1)
})

test('quit cleanup failure blocks exit and a later successful attempt can proceed', async () => {
  const app = new FakeApp()
  let attempts = 0
  const errors = []
  const controller = createQuitCleanupController({
    app,
    cleanup: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('save failed')
    },
    timeoutMs: 1000,
    onError: (error) => errors.push(error)
  })
  controller.install()

  assert.equal(app.fireBeforeQuit().defaultPrevented, true)
  assert.equal(await controller.whenSettled(), false)
  assert.equal(controller.getState(), 'idle')
  assert.equal(app.quitCalls, 0)
  assert.equal(errors.length, 1)

  assert.equal(app.fireBeforeQuit().defaultPrevented, true)
  assert.equal(await controller.whenSettled(), true)
  assert.equal(controller.getState(), 'ready')
  assert.equal(app.quitCalls, 1)
  assert.equal(app.allowedQuits, 1)
})

test('renderer quit handshake accepts only the matching sender and token', async () => {
  const sent = []
  const webContents = {
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload })
  }
  const handshake = createRendererQuitHandshake({
    getWebContents: () => webContents,
    timeoutMs: 1000,
    tokenFactory: () => 'nonce-1'
  })
  const first = handshake.request()
  assert.equal(handshake.request(), first, 'repeated quit events must share one request')
  assert.deepEqual(sent, [{ channel: 'knote:prepare-quit', payload: { token: 'nonce-1' } }])
  assert.equal(handshake.acknowledge({}, { token: 'nonce-1' }), false)
  assert.equal(handshake.acknowledge(webContents, { token: 'wrong' }), false)
  assert.equal(handshake.acknowledge(webContents, {
    token: 'nonce-1',
    ok: true,
    recovered: 2,
    tabBufferSessionId: 'renderer-session-1'
  }), true)
  assert.deepEqual(await first, {
    status: 'acked',
    recovered: 2,
    tabBufferSessionId: 'renderer-session-1'
  })
  assert.equal(handshake.hasPending(), false)
})

test('renderer quit handshake is bounded when the renderer never replies', async () => {
  const webContents = { isDestroyed: () => false, send: () => {} }
  const started = Date.now()
  const handshake = createRendererQuitHandshake({
    getWebContents: () => webContents,
    timeoutMs: 30,
    tokenFactory: () => 'nonce-timeout'
  })
  assert.deepEqual(await handshake.request(), { status: 'timeout' })
  assert.ok(Date.now() - started < 500)
  assert.equal(handshake.hasPending(), false)
})

test('renderer quit handshake forwards the documents that blocked the barrier', async () => {
  const webContents = { isDestroyed: () => false, send: () => {} }
  const handshake = createRendererQuitHandshake({
    getWebContents: () => webContents,
    timeoutMs: 1000,
    tokenFactory: () => 'nonce-blocked'
  })
  const request = handshake.request()
  const many = Array.from({ length: 10 }, (_value, index) => ({ identity: `D:/notes/${index}.md`, reason: 'still-ahead-of-disk' }))
  assert.equal(handshake.acknowledge(webContents, {
    token: 'nonce-blocked',
    ok: false,
    recovered: 1,
    blocked: [
      { identity: 'D:/notes/a.md', reason: 'still-ahead-of-disk' },
      { identity: 'x'.repeat(600), reason: 'too-long' }, // over the length cap
      { reason: 'missing-identity' },                    // malformed
      null,
      ...many
    ]
  }), true)
  const result = await request
  assert.equal(result.status, 'failed')
  assert.equal(result.recovered, 1)
  // the failure dialog names the file the user must fix, capped so a huge tab
  // list cannot turn the dialog into a wall of text
  assert.equal(result.blocked.length, 8)
  assert.deepEqual(result.blocked[0], { identity: 'D:/notes/a.md', reason: 'still-ahead-of-disk' })
  assert.ok(result.blocked.every((entry) => typeof entry.identity === 'string' && entry.identity.length <= 512))
})

test('a successful ack carries no blocked list', async () => {
  const webContents = { isDestroyed: () => false, send: () => {} }
  const handshake = createRendererQuitHandshake({
    getWebContents: () => webContents,
    timeoutMs: 1000,
    tokenFactory: () => 'nonce-clean'
  })
  const request = handshake.request()
  handshake.acknowledge(webContents, { token: 'nonce-clean', ok: true, recovered: 0, blocked: [{ identity: 'x.md' }] })
  const result = await request
  assert.equal(result.status, 'acked')
  assert.equal('blocked' in result, false)
})

test('renderer quit handshake treats a crashed renderer as unavailable without waiting', async () => {
  const sent = []
  const webContents = {
    isDestroyed: () => false,
    isCrashed: () => true,
    send: (channel, payload) => sent.push({ channel, payload })
  }
  const started = Date.now()
  const handshake = createRendererQuitHandshake({
    getWebContents: () => webContents,
    timeoutMs: 30,
    tokenFactory: () => 'nonce-crashed'
  })
  // A crashed renderer cannot ack, so waiting out the timeout would only let the
  // durability gate cancel quit and deadlock the app (issue #13). It must instead
  // resolve immediately as unavailable so exit falls back to the retention copy.
  assert.deepEqual(await handshake.request(), { status: 'unavailable' })
  assert.ok(Date.now() - started < 500, 'a crashed renderer must not wait out the timeout')
  assert.deepEqual(sent, [], 'no prepare-quit may be sent to a dead renderer')
  assert.equal(handshake.hasPending(), false)
})

test('a hung tree-kill command is bounded and receives a direct-kill fallback', async () => {
  class HungChild extends EventEmitter {
    constructor (pid) {
      super()
      this.pid = pid
      this.exitCode = null
      this.signalCode = null
      this.killCalls = 0
    }

    kill () {
      this.killCalls += 1
      return true
    }
  }

  const child = new HungChild(101)
  const killer = new HungChild(202)
  const started = Date.now()
  const result = await terminateProcessTree(child, {
    platform: 'win32',
    timeoutMs: 30,
    spawnProcess: () => killer
  })

  assert.equal(result.status, 'timeout')
  assert.ok(Date.now() - started < 500)
  assert.equal(killer.killCalls, 1)
  assert.equal(child.killCalls, 2)
})

const pidIsAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

const readFirstLine = (stream) => new Promise((resolve, reject) => {
  let text = ''
  const timer = setTimeout(() => reject(new Error('child pid was not reported')), 3000)
  stream.on('data', (chunk) => {
    text += chunk.toString()
    const newline = text.indexOf('\n')
    if (newline < 0) return
    clearTimeout(timer)
    resolve(text.slice(0, newline).trim())
  })
  stream.once('error', reject)
})

test('process cleanup waits for a real child process to exit', async (t) => {
  const grandchildProgram = 'setInterval(() => {}, 1000)'
  const parentProgram = [
    "const { spawn } = require('node:child_process')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildProgram)}], { windowsHide: true, stdio: 'ignore' })`,
    "process.stdout.write(String(child.pid) + '\\n')",
    'setInterval(() => {}, 1000)'
  ].join(';')
  const parent = spawn(process.execPath, ['-e', parentProgram], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const grandchildPid = Number(await readFirstLine(parent.stdout))
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)

  t.after(() => {
    for (const pid of [parent.pid, grandchildPid]) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  })

  const started = Date.now()
  const termination = terminateProcessTree(parent, { timeoutMs: 3500 })
  assert.equal(terminateProcessTree(parent, { timeoutMs: 3500 }), termination)
  const result = await termination
  const elapsed = Date.now() - started

  assert.notEqual(result.status, 'timeout')
  assert.ok(elapsed < 4500, `cleanup took ${elapsed}ms`)
  assert.equal(pidIsAlive(parent.pid), false)
  if (process.platform === 'win32') {
    assert.equal(pidIsAlive(grandchildPid), false, 'taskkill /T must terminate the descendant too')
  }
})

test('the quit failure dialog names the documents that blocked the barrier', () => {
  const error = new Error('renderer durability barrier failed: failed')
  error.barrierStatus = 'failed'
  error.blocked = [
    { identity: 'D:/notes/a.md', reason: 'still-ahead-of-disk' },
    { identity: 'D:/notes/b.md', reason: 'recovery-snapshot-failed' }
  ]
  const detail = buildQuitFailureDetail(error)
  assert.match(detail, /请确认文件仍可写/)
  assert.match(detail, /仍未落盘的文档（2）/)
  assert.match(detail, /· D:\/notes\/a\.md/)
  assert.match(detail, /· D:\/notes\/b\.md/)
  assert.match(detail, /诊断：renderer durability barrier failed: failed/)
  // a write-failure message must not be shown for a timeout
  assert.doesNotMatch(detail, /保存仍在进行中/)
})

test('the quit failure dialog distinguishes a timeout and caps the document list', () => {
  const error = new Error('renderer durability barrier failed: timeout')
  error.barrierStatus = 'timeout'
  error.blocked = Array.from({ length: 9 }, (_value, index) => ({ identity: `D:/notes/${index}.md`, reason: 'still-ahead-of-disk' }))
  const detail = buildQuitFailureDetail(error)
  assert.match(detail, /保存仍在进行中/)
  assert.match(detail, /仍未落盘的文档（9）/)
  assert.match(detail, /· …另有 4 个/)
  assert.match(detail, /· D:\/notes\/4\.md/)
  assert.doesNotMatch(detail, /· D:\/notes\/5\.md/)
  assert.doesNotMatch(detail, /请确认文件仍可写/)
})

test('a failure with no known document still explains itself', () => {
  const error = new Error('quit cleanup attempt was cancelled')
  assert.match(buildQuitFailureDetail(error), /请确认文件仍可写/)
  assert.doesNotMatch(buildQuitFailureDetail(error), /仍未落盘的文档/)
})
