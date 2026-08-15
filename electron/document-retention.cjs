const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const fsp = fs.promises
const SNAPSHOT_RE = /^(\d{16})-(\d{13})-([a-f0-9]{64})(?:-([drheq]))?\.md$/
const DEFAULT_RETENTION = Object.freeze({
  maxCount: 160,
  targetCount: 144,
  maxBytes: 64 * 1024 * 1024,
  targetBytes: 56 * 1024 * 1024,
  recentCount: 20,
  recoveryCount: 12
})

const checkpointCode = (label) => {
  const value = String(label || '').toLowerCase()
  if (value.includes('delete') || value.includes('trash')) return 'd'
  if (value.includes('rename') || value === 'renamed') return 'r'
  if (/history[\s_-]*restore/.test(value)) return 'h'
  if (/external[\s_-]*update/.test(value)) return 'e'
  if (/quit[\s_-]*recovery/.test(value)) return 'q'
  return ''
}
const checkpointLabel = (code) => ({
  d: 'recovery:delete',
  r: 'recovery:rename',
  h: 'recovery:history',
  e: 'recovery:external',
  q: 'recovery:quit'
})[code] || ''

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')

const STAT_IDENTITY_FIELDS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']
const fileStatIdentity = (stat) => {
  if (!stat || typeof stat !== 'object') return null
  const identity = {}
  for (const field of STAT_IDENTITY_FIELDS) {
    if (stat[field] != null) identity[field] = String(stat[field])
  }
  if (identity.mtimeNs == null && stat.mtimeMs != null) identity.mtimeNs = String(Math.trunc(Number(stat.mtimeMs) * 1e6))
  if (identity.ctimeNs == null && stat.ctimeMs != null) identity.ctimeNs = String(Math.trunc(Number(stat.ctimeMs) * 1e6))
  return Object.keys(identity).length ? identity : null
}
const fileStatIdentityMatches = (expected, current) => {
  const wanted = fileStatIdentity(expected)
  const actual = fileStatIdentity(current)
  if (!wanted || !actual) return false
  return Object.entries(wanted).every(([field, value]) => actual[field] === value)
}
const conditionalCommitStaleError = (reason = 'target_changed') => Object.assign(
  new Error(`conditional document commit is stale: ${reason}`),
  { code: 'STALE_DOCUMENT', stale: true, reason }
)
const readFileState = async (targetPath) => {
  const handle = await fsp.open(path.resolve(targetPath), 'r')
  try {
    const before = await handle.stat({ bigint: true })
    const content = await handle.readFile('utf8')
    const after = await handle.stat({ bigint: true })
    return {
      content,
      stat: fileStatIdentity(after),
      stable: fileStatIdentityMatches(fileStatIdentity(before), fileStatIdentity(after))
    }
  } finally {
    await handle.close()
  }
}

const selectRetentionIds = (items, policy, protectedIds = []) => {
  const keep = new Set(protectedIds.filter(Boolean))
  for (const item of items.slice(0, policy.recentCount)) keep.add(item.id)
  const recovery = items.filter((item) => item.checkpoint)
  const families = new Set()
  for (const item of recovery) {
    if (families.has(item.checkpoint)) continue
    keep.add(item.id)
    families.add(item.checkpoint)
  }
  for (const item of recovery.slice(0, policy.recoveryCount)) keep.add(item.id)

  let retainedBytes = items.filter((item) => keep.has(item.id)).reduce((sum, item) => sum + item.size, 0)
  const candidates = items.filter((item) => !keep.has(item.id))
  const availableSlots = Math.max(0, policy.targetCount - keep.size)
  const sampleCount = Math.min(availableSlots, candidates.length)
  const sampledIndexes = new Set()
  for (let index = 0; index < sampleCount; index++) {
    const position = sampleCount === 1
      ? candidates.length - 1
      : Math.round(index * (candidates.length - 1) / (sampleCount - 1))
    sampledIndexes.add(position)
  }
  for (const index of [...sampledIndexes].sort((a, b) => b - a)) {
    const item = candidates[index]
    if (!item || keep.size >= policy.targetCount) break
    if (retainedBytes + item.size > policy.targetBytes) continue
    keep.add(item.id)
    retainedBytes += item.size
  }
  return keep
}

