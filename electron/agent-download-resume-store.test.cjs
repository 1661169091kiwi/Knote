'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  AgentDownloadResumeStore,
  AgentDownloadResumeStoreError
} = require('./agent-download-resume-store.cjs')

const encryptedCodec = (key = crypto.randomBytes(32)) => ({
  key,
  seal (text) {
    const nonce = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
    const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()])
    return Buffer.concat([nonce, cipher.getAuthTag(), body])
  },
  unseal (sealed) {
    const value = Buffer.from(sealed)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12), { authTagLength: 16 })
    decipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
  }
})

const makeFixture = async (options = {}) => {
  const root = options.root || await fs.promises.mkdtemp(path.join(os.tmpdir(), 'knote-download-resume-store-'))
  const userData = path.join(root, 'user-data')
  const workspace = path.join(root, 'workspace')
  const parent = path.join(workspace, 'downloads')
  await fs.promises.mkdir(userData, { recursive: true })
  await fs.promises.mkdir(parent, { recursive: true })
  const workspaceStat = await fs.promises.stat(workspace, { bigint: true })
  const parentStat = await fs.promises.stat(parent, { bigint: true })
  const canonicalWorkspace = await fs.promises.realpath(workspace)
  const target = path.join(parent, options.name || 'report.pdf')
  const destinationKey = process.platform === 'win32' ? target.toLowerCase() : target
  const binding = {
    workspace: {
      lexical: workspace,
      canonical: canonicalWorkspace,
      dev: String(workspaceStat.dev),
      ino: String(workspaceStat.ino)
    },
    parent: {
      dev: String(parentStat.dev),
      ino: String(parentStat.ino),
      destinationKey
    },
    relativePath: `downloads/${path.basename(target)}`,
    maxBytes: 128 * 1024 * 1024
  }
  const codec = options.codec || encryptedCodec()
  const storeOptions = {
    boundaryDir: userData,
    legacyRoot: path.join(userData, 'agent-download-quarantine', 'v1'),
    persist: options.persist !== false,
    seal: codec.seal,
    unseal: codec.unseal,
    ttlMs: options.ttlMs,
    now: options.now,
    hooks: options.hooks,
    processId: options.processId,
    isProcessAlive: options.isProcessAlive
  }
  const v2 = path.join(userData, 'agent-download-quarantine', 'v2')
  const store = new AgentDownloadResumeStore(v2, storeOptions)
  await store.initialize()
  const create = (extra = {}) => store.create({
    ...binding,
    currentUrl: 'https://files.example/report.pdf?token=top-secret-signed-value',
    finalUrl: 'https://files.example/report.pdf?token=top-secret-signed-value',
    approvedOrigin: 'https://files.example',
    ...extra
  })
  const cleanup = async () => {
    await store.close().catch(() => {})
    if (!options.keep) await fs.promises.rm(root, { recursive: true, force: true })
  }
  return { root, userData, workspace, parent, target, binding, codec, v2, store, create, cleanup }
}

const writeAtEnd = async (entry, value) => {
  const buffer = Buffer.from(value)
  let offset = entry.metadata.committedBytes
  let source = 0
  while (source < buffer.length) {
    const written = await entry.part.handle.write(buffer, source, buffer.length - source, offset)
    assert.ok(written.bytesWritten > 0)
    source += written.bytesWritten
    offset += written.bytesWritten
  }
  return offset
}

const stablePatch = (entry, committedBytes, extra = {}) => ({
  committedBytes,
  knownTotal: extra.knownTotal === undefined ? committedBytes + 100 : extra.knownTotal,
  validator: extra.validator || { kind: 'etag', value: '"version-1"' },
  contentEncoding: 'identity',
  contentType: 'application/pdf',
  contentDisposition: 'attachment; filename="report.pdf"',
  ...extra
})

