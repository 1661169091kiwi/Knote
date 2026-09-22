'use strict'

const requiredFunction = (value, name) => {
  if (typeof value !== 'function') throw new TypeError(`${name} is required`)
  return value
}
const isStaleError = (error) => error?.stale === true || error?.code === 'STALE_DOCUMENT'

const createFsWriteIfUnchanged = ({
  serialize,
  authorizeTarget,
  assertWritable,
  readText,
  saveDocument,
  // Follow-up work that has to share this operation's lane — the main process
  // uses it to renew the open grant and reissue the capability after the bytes
  // land. It runs INSIDE the serialized task, so a caller must never ALSO wrap
  // this factory in `serialize`: the queue is serial, the outer task would await
  // the inner one while holding the lane the inner one is waiting for, and every
  // conditional write would hang forever.
  onCommitted = null
} = {}) => {
  const runSerialized = requiredFunction(serialize, 'serialize')
  const authorize = requiredFunction(authorizeTarget, 'authorizeTarget')
  const assertTargetWritable = requiredFunction(assertWritable, 'assertWritable')
  const read = requiredFunction(readText, 'readText')
  const save = requiredFunction(saveDocument, 'saveDocument')
  const afterCommit = onCommitted === null ? null : requiredFunction(onCommitted, 'onCommitted')


  return (request = {}) => {
    if (typeof request.expectedContent !== 'string') {
      return Promise.reject(new TypeError('expectedContent must be a string'))
    }
    const expectedContent = request.expectedContent
    const data = String(request.data == null ? '' : request.data)
    return runSerialized(async () => {
      // Authorization and the first comparison happen only after this operation
      // owns the same mutation lane as saves, renames, deletes, and creates.
      const target = authorize(request.path)
      assertTargetWritable(target)
      const current = await read(target)
      const currentContent = current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, 'content')
        ? String(current.content)
        : String(current)
      if (current?.stable === false || currentContent !== expectedContent) {
        return { ok: false, stale: true, error: 'stale_file' }
      }
      try {
        await save(target, data, {
          expectedContent,
          expectedStat: current && typeof current === 'object' ? current.stat : null
        })
      } catch (error) {
        if (isStaleError(error)) return { ok: false, stale: true, error: 'stale_file' }
        throw error
      }
      if (afterCommit) {
        try {
          await afterCommit(target)
        } catch { /* committed bytes: a follow-up hook must never fail the write */ }
      }
      return { ok: true }
    })
  }
}

module.exports = { createFsWriteIfUnchanged, isStaleError }
