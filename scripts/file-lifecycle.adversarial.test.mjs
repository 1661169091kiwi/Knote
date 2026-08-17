import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createAppDialogQueue } from '../src/lib/appDialogQueue.js'

const app = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
const between = (startText, endText) => {
  const start = app.indexOf(startText)
  const end = app.indexOf(endText, start)
  assert.ok(start >= 0 && end > start, `missing source range: ${startText}`)
  return app.slice(start, end)
}

test('filesystem handles retain raw identity across Vue state guards', () => {
  assert.match(app, /const currentFileHandle = shallowRef\(null\)/)
  assert.match(app, /const folderHandle = shallowRef\(null\)/)
  assert.match(app, /currentFileHandle\.value !== reconcileHandle/)
})

test('browser picker installs the new handle and navigation guard before new Markdown', () => {
  const install = between('const installOpenedMarkdown = async', '// Load a .md FILE HANDLE')
  const begin = install.indexOf('const navigationOwner = beginNavigationInstall()')
  const handle = install.indexOf('currentFileHandle.value = writable ? handle : null')
  const content = install.indexOf('content.value = nextContent')
  const finish = install.indexOf('finishNavigationInstall(navigationOwner)')
  assert.ok(begin >= 0 && handle > begin && content > handle && finish > content)
  assert.match(install, /const flushed = await flushAutoSave\(\)[\s\S]*if \(flushed === false\) return false/)
})

test('folder navigation freezes the old save and installs one coherent handle/content pair', () => {
  const openTree = between('const openTreeFile = async', '// ========== PDF Export')
  const flush = openTree.indexOf('const flushed = await flushAutoSave()')
  const read = openTree.indexOf('const file = await node.handle.getFile()')
  assert.ok(flush >= 0 && read > flush)
  assert.match(openTree, /if \(flushed === false \|\| !stillCurrent\(\)\) return false/)
  assert.match(openTree, /documentEditRevision\(targetIdentity\) === targetEditRevision/)
  assert.match(openTree, /content\.value === targetContent/)
  const lock = openTree.indexOf('withAsyncKeyLock(mutationKey')
  const begin = openTree.indexOf('const navigationOwner = beginNavigationInstall()')
  const handle = openTree.indexOf('currentFileHandle.value = writable ? node.handle : null')
  const content = openTree.indexOf('content.value = nextContent')
  assert.ok(lock >= 0 && begin > lock && handle > begin && content > handle)
  assert.match(openTree, /await resolveFileMutationKey\(targetFolderHandle, targetWorkspaceId, node\.path, node\.handle\)/)

  const watcher = between('watch(() => content.value', '// Moving the caret to another row')
  assert.match(watcher, /if \(navigationInstallOwner\) return/)
  assert.match(watcher, /handle:\s*currentFileHandle\.value/)
  assert.match(watcher, /markdown:\s*exportableMarkdown\(content\.value\)/)
  assert.match(watcher, /saveToFileHandle\(job\.handle, job\.payload\)/)
})

test('desktop progressive reads remain bound to the tab that initiated them', () => {
  const listener = between('window.knoteDesktop.onOpenFile(async', '// folders dropped onto the Knote icon')
  assert.match(listener, /const targetTab = openInNewTab\(\) \|\| activeTab\(\)/)
  assert.match(listener, /const targetToken = Symbol\('desktop-open'\)/)
  assert.match(listener, /targetTab\.openToken = targetToken/)
  assert.match(listener, /const targetEditRevision = documentEditRevision\(targetDocumentKey\)/)
  assert.match(listener, /const targetUntouched = \(\) =>/)
  assert.match(listener, /documentEditRevision\(targetDocumentKey\) === targetEditRevision/)
  assert.match(listener, /tabs\.value\.includes\(targetTab\)/)
  assert.match(listener, /if \(activeTab\(\) === targetTab\)/)
  assert.match(listener, /targetTab\.content = nextContent/)
})

