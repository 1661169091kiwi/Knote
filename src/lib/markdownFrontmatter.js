// YAML frontmatter must survive a round trip byte-for-byte. Without this rule
// markdown-it reads the opening `---` as a horizontal rule and the `key: value`
// lines as ordinary text, so an edit rewrote the block as "--- / ## key: value"
// and escaped bracketed values (`tags: [a, b]` -> `tags: \[a, b\]`).
//
// The block is carried as a single atom node whose text lives in an attribute:
// the editor never re-parses it, and its serializer writes the captured source
// back verbatim.

import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml'

const INSTALLED = Symbol.for('knote.markdownFrontmatter')
const OPEN_RE = /^---[ \t]*$/
const CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/

export const FRONTMATTER_ATTR = 'data-knote-frontmatter'

const encode = (value) => {
  try { return encodeURIComponent(String(value ?? '')) } catch { return '' }
}
export const decodeFrontmatter = (value) => {
  try { return decodeURIComponent(String(value ?? '')) } catch { return String(value ?? '') }
}
export const encodeFrontmatter = (value) => encode(value)

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char])

// Presentation only. Never serialize the parsed YAML back over the original
// source: comments, scalar spelling, anchors and indentation belong to the file.
// Walk the AST instead of toJS(), so aliases cannot expand exponentially and
// keys such as __proto__ are never assigned to a JavaScript object.
export const renderFrontmatterBody = (source) => {
  const raw = String(source ?? '')
  const fallback = () => `<pre class="knote-frontmatter-source">${escapeHtml(raw)}</pre>`
  if (raw.length > 16_384) return fallback()
  const lines = raw.split(/\r?\n/)
  if (lines.length > 258) return fallback()
  if (!OPEN_RE.test(lines[0] || '') || !CLOSE_RE.test(lines.at(-1) || '')) return fallback()
  try {
    const document = parseDocument(lines.slice(1, -1).join('\n'), {
      schema: 'failsafe', stringKeys: true, uniqueKeys: false, prettyErrors: false
    })
    if (document.errors.length || document.warnings.length || !isMap(document.contents) || !document.contents.items.length) return fallback()
    let remaining = 512
    const renderNode = (node, depth) => {
      if (--remaining < 0 || depth > 8) throw new Error('metadata presentation limit')
      if (node == null) return ''
      if (isAlias(node)) return `<span class="knote-frontmatter-alias">${escapeHtml(`*${node.source}`)}</span>`
      if (isScalar(node)) return escapeHtml(node.value)
      if (isSeq(node)) return `<span class="knote-frontmatter-items">${node.items.map(item => `<span class="knote-frontmatter-item">${renderNode(item, depth + 1)}</span>`).join('')}</span>`
      if (isMap(node)) {
        // Check duplicates in linear time; the parser's default pairwise key
        // comparisons can stall the renderer on a metadata block with many keys.
        const keys = new Set()
        return `<dl class="knote-frontmatter-properties">${node.items.map(pair => {
          if (!isScalar(pair.key) || keys.has(pair.key.value)) throw new Error('unsupported or duplicate metadata key')
          keys.add(pair.key.value)
          return `<div class="knote-frontmatter-row"><dt class="knote-frontmatter-key">${escapeHtml(pair.key.value)}</dt><dd class="knote-frontmatter-value">${renderNode(pair.value, depth + 1)}</dd></div>`
        }).join('')}</dl>`
      }
      throw new Error('unsupported metadata node')
    }
    return renderNode(document.contents, 0)
  } catch {
    // Invalid or unusually complex YAML remains readable and fully preserved.
    return fallback()
  }
}

export const installKnoteMarkdownFrontmatter = (markdownit) => {
  if (!markdownit || markdownit[INSTALLED]) return markdownit

  markdownit.block.ruler.before('hr', 'knote_frontmatter', (state, startLine, endLine, silent) => {
    // Only the very first line of the document, at column 0.
    if (startLine !== 0 || state.tShift[startLine] !== 0 || state.blkIndent !== 0) return false
    const first = state.src.slice(state.bMarks[startLine], state.eMarks[startLine])
    if (!OPEN_RE.test(first)) return false
    let closeLine = -1
    for (let line = startLine + 1; line < endLine; line++) {
      const text = state.src.slice(state.bMarks[line], state.eMarks[line])
      if (CLOSE_RE.test(text)) { closeLine = line; break }
    }
    // An unterminated block is not frontmatter — leave it to the hr rule.
    if (closeLine < 0) return false
    if (silent) return true
    const token = state.push('knote_frontmatter', '', 0)
    token.content = state.src.slice(state.bMarks[startLine], state.eMarks[closeLine])
    token.map = [startLine, closeLine + 1]
    token.block = true
    state.line = closeLine + 1
    return true
  })

  markdownit.renderer.rules.knote_frontmatter = (tokens, index) => {
    const token = tokens[index]
    const src = String(token.content ?? '')
    // The attribute remains the source of truth. The property list is shared by
    // the editor, preview and exports, not mistaken for editable body prose.
    // renderAttrs carries whichever line-anchor pair the parser installed — the
    // editor tags blocks with SLINE_ATTR/ELINE_ATTR, the split preview with
    // data-sline/data-eline — so one rule serves both. The class lets the
    // preview and the export reuse the editor's block styling; the editor's own
    // parse matches on the attribute, so it is unaffected.
    return `<div class="knote-frontmatter" ${FRONTMATTER_ATTR}="${encode(src)}"${markdownit.renderer.renderAttrs(token)}>${renderFrontmatterBody(src)}</div>\n`
  }

  Object.defineProperty(markdownit, INSTALLED, { value: true })
  return markdownit
}
