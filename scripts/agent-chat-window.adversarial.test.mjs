import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  VIRTUAL_ROW_THRESHOLD,
  ESTIMATED_ROW_HEIGHT,
  rowOffsets,
  rowIndexAt,
  windowFor,
  windowPadding
} from '../src/lib/agentChatWindow.js'
import { rewriteDaisyDropdownFocus } from '../vite/daisy-dropdown-focus.js'

const keys = (count) => Array.from({ length: count }, (_, index) => `m:${index}`)

test('row offsets use measured heights and the estimate for rows never seen', () => {
  const heights = new Map([['m:1', 100], ['m:3', 40]])
  const offsets = rowOffsets(keys(4), heights)
  assert.deepEqual(offsets, [0, ESTIMATED_ROW_HEIGHT, ESTIMATED_ROW_HEIGHT + 100, ESTIMATED_ROW_HEIGHT * 2 + 100, ESTIMATED_ROW_HEIGHT * 2 + 140])
  assert.deepEqual(rowOffsets([], heights), [0])
  // a bogus measurement never poisons the layout
  assert.equal(rowOffsets(['a'], new Map([['a', NaN]]))[1], ESTIMATED_ROW_HEIGHT)
  assert.equal(rowOffsets(['a'], new Map([['a', -5]]))[1], ESTIMATED_ROW_HEIGHT)
})

test('rowIndexAt finds the row under a scroll position', () => {
  const offsets = [0, 100, 300, 350, 1000]
  assert.equal(rowIndexAt(offsets, -20), 0)
  assert.equal(rowIndexAt(offsets, 0), 0)
  assert.equal(rowIndexAt(offsets, 99), 0)
  assert.equal(rowIndexAt(offsets, 100), 1)
  assert.equal(rowIndexAt(offsets, 349), 2)
  assert.equal(rowIndexAt(offsets, 999), 3)
  assert.equal(rowIndexAt(offsets, 5000), 3, 'past the end is the last row')
  assert.equal(rowIndexAt([0], 50), 0, 'an empty list')
})

test('the window covers the viewport plus overscan and never shrinks below the minimum', () => {
  const offsets = rowOffsets(keys(400), new Map())
  const viewport = 800
  const middle = windowFor({ offsets, scrollTop: 40_000, viewport, overscan: 600, minRows: 12 })
  assert.ok(offsets[middle.start] <= 40_000 - 600, JSON.stringify(middle))
  assert.ok(offsets[middle.end] >= 40_000 + viewport + 600, JSON.stringify(middle))
  assert.ok(middle.end - middle.start < 40, 'only a viewport-sized slice is mounted')
  // the top: starts at row 0
  assert.equal(windowFor({ offsets, scrollTop: 0, viewport, overscan: 600 }).start, 0)
  // a tiny viewport still mounts the minimum
  const tiny = windowFor({ offsets, scrollTop: 0, viewport: 0, overscan: 0, minRows: 12 })
  assert.equal(tiny.end - tiny.start, 12)
  // near the end the minimum is taken from the rows above
  const tail = windowFor({ offsets, scrollTop: offsets[400], viewport: 0, overscan: 0, minRows: 12 })
  assert.deepEqual(tail, { start: 388, end: 400 })
  // an empty chat
  assert.deepEqual(windowFor({ offsets: [0], scrollTop: 0, viewport }), { start: 0, end: 0 })
})

test('following the newest message always mounts through the last row', () => {
  const offsets = rowOffsets(keys(300), new Map())
  const pinned = windowFor({ offsets, scrollTop: 0, viewport: 700, overscan: 400, pinEnd: true })
  assert.equal(pinned.end, 300)
  assert.ok(offsets[300] - offsets[pinned.start] >= 700 + 400)
  // fewer rows than the minimum: all of them
  assert.deepEqual(windowFor({ offsets: rowOffsets(keys(5), new Map()), viewport: 700, pinEnd: true }), { start: 0, end: 5 })
})

test('spacers plus the mounted rows always add up to the full height', () => {
  const heights = new Map(keys(200).map((key, index) => [key, 80 + (index % 7) * 30]))
  const offsets = rowOffsets(keys(200), heights)
  for (const scrollTop of [0, 1234, 9000, offsets[200] - 500]) {
    const range = windowFor({ offsets, scrollTop, viewport: 600, overscan: 300 })
    const { top, bottom } = windowPadding(offsets, range)
    const mounted = offsets[range.end] - offsets[range.start]
    assert.equal(top + mounted + bottom, offsets[200])
  }
  assert.deepEqual(windowPadding([0], { start: 0, end: 0 }), { top: 0, bottom: 0 })
  assert.ok(VIRTUAL_ROW_THRESHOLD >= 40, 'short chats stay fully mounted')
})

test('the DaisyUI dropdown focus rule is rewritten without a [class*=] :has()', () => {
  const raw = '.dropdown > :not(:has( ~ [class*="dropdown-content"])):focus { outline-style: none; }'
  const minified = '.dropdown>:not(:has(~[class*=dropdown-content])):focus{outline-style:none}'
  const devString = '.dropdown > :not(:has( ~ [class*=\\"dropdown-content\\"])):focus{outline:none}'
  for (const css of [raw, minified, devString]) {
    const out = rewriteDaisyDropdownFocus(css)
    assert.doesNotMatch(out, /:has\(/, out)
    assert.match(out, /\.dropdown ?> ?:is\(\.dropdown-content, \.dropdown-content ~ \*\):focus/, out)
  }
  assert.equal(rewriteDaisyDropdownFocus('.a:has(> .b) {}'), '.a:has(> .b) {}', 'other :has() rules are untouched')
})

test('the Agent panel wires the window, row memo, follow and composer sizing', () => {
  const panel = readFileSync(fileURLToPath(new URL('../src/components/AgentPanel.vue', import.meta.url)), 'utf8')
  assert.match(panel, /from '\.\.\/lib\/agentChatWindow\.js'/)
  assert.match(panel, /v-memo="rowMemo\(m, i\)"/, 'rows are memoized so a keystroke never re-renders the conversation')
  assert.match(panel, /content-visibility:auto/, 'off-screen rows skip layout and paint')
  assert.match(panel, /field-sizing:content/, 'the composer grows with CSS, not a forced layout per keystroke')
  assert.doesNotMatch(panel, /const autoGrow/, 'no scrollHeight measurement on every keystroke')
})
