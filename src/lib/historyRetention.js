export const selectHistoryRetentionIds = (itemsValue, policy, protectedIds = []) => {
  const items = Array.isArray(itemsValue) ? itemsValue : []
  const keep = new Set(protectedIds.filter(Boolean))
  for (const item of items.slice(0, policy.recentCount)) keep.add(item.id)

  const recovery = items.filter((item) => item.checkpoint)
  const families = new Set()
  for (const item of recovery) {
    if (families.has(item.checkpoint)) continue
    keep.add(item.id)
    families.add(item.checkpoint)
  }
  for (const item of recovery.slice(0, policy.recoveryCount)) keep.add(item.id)

  let retainedBytes = items
    .filter((item) => keep.has(item.id))
    .reduce((sum, item) => sum + item.size, 0)
  const candidates = items.filter((item) => !keep.has(item.id))
  const availableSlots = Math.max(0, policy.targetCount - keep.size)
  if (!availableSlots || !candidates.length) return keep

  const sampleCount = Math.min(availableSlots, candidates.length)
  const sampledIndexes = new Set()
  for (let index = 0; index < sampleCount; index++) {
    const position = sampleCount === 1
      ? candidates.length - 1
      : Math.round(index * (candidates.length - 1) / (sampleCount - 1))
    sampledIndexes.add(position)
  }

  // Oldest first reserves space for long-range history instead of spending the
  // entire byte target on revisions immediately adjacent to the recent window.
  for (const index of [...sampledIndexes].sort((a, b) => b - a)) {
    const item = candidates[index]
    if (!item || keep.size >= policy.targetCount) break
    if (retainedBytes + item.size > policy.targetBytes) continue
    keep.add(item.id)
    retainedBytes += item.size
  }
  return keep
}
