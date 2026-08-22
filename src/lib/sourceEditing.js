// Source-mode smart editing helpers (pure string functions).
//
// The split-view source editor is a plain <textarea>; these helpers mirror the
// rich editor's auto-surround (issue #11) and the native list/quote Enter
// continuation, as deterministic string operations so they are unit-testable
// without a DOM. The caller (App.vue) wires them into the source textarea
// keydown handler behind a setting (default off) — the plain-text editing
// default stays untouched.
//
// Every function returns null when the keystroke should behave normally, or
// { value, selectionStart, selectionEnd } describing the replacement document
// and caret. No function mutates its inputs.

// Characters that wrap a selection with the same char on both sides. In plain
// text these are inserted literally (no WYSIWYG mark mapping needed), unlike
// the rich editor where ` * _ ~ must become code/italic/strike marks.
const MIRROR_WRAP = new Set(['`', '*', '_', '~'])
// Paired characters: the typed open char plus the inserted close char.
const PAIR_WRAP = { '"': '"', "'": "'", '(': ')', '[': ']', '{': '}' }
// With no selection only these auto-close (quotes stay literal so prose like
// don't/it's is never disturbed — same policy as the rich editor).
const NOSEL_AUTOCLOSE = new Set(['`', '(', '[', '{'])

// Line-prefix matchers: indent + marker + separator. Used both to detect a
// continuable line and to rebuild the prefix for the next line.
const UNORDERED_ITEM = /^(\s*)([-*+])([ \t]+)/
const ORDERED_ITEM = /^(\s*)(\d+)(\.)([ \t]+)/
const QUOTE_PREFIX = /^(\s*)(>+)([ \t]?)/
const LINE_PREFIXES = [UNORDERED_ITEM, ORDERED_ITEM, QUOTE_PREFIX]

const toSafeInt = (n, fallback) => {
  const v = Math.floor(Number(n))
  return Number.isFinite(v) && v >= 0 ? v : fallback
}

// Bounds of the line containing `offset` (line start, line end without the
// trailing newline). `offset` itself is clamped into the document.
const lineBounds = (value, offset) => {
  const source = String(value || '')
  const pos = toSafeInt(offset, 0)
  const clamped = Math.min(source.length, pos)
  const start = source.lastIndexOf('\n', clamped - 1) + 1
  const nl = source.indexOf('\n', clamped)
  const end = nl === -1 ? source.length : nl
  return { start, end }
}

// Counts fenced-code markers (lines starting with ```) that END before the
// line starting at `lineStartOffset`. An odd count means that line sits inside
// a fenced code block, where every smart edit is skipped (characters must stay
// literal there). Only scans up to the target line, so cost is O(caret line).
export const countFenceLinesBefore = (value, lineStartOffset) => {
  const source = String(value || '')
  const limit = Math.min(source.length, toSafeInt(lineStartOffset, 0))
  let fences = 0
  let searchFrom = 0
  while (searchFrom < limit) {
    const nl = source.indexOf('\n', searchFrom)
    if (nl === -1 || nl >= limit) break
    if (source.startsWith('```', searchFrom)) fences++
    searchFrom = nl + 1
  }
  return fences
}

export const isInsideCodeFence = (value, lineStartOffset) =>
  countFenceLinesBefore(value, lineStartOffset) % 2 === 1

// Enter inside a list item or blockquote continues the prefix on the new line
// (ordered items keep counting); Enter on an empty item (prefix only) removes
// the item instead. Returns null for plain paragraphs and code fences.
export const computeEnterContinuation = (value, caret) => {
  const source = String(value || '')
  const pos = Math.min(source.length, toSafeInt(caret, 0))
  const { start, end } = lineBounds(source, pos)
  if (isInsideCodeFence(source, start)) return null
  const line = source.slice(start, end)

  let prefix = null
  for (const re of LINE_PREFIXES) {
    const m = line.match(re)
    if (!m) continue
    const [, indent, marker] = m
    // Group layout differs: ordered items carry a literal dot in group 3
    // (so the separator lives in group 4), the others in group 3.
    const separator = re === ORDERED_ITEM ? m[4] : m[3]
    if (line.length === m[0].length) {
      // Prefix-only line: Enter exits the list/quote (remove the item).
      const next = source.slice(0, start) + source.slice(end)
      return { value: next, selectionStart: start, selectionEnd: start }
    }
    if (re === ORDERED_ITEM) {
      prefix = indent + (Number(marker) + 1) + m[3] + m[4]
    } else {
      // Reuse the exact typed marker for unordered/quote so `*` stays `*`.
      prefix = indent + marker + (separator || ' ')
    }
    break
  }
  if (prefix == null) return null

  const next = source.slice(0, pos) + '\n' + prefix + source.slice(pos)
  const caretAfter = pos + 1 + prefix.length
  return { value: next, selectionStart: caretAfter, selectionEnd: caretAfter }
}

// Backspace at the end of a prefix-only line removes the whole item prefix
// (exit the list/quote with one keystroke, like Obsidian). Null otherwise.
export const computeBackspaceUnwrap = (value, caret) => {
  const source = String(value || '')
  const pos = Math.min(source.length, toSafeInt(caret, 0))
  const { start, end } = lineBounds(source, pos)
  if (isInsideCodeFence(source, start)) return null
  if (pos !== end) return null
  const line = source.slice(start, end)
  for (const re of LINE_PREFIXES) {
    const m = line.match(re)
    if (m && m[0].length === line.length) {
      const next = source.slice(0, start) + source.slice(end)
      return { value: next, selectionStart: start, selectionEnd: start }
    }
  }
  return null
}

// Typing a wrap character: with a non-empty selection, wrap (or unwrap on a
// second trigger, toggling); with no selection, auto-close ` ( [ { with the
// caret inside (quotes stay literal). Skipped inside code fences.
export const computeSelectionSurround = (value, start, end, char) => {
  const source = String(value || '')
  const from = Math.min(source.length, toSafeInt(start, 0))
  const to = Math.max(from, Math.min(source.length, toSafeInt(end, 0)))
  if (typeof char !== 'string' || char.length !== 1) return null
  const lineStart = source.lastIndexOf('\n', from - 1) + 1
  if (isInsideCodeFence(source, lineStart)) return null

  const close = PAIR_WRAP[char]
  const isMirror = MIRROR_WRAP.has(char)
  if (!isMirror && close === undefined) return null
  const closer = close === undefined ? char : close

  if (from !== to) {
    const wrappedBefore = from >= char.length && source.startsWith(char, from - char.length)
    const wrappedAfter = source.startsWith(closer, to)
    if (wrappedBefore && wrappedAfter) {
      // Toggle off: drop the surrounding chars, keep the inner text selected.
      const next =
        source.slice(0, from - char.length) +
        source.slice(from, to) +
        source.slice(to + closer.length)
      return {
        value: next,
        selectionStart: from - char.length,
        selectionEnd: to - char.length
      }
    }
    // Wrap and keep the selection on the wrapped text.
    const next = source.slice(0, from) + char + source.slice(from, to) + closer + source.slice(to)
    return {
      value: next,
      selectionStart: from + char.length,
      selectionEnd: to + char.length
    }
  }

  if (!NOSEL_AUTOCLOSE.has(char)) return null
  const next = source.slice(0, from) + char + closer + source.slice(from)
  const caret = from + char.length
  return { value: next, selectionStart: caret, selectionEnd: caret }
}
