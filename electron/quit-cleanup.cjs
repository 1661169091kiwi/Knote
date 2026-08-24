'use strict'

const { spawn } = require('node:child_process')

const positiveTimeout = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const waitForProcessExit = (child, timeoutMs) => new Promise((resolve) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    resolve({ status: 'exited' })
    return
  }

  let settled = false
  let timer = null
  const finish = (result) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    child.removeListener('exit', onExit)
    child.removeListener('error', onError)
    resolve(result)
  }
  const onExit = (code, signal) => finish({ status: 'exited', code, signal })
  const onError = (error) => finish({ status: 'error', error })

  child.once('exit', onExit)
  child.once('error', onError)
  timer = setTimeout(() => finish({ status: 'timeout' }), positiveTimeout(timeoutMs, 3500))
})

const safeKill = (child, signal) => {
  try {
    if (!child || child.exitCode !== null || child.signalCode !== null) return false
    return child.kill(signal)
  } catch {
    return false
  }
}

// Windows venv launchers and pip both create descendants. Killing only the
// ChildProcess handle leaves those descendants holding pdf-env files open, so
// use taskkill /T and wait for both taskkill and the tracked parent. Every wait
// shares one deadline; shutdown must never hang indefinitely.
const terminateProcessTreeOnce = async (child, options = {}) => {
  const timeoutMs = positiveTimeout(options.timeoutMs, 3500)
  const platform = options.platform || process.platform
  const spawnProcess = options.spawnProcess || spawn
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(0, deadline - Date.now())

  if (!child || !Number.isInteger(child.pid) || child.pid <= 0 || child.exitCode !== null || child.signalCode !== null) {
    return { status: 'already-exited' }
  }

  if (platform !== 'win32') {
    safeKill(child, 'SIGKILL')
    return waitForProcessExit(child, remaining())
  }

  let killer = null
  let treeResult = null
  try {
    killer = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    treeResult = await waitForProcessExit(killer, remaining())
  } catch (error) {
    treeResult = { status: 'error', error }
  }

  if (!treeResult || treeResult.status !== 'exited' || treeResult.code !== 0) {
    safeKill(killer)
    safeKill(child)
  }

  const childResult = await waitForProcessExit(child, remaining())
  if (childResult.status === 'timeout') safeKill(child)
  return { ...childResult, treeResult }
}

// Multiple shutdown paths can notice the same child at once (for example a
// sidecar request timing out just as before-quit fires). Share the in-flight
// termination so callers all wait for the same bounded operation.
const processTerminations = new WeakMap()
const terminateProcessTree = (child, options = {}) => {
  if (!child || (typeof child !== 'object' && typeof child !== 'function')) {
    return terminateProcessTreeOnce(child, options)
  }
  const existing = processTerminations.get(child)
  if (existing) return existing
  let shared
  shared = terminateProcessTreeOnce(child, options).finally(() => {
    if (processTerminations.get(child) === shared) processTerminations.delete(child)
  })
  processTerminations.set(child, shared)
  return shared
}

const withTimeout = (operation, timeoutMs, onTimeout = () => {}) => new Promise((resolve, reject) => {
  let settled = false
  const finish = (fn, value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    fn(value)
  }
  const timer = setTimeout(() => {
    const error = new Error(`quit cleanup exceeded ${timeoutMs}ms`)
    error.code = 'QUIT_CLEANUP_TIMEOUT'
    try { onTimeout(error) } catch { /* timeout notification is best-effort */ }
    finish(reject, error)
  }, positiveTimeout(timeoutMs, 5000))

  Promise.resolve()
    .then(operation)
    .then((value) => finish(resolve, value), (error) => finish(reject, error))
})

