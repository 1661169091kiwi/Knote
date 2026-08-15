import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import JSZip from 'jszip'

if (!globalThis.crypto) globalThis.crypto = webcrypto
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64')
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary')

import {
  SourceContinuationError,
  createSourceCursor,
  createSourceReadContract,
  paginateUtf8LineRange,
  paginateUtf8PageSequence,
  paginateUtf8Text,
  readSourceCursor,
  sourceRevisionFingerprint,
  utf8ByteLength,
  validateSourceReadResult
} from '../src/lib/agentSourceContinuation.js'
import {
  searchWorkspaceSources,
  workspaceSearchSnapshot
} from '../src/lib/agentWorkspaceSearch.js'
import { readDocumentFile } from '../src/lib/fileReader.js'

const owner = Object.freeze({
  ownerKey: 'chat-a\0session-a\0surface-a\0run-a',
  cursorKey: 'cursor-signing-key-with-at-least-32-bytes'
})

const continuationError = (code) => (error) => {
  assert.ok(error instanceof SourceContinuationError)
  assert.equal(error.code, code)
  return true
}

test('opaque source cursors reject tampering, owner changes, option changes and stale revisions', async () => {
  const source = '甲😀乙\nsecond line'
  const revision = await sourceRevisionFingerprint(source)
  const binding = {
    kind: 'document_lines',
    sourceId: 'document:exact-tab-a',
    revision,
    options: { start_line: 1, end_line: 2 },
    position: { byte_offset: 7 },
    ...owner
  }
  const cursor = await createSourceCursor(binding)
  assert.match(cursor, /^[A-Za-z0-9_-]+$/)
  assert.equal(cursor.includes('exact-tab-a'), false)
  assert.equal(cursor.includes(owner.ownerKey), false)

  const decoded = await readSourceCursor(cursor, binding)
  assert.deepEqual(decoded.options, binding.options)
  assert.deepEqual(decoded.position, binding.position)

  const middle = Math.floor(cursor.length / 2)
  const replacement = cursor[middle] === 'A' ? 'B' : 'A'
  const tampered = cursor.slice(0, middle) + replacement + cursor.slice(middle + 1)
  await assert.rejects(readSourceCursor(tampered, binding), continuationError('CURSOR_INVALID'))
  await assert.rejects(readSourceCursor(cursor, { ...binding, ownerKey: `${owner.ownerKey}:other` }), continuationError('CURSOR_INVALID'))
  await assert.rejects(readSourceCursor(cursor, { ...binding, options: { start_line: 2, end_line: 2 } }), continuationError('CURSOR_INVALID'))
  await assert.rejects(readSourceCursor(cursor, { ...binding, revision: await sourceRevisionFingerprint(`${source}!`) }), continuationError('CURSOR_STALE'))
})

test('UTF-8 byte pagination rebuilds CJK and emoji source without replacement or overlap', () => {
  const source = '甲😀乙🥝终'.repeat(37)
  let offset = 0
  let rebuilt = ''
  let pages = 0
  while (true) {
    const page = paginateUtf8Text(source, { byteOffset: offset, byteLimit: 11 })
    assert.equal(page.byteOffset, offset)
    assert.ok(page.bytesRead > 0 && page.bytesRead <= 11)
    assert.doesNotMatch(page.text, /\uFFFD/)
    rebuilt += page.text
    pages++
    if (!page.hasMore) break
    assert.ok(page.nextByteOffset > offset)
    offset = page.nextByteOffset
  }
  assert.ok(pages > 20)
  assert.equal(rebuilt, source)
  assert.equal(offset + Buffer.byteLength(rebuilt.slice(-11), 'utf8') > 0, true)
})

test('an oversized physical line continues on the same line until every byte is exposed', () => {
  const oversized = `前缀${'😀甲'.repeat(80)}后缀`
  const source = `first\n${oversized}\nlast`
  let byteOffset = null
  let rebuilt = ''
  let pages = 0
  while (true) {
    const page = paginateUtf8LineRange(source, {
      startLine: 2,
      endLine: 2,
      byteOffset,
      byteLimit: 29
    })
    assert.equal(page.fragments.length, 1)
    assert.equal(page.fragments[0].line, 2)
    assert.equal(page.fragments[0].byteStart, pages === 0 ? 0 : byteOffset - page.rangeStart)
    rebuilt += page.fragments[0].text
    pages++
    if (!page.hasMore) {
      assert.equal(page.fragments[0].completeLine, pages === 1)
      break
    }
    assert.equal(page.fragments[0].completeLine, false)
    byteOffset = page.nextByteOffset
  }
  assert.ok(pages > 10)
  assert.equal(rebuilt, oversized)
})

test('exact total-lines plus one is an empty EOF page while farther ranges remain invalid', () => {
  const source = Array.from({ length: 56 }, (_, index) => `line-${index + 1}`).join('\n')
  const eof = paginateUtf8LineRange(source, { startLine: 57, endLine: 57, byteLimit: 1024 })
  assert.equal(eof.eof, true)
  assert.equal(eof.totalLines, 56)
  assert.equal(eof.bytesRead, 0)
  assert.equal(eof.hasMore, false)
  assert.deepEqual(eof.fragments, [])
  assert.throws(
    () => paginateUtf8LineRange(source, { startLine: 58, endLine: 58, byteLimit: 1024 }),
    continuationError('SOURCE_RANGE_INVALID')
  )
})

