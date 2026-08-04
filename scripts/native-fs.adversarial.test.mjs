import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { Directory } from '@capacitor/filesystem'
import {
  NativeDirHandle,
  NativeFileHandle,
  nativeExportText,
  setNativeFilesystemAdapter,
  setNativeSnapshotAdapter
} from '../src/lib/nativeFs.js'

const withFilesystem = async (methods, run) => {
  setNativeFilesystemAdapter(methods)
  try {
    return await run()
  } finally {
    setNativeFilesystemAdapter()
  }
}

const withSnapshots = async (writer, run, importer = async () => true, copier = async () => true) => {
  setNativeSnapshotAdapter(writer, importer, copier)
  try {
    return await run()
  } finally {
    setNativeSnapshotAdapter()
  }
}

test('native getFile returns a real binary-safe File with metadata', async () => {
  const expected = Uint8Array.from([0, 255, 1, 2, 128, 10])
  await withFilesystem({
    readFile: async () => ({ data: Buffer.from(expected).toString('base64') }),
    stat: async () => ({ type: 'file', size: expected.length, mtime: 123456 })
  }, async () => {
    const file = await new NativeFileHandle(Directory.Documents, 'Knote/scan.pdf').getFile()
    assert.ok(file instanceof File)
    assert.equal(file.name, 'scan.pdf')
    assert.equal(file.type, 'application/pdf')
    assert.equal(file.size, expected.length)
    assert.equal(file.lastModified, 123456)
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), expected)
  })
})

test('native writable accepts mixed chunk types and preserves exact bytes', async () => {
  const writes = []
  const renames = []
  await withFilesystem({
    readFile: async () => { const error = new Error('new file'); error.code = 'OS-PLUG-FILE-0008'; throw error },
    writeFile: async (options) => { writes.push(options) },
    rename: async (options) => { renames.push(options) },
    deleteFile: async () => {}
  }, async () => {
    const handle = new NativeFileHandle(Directory.Documents, 'Knote/pixel.png')
    const writer = await handle.createWritable()
    await writer.write('A')
    await writer.write(new Blob([Uint8Array.from([0, 255])]))
    await writer.write(Uint8Array.from([128, 66]).buffer)
    await writer.write(new DataView(Uint8Array.from([7, 8, 9]).buffer, 1, 2))
    await writer.close()
  })

  assert.equal(writes.length, 1)
  assert.equal(writes[0].encoding, undefined)
  assert.deepEqual([...Buffer.from(writes[0].data, 'base64')], [65, 0, 255, 128, 66, 8, 9])
  assert.equal(renames.length, 1)
  assert.match(renames[0].from, /^Knote\/pixel\.png\.knote-.+\.tmp$/)
  assert.equal(renames[0].to, 'Knote/pixel.png')
})

test('native file move supports rename-in-place and destination directory overloads', async () => {
  const renames = []
  await withFilesystem({
    rename: async (options) => { renames.push(options) }
  }, async () => {
    const handle = new NativeFileHandle(Directory.Documents, 'Knote/original.png')
    await handle.move('renamed.png')
    assert.equal(handle.name, 'renamed.png')
    assert.equal(handle._path, 'Knote/renamed.png')

    const destination = new NativeDirHandle(Directory.External, 'Knote/archive', 'archive')
    await handle.move(destination, 'moved.png')
    assert.equal(handle.name, 'moved.png')
    assert.equal(handle._dir, Directory.External)
    assert.equal(handle._path, 'Knote/archive/moved.png')
  })
  assert.deepEqual(renames, [
    {
      from: 'Knote/original.png',
      to: 'Knote/renamed.png',
      directory: Directory.Documents,
      toDirectory: Directory.Documents
    },
    {
      from: 'Knote/renamed.png',
      to: 'Knote/archive/moved.png',
      directory: Directory.Documents,
      toDirectory: Directory.External
    }
  ])
})

test('native removeEntry dispatches files and recursive directories to the correct APIs', async () => {
  const deleted = []
  const removedDirs = []
  await withFilesystem({
    stat: async ({ path }) => ({ type: path.endsWith('folder') ? 'directory' : 'file' }),
    readdir: async () => ({ files: [{ name: 'nested.png', type: 'file' }] }),
    deleteFile: async (options) => { deleted.push(options) },
    rmdir: async (options) => { removedDirs.push(options) }
  }, async () => {
    const root = new NativeDirHandle(Directory.Documents, 'Knote', 'Knote')
    await root.removeEntry('loose.png')
    await root.removeEntry('folder', { recursive: true })
  })
  assert.deepEqual(deleted, [{ path: 'Knote/loose.png', directory: Directory.Documents }])
  assert.deepEqual(removedDirs, [{ path: 'Knote/folder', directory: Directory.Documents, recursive: true }])
})

