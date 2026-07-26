// Deterministic execution contract for Knote Agent.
//
// Models may explain a tool result, but they do not get to decide whether an
// operation succeeded. Every result is normalized here, recorded in an
// append-only run ledger, and used to gate completion claims.

export const MUTATION_TOOLS = new Set([
  'replace_lines', 'insert_lines', 'continue_hunk', 'discard_hunks', 'insert_image',
  'create_file', 'create_folder', 'edit_file', 'move_file', 'rename_file',
  'delete_file', 'batch_process'
])

export const PRODUCTIVE_MUTATION_TOOLS = new Set([
  'replace_lines', 'insert_lines', 'continue_hunk', 'insert_image', 'create_file',
  'create_folder', 'edit_file', 'move_file', 'rename_file', 'delete_file',
  'batch_process'
])

const tidy = (value) => String(value == null ? '' : value)

export const toolSuccess = ({ code = 'OK', message = '', data = null, mutation = null, verification = null } = {}) => ({
  ok: true,
  code,
  retryable: false,
  message: tidy(message),
  text: tidy(message),
  data,
  mutation,
  verification
})

export const toolFailure = ({ code = 'TOOL_FAILED', message = '', retryable = false, data = null, verification = null } = {}) => ({
  ok: false,
  code,
  retryable: !!retryable,
  message: tidy(message),
  text: tidy(message),
  data,
  mutation: null,
  verification
})

export const failureFromMessage = (message, overrides = {}) => {
  const text = tidy(message)
  let code = overrides.code || 'TOOL_FAILED'
  let retryable = overrides.retryable
  if (/文档尚未读取|文档.*(?:发生变化|已变化)|重新调用 read_document/i.test(text)) {
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

const LEGACY_FAILURE = /^(?:工具执行失败|错误[:：]|未执行[:：]|操作失败[:：]|请求失败[:：]|检索失败[:：]|搜索失败[:：]|读取失败|读取被拒绝|计算失败[:：]|计算结果无效|版面分析(?:服务)?不可用)/i
const LEGACY_UNAVAILABLE = /^(?:当前没有打开文件夹工作区|当前模型不支持|当前环境不支持|PDF 解析环境未就绪)/i
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

const targetOf = (name, input = {}, mutation = null, documentId = '') => {
  if (/^(?:replace_lines|insert_lines|continue_hunk|discard_hunks|insert_image)$/.test(name)) return `document:${documentId || 'current'}`
  if (mutation && mutation.target) return String(mutation.target)
  if (input.path) return `path:${String(input.path).replace(/\\/g, '/')}`
  return `tool:${name}`
}

const familyOf = (name) => {
  if (/^(?:replace_lines|insert_lines|continue_hunk|insert_image)$/.test(name)) return 'document-edit'
  if (/^(?:create_file|edit_file)$/.test(name)) return 'file-write'
  if (/^(?:move_file|rename_file)$/.test(name)) return 'file-relocate'
  return name
}

let runSeq = 0
export const createExecutionLedger = ({ instruction = '', documentId = '', documentRevision = '' } = {}) => ({
  id: `run-${Date.now()}-${++runSeq}`,
  instruction: tidy(instruction),
  documentId: tidy(documentId),
  documentRevision: tidy(documentRevision),
  startedAt: Date.now(),
  entries: []
})

export const recordToolExecution = (ledger, { callId = '', name = '', input = {}, result, synthetic = false } = {}) => {
  const normalized = normalizeToolResult(name, result)
  const target = targetOf(name, input, normalized.mutation, ledger.documentId)
  const family = familyOf(name)
  const entry = {
    index: ledger.entries.length + 1,
    callId: tidy(callId),
    name: tidy(name),
    input,
    ok: normalized.ok,
    code: normalized.code,
    retryable: !!normalized.retryable,
    message: tidy(normalized.message).slice(0, 1200),
    mutation: normalized.mutation || null,
    verification: normalized.verification || null,
    target,
    family,
    synthetic: !!synthetic,
    resolvedBy: null,
    at: Date.now()
  }
  ledger.entries.push(entry)
  if (entry.ok && entry.mutation && entry.mutation.verified === true) {
    for (const old of ledger.entries) {
      if (old === entry || old.ok || old.resolvedBy || !old.retryable) continue
      if (old.family === family && old.target === target) old.resolvedBy = entry.index
    }
  }
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
    message: e.message.slice(0, 360),
    mutation: e.mutation,
    verification: e.verification
  }))
})

export const runOutcome = (ledger) => {
  const attempts = ledger.entries.filter((e) => PRODUCTIVE_MUTATION_TOOLS.has(e.name) && !e.synthetic)
  const successes = attempts.filter((e) => e.ok && e.mutation && e.mutation.verified === true)
  const failures = attempts.filter((e) => (
    (!e.ok && !e.resolvedBy) ||
    (e.ok && (
      /PARTIAL/i.test(e.code) ||
      Number(e.verification && e.verification.failed) > 0
    ))
  ))
  const stagedIds = [...new Set(successes.flatMap((e) => (e.mutation && e.mutation.hunkIds) || []))]
  const direct = successes.filter((e) => e.mutation && e.mutation.type !== 'pending_hunk' && e.mutation.type !== 'pending_hunk_continued')
  const status = !attempts.length ? 'none' : successes.length
    ? (failures.length ? 'partial' : 'success')
    : 'failed'
  return { status, attempts, successes, failures, stagedIds, direct }
}

