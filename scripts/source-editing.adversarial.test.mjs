import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeBackspaceUnwrap,
  computeEnterContinuation,
  computeSelectionSurround,
  countFenceLinesBefore,
  isInsideCodeFence
} from '../src/lib/sourceEditing.js'

// ---- fence detection ---------------------------------------------------

test('fence counting: odd markers mean inside, even means outside', () => {
  // line starts: text=0, ```js=5, code=11, ```=16, plain=20, ```=26, more=30
  const doc = 'text\n```js\ncode\n```\nplain\n```\nmore\n'
  assert.equal(countFenceLinesBefore(doc, 0), 0)
  assert.equal(countFenceLinesBefore(doc, 5), 0)   // the ```js line itself
  assert.equal(countFenceLinesBefore(doc, 11), 1)  // inside code
  assert.equal(countFenceLinesBefore(doc, 16), 1)  // closing ``` line
  assert.equal(countFenceLinesBefore(doc, 20), 2)  // after first fence
  assert.equal(countFenceLinesBefore(doc, 26), 2)  // second ``` open
  assert.equal(countFenceLinesBefore(doc, 30), 3)  // inside second fence
  assert.equal(isInsideCodeFence(doc, 11), true)
  assert.equal(isInsideCodeFence(doc, 0), false)
  assert.equal(isInsideCodeFence(doc, 30), true)
})

test('fence detection ignores indented fence markers inside other text', () => {
  const doc = '  ```not a fence\n```real\n'
  assert.equal(countFenceLinesBefore(doc, doc.length), 1)
})

// ---- Enter continuation ------------------------------------------------

test('Enter continues an unordered list item with the same marker', () => {
  const doc = '- alpha'
  const r = computeEnterContinuation(doc, 7)
  assert.deepEqual(r, { value: '- alpha\n- ', selectionStart: 10, selectionEnd: 10 })
})

test('Enter continues an ordered list with the next number', () => {
  const doc = '3. three'
  const r = computeEnterContinuation(doc, 8)
  assert.equal(r.value, '3. three\n4. ')
  assert.equal(r.selectionStart, 12)
})

test('Enter splits a list item in the middle and carries the prefix', () => {
  const doc = '- foobar'
  const caret = 5 // between foo and bar
  const r = computeEnterContinuation(doc, caret)
  assert.equal(r.value, '- foo\n- bar')
  assert.equal(r.selectionStart, 8)
})

test('Enter continues a blockquote with > ', () => {
  const doc = '> quoted'
  const r = computeEnterContinuation(doc, 8)
  assert.equal(r.value, '> quoted\n> ')
})

test('Enter continues nested blockquote markers', () => {
  const doc = '>> deep'
  const r = computeEnterContinuation(doc, 7)
  assert.equal(r.value, '>> deep\n>> ')
})

test('Enter preserves indentation for nested lists', () => {
  const doc = '  - nested'
  const r = computeEnterContinuation(doc, 10)
  assert.equal(r.value, '  - nested\n  - ')
})

test('Enter on an empty unordered item exits the list', () => {
  const doc = '- '
  const r = computeEnterContinuation(doc, 2)
  assert.deepEqual(r, { value: '', selectionStart: 0, selectionEnd: 0 })
})

test('Enter on an empty ordered item exits the list', () => {
  const doc = '1. '
  const r = computeEnterContinuation(doc, 3)
  assert.equal(r.value, '')
})

test('Enter on an empty quote exits the quote', () => {
  const doc = '> '
  const r = computeEnterContinuation(doc, 2)
  assert.equal(r.value, '')
})

test('Enter inside a code fence does nothing', () => {
  const doc = '```\n- not a list\n'
  const caret = doc.indexOf('not a list') + 2
  assert.equal(computeEnterContinuation(doc, caret), null)
})

test('Enter on a plain paragraph does nothing', () => {
  assert.equal(computeEnterContinuation('just text', 5), null)
})

