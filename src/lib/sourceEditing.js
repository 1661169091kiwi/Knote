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

// ---- code-fence smart editing -------------------------------------------
//
// Inside a fenced code block the "everything stays literal" rule is reversed
// for a small IDE-like subset: bracket/quote auto-pairing, Tab indentation and
// Enter auto-indent. Outside fences nothing here fires, and mirror chars /
// list / quote continuation still skip fences, so both halves stay disjoint.
// Each function self-checks the fence and returns null otherwise.

// Pairs that auto-close INSIDE a fence. The fence body is code, so quotes
// delimit strings: the plain-text policy of "quotes stay literal" does not
// apply there. `<` is deliberately NOT paired — as a less-than operator it is
// typed far more often than as an HTML tag opener.
const CODE_AUTO_PAIR = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" }
// All close characters of the pairs above. Typing one that already sits right
// after the caret moves the caret past it (IDE overtype) instead of doubling
// it — e.g. one `"` press closes `"abc|"` and `)` never piles up.
const CODE_CLOSE_CHARS = new Set(Object.values(CODE_AUTO_PAIR))
// Bracket groups that participate in Enter smart-indent (they map an unclosed
// opener to the closer that may be pushed onto its own line).
const BRACKET_CLOSE = { '(': ')', '[': ']', '{': '}' }

// One full indent level inside code: four spaces (per user preference),
// unless the line already indents with tabs.
const indentUnitFor = (indent) => (indent || '').includes('\t') ? '\t' : '    '
// Tab steps to the next 4-space tab stop instead of always inserting a full
// level: a 3-space indent gets one more space, a 5-space one gets three.
const tabStepFor = (indent) => {
  if ((indent || '').includes('\t')) return '\t'
  const gap = indent.length % 4
  return ' '.repeat(gap === 0 ? 4 : 4 - gap)
}

// Typing a pair char inside a code fence: with a selection, wrap (or unwrap on
// a second trigger); with no selection, auto-close with the caret in the
// middle. An overtype rule applies to close/quote chars already at the caret.
export const computeCodeAutoPair = (value, start, end, char) => {
  const source = String(value || '')
  const from = Math.min(source.length, toSafeInt(start, 0))
  const to = Math.max(from, Math.min(source.length, toSafeInt(end, 0)))
  if (typeof char !== 'string' || char.length !== 1) return null
  const lineStart = source.lastIndexOf('\n', from - 1) + 1
  if (!isInsideCodeFence(source, lineStart)) return null

  if (from !== to) {
    // Wrap the selection (or toggle it off when it is already wrapped by the
    // same pair), mirroring the plain-text surround behaviour.
    const close = CODE_AUTO_PAIR[char]
    if (close === undefined) return null
    const openBefore = from >= char.length && source.startsWith(char, from - char.length)
    const closeAfter = source.startsWith(close, to)
    if (openBefore && closeAfter) {
      const next =
        source.slice(0, from - char.length) +
        source.slice(from, to) +
        source.slice(to + close.length)
      return {
        value: next,
        selectionStart: from - char.length,
        selectionEnd: to - char.length
      }
    }
    const next = source.slice(0, from) + char + source.slice(from, to) + close + source.slice(to)
    return {
      value: next,
      selectionStart: from + char.length,
      selectionEnd: to + char.length
    }
  }

  // Overtype: the typed close char (or quote) is already the next character,
  // so just step past it instead of inserting a duplicate.
  if (CODE_CLOSE_CHARS.has(char) && source[from] === char) {
    return { value: source, selectionStart: from + 1, selectionEnd: from + 1 }
  }

  const close = CODE_AUTO_PAIR[char]
  if (close === undefined) return null
  const next = source.slice(0, from) + char + close + source.slice(from)
  const caret = from + char.length
  return { value: next, selectionStart: caret, selectionEnd: caret }
}

// Stack of still-unclosed bracket openers in `text`, ignoring brackets inside
// quoted strings (' " `, with backslash escapes) so a string literal such as
// `"not (closed"` never counts as an open group.
const codeOpenStack = (text) => {
  const stack = []
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch)
    else if (ch === ')' || ch === ']' || ch === '}') stack.pop()
  }
  return stack
}

