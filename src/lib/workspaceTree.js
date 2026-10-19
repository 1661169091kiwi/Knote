// Browsing a directory must not depend on indexing its descendants. Limits
// apply between complete directory layers, never halfway through a parent.
export const EXCLUDED_WORKSPACE_DIRS = new Set(['.git', '.svn', '.hg', '.cache', '.next', '.nuxt', 'node_modules', 'dist', 'release', 'coverage'])
const pendingLoads = new WeakMap()
const abortIfStale = current => {
  if (current()) return
  const error = new Error('Folder traversal was superseded')
  error.name = 'AbortError'
  throw error
}

export function workspaceFileType(name, detectType = () => null) {
  if (/\.(md|markdown)$/i.test(name)) return 'md'
  if (/\.pdf$/i.test(name)) return 'pdf'
  if (/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(name)) return 'image'
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase()
  if (['docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp', 'txt', 'csv', 'rtf'].includes(extension)) return extension
  return detectType(name) === 'code' ? 'code' : null
}

export async function readWorkspaceLayer(handle, path = '', { classify = workspaceFileType, stillCurrent = () => true, onEntry = () => {} } = {}) {
  abortIfStale(stillCurrent)
  const dirs = [], files = []
  let count = 0
  for await (const [name, child] of handle.entries()) {
    abortIfStale(stillCurrent)
    onEntry()
    if (child.kind === 'directory') {
      if (!EXCLUDED_WORKSPACE_DIRS.has(name)) dirs.push({ name, kind: 'dir', handle: child, parent: handle, path: `${path}/${name}`, children: [], childrenLoaded: false, loading: false, loadError: '' })
    } else {
      const ftype = classify(name)
      if (ftype) files.push({ name, kind: 'file', ftype, handle: child, parent: handle, path: `${path}/${name}` })
    }
    if (++count % 256 === 0) await new Promise(resolve => setTimeout(resolve, 0))
  }
  abortIfStale(stillCurrent)
  const byName = (a, b) => a.name.localeCompare(b.name)
  return [...dirs.sort(byName), ...files.sort(byName)]
}

export function workspaceTraversal(tree, depthLimit = 12) {
  const omittedPaths = []
  const walk = nodes => {
    for (const node of nodes) if (node.kind === 'dir') {
      if (!node.childrenLoaded) omittedPaths.push(node.path.replace(/^\//, ''))
      else walk(node.children)
    }
  }
  walk(tree)
  return Object.freeze({ complete: !omittedPaths.length, depthLimit, omittedPaths: Object.freeze(omittedPaths) })
}

export async function loadWorkspaceDirectory(node, options = {}) {
  if (node.childrenLoaded) return node.children
  if (pendingLoads.has(node)) return pendingLoads.get(node)
  node.loading = true
  node.loadError = ''
  const load = (async () => {
    try {
      const children = await readWorkspaceLayer(node.handle, node.path, options)
      node.children = children
      node.childrenLoaded = true
      return children
    } catch (error) {
      if (error?.name !== 'AbortError') node.loadError = String(error?.message || error)
      throw error
    } finally {
      node.loading = false
      pendingLoads.delete(node)
    }
  })()
  pendingLoads.set(node, load)
  return load
}

export async function buildWorkspaceTree(handle, { path = '', recursive = true, depthLimit = 12, maxEntries = 10_000, maxMs = 12_000, ...options } = {}) {
  let count = 0
  const deadline = Date.now() + maxMs
  const settings = { ...options, onEntry: () => { count++ } }
  const tree = await readWorkspaceLayer(handle, path, settings)
  Object.defineProperty(tree, '_agentTraversal', { get: () => workspaceTraversal(tree, depthLimit), enumerable: false })
  if (!recursive) return tree
  const queue = tree.filter(node => node.kind === 'dir').map(node => ({ node, depth: 1 }))
  // Breadth first: a large cache never starves siblings and root documents.
  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (count >= maxEntries || Date.now() > deadline) break
    const { node, depth } = queue[cursor]
    if (depth > depthLimit) continue
    try {
      const children = await loadWorkspaceDirectory(node, settings)
      for (const child of children) if (child.kind === 'dir') queue.push({ node: child, depth: depth + 1 })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      // An unreadable subtree stays explicitly incomplete, not silently empty.
    }
  }
  return tree
}

export async function resolveWorkspaceFile(handle, relativePath, classify = workspaceFileType) {
  const parts = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/')
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[:\0]/.test(part))) return null
  const name = parts.pop(), ftype = classify(name)
  if (!ftype || parts.some(part => EXCLUDED_WORKSPACE_DIRS.has(part))) return null
  try {
    let parent = handle
    for (const part of parts) parent = await parent.getDirectoryHandle(part)
    const file = await parent.getFileHandle(name)
    return { name, kind: 'file', ftype, handle: file, parent, path: '/' + [...parts, name].join('/') }
  } catch { return null }
}

export async function restoreWorkspaceExpansions(tree, expandedPaths, options = {}) {
  for (const path of [...expandedPaths].sort((a, b) => a.split('/').length - b.split('/').length)) {
    let nodes = tree
    for (const name of path.split('/').filter(Boolean)) {
      const node = nodes.find(node => node.kind === 'dir' && node.name === name)
      if (!node) break
      try { nodes = await loadWorkspaceDirectory(node, options) } catch (error) {
        if (error?.name === 'AbortError') throw error
        break
      }
    }
  }
  return tree
}