const atomicJson = async (filePath, value) => {
  const dir = path.dirname(filePath)
  await fsp.mkdir(dir, { recursive: true })
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  const handle = await fsp.open(temp, 'wx')
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fsp.rename(temp, filePath)
}

class DocumentRetentionStore {
  constructor (rootDir, options = {}) {
    this.rootDir = path.resolve(rootDir)
    this.platform = options.platform || process.platform
    this.fault = options.fault || null
    this.retention = { ...DEFAULT_RETENTION, ...(options.retention || {}) }
    this.queues = new Map()
    this.lastSequence = new Map()
  }

  canonicalIdentity (identity) {
    let raw = String(identity || '').trim()
    if (!raw) throw new Error('document identity is required')
    if (raw.startsWith('file:')) {
      const resolved = path.resolve(raw.slice(5)).replace(/\\/g, '/')
      raw = `file:${this.platform === 'win32' ? resolved.toLowerCase() : resolved}`
    } else {
      raw = raw.replace(/\\/g, '/')
      if (this.platform === 'win32' && /^(tree:|native:)/.test(raw)) raw = raw.toLowerCase()
    }
    return raw
  }

  documentId (identity) {
    return sha256(this.canonicalIdentity(identity))
  }

  documentDir (identity) {
    return path.join(this.rootDir, this.documentId(identity))
  }

  _enqueue (identity, work) {
    const key = this.documentId(identity)
    const previous = this.queues.get(key) || Promise.resolve()
    const operation = previous.catch(() => {}).then(work)
    const tracked = operation.then(() => undefined, () => undefined).finally(() => {
      if (this.queues.get(key) === tracked) this.queues.delete(key)
    })
    this.queues.set(key, tracked)
    return operation
  }

  async _fault (point, context) {
    if (typeof this.fault === 'function') await this.fault(point, context)
  }

  async _ensureDocumentDir (identity) {
    const canonical = this.canonicalIdentity(identity)
    const dir = this.documentDir(canonical)
    const snapshots = path.join(dir, 'snapshots')
    await fsp.mkdir(snapshots, { recursive: true })
    const identityPath = path.join(dir, 'identity.json')
    try {
      const current = JSON.parse(await fsp.readFile(identityPath, 'utf8'))
      if (current.canonicalIdentity !== canonical) throw new Error('document history identity collision')
    } catch (error) {
      if (error && error.message === 'document history identity collision') throw error
      if (error.code === 'ENOENT') {
        await atomicJson(identityPath, {
          format: 1,
          canonicalIdentity: canonical,
          createdAt: Date.now()
        })
      }
      // A corrupt identity hint cannot hide content: the directory itself is
      // already addressed by SHA-256(canonical identity), and snapshots are
      // recovered by scanning immutable files below it.
    }
    return { canonical, dir, snapshots }
  }

  async _scan (identity) {
    const { snapshots } = await this._ensureDocumentDir(identity)
    let names = []
    try { names = await fsp.readdir(snapshots) } catch { return [] }
    const items = []
    for (const name of names) {
      const match = SNAPSHOT_RE.exec(name)
      if (!match) continue
      const filePath = path.join(snapshots, name)
      let stat
      try { stat = await fsp.stat(filePath) } catch { continue }
      items.push({
        id: name,
        sequence: Number(match[1]),
        t: Number(match[2]),
        hash: match[3],
        checkpoint: match[4] || '',
        label: checkpointLabel(match[4]),
        size: stat.size
      })
    }
    items.sort((a, b) => b.sequence - a.sequence || b.id.localeCompare(a.id))
    return items
  }

