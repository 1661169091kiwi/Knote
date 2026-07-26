const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const fsp = fs.promises

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')

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
      const match = /^(\d{16})-(\d{13})-([a-f0-9]{64})\.md$/.exec(name)
      if (!match) continue
      const filePath = path.join(snapshots, name)
      let stat
      try { stat = await fsp.stat(filePath) } catch { continue }
      items.push({
        id: name,
        sequence: Number(match[1]),
        t: Number(match[2]),
        hash: match[3],
        label: '',
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
    if (current.length && current[0].hash === hash) return { ...current[0], duplicate: true }

    const { dir, snapshots } = await this._ensureDocumentDir(identity)
    const requestedTime = Number.isFinite(Number(options.time)) ? Number(options.time) : Date.now()
    const maxOnDisk = current.length ? current[0].sequence : 0
    const key = this.documentId(identity)
    const sequence = Math.max(Date.now(), maxOnDisk + 1, (this.lastSequence.get(key) || 0) + 1)
    this.lastSequence.set(key, sequence)
    const id = `${String(sequence).padStart(16, '0')}-${String(requestedTime).padStart(13, '0')}-${hash}.md`
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
    return { id, sequence, t: requestedTime, hash, label: String(options.label || ''), size: Buffer.byteLength(text), duplicate: false }
  }

  addSnapshot (identity, content, options = {}) {
    return this._enqueue(identity, () => this._addSnapshotUnlocked(identity, content, options))
  }

  async listSnapshots (identity) {
    const key = this.documentId(identity)
    const pending = this.queues.get(key)
    if (pending) await pending.catch(() => {})
    const items = await this._scan(identity)
    return items.map((item, index) => ({ ...item, index }))
  }

  async getSnapshot (identity, snapshotId) {
    const match = /^(\d{16})-(\d{13})-([a-f0-9]{64})\.md$/.exec(String(snapshotId || ''))
    if (!match) return null
    const snapshots = path.join(this.documentDir(identity), 'snapshots')
    try {
      const content = await fsp.readFile(path.join(snapshots, snapshotId), 'utf8')
      return sha256(content) === match[3] ? content : null
    } catch { return null }
  }

  async _atomicReplace (targetPath, content) {
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
    try {
      await fsp.rename(temp, target)
    } catch (error) {
      // Some Windows filesystems refuse rename-over-existing. Keep a recovery
      // copy in the same directory until the new file is fully in place.
      const recovery = path.join(dir, `.${path.basename(target)}.knote-recovery-${crypto.randomBytes(8).toString('hex')}`)
      let movedOld = false
      try {
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
      await this._addSnapshotUnlocked(identity, content, { time: options.time || Date.now(), label: options.label || 'save' })
      await this._atomicReplace(target, content)
      return { ok: true, identity: this.canonicalIdentity(identity) }
    })
  }

  async copyIdentityHistory (fromIdentity, toIdentity) {
    const fromDir = path.join(this.documentDir(fromIdentity), 'snapshots')
    const toInfo = await this._ensureDocumentDir(toIdentity)
    let names = []
    try { names = await fsp.readdir(fromDir) } catch { return false }
    for (const name of names) {
      if (!/^(\d{16})-(\d{13})-([a-f0-9]{64})\.md$/.test(name)) continue
      await fsp.copyFile(path.join(fromDir, name), path.join(toInfo.snapshots, name), fs.constants.COPYFILE_EXCL).catch((error) => {
        if (error.code !== 'EEXIST') throw error
      })
    }
    return true
  }
}

module.exports = { DocumentRetentionStore, sha256 }
