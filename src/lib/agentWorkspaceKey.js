const windowsPath = (value) => /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)

export const canonicalAgentWorkspaceId = (value) => {
  const id = String(value || '')
  const match = /^(folder|file):(.*)$/s.exec(id)
  if (!match || !windowsPath(match[2])) return id

  let path = match[2].replace(/\\/g, '/')
  if (path.startsWith('//')) path = `//${path.slice(2).replace(/\/{2,}/g, '/')}`
  else path = path.replace(/\/{2,}/g, '/')
  if (path.length > 3) path = path.replace(/\/+$/, '')
  return `${match[1]}:${path.toLowerCase()}`
}
