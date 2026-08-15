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
  saveDocument
} = {}) => {
  const runSerialized = requiredFunction(serialize, 'serialize')
  const authorize = requiredFunction(authorizeTarget, 'authorizeTarget')
  const assertTargetWritable = requiredFunction(assertWritable, 'assertWritable')
  const read = requiredFunction(readText, 'readText')
  const save = requiredFunction(saveDocument, 'saveDocument')

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
      return { ok: true }
    })
  }
}

module.exports = { createFsWriteIfUnchanged, isStaleError }
