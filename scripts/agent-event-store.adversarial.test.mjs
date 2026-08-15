import test from 'node:test'
import assert from 'node:assert/strict'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'

globalThis.indexedDB = indexedDB
globalThis.IDBKeyRange = IDBKeyRange

const {
  appendAgentEvent,
  deleteAgentSessionEvents,
  findInterruptedAgentRuns,
  flushAgentEvents,
  listAgentSessionEvents,
  pruneAgentSessionEvents
} = await import('../src/lib/agentEventStore.js')

const event = (id, type, at, payload = {}) => ({
  id,
  chatKey: 'chat:workspace-a',
  sessionId: 'session-a',
  type,
  at,
  payload
})

test('Agent event storage preserves order and identifies only unfinished runs', async () => {
  await deleteAgentSessionEvents('chat:workspace-a', 'session-a')
  await appendAgentEvent(event('e-1', 'run.started', 1, { runId: 'run-complete', promptId: 'prompt-1' }))
  await appendAgentEvent(event('e-2', 'tool.started', 2, { runId: 'run-complete', callId: 'call-1', tool: 'read_file' }))
  await appendAgentEvent(event('e-3', 'tool.settled', 3, { runId: 'run-complete', callId: 'call-1', tool: 'read_file' }))
  await appendAgentEvent(event('e-4', 'run.completed', 4, { runId: 'run-complete' }))
  await appendAgentEvent(event('e-5', 'run.started', 5, { runId: 'run-interrupted', promptId: 'prompt-2' }))
  await appendAgentEvent(event('e-6', 'tool.started', 6, { runId: 'run-interrupted', callId: 'call-2', tool: 'edit_file' }))
  await flushAgentEvents()

  const stored = await listAgentSessionEvents('chat:workspace-a', 'session-a')
  assert.deepEqual(stored.map((item) => item.id), ['e-1', 'e-2', 'e-3', 'e-4', 'e-5', 'e-6'])
  assert.deepEqual(findInterruptedAgentRuns(stored), [{
    runId: 'run-interrupted',
    promptId: 'prompt-2',
    startedAt: 5,
    lastEventAt: 6,
    uncertainTools: [{ callId: 'call-2', tool: 'edit_file' }]
  }])
})

test('Agent event retention and deletion stay scoped to one conversation', async () => {
  await appendAgentEvent({ ...event('other-1', 'run.started', 1, { runId: 'other-run' }), sessionId: 'session-b' })
  await pruneAgentSessionEvents('chat:workspace-a', 'session-a', 3)
  assert.deepEqual(
    (await listAgentSessionEvents('chat:workspace-a', 'session-a')).map((item) => item.id),
    ['e-4', 'e-5', 'e-6']
  )
  assert.equal((await listAgentSessionEvents('chat:workspace-a', 'session-b')).length, 1)

  await deleteAgentSessionEvents('chat:workspace-a', 'session-a')
  assert.equal((await listAgentSessionEvents('chat:workspace-a', 'session-a')).length, 0)
  assert.equal((await listAgentSessionEvents('chat:workspace-a', 'session-b')).length, 1)
})

test('legacy same-millisecond terminal and settled events are order independent', () => {
  const legacy = [
    event('z-start', 'run.started', 10, { runId: 'legacy-run', promptId: 'legacy-prompt' }),
    event('z-tool', 'tool.started', 10, { runId: 'legacy-run', callId: 'legacy-call', tool: 'edit_file' }),
    event('a-complete', 'run.completed', 10, { runId: 'legacy-run' }),
    event('a-settled', 'tool.settled', 10, { runId: 'legacy-run', callId: 'legacy-call', tool: 'edit_file' })
  ]
  assert.deepEqual(findInterruptedAgentRuns(legacy), [])
})

test('retention preserves every event belonging to an unfinished run', async () => {
  await deleteAgentSessionEvents('chat:workspace-a', 'session-a')
  await appendAgentEvent(event('old-terminal', 'run.completed', 1, { runId: 'old-run' }), { maxEvents: 2 })
  await appendAgentEvent(event('live-start', 'run.started', 2, { runId: 'live-run', promptId: 'p' }), { maxEvents: 2 })
  await appendAgentEvent(event('live-tool', 'tool.started', 3, { runId: 'live-run', callId: 'c', tool: 'edit_file' }), { maxEvents: 2 })
  assert.deepEqual(
    (await listAgentSessionEvents('chat:workspace-a', 'session-a')).map((item) => item.id),
    ['live-start', 'live-tool']
  )
})

test('a reused legacy call id is matched by occurrence so the later start stays uncertain', () => {
  const reused = [
    event('run-start', 'run.started', 1, { runId: 'reused-run', promptId: 'prompt' }),
    event('first-start', 'tool.started', 2, { runId: 'reused-run', callId: 'legacy-call', tool: 'read_file' }),
    event('first-settled', 'tool.settled', 3, { runId: 'reused-run', callId: 'legacy-call', tool: 'read_file' }),
    event('second-start', 'tool.started', 4, { runId: 'reused-run', callId: 'legacy-call', tool: 'edit_file' })
  ]
  assert.deepEqual(findInterruptedAgentRuns(reused), [{
    runId: 'reused-run',
    promptId: 'prompt',
    startedAt: 1,
    lastEventAt: 4,
    uncertainTools: [{ callId: 'legacy-call', tool: 'edit_file' }]
  }])
})