test('encrypted download resume store keeps durable bytes and authority fail closed', async (t) => {
  await t.test('creates a 256-bit filename-safe id and never writes signed URLs in plaintext', async () => {
    const fixture = await makeFixture()
    try {
      const legacy = path.join(fixture.userData, 'agent-download-quarantine', 'v1')
      await fs.promises.mkdir(legacy, { recursive: true })
      await fs.promises.writeFile(path.join(legacy, `${'a'.repeat(48)}.part`), 'old partial')
      await fs.promises.writeFile(path.join(legacy, 'keep.txt'), 'not a legacy part')
      await fixture.store.close()
      const next = new AgentDownloadResumeStore(fixture.v2, {
        boundaryDir: fixture.userData,
        legacyRoot: legacy,
        persist: true,
        seal: fixture.codec.seal,
        unseal: fixture.codec.unseal
      })
      await next.initialize()
      fixture.store = next
      const entry = await next.create({
        ...fixture.binding,
        currentUrl: 'https://files.example/report.pdf?token=top-secret-signed-value',
        finalUrl: 'https://files.example/report.pdf?token=top-secret-signed-value',
        approvedOrigin: 'https://files.example'
      })
      assert.match(entry.metadata.resumeId, /^[A-Za-z0-9_-]{43}$/)
      assert.equal(entry.metadata.part.filename, `${entry.metadata.resumeId}.part`)
      assert.equal((await entry.part.handle.stat({ bigint: true })).nlink, 1n)
      const files = await fs.promises.readdir(fixture.v2)
      const disk = Buffer.concat(await Promise.all(files.map((name) => fs.promises.readFile(path.join(fixture.v2, name)))))
      assert.equal(disk.includes(Buffer.from('top-secret-signed-value')), false)
      assert.equal(disk.includes(Buffer.from('https://files.example')), false)
      assert.deepEqual(await fs.promises.readdir(legacy), ['keep.txt'])
      await fixture.store.discard(entry)
    } finally { await fixture.cleanup() }
  })

  await t.test('safeStorage-unavailable mode writes no metadata and startup removes its orphan part', async () => {
    const fixture = await makeFixture({ persist: false, keep: true })
    try {
      const entry = await fixture.create()
      assert.equal(entry.persistent, false)
      assert.deepEqual((await fs.promises.readdir(fixture.v2)).filter((name) => name.includes('.meta.')), [])
      assert.equal((await fs.promises.readdir(fixture.v2)).some((name) => name.endsWith('.reserve')), false)
      await entry.part.handle.close()
      entry.part.handle = null
      await fixture.store.close()
      const restarted = new AgentDownloadResumeStore(fixture.v2, {
        boundaryDir: fixture.userData,
        persist: false
      })
      await restarted.initialize()
      assert.deepEqual(await restarted.scan(), [])
      assert.deepEqual(await fs.promises.readdir(fixture.v2), [])
      await restarted.close()
    } finally {
      await fs.promises.rm(fixture.root, { recursive: true, force: true })
    }
  })

  await t.test('commit fsyncs the exact part before advancing encrypted metadata', async () => {
    const fixture = await makeFixture()
    try {
      const entry = await fixture.create()
      const bytes = await writeAtEnd(entry, '%PDF-1.7\ncheckpoint')
      let synced = false
      const originalSync = entry.part.handle.sync.bind(entry.part.handle)
      entry.part.handle.sync = async () => { synced = true; return originalSync() }
      const metadata = await fixture.store.commit(entry, stablePatch(entry, bytes))
      assert.equal(synced, true)
      assert.equal(metadata.committedBytes, bytes)
      assert.ok(metadata.generation > 1)
      await fixture.store.discard(entry)
    } finally { await fixture.cleanup() }
  })

  await t.test('a metadata commit crash rolls back to the older slot and truncates only through the verified handle', async () => {
    const fixture = await makeFixture({ keep: true })
    let entry
    try {
      entry = await fixture.create()
      const committed = await writeAtEnd(entry, '%PDF')
      await fixture.store.commit(entry, stablePatch(entry, committed, { knownTotal: 12 }))
      const physical = await writeAtEnd(entry, '-EXTRA')
      assert.equal(physical, 10)
      fixture.store.hooks.beforeMetadataReplace = () => { throw new Error('simulated metadata crash') }
      await assert.rejects(
        fixture.store.commit(entry, stablePatch(entry, physical, { knownTotal: 12 })),
        /simulated metadata crash/
      )
      await entry.part.handle.close()
      entry.part.handle = null
      await fixture.store.close()

      const restarted = new AgentDownloadResumeStore(fixture.v2, {
        boundaryDir: fixture.userData,
        persist: true,
        seal: fixture.codec.seal,
        unseal: fixture.codec.unseal,
        processId: process.pid + 100000,
        isProcessAlive: () => false
      })
      await restarted.initialize()
      const status = await restarted.status(entry.metadata.resumeId)
      assert.equal(status.state, 'PAUSED_RETRYABLE')
      assert.equal(status.committedBytes, committed)
      assert.equal((await fs.promises.stat(path.join(fixture.v2, status.part.filename))).size, committed)
      await restarted.discard(status.resumeId)
      await restarted.close()
    } finally {
      await fs.promises.rm(fixture.root, { recursive: true, force: true })
    }
  })

  await t.test('open accepts a newly issued grant only when workspace, parent, destination, path and limit identities match', async () => {
    const fixture = await makeFixture()
    try {
      const entry = await fixture.create()
      const bytes = await writeAtEnd(entry, '%PDF grant')
      await fixture.store.pause(entry, stablePatch(entry, bytes))
      const reconstructedGrant = JSON.parse(JSON.stringify(fixture.binding))
      const resumed = await fixture.store.open(entry.metadata.resumeId, reconstructedGrant)
      assert.equal(resumed.metadata.committedBytes, bytes)
      await fixture.store.pause(resumed, stablePatch(resumed, bytes))
      await assert.rejects(
        fixture.store.open(entry.metadata.resumeId, {
          ...reconstructedGrant,
          workspace: { ...reconstructedGrant.workspace, ino: String(BigInt(reconstructedGrant.workspace.ino) + 1n) }
        }),
        (error) => error instanceof AgentDownloadResumeStoreError && error.code === 'DOWNLOAD_RESUME_BINDING_MISMATCH'
      )
      await fixture.store.discard(entry.metadata.resumeId)
    } finally { await fixture.cleanup() }
  })

  await t.test('a short part is rejected and removed instead of being appended', async () => {
    const fixture = await makeFixture()
    try {
      const entry = await fixture.create()
      const bytes = await writeAtEnd(entry, '%PDF short')
      await fixture.store.pause(entry, stablePatch(entry, bytes))
      await fs.promises.truncate(entry.part.path, bytes - 1)
      await assert.rejects(
        fixture.store.open(entry.metadata.resumeId, fixture.binding),
        (error) => error.code === 'DOWNLOAD_RESUME_PART_SHORT'
      )
      assert.equal(await fixture.store.status(entry.metadata.resumeId), null)
      assert.equal(await fs.promises.stat(entry.part.path).then(() => true, () => false), false)
    } finally { await fixture.cleanup() }
  })

  await t.test('hard-linked and replaced part identities are rejected with no resume', async () => {
    const fixture = await makeFixture()
    try {
      let entry = await fixture.create()
      let bytes = await writeAtEnd(entry, '%PDF hardlink')
      await fixture.store.pause(entry, stablePatch(entry, bytes))
      const peer = path.join(fixture.v2, 'peer-hardlink')
      await fs.promises.link(entry.part.path, peer)
      await assert.rejects(
        fixture.store.open(entry.metadata.resumeId, fixture.binding),
        (error) => error.code === 'DOWNLOAD_RESUME_PART_INVALID'
      )
      await fs.promises.unlink(peer).catch(() => {})

      entry = await fixture.create({
        ...fixture.binding,
        parent: { ...fixture.binding.parent, destinationKey: `${fixture.binding.parent.destinationKey}.second` },
        relativePath: 'downloads/second.pdf'
      })
      bytes = await writeAtEnd(entry, '%PDF replaced')
      await fixture.store.pause(entry, stablePatch(entry, bytes))
      await fs.promises.unlink(entry.part.path)
      await fs.promises.writeFile(entry.part.path, '%PDF impostor', { flag: 'wx', mode: 0o600 })
      await assert.rejects(
        fixture.store.open(entry.metadata.resumeId, {
          ...fixture.binding,
          parent: { ...fixture.binding.parent, destinationKey: `${fixture.binding.parent.destinationKey}.second` },
          relativePath: 'downloads/second.pdf'
        }),
        (error) => error.code === 'DOWNLOAD_RESUME_PART_INVALID'
      )
      assert.equal(await fixture.store.status(entry.metadata.resumeId), null)
    } finally { await fixture.cleanup() }
  })

  await t.test('a symlink part is rejected without following its target', async (t) => {
    const fixture = await makeFixture()
    try {
      const entry = await fixture.create()
      const bytes = await writeAtEnd(entry, '%PDF symlink')
      await fixture.store.pause(entry, stablePatch(entry, bytes))
      const outside = path.join(fixture.root, 'outside-canary')
      await fs.promises.writeFile(outside, 'do not touch')
      await fs.promises.unlink(entry.part.path)
      try { await fs.promises.symlink(outside, entry.part.path, 'file') } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return t.skip('file symlinks are unavailable')
        throw error
      }
      await assert.rejects(
        fixture.store.open(entry.metadata.resumeId, fixture.binding),
        (error) => error.code === 'DOWNLOAD_RESUME_PART_INVALID'
      )
      assert.equal(await fs.promises.readFile(outside, 'utf8'), 'do not touch')
    } finally { await fixture.cleanup() }
  })

  await t.test('corrupt encrypted metadata and orphan parts are removed during reconciliation', async () => {
    const fixture = await makeFixture({ keep: true })
    try {
      const entry = await fixture.create()
      await entry.part.handle.close()
      entry.part.handle = null
      await fixture.store.close()
      const slot = (await fs.promises.readdir(fixture.v2)).find((name) => name.startsWith(`${entry.metadata.resumeId}.meta.`))
      await fs.promises.writeFile(path.join(fixture.v2, slot), 'forged cleartext metadata')
      const orphanId = AgentDownloadResumeStore.createResumeId()
      await fs.promises.writeFile(path.join(fixture.v2, `${orphanId}.part`), 'orphan', { flag: 'wx', mode: 0o600 })
      const restarted = new AgentDownloadResumeStore(fixture.v2, {
        boundaryDir: fixture.userData,
        persist: true,
        seal: fixture.codec.seal,
        unseal: fixture.codec.unseal,
        processId: process.pid + 100001,
        isProcessAlive: () => false
      })
      await restarted.initialize()
      assert.equal(await restarted.status(entry.metadata.resumeId), null)
      assert.equal(await fs.promises.stat(path.join(fixture.v2, `${orphanId}.part`)).then(() => true, () => false), false)
      await restarted.close()
    } finally { await fs.promises.rm(fixture.root, { recursive: true, force: true }) }
  })

  await t.test('one resume owns its lock and one persistent reservation owns its target', async () => {
    const fixture = await makeFixture()
    try {
      const first = await fixture.create()
      await assert.rejects(
        fixture.store.open(first.metadata.resumeId, fixture.binding),
        (error) => error.code === 'DOWNLOAD_RESUME_BUSY'
      )
      await assert.rejects(
        fixture.create(),
        (error) => error.code === 'DOWNLOAD_RESUME_AVAILABLE' && error.details.resumeId === first.metadata.resumeId
      )
      await fixture.store.discard(first)
    } finally { await fixture.cleanup() }
  })

  await t.test('a second store process cannot own the live resume or create a second part for its target', async () => {
    const fixture = await makeFixture()
    let peer
    try {
      const entry = await fixture.create()
      peer = new AgentDownloadResumeStore(fixture.v2, {
        boundaryDir: fixture.userData,
        persist: true,
        seal: fixture.codec.seal,
        unseal: fixture.codec.unseal,
        processId: process.pid + 200000,
        isProcessAlive: () => true
      })
      await peer.initialize()
      await assert.rejects(
        peer.open(entry.metadata.resumeId, fixture.binding),
        (error) => error.code === 'DOWNLOAD_RESUME_BUSY'
      )
      await assert.rejects(
        peer.create({
          ...fixture.binding,
          currentUrl: 'https://files.example/report.pdf',
          finalUrl: 'https://files.example/report.pdf',
          approvedOrigin: 'https://files.example'
        }),
        (error) => error.code === 'DOWNLOAD_RESUME_AVAILABLE' && error.details.resumeId === entry.metadata.resumeId
      )
      assert.equal((await fs.promises.readdir(fixture.v2)).filter((name) => name.endsWith('.part')).length, 1)
      await fixture.store.discard(entry)
    } finally {
      await peer?.close().catch(() => {})
      await fixture.cleanup()
    }
  })

  await t.test('Last-Modified metadata is resumable while weak ETag text is rejected by schema', async () => {
    const fixture = await makeFixture()
    try {
      const entry = await fixture.create()
      const bytes = await writeAtEnd(entry, '%PDF modified')
      await fixture.store.pause(entry, stablePatch(entry, bytes, {
        validator: { kind: 'last-modified', value: 'Wed, 12 Aug 2026 10:20:30 GMT' }
      }))
      const resumed = await fixture.store.open(entry.metadata.resumeId, fixture.binding)
      await assert.rejects(
        fixture.store.commit(resumed, stablePatch(resumed, bytes, {
          validator: { kind: 'etag', value: 'W/"weak"' }
        })),
        (error) => error.code === 'DOWNLOAD_RESUME_METADATA_INVALID'
      )
      await fixture.store.discard(resumed)
    } finally { await fixture.cleanup() }
  })

  await t.test('TTL cleanup removes the part, encrypted slots and destination reservation', async () => {
    let now = 1_800_000_000_000
    const fixture = await makeFixture({ now: () => now, ttlMs: 1000 })
    try {
      const entry = await fixture.create()
      const bytes = await writeAtEnd(entry, '%PDF ttl')
      await fixture.store.pause(entry, stablePatch(entry, bytes))
      now += 1001
      assert.equal(await fixture.store.cleanupExpired(), 1)
      assert.deepEqual(await fixture.store.scan(), [])
      assert.deepEqual((await fs.promises.readdir(fixture.v2)).filter((name) => name !== ''), [])
    } finally { await fixture.cleanup() }
  })

  await t.test('complete removes resumable state only after the verified part is no longer needed', async () => {
    const fixture = await makeFixture()
    try {
      const entry = await fixture.create()
      const bytes = await writeAtEnd(entry, '%PDF complete')
      await fixture.store.commit(entry, stablePatch(entry, bytes, { knownTotal: bytes }))
      assert.equal(await fixture.store.complete(entry), true)
      assert.equal(await fixture.store.status(entry.metadata.resumeId), null)
      assert.equal(await fs.promises.stat(entry.part.path).then(() => true, () => false), false)
      assert.deepEqual(await fs.promises.readdir(fixture.v2), [])
    } finally { await fixture.cleanup() }
  })
})
