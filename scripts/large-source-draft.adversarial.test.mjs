import assert from 'node:assert/strict'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import {
  applyLargeSourcePageDraft,
  applyZeroWidthDeletion,
  buildLargeSourceOffsets,
  estimateLargeSourceDraftCaret,
  findLargeSourcePageByOffset,
  readLargeSourcePage,
  rebalanceLargeSourceView
} from '../src/lib/largeSourceDraft.js'

const makeEightMiBDocument = () => {
  const row = '0123456789abcdef'.repeat(31) + '\n'
  return row.repeat(Math.ceil((8 * 1024 * 1024) / row.length)).slice(0, 8 * 1024 * 1024)
}

test('100 continuous keystrokes mutate only the bounded draft before one full-source commit', () => {
  const source = makeEightMiBDocument()
  const offsets = buildLargeSourceOffsets(source)
  const middlePage = Math.floor((offsets.length - 1) / 2)
  const page = readLargeSourcePage(source, offsets, middlePage)
  assert.ok(page.draft.length <= 68_096)

  let draft = page.draft
  const immutableSource = source
  const started = performance.now()
  for (let index = 0; index < 100; index++) {
    draft += String.fromCharCode(65 + (index % 26))
    // The live 8 MiB source must remain the exact same immutable object until
    // the idle/boundary commit. A per-key splice would fail this invariant.
    assert.equal(source, immutableSource)
  }
  const inputElapsed = performance.now() - started

  const committed = applyLargeSourcePageDraft(source, offsets, middlePage, draft)
  assert.equal(committed.changed, true)
  assert.equal(committed.delta, 100)
  assert.equal(committed.source.length, source.length + 100)
  assert.equal(committed.source.slice(committed.start, committed.end), draft)
  assert.equal(committed.source.slice(0, committed.start), source.slice(0, committed.start))
  assert.equal(committed.source.slice(committed.end), source.slice(page.end))
  assert.ok(inputElapsed < 250, `bounded 100-key draft update took ${inputElapsed.toFixed(1)} ms`)
})

test('page commit adjusts later offsets once and adjacent pages remain byte-exact', () => {
  const source = makeEightMiBDocument()
  const offsets = buildLargeSourceOffsets(source)
  const targetPage = 7
  const current = readLargeSourcePage(source, offsets, targetPage)
  const following = readLargeSourcePage(source, offsets, targetPage + 1)
  const prefix = 'LOCAL-EDIT\n'
  const committed = applyLargeSourcePageDraft(source, offsets, targetPage, prefix + current.draft)

  assert.equal(committed.offsets[targetPage], offsets[targetPage])
  assert.equal(committed.offsets[targetPage + 1], offsets[targetPage + 1] + prefix.length)
  assert.equal(
    readLargeSourcePage(committed.source, committed.offsets, targetPage + 1).draft,
    following.draft
  )

  const idempotent = applyLargeSourcePageDraft(
    committed.source,
    committed.offsets,
    targetPage,
    prefix + current.draft
  )
  assert.equal(idempotent.changed, false)
  assert.equal(idempotent.source, committed.source)
  assert.equal(idempotent.offsets, committed.offsets)
})
test('a multi-megabyte paste is rebalanced into bounded pages and preserves the caret anchor', () => {
  const source = makeEightMiBDocument()
  const offsets = buildLargeSourceOffsets(source)
  const page = readLargeSourcePage(source, offsets, 3)
  const pasted = 'P'.repeat(2_000_000)
  const draft = page.draft.slice(0, 50) + pasted + page.draft.slice(50)
  const localCaret = 50 + pasted.length
  const committed = applyLargeSourcePageDraft(source, offsets, page.page, draft)
  const rebalanced = rebalanceLargeSourceView(
    committed.source,
    committed.offsets,
    committed.page,
    localCaret
  )

  assert.ok(rebalanced)
  assert.ok(rebalanced.draft.length <= 68_096)
  assert.ok(rebalanced.offsets.length > offsets.length)
  const globalCaret = rebalanced.start + rebalanced.caret
  assert.equal(globalCaret, committed.start + localCaret)
  assert.equal(committed.source.slice(globalCaret - 8, globalCaret), 'P'.repeat(8))
})

test('chunk boundaries prefer headings and never split fenced code blocks', () => {
  const fenceBody = 'inside fence\n'.repeat(8_000)
  const source = `# First\n\n${'before\n'.repeat(4_000)}\n\`\`\`mermaid\n${fenceBody}\`\`\`\n\n# After fence\nTail`
  const offsets = buildLargeSourceOffsets(source, 32_000, 2_000)
  assert.equal(offsets[0], 0)
  assert.equal(offsets.at(-1), source.length)
  assert.equal(offsets.slice(0, -1).map((start, index) => source.slice(start, offsets[index + 1])).join(''), source)
  const fenceStart = source.indexOf('```mermaid')
  const fenceEnd = source.indexOf('```', fenceStart + 3) + 3
  assert.equal(offsets.some((offset) => offset > fenceStart && offset < fenceEnd), false)
  const headingSource = `${'ordinary line\n'.repeat(7)}# Preferred boundary\n${'tail\n'.repeat(40)}`
  const headingOffset = headingSource.indexOf('# Preferred boundary')
  const headingOffsets = buildLargeSourceOffsets(headingSource, 64, 64)
  assert.equal(headingOffsets[1], headingOffset)
})

