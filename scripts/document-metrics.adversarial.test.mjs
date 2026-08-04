import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { analyzeDocumentChunked, countDocumentStatsChunked, extractOutlineChunked, filterOutlineItemsForSidebar } from '../src/lib/documentMetrics.js'

test('large statistics scan yields repeatedly and keeps marker semantics', async () => {
  const paragraph = 'alpha beta gamma\n'
  const source = `${paragraph.repeat(70_000)}![embedded](knote-img:abc)\n::: align:center :::\nlast word`
  let yields = 0
  const result = await countDocumentStatsChunked(source, {
    chunkSize: 4096,
    yieldControl: async () => { yields++ }
  })
  assert.ok(yields > 200, `expected a chunked scan, got only ${yields} yields`)
  assert.deepEqual(result, {
    chars: paragraph.length * 70_000 + 1 + 'last word'.length,
    lines: 70_001,
    words: 210_002
  })
})

test('statistics scan is cancellable between bounded chunks', async () => {
  let yields = 0
  const result = await countDocumentStatsChunked('word '.repeat(300_000), {
    chunkSize: 2048,
    shouldCancel: () => yields >= 3,
    yieldControl: async () => { yields++ }
  })
  assert.equal(result, null)
  assert.equal(yields, 3)
})

test('outline scan yields, ignores fenced headings, and caps giant labels', async () => {
  const giant = `# ${'x'.repeat(400_000)}\n`
  const source = `${giant}# Visible\n\`\`\`md\n# Hidden\n\`\`\`\n## Last\n${'plain\n'.repeat(100_000)}`
  let yields = 0
  const rows = await extractOutlineChunked(source, {
    chunkSize: 4096,
    yieldControl: async () => { yields++ }
  })
  assert.ok(yields > 200, `expected a chunked outline scan, got only ${yields} yields`)
  assert.equal(rows.length, 3)
  assert.equal(rows[1].text, 'Visible')
  assert.equal(rows[2].text, 'Last')
  assert.ok(rows[0].text.endsWith('…'))
  assert.ok(rows[0].text.length <= 2050)
})

test('outline entries include exact UTF-16 source offsets for chunk navigation', async () => {
  const source = '😀 prefix\n# First\nbody\n\n## Second\n'
  const result = await analyzeDocumentChunked(source, {
    includeStats: false,
    includeMissingImages: false,
    includeOutline: true,
    chunkSize: 5
  })
  assert.deepEqual(result.outline.map((item) => item.offset), [source.indexOf('# First'), source.indexOf('## Second')])
})

test('one pass supplies stats, bounded outline and unique missing-image validation', async () => {
  const source = [
    '# Visible',
    'alpha beta',
    '![one](knote-img:missing)',
    '![again](knote-img:missing)',
    '![known](knote-img:known)',
    ...Array.from({ length: 20 }, (_, index) => `## Heading ${index}`)
  ].join('\n')
  let yields = 0
  const result = await analyzeDocumentChunked(source, {
    chunkSize: 32,
    includeOutline: true,
    maxOutlineItems: 5,
    hasImage: (id) => id === 'known',
    yieldControl: async () => { yields++ }
  })
  assert.ok(yields > 0)
  assert.equal(result.missingImageCount, 1)
  assert.equal(result.outline.length, 5)
  assert.equal(result.outlineTruncated, true)
  assert.ok(result.stats.chars > 0)
  assert.ok(result.stats.words > 0)
})

