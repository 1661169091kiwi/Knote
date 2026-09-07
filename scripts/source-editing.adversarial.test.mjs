import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeBackspaceUnwrap,
  computeCodeAutoPair,
  computeCodeEnterIndent,
  computeCodeTab,
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

// ---- code-fence smart editing -------------------------------------------

const CODE_CLOSE = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" }
// A one-line fence body for caret math: line 2 is `body`.
const inFence = (body) => '```\n' + body + '\n```\n'
const after = (doc, frag) => doc.indexOf(frag) + frag.length

// auto-pairing inside the fence -------------------------------------------

test('code fence: ( [ { auto-close with the caret in the middle', () => {
  for (const open of ['(', '[', '{']) {
    const doc = inFence('a b')
    const caret = after(doc, 'a') // right after a, before the space
    const r = computeCodeAutoPair(doc, caret, caret, open)
    assert.equal(r.value, inFence('a' + open + CODE_CLOSE[open] + ' b'))
    assert.equal(r.selectionStart, caret + 1)
    assert.equal(r.selectionEnd, caret + 1)
  }
})

test('code fence: < stays literal (less-than is far more common than a tag)', () => {
  const doc = inFence('a b')
  const caret = after(doc, 'a')
  assert.equal(computeCodeAutoPair(doc, caret, caret, '<'), null)
})

test('code fence: quotes auto-close (unlike plain text)', () => {
  for (const q of ['"', "'"]) {
    const doc = inFence('ab')
    const caret = after(doc, 'a')
    const r = computeCodeAutoPair(doc, caret, caret, q)
    assert.equal(r.value, inFence('a' + q + q + 'b'))
    assert.equal(r.selectionStart, caret + 1)
  }
})

test('code fence: typing a close char overtypes an existing close at the caret', () => {
  const doc = inFence('"ab"')
  const caret = after(doc, 'b') // right before the closing quote
  const r = computeCodeAutoPair(doc, caret, caret, '"')
  assert.equal(r.value, doc) // nothing duplicated
  assert.equal(r.selectionStart, caret + 1)
  // same for a bracket: `f(a|)` typing `)` steps past it
  const doc2 = inFence('f(a)')
  const caret2 = after(doc2, 'a')
  const r2 = computeCodeAutoPair(doc2, caret2, caret2, ')')
  assert.equal(r2.value, doc2)
  assert.equal(r2.selectionStart, caret2 + 1)
})

test('code fence: open char next to a close still inserts a fresh pair', () => {
  const doc = inFence('f(a)')
  const caret = after(doc, 'f') // between f and (a)
  const r = computeCodeAutoPair(doc, caret, caret, '(')
  assert.equal(r.value, inFence('f()(a)'))
  assert.equal(r.selectionStart, caret + 1)
  assert.equal(r.selectionEnd, caret + 1)
})

test('code fence: wrap and toggle a selection with a pair char', () => {
  const doc = inFence('word')
  const from = doc.indexOf('word')
  const to = after(doc, 'word')
  const r = computeCodeAutoPair(doc, from, to, '[')
  assert.equal(r.value, inFence('[word]'))
  assert.equal(r.selectionStart, from + 1)
  assert.equal(r.selectionEnd, to + 1)
  // second trigger on the wrapped selection unwraps it again
  const wrappedFrom = r.value.indexOf('[') + 1
  const wrappedTo = after(r.value, 'word') // right where the closing ] sits
  const off = computeCodeAutoPair(r.value, wrappedFrom, wrappedTo, '[')
  assert.equal(off.value, doc)
})

test('code fence: mirror chars and non-pair chars stay literal', () => {
  for (const ch of ['*', '_', '~', '`', 'q']) {
    const doc = inFence('ab')
    const caret = after(doc, 'a')
    assert.equal(computeCodeAutoPair(doc, caret, caret, ch), null)
  }
})

test('code fence helpers are inert outside fences', () => {
  assert.equal(computeCodeAutoPair('a b', 1, 1, '('), null)
  assert.equal(computeCodeEnterIndent('  a', 3), null)
  assert.equal(computeCodeTab('a b', 1, 1), null)
  assert.equal(computeCodeTab('a\nb', 0, 3), null)
})

// Enter auto-indent inside the fence --------------------------------------

test('code fence: Enter keeps the current indentation', () => {
  const doc = inFence('    x')
  const caret = after(doc, 'x')
  const r = computeCodeEnterIndent(doc, caret)
  assert.equal(r.value, inFence('    x\n    '))
  assert.equal(r.selectionStart, caret + 5)
})

test('code fence: Enter inside unclosed brackets indents one extra level', () => {
  const doc = inFence('foo(')
  const caret = after(doc, 'foo(')
  const r = computeCodeEnterIndent(doc, caret)
  assert.equal(r.value, inFence('foo(\n    '))
  const doc2 = inFence('if (a) {')
  const r2 = computeCodeEnterIndent(doc2, after(doc2, 'if (a) {'))
  assert.equal(r2.value, inFence('if (a) {\n    '))
})