test('PDF page sequences resume inside one page before advancing to later requested pages', () => {
  const pages = [
    { id: 3, text: `page-three-${'甲😀'.repeat(40)}` },
    { id: 8, text: 'page-eight' }
  ]
  let position = { pageIndex: 0, byteOffset: 0 }
  const rebuilt = new Map([[3, ''], [8, '']])
  let sawPartialPage = false
  while (true) {
    const page = paginateUtf8PageSequence(pages, { ...position, byteLimit: 37 })
    for (const fragment of page.fragments) {
      rebuilt.set(fragment.id, rebuilt.get(fragment.id) + fragment.text)
      if (fragment.id === 3 && !fragment.pageComplete) sawPartialPage = true
    }
    if (!page.hasMore) break
    position = page.nextPosition
  }
  assert.equal(sawPartialPage, true)
  assert.equal(rebuilt.get(3), pages[0].text)
  assert.equal(rebuilt.get(8), pages[1].text)
})

test('three-layer grounding never aliases source completeness into legacy complete', () => {
  const contract = createSourceReadContract({
    unit: 'pdf_page',
    returned: 1,
    total: 1,
    truncated: false,
    hasMore: false,
    nextCursor: null,
    requestedRangeComplete: true,
    sourceComplete: false,
    projectionComplete: true,
    coverage: 'source_incomplete'
  })
  assert.equal(contract.grounding.complete, true)
  assert.equal(contract.grounding.source_complete, false)
  assert.equal(contract.grounding.clipped, false)
  assert.deepEqual(validateSourceReadResult(contract), contract)
})

test('literal workspace search scans complete long lines and resumes exact match offsets without duplicates', async () => {
  const longLine = `${'x'.repeat(3000)}NEEDLE ${'y'.repeat(3000)} needle needle`
  const sources = [{ path: 'long.txt', revision: 'r1', text: longLine }]
  const snapshot = workspaceSearchSnapshot(sources)
  let position = null
  const offsets = []
  let calls = 0
  while (true) {
    const result = await searchWorkspaceSources(sources, {
      query: 'needle',
      position,
      expectedSnapshot: snapshot,
      maxMatches: 1,
      maxPerFile: 1,
      timeBudgetMs: 1000,
      regexLineBytes: 128
    })
    for (const file of result.results) for (const hit of file.hits) offsets.push(hit.match_offset)
    calls++
    if (!result.hasMore) {
      assert.equal(result.sourceComplete, true)
      break
    }
    position = result.nextPosition
  }
  assert.ok(calls >= 4)
  assert.deepEqual(offsets, [3000, 6008, 6015])
  assert.equal(new Set(offsets).size, offsets.length)
})

test('regex line limits and workspace snapshot changes are explicit incomplete/stale outcomes', async () => {
  const sources = [{ path: 'huge.txt', revision: 'r1', text: `${'a'.repeat(3000)}needle` }]
  const skipped = await searchWorkspaceSources(sources, {
    query: 'needle',
    isRegex: true,
    regexLineBytes: 256,
    timeBudgetMs: 1000
  })
  assert.equal(skipped.hasMore, false)
  assert.equal(skipped.sourceComplete, false)
  assert.equal(skipped.skippedRegexLines, 1)
  assert.equal(skipped.reason, 'regex_line_limit')

  const stale = await searchWorkspaceSources(sources, {
    query: 'needle',
    expectedSnapshot: workspaceSearchSnapshot([{ path: 'huge.txt', revision: 'older', text: '' }])
  })
  assert.equal(stale.error, 'cursor_stale')
})

test('source revision hashes include all UTF-8 bytes', async () => {
  const left = await sourceRevisionFingerprint('same-prefix-甲')
  const right = await sourceRevisionFingerprint('same-prefix-乙')
  assert.match(left, /^sha256:[a-f0-9]{64}$/)
  assert.notEqual(left, right)
  assert.equal(utf8ByteLength('甲😀'), 7)
})

test('Office fallback extraction preserves numeric archive order, entities and escaped previews', async () => {
  const asFile = (name, bytes) => ({
    name,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  })

  const slides = new JSZip()
  slides.file('ppt/slides/slide10.xml', '<a:p><a:r><a:t>TEN &amp; final</a:t></a:r></a:p>')
  slides.file('ppt/slides/slide2.xml', '<a:p><a:r><a:t>TWO &lt;script&gt;</a:t></a:r></a:p>')
  const pptx = await readDocumentFile(asFile('ordered.pptx', await slides.generateAsync({ type: 'uint8array' })))
  assert.equal(pptx.source_complete, true)
  assert.ok(pptx.text.indexOf('TWO <script>') < pptx.text.indexOf('TEN & final'))
  assert.match(pptx.html, /TWO &lt;script&gt;/)
  assert.doesNotMatch(pptx.html, /<script>/)

  const workbook = new JSZip()
  workbook.file('xl/sharedStrings.xml', '<sst><si><t>A&amp;B&lt;</t></si></sst>')
  workbook.file('xl/worksheets/sheet10.xml', '<worksheet><sheetData><row><c r="A1"><v>10</v></c></row></sheetData></worksheet>')
  workbook.file('xl/worksheets/sheet2.xml', '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>&lt;tag&gt;</t><t>&amp;two</t></is></c></row></sheetData></worksheet>')
  const xlsx = await readDocumentFile(asFile('ordered.xlsx', await workbook.generateAsync({ type: 'uint8array' })))
  assert.equal(xlsx.source_complete, true)
  assert.ok(xlsx.text.indexOf('A&B<') < xlsx.text.indexOf('\n10'))
  assert.match(xlsx.text, /<tag>.*&two/)
  assert.match(xlsx.html, /&lt;tag&gt;/)
  assert.doesNotMatch(xlsx.html, /<tag>/)
  assert.equal(xlsx.source_total_bytes, Buffer.byteLength(xlsx.text, 'utf8'))
})
