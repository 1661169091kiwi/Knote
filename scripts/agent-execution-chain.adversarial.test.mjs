import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  classifyAgentWritableFile,
  createAgentWorkspaceFile,
  isAgentEditableTextFile,
  resolveAgentCreateFilePath
} from '../src/lib/agentWorkspaceFile.js'
import {
  RECOVERED_AWAITING_REPLAN,
  buildMutationRecoveryRequests,
  buildRecoveryReplanConstraint,
  consumeRecoveryNoToolReplan,
  createRecoveryReplanState,
  recoveryReplanPending,
  registerRecoveredMutation,
  syncRecoveryReplanState
} from '../src/lib/agentRecoveryState.js'
import {
  accumulateAgentUsage,
  agentUsageContextInput,
  agentUsageTotalInput,
  createAgentRunUsage
} from '../src/lib/agentUsage.js'
import { classifyDocumentReadPrecondition } from '../src/lib/documentTarget.js'
import { detectFtype } from '../src/lib/fileReader.js'
import {
  createExecutionLedger,
  recordToolExecution,
  serializeToolResult,
  toolFailure,
  toolSuccess
} from '../src/lib/agentExecutionLedger.js'
import {
  AGENT_STALL_MS,
  agentRuntimeIsStalled,
  agentRuntimeTransportHealth,
  chatMessages,
  contextUsage,
  sessionLastConversationAt,
  validateAgentMutationInput
} from '../src/lib/agentStore.js'

const appSource = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
const storeSource = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
const panelSource = fs.readFileSync(new URL('../src/components/AgentPanel.vue', import.meta.url), 'utf8')

class MemoryFileHandle {
  constructor(name) {
    this.kind = 'file'
    this.name = name
    this.content = ''
  }

  async createWritable() {
    return {
      write: async (value) => { this.content = String(value) },
      close: async () => {}
    }
  }
}

class MemoryDirectoryHandle {
  constructor(name = '') {
    this.kind = 'directory'
    this.name = name
    this.directories = new Map()
    this.files = new Map()
    this.beforeExclusiveCreate = null
  }

  async getDirectoryHandle(name, options = {}) {
    if (this.directories.has(name)) return this.directories.get(name)
    if (!options.create) throw Object.assign(new Error('missing directory'), { name: 'NotFoundError' })
    const directory = new MemoryDirectoryHandle(name)
    this.directories.set(name, directory)
    return directory
  }

  async getFileHandle(name, options = {}) {
    if (this.files.has(name)) return this.files.get(name)
    if (!options.create) throw Object.assign(new Error('missing file'), { name: 'NotFoundError' })
    const file = new MemoryFileHandle(name)
    this.files.set(name, file)
    return file
  }

  async createFileExclusive(name, content) {
    if (this.beforeExclusiveCreate) this.beforeExclusiveCreate(name)
    if (this.files.has(name)) return { ok: false, code: 'TARGET_EXISTS', reason: 'exact_target_exists' }
    const file = new MemoryFileHandle(name)
    file.content = String(content)
    this.files.set(name, file)
    return { ok: true, publication: 'atomic_hard_link_no_replace' }
  }
}

class MemoryStorage {
  constructor() { this.values = new Map() }
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null }
  setItem(key, value) { this.values.set(String(key), String(value)) }
  removeItem(key) { this.values.delete(String(key)) }
}

const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

const providerResponse = (message, finishReason, usage) => new Response(JSON.stringify({
  choices: [{ message, finish_reason: finishReason }],
  usage
}), { headers: { 'content-type': 'application/json' } })

const providerToolCall = (id, name, input) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(input) }
  }]
})

