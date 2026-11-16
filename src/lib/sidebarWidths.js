export const SIDEBAR_WIDTHS_KEY = 'knote-sidebar-widths-v1'
export const DEFAULT_SIDEBAR_WIDTHS = Object.freeze({ left: 280, agent: 420 })
// The editor's own column. It only binds where the column is capped — the
// centered layout and the three-column (assistant sidebar) layout — and it is
// draggable there, so "the three columns" really are three draggable columns.
export const DEFAULT_EDITOR_WIDTH = 848
export const EDITOR_WIDTH_MIN = 320
// How wide a rail grows by itself to fill its side of a centered editor (30rem,
// the --knote-sidebar-max-width token). A rail the user dragged wider stays wider.
// It is also the left rail's own maximum, so grabbing a filled rail never snaps it.
export const RAIL_FILL_MAX = 480
const clamp = (n, min, max) => Math.min(Math.max(min, max), Math.max(min, n))
// `leftFixed` / `agentFixed`: the user dragged that rail narrower than its fill,
// so its width stands as dragged (its divider is its own, apart from the
// editor's) instead of filling up to the centered editor.
export const normalizeSidebarWidths = (value = {}) => ({
  left: clamp(Number(value?.left) || 280, 240, RAIL_FILL_MAX),
  agent: clamp(Number(value?.agent) || 420, 320, 1200),
  editor: clamp(Number(value?.editor) || DEFAULT_EDITOR_WIDTH, EDITOR_WIDTH_MIN, 1600),
  leftFixed: value?.leftFixed === true,
  agentFixed: value?.agentFixed === true
})
export const fitSidebarWidths = (wanted, available, leftVisible = true, agentVisible = true, resizing = '', centered = false) => {
  const widths = normalizeSidebarWidths(wanted)
  // True editor centering reserves the same horizontal reach on both sides.
  // The visible rails may stay independently sized; CSS compensates only their
  // difference. Cap either visible rail to half of the space left after the
  // editor floor so that compensation can never squeeze the editor below 320px.
  if (centered && (leftVisible || agentVisible)) {
    const reserveMax = Math.max(0, (available - 320 - 32) / 2)
    let left = leftVisible
      ? clamp(widths.left, 240, Math.min(RAIL_FILL_MAX, reserveMax))
      : widths.left
    let agent = agentVisible
      ? clamp(widths.agent, 320, Math.min(1200, available * .45, reserveMax))
      : widths.agent
    // A centered editor leaves one equal side on its left and right. A rail
    // fills its side (up to RAIL_FILL_MAX) instead of leaving that space as an
    // empty margin or a compensation gap: the stored width is its minimum, and
    // a rail stored wider than its side keeps that width (the CSS compensation
    // margin then keeps the editor centered, as before). A rail the user pinned
    // narrower keeps its width and leaves the gap they asked for.
    const side = Math.floor((available - widths.editor - 32) / 2)
    const fill = (width) => Math.max(width, Math.min(side, RAIL_FILL_MAX))
    if (leftVisible && !widths.leftFixed) left = fill(left)
    if (agentVisible && !widths.agentFixed) agent = fill(agent)
    return { left, agent, editor: widths.editor, leftFixed: widths.leftFixed, agentFixed: widths.agentFixed }
  }
  const gap = (leftVisible ? 16 : 0) + (agentVisible ? 16 : 0)
  const budget = Math.max(0, available - 320 - gap)
  const leftMax = leftVisible ? Math.min(RAIL_FILL_MAX, budget - (agentVisible ? (resizing === 'left' ? widths.agent : 320) : 0)) : RAIL_FILL_MAX
  const left = clamp(widths.left, 240, leftMax)
  const agentMax = Math.min(available * .45, budget - (leftVisible ? left : 0))
  const agent = clamp(widths.agent, 320, agentMax)
  // Whatever the rails do not take stays available to the editor column, so a
  // wider editor can never overlap a rail.
  const editorMax = Math.max(EDITOR_WIDTH_MIN, available - gap - (leftVisible ? left : 0) - (agentVisible ? agent : 0))
  return { left, agent, editor: clamp(widths.editor, EDITOR_WIDTH_MIN, editorMax), leftFixed: widths.leftFixed, agentFixed: widths.agentFixed }
}
