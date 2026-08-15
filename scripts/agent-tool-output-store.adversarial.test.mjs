import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import fs from 'node:fs'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'

globalThis.indexedDB = indexedDB
globalThis.IDBKeyRange = IDBKeyRange
if (!globalThis.crypto) globalThis.crypto = webcrypto

const DB_NAME = 'knote-agent-tool-output'
const ARTIFACT_STORE = 'artifacts'

const {
  buildAgentToolOutputPreview,
  cleanupAgentToolOutputArtifacts,
  countAgentToolOutputLines,
  deleteAgentToolOutputSession,
  readAgentToolOutputArtifact,
  sliceAgentToolOutput,
  storeAgentToolOutputArtifact
} = await import('../src/lib/agentToolOutputStore.js')
const { captureLargeToolOutput, readAgentToolOutputForRun } = await import('../src/lib/agentStore.js')
const { serializeToolResult, toolSuccess } = await import('../src/lib/agentExecutionLedger.js')

const owner = Object.freeze({ chatKey: 'chat:workspace-a', sessionId: 'session-a' })

const artifactInput = (text, overrides = {}) => ({
  ...owner,
  runId: 'run-a',
  callId: 'call-a',
  tool: 'shell',
  contentType: 'text/plain; charset=utf-8',
  text,
  ...overrides
})

const readRequest = (artifactId, range, overrides = {}) => ({
  ...owner,
  artifactId,
  ...range,
  ...overrides
})

const deleteDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.deleteDatabase(DB_NAME)
  request.onsuccess = () => resolve()
  request.onerror = () => reject(request.error)
  request.onblocked = () => reject(new Error('test database deletion was blocked'))
})

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onabort = () => reject(transaction.error)
  transaction.onerror = () => reject(transaction.error)
})

const inspectArtifacts = async () => {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const transaction = database.transaction(ARTIFACT_STORE, 'readonly')
    const done = transactionDone(transaction)
    const rows = await requestResult(transaction.objectStore(ARTIFACT_STORE).getAll())
    await done
    return rows
  } finally {
    database.close()
  }
}

const errorCode = (code) => (error) => {
  assert.equal(error?.name, 'AgentToolOutputError')
  assert.equal(error?.code, code)
  return true
}

test.beforeEach(async () => {
  await deleteDatabase()
})

test.after(async () => {
  await deleteDatabase()
})

