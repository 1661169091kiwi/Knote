'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OpenTargetCapabilityStore, readSecretBytes, SECRET_BYTES } = require('./open-target-capability.cjs')
const { saveSingleFile } = require('./single-file-save.cjs')
const { DocumentRetentionStore } = require('./document-retention.cjs')

test('single-document atomic saves renew only their own committed identity and reopen capability', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-single-save-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'document.md')
  fs.writeFileSync(target, 'original')
  const capabilities = new OpenTargetCapabilityStore(path.join(directory, 'caps'))
  const retention = new DocumentRetentionStore(path.join(directory, 'history'))
  const grant = { expected: capabilities.snapshot('file', target) }
  const oldToken = capabilities.issueSnapshot('file', grant.expected)
  const save = (data) => saveSingleFile({ target, data, grant, capabilities,
    authorize: ({ committed = false } = {}) => { if (!committed && !capabilities.matches('file', grant.expected)) throw new Error('destination changed') },
    saveDocument: (file, text, options) => retention.saveDocument(file, text, options)
  })
  let token
  for (let i = 0; i < 4; i++) {
    token = await save(`version-${i}`)
    assert.equal(fs.readFileSync(target, 'utf8'), `version-${i}`)
    assert.equal(capabilities.matches('file', grant.expected), true)
    assert.equal(capabilities.verify('file', token).path, target)
  }
  assert.throws(() => capabilities.verify('file', oldToken), /destination changed/)
  const restarted = new OpenTargetCapabilityStore(path.join(directory, 'caps'))
  assert.equal(restarted.verify('file', token).path, target)
  const history = await retention.listSnapshots(`file:${target}`)
  assert.ok(history.length >= 5)
  fs.renameSync(target, path.join(directory, 'external-original.md'))
  fs.writeFileSync(target, 'external replacement')
  await assert.rejects(save('must not overwrite'), /destination changed/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'external replacement')
})

test('first Save As creates an exact-file capability without authorizing sibling files', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-first-save-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'new.md')
  const capabilities = new OpenTargetCapabilityStore(path.join(directory, 'caps'))
  const retention = new DocumentRetentionStore(path.join(directory, 'history'))
  const grant = { expected: null }
  const token = await saveSingleFile({ target, data: 'first', grant, capabilities,
    authorize: () => {}, saveDocument: (...args) => retention.saveDocument(...args)
  })
  assert.equal(capabilities.verify('file', token).path, target)
  assert.equal(capabilities.matches('file', grant.expected), true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'first')
})

test('single-document grant renewal rejects an unrelated post-save replacement', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-single-replace-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'document.md')
  fs.writeFileSync(target, 'original')
  const capabilities = new OpenTargetCapabilityStore(path.join(directory, 'caps'))
  const retention = new DocumentRetentionStore(path.join(directory, 'history'))
  const grant = { expected: capabilities.snapshot('file', target) }
  const previous = grant.expected
  await assert.rejects(saveSingleFile({ target, data: 'saved', grant, capabilities, authorize: () => {},
    saveDocument: async (...args) => {
      const receipt = await retention.saveDocument(...args)
      fs.renameSync(target, path.join(directory, 'saved-copy.md'))
      fs.writeFileSync(target, 'intruder')
      return receipt
    }
  }), { code: 'WRITE_COMMIT_UNCERTAIN' })
  assert.equal(grant.expected, previous)
  assert.equal(fs.readFileSync(target, 'utf8'), 'intruder')
})

test('open target capabilities survive restart and reject forged paths or types', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-open-capability-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'workspace')
  fs.mkdirSync(target)
  const first = new OpenTargetCapabilityStore(path.join(directory, 'store'))
  const snapshot = first.snapshot('folder', target)
  const token = first.issueSnapshot('folder', snapshot)
  const second = new OpenTargetCapabilityStore(path.join(directory, 'store'))
  assert.equal(second.verify('folder', token).path, path.resolve(target))
  assert.throws(() => second.verify('file', token), /invalid open target capability/)
  assert.throws(() => second.verify('folder', token.replace(/.$/, token.endsWith('a') ? 'b' : 'a')), /invalid open target capability/)
})

