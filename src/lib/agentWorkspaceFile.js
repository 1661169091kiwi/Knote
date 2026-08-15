const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])
const PLAIN_TEXT_EXTENSIONS = new Map([
  ['txt', 'txt'],
  ['csv', 'csv'],
  ['rtf', 'rtf']
])
const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'css', 'scss', 'sass', 'less',
  'htm', 'html', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'config',
  'xml', 'py', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs',
  'go', 'rs', 'rb', 'php', 'swift', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'cmd', 'sql', 'graphql', 'gql', 'proto', 'gradle', 'properties', 'env'
])
const NAMED_TEXT_FILES = new Set([
  'dockerfile', 'makefile', 'cmakelists.txt', 'podfile', 'gemfile', 'rakefile',
  'readme', 'license', 'notice', 'changelog'
])
const DOT_TEXT_FILES = new Set([
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc',
  '.prettierrc', '.eslintrc'
])
const UNSAFE_PATH_TEXT_RE = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u
const RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

const basenameOf = (value) => String(value || '').replace(/\\/g, '/').split('/').pop() || ''
const extensionOf = (name) => {
  const index = name.lastIndexOf('.')
  return index >= 0 && index < name.length - 1 ? name.slice(index + 1).toLowerCase() : ''
}

// This classifier is the single source of truth for files the Agent may write
// as UTF-8. SVG is writable text, but remains an image in the workspace tree.
export const classifyAgentWritableFile = (value) => {
  const name = basenameOf(value)
  const lower = name.toLowerCase()
  if (!name) return null
  if (NAMED_TEXT_FILES.has(lower) || DOT_TEXT_FILES.has(lower)) return 'code'
  const extension = extensionOf(name)
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (PLAIN_TEXT_EXTENSIONS.has(extension)) return PLAIN_TEXT_EXTENSIONS.get(extension)
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (extension === 'svg') return 'svg'
  return null
}

export const isAgentEditableTextFile = (value) => {
  const kind = classifyAgentWritableFile(value)
  return !!kind && kind !== 'svg'
}

export const isAgentCodeFile = (value) => classifyAgentWritableFile(value) === 'code'

export const resolveAgentCreateFilePath = (value) => {
  const raw = typeof value === 'string' ? value : ''
  if (!raw || raw !== raw.trim()) {
    return { ok: false, code: 'INVALID_PATH', reason: 'empty_or_surrounding_whitespace' }
  }
  const path = raw.replace(/\\/g, '/')
  if (path.length > 1024 || UNSAFE_PATH_TEXT_RE.test(path)) {
    return { ok: false, code: 'INVALID_PATH', reason: 'invalid_path_text' }
  }
  if (/^(?:\/|[A-Za-z]:)/.test(path)) {
    return { ok: false, code: 'INVALID_PATH', reason: 'absolute_path' }
  }
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' ||
      segment.length > 255 || /[<>:"|?*]/.test(segment) || /[ .]$/.test(segment) || RESERVED_NAME_RE.test(segment))) {
    return { ok: false, code: 'INVALID_PATH', reason: 'invalid_path_segment' }
  }

  const name = segments[segments.length - 1]
  const explicitKind = classifyAgentWritableFile(name)
  if (explicitKind) {
    return { ok: true, path: segments.join('/'), kind: explicitKind, defaultedExtension: false }
  }
  if (/\.[^./]+$/.test(name)) {
    return { ok: false, code: 'UNSUPPORTED_FILE_TYPE', reason: 'unsupported_extension' }
  }
  segments[segments.length - 1] = `${name}.md`
  return { ok: true, path: segments.join('/'), kind: 'markdown', defaultedExtension: true }
}

export const isAgentCreatableFile = (value) => resolveAgentCreateFilePath(value).ok

