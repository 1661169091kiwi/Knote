const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { DocumentRetentionStore } = require('../electron/document-retention.cjs')

const tempRoots = []
const fresh = async (options = {}) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'knote-retention-'))
  tempRoots.push(root)
  const docs = path.join(root, 'documents')
  const history = path.join(root, 'user-data', 'document-history', 'v1')
  await fs.promises.mkdir(docs, { recursive: true })
  return { root, docs, history, store: new DocumentRetentionStore(history, options) }
}

test.after(async () => {
  for (const root of tempRoots) await fs.promises.rm(root, { recursive: true, force: true })
})

test('same-named documents in different folders never share history', async () => {
  const { docs, store } = await fresh({ platform: 'win32' })
  const a = path.join(docs, 'alpha', 'notes.md')
  const b = path.join(docs, 'beta', 'notes.md')
  await store.saveDocument(a, 'ALPHA-ONLY')
  await store.saveDocument(b, 'BETA-ONLY')
  await store.saveDocument(a, 'ALPHA-SECOND')
  const ah = await store.listSnapshots(`file:${a}`)
  const bh = await store.listSnapshots(`file:${b}`)
  const ac = await Promise.all(ah.map((x) => store.getSnapshot(`file:${a}`, x.id)))
  const bc = await Promise.all(bh.map((x) => store.getSnapshot(`file:${b}`, x.id)))
  assert(ac.every((x) => x.includes('ALPHA')))
  assert(bc.every((x) => x.includes('BETA')))
  assert.notEqual(store.documentId(`file:${a}`), store.documentId(`file:${b}`))
})

test('rapid interleaved A/B saves retain order and cannot cross-overwrite', async () => {
  const { docs, store } = await fresh()
  const a = path.join(docs, 'A.md')
  const b = path.join(docs, 'B.md')
  const writes = []
  for (let i = 0; i < 80; i++) {
    writes.push(store.saveDocument(a, `A:${i}:DO-NOT-ENTER-B`))
    writes.push(store.saveDocument(b, `B:${i}:DO-NOT-ENTER-A`))
  }
  await Promise.all(writes)
  assert.equal(await fs.promises.readFile(a, 'utf8'), 'A:79:DO-NOT-ENTER-B')
  assert.equal(await fs.promises.readFile(b, 'utf8'), 'B:79:DO-NOT-ENTER-A')
  const ah = await store.listSnapshots(`file:${a}`)
  const bh = await store.listSnapshots(`file:${b}`)
  const ac = await Promise.all(ah.map((x) => store.getSnapshot(`file:${a}`, x.id)))
  const bc = await Promise.all(bh.map((x) => store.getSnapshot(`file:${b}`, x.id)))
  assert(ac.every((x) => x.startsWith('A:')))
  assert(bc.every((x) => x.startsWith('B:')))
})

test('a simulated crash after temp fsync leaves the old document intact and both versions recoverable', async () => {
  let fail = false
  const env = await fresh({ fault: (point) => { if (fail && point === 'after-temp-write') throw new Error('simulated power loss') } })
  const target = path.join(env.docs, 'critical.md')
  await env.store.saveDocument(target, 'SAFE-OLD')
  fail = true
  await assert.rejects(env.store.saveDocument(target, 'SAFE-NEW'), /simulated power loss/)
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'SAFE-OLD')
  const items = await env.store.listSnapshots(`file:${target}`)
  const contents = await Promise.all(items.map((x) => env.store.getSnapshot(`file:${target}`, x.id)))
  assert(contents.includes('SAFE-OLD'))
  assert(contents.includes('SAFE-NEW'))
})

test('history is append-only beyond the former 25-version and 1.2MB limits', async () => {
  const { docs, store } = await fresh()
  const target = path.join(docs, 'long-lived.md')
  for (let i = 0; i < 32; i++) {
    await store.saveDocument(target, `VERSION-${i}\n${String(i).padStart(2, '0')}:${'x'.repeat(52000)}`)
  }
  const items = await store.listSnapshots(`file:${target}`)
  assert.equal(items.length, 32)
  assert(items.reduce((sum, x) => sum + x.size, 0) > 1_200_000)
  const oldest = await store.getSnapshot(`file:${target}`, items[items.length - 1].id)
  assert(oldest.startsWith('VERSION-0'))
})

test('corrupt acceleration metadata cannot hide immutable snapshots', async () => {
  const { docs, store } = await fresh()
  const target = path.join(docs, 'recover.md')
  await store.saveDocument(target, 'ONE')
  await store.saveDocument(target, 'TWO')
  await fs.promises.writeFile(path.join(store.documentDir(`file:${target}`), 'head.json'), '{broken', 'utf8')
  const items = await store.listSnapshots(`file:${target}`)
  assert.equal(items.length, 2)
  assert.equal(await store.getSnapshot(`file:${target}`, items[0].id), 'TWO')
  await store.saveDocument(target, 'THREE')
  assert.equal((await store.listSnapshots(`file:${target}`)).length, 3)
})

