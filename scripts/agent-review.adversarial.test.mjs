import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  AGENT_REVIEW_CLASSIFICATIONS,
  AGENT_REVIEW_DOCUMENT_MODES,
  AGENT_REVIEW_MODES,
  AGENT_REVIEW_POLICIES,
  AGENT_REVIEW_TOOL_POLICY,
  AUTOMATIC_REVIEW_SYSTEM_PROMPT,
  buildAutomaticReviewRequest,
  classifyAgentReviewOperation,
  createAgentReviewSessionRuntime,
  createReviewAuditReceipt,
  cropSensitiveReviewText,
  exactDocumentReviewSnapshotMatches,
  agentReviewModeFor,
  agentReviewModeProfile,
  parseAutomaticReviewVerdict,
  runStructuredAutomaticReviewer,
  summarizeReviewText
} from '../src/lib/agentReview.js'

const read = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')

test('one explicit policy classifies operations for evidence-based automatic Review', () => {
  for (const tool of ['delete_file', 'run_command', 'run_code']) {
    assert.equal(classifyAgentReviewOperation(tool), AGENT_REVIEW_CLASSIFICATIONS.ALWAYS_CONFIRM)
  }
  for (const tool of ['replace_lines', 'insert_lines', 'continue_hunk', 'insert_image', 'create_file', 'download_file']) {
    assert.equal(classifyAgentReviewOperation(tool), AGENT_REVIEW_CLASSIFICATIONS.REVIEWABLE_NON_DESTRUCTIVE)
  }
  assert.equal(classifyAgentReviewOperation('edit_file'), AGENT_REVIEW_CLASSIFICATIONS.UNSUPPORTED)
  assert.equal(classifyAgentReviewOperation('edit_file', { openBuffer: true }), AGENT_REVIEW_CLASSIFICATIONS.REVIEWABLE_NON_DESTRUCTIVE)
  for (const tool of ['create_folder', 'batch_process', 'move_file', 'rename_file', 'future_tool']) {
    assert.equal(classifyAgentReviewOperation(tool), AGENT_REVIEW_CLASSIFICATIONS.UNSUPPORTED)
  }
  assert.equal(Object.isFrozen(AGENT_REVIEW_TOOL_POLICY), true)
})

