'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const STORE_VERSION = 2
const RECORD_MAGIC = 'KnoteAgentDownloadResume'
const RESERVATION_MAGIC = 'KnoteAgentDownloadReservation'
const RESUME_ID_RE = /^[A-Za-z0-9_-]{32,64}$/
const SLOT_RE = /^([A-Za-z0-9_-]{32,64})\.meta\.([01])$/
const PART_RE = /^([A-Za-z0-9_-]{32,64})\.part$/
const LOCK_RE = /^([A-Za-z0-9_-]{32,64})\.lock$/
const RESERVATION_RE = /^([a-f0-9]{64})\.reserve$/
const TEMP_RE = /^\.tmp-[A-Za-z0-9_-]{16,96}$/
const LEGACY_PART_RE = /^[a-f0-9]{48}\.part$/
const HTTP_URL_REJECT_RE = /[\u0000-\u001f\u007f\\]/
const STRONG_ETAG_RE = /^"[\x21\x23-\x7e\x80-\xff]*"$/
const HTTP_DATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/
const STATES = new Set(['ACTIVE', 'PAUSED_RETRYABLE', 'AWAITING_REDIRECT_APPROVAL', 'COMPLETED'])
const REDIRECT_STATES = new Set(['NONE', 'FOLLOWING_SAME_ORIGIN', 'AWAITING_APPROVAL', 'APPROVED_RESET_REQUIRED'])
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_LOCK_STALE_MS = 2 * 60 * 60 * 1000
const MAX_RECORD_BYTES = 256 * 1024

class AgentDownloadResumeStoreError extends Error {
  constructor (code, message, details, cause) {
    super(message || code)
    this.name = 'AgentDownloadResumeStoreError'
    this.code = code
    if (details !== undefined) this.details = details
    if (cause !== undefined) this.cause = cause
  }
}

const storeError = (code, message, details, cause) => new AgentDownloadResumeStoreError(code, message, details, cause)
const identityOf = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino) })
const sameIdentity = (stat, identity) => String(stat.dev) === identity.dev && String(stat.ino) === identity.ino
const sameIdentityValue = (left, right) => left.dev === right.dev && left.ino === right.ino
const isSafeInteger = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value))
const pathKey = (value) => process.platform === 'win32'
  ? path.resolve(String(value || '')).toLowerCase()
  : path.resolve(String(value || ''))

const isPathWithin = (candidate, root) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

const validHttpUrl = (value) => {
  if (typeof value !== 'string' || !value || value.length > 8192 || value !== value.trim() || HTTP_URL_REJECT_RE.test(value)) return false
  try {
    const parsed = new URL(value)
    return ['http:', 'https:'].includes(parsed.protocol) && !!parsed.hostname && !parsed.username && !parsed.password
  } catch { return false }
}

const validOrigin = (value) => {
  if (typeof value !== 'string' || !value || value.length > 512) return false
  try {
    const parsed = new URL(value)
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === value && parsed.pathname === '/' && !parsed.search && !parsed.hash
  } catch { return false }
}

const validStrongETag = (value) => typeof value === 'string' && value.length <= 1024 && STRONG_ETAG_RE.test(value)
const validLastModified = (value) => {
  if (typeof value !== 'string' || value.length > 64 || !HTTP_DATE_RE.test(value)) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toUTCString() === value
}
const validValidator = (value) => value === null || (
  value && typeof value === 'object' && !Array.isArray(value) &&
  ((value.kind === 'etag' && validStrongETag(value.value)) || (value.kind === 'last-modified' && validLastModified(value.value)))
)

const validIdentity = (value) => value && typeof value === 'object' &&
  typeof value.dev === 'string' && /^\d+$/.test(value.dev) &&
  typeof value.ino === 'string' && /^\d+$/.test(value.ino)

const validWorkspace = (value) => value && typeof value === 'object' &&
  typeof value.lexical === 'string' && path.isAbsolute(value.lexical) &&
  typeof value.canonical === 'string' && path.isAbsolute(value.canonical) &&
  validIdentity(value)

const validParent = (value) => value && typeof value === 'object' &&
  validIdentity(value) && typeof value.destinationKey === 'string' &&
  value.destinationKey.length > 0 && value.destinationKey.length <= 32768

const validRedirect = (value, state) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!isSafeInteger(value.count) || value.count > 10 || !REDIRECT_STATES.has(value.state)) return false
  if (typeof value.pendingUrl !== 'string' || typeof value.fromOrigin !== 'string' || typeof value.toOrigin !== 'string') return false
  if (value.pendingUrl && !validHttpUrl(value.pendingUrl)) return false
  if (value.fromOrigin && !validOrigin(value.fromOrigin)) return false
  if (value.toOrigin && !validOrigin(value.toOrigin)) return false
  return state !== 'AWAITING_REDIRECT_APPROVAL' || (
    value.state === 'AWAITING_APPROVAL' && !!value.pendingUrl && !!value.fromOrigin && !!value.toOrigin
  )
}

