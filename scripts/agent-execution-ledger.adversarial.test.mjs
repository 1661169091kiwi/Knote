import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildMutationRetryFeedback,
  buildRunReceipt,
  buildUserFailureReport,
  createExecutionLedger,
  guardFinalReport,
  normalizeToolResult,
  recordToolExecution,
  requireVerifiedMutation,
  runOutcome,
  serializeToolResult,
  toolFailure,
  toolSuccess
} from '../src/lib/agentExecutionLedger.js'

const verifiedEdit = (target = 'document:doc-a', hunkId = 'h-1') => toolSuccess({
  code: 'HUNK_STAGED',
  message: '已登记并验证待审核改动',
  mutation: { type: 'pending_hunk', target, hunkIds: [hunkId], verified: true },
  verification: { ok: true, registered: true, sameDocument: true }
})

test('blocks a completion claim when every mutation call failed', () => {
  const ledger = createExecutionLedger({ instruction: '请修改当前文档', documentId: 'doc-a' })
  recordToolExecution(ledger, {
    callId: '1', name: 'replace_lines', input: { start_line: 2 },
    result: toolFailure({ code: 'DOCUMENT_STALE', retryable: true, message: '文档已变化' })
  })
  const guarded = guardFinalReport('已经修改好了，修改现在已经显示。', ledger)
  assert.equal(guarded.blocked, true)
  assert.doesNotMatch(guarded.text, /后置验证|完成声明|系统撤回/)
  assert.match(guarded.text, /没能实际写入|文档已变化/)
  const retryFeedback = buildMutationRetryFeedback(ledger)
  assert.match(retryFeedback, /调用合适的读取\/修改工具补做/)
  assert.match(retryFeedback, /文档已变化/)
  assert.doesNotMatch(buildUserFailureReport(ledger), /Knote 内部执行校验/)
  assert.equal(buildRunReceipt(ledger, { claimBlocked: true }).status, 'blocked')
})

test('a verified retry resolves an earlier retryable failure on the same target', () => {
  const ledger = createExecutionLedger({ instruction: '润色文档', documentId: 'doc-a' })
  recordToolExecution(ledger, {
    callId: '1', name: 'replace_lines', input: { start_line: 99 },
    result: toolFailure({ code: 'RANGE_INVALID', retryable: true, message: '行号无效' })
  })
  recordToolExecution(ledger, {
    callId: '2', name: 'replace_lines', input: { start_line: 2 }, result: verifiedEdit()
  })
  const outcome = runOutcome(ledger)
  assert.equal(outcome.status, 'success')
  assert.equal(outcome.failures.length, 0)
  assert.equal(outcome.stagedIds.length, 1)
  assert.equal(ledger.entries[0].resolvedBy, 2)
  assert.equal(guardFinalReport('已提交修改，请审核。', ledger).blocked, false)
  const receipt = buildRunReceipt(ledger)
  assert.deepEqual(receipt.hunkIds, ['h-1'])
  assert.deepEqual(receipt.acceptedHunkIds, [])
  assert.deepEqual(receipt.rejectedHunkIds, [])
})

test('calling a mutating tool is not itself evidence of success', () => {
  const ledger = createExecutionLedger({ instruction: '修改文档', documentId: 'doc-a' })
  recordToolExecution(ledger, {
    callId: '1', name: 'insert_lines', input: { after_line: 0 },
    result: toolFailure({ code: 'EDIT_CONFLICT', message: '与已有改动重叠' })
  })
  assert.equal(runOutcome(ledger).successes.length, 0)
})

test('rejects a mutating success result without a verified post-condition receipt', () => {
  const raw = normalizeToolResult('replace_lines', { text: '已暂存修改。' })
  const strict = requireVerifiedMutation('replace_lines', raw)
  assert.equal(strict.ok, false)
  assert.equal(strict.code, 'POSTCONDITION_MISSING')
})

