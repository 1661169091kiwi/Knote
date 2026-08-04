const defaultYieldControl = () => new Promise((resolve) => {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(() => resolve(), { timeout: 48 })
  } else {
    setTimeout(resolve, 0)
  }
})

const whitespaceCode = (code) => (
  code <= 0x20 ||
  code === 0x85 ||
  code === 0xa0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000 ||
  code === 0xfeff
)

// Knote's compact image marker is deliberately bounded. A malformed Markdown
// image must never make a metrics pass search the rest of a multi-megabyte
// document for a closing parenthesis.
const boundedImageMarker = (source, start) => {
  if (source.charCodeAt(start) !== 33 || source.charCodeAt(start + 1) !== 91) return null
  const probeEnd = Math.min(source.length, start + 2048)
  const labelEndOffset = source.slice(start + 2, probeEnd).indexOf('](')
  if (labelEndOffset < 0) return null
  const targetStart = start + 2 + labelEndOffset + 2
  if (!source.startsWith('knote-img:', targetStart)) return null
  const closeOffset = source.slice(targetStart, probeEnd).indexOf(')')
  if (closeOffset < 0) return null
  return {
    end: targetStart + closeOffset + 1,
    id: source.slice(targetStart + 10, targetStart + closeOffset)
  }
}

const boundedAlignmentEnd = (source, start) => {
  if (source.charCodeAt(start) !== 58 || !source.startsWith(':::', start)) return -1
  const match = /^:::\s*align:\w+\s*:::\n?/.exec(source.slice(start, Math.min(source.length, start + 192)))
  return match ? start + match[0].length : -1
}

const plainHeading = (source, truncated) => {
  const plain = source
    .replace(/<[^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!~])/g, '$1')
    .replace(/[*_`~]|==|\+\+|\[\^[^\]]*\]/g, '')
    .replace(/\s+#+\s*$/, '')
    .trim()
  return truncated && plain ? `${plain}…` : plain
}

/**
 * Scan a document once for all header/sidebar metrics.
 *
 * Keeping this as one cancellable pass is important: the old UI separately
 * scanned statistics, outline headings and missing image references. An 8 MiB
 * document therefore paid for two or three complete O(n) walks after every
 * navigation. Options let a hidden outline stay cold without repeating the
 * already cached statistics later.
 */
export const analyzeDocumentChunked = async (value, options = {}) => {
  const source = String(value || '')
  const chunkSize = Math.max(256, Number(options.chunkSize) || 48_000)
  const includeStats = options.includeStats !== false
  const includeOutline = options.includeOutline === true
  const includeMissingImages = options.includeMissingImages !== false
  const maxOutlineItems = Math.max(0, Number.isFinite(Number(options.maxOutlineItems))
    ? Number(options.maxOutlineItems)
    : Number.POSITIVE_INFINITY)
  const hasImage = typeof options.hasImage === 'function' ? options.hasImage : () => false
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : () => false
  const yieldControl = typeof options.yieldControl === 'function' ? options.yieldControl : defaultYieldControl
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null

  let chars = 0
  let lines = 0
  let words = 0
  let lineHasText = false
  let inWord = false
  let statsSkipUntil = 0

  const outline = []
  let outlineTruncated = false
  let fence = null
  let lineStart = 0
  let lineNumber = 0
  const consumeLine = (start, end) => {
    if (!includeOutline) return
    const labelTruncated = end - start > 2048
    const raw = source.slice(start, Math.min(end, start + 2048))
    if (fence) {
      const close = !labelTruncated && /^ {0,3}(`{3,}|~{3,})\s*$/.exec(raw)
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null
      return
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw)
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { ch: open[1][0], len: open[1].length }
      return
    }
    const match = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(raw)
    if (!match) return
    if (outline.length >= maxOutlineItems) {
      outlineTruncated = true
      return
    }
    outline.push({
      id: `heading-line-${lineNumber}`,
      index: outline.length,
      line: lineNumber,
      offset: start,
      level: match[1].length,
      text: plainHeading(match[2], labelTruncated)
    })
  }

  const missingIds = new Set()
  let index = 0
  while (index < source.length) {
    if (shouldCancel()) return null
    const boundary = Math.min(source.length, index + chunkSize)
    while (index < boundary) {
      const code = source.charCodeAt(index)

      // Outline parsing observes raw line boundaries even while a compact
      // marker is excluded from character/word counts.
      if (code === 0x0a) {
        consumeLine(lineStart, index)
        lineStart = index + 1
        lineNumber++
      }

      if (index >= statsSkipUntil && code === 33) {
        const marker = boundedImageMarker(source, index)
        if (marker) {
          statsSkipUntil = marker.end
          if (includeMissingImages && marker.id && !hasImage(marker.id)) missingIds.add(marker.id)
        }
      } else if (index >= statsSkipUntil && code === 58) {
        const alignmentEnd = boundedAlignmentEnd(source, index)
        if (alignmentEnd > index) statsSkipUntil = alignmentEnd
      }

      if (includeStats && index >= statsSkipUntil) {
        if (code !== 0x200b && code !== 0x0d) {
          chars++
          const whitespace = whitespaceCode(code)
          if (code === 0x0a) {
            if (lineHasText) lines++
            lineHasText = false
          } else if (!whitespace) {
            lineHasText = true
          }
          if (whitespace) inWord = false
          else if (!inWord) {
            words++
            inWord = true
          }
        }
      }
      index++
    }
    if (index < source.length) {
      if (onProgress) onProgress({ processed: index, total: source.length })
      await yieldControl()
    }
  }

  consumeLine(lineStart, source.length)
  if (shouldCancel()) return null
  if (includeStats && lineHasText) lines++
  if (onProgress) onProgress({ processed: source.length, total: source.length })
  return {
    stats: includeStats ? { chars, lines, words } : null,
    outline: includeOutline ? outline : null,
    outlineTruncated,
    missingImageCount: includeMissingImages ? missingIds.size : null
  }
}

export const countDocumentStatsChunked = async (value, options = {}) => {
  const result = await analyzeDocumentChunked(value, {
    ...options,
    includeStats: true,
    includeOutline: false,
    includeMissingImages: false
  })
  return result ? result.stats : null
}

export const extractOutlineChunked = async (value, options = {}) => {
  const result = await analyzeDocumentChunked(value, {
    ...options,
    includeStats: false,
    includeOutline: true,
    includeMissingImages: false
  })
  return result ? result.outline : null
}

// Sidebar outline view-model. The analyzer emits one flat, level-ordered
// heading list; this derives the display list: rows under a collapsed heading
// disappear (the heading bar itself stays), the first N rows are returned for
// progressive rendering, and `hasChildren` drives the collapse chevrons.
export const filterOutlineItemsForSidebar = (itemsValue, collapsedIdsValue, limitValue) => {
  const items = Array.isArray(itemsValue) ? itemsValue : []
  const collapsed = collapsedIdsValue instanceof Set ? collapsedIdsValue : new Set()
  const limit = Math.max(1, Number(limitValue) || Number.POSITIVE_INFINITY)
  const ancestors = []
  const hasChildren = new Set()
  const visible = []
  for (const item of items) {
    if (!item || typeof item.level !== 'number') continue
    while (ancestors.length && ancestors[ancestors.length - 1].level >= item.level) ancestors.pop()
    if (ancestors.length) hasChildren.add(ancestors[ancestors.length - 1].id)
    if (!ancestors.some((a) => collapsed.has(a.id))) {
      visible.push(item)
      if (visible.length >= limit) return { visible, hasChildren }
    }
    ancestors.push({ level: item.level, id: item.id })
  }
  return { visible, hasChildren }
}
