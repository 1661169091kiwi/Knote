export const RECOVERED_AWAITING_REPLAN = 'RECOVERED_AWAITING_REPLAN'
export const RECOVERY_REPLAN_RESOLVED = 'RECOVERY_REPLAN_RESOLVED'
export const RECOVERY_REPLAN_EXHAUSTED = 'RECOVERY_REPLAN_EXHAUSTED'

export const createRecoveryReplanState = ({ maxForcedReplans = 1, maxProviderRounds = 4 } = {}) => ({
  status: 'IDLE',
  pending: [],
  forcedReplans: 0,
  providerRounds: 0,
  maxForcedReplans,
  maxProviderRounds,
  generation: 0
})

const unresolvedEntry = (ledger, pending) => {
  const entry = ledger?.entries?.find((item) => item.index === pending.entryIndex)
  return entry && !entry.ok && entry.retryable && !entry.resolvedBy ? entry : null
}

export const syncRecoveryReplanState = (state, ledger) => {
  state.pending = state.pending.filter((pending) => unresolvedEntry(ledger, pending))
  if (!state.pending.length) {
    state.status = state.generation ? RECOVERY_REPLAN_RESOLVED : 'IDLE'
    return state.status
  }
  if (state.providerRounds >= state.maxProviderRounds) {
    state.status = RECOVERY_REPLAN_EXHAUSTED
    return state.status
  }
  state.status = RECOVERED_AWAITING_REPLAN
  return state.status
}

export const registerRecoveredMutation = (state, entry, recovery = null) => {
  if (!entry || entry.ok || !entry.retryable) return state.status
  const pending = {
    entryIndex: entry.index,
    tool: entry.name,
    target: entry.target,
    failureCode: entry.code,
    recoveryCode: recovery?.code || RECOVERED_AWAITING_REPLAN
  }
  const index = state.pending.findIndex((item) => item.entryIndex === pending.entryIndex)
  if (index >= 0) state.pending[index] = pending
  else state.pending.push(pending)
  state.status = RECOVERED_AWAITING_REPLAN
  state.forcedReplans = 0
  state.providerRounds = 0
  state.generation += 1
  return state.status
}

export const beginRecoveryProviderRound = (state, ledger) => {
  if (syncRecoveryReplanState(state, ledger) !== RECOVERED_AWAITING_REPLAN) return state.status
  state.providerRounds += 1
  return syncRecoveryReplanState(state, ledger)
}

export const recoveryReplanPending = (state, ledger) => (
  syncRecoveryReplanState(state, ledger) === RECOVERED_AWAITING_REPLAN
)

export const consumeRecoveryNoToolReplan = (state, ledger) => {
  if (!recoveryReplanPending(state, ledger)) return false
  if (state.forcedReplans >= state.maxForcedReplans) return false
  state.forcedReplans += 1
  return true
}

export const buildRecoveryReplanConstraint = (state, { forced = false } = {}) => {
  const targets = [...new Set(state.pending.map((item) => item.target).filter(Boolean))].slice(0, 4)
  const failures = [...new Set(state.pending.map((item) => item.failureCode).filter(Boolean))].slice(0, 4)
  return `[系统 · ${RECOVERED_AWAITING_REPLAN}] 已刷新同一绑定目标，但原修改没有成功，旧行号不得盲目重放。${targets.length ? `待补做目标：${targets.join('、')}。` : ''}${failures.length ? `未解决错误：${failures.join('、')}。` : ''}若恢复元数据含 artifact_id，先用 read_tool_output 完整读取。必须依据刚返回的新 revision/范围重新规划并调用修改工具补做原目标，或明确说明客观上为何不能继续；在该 retryable 修改失败解决前，不得直接结束或声称部分完成。${forced ? '你上一回合未调用修改工具，系统现强制再给一次独立 replan 机会。' : ''}`
}

const normalizedUnreadRanges = (result) => {
  const source = Array.isArray(result?.data?.unread_ranges) ? result.data.unread_ranges : []
  const unique = new Map()
  for (const range of source) {
    const start = Math.floor(Number(range?.start_line ?? range?.start))
    const end = Math.floor(Number(range?.end_line ?? range?.end))
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) continue
    unique.set(`${start}:${end}`, { start_line: start, end_line: end })
  }
  return [...unique.values()].slice(0, 12)
}

export const buildMutationRecoveryRequests = (call, result) => {
  const tool = call?.name === 'edit_file' ? 'read_file' : 'read_document'
  const base = tool === 'read_file' ? { path: call?.input?.path } : {}
  if (result?.code === 'RANGE_NOT_READ') {
    const ranges = normalizedUnreadRanges(result)
    if (ranges.length) return ranges.map((range) => ({ name: tool, input: { ...base, ...range } }))
    const rawStart = call?.input?.start_line ?? call?.input?.after_line
    const start = Math.max(1, Math.floor(Number(rawStart)) || 1)
    const rawEnd = call?.input?.end_line ?? call?.input?.start_line ?? call?.input?.after_line
    const end = Math.max(start, Math.floor(Number(rawEnd)) || start)
    return [{ name: tool, input: { ...base, start_line: start, end_line: end } }]
  }
  return [{ name: tool, input: base }]
}
