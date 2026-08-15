// Deterministic execution contract for Knote Agent.
//
// Models may explain a tool result, but they do not get to decide whether an
// operation succeeded. Every result is normalized here, recorded in an
// append-only run ledger, and used to gate completion claims.

import { normalizeSourceGrounding } from './agentSourceContinuation.js'

export const MUTATION_TOOLS = new Set([
  'replace_lines', 'insert_lines', 'continue_hunk', 'discard_hunks', 'insert_image',
  'create_file', 'create_folder', 'edit_file', 'move_file', 'rename_file',
  'delete_file', 'download_file', 'batch_process'
])

export const PRODUCTIVE_MUTATION_TOOLS = new Set([
  'replace_lines', 'insert_lines', 'continue_hunk', 'insert_image', 'create_file',
  'create_folder', 'edit_file', 'move_file', 'rename_file', 'delete_file',
  'download_file', 'batch_process'
])

export const GROUNDING_TOOLS = new Set([
  'read_document', 'read_file', 'list_files', 'find_in_files', 'get_outline',
  'web_search', 'web_fetch', 'read_workspace_pdf', 'read_workspace_image',
  'read_pdf_text', 'render_pdf_page', 'pdf_prepare', 'pdf_get_element',
  'pdf_crop_region', 'pdf_layout', 'read_attachment', 'read_tool_output', 'get_datetime', 'calc'
])
export const EVIDENCE_TOOLS = GROUNDING_TOOLS