  async _addSnapshotUnlocked (identity, content, options = {}) {
    const text = String(content == null ? '' : content)
    const hash = sha256(text)
    const current = await this._scan(identity)
    const checkpoint = checkpointCode(options.label)
    if (current.length && current[0].hash === hash && (!checkpoint || current[0].checkpoint === checkpoint)) {
      return { ...current[0], duplicate: true }
    }

    const { dir, snapshots } = await this._ensureDocumentDir(identity)
    const requestedTime = Number.isFinite(Number(options.time)) ? Number(options.time) : Date.now()
    const maxOnDisk = current.length ? current[0].sequence : 0
    const key = this.documentId(identity)
    const sequence = Math.max(Date.now(), maxOnDisk + 1, (this.lastSequence.get(key) || 0) + 1)
    this.lastSequence.set(key, sequence)
    const id = `${String(sequence).padStart(16, '0')}-${String(requestedTime).padStart(13, '0')}-${hash}${checkpoint ? `-${checkpoint}` : ''}.md`
    const target = path.join(snapshots, id)
    const handle = await fsp.open(target, 'wx')
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await this._fault('after-snapshot', { identity: this.canonicalIdentity(identity), target, content: text })
    // This file is only an acceleration hint. Listing and recovery scan the
    // immutable snapshot files directly, so a corrupt/missing head can never
    // make historical content disappear.
    try {
      await atomicJson(path.join(dir, 'head.json'), { id, hash, sequence, updatedAt: Date.now(), label: String(options.label || '') })
    } catch { /* immutable snapshot is already durable */ }
    return { id, sequence, t: requestedTime, hash, checkpoint, label: String(options.label || ''), size: Buffer.byteLength(text), duplicate: false }
  }

  async _pruneUnlocked (identity, protectedIds = []) {
    const items = await this._scan(identity)
    const totalBytes = items.reduce((sum, item) => sum + item.size, 0)
    const policy = this.retention
    if (items.length <= policy.maxCount && totalBytes <= policy.maxBytes) return { removed: 0 }

    const keep = selectRetentionIds(items, policy, protectedIds)

    const { snapshots } = await this._ensureDocumentDir(identity)
    let removed = 0
    for (const item of items) {
      if (keep.has(item.id)) continue
      try {
        await fsp.unlink(path.join(snapshots, item.id))
        removed++
      } catch { /* retaining excess history is safer than failing a save */ }
    }
    return { removed }
  }

  addSnapshot (identity, content, options = {}) {
    return this._enqueue(identity, async () => {
      const snapshot = await this._addSnapshotUnlocked(identity, content, options)
      await this._pruneUnlocked(identity, [snapshot.id]).catch(() => {})
      return snapshot
    })
  }

  async listSnapshots (identity) {
    const key = this.documentId(identity)
    const pending = this.queues.get(key)
    if (pending) await pending.catch(() => {})
    const items = await this._scan(identity)
    return items.map((item, index) => ({ ...item, index }))
  }

  async getSnapshot (identity, snapshotId) {
    const match = SNAPSHOT_RE.exec(String(snapshotId || ''))
    if (!match) return null
    const snapshots = path.join(this.documentDir(identity), 'snapshots')
    try {
      const content = await fsp.readFile(path.join(snapshots, snapshotId), 'utf8')
      return sha256(content) === match[3] ? content : null
    } catch { return null }
  }

