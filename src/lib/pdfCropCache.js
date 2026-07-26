const canonicalCoordinate = (value, precision) => {
  const n = Math.max(0, Math.min(1, Number(value)))
  if (!Number.isFinite(n)) throw new TypeError('PDF crop coordinates must be finite numbers')
  return n.toFixed(precision)
}

export const pdfCropCacheKey = ({ attachmentId, page, bbox, precision = 5 }) => {
  if (!attachmentId) throw new TypeError('PDF crop cache requires an attachment id')
  const sourcePage = Math.floor(Number(page))
  if (!Number.isFinite(sourcePage) || sourcePage < 1) throw new TypeError('PDF crop cache requires a valid page')
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new TypeError('PDF crop cache requires a four-value bbox')
  const box = bbox.map((value) => canonicalCoordinate(value, precision))
  return `${attachmentId}|${sourcePage}|${box.join(',')}`
}

// Deduplicate both completed crops and identical crops that are still running.
// The cache stores only lightweight resource metadata; the caller owns the
// actual image bytes and supplies isAlive so stale resource ids are never used.
export const createPdfCropCache = () => {
  const completed = new Map()
  const inFlight = new Map()

  const resolve = async (key, create, isAlive = () => true) => {
    const existing = completed.get(key)
    if (existing && isAlive(existing)) {
      return { resource: existing, reused: true, source: 'cache' }
    }
    if (existing) completed.delete(key)

    const pending = inFlight.get(key)
    if (pending) {
      const resource = await pending
      return { resource, reused: true, source: 'in_flight' }
    }

    const task = Promise.resolve().then(create)
    inFlight.set(key, task)
    try {
      const resource = await task
      completed.set(key, resource)
      return { resource, reused: false, source: 'created' }
    } finally {
      if (inFlight.get(key) === task) inFlight.delete(key)
    }
  }

  const invalidateAttachment = (attachmentId) => {
    const prefix = `${attachmentId}|`
    for (const key of completed.keys()) if (key.startsWith(prefix)) completed.delete(key)
  }

  return {
    resolve,
    invalidateAttachment,
    clear: () => completed.clear(),
    size: () => completed.size
  }
}
