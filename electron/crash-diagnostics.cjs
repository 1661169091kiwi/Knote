const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const SCHEMA_VERSION = 1
const DEFAULT_DIRECTORY = 'crash-diagnostics'
const DEFAULT_MAX_STRING_LENGTH = 192

// Auto-recovery guard rails: reload the window at most once per cooldown and
// never more than MAX total times, so a renderer crash-loop cannot turn into
// an infinite reload storm. Document content is persisted near-realtime via
// the retention store, so a reload loses at most the last debounce window.
const AUTO_RECOVER_COOLDOWN_MS = 60 * 1000
const AUTO_RECOVER_MAX = 3

const EVENT_FIELDS = Object.freeze({
  'diagnostics-started': Object.freeze({
    appVersion: 'string',
    electronVersion: 'string',
    platform: 'string',
    arch: 'string',
    crashReporterStarted: 'boolean'
  }),
  'renderer-process-gone': Object.freeze({
    reason: 'string',
    exitCode: 'integer'
  }),
  'child-process-gone': Object.freeze({
    processType: 'string',
    reason: 'string',
    exitCode: 'integer',
    serviceName: 'string',
    processName: 'string'
  }),
  'window-unresponsive': Object.freeze({}),
  'window-responsive': Object.freeze({}),
  'renderer-auto-recovered': Object.freeze({
    attempt: 'integer'
  }),
  'main-uncaught-exception': Object.freeze({
    origin: 'string',
    errorName: 'string',
    errorCode: 'string',
    errorMessageLength: 'integer',
    errorFingerprint: 'hash'
  }),
  'main-unhandled-rejection': Object.freeze({
    origin: 'string',
    errorName: 'string',
    errorCode: 'string',
    errorMessageLength: 'integer',
    errorFingerprint: 'hash'
  })
})

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')

const isBelow = (parent, candidate) => {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

const resolveStorageRoot = (userDataDir, directoryName = DEFAULT_DIRECTORY) => {
  if (typeof userDataDir !== 'string' || !userDataDir.trim()) {
    throw new TypeError('Electron userData directory is required')
  }
  if (typeof directoryName !== 'string' || !directoryName.trim()) {
    throw new TypeError('diagnostics directory is required')
  }
  const userDataRoot = path.resolve(userDataDir)
  const candidate = path.resolve(userDataRoot, directoryName)
  if (!isBelow(userDataRoot, candidate) || candidate === userDataRoot) {
    throw new Error('crash diagnostics directory must be a child of Electron userData')
  }
  return { userDataRoot, rootDir: candidate }
}

const redactSecrets = (value) => String(value)
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{6,}\b/gi, 'Bearer [REDACTED]')
  .replace(/\b(?:sk-ant|sk|gh[pousr]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{6,}\b/gi, '[REDACTED]')
  .replace(/\b(api[\s_-]*key|authorization|access[\s_-]*token|token|secret|password)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]')

const sanitizeString = (value, maxLength) => {
  let text = redactSecrets(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > maxLength) text = `${text.slice(0, Math.max(0, maxLength - 1))}…`
  return text
}

const integer = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return undefined
  return Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(number)))
}

const summarizeError = (error, maxStringLength) => {
  const object = error && (typeof error === 'object' || typeof error === 'function') ? error : null
  const name = object && object.name ? object.name : typeof error
  const code = object && object.code != null ? object.code : ''
  const rawMessage = object && object.message != null ? String(object.message) : String(error == null ? '' : error)
  return {
    errorName: sanitizeString(name || 'Error', maxStringLength),
    errorCode: sanitizeString(code, maxStringLength),
    // Exception messages can contain document text, paths, request bodies, or
    // credentials. Keep only correlation metadata, never the message/stack.
    errorMessageLength: rawMessage.length,
    errorFingerprint: sha256(`${name}\u0000${code}\u0000${rawMessage}`)
  }
}

