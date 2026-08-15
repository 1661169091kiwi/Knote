import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EVIDENCE_TOOLS,
  GROUNDING_TOOLS,
  MUTATION_TOOLS,
  PRODUCTIVE_MUTATION_TOOLS,
  buildGroundingFailureReport,
  buildGroundingWarning,
  buildGroundingRetryFeedback,
  buildMutationRetryFeedback,
  buildRunReceipt,
  buildSourceRecoveryConstraint,
  buildUserFailureReport,
  createExecutionLedger,
  guardFinalReport,
  groundingOutcome,
  normalizeToolResult,
  prepareGroundingAttempt,
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
  assert.equal(honest.blocked, true)
  assert.equal(honest.reason, 'unresolved_partial_failure')
  assert.equal(guardFinalReport('处理完成：成功 1，失败 1（b.md）。', ledger).blocked, true)
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
      data: {
        completed: [{ path: 'a.md', output_path: 'a-摘要.md' }, { path: 'b.md', output_path: 'b-摘要.md' }],
        failed: [{ path: 'c.md', error: '读不到' }],
        aborted: []
      },
      mutation: {
        type: 'batch_files_created',
        target: 'workspace:test',
        paths: ['a-摘要.md', 'b-摘要.md'],
        sourcePaths: ['a.md', 'b.md'],
        verified: true
      },
      verification: { ok: true, written: 2, failed: 1, aborted: 0 }
    })
  })
  const outcome = runOutcome(ledger)
  assert.equal(outcome.status, 'partial')
  assert.equal(outcome.successes.length, 1)
  assert.equal(outcome.failures.length, 1)
  assert.deepEqual(ledger.entries[0].batchUnresolvedPaths, ['c.md'])
  assert.equal(guardFinalReport('批量处理已经全部完成。', ledger).blocked, true)
})

test('batch retries repair only the failed source children they actually complete', () => {
  const ledger = createExecutionLedger({ instruction: '批量总结三个文件' })
  recordToolExecution(ledger, {
    callId: 'partial',
    name: 'batch_process',
    input: { files: ['a.md', 'b.md', 'c.md'], task: '生成摘要', output_suffix: '-摘要' },
    result: toolSuccess({
      code: 'BATCH_PARTIAL',
      message: 'a 完成，b 失败，c 中止',
      data: {
        completed: [{ path: 'a.md', output_path: 'a-摘要.md' }],
        failed: [{ path: 'b.md', error: 'write failed' }],
        aborted: [{ path: 'c.md', error: 'aborted' }]
      },
      mutation: { type: 'batch_files_created', target: 'workspace:test', paths: ['a-摘要.md'], sourcePaths: ['a.md'], verified: true },
      verification: { ok: true, written: 1, failed: 1, aborted: 1 }
    })
  })
  recordToolExecution(ledger, {
    callId: 'repair-b',
    name: 'batch_process',
    input: { files: ['b.md'], task: '生成摘要', output_suffix: '-摘要' },
    result: toolSuccess({
      code: 'BATCH_COMPLETED',
      message: 'b 完成',
      data: { completed: [{ path: 'b.md', output_path: 'b-摘要.md' }], failed: [], aborted: [] },
      mutation: { type: 'batch_files_created', target: 'workspace:test', paths: ['b-摘要.md'], sourcePaths: ['b.md'], verified: true },
      verification: { ok: true, written: 1, failed: 0, aborted: 0 }
    })
  })
  assert.deepEqual(ledger.entries[0].batchUnresolvedPaths, ['c.md'])
  assert.equal(ledger.entries[0].resolvedBy, null)
  assert.equal(runOutcome(ledger).status, 'partial')

  recordToolExecution(ledger, {
    callId: 'unrelated-create',
    name: 'create_file',
    input: { path: 'c-摘要.md', content: 'not a batch repair' },
    result: toolSuccess({
      code: 'FILE_CREATED',
      message: 'created',
      mutation: { type: 'file_created', target: 'path:c-摘要.md', path: 'c-摘要.md', verified: true }
    })
  })
  assert.deepEqual(ledger.entries[0].batchUnresolvedPaths, ['c.md'])

  recordToolExecution(ledger, {
    callId: 'repair-c',
    name: 'batch_process',
    input: { files: ['c.md'], task: '生成摘要', output_suffix: '-摘要' },
    result: toolSuccess({
      code: 'BATCH_COMPLETED',
      message: 'c 完成',
      data: { completed: [{ path: 'c.md', output_path: 'c-摘要-2.md' }], failed: [], aborted: [] },
      mutation: { type: 'batch_files_created', target: 'workspace:test', paths: ['c-摘要-2.md'], sourcePaths: ['c.md'], verified: true },
      verification: { ok: true, written: 1, failed: 0, aborted: 0 }
    })
  })
  assert.deepEqual(ledger.entries[0].batchUnresolvedPaths, [])
  assert.equal(ledger.entries[0].resolvedBy, 4)
  assert.equal(runOutcome(ledger).status, 'success')
  assert.equal(guardFinalReport('三个文件都已处理完成。', ledger).blocked, false)
})

