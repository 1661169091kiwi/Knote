const clamp = (value, min, max) => Math.max(min, Math.min(Math.max(min, max), value))

// Pure viewport placement: keep a toolbar visible without scrolling or
// changing the editor selection. Coordinates are CSS pixels, not DPR pixels.
export function selectionToolbarPosition(anchor, bounds, width, height, gap = 12) {
  return {
    left: clamp(anchor.left, bounds.left, bounds.right - width),
    top: clamp(anchor.top - gap - height, bounds.top, bounds.bottom - height)
  }
}

export function tablePickerPosition(trigger, viewport, width, height, gap = 8) {
  const side = trigger.right + gap + width <= viewport.right ? 'right' : 'left'
  return {
    side,
    left: clamp(side === 'right' ? trigger.right + gap : trigger.left - gap - width, viewport.left, viewport.right - width),
    top: clamp(trigger.top, viewport.top, viewport.bottom - height)
  }
}
