export const agentResourceScopeKey = (chatKey, sessionId) => (
  `${String(chatKey || '')}\u0000${String(sessionId || '')}`
)

export const agentResourceStorageKey = (scope, resourceId) => (
  `${String(scope || '')}\u0001${String(resourceId || '')}`
)

export const agentResourceScopeTag = (scope) => {
  let hash = 2166136261
  const value = String(scope || '')
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
