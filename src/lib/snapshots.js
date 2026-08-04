// Durable document history.
//
// Desktop snapshots are immutable files below Electron's userData directory
// (outside the replaceable installation tree). Browser/Android renderers use
// IndexedDB, which is disk-backed and is explicitly requested as persistent
// origin storage. Per-document high watermarks keep history bounded while
// retaining recent, recovery, and representative older revisions.

import { selectHistoryRetentionIds } from './historyRetention.js'

const LEGACY_PREFIX = 'knote-snap:'
const DB_NAME = 'knote-document-history'
const STORE = 'snapshots'
const DB_VERSION = 2
const META_STORE = 'snapshotMeta'
const STATE_STORE = 'snapshotState'
const DOC_SEQUENCE_INDEX = 'docSequence'
const STATE_FORMAT = 1
const RETENTION = Object.freeze({
  maxCount: 160,
  targetCount: 144,
  maxBytes: 64 * 1024 * 1024,
  targetBytes: 56 * 1024 * 1024,
  recentCount: 20,
  recoveryCount: 12
})

let persistenceRequest = null
const textBytes = (value) => new TextEncoder().encode(String(value || '')).byteLength
const checkpointFamily = (label) => {
  const value = String(label || '').toLowerCase()
  if (value.includes('delete') || value.includes('trash')) return 'delete'
  if (value.includes('rename') || value === 'renamed') return 'rename'
  if (/history[\s_-]*restore/.test(value)) return 'history'
  if (/external[\s_-]*update/.test(value)) return 'external'
  if (/quit[\s_-]*recovery/.test(value)) return 'quit'
  return ''
}

const desktop = () => (typeof window !== 'undefined' && window.knoteDesktop && window.knoteDesktop.historyAdd)

const requestPersistence = () => {
  if (persistenceRequest || typeof navigator === 'undefined' || !navigator.storage?.persist) return
  persistenceRequest = Promise.resolve(navigator.storage.persist()).catch(() => {
    persistenceRequest = null
    return false
  })
}

const openDb = () => {
  requestPersistence()
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('durable history storage is unavailable'))
      return
    }
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    let request
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (error) {
      fail(error)
      return
    }
    request.onupgradeneeded = () => {
      const database = request.result
      const transaction = request.transaction
      const snapshots = database.objectStoreNames.contains(STORE)
        ? transaction.objectStore(STORE)
        : database.createObjectStore(STORE, { keyPath: 'id' })
      if (!snapshots.indexNames.contains('docKey')) snapshots.createIndex('docKey', 'docKey', { unique: false })

      const metadata = database.objectStoreNames.contains(META_STORE)
        ? transaction.objectStore(META_STORE)
        : database.createObjectStore(META_STORE, { keyPath: 'id' })
      if (!metadata.indexNames.contains(DOC_SEQUENCE_INDEX)) {
        metadata.createIndex(DOC_SEQUENCE_INDEX, ['docKey', 'sequence'], { unique: false })
      }
      if (!database.objectStoreNames.contains(STATE_STORE)) {
        database.createObjectStore(STATE_STORE, { keyPath: 'docKey' })
      }
    }
    request.onblocked = () => fail(new Error('durable history upgrade is blocked by another Knote window'))
    request.onerror = () => fail(request.error || new Error('failed to open durable history'))
    request.onsuccess = () => {
      const database = request.result
      if (settled) {
        database.close()
        return
      }
      settled = true
      database.onversionchange = () => database.close()
      resolve(database)
    }
  })
}

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error || new Error('history database request failed'))
})

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onabort = () => reject(transaction.error || new Error('history transaction aborted'))
  transaction.onerror = () => reject(transaction.error || new Error('history transaction failed'))
})

const runTransaction = async (database, stores, mode, work) => {
  const transaction = database.transaction(stores, mode)
  const done = transactionDone(transaction)
  try {
    const result = await work(transaction)
    await done
    return result
  } catch (error) {
    try { transaction.abort() } catch { /* already complete/aborted */ }
    try { await done } catch { /* preserve the original request error */ }
    throw error
  }
}

