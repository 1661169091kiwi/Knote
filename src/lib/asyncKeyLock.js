const tails = new Map()

// Serialize tasks sharing one canonical resource key while allowing unrelated
// files to proceed concurrently. Rejections never poison the next operation.
export const withAsyncKeyLock = (key, task) => {
  const normalized = String(key || '')
  if (!normalized) return Promise.reject(new Error('lock key is required'))
  if (typeof task !== 'function') return Promise.reject(new TypeError('lock task is required'))
  const previous = tails.get(normalized) || Promise.resolve()
  const operation = previous.catch(() => {}).then(task)
  const tracked = operation.then(() => undefined, () => undefined).finally(() => {
    if (tails.get(normalized) === tracked) tails.delete(normalized)
  })
  tails.set(normalized, tracked)
  return operation
}

export const pendingAsyncKeyLockCount = () => tails.size