const SUCCESS_CLAIM = /(?:已经|已|成功)(?:为你|替你|把|将|对)?(?:全部|均|都)?(?:完成|提交|暂存|修改|更新|插入|创建|写入|生成|润色|改写|移动|重命名|删除|保存|改好|做好|处理好)|(?:任务|处理|工作|文件).{0,10}(?:已经|已).{0,8}(?:全部|均|都)?(?:完成|成功|做好)|(?:全部|均|都).{0,8}(?:已经|已)?(?:完成|成功|做好|处理好)|(?:修改|更新|润色|改写|改动)(?:已经)?(?:完成|成功|做好|生效)|(?:修改|更新|处理|整理|写入|插入|创建|删除|移动|重命名|保存)(?:好|完|完成)了|(?:搞定|完成)了|(?:修改|改动).{0,12}(?:现在|已经).{0,8}(?:显示|生效)|\b(?:i(?:'ve| have)?|successfully)\s+(?:edited|updated|modified|inserted|created|written|submitted|staged|renamed|moved|deleted|saved|completed)\b|\b(?:all|every).{0,28}(?:completed|updated|edited|processed|done|succeeded)\b|\b(?:it(?:'s| is)|everything(?:'s| is))\s+done\b|\bchanges? (?:have been|were) (?:applied|submitted|staged|made|saved)\b/i
const FAILURE_DISCLOSURE = /(?:但|不过|然而|其中|仍有|还有|部分).{0,28}(?:失败|未完成|未成功|没能|无法|未写入|需重试)|(?:失败|未完成|未成功|没能|无法|未写入).{0,28}(?:部分|其中|仍有|还有)|\b(?:but|however|partially|partial|some|one or more).{0,40}\b(?:failed|not completed|could not|unable|remaining)\b|\b(?:failed|not completed|could not|unable|remaining).{0,40}\b(?:part|some|one or more)\b/i
const hasFailureDisclosure = (text) => {
  const value = tidy(text)
  if (FAILURE_DISCLOSURE.test(value)) return true
  const mentionsFailure = /失败|未完成|未成功|没能|无法|未写入|需重试|\bfailed\b|\bnot completed\b|\bcould not\b|\bunable\b/i.test(value)
  const explicitlyNone = /(?:没有|并无|无|零|0\s*(?:个|项)?)(?:任何)?失败|失败\s*[:：=]?\s*0\b|\b(?:no|zero)\s+failures?\b/i.test(value)
  return mentionsFailure && !explicitlyNone
}
const MUTATION_INTENT = /(?:修改|润色|改写|插入|更新|编辑|删除|重命名|移动|优化|修正|调整|精简|扩写|翻译)(?:一下|下|这段|全文|当前|它|吧|好|掉|成|为|到|进|在|.{0,20}(?:文档|文件|笔记|内容))?|(?:在|到|进).{0,8}(?:文档|文件|笔记).{0,12}(?:修改|润色|改写|插入|写入|更新|添加|删除)|(?:创建|新建|生成).{0,10}(?:文件|文件夹|文档)|\b(?:edit|modify|update|rewrite|polish|condense|expand|translate|insert into|write to|delete|rename|move|create)\b(?:\s+(?:this|it|the text)|.{0,30}\b(?:document|file|note|folder)\b)/i

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
你刚才把“部分完成”表述成了“全部完成”，但执行账本仍有未解决的失败。不要向用户解释这条内部校验，也不要重复已经成功的操作。
请只针对失败目标继续处理；修改工具只有 ok=true 且 mutation.verified=true 才算成功。${last ? `\n最近一次未解决的工具反馈：${last}` : ''}
如果客观上无法继续，请明确告诉用户哪些已完成、哪些未完成及具体原因，不能笼统声称全部完成。`
  }
  return `[Knote 内部执行校验：需要继续处理]
你刚才声称修改已经完成，但执行账本中没有任何通过后置验证的有效改动。不要向用户解释这条内部校验，也不要重复完成声明。
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

export const guardFinalReport = (text, ledger) => {
  const outcome = runOutcome(ledger)
  const claimed = hasMutationSuccessClaim(text)
  const mutationExpected = requiresMutationEvidence(ledger)
  const undisclosedPartial = outcome.successes.length > 0 && outcome.failures.length > 0 && !hasFailureDisclosure(text)
  if (mutationExpected && claimed && (!outcome.successes.length || undisclosedPartial)) {
    return {
      blocked: true,
      reason: undisclosedPartial ? 'unresolved_partial_failure' : 'missing_verified_mutation',
      text: buildUserFailureReport(ledger, text)
    }
  }
  return { blocked: false, text: tidy(text) }
}

export const buildRunReceipt = (ledger, { claimBlocked = false } = {}) => {
  const outcome = runOutcome(ledger)
  if (outcome.status === 'none' && !claimBlocked) return null
  return {
    status: claimBlocked ? 'blocked' : outcome.status,
    attempts: outcome.attempts.length,
    successful: outcome.successes.length,
    failed: outcome.failures.length,
    staged: outcome.stagedIds.length,
    hunkIds: outcome.stagedIds,
    acceptedHunkIds: [],
    rejectedHunkIds: [],
    direct: outcome.direct.length,
    claimBlocked: !!claimBlocked,
    runId: ledger.id
  }
}

export const serializeToolResult = (result) => JSON.stringify({
  ok: !!result.ok,
  code: result.code || (result.ok ? 'OK' : 'TOOL_FAILED'),
  retryable: !!result.retryable,
  message: tidy(result.message != null ? result.message : result.text),
  data: result.data || null,
  mutation: result.mutation || null,
  verification: result.verification || null,
  recovery: result.recovery || null
})
