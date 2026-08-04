// local-file-links.js — path routing for markdown links to local files
// (email-attachment style). One link form stays shareable: a RELATIVE path
// from the document's directory, used whenever the file lives inside that
// directory (default assets/ copies and in-workspace originals). Everything
// else becomes an absolute file:// URL — it always resolves from any doc, but
// only travels with the machine.

// Decode a %XX-encoded path segment (markdown destinations may escape spaces).
export const decodeLocalPath = (raw) => {
  try { return decodeURIComponent(String(raw || '')) } catch { return String(raw || '') }
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
