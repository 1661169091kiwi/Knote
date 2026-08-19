// local-file-links.js — path routing for markdown links to local files
// (email-attachment style). One link form stays shareable: a RELATIVE path
// from the document's directory, used whenever the file lives inside that
// directory (default assets/ copies and in-workspace originals). Everything
// else becomes an absolute file:// URL — it always resolves from any doc, but
// only travels with the machine.
// Import the userland package explicitly by subpath — a bare 'punycode'
// specifier resolves to Node's deprecated builtin instead of node_modules.
import punycode from 'punycode/punycode.js'

// Decode a %XX-encoded path segment (markdown destinations may escape spaces).
export const decodeLocalPath = (raw) => {
  try { return decodeURIComponent(String(raw || '')) } catch { return String(raw || '') }
}

// Agents (and pasted text) sometimes wrap a bare local Markdown filename in
// an http(s):// prefix, so the "host" IS the file: [x](http://Harness-R1.md).
// That is not a web URL — unwrap it back to the local filename so the link
// opens in a Knote tab instead of the browser. A REAL web URL to a .md file
// (real host + path, e.g. https://site.com/a/b.md) is left alone. Renderers
// may percent-encode or punycode-encode (xn--) the host, so decode both.
// Returns '' when the href is not a bare-host Markdown link.
export const bareMarkdownHostFilename = (href) => {
  const match = /^https?:\/\/([^/?#]+\.(?:md|markdown))\/?(?:[?#].*)?$/i.exec(String(href || '').trim())
  if (!match) return ''
  let name = match[1]
  name = decodeLocalPath(name)
  if (/(?:^|\.)xn--/i.test(name)) {
    try { name = punycode.toUnicode(name) } catch { /* keep the encoded form */ }
  }
  return name
}

// True when the href points at a local Markdown document: a relative path or
// drive-letter/file:// absolute ending in .md/.markdown, or a bare-host
// http(s):// wrapper around such a filename. Every other protocol (http
// links with real hosts, mailto, data, ...) is NOT a local document.
export const isLocalMarkdownHref = (href) => {
  const raw = String(href || '')
  if (/^https?:/i.test(raw)) return Boolean(bareMarkdownHostFilename(raw))
  if (!/\.(?:md|markdown)(?:$|[?#])/i.test(raw)) return false
  return !/^[a-z][a-z0-9+.-]*:/i.test(raw.replace(/^file:/i, ''))
}

// Relative link path from baseDir to absPath (forward slashes, case-insensitive
// so Windows drive/segment casing never breaks the comparison). Returns ''
// when absPath is not inside baseDir.
export const relativePathFrom = (baseDir, absPath) => {
  const base = String(baseDir || '')
  const abs = String(absPath || '')
  if (!base || !abs) return ''
  const baseParts = base.split(/[\\/]/).filter(Boolean)
  const absParts = abs.split(/[\\/]/).filter(Boolean)
  let i = 0
  while (i < baseParts.length && i < absParts.length && baseParts[i].toLowerCase() === absParts[i].toLowerCase()) i += 1
  if (i < baseParts.length) return ''
  return absParts.slice(i).join('/')
}

// Markdown link text for a local file. docDir is the current document's
// directory ('' when unknown): inside it the link is relative (shareable
// together with the folder), outside it the link is an ABSOLUTE forward-slash
// path. Both destinations are percent-encoded — CommonMark links cannot
// contain raw spaces or unbalanced parentheses, and renderers decode them for
// display. A file:// URL is NOT used: markdown-it refuses file: destinations.
export const localFileLinkMarkdown = (absPath, docDir = '') => {
  const name = String(absPath || '').split(/[\\/]/).filter(Boolean).pop() || 'file'
  const encodeDest = (dest) => encodeURI(dest).replace(/\(/g, '%28').replace(/\)/g, '%29')
  if (docDir) {
    const rel = relativePathFrom(docDir, absPath)
    if (rel) return `[${name}](${encodeDest(rel)})`
  }
  return `[${name}](${encodeDest(String(absPath || '').replace(/\\/g, '/'))})`
}
