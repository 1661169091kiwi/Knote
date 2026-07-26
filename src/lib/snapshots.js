// Durable document history.
//
// Desktop snapshots are immutable files below Electron's userData directory
// (outside the replaceable installation tree). Browser/Android renderers use
// IndexedDB, which is disk-backed and is explicitly requested as persistent
// origin storage. Nothing here trims old revisions automatically.

const LEGACY_PREFIX = 'knote-snap:'
const DB_NAME = 'knote-document-history'
const STORE = 'snapshots'
let dbPromise = null
let persistRequested = false
let lastSequence = 0

const desktop = () => (typeof window !== 'undefined' && window.knoteDesktop && window.knoteDesktop.historyAdd)

const requestPersistence = async () => {
  if (persistRequested) return
  persistRequested = true
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist()
  } catch { /* persistence is a browser policy decision */ }
}

const openDb = () => {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('durable history storage is unavailable')); return }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      const store = db.createObjectStore(STORE, { keyPath: 'id' })
      store.createIndex('docKey', 'docKey', { unique: false })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('failed to open durable history'))
  })
  requestPersistence()
  return dbPromise
}

const requestResult = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error || new Error('history database request failed'))
})

const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onabort = () => reject(tx.error || new Error('history transaction aborted'))
  tx.onerror = () => reject(tx.error || new Error('history transaction failed'))
})

const idbList = async (docKey) => {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readonly')
  const done = txDone(tx)
  const rows = await requestResult(tx.objectStore(STORE).index('docKey').getAll(IDBKeyRange.only(docKey)))
  await done
  return rows.sort((a, b) => b.sequence - a.sequence).map((row, index) => ({
    id: row.id,
    index,
    t: row.t,
    label: row.label || '',
    size: row.content.length
  }))
}

const idbAdd = async (docKey, content, now, label) => {
  const existing = await idbList(docKey)
  if (existing.length) {
    const latest = await idbGet(docKey, existing[0].id)
    if (latest === content) return false
  }
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const sequence = Math.max(Date.now() * 1000, lastSequence + 1)
  lastSequence = sequence
  const id = globalThis.crypto && globalThis.crypto.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${sequence}-${Math.random().toString(36).slice(2)}`
  tx.objectStore(STORE).add({ id, docKey, sequence, t: Number(now) || Date.now(), label: String(label || ''), content })
  await txDone(tx)
  return true
}

const idbGet = async (docKey, id) => {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readonly')
  const done = txDone(tx)
  const row = await requestResult(tx.objectStore(STORE).get(id))
  await done
  return row && row.docKey === docKey ? row.content : null
}

const legacyItems = (docKey) => {
  try {
    const raw = localStorage.getItem(LEGACY_PREFIX + docKey)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

const ensureLegacyMigrated = async (docKey) => {
  const marker = `knote-history-migrated:v1:${docKey}`
  try { if (localStorage.getItem(marker) === '1') return } catch { /* continue */ }
  const old = legacyItems(docKey)
  for (const item of old) {
    const text = String(item && item.content != null ? item.content : '')
    if (desktop()) await window.knoteDesktop.historyAdd(docKey, text, item.t, item.label || 'legacy')
    else await idbAdd(docKey, text, item.t, item.label || 'legacy')
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

// History is intentionally append-only. A future explicit storage-management
// UI may offer export + user-confirmed deletion; normal editing never clears it.
export const clearSnapshots = async () => false
