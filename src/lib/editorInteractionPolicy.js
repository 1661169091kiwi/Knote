// Resolve only the selected table, never the table currently under the mouse.
export function selectedTableContext(selection) {
  if (!selection) return null
  if (selection.node?.type?.name === 'table') return { pos: selection.from, node: selection.node }
  const find = ($pos) => {
    if (!$pos) return null
    for (let depth = $pos.depth; depth > 0; depth--) {
      const node = $pos.node(depth)
      if (node.type.name === 'table') return { pos: $pos.before(depth), node }
    }
    return null
  }
  const from = find(selection.$anchorCell || selection.$from)
  const to = find(selection.$headCell || selection.$to)
  return from && to && from.pos === to.pos ? from : null
}

// Do not disable pointer selection itself, block handles, file-tree DnD or
// image dragging. Cancel only native dragstart for an existing text selection.
export function preventNativeTextDrag(event, selection) {
  const target = event?.target?.nodeType === 3 ? event.target.parentElement : event?.target
  if (!target?.closest || target.closest('.knote-gutter, [data-knote-block-drag], img')) return false
  const input = target.closest('textarea, input')
  let selected = false
  if (input) {
    selected = typeof input.selectionStart === 'number' && input.selectionEnd > input.selectionStart
  } else if (target.closest('.ProseMirror, .knote-md-render, .knote-agent-panel, [contenteditable="true"]')) {
    const nativeSelection = selection ?? globalThis.getSelection?.()
    selected = Boolean(nativeSelection && !nativeSelection.isCollapsed && nativeSelection.rangeCount && nativeSelection.toString().length && nativeSelection.containsNode(target, true))
  }
  if (!selected) return false
  event.preventDefault()
  return true
}