test('full UTF-8 output is durable before a bounded head and tail preview is returned', async () => {
  const text = `HEAD:${'A'.repeat(40)}MIDDLE_SECRET${'B'.repeat(40)}:TAIL:\u{1F95D}\nsecond line`
  const stored = await storeAgentToolOutputArtifact(artifactInput(text, {
    runId: 'run-secret',
    callId: 'call-secret',
    tool: 'grep',
    contentType: 'application/x-ndjson'
  }), {
    previewHeadBytes: 16,
    previewTailBytes: 20
  })

  assert.match(stored.artifactId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  for (const privatePart of [owner.chatKey, owner.sessionId, 'run-secret', 'call-secret', 'grep']) {
    assert.equal(stored.artifactId.includes(privatePart), false)
  }
  assert.equal(stored.totalBytes, Buffer.byteLength(text, 'utf8'))
  assert.equal(stored.totalLines, text.split('\n').length)
  assert.equal(stored.sha256, createHash('sha256').update(text, 'utf8').digest('hex'))
  assert.equal(stored.captureComplete, true)
  assert.equal(stored.contentType, 'application/x-ndjson')
  assert.equal(stored.preview.truncated, true)
  assert.match(stored.preview.head, /^HEAD:/)
  assert.match(stored.preview.tail, /second line$/)
  assert.doesNotMatch(stored.preview.text, /MIDDLE_SECRET/)
  assert.equal(stored.preview.headBytes + stored.preview.omittedBytes + stored.preview.tailBytes, stored.totalBytes)

  const otherRealm = await import(`../src/lib/agentToolOutputStore.js?durable=${Date.now()}`)
  const full = await otherRealm.readAgentToolOutputArtifact(readRequest(stored.artifactId, {
    lineOffset: 1,
    lineLimit: 10
  }))
  assert.equal(full.text, text)
  assert.equal(full.sha256, stored.sha256)
  assert.equal(full.eof, true)
  assert.equal(full.nextLineOffset, stored.totalLines + 1)
})

test('pure preview and paging helpers preserve UTF-8 boundaries and explicit offsets', () => {
  const fruit = '\u{1F95D}'
  const text = `${fruit.repeat(4)}\nalpha\nbeta`
  const preview = buildAgentToolOutputPreview(text, { headBytes: 5, tailBytes: 5 })
  assert.equal(preview.truncated, true)
  assert.equal(preview.head, fruit)
  assert.doesNotMatch(preview.head + preview.tail, /\uFFFD/)
  assert.equal(countAgentToolOutputLines(''), 1)
  assert.equal(countAgentToolOutputLines(text), 3)

  const first = sliceAgentToolOutput(text, { lineOffset: 1, lineLimit: 2 })
  assert.equal(first.text, `${fruit.repeat(4)}\nalpha`)
  assert.equal(first.eof, false)
  assert.equal(first.nextLineOffset, 3)
  const last = sliceAgentToolOutput(text, { lineOffset: first.nextLineOffset, lineLimit: 2 })
  assert.equal(last.text, 'beta')
  assert.equal(last.eof, true)
  assert.equal(last.nextLineOffset, 4)

  assert.throws(
    () => sliceAgentToolOutput(text, { lineOffset: 1, lineLimit: 1, byteOffset: 0, byteLimit: 4 }),
    errorCode('ARTIFACT_RANGE_INVALID')
  )
  assert.throws(
    () => sliceAgentToolOutput(text, { byteOffset: 1, byteLimit: 4 }),
    errorCode('ARTIFACT_UTF8_BOUNDARY')
  )
})

test('retrieval requires an exact chat and session owner without delimiter collisions', async () => {
  const collisionOwner = { chatKey: 'chat-a', sessionId: 'session\u0000b' }
  const stored = await storeAgentToolOutputArtifact(artifactInput('owned output', collisionOwner))

  await assert.rejects(
    readAgentToolOutputArtifact(readRequest(stored.artifactId, { lineOffset: 1, lineLimit: 1 }, {
      chatKey: 'chat-a\u0000session',
      sessionId: 'b'
    })),
    errorCode('ARTIFACT_OWNER_MISMATCH')
  )
  const owned = await readAgentToolOutputArtifact(readRequest(
    stored.artifactId,
    { lineOffset: 1, lineLimit: 1 },
    collisionOwner
  ))
  assert.equal(owned.text, 'owned output')
})

test('model-supplied owner fields cannot override the immutable runtime owner', async () => {
  const stored = await storeAgentToolOutputArtifact(artifactInput('same-session later-turn output'))
  const runContext = {
    runId: 'later-run',
    toolOutputOwner: Object.freeze({ ...owner })
  }
  const result = await readAgentToolOutputForRun({
    artifact_id: stored.artifactId,
    line_offset: 1,
    line_limit: 1,
    chatKey: 'chat:attacker',
    sessionId: 'session-attacker',
    chat_key: 'chat:attacker-2',
    session_id: 'session-attacker-2'
  }, runContext)

  assert.equal(result.ok, true)
  assert.equal(result.code, 'TOOL_OUTPUT_READ')
  assert.equal(result.message, 'same-session later-turn output')
  assert.equal(result.data.artifact_id, stored.artifactId)
  assert.equal(result.data.range.line_offset, 1)
  assert.equal(result.data.range.eof, true)

  const wrongOwner = await readAgentToolOutputForRun({
    artifact_id: stored.artifactId,
    byte_offset: 0,
    byte_limit: 8
  }, {
    toolOutputOwner: Object.freeze({ chatKey: owner.chatKey, sessionId: 'another-session' })
  })
  assert.equal(wrongOwner.ok, false)
  assert.equal(wrongOwner.code, 'ARTIFACT_OWNER_MISMATCH')
  assert.equal(wrongOwner.retryable, false)

  const invalidRange = await readAgentToolOutputForRun({
    artifact_id: stored.artifactId,
    line_offset: 1,
    line_limit: 1,
    byte_offset: 0,
    byte_limit: 8
  }, runContext)
  assert.equal(invalidRange.ok, false)
  assert.equal(invalidRange.code, 'ARTIFACT_RANGE_INVALID')
  assert.equal(invalidRange.retryable, true)
})

test('provider grounding becomes complete only after preview and read ranges cover every artifact byte', async () => {
  const text = `${'H'.repeat(25_000)}${'M'.repeat(2_000)}${'T'.repeat(25_000)}`
  const runContext = {
    runId: 'run-grounding',
    toolOutputOwner: Object.freeze({ ...owner })
  }
  const captured = await captureLargeToolOutput('web_fetch', 'call-grounding', toolSuccess({
    code: 'WEB_FETCHED',
    message: text,
    data: { complete: true, coverage: 'complete' },
    grounding: { complete: true, coverage: 'complete', clipped: false }
  }), runContext)

  assert.equal(captured.grounding.complete, false)
  assert.equal(captured.grounding.coverage, 'artifact_preview')
  assert.equal(captured.grounding.artifact_id, captured.toolOutput.artifact_id)
  const start = captured.toolOutput.preview.omitted_byte_offset
  const end = captured.toolOutput.preview.tail_byte_offset
  const split = start + Math.floor((end - start) / 2)

  const laterHalf = await readAgentToolOutputForRun({
    artifact_id: captured.toolOutput.artifact_id,
    byte_offset: split,
    byte_limit: end - split
  }, runContext)
  assert.equal(laterHalf.ok, true)
  assert.deepEqual(laterHalf.grounding, {
    requested_range_complete: true,
    source_complete: true,
    projection_complete: false,
    complete: false,
    coverage: 'artifact_range',
    clipped: true,
    artifact_id: captured.toolOutput.artifact_id
  })

  const earlierHalf = await readAgentToolOutputForRun({
    artifact_id: captured.toolOutput.artifact_id,
    byte_offset: start,
    byte_limit: split - start
  }, runContext)
  assert.equal(earlierHalf.ok, true)
  assert.equal(earlierHalf.grounding.complete, true)
  assert.equal(earlierHalf.grounding.coverage, 'complete')
})

test('complete artifact projection preserves a partial upstream source and its continuation cursor', async () => {
  const text = `${'A'.repeat(26_000)}SOURCE_PAGE_BODY${'B'.repeat(26_000)}`
  const sourceContinuation = {
    unit: 'utf8_byte',
    returned: 32_768,
    total: 100_000,
    truncated: true,
    has_more: true,
    next_cursor: 'YWJj',
    reason: 'byte_budget'
  }
  const runContext = {
    runId: 'run-partial-source',
    toolOutputOwner: Object.freeze({ ...owner })
  }
  const captured = await captureLargeToolOutput('read_file', 'call-partial-source', toolSuccess({
    code: 'FILE_READ',
    message: text,
    data: { source_id: 'workspace-a:file-a', continuation: sourceContinuation },
    grounding: {
      requested_range_complete: false,
      source_complete: true,
      projection_complete: true,
      coverage: 'partial',
      complete: false,
      clipped: true
    }
  }), runContext)

  assert.equal(captured.grounding.requested_range_complete, false)
  assert.equal(captured.grounding.projection_complete, false)
  assert.equal(captured.grounding.source_id, 'workspace-a:file-a')
  const full = await readAgentToolOutputForRun({
    artifact_id: captured.toolOutput.artifact_id,
    byte_offset: 0,
    byte_limit: captured.toolOutput.total_bytes
  }, runContext)
  assert.equal(full.ok, true)
  assert.equal(full.grounding.requested_range_complete, false)
  assert.equal(full.grounding.source_complete, true)
  assert.equal(full.grounding.projection_complete, true)
  assert.equal(full.grounding.complete, false)
  assert.equal(full.grounding.coverage, 'partial')
  assert.equal(full.grounding.source_id, 'workspace-a:file-a')
  assert.deepEqual(full.data.continuation, sourceContinuation)
})

test('artifact threshold measures the final provider serialization, not only message text', async () => {
  const nested = `SERIALIZED_ONLY_${'x'.repeat(55_000)}`
  const runContext = {
    runId: 'run-serialized-threshold',
    toolOutputOwner: Object.freeze({ ...owner })
  }
  const captured = await captureLargeToolOutput('web_fetch', 'call-serialized-threshold', toolSuccess({
    code: 'WEB_FETCHED',
    message: 'short visible message',
    data: { nested },
    grounding: { complete: true, coverage: 'complete', clipped: false }
  }), runContext)

  assert.ok(captured.toolOutput?.artifact_id)
  assert.equal(captured.grounding.coverage, 'artifact_preview')
  const artifact = await readAgentToolOutputArtifact(readRequest(captured.toolOutput.artifact_id, {
    byteOffset: 0,
    byteLimit: captured.toolOutput.total_bytes
  }))
  assert.match(artifact.text, /short visible message/)
  assert.match(artifact.text, /SERIALIZED_ONLY_/)
})

test('complete line pagination covers inter-page newline separators', async () => {
  const text = Array.from({ length: 7000 }, (_, index) => `line-${String(index + 1).padStart(5, '0')}`).join('\n')
  const runContext = {
    runId: 'run-line-grounding',
    toolOutputOwner: Object.freeze({ ...owner })
  }
  const captured = await captureLargeToolOutput('read_file', 'call-line-grounding', toolSuccess({
    code: 'FILE_READ',
    message: text,
    grounding: { complete: true, coverage: 'complete', clipped: false }
  }), runContext)
  assert.equal(captured.grounding.complete, false)

  let offset = 1
  let page = null
  do {
    page = await readAgentToolOutputForRun({
      artifact_id: captured.toolOutput.artifact_id,
      line_offset: offset,
      line_limit: 1000
    }, runContext)
    assert.equal(page.ok, true)
    offset = page.data.range.next_line_offset
  } while (!page.data.range.eof)

  assert.equal(page.grounding.complete, true)
  assert.equal(page.grounding.coverage, 'complete')
})

test('failed artifact persistence exposes only an unresumable bounded preview and keeps verified receipts', async () => {
  const originalIndexedDB = globalThis.indexedDB
  const secret = `MIDDLE_SECRET_${'s'.repeat(2000)}`
  const text = `${'H'.repeat(30_000)}${secret}${'T'.repeat(30_000)}`
  let captured
  try {
    globalThis.indexedDB = undefined
    captured = await captureLargeToolOutput('web_fetch', 'call-capture-failed', toolSuccess({
      code: 'WEB_FETCHED',
      message: text,
      data: { stdout: text, complete: true },
      mutation: { type: 'verified_test_receipt', target: 'path:a.md', verified: true },
      verification: { ok: true, readBack: true },
      grounding: { complete: true, coverage: 'complete' }
    }), {
      runId: 'run-capture-failed',
      toolOutputOwner: Object.freeze({ ...owner })
    })
  } finally {
    globalThis.indexedDB = originalIndexedDB
  }

  assert.equal(captured.toolOutput, null)
  assert.equal(captured.captureWarning.capture_complete, false)
  assert.match(captured.captureWarning.message, /省略内容无法.*read_tool_output/)
  assert.equal(captured.grounding.complete, false)
  assert.equal(captured.grounding.coverage, 'unresumable_preview')
  assert.equal(captured.grounding.artifact_id, undefined)
  assert.equal(captured.mutation.verified, true)
  assert.doesNotMatch(captured.message, /MIDDLE_SECRET/)

  const serialized = serializeToolResult(captured)
  const providerResult = JSON.parse(serialized)
  assert.doesNotMatch(serialized, /MIDDLE_SECRET/)
  assert.equal(providerResult.tool_output, undefined)
  assert.equal(providerResult.mutation.verified, true)
  assert.deepEqual(providerResult.data.stdout, {
    omitted: true,
    resumable: false,
    reason: 'artifact_capture_failed',
    utf8_bytes: Buffer.byteLength(text, 'utf8')
  })
})

test('giant single lines fail bounded line reads and remain pageable in UTF-8 byte mode', async () => {
  const unit = `A\u{1F95D}`
  const text = unit.repeat(500)
  const stored = await storeAgentToolOutputArtifact(artifactInput(text))

  await assert.rejects(
    readAgentToolOutputArtifact(readRequest(stored.artifactId, { lineOffset: 1, lineLimit: 1 }), {
      maxReadBytes: 64
    }),
    errorCode('ARTIFACT_LINE_TOO_LARGE')
  )
  await assert.rejects(
    readAgentToolOutputArtifact(readRequest(stored.artifactId, { byteOffset: 2, byteLimit: 31 }), {
      maxReadBytes: 64
    }),
    errorCode('ARTIFACT_UTF8_BOUNDARY')
  )
  await assert.rejects(
    readAgentToolOutputArtifact(readRequest(stored.artifactId, { byteOffset: 1, byteLimit: 1 }), {
      maxReadBytes: 64
    }),
    errorCode('ARTIFACT_BYTE_LIMIT_TOO_SMALL')
  )

  let byteOffset = 0
  let rebuilt = ''
  let pages = 0
  while (true) {
    const page = await readAgentToolOutputArtifact(readRequest(stored.artifactId, {
      byteOffset,
      byteLimit: 31
    }), { maxReadBytes: 64 })
    assert.equal(page.byteOffset, byteOffset)
    assert.ok(page.bytesRead > 0 && page.bytesRead <= 31)
    assert.doesNotMatch(page.text, /\uFFFD/)
    rebuilt += page.text
    pages++
    if (page.eof) {
      assert.equal(page.nextByteOffset, stored.totalBytes)
      break
    }
    assert.ok(page.nextByteOffset > byteOffset)
    byteOffset = page.nextByteOffset
  }
  assert.ok(pages > 10)
  assert.equal(rebuilt, text)
})

test('oversized captures are rejected whole and unknown IDs report missing', async () => {
  await assert.rejects(
    storeAgentToolOutputArtifact(artifactInput('x'.repeat(65)), {
      maxArtifactBytes: 64,
      maxSessionBytes: 100,
      maxGlobalBytes: 100
    }),
    (error) => {
      errorCode('ARTIFACT_TOO_LARGE')(error)
      assert.equal(error.totalBytes, 65)
      assert.equal(error.maxArtifactBytes, 64)
      return true
    }
  )
  await assert.rejects(
    readAgentToolOutputArtifact(readRequest('00000000-0000-4000-8000-000000000000', {
      byteOffset: 0,
      byteLimit: 10
    })),
    errorCode('ARTIFACT_MISSING')
  )
  assert.equal((await inspectArtifacts()).length, 0)
})

test('session and global byte cleanup are bounded and leave explicit stale references', async () => {
  const limits = {
    maxArtifactBytes: 100,
    maxSessionArtifacts: 10,
    maxSessionBytes: 20,
    maxGlobalArtifacts: 10,
    maxGlobalBytes: 40,
    maxTombstones: 20
  }
  const first = await storeAgentToolOutputArtifact(artifactInput('A'.repeat(12), { callId: 'call-1' }), limits)
  const second = await storeAgentToolOutputArtifact(artifactInput('B'.repeat(12), { callId: 'call-2' }), limits)
  await assert.rejects(
    readAgentToolOutputArtifact(readRequest(first.artifactId, { lineOffset: 1, lineLimit: 1 })),
    errorCode('ARTIFACT_STALE')
  )

  const otherOwner = { chatKey: owner.chatKey, sessionId: 'session-b' }
  const otherOne = await storeAgentToolOutputArtifact(artifactInput('C'.repeat(12), {
    ...otherOwner,
    callId: 'call-3'
  }), limits)
  await storeAgentToolOutputArtifact(artifactInput('D'.repeat(12), {
    chatKey: 'chat:workspace-b',
    sessionId: 'session-c',
    callId: 'call-4'
  }), limits)
  await storeAgentToolOutputArtifact(artifactInput('E'.repeat(12), {
    chatKey: 'chat:workspace-c',
    sessionId: 'session-d',
    callId: 'call-5'
  }), limits)

  await assert.rejects(
    readAgentToolOutputArtifact(readRequest(second.artifactId, { lineOffset: 1, lineLimit: 1 })),
    errorCode('ARTIFACT_STALE')
  )
  const retainedOther = await readAgentToolOutputArtifact(readRequest(
    otherOne.artifactId,
    { lineOffset: 1, lineLimit: 1 },
    otherOwner
  ))
  assert.equal(retainedOther.text, 'C'.repeat(12))

  const rows = await inspectArtifacts()
  assert.ok(rows.length <= limits.maxGlobalArtifacts)
  assert.ok(rows.reduce((total, row) => total + row.totalBytes, 0) <= limits.maxGlobalBytes)
  const cleanup = await cleanupAgentToolOutputArtifacts(limits)
  assert.equal(cleanup.remainingArtifacts, rows.length)
  assert.ok(cleanup.remainingBytes <= limits.maxGlobalBytes)

  assert.equal(await deleteAgentToolOutputSession(otherOwner, limits), 1)
  await assert.rejects(
    readAgentToolOutputArtifact(readRequest(
      otherOne.artifactId,
      { lineOffset: 1, lineLimit: 1 },
      otherOwner
    )),
    errorCode('ARTIFACT_STALE')
  )
})

test('concurrent captures serialize retention and never exceed the global high watermark', async () => {
  const limits = {
    maxArtifactBytes: 100,
    maxSessionArtifacts: 20,
    maxSessionBytes: 200,
    maxGlobalArtifacts: 5,
    maxGlobalBytes: 50,
    maxTombstones: 50
  }
  const stored = await Promise.all(Array.from({ length: 20 }, (_, index) => (
    storeAgentToolOutputArtifact(artifactInput(String(index).padStart(10, '0'), {
      sessionId: `session-${index % 4}`,
      callId: `call-${index}`
    }), limits)
  )))
  assert.equal(new Set(stored.map((item) => item.artifactId)).size, stored.length)
  const rows = await inspectArtifacts()
  assert.equal(rows.length, 5)
  assert.equal(rows.reduce((total, row) => total + row.totalBytes, 0), 50)
})

test('newline-dense reads and payload-heavy retention avoid full indexes and artifact getAll cloning', async () => {
  const source = fs.readFileSync(new URL('../src/lib/agentToolOutputStore.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /lineByteStarts/)
  const dense = '\n'.repeat(500_000)
  const page = sliceAgentToolOutput(dense, { lineOffset: 250_000, lineLimit: 3 })
  assert.equal(page.text, '\n\n')
  assert.equal(page.totalLines, 500_001)
  assert.equal(page.byteOffset, 249_999)
  assert.equal(page.bytesRead, 2)

  await storeAgentToolOutputArtifact(artifactInput('seed'))
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = database.transaction(ARTIFACT_STORE, 'readonly')
  const done = transactionDone(transaction)
  const store = transaction.objectStore(ARTIFACT_STORE)
  const prototype = Object.getPrototypeOf(store)
  await requestResult(store.count())
  await done
  database.close()

  const originalGetAll = prototype.getAll
  prototype.getAll = function (...args) {
    if (this.name === ARTIFACT_STORE) throw new Error('artifact getAll payload cloning is forbidden')
    return originalGetAll.apply(this, args)
  }
  const limits = {
    maxArtifactBytes: 8 * 1024,
    maxSessionArtifacts: 16,
    maxSessionBytes: 64 * 1024,
    maxGlobalArtifacts: 8,
    maxGlobalBytes: 32 * 1024,
    maxTombstones: 100
  }
  try {
    for (let index = 0; index < 32; index++) {
      await storeAgentToolOutputArtifact(artifactInput(String(index).padStart(4, '0').repeat(1024), {
        chatKey: `chat:${index}`,
        sessionId: `session:${index}`,
        callId: `retention-${index}`
      }), limits)
    }
    const cleanup = await cleanupAgentToolOutputArtifacts(limits)
    assert.ok(cleanup.remainingArtifacts <= limits.maxGlobalArtifacts)
    assert.ok(cleanup.remainingBytes <= limits.maxGlobalBytes)
  } finally {
    prototype.getAll = originalGetAll
  }
})

test('age expiry transitions from retained to stale while unrelated opaque IDs stay missing', async () => {
  const stored = await storeAgentToolOutputArtifact(artifactInput('short lived'), {
    now: 1_000_000,
    maxAgeMs: 1000
  })
  await assert.rejects(
    readAgentToolOutputArtifact(readRequest(stored.artifactId, { byteOffset: 0, byteLimit: 20 }), {
      now: 1_001_001
    }),
    errorCode('ARTIFACT_STALE')
  )
  await assert.rejects(
    readAgentToolOutputArtifact(readRequest(stored.artifactId, { byteOffset: 0, byteLimit: 20 })),
    errorCode('ARTIFACT_STALE')
  )
  assert.equal((await inspectArtifacts()).length, 0)
})