test('mutation failures resolve only through the same tool and target', () => {
  const ledger = createExecutionLedger({ instruction: '下载报告文件' })
  recordToolExecution(ledger, {
    callId: 'download-failed',
    name: 'download_file',
    input: { url: 'https://example.test/report.pdf', path: 'report.pdf' },
    result: toolFailure({ code: 'DOWNLOAD_TIMEOUT', retryable: true, message: 'download timed out' })
  })
  recordToolExecution(ledger, {
    callId: 'create-same-path',
    name: 'create_file',
    input: { path: 'report.pdf', content: 'unrelated' },
    result: toolSuccess({
      code: 'FILE_CREATED',
      message: 'created at the same path',
      mutation: { type: 'file_created', target: 'path:report.pdf', path: 'report.pdf', verified: true }
    })
  })
  assert.equal(ledger.entries[0].resolvedBy, null)
  assert.equal(runOutcome(ledger).status, 'partial')
})

test('download instructions require a verified download receipt rather than an unrelated mutation', () => {
  const ledger = createExecutionLedger({ instruction: 'Please download the report file' })
  recordToolExecution(ledger, {
    callId: 'unrelated',
    name: 'create_file',
    input: { path: 'notes.md', content: 'x' },
    result: toolSuccess({
      code: 'FILE_CREATED',
      message: 'created notes',
      mutation: { type: 'file_created', target: 'path:notes.md', path: 'notes.md', verified: true }
    })
  })
  const guarded = guardFinalReport('The task is complete.', ledger)
  assert.equal(guarded.blocked, true)
  assert.equal(guarded.reason, 'missing_verified_download')
  assert.equal(guardFinalReport('Saved the report file.', ledger).reason, 'missing_verified_download')

  const advice = createExecutionLedger({ instruction: 'How do I download a report file?' })
  assert.equal(guardFinalReport('Use the browser download button and choose a destination.', advice).blocked, false)

  const localSave = createExecutionLedger({ instruction: 'Please save the report file in the workspace' })
  recordToolExecution(localSave, {
    callId: 'local-report',
    name: 'create_file',
    input: { path: 'report.md', content: 'report' },
    result: toolSuccess({
      code: 'FILE_CREATED',
      message: 'created report',
      mutation: { type: 'file_created', target: 'path:report.md', path: 'report.md', verified: true }
    })
  })
  assert.equal(guardFinalReport('I successfully created the report file.', localSave).blocked, false)

  const remoteSave = createExecutionLedger({ instruction: 'Please save https://example.test/report.pdf' })
  assert.equal(guardFinalReport('Saved the report from the URL.', remoteSave).reason, 'missing_verified_download')
})

