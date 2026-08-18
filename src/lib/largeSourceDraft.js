const DEFAULT_CHUNK_SIZE = 64_000
const DEFAULT_BOUNDARY_LOOKAHEAD = 4_096
// A character-bounded page can still create thousands of ProseMirror nodes.
// Keep structurally dense pages small enough to mount without blocking input.
const DEFAULT_MAX_LINES = 600

const fenceMarker = (line) => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
const closesFence = (line, fence) => {
  const match = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(line)
  return !!(match && match[1][0] === fence.ch && match[1].length >= fence.len)
}

const readSourceLine = (source, start) => {
  const newline = source.indexOf('\n', start)
  const end = newline >= 0 ? newline : source.length
  const textEnd = end > start && source.charCodeAt(end - 1) === 13 ? end - 1 : end
  return {
    start,
    next: newline >= 0 ? newline + 1 : source.length,
    text: source.slice(start, textEnd)
  }
}

// Most large prose files contain only ordinary lines and ATX headings. Encode
// those rows as (end * 4 + kind) so scanning them allocates no per-line object;
// structural markers fall back to the precise scanner below.
const readSimpleMarkdownLine = (source, start) => {
  const newline = source.indexOf('\n', start)
  const lineEnd = newline >= 0 ? newline : source.length
  const textEnd = lineEnd > start && source.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd
  const next = newline >= 0 ? newline + 1 : source.length
  let marker = start
  let spaces = 0
  while (marker < textEnd && source.charCodeAt(marker) === 32) {
    marker++
    spaces++
  }
  if (marker >= textEnd) return next * 4 + 2
  if (spaces >= 4 || source.charCodeAt(marker) === 9) return null

  const markerCode = source.charCodeAt(marker)
  if (markerCode === 35) {
    let hashes = marker
    while (hashes < textEnd && source.charCodeAt(hashes) === 35) hashes++
    const count = hashes - marker
    const nextCode = source.charCodeAt(hashes)
    if (count >= 1 && count <= 6 && (hashes >= textEnd || nextCode === 9 || nextCode === 32)) {
      return next * 4 + 3
    }
  }

  if (
    markerCode === 9 || markerCode === 36 || markerCode === 42 || markerCode === 43 ||
    markerCode === 45 || markerCode === 58 || markerCode === 60 || markerCode === 61 ||
    markerCode === 62 || markerCode === 92 || markerCode === 96 || markerCode === 126 ||
    (markerCode >= 48 && markerCode <= 57)
  ) return null

  for (let index = marker; index < textEnd; index++) {
    if (source.charCodeAt(index) === 124 && (index === marker || source.charCodeAt(index - 1) !== 92)) return null
  }

  if (next < source.length) {
    let nextMarker = next
    let nextIndent = 0
    while (nextIndent < 4 && source.charCodeAt(nextMarker) === 32) {
      nextMarker++
      nextIndent++
    }
    const nextCode = source.charCodeAt(nextMarker)
    if (nextCode === 45 || nextCode === 61) return null
  }
  return next * 4 + 1
}

const isBlankLine = (line) => {
  for (let index = 0; index < line.length; index++) {
    const code = line.charCodeAt(index)
    if (code !== 9 && code !== 32) return false
  }
  return true
}
const isAtxHeading = (line) => /^ {0,3}#{1,6}(?:[\t ]+|$)/.test(line)
const isSetextUnderline = (line) => /^ {0,3}(?:=+|-+)[\t ]*$/.test(line)
const isBlockquoteLine = (line) => /^ {0,3}>/.test(line)
const isIndentedLine = (line) => /^(?: {4}|\t)/.test(line)
const listMarker = (line) => /^( {0,3})(?:[*+-]|\d{1,9}[.)])(?:[\t ]+|$)/.exec(line)
const anyListMarker = (line) => /^[\t ]*(?:[*+-]|\d{1,9}[.)])(?:[\t ]+|$)/.test(line)
const leadingIndent = (line) => {
  const match = /^[\t ]*/.exec(line)?.[0] || ''
  let width = 0
  for (const ch of match) width += ch === '\t' ? 4 : 1
  return width
}
const isEscapedAt = (source, index) => {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && source.charCodeAt(cursor) === 92; cursor--) slashes++
  return slashes % 2 === 1
}
const tablePipeCount = (line) => {
  let count = 0
  for (let index = 0; index < line.length; index++) {
    if (line.charCodeAt(index) === 124 && !isEscapedAt(line, index)) count++
  }
  return count
}
const hasTablePipe = (line) => tablePipeCount(line) > 0
const splitTableCells = (line) => {
  let text = line.trim()
  if (text[0] === '|') text = text.slice(1)
  if (text.endsWith('|') && !isEscapedAt(text, text.length - 1)) text = text.slice(0, -1)
  const cells = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== 124 || isEscapedAt(text, index)) continue
    cells.push(text.slice(start, index))
    start = index + 1
  }
  cells.push(text.slice(start))
  return cells
}
const isTableDelimiter = (line) => {
  if (!hasTablePipe(line)) return false
  const cells = splitTableCells(line)
  return cells.length >= 1 && cells.every((cell) => /^[\t ]*:?-{1,}:?[\t ]*$/.test(cell))
}

