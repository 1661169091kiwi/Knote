// Source-line anchoring: which DOCUMENT lines each top-level block came from.
//
// The rich editor parses the INTERNAL form of the document (see emptyRows.js):
// every blank row is expanded into `&nbsp;` placeholder lines, so markdown-it's
// own line numbers no longer match the document's. toInternalMapped() records
// the translation. This module turns that translation into tags on the parsed
// HTML, one tag per TOP-LEVEL block:
//
//     <p data-sline="12" data-eline="12">…</p>
//
// The editor's schema carries those tags on its block nodes (see
// RichEditor.vue's SourceLineAnchors). That anchor is what lets an edit rewrite
// just the block it happened in: every other line of the file stays byte for
// byte as the user wrote it.
//
// Reusing markdown-it's own token.map (instead of diffing strings) is what
// makes the mapping exact — the tag is produced by the very token that renders
// the element, so it cannot drift.

import { needsBlankBetween } from './emptyRows.js'

export const SLINE_ATTR = 'data-sline'
export const ELINE_ATTR = 'data-eline'
// The items of a top-level list carry their own lines too, under separate
// names (they are not blocks of their own): splitMixedTaskLists() needs them
// to tag the lists it splits a mixed list into.
export const ITEM_SLINE_ATTR = 'data-knote-item-sline'
export const ITEM_ELINE_ATTR = 'data-knote-item-eline'

// The map handed to the parser for the CURRENT parse. Parsing is synchronous
// (md.render() inside setContent), so a module-level handoff needs no plumbing
// through markdown-it's API. A parse that happens outside the scope (a paste,
// the split preview's own instance) simply produces untagged HTML.
let activeMap = null

export const withSourceLineMap = (internalToDoc, fn) => {
  const previous = activeMap
  activeMap = internalToDoc || null
  try { return fn() } finally { activeMap = previous }
}

const docLine = (map, internalLine) => {
  const mapped = map[internalLine]
  return mapped == null ? internalLine : mapped
}

const TAGS = Symbol.for('knote.sourceLineTags')
const FENCE = Symbol.for('knote.sourceLineFence')

// The line span of every outermost block in a token stream, as [start, end]
// pairs of 0-based lines. Only nesting level 0 counts: a token inside a list
// item or a quote carries a line span too, and it is not a top-level block.
// `visit` sees each outermost token with its span.
export const outermostTokenSpans = (tokens, visit) => {
  const spans = []
  let depth = 0
  for (const token of tokens) {
    const opening = token.nesting === 1
    const closing = token.nesting === -1
    const outer = depth === 0
    if (opening) depth++
    else if (closing) depth--
    if (!outer || closing || !token.map) continue
    const span = [token.map[0], Math.max(token.map[0], token.map[1] - 1)]
    spans.push(span)
    if (visit) visit(token, span[0], span[1])
  }
  return spans
}

// Tag every outermost block token with its document line span.
export const installKnoteSourceLineTags = (markdownit) => {
  if (!markdownit || markdownit[TAGS]) return markdownit
  markdownit.core.ruler.push('knote_source_lines', (state) => {
    const map = activeMap
    if (!map) return
    outermostTokenSpans(state.tokens, (token, start, end) => {
      token.attrSet(SLINE_ATTR, String(docLine(map, start)))
      token.attrSet(ELINE_ATTR, String(docLine(map, end)))
    })
    for (const token of state.tokens) {
      if (token.type !== 'list_item_open' || token.level !== 1 || !token.map) continue
      token.attrSet(ITEM_SLINE_ATTR, String(docLine(map, token.map[0])))
      token.attrSet(ITEM_ELINE_ATTR, String(docLine(map, Math.max(token.map[0], token.map[1] - 1))))
    }
  })
  markdownit[TAGS] = true
  return markdownit
}

// markdown-it's fence rule builds a complete `<pre><code …>` string and renders
// the token's attributes onto the <code> element, where the codeBlock node's
// parse rule never looks. Wrap whatever rule the host installed (tiptap-markdown
// patches it) and put the tag on the <pre> instead.
export const installKnoteSourceLineFence = (markdownit) => {
  if (!markdownit || markdownit[FENCE]) return markdownit
  const previous = markdownit.renderer.rules.fence
  markdownit.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index]
    const sline = token.attrGet(SLINE_ATTR)
    const eline = token.attrGet(ELINE_ATTR)
    if (sline == null) return previous(tokens, index, options, env, self)
    const attrs = token.attrs
    token.attrs = (attrs || []).filter(([name]) => name !== SLINE_ATTR && name !== ELINE_ATTR)
    try {
      return previous(tokens, index, options, env, self)
        .replace(/<pre\b/, `<pre ${SLINE_ATTR}="${sline}" ${ELINE_ATTR}="${eline}"`)
    } finally {
      token.attrs = attrs
    }
  }
  markdownit[FENCE] = true
  return markdownit
}

