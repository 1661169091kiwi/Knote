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

const DEFAULT_SSE_MAX_EVENT_CHARS = 2 * 1024 * 1024
const DEFAULT_SSE_MAX_BUFFER_CHARS = 2 * 1024 * 1024
const DEFAULT_STREAM_MAX_ACCUMULATED_CHARS = 8 * 1024 * 1024
const DEFAULT_STREAM_MAX_EVENTS = 100_000
const MAX_STREAM_BLOCKS = 4096
const MAX_TOOL_CALL_ID_LENGTH = 120
const OPENAI_COMPLETE_REASONS = new Set(['stop', 'tool_calls', 'function_call'])
const ANTHROPIC_COMPLETE_REASONS = new Set(['end_turn', 'stop_sequence', 'tool_use'])

export class AgentProtocolError extends Error {
  constructor(code, message, { cause } = {}) {
    super(String(message || code || 'Provider protocol error'))
    this.name = 'AgentProtocolError'
    this.code = String(code || 'PROTOCOL_ERROR')
    if (cause !== undefined) this.cause = cause
  }
}

const protocolError = (code, message, options) => new AgentProtocolError(code, message, options)

export const openAITerminalComplete = (finishReason, { doneSeen = false } = {}) => {
  const reason = String(finishReason || '').trim()
  return OPENAI_COMPLETE_REASONS.has(reason) || (!reason && doneSeen === true)
}

export const anthropicTerminalComplete = (stopReason) => (
  ANTHROPIC_COMPLETE_REASONS.has(String(stopReason || '').trim())
)

