const tokenCount = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

export const createAgentRunUsage = () => ({
  lastInput: 0,
  peakInput: 0,
  totalInput: 0,
  output: 0,
  estimated: false
})

export const accumulateAgentUsage = (current, sample, { estimated = false } = {}) => {
  const input = tokenCount(sample?.input)
  const output = tokenCount(sample?.output)
  return {
    lastInput: input,
    peakInput: Math.max(tokenCount(current?.peakInput), input),
    totalInput: tokenCount(current?.totalInput) + input,
    output: tokenCount(current?.output) + output,
    estimated: current?.estimated === true || estimated
  }
}

// Legacy records only have `input`, which was a run-total. It is valid for the
// billing footer but cannot be presented as one precise context-window sample.
export const agentUsageTotalInput = (usage) => tokenCount(
  usage && Object.prototype.hasOwnProperty.call(usage, 'totalInput')
    ? usage.totalInput
    : usage?.input
)

export const agentUsageContextInput = (usage) => {
  if (!usage || (!Object.prototype.hasOwnProperty.call(usage, 'lastInput') &&
      !Object.prototype.hasOwnProperty.call(usage, 'peakInput'))) return null
  const lastInput = tokenCount(usage.lastInput)
  const peakInput = tokenCount(usage.peakInput)
  const tokens = Math.max(lastInput, peakInput)
  return tokens ? { tokens, lastInput, peakInput, estimated: usage.estimated === true } : null
}
