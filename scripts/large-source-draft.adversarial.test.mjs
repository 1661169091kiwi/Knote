import assert from 'node:assert/strict'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import {
  applyLargeSourcePageDraft,
  applyZeroWidthDeletion,
  buildLargeSourceOffsets,
  estimateLargeSourceDraftCaret,
  findLargeSourcePageByOffset,
  largeSourceDraftEditChangesStructure,
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
  const prefix = 'LOCAL-EDIT'
  const committed = applyLargeSourcePageDraft(source, offsets, targetPage, prefix + current.draft)

  assert.equal(committed.requiresOffsetRebuild, false)
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

test('structural page edits rebuild stale boundaries and preserve the global caret', () => {
  const source = `# Intro\n\n~~~js\n${'inside fence\n'.repeat(6)}~~~\n\n# After\n${'tail row\n'.repeat(120)}`
  const offsets = buildLargeSourceOffsets(source, 96, 16, 20)
  const closeOffset = source.indexOf('~~~', source.indexOf('~~~') + 3)
  const pageIndex = findLargeSourcePageByOffset(offsets, closeOffset)
  const page = readLargeSourcePage(source, offsets, pageIndex)
  const localClose = closeOffset - page.start
  const draft = page.draft.slice(0, localClose) + page.draft.slice(localClose + 3)
  const committed = applyLargeSourcePageDraft(source, offsets, pageIndex, draft)

  assert.equal(committed.requiresOffsetRebuild, true)
  assert.ok(committed.offsets.some((offset) => offset > source.indexOf('~~~') && offset < committed.source.length))
  const rebalanced = rebalanceLargeSourceView(
    committed.source,
    committed.offsets,
    committed.page,
    localClose,
    96,
    committed.requiresOffsetRebuild
  )
  assert.ok(rebalanced)
  assert.equal(rebalanced.start + rebalanced.caret, committed.start + localClose)
  const openFence = committed.source.indexOf('~~~')
  assert.equal(rebalanced.offsets.some((offset) => offset > openFence && offset < committed.source.length), false)
  assert.equal(rebalanced.offsets.at(-1), committed.source.length)
})

test('deleting a page-boundary newline invalidates offsets but ordinary text typing does not', () => {
  assert.equal(largeSourceDraftEditChangesStructure('alpha beta', 'alpha brave beta'), false)
  assert.equal(largeSourceDraftEditChangesStructure('alpha\nbeta', 'alphabeta'), true)

  const source = 'plain row\n'.repeat(160)
  const offsets = buildLargeSourceOffsets(source, 72, 12, 20)
  const pageIndex = offsets.findIndex((offset, index) => (
    index < offsets.length - 1 &&
    source.slice(offset, offsets[index + 1]).endsWith('\n') &&
    offsets[index + 1] < source.length
  ))
  assert.ok(pageIndex >= 0)
  const page = readLargeSourcePage(source, offsets, pageIndex)
  const draft = page.draft.slice(0, -1)
  const committed = applyLargeSourcePageDraft(source, offsets, pageIndex, draft)
  const staleSeam = committed.start + draft.length

  assert.equal(committed.requiresOffsetRebuild, true)
  assert.equal(committed.offsets[pageIndex + 1], staleSeam)
  const rebalanced = rebalanceLargeSourceView(
    committed.source,
    committed.offsets,
    committed.page,
    draft.length,
    72,
    committed.requiresOffsetRebuild
  )
  assert.ok(rebalanced)
  assert.equal(rebalanced.start + rebalanced.caret, staleSeam)
  assert.equal(rebalanced.offsets.includes(staleSeam), false)
  assert.equal(rebalanced.offsets.slice(0, -1).map((start, index) => (
    committed.source.slice(start, rebalanced.offsets[index + 1])
  )).join(''), committed.source)
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

test('frontmatter is atomic only with a valid closing delimiter', () => {
  const valid = `---\ntitle: bounded\ntags:\n  - test\n---\n# Body\n${'tail\n'.repeat(50)}`
  const validClose = valid.indexOf('---', 3) + 3
  const validOffsets = buildLargeSourceOffsets(valid, 16, 4, 10)
  assert.equal(validOffsets.some((offset) => offset > 0 && offset < validClose), false)

  const unclosed = `---\n${'ordinary horizontal-rule document row\n'.repeat(90_000)}`
  assert.ok(unclosed.length > 2 * 1024 * 1024)
  const offsets = buildLargeSourceOffsets(unclosed)
  assert.ok(offsets.length > 100)
  assert.ok(offsets[1] < unclosed.length)
  assert.equal(offsets.at(-1), unclosed.length)
  assert.equal(offsets.slice(0, -1).map((start, index) => (
    unclosed.slice(start, offsets[index + 1])
  )).join(''), unclosed)
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

test('oversized inline links and code spans remain whole while plain giant lines stay bounded', () => {
  const link = `[large](https://example.test/resource/${'a'.repeat(150_000)})`
  const code = `\`${'const-value-'.repeat(14_000)}\``
  const source = `plain-prefix ${link} plain-middle ${code} plain-suffix`
  const linkStart = source.indexOf(link)
  const linkEnd = linkStart + link.length
  const codeStart = source.indexOf(code)
  const codeEnd = codeStart + code.length
  const offsets = buildLargeSourceOffsets(source, 64_000, 4_096)

  assert.equal(offsets.some((offset) => offset > linkStart && offset < linkEnd), false)
  assert.equal(offsets.some((offset) => offset > codeStart && offset < codeEnd), false)
  assert.equal(offsets.slice(0, -1).map((start, index) => (
    source.slice(start, offsets[index + 1])
  )).join(''), source)

  const linkPageIndex = findLargeSourcePageByOffset(offsets, linkStart + 10)
  const linkPage = readLargeSourcePage(source, offsets, linkPageIndex)
  const editAt = linkPage.draft.indexOf('/resource/') + '/resource/'.length
  const draft = linkPage.draft.slice(0, editAt) + 'b' + linkPage.draft.slice(editAt + 1)
  const committed = applyLargeSourcePageDraft(source, offsets, linkPageIndex, draft)
  assert.equal(committed.requiresOffsetRebuild, false)
  assert.equal(committed.offsets.some((offset) => offset > linkStart && offset < linkEnd), false)
  assert.equal(committed.source.slice(committed.start, committed.end), draft)
  assert.equal(committed.source.slice(0, committed.start), source.slice(0, committed.start))
  assert.equal(committed.source.slice(committed.end), source.slice(linkPage.end))
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
    assert.ok((chunk.match(/\n/g) || []).length <= 600)
  }
})

test('short dense Markdown honors the line cap even below the character target', () => {
  const source = 'row\n'.repeat(7_000)
  const offsets = buildLargeSourceOffsets(source)
  assert.ok(offsets.length > 10)
  for (let index = 0; index < offsets.length - 1; index++) {
    const chunk = source.slice(offsets[index], offsets[index + 1])
    assert.ok((chunk.match(/\n/g) || []).length <= 600)
  }
  assert.equal(offsets.slice(0, -1).map((start, index) => source.slice(start, offsets[index + 1])).join(''), source)
})

test('a table larger than the line target remains one indivisible Markdown block', () => {
  const table = `| Row | Value |\n| --- | --- |\n${Array.from(
    { length: 700 },
    (_, index) => `| ${index} | table-${index} |\n`
  ).join('')}`
  const source = `# Intro\n\n${'lead\n'.repeat(20)}\n${table}\n# Tail\nDone\n`
  const tableStart = source.indexOf('| Row | Value |')
  const tableEnd = tableStart + table.length
  const offsets = buildLargeSourceOffsets(source, 512, 64, 600)
  assert.equal(offsets.some((offset) => offset > tableStart && offset < tableEnd), false)
  const tablePage = findLargeSourcePageByOffset(offsets, tableStart)
  const tableChunk = source.slice(offsets[tablePage], offsets[tablePage + 1])
  assert.ok((tableChunk.match(/\n/g) || []).length > 600)
})

test('a valid one-column GFM table remains one indivisible Markdown block', () => {
  const table = `| Value |\n| --- |\n${Array.from(
    { length: 700 },
    (_, index) => `| row-${index} |\n`
  ).join('')}`
  const source = `# Intro\n\n${table}\n# Tail\n`
  const tableStart = source.indexOf('| Value |')
  const tableEnd = tableStart + table.length
  const offsets = buildLargeSourceOffsets(source, 512, 64, 600)

  assert.equal(offsets.some((offset) => offset > tableStart && offset < tableEnd), false)
  assert.equal(offsets.slice(0, -1).map((start, index) => (
    source.slice(start, offsets[index + 1])
  )).join(''), source)
})

test('lists, blockquotes, HTML, math, and indented code stay atomic across chunk targets', () => {
  const fixtures = [
    {
      name: 'loose list',
      block: Array.from({ length: 240 }, (_, index) => `- item ${index}\n\n  continuation ${index}\n`).join('')
    },
    {
      name: 'blockquote',
      block: Array.from({ length: 700 }, (_, index) => `> quoted line ${index}\n`).join('')
    },
    {
      name: 'HTML block',
      block: `<div class="fixture">\n${Array.from({ length: 700 }, (_, index) => `<p>row ${index}</p>\n`).join('')}</div>\n`
    },
    {
      name: 'display math',
      block: `$$\n${Array.from({ length: 700 }, (_, index) => `x_{${index}} + y_{${index}}\n`).join('')}$$\n`
    },
    {
      name: 'indented code',
      block: Array.from({ length: 700 }, (_, index) => `    const value${index} = ${index}\n`).join('')
    }
  ]

  for (const fixture of fixtures) {
    const source = `before\n\n${fixture.block}\n# After\ntail\n`
    const start = source.indexOf(fixture.block)
    const end = start + fixture.block.length
    const offsets = buildLargeSourceOffsets(source, 128, 32, 50)
    assert.equal(
      offsets.some((offset) => offset > start && offset < end),
      false,
      `${fixture.name} was split at ${offsets.find((offset) => offset > start && offset < end)}`
    )
    assert.equal(offsets.at(-1), source.length)
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
