// Empty-row conversion between the document markdown (App.vue's `content`)
// and the internal representation used by editors/renderers.
//
// Document convention (clean markdown, what gets saved to disk), the Typora
// model: ONE blank line between two blocks is only the paragraph boundary
// Markdown needs, and is not shown. Every further blank line in that run is a
// visible empty row, so "A\n\n\nB" shows A, one empty row, B. A run with no
// block on one side (the start of the file, or its end up to the final
// newline) has no boundary to hold, so each of its blank lines is a row.
//
// Internal convention (survives markdown-it parsing, which collapses blank
// runs): each empty row is a standalone `&nbsp;` line between separators.
//
// Both directions are code-fence-aware: blank lines inside ``` / ~~~ fences
// are code content and pass through untouched. The fence tracker mirrors
// markdown-it's rules closely enough for real documents: up to 3 leading
// spaces, fence char + length tracked, a backtick fence whose info string
// contains a backtick is NOT a fence (it's inline code), and the closer must
// match the opener's char with at least its length and nothing else on the
// line.

const makeFenceTracker = () => {
  let open = null
  return {
    inside: () => open !== null,
    // Feed a non-blank line; returns true if the line is a fence delimiter.
    feed(line) {
      if (open) {
        const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
        if (m && m[1][0] === open.ch && m[1].length >= open.len) {
          open = null
          return true
        }
        return false
      }
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        open = { ch: m[1][0], len: m[1].length }
        return true
      }
      return false
    }
  }
}

// document markdown -> { internal (&nbsp; lines), internalToDoc }
// Same transformation as toInternal, but computed in a single pass that ALSO
// records, for every internal line index, the document line index it came from.
// toInternal expands each run of blank rows into separator + `&nbsp;` lines, so
// internal line numbers shift away from the document's — the split preview's
// line-anchored scroll sync needs this map to translate markdown-it's token.map
// (which counts INTERNAL lines) back to real document lines. Blank-region lines
// all map to the first blank of the run (they're whitespace; exact sub-mapping
// is irrelevant to alignment).
export const toInternalMapped = (md) => {
  const lines = (md || '').split('\n')
  const out = []
  const internalToDoc = []
  const fence = makeFenceTracker()
  let blanks = 0
  let blankStart = 0
  let seenContent = false
  const pushLine = (text, docIdx) => { internalToDoc[out.length] = docIdx; out.push(text) }
  const flush = (nextLine) => {
    if (!blanks) return
    // A blank row inside an indented block (a list item's continuation, a
    // nested list) must keep that indentation. A column-0 `&nbsp;` would
    // terminate the block, so an item's paragraphs, fences and quotes escaped
    // to the top level on every load — changing the document's structure.
    const indent = nextLine === undefined ? '' : (/^[ \t]*/.exec(nextLine) || [''])[0]
    // Between two content lines the run's first blank is the block boundary
    // itself (no row); only the blanks after it are rows.
    const boundary = seenContent && nextLine !== undefined ? 1 : 0
    if (seenContent) pushLine('', blankStart)
    for (let i = boundary; i < blanks; i++) { pushLine(`${indent}&nbsp;`, blankStart + i); pushLine('', blankStart + i) }
    blanks = 0
  }
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    if (fence.inside()) {
      pushLine(line, li)
      fence.feed(line)
      continue
    }
    if (line.trim() === '') { if (blanks === 0) blankStart = li; blanks++; continue }
    flush(line)
    // legacy placeholder from the pre-TipTap engine (outside fences only)
    pushLine(line === '<br>' ? '&nbsp;' : line, li)
    seenContent = true
    fence.feed(line)
  }
  flush()
  return { internal: out.join('\n'), internalToDoc }
}

// document markdown -> internal (&nbsp; lines)
export const toInternal = (md) => toInternalMapped(md).internal

// Structural block openers (headings, quotes, list items, fences, table rows,
// HTML).
export const startsOwnBlock = (line) => {
  const text = String(line)
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(text)) return true
  if (/^ {0,3}>/.test(text)) return true
  if (/^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(text)) return true
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(text)) return true
  if (/^ {0,3}\|/.test(text)) return true
  if (/^ {0,3}</.test(text)) return true
  return false
}

const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/

// Do two NEWLY adjacent blocks need the standard blank line between them?
// `above` is the last line of one block, `below` the first line of the next.
// Yes, except where neither side can run into the other: a line after an ATX
// heading, a thematic break, a setext underline (or the `---` closing
// frontmatter) or a closing fence starts fresh, and an ATX heading or a fence
// below interrupts anything. Everything else (paragraph
// text, list items, quotes, tables, HTML) would continue lazily or merge, and
// the blank line is the standard form other Markdown tools expect anyway.
export const needsBlankBetween = (above, below) => {
  if (above == null || below == null || !String(above).trim() || !String(below).trim()) return false
  const a = String(above), b = String(below)
  if (ATX_HEADING.test(a) || THEMATIC_BREAK.test(a) || SETEXT_UNDERLINE.test(a) || FENCE_LINE.test(a)) return false
  if (ATX_HEADING.test(b) || FENCE_LINE.test(b)) return false
  return true
}

// internal (&nbsp; lines) -> document markdown
export const fromInternal = (md) => {
  const lines = (md || '').split('\n')
  const out = []
  const fence = makeFenceTracker()
  let pendingBoundary = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fence.inside()) {
      out.push(line)
      fence.feed(line)
      continue
    }
    // An empty row may carry the indentation of the block it lives in (a list
    // item's continuation); the document form is always a plain blank line.
    if (/^[ \t]*&nbsp;$/.test(line)) {
      out.push('')
      if (lines[i + 1] !== undefined && lines[i + 1].trim() === '') i++
      continue
    }
    // The serializer's blank line between two blocks is the Markdown block
    // boundary: kept, once, but only when another block follows. It is written
    // right before that block, so it never lands at the end of the file (a
    // trailing blank line is a row), and a run of rows between two blocks is
    // one boundary plus one blank line per row.
    if (line === '') {
      if (out.length) pendingBoundary = true
      continue
    }
    if (pendingBoundary) { out.push(''); pendingBoundary = false }
    out.push(line)
    fence.feed(line)
  }
  return out.join('\n')
}
