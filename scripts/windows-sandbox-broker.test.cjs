'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')

if (process.platform !== 'win32') {
  console.log('SKIP: Windows AppContainer broker test requires win32.')
  process.exit(0)
}

const repoRoot = path.resolve(__dirname, '..')
const script = path.join(repoRoot, 'native', 'knote-sandbox-broker', 'test.ps1')
const result = spawnSync('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', script
], {
  cwd: repoRoot,
  stdio: 'inherit',
  windowsHide: true
})

if (result.error) throw result.error
process.exit(Number.isInteger(result.status) ? result.status : 1)