test('nested UTF-8 SVG creation requires an explicitly-created parent and remains an image preview type', async () => {
  const root = new MemoryDirectoryHandle('workspace')
  assert.equal(root.directories.has('assets'), false)

  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>流程图</text></svg>'
  const missingParent = await createAgentWorkspaceFile(root, 'assets/flow.svg', svg)
  assert.deepEqual(missingParent, { ok: false, code: 'PARENT_MISSING', reason: 'parent_directory_missing' })
  assert.equal(root.directories.has('assets'), false)

  const assets = await root.getDirectoryHandle('assets', { create: true })
  const result = await createAgentWorkspaceFile(root, 'assets/flow.svg', svg)

  assert.deepEqual(result, {
    ok: true,
    code: 'FILE_CREATED',
    path: 'assets/flow.svg',
    kind: 'svg',
    defaultedExtension: false
  })
  assert.equal(assets.files.get('flow.svg').content, svg)
  assert.equal(classifyAgentWritableFile('assets/flow.svg'), 'svg')
  assert.equal(isAgentEditableTextFile('assets/flow.svg'), false)
  assert.equal(detectFtype('flow.svg'), null)
  assert.match(appSource, /\|svg\)\$\/i\.test\(name\) \? 'image'/)

  const unsupported = await createAgentWorkspaceFile(root, 'assets/payload.exe', 'x')
  assert.deepEqual(unsupported, {
    ok: false,
    code: 'UNSUPPORTED_FILE_TYPE',
    reason: 'unsupported_extension'
  })
  assert.equal(root.directories.get('assets').files.has('payload.exe'), false)
})

test('workspace create propagates parent lookup errors and publication uncertainty', async () => {
  const denied = new MemoryDirectoryHandle('workspace')
  denied.getDirectoryHandle = async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }) }
  assert.deepEqual(await createAgentWorkspaceFile(denied, 'private/note.md', 'x'), {
    ok: false,
    code: 'WRITE_FAILED',
    reason: 'NotAllowedError'
  })

  const uncertain = new MemoryDirectoryHandle('workspace')
  uncertain.createFileExclusive = async () => ({
    ok: false,
    code: 'CREATE_PUBLICATION_UNCERTAIN',
    reason: 'final_target_revalidation_failed'
  })
  assert.deepEqual(await createAgentWorkspaceFile(uncertain, 'note.md', 'x', { exactName: true }), {
    ok: false,
    code: 'CREATE_PUBLICATION_UNCERTAIN',
    reason: 'final_target_revalidation_failed'
  })
})

test('automatic-review exact file creation never falls through to a numbered target', async () => {
  const root = new MemoryDirectoryHandle('workspace')
  const existing = new MemoryFileHandle('result.md')
  existing.content = '# Existing\n'
  root.files.set(existing.name, existing)

  const exact = await createAgentWorkspaceFile(root, 'result.md', '# Replacement\n', { exactName: true })
  assert.deepEqual(exact, { ok: false, code: 'TARGET_EXISTS', reason: 'exact_target_exists' })
  assert.equal(root.files.get('result.md').content, '# Existing\n')
  assert.equal(root.files.has('result-2.md'), false)

  const manual = await createAgentWorkspaceFile(root, 'result.md', '# Numbered\n')
  assert.equal(manual.path, 'result-2.md')
  assert.equal(root.files.get('result.md').content, '# Existing\n')
  assert.equal(root.files.get('result-2.md').content, '# Numbered\n')

  const raced = new MemoryDirectoryHandle('raced-workspace')
  raced.beforeExclusiveCreate = (name) => {
    const external = new MemoryFileHandle(name)
    external.content = '# External winner\n'
    raced.files.set(name, external)
  }
  const racedResult = await createAgentWorkspaceFile(raced, 'race.md', '# Agent must not overwrite\n', { exactName: true })
  assert.deepEqual(racedResult, { ok: false, code: 'TARGET_EXISTS', reason: 'exact_target_exists' })
  assert.equal(raced.files.get('race.md').content, '# External winner\n')
})

test('create_file rejects unsupported extensions in semantic preflight before permission execution', () => {
  assert.deepEqual(resolveAgentCreateFilePath('notes/new-note'), {
    ok: true,
    path: 'notes/new-note.md',
    kind: 'markdown',
    defaultedExtension: true
  })
  const failure = validateAgentMutationInput('create_file', {
    path: 'assets/payload.exe',
    content: 'not executable bytes'
  })
  assert.equal(failure.code, 'UNSUPPORTED_FILE_TYPE')
  assert.equal(failure.data.reason_code, 'UNSUPPORTED_FILE_TYPE')
  const dispatch = storeSource.slice(
    storeSource.indexOf('const batchValidation = validateToolCallBatch'),
    storeSource.indexOf('result = requireVerifiedMutation', storeSource.indexOf('const batchValidation = validateToolCallBatch'))
  )
  assert.ok(dispatch.indexOf('if (preflight?.error)') < dispatch.indexOf('executeTool(call.name'))
})

