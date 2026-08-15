import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_MEMORY_MAX_CHARS,
  AGENT_MEMORY_VERSION,
  agentMessagesAfterSummary,
  buildAgentMemorySource,
  fallbackAgentMemory,
  normalizeAgentMemorySummary,
  selectAgentCompactionRange,
  selectAgentMemoryCommit,
  selectAgentMessagesForPersistence,
  shouldCompactAgentContext
} from '../src/lib/agentContextMemory.js'

const messages = Array.from({ length: 40 }, (_, index) => ({
  id: `message-${index + 1}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  text: `${index % 2 === 0 ? 'request' : 'answer'} ${index + 1}`
}))

const summaryAt = (throughMessageId, text = 'A valid lossless memory claim') => ({
  version: AGENT_MEMORY_VERSION,
  text,
  throughMessageId,
  sourceCount: 10,
  updatedAt: 1
})

test('context compaction ends on a completed assistant turn and retains the recent tail', () => {
  const range = selectAgentCompactionRange(messages, null, { keepRecent: 14, minMessages: 8 })
  assert.ok(range)
  assert.equal(range.throughMessageId, 'message-26')
  assert.equal(range.sourceMessages.at(-1).role, 'assistant')
  assert.equal(range.remainingMessages.length, 14)
  assert.equal(agentMessagesAfterSummary(messages, summaryAt(range.throughMessageId)).length, 14)
})

test('incremental compaction starts after the previous summary boundary', () => {
  const range = selectAgentCompactionRange(messages, summaryAt('message-10'), { keepRecent: 14, minMessages: 8 })
  assert.ok(range)
  assert.equal(range.sourceMessages[0].id, 'message-11')
  assert.equal(range.throughMessageId, 'message-26')
})

test('compaction pressure uses both message count and context-window budget', () => {
  assert.equal(shouldCompactAgentContext(messages, null, { contextWindow: 128_000 }), true)
  const short = messages.slice(0, 20).map((message) => ({ ...message, text: 'x'.repeat(3000) }))
  assert.equal(shouldCompactAgentContext(short, null, { contextWindow: 16_000, systemTokens: 1500, keepRecent: 8 }), true)
  assert.equal(shouldCompactAgentContext(messages.slice(0, 12).map((message) => ({ ...message, text: 'y'.repeat(2000) })), null, { contextWindow: 4000, keepRecent: 8 }), true)
})

test('memory source preserves roles, attachments, receipts, and has a bounded fallback', () => {
  const source = buildAgentMemorySource([{
    id: 'u-1',
    role: 'user',
    text: 'Update src/main.js',
    attachments: [{ name: 'requirements.md' }]
  }, {
    id: 'a-1',
    role: 'assistant',
    text: 'The edit was staged.',
    receipt: { status: 'success', target: 'src/main.js' }
  }])
  assert.match(source, /用户/)
  assert.match(source, /requirements\.md/)
  assert.match(source, /src\/main\.js/)
  assert.match(source, /执行凭证/)
  assert.equal(fallbackAgentMemory({ text: 'old memory' }, 'z'.repeat(20_000), { maxChars: 4000 }), null)
})

test('compaction never cuts between segmented assistant bubbles', () => {
  const segmented = [
    { id: 'u-1', role: 'user', text: 'first request' },
    { id: 'a-1', role: 'assistant', text: 'tool progress' },
    { id: 'a-2', role: 'assistant', text: 'verified final answer' },
    { id: 'u-2', role: 'user', text: 'second request' },
    { id: 'a-3', role: 'assistant', text: 'second answer' },
    { id: 'u-3', role: 'user', text: 'recent request' },
    { id: 'a-4', role: 'assistant', text: 'recent answer' }
  ]
  const range = selectAgentCompactionRange(segmented, null, { keepRecent: 2, minMessages: 2 })
  assert.equal(range.throughMessageId, 'a-3')
  assert.match(buildAgentMemorySource(range.sourceMessages), /verified final answer/)
})

test('lossless source selection stops before an oversized message and preserves selections', () => {
  const source = [
    { id: 'u-1', role: 'user', text: 'request', selection: { text: 'SELECTED_FACT', lineHint: 'L2' } },
    { id: 'a-1', role: 'assistant', text: 'answer' },
    { id: 'u-2', role: 'user', text: 'MIDDLE_FACT ' + 'x'.repeat(6000) },
    { id: 'a-2', role: 'assistant', text: 'later answer' },
    { id: 'u-3', role: 'user', text: 'tail request' },
    { id: 'a-3', role: 'assistant', text: 'tail answer' }
  ]
  const range = selectAgentCompactionRange(source, null, { keepRecent: 2, minMessages: 2, maxSourceChars: 4000 })
  assert.equal(range.throughMessageId, 'a-1')
  const memory = buildAgentMemorySource(range.sourceMessages)
  assert.match(memory, /SELECTED_FACT/)
  assert.doesNotMatch(memory, /MIDDLE_FACT/)
})

test('compaction cannot advance past attachment content that has no coverage record', () => {
  const source = [
    { id: 'u-1', role: 'user', text: 'ordinary request' },
    { id: 'a-1', role: 'assistant', text: 'ordinary answer' },
    { id: 'u-2', role: 'user', text: '', attachments: [{ name: 'requirements.pdf' }] },
    { id: 'a-2', role: 'assistant', text: 'answer based on the attachment' },
    { id: 'u-3', role: 'user', text: 'recent request' },
    { id: 'a-3', role: 'assistant', text: 'recent answer' }
  ]
  const range = selectAgentCompactionRange(source, null, { keepRecent: 2, minMessages: 2 })
  assert.equal(range.throughMessageId, 'a-1')
  assert.doesNotMatch(buildAgentMemorySource(range.sourceMessages), /requirements\.pdf/)
})

test('memory summaries reject clipping and commit text and boundary atomically', () => {
  assert.equal(AGENT_MEMORY_MAX_CHARS, 12_000)
  assert.equal(normalizeAgentMemorySummary(summaryAt('message-2', 'x'.repeat(12_001))), null)
  assert.equal(normalizeAgentMemorySummary({ ...summaryAt('message-2'), throughMessageId: '' }), null)
  assert.equal(normalizeAgentMemorySummary({ ...summaryAt('message-2'), sourceCount: '10' }), null)

  const previous = summaryAt('message-2', 'previous lossless memory')
  const sourceThatCannotFit = 'SOURCE_FACT '.repeat(1500)
  const invalidResults = [
    { text: 'x'.repeat(12_001), terminalComplete: true },
    { text: ` ${'x'.repeat(11_999)} `, terminalComplete: true },
    { text: 'truncated memory '.repeat(10), terminalComplete: false, truncated: true },
    { text: 'refusal response '.repeat(10), terminalComplete: true, refusal: true }
  ]
  for (const providerResult of invalidResults) {
    assert.equal(selectAgentMemoryCommit({
      previousSummary: previous,
      source: sourceThatCannotFit,
      providerResult,
      throughMessageId: 'message-8',
      sourceMessages: 6,
      updatedAt: 2
    }), null)
    assert.equal(previous.throughMessageId, 'message-2')
    assert.equal(previous.text, 'previous lossless memory')
  }

  const fallback = selectAgentMemoryCommit({
    previousSummary: previous,
    source: 'RAW_FACT must survive',
    providerResult: { text: 'short', terminalComplete: true },
    throughMessageId: 'message-8',
    sourceMessages: 6,
    updatedAt: 2
  })
  assert.equal(fallback.mode, 'extractive')
  assert.equal(fallback.summary.throughMessageId, 'message-8')
  assert.match(fallback.summary.text, /RAW_FACT must survive/)
})

test('persistence retains all uncovered messages and at least the latest 80-message UI tail', () => {
  const history = Array.from({ length: 181 }, (_, index) => ({
    id: `persist-${index + 1}`,
    role: index % 2 ? 'assistant' : 'user',
    text: `message ${index + 1}`
  }))
  assert.equal(selectAgentMessagesForPersistence(history, null).length, 181)
  assert.equal(selectAgentMessagesForPersistence(history, summaryAt('missing-boundary')).length, 181)

  const uncovered = selectAgentMessagesForPersistence(history, summaryAt('persist-20'))
  assert.equal(uncovered.length, 162)
  assert.equal(uncovered[0].id, 'persist-20')
  assert.equal(uncovered.at(-1).id, 'persist-181')

  const recentBoundary = selectAgentMessagesForPersistence(history, summaryAt('persist-170'))
  assert.equal(recentBoundary.length, 80)
  assert.equal(recentBoundary[0].id, 'persist-102')
  assert.equal(recentBoundary.at(-1).id, 'persist-181')
})

test('receipt-bearing errors and covered attachment memory enter compaction source', () => {
  const source = buildAgentMemorySource([{
    id: 'receipt-error',
    role: 'assistant',
    text: 'The read failed deterministically.',
    error: true,
    receipt: { grounding: { status: 'failed', failed: 1 } }
  }, {
    id: 'recovery-error',
    role: 'assistant',
    text: 'The prior run was interrupted.',
    error: true,
    interruptedRunId: 'run-interrupted'
  }, {
    id: 'bare-error',
    role: 'assistant',
    text: 'MODEL_ERROR_MUST_NOT_ENTER_MEMORY',
    error: true
  }, {
    id: 'retracted-error',
    role: 'assistant',
    text: 'RETRACTED_ERROR_MUST_NOT_ENTER_MEMORY',
    error: true,
    receipt: { status: 'failed' },
    retracted: true
  }, {
    id: 'attachment-memory',
    role: 'user',
    text: '',
    attachments: [{ name: 'covered.pdf' }],
    attachmentMemory: { covered: true, text: 'COVERED_ATTACHMENT_FACT' }
  }])
  assert.match(source, /grounding/)
  assert.match(source, /run-interrupted/)
  assert.match(source, /COVERED_ATTACHMENT_FACT/)
  assert.doesNotMatch(source, /MODEL_ERROR_MUST_NOT_ENTER_MEMORY/)
  assert.doesNotMatch(source, /RETRACTED_ERROR_MUST_NOT_ENTER_MEMORY/)
})