const readUntilLine = (source, first, closes, checkFirst = true) => {
  let current = first
  let lines = 1
  if (checkFirst && closes(first.text)) return { end: first.next, lines, closed: true }
  let closed = false
  while (current.next < source.length) {
    current = readSourceLine(source, current.next)
    lines++
    if (closes(current.text)) {
      closed = true
      break
    }
  }
  return { end: current.next, lines, closed }
}

const readBlankTerminatedBlock = (source, first) => {
  let end = first.next
  let lines = 1
  while (end < source.length) {
    const line = readSourceLine(source, end)
    if (isBlankLine(line.text)) break
    end = line.next
    lines++
  }
  return { end, lines }
}

const readHtmlBlock = (source, first) => {
  const line = first.text
  const lower = line.toLowerCase()
  if (/^ {0,3}<!--/.test(line)) {
    return readUntilLine(source, first, (candidate) => candidate.includes('-->'))
  }
  if (/^ {0,3}<\?/.test(line)) {
    return readUntilLine(source, first, (candidate) => candidate.includes('?>'))
  }
  if (/^ {0,3}<!\[CDATA\[/.test(line)) {
    return readUntilLine(source, first, (candidate) => candidate.includes(']]>'))
  }
  if (/^ {0,3}<![A-Z]/.test(line)) {
    return readUntilLine(source, first, (candidate) => candidate.includes('>'))
  }
  const rawTag = /^ {0,3}<(script|pre|style|textarea)(?:[\t >]|$)/i.exec(line)
  if (rawTag) {
    const closing = `</${rawTag[1].toLowerCase()}`
    return readUntilLine(source, first, (candidate) => candidate.toLowerCase().includes(closing))
  }
  if (
    /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:[\t ][^>]*)?\/?>(?:[\t ].*)?$/.test(line) ||
    (/^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:[\t ][^>]*)?>/.test(line) && lower.includes('>'))
  ) {
    return readBlankTerminatedBlock(source, first)
  }
  return null
}

