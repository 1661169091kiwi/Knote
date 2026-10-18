const NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

// Native pointer selection owns its scrolling. Following selectionStart on a
// document selectionchange/mouseup pulls a downward range back to its anchor.
export const sourceCaretFollowIndex = (selection, event) => {
  if (event?.type !== 'input' && !(event?.type === 'keyup' && NAVIGATION_KEYS.has(event.key))) return null
  return selection.selectionDirection === 'backward' ? selection.selectionStart : selection.selectionEnd
}
