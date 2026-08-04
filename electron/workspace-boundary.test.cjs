'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  authorizeCreatableAssetImagePath,
  authorizeCreatableImagePath,
  authorizeCreatablePath,
  authorizeExistingImagePath,
  authorizeExistingPath,
  createBoundaryRoot
} = require('./workspace-boundary.cjs')

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
  assert.doesNotMatch(main, /const readGrants = \(\) => \[\.\.\.folderRootGrants, \.\.\.imageReadRootGrants\]/)
  assert.doesNotMatch(main, /const insideRoot =/)
  assert.doesNotMatch(main, /const insideReadRoot =/)
})