// A Markdown list may mix task items and plain items ("- note" then
// "- [x] done", one list). The editor's taskList holds only task items, and
// ProseMirror's parser "repairs" such a list by inventing an empty task item
// (written back as a stray `- [ ]`) and leaving the pieces without source
// lines. Split it first, on the parsed HTML: each run of task items and each
// run of plain items becomes a list of its own, tagged with its own items'
// lines. Serialized, the runs are adjacent lists again, which Markdown reads
// back as the one list the source had.
export const splitMixedTaskLists = (root) => {
  if (!root || !root.querySelectorAll) return root
  const isTask = (item) => item.classList.contains('task-list-item') || item.getAttribute('data-type') === 'taskItem'
  for (const list of [...root.querySelectorAll(':scope > ul.contains-task-list, :scope > ul[data-type="taskList"]')]) {
    const items = [...list.children].filter((child) => child.tagName === 'LI')
    if (!items.some(isTask) || items.every(isTask)) continue
    const runs = []
    for (const item of items) {
      const task = isTask(item)
      if (!runs.length || runs[runs.length - 1].task !== task) runs.push({ task, items: [] })
      runs[runs.length - 1].items.push(item)
    }
    const fragment = list.ownerDocument.createDocumentFragment()
    runs.forEach((run, index) => {
      const piece = list.cloneNode(false)
      piece.removeAttribute(SLINE_ATTR)
      piece.removeAttribute(ELINE_ATTR)
      piece.classList.remove('contains-task-list')
      piece.removeAttribute('data-type')
      if (run.task) { piece.classList.add('contains-task-list'); piece.setAttribute('data-type', 'taskList') }
      if (!piece.getAttribute('class')) piece.removeAttribute('class')
      const first = run.items[0]
      const last = run.items[run.items.length - 1]
      const sline = index === 0 ? list.getAttribute(SLINE_ATTR) : first.getAttribute(ITEM_SLINE_ATTR)
      const eline = last.getAttribute(ITEM_ELINE_ATTR) ?? (index === runs.length - 1 ? list.getAttribute(ELINE_ATTR) : null)
      if (sline != null && eline != null) {
        piece.setAttribute(SLINE_ATTR, sline)
        piece.setAttribute(ELINE_ATTR, eline)
      }
      for (const item of run.items) piece.appendChild(item)
      fragment.appendChild(piece)
    })
    list.replaceWith(fragment)
  }
  return root
}

// Renderers that emit their own element (the raw-HTML and frontmatter
// placeholders) build the tag string themselves.
export const taggedLineAttrs = (token) => {
  const sline = token && token.attrGet ? token.attrGet(SLINE_ATTR) : null
  if (sline == null) return ''
  const eline = token.attrGet(ELINE_ATTR)
  return ` ${SLINE_ATTR}="${sline}"${eline == null ? '' : ` ${ELINE_ATTR}="${eline}"`}`
}

// ---- writing back ---------------------------------------------------------
//
// An edit is `{ start, end, lines }`: replace document lines start..end
// (inclusive) with `lines`. A pure insertion is start > end.
//
// Blank lines follow the Typora model (see emptyRows.js): between two blocks,
// the first blank line of a run is the block boundary and every further one
// is an empty row; at the start or end of the file every blank line is a row.
// An edit therefore rewrites a whole REGION: the changed blocks plus the empty
// rows and blank lines around them, up to the nearest unchanged block (or the
// file's edge) on each side. Every line outside a region keeps its bytes.

const isBlankLine = (line) => line == null || !String(line).trim()

