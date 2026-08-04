import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import 'fake-indexeddb/auto'

const DB_NAME = 'knote-document-history'
const STORE = 'snapshots'
const META_STORE = 'snapshotMeta'
const STATE_STORE = 'snapshotState'

class MemoryStorage {
  constructor() { this.values = new Map() }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null }
  setItem(key, value) { this.values.set(String(key), String(value)) }
  removeItem(key) { this.values.delete(String(key)) }
}

globalThis.localStorage = new MemoryStorage()
globalThis.window = {}

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve
  transaction.onabort = () => reject(transaction.error)
  transaction.onerror = () => reject(transaction.error)
})

const deleteDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.deleteDatabase(DB_NAME)
  request.onsuccess = resolve
  request.onerror = () => reject(request.error)
  request.onblocked = () => reject(new Error('test database deletion was blocked'))
})

const openDatabase = (version = 2, upgrade = null) => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, version)
  request.onupgradeneeded = () => upgrade?.(request.result, request.transaction)
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const inspectDocument = async (docKey) => {
  const database = await openDatabase()
  try {
    const transaction = database.transaction([STORE, META_STORE, STATE_STORE], 'readonly')
    const done = transactionDone(transaction)
    const [bodyCount, metadataCount, state] = await Promise.all([
      requestResult(transaction.objectStore(STORE).index('docKey').count(IDBKeyRange.only(docKey))),
      requestResult(transaction.objectStore(META_STORE).index('docSequence').count(IDBKeyRange.bound(
        [docKey, 0], [docKey, Number.MAX_SAFE_INTEGER]
      ))),
      requestResult(transaction.objectStore(STATE_STORE).get(docKey))
    ])
    await done
    return { bodyCount, metadataCount, state }
  } finally {
    database.close()
  }
}

test.beforeEach(async () => {
  globalThis.localStorage = new MemoryStorage()
  await deleteDatabase()
})

test.after(async () => {
  await deleteDatabase()
  delete globalThis.window
  delete globalThis.localStorage
})

test('concurrent module realms preserve every body and one coherent state row', async () => {
  const first = await import(`../src/lib/snapshots.js?realm-a=${Date.now()}`)
  const second = await import(`../src/lib/snapshots.js?realm-b=${Date.now()}`)
  const docKey = 'file:concurrent.md'
  const contents = Array.from({ length: 32 }, (_, index) => `VERSION-${index}`)

  const results = await Promise.all(contents.map((content, index) => (
    (index % 2 ? first : second).addSnapshot(docKey, content, 1_800_000_000_000 + index, 'save')
  )))
  assert.equal(results.filter(Boolean).length, contents.length)

  const listed = await first.listSnapshots(docKey)
  assert.equal(listed.length, contents.length)
  const bodies = await Promise.all(listed.map((item) => second.getSnapshot(docKey, item.id)))
  assert.deepEqual(new Set(bodies), new Set(contents))

  const inspected = await inspectDocument(docKey)
  assert.equal(inspected.bodyCount, contents.length)
  assert.equal(inspected.metadataCount, contents.length)
  assert.equal(inspected.state.count, contents.length)
  assert.equal(inspected.state.format, 1)
  assert.equal(inspected.state.latestId, listed[0].id)
  assert.equal(new Set(listed.map((item) => item.id)).size, contents.length)
})

test('two contexts cannot append the same latest body twice', async () => {
  const first = await import(`../src/lib/snapshots.js?dedupe-a=${Date.now()}`)
  const second = await import(`../src/lib/snapshots.js?dedupe-b=${Date.now()}`)
  const results = await Promise.all([
    first.addSnapshot('file:dedupe.md', 'SAME', Date.now(), 'save'),
    second.addSnapshot('file:dedupe.md', 'SAME', Date.now(), 'save')
  ])
  assert.deepEqual(results.sort(), [false, true])
  assert.equal((await first.listSnapshots('file:dedupe.md')).length, 1)
})

