'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  authorizeCreatableAssetImagePath,
  authorizeCreatableAssetPath,
  authorizeCreatableImagePath,
  authorizeCreatablePath,
  authorizeExistingImagePath,
  authorizeExistingMarkdownPath,
  authorizeExistingPath,
  createBoundaryRoot,
  pathKey
} = require('./workspace-boundary.cjs')

test('security path keys preserve case distinctions', () => {
  assert.notEqual(pathKey(path.join('C:\\', 'Root', 'Notes')), pathKey(path.join('C:\\', 'Root', 'notes')))
})

const fixture = (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-boundary-'))
  const root = path.join(base, 'workspace')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  return { base, root, outside }
}

const junction = (target, link) => {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

test('authorizes normal existing and future descendants, not prefix siblings', (t) => {
  const { base, root } = fixture(t)
  const nested = path.join(root, 'src')
  const file = path.join(nested, 'note.md')
  fs.mkdirSync(nested)
  fs.writeFileSync(file, 'safe')
  const grants = [createBoundaryRoot(root)]

  assert.equal(authorizeExistingPath(file, grants).lexical, path.resolve(file))
  assert.equal(
    authorizeCreatablePath(path.join(root, 'new', 'deep', 'file.ts'), grants).lexical,
    path.resolve(root, 'new', 'deep', 'file.ts')
  )
  assert.throws(
    () => authorizeCreatablePath(path.join(base, 'workspace-evil', 'file.md'), grants),
    (error) => error && error.code === 'outside_workspace'
  )
  assert.throws(
    () => authorizeCreatablePath('relative.md', grants),
    (error) => error && error.code === 'invalid_workspace_path'
  )
})

test('authorizes descendants when the selected workspace is a filesystem root', (t) => {
  const { base } = fixture(t)
  const volumeRoot = path.parse(base).root
  const grants = [createBoundaryRoot(volumeRoot)]
  assert.equal(authorizeExistingPath(base, grants).lexical, path.resolve(base))
})

test('rejects an existing or future target through an outward junction', (t) => {
  const { root, outside } = fixture(t)
  const secret = path.join(outside, 'secret.md')
  fs.writeFileSync(secret, 'outside')
  const link = path.join(root, 'escape')
  try { junction(outside, link) } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) return t.skip('junction creation is unavailable')
    throw error
  }
  const grants = [createBoundaryRoot(root)]

  assert.throws(
    () => authorizeExistingPath(path.join(link, 'secret.md'), grants),
    (error) => error && error.code === 'reparse_point_blocked'
  )
  assert.throws(
    () => authorizeCreatablePath(path.join(link, 'missing', 'new.md'), grants),
    (error) => error && error.code === 'reparse_point_blocked'
  )
})

test('rejects redirecting descendants even when their target remains inside', (t) => {
  const { root } = fixture(t)
  const real = path.join(root, 'real')
  const link = path.join(root, 'alias')
  fs.mkdirSync(real)
  fs.writeFileSync(path.join(real, 'safe.md'), 'safe')
  try { junction(real, link) } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) return t.skip('junction creation is unavailable')
    throw error
  }
  const grants = [createBoundaryRoot(root)]
  assert.throws(
    () => authorizeExistingPath(path.join(link, 'safe.md'), grants),
    (error) => error && error.code === 'reparse_point_blocked'
  )
})

test('single-file image policies allow only real image paths and assets writes', (t) => {
  const { root } = fixture(t)
  const image = path.join(root, 'sibling.png')
  const ordinary = path.join(root, 'sibling.txt')
  fs.writeFileSync(image, 'png')
  fs.writeFileSync(ordinary, 'text')
  const grants = [createBoundaryRoot(root)]

  assert.equal(authorizeExistingImagePath(image, grants).lexical, path.resolve(image))
  assert.throws(
    () => authorizeExistingImagePath(ordinary, grants),
    (error) => error && error.code === 'not_an_image'
  )
  assert.equal(
    authorizeCreatableAssetImagePath(path.join(root, 'assets', 'future.webp'), grants).lexical,
    path.resolve(root, 'assets', 'future.webp')
  )
  fs.mkdirSync(path.join(root, 'assets'))
  const nestedGrants = [...grants, createBoundaryRoot(path.join(root, 'assets'))]
  assert.equal(
    authorizeCreatableAssetImagePath(path.join(root, 'assets', 'nested-grant.png'), nestedGrants).lexical,
    path.resolve(root, 'assets', 'nested-grant.png')
  )
  assert.throws(
    () => authorizeCreatableAssetImagePath(path.join(root, 'future.webp'), grants),
    (error) => error && error.code === 'outside_asset_directory'
  )
  assert.throws(
    () => authorizeCreatableImagePath(path.join(root, 'assets', 'future.txt'), grants),
    (error) => error && error.code === 'not_an_image'
  )
})