test('five review states and allow-all grants are process-local and exact-owner isolated', () => {
  const runtime = createAgentReviewSessionRuntime()
  const owner = { chatKey: 'workspace-a', sessionId: 'session-a', surfaceKey: 'tab-a' }
  const otherSurface = { ...owner, surfaceKey: 'tab-b' }
  const otherSession = { ...owner, sessionId: 'session-b' }
  const otherWorkspace = { ...owner, chatKey: 'workspace-b' }

  const defaultState = { mode: AGENT_REVIEW_MODES.REVIEW_TAB_MANUAL, allowAllGranted: false }
  assert.deepEqual(runtime.get(owner), defaultState)
  assert.equal(runtime.revision(owner), 0)
  assert.equal(runtime.grantRevision(owner), 0)
  assert.equal(runtime.set(owner, AGENT_REVIEW_MODES.REVIEW_TAB_MANUAL), true)
  assert.equal(runtime.revision(owner), 0, 'setting the effective default mode must be a no-op')
  assert.equal(runtime.set(owner, AGENT_REVIEW_MODES.MANUAL), true)
  assert.deepEqual(runtime.get(owner), { mode: AGENT_REVIEW_MODES.MANUAL, allowAllGranted: false })
  assert.equal(runtime.set(owner, AGENT_REVIEW_MODES.REVIEW_ALL_AUTO), true)
  assert.deepEqual(runtime.get(owner), { mode: AGENT_REVIEW_MODES.REVIEW_ALL_AUTO, allowAllGranted: false })
  assert.equal(runtime.set(owner, AGENT_REVIEW_MODES.ALLOW_ALL_TAB_MANUAL), false)
  assert.equal(runtime.set(owner, AGENT_REVIEW_MODES.ALLOW_ALL_ALL_AUTO), false)
  assert.equal(runtime.set(owner, AGENT_REVIEW_MODES.ALLOW_ALL_ALL_AUTO, { confirmed: true }), true)
  assert.deepEqual(runtime.get(owner), { mode: AGENT_REVIEW_MODES.ALLOW_ALL_ALL_AUTO, allowAllGranted: true })
  assert.ok(runtime.revision(owner) > 0)
  const allowAllRevision = runtime.revision(owner)
  const allowAllGrantRevision = runtime.grantRevision(owner)
  assert.ok(allowAllGrantRevision > 0)
  assert.equal(runtime.set(owner, AGENT_REVIEW_MODES.ALLOW_ALL_ALL_AUTO, { confirmed: true }), true)
  assert.equal(runtime.revision(owner), allowAllRevision, 'setting the active mode must not emit a new revision')
  assert.equal(runtime.set(owner, AGENT_REVIEW_MODES.ALLOW_ALL_TAB_MANUAL, { confirmed: true }), true)
  assert.ok(runtime.revision(owner) > allowAllRevision)
  assert.equal(runtime.grantRevision(owner), allowAllGrantRevision, 'the document-review switch must retain direct-operation authority')
  assert.equal(runtime.set(owner, AGENT_REVIEW_MODES.ALLOW_ALL_ALL_AUTO, { confirmed: true }), true)
  assert.equal(runtime.grantRevision(owner), allowAllGrantRevision)
  assert.deepEqual(runtime.get(otherSurface), defaultState)
  assert.deepEqual(runtime.get(otherSession), defaultState)
  assert.deepEqual(runtime.get(otherWorkspace), defaultState)

  assert.equal(runtime.set(owner, AGENT_REVIEW_MODES.REVIEW_TAB_MANUAL), true)
  assert.deepEqual(runtime.get(owner), defaultState)
  const revokedGrantRevision = runtime.grantRevision(owner)
  assert.ok(revokedGrantRevision > allowAllGrantRevision)
  assert.equal(runtime.set(owner, AGENT_REVIEW_MODES.ALLOW_ALL_TAB_MANUAL, { confirmed: true }), true)
  assert.ok(runtime.grantRevision(owner) > revokedGrantRevision, 'leaving and re-entering Allow All must not reuse an old grant epoch')

  runtime.set(otherSurface, AGENT_REVIEW_MODES.ALLOW_ALL_ALL_AUTO, { confirmed: true })
  assert.equal(runtime.delete(owner), true)
  assert.deepEqual(runtime.get(owner), defaultState)
  assert.deepEqual(runtime.get(otherSurface), { mode: AGENT_REVIEW_MODES.ALLOW_ALL_ALL_AUTO, allowAllGranted: true })
  runtime.set(owner, AGENT_REVIEW_MODES.ALLOW_ALL_TAB_MANUAL, { confirmed: true })
  assert.equal(runtime.delete({ chatKey: owner.chatKey, sessionId: owner.sessionId }), true)
  assert.deepEqual(runtime.get(owner), defaultState)
  assert.deepEqual(runtime.get(otherSurface), defaultState)

  const restarted = createAgentReviewSessionRuntime()
  assert.deepEqual(restarted.get(owner), defaultState)

  assert.equal(agentReviewModeFor(AGENT_REVIEW_POLICIES.MANUAL), AGENT_REVIEW_MODES.MANUAL)
  assert.equal(agentReviewModeFor(AGENT_REVIEW_POLICIES.REVIEW, AGENT_REVIEW_DOCUMENT_MODES.TAB_MANUAL), AGENT_REVIEW_MODES.REVIEW_TAB_MANUAL)
  assert.equal(agentReviewModeFor(AGENT_REVIEW_POLICIES.REVIEW, AGENT_REVIEW_DOCUMENT_MODES.ALL_AUTO), AGENT_REVIEW_MODES.REVIEW_ALL_AUTO)
  assert.equal(agentReviewModeFor(AGENT_REVIEW_POLICIES.ALLOW_ALL, AGENT_REVIEW_DOCUMENT_MODES.TAB_MANUAL), AGENT_REVIEW_MODES.ALLOW_ALL_TAB_MANUAL)
  assert.equal(agentReviewModeFor(AGENT_REVIEW_POLICIES.ALLOW_ALL, AGENT_REVIEW_DOCUMENT_MODES.ALL_AUTO), AGENT_REVIEW_MODES.ALLOW_ALL_ALL_AUTO)
  assert.deepEqual(agentReviewModeProfile(AGENT_REVIEW_MODES.REVIEW_ALL_AUTO), {
    policy: AGENT_REVIEW_POLICIES.REVIEW,
    documentMode: AGENT_REVIEW_DOCUMENT_MODES.ALL_AUTO,
    automaticOperations: true,
    automaticTabDocuments: true,
    requiresGrant: false
  })
  assert.equal(agentReviewModeProfile('unknown').policy, AGENT_REVIEW_POLICIES.MANUAL)
})