test('native Markdown writes preserve old and proposed text in the shared history layer', async () => {
  const snapshots = []
  const oldBytes = Buffer.from('OLD Markdown', 'utf8')
  await withSnapshots(async (identity, content, _time, label) => {
    snapshots.push({ identity, content, label })
    return true
  }, () => withFilesystem({
    readFile: async () => ({ data: oldBytes.toString('base64') }),
    writeFile: async () => {},
    rename: async () => {},
    deleteFile: async () => {}
  }, async () => {
    const writer = await new NativeFileHandle(Directory.Documents, 'Knote/note.md').createWritable()
    await writer.write('NEW Markdown')
    await writer.close()
  }))

  assert.deepEqual(snapshots.map(({ content, label }) => ({ content, label })), [
    { content: 'OLD Markdown', label: 'before-save' },
    { content: 'NEW Markdown', label: 'pending-save' },
    { content: 'NEW Markdown', label: 'save' }
  ])
  assert.ok(snapshots.every((snapshot) => snapshot.identity === 'native:DOCUMENTS:Knote/note.md'))
})

test('native Markdown deletion archives the body before removing the file', async () => {
  const events = []
  await withSnapshots(async (_identity, content, _time, label) => {
    events.push(`snapshot:${label}:${content}`)
    return true
  }, () => withFilesystem({
    stat: async () => ({ type: 'file' }),
    readdir: async () => { throw Object.assign(new Error('missing'), { code: 'OS-PLUG-FILE-0008' }) },
    readFile: async () => ({ data: Buffer.from('RECOVER ME').toString('base64') }),
    deleteFile: async () => { events.push('delete') }
  }, async () => {
    await new NativeDirHandle(Directory.Documents, 'Knote', 'Knote').removeEntry('note.md')
  }))
  assert.deepEqual(events, ['snapshot:before-delete:RECOVER ME', 'delete'])
})

test('native adapter has one shared history implementation and no hidden duplicate store', () => {
  const source = fs.readFileSync(new URL('../src/lib/nativeFs.js', import.meta.url), 'utf8')
  assert.match(source, /from '\.\/snapshots\.js'/)
  assert.doesNotMatch(source, /\.knote-history|nativeHistory|historyRoot/i)
})

test('native handles reject raw and encoded boundary escapes before adapter access', async () => {
  let calls = 0
  await withFilesystem(new Proxy({}, {
    get: () => async () => { calls += 1 }
  }), async () => {
    const root = new NativeDirHandle(Directory.Documents, 'Knote', 'Knote')
    for (const name of [
      '..', '.', '../escape.md', '..\\escape.md', '/escape.md', 'C:\\escape.md',
      'file:escape.md', 'assets%2f..%2fescape.md', '%2e%2e', '%252e%252e%252fescape.md',
      'bad\0name.md'
    ]) {
      await assert.rejects(() => root.getFileHandle(name, { create: true }), TypeError, name)
      await assert.rejects(() => root.getDirectoryHandle(name, { create: true }), TypeError, name)
      await assert.rejects(() => root.removeEntry(name), TypeError, name)
    }
    assert.throws(() => new NativeFileHandle(Directory.Documents, '../escape.md'), TypeError)
    assert.throws(() => new NativeDirHandle(Directory.Data, 'Knote', 'Knote'), TypeError)

    const file = new NativeFileHandle(Directory.Documents, 'Knote/note.md')
    await assert.rejects(() => file.move({ kind: 'directory', _dir: Directory.Data, _path: '' }, 'escape.md'), TypeError)
    file._path = 'Knote/../escape.md'
    await assert.rejects(() => file.getFile(), TypeError)
    await assert.rejects(() => nativeExportText('../escape.md', 'x'), TypeError)
  })
  assert.equal(calls, 0)
})

test('native create and delete propagate permission failures instead of treating them as absence', async () => {
  const denied = Object.assign(new Error('permission denied'), { code: 'OS-PLUG-FILE-0007' })
  let writes = 0
  let deletes = 0
  await withFilesystem({
    stat: async () => { throw denied },
    writeFile: async () => { writes += 1 },
    deleteFile: async () => { deletes += 1 }
  }, async () => {
    const root = new NativeDirHandle(Directory.Documents, 'Knote', 'Knote')
    await assert.rejects(() => root.getFileHandle('note.md', { create: true }), denied)
    await assert.rejects(() => root.getDirectoryHandle('folder', { create: true }), denied)
    await assert.rejects(() => root.removeEntry('note.md'), denied)
  })
  assert.equal(writes, 0)
  assert.equal(deletes, 0)
})

test('native handle lookup reports type mismatches without replacing the existing entry', async () => {
  await withFilesystem({
    stat: async ({ path }) => ({ type: path.endsWith('folder') ? 'directory' : 'file' })
  }, async () => {
    const root = new NativeDirHandle(Directory.Documents, 'Knote', 'Knote')
    await assert.rejects(
      () => root.getFileHandle('folder', { create: true }),
      (error) => error?.name === 'TypeMismatchError'
    )
    await assert.rejects(
      () => root.getDirectoryHandle('note.md', { create: true }),
      (error) => error?.name === 'TypeMismatchError'
    )
  })
})

