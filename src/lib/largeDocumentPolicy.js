// TipTap cost is driven by document structure, not just source length. A
// moderately sized architecture document can contain hundreds of headings,
// tables and fenced diagrams; mounting all of those NodeViews (and rendering
// every Mermaid block) is more expensive than a much larger plain-text note.
// Keep this policy pure so the decision can be tested without Electron.
//
// One continuous editor is the default; paged editing (one bounded rich chunk
// of LARGE_SOURCE_CHUNK_SIZE at a time, navigated by hand) is the fallback for
// documents past the CONTINUOUS_* limits. 1.1.6x-1.1.102 paged everything
// from 32k characters, but most of the lag that worked around was a DaisyUI
// rule that made every class change restyle the whole document (rewritten at
// build time: vite/daisy-dropdown-focus.js). With that gone and off-screen
// blocks skipping layout and paint (OFFSCREEN_BLOCK_SKIP_MIN_CHARS), one
// continuous editor measured on dense notes (headings, lists, tables, code;
// complexity ~2.8x characters): 250k chars - typing p95 24ms, Enter 56ms,
// open 0.4s; 500k - typing 40ms, Enter 96ms, open 0.85s. Plain prose scores
// ~1.1x, so it stays continuous up to the character limit.

export const LARGE_SOURCE_CHUNK_SIZE = 32_000
export const LARGE_DOCUMENT_HARD_CHAR_THRESHOLD = 1_000_000
export const CONTINUOUS_DOCUMENT_CHAR_LIMIT = 600_000
export const CONTINUOUS_DOCUMENT_COMPLEXITY_LIMIT = 1_600_000
// Documents this long mark their top-level editor blocks to skip layout and
// paint while off screen (content-visibility, see style.css).
export const OFFSCREEN_BLOCK_SKIP_MIN_CHARS = LARGE_SOURCE_CHUNK_SIZE

const isHorizontalSpace = (code) => code === 0x20 || code === 0x09

// `limits` ({ chars, complexity }) overrides the CONTINUOUS_* limits (E2E tests
// page a modest fixture to exercise the paged editor).
export const inspectLargeDocumentShape = (value, limits = {}) => {
  const source = String(value || '')
  const characters = source.length
  // The hard limit is already decisive. Avoid another O(n) line walk when a
  // multi-megabyte document is opened, restored or captured for a tab switch.
  // Shape counters remain numeric and the return schema stays identical; zero
  // means the detailed scan was intentionally unnecessary.
  if (characters >= LARGE_DOCUMENT_HARD_CHAR_THRESHOLD) {
    return {
      characters,
      lines: 0,
      headings: 0,
      tableRows: 0,
      fenceMarkers: 0,
      mermaidFences: 0,
      complexity: characters,
      usePagedSource: true
    }
  }
  let lines = 0
  let headings = 0
  let tableRows = 0
  let fenceMarkers = 0
  let mermaidFences = 0
  let start = 0

  while (start <= characters) {
    const newline = source.indexOf('\n', start)
    const end = newline < 0 ? characters : newline
    lines++

    let cursor = start
    let spaces = 0
    while (cursor < end && spaces < 3 && isHorizontalSpace(source.charCodeAt(cursor))) {
      cursor++
      spaces++
    }
    const first = source.charCodeAt(cursor)

    if (first === 0x23) { // # heading
      let hashes = 0
      while (cursor + hashes < end && source.charCodeAt(cursor + hashes) === 0x23 && hashes < 7) hashes++
      if (hashes >= 1 && hashes <= 6 && isHorizontalSpace(source.charCodeAt(cursor + hashes))) headings++
    } else if (first === 0x7c) { // | table row
      tableRows++
    } else if (first === 0x60 || first === 0x7e) { // ``` / ~~~ fence
      let run = 0
      while (cursor + run < end && source.charCodeAt(cursor + run) === first) run++
      if (run >= 3) {
        fenceMarkers++
        cursor += run
        while (cursor < end && isHorizontalSpace(source.charCodeAt(cursor))) cursor++
        if (source.slice(cursor, Math.min(end, cursor + 7)).toLowerCase() === 'mermaid') mermaidFences++
      }
    }

    if (newline < 0) break
    start = newline + 1
  }

  // Weights approximate the rich-editor work each shape creates: a line can
  // become a text/hard-break node; headings add fold widgets; table rows add
  // nested cell nodes; fences add syntax-highlighting NodeViews; a Mermaid
  // diagram adds its SVG once drawn. (Diagrams used to weigh 8,000: every one
  // was drawn right after opening. They are now drawn only near the viewport,
  // one at a time while the reader pauses, so a 350k note with 161 diagrams
  // scrolls with 1/152 slow frames in one continuous editor.)
  const complexity = characters +
    lines * 32 +
    headings * 320 +
    tableRows * 220 +
    fenceMarkers * 900 +
    mermaidFences * 500
  // Structure (complexity) is the main trigger for dense notes; the character
  // limit bounds long, simple prose.
  const charLimit = Number(limits?.chars) > 0 ? Number(limits.chars) : CONTINUOUS_DOCUMENT_CHAR_LIMIT
  const complexityLimit = Number(limits?.complexity) > 0 ? Number(limits.complexity) : CONTINUOUS_DOCUMENT_COMPLEXITY_LIMIT
  const usePagedSource = characters >= charLimit || complexity >= complexityLimit

  return {
    characters,
    lines,
    headings,
    tableRows,
    fenceMarkers,
    mermaidFences,
    complexity,
    usePagedSource
  }
}

export const shouldUsePagedSource = (value, limits) => inspectLargeDocumentShape(value, limits).usePagedSource