test('review prompts are isolated, redacted, bounded, and remain valid JSON', () => {
  const secret = 'sk-this-provider-key-must-not-survive-1234567890'
  const cropped = cropSensitiveReviewText(`api_key=${secret}\nAuthorization: Bearer opaque-token-value-123456`, 90)
  assert.ok(cropped.length <= 90)
  assert.doesNotMatch(cropped, /must-not-survive|opaque-token/)
  assert.match(cropped, /REDACTED/)
  assert.equal(cropSensitiveReviewText('oversized', 0), '')
  assert.equal(cropSensitiveReviewText('oversized', 5).length, 5)
  const signedUrl = cropSensitiveReviewText('https://user:password@example.test/file?X-Amz-Signature=LOCAL-SIGNATURE&sig=SECOND-SECRET', 500)
  assert.doesNotMatch(signedUrl, /user:password|LOCAL-SIGNATURE|SECOND-SECRET/)
  assert.match(signedUrl, /REDACTED/)
  const secretHeaders = cropSensitiveReviewText('Authorization: Basic dXNlcjpwYXNzd29yZA==\nCookie: sid=COOKIE-SECRET; theme=dark', 500)
  assert.doesNotMatch(secretHeaders, /dXNlcjpwYXNzd29yZA|COOKIE-SECRET|theme=dark/)

  const huge = `${'"\\'.repeat(9000)} password=do-not-store ${secret}`
  const request = buildAutomaticReviewRequest({
    instruction: huge,
    operation: { tool: 'create_file', detail: huge },
    target: `notes/${huge}`,
    baseline: summarizeReviewText(huge, 5000),
    proposed: summarizeReviewText(huge, 5000),
    evidence: { preflightComplete: true, detail: huge }
  })
  assert.match(AUTOMATIC_REVIEW_SYSTEM_PROMPT, /no tools, no conversation history/)
  assert.match(AUTOMATIC_REVIEW_SYSTEM_PROMPT, /untrusted data/)
  assert.ok(request.user.length <= 12_000, `review request was ${request.user.length} chars`)
  assert.doesNotThrow(() => JSON.parse(request.user))
  assert.doesNotMatch(request.user, /do-not-store|must-not-survive/)
  assert.equal(request.coverage.complete, false)
  assert.equal(request.coverage.redacted, true)
  assert.match(request.user, /WITHHELD_INCOMPLETE_REVIEW_INPUT/)

  const cyclic = { tool: 'create_file' }
  cyclic.self = cyclic
  const cyclicRequest = buildAutomaticReviewRequest({ operation: cyclic })
  assert.doesNotThrow(() => JSON.parse(cyclicRequest.user))
  assert.equal(cyclicRequest.coverage.complete, false)

  const sharedLines = ['# Before']
  const sharedRequest = buildAutomaticReviewRequest({
    instruction: 'Replace the heading.',
    operation: { tool: 'document_hunks', hunks: [{ oldLines: sharedLines, newLines: ['# After'] }] },
    baseline: [sharedLines],
    proposed: [['# After']],
    evidence: { preflightComplete: true, postconditionDefined: true }
  })
  assert.equal(sharedRequest.coverage.complete, true)
  assert.deepEqual(JSON.parse(sharedRequest.user).baseline, [['# Before']])

  const bigintRequest = buildAutomaticReviewRequest({ operation: { unsupportedNumber: 1n } })
  assert.doesNotThrow(() => JSON.parse(bigintRequest.user))
  assert.equal(bigintRequest.coverage.complete, false)
})