class CrashDiagnostics {
  constructor (userDataDir, options = {}) {
    const resolved = resolveStorageRoot(userDataDir, options.directoryName)
    this.userDataDir = resolved.userDataRoot
    this.rootDir = resolved.rootDir
    this.eventsFile = path.join(this.rootDir, 'events.jsonl')
    this.dumpsDir = path.join(this.rootDir, 'dumps')
    this.maxStringLength = Math.max(32, Math.min(1024, integer(options.maxStringLength) || DEFAULT_MAX_STRING_LENGTH))
    this._fsp = options.fsPromises || fs.promises
    this._now = typeof options.now === 'function' ? options.now : () => Date.now()
    this._onError = typeof options.onError === 'function' ? options.onError : null
    this._tail = Promise.resolve()
    this._initialized = false
    this._sequence = 0
    this._closed = false
    this._listeners = []
    this._windows = new WeakSet()
    this.crashReporterStarted = false
    this._recoverAt = -Infinity
    this._recoverCount = 0
  }

  _notifyFailure (operation, error) {
    if (!this._onError) return
    try {
      this._onError({ operation, ...summarizeError(error, this.maxStringLength) })
    } catch {
      // Diagnostics must never turn a logging failure into an app failure.
    }
  }

  _sanitizeEvent (event, details = {}) {
    const fieldTypes = EVENT_FIELDS[event]
    if (!fieldTypes) throw new TypeError(`unsupported crash diagnostic event: ${event}`)
    const item = {
      schema: SCHEMA_VERSION,
      sequence: ++this._sequence,
      timestamp: new Date(this._now()).toISOString(),
      event
    }
    for (const [field, type] of Object.entries(fieldTypes)) {
      if (!Object.prototype.hasOwnProperty.call(details, field)) continue
      const value = details[field]
      if (type === 'string') {
        const clean = sanitizeString(value, this.maxStringLength)
        if (clean) item[field] = clean
      } else if (type === 'integer') {
        const clean = integer(value)
        if (clean !== undefined) item[field] = clean
      } else if (type === 'boolean') {
        item[field] = value === true
      } else if (type === 'hash' && /^[a-f0-9]{64}$/i.test(String(value))) {
        item[field] = String(value).toLowerCase()
      }
    }
    return item
  }