  async _atomicReplace (targetPath, content, options = {}) {
    const target = path.resolve(targetPath)
    const dir = path.dirname(target)
    await fsp.mkdir(dir, { recursive: true })
    const temp = path.join(dir, `.${path.basename(target)}.knote-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`)
    const handle = await fsp.open(temp, 'wx')
    try {
      await handle.writeFile(String(content), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await this._fault('after-temp-write', { target, temp, content: String(content) })
    // Pure Node cannot bind this final condition check to the following rename
    // as one cross-process primitive. This narrows, but does not eliminate, the
    // external check-to-rename race; a native exclusive-handle broker is needed
    // for that stronger guarantee.
    try {
      if (typeof options.beforeCommit === 'function') await options.beforeCommit()
    } catch (error) {
      await fsp.unlink(temp).catch(() => {})
      throw error
    }
    try {
      await fsp.rename(temp, target)
    } catch (error) {
      // Some Windows filesystems refuse rename-over-existing. Keep a recovery
      // copy in the same directory until the new file is fully in place.
      const recovery = path.join(dir, `.${path.basename(target)}.knote-recovery-${crypto.randomBytes(8).toString('hex')}`)
      let movedOld = false
      try {
        // Windows rename-over-existing fallback has another mutation point.
        // Recheck before moving the old target out of the way.
        if (typeof options.beforeCommit === 'function') await options.beforeCommit()
        try { await fsp.rename(target, recovery); movedOld = true } catch (moveError) {
          if (moveError.code !== 'ENOENT') throw error
        }
        await this._fault('after-recovery-rename', { target, temp, recovery })
        await fsp.rename(temp, target)
        if (movedOld) await fsp.unlink(recovery).catch(() => {})
      } catch (fallbackError) {
        if (movedOld) {
          const targetExists = await fsp.stat(target).then(() => true, () => false)
          if (!targetExists) await fsp.rename(recovery, target).catch(() => {})
        }
        await fsp.unlink(temp).catch(() => {})
        throw fallbackError
      }
    } finally {
      await fsp.unlink(temp).catch(() => {})
    }
  }

  saveDocument (filePath, content, options = {}) {
    const target = path.resolve(String(filePath))
    const identity = `file:${target}`
    return this._enqueue(identity, async () => {
      let previous = null
      try { previous = await fsp.readFile(target, 'utf8') } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (previous != null) await this._addSnapshotUnlocked(identity, previous, { time: Date.now(), label: 'before-save' })
      // Persist the proposed version before touching the live document. A disk
      // failure therefore leaves either the old target or an immutable copy of
      // the new content; it can never destroy the only copy of either version.
      const proposed = await this._addSnapshotUnlocked(identity, content, { time: options.time || Date.now(), label: options.label || 'save' })
      const hasExpectedContent = Object.prototype.hasOwnProperty.call(options, 'expectedContent')
      const hasExpectedStat = options.expectedStat != null
      const verifyConditionalCommit = hasExpectedContent || hasExpectedStat
        ? async () => {
            let current
            try {
              current = await readFileState(target)
            } catch (error) {
              if (error?.code === 'ENOENT') throw conditionalCommitStaleError('target_missing')
              throw error
            }
            if (!current.stable) throw conditionalCommitStaleError('target_changed_while_reading')
            if (hasExpectedContent && current.content !== String(options.expectedContent)) {
              throw conditionalCommitStaleError('content_changed')
            }
            if (hasExpectedStat && !fileStatIdentityMatches(options.expectedStat, current.stat)) {
              throw conditionalCommitStaleError('identity_changed')
            }
          }
        : null
      await this._atomicReplace(target, content, { beforeCommit: verifyConditionalCommit })
      await this._pruneUnlocked(identity, [proposed.id]).catch(() => {})
      return { ok: true, identity: this.canonicalIdentity(identity) }
    })
  }

  async copyIdentityHistory (fromIdentity, toIdentity) {
    const fromDir = path.join(this.documentDir(fromIdentity), 'snapshots')
    const toInfo = await this._ensureDocumentDir(toIdentity)
    let names = []
    try { names = await fsp.readdir(fromDir) } catch { return false }
    for (const name of names) {
      if (!SNAPSHOT_RE.test(name)) continue
      await fsp.copyFile(path.join(fromDir, name), path.join(toInfo.snapshots, name), fs.constants.COPYFILE_EXCL).catch((error) => {
        if (error.code !== 'EEXIST') throw error
      })
    }
    await this._pruneUnlocked(toIdentity).catch(() => {})
    return true
  }
}

module.exports = {
  DocumentRetentionStore,
  sha256,
  DEFAULT_RETENTION,
  conditionalCommitStaleError,
  fileStatIdentity,
  fileStatIdentityMatches,
  readFileState
}
