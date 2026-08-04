export const tabResidentSize = (tab) => Math.max(
  typeof tab?.content === 'string' ? tab.content.length : 0,
  typeof tab?.exportedMd === 'string' ? tab.exportedMd.length : 0
)

// Choose background tabs whose duplicate document/editor payload should move
// to the signed main-process buffer store. The policy is both count- and
// byte-bounded: keeping two "large" tabs was harmless at 400 KiB but disastrous
// when both were 20 MiB. Very large documents never stay hot in the background;
// a single medium MRU tab does, preserving a fluid A/B working loop.
export const selectTabsToOffload = (tabs, activeId, options = {}) => {
  const numeric = (value, fallback, minimum = 0) => {
    const parsed = Number(value)
    return Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback)
  }
  const threshold = numeric(options.threshold, 300_000, 1)
  const hugeThreshold = numeric(options.hugeThreshold, 1_500_000, threshold)
  const maxHotBackground = numeric(options.maxHotBackground, 1)
  const maxHotHuge = numeric(options.maxHotHuge, 0)
  const maxHotBytes = numeric(options.maxHotBytes, 1_200_000)
  const canOffload = typeof options.canOffload === 'function' ? options.canOffload : () => true

  const candidates = (Array.isArray(tabs) ? tabs : [])
    .filter((tab) => tab && tab.id !== activeId && tab.resident &&
      tabResidentSize(tab) >= threshold && canOffload(tab))
    .sort((a, b) => (b.lastAccessAt || 0) - (a.lastAccessAt || 0))

  let hotCount = 0
  let hotHugeCount = 0
  let hotBytes = 0
  const offload = []
  for (const tab of candidates) {
    const size = tabResidentSize(tab)
    const huge = size >= hugeThreshold
    const mayStayHot = hotCount < maxHotBackground &&
      hotBytes + size <= maxHotBytes &&
      (!huge || hotHugeCount < maxHotHuge)
    if (mayStayHot) {
      hotCount++
      hotBytes += size
      if (huge) hotHugeCount++
    } else {
      offload.push(tab)
    }
  }
  return offload
}
