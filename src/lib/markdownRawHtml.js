// Raw HTML has no node in the editor's schema, so ProseMirror's parser silently
// threw it away: a `<div>`/`<table>` block kept its text and lost its tags, and an
// HTML comment (`<!-- … -->` is an html_block/html_inline token too) vanished
// completely. Pasted tables and annotated notes then degraded on the first edit.
//
// The renderer rules below hand the HTML to the document model as a placeholder
// element that carries the source verbatim in an attribute, so a dedicated atom
// node can hold it and write the original bytes back. The placeholder is only
// installed in the editor's own parser — every rendered view keeps showing the
// real HTML.
const INSTALLED = Symbol.for('knote.markdownRawHtml')

const encode = (value) => {
  try { return encodeURIComponent(String(value ?? '')) } catch { return '' }
}

// HTML the document model already has a node or mark for must NOT be captured
// here: Knote itself writes `<img … style="width:40%">` for a sized image and
// `<span style="color:…">` for coloured text, and both have to keep parsing into
// their real node/mark (otherwise the image toolbar and the colour controls stop
// recognising them). Anything else — a pasted `<table>`, `<details>`, a comment —
// is what the parser would otherwise throw away.
const MODELED_HTML = /^<(?:\/?)(?:img|span|strong|b|em|i|code|a|mark|ins|sub|sup|u|s|del|strike|p|h[1-6]|ul|ol|li|blockquote|pre|hr)\b/i

const isModeled = (content) => MODELED_HTML.test(String(content ?? '').trim())

export const RAW_HTML_BLOCK_ATTR = 'data-knote-raw-html'
export const RAW_HTML_INLINE_ATTR = 'data-knote-raw-html-inline'
export const encodeRawHtml = (value) => encode(String(value ?? ''))
export const decodeRawHtml = (value) => {
  try { return decodeURIComponent(String(value ?? '')) } catch { return String(value ?? '') }
}

export const installKnoteMarkdownRawHtml = (markdownit) => {
  if (!markdownit || markdownit[INSTALLED]) return markdownit
  markdownit.renderer.rules.html_block = (tokens, index) => {
    const content = String(tokens[index].content ?? '')
    if (isModeled(content)) return content
    return `<div ${RAW_HTML_BLOCK_ATTR}="${encode(content)}"></div>\n`
  }
  markdownit.renderer.rules.html_inline = (tokens, index) => {
    const content = String(tokens[index].content ?? '')
    // markdown-it-task-lists emits its checkbox and label as inline HTML, and
    // that markup is the editor's own plumbing (the task node reads the input's
    // checked state) — it must stay an element, not become user HTML that the
    // serializer then writes back into the file as literal tags.
    if (/^<input\b|^<\/?label\b/i.test(content)) return content
    if (isModeled(content)) return content
    return `<span ${RAW_HTML_INLINE_ATTR}="${encode(content)}"></span>`
  }
  Object.defineProperty(markdownit, INSTALLED, { value: true })
  return markdownit
}
