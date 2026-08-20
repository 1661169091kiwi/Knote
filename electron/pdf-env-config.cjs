// pdf-env-config.cjs — user-configurable PaddleOCR environment location and
// Python interpreter for the one-click PDF layout sidecar setup.
// Stored as JSON at <userData>/pdf-env-config.json; both fields empty means
// "default userData/pdf-env + auto-detected system python".
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const loadPdfEnvConfig = (file) => {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      envDir: typeof raw.envDir === 'string' ? raw.envDir.trim() : '',
      pythonPath: typeof raw.pythonPath === 'string' ? raw.pythonPath.trim() : ''
    }
  } catch { /* missing/corrupt file → defaults */ }
  return { envDir: '', pythonPath: '' }
}

// Pure validation shared by the IPC handler and the tests. Returns an error
// string, or '' when the value is acceptable. envDir requires a filesystem
// check for the foreign-folder guard, passed in as `dirState` ('missing' |
// 'empty' | 'ours' | 'foreign').
const validateEnvDir = (envDir, dirState) => {
  if (!envDir) return ''
  if (!path.isAbsolute(envDir)) return '路径必须是绝对路径'
  if (path.parse(envDir).root === path.normalize(envDir)) return '不能把磁盘根目录当作环境目录'
  // Never take over a non-empty folder we did not create: uninstalling the env
  // deletes the whole directory, so an arbitrary user folder is off-limits.
  if (dirState === 'foreign') return '该目录非空且不是 Knote 创建的环境（卸载会删除整个目录）'
  return ''
}

const validatePythonPath = (pythonPath) => {
  if (!pythonPath) return ''
  if (!path.isAbsolute(pythonPath)) return '解释器路径必须是绝对路径'
  if (!/python[\d.]*(?:\.exe)?$/i.test(path.basename(pythonPath))) return '解释器路径应指向 python 可执行文件'
  return ''
}

// What the env dir contains when it is one of ours (venv, embedded python, or
// a previously completed install marker).
const classifyEnvDir = (dir) => {
  let entries
  try { entries = fs.readdirSync(dir) } catch { return 'missing' }
  if (!entries.length) return 'empty'
  const ours = entries.some((name) => name === '.knote_ready' || name === 'Scripts' || name === 'bin' || /^python.*\.exe$/i.test(name) || /^python\d+\.\d+/i.test(name))
  return ours ? 'ours' : 'foreign'
}

const savePdfEnvConfig = (file, config) => {
  fs.writeFileSync(file, JSON.stringify({
    envDir: String(config.envDir || ''),
    pythonPath: String(config.pythonPath || '')
  }, null, 2))
}

module.exports = { loadPdfEnvConfig, savePdfEnvConfig, validateEnvDir, validatePythonPath, classifyEnvDir }