const positiveLimit = (value, fallback) => {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

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

const safeToolCallIdBase = (value) => String(value || '')
  .trim()
  .replace(/[^A-Za-z0-9_-]+/g, '_')
  .replace(/_+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, MAX_TOOL_CALL_ID_LENGTH)

const uniqueToolCallId = (base, usedIds) => {
  let id = base
  let suffix = 2
  while (usedIds.has(id)) {
    const tail = `_${suffix++}`
    id = `${base.slice(0, MAX_TOOL_CALL_ID_LENGTH - tail.length)}${tail}`
  }
  usedIds.add(id)
  return id
}

export const normalizeProviderToolCalls = (calls, { prefix = 'call', usedIds = null } = {}) => {
  const seen = usedIds instanceof Set ? usedIds : new Set()
  const safePrefix = safeToolCallIdBase(prefix) || 'call'
  return (Array.isArray(calls) ? calls : []).map((call, index) => {
    const source = call && typeof call === 'object' ? call : {}
    const decoded = decodeToolInput(source.input)
    const base = safeToolCallIdBase(source.id) || safeToolCallIdBase(`${safePrefix}_${index + 1}`)
    const id = uniqueToolCallId(base, seen)
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

// Incremental SSE framing. It retains only the current line and current event,
// while accepting LF, CRLF, and lone CR boundaries across arbitrary chunks.
export const createSseEventParser = (onEvent, {
  maxEventChars = DEFAULT_SSE_MAX_EVENT_CHARS,
  maxBufferChars = DEFAULT_SSE_MAX_BUFFER_CHARS
} = {}) => {
  if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function')
  const eventLimit = positiveLimit(maxEventChars, DEFAULT_SSE_MAX_EVENT_CHARS)
  const bufferLimit = positiveLimit(maxBufferChars, DEFAULT_SSE_MAX_BUFFER_CHARS)
  let lineBuffer = ''
  let eventChars = 0
  let dataLines = []
  let skipLeadingLf = false
  let ended = false

  const assertBounds = () => {
    if (lineBuffer.length > bufferLimit) {
      throw protocolError('SSE_BUFFER_TOO_LARGE', `SSE line buffer exceeded ${bufferLimit} characters.`)
    }
    if (eventChars > eventLimit) {
      throw protocolError('SSE_EVENT_TOO_LARGE', `SSE event exceeded ${eventLimit} characters.`)
    }
  }

  const appendLinePart = (part) => {
    if (!part) return
    lineBuffer += part
    eventChars += part.length
    assertBounds()
  }

  const dispatchEvent = () => {
    const payload = dataLines.length ? dataLines.join('\n') : null
    dataLines = []
    eventChars = 0
    if (payload !== null) onEvent(payload)
  }

  const finishLine = () => {
    eventChars += 1
    assertBounds()
    const line = lineBuffer
    lineBuffer = ''
    if (line === '') {
      dispatchEvent()
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    if (field !== 'data') return
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    dataLines.push(value)
  }

  const feed = (chunk) => {
    if (ended) throw protocolError('SSE_PARSER_CLOSED', 'SSE parser received data after completion.')
    const text = String(chunk || '')
    let cursor = 0
    if (skipLeadingLf && text) {
      if (text.startsWith('\n')) cursor = 1
      skipLeadingLf = false
    }
    while (cursor < text.length) {
      const cr = text.indexOf('\r', cursor)
      const lf = text.indexOf('\n', cursor)
      let boundary = -1
      if (cr >= 0 && lf >= 0) boundary = Math.min(cr, lf)
      else boundary = Math.max(cr, lf)
      if (boundary < 0) {
        appendLinePart(text.slice(cursor))
        break
      }
      appendLinePart(text.slice(cursor, boundary))
      const delimiter = text[boundary]
      finishLine()
      if (delimiter === '\r') {
        if (text[boundary + 1] === '\n') cursor = boundary + 2
        else {
          cursor = boundary + 1
          if (cursor === text.length) skipLeadingLf = true
        }
      } else cursor = boundary + 1
    }
  }

  const end = () => {
    if (ended) return
    ended = true
    if (lineBuffer) finishLine()
    dispatchEvent()
  }

  return { feed, end }
}

export const readSseEvents = async (body, onEvent, options = {}) => {
  if (!body || typeof body.getReader !== 'function') {
    throw protocolError('SSE_BODY_UNREADABLE', 'Streaming response body is not readable.')
  }
  const parser = createSseEventParser(onEvent, options)
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const onBytes = typeof options.onBytes === 'function' ? options.onBytes : null
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const byteLength = Number(value?.byteLength ?? value?.length ?? 0)
      if (onBytes && byteLength > 0) onBytes(byteLength)
      parser.feed(decoder.decode(value, { stream: true }))
    }
    parser.feed(decoder.decode())
    parser.end()
  } catch (error) {
    try { await reader.cancel(error) } catch { /* the stream may already be closed */ }
    throw error
  } finally {
    try { reader.releaseLock() } catch { /* ignored */ }
  }
}

export const parseSseJsonData = (payload) => {
  const text = String(payload == null ? '' : payload)
  if (!text.trim()) return null
  try {
    const parsed = JSON.parse(text)
    if (!plainObject(parsed)) {
      throw protocolError('INVALID_STREAM_EVENT', 'SSE JSON data must be an object.')
    }
    return parsed
  } catch (error) {
    if (error instanceof AgentProtocolError) throw error
    throw protocolError('MALFORMED_SSE_JSON', 'SSE data event contained malformed JSON.', { cause: error })
  }
}

const streamIndex = (value, provider) => {
  const index = Number(value)
  if (!Number.isInteger(index) || index < 0 || index >= MAX_STREAM_BLOCKS) {
    throw protocolError('STREAM_INDEX_OUT_OF_RANGE', `${provider} stream contained an invalid content index.`)
  }
  return index
}

const createStreamBudget = ({
  maxAccumulatedChars = DEFAULT_STREAM_MAX_ACCUMULATED_CHARS,
  maxEvents = DEFAULT_STREAM_MAX_EVENTS
} = {}) => {
  const charLimit = positiveLimit(maxAccumulatedChars, DEFAULT_STREAM_MAX_ACCUMULATED_CHARS)
  const eventLimit = positiveLimit(maxEvents, DEFAULT_STREAM_MAX_EVENTS)
  let chars = 0
  let events = 0
  return {
    event() {
      events += 1
      if (events > eventLimit) throw protocolError('STREAM_RESPONSE_TOO_LARGE', `Provider stream exceeded ${eventLimit} events.`)
    },
    add(value) {
      chars += String(value || '').length
      if (chars > charLimit) throw protocolError('STREAM_RESPONSE_TOO_LARGE', `Provider stream exceeded ${charLimit} accumulated characters.`)
    }
  }
}

const throwProviderStreamError = (payload) => {
  const failure = providerStreamError(payload)
  if (failure) throw protocolError('PROVIDER_STREAM_ERROR', failure)
}

export const createOpenAIStreamAccumulator = (options = {}) => {
  const budget = createStreamBudget(options)
  const onTextDelta = typeof options.onTextDelta === 'function' ? options.onTextDelta : null
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const calls = new Map()
  let text = ''
  let usage = null
  let finishReason = ''
  let doneSeen = false
  let refusalSeen = false

  const push = (payload) => {
    budget.event()
    const eventText = String(payload == null ? '' : payload)
    if (!eventText.trim()) return
    if (eventText.trim() === '[DONE]') {
      doneSeen = true
      if (onProgress) onProgress()
      return
    }
    const data = parseSseJsonData(eventText)
    if (!data) return
    throwProviderStreamError(data)
    if (onProgress) onProgress()
    if (data.usage) {
      usage = {
        input: Number(data.usage.prompt_tokens) || 0,
        output: Number(data.usage.completion_tokens) || 0
      }
    }
    const choice = Array.isArray(data.choices) ? data.choices[0] : null
    const terminal = choice && String(choice.finish_reason || '').trim()
    if (terminal) finishReason = terminal
    const delta = choice && choice.delta
    if (!delta || typeof delta !== 'object') return
    if (delta.refusal) refusalSeen = true
    const deltaText = providerText(delta.content)
    if (deltaText) {
      budget.add(deltaText)
      text += deltaText
      if (onTextDelta) onTextDelta(deltaText)
    }
    for (const rawCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = streamIndex(rawCall && rawCall.index != null ? rawCall.index : 0, 'OpenAI')
      const call = calls.get(index) || { id: '', name: '', input: '' }
      if (rawCall && rawCall.id) {
        budget.add(rawCall.id)
        call.id = String(rawCall.id)
      }
      if (rawCall && rawCall.function && rawCall.function.name) {
        budget.add(rawCall.function.name)
        call.name += String(rawCall.function.name)
      }
      if (rawCall && rawCall.function && rawCall.function.arguments) {
        budget.add(rawCall.function.arguments)
        call.input += String(rawCall.function.arguments)
      }
      calls.set(index, call)
    }
    if (plainObject(delta.function_call)) {
      const call = calls.get(0) || { id: '', name: '', input: '' }
      if (delta.function_call.name) {
        budget.add(delta.function_call.name)
        call.name += String(delta.function_call.name)
      }
      if (delta.function_call.arguments) {
        budget.add(delta.function_call.arguments)
        call.input += String(delta.function_call.arguments)
      }
      calls.set(0, call)
    }
  }

  const finish = () => {
    if (!doneSeen && !finishReason) {
      throw protocolError('STREAM_EOF_BEFORE_TERMINAL', 'OpenAI stream ended before [DONE] or a finish_reason.')
    }
    return {
      text,
      calls: [...calls.entries()].sort((left, right) => left[0] - right[0]).map(([, call]) => ({ ...call })),
      usage,
      finishReason,
      doneSeen,
      refusalSeen
    }
  }

  return { push, finish }
}

export const createAnthropicStreamAccumulator = (options = {}) => {
  const budget = createStreamBudget(options)
  const onTextDelta = typeof options.onTextDelta === 'function' ? options.onTextDelta : null
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const blocks = new Map()
  const closedBlocks = new Set()
  const usage = { input: 0, output: 0 }
  let text = ''
  let stopReason = ''
  let messageStopped = false

  const requireOpenBlock = (rawIndex) => {
    const index = streamIndex(rawIndex, 'Anthropic')
    const block = blocks.get(index)
    if (!block || closedBlocks.has(index)) {
      throw protocolError('ANTHROPIC_STREAM_INVALID_BLOCK', `Anthropic stream referenced unopened content block ${index}.`)
    }
    return { index, block }
  }

  const push = (payload) => {
    budget.event()
    const data = parseSseJsonData(payload)
    if (!data) return
    throwProviderStreamError(data)
    if (onProgress) onProgress()
    if (data.type === 'message_start') {
      usage.input = Number(data.message && data.message.usage && data.message.usage.input_tokens) || 0
      const initialReason = String(data.message && data.message.stop_reason || '').trim()
      if (initialReason) stopReason = initialReason
      return
    }
    if (data.type === 'content_block_start') {
      const index = streamIndex(data.index, 'Anthropic')
      if (blocks.has(index)) {
        throw protocolError('ANTHROPIC_STREAM_INVALID_BLOCK', `Anthropic stream started content block ${index} more than once.`)
      }
      const source = plainObject(data.content_block) ? data.content_block : {}
      const type = String(source.type || 'text')
      let block
      if (type === 'tool_use') {
        const initialInput = plainObject(source.input) && Object.keys(source.input).length
          ? JSON.stringify(source.input)
          : ''
        block = { type: 'tool_use', id: String(source.id || ''), name: String(source.name || ''), input: initialInput }
        budget.add(block.id)
        budget.add(block.name)
        budget.add(block.input)
      } else if (type === 'thinking') {
        block = { type: 'thinking', thinking: String(source.thinking || ''), signature: String(source.signature || '') }
        budget.add(block.thinking)
        budget.add(block.signature)
      } else if (type === 'redacted_thinking') {
        block = { type: 'redacted_thinking', data: String(source.data || '') }
        budget.add(block.data)
      } else if (type === 'text') {
        block = { type: 'text', text: String(source.text || '') }
        budget.add(block.text)
        text += block.text
        if (block.text && onTextDelta) onTextDelta(block.text)
      } else block = { type: '__skip' }
      blocks.set(index, block)
      return
    }
    if (data.type === 'content_block_delta') {
      const { block } = requireOpenBlock(data.index)
      const delta = plainObject(data.delta) ? data.delta : {}
      if (delta.type === 'text_delta' && block.type === 'text') {
        const part = String(delta.text || '')
        budget.add(part)
        block.text += part
        text += part
        if (part && onTextDelta) onTextDelta(part)
      } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
        const part = String(delta.partial_json || '')
        budget.add(part)
        block.input += part
      } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
        const part = String(delta.thinking || '')
        budget.add(part)
        block.thinking += part
      } else if (delta.type === 'signature_delta' && block.type === 'thinking') {
        const part = String(delta.signature || '')
        budget.add(part)
        block.signature += part
      }
      return
    }
    if (data.type === 'content_block_stop') {
      const { index } = requireOpenBlock(data.index)
      closedBlocks.add(index)
      return
    }
    if (data.type === 'message_delta') {
      const reason = String(data.delta && data.delta.stop_reason || '').trim()
      if (reason) stopReason = reason
      if (data.usage && Number.isFinite(Number(data.usage.output_tokens))) {
        usage.output = Number(data.usage.output_tokens)
      }
      return
    }
    if (data.type === 'message_stop') messageStopped = true
  }

  const finish = () => {
    if (!messageStopped) {
      throw protocolError('STREAM_EOF_BEFORE_TERMINAL', 'Anthropic stream ended before message_stop.')
    }
    if (!stopReason) {
      throw protocolError('ANTHROPIC_STOP_REASON_MISSING', 'Anthropic stream ended without a nonempty stop_reason.')
    }
    const unclosed = [...blocks.keys()].filter((index) => !closedBlocks.has(index)).sort((a, b) => a - b)
    if (unclosed.length) {
      throw protocolError('ANTHROPIC_CONTENT_BLOCK_UNCLOSED', `Anthropic stream left content block ${unclosed[0]} unclosed.`)
    }
    return {
      text,
      blocks: [...blocks.entries()].sort((left, right) => left[0] - right[0]).map(([, block]) => ({ ...block })),
      usage: { ...usage },
      stopReason,
      messageStopped
    }
  }

  return { push, finish }
}

export const readOpenAIStream = async (body, { onText = null, onTextDelta = null, onProgress = null, onBytes = null, ...options } = {}) => {
  const accumulator = createOpenAIStreamAccumulator({ ...options, onTextDelta, onProgress })
  await readSseEvents(body, accumulator.push, { ...options, onBytes })
  const result = accumulator.finish()
  if (result.text && !result.refusalSeen && openAITerminalComplete(result.finishReason, { doneSeen: result.doneSeen }) && typeof onText === 'function') onText(result.text)
  return result
}

export const readAnthropicStream = async (body, { onText = null, onTextDelta = null, onProgress = null, onBytes = null, ...options } = {}) => {
  const accumulator = createAnthropicStreamAccumulator({ ...options, onTextDelta, onProgress })
  await readSseEvents(body, accumulator.push, { ...options, onBytes })
  const result = accumulator.finish()
  if (result.text && anthropicTerminalComplete(result.stopReason) && typeof onText === 'function') onText(result.text)
  return result
}

const schemaPathProperty = (path, property) => (
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
    ? `${path}.${property}`
    : `${path}[${JSON.stringify(property)}]`
)

const schemaTypeMatches = (value, type) => {
  if (type === 'object') return plainObject(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'integer') return Number.isFinite(value) && Number.isInteger(value)
  if (type === 'number') return Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  return false
}

// Returns null on success or a deterministic {path, message} failure. This is
// intentionally the JSON-schema subset used by the locally advertised tools.
export const validateJsonSchemaSubset = (value, schema, path = '$') => {
  if (!plainObject(schema)) return { path, message: 'has no usable schema' }
  if (schema.type && !schemaTypeMatches(value, schema.type)) {
    return { path, message: `must be ${schema.type}` }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    return { path, message: `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}` }
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return { path, message: `must be >= ${schema.minimum}` }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return { path, message: `must be <= ${schema.maximum}` }
  }
  if (typeof value === 'string') {
    if (Number.isSafeInteger(schema.minLength) && value.length < schema.minLength) return { path, message: `must have length >= ${schema.minLength}` }
    if (Number.isSafeInteger(schema.maxLength) && value.length > schema.maxLength) return { path, message: `must have length <= ${schema.maxLength}` }
  }
  if (plainObject(value)) {
    const properties = plainObject(schema.properties) ? schema.properties : {}
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        return { path: schemaPathProperty(path, String(required)), message: 'is required' }
      }
    }
    for (const property of Object.keys(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, property)) continue
      const error = validateJsonSchemaSubset(value[property], properties[property], schemaPathProperty(path, property))
      if (error) return error
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).filter((property) => !Object.prototype.hasOwnProperty.call(properties, property)).sort()[0]
      if (extra !== undefined) return { path: schemaPathProperty(path, extra), message: 'is not allowed' }
    }
  }
  if (Array.isArray(value)) {
    if (Number.isSafeInteger(schema.minItems) && value.length < schema.minItems) return { path, message: `must contain at least ${schema.minItems} items` }
    if (Number.isSafeInteger(schema.maxItems) && value.length > schema.maxItems) return { path, message: `must contain at most ${schema.maxItems} items` }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateJsonSchemaSubset(value[index], schema.items, `${path}[${index}]`)
        if (error) return error
      }
    }
  }
  if (Array.isArray(schema.oneOf)) {
    let matches = 0
    for (const branch of schema.oneOf) {
      if (!validateJsonSchemaSubset(value, branch, path)) matches += 1
    }
    if (matches !== 1) return { path, message: `must match exactly one oneOf branch (matched ${matches})` }
  }
  return null
}

