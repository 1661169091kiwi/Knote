import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  AgentProtocolError,
  anthropicTerminalComplete,
  decodeToolInput,
  normalizeProviderToolCalls,
  openAITerminalComplete,
  providerStreamError,
  providerText,
  readAnthropicStream,
  readOpenAIStream,
  readSseEvents,
  validateJsonSchemaSubset,
  validateToolCallBatch
} from '../src/lib/agentToolProtocol.js'
import { readAgentToolOutputArtifact } from '../src/lib/agentToolOutputStore.js'
import {
  AGENT_PROVIDER_MAX_RECONNECTS,
  AGENT_PROVIDER_RECONNECT_DELAY_MS,
  isTransientAgentProviderError,
  runAgentProviderWithReconnect
} from '../src/lib/agentProviderRetry.js'

const encoder = new TextEncoder()
const streamBytes = (chunks) => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
    controller.close()
  }
})
const chunkEvery = (text, size) => {
  const bytes = encoder.encode(text)
  const chunks = []
  for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.subarray(offset, offset + size))
  return chunks
}
const sseJson = (events, { trailingNewline = true } = {}) => {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return trailingNewline ? body : body.replace(/\n+$/, '')
}
const rejectsProtocol = async (promise, code) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof AgentProtocolError)
  assert.equal(error.code, code)
  return true
})