test('code fence: Enter inside an empty pair pushes the closer onto its own line', () => {
  const doc = inFence('int main() {}')
  const caret = after(doc, '{')
  const r = computeCodeEnterIndent(doc, caret)
  assert.equal(r.value, inFence('int main() {\n    \n}'))
  assert.equal(r.selectionStart, caret + 5) // newline + one 4-space level
  // same for brackets/quotes of a paren group
  const doc2 = inFence('fn()')
  const r2 = computeCodeEnterIndent(doc2, after(doc2, '('))
  assert.equal(r2.value, inFence('fn(\n    \n)'))
  // a nested (indented) opener keeps the closer at the opener indent
  const doc3 = inFence('  call() {}')
  const r3 = computeCodeEnterIndent(doc3, after(doc3, '{'))
  assert.equal(r3.value, inFence('  call() {\n      \n  }'))
})

test('code fence: Enter does not split a pair that already has content', () => {
  const doc = inFence('fn(a)')
  const r = computeCodeEnterIndent(doc, after(doc, '('))
  // typed ends inside unclosed ( → one extra level, but `a)` stays in place
  assert.equal(r.value, inFence('fn(\n    a)'))
})

test('code fence: Enter on a line with no indent adds a plain newline', () => {
  const doc = inFence('plain')
  const r = computeCodeEnterIndent(doc, after(doc, 'plain'))
  assert.equal(r.value, inFence('plain\n'))
})

test('code fence: brackets inside string literals do not deepen the indent', () => {
  const doc = inFence('s = "not (closed"')
  const r = computeCodeEnterIndent(doc, after(doc, 's = "not (closed"'))
  assert.equal(r.value, inFence('s = "not (closed"\n'))
})

test('code fence: Enter mid-line splits and carries the line indent', () => {
  const doc = inFence('    ab')
  const caret = after(doc, 'a')
  const r = computeCodeEnterIndent(doc, caret)
  assert.equal(r.value, inFence('    a\n    b'))
  assert.equal(r.selectionStart, caret + 5)
})

test('code fence: Enter while inside the leading whitespace keeps it', () => {
  const doc = inFence('    x')
  const caret = after(doc, '  ') // inside the 4-space indent, after 2 spaces
  const r = computeCodeEnterIndent(doc, caret)
  // only the whitespace before the caret carries over; the rest of the line
  // (2 spaces + x) stays put
  assert.equal(r.value, inFence('  \n    x'))
})

// Tab inside the fence -----------------------------------------------------

test('code fence: Tab inserts one 4-space indent level at the caret', () => {
  const doc = inFence('x')
  const caret = after(doc, 'x')
  const r = computeCodeTab(doc, caret, caret)
  assert.equal(r.value, inFence('x    '))
  assert.equal(r.selectionStart, caret + 4)
})

test('code fence: Tab completes a partial indent to the next tab stop', () => {
  // three spaces already there → Tab adds just one more to reach four
  const doc3 = inFence('   x')
  const r3 = computeCodeTab(doc3, doc3.indexOf('x'), doc3.indexOf('x'))
  assert.equal(r3.value, inFence('    x'))
  assert.equal(r3.selectionStart, r3.value.indexOf('x'))
  // five spaces (one level + one extra space) → Tab adds three
  const doc5 = inFence('     x')
  const r5 = computeCodeTab(doc5, doc5.indexOf('x'), doc5.indexOf('x'))
  assert.equal(r5.value, inFence('        x'))
})

test('code fence: Tab follows the line indent style (tab lines get tabs)', () => {
  const doc = '```\n\tx\n```\n'
  const caret = after(doc, 'x')
  const r = computeCodeTab(doc, caret, caret)
  assert.equal(r.value, '```\n\tx\t\n```\n')
})

test('code fence: Tab with a multi-line selection indents each line', () => {
  const doc = '```\na\nb\nc\n```\n'
  const from = after(doc, 'a') - 1 // start of line a
  const to = after(doc, 'b') // right after b (b's newline follows)
  const r = computeCodeTab(doc, from, to)
  assert.equal(r.value, '```\n    a\n    b\nc\n```\n')
  assert.equal(r.selectionStart, from + 4)
  assert.equal(r.selectionEnd, to + 8) // two lines indented, 4 chars each
})

test('code fence: Tab skips empty lines inside the selection', () => {
  const doc = '```\na\n\nc\n```\n'
  const from = after(doc, 'a') - 1
  const to = after(doc, 'c')
  const r = computeCodeTab(doc, from, to)
  assert.equal(r.value, '```\n    a\n\n    c\n```\n')
  assert.equal(r.selectionStart, from + 4)
  assert.equal(r.selectionEnd, to + 8)
})
