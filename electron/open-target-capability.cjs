'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const VALID_TYPES = new Set(['file', 'folder'])
const nativeRealpath = (target) => {
  if (fs.realpathSync.native) {
    try {
      return path.resolve(fs.realpathSync.native(target))
    } catch (error) {
      // Windows can deny the native handle-based probe for a traversable
      // profile ancestor while the regular realpath can still resolve it.
      // Both consumers must agree on the same resolution strategy, otherwise
      // canonical strings differ across hosts and folder grants regress.
      if (!error || !['EPERM', 'EACCES'].includes(error.code)) throw error
    }
  }
  return path.resolve(fs.realpathSync(target))
}
const targetSnapshot = (target) => {
  const lexical = path.resolve(String(target || ''))
  const canonical = nativeRealpath(lexical)
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

// A stored secret is 32 raw bytes. Older builds sealed it with a host hook
// (safeStorage), and that seal is scoped to the APPLICATION IDENTITY: the dev
// build ("knote") and the packaged build ("Knote") share %APPDATA% on Windows
// but not the sealing key, so a launch under the other name could not open the
// secret, minted a fresh one, and silently invalidated every capability issued
// before it — which is how "recently opened" started reporting its files as
// missing. `decrypt` is the host's best-effort opener for that legacy format;
// anything it cannot open is treated as absent (a new secret is generated).
const SECRET_BYTES = 32
const readSecretBytes = (value, decrypt) => {
  const raw = Buffer.from(value)
  if (raw.length === SECRET_BYTES) return raw
  if (typeof decrypt !== 'function') return raw
  try {
    const opened = Buffer.from(decrypt(raw))
    return opened.length === SECRET_BYTES ? opened : raw
  } catch { return raw }
}

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
    let storedBytes = null
    try {
      const stored = fs.readFileSync(this.secretFile)
      existing = true
      storedBytes = stored
      const opened = Buffer.from(this.unseal(stored))
      if (opened.length === SECRET_BYTES) this.secret = opened
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
        if (opened.length !== SECRET_BYTES) throw new Error('invalid open target capability secret')
        this.secret = opened
      }
    } else if (storedBytes) {
      // Canonicalise the stored form. An older build may have written the secret
      // a way THIS build's seal does not produce (e.g. sealed with a host key
      // that is scoped to the application identity). The bytes are kept — only
      // the storage form changes — so the next launch of any flavour sharing
      // this profile reads it without needing the legacy opener.
      const canonical = Buffer.from(this.seal(this.secret))
      if (!canonical.equals(storedBytes)) {
        try { fs.writeFileSync(this.secretFile, canonical, { mode: 0o600 }) } catch { /* the readable secret still works */ }
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

module.exports = { OpenTargetCapabilityStore, readSecretBytes, SECRET_BYTES }