test('provider reconnect retries transient failures ten times at ten-second intervals', async () => {
  const waits = []
  const reconnects = []
  let calls = 0
  const result = await runAgentProviderWithReconnect(async (attempt) => {
    calls += 1
    if (attempt < AGENT_PROVIDER_MAX_RECONNECTS) throw new TypeError('fetch failed')
    return 'connected'
  }, {
    wait: async (delay) => { waits.push(delay) },
    onReconnect: ({ attempt }) => { reconnects.push(attempt) }
  })
  assert.equal(result, 'connected')
  assert.equal(calls, 11)
  assert.deepEqual(reconnects, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual(waits, Array(10).fill(AGENT_PROVIDER_RECONNECT_DELAY_MS))
})

test('provider reconnect excludes deterministic errors and remains abortable', async () => {
  for (const error of [
    Object.assign(new Error('rate limited'), { status: 429 }),
    Object.assign(new Error('early eof'), { code: 'STREAM_EOF_BEFORE_TERMINAL' }),
    Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
  ]) assert.equal(isTransientAgentProviderError(error), true)
  assert.equal(isTransientAgentProviderError(Object.assign(new Error('unauthorized'), { status: 401 })), false)
  assert.equal(isTransientAgentProviderError(Object.assign(new Error('bad json'), { code: 'MALFORMED_SSE_JSON' })), false)

  let deterministicCalls = 0
  await assert.rejects(runAgentProviderWithReconnect(async () => {
    deterministicCalls += 1
    throw Object.assign(new Error('unauthorized'), { status: 401 })
  }, { wait: async () => assert.fail('must not wait') }), /unauthorized/)
  assert.equal(deterministicCalls, 1)

  const controller = new AbortController()
  let reconnects = 0
  const pending = runAgentProviderWithReconnect(async () => {
    throw new TypeError('network request failed')
  }, {
    signal: controller.signal,
    onReconnect: () => {
      reconnects += 1
      queueMicrotask(() => controller.abort())
    }
  })
  await assert.rejects(pending, (error) => error?.name === 'AbortError')
  assert.equal(reconnects, 1)
})

test('OpenAI array-form text is flattened instead of becoming [object Object]', () => {
  assert.equal(providerText([
    { type: 'text', text: '第一段' },
    { type: 'output_text', text: '第二段' },
    '第三段'
  ]), '第一段第二段第三段')
  assert.equal(providerText({ text: 'not a supported top-level shape' }), '')
})

test('malformed or non-object tool arguments are never silently accepted as an empty object', () => {
  const broken = decodeToolInput('{"path":"a.md"')
  assert.deepEqual(broken.input, {})
  assert.match(broken.error, /不是有效 JSON/)

  const array = decodeToolInput('["a.md"]')
  assert.deepEqual(array.input, {})
  assert.match(array.error, /顶层必须是对象/)

  const valid = decodeToolInput('{"path":"a.md"}')
  assert.deepEqual(valid, { input: { path: 'a.md' }, error: null })
})

test('missing and duplicate provider call IDs become unique protocol-safe IDs', () => {
  const calls = normalizeProviderToolCalls([
    { id: '', name: 'read_document', input: '{}' },
    { id: 'same', name: 'read_file', input: '{"path":"a.md"}' },
    { id: 'same', name: 'read_file', input: '{"path":"b.md"}' }
  ], { prefix: 'probe' })
  assert.deepEqual(calls.map((call) => call.id), ['probe_1', 'same', 'same_2'])
  assert.equal(new Set(calls.map((call) => call.id)).size, calls.length)
  assert.deepEqual(calls[2].input, { path: 'b.md' })
})

test('provider call IDs stay safe and unique across every response in one run', () => {
  const usedIds = new Set()
  const first = normalizeProviderToolCalls([
    { id: 'same/id', name: 'read_document', input: '{}' },
    { id: '', name: 'read_document', input: '{}' }
  ], { prefix: 'openai call', usedIds })
  const second = normalizeProviderToolCalls([
    { id: 'same/id', name: 'read_document', input: '{}' },
    { id: '', name: 'read_document', input: '{}' }
  ], { prefix: 'openai call', usedIds })

  assert.deepEqual(first.map((call) => call.id), ['same_id', 'openai_call_2'])
  assert.deepEqual(second.map((call) => call.id), ['same_id_2', 'openai_call_2_2'])
  assert.equal(usedIds.size, 4)
  assert.ok([...usedIds].every((id) => /^[A-Za-z0-9_-]{1,120}$/.test(id)))
})

test('HTTP-200 stream error events are surfaced as actual request failures', () => {
  assert.equal(providerStreamError({ error: { message: 'upstream disconnected' } }), 'upstream disconnected')
  assert.equal(providerStreamError({ type: 'message_delta' }), '')
})

test('bounded SSE framing supports CRLF, multiline data, decoder flush, and a final event without newline', async () => {
  const source = ': comment\r\nevent: ignored\r\ndata: {"value":\r\ndata: "终"}\r\n\r\nid: ignored\ndata: {"final":"好"}'
  const payloads = []
  const byteChunks = []
  await readSseEvents(streamBytes([new Uint8Array(0), ...chunkEvery(source, 3)]), (payload) => payloads.push(payload), {
    onBytes: (byteLength) => byteChunks.push(byteLength)
  })
  assert.deepEqual(payloads, ['{"value":\n"终"}', '{"final":"好"}'])
  assert.equal(byteChunks.reduce((sum, value) => sum + value, 0), encoder.encode(source).byteLength)
  assert.ok(byteChunks.every((value) => value > 0), byteChunks)

  await rejectsProtocol(
    readSseEvents(streamBytes(['data: 123456789\n\n']), () => {}, { maxBufferChars: 10, maxEventChars: 100 }),
    'SSE_BUFFER_TOO_LARGE'
  )
})

test('malformed nonempty SSE JSON and provider error events fail with typed errors', async () => {
  await rejectsProtocol(
    readOpenAIStream(streamBytes(['data: {"choices": nope}\n\ndata: [DONE]\n\n'])),
    'MALFORMED_SSE_JSON'
  )
  await rejectsProtocol(
    readOpenAIStream(streamBytes(['data: {"error":{"message":"upstream disconnected"}}\n\n'])),
    'PROVIDER_STREAM_ERROR'
  )
})

test('OpenAI EOF without a semantic terminal exposes no prose or tool prefix', async () => {
  const delivered = []
  const provisional = []
  const event = {
    choices: [{
      delta: {
        content: 'not yet safe',
        tool_calls: [{ index: 0, id: 'prefix', function: { name: 'create_file', arguments: '{"path":"unsafe.md"' } }]
      },
      finish_reason: null
    }]
  }
  await rejectsProtocol(
    readOpenAIStream(streamBytes([`data: ${JSON.stringify(event)}`]), {
      onText: (text) => delivered.push(text),
      onTextDelta: (text) => provisional.push(text)
    }),
    'STREAM_EOF_BEFORE_TERMINAL'
  )
  assert.deepEqual(delivered, [])
  assert.deepEqual(provisional, ['not yet safe'])
})

test('complete OpenAI streams accept finish_reason or DONE and publish accumulated text once', async () => {
  const delivered = []
  const provisional = []
  let progress = 0
  let transportedBytes = 0
  const events = [
    { choices: [{ delta: { content: 'safe ' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'answer', tool_calls: [{ index: 0, id: 'call-1', function: { name: 'calc', arguments: '{"expression":' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"1+1"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }
  ]
  const result = await readOpenAIStream(streamBytes(chunkEvery(sseJson(events, { trailingNewline: false }), 5)), {
    onText: (text) => delivered.push(text),
    onTextDelta: (text) => provisional.push(text),
    onProgress: () => { progress++ },
    onBytes: (byteLength) => { transportedBytes += byteLength }
  })
  assert.equal(result.text, 'safe answer')
  assert.deepEqual(result.calls, [{ id: 'call-1', name: 'calc', input: '{"expression":"1+1"}' }])
  assert.deepEqual(result.usage, { input: 7, output: 3 })
  assert.equal(result.finishReason, 'tool_calls')
  assert.deepEqual(delivered, ['safe answer'])
  assert.deepEqual(provisional, ['safe ', 'answer'])
  assert.equal(progress, events.length)
  assert.ok(transportedBytes > 0)

  const done = await readOpenAIStream(streamBytes(['data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: [DONE]']))
  assert.equal(done.text, 'done')
  assert.equal(done.doneSeen, true)
})

test('provider terminal matrices accept only semantically complete reasons', () => {
  for (const reason of ['stop', 'tool_calls', 'function_call']) assert.equal(openAITerminalComplete(reason), true, reason)
  assert.equal(openAITerminalComplete('', { doneSeen: true }), true)
  for (const reason of ['length', 'content_filter', 'refusal', 'pause_turn', 'unknown', '']) {
    assert.equal(openAITerminalComplete(reason), false, reason || '(empty)')
  }
  assert.equal(openAITerminalComplete('unknown', { doneSeen: true }), false)

  for (const reason of ['end_turn', 'stop_sequence', 'tool_use']) assert.equal(anthropicTerminalComplete(reason), true, reason)
  for (const reason of ['refusal', 'content_filter', 'max_tokens', 'pause_turn', 'unknown', '']) {
    assert.equal(anthropicTerminalComplete(reason), false, reason || '(empty)')
  }
})

test('noncomplete and refusal stream states never publish accumulated provider prose', async () => {
  const openAiDelivered = []
  const openAiProvisional = []
  const openAi = await readOpenAIStream(streamBytes([sseJson([{
    choices: [{ delta: { content: 'filtered partial prose' }, finish_reason: 'content_filter' }]
  }])]), {
    onText: (text) => openAiDelivered.push(text),
    onTextDelta: (text) => openAiProvisional.push(text)
  })
  assert.equal(openAi.text, 'filtered partial prose')
  assert.deepEqual(openAiDelivered, [])
  assert.deepEqual(openAiProvisional, ['filtered partial prose'])

  const anthropicDelivered = []
  const anthropicProvisional = []
  const anthropic = await readAnthropicStream(streamBytes([sseJson([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'paused partial prose' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' }
  ])]), {
    onText: (text) => anthropicDelivered.push(text),
    onTextDelta: (text) => anthropicProvisional.push(text)
  })
  assert.equal(anthropic.text, 'paused partial prose')
  assert.deepEqual(anthropicDelivered, [])
  assert.deepEqual(anthropicProvisional, ['paused partial prose'])
})

test('Anthropic requires message_stop, stop_reason, and closure of every started block', async () => {
  const closedBlockEvents = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'withheld' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
  ]
  const delivered = []
  await rejectsProtocol(
    readAnthropicStream(streamBytes([sseJson(closedBlockEvents)]), { onText: (text) => delivered.push(text) }),
    'STREAM_EOF_BEFORE_TERMINAL'
  )
  assert.deepEqual(delivered, [])

  const unclosedEvents = [
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'withheld' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' }
  ]
  await rejectsProtocol(
    readAnthropicStream(streamBytes([sseJson(unclosedEvents)])),
    'ANTHROPIC_CONTENT_BLOCK_UNCLOSED'
  )
})

test('complete Anthropic streams preserve thinking signatures and replayable tool input', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 11 }, stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'plan:', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' check' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'validated' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'create_file', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a.md","content":"ok"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' }
  ]
  const delivered = []
  const provisional = []
  const result = await readAnthropicStream(streamBytes(chunkEvery(sseJson(events, { trailingNewline: false }), 7)), {
    onText: (text) => delivered.push(text),
    onTextDelta: (text) => provisional.push(text)
  })
  assert.equal(result.text, 'validated')
  assert.equal(result.stopReason, 'tool_use')
  assert.deepEqual(result.usage, { input: 11, output: 9 })
  assert.deepEqual(result.blocks, [
    { type: 'thinking', thinking: 'plan: check', signature: 'signed' },
    { type: 'text', text: 'validated' },
    { type: 'tool_use', id: 'tool-1', name: 'create_file', input: '{"path":"a.md","content":"ok"}' }
  ])
  assert.deepEqual(delivered, ['validated'])
  assert.deepEqual(provisional, ['validated'])
})

test('local schema validation reports deterministic required, type, extra, scalar/array bounds, and oneOf paths', () => {
  const schema = {
    type: 'object',
    properties: {
      content: { type: 'string', minLength: 1, maxLength: 3 },
      count: { type: 'integer', minimum: 1, maximum: 3 },
      enabled: { type: 'boolean' },
      tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['a', 'b'] } }
    },
    required: ['content', 'count'],
    additionalProperties: false
  }
  const valid = { content: 'x', count: 2, enabled: true, tags: ['a'] }
  const before = JSON.stringify(valid)
  assert.equal(validateJsonSchemaSubset(valid, schema), null)
  assert.equal(JSON.stringify(valid), before, 'validation mutated its input')
  assert.deepEqual(validateJsonSchemaSubset({ count: 2 }, schema), { path: '$.content', message: 'is required' })
  assert.deepEqual(validateJsonSchemaSubset({ content: 'x', count: 2.5 }, schema), { path: '$.count', message: 'must be integer' })
  assert.deepEqual(validateJsonSchemaSubset({ content: 'x', count: 4 }, schema), { path: '$.count', message: 'must be <= 3' })
  assert.deepEqual(validateJsonSchemaSubset({ content: '', count: 2 }, schema), { path: '$.content', message: 'must have length >= 1' })
  assert.deepEqual(validateJsonSchemaSubset({ content: 'long', count: 2 }, schema), { path: '$.content', message: 'must have length <= 3' })
  assert.deepEqual(validateJsonSchemaSubset({ content: 'x', count: 2, extra: true }, schema), { path: '$.extra', message: 'is not allowed' })
  assert.deepEqual(validateJsonSchemaSubset({ content: 'x', count: 2, tags: [] }, schema), { path: '$.tags', message: 'must contain at least 1 items' })
  assert.deepEqual(validateJsonSchemaSubset({ content: 'x', count: 2, tags: ['a', 'b', 'a'] }, schema), { path: '$.tags', message: 'must contain at most 2 items' })
  assert.deepEqual(validateJsonSchemaSubset({ content: 'x', count: 2, tags: ['c'] }, schema), { path: '$.tags[0]', message: 'must be one of "a", "b"' })

  const oneOf = {
    oneOf: [
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
      { type: 'object', properties: { b: { type: 'number' } }, required: ['b'], additionalProperties: false }
    ]
  }
  assert.equal(validateJsonSchemaSubset({ a: 'ok' }, oneOf), null)
  assert.deepEqual(validateJsonSchemaSubset({ a: 'x', b: 1 }, oneOf), {
    path: '$',
    message: 'must match exactly one oneOf branch (matched 0)'
  })
})

test('tool batches prevalidate every sibling and reject all valid calls when one is invalid', () => {
  const offered = [{
    name: 'create_file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false
    }
  }, {
    name: 'ask_user',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
      additionalProperties: false
    }
  }]
  const calls = normalizeProviderToolCalls([
    { id: 'valid', name: 'create_file', input: '{"path":"a.md","content":"safe"}' },
    { id: 'invalid', name: 'create_file', input: '{"path":"b.md"}' }
  ])
  const batch = validateToolCallBatch(calls, offered)
  assert.equal(batch.valid, false)
  assert.deepEqual(batch.calls.map((entry) => entry.error.code), ['TOOL_BATCH_REJECTED', 'INVALID_TOOL_ARGUMENTS'])
  assert.match(batch.calls[1].error.message, /\$\.content is required/)

  const unavailable = validateToolCallBatch(normalizeProviderToolCalls([
    { id: 'unknown', name: 'delete_everything', input: '{}' }
  ]), offered)
  assert.equal(unavailable.calls[0].error.code, 'TOOL_NOT_AVAILABLE')

  const questionBatch = validateToolCallBatch(normalizeProviderToolCalls([
    { id: 'question', name: 'ask_user', input: '{"question":"Which?"}' },
    { id: 'write', name: 'create_file', input: '{"path":"a.md","content":"safe"}' }
  ]), offered)
  assert.deepEqual(questionBatch.calls.map((entry) => entry.error.code), ['QUESTION_MUST_BE_EXCLUSIVE', 'TOOL_BATCH_REJECTED'])
})

