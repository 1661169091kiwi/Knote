// Native clipboards commonly append CRLF (and sometimes an empty CRLF pair)
// to a copied selection. tiptap-markdown parses those terminal newlines as
// hard breaks, so formatted plain-text Markdown gains visible empty rows.
// Internal newlines are intentional document content and are never collapsed.
export const normalizePastedMarkdownText = (value) => String(value || '')
  .replace(/\r\n?/g, '\n')
  .replace(/\n+$/, '')

// Browsers usually put both text/plain and text/html on the clipboard. When
// somebody copies Markdown source, the HTML flavour often wraps each source
// line in its own <p>/<div>. ProseMirror prefers that HTML and therefore turns
// one source newline into two Markdown newlines on the next serialization.
// Prefer text/plain only when it contains unambiguous Markdown source syntax;
// ordinary Word/web rich text must continue through the HTML paste pipeline.
export const hasExplicitMarkdownSyntax = (value) => {
  const text = normalizePastedMarkdownText(value)
  if (!text) return false
  return [
    /\*\*(?=\S)[\s\S]*?\S\*\*/,
    /__(?=\S)[\s\S]*?\S__/,
    // Single emphasis delimiters need a word/space boundary. This recognises
    // `*italic*` / `_italic_` without treating ordinary `a*b` / `a_b` as
    // Markdown source.
    // Unicode punctuation and Han text are valid boundaries too. Without
    // these, `这是*斜体*。` and `（_斜体_）` were incorrectly handed back to
    // the HTML clipboard flavour and could regain the extra paragraph gap.
    /(^|[\s\p{P}\p{S}\p{Script=Han}])\*(?=\S)[^*\n]*?\S\*(?=$|[\s\p{P}\p{S}\p{Script=Han}])/mu,
    /(^|[\s\p{P}\p{S}\p{Script=Han}])_(?=\S)[^_\n]*?\S_(?=$|[\s\p{P}\p{S}\p{Script=Han}])/mu,
    /~~(?=\S)[\s\S]*?\S~~/,
    /==(?=\S)[\s\S]*?\S==/,
    /\+\+(?=\S)[\s\S]*?\S\+\+/,
    /`[^`\n]+`/,
    /!?\[[^\]\n]*\]\([^\n)]+\)/,
    /^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+|```|~~~)/m,
    /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/m,
    /^\s*\[\^[^\]\n]+\]:\s+\S/m,
    // A pipe row followed by a Markdown table delimiter row.
    /^\s*\|?.+\|.+\|?\s*\n\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m
  ].some((pattern) => pattern.test(text))
}