test('single-file asset policy allows any extension below assets only', (t) => {
  const { root } = fixture(t)
  const grants = [createBoundaryRoot(root)]

  assert.equal(
    authorizeCreatableAssetPath(path.join(root, 'assets', 'future.pdf'), grants).lexical,
    path.resolve(root, 'assets', 'future.pdf')
  )
  assert.equal(
    authorizeCreatableAssetPath(path.join(root, 'assets', 'archive.zip'), grants).lexical,
    path.resolve(root, 'assets', 'archive.zip')
  )
  assert.throws(
    () => authorizeCreatableAssetPath(path.join(root, 'future.pdf'), grants),
    (error) => error && error.code === 'outside_asset_directory'
  )
  assert.throws(
    () => authorizeCreatableAssetPath(path.join(root, 'notes', 'future.pdf'), grants),
    (error) => error && error.code === 'outside_asset_directory'
  )
})

test('single-file Markdown links stay inside the frozen parent boundary', (t) => {
  const { root, outside } = fixture(t)
  const sibling = path.join(root, 'Sibling.MARKDOWN')
  const nested = path.join(root, 'notes', 'nested.md')
  const ordinary = path.join(root, 'sibling.txt')
  fs.mkdirSync(path.dirname(nested))
  fs.writeFileSync(sibling, '# sibling')
  fs.writeFileSync(nested, '# nested')
  fs.writeFileSync(ordinary, 'text')
  fs.writeFileSync(path.join(outside, 'outside.md'), '# outside')
  const grants = [createBoundaryRoot(root)]

  assert.equal(authorizeExistingMarkdownPath(sibling, grants).lexical, path.resolve(sibling))
  assert.equal(authorizeExistingMarkdownPath(nested, grants).lexical, path.resolve(nested))
  assert.throws(
    () => authorizeExistingMarkdownPath(ordinary, grants),
    (error) => error && error.code === 'not_markdown'
  )
  assert.throws(
    () => authorizeExistingMarkdownPath(path.join(outside, 'outside.md'), grants),
    (error) => error && error.code === 'outside_workspace'
  )
})

test('rejects multi-link files for both reads and writes', (t) => {
  const { root, outside } = fixture(t)
  const outsideFile = path.join(outside, 'shared.png')
  fs.mkdirSync(path.join(root, 'assets'))
  const insideLink = path.join(root, 'assets', 'shared.png')
  fs.writeFileSync(outsideFile, 'outside')
  try {
    fs.linkSync(outsideFile, insideLink)
  } catch (error) {
    if (error && ['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error.code)) {
      return t.skip('hard-link creation is unavailable')
    }
    throw error
  }
  const grants = [createBoundaryRoot(root)]

  assert.throws(
    () => authorizeExistingPath(insideLink, grants),
    (error) => error && error.code === 'hard_link_blocked'
  )
  assert.throws(
    () => authorizeCreatablePath(insideLink, grants),
    (error) => error && error.code === 'hard_link_blocked'
  )
  assert.throws(
    () => authorizeExistingImagePath(insideLink, grants),
    (error) => error && error.code === 'hard_link_blocked'
  )
  assert.throws(
    () => authorizeCreatableAssetImagePath(insideLink, grants),
    (error) => error && error.code === 'hard_link_blocked'
  )
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside')
})

test('permits a selected root that is itself a junction but freezes its target', (t) => {
  const { base, root } = fixture(t)
  const picked = path.join(base, 'picked-workspace')
  fs.writeFileSync(path.join(root, 'note.md'), 'safe')
  try { junction(root, picked) } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) return t.skip('junction creation is unavailable')
    throw error
  }
  const grants = [createBoundaryRoot(picked)]

  assert.equal(
    authorizeExistingPath(path.join(picked, 'note.md'), grants).lexical,
    path.resolve(picked, 'note.md')
  )
  assert.throws(
    () => authorizeExistingPath(path.join(root, 'note.md'), grants),
    (error) => error && error.code === 'outside_workspace'
  )
})

