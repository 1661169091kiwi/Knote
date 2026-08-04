'use strict'

const fs = require('fs')
const path = require('path')

class WorkspaceBoundaryError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'WorkspaceBoundaryError'
    this.code = code
  }
}

const nativeRealpath = (target) => {
  if (fs.realpathSync.native) {
    try {
      return path.resolve(fs.realpathSync.native(target))
    } catch (error) {
      // Windows can deny the native handle-based probe for a traversable
      // profile ancestor (notably under constrained app/test tokens) while
      // the regular realpath implementation can still resolve it safely.
      if (!error || !['EPERM', 'EACCES'].includes(error.code)) throw error
    }
  }
  return path.resolve(fs.realpathSync(target))
}

const pathKey = (target) => {
  const resolved = path.resolve(String(target || ''))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const samePath = (left, right) => pathKey(left) === pathKey(right)

const isPathWithin = (candidate, root) => {
  const candidateKey = pathKey(candidate)
  const rootKey = pathKey(root)
  const rootPrefix = rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep
  return candidateKey === rootKey || candidateKey.startsWith(rootPrefix)
}

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif'
])

const assertImagePath = (candidate) => {
  if (!IMAGE_EXTENSIONS.has(path.extname(String(candidate || '')).toLowerCase())) {
    throw new WorkspaceBoundaryError('not_an_image', 'path does not have a supported image extension')
  }
}

const createBoundaryRoot = (rootPath) => {
  const lexical = path.resolve(String(rootPath || ''))
  let stat
  try {
    stat = fs.statSync(lexical)
  } catch {
    throw new WorkspaceBoundaryError('workspace_root_missing', 'workspace root does not exist')
  }
  if (!stat.isDirectory()) {
    throw new WorkspaceBoundaryError('workspace_root_not_directory', 'workspace root is not a directory')
  }
  return Object.freeze({
    lexical,
    lexicalKey: pathKey(lexical),
    canonical: nativeRealpath(lexical)
  })
}

const matchingRoot = (candidate, roots) => {
  const raw = String(candidate || '')
  if (!raw || !path.isAbsolute(raw)) {
    throw new WorkspaceBoundaryError('invalid_workspace_path', 'workspace path must be absolute')
  }
  const lexical = path.resolve(raw)
  let best = null
  for (const root of roots || []) {
    if (!root || !root.lexical || !root.canonical) continue
    if (!isPathWithin(lexical, root.lexical)) continue
    if (!best || root.lexical.length > best.lexical.length) best = root
  }
  if (!best) throw new WorkspaceBoundaryError('outside_workspace', 'outside workspace')
  return { lexical, root: best }
}

const lstatOrMissing = (target) => {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
}

/**
 * Resolve a renderer-supplied path against a root whose canonical destination
 * was frozen when the workspace was registered.
 *
 * The selected root itself may be a junction (a useful Windows workflow), but
 * every descendant component must be a normal path component.  This prevents a
 * workspace-local symlink/junction/reparse point from redirecting an operation
 * outside the registered root.
 */
