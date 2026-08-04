const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
const cleanupSource = fs.readFileSync(path.join(__dirname, 'quit-cleanup.cjs'), 'utf8')

test('the main process has one authoritative before-quit path', () => {
  const registrations = cleanupSource.match(/app\.on\(['"]before-quit['"]/g) || []
  assert.equal(registrations.length, 1)
  assert.match(source, /createQuitCleanupController\(\{[\s\S]*?quitting\s*=\s*true/)
  assert.match(source, /rendererQuitHandshake\.request\(\)[\s\S]*waitForFsMutations\(\)[\s\S]*crashDiagnostics\.flush\(\)/)
  assert.match(source, /RENDERER_QUIT_BARRIER_FAILED/)
})

test('window-all-closed never re-enters app.quit during an active quit', () => {
  assert.doesNotMatch(source, /app\.on\(['"]window-all-closed['"][\s\S]{0,240}?app\.quit\(\)/)
})

test('Windows session shutdown bypasses tray-hide interception', () => {
  assert.match(source, /win\.on\(['"]query-session-end['"],\s*\(event\)\s*=>\s*\{[\s\S]*?quitting\s*=\s*true[\s\S]*?event\.preventDefault\(\)[\s\S]*?app\.quit\(\)/)
  assert.match(source, /win\.on\(['"]session-end['"],\s*\(\)\s*=>\s*\{\s*quitting\s*=\s*true\s*\}\)/)
  assert.match(source, /win\.on\(['"]close['"],\s*\(e\)\s*=>\s*\{\s*if\s*\(!quitting\s*&&\s*!isE2E\)/)
})

test('installer shutdown is accepted only for this exact executable instance', () => {
  assert.match(source, /const installerShutdownRequestFromArgv = \(argv\) =>/)
  assert.match(source, /pathKey\(request\.target\) !== pathKey\(process\.execPath\)/)
  assert.match(source, /pathKey\(path\.dirname\(ackCandidate\)\) === pathKey\(os\.tmpdir\(\)\)/)
  assert.match(source, /if \(handleInstallerShutdownRequest\(installerShutdownRequestFromArgv\(argv\)\)\) return/)
  assert.match(source, /handleInstallerShutdownRequest\(initialInstallerShutdownRequest\)/)
  assert.match(source, /writeFile\(ackPath, 'ready', \{ flag: 'wx' \}\)/)
})

test('tab buffers are pruned at startup and cleared only after quit durability barriers', () => {
  assert.match(source, /await tabBuffers\(\)\.initialize\(\)[\s\S]*createWindow\(\)/)
  const fsBarrier = source.indexOf('await waitForFsMutations()')
  const diagnosticsBarrier = source.indexOf('await crashDiagnostics.flush()', fsBarrier)
  const bufferCleanup = source.indexOf('void tabBufferStore.clearSession(rendererResult.tabBufferSessionId)', diagnosticsBarrier)
  assert.ok(fsBarrier >= 0 && diagnosticsBarrier > fsBarrier && bufferCleanup > diagnosticsBarrier)
  assert.match(source, /cleanup: async \(\{ signal \} = \{\}\)[\s\S]*assertCurrentAttempt\(\)/)
  assert.match(source, /webContents\.send\('knote:quit-cancelled'\)/)
  assert.match(source, /getWebContents: \(\) => \(rendererReady && win/)
})
