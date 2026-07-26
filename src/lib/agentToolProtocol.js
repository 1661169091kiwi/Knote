// Provider-neutral guards for model-generated tool calls.
//
// OpenAI-compatible gateways are not equally strict: some omit call IDs,
// duplicate them, return content as an array, or emit malformed JSON
// arguments while still answering HTTP 200.  Normalize those differences
// before the executor sees a call so the next provider round remains valid
// and a bad argument can never be mistaken for an intentional empty object.

const plainObject = (value) => (
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value)
)

export const providerText = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    if (typeof part.text === 'string') return part.text
    if (typeof part.content === 'string') return part.content
    if (typeof part.value === 'string') return part.value
    return ''
  }).join('')
}

export const decodeToolInput = (raw) => {
  if (raw == null || raw === '') return { input: {}, error: null }
  if (plainObject(raw)) return { input: raw, error: null }
  if (typeof raw !== 'string') {
    return {
      input: {},
      error: `工具参数必须是 JSON 对象，实际收到 ${Array.isArray(raw) ? '数组' : typeof raw}。`
    }
  }
  try {
    const parsed = JSON.parse(raw)
    if (plainObject(parsed)) return { input: parsed, error: null }
    return {
      input: {},
      error: `工具参数 JSON 的顶层必须是对象，实际收到 ${Array.isArray(parsed) ? '数组' : typeof parsed}。`
    }
  } catch (err) {
    return {
      input: {},
      error: `工具参数不是有效 JSON：${String((err && err.message) || err).slice(0, 180)}`
    }
  }
}

export const normalizeProviderToolCalls = (calls, { prefix = 'call' } = {}) => {
  const seen = new Set()
  return (Array.isArray(calls) ? calls : []).map((call, index) => {
    const source = call && typeof call === 'object' ? call : {}
    const decoded = decodeToolInput(source.input)
    const base = String(source.id || '').trim() || `${prefix}_${index + 1}`
    let id = base
    let suffix = 2
    while (seen.has(id)) id = `${base}_${suffix++}`
    seen.add(id)
    return {
      ...source,
      id,
      name: String(source.name || '').trim(),
      input: decoded.input,
      inputError: decoded.error
    }
  })
}

export const providerStreamError = (payload) => {
  if (!payload || typeof payload !== 'object' || !payload.error) return ''
  const err = payload.error
  if (typeof err === 'string') return err
  return String(err.message || err.type || err.code || '流式响应返回未知错误')
}
