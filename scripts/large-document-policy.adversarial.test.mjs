import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  inspectLargeDocumentShape,
  shouldUsePagedSource,
  LARGE_SOURCE_CHUNK_SIZE,
  CONTINUOUS_DOCUMENT_CHAR_LIMIT,
  CONTINUOUS_DOCUMENT_COMPLEXITY_LIMIT,
  OFFSCREEN_BLOCK_SKIP_MIN_CHARS
} from '../src/lib/largeDocumentPolicy.js'
import {
  searchPattern,
  visibleSourceRanges,
  countSourceMatches,
  replaceSourceMatches
} from '../src/lib/largeDocumentFind.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const makeArchitectureFixture = () => {
  const lines = []
  for (let section = 0; section < 161; section++) {
    lines.push(`# Module ${section}`)
    lines.push(`## Data flow ${section}`)
    lines.push('| component | responsibility |')
    lines.push('| --- | --- |')
    lines.push('```mermaid')
    lines.push(`graph TD; A${section}-->B${section}`)
    lines.push('```')
    for (let row = 0; row < 45; row++) {
      lines.push(`Architecture note ${section}.${row}: flow and state.`)
    }
  }
  return lines.join('\n')
}

test('a 350k-class architecture document with many diagrams stays in the continuous editor', () => {
  // diagrams are drawn lazily (near the viewport, one at a time while the
  // reader pauses), so they no longer push a document into paging
  const source = makeArchitectureFixture()
  const shape = inspectLargeDocumentShape(source)
  assert.ok(shape.characters > 280_000 && shape.characters < 450_000)
  assert.ok(shape.lines > 8_000)
  assert.equal(shape.mermaidFences, 161)
  assert.ok(shape.complexity < CONTINUOUS_DOCUMENT_COMPLEXITY_LIMIT, String(shape.complexity))
  assert.equal(shape.usePagedSource, false)
})

test('simple prose shorter than a single chunk stays in the whole-document editor', () => {
  const source = 'plain prose '.repeat(2_000)
  assert.ok(source.length < LARGE_SOURCE_CHUNK_SIZE)
  assert.equal(shouldUsePagedSource(source), false)
})

test('long documents stay in one continuous editor until the continuous limits', () => {
  // longer than a chunk is no longer a reason to page
  const prose = 'plain prose '.repeat(4_000)
  assert.ok(prose.length > LARGE_SOURCE_CHUNK_SIZE)
  assert.equal(shouldUsePagedSource(prose), false)
  // long simple prose: continuous up to the character limit, paged past it
  const paragraph = 'Plain prose sentence for a long essay without much structure. '.repeat(8) + '\n\n'
  const below = paragraph.repeat(Math.floor((CONTINUOUS_DOCUMENT_CHAR_LIMIT - 1) / paragraph.length))
  assert.ok(inspectLargeDocumentShape(below).complexity < CONTINUOUS_DOCUMENT_COMPLEXITY_LIMIT)
  assert.equal(shouldUsePagedSource(below), false)
  assert.equal(shouldUsePagedSource(below + paragraph.repeat(2)), true)
  // dense notes page on structure first (~2.8 complexity per character)
  const note = (n) => [`## Section ${n}`, '', 'Body text for a dense note. '.repeat(6), '', '| a | b |', '| --- | --- |', `| ${n} | x |`, '', '```js', `const n = ${n}`, '```', ''].join('\n')
  let dense = ''
  for (let n = 0; inspectLargeDocumentShape(dense).complexity < CONTINUOUS_DOCUMENT_COMPLEXITY_LIMIT; n += 1) dense += note(n)
  assert.ok(dense.length < CONTINUOUS_DOCUMENT_CHAR_LIMIT, 'structure, not length, pages dense notes')
  assert.equal(shouldUsePagedSource(dense), true)
  // paged editing still uses 32k chunks; long documents skip off-screen blocks from there
  assert.equal(LARGE_SOURCE_CHUNK_SIZE, 32_000)
  assert.equal(OFFSCREEN_BLOCK_SKIP_MIN_CHARS, LARGE_SOURCE_CHUNK_SIZE)
})

test('explicit limits (E2E) page a modest document', () => {
  const prose = 'plain prose '.repeat(4_000)
  assert.equal(shouldUsePagedSource(prose, { chars: 32_000 }), true)
  assert.equal(shouldUsePagedSource(prose, { chars: 0 }), false, 'a non-positive limit falls back to the default')
  assert.equal(shouldUsePagedSource('# a\n\nb', { complexity: 10 }), true)
})

test('four-space indented examples are not mistaken for Markdown fences', () => {
  const shape = inspectLargeDocumentShape('    ```mermaid\n    graph TD\n    ```')
  assert.equal(shape.fenceMarkers, 0)
  assert.equal(shape.mermaidFences, 0)
})

test('the hard safety limit still pages unstructured million-character input', () => {
  assert.equal(shouldUsePagedSource('x'.repeat(1_000_000)), true)
})

