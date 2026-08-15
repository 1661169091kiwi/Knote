'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { statMtimeMs } = require('./file-stat-time.cjs')

test('BigInt nanosecond stats preserve the fractional milliseconds used by regular stats', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-stat-time-'))
  const target = path.join(root, 'sample.md')
  fs.writeFileSync(target, 'sample\n')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const regular = fs.statSync(target)
  const precise = fs.statSync(target, { bigint: true })
  assert.equal(statMtimeMs(precise), regular.mtimeMs)
  assert.equal(statMtimeMs({ mtimeNs: 1_786_427_803_094_265_400n }), 1_786_427_803_094.2654)
})

test('regular number stats remain supported', () => {
  assert.equal(statMtimeMs({ mtimeMs: 1234.125 }), 1234.125)
})
