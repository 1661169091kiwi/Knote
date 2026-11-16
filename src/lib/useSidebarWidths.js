import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { SIDEBAR_WIDTHS_KEY, DEFAULT_SIDEBAR_WIDTHS, DEFAULT_EDITOR_WIDTH, RAIL_FILL_MAX, normalizeSidebarWidths, fitSidebarWidths } from './sidebarWidths.js'

export const useSidebarWidths = ({ leftVisible, agentVisible, centered = () => false }) => {
  const workbenchRef = ref(null)
  let wanted
  try { wanted = normalizeSidebarWidths(JSON.parse(localStorage.getItem(SIDEBAR_WIDTHS_KEY) || '{}')) } catch { wanted = normalizeSidebarWidths() }
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
  // Every grip resizes only its own column: the left rail's and the editor's
  // share a gap but stay two separate dividers. A rail filling its side of a
  // centered editor is wider than its stored width (that is only a minimum), so
  // a rail drag never fills while it runs, and how it ends decides what is kept:
  // left short of the editor, the rail is pinned at that width (`<side>Fixed`)
  // and the gap is the user's; brought back up to the editor (or wider), it
  // fills again. Double-click / Home also returns it to filling.
  const fixedKey = (side) => `${side}Fixed`
  const railChange = (moved, side, fitWith) => {
    const width = moved[side]
    // how far this rail reaches by filling alone (its smallest stored minimum)
    const reach = fitWith({ ...moved, [side]: 1, [fixedKey(side)]: false }, side)[side]
    if (width < reach - .5) return { [side]: width, [fixedKey(side)]: true }
    return { [side]: width > reach + .5 ? width : Math.min(wanted[side], width), [fixedKey(side)]: false }
  }
  const finish = (commit = true) => {
    if (!gesture) return
    cancelAnimationFrame(frame)
    const ended = gesture
    const { side } = ended
    let change = null
    if (commit && Math.abs(ended.latest[side] - ended.start[side]) >= .5) {
      change = side === 'editor' ? { editor: ended.latest.editor } : railChange(ended.latest, side, fitDuring)
    }
    gesture = null
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('blur', cancel)
    try { ended.target.releasePointerCapture(ended.pointerId) } catch { /* capture already lost */ }
    delete ended.target.dataset.resizing
    if (workbenchRef.value) delete workbenchRef.value.dataset.resizingSidebars
    if (change) { wanted = { ...wanted, ...change }; persist() }
    sync()
  }
  const move = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    // the divider sits on the column's left edge for the assistant rail and the
    // editor, so dragging left grows both; the left rail owns its right edge
    const delta = (event.clientX - gesture.x) * (gesture.side === 'left' ? 1 : -1)
    // The window's room is captured at gesture start. Pointer frames only
    // mutate CSS variables; no editor/Agent reactive update or disk write.
    // A dragged rail follows the pointer from where it is drawn, filled or not.
    const next = { ...gesture.start, [gesture.side]: gesture.start[gesture.side] + delta }
    if (gesture.side !== 'editor') next[fixedKey(gesture.side)] = true
    gesture.latest = fitDuring(next, gesture.side)
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
  const reset = (side) => {
    finish(false)
    wanted = { ...wanted, [side]: DEFAULT_SIDEBAR_WIDTHS[side] ?? DEFAULT_EDITOR_WIDTH }
    if (side !== 'editor') wanted[fixedKey(side)] = false
    persist(); sync()
  }
  const keydown = (side, event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') { reset(side); return }
    // the arrow moves the divider itself: left shrinks the left rail and widens
    // both the editor column and the assistant rail
    const delta = (event.key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1) * (event.shiftKey ? 40 : 10)
    if (side === 'editor') wanted = { ...wanted, editor: fit({ ...widths.value, editor: widths.value.editor + delta }, 'editor').editor }
    else wanted = { ...wanted, ...railChange(fit({ ...widths.value, [side]: widths.value[side] + delta, [fixedKey(side)]: true }, side), side, fit) }
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
