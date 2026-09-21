// The write-back's foundation: every top-level block must know the DOCUMENT
// lines it came from. If a tag lands on the wrong line, an edit rewrites the
// wrong lines — so these checks are about exactness, not about plausibility.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import MarkdownIt from 'markdown-it'
import { toInternalMapped } from '../src/lib/emptyRows.js'
import { installKnoteMarkdownRawHtml, RAW_HTML_BLOCK_ATTR } from '../src/lib/markdownRawHtml.js'
import { installKnoteMarkdownFrontmatter, FRONTMATTER_ATTR } from '../src/lib/markdownFrontmatter.js'
import {
  SLINE_ATTR,
  ELINE_ATTR,
  installKnoteSourceLineTags,
  installKnoteSourceLineFence,
  withSourceLineMap,
  outermostTokenSpans,
  isolateLines,
  applySourceLineEdits
} from '../src/lib/markdownSourceLines.js'

const makeMarkdown = () => {
  const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
  installKnoteMarkdownRawHtml(md)
  installKnoteMarkdownFrontmatter(md)
  installKnoteSourceLineTags(md)
  installKnoteSourceLineFence(md)
  return md
}

// Every element the parser produced, with the lines it claims.
const tagsOf = (html) => {
  const out = []
  const re = new RegExp(`<([a-z0-9]+)([^>]*?)${SLINE_ATTR}="(\\d+)"(?:[^>]*?${ELINE_ATTR}="(\\d+)")?`, 'gi')
  let match
  while ((match = re.exec(html))) out.push({ tag: match[1].toLowerCase(), start: Number(match[3]), end: match[4] ? Number(match[4]) : Number(match[3]) })
  return out
}

// Render a document the way the editor's parser does: internal form in, tags
// translated back to document lines.
const render = (md, source) => {
  const { internal, internalToDoc } = toInternalMapped(source)
  return withSourceLineMap(internalToDoc, () => md.render(internal))
}

test('every top-level block is tagged with the document lines it came from', () => {
  const md = makeMarkdown()
  const source = ['# 标题', '', '第一段。', '', '- 甲', '- 乙', '', '> 引用', '', '```js', 'const x = 1', '```'].join('\n')
  const tags = tagsOf(render(md, source))
  assert.deepEqual(tags, [
    { tag: 'h1', start: 0, end: 0 },
    // the blank row after the heading is a row of its own
    { tag: 'p', start: 1, end: 1 },
    { tag: 'p', start: 2, end: 2 },
    { tag: 'p', start: 3, end: 3 },
    { tag: 'ul', start: 4, end: 6 },
    { tag: 'p', start: 6, end: 6 },
    { tag: 'blockquote', start: 7, end: 7 },
    { tag: 'p', start: 8, end: 8 },
    { tag: 'pre', start: 9, end: 11 }
  ])
})

test('only top-level blocks are tagged, never nested ones', () => {
  const md = makeMarkdown()
  const source = ['- 甲', '  - 乙', '', '> 引用里的段落', '>', '> 第二段'].join('\n')
  const html = render(md, source)
  // the blank row between the list and the quote is a row of its own, so it is
  // tagged too — nothing INSIDE the list or the quote is
  const tags = tagsOf(html)
  assert.deepEqual(tags, [
    { tag: 'ul', start: 0, end: 2 },
    { tag: 'p', start: 2, end: 2 },
    { tag: 'blockquote', start: 3, end: 5 }
  ])
})

test('the tag follows the source line, not the position in the rendered HTML', () => {
  const md = makeMarkdown()
  // blank rows expand into `&nbsp;` lines internally, so a tag that ignored the
  // translation would drift by one line per blank row
  const source = ['甲', '', '', '', '乙'].join('\n')
  const tags = tagsOf(render(md, source))
  assert.deepEqual(tags, [
    { tag: 'p', start: 0, end: 0 },
    { tag: 'p', start: 1, end: 1 },
    { tag: 'p', start: 2, end: 2 },
    { tag: 'p', start: 3, end: 3 },
    { tag: 'p', start: 4, end: 4 }
  ])
})

test('a fenced block keeps its tag on the <pre> element', () => {
  const md = makeMarkdown()
  const source = ['```js', 'const a = 1', '```'].join('\n')
  const html = render(md, source)
  assert.match(html, new RegExp(`<pre ${SLINE_ATTR}="0" ${ELINE_ATTR}="2"`))
})

test('raw HTML and frontmatter placeholders carry their tag', () => {
  const md = makeMarkdown()
  const withFrontmatter = render(md, ['---', 'title: T', '---', '', '<!-- 注释 -->'].join('\n'))
  assert.match(withFrontmatter, new RegExp(`${FRONTMATTER_ATTR}="[^"]*" ${SLINE_ATTR}="0" ${ELINE_ATTR}="2"`))
  assert.match(withFrontmatter, new RegExp(`${RAW_HTML_BLOCK_ATTR}="[^"]*" ${SLINE_ATTR}="4" ${ELINE_ATTR}="4"`))
})

test('nothing is tagged outside a parse that was given a line map', () => {
  const md = makeMarkdown()
  assert.equal(tagsOf(md.render('# 标题\n\n正文')).length, 0)
  // and the map is only active inside the scope it was handed to
  const { internal, internalToDoc } = toInternalMapped('甲\n\n乙')
  withSourceLineMap(internalToDoc, () => {})
  assert.equal(tagsOf(md.render(internal)).length, 0)
})