test('incomplete or sensitive reviewer inputs fail closed before provider invocation', async () => {
  const pass = JSON.stringify({
    verdict: 'PASS',
    reason: 'Would approve if invoked.',
    checks: { instructionAligned: true, targetExact: true, nonDestructive: true, evidenceComplete: true }
  })
  const cases = [
    buildAutomaticReviewRequest({ instruction: `safe ${'x'.repeat(5000)} forbidden tail` }),
    buildAutomaticReviewRequest({ proposed: { items: Array.from({ length: 25 }, (_, index) => index) } }),
    buildAutomaticReviewRequest({ proposed: { password: 'OBJECT_SECRET' } }),
    buildAutomaticReviewRequest({ proposed: '{"credentials":{"awsAccessKeyId":"JSON_SECRET"}}' }),
    buildAutomaticReviewRequest({ proposed: '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----' }),
    buildAutomaticReviewRequest({ proposed: 'https://example.test/?token=SHORT_SECRET' })
  ]
  let calls = 0
  for (const request of cases) {
    const verdict = await runStructuredAutomaticReviewer({ request, invoke: async () => { calls++; return pass } })
    assert.equal(verdict.verdict, 'UNKNOWN')
  }
  assert.equal(calls, 0)
  assert.doesNotMatch(cases.map((request) => request.user).join('\n'), /OBJECT_SECRET|JSON_SECRET|abc123|SHORT_SECRET/)

  const complete = buildAutomaticReviewRequest({
    instruction: 'Create a short note.',
    operation: { tool: 'create_file' },
    target: 'note.md',
    proposed: '# Note',
    evidence: { preflightComplete: true, postconditionDefined: true }
  })
  assert.equal(complete.coverage.complete, true)
  assert.equal((await runStructuredAutomaticReviewer({ request: complete, invoke: async () => { calls++; return pass } })).verdict, 'PASS')
  assert.equal(calls, 1)
})

test('automatic verdict parsing is exact-schema and fail-closed', async () => {
  const pass = JSON.stringify({
    verdict: 'PASS',
    reason: 'Exact additive target.',
    checks: { instructionAligned: true, targetExact: true, nonDestructive: true, evidenceComplete: true }
  })
  assert.equal(parseAutomaticReviewVerdict(pass).verdict, 'PASS')
  assert.equal(parseAutomaticReviewVerdict('```json\n' + pass + '\n```').verdict, 'UNKNOWN')
  assert.equal(parseAutomaticReviewVerdict('{bad json').reasonCode, 'reviewer_json_invalid')
  assert.equal(parseAutomaticReviewVerdict(JSON.stringify({
    verdict: 'PASS',
    reason: 'Incomplete.',
    checks: { instructionAligned: true, targetExact: true, nonDestructive: false, evidenceComplete: true }
  })).reasonCode, 'reviewer_checks_incomplete')
  assert.equal(parseAutomaticReviewVerdict(JSON.stringify({
    verdict: 'PASS',
    reason: 'Extra authority.',
    approved: true,
    checks: { instructionAligned: true, targetExact: true, nonDestructive: true, evidenceComplete: true }
  })).reasonCode, 'reviewer_schema_invalid')
  assert.equal(parseAutomaticReviewVerdict('{"verdict":"FAIL","verdict":"PASS","reason":"Duplicate.","checks":{"instructionAligned":true,"targetExact":true,"nonDestructive":true,"evidenceComplete":true}}').reasonCode, 'reviewer_schema_invalid')
  assert.equal(parseAutomaticReviewVerdict('{"verdict":"FAIL","\\u0076erdict":"PASS","reason":"Escaped duplicate.","checks":{"instructionAligned":true,"targetExact":true,"nonDestructive":true,"evidenceComplete":true}}').reasonCode, 'reviewer_schema_invalid')
  assert.equal(parseAutomaticReviewVerdict(JSON.stringify({
    verdict: 'FAIL',
    reason: 'The quoted key "verdict": remains ordinary reason text.',
    checks: { instructionAligned: false, targetExact: true, nonDestructive: true, evidenceComplete: true }
  })).verdict, 'FAIL')
  assert.equal(parseAutomaticReviewVerdict(JSON.stringify({
    verdict: 'PASS',
    reason: '',
    checks: { instructionAligned: true, targetExact: true, nonDestructive: true, evidenceComplete: true }
  })).reasonCode, 'reviewer_schema_invalid')

  assert.equal((await runStructuredAutomaticReviewer({
    request: { system: 'isolated', user: '{}', coverage: { complete: true, redacted: false } },
    invoke: async () => { throw new Error('provider unavailable') }
  })).reasonCode, 'reviewer_provider_error')
  assert.equal((await runStructuredAutomaticReviewer({ request: null, invoke: async () => pass })).reasonCode, 'reviewer_request_invalid')

  let attempts = 0
  const recovered = await runStructuredAutomaticReviewer({
    request: { system: 'isolated', user: '{}', coverage: { complete: true, redacted: false } },
    invoke: async () => (++attempts === 1 ? '{bad json' : pass)
  })
  assert.equal(attempts, 2)
  assert.equal(recovered.verdict, 'PASS')
})