test('native Markdown open imports the exact released Android history format once without deleting its source', async () => {
  const identity = 'native:DOCUMENTS:Knote/note.md'
  const sha = createHash('sha256').update(identity).digest('hex')
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (const char of identity) {
    const codePoint = char.codePointAt(0)
    h1 = Math.imul(h1 ^ codePoint, 0x01000193)
    h2 = Math.imul(h2 ^ codePoint, 0x85ebca6b)
  }
  const fallback = `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
  const imports = []
  const reads = []
  const deletes = []
  await withSnapshots(async () => true, () => withFilesystem({
    readdir: async ({ path, directory }) => {
      assert.equal(directory, Directory.Data)
      if (path.endsWith(sha)) {
        return { files: [
          { name: '1700000000000-abcdefgh.md', type: 'file' },
          { name: '../escape.md', type: 'file' },
          { name: 'not-a-snapshot.txt', type: 'file' }
        ] }
      }
      if (path.endsWith(fallback)) {
        return { files: [{ name: '1600000000000-fallback.md', type: 'file' }] }
      }
      throw Object.assign(new Error('missing'), { code: 'OS-PLUG-FILE-0008' })
    },
    readFile: async (options) => {
      reads.push(options)
      if (options.directory === Directory.Data) {
        return { data: options.path.includes('1600000000000') ? 'OLDER' : 'NEWER' }
      }
      return { data: Buffer.from('CURRENT').toString('base64') }
    },
    stat: async () => ({ type: 'file', mtime: 1 }),
    deleteFile: async (options) => { deletes.push(options) }
  }, async () => {
    const handle = new NativeFileHandle(Directory.Documents, 'Knote/note.md')
    assert.equal(await (await handle.getFile()).text(), 'CURRENT')
    assert.equal(await (await handle.getFile()).text(), 'CURRENT')
  }), async (docKey, importId, items) => {
    imports.push({ docKey, importId, items })
    return true
  })

  assert.deepEqual(imports, [{
    docKey: identity,
    importId: 'android-directory-data-v1',
    items: [
      { content: 'OLDER', t: 1600000000000, label: 'legacy-native' },
      { content: 'NEWER', t: 1700000000000, label: 'legacy-native' }
    ]
  }])
  assert.equal(reads.filter((item) => item.directory === Directory.Data).length, 2)
  assert.equal(deletes.length, 0)
})

test('failed native legacy imports are unmarked and retried on the next access', async () => {
  let imports = 0
  await withSnapshots(async () => true, () => withFilesystem({
    readdir: async () => ({ files: [] }),
    readFile: async () => ({ data: Buffer.from('CURRENT').toString('base64') }),
    stat: async () => ({ type: 'file', mtime: 1 })
  }, async () => {
    const handle = new NativeFileHandle(Directory.Documents, 'Knote/retry.md')
    await handle.getFile()
    await handle.getFile()
  }), async () => {
    imports += 1
    if (imports === 1) throw new Error('transaction aborted')
    return true
  })
  assert.equal(imports, 2)
})

test('native Markdown moves migrate legacy data and copy shared history to the new identity', async () => {
  const copies = []
  const renames = []
  const events = []
  await withSnapshots(async () => true, () => withFilesystem({
    readdir: async () => { throw Object.assign(new Error('missing'), { code: 'OS-PLUG-FILE-0008' }) },
    rename: async (options) => { events.push('rename'); renames.push(options) }
  }, async () => {
    const handle = new NativeFileHandle(Directory.Documents, 'Knote/old.md')
    await handle.move('new.md')
    assert.equal(handle._path, 'Knote/new.md')
  }), async () => true, async (fromKey, toKey) => {
    events.push('copy')
    copies.push([fromKey, toKey])
    return true
  })
  assert.equal(renames.length, 1)
  assert.deepEqual(copies, [[
    'native:DOCUMENTS:Knote/old.md',
    'native:DOCUMENTS:Knote/new.md'
  ]])
  assert.deepEqual(events, ['copy', 'rename'])
})

test('native Markdown move does not mutate the filesystem if its transactional history copy fails', async () => {
  const renames = []
  const copyError = new Error('history unavailable')
  const handle = new NativeFileHandle(Directory.Documents, 'Knote/old.md')
  await withSnapshots(async () => true, () => withFilesystem({
    readdir: async () => { throw Object.assign(new Error('missing'), { code: 'OS-PLUG-FILE-0008' }) },
    rename: async (options) => { renames.push(options) }
  }, async () => {
    await assert.rejects(() => handle.move('new.md'), copyError)
  }), async () => true, async () => { throw copyError })
  assert.equal(handle._path, 'Knote/old.md')
  assert.deepEqual(renames, [])
})