export const formatSchemaValidationError = (error) => error
  ? `${String(error.path || '$')} ${String(error.message || 'is invalid')}`
  : ''

const offeredToolMap = (offeredTools) => {
  if (offeredTools instanceof Map) return offeredTools
  const map = new Map()
  for (const tool of Array.isArray(offeredTools) ? offeredTools : []) {
    const name = String(tool && tool.name || '').trim()
    if (name && !map.has(name)) map.set(name, tool)
  }
  return map
}

const unavailableToolFailure = (call) => ({
  code: 'TOOL_NOT_AVAILABLE',
  retryable: false,
  message: call.name
    ? `工具 ${call.name} 未在本轮可用工具列表中，本次调用已被系统拒绝且没有执行。`
    : '模型返回了空的工具名称，本次调用已被系统拒绝且没有执行。'
})

export const validateToolCallBatch = (calls, offeredTools, { semanticValidator = null } = {}) => {
  const list = Array.isArray(calls) ? calls : []
  const tools = offeredToolMap(offeredTools)
  const errors = new Map()
  const resolvedTools = new Map()

  for (let index = 0; index < list.length; index += 1) {
    const call = list[index] && typeof list[index] === 'object' ? list[index] : {}
    const tool = tools.get(String(call.name || ''))
    if (!tool) {
      errors.set(index, unavailableToolFailure(call))
      continue
    }
    resolvedTools.set(index, tool)
    if (call.inputError) {
      errors.set(index, {
        code: 'INVALID_TOOL_ARGUMENTS',
        retryable: true,
        message: `${call.inputError} 请按工具参数定义重新生成完整的 JSON 对象后重试；本次工具未执行。`
      })
      continue
    }
    const schemaError = validateJsonSchemaSubset(call.input, tool.parameters)
    if (schemaError) {
      errors.set(index, {
        code: 'INVALID_TOOL_ARGUMENTS',
        retryable: true,
        message: `工具 ${call.name} 的参数 ${formatSchemaValidationError(schemaError)}。请按工具参数定义重新生成完整调用；本次工具未执行。`
      })
      continue
    }
    if (typeof semanticValidator === 'function') {
      const semanticError = semanticValidator(call, tool)
      if (semanticError) {
        errors.set(index, {
          code: String(semanticError.code || 'INVALID_TOOL_SEMANTICS'),
          retryable: semanticError.retryable !== false,
          message: String(semanticError.message || `工具 ${call.name} 的参数语义无效；本次工具未执行。`),
          ...(semanticError.data == null ? {} : { data: semanticError.data })
        })
      }
    }
  }

  const questionIndexes = list
    .map((call, index) => (call && call.name === 'ask_user' ? index : -1))
    .filter((index) => index >= 0)
  if (questionIndexes.length && (questionIndexes.length !== 1 || list.length !== 1)) {
    for (const index of questionIndexes) {
      if (errors.has(index)) continue
      errors.set(index, {
        code: 'QUESTION_MUST_BE_EXCLUSIVE',
        retryable: true,
        message: 'ask_user 必须是该次模型输出中唯一的工具调用。为避免在用户回答前按猜测执行，本批次所有工具均未执行；请先单独提问，再根据答案生成完整调用集。'
      })
    }
  }

  const rejected = errors.size > 0
  return {
    valid: !rejected,
    calls: list.map((call, index) => ({
      call,
      tool: resolvedTools.get(index) || null,
      error: errors.get(index) || (rejected ? {
        code: 'TOOL_BATCH_REJECTED',
        retryable: true,
        message: '同一助手批次中的其他工具调用未通过预验证。为避免部分执行，本调用未执行；请修正问题后完整重发整个调用集。'
      } : null)
    }))
  }
}
