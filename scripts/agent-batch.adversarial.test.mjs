import test from 'node:test'
import assert from 'node:assert/strict'

import {
  estimateAgentTokens,
  isSupportedBatchSource,
  validateBatchWorkerInput,
  validateBatchWorkerResponse
} from '../src/lib/agentBatch.js'

test('batch input budgeting rejects oversized CJK before provider execution', () => {
  assert.throws(
    () => validateBatchWorkerInput({ system: 'system', user: '文'.repeat(9000), ctxWindow: 8192 }),
    (error) => error?.code === 'CONTEXT_LIMIT' && /未调用模型/.test(error.message)
  )
  const accepted = validateBatchWorkerInput({ system: 'system', user: 'a'.repeat(8000), ctxWindow: 8192 })
  assert.ok(accepted.inputTokens <= accepted.inputLimit)
  assert.equal(estimateAgentTokens('文'.repeat(100)), 100)
})

test('batch workers reject binary sources and incomplete model output', () => {
  assert.equal(isSupportedBatchSource('notes/readme.md'), true)
  assert.equal(isSupportedBatchSource('slides/deck.pptx'), true)
  assert.equal(isSupportedBatchSource('papers/scan.pdf'), false)
  assert.equal(isSupportedBatchSource('images/page.png'), false)
  assert.throws(
    () => validateBatchWorkerResponse({ text: '# partial', truncated: true }),
    (error) => error?.code === 'OUTPUT_TRUNCATED'
  )
  assert.throws(
    () => validateBatchWorkerResponse({ text: 'refused', refusal: true }),
    (error) => error?.code === 'MODEL_REFUSED'
  )
  assert.equal(validateBatchWorkerResponse({ text: '# complete' }), '# complete')
})
