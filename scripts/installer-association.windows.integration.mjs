// Real Windows repeat-install probe. This deliberately never writes the
// protected UserChoice key: the user must have selected Knote through Windows
// Settings/Open With beforehand. Run from an elevated terminal so the NSIS
// child does not hand work to a detached UAC instance:
//
//   node scripts/installer-association.windows.integration.mjs release/Knote-Setup-x.y.z.exe
//   node scripts/installer-association.windows.integration.mjs release/Knote-Setup-x.y.z.exe --require-protected-user-choice
//
// The probe snapshots ProgId+Hash, polls the two stable class commands while
// the installer replaces the application, then proves the protected values,
// legacy HKCR extension defaults and command resolution survived byte-for-byte.
// The optional flag is the release gate after the user explicitly chooses
// Knote in Windows Settings; without it the JSON result says honestly whether
// only the legacy extension-default path was exercised.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.platform !== 'win32') {
  console.log(JSON.stringify({ skipped: true, reason: 'Windows-only integration probe' }))
  process.exit(0)
}

const installerArg = process.argv[2]
assert.ok(installerArg, 'installer path argument is required')
const installer = resolve(installerArg)
assert.ok(existsSync(installer), `installer not found: ${installer}`)
const requireProtectedUserChoice = process.argv.includes('--require-protected-user-choice')

const reg = (root, key, value = '') => {
  const args = ['query', `${root}\\${key}`]
  if (value) args.push('/v', value)
  else args.push('/ve')
  const run = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true })
  if (run.status !== 0) return null
  const line = String(run.stdout || '').split(/\r?\n/).find((item) => /REG_(?:SZ|EXPAND_SZ|NONE)/.test(item))
  if (!line) return null
  const match = line.match(/REG_(?:SZ|EXPAND_SZ|NONE)\s+(.*)$/)
  return match ? match[1].trim() : null
}

const userChoice = (extension) => {
  const key = `Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}\\UserChoice`
  return {
    progId: reg('HKCU', key, 'ProgId'),
    hash: reg('HKCU', key, 'Hash')
  }
}

const isKnoteProgId = (value) => {
  const id = String(value || '').toLowerCase()
  return id === 'knote.markdown' || id === 'applications\\knote.exe'
}

const commands = () => ({
  markdown: reg('HKCR', 'Knote.Markdown\\shell\\open\\command'),
  application: reg('HKCR', 'Applications\\Knote.exe\\shell\\open\\command')
})

const before = {
  md: userChoice('.md'),
  markdown: userChoice('.markdown'),
  extensionDefaults: {
    md: reg('HKCR', '.md'),
    markdown: reg('HKCR', '.markdown')
  },
  commands: commands()
}
assert.ok(before.commands.markdown, 'Knote.Markdown must resolve before repeat install')
assert.ok(before.commands.application, 'Applications\\Knote.exe must resolve before repeat install')
const protectedKnoteChoices = ['md', 'markdown'].filter((extension) => (
  isKnoteProgId(before[extension].progId) && Boolean(before[extension].hash)
))
const legacyKnoteDefaults = ['md', 'markdown'].filter((extension) => (
  !before[extension].progId && !before[extension].hash &&
  String(before.extensionDefaults[extension] || '').toLowerCase() === 'knote.markdown'
))
assert.ok(
  protectedKnoteChoices.length > 0 || legacyKnoteDefaults.length > 0,
  'precondition failed: neither UserChoice nor HKCR extension defaults currently select Knote'
)
if (requireProtectedUserChoice) {
  assert.ok(
    protectedKnoteChoices.includes('md'),
    'precondition failed: Windows .md UserChoice must explicitly select Knote and include Hash'
  )
}

const samples = []
let installerExit = null
const child = spawn(installer, ['/S', '/allusers'], {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk })
child.stderr.on('data', (chunk) => { stderr += chunk })

const startedAt = Date.now()
const poll = setInterval(() => {
  const current = commands()
  samples.push({
    elapsedMs: Date.now() - startedAt,
    markdown: Boolean(current.markdown),
    application: Boolean(current.application)
  })
}, 100)

const timeout = setTimeout(() => {
  try { child.kill() } catch { /* best effort */ }
}, 5 * 60_000)

await new Promise((resolveExit, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    installerExit = { code, signal }
    resolveExit()
  })
})
clearTimeout(timeout)
clearInterval(poll)

assert.deepEqual(installerExit, { code: 0, signal: null }, `installer failed: ${stderr || stdout}`)
const after = {
  md: userChoice('.md'),
  markdown: userChoice('.markdown'),
  extensionDefaults: {
    md: reg('HKCR', '.md'),
    markdown: reg('HKCR', '.markdown')
  },
  commands: commands()
}

for (const extension of ['md', 'markdown']) {
  const choice = before[extension]
  if (!choice.progId && !choice.hash) continue
  assert.deepEqual(after[extension], choice, `${extension} UserChoice changed during repeat install`)
}
for (const extension of ['md', 'markdown']) {
  assert.equal(
    after.extensionDefaults[extension],
    before.extensionDefaults[extension],
    `${extension} HKCR default changed during repeat install`
  )
}
assert.ok(samples.length > 0, 'installer completed before the continuity poll sampled it')
assert.ok(samples.every((item) => item.markdown), 'Knote.Markdown became unresolved during update')
assert.ok(samples.every((item) => item.application), 'Applications\\Knote.exe became unresolved during update')
assert.ok(after.commands.markdown, 'Knote.Markdown is unresolved after repeat install')
assert.ok(after.commands.application, 'Applications\\Knote.exe is unresolved after repeat install')
assert.equal(after.commands.markdown, before.commands.markdown, 'Knote.Markdown command target changed during original-location update')
assert.equal(after.commands.application, before.commands.application, 'Applications\\Knote.exe command target changed during original-location update')

console.log(JSON.stringify({
  ok: true,
  elapsedMs: Date.now() - startedAt,
  samples: samples.length,
  protectedUserChoiceVerified: protectedKnoteChoices.length > 0,
  protectedKnoteChoices,
  legacyExtensionDefaultsVerified: legacyKnoteDefaults,
  requireProtectedUserChoice,
  before,
  after
}, null, 2))
