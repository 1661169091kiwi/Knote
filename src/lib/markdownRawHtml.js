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
import { taggedLineAttrs } from './markdownSourceLines.js'

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

// Knote writes multi-paragraph/merged tables as HTML because GFM cannot hold
// them. They must re-enter the table schema, not the read-only raw HTML atom.
// Be conservative: unsupported markup stays opaque and byte-preserved rather
// than being silently flattened by ProseMirror's parser.
const TABLE_TAGS = new Set(['TABLE', 'COLGROUP', 'COL', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'STRIKE', 'SPAN', 'MARK', 'IMG', 'CODE', 'PRE', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
const modeledStyles = (value, properties) => !/url\s*\(|expression\s*\(|\\|@/i.test(value) && value.split(';').every(declaration => {
  if (!declaration.trim()) return true
  const colon = declaration.indexOf(':')
  return colon > 0 && properties.has(declaration.slice(0, colon).trim().toLowerCase())
})
const modelableTable = (content, document) => {
  if (!document?.createElement || !/^\s*<table\b/i.test(content) || !/<\/table>\s*$/i.test(content)) return false
  const template = document.createElement('template')
  template.innerHTML = content
  const roots = [...template.content.childNodes].filter(node => node.nodeType !== 3 || node.textContent.trim())
  const table = roots[0]
  if (roots.length !== 1 || table?.nodeName !== 'TABLE' || table.querySelector('table') || !table.querySelector('tr > td, tr > th')) return false
  const supportedAttribute = (element, name, value) => {
    const tag = element.nodeName
    if ((tag === 'TD' || tag === 'TH') && /^(colspan|rowspan)$/.test(name)) return /^[1-9]\d{0,2}$/.test(value)
    if ((tag === 'TD' || tag === 'TH') && name === 'data-colwidth') return /^[1-9]\d*(?:,[1-9]\d*)*$/.test(value)
    if ((tag === 'TD' || tag === 'TH') && name === 'style') return /^\s*(?:text-align\s*:\s*(?:left|center|right)\s*;?\s*)?$/i.test(value)
    if (tag === 'TABLE' && name === 'style') return /^\s*(?:min-width\s*:\s*\d+(?:\.\d+)?px\s*;?\s*)?$/i.test(value)
    if (tag === 'COL' && name === 'style') return /^\s*(?:min-width\s*:\s*25px\s*;?\s*)?$/i.test(value)
    if (tag === 'A' && /^(href|title|target|rel)$/.test(name)) return !/^(?:javascript|vbscript|data):/i.test(value.trim())
    if (tag === 'SPAN' && name === 'style') return modeledStyles(value, new Set(['color', 'background-color']))
    if (tag === 'IMG' && /^(alt|title)$/.test(name)) return true
    if (tag === 'IMG' && name === 'src') return !/^(?:javascript|vbscript|data:(?!image\/))/i.test(value.replace(/[\u0000-\u0020]/g, ''))
    if (tag === 'IMG' && /^(data-knote-scale|data-knote-intrinsic-width)$/.test(name)) return /^\d+(?:\.\d+)?$/.test(value)
    if (tag === 'IMG' && name === 'data-knote-wikilink') return value === '1'
    if (tag === 'IMG' && name === 'data-knote-wikilink-size') return /^\d+(?:x\d+)?$/.test(value)
    if (tag === 'IMG' && name === 'style') {
      if (!modeledStyles(value, new Set(['width', 'display', 'margin-left', 'margin-right']))) return false
      const style = element.style, scaled = element.hasAttribute('data-knote-scale') && element.hasAttribute('data-knote-intrinsic-width')
      return (!style.width || /^\d+(?:\.\d+)?%$/.test(style.width) || (scaled && /^min\(/.test(style.width))) &&
        (!style.display || style.display === 'block') && (!style.marginLeft || style.marginLeft === 'auto') &&
        (!style.marginRight || (style.marginRight === 'auto' && style.marginLeft === 'auto'))
    }
    if (tag === 'OL' && name === 'start') return /^\d+$/.test(value)
    if (tag === 'CODE' && name === 'class') return /^language-[\w+-]+$/.test(value)
    return false
  }
  for (const element of [table, ...table.querySelectorAll('*')]) {
    if (!TABLE_TAGS.has(element.nodeName)) return false
    for (const attribute of element.attributes) if (!supportedAttribute(element, attribute.name, attribute.value)) return false
  }
  // Comments are source data too, but the table schema cannot represent them.
  const walker = document.createTreeWalker(template.content, 128 /* SHOW_COMMENT */)
  return !walker.nextNode()
}

export const RAW_HTML_BLOCK_ATTR = 'data-knote-raw-html'
export const RAW_HTML_INLINE_ATTR = 'data-knote-raw-html-inline'
export const encodeRawHtml = (value) => encode(String(value ?? ''))
export const decodeRawHtml = (value) => {
  try { return decodeURIComponent(String(value ?? '')) } catch { return String(value ?? '') }
}

export const installKnoteMarkdownRawHtml = (markdownit, { document = globalThis.document } = {}) => {
  if (!markdownit || markdownit[INSTALLED]) return markdownit
  markdownit.renderer.rules.html_block = (tokens, index) => {
    const content = String(tokens[index].content ?? '')
    if (modelableTable(content, document)) return content.replace(/<table\b/i, `<table${taggedLineAttrs(tokens[index])}`)
    if (isModeled(content)) return content
    return `<div ${RAW_HTML_BLOCK_ATTR}="${encode(content)}"${taggedLineAttrs(tokens[index])}></div>\n`
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
