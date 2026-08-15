const DB_NAME = 'knote-agent-runtime'
const DB_VERSION = 1
const EVENT_STORE = 'events'
const SESSION_INDEX = 'sessionKey'
const CHAT_INDEX = 'chatKey'
const DEFAULT_SESSION_LIMIT = 2000

let databasePromise = null
let persistenceRequest = null
let writeQueue = Promise.resolve()

const requestPersistence = () => {
  if (persistenceRequest || typeof navigator === 'undefined' || !navigator.storage?.persist) return
  persistenceRequest = Promise.resolve(navigator.storage.persist()).catch(() => false)
}

const openDatabase = () => {
  if (databasePromise) return databasePromise
  requestPersistence()
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Agent event storage is unavailable'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      const store = database.objectStoreNames.contains(EVENT_STORE)
        ? request.transaction.objectStore(EVENT_STORE)
        : database.createObjectStore(EVENT_STORE, { keyPath: 'id' })
      if (!store.indexNames.contains(SESSION_INDEX)) store.createIndex(SESSION_INDEX, 'sessionKey', { unique: false })
      if (!store.indexNames.contains(CHAT_INDEX)) store.createIndex(CHAT_INDEX, 'chatKey', { unique: false })
    }
    request.onblocked = () => reject(new Error('Agent event storage upgrade is blocked'))
    request.onerror = () => reject(request.error || new Error('Could not open Agent event storage'))
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => {
        database.close()
        databasePromise = null
      }
      resolve(database)
    }
  }).catch((error) => {
    databasePromise = null
    throw error
  })
  return databasePromise
}

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onabort = () => reject(transaction.error || new Error('Agent event transaction aborted'))
  transaction.onerror = () => reject(transaction.error || new Error('Agent event transaction failed'))
})

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error || new Error('Agent event request failed'))
})

const sessionKey = (chatKey, sessionId) => `${String(chatKey || '')}\u0000${String(sessionId || '')}`

const normalizeEvent = (event) => {
  if (!event || !event.id || !event.chatKey || !event.sessionId || !event.type) {
    throw new TypeError('Agent events require id, chatKey, sessionId, and type')
  }
  const chatKey = String(event.chatKey)
  const sessionId = String(event.sessionId)
  return {
    id: String(event.id),
    chatKey,
    sessionId,
    sessionKey: sessionKey(chatKey, sessionId),
    type: String(event.type),
    at: Number(event.at) || Date.now(),
    order: Number(event.order) || (Number(event.at) || Date.now()) * 1000,
    payload: event.payload && typeof event.payload === 'object' ? event.payload : {}
  }
}

const eventOrder = (left, right) => (
  Number(left.order || (Number(left.at) || 0) * 1000) - Number(right.order || (Number(right.at) || 0) * 1000) ||
  String(left.id).localeCompare(String(right.id))
)

const TERMINAL_RUN_EVENTS = new Set(['run.completed', 'run.interrupted', 'run.recovered'])

const unfinishedRunIds = (records) => {
  const started = new Set()
  const terminal = new Set()
  for (const event of records || []) {
    const runId = String(event?.payload?.runId || '')
    if (!runId) continue
    if (event.type === 'run.started') started.add(runId)
    if (TERMINAL_RUN_EVENTS.has(event.type)) terminal.add(runId)
  }
  return new Set([...started].filter((runId) => !terminal.has(runId)))
}

const pruneRecords = (store, records, maxEvents, preserveIds = new Set()) => {
  const ordered = [...(records || [])].sort(eventOrder)
  let excess = Math.max(0, ordered.length - Math.max(1, Number(maxEvents) || DEFAULT_SESSION_LIMIT))
  if (!excess) return 0
  const protectedRuns = unfinishedRunIds(ordered)
  let deleted = 0
  for (const event of ordered) {
    if (!excess) break
    if (preserveIds.has(event.id)) continue
    const runId = String(event?.payload?.runId || '')
    if (runId && protectedRuns.has(runId)) continue
    store.delete(event.id)
    excess--
    deleted++
  }
  return deleted
}

export const pruneAgentSessionEvents = async (chatKey, sessionId, maxEvents = DEFAULT_SESSION_LIMIT) => {
  const database = await openDatabase()
  const transaction = database.transaction(EVENT_STORE, 'readwrite')
  const store = transaction.objectStore(EVENT_STORE)
  const records = await requestResult(store.index(SESSION_INDEX).getAll(sessionKey(chatKey, sessionId)))
  const excess = pruneRecords(store, Array.isArray(records) ? records : [], maxEvents)
  await transactionDone(transaction)
  return excess
}

