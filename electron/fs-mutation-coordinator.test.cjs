'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createFsMutationCoordinator } = require('./fs-mutation-coordinator.cjs')

const key = (value) => String(value).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
const make = () => createFsMutationCoordinator({ toKey: key, separator: '/' })

test('mutations run strictly in submission order', async () => {
  const coordinator = make()
  const events = []
  let release
  let signalStarted
  const gate = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { signalStarted = resolve })
  const first = coordinator.run(async () => {
    events.push('first:start')
    signalStarted()
    await gate
    events.push('first:end')
  })
  const second = coordinator.run(async () => { events.push('second') })
  await started
  assert.deepEqual(events, ['first:start'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(events, ['first:start', 'first:end', 'second'])
})

test('a failed mutation never poisons later work', async () => {
  const coordinator = make()
  await assert.rejects(coordinator.run(async () => { throw new Error('expected') }), /expected/)
  assert.equal(await coordinator.run(async () => 42), 42)
})

test('a stale directory blocks every delayed descendant write', () => {
  const coordinator = make()
  coordinator.markStale('D:/Notes/old')
  assert.equal(coordinator.isStale('d:/notes/old/file.md'), true)
  assert.throws(
    () => coordinator.assertWritable('D:/Notes/old/assets/late.png'),
    (error) => error && error.code === 'STALE_PATH_WRITE_BLOCKED'
  )
  assert.equal(coordinator.isStale('D:/Notes/other/file.md'), false)
})

test('explicit recreation clears only that exact stale root and its descendants', () => {
  const coordinator = make()
  coordinator.markStale('D:/Notes/old')
  coordinator.markStale('D:/Notes/other')
  coordinator.clearStale('D:/Notes/old')
  assert.equal(coordinator.isStale('D:/Notes/old/file.md'), false)
  assert.equal(coordinator.isStale('D:/Notes/other/file.md'), true)
})

test('ancestor tombstones compact already-stale descendants', () => {
  const coordinator = make()
  coordinator.markStale('D:/Notes/old/a.md')
  coordinator.markStale('D:/Notes/old/assets')
  coordinator.markStale('D:/Notes/old')
  assert.deepEqual(coordinator.staleRootsForTest(), ['d:/notes/old'])
})

test('every write/destructive IPC path uses the mutation coordinator', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
  for (const channel of [
    'knote:write-file',
    'knote:fs-write',
    'knote:fs-create',
    'knote:fs-delete',
    'knote:fs-mkdir',
    'knote:write-image-file',
    'knote:fs-rename',
    'knote:trash'
  ]) {
    const marker = "ipcMain.handle('" + channel + "'"
    const start = source.indexOf(marker)
    assert.ok(start >= 0, channel + ' handler is missing')
    assert.match(source.slice(start, start + 240), /serializeFsMutation\(/, channel + ' bypasses the coordinator')
  }
})