test('hard-limit documents return before any line scan while preserving the result shape', () => {
  const originalIndexOf = String.prototype.indexOf
  let indexOfCalls = 0
  let shape
  String.prototype.indexOf = function (...args) {
    indexOfCalls++
    return originalIndexOf.apply(this, args)
  }
  try {
    shape = inspectLargeDocumentShape('x'.repeat(8 * 1024 * 1024))
  } finally {
    String.prototype.indexOf = originalIndexOf
  }
  assert.equal(indexOfCalls, 0)
  assert.deepEqual(Object.keys(shape).sort(), [
    'characters', 'complexity', 'fenceMarkers', 'headings', 'lines',
    'mermaidFences', 'tableRows', 'usePagedSource'
  ])
  assert.equal(shape.characters, 8 * 1024 * 1024)
  assert.equal(shape.complexity, shape.characters)
  assert.equal(shape.lines, 0)
  assert.equal(shape.usePagedSource, true)
})

test('every App entry point uses the same adaptive policy', () => {
  const app = fs.readFileSync(path.join(here, '..', 'src', 'App.vue'), 'utf8')
  assert.match(app, /import \{ shouldUsePagedSource(?:, LARGE_SOURCE_CHUNK_SIZE)? \} from '\.\/lib\/largeDocumentPolicy\.js'/)
  assert.match(app, /const plain = shouldUsePagedSource\(nextContent, pagingLimits\(\)\)/)
  assert.equal((app.match(/shouldUsePagedSource\(/g) || []).length, 1, 'large-document policy should be centralized in stageLargeEditorLoad')
  assert.match(app, /const editorLoad = stageLargeEditorLoad\(nextContent/)
  assert.match(app, /const editorLoad = stageLargeEditorLoad\(tb\.content/)
  assert.doesNotMatch(app, /LARGE_DOCUMENT_PLAIN_THRESHOLD/)
  assert.match(app, /data-large-document-mode="largeDocumentPlainMode \? 'chunked-rich' : 'off'"/)
  assert.match(app, /data-testid="large-document-rich-chunk"/)
  assert.match(app, /:content-key="largeSourceEditorVersion"/)
  assert.doesNotMatch(app, /data-testid="large-document-source"/)
})

test('find across a paged document counts and replaces the words a reader sees, not the syntax around them', () => {
  const source = [
    '# Report on the report',
    '',
    'A [report link](https://example.com/report.md) and ![report chart](assets/report.png).',
    '',
    '<span class="report">inline report</span> <https://report.example.com>',
    '',
    '```js',
    'const report = 1',
    '```'
  ].join('\n')
  const pattern = searchPattern('report')
  // heading x2, the link's text, the span's text, the code: the address, the
  // image (alt and file), the tag's attribute and the autolink do not count
  assert.equal(countSourceMatches(source, pattern), 5)
  const { text, replaced } = replaceSourceMatches(source, pattern, 'memo')
  assert.equal(replaced, 5)
  assert.match(text, /^# memo on the memo$/m)
  assert.match(text, /\[memo link\]\(https:\/\/example\.com\/report\.md\)/)
  assert.match(text, /!\[report chart\]\(assets\/report\.png\)/)
  assert.match(text, /<span class="report">inline memo<\/span> <https:\/\/report\.example\.com>/)
  assert.match(text, /const memo = 1/)
  // every visible range together with the hidden ones is the whole source
  const ranges = visibleSourceRanges(source)
  assert.ok(ranges.every(([from, to], index) => from < to && (index === 0 || ranges[index - 1][1] < from)))
})

test('find options match the editor: case, whole words, literal queries and replacements', () => {
  assert.equal(countSourceMatches('Alpha alpha ALPHA', searchPattern('alpha')), 3)
  assert.equal(countSourceMatches('Alpha alpha ALPHA', searchPattern('alpha', { caseSensitive: true })), 1)
  assert.equal(countSourceMatches('cat category scat cat.', searchPattern('cat', { wholeWord: true })), 2)
  assert.equal(countSourceMatches('a+b (a+b) [x]', searchPattern('a+b')), 2)
  assert.equal(searchPattern(''), null)
  assert.equal(countSourceMatches('anything', null), 0)
  // `$&` in a replacement is literal text, as in the editor
  assert.equal(replaceSourceMatches('price', searchPattern('price'), '$& $1').text, '$& $1')
})

test('counting every chunk of a multi-megabyte document stays quick', () => {
  const chunk = '## Section\n\nalpha beta [gamma](https://x.test/gamma) delta gamma\n\n'.repeat(400)
  const chunks = Array.from({ length: 256 }, () => chunk)
  const pattern = searchPattern('gamma')
  const started = performance.now()
  const total = chunks.reduce((sum, text) => sum + countSourceMatches(text, pattern), 0)
  const elapsed = performance.now() - started
  assert.equal(total, 256 * 400 * 2)
  assert.ok(elapsed < 1500, `counting ${chunks.length} chunks took ${elapsed.toFixed(1)}ms`)
})
