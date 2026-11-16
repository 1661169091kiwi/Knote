import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { SIDEBAR_WIDTHS_KEY, DEFAULT_SIDEBAR_WIDTHS, DEFAULT_EDITOR_WIDTH, EDITOR_WIDTH_MIN, RAIL_FILL_MAX, normalizeSidebarWidths, fitSidebarWidths } from './sidebarWidths.js'

export const useSidebarWidths = ({ leftVisible, agentVisible, centered = () => false }) => {
  const workbenchRef = ref(null)
  let wanted
  try { wanted = normalizeSidebarWidths(JSON.parse(localStorage.getItem(SIDEBAR_WIDTHS_KEY) || '{}')) } catch { wanted = { ...DEFAULT_SIDEBAR_WIDTHS } }
  const widths = ref({ ...wanted })
  let observer, gesture = null, frame = 0, observedWidth = -1
  // The centered workbench cap: the editor plus a full rail (30rem, or a rail
  // stored wider) on each side, plus the two gaps. Rails fill their side of a
  // centered editor up to that (lib/sidebarWidths.js); beyond it the window gets
  // symmetric outer margins.
  const capFor = (editor, left, agent) => Math.round(editor + 2 * Math.max(RAIL_FILL_MAX, left, agent) + 32)
  const measured = () => workbenchRef.value?.clientWidth || window.innerWidth
  // At rest the workbench is measured (it already reflects the painted cap).
  const fit = (value, side = '') => fitSidebarWidths(value, measured(), leftVisible(), agentVisible(), side, centered())
  // The room the workbench may take: its parent's content box, never less than
  // what it measures now.
  const room = () => {
    const parent = workbenchRef.value?.parentElement
    if (!parent) return measured()
    const style = getComputedStyle(parent)
    return Math.max(measured(), parent.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0))
  }
  // During a drag the centered cap moves with the dragged widths, so the
  // workbench lags a frame behind: fit against the width it WILL have.
  const fitDuring = (value, side) => {
    const normalized = normalizeSidebarWidths(value)
    const available = centered()
      ? Math.min(gesture.room, capFor(normalized.editor, normalized.left, normalized.agent))
      : gesture.available
    return fitSidebarWidths(normalized, available, leftVisible(), agentVisible(), side, centered())
  }
  const paint = (value) => {
    const el = workbenchRef.value
    if (!el) return
    el.style.setProperty('--knote-sidebar-width', `${value.left}px`)
    el.style.setProperty('--knote-agent-sidebar-width', `${value.agent}px`)
    el.style.setProperty('--knote-editor-width', `${value.editor}px`)
    el.style.setProperty('--knote-centered-workbench-width', `${capFor(value.editor, value.left, value.agent)}px`)
  }
  const sync = () => { if (!gesture) { widths.value = fit(wanted); paint(widths.value) } }
  const persist = () => { try { localStorage.setItem(SIDEBAR_WIDTHS_KEY, JSON.stringify(wanted)) } catch { /* width is non-critical */ } }
  // A rail filling its side of a centered editor is wider than its stored
  // width: there, the rail's divider is really the editor's edge. Dragging it
  // (or its arrow keys) resizes the centered editor by twice the move, so the
  // boundary follows the pointer and both rails fill the new sides.
  const fillDriven = (side) => centered() && side !== 'editor' && widths.value[side] > wanted[side] + 0.5
  const editorFor = (startEditor, delta) => Math.max(EDITOR_WIDTH_MIN, Math.min(1600, startEditor - 2 * delta))
  const finish = (commit = true) => {
    if (!gesture) return
    cancelAnimationFrame(frame)
    const ended = gesture
    gesture = null
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('blur', cancel)
    try { ended.target.releasePointerCapture(ended.pointerId) } catch { /* capture already lost */ }
    delete ended.target.dataset.resizing
    if (workbenchRef.value) delete workbenchRef.value.dataset.resizingSidebars
    const stored = ended.fillDriven ? 'editor' : ended.side
    if (commit && Math.abs(ended.latest[stored] - ended.start[stored]) >= .5) {
      wanted = { ...wanted, [stored]: ended.latest[stored] }; persist()
    }
    sync()
  }
  const move = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    // the divider sits on the column's left edge for the assistant rail and the
    // editor, so dragging left grows both; the left rail owns its right edge
    const delta = (event.clientX - gesture.x) * (gesture.side === 'left' ? 1 : -1)
    // The window's room is captured at gesture start. Pointer frames only
    // mutate CSS variables; no editor/Agent reactive update or disk write.
    gesture.latest = gesture.fillDriven
      ? fitDuring({ ...wanted, editor: editorFor(gesture.start.editor, delta) }, 'editor')
      : fitDuring({ ...gesture.start, [gesture.side]: gesture.start[gesture.side] + delta }, gesture.side)
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => { if (gesture) paint(gesture.latest) })
  }
  const up = (e) => { if (gesture && e.pointerId === gesture.pointerId) { move(e); finish(true) } }
  const cancel = () => finish(false)
  const start = (side, event) => {
    if (event.button !== 0 || !workbenchRef.value) return
    event.preventDefault()
    finish(false)
    gesture = {
      side,
      fillDriven: fillDriven(side),
      x: event.clientX,
      start: { ...widths.value },
      latest: { ...widths.value },
      room: room(),
      available: measured(),
      viewport: window.innerWidth,
      pointerId: event.pointerId,
      target: event.currentTarget
    }
    workbenchRef.value.dataset.resizingSidebars = 'true'
    event.currentTarget.dataset.resizing = 'true'
    event.currentTarget.setPointerCapture(event.pointerId)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
  }
  const reset = (side) => { finish(false); wanted[side] = DEFAULT_SIDEBAR_WIDTHS[side] ?? DEFAULT_EDITOR_WIDTH; persist(); sync() }
  const keydown = (side, event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') { reset(side); return }
    // the arrow moves the divider itself: left shrinks the left rail and widens
    // both the editor column and the assistant rail
    const delta = (event.key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1) * (event.shiftKey ? 40 : 10)
    if (fillDriven(side)) wanted.editor = fit({ ...wanted, editor: editorFor(widths.value.editor, delta) }, 'editor').editor
    else wanted[side] = fit({ ...widths.value, [side]: widths.value[side] + delta }, side)[side]
    persist(); sync()
  }
  watch([leftVisible, agentVisible, centered], sync, { flush: 'post' })
  onMounted(() => {
    observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width
      if (nextWidth === observedWidth) return
      observedWidth = nextWidth
      if (gesture) {
        // a drag moves the centered cap, so the workbench resizes under it: that
        // is the drag itself. Only a real window resize invalidates its geometry.
        if (window.innerWidth === gesture.viewport) return
        finish(false)
      }
      sync()
    })
    if (workbenchRef.value) observer.observe(workbenchRef.value)
    sync()
  })
  onBeforeUnmount(() => { finish(false); observer?.disconnect(); cancelAnimationFrame(frame) })
  return { workbenchRef, sidebarWidths: widths, startSidebarResize: start, resetSidebarWidth: reset, onSidebarResizeKeydown: keydown }
}
