export const SIDEBAR_WIDTHS_KEY = 'knote-sidebar-widths-v1'
export const DEFAULT_SIDEBAR_WIDTHS = Object.freeze({ left: 280, agent: 420 })
const clamp = (n, min, max) => Math.min(Math.max(min, max), Math.max(min, n))
export const normalizeSidebarWidths = (value = {}) => ({
  left: clamp(Number(value?.left) || 280, 240, 400),
  agent: clamp(Number(value?.agent) || 420, 320, 1200)
})
export const fitSidebarWidths = (wanted, available, leftVisible = true, agentVisible = true, resizing = '', centered = false) => {
  const widths = normalizeSidebarWidths(wanted)
  // True editor centering reserves the same horizontal reach on both sides.
  // The visible rails may stay independently sized; CSS compensates only their
  // difference. Cap either visible rail to half of the space left after the
  // editor floor so that compensation can never squeeze the editor below 320px.
  if (centered && (leftVisible || agentVisible)) {
    const reserveMax = Math.max(0, (available - 320 - 32) / 2)
    const left = leftVisible
      ? clamp(widths.left, 240, Math.min(400, reserveMax))
      : widths.left
    const agent = agentVisible
      ? clamp(widths.agent, 320, Math.min(1200, available * .45, reserveMax))
      : widths.agent
    return { left, agent }
  }
  const gap = (leftVisible ? 16 : 0) + (agentVisible ? 16 : 0)
  const budget = Math.max(0, available - 320 - gap)
  const leftMax = leftVisible ? Math.min(400, budget - (agentVisible ? (resizing === 'left' ? widths.agent : 320) : 0)) : 400
  const left = clamp(widths.left, 240, leftMax)
  const agentMax = Math.min(available * .45, budget - (leftVisible ? left : 0))
  return { left, agent: clamp(widths.agent, 320, agentMax) }
}
