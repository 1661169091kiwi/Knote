'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const VALID_TYPES = new Set(['file', 'folder'])
const targetSnapshot = (target) => {
  const lexical = path.resolve(String(target || ''))
  const canonical = path.resolve(fs.realpathSync(lexical))
  const stat = fs.statSync(lexical, { bigint: true })
  return {
    path: lexical,
    canonical,
    dev: String(stat.dev),
    ino: String(stat.ino),
    kind: stat.isDirectory() ? 'folder' : stat.isFile() ? 'file' : 'other'
  }
}
const sameSnapshot = (left, right) => (
  left.path === right.path &&
  left.canonical === right.canonical &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.kind === right.kind
)

class OpenTargetCapabilityStore {
  constructor (directory, { persist = true, seal = (value) => value, unseal = (value) => value } = {}) {
    this.directory = path.resolve(String(directory || ''))
    this.secretFile = path.join(this.directory, 'secret.bin')
    this.persist = !!persist
    this.seal = seal
    this.unseal = unseal
    this.secret = null
  }

  loadSecret () {
    if (this.secret) return this.secret
    if (!this.persist) {
      this.secret = crypto.randomBytes(32)
      return this.secret
    }
    fs.mkdirSync(this.directory, { recursive: true })
    let existing = false
    try {
      const stored = fs.readFileSync(this.secretFile)
      existing = true
      const opened = Buffer.from(this.unseal(stored))
      if (opened.length === 32) this.secret = opened
    } catch { /* create below */ }
    if (!this.secret) {
      const created = crypto.randomBytes(32)
      const sealed = Buffer.from(this.seal(created))
      try {
        fs.writeFileSync(this.secretFile, sealed, { mode: 0o600, flag: existing ? 'w' : 'wx' })
        this.secret = created
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const stored = fs.readFileSync(this.secretFile)
        const opened = Buffer.from(this.unseal(stored))
        if (opened.length !== 32) throw new Error('invalid open target capability secret')
        this.secret = opened
      }
    }
    return this.secret
  }

  issue (type, target) {
    if (!VALID_TYPES.has(type)) throw new TypeError('invalid open target type')
    const snapshot = targetSnapshot(target)
    if (snapshot.kind !== type) throw new TypeError('open target type does not match the filesystem object')
    return this.issueSnapshot(type, snapshot)
  }

  issueSnapshot (type, snapshot) {
    if (!VALID_TYPES.has(type) || !snapshot || snapshot.kind !== type) throw new TypeError('invalid open target snapshot')
    const payload = Buffer.from(JSON.stringify({ v: 3, type, ...snapshot })).toString('base64url')
    const signature = crypto.createHmac('sha256', this.loadSecret()).update(payload).digest('base64url')
    return `${payload}.${signature}`
  }

  snapshot (type, target) {
    if (!VALID_TYPES.has(type)) throw new TypeError('invalid open target type')
    const snapshot = targetSnapshot(target)
    if (snapshot.kind !== type) throw new TypeError('open target type does not match the filesystem object')
    return snapshot
  }

  verify (type, capability) {
    if (!VALID_TYPES.has(type)) throw new TypeError('invalid open target type')
    const token = String(capability || '')
    if (token.length > 8192) throw new Error('invalid open target capability')
    const separator = token.lastIndexOf('.')
    if (separator <= 0) throw new Error('invalid open target capability')
    const payload = token.slice(0, separator)
    const signature = token.slice(separator + 1)
    const supplied = Buffer.from(signature, 'base64url')
    const expected = crypto.createHmac('sha256', this.loadSecret()).update(payload).digest()
    if (supplied.toString('base64url') !== signature || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      throw new Error('invalid open target capability')
    }
    let parsed
    try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { throw new Error('invalid open target capability') }
    if (
      parsed?.v !== 3 ||
      parsed?.type !== type ||
      typeof parsed?.path !== 'string' ||
      !path.isAbsolute(parsed.path) ||
      typeof parsed?.canonical !== 'string' ||
      !path.isAbsolute(parsed.canonical) ||
      typeof parsed?.dev !== 'string' ||
      typeof parsed?.ino !== 'string' ||
      parsed?.kind !== type
    ) {
      throw new Error('invalid open target capability')
    }
    let current
    try { current = targetSnapshot(parsed.path) } catch { throw new Error('open target is no longer available') }
    const approved = { path: path.resolve(parsed.path), canonical: path.resolve(parsed.canonical), dev: parsed.dev, ino: parsed.ino, kind: parsed.kind }
    if (!sameSnapshot(current, approved)) throw new Error('open target destination changed')
    return approved
  }

  matches (type, snapshot) {
    if (!snapshot || snapshot.kind !== type) return false
    try { return sameSnapshot(targetSnapshot(snapshot.path), snapshot) } catch { return false }
  }
}

module.exports = { OpenTargetCapabilityStore }
