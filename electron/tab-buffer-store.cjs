const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const fsp = fs.promises
const REF_KIND = 'knote-tab-buffer'
const REF_VERSION = 1
const SECRET_BYTES = 32
const HEX_32 = /^[a-f0-9]{32}$/
const HEX_64 = /^[a-f0-9]{64}$/
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 256

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

const missing = (error) => error && error.code === 'ENOENT'

class TabBufferStore {
  constructor (rootDir, options = {}) {
    if (typeof rootDir !== 'string' || !rootDir.trim()) throw new TypeError('tab buffer root is required')
    this.rootDir = path.resolve(rootDir)
    this.boundaryDir = path.resolve(options.boundaryDir || path.dirname(path.dirname(this.rootDir)))
    if (!this._inside(this.boundaryDir, this.rootDir)) throw new TypeError('tab buffer root must be inside its boundary')
    this.sessionsDir = path.join(this.rootDir, 'sessions')
    this.secretPath = path.join(this.rootDir, 'store-key.bin')
    this.lockPath = path.join(this.rootDir, '.mutation.lock')
    this.fault = typeof options.fault === 'function' ? options.fault : null
    this.secretOverride = options.secret == null ? null : this._normalizeSecret(options.secret)
    this.maxBytes = this._positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES, 'tab buffer byte limit')
    this.maxEntries = this._positiveLimit(options.maxEntries, DEFAULT_MAX_ENTRIES, 'tab buffer entry limit')
    this.secretPromise = null
    this.boundaryRealPromise = null
    this.rootRealPromise = null
    this.queues = new Map()
    this.mutationQueue = Promise.resolve()
  }

  _positiveLimit (value, fallback, label) {
    const limit = value == null ? fallback : Number(value)
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError(`${label} must be a positive safe integer`)
    return limit
  }

  _normalizeSecret (value) {
    const secret = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), 'utf8')
    if (secret.length < SECRET_BYTES) throw new TypeError('tab buffer secret must contain at least 32 bytes')
    return secret
  }

  _identity (value, label) {
    if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError(`${label} must be a string or number`)
    const id = String(value)
    if (!id || id.length > 1024 || id.includes('\0')) throw new TypeError(`invalid ${label}`)
    return id
  }

  async _fault (point, context) {
    if (this.fault) await this.fault(point, context)
  }

  async _secret () {
    if (this.secretOverride) return this.secretOverride
    if (!this.secretPromise) this.secretPromise = this._loadOrCreateSecret()
    return this.secretPromise
  }

  async _loadOrCreateSecret () {
    await this._rootReal()
    try {
      const current = await fsp.readFile(this.secretPath)
      if (current.length !== SECRET_BYTES) throw new Error('tab buffer store key is corrupt')
      return current
    } catch (error) {
      if (!missing(error)) throw error
    }

    const candidate = crypto.randomBytes(SECRET_BYTES)
    let handle = null
    try {
      handle = await fsp.open(this.secretPath, 'wx', 0o600)
      await handle.writeFile(candidate)
      await handle.sync()
      return candidate
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const current = await fsp.readFile(this.secretPath)
      if (current.length !== SECRET_BYTES) throw new Error('tab buffer store key is corrupt')
      return current
    } finally {
      if (handle) await handle.close()
    }
  }

  _hmac (secret, namespace, value) {
    return crypto.createHmac('sha256', secret).update(namespace).update('\0').update(value).digest('hex')
  }

  async _keys (sessionId, tabId = null) {
    const secret = await this._secret()
    const session = this._identity(sessionId, 'session id')
    const sessionKey = this._hmac(secret, 'session', session)
    if (tabId == null) return { secret, sessionKey }
    const tab = this._identity(tabId, 'tab id')
    const tabKey = this._hmac(secret, 'tab', `${session}\0${tab}`)
    return { secret, sessionKey, tabKey }
  }

  _canonicalRef (ref) {
    return [
      REF_KIND,
      String(REF_VERSION),
      ref.session,
      ref.tab,
      ref.id,
      ref.hash,
      String(ref.size)
    ].join('\0')
  }

  _signRef (secret, ref) {
    return crypto.createHmac('sha256', secret).update(this._canonicalRef(ref)).digest('hex')
  }

  async _validatedRef (candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new TypeError('invalid tab buffer ref')
    const allowed = new Set(['kind', 'version', 'session', 'tab', 'id', 'hash', 'size', 'sig'])
    for (const key of Object.keys(candidate)) {
      if (!allowed.has(key)) throw new TypeError('invalid tab buffer ref')
    }
    const ref = {
      kind: candidate.kind,
      version: candidate.version,
      session: candidate.session,
      tab: candidate.tab,
      id: candidate.id,
      hash: candidate.hash,
      size: candidate.size,
      sig: candidate.sig
    }
    if (ref.kind !== REF_KIND || ref.version !== REF_VERSION) throw new TypeError('invalid tab buffer ref')
    if (!HEX_64.test(ref.session) || !HEX_64.test(ref.tab) || !HEX_32.test(ref.id) || !HEX_64.test(ref.hash) || !HEX_64.test(ref.sig)) {
      throw new TypeError('invalid tab buffer ref')
    }
    if (!Number.isSafeInteger(ref.size) || ref.size < 0) throw new TypeError('invalid tab buffer ref')

    const secret = await this._secret()
    const expected = Buffer.from(this._signRef(secret, ref), 'hex')
    const actual = Buffer.from(ref.sig, 'hex')
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error('untrusted tab buffer ref')
    return ref
  }

  _inside (parent, target) {
    const relative = path.relative(parent, target)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  }

  _resolved (parent, ...parts) {
    const target = path.resolve(parent, ...parts)
    if (!this._inside(parent, target)) throw new Error('tab buffer path escaped its root')
    return target
  }

  async _rootReal () {
    if (!this.rootRealPromise) {
      this.rootRealPromise = (async () => {
        const boundaryReal = await this._boundaryReal()
        const relative = path.relative(this.boundaryDir, this.rootDir)
        let current = this.boundaryDir
        for (const segment of relative.split(path.sep).filter(Boolean)) {
          current = path.join(current, segment)
          let stat
          try { stat = await fsp.lstat(current) } catch (error) {
            if (!missing(error)) throw error
            await fsp.mkdir(current).catch((mkdirError) => {
              if (mkdirError.code !== 'EEXIST') throw mkdirError
            })
            stat = await fsp.lstat(current)
          }
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe tab buffer root ancestor')
          const real = await fsp.realpath(current)
          if (!this._inside(boundaryReal, real)) throw new Error('tab buffer root escaped its boundary')
        }
        return fsp.realpath(this.rootDir)
      })()
    }
    const expected = await this.rootRealPromise
    const boundaryReal = await this._boundaryReal()
    const stat = await fsp.lstat(this.rootDir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe tab buffer root directory')
    const current = await fsp.realpath(this.rootDir)
    if (!this._inside(boundaryReal, current)) throw new Error('tab buffer root escaped its boundary')
    if (path.resolve(current) !== path.resolve(expected)) throw new Error('tab buffer root directory changed')
    return expected
  }

  async _boundaryReal () {
    if (!this.boundaryRealPromise) {
      this.boundaryRealPromise = (async () => {
        await fsp.mkdir(this.boundaryDir, { recursive: true })
        const stat = await fsp.lstat(this.boundaryDir)
        if (!stat.isDirectory()) throw new Error('unsafe tab buffer boundary')
        return fsp.realpath(this.boundaryDir)
      })()
    }
    const expected = await this.boundaryRealPromise
    const stat = await fsp.lstat(this.boundaryDir)
    if (!stat.isDirectory()) throw new Error('unsafe tab buffer boundary')
    const current = await fsp.realpath(this.boundaryDir)
    if (path.resolve(current) !== path.resolve(expected)) throw new Error('tab buffer boundary changed')
    return expected
  }

  async _ensureDirectory (dir) {
    const rootReal = await this._rootReal()
    await fsp.mkdir(dir, { recursive: true })
    const stat = await fsp.lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe tab buffer directory')
    const real = await fsp.realpath(dir)
    if (!this._inside(rootReal, real)) throw new Error('tab buffer directory escaped its root')
    return dir
  }

  _sessionDir (sessionKey) {
    if (!HEX_64.test(sessionKey)) throw new TypeError('invalid tab buffer session key')
    return this._resolved(this.sessionsDir, sessionKey)
  }

  _target (ref) {
    const dir = this._sessionDir(ref.session)
    return this._resolved(dir, `${ref.tab}.${ref.id}.buf`)
  }

  async _hashStoredFile (target) {
    const stat = await fsp.lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe tab buffer file')
    const hash = crypto.createHash('sha256')
    let size = 0
    // Stream the durability read-back. fsp.readFile used to allocate a second
    // full-size Buffer beside the IPC string and write Buffer, producing a
    // sharp memory spike exactly while a huge tab was being moved out of RAM.
    for await (const chunk of fs.createReadStream(target)) {
      size += chunk.length
      hash.update(chunk)
    }
    return { size, hash: hash.digest('hex') }
  }

  _enqueue (sessionKey, work) {
    const previous = this.queues.get(sessionKey) || Promise.resolve()
    const operation = previous.catch(() => {}).then(work)
    const tracked = operation.then(() => undefined, () => undefined).finally(() => {
      if (this.queues.get(sessionKey) === tracked) this.queues.delete(sessionKey)
    })
    this.queues.set(sessionKey, tracked)
    return operation
  }

  _enqueueMutation (work) {
    const operation = this.mutationQueue.catch(() => {}).then(() => this._withMutationLock(work))
    this.mutationQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  _processAlive (pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }

  async _withMutationLock (work) {
    await this._rootReal()
    const token = crypto.randomBytes(16).toString('hex')
    const deadline = Date.now() + 15_000
    let handle = null
    while (!handle) {
      try {
        handle = await fsp.open(this.lockPath, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }))
        } catch (error) {
          await handle.close().catch(() => {})
          handle = null
          await fsp.unlink(this.lockPath).catch(() => {})
          throw error
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        let stale = false
        let observedRaw = null
        try {
          const [raw, stat] = await Promise.all([
            fsp.readFile(this.lockPath, 'utf8'),
            fsp.lstat(this.lockPath)
          ])
          observedRaw = raw
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe tab buffer mutation lock')
          const owner = JSON.parse(raw)
          stale = !this._processAlive(Number(owner?.pid))
        } catch (readError) {
          if (missing(readError)) continue
          if (/unsafe tab buffer mutation lock/.test(String(readError?.message || ''))) throw readError
          try {
            const stat = await fsp.lstat(this.lockPath)
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe tab buffer mutation lock')
            stale = Date.now() - stat.mtimeMs > 30_000
          } catch (statError) {
            if (missing(statError)) continue
            throw statError
          }
        }
        if (stale) {
          let unchanged = false
          try { unchanged = observedRaw != null && await fsp.readFile(this.lockPath, 'utf8') === observedRaw } catch (readError) {
            if (missing(readError)) continue
            throw readError
          }
          if (!unchanged) continue
          await fsp.unlink(this.lockPath).catch((unlinkError) => {
            if (!missing(unlinkError)) throw unlinkError
          })
          continue
        }
        if (Date.now() >= deadline) {
          const timeout = new Error('tab buffer mutation lock timed out')
          timeout.code = 'TAB_BUFFER_LOCK_TIMEOUT'
          throw timeout
        }
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
    }
    try {
      return await work()
    } finally {
      await handle.close().catch(() => {})
      try {
        const owner = JSON.parse(await fsp.readFile(this.lockPath, 'utf8'))
        if (owner?.token === token) await fsp.unlink(this.lockPath)
      } catch { /* stale locks are recovered by the next mutation */ }
    }
  }

  async _measureUsage () {
    await this._ensureDirectory(this.sessionsDir)
    const rootReal = await this._rootReal()
    let bytes = 0
    let entries = 0
    for (const sessionEntry of await fsp.readdir(this.sessionsDir, { withFileTypes: true })) {
      const sessionPath = this._resolved(this.sessionsDir, sessionEntry.name)
      const sessionStat = await fsp.lstat(sessionPath)
      if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) throw new Error('unsafe tab buffer session entry')
      const sessionReal = await fsp.realpath(sessionPath)
      if (!this._inside(rootReal, sessionReal)) throw new Error('tab buffer session escaped its root')
      for (const fileEntry of await fsp.readdir(sessionPath, { withFileTypes: true })) {
        const filePath = this._resolved(sessionPath, fileEntry.name)
        const stat = await fsp.lstat(filePath)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe tab buffer store entry')
        bytes += stat.size
        entries += 1
      }
    }
    return { bytes, entries }
  }

  _quotaError () {
    const error = new Error('tab buffer store quota exceeded')
    error.code = 'TAB_BUFFER_QUOTA_EXCEEDED'
    return error
  }

  async _removeTreeSafe (target, rootReal, stats) {
    const lexical = path.resolve(target)
    if (!this._inside(this.rootDir, lexical)) throw new Error('tab buffer cleanup escaped its root')
    let stat
    try { stat = await fsp.lstat(lexical) } catch (error) {
      if (missing(error)) return
      throw error
    }
    if (stat.isSymbolicLink()) {
      await fsp.unlink(lexical)
      stats.entries += 1
      return
    }
    if (!stat.isDirectory()) {
      stats.bytes += stat.size
      stats.entries += 1
      await fsp.unlink(lexical)
      return
    }
    const real = await fsp.realpath(lexical)
    if (!this._inside(rootReal, real)) throw new Error('tab buffer cleanup escaped its root')
    for (const entry of await fsp.readdir(lexical)) {
      await this._removeTreeSafe(this._resolved(lexical, entry), rootReal, stats)
    }
    await fsp.rmdir(lexical)
  }

  // Called once before the first renderer exists. Session refs are intentionally
  // process-local, so every prior session and orphan temp belongs to a crashed
  // or already-terminated renderer and can be removed without LRU-evicting a
  // live cold tab.
  async initialize () {
    return this._enqueueMutation(async () => {
      const rootReal = await this._rootReal()
      const removed = { bytes: 0, entries: 0 }
      const quarantine = this._resolved(this.rootDir, `.stale-sessions-${crypto.randomBytes(12).toString('hex')}`)
      try { await fsp.rename(this.sessionsDir, quarantine) } catch (error) {
        if (!missing(error)) throw error
      }
      await this._ensureDirectory(this.sessionsDir)
      await this._removeTreeSafe(quarantine, rootReal, removed)
      // A previous process may have exited after the atomic rename but before
      // deleting its private quarantine. These names are never renderer refs.
      for (const name of await fsp.readdir(this.rootDir)) {
        if (/^(?:\.stale-sessions-[a-f0-9]{24}|\.dropping-session-[a-f0-9]{64}-[a-f0-9]{16})$/.test(name)) {
          await this._removeTreeSafe(this._resolved(this.rootDir, name), rootReal, removed)
        }
      }
      return removed
    })
  }

  async put (sessionId, tabId, content) {
    const { secret, sessionKey, tabKey } = await this._keys(sessionId, tabId)
    const text = String(content == null ? '' : content)
    const size = Buffer.byteLength(text, 'utf8')
    if (size > this.maxBytes) throw this._quotaError()
    return this._enqueue(sessionKey, () => this._enqueueMutation(async () => {
      await this._ensureDirectory(this.sessionsDir)
      const usage = await this._measureUsage()
      if (usage.entries + 1 > this.maxEntries || usage.bytes + size > this.maxBytes) throw this._quotaError()
      const dir = await this._ensureDirectory(this._sessionDir(sessionKey))
      const bytes = Buffer.from(text, 'utf8')
      const hash = sha256(bytes)
      const id = crypto.randomBytes(16).toString('hex')
      const base = { kind: REF_KIND, version: REF_VERSION, session: sessionKey, tab: tabKey, id, hash, size }
      const target = this._target(base)
      const temp = this._resolved(dir, `.${tabKey}.${id}.${crypto.randomBytes(8).toString('hex')}.tmp`)
      let handle = null
      let renamed = false
      try {
        handle = await fsp.open(temp, 'wx', 0o600)
        await handle.writeFile(bytes)
        await this._fault('after-temp', { temp, target, sessionKey, tabKey, id })
        await handle.sync()
        await this._fault('after-fsync', { temp, target, sessionKey, tabKey, id })
        await handle.close()
        handle = null
        await fsp.rename(temp, target)
        renamed = true
        await this._fault('after-rename', { temp, target, sessionKey, tabKey, id })
        await this._fault('tamper', { target, sessionKey, tabKey, id })

        const stored = await this._hashStoredFile(target)
        if (stored.size !== size || stored.hash !== hash) throw new Error('tab buffer read-back verification failed')
        const ref = { ...base, sig: '' }
        ref.sig = this._signRef(secret, ref)
        return Object.freeze(ref)
      } catch (error) {
        if (renamed) await fsp.unlink(target).catch(() => {})
        throw error
      } finally {
        if (handle) await handle.close().catch(() => {})
        await fsp.unlink(temp).catch(() => {})
      }
    }))
  }

  async _readVerified (ref) {
    const target = this._target(ref)
    let stat
    try {
      stat = await fsp.lstat(target)
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe tab buffer file')
    const rootReal = await this._rootReal()
    const real = await fsp.realpath(target)
    if (!this._inside(rootReal, real)) throw new Error('tab buffer file escaped its root')
    if (stat.size !== ref.size) throw new Error('tab buffer size mismatch')
    const bytes = await fsp.readFile(target)
    if (bytes.length !== ref.size) throw new Error('tab buffer size mismatch')
    if (sha256(bytes) !== ref.hash) throw new Error('tab buffer hash mismatch')
    return bytes.toString('utf8')
  }

  async get (candidate) {
    const ref = await this._validatedRef(candidate)
    return this._enqueue(ref.session, () => this._readVerified(ref))
  }

  async drop (candidate) {
    const ref = await this._validatedRef(candidate)
    return this._enqueue(ref.session, () => this._enqueueMutation(async () => {
      const target = this._target(ref)
      let stat
      try {
        stat = await fsp.lstat(target)
      } catch (error) {
        if (missing(error)) return false
        throw error
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe tab buffer file')
      const rootReal = await this._rootReal()
      const real = await fsp.realpath(target)
      if (!this._inside(rootReal, real)) throw new Error('tab buffer file escaped its root')
      await fsp.unlink(target)
      return true
    }))
  }

  async clearSession (sessionId) {
    const { sessionKey } = await this._keys(sessionId)
    return this._enqueue(sessionKey, () => this._enqueueMutation(async () => {
      await this._ensureDirectory(this.sessionsDir)
      const dir = this._sessionDir(sessionKey)
      let stat
      try {
        stat = await fsp.lstat(dir)
      } catch (error) {
        if (missing(error)) return false
        throw error
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe tab buffer session directory')
      const rootReal = await this._rootReal()
      const real = await fsp.realpath(dir)
      if (!this._inside(rootReal, real)) throw new Error('tab buffer session escaped its root')
      const quarantine = this._resolved(this.rootDir, `.dropping-session-${sessionKey}-${crypto.randomBytes(8).toString('hex')}`)
      await fsp.rename(dir, quarantine)
      await this._removeTreeSafe(quarantine, rootReal, { bytes: 0, entries: 0 })
      return true
    }))
  }
}

module.exports = {
  TabBufferStore,
  REF_KIND,
  REF_VERSION,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES
}