test('normalizes legacy unavailability text into an explicit failure', () => {
  const result = normalizeToolResult('list_files', { text: '当前没有打开文件夹工作区。' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UNAVAILABLE')
})

test('reports partial completion when another target still has an unresolved failure', () => {
  const ledger = createExecutionLedger({ instruction: '更新两个文件', documentId: 'doc-a' })
  recordToolExecution(ledger, {
    callId: '1', name: 'edit_file', input: { path: 'a.md' },
    result: toolSuccess({
      code: 'FILE_EDITED', message: 'a.md 已验证',
      mutation: { type: 'file_edited', target: 'path:a.md', path: 'a.md', verified: true }
    })
  })
  recordToolExecution(ledger, {
    callId: '2', name: 'edit_file', input: { path: 'b.md' },
    result: toolFailure({ code: 'WRITE_FAILED', message: 'b.md 写入失败' })
  })
  const outcome = runOutcome(ledger)
  assert.equal(outcome.status, 'partial')
  assert.equal(outcome.successes.length, 1)
  assert.equal(outcome.failures.length, 1)
})

test('blocks a broad completion claim when only part of a multi-target task succeeded', () => {
  const ledger = createExecutionLedger({ instruction: '更新两个文件', documentId: 'doc-a' })
  recordToolExecution(ledger, {
    callId: '1', name: 'edit_file', input: { path: 'a.md' },
    result: toolSuccess({
      code: 'FILE_EDITED', message: 'a.md 已验证',
      mutation: { type: 'file_edited', target: 'path:a.md', path: 'a.md', verified: true }
    })
  })
  recordToolExecution(ledger, {
    callId: '2', name: 'edit_file', input: { path: 'b.md' },
    result: toolFailure({ code: 'WRITE_FAILED', message: 'b.md 写入失败' })
  })
  const broad = guardFinalReport('两个文件都已经修改完成。', ledger)
  assert.equal(broad.blocked, true)
  assert.equal(broad.reason, 'unresolved_partial_failure')
  assert.match(broad.text, /只完成了一部分|b\.md 写入失败/)

  const honest = guardFinalReport('a.md 已修改成功，但 b.md 写入失败，本轮未完成。', ledger)
  assert.equal(honest.blocked, false)
  assert.equal(guardFinalReport('处理完成：成功 1，失败 1（b.md）。', ledger).blocked, false)
  assert.equal(guardFinalReport('都处理好了，没有失败。', ledger).blocked, true)
})

test('a batch partial result remains an unresolved partial outcome', () => {
  const ledger = createExecutionLedger({ instruction: '批量总结三个文件', documentId: 'doc-a' })
  recordToolExecution(ledger, {
    callId: '1',
    name: 'batch_process',
    input: { files: ['a.md', 'b.md', 'c.md'] },
    result: toolSuccess({
      code: 'BATCH_PARTIAL',
      message: '成功 2，失败 1：c.md 读不到',
      mutation: { type: 'batch_files_created', target: 'workspace:test', paths: ['a-摘要.md', 'b-摘要.md'], verified: true },
      verification: { ok: true, written: 2, failed: 1 }
    })
  })
  const outcome = runOutcome(ledger)
  assert.equal(outcome.status, 'partial')
  assert.equal(outcome.successes.length, 1)
  assert.equal(outcome.failures.length, 1)
  assert.equal(guardFinalReport('批量处理已经全部完成。', ledger).blocked, true)
})

test('does not rewrite an honest failure report', () => {
  const ledger = createExecutionLedger({ instruction: '请修改文档', documentId: 'doc-a' })
  recordToolExecution(ledger, {
    callId: '1', name: 'replace_lines', input: {},
    result: toolFailure({ code: 'DOCUMENT_STALE', message: '修改失败：文档已变化' })
  })
  const text = '修改失败，文档内容已变化，本轮没有完成。'
  const guarded = guardFinalReport(text, ledger)
  assert.equal(guarded.blocked, false)
  assert.equal(guarded.text, text)
})

test('blocks unsupported English completion claims', () => {
  const ledger = createExecutionLedger({ instruction: 'Please edit the current document', documentId: 'doc-a' })
  const guarded = guardFinalReport('I have successfully updated the document.', ledger)
  assert.equal(guarded.blocked, true)
  assert.match(guarded.text, /couldn't apply/i)
})

test('treats a short in-editor command as mutation intent', () => {
  const ledger = createExecutionLedger({ instruction: '润色一下', documentId: 'doc-a' })
  const guarded = guardFinalReport('已经润色完成。', ledger)
  assert.equal(guarded.blocked, true)
})

test('does not block ordinary writing help that does not request a file mutation', () => {
  const ledger = createExecutionLedger({ instruction: '帮我写一段推荐文案', documentId: 'doc-a' })
  const guarded = guardFinalReport('已经为你写好一版推荐文案：欢迎使用 Knote。', ledger)
  assert.equal(guarded.blocked, false)
})

test('serialized provider result carries machine-readable failure evidence', () => {
  const serialized = serializeToolResult(toolFailure({ code: 'WRITE_FAILED', retryable: true, message: '写盘失败' }))
  const parsed = JSON.parse(serialized)
  assert.deepEqual({ ok: parsed.ok, code: parsed.code, retryable: parsed.retryable }, {
    ok: false, code: 'WRITE_FAILED', retryable: true
  })
})

test('normalizes legacy search, reader, layout and conversion failures as failures', () => {
  const samples = [
    ['web_search', '搜索失败：网络超时。', 'TRANSIENT_FAILURE', true],
    ['web_fetch', '读取被拒绝：该网址指向本机或内网地址。', 'ACCESS_BLOCKED', false],
    ['pdf_prepare', '版面分析不可用（需桌面版）。', 'UNAVAILABLE', false],
    ['read_workspace_pdf', 'PDF《a.pdf》已加载（共 2 页），但转换失败：decode error', 'TRANSIENT_FAILURE', true],
    ['calc', '计算结果无效（Infinity）。', 'INVALID_RESULT', false]
  ]
  for (const [name, text, code, retryable] of samples) {
    const result = normalizeToolResult(name, { text })
    assert.equal(result.ok, false, `${name} should fail`)
    assert.equal(result.code, code)
    assert.equal(result.retryable, retryable)
  }
})

test('structured tool results retain model-visible image payloads through normalization', () => {
  const result = normalizeToolResult('pdf_prepare', {
    ...toolSuccess({ code: 'PDF_PREPARED', message: 'ok' }),
    imageDataUrl: 'data:image/png;base64,AAAA',
    imageDataUrls: ['data:image/png;base64,BBBB']
  })
  assert.equal(result.imageDataUrl, 'data:image/png;base64,AAAA')
  assert.deepEqual(result.imageDataUrls, ['data:image/png;base64,BBBB'])
})
