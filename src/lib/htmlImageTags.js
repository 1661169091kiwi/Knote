// Locate image tags without a repeated per-character regex alternative over
// megabyte data URLs. Native searches skip ordinary text and quoted values.
// Coordinates are source offsets, so callers can preserve every other byte.
export function* htmlImageTags(source) {
  const starts = /<img(?=[\t\n\f\r />])/gi
  const delimiters = /["'<>]/g
  let match
  while ((match = starts.exec(source))) {
    delimiters.lastIndex = starts.lastIndex
    let delimiter
    while ((delimiter = delimiters.exec(source))) {
      const char = delimiter[0]
      if (char === '<') {
        // An unquoted nested opener makes this candidate incomplete. Resume
        // at that opener instead of rescanning the same malformed prefix.
        starts.lastIndex = delimiter.index
        break
      }
      if (char === '>') {
        const end = delimiter.index + 1
        yield { start: match.index, end }
        starts.lastIndex = end
        break
      }
      const endQuote = source.indexOf(char, delimiter.index + 1)
      if (endQuote < 0) return
      delimiters.lastIndex = endQuote + 1
    }
    if (!delimiter) return
  }
}

export const isSingleHtmlImage = (source) => {
  const tags = htmlImageTags(source)
  const first = tags.next()
  return !first.done && !source.slice(0, first.value.start).trim() &&
    !source.slice(first.value.end).trim() && tags.next().done
}
