import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { selectTabsToOffload } from '../src/lib/tabResidencyPolicy.js'

const [main, preload, app] = await Promise.all([
  readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
])

const between = (source, start, end) => {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `missing ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.notEqual(to, -1, `missing ${end}`)
  return source.slice(from, to)
}

test('signed tab-buffer IPC is exposed without renderer filesystem paths', () => {
  for (const operation of ['put', 'get', 'drop', 'clear-session']) {
    assert.match(main, new RegExp(`knote:tab-buffer-${operation}`))
  }
  for (const method of ['tabBufferPut', 'tabBufferGet', 'tabBufferDrop', 'tabBufferClearSession']) {
    assert.match(preload, new RegExp(`${method}:`))
  }
  const bridge = between(preload, 'tabBufferPut:', 'trash:')
  assert.doesNotMatch(bridge, /\bpath\b/)
})

test('high-frequency file IPC authorizes before yielding and avoids sync disk calls', () => {
  const handlers = [
    ['knote:fs-list', 'knote:fs-read'],
    ['knote:fs-read', 'knote:fs-exists'],
    ['knote:fs-exists', 'knote:fs-stat'],
    ['knote:read-image-file', 'knote:read-file-bytes'],
    ['knote:read-file-bytes', 'knote:fs-write']
  ]
  for (const [name, next] of handlers) {
    const body = between(main, `ipcMain.handle('${name}'`, `ipcMain.handle('${next}'`)
    assert.doesNotMatch(body, /readFileSync|readdirSync|existsSync|statSync/)
    const authorization = body.search(/existing(Read|Image)(?:OrWritable)?Path|creatableReadPath/)
    const firstAsyncIo = body.search(/await |return fs\.promises/)
    assert.ok(authorization >= 0 && firstAsyncIo > authorization, `${name} must authorize before async I/O`)
  }
})

test('cold-tab eviction clears memory only after a verified store put and race guard', () => {
  const offload = between(app, 'const offloadTab = async', 'const hydrateTab = async')
  const put = offload.indexOf('tabBufferPut(')
  const verifiedRef = offload.indexOf("ref.kind !== 'knote-tab-buffer'")
  const raceGuard = offload.indexOf('const unchanged =')
  const clear = offload.indexOf('tb.content = null')
  assert.ok(put >= 0 && verifiedRef > put && raceGuard > verifiedRef && clear > raceGuard)
  assert.doesNotMatch(offload, /tabBufferGet\(ref\)/, 'renderer must not transfer the just-written huge string back a second time')
  assert.match(offload, /tb\.id !== activeTabId\.value/)
  assert.match(offload, /tb\.bufferGeneration === generation/)
  assert.match(offload, /if \(!unchanged\)[\s\S]*dropTabBufferRef\(ref\)/)
})

test('renderer keeps cold buffers until main completes every quit barrier', () => {
  const flush = between(app, 'const flushRendererStateForQuit = (payload = {}) =>', 'onMounted(() =>')
  const unmount = between(app, 'onBeforeUnmount(() =>', '</script>')
  assert.doesNotMatch(flush, /tabBufferClearSession\(/)
  assert.doesNotMatch(unmount, /tabBufferClearSession\(/)
  assert.match(flush, /tabBufferSessionId: ok \? TAB_BUFFER_SESSION_ID : ''/)
  assert.match(flush, /typeof markdown !== 'string'/)
  assert.doesNotMatch(flush, /flushed === false\) ok = false/)
  assert.match(flush, /const revision = documentEditRevision\(key\)/)
  assert.match(flush, /documentEditRevision\(key\) === revision/)
  assert.doesNotMatch(flush, /rendererQuitWorkChain = Promise\.resolve\(\)/)
  const diagnostics = main.indexOf('await crashDiagnostics.flush()')
  const cleanup = main.indexOf('void tabBufferStore.clearSession(rendererResult.tabBufferSessionId)', diagnostics)
  assert.ok(cleanup > diagnostics)
  assert.match(preload, /onQuitCancelled:/)
  assert.match(app, /resetRendererQuitAfterCancellation/)
})

test('dirty or unverifiable cold tabs cannot be offloaded and discarded', () => {
  const eligibility = between(app, 'const tabCanOffload =', '// Write a background snapshot')
  const close = between(app, 'const closeTab = async', '// Ctrl+Tab')
  assert.match(eligibility, /documentIsAheadOfDisk\(snapshotDocKeyForTab\(tb\)\)/)
  assert.match(close, /if \(!tb\.resident && !await hydrateTab\(tb\)\)/)
  assert.match(close, /takeSnapshot\('close-recovery'/)
  assert.match(close, /Could not safely save or recover this tab/)
  assert.match(close, /documentEditRevision\(closeIntentKey\) !== closeIntentRevision/)
  assert.match(close, /currentCloseText !== closeIntentText/)
})

test('renderer subscribes to quit barriers before announcing readiness', () => {
  const mounted = between(app, 'onMounted(() =>', 'onBeforeUnmount(() =>')
  const prepare = mounted.indexOf('onPrepareQuit')
  const cancelled = mounted.indexOf('onQuitCancelled')
  const ready = mounted.indexOf('knoteDesktop?.ready?.()')
  assert.ok(prepare >= 0 && cancelled > prepare && ready > cancelled)
})

test('switch hydrates before changing active document', () => {
  const switcher = between(app, 'const switchTab = async', '// A pristine tab')
  assert.ok(switcher.indexOf('await hydrateTab(next)') < switcher.indexOf('activeTabId.value = id'))
  assert.match(switcher, /generation !== tabSwitchGeneration/)
  assert.match(app, /const TAB_BUFFER_THRESHOLD = 300_000/)
  assert.match(app, /const TAB_BUFFER_HUGE_THRESHOLD = 1_500_000/)
  assert.match(app, /const MAX_HOT_BACKGROUND_TABS = 1/)
  assert.match(app, /requestIdleCallback\(run, \{ timeout: 1_500 \}\)/)
  assert.doesNotMatch(between(app, 'const scheduleTabResidencySweep', '// Active tab renders'), /queueMicrotask/)
})

test('one medium A/B working set stays hot while excess and huge background tabs offload', () => {
  const large = (id, lastAccessAt) => ({
    id,
    resident: true,
    content: 'x'.repeat(400_000),
    exportedMd: '',
    lastAccessAt
  })
  const active = large('active', 100)
  const b = large('b', 90)
  const c = large('c', 80)
  assert.deepEqual(selectTabsToOffload([active, b], active.id).map((tab) => tab.id), [])
  assert.deepEqual(selectTabsToOffload([active, b, c], active.id).map((tab) => tab.id), ['c'])

  const d = large('d', 70)
  assert.deepEqual(selectTabsToOffload([active, b, c, d], active.id).map((tab) => tab.id), ['c', 'd'])
  const e = large('e', 60)
  assert.deepEqual(selectTabsToOffload([active, b, c, d, e], active.id).map((tab) => tab.id), ['c', 'd', 'e'])

  const small = { id: 'small', resident: true, content: 'tiny', exportedMd: '', lastAccessAt: 200 }
  assert.deepEqual(selectTabsToOffload([active, small, b, c, d], active.id).map((tab) => tab.id), ['c', 'd'])

  const huge = { ...large('huge', 95), content: 'x'.repeat(1_500_000) }
  assert.deepEqual(selectTabsToOffload([active, huge], active.id).map((tab) => tab.id), ['huge'])
})

test('undo-bearing tabs are protected and the capture flush precedes Markdown copies', () => {
  const offload = between(app, 'const offloadTab = async', 'const hydrateTab = async')
  const capture = between(app, 'const captureActiveTab = () =>', 'const restoreTab = (tb) =>')
  assert.match(offload, /if \(!tabCanOffload\(tb\)\) return false/)
  assert.ok(capture.indexOf('snapshotState()') < capture.indexOf('const sourceContent = content.value'))
  assert.ok(capture.indexOf('const sourceContent = content.value') < capture.indexOf('exportableMarkdown(sourceContent)'))
  assert.match(app, /editorStateHasUndoHistory/)
  assert.match(app, /largeDocumentPlainMode\.value[\s\S]*pushUndo\(\)/)
})

test('structurally expensive documents mount one bounded TipTap chunk', () => {
  assert.match(app, /import \{ shouldUsePagedSource \}/)
  assert.match(app, /const plain = shouldUsePagedSource\(nextContent\)/)
  assert.match(app, /largeDocumentPlainMode\.value = true/)
  assert.match(app, /data-testid="large-document-rich-mode"/)
  assert.match(app, /data-testid="large-document-rich-chunk"/)
  assert.match(app, /:content-key="largeSourceEditorVersion"/)
  assert.doesNotMatch(app, /data-testid="large-document-source"/)
  assert.doesNotMatch(app, /data-testid="load-large-rich-editor"/)
  assert.match(app, /<RichEditor[\s\S]*v-else/)
  assert.match(app, /v-if="viewMode === 'split' && !largeDocumentPlainMode && !pdfView"/)
  assert.match(app, /v-if="viewMode === 'split' && !largeDocumentPlainMode"[\s\S]*data-testid="markdown-full-preview"/)
  assert.match(app, /v-if="largeDocumentPlainMode && !pdfView"[\s\S]*data-testid="large-document-rich-mode"/)
  assert.match(app, /watch\(\(\) => viewMode\.value === 'split' && !largeDocumentPlainMode\.value \? renderedHtml\.value : null/)
})