test('Enter on a heading does nothing', () => {
  assert.equal(computeEnterContinuation('# heading', 9), null)
})

test('Enter on a dash that is not a list marker does nothing', () => {
  assert.equal(computeEnterContinuation('a - b', 3), null)
})

// ---- Backspace unwrap ---------------------------------------------------

test('Backspace at the end of an empty list item removes the prefix', () => {
  const doc = '- '
  const r = computeBackspaceUnwrap(doc, 2)
  assert.deepEqual(r, { value: '', selectionStart: 0, selectionEnd: 0 })
})

test('Backspace on an empty ordered item removes the prefix', () => {
  const r = computeBackspaceUnwrap('12. ', 4)
  assert.equal(r.value, '')
})

test('Backspace on an empty quote removes the quote prefix', () => {
  const r = computeBackspaceUnwrap('> ', 2)
  assert.equal(r.value, '')
})

test('Backspace with content on the line does nothing', () => {
  assert.equal(computeBackspaceUnwrap('- item', 6), null)
})

test('Backspace not at line end does nothing', () => {
  assert.equal(computeBackspaceUnwrap('- x', 1), null)
})

test('Backspace inside a code fence does nothing', () => {
  const doc = '```\n- \n'
  assert.equal(computeBackspaceUnwrap(doc, doc.indexOf('- ') + 2), null)
})

// ---- selection surround -------------------------------------------------

test('mirror char wraps the selection literally', () => {
  const r = computeSelectionSurround('select me', 0, 9, '*')
  assert.equal(r.value, '*select me*')
  assert.equal(r.selectionStart, 1)
  assert.equal(r.selectionEnd, 10)
})

test('backtick wraps the selection', () => {
  const r = computeSelectionSurround('code', 0, 4, '`')
  assert.equal(r.value, '`code`')
})

test('pair char wraps with the close char', () => {
  const r = computeSelectionSurround('word', 0, 4, '(')
  assert.equal(r.value, '(word)')
})

test('second trigger unwraps (toggle)', () => {
  const wrapped = computeSelectionSurround('abc', 0, 3, '*')
  const unwrapped = computeSelectionSurround(wrapped.value, 1, 4, '*')
  assert.equal(unwrapped.value, 'abc')
  assert.equal(unwrapped.selectionStart, 0)
  assert.equal(unwrapped.selectionEnd, 3)
})

test('pair toggle unwraps', () => {
  const wrapped = computeSelectionSurround('x', 0, 1, '[')
  const unwrapped = computeSelectionSurround(wrapped.value, 1, 2, '[')
  assert.equal(unwrapped.value, 'x')
})

test('no selection: backtick and brackets auto-close with caret inside', () => {
  for (const ch of ['`', '(', '[', '{']) {
    const r = computeSelectionSurround('ab', 1, 1, ch)
    assert.equal(r.value, 'a' + ch + (ch === '`' ? '`' : PAIR_CLOSE[ch]) + 'b')
    assert.equal(r.selectionStart, 2)
    assert.equal(r.selectionEnd, 2)
  }
})

test('no selection: quotes stay literal (no auto-close)', () => {
  assert.equal(computeSelectionSurround("don", 2, 2, "'"), null)
  assert.equal(computeSelectionSurround('say', 3, 3, '"'), null)
})

test('no selection: emphasis chars do not auto-close', () => {
  assert.equal(computeSelectionSurround('ab', 1, 1, '*'), null)
  assert.equal(computeSelectionSurround('ab', 1, 1, '_'), null)
  assert.equal(computeSelectionSurround('ab', 1, 1, '~'), null)
})

test('surround is skipped inside a code fence', () => {
  const doc = '```\nabc'
  assert.equal(computeSelectionSurround(doc, 4, 6, '*'), null)
})

test('non-wrap characters are ignored', () => {
  assert.equal(computeSelectionSurround('ab', 0, 1, 'q'), null)
})

const PAIR_CLOSE = { '(': ')', '[': ']', '{': '}' }