test('outermostTokenSpans reports one span per top-level token', () => {
  const md = new MarkdownIt({ html: true })
  const tokens = md.parse('# H\n\np\n\n- a\n  - b\n\n> q\n', {})
  // a list's span runs through the blank line that follows it (see the note on
  // the anchor clamp above)
  assert.deepEqual(outermostTokenSpans(tokens), [[0, 0], [2, 2], [4, 6], [7, 7]])
})

// ---- splicing --------------------------------------------------------------

test('a rewritten block cannot merge with the lines it lands between', () => {
  // paragraph followed by a paragraph: without a blank they would parse as ONE
  assert.deepEqual(isolateLines(['甲'], '上文', '下文'), ['', '甲', ''])
  // a heading, quote, list, fence or table interrupts the paragraph above it
  assert.deepEqual(isolateLines(['甲'], '# 标题', undefined), ['甲'])
  assert.deepEqual(isolateLines(['甲'], undefined, '- 列表'), ['甲'])
  assert.deepEqual(isolateLines(['甲'], undefined, '> 引用'), ['甲'])
  // ...but a line that only LOOKS like a break does not: `---` under a
  // paragraph is a setext heading, so a separator is still required
  assert.deepEqual(isolateLines(['甲'], undefined, '---'), ['甲', ''])
  // an existing blank line is separator enough
  assert.deepEqual(isolateLines(['甲'], undefined, ''), ['甲'])
  // a line that already ends its block above needs nothing after it: a thematic
  // break, a setext underline, the `---` that closes frontmatter
  assert.deepEqual(isolateLines(['甲'], '---', undefined), ['甲'])
  assert.deepEqual(isolateLines(['甲'], '=====', undefined), ['甲'])
  assert.deepEqual(isolateLines(['甲'], '* * *', undefined), ['甲'])
  // and an empty row's own blank line is never doubled
  assert.deepEqual(isolateLines(['', '甲'], undefined, undefined), ['', '甲'])
})

test('edits are applied bottom-up so earlier line numbers stay valid', () => {
  const content = ['a', 'b', 'c', 'd', 'e'].join('\n')
  const next = applySourceLineEdits(content, [
    { start: 1, end: 1, lines: ['B'] },
    { start: 3, end: 4, lines: ['D'] }
  ])
  assert.equal(next, ['a', 'B', 'c', 'D'].join('\n'))
})

test('an insertion is a range with end before start', () => {
  const content = ['a', 'b'].join('\n')
  assert.equal(applySourceLineEdits(content, [{ start: 1, end: 0, lines: ['新', ''] }]), ['a', '新', '', 'b'].join('\n'))
  assert.equal(applySourceLineEdits(content, [{ start: 2, end: 1, lines: ['尾'] }]), ['a', 'b', '尾'].join('\n'))
})

test('a deletion removes exactly its lines', () => {
  const content = ['a', 'b', 'c'].join('\n')
  assert.equal(applySourceLineEdits(content, [{ start: 1, end: 1, lines: [] }]), ['a', 'c'].join('\n'))
})

test('an overlapping edit is skipped rather than allowed to corrupt the file', () => {
  const content = ['a', 'b', 'c', 'd'].join('\n')
  // edits are applied bottom-up, so the lower one wins and the other is dropped
  const next = applySourceLineEdits(content, [
    { start: 1, end: 2, lines: ['X'] },
    { start: 2, end: 3, lines: ['Y'] }
  ])
  assert.equal(next, ['a', 'b', 'Y'].join('\n'))
})

// ---- wiring ----------------------------------------------------------------

test('the editor anchors, writes back and keeps a way out', async () => {
  const source = await readFile(new URL('../src/components/RichEditor.vue', import.meta.url), 'utf8')
  // the parser tags blocks, and the tags ride on the schema as hidden attrs
  assert.match(source, /installKnoteSourceLineTags\(markdownit\)/)
  assert.match(source, /installKnoteSourceLineFence\(markdownit\)/)
  assert.match(source, /name: 'knoteSourceLineAnchors'/)
  assert.match(source, /rendered: false,/)
  assert.match(source, /keepOnSplit: false,/)
  // a pasted or dragged block must not keep the anchor of the place it came from
  assert.match(source, /transformPasted: \(slice\) => clearSourceAnchors\(slice\)/)
  // the parse boundary hands the translation to the parser
  assert.match(source, /withSourceLineMap\(anchorMap, \(\) => editor\.chain\(\)/)
  // and an unexpected failure in the fast path falls back to the old behaviour
  assert.match(source, /catch \(error\) \{\s*\n\s*writeBackMode = `fallback:threw/)
  assert.match(source, /md = fromInternal\(postprocessMarkdown\(editor\.storage\.markdown\.getMarkdown\(\)\)\)/)
})

test('the block-splice path is opt-in per editor instance', async () => {
  const app = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
  // the whole-document editor opts in; the bounded large-document chunk editor
  // deliberately keeps the previous all-or-nothing behaviour
  const single = /<RichEditor\s+v-else[\s\S]{0,400}?block-splice/
  assert.match(app, single)
  const occurrences = (app.match(/block-splice/g) || []).length
  assert.equal(occurrences, 1)
})
