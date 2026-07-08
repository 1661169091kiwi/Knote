// Empty-row conversion between the document markdown (App.vue's `content`)
// and the internal representation used by editors/renderers.
//
// Document convention (clean markdown, what gets saved to disk):
//   - one blank line between blocks is the normal separator (no empty row)
//   - each ADDITIONAL blank line is one visible empty row
//   - leading blank lines are all rows; a trailing run of n blank lines is
//     n-1 rows
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

// document markdown -> internal (&nbsp; lines)
export const toInternal = (md) => {
  const lines = (md || '').split('\n')
  const out = []
  const fence = makeFenceTracker()
  let blanks = 0
  let seenContent = false
  const flush = () => {
    if (!blanks) return
    const rows = seenContent ? blanks - 1 : blanks
    if (seenContent) out.push('')
    for (let i = 0; i < rows; i++) out.push('&nbsp;', '')
    blanks = 0
  }
  for (const line of lines) {
    if (fence.inside()) {
      out.push(line)
      fence.feed(line)
      continue
    }
    if (line.trim() === '') { blanks++; continue }
    flush()
    // legacy placeholder from the pre-TipTap engine (outside fences only)
    out.push(line === '<br>' ? '&nbsp;' : line)
    seenContent = true
    fence.feed(line)
  }
  flush()
  return out.join('\n')
}

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
      // the row's own blank line; its \n\n separator collapses to one \n
      out.push('')
      if (lines[i + 1] !== undefined && lines[i + 1].trim() === '') i++
      continue
    }
    out.push(line)
    fence.feed(line)
  }
  return out.join('\n')
}