test('agent loop wires immutable run protocol state and all-or-nothing preflight', () => {
  const source = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
  assert.match(source, /const protocolState = Object\.freeze\(\{ toolCallIds: new Set\(\) \}\)/)
  assert.match(source, /usedIds: runToolCallIds\(runContext\)/)
  assert.match(source, /const offeredToolMap = new Map\(offeredTools\.map/)
  assert.match(source, /validateToolCallBatch\(resp\.toolCalls, offeredToolMap, \{/)
  assert.match(source, /semanticValidator: \(call\) => validateAgentMutationInput/)
  assert.match(source, /resp\.terminalComplete !== true/)
  assert.match(source, /providerTerminalProtocolError/)
  assert.match(source, /segment\.length > 255/)
  assert.match(source, /!finalDownloadUrlLooksPublic\(normalized\.url\)/)
  assert.match(source, /if \(resp\.truncated\) \{[\s\S]{0,180}if \(resp\.toolCalls\.length\)/)
  assert.match(source, /没有把该助手工具调用轮次加入历史/)
  assert.match(source, /上一段输出因模型长度上限被截断/)
  assert.match(source, /beginRunProvisional\(runContext, continuationText\)/)
  assert.match(source, /appendRunProvisional\(runContext, provisionalEpoch, d\)/)
  assert.match(source, /const onBytes = \(\) => touchRunTransport\(runContext\)/)
  assert.match(source, /markRunTransportDisconnected\(runContext\)/)
  assert.match(source, /const hardVerdict = guardFinalReport\(passText, runLedger\)/)
  assert.match(source, /verdict\?\.passed === true/)
  assert.ok(source.indexOf('appendReplyText(acceptedPassText)') > source.indexOf('const verdict = await runVerifier'))
  assert.doesNotMatch(source, /appendReplyText\(continuationText \+ finalChunk\)/)
  assert.doesNotMatch(source, /const readSseLines|Legacy source-shape marker/)
  assert.match(source, /工具 \$\{group\.call\.name\}（call_id=\$\{group\.call\.id\}）返回的/)
})

test('live Agent projection is process-local, timestamped, and excluded from persisted session records', () => {
  const store = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
  const panel = fs.readFileSync(new URL('../src/components/AgentPanel.vue', import.meta.url), 'utf8')
  const record = store.slice(store.indexOf('const storedSessionRecord ='), store.indexOf('const sessionsForPersistence ='))
  assert.match(store, /export const AGENT_STALL_MS = 30_000/)
  assert.match(store, /startedAt: 0/)
  assert.match(store, /lastProgressAt: 0/)
  assert.match(store, /transportExpected: false/)
  assert.match(store, /transportHealth: 'healthy'/)
  assert.match(store, /provisionalText: ''/)
  assert.match(store, /verifying: false/)
  assert.doesNotMatch(record, /provisionalText|startedAt|lastProgressAt|transportExpected|transportHealth|verifying/)
  assert.match(panel, /data-testid="agent-provisional-message"/)
  assert.match(panel, /renderMd\(provisionalText, \{ copyControls: false \}\)/)
  assert.match(panel, /data-testid="agent-run-status"/)
  assert.match(panel, /agentRuntimeTransportHealth/)
})

test('tool instructions distinguish data from authority and remove ambiguous PDF/file routing', () => {
  const source = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
  assert.match(source, /当前文档、工作区文件.*不可信数据/)
  assert.match(source, /一批并行调用中只要有一个失败/)
  assert.match(source, /不要再对同一页调用 pdf_layout 做重复分析/)
  assert.match(source, /首次可传 start_line\/end_line/)
  assert.match(source, /超长物理行会用同一行的 UTF-8 byte cursor 继续/)
  assert.match(source, /normalizeWorkspacePath\(input\.path\)/)
  assert.match(source, /code: 'RANGE_NOT_READ'/)
  assert.match(source, /lastReadDocRanges = \[\]/)
  assert.match(source, /为避免静默截断，本文件未处理/)
  assert.doesNotMatch(source, /old_string 仍可引用未显示部分/)
})

test('every advertised tool has exactly one executor branch across the full tool surface', () => {
  const source = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
  const toolBlock = source.slice(source.indexOf('const TOOLS = ['), source.indexOf('const SYSTEM_PROMPT'))
  const switchBlock = source.slice(source.indexOf('const executeTool ='), source.indexOf('const ACTIVITY_LABEL'))
  const advertised = [...toolBlock.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1])
  const executed = [...switchBlock.matchAll(/case\s+'([^']+)'/g)].map((match) => match[1])
  const expected = [
    'read_document', 'read_attachment', 'read_tool_output', 'ask_user', 'replace_lines', 'insert_lines', 'discard_hunks',
    'continue_hunk', 'create_file', 'create_folder', 'list_files', 'read_file',
    'edit_file', 'read_workspace_pdf', 'read_workspace_image', 'web_search',
    'web_fetch', 'download_file', 'read_pdf_text', 'render_pdf_page', 'pdf_prepare',
    'pdf_get_element', 'pdf_crop_region', 'pdf_layout', 'insert_image',
    'batch_process', 'update_plan', 'get_datetime', 'find_in_files', 'get_outline',
    'move_file', 'rename_file', 'delete_file', 'run_command', 'run_code', 'task_wait',
    'task_status', 'task_cancel', 'calc'
  ]
  assert.deepEqual(advertised, expected)
  assert.equal(new Set(advertised).size, advertised.length)
  assert.deepEqual([...executed].sort(), [...expected].sort())
})

test('download_file advertises an optional exact caller limit without a product cap', () => {
  const source = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
  const toolBlock = source.slice(source.indexOf('const TOOLS = ['), source.indexOf('const SYSTEM_PROMPT'))
  const definitions = Function(`${toolBlock}; return TOOLS`)()
  const tool = definitions.find((item) => item.name === 'download_file')

  assert.ok(tool)
  assert.deepEqual(Object.keys(tool.parameters.properties), ['url', 'path', 'max_bytes', 'resume_id'])
  assert.deepEqual(tool.parameters.required, ['url', 'path'])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.properties.max_bytes, {
    type: 'integer',
    minimum: 1,
    description: '（可选）调用者选择的精确最大下载字节数；省略时不设置固定单文件限制，下载仍受磁盘和资源策略约束'
  })
  assert.equal('default' in tool.parameters.properties.max_bytes, false)
  assert.equal('maximum' in tool.parameters.properties.max_bytes, false)
  assert.deepEqual(tool.parameters.properties.resume_id, {
    type: 'string',
    minLength: 32,
    maxLength: 64,
    pattern: '^[A-Za-z0-9_-]+$',
    description: '（可选）同一会话先前 DOWNLOAD_PAUSED/DOWNLOAD_RESUME_AVAILABLE 回执给出的不透明续传 ID'
  })
  assert.match(tool.description, /无固定单文件限制/)
  assert.match(tool.description, /流式写入私有磁盘隔离区/)
  assert.match(tool.description, /永不覆盖、打开或执行文件/)
  assert.match(tool.description, /Range\/If-Range/)
  assert.match(source, /case 'download_file': return await execDownloadFile\(input, signal, callMeta, runContext\)/)
})

test('Chromium task tools expose narrow owner-free schemas and matching runtime guards', () => {
  const source = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
  const toolBlock = source.slice(source.indexOf('const TOOLS = ['), source.indexOf('const SYSTEM_PROMPT'))
  const definitions = Function(`${toolBlock}; return TOOLS`)()
  const byName = new Map(definitions.map((tool) => [tool.name, tool]))
  const runCode = byName.get('run_code')
  assert.deepEqual(Object.keys(runCode.parameters.properties), ['language', 'code', 'input', 'timeout_ms'])
  assert.deepEqual(runCode.parameters.required, ['language', 'code'])
  assert.deepEqual(runCode.parameters.properties.language.enum, ['javascript'])
  assert.equal(runCode.parameters.properties.code.maxLength, 131072)
  assert.deepEqual(
    [runCode.parameters.properties.timeout_ms.minimum, runCode.parameters.properties.timeout_ms.maximum],
    [100, 300000]
  )
  const wait = byName.get('task_wait')
  assert.deepEqual(Object.keys(wait.parameters.properties), ['task_id', 'wait_ms'])
  assert.equal(wait.parameters.properties.wait_ms.maximum, 30000)
  for (const name of ['run_code', 'task_wait', 'task_status', 'task_cancel']) {
    assert.doesNotMatch(JSON.stringify(byName.get(name).parameters), /chat_?key|session_?id|run_?id|owner/i)
  }
  assert.match(source, /const normalizeRendererRunCodeInput =/)
  assert.match(source, /AGENT_SANDBOX_TASK_ID_RE = \/\^sbx_/)
  assert.match(source, /normalizeTaskToolInput\(input, \{ wait: true \}\)/)
  assert.match(source, /task\.code_hash !== codeHash/)
  assert.match(source, /backend: 'chromium-renderer'/)
  assert.match(source, /network: 'unverified'/)
})

test('read_tool_output uses a flat gateway-compatible schema and runtime exact-pair validation', async () => {
  const source = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
  const toolBlock = source.slice(source.indexOf('const TOOLS = ['), source.indexOf('const SYSTEM_PROMPT'))
  const definitions = Function(`${toolBlock}; return TOOLS`)()
  const tool = definitions.find((item) => item.name === 'read_tool_output')
  const schema = tool?.parameters

  assert.equal(schema?.type, 'object')
  assert.equal(Object.hasOwn(schema, 'oneOf'), false)
  assert.doesNotMatch(JSON.stringify(schema), /"oneOf"/)
  assert.deepEqual(Object.keys(schema.properties), [
    'artifact_id', 'line_offset', 'line_limit', 'byte_offset', 'byte_limit'
  ])
  assert.deepEqual(schema.required, ['artifact_id'])
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(
    Object.fromEntries(Object.entries(schema.properties).slice(1).map(([name, property]) => [name, [property.minimum, property.maximum]])),
    {
      line_offset: [1, Number.MAX_SAFE_INTEGER],
      line_limit: [1, 2000],
      byte_offset: [0, Number.MAX_SAFE_INTEGER],
      byte_limit: [1, 262144]
    }
  )
  assert.match(tool.description, /exactly one complete pair/)
  assert.doesNotMatch(JSON.stringify(schema), /chat_?key|session_?id|owner/i)
  assert.equal(validateJsonSchemaSubset({ artifact_id: 'opaque', line_offset: 1 }, schema), null)
  assert.equal(validateJsonSchemaSubset({
    artifact_id: 'opaque',
    line_offset: 1,
    line_limit: 1,
    byte_offset: 0,
    byte_limit: 8
  }, schema), null)

  const artifactId = 'runtime-range-validation'
  const owner = { chatKey: 'chat:protocol', sessionId: 'session:protocol', artifactId }
  const invalidRanges = [
    { lineOffset: 1, lineLimit: 1, byteOffset: 0, byteLimit: 8 },
    { lineOffset: 1 },
    { byteLimit: 8 },
    {}
  ]
  for (const range of invalidRanges) {
    await assert.rejects(
      readAgentToolOutputArtifact({ ...owner, ...range }),
      (error) => error?.name === 'AgentToolOutputError' && error?.code === 'ARTIFACT_RANGE_INVALID'
    )
  }
})
