import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SafDirHandle,
  SafFileHandle,
  nativeAndroidWebSearch,
  releaseSafGrant,
  setSafPluginAdapter,
  setSafSnapshotAdapter
} from '../src/lib/safFs.js'

const GRANT_ID = 'g'.repeat(43)
const ENTRY_A = 'a'.repeat(43)
const ENTRY_B = 'b'.repeat(43)
const ENTRY_C = 'c'.repeat(43)

const treeGrant = () => ({
  grantId: GRANT_ID,
  kind: 'tree',
  displayName: 'Notes',
  readable: true,
  writable: true,
  persisted: true,
  valid: true
})

const fileMetadata = (path, entryId = ENTRY_A, over = {}) => ({
  entryId,
  name: path.split('/').pop(),
  relativePath: path,
  kind: 'file',
  mimeType: 'text/markdown',
  size: 4,
  lastModified: 10,
  readable: true,
  writable: true,
  contentWritable: true,
  ...over
})

const withSaf = async (adapter, run) => {
  setSafPluginAdapter(adapter)
  try {
    return await run()
  } finally {
    setSafPluginAdapter()
  }
}

const withSnapshots = async (writer, run, copier = async () => true) => {
  setSafSnapshotAdapter(writer, copier)
  try {
    return await run()
  } finally {
    setSafSnapshotAdapter()
  }
}

test('SAF file handles propagate every capability returned by native metadata', async () => {
  const calls = []
  await withSaf({
    readFile: async (options) => {
      calls.push(['read', options.entryId])
      return { data: Buffer.from('read').toString('base64'), metadata: fileMetadata('note.md', ENTRY_B) }
    },
    restoreGrant: async () => treeGrant(),
    stat: async (options) => {
      calls.push(['stat', options.entryId])
      return fileMetadata('note.md', ENTRY_C)
    },
    writeFile: async (options) => {
      calls.push(['write', options.entryId, Buffer.from(options.data, 'base64').toString('utf8')])
      return fileMetadata('note.md', ENTRY_A)
    }
  }, async () => {
    const handle = new SafFileHandle(treeGrant(), 'note.md', fileMetadata('note.md', ENTRY_A))
    assert.equal(await (await handle.getFile()).text(), 'read')
    assert.equal(await handle.queryPermission({ mode: 'readwrite' }), 'granted')
    const writer = await handle.createWritable()
    await writer.write('next')
    await writer.close()
    assert.equal(handle._entryId, ENTRY_A)
  })

  assert.deepEqual(calls, [
    ['read', ENTRY_A],
    ['stat', ENTRY_B],
    ['write', ENTRY_C, 'next']
  ])
})

test('SAF maps stale native capabilities to InvalidStateError without retrying', async () => {
  let reads = 0
  await withSaf({
    readFile: async () => {
      reads += 1
      throw Object.assign(new Error('replaced'), { code: 'ENTRY_CHANGED' })
    }
  }, async () => {
    const handle = new SafFileHandle(treeGrant(), 'note.md', fileMetadata('note.md'))
    await assert.rejects(
      () => handle.getFile(),
      (error) => error?.name === 'InvalidStateError' && error?.code === 'ENTRY_CHANGED'
    )
  })
  assert.equal(reads, 1)
})

test('SAF rejects unsafe names and forged provider paths before further adapter access', async () => {
  let calls = 0
  await withSaf(new Proxy({}, {
    get: (_target, method) => async () => {
      calls += 1
      if (method === 'list') {
        return { entries: [fileMetadata('elsewhere/other.md')] }
      }
      return fileMetadata('note.md')
    }
  }), async () => {
    const root = new SafDirHandle(treeGrant())
    for (const name of ['..', '.', '../escape.md', '..\\escape.md', '/escape.md', 'file:escape.md', 'bad\0name.md', 'e\u0301.md']) {
      await assert.rejects(() => root.getFileHandle(name, { create: true }), TypeError)
      await assert.rejects(() => root.getDirectoryHandle(name, { create: true }), TypeError)
      await assert.rejects(() => root.removeEntry(name), TypeError)
    }
    assert.equal(calls, 0)
    await assert.rejects(async () => {
      for await (const _entry of root.entries()) { /* consume */ }
    }, TypeError)
  })
  assert.equal(calls, 1)
})

test('SAF writable streams preserve bytes and enforce replacement stream state', async () => {
  const writes = []
  await withSaf({
    writeFile: async (options) => {
      writes.push(Buffer.from(options.data, 'base64'))
      return fileMetadata('binary.md')
    }
  }, async () => {
    const handle = new SafFileHandle(treeGrant(), 'binary.md', fileMetadata('binary.md'))
    await assert.rejects(() => handle.createWritable({ keepExistingData: true }), (error) => error?.name === 'NotSupportedError')

    const aborted = await handle.createWritable()
    await aborted.write('discard')
    await aborted.abort()
    await assert.rejects(() => aborted.write('late'), (error) => error?.name === 'InvalidStateError')
    await assert.rejects(() => aborted.close(), (error) => error?.name === 'InvalidStateError')

    const writer = await handle.createWritable()
    await writer.write('A')
    await writer.write(Uint8Array.from([0, 255]))
    await writer.write(new DataView(Uint8Array.from([7, 8, 9]).buffer, 1, 2))
    await writer.close()
    await assert.rejects(() => writer.close(), (error) => error?.name === 'InvalidStateError')
  })
  assert.equal(writes.length, 1)
  assert.deepEqual([...writes[0]], [65, 0, 255, 8, 9])
})

