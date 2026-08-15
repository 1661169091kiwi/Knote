'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { normalizeAgentCommandIntent } = require('./agent-command-runner.cjs')

const fixture = (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-agent-command-'))
  fs.writeFileSync(path.join(cwd, 'safe.js'), 'console.log("safe")\n')
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  return cwd
}

const intent = (cwd, args, extra = {}) => normalizeAgentCommandIntent({
  id: 'command-test',
  program: 'node',
  args,
  cwd,
  timeoutMs: 5000,
  ...extra
})

test('logical command validation permits only non-executing Node diagnostics', (t) => {
  const cwd = fixture(t)
  assert.throws(() => intent(cwd, ['-e', 'process.exit()']), (error) => error.code === 'COMMAND_ARGS_BLOCKED')
  assert.throws(() => intent(cwd, ['--test', 'safe.js']), (error) => error.code === 'COMMAND_ARGS_BLOCKED')
  assert.throws(() => intent(cwd, ['--check', '../outside.js']), (error) => ['COMMAND_PATH_NOT_FOUND', 'COMMAND_PATH_BLOCKED'].includes(error.code))
  assert.throws(() => intent(cwd, ['--check', 'safe.js'], { executable: process.execPath }), (error) => error.code === 'INVALID_COMMAND_REQUEST')
  assert.deepEqual(intent(cwd, ['--check', 'safe.js']).args, ['--check', '--', 'safe.js'])
  assert.deepEqual(intent(cwd, ['--version']).args, ['--version'])
})

test('the command intent module has no host process or PATH resolution capability', () => {
  const source = fs.readFileSync(path.join(__dirname, 'agent-command-runner.cjs'), 'utf8')
  assert.doesNotMatch(source, /child_process|node:child_process|\bspawn(?:Sync)?\b|execFile|process\.env|\bPATH\b/)
  assert.doesNotMatch(source, /shell\s*:/)
})

test('desktop command IPC and model exposure remain fail-closed until native attestation exists', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8')
  const store = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'agentStore.js'), 'utf8')
  const handlerStart = main.indexOf("ipcMain.handle('knote:agent-command-run'")
  const handlerEnd = main.indexOf("ipcMain.handle('knote:agent-command-cancel'", handlerStart)
  const handler = main.slice(handlerStart, handlerEnd)
  assert.match(handler, /'SANDBOX_UNAVAILABLE'/)
  assert.doesNotMatch(main, /require\('\.\/agent-command-runner\.cjs'\)/)
  assert.doesNotMatch(handler, /spawn|startRestrictedCommand|approveAgentCommand|process\.env/)
  assert.match(preload, /agentCommandEnabled: false/)
  assert.match(store, /window\.knoteDesktop\?\.agentCommandEnabled === true/)
})