const withDatabase = async (work) => {
  const database = await openDb()
  try {
    return await work(database)
  } finally {
    database.close()
  }
}

const visitCursor = (source, range, visit) => new Promise((resolve, reject) => {
  const request = source.openCursor(range)
  request.onerror = () => reject(request.error || new Error('history cursor failed'))
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) {
      resolve()
      return
    }
    visit(cursor.value, cursor)
    cursor.continue()
  }
})

const docSequenceRange = (docKey) => IDBKeyRange.bound(
  [docKey, 0],
  [docKey, Number.MAX_SAFE_INTEGER]
)

const sortedMetadata = (items) => [...items].sort((a, b) => (
  Number(b.sequence || 0) - Number(a.sequence || 0) || String(b.id || '').localeCompare(String(a.id || ''))
))

const stateFromItems = (docKey, itemsValue, extra = {}) => {
  const items = sortedMetadata(itemsValue)
  const completedImports = Array.isArray(extra.completedImports)
    ? [...new Set(extra.completedImports.map(String).filter(Boolean))].slice(-32)
    : []
  const cursorMap = new Map()
  if (Array.isArray(extra.copyCursors)) {
    for (const cursor of extra.copyCursors) {
      if (!cursor?.source || !cursor.latestId || !Number.isSafeInteger(Number(cursor.latestSequence))) continue
      cursorMap.set(String(cursor.source), {
        source: String(cursor.source),
        latestId: String(cursor.latestId),
        latestSequence: Number(cursor.latestSequence)
      })
    }
  }
  return {
    docKey,
    format: STATE_FORMAT,
    count: items.length,
    bytes: items.reduce((sum, item) => sum + Number(item.size || 0), 0),
    latestId: items[0]?.id || '',
    latestSequence: Number(items[0]?.sequence || 0),
    legacyLocalStorageMigrated: extra.legacyLocalStorageMigrated === true,
    completedImports,
    copyCursors: [...cursorMap.values()]
  }
}

const stateMatchesRows = (state, items, bodyIds) => {
  if (!state || state.format !== STATE_FORMAT || state.count !== items.length || bodyIds.length !== items.length) return false
  const ids = new Set(bodyIds.map(String))
  if (ids.size !== items.length || items.some((item) => !ids.has(String(item.id)))) return false
  const calculated = stateFromItems(state.docKey, items, state)
  return state.bytes === calculated.bytes &&
    state.latestId === calculated.latestId &&
    state.latestSequence === calculated.latestSequence
}

const rebuildMetadata = async (transaction, docKey, previousState = null) => {
  const snapshots = transaction.objectStore(STORE)
  const metadata = transaction.objectStore(META_STORE)
  const bodies = []
  await visitCursor(snapshots.index('docKey'), IDBKeyRange.only(docKey), (row) => bodies.push(row))
  await visitCursor(metadata.index(DOC_SEQUENCE_INDEX), docSequenceRange(docKey), (_row, cursor) => cursor.delete())

  bodies.sort((a, b) => {
    const aOrder = Number(a.sequence) > 0 ? Number(a.sequence) : (Number(a.t) || 0) * 1000
    const bOrder = Number(b.sequence) > 0 ? Number(b.sequence) : (Number(b.t) || 0) * 1000
    return aOrder - bOrder || String(a.id || '').localeCompare(String(b.id || ''))
  })
  let previousSequence = 0
  const items = bodies.map((row) => {
    const proposed = Number(row.sequence) > 0
      ? Number(row.sequence)
      : Math.max(1, Math.trunc((Number(row.t) || Date.now()) * 1000))
    const sequence = Math.max(proposed, previousSequence + 1)
    previousSequence = sequence
    const item = {
      id: row.id,
      docKey,
      sequence,
      t: Number(row.t) || Date.now(),
      label: String(row.label || ''),
      checkpoint: checkpointFamily(row.label),
      size: Number(row.size) || textBytes(row.content)
    }
    metadata.put(item)
    return item
  })
  const state = stateFromItems(docKey, items, previousState || {})
  transaction.objectStore(STATE_STORE).put(state)
  return { state, items: sortedMetadata(items) }
}