test('SAF grant release drains active calls and rejects calls started during release', async () => {
  let finishRead
  let releases = 0
  const readResult = new Promise((resolve) => { finishRead = resolve })
  await withSaf({
    readFile: async () => readResult,
    releaseGrant: async () => { releases += 1 }
  }, async () => {
    const handle = new SafFileHandle(treeGrant(), 'note.md', fileMetadata('note.md'))
    const read = handle.getFile()
    const release = releaseSafGrant(GRANT_ID)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(releases, 0)
    await assert.rejects(
      () => handle.getFile(),
      (error) => error?.name === 'NotAllowedError' && error?.code === 'GRANT_REVOKED'
    )
    finishRead({ data: Buffer.from('read').toString('base64'), metadata: fileMetadata('note.md') })
    await read
    await release
  })
  assert.equal(releases, 1)
})

test('SAF Markdown deletion snapshots bytes before invoking native delete', async () => {
  const events = []
  await withSnapshots(async (_identity, content, _time, label) => {
    events.push(`snapshot:${label}:${content}`)
    return true
  }, () => withSaf({
    stat: async () => fileMetadata('note.md'),
    readFile: async () => ({
      data: Buffer.from('recover me').toString('base64'),
      metadata: fileMetadata('note.md', ENTRY_A, { size: 10 })
    }),
    delete: async (options) => { events.push(`delete:${options.entryId}`) }
  }, async () => {
    await new SafDirHandle(treeGrant()).removeEntry('note.md')
  }))

  assert.deepEqual(events, [
    'snapshot:before-delete:recover me',
    `delete:${ENTRY_A}`
  ])
})

test('Android search cancellation targets only its generated request identifier', async () => {
  const pending = new Map()
  const cancellations = []
  await withSaf({
    webSearch: (options) => new Promise((resolve) => {
      pending.set(options.requestId, { options, resolve })
    }),
    cancelWebSearch: async ({ requestId }) => {
      cancellations.push(requestId)
      pending.get(requestId)?.resolve({
        ok: false,
        requestId,
        engine: pending.get(requestId).options.engine,
        results: [],
        code: 'SEARCH_CANCELLED',
        retryable: false
      })
      return { cancelled: true }
    }
  }, async () => {
    const controller = new AbortController()
    const first = nativeAndroidWebSearch('first parallel search', 5, { engine: 'bing', signal: controller.signal })
    const second = nativeAndroidWebSearch('second parallel search', 5, { engine: 'bing' })
    assert.equal(pending.size, 2)
    const requestIds = [...pending.keys()]
    assert.notEqual(requestIds[0], requestIds[1])
    assert.ok(requestIds.every((requestId) => /^[A-Za-z0-9_-]{16,128}$/.test(requestId)))

    controller.abort()
    await assert.rejects(first, (error) => error?.name === 'AbortError' && error?.code === 'SEARCH_CANCELLED')
    while (!cancellations.length) await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(cancellations, [requestIds[0]])

    pending.get(requestIds[1]).resolve({
      ok: true,
      requestId: requestIds[1],
      engine: 'bing',
      results: [],
      status: 200,
      rate: { status: 200 }
    })
    const unaffected = await second
    assert.equal(unaffected.ok, true)
    assert.deepEqual(unaffected.results, [])
    assert.equal(unaffected.requestId, requestIds[1])
  })
})

test('Android search fails closed for unknown engines before plugin access', async () => {
  let calls = 0
  await withSaf({
    webSearch: async () => { calls += 1; return { ok: true, engine: 'bing', results: [] } }
  }, async () => {
    const result = await nativeAndroidWebSearch('do not broaden this search', 5, { engine: 'google' })
    assert.deepEqual(result, {
      ok: false,
      requestId: '',
      engine: null,
      results: [],
      code: 'INVALID_SEARCH_ENGINE',
      error: 'bad_engine',
      retryable: false
    })
  })
  assert.equal(calls, 0)
})

test('Android search bridge preserves bounded failure metadata without response data', async () => {
  await withSaf({
    webSearch: async (options) => ({
      ok: false,
      requestId: options.requestId,
      engine: 'mojeek',
      results: [{ title: 'must be discarded', url: 'https://example.com/private' }],
      code: 'SEARCH_RATE_LIMITED',
      error: 'forged-error',
      retryable: true,
      status: 429,
      rate: { status: 429, retryAfterMs: 999999, raw: 'secret' },
      headers: { authorization: 'secret' },
      body: 'secret response body'
    })
  }, async () => {
    const result = await nativeAndroidWebSearch('bounded metadata', 5, { engine: 'mojeek' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'SEARCH_RATE_LIMITED')
    assert.equal(result.error, 'rate_limited')
    assert.equal(result.retryable, true)
    assert.equal(result.status, 429)
    assert.deepEqual(result.rate, { status: 429, retryAfterMs: 120000 })
    assert.deepEqual(result.results, [])
    assert.doesNotMatch(JSON.stringify(result), /authorization|secret|headers|body|raw/)
  })
})
