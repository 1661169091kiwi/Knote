import test from 'node:test'
import assert from 'node:assert/strict'
import { indexedDB } from 'fake-indexeddb'

globalThis.indexedDB = indexedDB

const {
  deleteAgentChatState,
  enqueueAgentChatState,
  flushAgentChatState,
  loadAgentChatState
} = await import('../src/lib/agentStateStore.js')

test('Agent state mirror keeps only the newest complete snapshot per workspace', async () => {
  const key = 'knote-agent-chat:workspace-state-test'
  await deleteAgentChatState(key)
  await enqueueAgentChatState(key, { updatedAt: 1, sessions: [{ id: 'old' }] })
  await enqueueAgentChatState(key, { updatedAt: 2, sessions: [{ id: 'new' }] })
  await flushAgentChatState()
  assert.deepEqual(await loadAgentChatState(key), { updatedAt: 2, sessions: [{ id: 'new' }] })
  await deleteAgentChatState(key)
  assert.equal(await loadAgentChatState(key), null)
})