test('failed mutation attempts replace even honest or plausible model prose', () => {
  const ledger = createExecutionLedger({ instruction: '请修改文档', documentId: 'doc-a' })
  recordToolExecution(ledger, {
    callId: '1', name: 'replace_lines', input: {},
    result: toolFailure({ code: 'DOCUMENT_STALE', message: '修改失败：文档已变化' })
  })
  const text = '修改失败，文档内容已变化，本轮没有完成。'
  const guarded = guardFinalReport(text, ledger)
  assert.equal(guarded.blocked, true)
  assert.equal(guarded.reason, 'mutation_failed')
  assert.notEqual(guarded.text, text)
  assert.match(guarded.text, /文档已变化/)
  assert.equal(guardFinalReport('文档看起来没有变化，你可以稍后再试。', ledger).blocked, true)
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

test('artifactized provider results expose only preview text and compact resumable metadata', () => {
  const secret = `FULL_SECRET_${'x'.repeat(6000)}`
  const toolOutput = {
    artifact_id: 'opaque-artifact-id',
    content_type: 'text/plain; charset=utf-8',
    encoding: 'utf-8',
    total_bytes: 70000,
    total_lines: 9,
    sha256: 'a'.repeat(64),
    capture_complete: true,
    expires_at: 123456789,
    preview: {
      truncated: true,
      head_byte_offset: 0,
      head_bytes: 24576,
      omitted_byte_offset: 24576,
      omitted_bytes: 20848,
      tail_byte_offset: 45424,
      tail_bytes: 24576
    }
  }
  const serialized = serializeToolResult(toolSuccess({
    code: 'COMMAND_SUCCEEDED',
    message: 'preview head\n... bytes omitted ...\npreview tail',
    data: { stdout: secret, stderr: secret, exitCode: 0, nested: { output: secret } },
    recovery: { message: secret },
    toolOutput
  }))
  const parsed = JSON.parse(serialized)

  assert.equal(parsed.message, 'preview head\n... bytes omitted ...\npreview tail')
  assert.deepEqual(parsed.tool_output, toolOutput)
  assert.equal(serialized.includes('FULL_SECRET_'), false)
  assert.deepEqual(parsed.data.stdout, { artifactized: true, utf8_bytes: Buffer.byteLength(secret, 'utf8') })
  assert.deepEqual(parsed.data.stderr, { artifactized: true, utf8_bytes: Buffer.byteLength(secret, 'utf8') })
  assert.equal(parsed.data.exitCode, 0)
  assert.equal(parsed.recovery, null)
})

test('a capture warning preserves an already-verified success without claiming resumability', () => {
  const parsed = JSON.parse(serializeToolResult(toolSuccess({
    code: 'FILE_EDITED',
    message: 'complete original result',
    mutation: { type: 'file_edited', target: 'path:a.md', verified: true },
    captureWarning: {
      code: 'ARTIFACT_STORAGE_UNAVAILABLE',
      retryable: false,
      capture_complete: false,
      message: 'complete output was not captured'
    }
  })))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.code, 'FILE_EDITED')
  assert.equal(parsed.message, 'complete original result')
  assert.equal(parsed.mutation.verified, true)
  assert.equal(parsed.tool_output, undefined)
  assert.equal(parsed.capture_warning.capture_complete, false)
})

test('read_tool_output is read-only execution evidence', () => {
  assert.equal(MUTATION_TOOLS.has('read_tool_output'), false)
  assert.equal(PRODUCTIVE_MUTATION_TOOLS.has('read_tool_output'), false)
})

test('download_file is a productive verified file-write mutation', () => {
  assert.equal(MUTATION_TOOLS.has('download_file'), true)
  assert.equal(PRODUCTIVE_MUTATION_TOOLS.has('download_file'), true)

  const missingReceipt = requireVerifiedMutation('download_file', toolSuccess({
    code: 'FILE_DOWNLOADED',
    message: 'downloaded without evidence'
  }))
  assert.equal(missingReceipt.ok, false)
  assert.equal(missingReceipt.code, 'POSTCONDITION_MISSING')

  const unsupported = createExecutionLedger({ instruction: 'Download the report file' })
  assert.equal(guardFinalReport('I successfully downloaded the report.', unsupported).blocked, true)
  assert.equal(guardFinalReport('Downloaded the file.', unsupported).blocked, true)
  const unsupportedZh = createExecutionLedger({ instruction: '请下载报告文件' })
  assert.equal(guardFinalReport('报告文件下载成功。', unsupportedZh).blocked, true)

  const ledger = createExecutionLedger({ instruction: 'Download the report file' })
  const entry = recordToolExecution(ledger, {
    callId: 'download-1',
    name: 'download_file',
    input: { url: 'https://files.example/report.pdf', path: 'downloads/report.pdf' },
    result: toolSuccess({
      code: 'FILE_DOWNLOADED',
      message: 'download verified',
      mutation: {
        type: 'file_downloaded',
        target: 'path:downloads/report.pdf',
        path: 'downloads/report.pdf',
        verified: true
      },
      verification: { ok: true, source: 'main_process_exclusive_write_hash' }
    })
  })
  assert.equal(entry.family, 'file-write')
  assert.equal(runOutcome(ledger).status, 'success')
  assert.equal(guardFinalReport('I successfully downloaded the report.', ledger).blocked, false)
})

test('normalizes legacy search, reader, layout and conversion failures as failures', () => {
  const samples = [
    ['web_search', '搜索失败：网络超时。', 'TRANSIENT_FAILURE', true],
    ['web_fetch', '读取被拒绝：该网址指向本机或内网地址。', 'ACCESS_BLOCKED', false],
    ['pdf_prepare', '版面分析不可用（需桌面版）。', 'UNAVAILABLE', false],
    ['pdf_layout', '版面分析服务仅在桌面版可用。请改用 render_pdf_page。', 'TOOL_FAILED', false],
    ['read_workspace_pdf', 'PDF《a.pdf》已加载（共 2 页），但转换失败：decode error', 'TRANSIENT_FAILURE', true],
    ['calc', '计算结果无效（Infinity）。', 'INVALID_RESULT', false]
  ]
  for (const [name, text, code, retryable] of samples) {
    const result = normalizeToolResult(name, { text })
    assert.equal(result.ok, false, `${name} should fail`)
    assert.equal(result.code, code)
    assert.equal(result.retryable, retryable)
  }
  assert.equal(normalizeToolResult('read_file', { text: '「a.pdf」是 PDF 文件，请改用 read_workspace_pdf 读取。' }).ok, false)
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

test('one verified document success resolves only the latest matching failure', () => {
  const ledger = createExecutionLedger({ instruction: '修改两个独立区域', documentId: 'doc-a' })
  recordToolExecution(ledger, {
    callId: 'failure-1', name: 'replace_lines', input: { start_line: 2 },
    result: toolFailure({ code: 'RANGE_INVALID', retryable: true, message: '区域一行号无效' })
  })
  recordToolExecution(ledger, {
    callId: 'failure-2', name: 'replace_lines', input: { start_line: 20 },
    result: toolFailure({ code: 'RANGE_INVALID', retryable: true, message: '区域二行号无效' })
  })
  recordToolExecution(ledger, {
    callId: 'success-1', name: 'replace_lines', input: { start_line: 20 },
    result: verifiedEdit('document:doc-a', 'h-latest')
  })

  assert.equal(ledger.entries[0].resolvedBy, null)
  assert.equal(ledger.entries[1].resolvedBy, 3)
  assert.equal(runOutcome(ledger).status, 'partial')
  assert.equal(guardFinalReport('只修复了第二个区域，第一个区域仍失败。', ledger).blocked, true)
})

test('a fully non-retryable mutation failure is program-owned and not eligible for hard retry', () => {
  const ledger = createExecutionLedger({ instruction: '删除文件', documentId: 'doc-a' })
  recordToolExecution(ledger, {
    callId: 'declined', name: 'delete_file', input: { path: 'a.md' },
    result: toolFailure({ code: 'USER_DECLINED', retryable: false, message: '用户拒绝删除文件。' })
  })
  const guarded = guardFinalReport('用户拒绝了，所以没有删除。', ledger)
  assert.equal(guarded.blocked, true)
  assert.equal(guarded.retryable, false)
  assert.match(guarded.text, /用户拒绝/)
})

test('grounding tools retain partial work and expose unresolved source status', () => {
  assert.equal(EVIDENCE_TOOLS, GROUNDING_TOOLS)
  for (const name of [
    'read_document', 'read_file', 'list_files', 'find_in_files', 'get_outline',
    'web_search', 'web_fetch', 'read_workspace_pdf', 'read_workspace_image',
    'read_pdf_text', 'render_pdf_page', 'pdf_prepare', 'pdf_get_element',
    'pdf_crop_region', 'pdf_layout', 'read_tool_output'
  ]) assert.equal(GROUNDING_TOOLS.has(name), true, `${name} must be grounding evidence`)

  const ledger = createExecutionLedger({ instruction: 'Read missing.md and search the web for its release date' })
  recordToolExecution(ledger, {
    callId: 'read-failed', name: 'read_file', input: { path: 'missing.md' },
    result: toolFailure({ code: 'NOT_FOUND', retryable: true, message: 'missing.md was not found' })
  })
  recordToolExecution(ledger, {
    callId: 'search-failed', name: 'web_search', input: { query: 'missing release date' },
    result: toolFailure({ code: 'WEB_SEARCH_FAILED', retryable: true, message: 'network unavailable' })
  })
  const guarded = guardFinalReport('The verified release date is January 2, 2030.', ledger)
  assert.equal(guarded.blocked, false)
  assert.equal(guarded.reason, 'grounding_incomplete')
  assert.equal(guarded.retryable, false)
  assert.match(guarded.text, /January 2, 2030/)
  assert.match(guarded.text, /Source status/)
  assert.equal((guardFinalReport(guarded.text, ledger).text.match(/Source status/g) || []).length, 1)
  assert.doesNotMatch(buildGroundingFailureReport(ledger), /network unavailable|web_search|web_fetch/)
  assert.match(buildGroundingFailureReport(ledger), /temporarily unavailable/i)
  assert.match(buildGroundingRetryFeedback(ledger), /同一来源续读|exact source/i)

  assert.match(buildGroundingWarning(ledger), /2 requested sources/)
  const receipt = buildRunReceipt(ledger)
  assert.equal(receipt.grounding.status, 'failed')
  assert.equal(receipt.grounding.successful, 0)
  assert.equal(receipt.grounding.failed, 2)
  assert.equal(receipt.claimBlocked, false)
})

test('only a usable same-family same-target evidence retry resolves its failure', () => {
  const sameTarget = createExecutionLedger({ instruction: 'Read a.md' })
  recordToolExecution(sameTarget, {
    callId: 'a-fail', name: 'read_file', input: { path: 'a.md' },
    result: toolFailure({ code: 'TRANSIENT_FAILURE', retryable: true, message: 'temporary read failure' })
  })
  recordToolExecution(sameTarget, {
    callId: 'a-success', name: 'read_file', input: { path: 'a.md' },
    result: toolSuccess({ code: 'FILE_READ', message: 'FACT_FROM_A', data: { complete: true, coverage: 'complete' } })
  })
  assert.equal(sameTarget.entries[0].resolvedBy, 2)
  assert.equal(groundingOutcome(sameTarget).status, 'success')
  assert.equal(guardFinalReport('FACT_FROM_A', sameTarget).blocked, false)

  const unrelated = createExecutionLedger({ instruction: 'Read a.md' })
  recordToolExecution(unrelated, {
    callId: 'a-fail', name: 'read_file', input: { path: 'a.md' },
    result: toolFailure({ code: 'TRANSIENT_FAILURE', retryable: true, message: 'temporary read failure' })
  })
  recordToolExecution(unrelated, {
    callId: 'b-success', name: 'read_file', input: { path: 'b.md' },
    result: toolSuccess({ code: 'FILE_READ', message: 'FACT_FROM_B', data: { complete: true, coverage: 'complete' } })
  })
  assert.equal(unrelated.entries[0].resolvedBy, null)
  assert.equal(groundingOutcome(unrelated).status, 'partial')
  assert.equal(groundingOutcome(unrelated).failures.length, 1)
  assert.equal(guardFinalReport('FACT_FROM_B', unrelated).reason, 'grounding_incomplete')

  const incomplete = createExecutionLedger({ instruction: 'Read a clipped source' })
  recordToolExecution(incomplete, {
    callId: 'clipped', name: 'web_fetch', input: { url: 'https://example.test/large' },
    result: toolSuccess({
      code: 'WEB_FETCHED',
      message: 'partial body',
      data: { complete: false, coverage: 'none', clipped: true }
    })
  })
  assert.equal(groundingOutcome(incomplete).successes.length, 0)
  assert.equal(groundingOutcome(incomplete).failures.length, 0)
  assert.equal(groundingOutcome(incomplete).pending.length, 1)
  assert.equal(groundingOutcome(incomplete).status, 'incomplete')
  assert.equal(guardFinalReport('The source definitely says X.', incomplete).reason, 'grounding_incomplete')

  const textMarkedIncomplete = createExecutionLedger({ instruction: 'Read a long document' })
  recordToolExecution(textMarkedIncomplete, {
    callId: 'text-clipped', name: 'read_document', input: {},
    result: toolSuccess({ code: 'OK', message: 'Visible prefix only. The output was truncated.' })
  })
  assert.equal(groundingOutcome(textMarkedIncomplete).successes.length, 0)
})

test('source obligations allow bounded declared alternatives without weakening target locks', () => {
  const ledger = createExecutionLedger({ instruction: '核验发布信息' })
  const blocked = recordToolExecution(ledger, {
    callId: 'blocked',
    name: 'web_fetch',
    input: { url: 'http://127.0.0.1/private?first=1' },
    result: toolFailure({ code: 'ACCESS_BLOCKED', retryable: false, message: 'web_fetch blocked internal target' })
  })
  assert.equal(blocked.retryable, false)
  assert.equal(blocked.failure.recovery_scope, 'alternate_target')
  assert.equal(blocked.failure.target_locked, true)
  assert.equal(blocked.sourceRecovery.remaining.alternatives, 2)
  const retained = guardFinalReport('发布日期是明天。', ledger)
  assert.equal(retained.blocked, false)
  assert.equal(retained.replanAllowed, false)
  assert.match(retained.text, /来源状态/)
  assert.doesNotMatch(buildGroundingFailureReport(ledger), /web_fetch|internal target/)

  const locked = prepareGroundingAttempt(ledger, 'web_fetch', {
    url: 'http://127.0.0.1/private?changed=2',
    recovery_for: blocked.sourceRecovery.obligation_id
  })
  assert.equal(locked.ok, false)
  assert.equal(locked.error.code, 'TARGET_RETRY_FORBIDDEN')

  const undeclared = prepareGroundingAttempt(ledger, 'web_fetch', { url: 'https://public.example/release' })
  assert.equal(undeclared.ok, true)
  recordToolExecution(ledger, {
    callId: 'unrelated',
    name: 'web_fetch',
    input: undeclared.input,
    result: toolSuccess({ code: 'WEB_FETCHED', message: 'public but undeclared', data: { complete: true, coverage: 'complete' } })
  })
  assert.equal(blocked.resolvedBy, null)

  const alternative = prepareGroundingAttempt(ledger, 'web_fetch', {
    url: 'https://public.example/release',
    recovery_for: blocked.sourceRecovery.obligation_id
  })
  assert.equal(alternative.ok, true)
  assert.equal(alternative.input.recovery_for, undefined)
  const recovered = recordToolExecution(ledger, {
    callId: 'alternative',
    name: 'web_fetch',
    input: alternative.input,
    sourceRecoveryControl: alternative.control,
    result: toolSuccess({ code: 'WEB_FETCHED', message: 'verified public source', data: { complete: true, coverage: 'complete' } })
  })
  assert.equal(blocked.resolvedBy, recovered.index)
  assert.equal(groundingOutcome(ledger).status, 'success')
  assert.equal(guardFinalReport('已依据公开来源核验。', ledger).blocked, false)
})

test('source recovery budgets and provider serialization remain bounded', () => {
  const ledger = createExecutionLedger({ instruction: 'Find a source' })
  const failed = recordToolExecution(ledger, {
    callId: 'failed',
    name: 'web_search',
    input: { query: 'release' },
    result: toolFailure({ code: 'WEB_SEARCH_FAILED', retryable: true, message: 'temporary network failure' })
  })
  const obligationId = failed.sourceRecovery.obligation_id
  assert.match(buildSourceRecoveryConstraint(ledger), new RegExp(obligationId))

  const first = prepareGroundingAttempt(ledger, 'web_search', { query: 'release', recovery_for: obligationId })
  assert.equal(first.ok, true)
  const result = toolFailure({ code: 'WEB_SEARCH_FAILED', retryable: true, message: 'still unavailable' })
  const retry = recordToolExecution(ledger, {
    callId: 'retry', name: 'web_search', input: first.input, result, sourceRecoveryControl: first.control
  })
  const serialized = JSON.parse(serializeToolResult({ ...result, failure: retry.failure, sourceRecovery: retry.sourceRecovery }))
  assert.equal(serialized.failure.class, 'transient')
  assert.equal(serialized.source_recovery.obligation_id, obligationId)
  assert.equal(serialized.source_recovery.remaining.same_target, 0)

  const exhausted = prepareGroundingAttempt(ledger, 'web_search', { query: 'release', recovery_for: obligationId })
  assert.equal(exhausted.ok, false)
  assert.equal(exhausted.error.code, 'SOURCE_RECOVERY_EXHAUSTED')
})

test('a missing artifact can be superseded only by reacquiring its recorded read-only source', () => {
  const ledger = createExecutionLedger({ instruction: 'Read a.md completely' })
  recordToolExecution(ledger, {
    callId: 'artifact-missing',
    name: 'read_tool_output',
    input: { artifact_id: 'missing-a' },
    result: toolFailure({
      code: 'ARTIFACT_MISSING',
      retryable: true,
      message: 'Artifact does not exist',
      data: { recovery_source_target: 'path:a.md', retry_same_artifact: false }
    })
  })
  recordToolExecution(ledger, {
    callId: 'wrong-source',
    name: 'read_file',
    input: { path: 'b.md' },
    result: toolSuccess({ code: 'FILE_READ', message: 'B', data: { complete: true, coverage: 'complete' } })
  })
  assert.equal(ledger.entries[0].resolvedBy, null)

  recordToolExecution(ledger, {
    callId: 'right-source',
    name: 'read_file',
    input: { path: 'a.md' },
    result: toolSuccess({ code: 'FILE_READ', message: 'A', data: { complete: true, coverage: 'complete' } })
  })
  assert.equal(ledger.entries[0].resolvedBy, 3)
  assert.equal(groundingOutcome(ledger).status, 'success')
})

test('a successful bound document read clears an earlier failure despite source projection ids', () => {
  const ledger = createExecutionLedger({ instruction: 'Read the current document', documentId: 'doc-a' })
  recordToolExecution(ledger, {
    callId: 'past-eof', name: 'read_document', input: { start_line: 99 },
    result: toolFailure({ code: 'SOURCE_RANGE_INVALID', retryable: true, message: 'range invalid' })
  })
  recordToolExecution(ledger, {
    callId: 'whole-doc', name: 'read_document', input: {},
    result: toolSuccess({
      code: 'DOCUMENT_READ', message: 'complete document', data: { source_id: 'document-lines:r1' },
      grounding: { requested_range_complete: true, source_complete: true, projection_complete: true, coverage: 'complete' }
    })
  })
  assert.equal(ledger.entries[0].logicalTarget, 'document:doc-a')
  assert.equal(ledger.entries[0].resolvedBy, 2)
  assert.equal(guardFinalReport('The document says X.', ledger).blocked, false)
})

test('artifact previews and partial ranges resolve only after complete coverage of the same artifact', () => {
  const ledger = createExecutionLedger({ instruction: 'Read the complete fetched source' })
  recordToolExecution(ledger, {
    callId: 'preview-a',
    name: 'web_fetch',
    input: { url: 'https://example.test/a' },
    result: toolSuccess({
      code: 'WEB_FETCHED',
      message: 'head and tail preview',
      data: { complete: true, coverage: 'complete' },
      grounding: {
        requested_range_complete: true,
        source_complete: true,
        projection_complete: false,
        complete: false,
        coverage: 'artifact_preview',
        clipped: true,
        artifact_id: 'artifact-a'
      },
      toolOutput: { artifact_id: 'artifact-a' }
    })
  })
  recordToolExecution(ledger, {
    callId: 'range-a',
    name: 'read_tool_output',
    input: { artifact_id: 'artifact-a', byte_offset: 100, byte_limit: 100 },
    result: toolSuccess({
      code: 'TOOL_OUTPUT_READ',
      message: 'middle range',
      data: { artifact_id: 'artifact-a' },
      grounding: {
        requested_range_complete: true,
        source_complete: true,
        projection_complete: false,
        complete: false,
        coverage: 'artifact_range',
        clipped: true,
        artifact_id: 'artifact-a'
      }
    })
  })

  let outcome = groundingOutcome(ledger)
  assert.equal(outcome.failures.length, 0)
  assert.equal(outcome.pending.length, 2)
  assert.equal(ledger.entries[0].ok, true)
  assert.equal(ledger.entries[1].ok, true)

  recordToolExecution(ledger, {
    callId: 'complete-b',
    name: 'read_tool_output',
    input: { artifact_id: 'artifact-b', byte_offset: 0, byte_limit: 10 },
    result: toolSuccess({
      code: 'TOOL_OUTPUT_READ',
      message: 'all of unrelated artifact',
      data: { artifact_id: 'artifact-b' },
      grounding: {
        requested_range_complete: true,
        source_complete: true,
        projection_complete: true,
        complete: true,
        coverage: 'complete',
        artifact_id: 'artifact-b'
      }
    })
  })
  outcome = groundingOutcome(ledger)
  assert.equal(outcome.status, 'partial')
  assert.equal(outcome.pending.length, 2)
  assert.equal(ledger.entries[0].resolvedBy, null)
  assert.equal(guardFinalReport('The source says X.', ledger).reason, 'grounding_incomplete')

  recordToolExecution(ledger, {
    callId: 'complete-a',
    name: 'read_tool_output',
    input: { artifact_id: 'artifact-a', byte_offset: 0, byte_limit: 1000 },
    result: toolSuccess({
      code: 'TOOL_OUTPUT_READ',
      message: 'complete artifact A',
      data: { artifact_id: 'artifact-a' },
      grounding: {
        requested_range_complete: true,
        source_complete: true,
        projection_complete: true,
        complete: true,
        coverage: 'complete',
        artifact_id: 'artifact-a'
      }
    })
  })
  outcome = groundingOutcome(ledger)
  assert.equal(outcome.status, 'success')
  assert.equal(outcome.pending.length, 0)
  assert.equal(ledger.entries[0].resolvedBy, 4)
  assert.equal(ledger.entries[1].resolvedBy, 4)
  assert.equal(guardFinalReport('The source says X.', ledger).blocked, false)
})

test('an artifact-complete projection of a partial source resolves only after that exact source continues', () => {
  const ledger = createExecutionLedger({ instruction: 'Read the complete source' })
  recordToolExecution(ledger, {
    callId: 'preview',
    name: 'read_file',
    input: { path: 'a.md' },
    result: toolSuccess({
      code: 'FILE_READ',
      message: 'artifact preview',
      data: { source_id: 'workspace-a:file-a' },
      grounding: {
        requested_range_complete: false,
        source_complete: true,
        projection_complete: false,
        coverage: 'artifact_preview',
        complete: false,
        clipped: true,
        artifact_id: 'artifact-partial',
        source_id: 'workspace-a:file-a'
      }
    })
  })
  recordToolExecution(ledger, {
    callId: 'artifact-full',
    name: 'read_tool_output',
    input: { artifact_id: 'artifact-partial', byte_offset: 0, byte_limit: 1000 },
    result: toolSuccess({
      code: 'TOOL_OUTPUT_READ',
      message: 'all bytes of this source page',
      data: { source_id: 'workspace-a:file-a', artifact_id: 'artifact-partial' },
      grounding: {
        requested_range_complete: false,
        source_complete: true,
        projection_complete: true,
        coverage: 'partial',
        complete: false,
        clipped: true,
        artifact_id: 'artifact-partial',
        source_id: 'workspace-a:file-a'
      }
    })
  })
  assert.equal(groundingOutcome(ledger).status, 'incomplete')
  assert.equal(ledger.entries[0].resolvedBy, null)
  assert.equal(ledger.entries[1].resolvedBy, null)

  recordToolExecution(ledger, {
    callId: 'source-final',
    name: 'read_file',
    input: { path: 'a.md', cursor: 'opaque' },
    result: toolSuccess({
      code: 'FILE_READ',
      message: 'source tail',
      data: { source_id: 'workspace-a:file-a' },
      grounding: {
        requested_range_complete: true,
        source_complete: true,
        projection_complete: true,
        coverage: 'complete',
        complete: true,
        clipped: false,
        source_id: 'workspace-a:file-a'
      }
    })
  })
  assert.equal(ledger.entries[0].resolvedBy, 3)
  assert.equal(ledger.entries[1].resolvedBy, 3)
  assert.equal(groundingOutcome(ledger).status, 'success')
})

test('an artifactized final source continuation transitively resolves its earlier partial page', () => {
  const ledger = createExecutionLedger({ instruction: 'Read the complete PDF source' })
  recordToolExecution(ledger, {
    callId: 'context-page',
    name: 'read_pdf_text',
    input: { attachment_id: 'pdf-a' },
    result: toolSuccess({
      code: 'PDF_CONTEXT_PARTIAL',
      message: 'initial context page',
      data: { source_id: 'pdf-a' },
      grounding: {
        requested_range_complete: false,
        source_complete: null,
        projection_complete: true,
        coverage: 'partial',
        complete: false,
        clipped: true,
        source_id: 'pdf-a'
      }
    })
  })
  recordToolExecution(ledger, {
    callId: 'source-final-preview',
    name: 'read_pdf_text',
    input: { attachment_id: 'pdf-a', cursor: 'opaque' },
    result: toolSuccess({
      code: 'PDF_TEXT_READ',
      message: 'bounded final source preview',
      data: { source_id: 'pdf-a' },
      grounding: {
        requested_range_complete: true,
        source_complete: true,
        projection_complete: false,
        coverage: 'artifact_preview',
        complete: false,
        clipped: true,
        artifact_id: 'artifact-pdf-final',
        source_id: 'pdf-a'
      },
      toolOutput: { artifact_id: 'artifact-pdf-final' }
    })
  })
  assert.equal(groundingOutcome(ledger).status, 'incomplete')
  assert.equal(ledger.entries[0].resolvedBy, null)

  recordToolExecution(ledger, {
    callId: 'artifact-final',
    name: 'read_tool_output',
    input: { artifact_id: 'artifact-pdf-final', byte_offset: 0, byte_limit: 100000 },
    result: toolSuccess({
      code: 'TOOL_OUTPUT_READ',
      message: 'complete final source result',
      data: { source_id: 'pdf-a', artifact_id: 'artifact-pdf-final' },
      grounding: {
        requested_range_complete: true,
        source_complete: true,
        projection_complete: true,
        coverage: 'complete',
        complete: true,
        clipped: false,
        artifact_id: 'artifact-pdf-final',
        source_id: 'pdf-a'
      }
    })
  })
  assert.equal(ledger.entries[0].resolvedBy, 3)
  assert.equal(ledger.entries[1].resolvedBy, 3)
  assert.equal(groundingOutcome(ledger).status, 'success')
  assert.equal(guardFinalReport('The source says X.', ledger).blocked, false)
})

test('a complete read of another range on the same physical source cannot settle a partial cursor chain', () => {
  const ledger = createExecutionLedger({ instruction: 'Read range A completely' })
  const read = (callId, sourceId, requestedRangeComplete) => recordToolExecution(ledger, {
    callId,
    name: 'read_pdf_text',
    input: { attachment_id: 'same-pdf' },
    result: toolSuccess({
      code: requestedRangeComplete ? 'PDF_TEXT_READ' : 'PDF_TEXT_PARTIAL',
      message: callId,
      data: { source_id: sourceId },
      grounding: {
        requested_range_complete: requestedRangeComplete,
        source_complete: true,
        projection_complete: true,
        coverage: requestedRangeComplete ? 'requested_range' : 'partial',
        complete: requestedRangeComplete,
        clipped: !requestedRangeComplete,
        source_id: sourceId
      }
    })
  })
  read('range-a-head', 'pdf:revision:range-a', false)
  read('range-b-complete', 'pdf:revision:range-b', true)
  assert.equal(ledger.entries[0].resolvedBy, null)
  assert.equal(groundingOutcome(ledger).status, 'partial')

  read('range-a-tail', 'pdf:revision:range-a', true)
  assert.equal(ledger.entries[0].resolvedBy, 3)
  assert.equal(groundingOutcome(ledger).status, 'success')
})