// Electron does not await async before-quit listeners. This controller blocks
// the first event, runs cleanup exactly once, then issues one gated app.quit().
// The re-entered before-quit sees state=ready and is allowed through.
const createQuitCleanupController = ({ app, markQuitting, cleanup, timeoutMs = 5000, onError = () => {} }) => {
  if (!app || typeof app.on !== 'function' || typeof app.quit !== 'function') throw new TypeError('app is required')
  if (typeof cleanup !== 'function') throw new TypeError('cleanup is required')

  let installed = false
  let state = 'idle'
  let completion = Promise.resolve()
  let resumed = false
  let activeController = null

  const beforeQuit = (event) => {
    if (typeof markQuitting === 'function') markQuitting()
    if (state === 'ready') return
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    if (state === 'running') return

    state = 'running'
    const controller = new AbortController()
    activeController = controller
    completion = withTimeout(
      () => cleanup({ signal: controller.signal }),
      timeoutMs,
      () => controller.abort()
    )
      .then(() => {
        if (activeController === controller) activeController = null
        state = 'ready'
        if (resumed) return
        resumed = true
        app.quit()
        return true
      })
      .catch((error) => {
        controller.abort()
        if (activeController === controller) activeController = null
        // A failed durability barrier must cancel this quit attempt. Keeping
        // the renderer alive is the only way to preserve edits when neither a
        // document write nor a recovery snapshot could be completed.
        state = 'idle'
        try { onError(error) } catch { /* diagnostics must not block retry */ }
        return false
      })
  }

  return {
    install () {
      if (installed) return
      installed = true
      app.on('before-quit', beforeQuit)
    },
    dispose () {
      if (!installed) return
      installed = false
      if (activeController) activeController.abort()
      if (typeof app.removeListener === 'function') app.removeListener('before-quit', beforeQuit)
    },
    getState: () => state,
    whenSettled: () => completion
  }
}

// Request one renderer-side save barrier and resolve only for the matching
// webContents + nonce. The promise is deliberately result-based (rather than
// rejecting on timeout) so it can participate in the main cleanup controller's
// one hard outer deadline without creating an unhandled rejection.
const createRendererQuitHandshake = ({
  getWebContents,
  timeoutMs = 6000,
  tokenFactory = (() => {
    let sequence = 0
    return () => `quit-${Date.now()}-${++sequence}`
  })(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) => {
  if (typeof getWebContents !== 'function') throw new TypeError('getWebContents is required')
  let pending = null
  let disposed = false

  const settle = (request, result) => {
    if (!request || pending !== request) return false
    pending = null
    if (request.timer) clearTimer(request.timer)
    request.resolve(result)
    return true
  }

  const request = () => {
    if (disposed) return Promise.resolve({ status: 'disposed' })
    if (pending) return pending.promise
    let webContents = null
    try { webContents = getWebContents() } catch { /* window is already gone */ }
    // A crashed renderer can never answer the save barrier: its in-memory edits
    // are already gone, and blocking quit cannot bring them back — it only traps
    // the user into a forced kill (issue #13). Treat it as unavailable so the
    // durability gate falls back to the last retention-store snapshot and exits.
    if (!webContents || webContents.isDestroyed?.() || webContents.isCrashed?.() || typeof webContents.send !== 'function') {
      return Promise.resolve({ status: 'unavailable' })
    }
    const token = String(tokenFactory())
    let resolve
    const promise = new Promise((done) => { resolve = done })
    const current = { token, webContents, promise, resolve, timer: null }
    pending = current
    current.timer = setTimer(
      () => settle(current, { status: 'timeout' }),
      positiveTimeout(timeoutMs, 6000)
    )
    try {
      webContents.send('knote:prepare-quit', { token })
    } catch (error) {
      settle(current, { status: 'send-error', error })
    }
    return promise
  }

  const acknowledge = (sender, payload = {}) => {
    const current = pending
    if (!current || sender !== current.webContents || String(payload.token || '') !== current.token) return false
    const result = {
      status: payload.ok === false ? 'failed' : 'acked',
      recovered: Number(payload.recovered) || 0
    }
    if (typeof payload.tabBufferSessionId === 'string' && payload.tabBufferSessionId.length <= 1024 && !payload.tabBufferSessionId.includes('\0')) {
      result.tabBufferSessionId = payload.tabBufferSessionId
    }
    return settle(current, result)
  }

  const dispose = () => {
    disposed = true
    if (pending) settle(pending, { status: 'disposed' })
  }

  return { request, acknowledge, dispose, hasPending: () => !!pending }
}

module.exports = {
  createRendererQuitHandshake,
  createQuitCleanupController,
  terminateProcessTree,
  waitForProcessExit,
  withTimeout
}
