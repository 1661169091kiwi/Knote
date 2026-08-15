import test from 'node:test'
import assert from 'node:assert/strict'
import { indexedDB } from 'fake-indexeddb'

import {
  buildAgentMemorySource,
  selectAgentCompactionRange,
  shouldCompactAgentContext
} from '../src/lib/agentContextMemory.js'
import { loadAgentChatState, saveAgentChatState } from '../src/lib/agentStateStore.js'
import {
  canonicalAgentWorkspaceId,
  historicalWindowsAgentWorkspaceId
} from '../src/lib/agentWorkspaceKey.js'

class MemoryStorage {
  constructor() { this.values = new Map() }
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null }
  setItem(key, value) { this.values.set(String(key), String(value)) }
  removeItem(key) { this.values.delete(String(key)) }
}

const installBrowserStorage = () => {
  globalThis.indexedDB = indexedDB
  globalThis.localStorage = new MemoryStorage()
  globalThis.window = {}
}

const removeBrowserStorage = () => {
  delete globalThis.window
  delete globalThis.localStorage
  delete globalThis.indexedDB
}

test('a send waiting for hydration cannot cross into a newly selected workspace', async () => {
  installBrowserStorage()
  try {
    const store = await import(`../src/lib/agentStore.js?hydration-owner=${Date.now()}`)
    Object.assign(store.agentConfig, { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', model: 'test' })
    store.setChatWorkspace({ id: `folder:hydration-a-${Date.now()}` })
    store.agentStatus.value = 'running'
    const pending = store.sendToAgent('must stay in workspace A')
    store.setChatWorkspace({ id: `folder:hydration-b-${Date.now()}` })
    const result = await pending
    assert.deepEqual(result, { ok: false, code: 'AGENT_CONTEXT_CHANGED' })
    assert.equal(store.chatSessions.value.some((session) => session.queue.length), false)
    store.agentStatus.value = 'idle'
    await store.sendToAgent('')
  } finally {
    removeBrowserStorage()
  }
})

test('a newer IndexedDB completion is selected before interrupted-run recovery writes', async () => {
  installBrowserStorage()
  try {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const workspaceId = `folder:mirror-${suffix}`
    const chatKey = `knote-agent-chat:${workspaceId}`
    const sessionId = `session-${suffix}`
    const promptId = `prompt-${suffix}`
    const replyId = `reply-${suffix}`
    const started = { id: `start-${suffix}`, type: 'run.started', at: 10, order: 10, payload: { runId: `run-${suffix}`, promptId } }
    const completed = { id: `complete-${suffix}`, type: 'run.completed', at: 20, order: 20, payload: { runId: `run-${suffix}`, promptId, messageId: replyId, text: 'durable final reply' } }
    localStorage.setItem(chatKey, JSON.stringify({
      schemaVersion: 2,
      updatedAt: 100,
      activeId: sessionId,
      sessions: [{
        id: sessionId,
        title: '',
        messages: [{ id: promptId, role: 'user', text: 'finish this' }],
        plan: [],
        activity: [],
        queue: [],
        events: [started],
        eventWatermark: 10,
        summary: null
      }]
    }))
    await saveAgentChatState(chatKey, {
      schemaVersion: 2,
      updatedAt: 200,
      activeId: sessionId,
      sessions: [{
        id: sessionId,
        title: '',
        messages: [
          { id: promptId, role: 'user', text: 'finish this' },
          { id: replyId, role: 'assistant', text: 'durable final reply' }
        ],
        plan: [],
        activity: [],
        queue: [],
        events: [started, completed],
        eventWatermark: 20,
        summary: null
      }]
    })

    const store = await import(`../src/lib/agentStore.js?mirror-order=${suffix}`)
    store.setChatWorkspace({ id: workspaceId })
    await store.sendToAgent('')
    assert.deepEqual(store.chatMessages.value.map((message) => message.text), ['finish this', 'durable final reply'])
    assert.equal(store.chatMessages.value.some((message) => message.error), false)
  } finally {
    removeBrowserStorage()
  }
})

test('switching away during hydration cannot mirror the stale local snapshot over a newer completion', async () => {
  installBrowserStorage()
  try {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const workspaceId = `folder:switch-${suffix}`
    const chatKey = `knote-agent-chat:${workspaceId}`
    const sessionId = `session-${suffix}`
    const localState = {
      schemaVersion: 2,
      updatedAt: 100,
      activeId: sessionId,
      sessions: [{ id: sessionId, title: '', messages: [{ id: 'local', role: 'user', text: 'stale local' }], plan: [], activity: [], queue: [], events: [], eventWatermark: 0, summary: null }]
    }
    const durableState = {
      schemaVersion: 2,
      updatedAt: 200,
      activeId: sessionId,
      sessions: [{ id: sessionId, title: '', messages: [{ id: 'durable', role: 'assistant', text: 'new durable completion' }], plan: [], activity: [], queue: [], events: [], eventWatermark: 0, summary: null }]
    }
    localStorage.setItem(chatKey, JSON.stringify(localState))
    await saveAgentChatState(chatKey, durableState)

    const store = await import(`../src/lib/agentStore.js?switch-hydration=${suffix}`)
    store.setChatWorkspace({ id: workspaceId })
    store.setChatWorkspace({ id: `folder:elsewhere-${suffix}` })
    await store.sendToAgent('')
    store.setChatWorkspace({ id: workspaceId })
    await store.sendToAgent('')
    assert.deepEqual(store.chatMessages.value.map((message) => message.text), ['new durable completion'])
  } finally {
    removeBrowserStorage()
  }
})

test('a folded Windows legacy chat is claimed once and merges local and durable records into the exact-case key', async () => {
  installBrowserStorage()
  try {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const requestedId = `folder:C:\\Users\\Writer\\Migration-${suffix}`
    const secondRequestedId = `folder:C:\\USERS\\Writer\\Migration-${suffix}`
    const exactId = canonicalAgentWorkspaceId(requestedId)
    const secondExactId = canonicalAgentWorkspaceId(secondRequestedId)
    const foldedId = historicalWindowsAgentWorkspaceId(requestedId)
    assert.equal(historicalWindowsAgentWorkspaceId(secondRequestedId), foldedId)
    assert.notEqual(exactId, secondExactId)

    const targetKey = `knote-agent-chat:${exactId}`
    const secondTargetKey = `knote-agent-chat:${secondExactId}`
    const foldedKey = `knote-agent-chat:${foldedId}`
    const state = (updatedAt, activeId, sessions) => ({ schemaVersion: 2, updatedAt, activeId, sessions })
    const session = (id, text) => ({
      id,
      title: '',
      messages: [{ id: `message-${text}`, role: 'user', text }],
      plan: [],
      activity: [],
      queue: [],
      events: [],
      eventWatermark: 0,
      summary: null
    })
    localStorage.setItem(targetKey, JSON.stringify(state(10, 'shared-session', [session('shared-session', 'exact current record')])))
    await saveAgentChatState(targetKey, state(15, 'exact-durable-session', [session('exact-durable-session', 'exact durable record')]))
    const foldedLocal = state(20, 'shared-session', [session('shared-session', 'folded local record')])
    localStorage.setItem(foldedKey, JSON.stringify(foldedLocal))
    const foldedDurable = state(30, 'durable-session', [session('durable-session', 'folded durable record')])
    await saveAgentChatState(foldedKey, foldedDurable)
    localStorage.setItem(secondTargetKey, JSON.stringify(state(40, 'second-session', [session('second-session', 'second exact record')])))

    const store = await import(`../src/lib/agentStore.js?folded-migration=${suffix}`)
    store.setChatWorkspace({ id: requestedId })
    await store.sendToAgent('')
    const importedTexts = store.chatSessions.value.flatMap((item) => item.messages.map((message) => message.text))
    assert.deepEqual(new Set(importedTexts), new Set([
      'exact current record',
      'exact durable record',
      'folded local record',
      'folded durable record'
    ]))
    assert.equal(store.chatSessions.value.length, 4, 'same-id records must use the existing collision remap')

    const persistedTarget = await loadAgentChatState(targetKey)
    assert.deepEqual(new Set(persistedTarget.sessions.flatMap((item) => item.messages.map((message) => message.text))), new Set(importedTexts))
    assert.deepEqual(JSON.parse(localStorage.getItem(foldedKey)), foldedLocal, 'the legacy local source must remain untouched')
    assert.deepEqual(await loadAgentChatState(foldedKey), foldedDurable, 'the legacy durable source must remain untouched')

    store.setChatWorkspace({ id: secondRequestedId })
    await store.sendToAgent('')
    assert.deepEqual(store.chatSessions.value.flatMap((item) => item.messages.map((message) => message.text)), ['second exact record'])
    assert.equal(localStorage.getItem(`knote-agent-chat-migration-claim-v1:${encodeURIComponent(foldedKey)}`), targetKey)
  } finally {
    removeBrowserStorage()
  }
})

test('hydration covers expired attachment payloads with an explicit loss marker so compaction can advance', async () => {
  installBrowserStorage()
  try {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const workspaceId = `folder:attachment-history-${suffix}`
    const chatKey = `knote-agent-chat:${workspaceId}`
    const messages = Array.from({ length: 41 }, (_, index) => ({
      id: `history-${index + 1}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: index === 0 ? 'Review the historical upload.' : `history message ${index + 1}`,
      ...(index === 0 ? { attachments: [{ id: 'expired-attachment', kind: 'pdf', name: 'old-requirements.pdf' }] } : {})
    }))
    localStorage.setItem(chatKey, JSON.stringify({
      schemaVersion: 2,
      updatedAt: 100,
      activeId: 'attachment-session',
      sessions: [{
        id: 'attachment-session',
        title: '',
        messages,
        plan: [],
        activity: [],
        queue: [],
        events: [],
        eventWatermark: 0,
        summary: null
      }]
    }))

    const store = await import(`../src/lib/agentStore.js?attachment-hydration=${suffix}`)
    store.setChatWorkspace({ id: workspaceId })
    await store.sendToAgent('')
    const hydrated = store.chatMessages.value
    assert.equal(hydrated[0].attachmentMemory?.covered, true)
    assert.equal(hydrated[0].attachmentMemory?.unavailable, true)
    assert.match(hydrated[0].attachmentMemory.text, /contents unavailable/i)
    assert.match(hydrated[0].attachmentMemory.text, /reattach/i)
    assert.equal(shouldCompactAgentContext(hydrated, null, { contextWindow: 128_000 }), true)

    const range = selectAgentCompactionRange(hydrated, null, { keepRecent: 6, minMessages: 4 })
    assert.ok(range)
    assert.ok(range.throughIndex > 1, 'the expired attachment must not remain a permanent boundary')
    const memory = buildAgentMemorySource(range.sourceMessages)
    assert.match(memory, /Attachment contents unavailable/)
    assert.match(memory, /no attachment facts were summarized/)

    const durable = await loadAgentChatState(chatKey)
    assert.equal(durable.sessions[0].messages[0].attachmentMemory.unavailable, true)
  } finally {
    removeBrowserStorage()
  }
})