test('document automatic acceptance requires exact identity, generation, revision, and content fingerprint', () => {
  const expected = { documentId: 'doc-a', generation: 7, revision: 12, contentFingerprint: '8:abc' }
  assert.equal(exactDocumentReviewSnapshotMatches(expected, { ...expected }), true)
  for (const changed of [
    { documentId: 'doc-b' },
    { generation: 8 },
    { revision: 13 },
    { contentFingerprint: '8:def' }
  ]) assert.equal(exactDocumentReviewSnapshotMatches(expected, { ...expected, ...changed }), false)
  assert.equal(exactDocumentReviewSnapshotMatches({ ...expected, generation: Number.NaN }, expected), false)
  assert.equal(exactDocumentReviewSnapshotMatches({ ...expected, generation: '7' }, expected), false)
  assert.equal(exactDocumentReviewSnapshotMatches({ ...expected, revision: null }, expected), false)
})

test('persistable review receipts retain compact evidence but no sensitive body fields', () => {
  const receipt = createReviewAuditReceipt({
    mode: AGENT_REVIEW_MODES.REVIEW_TAB_MANUAL,
    tool: 'create_file',
    classification: AGENT_REVIEW_CLASSIFICATIONS.REVIEWABLE_NON_DESTRUCTIVE,
    target: 'notes/result.md',
    verdict: 'UNKNOWN',
    outcome: 'manual_required',
    reasonCode: 'reviewer_unknown',
    reason: 'password=do-not-persist',
    runId: 'run-a',
    callId: 'call-a',
    itemCount: 3,
    evidence: {
      preflightComplete: true,
      postconditionDefined: true,
      documentId: 'doc-a',
      secretBody: 'private document body'
    }
  })
  const serialized = JSON.stringify(receipt)
  assert.equal(Object.isFrozen(receipt), true)
  assert.match(serialized, /preflightComplete/)
  assert.match(serialized, /"policyVersion":3/)
  assert.match(serialized, /"policy":"review"/)
  assert.match(serialized, /"documentMode":"tab_manual"/)
  assert.match(serialized, /"itemCount":3/)
  assert.doesNotMatch(serialized, /do-not-persist|private document body|secretBody/)

  const signedTarget = JSON.stringify(createReviewAuditReceipt({
    mode: AGENT_REVIEW_MODES.REVIEW_TAB_MANUAL,
    tool: 'download_file',
    target: 'https://files.example/item?X-Amz-Credential=LOCAL-CREDENTIAL&X-Amz-Signature=LOCAL-SIGNATURE'
  }))
  assert.doesNotMatch(signedTarget, /LOCAL-CREDENTIAL|LOCAL-SIGNATURE/)
})

test('legacy review modes remain readable only in historical audit receipts', () => {
  for (const mode of ['automatic', 'allow_all', 'markdown_review', 'full_auto']) {
    assert.equal(createReviewAuditReceipt({ mode }).mode, mode)
  }
  const runtime = createAgentReviewSessionRuntime()
  const owner = { chatKey: 'workspace-a', sessionId: 'session-a', surfaceKey: 'tab-a' }
  for (const mode of ['automatic', 'allow_all', 'markdown_review', 'full_auto']) assert.equal(runtime.set(owner, mode, { confirmed: true }), false)
})

