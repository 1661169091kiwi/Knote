import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createAgentDraftKey, createAgentSurfaceKey, isAgentSurfaceKey } from '../src/lib/agentSurface.js'
import { classifyAgentCapabilities } from '../src/lib/agentCapabilitySummary.js'
import { createAppDialogQueue } from '../src/lib/appDialogQueue.js'

const read = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
const between = (source, start, end) => {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0 && to > from, `missing source boundary: ${start} -> ${end}`)
  return source.slice(from, to)
}

test('surface and draft keys preserve every identity boundary without collisions', () => {
  const first = createAgentSurfaceKey({ workspaceId: 'a|b', documentId: 'c', tabId: 'd' })
  const second = createAgentSurfaceKey({ workspaceId: 'a', documentId: 'b|c', tabId: 'd' })
  const duplicateTab = createAgentSurfaceKey({ workspaceId: 'a|b', documentId: 'c', tabId: 'e' })

  assert.notEqual(first, second)
  assert.notEqual(first, duplicateTab)
  assert.equal(first, createAgentSurfaceKey({ workspaceId: 'a|b', documentId: 'c', tabId: 'd' }))
  assert.equal(isAgentSurfaceKey(first), true)
  assert.equal(isAgentSurfaceKey(JSON.stringify(['knote-agent-surface-v1', 'a', 'b'])), false)
  assert.equal(isAgentSurfaceKey(JSON.stringify(['knote-agent-surface-v1', 'a', {}, 'd'])), false)
  assert.notEqual(createAgentDraftKey(first, 'session-a'), createAgentDraftKey(first, 'session-b'))
  assert.notEqual(createAgentDraftKey(first, 'session-a'), createAgentDraftKey(duplicateTab, 'session-a'))
})

test('capability results have deterministic success, partial, and failure classes', () => {
  assert.equal(classifyAgentCapabilities({ chat: true, tools: true, vision: true, pdf: true }), 'success')
  assert.equal(classifyAgentCapabilities({ chat: true, tools: true, vision: false, pdf: false }), 'partial')
  assert.equal(classifyAgentCapabilities({ chat: true, tools: true, vision: true, pdf: true, error: 'late probe error' }), 'partial')
  assert.equal(classifyAgentCapabilities({ chat: false, tools: true, vision: true, pdf: true }), 'failure')
})

test('the shared dialog queue publishes alert copy and tone without adding browser globals', async () => {
  const activations = []
  const queue = createAppDialogQueue({ onActivate: (request) => activations.push(request) })
  const result = queue.request({
    mode: 'alert',
    owner: 'capability-check',
    tone: 'partial',
    title: 'Some capabilities are available',
    message: 'Available: Chat\nUnavailable: PDF'
  })

  assert.deepEqual(queue.current(), {
    id: 'app-dialog-1',
    owner: 'capability-check',
    mode: 'alert',
    title: 'Some capabilities are available',
    message: 'Available: Chat\nUnavailable: PDF',
    tone: 'partial',
    value: ''
  })
  assert.equal(queue.settle(queue.current().id, true), true)
  assert.equal(await result, true)
  assert.equal(activations.at(-1), null)
})

test('surface projection, durable answers, and app alerts remain wired at their ownership boundaries', () => {
  const store = read('src/lib/agentStore.js')
  const app = read('src/App.vue')
  const panel = read('src/components/AgentPanel.vue')
  const answer = between(store, 'export const answerAgentQuestion', 'export const dismissAgentQuestion')
  const workspaceSwitch = between(store, 'export const setChatWorkspace', 'export const persistConfig')

  assert.ok(answer.indexOf('await persistRunSessionDurably(context)') < answer.indexOf('settleAgentQuestion(context'))
  assert.match(answer, /context\.surfaceKey !== activeAgentSurfaceKey\.value/)
  assert.match(store, /surfaceKey:\s*context\.surfaceKey,[\s\S]*programGenerated:\s*true,[\s\S]*questionAnswer:/)
  assert.match(workspaceSwitch, /agentProjectionSuspended = true[\s\S]*activeAgentSurfaceKey\.value = nextSurfaceKey[\s\S]*loadChat\(\)/)
  assert.match(app, /surface:\s*\{[\s\S]*workspaceId:[\s\S]*documentId:[\s\S]*tabId:/)
  assert.match(app, /mode:\s*'alert'[\s\S]*tone,[\s\S]*message/)
  assert.match(app, /<Teleport to="body">[\s\S]*data-dialog-mode[\s\S]*promptState\.mode === 'prompt'/)
  assert.match(panel, /data-control-position="left"[\s\S]*data-control-position="center"[\s\S]*data-control-position="right"/)
  assert.match(panel, /await answerAgentQuestion\(question\.id, text\)/)
})