const readListBlock = (source, first, baseIndent) => {
  let end = first.next
  let lines = 1
  while (end < source.length) {
    const line = readSourceLine(source, end)
    if (!isBlankLine(line.text)) {
      const startsIndependentBlock = leadingIndent(line.text) <= baseIndent + 3 && (
        isAtxHeading(line.text) ||
        !!fenceMarker(line.text) ||
        /^ {0,3}(?:\${2,}|\\\[)/.test(line.text) ||
        /^ {0,3}(?:<!--|<\?|<!\[CDATA\[|<![A-Z]|<\/?[A-Za-z])/.test(line.text)
      )
      if (startsIndependentBlock && !anyListMarker(line.text)) break
      end = line.next
      lines++
      continue
    }

    let blankEnd = end
    let blankLines = 0
    while (blankEnd < source.length) {
      const blank = readSourceLine(source, blankEnd)
      if (!isBlankLine(blank.text)) break
      blankEnd = blank.next
      blankLines++
    }
    if (blankEnd >= source.length) break
    const continuation = readSourceLine(source, blankEnd)
    if (!anyListMarker(continuation.text) && leadingIndent(continuation.text) <= baseIndent) break
    end = blankEnd
    lines += blankLines
  }
  return { end, lines }
}

const readBlockquoteBlock = (source, first) => {
  let end = first.next
  let lines = 1
  while (end < source.length) {
    const line = readSourceLine(source, end)
    if (isBlankLine(line.text)) break
    const startsIndependentBlock = !isBlockquoteLine(line.text) && (
      isAtxHeading(line.text) || !!fenceMarker(line.text) || anyListMarker(line.text)
    )
    if (startsIndependentBlock) break
    end = line.next
    lines++
  }
  return { end, lines }
}

const readIndentedBlock = (source, first) => {
  let end = first.next
  let lines = 1
  while (end < source.length) {
    const line = readSourceLine(source, end)
    if (isIndentedLine(line.text)) {
      end = line.next
      lines++
      continue
    }
    if (!isBlankLine(line.text)) break

    let blankEnd = end
    let blankLines = 0
    while (blankEnd < source.length) {
      const blank = readSourceLine(source, blankEnd)
      if (!isBlankLine(blank.text)) break
      blankEnd = blank.next
      blankLines++
    }
    if (blankEnd >= source.length || !isIndentedLine(readSourceLine(source, blankEnd).text)) break
    end = blankEnd
    lines += blankLines
  }
  return { end, lines }
}

const readMarkdownBlock = (source, start) => {
  const first = readSourceLine(source, start)
  const base = { start, end: first.next, lines: 1, atomic: false, priorityAfter: 1 }
  if (isBlankLine(first.text)) return { ...base, priorityAfter: 2 }

  let markerOffset = 0
  while (markerOffset < first.text.length && markerOffset < 4 && first.text.charCodeAt(markerOffset) === 32) {
    markerOffset++
  }
  const markerCode = first.text.charCodeAt(markerOffset)

  if (markerOffset >= 4 || markerCode === 9) {
    return { ...base, ...readIndentedBlock(source, first), atomic: true }
  }

  if (start === 0 && markerCode === 45 && first.text.trim() === '---') {
    const block = readUntilLine(source, first, (line) => /^(?:---|\.\.\.)[\t ]*$/.test(line.trim()), false)
    if (block.closed) return { ...base, ...block, atomic: true }
  }

  if (markerCode === 96 || markerCode === 126) {
    const fence = fenceMarker(first.text)
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      const marker = { ch: fence[1][0], len: fence[1].length }
      const block = readUntilLine(source, first, (line) => closesFence(line, marker), false)
      return { ...base, ...block, atomic: true }
    }
  }

  if (markerCode === 58) {
    const directive = /^ {0,3}(:{3,})(?:[\t ].*)?$/.exec(first.text)
    if (directive) {
      const block = readUntilLine(source, first, (line) => {
        const close = /^ {0,3}(:{3,})[\t ]*$/.exec(line)
        return !!close && close[1].length >= directive[1].length
      }, false)
      return { ...base, ...block, atomic: true }
    }
  }

  if (markerCode === 36) {
    const dollars = /^ {0,3}(\${2,})(.*)$/.exec(first.text)
    if (dollars) {
      const markerLength = dollars[1].length
      const rest = dollars[2].trim()
      if (rest.length >= markerLength && rest.endsWith('$'.repeat(markerLength))) return { ...base, atomic: true }
      const block = readUntilLine(source, first, (line) => {
        const close = line.trim()
        return /^\$+$/.test(close) && close.length >= markerLength
      }, false)
      return { ...base, ...block, atomic: true }
    }
  }
  if (markerCode === 92 && /^ {0,3}\\\[[\t ]*$/.test(first.text)) {
    const block = readUntilLine(source, first, (line) => /^ {0,3}\\\][\t ]*$/.test(line), false)
    return { ...base, ...block, atomic: true }
  }

  if (markerCode === 60) {
    const html = readHtmlBlock(source, first)
    if (html) return { ...base, ...html, atomic: true }
  }

  if (markerCode === 62 && isBlockquoteLine(first.text)) {
    return { ...base, ...readBlockquoteBlock(source, first), atomic: true }
  }

  if (
    markerCode === 42 || markerCode === 43 || markerCode === 45 ||
    (markerCode >= 48 && markerCode <= 57)
  ) {
    const list = listMarker(first.text)
    if (list) return { ...base, ...readListBlock(source, first, list[1].length), atomic: true }
  }

  if (first.text.includes('|') && hasTablePipe(first.text) && first.next < source.length) {
    const delimiter = readSourceLine(source, first.next)
    if (isTableDelimiter(delimiter.text)) {
      let end = delimiter.next
      let lines = 2
      while (end < source.length) {
        const row = readSourceLine(source, end)
        if (isBlankLine(row.text) || !hasTablePipe(row.text)) break
        end = row.next
        lines++
      }
      return { ...base, end, lines, atomic: true }
    }
  }

  if (first.next < source.length) {
    let nextMarker = first.next
    let nextIndent = 0
    while (nextIndent < 4 && source.charCodeAt(nextMarker) === 32) {
      nextMarker++
      nextIndent++
    }
    const nextCode = source.charCodeAt(nextMarker)
    if (nextCode === 45 || nextCode === 61) {
      const next = readSourceLine(source, first.next)
      if (isSetextUnderline(next.text)) {
        return { ...base, end: next.next, lines: 2, atomic: true }
      }
    }
  }

  if (markerCode === 35 && isAtxHeading(first.text)) return { ...base, priorityBefore: 3 }
  return base
}

const readBracketEnd = (source, start, end) => {
  let depth = 1
  for (let index = start + 1; index < end; index++) {
    if (isEscapedAt(source, index)) continue
    if (source[index] === '[') depth++
    else if (source[index] === ']' && --depth === 0) return index
  }
  return -1
}

const readParenthesizedEnd = (source, start, end) => {
  let depth = 1
  for (let index = start + 1; index < end; index++) {
    if (isEscapedAt(source, index)) continue
    if (source[index] === '(') depth++
    else if (source[index] === ')' && --depth === 0) return index + 1
  }
  return -1
}

const readInlineProtectedSpan = (source, index, end) => {
  const code = source.charCodeAt(index)
  if (code === 96) {
    let markerEnd = index + 1
    while (markerEnd < end && source.charCodeAt(markerEnd) === 96) markerEnd++
    const marker = source.slice(index, markerEnd)
    let close = source.indexOf(marker, markerEnd)
    while (close >= 0 && close < end) {
      if (source.charCodeAt(close - 1) !== 96 && source.charCodeAt(close + marker.length) !== 96) {
        return { start: index, end: close + marker.length, type: 'code' }
      }
      close = source.indexOf(marker, close + marker.length)
    }
    return null
  }

  if (code === 91 && !isEscapedAt(source, index)) {
    const labelEnd = readBracketEnd(source, index, end)
    if (labelEnd < 0) return { skipTo: end }
    const spanStart = index > 0 && source[index - 1] === '!' && !isEscapedAt(source, index - 1)
      ? index - 1
      : index
    const next = labelEnd + 1
    if (source[next] === '(') {
      const spanEnd = readParenthesizedEnd(source, next, end)
      return spanEnd > 0 ? { start: spanStart, end: spanEnd, type: 'link' } : null
    }
    if (source[next] === '[') {
      const referenceEnd = readBracketEnd(source, next, end)
      if (referenceEnd > 0) return { start: spanStart, end: referenceEnd + 1, type: 'reference' }
    }
    return { start: spanStart, end: labelEnd + 1, type: 'label' }
  }

  if (code === 60 && !isEscapedAt(source, index)) {
    const close = source.indexOf('>', index + 1)
    if (close > index && close < end) {
      const body = source.slice(index + 1, Math.min(close, index + 80))
      if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|[^ <>@]+@[^ <>@]+$|\/?[A-Za-z]|[?!])/.test(body)) {
        return { start: index, end: close + 1, type: 'angle' }
      }
    }
    if (close < 0 || close >= end) return { skipTo: end }
  }
  return null
}

