const linesOf = (value) => String(value ?? '').replace(/\r\n?/g, '\n').split('\n')

export const mergeLineRanges = (ranges, start, end) => {
  const next = [...(Array.isArray(ranges) ? ranges : []), [Number(start), Number(end)]]
    .filter((range) => Number.isInteger(range[0]) && Number.isInteger(range[1]) && range[0] >= 1 && range[1] >= range[0])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged = []
  for (const range of next) {
    const previous = merged[merged.length - 1]
    if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1])
    else merged.push([...range])
  }
  return merged
}

export const lineRangeWasRead = (ranges, start, end) => (
  (Array.isArray(ranges) ? ranges : []).some((range) => range[0] <= start && range[1] >= end)
)

export const classifyDocumentReadPrecondition = ({
  currentDocumentId,
  currentContent,
  lastReadDocumentId,
  lastReadContent
} = {}) => {
  if (lastReadContent == null || lastReadDocumentId == null) {
    return { ok: false, code: 'DOCUMENT_NOT_READ' }
  }
  if (String(lastReadDocumentId) !== String(currentDocumentId) || String(lastReadContent) !== String(currentContent)) {
    return { ok: false, code: 'DOCUMENT_STALE' }
  }
  return { ok: true, code: 'DOCUMENT_READY' }
}

const newlineCount = (value) => (String(value || '').replace(/\r\n?/g, '\n').match(/\n/g) || []).length

// Map a raw-text match back to the physical lines it can affect. A match that
// consumes a newline also covers the line on the far side of that boundary.
export const textSpanLineRange = (source, index, length) => {
  const text = String(source ?? '')
  const startOffset = Math.max(0, Math.min(text.length, Number(index) || 0))
  const spanLength = Math.max(0, Math.min(text.length - startOffset, Number(length) || 0))
  const start = newlineCount(text.slice(0, startOffset)) + 1
  return { start, end: start + newlineCount(text.slice(startOffset, startOffset + spanLength)) }
}

// Trim unchanged whole lines from both ends so an exact full-buffer CAS can
// still be reviewed as the smallest line hunk. An empty old slice is a true
// insertion between lines rather than a zero-width replacement.
export const minimalDocumentLineHunk = (before, after) => {
  const oldDocumentLines = linesOf(before)
  const newDocumentLines = linesOf(after)
  if (oldDocumentLines.length === newDocumentLines.length &&
      oldDocumentLines.every((line, index) => line === newDocumentLines[index])) return null

  let prefix = 0
  while (prefix < oldDocumentLines.length &&
         prefix < newDocumentLines.length &&
         oldDocumentLines[prefix] === newDocumentLines[prefix]) prefix++

  let suffix = 0
  while (suffix < oldDocumentLines.length - prefix &&
         suffix < newDocumentLines.length - prefix &&
         oldDocumentLines[oldDocumentLines.length - 1 - suffix] === newDocumentLines[newDocumentLines.length - 1 - suffix]) suffix++

  const oldEnd = oldDocumentLines.length - suffix
  const newEnd = newDocumentLines.length - suffix
  const oldLines = oldDocumentLines.slice(prefix, oldEnd)
  const newLines = newDocumentLines.slice(prefix, newEnd)
  if (!oldLines.length) {
    return {
      kind: 'insert',
      after: prefix,
      oldLines: [],
      newLines,
      applyLines: newLines
    }
  }
  return {
    kind: 'replace',
    start: prefix + 1,
    end: oldEnd,
    oldLines,
    newLines,
    applyLines: newLines
  }
}
