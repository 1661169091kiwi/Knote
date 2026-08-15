export const AGENT_CAPABILITY_KEYS = Object.freeze(['chat', 'tools', 'vision', 'pdf'])

export const classifyAgentCapabilities = (result = {}) => {
  if (result.chat !== true) return 'failure'
  return AGENT_CAPABILITY_KEYS.every((key) => result[key] === true) && !result.error
    ? 'success'
    : 'partial'
}
