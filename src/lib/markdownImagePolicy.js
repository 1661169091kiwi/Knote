const SVG_BASE64_DATA_URL = /^data:image\/svg\+xml(?:;charset=(?:utf-8|us-ascii))?;base64,[A-Za-z0-9+/]+={0,2}(?:#knote-resource=[^&#\s]+&knote-token=[^&#\s]+)?$/i
const INSTALLED = Symbol.for('knote.markdownSvgDataPolicy')

// markdown-it blocks SVG data URLs by default. Knote produces this narrow
// base64 form from local or user-owned images, without admitting executable
// schemes, HTML data URLs, file URLs, or unencoded SVG markup.
export const installKnoteMarkdownImagePolicy = (markdownit) => {
  if (!markdownit || markdownit[INSTALLED]) return markdownit
  const validate = markdownit.validateLink.bind(markdownit)
  markdownit.validateLink = (url) => validate(url) || SVG_BASE64_DATA_URL.test(String(url || ''))
  Object.defineProperty(markdownit, INSTALLED, { value: true })
  return markdownit
}

export const isKnoteSvgDataUrl = (url) => SVG_BASE64_DATA_URL.test(String(url || ''))
