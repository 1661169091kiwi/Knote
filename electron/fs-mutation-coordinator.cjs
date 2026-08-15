'use strict'

const path = require('node:path')

const defaultPathKey = (target) => {
  const resolved = path.resolve(String(target || ''))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const createFsMutationCoordinator = ({
  toKey = defaultPathKey,
  separator = path.sep
} = {}) => {
  let tail = Promise.resolve()
  let generation = 0
  const staleRoots = new Set()

  const run = (task) => {
    if (typeof task !== 'function') throw new TypeError('mutation task is required')
    const operation = tail.catch(() => {}).then(() => {
      generation += 1
      return task()
    })
    tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  const isStale = (target) => {
    const key = toKey(target)
    for (const root of staleRoots) {
      if (key === root || key.startsWith(root + separator)) return true
    }
    return false
  }

  const assertWritable = (target) => {
    if (!isStale(target)) return target
    const error = new Error('stale_path_write_blocked')
    error.code = 'STALE_PATH_WRITE_BLOCKED'
    throw error
  }

  const markStale = (target) => {
    const key = toKey(target)
    // A stale ancestor already covers this path. Conversely, replacing stale
    // descendants with their ancestor keeps the set bounded after dir deletes.
    for (const root of staleRoots) {
      if (key === root || key.startsWith(root + separator)) return key
    }
    for (const root of [...staleRoots]) {
      if (root.startsWith(key + separator)) staleRoots.delete(root)
    }
    staleRoots.add(key)
    return key
  }

  const clearStale = (target) => {
    const key = toKey(target)
    for (const root of [...staleRoots]) {
      if (root === key || root.startsWith(key + separator)) staleRoots.delete(root)
    }
    return key
  }

  return {
    run,
    isStale,
    assertWritable,
    markStale,
    clearStale,
    generation: () => generation,
    whenIdle: () => tail,
    staleRootsForTest: () => [...staleRoots]
  }
}

module.exports = { createFsMutationCoordinator }
