import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

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
  const begin = openTree.indexOf('const navigationOwner = beginNavigationInstall()')
  const handle = openTree.indexOf('currentFileHandle.value = writable ? node.handle : null')
  const content = openTree.indexOf('content.value = nextContent')
  assert.ok(begin >= 0 && handle > begin && content > handle)

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
  const rename = between('const renameTreeFile = async', '// ---- Move file/folder')
  assert.doesNotMatch(rename, /if \(!record\.editable\) tb\.isLocal = false/)
})