const tidy = (value) => String(value == null ? '' : value)
const boundedEvidenceText = (value, limit, label) => {
  const text = tidy(value)
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n[${label}_TRUNCATED returned_chars=${limit} total_chars=${text.length}]`
}

export const toolSuccess = ({
  code = 'OK',
  message = '',
  data = null,
  mutation = null,
  verification = null,
  recovery = null,
  grounding = null,
  failure = null,
  sourceRecovery = null,
  toolOutput = null,
  captureWarning = null
} = {}) => ({
  ok: true,
  code,
  retryable: false,
  message: tidy(message),
  text: tidy(message),
  data,
  mutation,
  verification,
  recovery,
  grounding,
  failure,
  sourceRecovery,
  toolOutput,
  captureWarning
})

export const toolFailure = ({
  code = 'TOOL_FAILED',
  message = '',
  retryable = false,
  data = null,
  verification = null,
  recovery = null,
  grounding = null,
  failure = null,
  sourceRecovery = null,
  toolOutput = null,
  captureWarning = null
} = {}) => ({
  ok: false,
  code,
  retryable: !!retryable,
  message: tidy(message),
  text: tidy(message),
  data,
  mutation: null,
  verification,
  recovery,
  grounding,
  failure,
  sourceRecovery,
  toolOutput,
  captureWarning
})

export const failureFromMessage = (message, overrides = {}) => {
  const text = tidy(message)
  let code = overrides.code || 'TOOL_FAILED'
  let retryable = overrides.retryable
  if (/文档尚未读取|尚未读取(?:绑定目标|文件)|尚未建立读取基线|DOCUMENT_NOT_READ/i.test(text)) {
    code = overrides.code || 'DOCUMENT_NOT_READ'
    if (retryable == null) retryable = true
  } else if (/文档.*(?:发生变化|已变化)|revision.*变化|重新调用 read_document/i.test(text)) {
    code = overrides.code || 'DOCUMENT_STALE'
    if (retryable == null) retryable = true
  } else if (/行号无效|after_line 无效|重新.*最新行号/i.test(text)) {
    code = overrides.code || 'RANGE_INVALID'
    if (retryable == null) retryable = true
  } else if (/未找到|找不到|读不到/i.test(text)) {
    code = overrides.code || 'NOT_FOUND'
    if (retryable == null) retryable = true
  } else if (/重叠|无法唯一定位|出现 \d+ 次/i.test(text)) {
    code = overrides.code || 'EDIT_CONFLICT'
    if (retryable == null) retryable = true
  } else if (/用户拒绝|declined/i.test(text)) {
    code = overrides.code || 'USER_DECLINED'
    retryable = false
  } else if (/读取被拒绝|本机或内网地址/i.test(text)) {
    code = overrides.code || 'ACCESS_BLOCKED'
    retryable = false
  } else if (/不支持|不可用|没有打开文件夹工作区/i.test(text)) {
    code = overrides.code || 'UNAVAILABLE'
    retryable = false
  } else if (/搜索失败|读取失败|检索失败|转换失败/i.test(text)) {
    code = overrides.code || 'TRANSIENT_FAILURE'
    if (retryable == null) retryable = true
  } else if (/计算结果无效/i.test(text)) {
    code = overrides.code || 'INVALID_RESULT'
    retryable = false
  } else if (/完全相同|无需修改/i.test(text)) {
    code = overrides.code || 'NO_CHANGE'
    retryable = false
  }
  return toolFailure({ ...overrides, code, retryable: !!retryable, message: text })
}

const LEGACY_FAILURE = /^(?:工具执行失败|错误[:：]|未执行[:：]|操作失败[:：]|请求失败[:：]|检索失败[:：]|搜索失败[:：]|搜索未返回结果|Jina 搜索失败|读取失败|读取被拒绝|计算失败[:：]|计算结果无效|版面分析(?:服务)?不可用|「[^」]+」是\s*(?:PDF|图片)\s*文件，请改用)/i
const LEGACY_UNAVAILABLE = /^(?:当前没有打开文件夹工作区|当前模型不支持|当前环境不支持|PDF 解析环境未就绪|版面分析服务仅在桌面版可用)/i
const LEGACY_EMBEDDED_FAILURE = /^PDF《[^》]+》已加载.*但转换失败/i

// Legacy read-only tools still return {text}. Normalize them at one boundary so
// providers and the UI always receive an explicit `ok` boolean. Mutating tools
// are required to return an explicit structured result and are rejected below
// if they do not provide a verified mutation receipt.
export const normalizeToolResult = (name, raw) => {
  if (raw && typeof raw.ok === 'boolean') {
    const message = tidy(raw.message != null ? raw.message : raw.text)
    const normalized = raw.ok
      ? toolSuccess({ ...raw, message })
      : toolFailure({ ...raw, message })
    return {
      ...normalized,
      imageDataUrl: raw.imageDataUrl,
      imageDataUrls: raw.imageDataUrls
    }
  }
  const obj = raw && typeof raw === 'object' ? raw : { text: raw }
  const message = tidy(obj.text)
  if (LEGACY_FAILURE.test(message) || LEGACY_UNAVAILABLE.test(message) || LEGACY_EMBEDDED_FAILURE.test(message)) {
    return { ...failureFromMessage(message), imageDataUrl: obj.imageDataUrl, imageDataUrls: obj.imageDataUrls }
  }
  return { ...toolSuccess({ message, data: obj.data || null }), imageDataUrl: obj.imageDataUrl, imageDataUrls: obj.imageDataUrls }
}

export const requireVerifiedMutation = (name, result) => {
  if (!MUTATION_TOOLS.has(name) || !result.ok) return result
  if (!result.mutation || result.mutation.verified !== true) {
    return toolFailure({
      code: 'POSTCONDITION_MISSING',
      message: `工具 ${name} 返回了成功，但没有提供通过后置验证的修改凭证；系统已拒绝把它计为成功。`,
      retryable: true,
      verification: { ok: false, reason: 'missing_verified_mutation' }
    })
  }
  return result
}

const normalizedIdentity = (value) => tidy(value).trim().replace(/\s+/g, ' ')
const normalizedPath = (value) => normalizedIdentity(value).replace(/\\/g, '/')
const normalizedPathList = (values) => [...new Set((Array.isArray(values) ? values : [])
  .map((value) => normalizedPath(value?.path ?? value?.sourcePath ?? value))
  .filter(Boolean))]

const groundingTargetOf = (name, input = {}, documentId = '') => {
  if (name === 'read_document' || (name === 'get_outline' && !input.path)) return `document:${documentId || 'current'}`
  if (name === 'list_files') return 'workspace:current'
  if (name === 'read_file' || name === 'read_workspace_pdf' || name === 'read_workspace_image' || name === 'get_outline') {
    return `path:${normalizedPath(input.path)}`
  }
  if (name === 'find_in_files' || name === 'web_search') return `query:${normalizedIdentity(input.query)}`
  if (name === 'web_fetch') return `url:${normalizedIdentity(input.url)}`
  if (name === 'read_attachment') return `attachment:${normalizedIdentity(input.attachment_id)}`
  if (name === 'read_tool_output') return `artifact:${normalizedIdentity(input.artifact_id)}`
  if (name === 'pdf_get_element') return `element:${normalizedIdentity(input.element_id)}`
  if (/^(?:read_pdf_text|render_pdf_page|pdf_prepare|pdf_crop_region|pdf_layout)$/.test(name)) {
    return `attachment:${normalizedIdentity(input.attachment_id)}`
  }
  if (name === 'calc') return `expression:${normalizedIdentity(input.expression)}`
  return `tool:${name}`
}

export const groundingPolicyTargetOf = (name, input = {}, documentId = '') => {
  if (name === 'web_fetch') {
    try {
      const url = new URL(String(input.url || ''))
      url.search = ''
      url.hash = ''
      return `web-origin-path:${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, '') || '/'}`
    } catch { return `web-url:${normalizedIdentity(input.url)}` }
  }
  return groundingTargetOf(name, input, documentId)
}

const targetOf = (name, input = {}, mutation = null, documentId = '') => {
  if (GROUNDING_TOOLS.has(name)) return groundingTargetOf(name, input, documentId)
  if (/^(?:replace_lines|insert_lines|continue_hunk|discard_hunks|insert_image)$/.test(name)) return `document:${documentId || 'current'}`
  if (mutation && mutation.target) return String(mutation.target)
  if (input.path) return `path:${normalizedPath(input.path)}`
  return `tool:${name}`
}

const familyOf = (name) => {
  if (/^(?:pdf_prepare|pdf_get_element|pdf_crop_region|pdf_layout)$/.test(name)) return 'pdf-visual-read'
  if (/^(?:read_workspace_pdf|read_pdf_text)$/.test(name)) return 'pdf-text-read'
  if (/^(?:replace_lines|insert_lines|continue_hunk|insert_image)$/.test(name)) return 'document-edit'
  if (/^(?:create_file|edit_file|download_file)$/.test(name)) return 'file-write'
  if (/^(?:move_file|rename_file)$/.test(name)) return 'file-relocate'
  return name
}

const groundingMetadata = (name, result) => {
  if (!GROUNDING_TOOLS.has(name)) return null
  const declared = result?.grounding && typeof result.grounding === 'object' ? result.grounding : {}
  const data = result?.data && typeof result.data === 'object' ? result.data : {}
  const merged = { ...data, ...declared }
  const coverage = normalizedIdentity(merged.coverage).toLowerCase()
  const normalized = normalizeSourceGrounding(merged, {
    defaultRequested: null,
    defaultSource: null,
    defaultProjection: null,
    legacySourceComplete: true
  })
  const continuation = declared.continuation && typeof declared.continuation === 'object'
    ? declared.continuation
    : data.continuation && typeof data.continuation === 'object'
      ? data.continuation
      : null
  const continuationReason = normalizedIdentity(continuation?.reason).toLowerCase()
  const clipped = declared.clipped === true || data.clipped === true
  const artifactId = normalizedIdentity(
    declared.artifact_id ?? data.artifact_id ?? result?.toolOutput?.artifact_id
  )
  const sourceId = normalizedIdentity(declared.source_id ?? data.source_id)
  const message = tidy(result?.message)
  const messageIncomplete = /coverage\s*[:=]\s*(?:none|partial|incomplete)|(?:本次读取|正文|内容|结果|输出|页面).{0,24}(?:已截断|不完整)|尚未读取|未包含的部分|仅返回部分结果|已忽略.{0,20}(?:页|结果)|\b(?:truncated|incomplete|partial coverage|coverage none)\b/i.test(message)
  const projectionCoverageIncomplete = /^(?:artifact_preview|artifact_range|unresumable_preview)$/.test(coverage)
  let requestedRangeComplete = normalized.requested_range_complete
  let projectionComplete = normalized.projection_complete
  let sourceComplete = normalized.source_complete
  if (requestedRangeComplete === null && (messageIncomplete || /^(?:none|partial|incomplete)$/.test(coverage) || /(?:PARTIAL|INCOMPLETE)/i.test(result?.code))) {
    requestedRangeComplete = false
  }
  if (projectionComplete === null && projectionCoverageIncomplete) projectionComplete = false
  // Legacy read-only results without completeness fields remain usable unless
  // they carry an explicit partial marker. New results never take this path.
  if (requestedRangeComplete === null) requestedRangeComplete = !messageIncomplete && !projectionCoverageIncomplete
  if (projectionComplete === null) projectionComplete = !projectionCoverageIncomplete
  const windowEvidence = continuationReason === 'source_window' || coverage === 'source_window'
  const sourceUnusable = sourceComplete === false && !windowEvidence
  const explicitlyIncomplete = requestedRangeComplete !== true || projectionComplete !== true || sourceUnusable || clipped && projectionCoverageIncomplete
  const hasPayload = !!message.trim() || !!result?.imageDataUrl || !!result?.imageDataUrls?.length || result?.data != null
  const hardFailure = result?.ok !== true
  const usable = !hardFailure && hasPayload && !explicitlyIncomplete
  return {
    usable,
    complete: requestedRangeComplete === true && projectionComplete === true,
    requestedRangeComplete,
    sourceComplete,
    projectionComplete,
    coverage: coverage || null,
    clipped,
    artifactId: artifactId || null,
    sourceId: sourceId || null,
    continuationReason: continuationReason || null,
    hardFailure,
    progress: !hardFailure && !usable && hasPayload
  }
}

const SOURCE_FAILURE_CLASSES = Object.freeze({
  ACCESS_BLOCKED: ['access_blocked', 'alternate_target', true, 'source_access_blocked', 0, 2],
  USER_DECLINED: ['user_declined', 'none', true, 'permission_declined', 0, 0],
  TARGET_RETRY_FORBIDDEN: ['safety_blocked', 'none', true, 'source_access_blocked', 0, 0],
  SOURCE_RECOVERY_EXHAUSTED: ['unavailable', 'none', false, 'source_unavailable', 0, 0]
})

const sourceFailureDisposition = (result, grounding) => {
  const code = String(result?.code || 'TOOL_FAILED')
  const exact = SOURCE_FAILURE_CLASSES[code]
  let values = exact
  if (!values && /(?:INVALID|RANGE|CURSOR)/.test(code)) values = ['invalid_input', 'same_target', false, 'source_unavailable', 1, 0]
  else if (!values && /(?:NOT_FOUND|NO_RESULTS|NO_CONTENT|MISSING)/.test(code)) values = ['not_found', 'alternate_target', false, 'source_not_found', 0, 2]
  else if (!values && (grounding && !grounding.usable && !grounding.hardFailure || /(?:PARTIAL|INCOMPLETE|TRUNCATED)/.test(code))) values = ['incomplete', 'same_or_alternate', false, 'source_incomplete', 3, 1]
  else if (!values && /(?:UNAVAILABLE|UNSUPPORTED)/.test(code)) values = ['unavailable', 'alternate_target', false, 'source_unavailable', 0, 2]
  else if (!values && result?.retryable === true) values = ['transient', 'same_or_alternate', false, 'source_temporarily_unavailable', 1, 2]
  else if (!values) values = ['unknown', 'alternate_target', false, 'source_unavailable', 0, 1]
  return Object.freeze({
    class: values[0],
    recovery_scope: values[1],
    target_locked: values[2],
    public_reason: values[3],
    same_target_budget: values[4],
    alternative_budget: values[5]
  })
}

const sourceObligationSnapshot = (obligation) => obligation
  ? Object.freeze({
      obligation_id: obligation.id,
      status: obligation.status,
      resolution_policy: obligation.resolutionPolicy,
      remaining: Object.freeze({
        same_target: Math.max(0, obligation.sameTargetRemaining),
        alternatives: Math.max(0, obligation.alternativesRemaining),
        forced_replans: Math.max(0, obligation.forcedReplansRemaining)
      })
    })
  : null

const sourceEntryForObligation = (ledger, obligation) => ledger.entries.find((entry) => entry.index === obligation?.createdBy) || null

const syncSourceObligations = (ledger) => {
  for (const obligation of ledger.groundingObligations || []) {
    if (obligation.status !== 'open') continue
    const source = sourceEntryForObligation(ledger, obligation)
    if (source?.resolvedBy) {
      obligation.status = 'resolved'
      obligation.resolvedBy = source.resolvedBy
      continue
    }
    if (
      obligation.providerRounds > obligation.maxProviderRounds ||
      obligation.sameTargetRemaining <= 0 && obligation.alternativesRemaining <= 0 && obligation.forcedReplansRemaining <= 0
    ) obligation.status = 'exhausted'
  }
}

let obligationSequence = 0
const createSourceObligation = (ledger, entry, disposition, policyTarget) => {
  const obligation = {
    id: `obl-${Date.now().toString(36)}-${++obligationSequence}`,
    createdBy: entry.index,
    status: disposition.recovery_scope === 'none' ? 'terminal' : 'open',
    resolutionPolicy: disposition.recovery_scope === 'same_target' ? 'exact_source' : 'declared_alternative',
    failure: disposition,
    logicalTarget: entry.logicalTarget,
    family: entry.family,
    policyTarget,
    sameTargetRemaining: disposition.same_target_budget,
    alternativesRemaining: disposition.alternative_budget,
    forcedReplansRemaining: disposition.recovery_scope === 'none' ? 0 : 1,
    providerRounds: 0,
    maxProviderRounds: 4,
    attempts: [entry.index],
    resolvedBy: null
  }
  ledger.groundingObligations.push(obligation)
  entry.obligationId = obligation.id
  if (disposition.target_locked && policyTarget) ledger.groundingTargetLocks.set(policyTarget, obligation.id)
  return obligation
}

const openSourceObligation = (ledger, id) => (ledger.groundingObligations || [])
  .find((obligation) => obligation.id === id && obligation.status === 'open') || null

const sourceAttemptError = (code, message, obligation = null) => ({
  ok: false,
  input: null,
  obligation,
  error: {
    code,
    retryable: false,
    message,
    failure: sourceFailureDisposition({ code, retryable: false }, { hardFailure: true }),
    sourceRecovery: sourceObligationSnapshot(obligation)
  }
})

export const prepareGroundingAttempt = (ledger, name, input = {}) => {
  const cleanInput = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {}
  const recoveryFor = normalizedIdentity(cleanInput.recovery_for)
  delete cleanInput.recovery_for
  if (!GROUNDING_TOOLS.has(name)) return { ok: true, input: cleanInput, control: null }
  syncSourceObligations(ledger)
  const logicalTarget = groundingTargetOf(name, cleanInput, ledger.documentId)
  const policyTarget = groundingPolicyTargetOf(name, cleanInput, ledger.documentId)
  let obligation = null
  if (recoveryFor) {
    obligation = openSourceObligation(ledger, recoveryFor)
    if (!obligation) return sourceAttemptError('SOURCE_RECOVERY_INVALID', '来源恢复引用无效、已结束或不属于本轮任务。')
  } else {
    obligation = [...(ledger.groundingObligations || [])].reverse().find((item) => (
      item.status === 'open' && item.logicalTarget === logicalTarget && item.family === familyOf(name)
    )) || null
  }
  const lockedBy = ledger.groundingTargetLocks.get(policyTarget)
  if (lockedBy) {
    return sourceAttemptError('TARGET_RETRY_FORBIDDEN', '该来源目标已被安全策略锁定；不得通过修改查询参数或其他参数重试同一目标。', openSourceObligation(ledger, lockedBy) || obligation)
  }
  if (!obligation) return { ok: true, input: cleanInput, control: null }
  const sameTarget = obligation.logicalTarget === logicalTarget && obligation.family === familyOf(name)
  const kind = sameTarget ? 'same_target' : 'alternative'
  if (kind === 'same_target' && obligation.sameTargetRemaining <= 0) {
    return sourceAttemptError('SOURCE_RECOVERY_EXHAUSTED', '同一来源目标的有限重试预算已用尽；请改用明确的替代来源。', obligation)
  }
  if (kind === 'alternative' && obligation.alternativesRemaining <= 0) {
    return sourceAttemptError('SOURCE_RECOVERY_EXHAUSTED', '替代来源的有限尝试预算已用尽。', obligation)
  }
  return {
    ok: true,
    input: cleanInput,
    control: { obligationId: obligation.id, kind, logicalTarget, policyTarget }
  }
}

export const beginSourceRecoveryProviderRound = (ledger) => {
  for (const obligation of ledger.groundingObligations || []) {
    if (obligation.status === 'open') obligation.providerRounds += 1
  }
  syncSourceObligations(ledger)
}

export const sourceRecoveryPending = (ledger) => {
  syncSourceObligations(ledger)
  return (ledger.groundingObligations || []).some((obligation) => obligation.status === 'open')
}

export const consumeSourceRecoveryNoToolReplan = (ledger) => {
  syncSourceObligations(ledger)
  const pending = (ledger.groundingObligations || []).filter((obligation) => obligation.status === 'open' && obligation.forcedReplansRemaining > 0)
  if (!pending.length) return false
  for (const obligation of pending) obligation.forcedReplansRemaining -= 1
  return true
}

export const buildSourceRecoveryConstraint = (ledger, { forced = false } = {}) => {
  syncSourceObligations(ledger)
  const pending = (ledger.groundingObligations || []).filter((obligation) => obligation.status === 'open').slice(0, 4)
  const lines = pending.map((obligation) => {
    const remaining = sourceObligationSnapshot(obligation).remaining
    return `${obligation.id}: same_target=${remaining.same_target}, alternatives=${remaining.alternatives}`
  })
  return `[Knote 内部来源恢复：需要重新规划]
