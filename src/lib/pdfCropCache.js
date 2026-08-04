const canonicalCoordinate = (value, precision) => {
  const n = Math.max(0, Math.min(1, Number(value)))
  if (!Number.isFinite(n)) throw new TypeError('PDF crop coordinates must be finite numbers')
  return n.toFixed(precision)
}

export const pdfCropCacheKey = ({ scope = '', attachmentId, page, bbox, precision = 5 }) => {
  if (!attachmentId) throw new TypeError('PDF crop cache requires an attachment id')
  const sourcePage = Math.floor(Number(page))
  if (!Number.isFinite(sourcePage) || sourcePage < 1) throw new TypeError('PDF crop cache requires a valid page')
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new TypeError('PDF crop cache requires a four-value bbox')
  const box = bbox.map((value) => canonicalCoordinate(value, precision))
  const scopePrefix = scope ? `${encodeURIComponent(String(scope))}::` : ''
  return `${scopePrefix}${attachmentId}|${sourcePage}|${box.join(',')}`
}

// Deduplicate both completed crops and identical crops that are still running.
// The cache stores only lightweight resource metadata; the caller owns the
// actual image bytes and supplies isAlive so stale resource ids are never used.
export const createPdfCropCache = () => {
  const completed = new Map()
  const inFlight = new Map()
  const generations = new Map()
  let clearGeneration = 0
  const generationFor = (key) => `${clearGeneration}:${generations.get(key) || 0}`
  const invalidateKey = (key) => {
    generations.set(key, (generations.get(key) || 0) + 1)
    completed.delete(key)
    inFlight.delete(key)
  }

  const resolve = async (key, create, isAlive = () => true) => {
    const existing = completed.get(key)
    if (existing && isAlive(existing)) {
      return { resource: existing, reused: true, source: 'cache' }
    }
    if (existing) completed.delete(key)

    const generation = generationFor(key)
    const pending = inFlight.get(key)
    if (pending && pending.generation === generation) {
      const resource = await pending.task
      if (generationFor(key) !== generation || !isAlive(resource)) return resolve(key, create, isAlive)
      return { resource, reused: true, source: 'in_flight' }
    }

    const task = Promise.resolve().then(create)
    const record = { generation, task }
    inFlight.set(key, record)
    try {
      const resource = await task
      if (generationFor(key) === generation && inFlight.get(key) === record && isAlive(resource)) {
        completed.set(key, resource)
      }
      return { resource, reused: false, source: 'created' }
    } finally {
      if (inFlight.get(key) === record) inFlight.delete(key)
    }
  }

  const invalidateAttachment = (attachmentId, scope = '') => {
    const scopePrefix = scope ? `${encodeURIComponent(String(scope))}::` : ''
    const prefix = `${scopePrefix}${attachmentId}|`
    const keys = new Set([...completed.keys(), ...inFlight.keys(), ...generations.keys()])
    for (const key of keys) if (key.startsWith(prefix)) invalidateKey(key)
  }

  const invalidateScope = (scope) => {
    const prefix = `${encodeURIComponent(String(scope || ''))}::`
    const keys = new Set([...completed.keys(), ...inFlight.keys(), ...generations.keys()])
    for (const key of keys) if (key.startsWith(prefix)) invalidateKey(key)
  }

  const clear = () => {
    clearGeneration++
    completed.clear()
    inFlight.clear()
    generations.clear()
  }

  return {
    resolve,
    invalidateAttachment,
    invalidateScope,
    clear,
    size: () => completed.size
  }
}