// Enter inside a code fence: the next line keeps the current indentation; when
// the caret sits inside an unclosed bracket group it indents one extra level.
// Inside an EMPTY pair on the same line — `{|}` — the closer is pushed onto
// its own line (indented like the opener) so the caret lands on the new body
// line, mirroring an IDE's auto-indent:
//   int main() {      int main() {
//     |          →    <body, one level in>
//   }                 }
export const computeCodeEnterIndent = (value, caret) => {
  const source = String(value || '')
  const pos = Math.min(source.length, toSafeInt(caret, 0))
  const { start, end } = lineBounds(source, pos)
  if (!isInsideCodeFence(source, start)) return null
  const line = source.slice(start, end)
  const col = pos - start
  const typed = line.slice(0, col)
  const indent = /^(\s*)/.exec(line)[1]
  // While the caret is inside the leading whitespace, carry exactly the
  // whitespace before it; otherwise copy the line indent and, when the typed
  // text ends inside an unclosed bracket group, add one more level.
  const inLeadingWs = /^\s*$/.test(typed)
  const base = inLeadingWs && typed.length < indent.length ? typed : indent
  const stack = inLeadingWs ? [] : codeOpenStack(typed)

  if (stack.length > 0) {
    // Empty-pair split: when only whitespace (on this same line) separates the
    // caret from the matching closer, move that closer onto its own line at the
    // opener's indent and put the caret on a fresh body line one level in.
    const rest = line.slice(col)
    const gap = /^(\s*)(\S)/.exec(rest)
    if (gap && gap[2] === BRACKET_CLOSE[stack[stack.length - 1]]) {
      const bodyIndent = base + indentUnitFor(indent)
      const closerRest = rest.slice(gap[1].length) // from the closer to EOL
      const next = source.slice(0, pos) + '\n' + bodyIndent + '\n' + indent + closerRest + source.slice(end)
      const caretAfter = pos + 1 + bodyIndent.length
      return { value: next, selectionStart: caretAfter, selectionEnd: caretAfter }
    }
  }

  const nextIndent = base + (stack.length > 0 ? indentUnitFor(indent) : '')
  const next = source.slice(0, pos) + '\n' + nextIndent + source.slice(pos)
  const caretAfter = pos + 1 + nextIndent.length
  return { value: next, selectionStart: caretAfter, selectionEnd: caretAfter }
}

// Tab inside a code fence: with a collapsed caret, step to the next tab stop
// (completing a partial indent rather than always adding a full level); with a
// selection, indent every line the selection touches by one full level (empty
// lines stay empty), keeping the selection extent. Fences outside untouched.
export const computeCodeTab = (value, start, end) => {
  const source = String(value || '')
  const from = Math.min(source.length, toSafeInt(start, 0))
  const to = Math.max(from, Math.min(source.length, toSafeInt(end, 0)))
  const lineStart = source.lastIndexOf('\n', from - 1) + 1
  if (!isInsideCodeFence(source, lineStart)) return null
  const nl = source.indexOf('\n', lineStart)
  const lineEnd = nl === -1 ? source.length : nl
  const lineIndent = /^(\s*)/.exec(source.slice(lineStart, lineEnd))[1]

  if (from === to) {
    const step = tabStepFor(lineIndent)
    const next = source.slice(0, from) + step + source.slice(from)
    const caret = from + step.length
    return { value: next, selectionStart: caret, selectionEnd: caret }
  }

  const unit = indentUnitFor(lineIndent)
  const firstLineStart = source.lastIndexOf('\n', from - 1) + 1
  const nlAfterEnd = source.indexOf('\n', to)
  const lastLineEnd = nlAfterEnd === -1 ? source.length : nlAfterEnd
  const body = source.slice(firstLineStart, lastLineEnd)
  const lines = body.split('\n')
  const indented = lines.map((l) => (l === '' ? l : unit + l)).join('\n')
  const inserted = indented.length - body.length
  // An empty first line gets no prefix, so the selection start shifts only
  // when that line was actually indented.
  const shiftStart = lines[0] === '' ? 0 : unit.length
  const next = source.slice(0, firstLineStart) + indented + source.slice(lastLineEnd)
  return { value: next, selectionStart: from + shiftStart, selectionEnd: to + inserted }
}