仍有未解决的来源证据，不能依据空结果、截断内容或猜测结束。${forced ? '上一回合没有调用来源工具，系统仅再提供这一次强制重规划机会。' : ''}
可恢复项：${lines.join('；') || '无'}。
retryable 只表示能否重试同一目标；即使 retryable=false，source_recovery 仍可能允许换来源。换来源时必须把对应 obligation_id 原样放入只读来源工具的 recovery_for。target_locked 的目标不得通过修改 query、URL 参数或其他参数重试。不要向用户展示 obligation_id 或内部工具名。`
}

const resolveLatestMatchingFailure = (entries, entry, predicate) => {
  for (let index = entries.length - 2; index >= 0; index--) {
    const old = entries[index]
    if (old.resolvedBy || !old.retryable || old.name !== entry.name || old.target !== entry.target) continue
    if (!predicate(old)) continue
    old.resolvedBy = entry.index
    return old
  }
  return null
}

const batchAccounting = (result) => {
  const completed = normalizedPathList(
    result?.mutation?.sourcePaths ?? result?.verification?.completedSourcePaths ?? result?.data?.completed
  )
  const unresolved = normalizedPathList([
    ...(Array.isArray(result?.data?.failed) ? result.data.failed : []),
    ...(Array.isArray(result?.data?.aborted) ? result.data.aborted : [])
  ])
  const declared = Array.isArray(result?.data?.failed) && Array.isArray(result?.data?.aborted)
  return { completed, unresolved, declared }
}
const batchRetryKey = (input = {}) => JSON.stringify({
  task: normalizedIdentity(input.task),
  sharedStyle: normalizedIdentity(input.shared_style),
  outputSuffix: normalizedIdentity(input.output_suffix == null ? '-复习资料' : input.output_suffix)
})

const resolveBatchChildren = (entries, entry) => {
  if (entry.name !== 'batch_process' || !entry.mutation?.verified || !entry.batchCompletedPaths.length) return
  const completed = new Set(entry.batchCompletedPaths)
  for (let index = 0; index < entries.length - 1; index++) {
    const old = entries[index]
    if (old.name !== 'batch_process' || old.resolvedBy || old.batchRetryKey !== entry.batchRetryKey || !old.batchUnresolvedPaths?.length) continue
    const repaired = old.batchUnresolvedPaths.filter((path) => completed.has(path))
    if (!repaired.length) continue
    old.batchResolvedPaths = [...new Set([...(old.batchResolvedPaths || []), ...repaired])]
    old.batchUnresolvedPaths = old.batchUnresolvedPaths.filter((path) => !completed.has(path))
    if (!old.batchUnresolvedPaths.length) old.resolvedBy = entry.index
  }
}

const groundingResolutionMatches = (old, entry) => {
  if (!old.grounding || old.grounding.usable || old.resolvedBy || !entry.grounding?.usable) return false
  const oldArtifact = old.grounding.artifactId
  const newArtifact = entry.grounding.artifactId
  const sameArtifact = !!oldArtifact && oldArtifact === newArtifact
  const sameSource = !!old.grounding.sourceId && old.grounding.sourceId === entry.grounding.sourceId && old.target === entry.target
  if (old.grounding.hardFailure) {
    const missingArtifactSource = old.name === 'read_tool_output' &&
      ['ARTIFACT_MISSING', 'ARTIFACT_STALE', 'ARTIFACT_CORRUPT'].includes(old.code) &&
      old.recoverySourceTarget && old.recoverySourceTarget === entry.logicalTarget
    if (missingArtifactSource) return true
    return old.family === entry.family && old.logicalTarget === entry.logicalTarget
  }
  if (old.grounding.coverage === 'artifact_preview' && oldArtifact) {
    if (entry.name === 'read_tool_output' && sameArtifact) {
      return old.grounding.requestedRangeComplete === true &&
        entry.grounding.requestedRangeComplete === true &&
        entry.grounding.projectionComplete === true
    }
    return sameSource && entry.name !== 'read_tool_output'
  }
  if (oldArtifact) return sameArtifact || (sameSource && entry.name !== 'read_tool_output')
  return old.family === entry.family && old.target === entry.target
}

const resolveMatchingGroundingEntries = (entries, entry) => {
  const completedSourceBridges = []
  for (let index = 0; index < entries.length - 1; index++) {
    const old = entries[index]
    if (!groundingResolutionMatches(old, entry)) continue
    old.resolvedBy = entry.index
    if (entry.name === 'read_tool_output' && old.name !== 'read_tool_output' && old.grounding?.sourceId) {
      completedSourceBridges.push(old)
    }
  }
  // A source continuation can itself exceed the provider projection and become
  // an artifact preview. Completing that exact artifact makes the intervening
  // source read usable, so it may now resolve earlier partial pages from the
  // same source. The artifact entry alone never gains another tool's family.
  for (const bridge of completedSourceBridges) {
    const completedBridge = {
      ...bridge,
      grounding: {
        ...bridge.grounding,
        usable: true,
        complete: bridge.grounding.requestedRangeComplete === true,
        projectionComplete: true
      }
    }
    for (let index = 0; index < bridge.index - 1; index++) {
      const old = entries[index]
      if (groundingResolutionMatches(old, completedBridge)) old.resolvedBy = entry.index
    }
  }
}

let runSeq = 0
export const createExecutionLedger = ({ instruction = '', documentId = '', documentRevision = '' } = {}) => ({
  id: `run-${Date.now()}-${++runSeq}`,
  instruction: tidy(instruction),
  documentId: tidy(documentId),
  documentRevision: tidy(documentRevision),
  startedAt: Date.now(),
  entries: [],
  groundingObligations: [],
  groundingTargetLocks: new Map()
})

export const recordToolExecution = (ledger, { callId = '', name = '', input = {}, result, synthetic = false, sourceRecoveryControl = null } = {}) => {
  const normalized = normalizeToolResult(name, result)
  const family = familyOf(name)
  const grounding = groundingMetadata(name, normalized)
  const logicalTarget = targetOf(name, input, normalized.mutation, ledger.documentId)
  const recoverySourceTarget = normalized?.data?.recovery_source_target
    ? String(normalized.data.recovery_source_target)
    : ''
  const target = grounding?.sourceId
    ? `source:${grounding.sourceId}`
    : logicalTarget
  const batch = name === 'batch_process' ? batchAccounting(normalized) : null
  const entry = {
    index: ledger.entries.length + 1,
    callId: tidy(callId),
    name: tidy(name),
    input,
    ok: normalized.ok,
    code: normalized.code,
    retryable: !!normalized.retryable,
    message: boundedEvidenceText(normalized.message, 1200, 'LEDGER_MESSAGE'),
    mutation: normalized.mutation || null,
    verification: normalized.verification || null,
    grounding,
    target,
    logicalTarget,
    recoverySourceTarget,
    family,
    failure: normalized.failure || null,
    sourceRecovery: normalized.sourceRecovery || null,
    obligationId: sourceRecoveryControl?.obligationId || null,
    recoveryKind: sourceRecoveryControl?.kind || null,
    synthetic: !!synthetic,
    batchCompletedPaths: batch?.completed || [],
    batchUnresolvedPaths: batch?.unresolved || [],
    batchResolvedPaths: [],
    batchAccountingComplete: batch?.declared === true,
    batchRetryKey: batch ? batchRetryKey(input) : '',
    resolvedBy: null,
    at: Date.now()
  }
  ledger.entries.push(entry)
  let obligation = sourceRecoveryControl?.obligationId
    ? openSourceObligation(ledger, sourceRecoveryControl.obligationId)
    : normalized.sourceRecovery?.obligation_id
      ? openSourceObligation(ledger, normalized.sourceRecovery.obligation_id)
      : null
  if (obligation && !entry.obligationId) entry.obligationId = obligation.id
  if (obligation && sourceRecoveryControl) {
    obligation.attempts.push(entry.index)
    if (sourceRecoveryControl.kind === 'same_target') obligation.sameTargetRemaining -= 1
    else obligation.alternativesRemaining -= 1
  }
  if (entry.ok && entry.mutation && entry.mutation.verified === true) {
    if (entry.name === 'batch_process') resolveBatchChildren(ledger.entries, entry)
    else {
      resolveLatestMatchingFailure(ledger.entries, entry, (old) => (
        PRODUCTIVE_MUTATION_TOOLS.has(old.name) && !old.ok
      ))
    }
  }
  if (grounding?.usable) {
    resolveMatchingGroundingEntries(ledger.entries, entry)
    if (obligation && !entry.resolvedBy) {
      const source = sourceEntryForObligation(ledger, obligation)
      if (source && !source.resolvedBy) source.resolvedBy = entry.index
      obligation.status = 'resolved'
      obligation.resolvedBy = entry.index
    }
  } else if (GROUNDING_TOOLS.has(name) && (grounding?.hardFailure || grounding && !grounding.usable)) {
    const disposition = normalized.failure || sourceFailureDisposition(normalized, grounding)
    entry.failure = disposition
    if (!obligation && !synthetic) obligation = createSourceObligation(
      ledger,
      entry,
      disposition,
      groundingPolicyTargetOf(name, input, ledger.documentId)
    )
    entry.sourceRecovery = sourceObligationSnapshot(obligation)
  }
  syncSourceObligations(ledger)
  return entry
}

export const ledgerEvidence = (ledger) => ({
  run_id: ledger.id,
  document_id: ledger.documentId,
  entries: ledger.entries.map((e) => ({
    step: e.index,
    tool: e.name,
    ok: e.ok,
    code: e.code,
    retryable: e.retryable,
    resolved_by: e.resolvedBy,
    target: e.target,
    message: boundedEvidenceText(e.message, 360, 'LEDGER_EVIDENCE'),
    mutation: e.mutation,
    verification: e.verification,
    grounding: e.grounding,
    failure: e.failure,
    source_recovery: e.sourceRecovery,
    batch_unresolved_paths: e.batchUnresolvedPaths,
    batch_resolved_paths: e.batchResolvedPaths
  }))
})

export const runOutcome = (ledger) => {
  const attempts = ledger.entries.filter((e) => PRODUCTIVE_MUTATION_TOOLS.has(e.name) && !e.synthetic)
  const successes = attempts.filter((e) => e.ok && e.mutation && e.mutation.verified === true)
  const failures = attempts.filter((e) => {
    if (!e.ok) return !e.resolvedBy
    if (e.name === 'batch_process') {
      if (e.resolvedBy) return false
      if (e.batchUnresolvedPaths.length) return true
      return !e.batchAccountingComplete && (
        /(?:PARTIAL|INTERRUPTED)/i.test(e.code) ||
        Number(e.verification?.failed) > 0 ||
        Number(e.verification?.aborted) > 0
      )
    }
    return /PARTIAL/i.test(e.code) || Number(e.verification?.failed) > 0
  })
  const stagedIds = [...new Set(successes.flatMap((e) => (e.mutation && e.mutation.hunkIds) || []))]
  const pendingFileIds = [...new Set(successes
    .filter((entry) => entry.mutation?.type === 'pending_file_hunk')
    .flatMap((entry) => entry.mutation.hunkIds || []))]
  const direct = successes.filter((e) => e.mutation && !String(e.mutation.type || '').startsWith('pending_'))
  const status = !attempts.length ? 'none' : successes.length
    ? (failures.length ? 'partial' : 'success')
    : 'failed'
  return { status, attempts, successes, failures, stagedIds, pendingFileIds, direct }
}

export const groundingOutcome = (ledger) => {
  syncSourceObligations(ledger)
  const attempts = ledger.entries.filter((entry) => GROUNDING_TOOLS.has(entry.name))
  const successes = attempts.filter((entry) => entry.grounding?.usable)
  const failures = attempts.filter((entry) => entry.grounding?.hardFailure && !entry.resolvedBy)
  const pending = attempts.filter((entry) => entry.grounding && !entry.grounding.usable && !entry.grounding.hardFailure && !entry.resolvedBy)
  const unresolved = [...failures, ...pending].sort((left, right) => left.index - right.index)
  const retryableFailures = failures.filter((entry) => entry.retryable)
  const status = !attempts.length
    ? 'none'
    : unresolved.length
      ? (successes.length ? 'partial' : failures.length ? 'failed' : 'incomplete')
      : 'success'
  const obligations = ledger.groundingObligations || []
  const replanAllowed = obligations.some((obligation) => obligation.status === 'open')
  return { status, attempts, successes, failures, pending, unresolved, retryableFailures, obligations, replanAllowed }
}

const SUCCESS_CLAIM = /(?:已经|已|成功)(?:为你|替你|把|将|对)?(?:全部|均|都)?(?:完成|提交|暂存|修改|更新|插入|创建|写入|生成|润色|改写|移动|重命名|删除|下载|保存|改好|做好|处理好)|(?:任务|处理|工作|文件).{0,10}(?:已经|已).{0,8}(?:全部|均|都)?(?:完成|成功|做好)|(?:全部|均|都).{0,8}(?:已经|已)?(?:完成|成功|做好|处理好)|(?:修改|更新|润色|改写|改动)(?:已经)?(?:完成|成功|做好|生效)|(?:修改|更新|处理|整理|写入|插入|创建|删除|下载|移动|重命名|保存)(?:好|完|完成)了|(?:搞定|完成)了|(?:修改|改动).{0,12}(?:现在|已经).{0,8}(?:显示|生效)|(?:下载|保存).{0,12}(?:成功|完成|好了)|(?:文件|资料|报告).{0,12}(?:下载|保存)(?:成功|完成|好了)|\b(?:i(?:'ve| have)?|successfully)\s+(?:edited|updated|modified|inserted|created|written|submitted|staged|renamed|moved|deleted|downloaded|saved|completed)\b|\b(?:i\s+)?downloaded\s+(?:the\s+|your\s+)?(?:file|report|document)\b|\b(?:all|every).{0,28}(?:completed|updated|edited|processed|downloaded|done|succeeded)\b|\b(?:it(?:'s| is)|everything(?:'s| is))\s+done\b|\b(?:the\s+)?(?:task|work|request)\s+is\s+(?:complete|done|finished|successful)\b|\bchanges? (?:have been|were) (?:applied|submitted|staged|made|saved)\b/i
const MUTATION_INTENT = /(?:修改|润色|改写|插入|更新|编辑|删除|下载|重命名|移动|优化|修正|调整|精简|扩写|翻译)(?:一下|下|这段|全文|当前|它|吧|好|掉|成|为|到|进|在|.{0,20}(?:文档|文件|笔记|内容))?|(?:在|到|进).{0,8}(?:文档|文件|笔记).{0,12}(?:修改|润色|改写|插入|写入|更新|添加|删除|下载)|(?:创建|新建|生成).{0,10}(?:文件|文件夹|文档)|\b(?:edit|modify|update|rewrite|polish|condense|expand|translate|insert into|write to|delete|download|rename|move|create)\b(?:\s+(?:this|it|the text)|.{0,30}\b(?:document|file|note|folder)\b)/i
const DOWNLOAD_INTENT = /(?:请|帮我|替我|给我|麻烦|需要你|我要你).{0,24}下载.{0,36}(?:文件|文档|报告|资料|附件|pdf|网址|链接)|^下载.{0,40}(?:文件|文档|报告|资料|附件|pdf|网址|链接)|(?:请|帮我|替我|给我|麻烦|需要你|我要你).{0,24}(?:保存.{0,36}(?:附件|https?:\/\/|网址|链接)|(?:https?:\/\/|网址|链接).{0,24}保存)|^保存.{0,40}(?:附件|https?:\/\/|网址|链接)|\b(?:please\s+|can you\s+|could you\s+|i (?:want|need) you to\s+)?download\b.{0,48}\b(?:file|document|report|attachment|pdf|url)\b|^(?:please\s+|can you\s+|could you\s+|i (?:want|need) you to\s+)?save\b.{0,80}(?:https?:\/\/|\b(?:url|link|attachment)\b)/i
const DOWNLOAD_ADVICE = /(?:如何|怎么|怎样).{0,20}(?:下载|保存)|\bhow\s+(?:do|can|should)\s+[^?.]{0,40}\bdownload\b|\bhow\s+to\s+download\b/i
const DOWNLOAD_SUCCESS_CLAIM = /\b(?:download|save)(?:\s+was|\s+is)?\s+(?:successful|complete|completed|done|finished)\b|\b(?:downloaded|saved)\b.{0,30}\b(?:it|file|document|report|attachment|pdf)\b/i

export const hasMutationSuccessClaim = (text) => SUCCESS_CLAIM.test(tidy(text))
export const requiresMutationEvidence = (ledger) => {
  const outcome = runOutcome(ledger)
  return outcome.attempts.length > 0 || MUTATION_INTENT.test(tidy(ledger.instruction))
}

const seemsEnglish = (text) => {
  const s = tidy(text)
  const ascii = (s.match(/[A-Za-z]/g) || []).length
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length
  return ascii > cjk * 2
}

const lastFailureMessage = (outcome) => {
  const last = outcome.failures[outcome.failures.length - 1]
  return last && tidy(last.message).trim()
}

// This text is fed back to the model, never shown as an assistant answer.
// It turns the deterministic completion gate into a recovery loop instead of
// merely replacing a hallucinated success claim after the run has ended.
export const buildMutationRetryFeedback = (ledger) => {
  const outcome = runOutcome(ledger)
  const last = lastFailureMessage(outcome)
  if (outcome.successes.length && outcome.failures.length) {
    return `[Knote 内部执行校验：仍有未完成项]
