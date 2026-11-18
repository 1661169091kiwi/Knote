// Windowed rendering for long Agent conversations.
//
// A long chat used to keep every message mounted: 400 messages are ~32k DOM
// nodes, so opening the session, any full restyle and every Vue patch of the
// panel paid for all of them. Past VIRTUAL_ROW_THRESHOLD rows only the rows in
// (and around) the viewport are mounted; the rest are two spacer blocks whose
// heights come from the rows' measured sizes (an estimate until a row has been
// seen). Kept pure so the window maths is testable without a DOM.

// Shorter chats keep every row mounted: nothing to win, and find-in-page,
// long selections and tests see the whole conversation as before.
export const VIRTUAL_ROW_THRESHOLD = 60
// A row's slot: its border box plus the 16px gap below it. Matches the
// `contain-intrinsic-size` of an unrendered row (200px) + that gap.
export const ESTIMATED_ROW_HEIGHT = 216
// Mount rows this far above and below the viewport, so ordinary scrolling never
// reaches a spacer before the next frame has mounted its rows.
export const OVERSCAN_PX = 1200
export const MIN_WINDOW_ROWS = 12

const slot = (heights, key, estimate) => {
  const height = heights?.get?.(key)
  return Number.isFinite(height) && height >= 0 ? height : estimate
}

// offsets[i] is the top of row i, offsets[count] the total height.
export const rowOffsets = (keys, heights, estimate = ESTIMATED_ROW_HEIGHT) => {
  const list = Array.isArray(keys) ? keys : []
  const offsets = new Array(list.length + 1)
  offsets[0] = 0
  for (let index = 0; index < list.length; index++) {
    offsets[index + 1] = offsets[index] + slot(heights, list[index], estimate)
  }
  return offsets
}

// The last row whose top is at or above y (0 for an empty list).
export const rowIndexAt = (offsets, y) => {
  let low = 0
  let high = offsets.length - 2
  if (high < 0) return 0
  if (y <= 0) return 0
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (offsets[middle] <= y) low = middle
    else high = middle - 1
  }
  return low
}

// The rows to mount for a viewport. `pinEnd` (following the newest message)
// always mounts through the last row, whatever the scroll position says.
export const windowFor = ({
  offsets,
  scrollTop = 0,
  viewport = 0,
  overscan = OVERSCAN_PX,
  minRows = MIN_WINDOW_ROWS,
  pinEnd = false
}) => {
  const count = Math.max(0, (offsets?.length || 1) - 1)
  if (!count) return { start: 0, end: 0 }
  const span = Math.max(0, viewport)
  let start
  let end
  if (pinEnd) {
    end = count
    start = rowIndexAt(offsets, Math.max(0, offsets[count] - span - overscan))
  } else {
    const top = Math.max(0, scrollTop)
    start = rowIndexAt(offsets, top - overscan)
    end = Math.min(count, rowIndexAt(offsets, top + span + overscan) + 1)
  }
  if (end - start < minRows) {
    if (pinEnd || end === count) start = Math.max(0, end - minRows)
    else end = Math.min(count, start + minRows)
  }
  return { start, end }
}

// Spacer heights around a window.
export const windowPadding = (offsets, { start, end }) => {
  const count = Math.max(0, (offsets?.length || 1) - 1)
  const total = count ? offsets[count] : 0
  const top = count ? offsets[Math.min(start, count)] : 0
  const bottom = count ? total - offsets[Math.min(end, count)] : 0
  return { top, bottom }
}
