// TipTap cost is driven by document structure, not just source length. A
// moderately sized architecture document can contain hundreds of headings,
// tables and fenced diagrams; mounting all of those NodeViews (and rendering
// every Mermaid block) is more expensive than a much larger plain-text note.
// Keep this policy pure so the decision can be tested without Electron.

export const LARGE_DOCUMENT_HARD_CHAR_THRESHOLD = 1_000_000
export const LARGE_DOCUMENT_COMPLEXITY_THRESHOLD = 900_000

const isHorizontalSpace = (code) => code === 0x20 || code === 0x09

export const inspectLargeDocumentShape = (value) => {
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
  // nested cell nodes; fences add syntax-highlighting NodeViews; Mermaid
  // fences additionally schedule an SVG render.
  const complexity = characters +
    lines * 32 +
    headings * 320 +
    tableRows * 220 +
    fenceMarkers * 900 +
    mermaidFences * 8_000
  const usePagedSource = characters >= LARGE_DOCUMENT_HARD_CHAR_THRESHOLD ||
    complexity >= LARGE_DOCUMENT_COMPLEXITY_THRESHOLD

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

export const shouldUsePagedSource = (value) => inspectLargeDocumentShape(value).usePagedSource
