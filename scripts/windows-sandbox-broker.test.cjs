'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')

if (process.platform !== 'win32') {
  console.log('SKIP: Windows AppContainer broker test requires win32.')
  process.exit(0)
}

const repoRoot = path.resolve(__dirname, '..')
const script = path.join(repoRoot, 'native', 'knote-sandbox-broker', 'test.ps1')
const powershellEnv = { ...process.env }
// GitHub's pwsh runner exports PowerShell 7 module paths. Windows PowerShell
// 5.1 must rebuild its own defaults or it can load incompatible inbox modules.
for (const key of Object.keys(powershellEnv)) {
  if (key.toLowerCase() === 'psmodulepath') delete powershellEnv[key]
}
const result = spawnSync('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', script
], {
  cwd: repoRoot,
  env: powershellEnv,
  stdio: 'inherit',
  windowsHide: true
})

if (result.error) throw result.error
process.exit(Number.isInteger(result.status) ? result.status : 1)