const inlineProtectedRangeAt = (source, start, target, end) => {
  let index = start
  while (index < target && index < end) {
    const span = readInlineProtectedSpan(source, index, end)
    if (!span) {
      index++
      continue
    }
    if (span.skipTo) {
      index = Math.max(index + 1, span.skipTo)
      continue
    }
    if (target > span.start && target < span.end) return span
    index = Math.max(index + 1, span.end)
  }
  return null
}

const inlineBoundarySignature = (line) => {
  const types = []
  let index = 0
  while (index < line.length) {
    const span = readInlineProtectedSpan(line, index, line.length)
    if (!span) {
      index++
      continue
    }
    if (span.skipTo) {
      index = Math.max(index + 1, span.skipTo)
      continue
    }
    types.push(span.type)
    index = Math.max(index + 1, span.end)
  }
  return types.join(',')
}

const normalizedRawChunkBoundary = (source, target) => {
  let boundary = Math.max(1, Math.min(source.length, target))
  const previous = source.charCodeAt(boundary - 1)
  const next = source.charCodeAt(boundary)
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) boundary++
  if (source[boundary - 1] === '\r' && source[boundary] === '\n') boundary++
  return Math.min(source.length, boundary)
}

const rawChunkBoundary = (source, cursor, target) => {
  let boundary = normalizedRawChunkBoundary(source, target)
  const newline = source.indexOf('\n', cursor)
  const lineEnd = newline >= 0 ? newline : source.length
  if (boundary < lineEnd) {
    const protectedRange = inlineProtectedRangeAt(source, cursor, boundary, lineEnd)
    if (protectedRange) {
      boundary = protectedRange.start > cursor ? protectedRange.start : protectedRange.end
    }
  }
  return normalizedRawChunkBoundary(source, boundary)
}