执行账本仍有未解决的修改失败。不要向用户解释这条内部校验，也不要重复已经成功的操作。
请只针对失败目标继续处理；修改工具只有 ok=true 且 mutation.verified=true 才算成功。${last ? `\n最近一次未解决的工具反馈：${last}` : ''}
如果客观上无法继续，请明确告诉用户哪些已完成、哪些未完成及具体原因，不能笼统声称全部完成。`
  }
  return `[Knote 内部执行校验：需要继续处理]
执行账本中没有任何通过后置验证的有效改动。不要向用户解释这条内部校验，也不要重复完成声明。
请重新检查原始请求和工具结果，调用合适的读取/修改工具补做；修改工具只有 ok=true 且 mutation.verified=true 才算成功。${last ? `\n最近一次未解决的工具反馈：${last}` : '\n本轮尚未产生有效的修改工具调用。'}
如果缺少路径、目标文件或用户选择，调用 ask_user 提问；如果客观上无法继续，简洁说明具体阻碍，不要声称已经完成。`
}

export const buildUserFailureReport = (ledger, fallbackText = '') => {
  const outcome = runOutcome(ledger)
  const english = seemsEnglish(ledger.instruction || fallbackText)
  const last = lastFailureMessage(outcome)
  if (outcome.successes.length && outcome.failures.length) {
    if (english) {
      return last
        ? `The task was only partially completed. The remaining operation reported: ${last}`
        : 'The task was only partially completed; one or more requested changes still need attention.'
    }
    return last
      ? `这项任务只完成了一部分。尚未完成的操作反馈：${last}`
      : '这项任务只完成了一部分，仍有请求的改动尚未成功。'
  }
  if (english) {
    return last
      ? `I couldn't apply the requested change. The last operation reported: ${last}`
      : `I couldn't apply the requested change. Please try again or provide the missing target details.`
  }
  return last
    ? `这次修改没能实际写入。最后一次操作反馈：${last}`
    : '这次修改没能实际写入。请重试一次，或补充需要修改的目标位置。'
}