const reservedWritePaths = new Set()
const writeFailure = (code, reason) => ({ ok: false, code, reason })
const missingEntry = (error) => error?.name === 'NotFoundError' || error?.code === 'ENOENT'
const EXCLUSIVE_FAILURE_CODES = new Set([
  'TARGET_EXISTS',
  'WORKSPACE_CHANGED',
  'EXCLUSIVE_CREATE_UNAVAILABLE',
  'CREATE_PUBLICATION_UNCERTAIN',
  'CREATE_PUBLICATION_RECOVERY_REQUIRED'
])

// Parent directories are separate mutations and must already exist. This keeps
// create_file from silently acquiring create_folder's broader side effects.
export const createAgentWorkspaceFile = async (rootHandle, relativePath, content, { reservationScope = '', exactName = false } = {}) => {
  if (!rootHandle || typeof rootHandle.getDirectoryHandle !== 'function') {
    return writeFailure('WORKSPACE_CHANGED', 'workspace_binding_unavailable')
  }
  const resolved = resolveAgentCreateFilePath(relativePath)
  if (!resolved.ok) return resolved

  const segments = resolved.path.split('/')
  const requestedName = segments.pop()
  let reservationKey = ''
  try {
    let directory = rootHandle
    for (const segment of segments) {
      try { directory = await directory.getDirectoryHandle(segment) } catch (error) {
        if (missingEntry(error)) return writeFailure('PARENT_MISSING', 'parent_directory_missing')
        throw error
      }
    }

    const dot = requestedName.lastIndexOf('.')
    const base = dot > 0 ? requestedName.slice(0, dot) : requestedName
    const extension = dot > 0 ? requestedName.slice(dot) : ''
    const directoryKey = segments.join('/').toLowerCase()
    const scopeKey = String(reservationScope || '')
    let finalName = ''
    for (let index = 1; index < (exactName ? 2 : 1000); index += 1) {
      const candidate = index === 1 ? requestedName : `${base}-${index}${extension}`
      const key = `${scopeKey}\u0000${directoryKey}/${candidate.toLowerCase()}`
      if (reservedWritePaths.has(key)) continue
      reservedWritePaths.add(key)
      let exists = false
      try { await directory.getFileHandle(candidate); exists = true } catch (error) {
        if (!missingEntry(error)) throw error
      }
      if (exists) {
        reservedWritePaths.delete(key)
        if (exactName) return writeFailure('TARGET_EXISTS', 'exact_target_exists')
        continue
      }
      finalName = candidate
      reservationKey = key
      break
    }
    if (!finalName) return writeFailure('NAME_COLLISION_LIMIT', 'no_available_name')

    if (exactName) {
      if (typeof directory.createFileExclusive !== 'function') {
        return writeFailure('EXCLUSIVE_CREATE_UNAVAILABLE', 'atomic_no_replace_unavailable')
      }
      const created = await directory.createFileExclusive(finalName, String(content ?? ''))
      if (!created?.ok) {
        if (EXCLUSIVE_FAILURE_CODES.has(created?.code)) {
          return writeFailure(created.code, String(created?.reason || created.code).slice(0, 80))
        }
        return writeFailure('WRITE_FAILED', String(created?.reason || created?.code || 'exclusive_create_failed').slice(0, 80))
      }
      return {
        ok: true,
        code: 'FILE_CREATED',
        path: (segments.length ? `${segments.join('/')}/` : '') + finalName,
        kind: resolved.kind,
        defaultedExtension: resolved.defaultedExtension
      }
    }

    const fileHandle = await directory.getFileHandle(finalName, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(String(content ?? ''))
    await writable.close()
    return {
      ok: true,
      code: 'FILE_CREATED',
      path: (segments.length ? `${segments.join('/')}/` : '') + finalName,
      kind: resolved.kind,
      defaultedExtension: resolved.defaultedExtension
    }
  } catch (error) {
    return writeFailure('WRITE_FAILED', String(error?.name || error?.code || 'write_failed').slice(0, 80))
  } finally {
    if (reservationKey) reservedWritePaths.delete(reservationKey)
  }
}