export const appendAgentEvent = async (event, { maxEvents = DEFAULT_SESSION_LIMIT } = {}) => {
  const normalized = normalizeEvent(event)
  const database = await openDatabase()
  const transaction = database.transaction(EVENT_STORE, 'readwrite')
  const store = transaction.objectStore(EVENT_STORE)
  const records = await requestResult(store.index(SESSION_INDEX).getAll(normalized.sessionKey))
  const byId = new Map((records || []).map((item) => [item.id, item]))
  byId.set(normalized.id, normalized)
  pruneRecords(store, [...byId.values()], maxEvents, new Set([normalized.id]))
  store.put(normalized)
  await transactionDone(transaction)
  return true
}

export const enqueueAgentEvent = (event) => {
  const operation = writeQueue.then(() => appendAgentEvent(event))
  writeQueue = operation.catch(() => false)
  return operation.catch(() => false)
}

export const flushAgentEvents = () => writeQueue

export const listAgentSessionEvents = async (chatKey, sessionId, { limit = 500 } = {}) => {
  await writeQueue
  const database = await openDatabase()
  const transaction = database.transaction(EVENT_STORE, 'readonly')
  const records = await requestResult(transaction.objectStore(EVENT_STORE).index(SESSION_INDEX).getAll(sessionKey(chatKey, sessionId)))
  await transactionDone(transaction)
  return (Array.isArray(records) ? records : [])
    .sort(eventOrder)
    .slice(-Math.max(1, Number(limit) || 500))
}

export const deleteAgentSessionEvents = (chatKey, sessionId) => {
  const key = sessionKey(chatKey, sessionId)
  const operation = writeQueue.then(async () => {
    const database = await openDatabase()
    const transaction = database.transaction(EVENT_STORE, 'readwrite')
    const store = transaction.objectStore(EVENT_STORE)
    const ids = await requestResult(store.index(SESSION_INDEX).getAllKeys(key))
    for (const id of ids || []) store.delete(id)
    await transactionDone(transaction)
    return true
  })
  writeQueue = operation.catch(() => false)
  return operation.catch(() => false)
}

export const findInterruptedAgentRuns = (events) => {
  const runs = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    const runId = String(event?.payload?.runId || '')
    if (!runId) continue
    let run = runs.get(runId)
    if (!run) {
      run = {
        runId,
        promptId: '',
        surfaceKey: '',
        startedAt: 0,
        lastEventAt: 0,
        started: false,
        toolStarts: [],
        toolStartCounts: new Map(),
        settledToolCounts: new Map(),
        terminal: false
      }
      runs.set(runId, run)
    }
    run.lastEventAt = Math.max(run.lastEventAt, Number(event.at) || 0)
    if (event.type === 'run.started') {
      run.started = true
      run.promptId ||= String(event.payload?.promptId || '')
      run.surfaceKey ||= String(event.payload?.surfaceKey || '')
      const at = Number(event.at) || 0
      run.startedAt = run.startedAt ? Math.min(run.startedAt, at) : at
    } else if (event.type === 'tool.started') {
      const callId = String(event.payload?.callId || event.id)
      const occurrence = (run.toolStartCounts.get(callId) || 0) + 1
      run.toolStartCounts.set(callId, occurrence)
      run.toolStarts.push({ callId, tool: String(event.payload?.tool || 'unknown'), occurrence })
    } else if (event.type === 'tool.settled') {
      const callId = String(event.payload?.callId || event.id)
      run.settledToolCounts.set(callId, (run.settledToolCounts.get(callId) || 0) + 1)
    } else if (TERMINAL_RUN_EVENTS.has(event.type)) {
      run.terminal = true
    }
  }
  return [...runs.values()]
    .filter((run) => run.started && !run.terminal)
    .map((run) => ({
      runId: run.runId,
      promptId: run.promptId,
      ...(run.surfaceKey ? { surfaceKey: run.surfaceKey } : {}),
      startedAt: run.startedAt,
      lastEventAt: run.lastEventAt,
      uncertainTools: run.toolStarts
        .filter(({ callId, occurrence }) => occurrence > (run.settledToolCounts.get(callId) || 0))
        .map(({ callId, tool }) => ({ callId, tool }))
    }))
}