const validMetadata = (metadata, expectedResumeId = '') => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
  if (metadata.version !== STORE_VERSION || !RESUME_ID_RE.test(metadata.resumeId || '')) return false
  if (expectedResumeId && metadata.resumeId !== expectedResumeId) return false
  if (!isSafeInteger(metadata.generation, 1) || !STATES.has(metadata.state)) return false
  if (!validHttpUrl(metadata.currentUrl) || !validHttpUrl(metadata.finalUrl) || !validOrigin(metadata.approvedOrigin)) return false
  if (!validRedirect(metadata.redirect, metadata.state)) return false
  if (typeof metadata.relativePath !== 'string' || !metadata.relativePath || metadata.relativePath.length > 1024) return false
  if (!(metadata.maxBytes === null || isSafeInteger(metadata.maxBytes, 1))) return false
  if (!validWorkspace(metadata.workspace) || !validParent(metadata.parent)) return false
  if (!metadata.part || metadata.part.filename !== `${metadata.resumeId}.part` || !validIdentity(metadata.part) || metadata.part.nlink !== 1) return false
  if (!isSafeInteger(metadata.committedBytes)) return false
  if (!(metadata.knownTotal === null || (isSafeInteger(metadata.knownTotal) && metadata.knownTotal >= metadata.committedBytes))) return false
  if (metadata.maxBytes !== null && metadata.committedBytes > metadata.maxBytes) return false
  if (metadata.maxBytes !== null && metadata.knownTotal !== null && metadata.knownTotal > metadata.maxBytes) return false
  if (!validValidator(metadata.validator)) return false
  if (metadata.state === 'PAUSED_RETRYABLE' && (
    !metadata.validator || (metadata.contentEncoding && metadata.contentEncoding !== 'identity')
  )) return false
  for (const [key, max] of [['contentEncoding', 256], ['contentType', 2048], ['contentDisposition', 8192]]) {
    if (typeof metadata[key] !== 'string' || metadata[key].length > max || /[\u0000\r\n]/.test(metadata[key])) return false
  }
  if (!isSafeInteger(metadata.createdAt, 1) || !isSafeInteger(metadata.updatedAt, metadata.createdAt)) return false
  if (!isSafeInteger(metadata.retryCount) || metadata.retryCount > 1000) return false
  if (!isSafeInteger(metadata.expiresAt, metadata.updatedAt)) return false
  return true
}

const normalizeBinding = (value) => {
  if (!value || typeof value !== 'object') throw storeError('DOWNLOAD_RESUME_BINDING_MISMATCH', 'download resume binding is missing')
  const workspace = clone(value.workspace)
  const parent = clone(value.parent)
  if (!validWorkspace(workspace) || !validParent(parent)) {
    throw storeError('DOWNLOAD_RESUME_BINDING_MISMATCH', 'download resume binding is invalid')
  }
  return {
    workspace: {
      lexical: path.resolve(workspace.lexical),
      canonical: path.resolve(workspace.canonical),
      dev: workspace.dev,
      ino: workspace.ino
    },
    parent,
    relativePath: String(value.relativePath || ''),
    maxBytes: value.maxBytes === undefined ? null : value.maxBytes
  }
}

const sameBinding = (metadata, binding) => (
  pathKey(metadata.workspace.lexical) === pathKey(binding.workspace.lexical) &&
  pathKey(metadata.workspace.canonical) === pathKey(binding.workspace.canonical) &&
  sameIdentityValue(metadata.workspace, binding.workspace) &&
  sameIdentityValue(metadata.parent, binding.parent) &&
  metadata.parent.destinationKey === binding.parent.destinationKey &&
  metadata.relativePath === binding.relativePath &&
  metadata.maxBytes === binding.maxBytes
)

class AgentDownloadResumeStore {
  constructor (root, options = {}) {
    this.root = path.resolve(String(root || ''))
    this.boundaryDir = path.resolve(String(options.boundaryDir || path.dirname(path.dirname(this.root))))
    this.legacyRoot = options.legacyRoot ? path.resolve(String(options.legacyRoot)) : ''
    this.persist = options.persist === true
    this.seal = typeof options.seal === 'function' ? options.seal : null
    this.unseal = typeof options.unseal === 'function' ? options.unseal : null
    if (this.persist && (!this.seal || !this.unseal)) {
      throw storeError('DOWNLOAD_RESUME_ENCRYPTION_UNAVAILABLE', 'encrypted download resume storage is unavailable')
    }
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes
    this.ttlMs = isSafeInteger(options.ttlMs, 1) ? options.ttlMs : DEFAULT_TTL_MS
    this.lockStaleMs = isSafeInteger(options.lockStaleMs, 1) ? options.lockStaleMs : DEFAULT_LOCK_STALE_MS
    this.processId = isSafeInteger(options.processId, 1) ? options.processId : process.pid
    this.isProcessAlive = typeof options.isProcessAlive === 'function'
      ? options.isProcessAlive
      : (pid) => {
          try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
        }
    this.hooks = options.hooks && typeof options.hooks === 'object' ? options.hooks : {}
    this.instanceId = this.randomBytes(18).toString('base64url')
    this.records = new Map()
    this.destinationReservations = new Map()
    this.locks = new Map()
    this.initializing = null
    this.initialized = false
    this.closed = false
    this.canonicalRoot = ''
  }

  static isResumeId (value) { return typeof value === 'string' && RESUME_ID_RE.test(value) }
  static createResumeId (randomBytes = crypto.randomBytes) { return randomBytes(32).toString('base64url') }

  async initialize () {
    if (this.closed) throw storeError('DOWNLOAD_RESUME_STORE_CLOSED', 'download resume storage is closed')
    if (this.initialized) return this.scan()
    if (this.initializing) return this.initializing
    this.initializing = this._initialize().finally(() => { this.initializing = null })
    return this.initializing
  }

