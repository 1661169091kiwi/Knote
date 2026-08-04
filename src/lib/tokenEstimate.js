export const estimateAgentTokens = (value) => {
  let tokens = 0
  const text = String(value || '')
  for (let index = 0; index < text.length; index++) tokens += text.charCodeAt(index) > 0x2e80 ? 1 : 0.25
  return Math.round(tokens)
}
