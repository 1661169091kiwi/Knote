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
