const text = (value) => String(value == null ? '' : value)

// JSON tuples keep every identity boundary explicit, so path separators or
// user-controlled document text cannot collide with another surface.
export const createAgentSurfaceKey = ({ workspaceId = '', documentId = '', tabId = '' } = {}) => JSON.stringify([
  'knote-agent-surface-v1',
  text(workspaceId),
  text(documentId),
  text(tabId)
])

export const createAgentDraftKey = (surfaceKey, sessionId) => JSON.stringify([
  'knote-agent-draft-v1',
  text(surfaceKey),
  text(sessionId)
])

export const isAgentSurfaceKey = (value) => {
  try {
    const tuple = JSON.parse(String(value || ''))
    return Array.isArray(tuple) && tuple.length === 4 && tuple[0] === 'knote-agent-surface-v1' &&
      tuple.slice(1).every((part) => typeof part === 'string')
  } catch {
    return false
  }
}