test('8 MiB combined analysis performs one bounded walk instead of two full walks', async (t) => {
  const unit = '# Heading\nalpha beta gamma delta\nplain text\n'
  const source = unit.repeat(Math.ceil((8 * 1024 * 1024) / unit.length)).slice(0, 8 * 1024 * 1024)
  const chunkSize = 48_000
  let combinedYields = 0
  let maxTurnMs = 0
  let turnStarted = performance.now()
  const started = performance.now()
  const combined = await analyzeDocumentChunked(source, {
    chunkSize,
    includeOutline: true,
    maxOutlineItems: 4_000,
    yieldControl: async () => {
      const now = performance.now()
      maxTurnMs = Math.max(maxTurnMs, now - turnStarted)
      combinedYields++
      turnStarted = performance.now()
    }
  })
  maxTurnMs = Math.max(maxTurnMs, performance.now() - turnStarted)
  const elapsedMs = performance.now() - started

  let separateYields = 0
  await countDocumentStatsChunked(source, {
    chunkSize,
    yieldControl: async () => { separateYields++ }
  })
  await extractOutlineChunked(source, {
    chunkSize,
    maxOutlineItems: 4_000,
    yieldControl: async () => { separateYields++ }
  })

  assert.ok(combined.stats.chars > 8_000_000)
  assert.equal(combined.outline.length, 4_000)
  assert.equal(combined.outlineTruncated, true)
  assert.ok(combinedYields > 100)
  assert.ok(separateYields >= combinedYields * 2 - 2,
    `combined=${combinedYields}, separate=${separateYields}`)
  assert.ok(maxTurnMs < 100, `analysis monopolized one turn for ${maxTurnMs.toFixed(1)}ms`)
  t.diagnostic(`8MiB combined analysis: ${elapsedMs.toFixed(1)}ms total, ${combinedYields} yields, max synchronous turn ${maxTurnMs.toFixed(1)}ms; separate passes require ${separateYields} yields`)
})

const outlineFixture = [
  { id: 'a', level: 1, text: 'A' },
  { id: 'a1', level: 2, text: 'A.1' },
  { id: 'a1a', level: 3, text: 'A.1.a' },
  { id: 'a2', level: 2, text: 'A.2' },
  { id: 'b', level: 1, text: 'B' },
  { id: 'b1', level: 2, text: 'B.1' },
  { id: 'c', level: 1, text: 'C' },
  { id: 'c1', level: 2, text: 'C.1' }
]

test('sidebar outline collapse hides descendants while the heading bar stays', () => {
  const { visible, hasChildren } = filterOutlineItemsForSidebar(outlineFixture, new Set(['a']), 10_000)
  assert.deepEqual(visible.map((item) => item.id), ['a', 'b', 'b1', 'c', 'c1'])
  assert.deepEqual(hasChildren, new Set(['a', 'a1', 'b', 'c']))
})

test('collapsing a leaf heading hides nothing', () => {
  const { visible } = filterOutlineItemsForSidebar(outlineFixture, new Set(['a1a', 'b1']), 10_000)
  assert.deepEqual(visible.map((item) => item.id), outlineFixture.map((item) => item.id))
})

test('nested collapses hide the whole subtree and expanding restores it', () => {
  const collapsed = filterOutlineItemsForSidebar(outlineFixture, new Set(['a', 'b']), 10_000)
  assert.deepEqual(collapsed.visible.map((item) => item.id), ['a', 'b', 'c', 'c1'])
  const restored = filterOutlineItemsForSidebar(outlineFixture, new Set(['a']), 10_000)
  assert.deepEqual(restored.visible.map((item) => item.id), ['a', 'b', 'b1', 'c', 'c1'])
})

test('the progressive render limit applies after collapse filtering', () => {
  const { visible } = filterOutlineItemsForSidebar(outlineFixture, new Set(['a']), 3)
  assert.deepEqual(visible.map((item) => item.id), ['a', 'b', 'b1'])
  const uncapped = filterOutlineItemsForSidebar(outlineFixture, new Set(), 10_000)
  assert.equal(uncapped.visible.length, outlineFixture.length)
})

test('malformed or empty outline input degrades to an empty list', () => {
  const empty = filterOutlineItemsForSidebar(null, new Set(), 10)
  assert.deepEqual(empty.visible, [])
  const mixed = filterOutlineItemsForSidebar([null, { id: 'x', level: 1 }, 'junk', { id: 'y', level: 2 }], new Set(), 10)
  assert.deepEqual(mixed.visible.map((item) => item.id), ['x', 'y'])
  assert.deepEqual(mixed.hasChildren, new Set(['x']))
})