const lastGroundingFailure = (outcome) => outcome.unresolved[outcome.unresolved.length - 1] || null

export const buildGroundingRetryFeedback = (ledger) => {
  const outcome = groundingOutcome(ledger)
  const last = lastGroundingFailure(outcome)
  const reacquire = last?.recoverySourceTarget
    ? `\n该 artifact 已不可用，禁止继续重试同一 artifact_id。请重新调用原只读来源工具取得 ${last.recoverySourceTarget}，再使用新结果或新 artifact；不要重放修改、下载、命令或代码执行。`
    : ''
  return `[Knote 内部事实校验：需要重新取得证据]
本轮仍有未解决的来源失败或尚未完整暴露给你的内容，不能依据空结果、截断预览、局部范围或模型自身猜测回答。不要向用户解释这条内部校验。
同一来源续读仍必须保持 exact source/artifact/cursor。若工具结果给出 source_recovery，可在预算内改用替代来源，并把 obligation_id 原样作为 recovery_for；没有该引用的不同路径、网址、查询或附件不会解决原目标。target_locked 的目标不得通过修改参数重试。${reacquire}${last?.message ? `\n最近一次来源反馈：${last.message}` : ''}
如果仍无法读取，请停止猜测并如实报告来源失败。`
}

const publicGroundingFailureText = (entry, english) => {
  const reason = entry?.failure?.public_reason || (entry?.grounding?.hardFailure ? 'source_unavailable' : 'source_incomplete')
  const copy = {
    source_access_blocked: ['The requested source was blocked by the safety policy.', '目标来源因安全策略无法访问。'],
    source_temporarily_unavailable: ['The requested source is temporarily unavailable.', '资料来源暂时无法访问。'],
    source_incomplete: ['The source content could not be read completely.', '资料内容未能完整读取。'],
    source_not_found: ['The requested source could not be found.', '没有找到所需的资料来源。'],
    permission_declined: ['The related operation was not authorized.', '相关操作未获授权。'],
    source_unavailable: ['The requested source could not be read.', '所需资料来源无法读取。']
  }
  const selected = copy[reason] || copy.source_unavailable
  return selected[english ? 0 : 1]
}

