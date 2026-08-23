// Empty-row conversion between the document markdown (App.vue's `content`)
// and the internal representation used by editors/renderers.
//
// Document convention (clean markdown, what gets saved to disk): every blank
// source line is one visible empty row, including the first one between blocks.
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
  const flush = () => {
    if (!blanks) return
    if (seenContent) pushLine('', blankStart)
    for (let i = 0; i < blanks; i++) { pushLine('&nbsp;', blankStart + i); pushLine('', blankStart + i) }
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
    flush()
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

// internal (&nbsp; lines) -> document markdown
export const fromInternal = (md) => {
  const lines = (md || '').split('\n')
  const out = []
  const fence = makeFenceTracker()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fence.inside()) {
      out.push(line)
      fence.feed(line)
      continue
    }
    if (line === '&nbsp;') {
      out.push('')
      if (lines[i + 1] !== undefined && lines[i + 1].trim() === '') i++
      continue
    }
    // Top-level blocks are separated by serializer formatting. Only an
    // explicit &nbsp; paragraph above represents a source blank row.
    if (line === '') continue
    out.push(line)
    fence.feed(line)
  }
  return out.join('\n')
}
