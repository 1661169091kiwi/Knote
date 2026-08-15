import test from 'node:test'
import assert from 'node:assert/strict'

class FailingStorage {
  constructor(entries = []) { this.values = new Map(entries) }
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null }
  setItem() { throw new Error('quota exceeded') }
  removeItem(key) { this.values.delete(String(key)) }
}

test('failed state recovery rolls back before settlement events can suppress a retry', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const workspaceId = `folder:recovery-${suffix}`
  const chatKey = `knote-agent-chat:${workspaceId}`
  const sessionId = `session-${suffix}`
  const runId = `run-${suffix}`
  const promptId = `prompt-${suffix}`
  const steerId = `steer-${suffix}`
  const events = [
    { id: 'admit', type: 'prompt.admitted', at: 1, order: 1, payload: { promptId: steerId, context: { workspaceId } } },
    { id: 'start', type: 'run.started', at: 2, order: 2, payload: { runId, promptId } },
    { id: 'steered', type: 'prompt.steered', at: 3, order: 3, payload: { runId, promptId: steerId } }
  ]
  const state = JSON.stringify({
    schemaVersion: 2,
    updatedAt: 10,
    activeId: sessionId,
    sessions: [{
      id: sessionId,
      title: '',
      messages: [
        { id: promptId, role: 'user', text: 'original task' },
        { id: steerId, role: 'user', text: 'uncertain steer' }
      ],
      plan: [],
      activity: [],
      queue: [],
      events,
      eventWatermark: 3,
      summary: null
    }]
  })
  globalThis.localStorage = new FailingStorage([[chatKey, state]])
  globalThis.window = {}
  delete globalThis.indexedDB
  try {
    const store = await import(`../src/lib/agentStore.js?failed-recovery=${suffix}`)
    store.setChatWorkspace({ id: workspaceId })
    await store.sendToAgent('')
    const session = store.chatSessions.value[0]
    assert.deepEqual(session.messages.map((message) => message.text), ['original task', 'uncertain steer'])
    assert.deepEqual(session.queue, [])
    assert.deepEqual(session.events.map((event) => event.type), ['prompt.admitted', 'run.started', 'prompt.steered'])
  } finally {
    delete globalThis.window
    delete globalThis.localStorage
  }
})
