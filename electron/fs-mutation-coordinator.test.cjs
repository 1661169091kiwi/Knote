'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createFsMutationCoordinator } = require('./fs-mutation-coordinator.cjs')
const { createFsWriteIfUnchanged } = require('./fs-write-if-unchanged.cjs')

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

const memoryCas = (coordinator, initial, saveOverride = null) => {
  let content = initial
  let saves = 0
  const write = createFsWriteIfUnchanged({
    serialize: (task) => coordinator.run(task),
    authorizeTarget: (target) => `authorized:${target}`,
    assertWritable: (target) => assert.match(target, /^authorized:/),
    readText: async () => content,
    saveDocument: async (_target, next, condition) => {
      saves += 1
      if (saveOverride) await saveOverride(next, () => { content = next }, condition)
      else content = next
    }
  })
  return {
    write,
    content: () => content,
    saves: () => saves
  }
}

test('main conditional commit saves an exact expected version and reports stale without writing', async () => {
  const coordinator = make()
  const disk = memoryCas(coordinator, 'before\r\n')
  assert.deepEqual(await disk.write({ path: 'note.md', data: 'after\r\n', expectedContent: 'before\r\n' }), { ok: true })
  assert.equal(disk.content(), 'after\r\n')
  assert.deepEqual(
    await disk.write({ path: 'note.md', data: 'must-not-land', expectedContent: 'before\r\n' }),
    { ok: false, stale: true, error: 'stale_file' }
  )
  assert.equal(disk.content(), 'after\r\n')
  assert.equal(disk.saves(), 1)
})

test('main conditional commits serialize so a peer cannot publish from an old baseline', async () => {
  const coordinator = make()
  const events = []
  let releaseFirst
  let firstStarted
  const gate = new Promise((resolve) => { releaseFirst = resolve })
  const started = new Promise((resolve) => { firstStarted = resolve })
  const disk = memoryCas(coordinator, 'base', async (next, commit) => {
    events.push(`save:${next}:start`)
    if (next === 'first') {
      firstStarted()
      await gate
    }
    commit()
    events.push(`save:${next}:end`)
  })

  const first = disk.write({ path: 'note.md', data: 'first', expectedContent: 'base' })
  await started
  const second = disk.write({ path: 'note.md', data: 'second', expectedContent: 'base' })
  await Promise.resolve()
  assert.deepEqual(events, ['save:first:start'])
  releaseFirst()
  assert.deepEqual(await first, { ok: true })
  assert.deepEqual(await second, { ok: false, stale: true, error: 'stale_file' })
  assert.equal(disk.content(), 'first')
  assert.equal(disk.saves(), 1)
  assert.deepEqual(events, ['save:first:start', 'save:first:end'])
})

test('main conditional commit maps retention final-check stale without publishing', async () => {
  const coordinator = make()
  const disk = memoryCas(coordinator, 'base', async (_next, _commit, condition) => {
    assert.equal(condition.expectedContent, 'base')
    const error = new Error('changed while snapshots were prepared')
    error.code = 'STALE_DOCUMENT'
    error.stale = true
    throw error
  })
  assert.deepEqual(
    await disk.write({ path: 'note.md', data: 'agent', expectedContent: 'base' }),
    { ok: false, stale: true, error: 'stale_file' }
  )
  assert.equal(disk.content(), 'base')
})

test('every write/destructive IPC path uses the mutation coordinator', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
  for (const channel of [
    'knote:write-file',
    'knote:fs-write',
    'knote:fs-create',
    'knote:fs-create-exclusive',
    'knote:fs-delete',
    'knote:fs-mkdir',
    'knote:write-image-file',
    'knote:import-attachment',
    'knote:attachment-mkdir',
    'knote:attachment-rename-dir',
    'knote:fs-rename',
    'knote:trash'
  ]) {
    const marker = "ipcMain.handle('" + channel + "'"
    const start = source.indexOf(marker)
    assert.ok(start >= 0, channel + ' handler is missing')
    assert.match(source.slice(start, start + 500), /serializeFsMutation\(/, channel + ' bypasses the coordinator')
  }
})

test('the Agent conditional-write IPC is narrow and delegates to the serialized main-process primitive', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8')
  assert.match(main, /createFsWriteIfUnchanged\(\{[\s\S]*serialize: serializeFsMutation[\s\S]*authorizeTarget: existingWritePath[\s\S]*retention\(\)\.saveDocument/)
  assert.match(main, /ipcMain\.handle\('knote:fs-write-if-unchanged',[\s\S]{0,160}fsWriteIfUnchanged\(request\)/)
  assert.match(preload, /fsWriteIfUnchanged: \(path, data, expectedContent\) => ipcRenderer\.invoke\('knote:fs-write-if-unchanged', \{ path, data, expectedContent \}\)/)
  const exclusive = main.slice(main.indexOf("ipcMain.handle('knote:fs-create-exclusive'"), main.indexOf('const markdownFilesUnder'))
  assert.match(exclusive, /assertParentUnchanged\(\)[\s\S]*fs\.linkSync\(stagingPath, target\)/)
  assert.match(exclusive, /CREATE_PUBLICATION_UNCERTAIN/)
  assert.match(exclusive, /sameIdentity\(current, stagingIdentity\)/)
  assert.match(preload, /fsCreateExclusive: \(path, data\) => ipcRenderer\.invoke\('knote:fs-create-exclusive', \{ path, data \}\)/)
})