const markdownLineBoundarySignature = (lineValue) => {
  const line = String(lineValue || '').replace(/\r$/, '')
  if (isBlankLine(line)) return 'blank'
  if (isIndentedLine(line)) return 'indent'
  const fence = fenceMarker(line)
  if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) return `fence:${fence[1][0]}:${fence[1].length}`
  const directive = /^ {0,3}(:{3,})(?:[\t ].*)?$/.exec(line)
  if (directive) return `directive:${directive[1].length}`
  const dollars = /^ {0,3}(\${2,})/.exec(line)
  if (dollars) return `math:${dollars[1].length}`
  if (/^ {0,3}\\\[[\t ]*$/.test(line) || /^ {0,3}\\\][\t ]*$/.test(line)) return 'math-bracket'
  const heading = /^ {0,3}(#{1,6})(?:[\t ]+|$)/.exec(line)
  if (heading) return `heading:${heading[1].length}`
  if (isSetextUnderline(line)) return `setext:${line.trim()[0]}`
  if (/^ {0,3}(?:(?:\*[\t ]*){3,}|(?:_[\t ]*){3,}|(?:-[\t ]*){3,})$/.test(line)) return 'thematic'
  const quote = /^ {0,3}(>+)/.exec(line)
  if (quote) return `quote:${quote[1].length}`
  const list = listMarker(line)
  if (list) return `list:${leadingIndent(line)}:${/\d/.test(line.trim()[0]) ? 'ordered' : 'bullet'}`
  if (/^ {0,3}(?:<!--|<\?|<!\[CDATA\[|<![A-Z]|<\/?[A-Za-z])/.test(line)) return 'html'
  if (/^ {0,3}\[[^\]]+\]:/.test(line)) return 'definition'
  if (isTableDelimiter(line)) return `table-delimiter:${tablePipeCount(line)}`
  const pipes = tablePipeCount(line)
  const inline = inlineBoundarySignature(line)
  return `text:p${pipes}:i${inline}`
}

const markdownSignatureWindow = (source, offsetValue) => {
  const offset = Math.max(0, Math.min(source.length, Number(offsetValue) || 0))
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const previousStart = lineStart > 0
    ? source.lastIndexOf('\n', Math.max(0, lineStart - 2)) + 1
    : 0
  const lineEnd = source.indexOf('\n', offset)
  const nextEnd = lineEnd < 0 ? source.length : source.indexOf('\n', lineEnd + 1)
  const end = nextEnd < 0 ? source.length : nextEnd
  return source.slice(previousStart, end).split('\n').map(markdownLineBoundarySignature).join('\n')
}

export const largeSourceDraftEditChangesStructure = (previousValue, nextValue) => {
  const previous = String(previousValue || '')
  const next = String(nextValue || '')
  if (previous === next) return false
  const sharedLimit = Math.min(previous.length, next.length)
  let prefix = 0
  while (prefix < sharedLimit && previous[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix++
  const removed = previous.slice(prefix, previous.length - suffix)
  const inserted = next.slice(prefix, next.length - suffix)
  if (/[\r\n]/.test(removed) || /[\r\n]/.test(inserted)) return true
  return markdownSignatureWindow(previous, prefix) !== markdownSignatureWindow(next, prefix)
}

export const buildLargeSourceOffsets = (
  sourceValue,
  chunkSize = DEFAULT_CHUNK_SIZE,
  boundaryLookahead = DEFAULT_BOUNDARY_LOOKAHEAD,
  maxLines = DEFAULT_MAX_LINES
) => {
  const source = String(sourceValue || '')
  const boundedChunkSize = Math.max(1, Number(chunkSize) || DEFAULT_CHUNK_SIZE)
  const boundedLookahead = Math.max(0, Number(boundaryLookahead) || 0)
  const boundedMaxLines = Math.max(1, Number(maxLines) || DEFAULT_MAX_LINES)
  const offsets = [0]
  let cursor = 0
  while (cursor < source.length) {
    const target = Math.min(source.length, cursor + boundedChunkSize)
    const limit = Math.min(source.length, target + boundedLookahead)
    const earliestUseful = cursor + Math.max(1, Math.floor((target - cursor) * 0.55))
    let bestAfterOffset = 0
    let bestAfterPriority = -1
    let bestBeforeOffset = 0
    let bestBeforePriority = -1
    let firstSafeAfter = 0
    const considerCandidate = (offset, priority) => {
      if (offset <= cursor) return
      if (offset >= target) {
        if (!firstSafeAfter || offset < firstSafeAfter) firstSafeAfter = offset
        if (offset <= limit && (
          priority > bestAfterPriority ||
          (priority === bestAfterPriority && (!bestAfterOffset || offset < bestAfterOffset))
        )) {
          bestAfterOffset = offset
          bestAfterPriority = priority
        }
        return
      }
      if (offset >= earliestUseful && (
        priority > bestBeforePriority ||
        (priority === bestBeforePriority && offset > bestBeforeOffset)
      )) {
        bestBeforeOffset = offset
        bestBeforePriority = priority
      }
    }
    let scan = cursor
    let scannedLines = 0
    let lineCap = 0
    let targetInsideAtomicBlock = false
    while (scan < source.length) {
      const simple = readSimpleMarkdownLine(source, scan)
      const simpleKind = simple ? simple % 4 : 0
      const block = simple ? null : readMarkdownBlock(source, scan)
      const blockStart = scan
      const blockEnd = simple ? (simple - simpleKind) / 4 : block.end
      const blockLines = simple ? 1 : block.lines
      const blockAtomic = simple ? false : block.atomic
      const priorityBefore = simpleKind === 3 ? 3 : block?.priorityBefore
      const priorityAfter = simpleKind === 2 ? 2 : (block?.priorityAfter || 1)
      if (priorityBefore && blockStart > cursor) considerCandidate(blockStart, priorityBefore)

      if (scannedLines > 0 && scannedLines + blockLines > boundedMaxLines) {
        lineCap = blockStart
        break
      }

      scannedLines += blockLines
      if (blockAtomic && target > blockStart && target < blockEnd) targetInsideAtomicBlock = true
      considerCandidate(blockEnd, priorityAfter)
      scan = blockEnd

      if (scannedLines >= boundedMaxLines) {
        lineCap = scan
        break
      }
      if (scan >= source.length || scan >= limit) break
    }

    const boundaryTarget = lineCap ? Math.min(target, lineCap) : target
    let end = lineCap || bestAfterOffset || bestBeforeOffset || firstSafeAfter
    if (!end) end = source.length
    if (!lineCap && !targetInsideAtomicBlock && end > limit) end = rawChunkBoundary(source, cursor, boundaryTarget)
    if (end <= cursor) end = rawChunkBoundary(source, cursor, boundaryTarget)
    offsets.push(end)
    cursor = end
  }
  if (offsets.length === 1) offsets.push(0)
  return offsets
}

export const findLargeSourcePageByOffset = (offsetsValue, offsetValue) => {
  const offsets = Array.isArray(offsetsValue) && offsetsValue.length >= 2
    ? offsetsValue
    : [0, 0]
  const offset = Math.max(0, Math.min(offsets[offsets.length - 1], Number(offsetValue) || 0))
  let low = 0
  let high = offsets.length - 2
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    // A heading exactly on a boundary belongs to the chunk on the right.
    if (offset >= offsets[middle + 1]) low = middle + 1
    else high = middle
  }
  return low
}

export const applyZeroWidthDeletion = (value, startValue, endValue, key) => {
  const source = String(value || '')
  const start = Math.max(0, Math.min(source.length, Number(startValue) || 0))
  const end = Math.max(start, Math.min(source.length, Number(endValue) || 0))
  if (start !== end) return null
  if (key === 'Backspace' && start > 0) {
    if (source[start - 1] === '\u200b') {
      const from = start >= 2 && source[start - 2] === '\n' ? start - 2 : start - 1
      return { value: source.slice(0, from) + source.slice(start), caret: from }
    }
    if (start >= 2 && source[start - 1] === '\n' && source[start - 2] === '\u200b') {
      const from = start >= 3 && source[start - 3] === '\n' ? start - 3 : start - 2
      return { value: source.slice(0, from) + source.slice(start), caret: from }
    }
  }
  if (key === 'Delete' && start < source.length && source[start] === '\u200b') {
    const to = start + 1 < source.length && source[start + 1] === '\n' ? start + 2 : start + 1
    return { value: source.slice(0, start) + source.slice(to), caret: start }
  }
  return null
}

export const estimateLargeSourceDraftCaret = (previousValue, nextValue) => {
  const previous = String(previousValue || '')
  const next = String(nextValue || '')
  const sharedLimit = Math.min(previous.length, next.length)
  let prefix = 0
  while (prefix < sharedLimit && previous[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix++
  return Math.max(prefix, next.length - suffix)
}

export const readLargeSourcePage = (sourceValue, offsetsValue, requestedPage = 0) => {
  const source = String(sourceValue || '')
  const offsets = Array.isArray(offsetsValue) && offsetsValue.length >= 2
    ? offsetsValue
    : buildLargeSourceOffsets(source)
  const page = Math.max(0, Math.min(offsets.length - 2, Number(requestedPage) || 0))
  return {
    page,
    start: offsets[page],
    end: offsets[page + 1],
    draft: source.slice(offsets[page], offsets[page + 1])
  }
}

// This is deliberately the only operation that splices the immutable full
// source string. Keystrokes mutate only the bounded page draft; idle/boundary
// commits call this once for the whole burst.
export const applyLargeSourcePageDraft = (sourceValue, offsetsValue, requestedPage, draftValue) => {
  const source = String(sourceValue || '')
  const offsets = Array.isArray(offsetsValue) && offsetsValue.length >= 2
    ? offsetsValue
    : buildLargeSourceOffsets(source)
  const page = Math.max(0, Math.min(offsets.length - 2, Number(requestedPage) || 0))
  const start = offsets[page]
  const previousEnd = offsets[page + 1]
  const draft = String(draftValue ?? '')
  const previousDraft = source.slice(start, previousEnd)
  if (draft === previousDraft) {
    return {
      source,
      offsets,
      page,
      start,
      previousEnd,
      end: previousEnd,
      delta: 0,
      changed: false,
      requiresOffsetRebuild: false
    }
  }

  const nextSource = source.slice(0, start) + draft + source.slice(previousEnd)
  const delta = draft.length - (previousEnd - start)
  const requiresOffsetRebuild = largeSourceDraftEditChangesStructure(previousDraft, draft)
  const nextOffsets = offsets.slice()
  if (delta) {
    for (let index = page + 1; index < nextOffsets.length; index++) nextOffsets[index] += delta
  }
  return {
    source: nextSource,
    offsets: nextOffsets,
    page,
    start,
    previousEnd,
    end: previousEnd + delta,
    delta,
    changed: true,
    requiresOffsetRebuild
  }
}
export const rebalanceLargeSourceView = (
  sourceValue,
  offsetsValue,
  requestedPage,
  localCaretValue,
  chunkSize = DEFAULT_CHUNK_SIZE,
  forceRebuild = false
) => {
  const source = String(sourceValue || '')
  const offsets = Array.isArray(offsetsValue) && offsetsValue.length >= 2
    ? offsetsValue
    : buildLargeSourceOffsets(source, chunkSize)
  const current = readLargeSourcePage(source, offsets, requestedPage)
  const boundedChunkSize = Math.max(1, Number(chunkSize) || DEFAULT_CHUNK_SIZE)
  const removedWholeChunk = current.draft.length === 0 && offsets.length > 2
  if (current.draft.length <= boundedChunkSize * 2 && !removedWholeChunk && forceRebuild !== true) return null

  const globalCaret = current.start + Math.max(
    0,
    Math.min(current.draft.length, Number(localCaretValue) || 0)
  )
  const nextOffsets = buildLargeSourceOffsets(source, boundedChunkSize)
  const pageState = readLargeSourcePage(source, nextOffsets, findLargeSourcePageByOffset(nextOffsets, globalCaret))
  return {
    ...pageState,
    offsets: nextOffsets,
    caret: Math.max(0, Math.min(pageState.draft.length, globalCaret - pageState.start))
  }
}
