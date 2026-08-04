const DEFAULT_CHUNK_SIZE = 64_000
const DEFAULT_BOUNDARY_LOOKAHEAD = 4_096
const DEFAULT_MAX_LINES = 1_800

const fenceMarker = (line) => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
const closesFence = (line, fence) => {
  const match = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(line)
  return !!(match && match[1][0] === fence.ch && match[1].length >= fence.len)
}

const rawChunkBoundary = (source, target) => {
  let boundary = Math.max(1, Math.min(source.length, target))
  const previous = source.charCodeAt(boundary - 1)
  const next = source.charCodeAt(boundary)
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) boundary++
  if (source[boundary - 1] === '\r' && source[boundary] === '\n') boundary++
  return Math.min(source.length, boundary)
}

const chooseChunkBoundary = (candidates, cursor, target, limit) => {
  const usable = candidates.filter((candidate) => candidate.offset > cursor)
  const after = usable
    .filter((candidate) => candidate.offset >= target && candidate.offset <= limit)
    .sort((a, b) => b.priority - a.priority || a.offset - b.offset)
  if (after.length) return after[0].offset

  // Do not create a tiny trailing fragment merely to hit the target exactly.
  const earliestUseful = cursor + Math.max(1, Math.floor((target - cursor) * 0.55))
  const before = usable
    .filter((candidate) => candidate.offset >= earliestUseful && candidate.offset < target)
    .sort((a, b) => b.priority - a.priority || b.offset - a.offset)
  if (before.length) return before[0].offset

  const firstSafeAfter = usable.find((candidate) => candidate.offset >= target)
  return firstSafeAfter ? firstSafeAfter.offset : 0
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
    if (target >= source.length) {
      offsets.push(source.length)
      break
    }

    const limit = Math.min(source.length, target + boundedLookahead)
    const candidates = []
    let lineStart = cursor
    let fence = null
    let targetInsideFence = false
    let scannedLines = 0
    let lineCap = 0
    let scannedPastLimit = false
    while (lineStart < source.length) {
      const newline = source.indexOf('\n', lineStart)
      const lineEnd = newline >= 0 ? newline : source.length
      const nextLine = newline >= 0 ? newline + 1 : source.length
      const line = source.slice(lineStart, lineEnd)

      let protectedLine = !!fence
      if (fence) {
        if (closesFence(line, fence)) fence = null
      } else {
        const marker = fenceMarker(line)
        if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
          fence = { ch: marker[1][0], len: marker[1].length }
          protectedLine = true
        } else {
          if (lineStart > cursor && /^ {0,3}#{1,6}[\t ]+/.test(line)) {
            candidates.push({ offset: lineStart, priority: 3 })
          }
          if (!line.trim() && nextLine > cursor) {
            candidates.push({ offset: nextLine, priority: 2 })
          }
        }
      }

      if (target >= lineStart && target < nextLine && protectedLine) targetInsideFence = true

      if (!fence && nextLine > cursor) candidates.push({ offset: nextLine, priority: 1 })
      scannedLines++
      if (scannedLines >= boundedMaxLines && !fence) {
        lineCap = nextLine
        break
      }
      if (nextLine >= limit) scannedPastLimit = true
      if (scannedPastLimit && !fence) break
      if (nextLine >= source.length) break
      lineStart = nextLine
    }

    const boundaryTarget = lineCap ? Math.min(target, lineCap) : target
    const boundaryLimit = lineCap || limit
    let end = chooseChunkBoundary(candidates, cursor, boundaryTarget, boundaryLimit)
    if (!end) end = source.length
    if (!lineCap && !targetInsideFence && end > limit) end = rawChunkBoundary(source, boundaryTarget)
    if (end <= cursor) end = rawChunkBoundary(source, boundaryTarget)
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
    return { source, offsets, page, start, previousEnd, end: previousEnd, delta: 0, changed: false }
  }

  const nextSource = source.slice(0, start) + draft + source.slice(previousEnd)
  const delta = draft.length - (previousEnd - start)
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
    changed: true
  }
}
export const rebalanceLargeSourceView = (
  sourceValue,
  offsetsValue,
  requestedPage,
  localCaretValue,
  chunkSize = DEFAULT_CHUNK_SIZE
) => {
  const source = String(sourceValue || '')
  const offsets = Array.isArray(offsetsValue) && offsetsValue.length >= 2
    ? offsetsValue
    : buildLargeSourceOffsets(source, chunkSize)
  const current = readLargeSourcePage(source, offsets, requestedPage)
  const boundedChunkSize = Math.max(1, Number(chunkSize) || DEFAULT_CHUNK_SIZE)
  const removedWholeChunk = current.draft.length === 0 && offsets.length > 2
  if (current.draft.length <= boundedChunkSize * 2 && !removedWholeChunk) return null

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