export const buildGroundingFailureReport = (ledger, fallbackText = '') => {
  const outcome = groundingOutcome(ledger)
  const last = lastGroundingFailure(outcome)
  const english = seemsEnglish(ledger.instruction || fallbackText)
  const detail = publicGroundingFailureText(last, english)
  if (english) {
    return `I couldn't verify the requested facts. ${detail}`
  }
  return `这次未能取得可核验的来源内容。${detail}`
}

export const buildGroundingWarning = (ledger, fallbackText = '') => {
  const outcome = groundingOutcome(ledger)
  const english = seemsEnglish(ledger.instruction || fallbackText)
  const unavailable = outcome.unresolved.length
  const usable = outcome.successes.length
  if (english) {
    return `[Source status] Kept this answer, but ${unavailable} requested source${unavailable === 1 ? '' : 's'} remained unavailable or incomplete${usable ? `; ${usable} usable source${usable === 1 ? '' : 's'} were retained` : ''}. Treat unsupported details as unverified.`
  }
  return `【来源状态】已保留本次回复，但仍有 ${unavailable} 个请求来源不可用或未读完整${usable ? `；已保留 ${usable} 个可用来源` : ''}。缺少来源支撑的细节应视为未核验。`
}

export const guardFinalReport = (text, ledger) => {
  const outcome = runOutcome(ledger)
  const claimed = hasMutationSuccessClaim(text)
  const mutationExpected = requiresMutationEvidence(ledger)
  if (outcome.attempts.length && (outcome.status === 'failed' || outcome.status === 'partial')) {
    return {
      blocked: true,
      reason: outcome.status === 'partial' ? 'unresolved_partial_failure' : 'mutation_failed',
      retryable: outcome.failures.some((entry) => entry.retryable),
      text: buildUserFailureReport(ledger, text)
    }
  }
  const downloadExpected = DOWNLOAD_INTENT.test(tidy(ledger.instruction)) && !DOWNLOAD_ADVICE.test(tidy(ledger.instruction))
  const verifiedDownload = outcome.successes.some((entry) => entry.name === 'download_file')
  if (downloadExpected && (claimed || DOWNLOAD_SUCCESS_CLAIM.test(tidy(text))) && !verifiedDownload) {
    return {
      blocked: true,
      reason: 'missing_verified_download',
      retryable: true,
      text: buildUserFailureReport(ledger, text)
    }
  }
  if (mutationExpected && claimed && !outcome.successes.length) {
    return {
      blocked: true,
      reason: 'missing_verified_mutation',
      retryable: true,
      text: buildUserFailureReport(ledger, text)
    }
  }
  const grounding = groundingOutcome(ledger)
  if (grounding.unresolved.length) {
    const answer = tidy(text)
    const warning = buildGroundingWarning(ledger, answer)
    return {
      blocked: false,
      reason: 'grounding_incomplete',
      retryable: false,
      replanAllowed: false,
      groundingIncomplete: true,
      text: answer
        ? (/\[(?:Source status)\]|【来源状态】/.test(answer) ? answer : `${answer}\n\n${warning}`)
        : buildGroundingFailureReport(ledger, text)
    }
  }
  return { blocked: false, text: tidy(text) }
}