  async _repairPartialTail () {
    let handle
    try {
      handle = await this._fsp.open(this.eventsFile, 'r+')
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      throw error
    }
    try {
      const stat = await handle.stat()
      if (!stat.size) return
      const readLength = Math.min(stat.size, 64 * 1024)
      const buffer = Buffer.alloc(readLength)
      await handle.read(buffer, 0, readLength, stat.size - readLength)
      if (buffer[readLength - 1] === 0x0a) return
      const newline = buffer.lastIndexOf(0x0a)
      const validSize = newline < 0 ? 0 : stat.size - readLength + newline + 1
      await handle.truncate(validSize)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async _ensureReady () {
    if (this._initialized) return
    await this._fsp.mkdir(this.rootDir, { recursive: true })
    await this._repairPartialTail()
    this._initialized = true
  }

  async _append (item) {
    await this._ensureReady()
    const line = Buffer.from(`${JSON.stringify(item)}\n`, 'utf8')
    const handle = await this._fsp.open(this.eventsFile, 'a')
    try {
      let offset = 0
      while (offset < line.length) {
        const result = await handle.write(line, offset, line.length - offset)
        if (!result || !result.bytesWritten) throw new Error('zero-byte diagnostics write')
        offset += result.bytesWritten
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  record (event, details = {}) {
    if (this._closed) return Promise.resolve(false)
    const item = this._sanitizeEvent(event, details)
    const operation = this._tail.then(async () => {
      try {
        await this._append(item)
        return true
      } catch (error) {
        this._notifyFailure('append-event', error)
        return false
      }
    })
    this._tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  recordMainException (kind, error, origin = '') {
    const event = kind === 'unhandled-rejection'
      ? 'main-unhandled-rejection'
      : 'main-uncaught-exception'
    return this.record(event, {
      origin,
      ...summarizeError(error, this.maxStringLength)
    })
  }

  flush () {
    return this._tail.then(() => true)
  }

  attachWindow (win) {
    if (!win || typeof win.on !== 'function' || this._windows.has(win)) return false
    this._windows.add(win)
    addListener(this, win.webContents, 'render-process-gone', (_event, details = {}) => {
      void this.record('renderer-process-gone', {
        reason: details.reason,
        exitCode: details.exitCode
      })
      this._maybeAutoRecover(win, details)
    })
    addListener(this, win, 'unresponsive', () => {
      void this.record('window-unresponsive')
    })
    addListener(this, win, 'responsive', () => {
      void this.record('window-responsive')
    })
    return true
  }

  _maybeAutoRecover (win, details = {}) {
    // Only a hard renderer crash is worth reloading for; being killed or
    // exiting abnormally usually means the app is shutting down or the OS
    // reclaimed the process (memory pressure), and reloading would fight it.
    if (details.reason !== 'crashed') return
    if (this._closed) return
    if (!win || typeof win.isDestroyed !== 'function' || win.isDestroyed()) return
    const webContents = win.webContents
    if (!webContents || typeof webContents.reload !== 'function') return
    // Cooldown + hard cap keep a crash-loop from becoming a reload storm.
    const now = this._now()
    if (now - this._recoverAt < AUTO_RECOVER_COOLDOWN_MS) return
    if (this._recoverCount >= AUTO_RECOVER_MAX) return
    this._recoverAt = now
    this._recoverCount += 1
    void this.record('renderer-auto-recovered', { attempt: this._recoverCount })
    try {
      webContents.reload()
    } catch (error) {
      this._notifyFailure('auto-recover-reload', error)
    }
  }

  detach () {
    for (const remove of this._listeners.splice(0)) {
      try { remove() } catch { /* already detached */ }
    }
    this._windows = new WeakSet()
  }

  async close () {
    this.detach()
    this._closed = true
    await this.flush()
  }
}

const addListener = (diagnostics, emitter, event, listener) => {
  if (!emitter || typeof emitter.on !== 'function') return
  emitter.on(event, listener)
  diagnostics._listeners.push(() => {
    if (typeof emitter.off === 'function') emitter.off(event, listener)
    else if (typeof emitter.removeListener === 'function') emitter.removeListener(event, listener)
  })
}

const attachCrashDiagnostics = (options = {}) => {
  const app = options.app
  if (!app || typeof app.getPath !== 'function') throw new TypeError('Electron app is required')
  const diagnostics = new CrashDiagnostics(app.getPath('userData'), options)
  const win = options.window || options.win
  const crashReporter = options.crashReporter
  const processEmitter = options.processEmitter || process

  let dumpDirectoryReady = false
  try {
    fs.mkdirSync(diagnostics.dumpsDir, { recursive: true })
    if (typeof app.setPath !== 'function') throw new Error('Electron app.setPath is unavailable')
    app.setPath('crashDumps', diagnostics.dumpsDir)
    dumpDirectoryReady = true
  } catch (error) {
    diagnostics._notifyFailure('prepare-crash-dumps', error)
  }

  if (dumpDirectoryReady && crashReporter && typeof crashReporter.start === 'function') {
    try {
      crashReporter.start({
        companyName: options.companyName || 'Knote',
        productName: options.productName || 'Knote',
        uploadToServer: false,
        compress: false,
        extra: { diagnosticsSchema: String(SCHEMA_VERSION), localOnly: 'true' }
      })
      diagnostics.crashReporterStarted = true
    } catch (error) {
      diagnostics._notifyFailure('start-crash-reporter', error)
    }
  }

  diagnostics.attachWindow(win)
  addListener(diagnostics, app, 'child-process-gone', (_event, details = {}) => {
    void diagnostics.record('child-process-gone', {
      processType: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      processName: details.name
    })
  })
  addListener(diagnostics, processEmitter, 'uncaughtExceptionMonitor', (error, origin) => {
    void diagnostics.recordMainException('uncaught-exception', error, origin)
  })
  // Merely adding an unhandledRejection listener changes Node's default
  // throw/warn policy. Keep it opt-in; applications that already own such a
  // handler can instead call recordMainException at that existing boundary.
  if (options.captureUnhandledRejections === true) {
    addListener(diagnostics, processEmitter, 'unhandledRejection', (reason) => {
      void diagnostics.recordMainException('unhandled-rejection', reason, 'unhandledRejection')
    })
  }

  void diagnostics.record('diagnostics-started', {
    appVersion: typeof app.getVersion === 'function' ? app.getVersion() : '',
    electronVersion: options.electronVersion || process.versions.electron || '',
    platform: process.platform,
    arch: process.arch,
    crashReporterStarted: diagnostics.crashReporterStarted
  })
  return diagnostics
}

module.exports = {
  CrashDiagnostics,
  attachCrashDiagnostics,
  attach: attachCrashDiagnostics,
  resolveStorageRoot,
  SCHEMA_VERSION,
  EVENT_FIELDS
}
