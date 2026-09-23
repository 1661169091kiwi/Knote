// YAML frontmatter must survive a round trip byte-for-byte. Without this rule
// markdown-it reads the opening `---` as a horizontal rule and the `key: value`
// lines as ordinary text, so an edit rewrote the block as "--- / ## key: value"
// and escaped bracketed values (`tags: [a, b]` -> `tags: \[a, b\]`).
//
// The block is carried as a single atom node whose text lives in an attribute:
// the editor never re-parses it, and its serializer writes the captured source
// back verbatim.

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
    // The attribute is the source of truth (the editor's atom reads it back
    // verbatim) and the escaped text is what every rendered view paints — the raw
    // HTML rules follow the same principle in reverse ("every rendered view keeps
    // showing the real thing"). Without this rule installed in the render path at
    // all, the split preview read a YAML head as body markdown: an <hr>, a
    // paragraph, and a list whose continuation swallowed the next key (issue #24).
    // renderAttrs carries whichever line-anchor pair the parser installed — the
    // editor tags blocks with SLINE_ATTR/ELINE_ATTR, the split preview with
    // data-sline/data-eline — so one rule serves both. The class lets the
    // preview and the export reuse the editor's block styling; the editor's own
    // parse matches on the attribute, so it is unaffected.
    return `<div class="knote-frontmatter" ${FRONTMATTER_ATTR}="${encode(src)}"${markdownit.renderer.renderAttrs(token)}>${markdownit.utils.escapeHtml(src)}</div>\n`
  }

  Object.defineProperty(markdownit, INSTALLED, { value: true })
  return markdownit
}
