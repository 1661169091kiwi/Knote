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

import { startsOwnBlock } from './emptyRows.js'

export const SLINE_ATTR = 'data-sline'
export const ELINE_ATTR = 'data-eline'

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
// The separator rules mirror fromInternal()'s: a block boundary needs a blank
// line only where two adjacent lines would otherwise merge into ONE paragraph.
// Every other line of the file is left alone — that is the whole point.

const isBlank = (line) => line === undefined || line.trim() === ''

// A thematic break — or the `=====`/`-----` underline that closes a setext
// heading, or the `---` that closes a frontmatter block — ends its block
// outright and never takes a continuation line, so nothing following it can
// merge into the block above. Only the "above" side needs this: as the line
// BELOW, `---` under a paragraph would make that paragraph a setext heading,
// which is exactly what a separator prevents.
const ENDS_BLOCK = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,}|(?:=\s*){3,})$/

const needsSeparator = (above, below) => {
  if (isBlank(above) || isBlank(below)) return false
  if (ENDS_BLOCK.test(String(above))) return false
  return !startsOwnBlock(above) && !startsOwnBlock(below)
}

// Wrap a block's markdown so that splicing it in cannot merge it with the
// source line before/after it.
export const isolateLines = (lines, previousLine, nextLine) => {
  const out = lines.slice()
  if (out.length && needsSeparator(previousLine, out[0])) out.unshift('')
  if (out.length && needsSeparator(out[out.length - 1], nextLine)) out.push('')
  return out
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
