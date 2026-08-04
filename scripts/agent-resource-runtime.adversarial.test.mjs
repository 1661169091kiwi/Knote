import test from 'node:test'
import assert from 'node:assert/strict'

class MemoryStorage {
  constructor() { this.values = new Map() }
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null }
  setItem(key, value) { this.values.set(String(key), String(value)) }
  removeItem(key) { this.values.delete(String(key)) }
  clear() { this.values.clear() }
}

const storedChat = (id, text) => JSON.stringify({
  activeId: id,
  sessions: [{ id, title: '', messages: [{ role: 'user', text }], plan: [], activity: [] }]
})

test('runtime attachment lookup cannot cross conversation or workspace scope', async () => {
  globalThis.localStorage = new MemoryStorage()
  globalThis.window = {}
  try {
    const store = await import(`../src/lib/agentStore.js?resource-runtime=${Date.now()}`)
    const firstSession = store.activeSessionId.value
    const first = store.addAttachment({ kind: 'image', name: 'first.png', dataUrl: 'data:image/png;base64,AA==' })
    const abandoned = store.addAttachment({ kind: 'md', name: 'abandoned.md', text: 'draft only' })
    assert.equal(store.getActiveAttachment(first.id)?.name, 'first.png')
    assert.equal(store.getActiveAttachment(abandoned.id)?.name, 'abandoned.md')

    store.chatMessages.value.push({ role: 'user', text: 'seed first conversation' })
    store.newSession()
    const secondSession = store.activeSessionId.value
    assert.notEqual(secondSession, firstSession)
    assert.equal(store.getActiveAttachment(first.id), null)
    assert.equal(store.removeAttachment(abandoned), true, 'a stale draft must be removable after the UI changes scope')
    assert.equal(store.removeAttachment(abandoned), false, 'discarding the same draft twice must be harmless')
    const second = store.addAttachment({ kind: 'image', name: 'second.png', dataUrl: 'data:image/png;base64,AQ==' })
    assert.equal(store.getActiveAttachment(second.id)?.name, 'second.png')

    store.switchSession(firstSession)
    assert.equal(store.getActiveAttachment(first.id)?.name, 'first.png')
    assert.equal(store.getActiveAttachment(abandoned.id), null)
    assert.equal(store.getActiveAttachment(second.id), null)

    store.setChatWorkspace({ id: 'folder:B' })
    assert.equal(store.getActiveAttachment(first.id), null)
    assert.equal(store.getActiveAttachment(second.id), null)

    store.setChatWorkspace({ id: '' })
    assert.equal(store.activeSessionId.value, firstSession)
    assert.equal(store.getActiveAttachment(first.id)?.name, 'first.png')
    assert.equal(store.getActiveAttachment(second.id), null)
    assert.equal(Object.keys(store.attachmentPool).length, 2, 'scoped resources may coexist without overwriting')
  } finally {
    delete globalThis.window
    delete globalThis.localStorage
  }
})

test('Windows path aliases converge while one legacy name store can be claimed only once', async () => {
  const storage = new MemoryStorage()
  globalThis.localStorage = storage
  globalThis.window = {}
  try {
    const rawPathKey = 'knote-agent-chat:folder:C:\\Users\\Writer\\Notes'
    const canonicalKey = 'knote-agent-chat:folder:c:/users/writer/notes'
    const legacyKey = 'knote-agent-chat:folder:Notes'
    storage.setItem(rawPathKey, storedChat('path-session', 'newer path history'))
    storage.setItem(legacyKey, storedChat('legacy-session', 'legacy name history'))
    const originalLegacy = storage.getItem(legacyKey)

    const store = await import(`../src/lib/agentStore.js?workspace-runtime=${Date.now()}`)
    store.setChatWorkspace({
      id: 'folder:c:/USERS/writer/notes/',
      legacyIds: ['folder:Notes']
    })
    assert.equal(store.activeChatKey.value, canonicalKey)
    assert.deepEqual(
      store.chatSessions.value.map((session) => session.messages[0]?.text).sort(),
      ['legacy name history', 'newer path history']
    )
    assert.equal(storage.getItem(legacyKey), originalLegacy, 'legacy recovery data must remain byte-for-byte unchanged')
    const claimKey = `knote-agent-chat-migration-claim-v1:${encodeURIComponent(legacyKey)}`
    assert.equal(storage.getItem(claimKey), canonicalKey)

    store.setChatWorkspace({ id: 'folder:D:\\Other\\Notes', legacyIds: ['folder:Notes'] })
    assert.equal(store.activeChatKey.value, 'knote-agent-chat:folder:d:/other/notes')
    assert.equal(store.chatMessages.value.length, 0, 'a second same-named folder must not inherit the claimed history')

    store.setChatWorkspace({ id: 'folder:C:\\USERS\\WRITER\\NOTES\\', legacyIds: ['folder:Notes'] })
    assert.equal(store.activeChatKey.value, canonicalKey)
    assert.deepEqual(
      store.chatSessions.value.map((session) => session.messages[0]?.text).sort(),
      ['legacy name history', 'newer path history']
    )
    assert.equal(storage.getItem(rawPathKey), storedChat('path-session', 'newer path history'), 'path alias recovery data must remain untouched')
  } finally {
    delete globalThis.window
    delete globalThis.localStorage
  }
})
