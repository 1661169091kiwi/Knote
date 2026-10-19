import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { CellSelection, TableMap, cellAround, deleteCellSelection, tableEditingKey } from '@tiptap/pm/tables'
import { DOMSerializer } from '@tiptap/pm/model'

export const tableInteractionKey = new PluginKey('knoteTableInteraction')

// posAtCoords clamps paragraph whitespace to a text boundary. Only delegate
// to native selection when the pointer actually intersects an adjacent glyph.
// Inspect at most two characters, not every text node in a large table/cell.
function pointerHitsText(view, resolved, event) {
  const range = view.dom.ownerDocument.createRange()
  for (const direction of [-1, 1]) {
    const neighbour = direction < 0 ? resolved.nodeBefore : resolved.nodeAfter
    if (!neighbour?.isText) continue
    const from = view.domAtPos(resolved.pos + (direction < 0 ? -1 : 0))
    const to = view.domAtPos(resolved.pos + (direction > 0 ? 1 : 0))
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
    if ([...range.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)) return true
  }
  return false
}

export function tableSelectionInfo(selection) {
  const anchor = selection instanceof CellSelection ? selection.$anchorCell : cellAround(selection.$anchor)
  const head = selection instanceof CellSelection ? selection.$headCell : cellAround(selection.$head)
  if (!anchor || !head || anchor.start(-1) !== head.start(-1)) return null
  const table = anchor.node(-1), start = anchor.start(-1)
  // A caret highlight only needs two ancestor paths. Do not build a grid of
  // a potentially huge table just because the caret moved or text changed.
  return {
    anchor, head, table, start,
    get map() { return TableMap.get(table) },
    get rect() { return this.map.rectBetween(anchor.pos - start, head.pos - start) }
  }
}

export function tableSelectionText(selection) {
  const info = tableSelectionInfo(selection)
  if (!info) return ''
  const { map, table, rect } = info
  const rows = []
  for (let row = rect.top; row < rect.bottom; row++) {
    const cells = []
    for (let col = rect.left; col < rect.right; col++) {
      const offset = map.map[row * map.width + col]
      const origin = map.findCell(offset)
      const cell = table.nodeAt(offset)
      cells.push(origin.top === row && origin.left === col
        ? cell.textBetween(0, cell.content.size, ' ', leaf => leaf.type.name === 'hardBreak' ? ' ' : '').replace(/[\t\r\n]/g, ' ')
        : '')
    }
    rows.push(cells.join('\t'))
  }
  return rows.join('\n')
}

function writeCells(view, event) {
  if (!(view.state.selection instanceof CellSelection) || !event.clipboardData) return false
  const holder = view.dom.ownerDocument.createElement('div')
  const fragment = DOMSerializer.fromSchema(view.state.schema).serializeFragment(view.state.selection.content().content)
  if (fragment.firstChild?.nodeName === 'TABLE') holder.appendChild(fragment)
  else {
    // CellSelection slices are commonly open at the table level and contain
    // bare TRs. External apps discard those without a real table container.
    const table = view.dom.ownerDocument.createElement('table')
    const body = view.dom.ownerDocument.createElement('tbody')
    body.appendChild(fragment)
    table.appendChild(body)
    holder.appendChild(table)
  }
  event.clipboardData.setData('text/plain', tableSelectionText(view.state.selection))
  event.clipboardData.setData('text/html', holder.innerHTML)
  event.preventDefault()
  return true
}

