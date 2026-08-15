const DB_NAME = 'knote-agent-state'
const DB_VERSION = 1
const STATE_STORE = 'chatState'

let databasePromise = null
let writeQueue = Promise.resolve()

const openDatabase = () => {
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Agent state storage is unavailable'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STATE_STORE)) database.createObjectStore(STATE_STORE, { keyPath: 'chatKey' })
    }
    request.onblocked = () => reject(new Error('Agent state storage upgrade is blocked'))
    request.onerror = () => reject(request.error || new Error('Could not open Agent state storage'))
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
  transaction.onabort = () => reject(transaction.error || new Error('Agent state transaction aborted'))
  transaction.onerror = () => reject(transaction.error || new Error('Agent state transaction failed'))
})

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error || new Error('Agent state request failed'))
})

export const saveAgentChatState = async (chatKey, state) => {
  const key = String(chatKey || '')
  if (!key || !state || typeof state !== 'object') throw new TypeError('chatKey and state are required')
  const database = await openDatabase()
  const transaction = database.transaction(STATE_STORE, 'readwrite')
  transaction.objectStore(STATE_STORE).put({ chatKey: key, state })
  await transactionDone(transaction)
  return true
}

export const enqueueAgentChatState = (chatKey, state) => {
  const operation = writeQueue.then(() => saveAgentChatState(chatKey, state))
  writeQueue = operation.catch(() => false)
  return operation.catch(() => false)
}

export const loadAgentChatState = async (chatKey) => {
  await writeQueue
  const database = await openDatabase()
  const transaction = database.transaction(STATE_STORE, 'readonly')
  const record = await requestResult(transaction.objectStore(STATE_STORE).get(String(chatKey || '')))
  await transactionDone(transaction)
  return record?.state || null
}

export const deleteAgentChatState = (chatKey) => {
  const operation = writeQueue.then(async () => {
    const database = await openDatabase()
    const transaction = database.transaction(STATE_STORE, 'readwrite')
    transaction.objectStore(STATE_STORE).delete(String(chatKey || ''))
    await transactionDone(transaction)
    return true
  })
  writeQueue = operation.catch(() => false)
  return operation.catch(() => false)
}

export const flushAgentChatState = () => writeQueue
