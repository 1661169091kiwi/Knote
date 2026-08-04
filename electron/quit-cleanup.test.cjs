'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const {
  createRendererQuitHandshake,
  createQuitCleanupController,
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