test('folder capabilities reject a junction whose destination changed after restart', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-open-capability-link-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstTarget = path.join(directory, 'first')
  const secondTarget = path.join(directory, 'second')
  const selected = path.join(directory, 'selected')
  fs.mkdirSync(firstTarget)
  fs.mkdirSync(secondTarget)
  try { fs.symlinkSync(firstTarget, selected, process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
    if (error && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('junction creation is unavailable')
    throw error
  }
  const store = new OpenTargetCapabilityStore(path.join(directory, 'store'))
  const token = store.issue('folder', selected)
  fs.rmSync(selected, { recursive: true, force: true })
  fs.symlinkSync(secondTarget, selected, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => store.verify('folder', token), /destination changed/)
})

test('capabilities reject a replacement object at the same lexical path', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-open-capability-replaced-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'note.md')
  fs.writeFileSync(target, 'first')
  const store = new OpenTargetCapabilityStore(path.join(directory, 'store'))
  const token = store.issue('file', target)
  fs.renameSync(target, path.join(directory, 'old.md'))
  fs.writeFileSync(target, 'replacement')
  assert.throws(() => store.verify('file', token), /destination changed/)
})

test('secret persistence can seal raw HMAC key bytes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-open-capability-sealed-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'workspace')
  fs.mkdirSync(target)
  const seal = (value) => Buffer.concat([Buffer.from('sealed:'), Buffer.from(value).map((byte) => byte ^ 0x5a)])
  const unseal = (value) => Buffer.from(value).subarray(7).map((byte) => byte ^ 0x5a)
  const first = new OpenTargetCapabilityStore(path.join(directory, 'store'), { seal, unseal })
  const token = first.issue('folder', target)
  const stored = fs.readFileSync(path.join(directory, 'store', 'secret.bin'))
  assert.equal(stored.subarray(0, 7).toString(), 'sealed:')
  assert.notEqual(stored.length, 32)
  const second = new OpenTargetCapabilityStore(path.join(directory, 'store'), { seal, unseal })
  assert.equal(second.verify('folder', token).path, target)
})

test('a secret sealed by an older build keeps working across flavours and is rewritten unsealed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-capability-migrate-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const storeDir = path.join(directory, 'caps')
  const secretFile = path.join(storeDir, 'secret.bin')
  const target = path.join(directory, 'doc.md')
  fs.writeFileSync(target, '# x\n')

  // what the old build did: a host hook whose key is scoped to the APPLICATION
  // IDENTITY — the dev build and the packaged build share %APPDATA% on Windows
  // but not that key, which silently rotated the secret (and killed every
  // capability issued before it: "最近打开失效")
  const scope = 'flavour-a'
  const seal = (value) => Buffer.concat([Buffer.from(`${scope}:`), Buffer.from(value).map((byte) => byte ^ 0x5a)])
  const unseal = (value) => Buffer.from(value.subarray(scope.length + 1)).map((byte) => byte ^ 0x5a)

  const legacy = new OpenTargetCapabilityStore(storeDir, { seal, unseal })
  const token = legacy.issue('file', target)
  assert.notEqual(fs.readFileSync(secretFile).length, SECRET_BYTES, 'the legacy store seals the secret on disk')

  // the same profile opened by the current build: `unseal` understands the old
  // form, `seal` is identity, so the file is canonicalised to raw bytes
  const current = { unseal: (value) => readSecretBytes(value, unseal) }
  const migrated = new OpenTargetCapabilityStore(storeDir, current)
  assert.equal(migrated.verify('file', token).path, target, 'a token issued before the migration must keep working')
  assert.equal(fs.readFileSync(secretFile).length, SECRET_BYTES, 'the secret is rewritten in the portable form')

  // and a THIRD reader — even one with no legacy opener at all — now works too
  const fresh = new OpenTargetCapabilityStore(storeDir)
  assert.equal(fresh.verify('file', token).path, target, 'no host-scoped key is needed after the migration')
})

test('main.cjs keeps the capability secret portable (no flavour-scoped seal)', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
  // safeStorage seals with a key scoped to the application identity: the dev
  // ("knote") and packaged ("Knote") builds share %APPDATA% but not that key, so
  // sealing the secret silently rotated it on every flavour switch and every
  // capability issued before that (the "recently opened" list) stopped verifying
  assert.doesNotMatch(main, /OpenTargetCapabilityStore\([\s\S]{0,300}?seal:/, 'the capability secret must not be sealed with a flavour-scoped key')
  assert.match(main, /unseal: unsealCapabilitySecret/, 'a legacy sealed secret must still be readable (one-time migration)')
})
