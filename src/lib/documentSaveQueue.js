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
  const key = String(identity || '')
  while (true) {
    const pending = queues.get(key)
    if (!pending) return
    await pending
  }
}

// Drain a moving target: a completion may enqueue a final follow-up save.
export const waitForAllDocumentSaves = async () => {
  while (queues.size) {
    const pending = [...new Set(queues.values())]
    await Promise.all(pending)
  }
}

export const pendingDocumentSaveCount = () => queues.size
