'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { loadPdfEnvConfig, savePdfEnvConfig, validateEnvDir, validatePythonPath, classifyEnvDir } = require('./pdf-env-config.cjs')

test('load returns defaults for missing or corrupt config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-pdfcfg-'))
  assert.deepEqual(loadPdfEnvConfig(path.join(dir, 'nope.json')), { envDir: '', pythonPath: '' })
  const bad = path.join(dir, 'bad.json')
  fs.writeFileSync(bad, '{not json')
  assert.deepEqual(loadPdfEnvConfig(bad), { envDir: '', pythonPath: '' })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('save + load round-trips and trims values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-pdfcfg-'))
  const file = path.join(dir, 'cfg.json')
  savePdfEnvConfig(file, { envDir: '  D:\\envs\\ocr  ', pythonPath: '' })
  assert.deepEqual(loadPdfEnvConfig(file), { envDir: 'D:\\envs\\ocr', pythonPath: '' })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('envDir validation: default ok, relative refused, root refused, foreign non-empty refused', () => {
  assert.equal(validateEnvDir('', 'missing'), '')
  assert.equal(validateEnvDir('relative/path', 'missing'), '路径必须是绝对路径')
  const root = path.parse(process.cwd()).root
  assert.equal(validateEnvDir(root, 'missing'), '不能把磁盘根目录当作环境目录')
  const abs = path.join(root, 'knote-custom-env')
  assert.equal(validateEnvDir(abs, 'missing'), '')
  assert.equal(validateEnvDir(abs, 'empty'), '')
  assert.equal(validateEnvDir(abs, 'ours'), '')
  assert.match(validateEnvDir(abs, 'foreign'), /非空/)
})

test('pythonPath validation: default ok, must be absolute and python-like', () => {
  assert.equal(validatePythonPath(''), '')
  assert.match(validatePythonPath('python.exe'), /绝对路径/)
  const win = 'C:\\Python312\\python.exe'
  const posix = '/usr/bin/python3'
  const good = process.platform === 'win32' ? win : posix
  assert.equal(validatePythonPath(good), '')
  const bad = process.platform === 'win32' ? 'C:\\tools\\node.exe' : '/usr/bin/node'
  assert.match(validatePythonPath(bad), /python/)
})

test('classifyEnvDir distinguishes missing/empty/ours/foreign', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-pdfcfg-'))
  assert.equal(classifyEnvDir(path.join(dir, 'missing')), 'missing')
  const empty = path.join(dir, 'empty')
  fs.mkdirSync(empty)
  assert.equal(classifyEnvDir(empty), 'empty')
  const ours = path.join(dir, 'ours')
  fs.mkdirSync(path.join(ours, 'Scripts'), { recursive: true })
  assert.equal(classifyEnvDir(ours), 'ours')
  const foreign = path.join(dir, 'foreign')
  fs.mkdirSync(foreign)
  fs.writeFileSync(path.join(foreign, 'notes.txt'), 'x')
  assert.equal(classifyEnvDir(foreign), 'foreign')
  fs.rmSync(dir, { recursive: true, force: true })
})