test('legacy localStorage import is atomic across tabs and recoverable after IndexedDB eviction', async () => {
  const docKey = 'file:legacy.md'
  localStorage.setItem(`knote-snap:${docKey}`, JSON.stringify([
    { content: 'LEGACY-ONE', t: 1, label: 'legacy' },
    { content: 'LEGACY-TWO', t: 2, label: 'legacy' }
  ]))
  const first = await import(`../src/lib/snapshots.js?legacy-a=${Date.now()}`)
  const second = await import(`../src/lib/snapshots.js?legacy-b=${Date.now()}`)
  const [firstList, secondList] = await Promise.all([
    first.listSnapshots(docKey),
    second.listSnapshots(docKey)
  ])
  assert.equal(firstList.length, 2)
  assert.equal(secondList.length, 2)
  assert.equal((await inspectDocument(docKey)).bodyCount, 2)
  assert.equal(localStorage.getItem(`knote-history-migrated:v1:${docKey}`), '1')

  await deleteDatabase()
  const recovered = await import(`../src/lib/snapshots.js?legacy-recovery=${Date.now()}`)
  const recoveredList = await recovered.listSnapshots(docKey)
  assert.equal(recoveredList.length, 2)
  assert.deepEqual(
    new Set(await Promise.all(recoveredList.map((item) => recovered.getSnapshot(docKey, item.id)))),
    new Set(['LEGACY-ONE', 'LEGACY-TWO'])
  )
})

test('a populated v1 database deduplicates legacy bodies even if its old marker write crashed', async () => {
  const docKey = 'file:v1-upgrade.md'
  const database = await openDatabase(1, (db) => {
    const store = db.createObjectStore(STORE, { keyPath: 'id' })
    store.createIndex('docKey', 'docKey', { unique: false })
  })
  const transaction = database.transaction(STORE, 'readwrite')
  const done = transactionDone(transaction)
  const store = transaction.objectStore(STORE)
  store.put({ id: 'v1-one', docKey, t: 1, label: 'legacy', content: 'LEGACY-ONE' })
  store.put({ id: 'v1-two', docKey, t: 2, label: 'legacy', content: 'LEGACY-TWO' })
  store.put({ id: 'v1-modern', docKey, t: 3, label: 'save', content: 'MODERN' })
  await done
  database.close()
  localStorage.setItem(`knote-snap:${docKey}`, JSON.stringify([
    { content: 'LEGACY-ONE', t: 1, label: 'legacy' },
    { content: 'LEGACY-TWO', t: 2, label: 'legacy' }
  ]))
  const snapshots = await import(`../src/lib/snapshots.js?v1-upgrade=${Date.now()}`)
  const listed = await snapshots.listSnapshots(docKey)
  assert.equal(listed.length, 3)
  assert.deepEqual(
    new Set(await Promise.all(listed.map((item) => snapshots.getSnapshot(docKey, item.id)))),
    new Set(['LEGACY-ONE', 'LEGACY-TWO', 'MODERN'])
  )
  assert.equal((await inspectDocument(docKey)).state.legacyLocalStorageMigrated, true)
})

test('named snapshot imports commit their marker with the bodies and recover after database eviction', async () => {
  const docKey = 'native:DOCUMENTS:Knote/imported.md'
  const items = [
    { content: 'LEGACY-ONE', t: 1, label: 'legacy-native' },
    { content: 'LEGACY-TWO', t: 2, label: 'legacy-native' }
  ]
  const first = await import(`../src/lib/snapshots.js?import-a=${Date.now()}`)
  const second = await import(`../src/lib/snapshots.js?import-b=${Date.now()}`)
  const results = await Promise.all([
    first.importSnapshotsOnce(docKey, 'android-directory-data-v1', items),
    second.importSnapshotsOnce(docKey, 'android-directory-data-v1', items)
  ])
  assert.deepEqual(results.sort(), [false, true])
  let inspected = await inspectDocument(docKey)
  assert.equal(inspected.bodyCount, 2)
  assert.deepEqual(inspected.state.completedImports, ['android-directory-data-v1'])

  await deleteDatabase()
  const recovered = await import(`../src/lib/snapshots.js?import-recovery=${Date.now()}`)
  assert.equal(await recovered.importSnapshotsOnce(docKey, 'android-directory-data-v1', items), true)
  inspected = await inspectDocument(docKey)
  assert.equal(inspected.bodyCount, 2)
  assert.deepEqual(inspected.state.completedImports, ['android-directory-data-v1'])
})