export const buildRunReceipt = (ledger, { claimBlocked = false, blockReason = '' } = {}) => {
  const outcome = runOutcome(ledger)
  const grounding = groundingOutcome(ledger)
  if (outcome.status === 'none' && grounding.status === 'none' && !claimBlocked) return null
  const receipt = {
    status: claimBlocked ? 'blocked' : outcome.status,
    attempts: outcome.attempts.length,
    successful: outcome.successes.length,
    failed: outcome.failures.length,
    staged: outcome.stagedIds.length,
    hunkIds: outcome.stagedIds,
    pendingFileHunkIds: outcome.pendingFileIds,
    acceptedHunkIds: [],
    rejectedHunkIds: [],
    direct: outcome.direct.length,
    claimBlocked: !!claimBlocked,
    blockReason: claimBlocked ? tidy(blockReason) : '',
    runId: ledger.id,
    durability: outcome.pendingFileIds.length ? 'pending_review_not_saved' : null
  }
  if (grounding.status !== 'none') {
    receipt.grounding = {
      status: grounding.status,
      attempts: grounding.attempts.length,
      successful: grounding.successes.length,
      failed: grounding.failures.length,
      incomplete: grounding.pending.length,
      retryable: grounding.retryableFailures.length + grounding.pending.length,
      replanAllowed: grounding.replanAllowed,
      obligations: grounding.obligations.filter((obligation) => obligation.status !== 'resolved').slice(-12).map((obligation) => ({
        status: obligation.status,
        failureClass: obligation.failure.class,
        publicReason: obligation.failure.public_reason
      })),
      sources: grounding.attempts.slice(-24).map((entry) => ({
        tool: entry.name,
        target: entry.target.slice(0, 240),
        ok: !!entry.grounding?.usable,
        code: entry.code,
         coverage: entry.grounding?.coverage || null,
         complete: entry.grounding?.complete,
         requested_range_complete: entry.grounding?.requestedRangeComplete,
         source_complete: entry.grounding?.sourceComplete,
          projection_complete: entry.grounding?.projectionComplete,
          source_id: entry.grounding?.sourceId || null,
          artifact_id: entry.grounding?.artifactId || null,
        hardFailure: entry.grounding?.hardFailure === true,
        resolvedBy: entry.resolvedBy
      }))
    }
  }
  return receipt
}

