import test from 'node:test'
import assert from 'node:assert/strict'

import {
  latestAgentEventOrder,
  terminalMessageRecoveryCandidates,
  uncertainSteerRecoveryCandidates
} from '../src/lib/agentRecovery.js'

const event = (id, type, order, payload = {}) => ({ id, type, order, at: order, payload })

test('terminal recovery ignores replies intentionally outside the retained message window', () => {
  const messages = [
    { id: 'recent-prompt', role: 'user', text: 'recent' }
  ]
  const events = [
    event('old-start', 'run.started', 10, { runId: 'old', promptId: 'old-prompt' }),
    event('old-final', 'run.completed', 11, { runId: 'old', promptId: 'old-prompt', messageId: 'old-reply', text: 'old reply' }),
    event('recent-start', 'run.started', 20, { runId: 'recent', promptId: 'recent-prompt' }),
    event('recent-final', 'run.completed', 21, { runId: 'recent', promptId: 'recent-prompt', messageId: 'recent-reply', text: 'recent reply' })
  ]
  assert.equal(latestAgentEventOrder(events.slice(0, 3)), 20)
  assert.deepEqual(
    terminalMessageRecoveryCandidates({ messages, events, persistedEventOrder: 20 }).map((item) => item.id),
    ['recent-final']
  )
})

test('a committed steer on an unfinished run is recovered once as uncertain work', () => {
  const messages = [{ id: 'steer-1', role: 'user', text: 'also update the title' }]
  const events = [
    event('admit', 'prompt.admitted', 1, { promptId: 'steer-1', context: { workspaceId: 'A' } }),
    event('start', 'run.started', 2, { runId: 'run-1', promptId: 'prompt-1' }),
    event('steered', 'prompt.steered', 3, { runId: 'run-1', promptId: 'steer-1' })
  ]
  const candidates = uncertainSteerRecoveryCandidates({ messages, queue: [], events })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].message.text, 'also update the title')
  assert.equal(candidates[0].admission.payload.context.workspaceId, 'A')

  events.push(event('settled', 'prompt.recovery_blocked', 4, { promptId: 'steer-1', runId: 'run-1' }))
  assert.equal(uncertainSteerRecoveryCandidates({ messages, queue: [], events }).length, 0)
})

test('a steer from a terminal run is never requeued', () => {
  const messages = [{ id: 'steer-1', role: 'user', text: 'done already' }]
  const events = [
    event('start', 'run.started', 1, { runId: 'run-1', promptId: 'prompt-1' }),
    event('steered', 'prompt.steered', 2, { runId: 'run-1', promptId: 'steer-1' }),
    event('complete', 'run.completed', 3, { runId: 'run-1', promptId: 'prompt-1', messageId: 'reply', text: 'done' })
  ]
  assert.equal(uncertainSteerRecoveryCandidates({ messages, queue: [], events }).length, 0)
})

test('a missing terminal message recovers even below an unrelated newer event watermark', () => {
  const messages = [{ id: 'retained-prompt', role: 'user', text: 'retain this prompt' }]
  const events = [
    event('start', 'run.started', 10, { runId: 'run-retained', promptId: 'retained-prompt' }),
    event('terminal', 'run.completed', 11, {
      runId: 'run-retained',
      promptId: 'retained-prompt',
      messageId: 'missing-reply',
      text: 'recover this terminal reply'
    }),
    event('unrelated-newer', 'prompt.admitted', 99, { promptId: 'other-prompt' })
  ]
  assert.deepEqual(
    terminalMessageRecoveryCandidates({ messages, events, persistedEventOrder: 99 }).map((item) => item.id),
    ['terminal']
  )
  messages.push({ id: 'missing-reply', role: 'assistant', text: 'already present' })
  assert.equal(terminalMessageRecoveryCandidates({ messages, events, persistedEventOrder: 99 }).length, 0)
})
