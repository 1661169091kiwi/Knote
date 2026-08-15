const DB_NAME = 'knote-browser-workspaces'
const DB_VERSION = 1
const STORE_NAME = 'handles'
const LOCK_NAME = 'knote-browser-workspace-identity-v1'
const DURABLE_PREFIX = 'folder:fsa/v1/'
const SESSION_PREFIX = 'folder:fsa/session/'
const FILE_DURABLE_PREFIX = 'file:fsa/v1/'
const FILE_SESSION_PREFIX = 'file:fsa/session/'

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'))
  transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'))
})

const openDatabase = () => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    reject(new Error('IndexedDB unavailable'))
    return
  }
  const request = indexedDB.open(DB_NAME, DB_VERSION)
  let settled = false
  const fail = (error) => {
    if (settled) return
    settled = true
    reject(error)
  }
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
  }
  request.onblocked = () => fail(new Error('Browser workspace registry is blocked'))
  request.onerror = () => fail(request.error || new Error('Could not open browser workspace registry'))
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

const listPersistedRecords = async () => {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).getAll()
    await transactionDone(transaction)
    const records = request.result
    return Array.isArray(records) ? records : []
  } finally {
    database.close()
  }
}

const putPersistedRecord = async (record) => {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(record)
    await transactionDone(transaction)
  } finally {
    database.close()
  }
}

const randomToken = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().toLowerCase()
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

const compareEntry = async (candidate, stored) => {
  try {
    return !!(stored && await candidate.isSameEntry(stored))
  } catch {
    return false
  }
}

const findMatchingRecord = async (handle, records, kind) => {
  const ordered = [...records].sort((a, b) => (
    Number(a?.createdAt || 0) - Number(b?.createdAt || 0) || String(a?.id || '').localeCompare(String(b?.id || ''))
  ))
  for (const record of ordered) {
    if (!record || record.kind !== kind || !record.id || !record.handle) continue
    if (await compareEntry(handle, record.handle)) return record
  }
  return null
}

const defaultLock = (run) => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null
  return locks?.request ? locks.request(LOCK_NAME, { mode: 'exclusive' }, run) : run()
}

const createBrowserHandleIdentityRegistry = ({
  kind,
  durablePrefix,
  sessionPrefix,
  listRecords = listPersistedRecords,
  putRecord = putPersistedRecord,
  createId = randomToken,
  withLock = defaultLock,
  now = () => Date.now()
} = {}) => {
  const memoryRecords = []
  let queue = Promise.resolve()

  const resolveUnlocked = async (handle) => {
    if (!handle || handle.kind !== kind || typeof handle.isSameEntry !== 'function') {
      throw new TypeError(`A comparable FileSystem${kind === 'directory' ? 'Directory' : 'File'}Handle is required`)
    }

    const memoryMatch = await findMatchingRecord(handle, memoryRecords, kind)
    if (memoryMatch) {
      memoryMatch.handle = handle
      memoryMatch.name = handle.name || memoryMatch.name || ''
      memoryMatch.lastOpenedAt = now()
      return {
        id: `${memoryMatch.durable ? durablePrefix : sessionPrefix}${memoryMatch.id}`,
        durable: !!memoryMatch.durable
      }
    }

    let persisted
    try {
      persisted = await listRecords()
    } catch {
      persisted = null
    }

    if (persisted) {
      const match = await findMatchingRecord(handle, persisted, kind)
      if (match) {
        const record = {
          ...match,
          handle,
          name: handle.name || match.name || '',
          lastOpenedAt: now(),
          durable: true
        }
        memoryRecords.push(record)
        // The old handle already makes this identity durable. Refreshing it is
        // best-effort because a transient write failure must not split it.
        const { durable: _durable, ...persistedRecord } = record
        try { await putRecord(persistedRecord) } catch { /* keep the established identity */ }
        return { id: `${durablePrefix}${record.id}`, durable: true }
      }
    }

    const generated = String(createId() || randomToken()).toLowerCase().replace(/[^a-z0-9-]/g, '')
    const token = generated || randomToken()
    const id = kind === 'file' ? `file-${token}` : token
    const record = {
      id,
      kind,
      handle,
      name: handle.name || '',
      createdAt: now(),
      lastOpenedAt: now()
    }

    if (persisted) {
      try {
        await putRecord(record)
        memoryRecords.push({ ...record, durable: true })
        return { id: `${durablePrefix}${id}`, durable: true }
      } catch { /* fall through to an isolated session identity */ }
    }

    memoryRecords.push({ ...record, durable: false })
    return { id: `${sessionPrefix}${id}`, durable: false }
  }

  const resolve = (handle) => {
    const run = () => withLock(() => resolveUnlocked(handle))
    const result = queue.then(run, run)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  return { resolve }
}

export const createBrowserWorkspaceIdentityRegistry = (options = {}) => createBrowserHandleIdentityRegistry({
  ...options,
  kind: 'directory',
  durablePrefix: DURABLE_PREFIX,
  sessionPrefix: SESSION_PREFIX
})

export const createBrowserFileIdentityRegistry = (options = {}) => createBrowserHandleIdentityRegistry({
  ...options,
  kind: 'file',
  durablePrefix: FILE_DURABLE_PREFIX,
  sessionPrefix: FILE_SESSION_PREFIX
})

const browserWorkspaceIdentityRegistry = createBrowserWorkspaceIdentityRegistry()
const browserFileIdentityRegistry = createBrowserFileIdentityRegistry()

export const resolveBrowserWorkspaceIdentity = (handle) => browserWorkspaceIdentityRegistry.resolve(handle)
export const resolveBrowserFileIdentity = (handle) => browserFileIdentityRegistry.resolve(handle)
