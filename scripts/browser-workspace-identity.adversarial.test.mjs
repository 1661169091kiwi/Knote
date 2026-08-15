import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  createBrowserFileIdentityRegistry,
  createBrowserWorkspaceIdentityRegistry
} from '../src/lib/browserWorkspaceIdentity.js'

const appSource = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')

const fakeHandle = (entry, name = 'workspace') => ({
  kind: 'directory',
  name,
  async isSameEntry(other) { return other?.entry === entry },
  entry
})

const fakeFileHandle = (entry, name = 'note.md') => ({
  kind: 'file',
  name,
  async isSameEntry(other) { return other?.entry === entry },
  entry
})

const memoryPersistence = () => {
  const records = []
  return {
    records,
    listRecords: async () => records.map((record) => ({ ...record })),
    putRecord: async (record) => {
      const index = records.findIndex((candidate) => candidate.id === record.id)
      if (index >= 0) records[index] = { ...record }
      else records.push({ ...record })
    }
  }
}

test('same-named pathless folders receive different durable identities', async () => {
  const persistence = memoryPersistence()
  let sequence = 0
  const registry = createBrowserWorkspaceIdentityRegistry({
    ...persistence,
    createId: () => `id-${++sequence}`,
    withLock: (run) => run(),
    now: () => 1
  })

  const first = await registry.resolve(fakeHandle('entry-a'))
  const second = await registry.resolve(fakeHandle('entry-b'))
  assert.deepEqual(first, { id: 'folder:fsa/v1/id-1', durable: true })
  assert.deepEqual(second, { id: 'folder:fsa/v1/id-2', durable: true })
})

test('fresh wrappers for one entry reuse the persisted identity after reload', async () => {
  const persistence = memoryPersistence()
  const firstRegistry = createBrowserWorkspaceIdentityRegistry({
    ...persistence,
    createId: () => 'persisted-id',
    withLock: (run) => run(),
    now: () => 1
  })
  const first = await firstRegistry.resolve(fakeHandle('same-entry'))

  const reloadedRegistry = createBrowserWorkspaceIdentityRegistry({
    ...persistence,
    createId: () => 'must-not-be-used',
    withLock: (run) => run(),
    now: () => 2
  })
  const reopened = await reloadedRegistry.resolve(fakeHandle('same-entry'))
  assert.deepEqual(reopened, first)
  assert.equal(persistence.records.length, 1)
  assert.equal(persistence.records[0].lastOpenedAt, 2)
})

test('registry failures fail closed with isolated session identities', async () => {
  let sequence = 0
  const registry = createBrowserWorkspaceIdentityRegistry({
    listRecords: async () => { throw new Error('blocked') },
    putRecord: async () => { throw new Error('blocked') },
    createId: () => `fallback-${++sequence}`,
    withLock: (run) => run(),
    now: () => 1
  })
  const first = await registry.resolve(fakeHandle('entry-a'))
  const second = await registry.resolve(fakeHandle('entry-b'))
  assert.equal(first.durable, false)
  assert.equal(second.durable, false)
  assert.notEqual(first.id, second.id)
  assert.match(first.id, /^folder:fsa\/session\//)
})

test('App installs explicit identity before publishing a browser folder handle', () => {
  const adoption = appSource.slice(
    appSource.indexOf('const adoptFolderHandle = async'),
    appSource.indexOf('\nconst openFolder = async')
  )
  assert.match(adoption, /resolveBrowserWorkspaceIdentity\(handle\)/)
  assert.ok(adoption.indexOf('folderWorkspaceId.value = workspaceIdentity') < adoption.indexOf('folderHandle.value = handle'))
  assert.match(appSource, /folderWorkspaceIdentityDurable\.value\) return \[`folder:\$\{folderName\.value\}`\]/)
  assert.match(appSource, /return `folder:session\/\$\{opaqueHandleIdentity\(folderHandle\.value\)\}`/)
})

test('same-named pathless files receive distinct identities while fresh wrappers reuse one entry', async () => {
  const persistence = memoryPersistence()
  let sequence = 0
  const firstRegistry = createBrowserFileIdentityRegistry({
    ...persistence,
    createId: () => `id-${++sequence}`,
    withLock: (run) => run(),
    now: () => 1
  })
  const first = await firstRegistry.resolve(fakeFileHandle('entry-a'))
  const second = await firstRegistry.resolve(fakeFileHandle('entry-b'))
  assert.notEqual(first.id, second.id)
  assert.match(first.id, /^file:fsa\/v1\/file-id-1$/)

  const reloaded = createBrowserFileIdentityRegistry({
    ...persistence,
    createId: () => 'must-not-be-used',
    withLock: (run) => run(),
    now: () => 2
  })
  assert.deepEqual(await reloaded.resolve(fakeFileHandle('entry-a')), first)
})

test('App resolves pathless file identity without using the display filename as workspace identity', () => {
  const open = appSource.slice(
    appSource.indexOf('const openFileFromHandle = async'),
    appSource.indexOf('\nconst openLocalFile = async')
  )
  assert.match(open, /resolveBrowserFileIdentity\(handle\)/)
  assert.ok(open.indexOf('resolveBrowserFileIdentity(handle)') < open.indexOf('installOpenedMarkdown'))
  assert.match(open, /resolveFileMutationKey\(null, workspaceIdentity, '', handle\)/)
  assert.ok(open.indexOf('withAsyncKeyLock(mutationKey') < open.indexOf('const file = await handle.getFile()'))
  assert.ok(open.indexOf('const file = await handle.getFile()') < open.indexOf('installOpenedMarkdown'))
  assert.match(appSource, /if \(tb\?\.fileWorkspaceId\) return tb\.fileWorkspaceId/)
  assert.match(appSource, /return `file:session\/\$\{opaqueHandleIdentity\(tabFileHandle\)\}`/)
  assert.doesNotMatch(appSource, /return 'file:' \+ \(tabFileHandle\.name/)
  assert.match(appSource, /const workspaceIdentity = createPathlessFileSessionIdentity\(\)/)
  assert.match(appSource, /watch\(\[folderHandle, currentFileHandle, folderWorkspaceId, activeTabId, workspaceIdentityRevision\]/)
  assert.match(appSource, /setTabFileWorkspaceIdentity\(targetTab, workspaceIdentity, workspaceIdentityDurable\)/)
  assert.match(appSource, /touchWorkspaceIdentity\(\)/)
  assert.match(appSource, /tb\?\.fileWorkspaceIdentityDurable && currentFileName\.value/)
})
