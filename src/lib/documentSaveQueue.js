// Serialises saves per immutable document identity. Different documents may
// write concurrently, but an older write for one document can never land after
// a newer write for that same document.
const queues = new Map()

export const enqueueDocumentSave = (identity, task) => {
  const key = String(identity || '')
  if (!key) return Promise.reject(new Error('save identity is required'))
  const previous = queues.get(key) || Promise.resolve()
  const operation = previous.catch(() => {}).then(task)
  const tracked = operation.then(() => undefined, () => undefined).finally(() => {
    if (queues.get(key) === tracked) queues.delete(key)
  })
  queues.set(key, tracked)
  return operation
}

export const waitForDocumentSaves = async (identity) => {
  const pending = queues.get(String(identity || ''))
  if (pending) await pending
}

export const pendingDocumentSaveCount = () => queues.size
