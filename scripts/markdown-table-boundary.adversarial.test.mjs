import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import MarkdownIt from 'markdown-it'
import { installKnoteMarkdownTableBoundary } from '../src/lib/markdownTableBoundary.js'

const readRepo = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')
const table = '| 列一 | 列二 |\n| --- | --- |\n| 值一 | 值二 |\n'

const parse = (source) => {
  const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
  installKnoteMarkdownTableBoundary(md)
  return md.render(source)
}

// ---- the bug: a paragraph written directly under a table -------------------
// markdown-it's table rule turns ANY non-blank line into a row, so a line with no
// blank line above it was absorbed as a one-cell row on every load. The source
// stayed byte-identical, which is why the byte-level long-document guard could
// not see it: the loss is in the parsed structure, not in the file.

test('a line directly under a table stays a paragraph instead of becoming a row', () => {
  const html = parse(table + '文字紧跟在表格后\n')
  assert.match(html, /<\/tbody>\s*<\/table>\s*<p>文字紧跟在表格后<\/p>/)
  assert.doesNotMatch(html, /<td>\s*文字紧跟在表格后\s*<\/td>/)
})

test('inline markup in that line survives as paragraph content', () => {
  const html = parse(table + '**加粗文字**\n')
  assert.match(html, /<p><strong>加粗文字<\/strong><\/p>/)
  assert.doesNotMatch(html, /<td><strong>加粗文字/)
})

test('a real row (with or without an escaped pipe) is still a row', () => {
  assert.match(parse(table + '| 值三 | 值四 |\n'), /<td>值三<\/td>\s*<td>值四<\/td>/)
  assert.match(parse(table + '| 值三 \\| 冒号 | 值四 |\n'), /<td>值三 \| 冒号<\/td>\s*<td>值四<\/td>/)
  // a line whose only pipe is escaped is a paragraph, not a row — same rule GFM uses
  assert.match(parse(table + 'a \\| b\n'), /<p>a \| b<\/p>/)
})

test('the surrounding structure is unchanged: blank lines, lists, headings, tables under paragraphs', () => {
  // a blank line already ended the table, so this must be byte-identical to a
  // parser without the fix
  const plain = new MarkdownIt({ html: true, breaks: true, linkify: true })
  for (const source of [
    table + '\n文字\n',
    table + '- 列表项\n',
    table + '## 标题\n',
    table + '> 引用\n',
    '普通段落\n' + table,
    '| a |\n| --- |\n| 1 |\n| 2 |\n'
  ]) {
    assert.equal(parse(source), plain.render(source), JSON.stringify(source))
  }
})

test('a table nested in a list keeps its own boundary too', () => {
  // The same GFM rule has to hold inside a list item: a table nested under a
  // bullet/ordered item ends at the first indented line that is not a row. Before
  // the boundary fix that line became a cell INSIDE the nested table.
  const nested = [
    '- 无序项',
    '',
    '  | 列一 | 列二 |',
    '  | --- | --- |',
    '  | 值一 | 值二 |',
    '  紧贴嵌套表格的正文行',
    ''
  ].join('\n')
  const html = parse(nested)
  assert.match(html, /<li>[\s\S]*<table>[\s\S]*<\/table>\s*<p>紧贴嵌套表格的正文行<\/p>\s*<\/li>/)
  assert.doesNotMatch(html, /<td>\s*紧贴嵌套表格的正文行\s*<\/td>/)

  const ordered = [
    '1. 有序项',
    '',
    '   | 左 | 右 |',
    '   | :--- | ---: |',
    '   | 1 | 2 |',
    '   紧贴嵌套表格的正文行',
    ''
  ].join('\n')
  const orderedHtml = parse(ordered)
  assert.match(orderedHtml, /<ol>[\s\S]*<table>[\s\S]*<\/table>\s*<p>紧贴嵌套表格的正文行<\/p>/)
  assert.doesNotMatch(orderedHtml, /<td>\s*紧贴嵌套表格的正文行\s*<\/td>/)
  assert.match(orderedHtml, /text-align:left[\s\S]{0,200}text-align:right/, 'a nested table keeps its alignment')

  // and the table really is nested: a second-level item holds it without lifting
  const secondLevel = [
    '- 父项',
    '  - 子项',
    '',
    '    | 子一 | 子二 |',
    '    | --- | --- |',
    '    | 1 | 2 |',
    ''
  ].join('\n')
  const nestedHtml = parse(secondLevel)
  assert.match(nestedHtml, /<li>\s*父项\s*<ul>\s*<li>[\s\S]*<table>/, 'the table must stay inside the nested item')
  assert.equal((nestedHtml.match(/<table>/g) || []).length, 1)
})

test('list and image syntax inside a cell stays cell content', () => {
  const html = parse('| 列表 | 说明 |\n| --- | --- |\n| - 甲 | 1 |\n| 1. 乙 | 2 |\n| ![图](a.png) | 3 |\n')
  assert.equal((html.match(/<table>/g) || []).length, 1, 'the cell content must not start a new block')
  assert.match(html, /<td>- 甲<\/td>/)
  assert.match(html, /<td>1\. 乙<\/td>/)
  assert.match(html, /<td><img src="a\.png" alt="图"><\/td>/)
  assert.equal((html.match(/<ul>|<ol>/g) || []).length, 0)
})

test('the long-document corpus keeps its table-following paragraph out of the table', () => {
  const corpus = readRepo('scripts/fixtures/long-document-corpus.md')
  const html = parse(corpus)
  // the corpus deliberately carries this case (line 598) with no blank line above
  assert.match(corpus, /\n\|[^\n]*\|\n这段文字紧贴在表格之后没有任何空行。/)
  assert.match(html, /<p>这段文字紧贴在表格之后没有任何空行。<\/p>/)
  // and no cell anywhere holds it
  assert.doesNotMatch(html, /<td>[^<]*紧贴在表格之后/)
})

test('every markdown parse site installs the table boundary', () => {
  // the editor parser is the one that tags blocks for write-back; the App md
  // renders previews, exports and split view — a parser that disagrees with
  // either would re-swallow the line somewhere in the app
  assert.match(readRepo('src/components/RichEditor.vue'), /installKnoteMarkdownTableBoundary\(markdownit\)/)
  assert.match(readRepo('src/App.vue'), /installKnoteMarkdownTableBoundary\(md\)/)
  const source = readRepo('src/lib/markdownTableBoundary.js')
  // replacing the rule through `at()` drops its `alt` chain unless it is passed
  // back — paragraphs stop terminating at a table line without it
  assert.match(source, /ruler\.at\('table',[\s\S]{0,1200}\}, \{ alt: \['paragraph', 'reference'\] \}\)/)
})
