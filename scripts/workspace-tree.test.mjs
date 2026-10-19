import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkspaceTree, loadWorkspaceDirectory, resolveWorkspaceFile, restoreWorkspaceExpansions, workspaceFileType } from '../src/lib/workspaceTree.js'

const file = name => ({ name, kind: 'file' })
const dir = (name, children = []) => ({
  name, kind: 'directory', reads: 0,
  async *entries() { this.reads++; for (const child of children) yield [child.name, child] },
  async getDirectoryHandle(name, options) { assert.equal(options, undefined); const node = children.find(n => n.name === name && n.kind === 'directory'); if (!node) throw Error('missing'); return node },
  async getFileHandle(name, options) { assert.equal(options, undefined); const node = children.find(n => n.name === name && n.kind === 'file'); if (!node) throw Error('missing'); return node }
})

test('opening a folder lists the entire root without entering a large early subtree', async () => {
  const cache = dir('.test-deps', Array.from({ length: 11000 }, (_, i) => file(`${i}.txt`)))
  const root = dir('workspace', [cache, dir('notes', [file('nested.md')]), ...Array.from({ length: 67 }, (_, i) => file(`root-${i}.md`))])
  const tree = await buildWorkspaceTree(root, { recursive: false, maxEntries: 2 })
  assert.equal(tree.filter(n => n.kind === 'file').length, 67)
  assert.equal(cache.reads, 0)
  assert.equal(tree._agentTraversal.complete, false)
  assert.deepEqual(tree._agentTraversal.omittedPaths, ['.test-deps', 'notes'])
  assert.equal(Object.keys(tree).includes('_agentTraversal'), false)
})

test('entry budgets cannot truncate the immediate children of a directory', async () => {
  const root = dir('workspace', Array.from({ length: 300 }, (_, i) => file(`${i}.md`)))
  const tree = await buildWorkspaceTree(root, { maxEntries: 1 })
  assert.equal(tree.length, 300)
  assert.equal(tree._agentTraversal.complete, true)
})

test('bounded indexing is breadth first, with explicit unloaded paths and lazy recovery', async () => {
  const deep = dir('deep', Array.from({ length: 500 }, (_, i) => file(`${i}.md`)))
  const root = dir('workspace', [dir('a-cache', [deep]), dir('z-notes', [file('paper.md')]), file('root.md')])
  const tree = await buildWorkspaceTree(root, { maxEntries: 5 })
  assert.equal(tree.find(n => n.name === 'z-notes').children[0].name, 'paper.md')
  assert.equal(deep.reads, 0)
  assert.deepEqual(tree._agentTraversal.omittedPaths, ['a-cache/deep'])
  await loadWorkspaceDirectory(tree[0].children[0])
  assert.equal(tree._agentTraversal.complete, true)
})

test('depth limits leave directories expandable instead of pretending they are empty', async () => {
  const tree = await buildWorkspaceTree(dir('root', [dir('a', [dir('b', [file('deep.md')])])]), { depthLimit: 1 })
  assert.deepEqual(tree._agentTraversal.omittedPaths, ['a/b'])
  await loadWorkspaceDirectory(tree[0].children[0])
  assert.equal(tree[0].children[0].children[0].name, 'deep.md')
  assert.equal(tree._agentTraversal.complete, true)
})

test('concurrent expand requests share one load and preserve its complete result', async () => {
  const child = dir('notes', [file('a.md')])
  const tree = await buildWorkspaceTree(dir('root', [child]), { recursive: false })
  const [first, second] = await Promise.all([loadWorkspaceDirectory(tree[0]), loadWorkspaceDirectory(tree[0])])
  assert.equal(child.reads, 1)
  assert.equal(first, second)
  assert.equal(tree[0].loading, false)
  assert.equal(tree[0].childrenLoaded, true)
})

test('a stale expansion cannot install its partial children', async () => {
  let current = true
  const child = { name: 'notes', kind: 'directory', async *entries() { yield ['a.md', file('a.md')]; current = false; yield ['b.md', file('b.md')] } }
  const tree = await buildWorkspaceTree(dir('root', [child]), { recursive: false })
  await assert.rejects(loadWorkspaceDirectory(tree[0], { stillCurrent: () => current }), { name: 'AbortError' })
  assert.equal(tree[0].childrenLoaded, false)
  assert.deepEqual(tree[0].children, [])
  assert.equal(tree[0].loading, false)
})

test('unreadable branches do not hide root files or masquerade as complete indexes', async () => {
  const child = dir('locked')
  child.entries = async function* () { throw Error('permission denied') }
  const tree = await buildWorkspaceTree(dir('root', [child, file('readme.md')]))
  assert.equal(tree.find(n => n.name === 'readme.md').kind, 'file')
  assert.equal(tree[0].loadError, 'permission denied')
  assert.equal(tree._agentTraversal.complete, false)
  child.entries = async function* () { yield ['fixed.md', file('fixed.md')] }
  await loadWorkspaceDirectory(tree[0])
  assert.equal(tree._agentTraversal.complete, true)
})

test('hidden source folders stay visible while fixed vendor exclusions are unchanged', async () => {
  const tree = await buildWorkspaceTree(dir('root', [dir('.claude'), dir('.git'), dir('node_modules'), dir('__pycache__'), file('readme.md')]), { recursive: false })
  assert.deepEqual(tree.map(n => n.name).sort(), ['.claude', '__pycache__', 'readme.md'].sort())
})

test('agent reads can resolve unopened paths without creating directories or broadening exclusions', async () => {
  const target = file('paper.md')
  const root = dir('root', [dir('notes', [target]), dir('node_modules', [file('vendor.md')])])
  assert.equal((await resolveWorkspaceFile(root, '/notes/paper.md')).handle, target)
  for (const path of ['../paper.md', 'notes/../paper.md', 'notes//paper.md', 'C:/paper.md', 'node_modules/vendor.md', 'notes/missing.md', 'notes/archive.zip']) assert.equal(await resolveWorkspaceFile(root, path), null)
})

test('file classification preserves document, image and code handling', () => {
  assert.equal(workspaceFileType('README', () => 'code'), 'code')
  assert.equal(workspaceFileType('test.PDF'), 'pdf')
  assert.equal(workspaceFileType('test.MARKDOWN'), 'md')
  assert.equal(workspaceFileType('test.png'), 'image')
  assert.equal(workspaceFileType('test.docx'), 'docx')
  assert.equal(workspaceFileType('test.bin'), null)
})

test('refresh restores expanded nested paths even when the bounded index did not reach them', async () => {
  const root = dir('root', [dir('notes', [dir('deep', [file('paper.md')])])])
  const tree = await buildWorkspaceTree(root, { maxEntries: 0 })
  assert.equal(tree[0].childrenLoaded, false)
  await restoreWorkspaceExpansions(tree, new Set(['/notes/deep']))
  assert.equal(tree[0].children[0].children[0].name, 'paper.md')
  assert.equal(tree._agentTraversal.complete, true)
})
