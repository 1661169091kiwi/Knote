'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OpenTargetCapabilityStore } = require('./open-target-capability.cjs')

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