test('store, app, and panel preserve exact-owner grants, post-owner CAS, and technical safety boundaries', () => {
  const store = read('src/lib/agentStore.js')
  const app = read('src/App.vue')
  const panel = read('src/components/AgentPanel.vue')
  const finalizer = store.slice(store.indexOf('const ownedPendingReview ='), store.indexOf('resolveRunCompletion()', store.indexOf('const ownedPendingReview =')))

  assert.match(store, /surfaceKey: String\(context\?\.surfaceKey \|\| activeAgentSurfaceKey\.value/)
  assert.match(store, /classifyAgentReviewOperation\(name, operationContext\)/)
  assert.match(store, /withTools: false,[\s\S]{0,180}temperature: 0/)
  assert.match(store, /const revalidateAutomaticDirectReview =/)
  assert.match(store, /state\.revision === authorization\.revision/)
  assert.match(store, /state\.grantRevision === authorization\.grantRevision/)
  assert.match(store, /kind: 'allow_all_grant'/)
  assert.match(store, /fingerprint: directMutationCallFingerprint\(name, input\)/)
  assert.match(store, /code: 'AUTOMATIC_REVIEW_REVALIDATION_REQUIRED'/)
  assert.match(store, /forceManual: true,[\s\S]{0,100}reviewFallback/)
  assert.match(store, /name === 'run_code'[\s\S]{0,180}code:sha256:/)
  assert.match(store, /name === 'run_command'[\s\S]{0,100}reviewTextFingerprint/)
  assert.match(store, /name === 'download_file'[\s\S]{0,120}summary\?\.destination/)
  assert.match(store, /atomicNoReplace = typeof context\?\.workspaceBinding\?\.handle\?\.createFileExclusive/)
  assert.match(store, /postcondition: 'atomic_no_replace_exact_path_readback'/)
  const authorize = store.slice(store.indexOf('const authorizeDirectMutation ='), store.indexOf('const RENDERER_MUTATION_TOOLS'))
  assert.ok(authorize.indexOf('if (allowAllRequested)') < authorize.indexOf('preflight.classification === AGENT_REVIEW_CLASSIFICATIONS.ALWAYS_CONFIRM'))
  assert.match(authorize, /allowAllRequested \|\| evidenceReviewRequested/)
  assert.match(store, /skipHumanReview = reviewProfile\.policy === AGENT_REVIEW_POLICIES\.ALLOW_ALL && reviewState\.allowAllGranted/)
  assert.match(app, /if \(options\?\.skipHumanReview !== true\)/)
  assert.ok(finalizer.indexOf('activeRuns.delete(ownerKey)') < finalizer.indexOf('reviewAndMaybeAcceptRunHunks'))
  assert.ok(finalizer.indexOf('reviewAndMaybeAcceptRunHunks') < finalizer.indexOf('releaseRunDocumentBindings'))
  assert.match(store, /const unsettledRunFinalizations = new Set\(\)/)
  assert.match(store, /const contexts = \[\.\.\.unsettledRunFinalizations\]/)
  assert.ok(store.indexOf('resolveRunCompletion()') < store.indexOf('unsettledRunFinalizations.delete(runContext)'))
  assert.match(store, /hunks: hunkDiff/)
  assert.match(store, /oldLines: hunk\.oldLines,[\s\S]{0,100}newLines: hunk\.applyLines/)
  assert.match(app, /String\(request\.documentId \|\| ''\) !== String\(current\.documentId \|\| ''\)/)
  assert.match(app, /String\(request\.expectedMarkdown \?\? ''\) !== String\(current\.markdown \?\? ''\)/)
  assert.match(panel, /requestAppDialog\(\{[\s\S]{0,300}agent_review_allow_all_confirm_title/)
  assert.match(panel, /aria-haspopup="dialog"/)
  assert.match(panel, /data-testid="agent-review-policy-group"/)
  assert.match(panel, /data-testid="agent-review-document-group"/)
  assert.match(panel, /role="switch"/)
  assert.match(panel, /option\.policy === AGENT_REVIEW_POLICIES\.ALLOW_ALL/)
  assert.match(panel, /aria-checked="activeReviewProfile\.documentMode === AGENT_REVIEW_DOCUMENT_MODES\.TAB_MANUAL"/)
  assert.match(app, /agent_review_document_label: '编辑文档时人工审核'/)
  assert.match(panel, /fill="currentColor"/)
  assert.match(panel, /role="radiogroup"/)
  assert.match(panel, /agentReviewModeFor/)
  assert.match(panel, /agent-review-mode-popover/)
  assert.match(panel, /surfaceKey: activeAgentSurfaceKey\.value/)
  assert.match(panel, /data-testid="agent-review-receipt"/)
})