test('document read preconditions distinguish not-read from a real stale revision', () => {
  assert.deepEqual(classifyDocumentReadPrecondition({
    currentDocumentId: 'doc-a',
    currentContent: 'new',
    lastReadDocumentId: null,
    lastReadContent: null
  }), { ok: false, code: 'DOCUMENT_NOT_READ' })
  assert.deepEqual(classifyDocumentReadPrecondition({
    currentDocumentId: 'doc-a',
    currentContent: 'new',
    lastReadDocumentId: 'doc-a',
    lastReadContent: 'old'
  }), { ok: false, code: 'DOCUMENT_STALE' })
  assert.match(storeSource, /code: 'DOCUMENT_NOT_READ'/)
  assert.match(appSource, /documentTargetFailure\('TARGET_REPLACED'/)
})

test('recovery enters awaiting-replan, forces one no-tool retry, and resolves only after repair', () => {
  const ledger = createExecutionLedger({ instruction: '修改文档', documentId: 'doc-a' })
  const failed = recordToolExecution(ledger, {
    callId: 'failed',
    name: 'replace_lines',
    input: { start_line: 2, end_line: 2, new_content: 'B' },
    result: toolFailure({ code: 'DOCUMENT_NOT_READ', retryable: true, message: 'not read' })
  })
  const state = createRecoveryReplanState()
  assert.equal(registerRecoveredMutation(state, failed, { code: RECOVERED_AWAITING_REPLAN }), RECOVERED_AWAITING_REPLAN)
  assert.equal(recoveryReplanPending(state, ledger), true)
  assert.match(buildRecoveryReplanConstraint(state), /旧行号不得盲目重放/)
  assert.equal(consumeRecoveryNoToolReplan(state, ledger), true)
  assert.equal(consumeRecoveryNoToolReplan(state, ledger), false)

  recordToolExecution(ledger, {
    callId: 'repair',
    name: 'replace_lines',
    input: { start_line: 2, end_line: 2, new_content: 'B' },
    result: toolSuccess({
      code: 'HUNK_STAGED',
      message: 'staged',
      mutation: { type: 'pending_hunk', target: 'document:doc-a', hunkIds: ['h-1'], verified: true }
    })
  })
  assert.equal(syncRecoveryReplanState(state, ledger), 'RECOVERY_REPLAN_RESOLVED')
  assert.equal(recoveryReplanPending(state, ledger), false)
})

test('recovery serialization exposes the refreshed body once and keeps compact provenance', () => {
  const body = 'UNIQUE_REFRESHED_DOCUMENT_BODY'
  const serialized = serializeToolResult(toolFailure({
    code: 'DOCUMENT_STALE',
    retryable: true,
    message: `original failure\n${body}`,
    recovery: {
      code: RECOVERED_AWAITING_REPLAN,
      revision: '12:abc',
      range: { start_line: 2, end_line: 4 },
      message: body,
      provenance: [{ call_id: 'synthetic-1', tool: 'read_document', code: 'DOCUMENT_READ', synthetic: true }]
    }
  }))
  assert.equal(serialized.split(body).length - 1, 1)
  const parsed = JSON.parse(serialized)
  assert.equal(parsed.recovery.message, undefined)
  assert.equal(parsed.recovery.code, RECOVERED_AWAITING_REPLAN)
  assert.deepEqual(parsed.recovery.range, { start_line: 2, end_line: 4 })
  assert.equal(parsed.recovery.provenance[0].call_id, 'synthetic-1')
})

test('RANGE_NOT_READ recovery reads every exact unread edit_file range', () => {
  assert.deepEqual(buildMutationRecoveryRequests({
    name: 'edit_file',
    input: { path: 'notes/a.md', old_string: 'x', new_string: 'y', replace_all: true }
  }, {
    code: 'RANGE_NOT_READ',
    data: { unread_ranges: [{ start: 3, end: 4 }, { start: 20, end: 22 }] }
  }), [{
    name: 'read_file',
    input: { path: 'notes/a.md', start_line: 3, end_line: 4 }
  }, {
    name: 'read_file',
    input: { path: 'notes/a.md', start_line: 20, end_line: 22 }
  }])
})

test('token accounting separates billing totals from context-window samples', () => {
  let usage = createAgentRunUsage()
  usage = accumulateAgentUsage(usage, { input: 128_000, output: 2000 })
  usage = accumulateAgentUsage(usage, { input: 96_000, output: 1000 })
  usage = accumulateAgentUsage(usage, { input: 160_000, output: 500 })
  assert.deepEqual(usage, {
    lastInput: 160_000,
    peakInput: 160_000,
    totalInput: 384_000,
    output: 3500,
    estimated: false
  })
  assert.equal(agentUsageTotalInput(usage), 384_000)
  assert.equal(agentUsageContextInput(usage).tokens, 160_000)
  assert.equal(agentUsageContextInput({ input: 384_000, output: 3500 }), null)

  const previous = chatMessages.value
  try {
    chatMessages.value = [{ role: 'assistant', text: '', usage }]
    assert.equal(contextUsage(), 160_000)
    chatMessages.value = [{ role: 'assistant', text: 'legacy', usage: { input: 384_000, output: 3500 } }]
    assert.ok(contextUsage() < 10_000)
  } finally {
    chatMessages.value = previous
  }
  assert.match(panelSource, /agentUsageTotalInput\(m\.usage\)/)
  assert.doesNotMatch(panelSource.slice(panelSource.indexOf('const ctxRing'), panelSource.indexOf('const fmtCtx')), /usage\.input|totalInput/)
})

test('session activity ordering and stalled health use explicit conversation progress', () => {
  assert.equal(sessionLastConversationAt({ id: 's-1000-1', lastConversationAt: 3000, messages: [{ id: 'msg-9000-1' }] }), 3000)
  assert.equal(sessionLastConversationAt({ id: 's-1000-1', messages: [{ id: 'msg-4000-1' }], queue: [{ createdAt: 5000 }] }), 5000)
  assert.equal(agentRuntimeIsStalled({ phase: 'running', lastProgressAt: 1000 }, 1000 + AGENT_STALL_MS - 1), false)
  assert.equal(agentRuntimeIsStalled({ phase: 'running', lastProgressAt: 1000 }, 1000 + AGENT_STALL_MS), true)
  assert.equal(agentRuntimeIsStalled({ phase: 'waiting_question', lastProgressAt: 1000 }, 1000 + AGENT_STALL_MS * 2), false)
  assert.equal(agentRuntimeIsStalled({ phase: 'waiting_permission', lastProgressAt: 1000 }, 1000 + AGENT_STALL_MS * 2), false)
  assert.equal(agentRuntimeIsStalled({ phase: 'running', transportExpected: false, lastProgressAt: 1000 }, 1000 + AGENT_STALL_MS * 2), false)
  assert.equal(agentRuntimeTransportHealth({ phase: 'running', transportExpected: true, transportHealth: 'healthy', lastProgressAt: 1000 }, 1000 + AGENT_STALL_MS), 'stalled')
  assert.equal(agentRuntimeTransportHealth({ phase: 'running', transportExpected: true, transportHealth: 'disconnected', lastProgressAt: 9000 }, 9000), 'disconnected')
  assert.equal(agentRuntimeTransportHealth({ phase: 'waiting_question', transportExpected: false, transportHealth: 'healthy', lastProgressAt: 1000 }, 1000 + AGENT_STALL_MS * 2), 'healthy')
  assert.doesNotMatch(appSource, /agent_run_stalled/)
  assert.match(panelSource, /:data-health="activeRunHealth"/)
  assert.match(panelSource, /activeAgentRuntime\.value\.activity \|\| agentActivity\.value/)
})

test('Agent UI exposes explicit copy controls and a workspace destination picker', () => {
  const blockCopySource = appSource.slice(
    appSource.indexOf('const decorateAgentCopyControls ='),
    appSource.indexOf('const resolveAgentChatImages =')
  )
  assert.match(panelSource, /data-agent-copy="message"/)
  assert.match(panelSource, /data-agent-copy/)
  assert.match(panelSource, /tableToMarkdown/)
  assert.match(blockCopySource, /button\.classList\.add\('is-icon'\)[\s\S]*knote-agent-copy-icon[\s\S]*knote-agent-copy-check/)
  assert.doesNotMatch(blockCopySource, /button\.textContent = label/)
  assert.doesNotMatch(panelSource, /if \(kind === 'code'\) copy\.textContent/)
  assert.match(appSource, /data-testid="workspace-new-file"/)
  assert.match(appSource, /data-testid="workspace-new-folder"/)
  assert.match(appSource, /data-testid="create-target-dialog"/)
  assert.match(appSource, /v-for="destination in createDestinations"/)
})

test('actual provider loop forces replan after automatic read and then stages the repair', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const originalStorage = globalThis.localStorage
  const requests = []
  const responses = [
    providerResponse(providerToolCall('edit-before-read', 'replace_lines', {
      start_line: 2,
      end_line: 2,
      new_content: 'replanned line'
    }), 'tool_calls', { prompt_tokens: 100, completion_tokens: 10 }),
    providerResponse({ role: 'assistant', content: '只能部分完成。' }, 'stop', { prompt_tokens: 180, completion_tokens: 8 }),
    providerResponse(providerToolCall('edit-after-read', 'replace_lines', {
      start_line: 2,
      end_line: 2,
      new_content: 'replanned line'
    }), 'tool_calls', { prompt_tokens: 220, completion_tokens: 12 }),
    providerResponse({ role: 'assistant', content: '已提交修改，请审核。' }, 'stop', { prompt_tokens: 260, completion_tokens: 9 })
  ]
  globalThis.window = {}
  globalThis.localStorage = new MemoryStorage()
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body))
    const response = responses.shift()
    if (!response) throw new Error('unexpected provider request')
    return response
  }

  try {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const store = await import(`../src/lib/agentStore.js?execution-chain=${suffix}`)
    Object.assign(store.agentConfig, {
      protocol: 'openai',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'test-key',
      model: 'test-model',
      verify: false,
      ctxWindow: 0,
      webSearch: false
    })
    Object.assign(store.capabilities, { checked: true, chat: true, tools: true, vision: false, pdf: false })
    const document = 'first line\noriginal line\nlast line'
    Object.assign(store.agentBridge, {
      getMarkdown: () => document,
      getDocumentIdentity: () => 'doc:execution-chain',
      getWorkspaceIdentity: () => 'workspace:execution-chain',
      getActiveFilePath: () => 'note.md',
      isCurrentDocumentEditable: () => true,
      hasFolder: () => false,
      scrollToLine: () => {},
      previewChange: () => {},
      clearPreview: () => {}
    })
    store.chatSessions.value[0].title = 'execution chain test'

    const admitted = await store.sendToAgent('请修改第二行')
    assert.equal(admitted.ok, true)
    const settled = await waitFor(() => {
      const runtime = store.agentSessionRuntime(store.chatSessions.value[0])
      return runtime.phase === 'idle' && !(store.chatSessions.value[0].queue || []).length
    })
    assert.equal(settled, true)
    assert.equal(requests.length, 4)
    const recoveredHistory = JSON.stringify(requests[1].messages)
    assert.match(recoveredHistory, /RECOVERED_AWAITING_REPLAN/)
    assert.equal(recoveredHistory.split('original line').length - 1, 1)
    const recoveredToolResult = requests[1].messages.find((message) => message.role === 'tool')
    assert.equal(JSON.parse(recoveredToolResult.content).recovery.message, undefined)
    assert.match(JSON.stringify(requests[2].messages), /强制再给一次独立 replan 机会/)
    assert.equal(store.pendingHunks.value.length, 1)
    assert.equal(store.pendingHunks.value[0].newLines.join('\n'), 'replanned line')
    const final = store.chatSessions.value[0].messages.filter((message) => message.role === 'assistant').at(-1)
    assert.equal(final.text, '已提交修改，请审核。')
    assert.deepEqual(final.usage, {
      lastInput: 260,
      peakInput: 260,
      totalInput: 760,
      output: 39,
      estimated: false
    })
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
    if (originalStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = originalStorage
  }
})

