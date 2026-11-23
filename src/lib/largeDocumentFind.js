// Find / replace across a document past the continuous limits (App.vue's
// stacked chunk view). The live chunk's editor searches its own rendered text;
// every other chunk is searched here, on its Markdown source. Only text a
// reader sees counts: image syntax (its alt text and address), link
// addresses, autolinks and HTML tags are skipped, so a search finds, and a
// replace-all rewrites, the words on the page rather than the syntax around
// them. (Emphasis markers stay: a match across `**` is missed here and found
// by the editor once that chunk is live.)

// The same pattern the editor's search builds (RichEditor findSearchMatches).
export const searchPattern = (query, { caseSensitive = false, wholeWord = false } = {}) => {
  if (!query) return null
  let pattern = String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (wholeWord) pattern = `(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`
  try {
    return new RegExp(pattern, caseSensitive ? 'gu' : 'giu')
  } catch {
    return null
  }
}

// ![alt](address) whole, the ](address) of a link, <autolinks> and <tags>
const HIDDEN_SOURCE = /!\[[^\]\n]*\]\([^)\n]*\)|\]\([^)\n]*\)|<[^>\n]+>/g

// [from, to) ranges of `source` a reader sees
export const visibleSourceRanges = (source) => {
  const text = String(source || '')
  const ranges = []
  let last = 0
  HIDDEN_SOURCE.lastIndex = 0
  let hidden
  while ((hidden = HIDDEN_SOURCE.exec(text))) {
    if (hidden.index > last) ranges.push([last, hidden.index])
    last = hidden.index + hidden[0].length
  }
  if (last < text.length) ranges.push([last, text.length])
  return ranges
}

export const countSourceMatches = (source, pattern) => {
  if (!pattern) return 0
  const text = String(source || '')
  let count = 0
  for (const [from, to] of visibleSourceRanges(text)) {
    const part = text.slice(from, to)
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(part))) {
      if (!match[0].length) { pattern.lastIndex++; continue }
      count++
    }
  }
  return count
}

// The replacement is literal text (no `$&` patterns), as in the editor.
export const replaceSourceMatches = (source, pattern, replacement) => {
  const text = String(source || '')
  if (!pattern) return { text, replaced: 0 }
  const literal = String(replacement ?? '')
  let out = ''
  let last = 0
  let replaced = 0
  for (const [from, to] of visibleSourceRanges(text)) {
    out += text.slice(last, from)
    pattern.lastIndex = 0
    out += text.slice(from, to).replace(pattern, (match) => {
      if (!match.length) return match
      replaced++
      return literal
    })
    last = to
  }
  out += text.slice(last)
  return { text: out, replaced }
}
