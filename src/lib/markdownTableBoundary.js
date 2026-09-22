// GFM ends a table at the first blank line OR the beginning of another
// block-level structure, so a paragraph written directly under a table — with no
// blank line between them — is a paragraph. markdown-it's own table rule does
// not agree: it turns ANY non-blank line into a row
//
//   lineText = getLine(state, nextLine).trim()
//   if (!lineText) { break }            // only blank lines end the table here
//   columns = escapedSplit(lineText)    // ...so "text" becomes a one-cell row
//
// That silently swallows the line into the table on every load: the document
// model never sees a paragraph, per-block write-back has nothing to write back,
// and the user's text renders as a table cell it never was.
//
// The fix keeps the markdown source byte-identical — nothing is rewritten or
// pre-processed. The rule is simply handed a shorter row range: it stops at the
// first row-shaped line that carries no unescaped pipe, and the block parser
// then reads the rest of those lines as their own blocks, exactly like GFM.
const hasUnescapedPipe = (text) => {
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '|') continue
    let backslashes = 0
    for (let before = index - 1; before >= 0 && text[before] === '\\'; before--) backslashes += 1
    if (backslashes % 2 === 0) return true
  }
  return false
}

export const installKnoteMarkdownTableBoundary = (markdownit) => {
  const ruler = markdownit?.block?.ruler
  // Fails loudly rather than silently losing the fix: `at(name)` only replaces a
  // rule, so the original has to be read back out of the ruler's own list.
  if (!ruler || !Array.isArray(ruler.__rules__)) throw new Error('markdown-it block ruler is unavailable')
  const registered = ruler.__rules__.find((rule) => rule.name === 'table')
  if (!registered || typeof registered.fn !== 'function') throw new Error('the markdown-it table rule is unavailable')
  const tableRule = registered.fn
  // The replacement must keep the original's `alt` chain, otherwise paragraphs
  // would no longer terminate at a table line.
  ruler.at('table', (state, startLine, endLine, silent) => {
    let limit = endLine
    for (let line = startLine + 2; line < endLine; line++) {
      const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
      // Blank lines end the table inside the rule already, so scanning past them
      // costs nothing; an indented or outdented line is the rule's own break too.
      if (!text.trim()) continue
      if (state.sCount[line] - state.blkIndent >= 4) continue
      if (!hasUnescapedPipe(text)) { limit = line; break }
    }
    return tableRule(state, startLine, limit, silent)
  }, { alt: ['paragraph', 'reference'] })
}