// Frame a region's serialized lines between the blocks around it.
//   fragmentLines  the region's blocks, serialized (fromInternal form: rows are
//                  blank lines; leading and trailing blanks are rows only)
//   above / below  the last line of the block above, the first line of the
//                  block below (undefined at the file's start / end)
//   firstWas / lastWas  the region's first and last ORIGINAL lines (undefined
//                  for a pure insertion)
// Returns the lines to write and how many boundary blanks went on top (`lead`),
// which re-anchoring needs to find the fragment inside them.
export const frameRegion = (fragmentLines, { above, below, firstWas, lastWas } = {}) => {
  const fragment = fragmentLines.slice()
  const content = fragment.map((line) => !isBlankLine(line))
  const first = content.indexOf(true)
  const last = content.lastIndexOf(true)
  const hasAbove = above !== undefined
  const hasBelow = below !== undefined
  if (first < 0) {
    // only empty rows: between two blocks they need the one boundary as well
    return hasAbove && hasBelow ? { lines: ['', ...fragment], lead: 1 } : { lines: fragment, lead: 0 }
  }
  // Does one edge need the boundary blank line? Yes when rows now sit on that
  // side (rows are always one boundary plus their own lines), when the region
  // replaced a run that began/ended with a blank (it held the boundary), or
  // when the newly adjacent blocks would run together. A block the source kept
  // directly against its neighbour (a paragraph right under its heading, a
  // line Knote reads apart from the table above it) stays that way unless its
  // own first/last line changed kind.
  const needsEdge = (rowsOnSide, was, outer, inner, outerAbove) => {
    if (rowsOnSide) return true
    if (was !== undefined && isBlankLine(was)) return true
    const fresh = outerAbove ? needsBlankBetween(outer, inner) : needsBlankBetween(inner, outer)
    if (!fresh || was === undefined) return fresh
    const before = outerAbove ? needsBlankBetween(outer, was) : needsBlankBetween(was, outer)
    return !before
  }
  const top = hasAbove && needsEdge(first > 0, firstWas, above, fragment[first], true)
  const bottom = hasBelow && needsEdge(last < fragment.length - 1, lastWas, below, fragment[last], false)
  return { lines: [...(top ? [''] : []), ...fragment, ...(bottom ? [''] : [])], lead: top ? 1 : 0 }
}

// The serializer never writes whitespace at the end of a line: Markdown drops it
// when it parses (a paragraph's last line, a line before a soft break), so the
// editor never even holds it. A rewritten region therefore lost every trailing
// space the file had. When the region still has its original line count, each
// rewritten line that ends without whitespace takes the whitespace its original
// line ended with (and a blank line keeps its original spaces). Only for prose:
// in code a trailing space is content the user may have just deleted on purpose.
// A line that carries on past its old whitespace (`text ` -> `text more`) had
// that whitespace as text the editor held (the user typed it, it was written,
// and they kept typing): it is content now, not the file's formatting.
export const restoreTrailingWhitespace = (lines, original) => {
  if (!Array.isArray(original) || lines.length !== original.length) return lines
  return lines.map((line, index) => {
    const was = String(original[index] ?? '')
    const trailing = /[ \t]+$/.exec(was)?.[0]
    if (!trailing) return line
    if (line === '') return was.trim() === '' ? was : line
    if (/[ \t]$/.test(line) || line.startsWith(was)) return line
    return line + trailing
  })
}

// Several live paragraph nodes can serialize to consecutive soft-newline
// rows, which Markdown parses as one span. Assign their source lines only
// when independently serialized blocks concatenate to the EXACT fragment.
// Never infer ownership from text similarity, counts or overlapping spans.
export const exactSerializedBlockLines = (fragment, parts) => {
  if (!parts.length || parts.some(part => typeof part !== 'string') || parts.join('\n') !== fragment) return null
  let cursor = 0
  return parts.map(part => {
    const count = part.split('\n').length
    const span = [cursor, cursor + count - 1]
    cursor += count
    return span
  })
}

// Pair the blocks of a written markdown string with the lines they landed on.
// A parsed block takes the next parsed span; an empty row in the editor is a
// blank LINE in the string and takes the next free blank line. Both walks run in
// document order, so any disagreement — a span left over, a block that would
// start before the previous one ended — means the pairing cannot be trusted and
// null is returned (the caller then stops trusting its anchors rather than
// writing the wrong lines).
export const pairBlocksWithLines = (lines, spans, blocks) => {
  const out = []
  let next = 0
  let cursor = 0
  for (const block of blocks) {
    if (block.blank) {
      let at = cursor
      while (at < lines.length && String(lines[at]).trim() !== '') at++
      if (at >= lines.length) return null
      if (next < spans.length && spans[next][0] <= at) return null
      out.push([at, at])
      cursor = at + 1
      continue
    }
    if (next >= spans.length) return null
    const span = spans[next++]
    if (span[0] < cursor) return null
    out.push([span[0], span[1]])
    cursor = span[1] + 1
  }
  return next === spans.length ? out : null
}

// Apply edits to a document string. Edits are applied from the bottom up so
// earlier line numbers stay valid; an edit overlapping one already applied is
// skipped rather than allowed to corrupt the file.
export const applySourceLineEdits = (content, edits) => {
  const lines = String(content ?? '').split('\n')
  const ordered = edits.slice().sort((a, b) => b.start - a.start)
  let lastStart = Infinity
  for (const edit of ordered) {
    const start = Math.max(0, Math.min(edit.start, lines.length))
    const end = Math.max(start - 1, Math.min(edit.end, lines.length - 1))
    if (end >= lastStart) continue // overlapping an edit already applied
    lastStart = start
    lines.splice(start, end - start + 1, ...edit.lines)
  }
  return lines.join('\n')
}
