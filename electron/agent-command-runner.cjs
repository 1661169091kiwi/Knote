'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ALLOWED_PROGRAMS = new Set(['node'])
const MAX_ARGS = 64
const MAX_ARG_CHARS = 4096
const MAX_TOTAL_ARG_CHARS = 4096
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 300_000

class AgentCommandError extends Error {
  constructor (code, message) {
    super(message || code)
    this.name = 'AgentCommandError'
    this.code = code
  }
}

const commandError = (code, message) => new AgentCommandError(code, message)

const normalizeArgs = (value) => {
  if (!Array.isArray(value) || value.length > MAX_ARGS) throw commandError('INVALID_COMMAND_ARGS', 'args must be a bounded array')
  const args = value.map((item) => {
    const arg = String(item)
    if (arg.length > MAX_ARG_CHARS || /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u.test(arg)) {
      throw commandError('INVALID_COMMAND_ARGS', 'arguments contain unsafe text')
    }
    return arg
  })
  if (args.reduce((total, arg) => total + arg.length, 0) > MAX_TOTAL_ARG_CHARS) {
    throw commandError('INVALID_COMMAND_ARGS', 'combined arguments are too long')
  }
  return args
}

const pathInside = (candidate, root) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const workspaceScript = (candidate, cwd) => {
  const raw = String(candidate || '')
  if (!raw || raw === '-' || path.isAbsolute(raw)) throw commandError('COMMAND_PATH_BLOCKED', 'script paths must be relative')
  const target = path.resolve(cwd, raw)
  let canonicalRoot
  let canonicalTarget
  try {
    canonicalRoot = fs.realpathSync(cwd)
    canonicalTarget = fs.realpathSync(target)
  } catch {
    throw commandError('COMMAND_PATH_NOT_FOUND', `script does not exist: ${raw}`)
  }
  if (!pathInside(canonicalTarget, canonicalRoot) || !fs.statSync(canonicalTarget).isFile()) {
    throw commandError('COMMAND_PATH_BLOCKED', 'script resolves outside the workspace or is not a file')
  }
  return canonicalTarget
}

const normalizeAgentCommandIntent = (request) => {
  const keys = Object.keys(request || {})
  const allowed = new Set(['id', 'program', 'args', 'cwd', 'timeoutMs'])
  if (keys.some((key) => !allowed.has(key))) throw commandError('INVALID_COMMAND_REQUEST', 'request contains authority-bearing or unsupported fields')
  const id = String(request?.id || '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 160)
  if (!id) throw commandError('INVALID_COMMAND_ID', 'command id is required')
  const program = String(request?.program || '').trim().toLowerCase()
  if (!ALLOWED_PROGRAMS.has(program) || /[\\/]/.test(program)) throw commandError('COMMAND_NOT_ALLOWED', 'program is not allowed')
  if (!path.isAbsolute(String(request?.cwd || ''))) throw commandError('INVALID_COMMAND_CWD', 'cwd must be an absolute workspace directory')
  const cwd = path.resolve(request.cwd)
  if (!fs.statSync(cwd).isDirectory()) throw commandError('INVALID_COMMAND_CWD', 'cwd is not a directory')
  const requestedArgs = normalizeArgs(request?.args)
  let artifactPaths = []
  let args
  if (requestedArgs.length === 1 && /^(?:-v|--version)$/.test(requestedArgs[0])) {
    args = [...requestedArgs]
  } else if (requestedArgs.length === 2 && requestedArgs[0] === '--check') {
    artifactPaths = [workspaceScript(requestedArgs[1], cwd)]
    args = ['--check', '--', requestedArgs[1]]
  } else {
    throw commandError('COMMAND_ARGS_BLOCKED', 'only node --version or node --check <workspace script> is allowed')
  }
  return Object.freeze({
    id,
    program,
    requestedArgs: Object.freeze([...requestedArgs]),
    args: Object.freeze(args),
    cwd,
    timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(request?.timeoutMs) || DEFAULT_TIMEOUT_MS)),
    artifactPaths: Object.freeze(artifactPaths)
  })
}

module.exports = {
  AgentCommandError,
  ALLOWED_PROGRAMS,
  normalizeAgentCommandIntent
}