test('whole-document mutations rebuild bounded rich-editor state', () => {
  assert.match(app, /const replaceWholeDocumentContent = \(value, options = \{\}\) => \{[\s\S]*stageLargeEditorLoad\(nextContent/)
  const assets = between('const flushImagesToAssets = async', 'const scheduleAssetsFlush')
  assert.match(assets, /largeDocumentPlainMode\.value && largeSourceDraftDirty/)
  assert.match(assets, /replaceWholeDocumentContent\(out\)/)
  const find = between('const replaceOne = () =>', 'const openFind =')
  assert.match(find, /commitLargeSourceDraft\('replace-one'\)[\s\S]*replaceWholeDocumentContent/)
  assert.match(find, /commitLargeSourceDraft\('replace-all'\)[\s\S]*replaceWholeDocumentContent/)
})

test('Chinese and English samples share the guarded file-detaching replacement path', () => {
  assert.match(app, /const sampleZh = `# Knote Markdown 编辑器/)
  assert.match(app, /const sampleEn = `# Knote Markdown Editor/)
  assert.match(app, /const content = ref\(sampleZh\)/)
  const loader = between('const loadSample = async', '// ========== Undo/Redo System')
  assert.match(loader, /sampleLanguage === 'en' \? sampleEn : sampleZh/)
  assert.match(loader, /replaceWholeDocumentContent\(nextSample\)/)
  assert.match(app, /data-testid="load-sample-zh"[\s\S]{0,260}@click="loadSample\('zh'\)/)
  assert.match(app, /data-testid="load-sample-en"[\s\S]{0,260}@click="loadSample\('en'\)/)
})

test('first Save As constructs a desktop handle from top-level scope', () => {
  assert.match(app, /const mkDesktopHandle = \(filePath, name\) => mkDesktopFileHandle\(filePath, name, parentPathOf\(filePath\)\)/)
  const save = between('const saveFile = async', '// Auto-save watcher')
  assert.match(save, /const handle = mkDesktopHandle\(picked\.path, picked\.name/)
  assert.match(save, /await saveToFileHandle\(handle, payload\)/)
})

test('tree rename keeps binary bytes and never promotes a read-only preview to a document handle', () => {
  const rename = between('const renameTreeFile = async', '// ---- Move file/folder')
  assert.match(rename, /await w\.write\(await file\.arrayBuffer\(\)\)/)
  assert.doesNotMatch(rename, /await file\.text\(\)/)
  assert.match(rename, /if \(record\.editable\) \{[\s\S]*tb\.fileHandle = newHandle/)
  assert.match(rename, /if \(record\.editable\) \{[\s\S]*currentFileHandle\.value = newHandle/)
  assert.match(rename, /if \(!record\.editable\) continue/)
  assert.match(rename, /browserHistoryPair[\s\S]*await copySnapshots\(browserHistoryPair\[0\], browserHistoryPair\[1\]\)/)
  assert.match(rename, /pdfView\.value = \{ \.\.\.pdfView\.value, name, path: remappedTreePath \}/)
  const barrier = between('const treeMutationSaveBarrier = async', 'const deleteTreeFile = async')
  assert.match(barrier, /node\.kind === 'dir' \|\| node\.ftype === 'md'/)
  assert.match(barrier, /if \(editable && text != null && await takeSnapshot/)
})

test('UI, Agent, and desktop handle renames reject path components', () => {
  const rename = between('const renameTreeFile = async', '// ---- Move file/folder')
  const agentRename = between('agentBridge.renameFile = async', 'agentBridge.moveFile = async')
  assert.match(rename, /isSafeWorkspaceLeafName\(name\)/)
  assert.match(agentRename, /isSafeWorkspaceLeafName\(name\)/)
  assert.match(agentRename, /browserTreeSnapshotKey[\s\S]*copySnapshots/)
  const desktop = fs.readFileSync(new URL('../src/lib/desktopFs.js', import.meta.url), 'utf8')
  assert.match(desktop, /name === '\.\.'[\s\S]*invalid desktop child name/)
})

test('PDF overlay rename preserves and restores the underlying Markdown identity', () => {
  const pdf = between('const pdfView = ref(null)', 'const pdfZoom =')
  assert.match(pdf, /returnPath/)
  assert.match(pdf, /activeTreePath\.value = closing\.returnPath/)
  assert.match(pdf, /pdfView\.value = null\s+if \(closing\) \{\s+setViewMode\('single'\)/)
  assert.match(pdf, /pendingPdfScrollRestore = pending[\s\S]*nextTick\(\(\) => \{[\s\S]*root\.scrollTop = pending\.scrollTop/)
  assert.match(pdf, /if \(!r \|\| !r\.bytes\)[\s\S]*?return abandonIfOwned\(\)[\s\S]*?setViewMode\('single'\)\s+pdfView\.value =/)
  assert.match(app, /const setViewMode = \(mode\) => \{\s+if \(mode === 'split' && pdfView\.value\) return/)
  assert.match(app, /data-testid="view-split"[\s\S]{0,300}:disabled="!!pdfView"/)
  const rename = between('const renameTreeFile = async', '// ---- Move file/folder')
  assert.doesNotMatch(rename, /if \(!record\.editable\) tb\.isLocal = false/)
})

test('renderer-side replacement fails closed when the existing file cannot be protected', () => {
  const save = between('const saveToFileHandle = async', '// ---- Version snapshots')
  const guardStart = save.indexOf('if (!protectedByMain)')
  const read = save.indexOf('const previousFile = await handle.getFile()', guardStart)
  const oldSnapshot = save.indexOf("takeSnapshot('before-save'", read)
  const newSnapshot = save.indexOf("takeSnapshot('pending-save'", oldSnapshot)
  const writer = save.indexOf('await handle.createWritable', newSnapshot)
  assert.ok(guardStart >= 0 && read > guardStart && oldSnapshot > read && newSnapshot > oldSnapshot && writer > newSnapshot)
  assert.doesNotMatch(save.slice(read, writer), /catch\s*\(/)
  assert.match(save, /uncertainSaveHandles\.add\(handle\)[\s\S]*blockedDocumentSaveIdentities\.add/)
})

test('Android storage replacement drains saves and Agent leases before revoking grants', () => {
  const prepare = between('const prepareAndroidStorageReplacement = async', 'const parentPathOf =')
  assert.match(prepare, /stopAgentRunsForDocument\(agentDocumentKey\(\)\)/)
  assert.match(prepare, /await waitForAgentDocumentLeases\(targetTab\)/)
  assert.match(prepare, /await waitForDocumentSaves\(saveIdentity\)/)
  assert.doesNotMatch(prepare, /folderHandle\.value && !currentFileName\.value/)

  const remember = between('const rememberAndroidStorage = async', 'const clearRememberedAndroidStorage =')
  const persist = remember.indexOf('localStorage.setItem')
  const drain = remember.indexOf('await waitForAllDocumentSaves()')
  const release = remember.indexOf('await releaseSafGrant')
  assert.ok(persist >= 0 && drain > persist && release > drain)
  assert.match(remember, /androidGrantIsReferenced/)
})

test('Android lifecycle checkpoints drafts and stale SAF entries stop auto-save', () => {
  const lifecycle = between('const protectAndroidBackgroundState =', 'onMounted(() => {')
  assert.match(lifecycle, /takeSnapshot\('background-recovery'/)
  assert.match(lifecycle, /await flushAutoSave\(\)/)
  assert.match(lifecycle, /await waitForDocumentSaves\(key\)/)
  assert.match(app, /CapacitorApp\.addListener\('appStateChange'/)
  assert.match(app, /CapacitorApp\.addListener\('backButton'[\s\S]*closeMobilePanels\(\)/)

  const watcher = between('let diskWatchTimer = setInterval', '// ========== Folder tree')
  assert.match(watcher, /error\?\.code === 'ENTRY_CHANGED'/)
  assert.match(watcher, /isLocalFile\.value = false/)
  assert.match(watcher, /await refreshFolder\(\)/)
  const dedupe = between('const findOpenTreeDocumentTab =', 'const openTreeFile = async')
  assert.match(dedupe, /!staleSafFileHandles\.has\(openHandle\)/)
})

test('Android picker intents are monotonic and first-save edits receive a follow-up save', () => {
  const openFile = between('const openLocalFile = async', '// A tiny per-document revision clock')
  assert.ok(openFile.indexOf('beginAndroidStorageIntent()') < openFile.indexOf('await prepareAndroidStorageReplacement()'))
  assert.match(openFile, /openFileFromHandle\(handle, \{ stillCurrent: androidIntentIsCurrent \}\)/)

  const openFolder = between('const openFolder = async', '// The directory new files/folders')
  assert.ok(openFolder.indexOf('beginAndroidStorageIntent()') < openFolder.indexOf('await prepareAndroidStorageReplacement()'))
  assert.match(openFolder, /adoptFolderHandle\(handle, handle\.name, '', androidIntentIsCurrent\)/)

  const followUp = between('const saveEditsMadeDuringFirstSave = async', 'const saveFile = async')
  assert.match(followUp, /currentFileHandle\.value !== handle/)
  assert.match(followUp, /markDocumentEdited\(key\)/)
  assert.match(followUp, /saveToFileHandle\(handle/)
  const firstSave = between('const saveFile = async', '// Auto-save watcher')
  assert.ok((firstSave.match(/saveEditsMadeDuringFirstSave\(handle, payload\.snapshotContent\)/g) || []).length >= 3)
})

test('two concurrent confirmations stay FIFO and both promises settle', async () => {
  const activations = []
  const queue = createAppDialogQueue({ onActivate: (request) => activations.push(request?.title || null) })
  const first = queue.request({ mode: 'confirm', title: 'first', owner: 'delete:a' })
  const second = queue.request({ mode: 'confirm', title: 'second', owner: 'close:b' })

  assert.equal(queue.size(), 2)
  assert.equal(queue.current().title, 'first')
  assert.deepEqual(activations, ['first'])
  assert.equal(queue.settle(queue.current().id, true), true)
  assert.equal(await first, true)
  assert.equal(queue.current().title, 'second')
  assert.deepEqual(activations, ['first', 'second'])
  assert.equal(queue.settle(queue.current().id, false), true)
  assert.equal(await second, false)
  assert.equal(queue.size(), 0)
  assert.deepEqual(activations, ['first', 'second', null])
})

test('dialog cancel-all releases active and queued work, including renderer quit', async () => {
  const queue = createAppDialogQueue()
  const first = queue.request({ mode: 'confirm', title: 'first' })
  const second = queue.request({ mode: 'prompt', title: 'second' })
  assert.equal(queue.cancelAll(), 2)
  assert.deepEqual(await Promise.all([first, second]), [null, null])
  assert.equal(queue.size(), 0)

  const quit = between('const flushRendererStateForQuit =', 'const resetRendererQuitAfterCancellation =')
  assert.ok(quit.indexOf('cancelAllDialogs()') < quit.indexOf('await flushAgentForRendererShutdown()'))
  const unmount = app.slice(app.indexOf('onBeforeUnmount(() => {'))
  assert.match(unmount, /appDialogQueue\.dispose\(\)/)
})