// A normal caret click still uses ProseMirror's native text-selection path.
// Only crossing a cell boundary (or using its narrow selection band) takes
// over the gesture. All listeners and the optional edge-scroll RAF are scoped
// to that one gesture; no document scans or idle animation frames are used.
export function tableInteractionPlugin() {
  let startGesture = () => false
  let cancelGesture = () => {}
  return new Plugin({
    key: tableInteractionKey,
    props: {
      decorations(state) {
        const info = tableSelectionInfo(state.selection)
        if (!info || state.selection instanceof CellSelection) return null
        const cell = state.doc.nodeAt(info.head.pos)
        return DecorationSet.create(state.doc, [Decoration.node(info.head.pos, info.head.pos + cell.nodeSize, { class: 'knote-active-cell' })])
      },
      handleDOMEvents: {
        mousedown: (view, event) => startGesture(event),
        blur: () => { cancelGesture(); return false },
        dragstart: (view, event) => {
          if (!(view.state.selection instanceof CellSelection)) return false
          event.preventDefault(); cancelGesture(); return true
        },
        copy: writeCells,
        cut(view, event) {
          if (!writeCells(view, event)) return false
          deleteCellSelection(view.state, view.dispatch)
          return true
        }
      },
      handleKeyDown(view, event) {
        if (event.key === 'Escape') {
          cancelGesture()
          if (!(view.state.selection instanceof CellSelection)) return false
          view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.selection.$headCell)).setMeta('addToHistory', false))
          return true
        }
        // TipTap's default table shortcut deletes the TABLE when all cells
        // are selected. Here Delete always clears contents, never structure.
        if ((event.key === 'Delete' || event.key === 'Backspace') && view.state.selection instanceof CellSelection) {
          event.preventDefault()
          return deleteCellSelection(view.state, view.dispatch)
        }
        return false
      }
    },
    view(view) {
      const win = view.dom.ownerDocument.defaultView
      let gesture = null, frame = 0, disposed = false
      const stop = () => {
        gesture = null
        if (frame) win.cancelAnimationFrame(frame)
        frame = 0
        win.removeEventListener('mousemove', move, true)
        win.removeEventListener('mouseup', up, true)
        win.removeEventListener('blur', stop)
        win.removeEventListener('keydown', escape, true)
        if (!disposed && !view.isDestroyed && tableEditingKey.getState(view.state) != null) {
          view.dispatch(view.state.tr.setMeta(tableEditingKey, -1).setMeta('addToHistory', false))
        }
      }
      cancelGesture = stop
      const escape = event => { if (event.key === 'Escape') stop() }
      const findCell = element => {
        const cell = element?.closest?.('td,th')
        if (!cell || !view.dom.contains(cell)) return null
        const pos = view.posAtDOM(cell, 0)
        return cellAround(view.state.doc.resolve(pos))
      }
      const select = head => {
        if (!gesture || !head || gesture.anchor.start(-1) !== head.start(-1)) return
        const selection = new CellSelection(gesture.anchor, head)
        if (!selection.eq(view.state.selection) || tableEditingKey.getState(view.state) == null) {
          view.dispatch(view.state.tr.setSelection(selection).setMeta(tableEditingKey, gesture.anchor.pos).setMeta('addToHistory', false))
        }
      }
      const edgeVelocity = () => {
        if (!gesture?.rectangular) return 0
        const rect = gesture.scroller.getBoundingClientRect()
        const top = Math.max(0, rect.top), bottom = Math.min(win.innerHeight, rect.bottom)
        return gesture.y < top + 28 ? -Math.min(16, (top + 28 - gesture.y) / 2)
          : gesture.y > bottom - 28 ? Math.min(16, (gesture.y - bottom + 28) / 2) : 0
      }
      const tick = () => {
        frame = 0
        if (!gesture) return
        const speed = edgeVelocity()
        if (!speed) return
        const before = gesture.scroller.scrollTop
        gesture.scroller.scrollTop += speed
        if (gesture.scroller.scrollTop === before) return
        const bounds = gesture.scroller.getBoundingClientRect()
        const y = Math.max(Math.max(0, bounds.top) + 2, Math.min(Math.min(win.innerHeight, bounds.bottom) - 2, gesture.y))
        select(findCell(view.dom.ownerDocument.elementFromPoint(gesture.x, y)))
        frame = win.requestAnimationFrame(tick)
      }
      const move = event => {
        if (!gesture) return
        if (!(event.buttons & 1)) { stop(); return }
        gesture.x = event.clientX; gesture.y = event.clientY
        const head = findCell(view.dom.ownerDocument.elementFromPoint(event.clientX, event.clientY))
        if (head && head.pos !== gesture.anchor.pos && Math.hypot(event.clientX - gesture.originX, event.clientY - gesture.originY) >= 6) gesture.rectangular = true
        if (gesture.rectangular) {
          event.preventDefault()
          select(head)
          if (!frame && edgeVelocity()) frame = win.requestAnimationFrame(tick)
        }
      }
      const up = () => stop()
      startGesture = event => {
        stop()
        if (event.button !== 0 || event.ctrlKey || event.metaKey || !view.editable) return false
        if (event.target.closest?.('img, [contenteditable="false"]')) return false
        const head = findCell(event.target)
        if (!head) return false
        const previous = tableSelectionInfo(view.state.selection)
        const anchor = event.shiftKey && previous?.start === head.start(-1) ? previous.anchor : head
        const cell = event.target.closest('td,th')
        const band = event.clientX - cell.getBoundingClientRect().left <= 6
        let scroller = view.dom.parentElement
        while (scroller.parentElement && !/(auto|scroll)/.test(win.getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
        gesture = { anchor, doc: view.state.doc, x: event.clientX, y: event.clientY, originX: event.clientX, originY: event.clientY, rectangular: band || (event.shiftKey && anchor.pos !== head.pos), scroller }
        win.addEventListener('mousemove', move, true)
        win.addEventListener('mouseup', up, true)
        win.addEventListener('blur', stop)
        win.addEventListener('keydown', escape, true)
        if (!gesture.rectangular) {
          const content = head.nodeAfter
          const emptyParagraph = content.childCount === 1 && content.firstChild.isTextblock && content.firstChild.content.size === 0
          const hit = emptyParagraph ? null : view.posAtCoords({ left: event.clientX, top: event.clientY })
          const resolvedHit = hit ? view.state.doc.resolve(hit.pos) : null
          const ownTextHit = resolvedHit?.parent.inlineContent && cellAround(resolvedHit)?.pos === head.pos
          // Keep native text selection only when the coordinate hit is an
          // actual text position in this DOM cell. Paragraph/inline whitespace
          // can otherwise resolve to the previous cell just like TD padding.
          if (event.target !== cell && !emptyParagraph && ownTextHit && pointerHitsText(view, resolvedHit, event)) return false
          const end = head.pos + head.nodeAfter.nodeSize - 1
          const atStart = !emptyParagraph && !ownTextHit && hit && hit.pos <= head.pos + 1
          const pos = emptyParagraph ? head.pos + 2 : ownTextHit ? hit.pos : atStart ? head.pos + 1 : end
          event.preventDefault()
          // At the first paragraph boundary search forwards, not backwards
          // into the preceding cell. The end boundary searches backwards.
          view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos), atStart ? 1 : -1)).setMeta('addToHistory', false))
          view.focus()
          return true
        }
        event.preventDefault()
        view.focus()
        select(head)
        return true
      }
      return {
        update() { if (gesture && gesture.doc !== view.state.doc) stop() },
        destroy() { disposed = true; stop(); startGesture = () => false; cancelGesture = () => {} }
      }
    }
  })
}