test('provisional text survives tool rounds, replaces prior prose, and commits only after terminal validation', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const originalStorage = globalThis.localStorage
  const storage = new MemoryStorage()
  const encoder = new TextEncoder()
  const streamControllers = []
  let providerRound = 0
  const emit = (round, payload) => {
    streamControllers[round].enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
  }
  globalThis.window = {}
  globalThis.localStorage = storage
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body)
    if (Number(payload.max_tokens || payload.max_completion_tokens) === 64) {
      return providerResponse({ role: 'assistant', content: 'Stream title' }, 'stop', { prompt_tokens: 4, completion_tokens: 2 })
    }
    const round = providerRound++
    return new Response(new ReadableStream({ start(controller) { streamControllers[round] = controller } }), {
      headers: { 'content-type': 'text/event-stream' }
    })
  }

  try {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const store = await import(`../src/lib/agentStore.js?stream-projection=${suffix}`)
    Object.assign(store.agentConfig, {
      protocol: 'openai', baseUrl: 'https://provider.test/v1', apiKey: 'test-key', model: 'test-model',
      verify: false, ctxWindow: 0, webSearch: false
    })
    Object.assign(store.capabilities, { checked: true, chat: true, tools: true, vision: false, pdf: false })
    Object.assign(store.agentBridge, {
      getMarkdown: () => '# Stream test\n',
      getDocumentIdentity: () => 'doc:stream-projection',
      getWorkspaceIdentity: () => 'workspace:stream-projection',
      getActiveFilePath: () => 'stream.md',
      isCurrentDocumentEditable: () => true,
      hasFolder: () => false
    })
    const session = store.chatSessions.value[0]
    const sessionId = session.id
    assert.equal((await store.sendToAgent('STREAM_PROJECTION_TEST')).ok, true)
    assert.equal(await waitFor(() => !!streamControllers[0]), true)

    emit(0, { choices: [{ delta: { content: 'ROUND_ONE_PRE_TOOL' }, finish_reason: null }] })
    assert.equal(await waitFor(() => store.agentSessionRuntime(session).provisionalText === 'ROUND_ONE_PRE_TOOL'), true)
    assert.equal(session.messages.some((message) => String(message.text || '').includes('ROUND_ONE_PRE_TOOL')), false)
    emit(0, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'calc-one', type: 'function', function: { name: 'calc', arguments: '{"expression":"1+1"}' } }] }, finish_reason: null }] })
    emit(0, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    streamControllers[0].close()

    assert.equal(await waitFor(() => !!streamControllers[1]), true)
    assert.equal(store.agentSessionRuntime(session).provisionalText, 'ROUND_ONE_PRE_TOOL')

    emit(1, { choices: [{ delta: { content: 'ROUND_' }, finish_reason: null }] })
    assert.equal(await waitFor(() => store.agentSessionRuntime(session).provisionalText === 'ROUND_'), true)
    emit(1, { choices: [{ delta: { content: 'TWO_PRE_TOOL' }, finish_reason: null }] })
    assert.equal(await waitFor(() => store.agentSessionRuntime(session).provisionalText === 'ROUND_TWO_PRE_TOOL'), true)
    assert.doesNotMatch(store.agentSessionRuntime(session).provisionalText, /ROUND_ONE/)
    assert.equal(session.messages.some((message) => /ROUND_(?:ONE|TWO)/.test(String(message.text || ''))), false)

    store.newSession()
    const otherSessionId = store.activeSessionId.value
    store.switchSession(sessionId)
    assert.doesNotMatch([...storage.values.values()].join('\n'), /ROUND_(?:ONE|TWO)/)

    emit(1, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'calc-two', type: 'function', function: { name: 'calc', arguments: '{"expression":"2+2"}' } }] }, finish_reason: null }] })
    emit(1, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    streamControllers[1].close()

    assert.equal(await waitFor(() => !!streamControllers[2]), true)
    assert.equal(store.agentSessionRuntime(session).provisionalText, 'ROUND_TWO_PRE_TOOL')

    emit(2, { choices: [{ delta: { content: 'FINAL_' }, finish_reason: null }] })
    assert.equal(await waitFor(() => store.agentSessionRuntime(session).provisionalText === 'FINAL_'), true)
    emit(2, { choices: [{ delta: { content: 'ANSWER' }, finish_reason: null }] })
    assert.equal(await waitFor(() => store.agentSessionRuntime(session).provisionalText === 'FINAL_ANSWER'), true)
    assert.doesNotMatch(store.agentSessionRuntime(session).provisionalText, /ROUND_/)
    assert.equal(session.messages.some((message) => String(message.text || '').includes('FINAL_ANSWER')), false)

    store.switchSession(otherSessionId)
    store.switchSession(sessionId)
    assert.doesNotMatch([...storage.values.values()].join('\n'), /ROUND_(?:ONE|TWO)|FINAL_ANSWER/)

    emit(2, { choices: [{ delta: {}, finish_reason: 'stop' }] })
    streamControllers[2].close()
    assert.equal(await waitFor(() => store.agentSessionRuntime(session).phase === 'idle'), true)
    assert.equal(store.agentSessionRuntime(session).provisionalText, '')
    assert.equal(session.messages.filter((message) => message.role === 'assistant' && message.text === 'FINAL_ANSWER').length, 1)
    assert.equal(session.messages.some((message) => /ROUND_(?:ONE|TWO)/.test(String(message.text || ''))), false)
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
    if (originalStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = originalStorage
  }
})