const toolResultEncoder = new TextEncoder()
const MIRRORED_TOOL_OUTPUT_FIELDS = new Set([
  'body', 'content', 'message', 'next_cursor', 'output', 'raw', 'stderr', 'stdout', 'text', 'transcript'
])

// Once the complete textual result has an artifact, provider-visible structured
// fields must not smuggle a second full copy around the bounded preview.
const sanitizeArtifactizedToolValue = (value, { resumable = true } = {}) => {
  let remainingTextBytes = 4096
  const ancestors = new WeakSet()
  const omitted = (details = {}) => resumable
    ? { artifactized: true, ...details }
    : { omitted: true, resumable: false, reason: 'artifact_capture_failed', ...details }
  const visit = (current, key = '', depth = 0) => {
    if (typeof current === 'string') {
      const bytes = toolResultEncoder.encode(current).byteLength
      const mirrored = MIRRORED_TOOL_OUTPUT_FIELDS.has(String(key).toLowerCase())
      if (mirrored || bytes > 1024 || bytes > remainingTextBytes) {
        return omitted({ utf8_bytes: bytes })
      }
      remainingTextBytes -= bytes
      return current
    }
    if (current == null || typeof current !== 'object') return current
    if (depth >= 6) return omitted({ omitted_reason: 'depth_limit' })
    if (ancestors.has(current)) return omitted({ omitted_reason: 'circular_reference' })
    ancestors.add(current)
    let sanitized
    if (Array.isArray(current)) {
      sanitized = current.slice(0, 32).map((item) => visit(item, key, depth + 1))
      if (current.length > 32) sanitized.push(omitted({ items_omitted: current.length - 32 }))
    } else {
      sanitized = {}
      const entries = Object.entries(current)
      for (const [childKey, childValue] of entries.slice(0, 48)) {
        sanitized[childKey] = visit(childValue, childKey, depth + 1)
      }
      if (entries.length > 48) sanitized.fields_omitted = omitted({ count: entries.length - 48 })
    }
    ancestors.delete(current)
    return sanitized
  }
  return visit(value)
}

const compactRecoveryRange = (range) => {
  if (!range || typeof range !== 'object') return null
  const start = Number(range.start_line ?? range.start)
  const end = Number(range.end_line ?? range.end)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null
  return { start_line: start, end_line: end }
}

// Recovery source text belongs only in the provider-visible `message`. Keep a
// compact receipt here so serializing a result can never duplicate the body.
const compactRecoveryMetadata = (recovery) => {
  if (!recovery || typeof recovery !== 'object') return null
  const compact = {}
  if (recovery.code) compact.code = tidy(recovery.code).slice(0, 120)
  if (recovery.revision) compact.revision = tidy(recovery.revision).slice(0, 160)
  const range = compactRecoveryRange(recovery.range)
  if (range) compact.range = range
  const ranges = (Array.isArray(recovery.ranges) ? recovery.ranges : [])
    .map(compactRecoveryRange)
    .filter(Boolean)
    .slice(0, 12)
  if (ranges.length) compact.ranges = ranges
  const artifacts = [
    ...(recovery.artifact ? [recovery.artifact] : []),
    ...(Array.isArray(recovery.artifacts) ? recovery.artifacts : [])
  ].map((artifact) => ({
    artifact_id: tidy(artifact?.artifact_id ?? artifact?.artifactId).slice(0, 160),
    total_bytes: Number(artifact?.total_bytes ?? artifact?.totalBytes) || undefined,
    sha256: tidy(artifact?.sha256).slice(0, 128) || undefined
  })).filter((artifact) => artifact.artifact_id).slice(0, 12)
  if (artifacts.length === 1) compact.artifact = artifacts[0]
  else if (artifacts.length) compact.artifacts = artifacts
  const provenance = (Array.isArray(recovery.provenance) ? recovery.provenance : [])
    .map((item) => ({
      call_id: tidy(item?.call_id ?? item?.callId).slice(0, 160),
      tool: tidy(item?.tool).slice(0, 80),
      code: tidy(item?.code).slice(0, 120),
      path: tidy(item?.path).slice(0, 1024) || undefined,
      range: compactRecoveryRange(item?.range) || undefined,
      artifact_id: tidy(item?.artifact_id ?? item?.artifactId).slice(0, 160) || undefined,
      synthetic: item?.synthetic === true || undefined
    }))
    .filter((item) => item.call_id || item.tool || item.code)
    .slice(0, 12)
  if (provenance.length) compact.provenance = provenance
  return Object.keys(compact).length ? compact : null
}

export const serializeToolResult = (result) => {
  const incompleteCapture = result.captureWarning?.capture_complete === false
  const recovery = compactRecoveryMetadata(result.recovery)
  const details = result.toolOutput || incompleteCapture
    ? sanitizeArtifactizedToolValue({
        data: result.data || null,
        mutation: result.mutation || null,
        verification: result.verification || null,
        recovery,
        grounding: result.grounding || null,
        failure: result.failure || null,
        source_recovery: result.sourceRecovery || null
      }, { resumable: !!result.toolOutput })
    : {
        data: result.data || null,
        mutation: result.mutation || null,
        verification: result.verification || null,
        recovery,
        grounding: result.grounding || null,
        failure: result.failure || null,
        source_recovery: result.sourceRecovery || null
      }
  const serialized = {
    ok: !!result.ok,
    code: result.code || (result.ok ? 'OK' : 'TOOL_FAILED'),
    retryable: !!result.retryable,
    message: tidy(result.message != null ? result.message : result.text),
    ...details
  }
  if (result.toolOutput) serialized.tool_output = result.toolOutput
  if (result.captureWarning) serialized.capture_warning = result.captureWarning
  return JSON.stringify(serialized)
}