const loadHistoryState = async (transaction, docKey) => {
  const snapshots = transaction.objectStore(STORE)
  const metadata = transaction.objectStore(META_STORE)
  const [state, items, bodyIds] = await Promise.all([
    requestResult(transaction.objectStore(STATE_STORE).get(docKey)),
    requestResult(metadata.index(DOC_SEQUENCE_INDEX).getAll(docSequenceRange(docKey))),
    requestResult(snapshots.index('docKey').getAllKeys(IDBKeyRange.only(docKey)))
  ])
  const ordered = sortedMetadata(items)
  if (stateMatchesRows(state, ordered, bodyIds)) return { state, items: ordered }
  return rebuildMetadata(transaction, docKey, state)
}

const nextSequence = (latestSequence, time) => {
  const wall = Math.max(1, Math.trunc((Number(time) || Date.now()) * 1000))
  const previous = Math.max(0, Math.trunc(Number(latestSequence) || 0))
  if (previous >= Number.MAX_SAFE_INTEGER) throw new Error('history sequence exhausted')
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(wall, previous + 1))
}

const nextSnapshotId = (sequence) => (
  globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${sequence}-${Math.random().toString(36).slice(2)}`
)

const pruneItems = (transaction, docKey, itemsValue, protectedIds = [], force = false) => {
  const items = sortedMetadata(itemsValue)
  const state = stateFromItems(docKey, items)
  if (!force && state.count <= RETENTION.maxCount && state.bytes <= RETENTION.maxBytes) return items
  const keep = selectHistoryRetentionIds(items, RETENTION, protectedIds)
  const retained = []
  const snapshots = transaction.objectStore(STORE)
  const metadata = transaction.objectStore(META_STORE)
  for (const item of items) {
    if (keep.has(item.id)) retained.push(item)
    else {
      snapshots.delete(item.id)
      metadata.delete(item.id)
    }
  }
  return retained
}

const appendRows = async (transaction, docKey, loaded, rows, {
  forcePrune = false,
  markLegacyMigrated = false,
  completedImports = [],
  copyCursor = null
} = {}) => {
  const snapshots = transaction.objectStore(STORE)
  const metadata = transaction.objectStore(META_STORE)
  let items = [...loaded.items]
  let latestContent = null
  if (loaded.state.latestId) {
    const latest = await requestResult(snapshots.get(loaded.state.latestId))
    latestContent = latest && latest.docKey === docKey ? String(latest.content ?? '') : null
  }
  let latestSequence = Number(loaded.state.latestSequence || 0)
  const addedIds = []
  for (const row of rows) {
    const content = String(row.content ?? '')
    if (latestContent === content) continue
    const t = Number(row.now) || Date.now()
    const sequence = nextSequence(latestSequence, t)
    const id = nextSnapshotId(sequence)
    const size = textBytes(content)
    const item = {
      id,
      docKey,
      sequence,
      t,
      label: String(row.label || ''),
      checkpoint: checkpointFamily(row.label),
      size
    }
    snapshots.add({ ...item, content })
    metadata.add(item)
    items.unshift(item)
    addedIds.push(id)
    latestContent = content
    latestSequence = sequence
  }

  const protectedIds = addedIds.length ? [addedIds[addedIds.length - 1]] : []
  items = pruneItems(transaction, docKey, items, protectedIds, forcePrune)
  const state = stateFromItems(docKey, items, {
    legacyLocalStorageMigrated: markLegacyMigrated || loaded.state.legacyLocalStorageMigrated,
    completedImports: [
      ...(loaded.state.completedImports || []),
      ...completedImports
    ],
    copyCursors: copyCursor
      ? [
          ...(loaded.state.copyCursors || []).filter((cursor) => cursor.source !== copyCursor.source),
          copyCursor
        ]
      : loaded.state.copyCursors
  })
  transaction.objectStore(STATE_STORE).put(state)
  return addedIds.length
}

const idbAddAttempt = (docKey, content, now, label, forcePrune = false) => withDatabase((database) => (
  runTransaction(database, [STORE, META_STORE, STATE_STORE], 'readwrite', async (transaction) => {
    const loaded = await loadHistoryState(transaction, docKey)
    return (await appendRows(transaction, docKey, loaded, [{ content, now, label }], { forcePrune })) > 0
  })
))

const idbAdd = async (docKey, content, now, label) => {
  try {
    return await idbAddAttempt(docKey, content, now, label)
  } catch (error) {
    if (error?.name !== 'QuotaExceededError') throw error
    // Retry once after compacting this document in the same net transaction.
    // A second quota failure is surfaced; history writes never pretend to be
    // durable by falling back to memory or silently dropping the new revision.
    return idbAddAttempt(docKey, content, now, label, true)
  }
}

const idbList = (docKey) => withDatabase((database) => (
  runTransaction(database, [STORE, META_STORE, STATE_STORE], 'readwrite', async (transaction) => {
    const loaded = await loadHistoryState(transaction, docKey)
    return loaded.items.map((row, index) => ({
      id: row.id,
      index,
      t: row.t,
      label: row.label || '',
      checkpoint: row.checkpoint || '',
      size: row.size
    }))
  })
))

const idbGet = (docKey, id) => withDatabase((database) => (
  runTransaction(database, STORE, 'readonly', async (transaction) => {
    const row = await requestResult(transaction.objectStore(STORE).get(id))
    return row && row.docKey === docKey ? row.content : null
  })
))

const idbImportLegacy = (docKey, items) => withDatabase((database) => (
  runTransaction(database, [STORE, META_STORE, STATE_STORE], 'readwrite', async (transaction) => {
    const loaded = await loadHistoryState(transaction, docKey)
    if (loaded.state.legacyLocalStorageMigrated) return false
    // Version-1 databases predate the transactional state marker, and could
    // crash after writing bodies but before setting their localStorage marker.
    // Compare the retained source against every immutable body so either crash
    // order is idempotent while a genuinely missing legacy revision recovers.
    const existingRows = await requestResult(
      transaction.objectStore(STORE).index('docKey').getAll(IDBKeyRange.only(docKey))
    )
    const existingContents = new Set(existingRows.map((row) => String(row?.content ?? '')))
    const pending = items.filter((item) => !existingContents.has(String(item?.content ?? '')))
    await appendRows(
      transaction,
      docKey,
      loaded,
      pending.map((item) => ({
        content: String(item?.content ?? ''),
        now: item?.t,
        label: item?.label || 'legacy'
      })),
      { markLegacyMigrated: true }
    )
    return true
  })
))

const idbImportOnceAttempt = (docKey, importId, items, forcePrune = false) => withDatabase((database) => (
  runTransaction(database, [STORE, META_STORE, STATE_STORE], 'readwrite', async (transaction) => {
    const loaded = await loadHistoryState(transaction, docKey)
    if (loaded.state.completedImports?.includes(importId)) return false
    await appendRows(
      transaction,
      docKey,
      loaded,
      [...items]
        .sort((a, b) => Number(a?.t || 0) - Number(b?.t || 0))
        .map((item) => ({
          content: String(item?.content ?? ''),
          now: item?.t,
          label: item?.label || 'imported'
        })),
      { forcePrune, completedImports: [importId] }
    )
    return true
  })
))

const idbImportOnce = async (docKey, importId, items) => {
  try {
    return await idbImportOnceAttempt(docKey, importId, items)
  } catch (error) {
    if (error?.name !== 'QuotaExceededError') throw error
    return idbImportOnceAttempt(docKey, importId, items, true)
  }
}

const idbCopyAttempt = (fromKey, toKey, forcePrune = false) => withDatabase((database) => (
  runTransaction(database, [STORE, META_STORE, STATE_STORE], 'readwrite', async (transaction) => {
    const source = await loadHistoryState(transaction, fromKey)
    const target = await loadHistoryState(transaction, toKey)
    if (!source.items.length) return false
    const cursor = target.state.copyCursors?.find((item) => item.source === fromKey)
    const pendingItems = cursor
      ? source.items.filter((item) => Number(item.sequence) > Number(cursor.latestSequence))
      : source.items
    if (!pendingItems.length) return false
    const snapshots = transaction.objectStore(STORE)
    const rows = []
    for (const item of [...pendingItems].reverse()) {
      const body = await requestResult(snapshots.get(item.id))
      if (body?.docKey === fromKey) rows.push({
        content: String(body.content ?? ''),
        now: item.t,
        label: item.label || 'renamed'
      })
    }
    await appendRows(transaction, toKey, target, rows, {
      forcePrune,
      copyCursor: {
        source: fromKey,
        latestId: source.state.latestId,
        latestSequence: source.state.latestSequence
      }
    })
    return rows.length > 0
  })
))

const idbCopy = async (fromKey, toKey) => {
  try {
    return await idbCopyAttempt(fromKey, toKey)
  } catch (error) {
    if (error?.name !== 'QuotaExceededError') throw error
    return idbCopyAttempt(fromKey, toKey, true)
  }
}

const legacyItems = (docKey) => {
  try {
    const raw = localStorage.getItem(LEGACY_PREFIX + docKey)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const ensureLegacyMigrated = async (docKey) => {
  const marker = `knote-history-migrated:v1:${docKey}`
  let alreadyMarked = false
  try { alreadyMarked = localStorage.getItem(marker) === '1' } catch { /* continue */ }
  // IndexedDB may have been evicted while localStorage survived. Browser
  // migration therefore trusts the transactional state marker, not only the
  // older localStorage marker, and can recover again from the retained source.
  const old = desktop() && alreadyMarked ? [] : legacyItems(docKey)
  if (desktop()) {
    if (alreadyMarked) return
    for (const item of old) {
      const text = String(item?.content ?? '')
      await window.knoteDesktop.historyAdd(docKey, text, item?.t, item?.label || 'legacy')
    }
  } else {
    // The marker lives in the same serialized write transaction as snapshot
    // state, so two tabs cannot import the same localStorage history twice.
    await idbImportLegacy(docKey, old)
  }
  // Keep the old source as a second recovery copy. The marker merely prevents
  // importing it again on every launch.
  try { localStorage.setItem(marker, '1') } catch { /* read-only storage */ }
}

export const addSnapshot = async (docKey, content, now, label = '') => {
  if (!docKey || content == null) return false
  await ensureLegacyMigrated(docKey)
  if (desktop()) return window.knoteDesktop.historyAdd(docKey, String(content), now, label)
  return idbAdd(docKey, String(content), now, label)
}

export const listSnapshots = async (docKey) => {
  if (!docKey) return []
  await ensureLegacyMigrated(docKey)
  return desktop() ? window.knoteDesktop.historyList(docKey) : idbList(docKey)
}

export const getSnapshot = async (docKey, id) => {
  if (!docKey || !id) return null
  await ensureLegacyMigrated(docKey)
  return desktop() ? window.knoteDesktop.historyGet(docKey, id) : idbGet(docKey, id)
}

export const importSnapshotsOnce = async (docKey, importId, items = []) => {
  if (!docKey || !importId) throw new TypeError('snapshot import requires a document key and import ID')
  if (!Array.isArray(items)) throw new TypeError('snapshot import items must be an array')
  await ensureLegacyMigrated(docKey)
  if (desktop()) throw new Error('transactional snapshot import is unavailable in desktop history')
  return idbImportOnce(String(docKey), String(importId), items)
}

export const copySnapshots = async (fromKey, toKey) => {
  if (!fromKey || !toKey || fromKey === toKey) return false
  await ensureLegacyMigrated(fromKey)
  await ensureLegacyMigrated(toKey)
  // Desktop fsRename performs the history copy in the main process beside the
  // filesystem mutation. Browser and Android identities are renderer-owned.
  if (desktop()) return false
  return idbCopy(String(fromKey), String(toKey))
}

// History has no destructive clear operation. Automatic retention only removes
// excess revisions after a document crosses its high watermark.
export const clearSnapshots = async () => false