  async _initialize () {
    if (!isPathWithin(this.root, this.boundaryDir) || pathKey(this.root) === pathKey(this.boundaryDir)) {
      throw storeError('DOWNLOAD_QUARANTINE_INVALID', 'download resume quarantine escaped user data')
    }
    await fs.promises.mkdir(this.boundaryDir, { recursive: true, mode: 0o700 })
    const quarantineParent = path.dirname(this.root)
    await fs.promises.mkdir(quarantineParent, { recursive: true, mode: 0o700 })
    try { await fs.promises.mkdir(this.root, { mode: 0o700 }) } catch (error) { if (error?.code !== 'EEXIST') throw error }

    const [canonicalBoundary, canonicalParent, canonicalRoot, parentStat, rootStat] = await Promise.all([
      fs.promises.realpath(this.boundaryDir),
      fs.promises.realpath(quarantineParent),
      fs.promises.realpath(this.root),
      fs.promises.lstat(quarantineParent, { bigint: true }),
      fs.promises.lstat(this.root, { bigint: true })
    ])
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw storeError('DOWNLOAD_QUARANTINE_INVALID', 'download resume quarantine is not a private directory')
    }
    if (!isPathWithin(canonicalParent, canonicalBoundary) || !isPathWithin(canonicalRoot, canonicalBoundary)) {
      throw storeError('DOWNLOAD_QUARANTINE_INVALID', 'download resume quarantine escaped user data')
    }
    this.canonicalRoot = path.resolve(canonicalRoot)
    await fs.promises.chmod(quarantineParent, 0o700).catch(() => {})
    await fs.promises.chmod(this.root, 0o700).catch(() => {})
    await this._cleanupLegacyParts()
    this.initialized = true
    await this.reconcile()
    return this.scan()
  }

  async _cleanupLegacyParts () {
    if (!this.legacyRoot) return
    let entries
    try { entries = await fs.promises.readdir(this.legacyRoot, { withFileTypes: true }) } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (!LEGACY_PART_RE.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue
      await fs.promises.unlink(path.join(this.legacyRoot, entry.name)).catch((error) => {
        if (error?.code !== 'ENOENT') throw error
      })
    }
  }

  _assertReady () {
    if (!this.initialized) throw storeError('DOWNLOAD_RESUME_STORE_UNINITIALIZED', 'download resume storage is not initialized')
    if (this.closed) throw storeError('DOWNLOAD_RESUME_STORE_CLOSED', 'download resume storage is closed')
  }

  _partPath (resumeId) { return path.join(this.root, `${resumeId}.part`) }
  _slotPath (resumeId, slot) { return path.join(this.root, `${resumeId}.meta.${slot}`) }
  _lockPath (resumeId) { return path.join(this.root, `${resumeId}.lock`) }
  _reservationHash (destinationKey) { return crypto.createHash('sha256').update(destinationKey).digest('hex') }
  _reservationPath (destinationKey) { return path.join(this.root, `${this._reservationHash(destinationKey)}.reserve`) }
  _tempPath () { return path.join(this.root, `.tmp-${this.randomBytes(24).toString('base64url')}`) }

  async _sealJson (value) {
    let sealed
    try { sealed = await this.seal(JSON.stringify(value)) } catch (cause) {
      throw storeError('DOWNLOAD_RESUME_ENCRYPTION_FAILED', 'could not encrypt download resume metadata', undefined, cause)
    }
    const buffer = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed || [])
    if (!buffer.length || buffer.length > MAX_RECORD_BYTES) {
      throw storeError('DOWNLOAD_RESUME_ENCRYPTION_FAILED', 'encrypted download resume metadata is invalid')
    }
    return buffer
  }

  async _unsealJsonBuffer (buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_RECORD_BYTES) {
      throw storeError('DOWNLOAD_RESUME_METADATA_INVALID', 'download resume metadata is invalid')
    }
    try {
      const clear = await this.unseal(buffer)
      const text = Buffer.isBuffer(clear) ? clear.toString('utf8') : String(clear)
      return JSON.parse(text)
    } catch (cause) {
      throw storeError('DOWNLOAD_RESUME_METADATA_INVALID', 'download resume metadata could not be authenticated', undefined, cause)
    }
  }

  async _readPrivateFile (filePath) {
    const before = await fs.promises.lstat(filePath, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || Number(before.nlink) !== 1 || Number(before.size) > MAX_RECORD_BYTES) {
      throw storeError('DOWNLOAD_RESUME_METADATA_INVALID', 'download resume record is not a private regular file')
    }
    const handle = await fs.promises.open(filePath, 'r')
    try {
      const opened = await handle.stat({ bigint: true })
      if (!sameIdentity(opened, identityOf(before)) || !opened.isFile() || Number(opened.nlink) !== 1 || Number(opened.size) > MAX_RECORD_BYTES) {
        throw storeError('DOWNLOAD_RESUME_METADATA_INVALID', 'download resume record changed while opening')
      }
      return await handle.readFile()
    } finally {
      await handle.close().catch(() => {})
    }
  }

  async _writeTemp (buffer) {
    const tempPath = this._tempPath()
    const handle = await fs.promises.open(tempPath, 'wx+', 0o600)
    let identity = null
    try {
      await handle.writeFile(buffer)
      await handle.sync()
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || Number(stat.nlink) !== 1 || Number(stat.size) !== buffer.length) {
        throw storeError('DOWNLOAD_RESUME_STORAGE_INVALID', 'download resume temporary record failed verification')
      }
      identity = identityOf(stat)
      await handle.close()
      const canonical = await fs.promises.realpath(tempPath)
      if (pathKey(path.dirname(canonical)) !== pathKey(this.canonicalRoot)) {
        throw storeError('DOWNLOAD_QUARANTINE_INVALID', 'download resume temporary record escaped quarantine')
      }
      return { path: tempPath, identity }
    } catch (error) {
      await handle.close().catch(() => {})
      await this._unlinkIfIdentity(tempPath, identity).catch(() => {})
      throw error
    }
  }

  async _atomicCreate (target, buffer) {
    const temp = await this._writeTemp(buffer)
    try {
      await fs.promises.link(temp.path, target)
    } finally {
      await this._unlinkIfIdentity(temp.path, temp.identity).catch(() => {})
    }
    const stat = await fs.promises.lstat(target, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1 || Number(stat.size) !== buffer.length) {
      throw storeError('DOWNLOAD_RESUME_STORAGE_INVALID', 'download resume record failed atomic creation')
    }
    return identityOf(stat)
  }

  async _replaceSlot (target, buffer, metadata) {
    const temp = await this._writeTemp(buffer)
    try {
      await this.hooks.beforeMetadataReplace?.({ target, metadata: clone(metadata) })
      await fs.promises.rename(temp.path, target)
      const stat = await fs.promises.lstat(target, { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1 || Number(stat.size) !== buffer.length) {
        throw storeError('DOWNLOAD_RESUME_METADATA_INVALID', 'download resume metadata failed atomic replacement')
      }
      await this._syncDirectory()
    } catch (error) {
      await this._unlinkIfIdentity(temp.path, temp.identity).catch(() => {})
      throw error
    }
  }

  async _syncDirectory () {
    let handle
    try {
      handle = await fs.promises.open(this.root, 'r')
      await handle.sync()
    } catch (error) {
      if (!['EINVAL', 'EPERM', 'EACCES', 'ENOTSUP'].includes(String(error?.code || ''))) throw error
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  async _writeMetadata (metadata) {
    if (!validMetadata(metadata, metadata.resumeId)) {
      throw storeError('DOWNLOAD_RESUME_METADATA_INVALID', 'refusing to commit invalid download resume metadata')
    }
    if (!this.persist) return
    const envelope = {
      magic: RECORD_MAGIC,
      version: STORE_VERSION,
      generation: metadata.generation,
      metadata
    }
    const sealed = await this._sealJson(envelope)
    await this._replaceSlot(this._slotPath(metadata.resumeId, metadata.generation % 2), sealed, metadata)
  }

  async _readSlot (filePath, resumeId) {
    const envelope = await this._unsealJsonBuffer(await this._readPrivateFile(filePath))
    if (
      !envelope || envelope.magic !== RECORD_MAGIC || envelope.version !== STORE_VERSION ||
      envelope.generation !== envelope.metadata?.generation || !validMetadata(envelope.metadata, resumeId)
    ) throw storeError('DOWNLOAD_RESUME_METADATA_INVALID', 'download resume metadata schema is invalid')
    return envelope.metadata
  }

  async _writeReservation (metadata) {
    const destinationKey = metadata.parent.destinationKey
    if (this.destinationReservations.has(destinationKey)) {
      const resumeId = this.destinationReservations.get(destinationKey)
      throw storeError('DOWNLOAD_RESUME_AVAILABLE', 'a paused download already reserves this destination', { resumeId })
    }
    this.destinationReservations.set(destinationKey, metadata.resumeId)
    if (!this.persist) return
    const record = {
      magic: RESERVATION_MAGIC,
      version: STORE_VERSION,
      resumeId: metadata.resumeId,
      destinationKey,
      createdAt: metadata.createdAt
    }
    const buffer = await this._sealJson(record)
    try {
      await this._atomicCreate(this._reservationPath(destinationKey), buffer)
    } catch (error) {
      this.destinationReservations.delete(destinationKey)
      if (error?.code !== 'EEXIST') throw error
      let existing
      try { existing = await this._readReservation(this._reservationPath(destinationKey), destinationKey) } catch (cause) {
        throw storeError('DOWNLOAD_RESUME_RESERVATION_INVALID', 'download destination reservation is invalid', undefined, cause)
      }
      throw storeError('DOWNLOAD_RESUME_AVAILABLE', 'a paused download already reserves this destination', { resumeId: existing.resumeId })
    }
  }

  async _readReservation (filePath, expectedDestinationKey = '') {
    const record = await this._unsealJsonBuffer(await this._readPrivateFile(filePath))
    if (
      !record || record.magic !== RESERVATION_MAGIC || record.version !== STORE_VERSION ||
      !RESUME_ID_RE.test(record.resumeId || '') || typeof record.destinationKey !== 'string' ||
      !isSafeInteger(record.createdAt, 1) ||
      (expectedDestinationKey && record.destinationKey !== expectedDestinationKey)
    ) throw storeError('DOWNLOAD_RESUME_RESERVATION_INVALID', 'download destination reservation schema is invalid')
    return record
  }

  async _removeReservation (metadata) {
    const key = metadata.parent.destinationKey
    if (this.destinationReservations.get(key) === metadata.resumeId) this.destinationReservations.delete(key)
    if (!this.persist) return true
    const reservationPath = this._reservationPath(key)
    try {
      const reservation = await this._readReservation(reservationPath, key)
      if (reservation.resumeId !== metadata.resumeId) return false
      await fs.promises.unlink(reservationPath)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      throw error
    }
  }

  async _acquireLock (resumeId) {
    if (this.locks.has(resumeId)) throw storeError('DOWNLOAD_RESUME_BUSY', 'download resume already has an owner')
    const lockPath = this._lockPath(resumeId)
    const token = this.randomBytes(18).toString('base64url')
    const body = Buffer.from(JSON.stringify({
      version: STORE_VERSION,
      pid: this.processId,
      instanceId: this.instanceId,
      token,
      createdAt: this.now()
    }))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const identity = await this._atomicCreate(lockPath, body)
        const lock = { resumeId, path: lockPath, identity, token }
        this.locks.set(resumeId, lock)
        return lock
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const stale = await this._lockIsStale(lockPath)
        if (!stale) throw storeError('DOWNLOAD_RESUME_BUSY', 'download resume already has an owner')
        await fs.promises.unlink(lockPath).catch((cause) => { if (cause?.code !== 'ENOENT') throw cause })
      }
    }
    throw storeError('DOWNLOAD_RESUME_BUSY', 'download resume already has an owner')
  }

  async _lockIsStale (lockPath) {
    let stat
    let record
    try {
      stat = await fs.promises.lstat(lockPath, { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1 || Number(stat.size) > 4096) return false
      record = JSON.parse((await fs.promises.readFile(lockPath, 'utf8')).trim())
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      return false
    }
    if (!record || record.version !== STORE_VERSION || !isSafeInteger(record.pid, 1) || !isSafeInteger(record.createdAt, 1)) return false
    if (this.now() - record.createdAt > this.lockStaleMs) return true
    return !this.isProcessAlive(record.pid)
  }

  async _releaseLock (entryOrId) {
    const resumeId = typeof entryOrId === 'string' ? entryOrId : entryOrId?.metadata?.resumeId
    const lock = this.locks.get(resumeId)
    if (!lock) return true
    this.locks.delete(resumeId)
    return this._unlinkIfIdentity(lock.path, lock.identity)
  }

  async _unlinkIfIdentity (filePath, identity) {
    try {
      const stat = await fs.promises.lstat(filePath, { bigint: true })
      if (identity && !sameIdentity(stat, identity)) return false
      await fs.promises.unlink(filePath)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      throw error
    }
  }

  async _openPart (metadata) {
    const partPath = this._partPath(metadata.resumeId)
    let before
    try { before = await fs.promises.lstat(partPath, { bigint: true }) } catch (cause) {
      throw storeError('DOWNLOAD_RESUME_PART_INVALID', 'download resume part is missing', undefined, cause)
    }
    if (
      !before.isFile() || before.isSymbolicLink() || Number(before.nlink) !== 1 ||
      !sameIdentity(before, metadata.part)
    ) throw storeError('DOWNLOAD_RESUME_PART_INVALID', 'download resume part identity changed')
    const canonicalPart = await fs.promises.realpath(partPath)
    if (pathKey(path.dirname(canonicalPart)) !== pathKey(this.canonicalRoot)) {
      throw storeError('DOWNLOAD_RESUME_PART_INVALID', 'download resume part escaped quarantine')
    }
    const flags = fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0)
    const handle = await fs.promises.open(partPath, flags)
    try {
      let opened = await handle.stat({ bigint: true })
      if (
        !opened.isFile() || Number(opened.nlink) !== 1 ||
        !sameIdentity(opened, metadata.part) || !sameIdentity(opened, identityOf(before))
      ) throw storeError('DOWNLOAD_RESUME_PART_INVALID', 'download resume part changed while opening')
      const size = Number(opened.size)
      if (!Number.isSafeInteger(size) || size < metadata.committedBytes) {
        throw storeError('DOWNLOAD_RESUME_PART_SHORT', 'download resume part is shorter than committed metadata')
      }
      if (size > metadata.committedBytes) {
        await handle.truncate(metadata.committedBytes)
        await handle.sync()
        opened = await handle.stat({ bigint: true })
        if (!sameIdentity(opened, metadata.part) || Number(opened.nlink) !== 1 || Number(opened.size) !== metadata.committedBytes) {
          throw storeError('DOWNLOAD_RESUME_PART_INVALID', 'download resume part could not be reconciled')
        }
      }
      return { path: partPath, handle, identity: identityOf(opened) }
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
  }

  async _createPart (resumeId) {
    const partPath = this._partPath(resumeId)
    const handle = await fs.promises.open(partPath, 'wx+', 0o600)
    try {
      await fs.promises.chmod(partPath, 0o600).catch(() => {})
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || Number(stat.nlink) !== 1 || Number(stat.size) !== 0) {
        throw storeError('DOWNLOAD_RESUME_PART_INVALID', 'private download part failed creation checks')
      }
      const canonicalPart = await fs.promises.realpath(partPath)
      if (pathKey(path.dirname(canonicalPart)) !== pathKey(this.canonicalRoot)) {
        throw storeError('DOWNLOAD_RESUME_PART_INVALID', 'private download part escaped quarantine')
      }
      return { path: partPath, handle, identity: identityOf(stat) }
    } catch (error) {
      await handle.close().catch(() => {})
      await fs.promises.unlink(partPath).catch(() => {})
      throw error
    }
  }

  async create (input) {
    this._assertReady()
    const binding = normalizeBinding(input)
    if (!binding.relativePath || binding.relativePath.length > 1024 || !(binding.maxBytes === null || isSafeInteger(binding.maxBytes, 1))) {
      throw storeError('DOWNLOAD_RESUME_BINDING_MISMATCH', 'download resume destination binding is invalid')
    }
    if (!validHttpUrl(input.currentUrl) || !validHttpUrl(input.finalUrl || input.currentUrl)) {
      throw storeError('INVALID_DOWNLOAD_URL', 'download resume URL is invalid')
    }
    const approvedOrigin = String(input.approvedOrigin || new URL(input.currentUrl).origin)
    if (!validOrigin(approvedOrigin)) throw storeError('INVALID_DOWNLOAD_URL', 'download resume origin is invalid')
    let resumeId
    for (let attempt = 0; attempt < 8; attempt += 1) {
      resumeId = AgentDownloadResumeStore.createResumeId(this.randomBytes)
      if (!this.records.has(resumeId)) break
      resumeId = ''
    }
    if (!resumeId) throw storeError('DOWNLOAD_QUARANTINE_BUSY', 'could not allocate an opaque download resume id')
    const createdAt = this.now()
    const lock = await this._acquireLock(resumeId)
    let part = null
    let metadata = null
    try {
      part = await this._createPart(resumeId)
      metadata = {
        version: STORE_VERSION,
        resumeId,
        generation: 1,
        state: 'ACTIVE',
        currentUrl: input.currentUrl,
        finalUrl: input.finalUrl || input.currentUrl,
        approvedOrigin,
        redirect: { count: 0, state: 'NONE', pendingUrl: '', fromOrigin: '', toOrigin: '' },
        relativePath: binding.relativePath,
        maxBytes: binding.maxBytes,
        workspace: binding.workspace,
        parent: binding.parent,
        part: { filename: `${resumeId}.part`, ...part.identity, nlink: 1 },
        committedBytes: 0,
        knownTotal: null,
        validator: null,
        contentEncoding: '',
        contentType: '',
        contentDisposition: '',
        createdAt,
        updatedAt: createdAt,
        retryCount: 0,
        expiresAt: createdAt + this.ttlMs
      }
      if (!validMetadata(metadata, resumeId)) throw storeError('DOWNLOAD_RESUME_METADATA_INVALID', 'new download resume metadata is invalid')
      await this._writeReservation(metadata)
      await this._writeMetadata(metadata)
      this.records.set(resumeId, clone(metadata))
      return { metadata: clone(metadata), part, lock, persistent: this.persist }
    } catch (error) {
      if (part?.handle) await part.handle.close().catch(() => {})
      if (part) await this._unlinkIfIdentity(part.path, part.identity).catch(() => {})
      if (metadata) await this._removeReservation(metadata).catch(() => {})
      await this._deleteMetadataFiles(resumeId).catch(() => {})
      await this._releaseLock(resumeId).catch(() => {})
      throw error
    }
  }

  async open (resumeId, bindingInput) {
    this._assertReady()
    if (!AgentDownloadResumeStore.isResumeId(resumeId)) throw storeError('DOWNLOAD_RESUME_INVALID', 'download resume id is invalid')
    const metadata = this.records.get(resumeId)
    if (!metadata || metadata.state === 'COMPLETED') throw storeError('DOWNLOAD_RESUME_NOT_FOUND', 'download resume is unavailable')
    if (metadata.expiresAt <= this.now()) {
      await this.discard(resumeId).catch(() => {})
      throw storeError('DOWNLOAD_RESUME_EXPIRED', 'download resume expired')
    }
    const binding = normalizeBinding(bindingInput)
    if (!sameBinding(metadata, binding)) throw storeError('DOWNLOAD_RESUME_BINDING_MISMATCH', 'download resume destination or workspace changed')
    const lock = await this._acquireLock(resumeId)
    try {
      const part = await this._openPart(metadata)
      const active = {
        ...metadata,
        generation: metadata.generation + 1,
        state: 'ACTIVE',
        updatedAt: this.now(),
        expiresAt: this.now() + this.ttlMs
      }
      await part.handle.sync()
      await this._writeMetadata(active)
      this.records.set(resumeId, clone(active))
      return { metadata: clone(active), part, lock, persistent: this.persist }
    } catch (error) {
      await this._releaseLock(resumeId).catch(() => {})
      if (['DOWNLOAD_RESUME_PART_INVALID', 'DOWNLOAD_RESUME_PART_SHORT', 'DOWNLOAD_RESUME_METADATA_INVALID'].includes(error?.code)) {
        await this.discard(resumeId).catch(() => {})
      }
      throw error
    }
  }

  async commit (entry, patch = {}) {
    this._assertReady()
    const resumeId = entry?.metadata?.resumeId
    if (!AgentDownloadResumeStore.isResumeId(resumeId) || !this.locks.has(resumeId) || !entry?.part?.handle) {
      throw storeError('DOWNLOAD_RESUME_NOT_OWNED', 'download resume does not have an active owner')
    }
    const previous = this.records.get(resumeId)
    if (!previous || previous.generation !== entry.metadata.generation) {
      throw storeError('DOWNLOAD_RESUME_METADATA_CHANGED', 'download resume metadata generation changed')
    }
    const committedBytes = patch.committedBytes === undefined ? previous.committedBytes : patch.committedBytes
    if (!isSafeInteger(committedBytes)) throw storeError('DOWNLOAD_RESUME_METADATA_INVALID', 'committed download byte count is invalid')
    // The encrypted offset is committed only after the exact part bytes have
    // reached the filesystem. A torn metadata replace can therefore roll back
    // to an older offset, but can never point beyond durable part data.
    await entry.part.handle.sync()
    const stat = await entry.part.handle.stat({ bigint: true })
    if (
      !stat.isFile() || Number(stat.nlink) !== 1 || !sameIdentity(stat, entry.part.identity) ||
      !sameIdentity(stat, previous.part) || Number(stat.size) !== committedBytes
    ) throw storeError('DOWNLOAD_RESUME_PART_INVALID', 'download resume part failed checkpoint identity verification')
    const now = this.now()
    const next = {
      ...previous,
      ...clone(patch),
      version: STORE_VERSION,
      resumeId,
      generation: previous.generation + 1,
      part: previous.part,
      workspace: previous.workspace,
      parent: previous.parent,
      relativePath: previous.relativePath,
      maxBytes: previous.maxBytes,
      createdAt: previous.createdAt,
      updatedAt: now,
      expiresAt: patch.expiresAt === undefined ? now + this.ttlMs : patch.expiresAt
    }
    if (!validMetadata(next, resumeId)) throw storeError('DOWNLOAD_RESUME_METADATA_INVALID', 'download resume checkpoint is invalid')
    await this._writeMetadata(next)
    this.records.set(resumeId, clone(next))
    entry.metadata = clone(next)
    return clone(next)
  }

  async pause (entry, patch = {}) {
    let result
    try {
      if (!entry?.part?.handle) throw storeError('DOWNLOAD_RESUME_NOT_OWNED', 'download resume does not have an active part')
      await entry.part.handle.sync()
      result = await this.commit(entry, {
        ...patch,
        state: patch.state || 'PAUSED_RETRYABLE',
        retryCount: patch.retryCount === undefined ? entry.metadata.retryCount + 1 : patch.retryCount
      })
    } finally {
      if (entry?.part?.handle) {
        await entry.part.handle.close().catch(() => {})
        entry.part.handle = null
      }
      await this._releaseLock(entry).catch(() => {})
    }
    return result
  }

  async complete (entry) {
    this._assertReady()
    let cleanupComplete = true
    if (entry?.part?.handle) {
      await entry.part.handle.close().catch(() => { cleanupComplete = false })
      entry.part.handle = null
    }
    const resumeId = entry?.metadata?.resumeId
    const metadata = this.records.get(resumeId) || entry?.metadata
    if (!metadata) return false
    try {
      const completed = {
        ...metadata,
        generation: metadata.generation + 1,
        state: 'COMPLETED',
        updatedAt: this.now(),
        expiresAt: this.now() + this.ttlMs
      }
      await this._writeMetadata(completed)
      this.records.set(resumeId, clone(completed))
    } catch { cleanupComplete = false }
    try {
      if (!(await this._unlinkIfIdentity(this._partPath(resumeId), metadata.part))) cleanupComplete = false
    } catch { cleanupComplete = false }
    try { if (!(await this._removeReservation(metadata))) cleanupComplete = false } catch { cleanupComplete = false }
    try { await this._deleteMetadataFiles(resumeId) } catch { cleanupComplete = false }
    if (cleanupComplete) this.records.delete(resumeId)
    try { if (!(await this._releaseLock(resumeId))) cleanupComplete = false } catch { cleanupComplete = false }
    return cleanupComplete
  }

  async discard (entryOrId) {
    this._assertReady()
    const entry = typeof entryOrId === 'object' ? entryOrId : null
    const resumeId = typeof entryOrId === 'string' ? entryOrId : entry?.metadata?.resumeId
    if (!AgentDownloadResumeStore.isResumeId(resumeId)) return false
    const metadata = this.records.get(resumeId) || entry?.metadata || null
    let ownedHere = this.locks.has(resumeId)
    if (!ownedHere) {
      try { await this._acquireLock(resumeId); ownedHere = true } catch (error) {
        if (error?.code === 'DOWNLOAD_RESUME_BUSY') throw error
        throw error
      }
    }
    let cleanupComplete = true
    try {
      if (entry?.part?.handle) {
        await entry.part.handle.close().catch(() => { cleanupComplete = false })
        entry.part.handle = null
      }
      try {
        const expected = metadata?.part || null
        if (!(await this._unlinkIfIdentity(this._partPath(resumeId), expected))) {
          // The app-owned pathname may have been replaced. Unlinking the name is
          // safe (lstat never follows a symlink) and prevents a forged resume.
          await fs.promises.unlink(this._partPath(resumeId)).catch((error) => { if (error?.code !== 'ENOENT') throw error })
        }
      } catch { cleanupComplete = false }
      if (metadata) {
        try { if (!(await this._removeReservation(metadata))) cleanupComplete = false } catch { cleanupComplete = false }
      }
      try { await this._deleteMetadataFiles(resumeId) } catch { cleanupComplete = false }
      this.records.delete(resumeId)
    } finally {
      if (ownedHere) {
        try { if (!(await this._releaseLock(resumeId))) cleanupComplete = false } catch { cleanupComplete = false }
      }
    }
    return cleanupComplete
  }

  async _deleteMetadataFiles (resumeId) {
    await Promise.all([0, 1].map(async (slot) => {
      await fs.promises.unlink(this._slotPath(resumeId, slot)).catch((error) => { if (error?.code !== 'ENOENT') throw error })
    }))
  }

  async scan () {
    this._assertReady()
    return [...this.records.values()]
      .filter((metadata) => metadata.state !== 'COMPLETED')
      .map(clone)
      .sort((left, right) => left.createdAt - right.createdAt || left.resumeId.localeCompare(right.resumeId))
  }

  async status (resumeId) {
    this._assertReady()
    if (!AgentDownloadResumeStore.isResumeId(resumeId)) return null
    const metadata = this.records.get(resumeId)
    return metadata && metadata.state !== 'COMPLETED' ? clone(metadata) : null
  }

  async findByDestination (destinationKey) {
    this._assertReady()
    const resumeId = this.destinationReservations.get(String(destinationKey || ''))
    const metadata = resumeId ? this.records.get(resumeId) : null
    return metadata && metadata.state !== 'COMPLETED' ? clone(metadata) : null
  }

  async cleanupExpired (now = this.now()) {
    this._assertReady()
    let removed = 0
    for (const metadata of [...this.records.values()]) {
      if (metadata.expiresAt > now && metadata.state !== 'COMPLETED') continue
      try { if (await this.discard(metadata.resumeId)) removed += 1 } catch (error) {
        if (error?.code !== 'DOWNLOAD_RESUME_BUSY') throw error
      }
    }
    return removed
  }

  async reconcile () {
    this._assertReady()
    if (!this.persist) {
      const entries = await fs.promises.readdir(this.root, { withFileTypes: true })
      for (const entry of entries) {
        if (PART_RE.test(entry.name) || SLOT_RE.test(entry.name) || RESERVATION_RE.test(entry.name) || LOCK_RE.test(entry.name) || TEMP_RE.test(entry.name)) {
          await fs.promises.unlink(path.join(this.root, entry.name)).catch((error) => { if (error?.code !== 'ENOENT') throw error })
        }
      }
      this.records.clear()
      this.destinationReservations.clear()
      return { available: 0, discarded: 0 }
    }

    const entries = await fs.promises.readdir(this.root, { withFileTypes: true })
    const slots = new Map()
    const partIds = new Set()
    const reservationFiles = []
    for (const entry of entries) {
      const slot = SLOT_RE.exec(entry.name)
      const part = PART_RE.exec(entry.name)
      if (slot) {
        if (!slots.has(slot[1])) slots.set(slot[1], [])
        slots.get(slot[1]).push(path.join(this.root, entry.name))
      } else if (part) partIds.add(part[1])
      else if (RESERVATION_RE.test(entry.name)) reservationFiles.push(path.join(this.root, entry.name))
      else if (TEMP_RE.test(entry.name)) await fs.promises.unlink(path.join(this.root, entry.name)).catch(() => {})
    }

    const loaded = new Map()
    const invalidIds = new Set()
    for (const [resumeId, files] of slots) {
      const candidates = []
      for (const filePath of files) {
        try { candidates.push(await this._readSlot(filePath, resumeId)) } catch { /* another valid slot may survive a torn commit */ }
      }
      candidates.sort((left, right) => right.generation - left.generation)
      if (!candidates.length) invalidIds.add(resumeId)
      else loaded.set(resumeId, candidates[0])
    }

    const reservations = new Map()
    for (const filePath of reservationFiles) {
      try {
        const reservation = await this._readReservation(filePath)
        const expectedName = `${this._reservationHash(reservation.destinationKey)}.reserve`
        if (path.basename(filePath) !== expectedName || reservations.has(reservation.destinationKey)) throw new Error('reservation mismatch')
        reservations.set(reservation.destinationKey, { ...reservation, filePath })
      } catch {
        await fs.promises.unlink(filePath).catch(() => {})
      }
    }

    let discarded = 0
    this.records.clear()
    this.destinationReservations.clear()
    const destinationOwners = new Map()
    for (const [resumeId, metadata] of loaded) {
      const duplicate = destinationOwners.get(metadata.parent.destinationKey)
      if (duplicate) {
        invalidIds.add(duplicate)
        invalidIds.add(resumeId)
        continue
      }
      destinationOwners.set(metadata.parent.destinationKey, resumeId)
      this.records.set(resumeId, clone(metadata))
      this.destinationReservations.set(metadata.parent.destinationKey, resumeId)
    }

    for (const resumeId of invalidIds) {
      const lockPath = this._lockPath(resumeId)
      let live = false
      try { live = !(await this._lockIsStale(lockPath)) } catch { live = true }
      if (live) continue
      await this._deleteMetadataFiles(resumeId).catch(() => {})
      await fs.promises.unlink(this._partPath(resumeId)).catch(() => {})
      await fs.promises.unlink(lockPath).catch(() => {})
      this.records.delete(resumeId)
      partIds.delete(resumeId)
      discarded += 1
    }
    this.destinationReservations.clear()
    for (const metadata of this.records.values()) {
      this.destinationReservations.set(metadata.parent.destinationKey, metadata.resumeId)
    }

    for (const resumeId of [...partIds]) {
      if (this.records.has(resumeId)) continue
      const lockPath = this._lockPath(resumeId)
      let live = false
      try { live = !(await this._lockIsStale(lockPath)) } catch { live = true }
      if (live) continue
      await fs.promises.unlink(this._partPath(resumeId)).catch(() => {})
      await fs.promises.unlink(lockPath).catch(() => {})
      discarded += 1
    }

    for (const [destinationKey, reservation] of reservations) {
      const metadata = this.records.get(reservation.resumeId)
      if (!metadata || metadata.parent.destinationKey !== destinationKey) {
        let live = false
        try { live = !(await this._lockIsStale(this._lockPath(reservation.resumeId))) } catch { live = true }
        if (live) continue
        await fs.promises.unlink(reservation.filePath).catch(() => {})
        continue
      }
    }

    for (const metadata of [...this.records.values()]) {
      const reservation = reservations.get(metadata.parent.destinationKey)
      if (!reservation) {
        try {
          const buffer = await this._sealJson({
            magic: RESERVATION_MAGIC,
            version: STORE_VERSION,
            resumeId: metadata.resumeId,
            destinationKey: metadata.parent.destinationKey,
            createdAt: metadata.createdAt
          })
          await this._atomicCreate(this._reservationPath(metadata.parent.destinationKey), buffer)
        } catch {
          await this.discard(metadata.resumeId).catch(() => {})
          discarded += 1
          continue
        }
      } else if (reservation.resumeId !== metadata.resumeId) {
        await this.discard(metadata.resumeId).catch(() => {})
        discarded += 1
        continue
      }

      if (metadata.expiresAt <= this.now() || metadata.state === 'COMPLETED') {
        await this.discard(metadata.resumeId).catch(() => {})
        discarded += 1
        continue
      }
      const lockPath = this._lockPath(metadata.resumeId)
      let hasLiveLock = false
      try { hasLiveLock = !(await this._lockIsStale(lockPath)) } catch { hasLiveLock = true }
      if (hasLiveLock) continue
      await fs.promises.unlink(lockPath).catch(() => {})
      try {
        const lock = await this._acquireLock(metadata.resumeId)
        const part = await this._openPart(metadata)
        const entry = { metadata: clone(metadata), part, lock, persistent: true }
        if (metadata.state === 'ACTIVE') {
          if (!metadata.validator) {
            await this.discard(entry)
            discarded += 1
            continue
          }
          await this.pause(entry, { state: 'PAUSED_RETRYABLE', committedBytes: metadata.committedBytes })
        } else {
          await part.handle.close()
          part.handle = null
          await this._releaseLock(entry)
        }
      } catch {
        await this.discard(metadata.resumeId).catch(() => {})
        discarded += 1
      }
    }
    return { available: this.records.size, discarded }
  }

  async close () {
    if (this.closed) return
    for (const resumeId of [...this.locks.keys()]) await this._releaseLock(resumeId).catch(() => {})
    this.closed = true
  }
}

module.exports = Object.freeze({
  AgentDownloadResumeStore,
  AgentDownloadResumeStoreError,
  HTTP_DATE_RE,
  RESUME_ID_RE,
  STORE_VERSION,
  STRONG_ETAG_RE,
  validLastModified,
  validStrongETag,
  validValidator
})
