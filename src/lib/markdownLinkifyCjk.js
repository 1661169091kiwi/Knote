// linkify-it decides where a bare URL ends, and it counts CJK text as part of
// the URL. In Chinese prose a URL is normally followed by punctuation and more
// words, so "见 http://example.com/x，后面还有字" became ONE link whose href
// swallowed the comma and the rest of the sentence — and saving it wrote the
// Chinese back out percent-encoded. English behaves correctly (a trailing "."
// stays outside), so only the CJK tail needs trimming.
const INSTALLED = Symbol.for('knote.markdownLinkifyCjk')

// CJK punctuation, ideographs, kana and full-width forms.
const CJK_TAIL_RE = /[⺀-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯　-〿]+$/

export const trimLinkifyCjkTail = (match) => {
  if (!match || typeof match.raw !== 'string') return match
  const trimmed = match.raw.replace(CJK_TAIL_RE, '')
  if (trimmed === match.raw || !trimmed) return match
  const dropped = match.raw.length - trimmed.length
  return {
    ...match,
    raw: trimmed,
    text: trimmed,
    url: match.url.slice(0, Math.max(0, match.url.length - dropped)),
    lastIndex: match.lastIndex - dropped
  }
}

export const installKnoteMarkdownLinkifyCjk = (markdownit) => {
  const linkify = markdownit?.linkify
  if (!linkify || linkify[INSTALLED]) return markdownit
  // markdown-it's inline rule asks `matchAtStart`; the core (text-level) rule
  // asks `match`. Both have to be trimmed.
  const originalMatchAtStart = linkify.matchAtStart.bind(linkify)
  linkify.matchAtStart = (text) => trimLinkifyCjkTail(originalMatchAtStart(text))
  const originalMatch = linkify.match.bind(linkify)
  linkify.match = (text) => {
    const matches = originalMatch(text)
    return matches ? matches.map(trimLinkifyCjkTail) : matches
  }
  Object.defineProperty(linkify, INSTALLED, { value: true })
  return markdownit
}
