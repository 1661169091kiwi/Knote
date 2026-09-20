import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { toInternal, fromInternal } from '../src/lib/emptyRows.js'

// ---- blank-row placeholders must respect block indentation -----------------
//
// A blank row inside a list item used to become a column-0 `&nbsp;` line,
// which terminates the item: the item's following paragraph, fence or quote
// escaped to the top level on every load, silently changing the document's
// structure (a fence or quote left the list).

test('a blank row inside a list item keeps the item indentation', () => {
  const internal = toInternal('- item\n\n  continued\n')
  assert.match(internal, /\n  &nbsp;\n/)
})

test('a blank row before a nested list item keeps that indentation', () => {
  const internal = toInternal('- a\n\n  - nested\n')
  assert.match(internal, /\n  &nbsp;\n/)
})

test('a blank row between top-level blocks stays at column zero', () => {
  const internal = toInternal('para one\n\npara two\n')
  assert.match(internal, /\n&nbsp;\n/)
  assert.doesNotMatch(internal, / &nbsp;/)
})

test('a blank row inside a fenced block is never a placeholder', () => {
  const internal = toInternal('```\na\n\nb\n```\n')
  assert.ok(internal.startsWith('```\na\n\nb\n```'), internal)
})

// ---- the reverse conversion ----------------------------------------------

test('fromInternal turns both placeholder forms back into blank lines', () => {
  assert.equal(fromInternal('a\n\n&nbsp;\n\nb'), 'a\n\nb')
  assert.equal(fromInternal('a\n\n  &nbsp;\n\nb'), 'a\n\nb')
})

test('fromInternal leaves fenced content untouched', () => {
  assert.equal(fromInternal('```\n&nbsp;\n```'), '```\n&nbsp;\n```')
})

// ---- the pair is stable for a realistic document --------------------------

test('toInternal/fromInternal round-trips a list with nested blocks', () => {
  const doc = [
    '- Loose item one',
    '',
    '  A paragraph inside the list item.',
    '',
    '- Loose item two',
    '',
    '  ```py',
    '  print("code in list")',
    '  ```',
    '',
    '  > quote in list',
    ''
  ].join('\n')
  assert.equal(fromInternal(toInternal(doc)), doc)
})

test('toInternal/fromInternal round-trips an indented nested list', () => {
  const doc = '- a\n  - b\n\n    still b\n- c\n'
  assert.equal(fromInternal(toInternal(doc)), doc)
})

// ---- wiring contracts ------------------------------------------------------

test('the task-list plugin is registered without the broken labelAfter mode', async () => {
  const app = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
  // markdown-it-task-lists keeps its options in MODULE-LEVEL state, so whatever
  // App.vue passes leaks into the editor's own parser. `labelAfter` is broken
  // there: it pops the last inline child and appends a <label> holding the
  // item's RAW markdown, duplicating formatted task text.
  assert.match(app, /\.use\(taskLists, \{ enabled: true, label: true \}\)/)
  assert.doesNotMatch(app, /\.use\(taskLists, \{[^}]*labelAfter/)
})

test('the table serializer escapes pipes, keeps images and writes alignment', async () => {
  const source = await readFile(new URL('../src/components/RichEditor.vue', import.meta.url), 'utf8')
  // a cell whose only child is a block image has no textContent, so the stock
  // serializer skipped it and deleted the image
  assert.match(source, /const renderTableCellContents = \(state, cell\) => \{/)
  assert.match(source, /if \(child\.isTextblock\) state\.renderInline\(child\)/)
  // pipes are escaped on the produced OUTPUT: pre-escaping would have its
  // backslash escaped again by prosemirror-markdown's own text escaper
  assert.ok(source.includes("state.out.slice(start).replace(/\\|/g, '\\\\|')"))
  // a block child closes a block; the separator must not flush a blank line
  assert.match(source, /state\.closed = null\s*\r?\n\s*\}\)\s*\r?\n\s*state\.write\(' \|'\)/)
  // GFM alignment survives via a cell attribute and the delimiter row
  assert.match(source, /const KnoteTableCell = TableCell\.extend\(\{/)
  assert.match(source, /const KnoteTableHeader = TableHeader\.extend\(\{/)
  assert.match(source, /const tableDelimiterCell = \(cell\) => \{/)
  assert.match(source, /if \(align === 'center'\) return ':---:'/)
  assert.match(source, /if \(align === 'right'\) return '---:'/)
  assert.match(source, /if \(align === 'left'\) return ':---'/)
  const registeredHeader = source.indexOf('    KnoteTableHeader,')
  const registeredCell = source.indexOf('    KnoteTableCell,')
  assert.ok(registeredHeader > 0 && registeredCell > registeredHeader)
})

test('escaped literal syntax is restored through the emit path', async () => {
  const source = await readFile(new URL('../src/components/RichEditor.vue', import.meta.url), 'utf8')
  // callouts, subscripts, abbreviation definitions and reference definitions
  // are plain text in the editor; the serializer escapes them, so the emit
  // path must put the source form back (see the e2e fidelity tests)
  assert.match(source, /const restoreLiteralSyntax = \(segment\) => segment/)
  assert.match(source, /out\.push\(unescapeMathSpans\(mapOutsideInlineCode\(line, restoreLiteralSyntax\)\)\)/)
  // the Obsidian `![[pic.png|300]]` size suffix rides on the node
  assert.match(source, /\bwikilinkSize: \{/)
  assert.match(source, /data-knote-wikilink-size/)
})
