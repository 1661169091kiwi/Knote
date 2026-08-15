const windowsPath = (value) => /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)

const normalizedWindowsAgentWorkspace = (value) => {
  const id = String(value || '')
  const match = /^(folder|file):(.*)$/s.exec(id)
  if (!match || !windowsPath(match[2])) return null

  let path = match[2].replace(/\\/g, '/')
  if (path.startsWith('//')) path = `//${path.slice(2).replace(/\/{2,}/g, '/')}`
  else path = path.replace(/\/{2,}/g, '/')
  if (path.length > 3) path = path.replace(/\/+$/, '')
  return { kind: match[1], path }
}

export const canonicalAgentWorkspaceId = (value) => {
  const normalized = normalizedWindowsAgentWorkspace(value)
  return normalized ? `${normalized.kind}:${normalized.path}` : String(value || '')
}

// Builds before exact-case workspace isolation folded Windows paths. Keep this
// only as an explicitly claimed migration source, never as a current identity.
export const historicalWindowsAgentWorkspaceId = (value) => {
  const normalized = normalizedWindowsAgentWorkspace(value)
  return normalized ? `${normalized.kind}:${normalized.path.toLowerCase()}` : ''
}