const authorizePath = (candidate, roots, { mustExist }) => {
  const { lexical, root } = matchingRoot(candidate, roots)

  let currentRoot
  try {
    currentRoot = nativeRealpath(root.lexical)
  } catch {
    throw new WorkspaceBoundaryError('workspace_root_changed', 'workspace root is no longer available')
  }
  if (!samePath(currentRoot, root.canonical)) {
    throw new WorkspaceBoundaryError('workspace_root_changed', 'workspace root destination changed')
  }

  const relative = path.relative(root.lexical, lexical)
  const segments = relative ? relative.split(path.sep).filter(Boolean) : []
  let lexicalCursor = root.lexical
  let canonicalCursor = root.canonical

  for (let index = 0; index < segments.length; index += 1) {
    lexicalCursor = path.join(lexicalCursor, segments[index])
    canonicalCursor = path.join(canonicalCursor, segments[index])
    const stat = lstatOrMissing(lexicalCursor)

    if (!stat) {
      if (mustExist) {
        throw new WorkspaceBoundaryError('not_found', 'path does not exist')
      }
      // Once a component is absent, all remaining components are necessarily
      // new.  The nearest existing parent has already been verified.
      return {
        lexical,
        canonicalPath: path.resolve(root.canonical, relative),
        root,
        exists: false,
        nearestExistingParent: path.dirname(canonicalCursor)
      }
    }

    // Node reports Windows junctions and ordinary filesystem symlinks through
    // isSymbolicLink().  The realpath equality check below also catches other
    // redirecting reparse-point forms that Node does not classify explicitly.
    if (stat.isSymbolicLink()) {
      throw new WorkspaceBoundaryError('reparse_point_blocked', 'workspace path contains a symlink or junction')
    }
    // A regular file with more than one directory entry can expose the same
    // bytes both inside and outside the workspace without involving a reparse
    // point. There is no portable, race-free API for enumerating every NTFS
    // hard-link name, so reject only the exceptional multi-link file itself.
    // Ordinary files (nlink 0/1) and directories are unaffected.
    if (stat.isFile() && Number(stat.nlink) > 1) {
      throw new WorkspaceBoundaryError('hard_link_blocked', 'workspace file has multiple hard links')
    }

    let actual
    try {
      actual = nativeRealpath(lexicalCursor)
    } catch {
      throw new WorkspaceBoundaryError('not_found', 'path does not exist')
    }
    if (!samePath(actual, canonicalCursor) || !isPathWithin(actual, root.canonical)) {
      throw new WorkspaceBoundaryError('reparse_point_blocked', 'workspace path redirects outside its registered root')
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new WorkspaceBoundaryError('not_a_directory', 'a workspace path parent is not a directory')
    }
  }

  return {
    lexical,
    canonicalPath: segments.length ? canonicalCursor : root.canonical,
    root,
    exists: true,
    nearestExistingParent: segments.length ? path.dirname(canonicalCursor) : root.canonical
  }
}

const authorizeExistingPath = (candidate, roots) => authorizePath(candidate, roots, { mustExist: true })
const authorizeCreatablePath = (candidate, roots) => authorizePath(candidate, roots, { mustExist: false })
const authorizeExistingImagePath = (candidate, roots) => {
  assertImagePath(candidate)
  return authorizeExistingPath(candidate, roots)
}
const authorizeCreatableImagePath = (candidate, roots) => {
  assertImagePath(candidate)
  return authorizeCreatablePath(candidate, roots)
}
// Any single-file descendant that must live under a registered root's
// `assets/` directory. Unlike the image variant this is extension-agnostic, so
// a document can embed links to arbitrary attachments (pdf/docx/zip/...) that
// live in the same assets folder. The path must still sit below the registered
// root and never traverse a reparse point.
const authorizeCreatableAssetPath = (candidate, roots) => {
  const lexical = path.resolve(String(candidate || ''))
  let authorizationError = null
  for (const root of roots || []) {
    if (!root || !root.lexical) continue
    const relative = path.relative(root.lexical, lexical)
    const first = relative.split(path.sep).filter(Boolean)[0] || ''
    if (pathKey(first) !== pathKey('assets')) continue
    try {
      return authorizeCreatablePath(lexical, [root])
    } catch (error) {
      authorizationError = authorizationError || error
    }
  }
  if (authorizationError) throw authorizationError
  throw new WorkspaceBoundaryError('outside_asset_directory', 'single-file attachments must be written below assets')
}
const authorizeCreatableAssetImagePath = (candidate, roots) => {
  assertImagePath(candidate)
  return authorizeCreatableAssetPath(candidate, roots)
}

module.exports = {
  WorkspaceBoundaryError,
  authorizeCreatableAssetImagePath,
  authorizeCreatableAssetPath,
  authorizeCreatableImagePath,
  authorizeCreatablePath,
  authorizeExistingImagePath,
  authorizeExistingPath,
  createBoundaryRoot,
  isPathWithin,
  pathKey
}