test('an unclosed fence remains one atomic trailing chunk', () => {
  const source = `# Intro\n\n${'x\n'.repeat(100)}\`\`\`ts\n${'const x = 1\n'.repeat(20_000)}`
  const offsets = buildLargeSourceOffsets(source, 8_000, 512)
  const fenceStart = source.indexOf('```ts')
  assert.equal(offsets.some((offset) => offset > fenceStart && offset < source.length), false)
  assert.equal(offsets.at(-1), source.length)
})

test('a giant non-fenced line uses bounded fallback chunks without splitting surrogate pairs', () => {
  const unit = 'A😀'
  const source = unit.repeat(400_000)
  const offsets = buildLargeSourceOffsets(source, 64_000, 4_096)
  assert.ok(offsets.length > 10)
  for (let index = 0; index < offsets.length - 1; index++) {
    const chunk = source.slice(offsets[index], offsets[index + 1])
    assert.ok(chunk.length <= 64_001)
    assert.doesNotMatch(chunk, /[\uD800-\uDBFF]$/)
    assert.doesNotMatch(chunk, /^[\uDC00-\uDFFF]/)
  }
  assert.equal(offsets.slice(0, -1).map((start, index) => source.slice(start, offsets[index + 1])).join(''), source)
})

test('structurally dense Markdown caps lines per rich chunk while keeping fences atomic', () => {
  const source = `${'# Heading\nbody\nblank\n'.repeat(8_000)}\`\`\`txt\n${'inside\n'.repeat(2_500)}\`\`\`\n`
  const offsets = buildLargeSourceOffsets(source)
  assert.ok(offsets.length > 10)
  const fenceStart = source.indexOf('```txt')
  const fenceEnd = source.indexOf('```', fenceStart + 3) + 3
  assert.equal(offsets.some((offset) => offset > fenceStart && offset < fenceEnd), false)
  for (let index = 0; index < offsets.length - 2; index++) {
    const chunk = source.slice(offsets[index], offsets[index + 1])
    if (chunk.includes('```txt')) continue
    assert.ok((chunk.match(/\n/g) || []).length <= 1_800)
  }
})

test('changed-draft caret tracks insertions, replacements, and deletions', () => {
  assert.equal(estimateLargeSourceDraftCaret('abcXYZdef', 'abc123XYZdef'), 6)
  assert.equal(estimateLargeSourceDraftCaret('abcXYZdef', 'abcQdef'), 4)
  assert.equal(estimateLargeSourceDraftCaret('abcXYZdef', 'abcdef'), 3)
  assert.equal(estimateLargeSourceDraftCaret('same', 'same'), 4)
})

test('deleting a whole chunk removes duplicate boundaries during rebalance', () => {
  const source = `${'# Section\nbody\n\n'.repeat(2_000)}tail\n`
  const offsets = buildLargeSourceOffsets(source, 4_000, 512)
  const page = 2
  const committed = applyLargeSourcePageDraft(source, offsets, page, '')
  const rebalanced = rebalanceLargeSourceView(committed.source, committed.offsets, page, 0, 4_000)
  assert.ok(rebalanced)
  assert.equal(new Set(rebalanced.offsets).size, rebalanced.offsets.length)
  assert.equal(rebalanced.offsets.at(-1), committed.source.length)
})

test('source offsets map boundaries to the chunk on the right', () => {
  const source = `${'# A\ntext\n\n'.repeat(2_000)}# Last\n`
  const offsets = buildLargeSourceOffsets(source, 4_000, 512)
  assert.ok(offsets.length > 3)
  const boundary = offsets[2]
  assert.equal(findLargeSourcePageByOffset(offsets, boundary), 2)
  assert.equal(findLargeSourcePageByOffset(offsets, boundary - 1), 1)
})

test('zero-width deletion applies to the bounded value supplied by the caller', () => {
  assert.deepEqual(applyZeroWidthDeletion('before\n\u200bafter', 8, 8, 'Backspace'), {
    value: 'beforeafter',
    caret: 6
  })
  assert.deepEqual(applyZeroWidthDeletion('before\u200b\nafter', 6, 6, 'Delete'), {
    value: 'beforeafter',
    caret: 6
  })
  assert.equal(applyZeroWidthDeletion('a\u200bb', 0, 2, 'Delete'), null)
})
