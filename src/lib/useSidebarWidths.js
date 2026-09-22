import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { SIDEBAR_WIDTHS_KEY, DEFAULT_SIDEBAR_WIDTHS, DEFAULT_EDITOR_WIDTH, normalizeSidebarWidths, fitSidebarWidths } from './sidebarWidths.js'

export const useSidebarWidths = ({ leftVisible, agentVisible, centered = () => false }) => {
  const workbenchRef = ref(null)
  let wanted
  try { wanted = normalizeSidebarWidths(JSON.parse(localStorage.getItem(SIDEBAR_WIDTHS_KEY) || '{}')) } catch { wanted = { ...DEFAULT_SIDEBAR_WIDTHS } }
  const widths = ref({ ...wanted })
  let observer, gesture = null, frame = 0, observedWidth = -1
  const fit = (value, side = '') => fitSidebarWidths(value, workbenchRef.value?.clientWidth || window.innerWidth, leftVisible(), agentVisible(), side, centered())
  const paint = (value) => {
    const el = workbenchRef.value
    if (!el) return
    el.style.setProperty('--knote-sidebar-width', `${value.left}px`)
    el.style.setProperty('--knote-agent-sidebar-width', `${value.agent}px`)
    el.style.setProperty('--knote-editor-width', `${value.editor}px`)
  }
  const sync = () => { if (!gesture) { widths.value = fit(wanted); paint(widths.value) } }
  const persist = () => { try { localStorage.setItem(SIDEBAR_WIDTHS_KEY, JSON.stringify(wanted)) } catch { /* width is non-critical */ } }
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
    if (workbenchRef.value) delete workbenchRef.value.dataset.resizingSidebars
    if (commit && Math.abs(ended.latest[ended.side] - ended.start[ended.side]) >= .5) {
      wanted = { ...wanted, [ended.side]: ended.latest[ended.side] }; persist()
    }
    sync()
  }
  const move = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    // the divider sits on the column's left edge for the assistant rail and the
    // editor, so dragging left grows both; the left rail owns its right edge
    const delta = (event.clientX - gesture.x) * (gesture.side === 'left' ? 1 : -1)
    // Bounds and geometry are captured at gesture start. Pointer frames only
    // mutate CSS variables; no editor/Agent reactive update or disk write.
    gesture.latest = fitSidebarWidths({ ...gesture.start, [gesture.side]: gesture.start[gesture.side] + delta }, gesture.available, leftVisible(), agentVisible(), gesture.side, centered())
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => { if (gesture) paint(gesture.latest) })
  }
  const up = (e) => { if (gesture && e.pointerId === gesture.pointerId) { move(e); finish(true) } }
  const cancel = () => finish(false)
  const start = (side, event) => {
    if (event.button !== 0 || !workbenchRef.value) return
    event.preventDefault()
    finish(false)
    gesture = { side, x: event.clientX, start: { ...widths.value }, latest: { ...widths.value }, available: workbenchRef.value.clientWidth, pointerId: event.pointerId, target: event.currentTarget }
    workbenchRef.value.dataset.resizingSidebars = 'true'
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
    wanted[side] = fit({ ...widths.value, [side]: widths.value[side] + delta }, side)[side]
    persist(); sync()
  }
  watch([leftVisible, agentVisible, centered], sync, { flush: 'post' })
  onMounted(() => {
    observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width
      if (nextWidth === observedWidth) return
      observedWidth = nextWidth
      if (gesture) finish(false)
      sync()
    })
    if (workbenchRef.value) observer.observe(workbenchRef.value)
    sync()
  })
  onBeforeUnmount(() => { finish(false); observer?.disconnect(); cancelAnimationFrame(frame) })
  return { workbenchRef, sidebarWidths: widths, startSidebarResize: start, resetSidebarWidth: reset, onSidebarResizeKeydown: keydown }
}