test('renderer-owned rename copies immutable history once and retains the old archive', async () => {
  const snapshots = await import(`../src/lib/snapshots.js?copy=${Date.now()}`)
  const fromKey = 'native:DOCUMENTS:Knote/old.md'
  const toKey = 'native:DOCUMENTS:Knote/new.md'
  await snapshots.importSnapshotsOnce(fromKey, 'android-directory-data-v1', [
    { content: 'OLD-ONE', t: 1, label: 'legacy-native' },
    { content: 'OLD-TWO', t: 2, label: 'before-save' }
  ])
  assert.equal(await snapshots.copySnapshots(fromKey, toKey), true)
  assert.equal(await snapshots.copySnapshots(fromKey, toKey), false)

  const source = await snapshots.listSnapshots(fromKey)
  const target = await snapshots.listSnapshots(toKey)
  assert.equal(source.length, 2)
  assert.equal(target.length, 2)
  assert.deepEqual(
    await Promise.all(target.map((item) => snapshots.getSnapshot(toKey, item.id))),
    ['OLD-TWO', 'OLD-ONE']
  )
  let inspected = await inspectDocument(toKey)
  assert.deepEqual(inspected.state.completedImports, [])
  assert.equal(inspected.state.copyCursors[0].source, fromKey)

  assert.equal(await snapshots.importSnapshotsOnce(toKey, 'android-directory-data-v1', [
    { content: 'DESTINATION-LEGACY', t: 3, label: 'legacy-native' }
  ]), true)
  await snapshots.addSnapshot(fromKey, 'OLD-THREE', 4, 'save')
  assert.equal(await snapshots.copySnapshots(fromKey, toKey), true)
  assert.equal(await snapshots.copySnapshots(fromKey, toKey), false)
  const advanced = await snapshots.listSnapshots(toKey)
  assert.equal(advanced.length, 4)
  assert.deepEqual(
    new Set(await Promise.all(advanced.map((item) => snapshots.getSnapshot(toKey, item.id)))),
    new Set(['OLD-ONE', 'OLD-TWO', 'DESTINATION-LEGACY', 'OLD-THREE'])
  )
  inspected = await inspectDocument(toKey)
  assert.deepEqual(inspected.state.completedImports, ['android-directory-data-v1'])
})

test('missing acceleration rows are rebuilt from immutable snapshot bodies', async () => {
  const snapshots = await import(`../src/lib/snapshots.js?repair=${Date.now()}`)
  const docKey = 'file:repair.md'
  await snapshots.addSnapshot(docKey, 'ONE', 1, 'save')
  await snapshots.addSnapshot(docKey, 'TWO', 2, 'before-delete')
  const before = await snapshots.listSnapshots(docKey)

  const database = await openDatabase()
  const transaction = database.transaction([META_STORE, STATE_STORE], 'readwrite')
  const done = transactionDone(transaction)
  transaction.objectStore(META_STORE).delete(before[0].id)
  const state = await requestResult(transaction.objectStore(STATE_STORE).get(docKey))
  transaction.objectStore(STATE_STORE).put({ ...state, count: 2 })
  await done
  database.close()

  const repaired = await snapshots.listSnapshots(docKey)
  assert.equal(repaired.length, 2)
  assert.deepEqual(
    new Set(await Promise.all(repaired.map((item) => snapshots.getSnapshot(docKey, item.id)))),
    new Set(['ONE', 'TWO'])
  )
  const inspected = await inspectDocument(docKey)
  assert.equal(inspected.metadataCount, 2)
  assert.equal(inspected.state.count, 2)
})

test('a blocked schema upgrade rejects promptly and a later call can retry', async () => {
  const blocker = await openDatabase(1, (database) => {
    const store = database.createObjectStore(STORE, { keyPath: 'id' })
    store.createIndex('docKey', 'docKey', { unique: false })
  })
  blocker.onversionchange = () => { /* deliberately hold the old connection */ }
  const snapshots = await import(`../src/lib/snapshots.js?blocked=${Date.now()}`)

  await assert.rejects(
    Promise.race([
      snapshots.listSnapshots('file:blocked.md'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('blocked open did not settle')), 500))
    ]),
    /upgrade is blocked/
  )

  blocker.close()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(await snapshots.listSnapshots('file:blocked.md'), [])
})

test('source keeps metadata repair, append, and pruning in one write transaction', () => {
  const source = fs.readFileSync(new URL('../src/lib/snapshots.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /let dbPromise|metadataReady|idbQueues/)
  assert.match(source, /database\.onversionchange = \(\) => database\.close\(\)/)
  assert.match(source, /request\.onblocked = \(\) => fail/)
  assert.match(source, /runTransaction\(database, \[STORE, META_STORE, STATE_STORE\], 'readwrite'/)
  assert.match(source, /const loaded = await loadHistoryState\(transaction, docKey\)/)
  assert.match(source, /items = pruneItems\(transaction, docKey, items, protectedIds, forcePrune\)/)
  const appSource = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.match(appSource, /const protectedPrevious = await takeSnapshot\('before external update'/)
  assert.match(appSource, /if \(protectedPrevious == null\)[\s\S]*diskWatchMtime = 0[\s\S]*diskWatchRaw = null/)
})