test('corrupt identity metadata and corrupt snapshot bytes fail safely', async () => {
  const { docs, store } = await fresh()
  const target = path.join(docs, 'integrity.md')
  await store.saveDocument(target, 'HASH-PROTECTED')
  const docDir = store.documentDir(`file:${target}`)
  await fs.promises.writeFile(path.join(docDir, 'identity.json'), '{not-json', 'utf8')
  const items = await store.listSnapshots(`file:${target}`)
  assert.equal(items.length, 1)
  assert.equal(await store.getSnapshot(`file:${target}`, items[0].id), 'HASH-PROTECTED')
  await fs.promises.writeFile(path.join(docDir, 'snapshots', items[0].id), 'TAMPERED', 'utf8')
  assert.equal(await store.getSnapshot(`file:${target}`, items[0].id), null)
  // Metadata damage must not stop later versions from being durably appended.
  await store.saveDocument(target, 'AFTER-METADATA-DAMAGE')
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'AFTER-METADATA-DAMAGE')
})

test('one hundred same-basename unicode documents remain pairwise isolated', async () => {
  const { docs, store } = await fresh({ platform: 'win32' })
  const targets = []
  for (let i = 0; i < 100; i++) {
    const target = path.join(docs, `目录-${String(i).padStart(3, '0')}`, '同名.md')
    targets.push(target)
    await store.saveDocument(target, `DOC-${i}-唯一内容`)
  }
  const ids = new Set(targets.map((target) => store.documentId(`file:${target}`)))
  assert.equal(ids.size, 100)
  for (let i = 0; i < targets.length; i++) {
    const items = await store.listSnapshots(`file:${targets[i]}`)
    assert.equal(items.length, 1)
    assert.equal(await store.getSnapshot(`file:${targets[i]}`, items[0].id), `DOC-${i}-唯一内容`)
  }
})

test('rename copies complete history to the new identity without deleting the old archive', async () => {
  const { docs, store } = await fresh()
  const oldPath = path.join(docs, 'old.md')
  const newPath = path.join(docs, 'new.md')
  await store.saveDocument(oldPath, 'BEFORE-1')
  await store.saveDocument(oldPath, 'BEFORE-2')
  await fs.promises.rename(oldPath, newPath)
  await store.copyIdentityHistory(`file:${oldPath}`, `file:${newPath}`)
  await store.saveDocument(newPath, 'AFTER-RENAME')
  assert.equal((await store.listSnapshots(`file:${oldPath}`)).length, 2)
  assert.equal((await store.listSnapshots(`file:${newPath}`)).length, 3)
})

test('replacing an installation tree cannot alter userData history', async () => {
  const { root, docs, history, store } = await fresh()
  const target = path.join(docs, 'upgrade.md')
  await store.saveDocument(target, 'SURVIVE-UPGRADE')
  const install = path.join(root, 'install', 'Knote')
  await fs.promises.mkdir(install, { recursive: true })
  await fs.promises.writeFile(path.join(install, 'app.asar'), 'old program')
  const before = crypto.createHash('sha256').update(await fs.promises.readFile((await store.listSnapshots(`file:${target}`))[0].id
    ? path.join(store.documentDir(`file:${target}`), 'snapshots', (await store.listSnapshots(`file:${target}`))[0].id)
    : '')).digest('hex')
  await fs.promises.rm(install, { recursive: true, force: true })
  await fs.promises.mkdir(install, { recursive: true })
  await fs.promises.writeFile(path.join(install, 'app.asar'), 'new program')
  assert(await fs.promises.stat(history))
  const item = (await store.listSnapshots(`file:${target}`))[0]
  const after = crypto.createHash('sha256').update(await fs.promises.readFile(path.join(store.documentDir(`file:${target}`), 'snapshots', item.id))).digest('hex')
  assert.equal(after, before)
  assert.equal(await store.getSnapshot(`file:${target}`, item.id), 'SURVIVE-UPGRADE')
})

test('renderer save queue runs older same-document work before newer work', async () => {
  const { enqueueDocumentSave } = await import('../src/lib/documentSaveQueue.js')
  const landed = []
  let releaseOld
  const gate = new Promise((resolve) => { releaseOld = resolve })
  const old = enqueueDocumentSave('file:A', async () => { await gate; landed.push('old') })
  const newer = enqueueDocumentSave('file:A', async () => { landed.push('new') })
  const other = enqueueDocumentSave('file:B', async () => { landed.push('B') })
  await other
  releaseOld()
  await Promise.all([old, newer])
  assert(landed.indexOf('old') < landed.indexOf('new'))
  assert(landed.includes('B'))
})