test('desktop IPC routes reads, writes and destructive operations through the boundary', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
  assert.match(main, /require\('\.\/workspace-boundary\.cjs'\)/)
  assert.match(main, /const readGrants = \(\) => folderRootGrants/)
  assert.match(main, /authorizeExistingImagePath\(p, imageReadRootGrants\)/)
  assert.match(main, /authorizeCreatableAssetImagePath\(p, assetWriteRootGrants\)/)
  assert.match(main, /const target = existingReadPath\(p\)/)
  assert.match(main, /const target = creatableWriteOrWritablePath\(p\)/)
  assert.match(main, /const source = existingWritePath\(from\)/)
  assert.match(main, /const destination = creatableWritePath\(to\)/)
  assert.match(main, /const target = existingWriteOrWritablePath\(p\)/)
  assert.match(main, /\.filter\(\(d\) => !d\.isSymbolicLink\(\)\)/)
  // attachment import copies into registered assets roots; opening one file
  // must not turn its parent image root into a generic sibling-document grant
  assert.match(main, /authorizeCreatableAssetPath\(p, assetWriteRootGrants\)/)
  assert.match(main, /const existingOpenPath = \(p\) => \{/)
  assert.match(main, /authorizeWritablePath\(p\)/)
  assert.match(main, /authorizeExistingMarkdownPath\(p, imageReadRootGrants\)/)
  assert.match(main, /authorizeExistingImagePath\(p, imageReadRootGrants\)/)
  assert.match(main, /authorizeExistingAssetPath\(p, assetWriteRootGrants\)/)
  assert.doesNotMatch(main, /const openGrants =/)
  assert.doesNotMatch(main, /const readGrants = \(\) => \[\.\.\.folderRootGrants, \.\.\.imageReadRootGrants\]/)
  // attachments may copy into a user-chosen target folder (default <dir>/assets):
  // every target and every final copy is still authorized against the roots
  assert.match(main, /knote:import-attachment/, 'attachment import route exists')
  assert.match(main, /const documentDir = path\.resolve\(String\(dir \|\| ''\)\)/)
  assert.match(main, /const targetDir = target \? path\.resolve\(String\(target\)\) : path\.join\(documentDir, 'assets'\)/)
  assert.match(main, /knote:pick-file-to-link/, 'in-place link picker route exists')
  // the destination folder picker is RESTRICTED to the document's file tree:
  // it lists only directories that pass the creatable probe, so the renderer
  // can never steer a copy outside the granted roots
  assert.match(main, /knote:attachment-dirs/, 'attachment folder tree route exists')
  assert.match(main, /knote:pick-import-file/, 'attachment source picker route exists')
  assert.match(main, /creatableAssetPath\(path\.join\(abs, '__knote_attach_probe__'\)\)/)
  assert.match(main, /pathKey\(entry\.documentDir\) !== pathKey\(destination\.documentDir\)/)
  assert.match(main, /pathKey\(entry\.targetDir\) !== pathKey\(destination\.targetDir\)/)
  assert.match(main, /entry\.handle\.read\(buffer/)
  assert.doesNotMatch(main, /copyFile\(picked\.source/)
  assert.match(main, /safeStorage\.encryptString/)
  assert.match(main, /persist: encrypted/)
  assert.match(main, /const safeName = path\.basename\(String\(defaultName/)
  assert.match(main, /return serializeFsMutation\(async \(\) => \{[\s\S]{0,700}output = await fs\.promises\.open/)
  assert.match(main, /await output\.writeFile\(pdf\)/)
  assert.doesNotMatch(main, /writeFile\(filePath, pdf\)/)
  assert.match(main, /PROTECTED_WORKSPACE_ROOT/)
  assert.match(main, /canonicalPathContains\(selected, authority\)[\s\S]{0,100}canonicalPathContains\(authority, selected\)/)
  assert.match(main, /pathsOverlapByFilesystemIdentity\(selected, authority\)/)
  assert.match(main, /systemPythonExecutables\(\)/)
  assert.match(main, /PYTHONNOUSERSITE = '1'/)
  assert.match(main, /PIP_CONFIG_FILE = process\.platform/)
  assert.match(main, /spawn\(py, \['-I', script/)
  assert.match(main, /runStreaming\(sysPy, \['-I', '-S', '-m', 'venv'/)
  assert.match(main, /push\(assets, 'assets'\)/)
  assert.match(main, /await walk\(assets, 'assets', 0\)/)
  // the chosen folder is persisted per document directory and re-authorized on
  // every read (userData, never inside a workspace)
  assert.match(main, /knote:attachment-target-get/, 'attachment target persistence read route exists')
  assert.match(main, /knote:attachment-target-set/, 'attachment target persistence write route exists')
  assert.match(main, /path\.join\(app\.getPath\('userData'\), 'attachment-targets\.json'\)/)
  assert.match(main, /if \(stored && qualifies\(path\.resolve\(stored\)\)\)/)
  // new/rename folder helpers inside the insert popup stay inside the same
  // creatable probe and run through the mutation coordinator
  assert.match(main, /knote:attachment-mkdir/, 'attachment folder create route exists')
  assert.match(main, /knote:attachment-rename-dir/, 'attachment folder rename route exists')
  assert.match(main, /const checked = creatableAssetPath\(newPath\)/)
  assert.match(main, /markStaleWritePath\(oldPath\)/)
  // in-place links may reference files OUTSIDE the workspace, but only paths
  // the user explicitly picked (bounded set) are openable beyond the roots
  assert.match(main, /const pickedOpenPaths = new Map\(\)/)
  assert.match(main, /!openTargetCapabilities\(\)\.matches\('file', snapshot\)/)
  assert.doesNotMatch(main, /const insideRoot =/)
  assert.doesNotMatch(main, /const insideReadRoot =/)
})
