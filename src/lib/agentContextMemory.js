import { estimateAgentTokens } from './tokenEstimate.js'

export const AGENT_MEMORY_VERSION = 1
export const AGENT_MEMORY_KEEP_RECENT = 14
export const AGENT_MEMORY_MAX_CHARS = 12_000

const messageText = (message) => String(message?.text || '').trim()
const coveredAttachmentText = (message) => (
  message?.attachmentMemory?.covered === true && typeof message.attachmentMemory.text === 'string'
    ? message.attachmentMemory.text
    : ''
)
const messageExecutionEvidence = (message) => (
  message?.receipt || message?.recovery || message?.recoveryEvidence || message?.interruptedRunId
)
const usableMessage = (message) => (
  (message?.role === 'user' || message?.role === 'assistant') &&
  !message?.retracted &&
  (!message?.error || !!messageExecutionEvidence(message)) &&
  (
    !!messageText(message) ||
    !!String(message?.selection?.text || '').trim() ||
    !!coveredAttachmentText(message) ||
    !!messageExecutionEvidence(message)
  )
)

const attachmentBarrier = (message) => (
  Array.isArray(message?.attachments) &&
  message.attachments.length > 0 &&
  !coveredAttachmentText(message)
)

const stringifyEvidence = (value) => {
  try { return JSON.stringify(value) } catch { return '（凭证无法序列化）' }
}

const memoryBlock = (message) => {
  const role = message.role === 'user' ? '用户' : '助手'
  const attachments = (message.attachments || []).map((item) => item?.name).filter(Boolean)
  const selection = message.selection?.text
    ? `\n选中上下文${message.selection.lineHint ? `（${message.selection.lineHint}）` : ''}：\n${String(message.selection.text)}`
    : ''
  const receipt = message.receipt ? `\n执行凭证：${stringifyEvidence(message.receipt)}` : ''
  const recovery = message.recovery || message.recoveryEvidence || message.interruptedRunId
    ? `\n恢复凭证：${stringifyEvidence(message.recovery || message.recoveryEvidence || { interruptedRunId: message.interruptedRunId })}`
    : ''
  const attachmentText = coveredAttachmentText(message)
  const attachmentMemory = attachmentText
    ? `\n附件内容摘要：\n${attachmentText}`
    : ''
  return `【${role}】${attachments.length ? `（附件：${attachments.join('、')}）` : ''}\n${String(message.text || '')}${selection}${attachmentMemory}${receipt}${recovery}`
}

const normalizedMemoryLimit = (maxChars) => {
  const value = Number(maxChars)
  return Number.isSafeInteger(value) && value > 0 ? value : AGENT_MEMORY_MAX_CHARS
}

export const normalizeAgentMemorySummary = (summary, { maxChars = AGENT_MEMORY_MAX_CHARS } = {}) => {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null
  if (summary.version != null && summary.version !== AGENT_MEMORY_VERSION) return null
  if (typeof summary.text !== 'string' || !summary.text.trim()) return null
  if (summary.text.length > normalizedMemoryLimit(maxChars)) return null
  if (typeof summary.throughMessageId !== 'string' || !summary.throughMessageId.trim()) return null
  if (summary.throughMessageId !== summary.throughMessageId.trim() || summary.throughMessageId.length > 180) return null
  const sourceCount = summary.sourceCount == null ? 0 : summary.sourceCount
  const updatedAt = summary.updatedAt == null ? 0 : summary.updatedAt
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 0) return null
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return null
  return {
    version: AGENT_MEMORY_VERSION,
    text: summary.text,
    throughMessageId: summary.throughMessageId,
    sourceCount,
    updatedAt
  }
}

export const agentSummaryBoundaryIndex = (messages, summary) => {
  const list = Array.isArray(messages) ? messages : []
  const normalized = normalizeAgentMemorySummary(summary)
  if (!normalized) return -1
  let found = -1
  for (let index = 0; index < list.length; index++) {
    if (String(list[index]?.id || '') !== normalized.throughMessageId) continue
    if (found >= 0) return -1
    found = index
  }
  return found
}

export const agentMessagesAfterSummary = (messages, summary) => {
  const list = Array.isArray(messages) ? messages : []
  const index = agentSummaryBoundaryIndex(list, summary)
  return index >= 0 ? list.slice(index + 1) : list
}

export const selectAgentMessagesForPersistence = (messages, summary, { uiTail = 80 } = {}) => {
  const list = Array.isArray(messages) ? messages : []
  const boundaryIndex = agentSummaryBoundaryIndex(list, summary)
  if (boundaryIndex < 0) return list.slice()
  const tailCount = Number.isSafeInteger(Number(uiTail)) && Number(uiTail) > 0 ? Number(uiTail) : 80
  const tailStart = Math.max(0, list.length - tailCount)
  // Keep the boundary itself so the atomic coverage claim remains verifiable
  // after reload, as well as every message not covered by that claim.
  return list.slice(Math.min(boundaryIndex, tailStart))
}

export const selectAgentCompactionRange = (messages, summary, {
  keepRecent = AGENT_MEMORY_KEEP_RECENT,
  minMessages = 8,
  maxSourceChars = 36_000,
  maxSourceTokens = 12_000
} = {}) => {
  const list = Array.isArray(messages) ? messages : []
  const throughIndex = agentSummaryBoundaryIndex(list, summary)
  const start = Math.max(0, throughIndex + 1)
  const endLimit = list.length - Math.max(2, Number(keepRecent) || AGENT_MEMORY_KEEP_RECENT) - 1
  if (endLimit < start) return null
  const minimum = Math.max(2, Number(minMessages) || 8)
  const sourceLimit = Math.max(4000, Number(maxSourceChars) || 36_000)
  const tokenLimit = Math.max(1000, Number(maxSourceTokens) || 12_000)
  let chars = 0
  let tokens = 0
  let usableCount = 0
  let end = -1
  for (let index = start; index <= endLimit; index++) {
    const message = list[index]
    if (attachmentBarrier(message)) break
    if (usableMessage(message)) {
      const block = memoryBlock(message)
      const blockChars = block.length + 2
      const blockTokens = estimateAgentTokens(block)
      if (chars + blockChars > sourceLimit || tokens + blockTokens > tokenLimit) break
      chars += blockChars
      tokens += blockTokens
      usableCount++
    }
    if (!usableMessage(message) || message.role !== 'assistant' || usableCount < minimum) continue
    const next = list.slice(index + 1).find((candidate) => usableMessage(candidate) || attachmentBarrier(candidate))
    if (next?.role === 'user') end = index
  }
  if (end < start) return null
  const sourceMessages = list.slice(start, end + 1).filter(usableMessage)
  return {
    sourceMessages,
    throughMessageId: String(list[end]?.id || ''),
    throughIndex: end,
    remainingMessages: list.slice(end + 1)
  }
}

export const shouldCompactAgentContext = (messages, summary, {
  contextWindow = 0,
  systemTokens = 1500,
  keepRecent = AGENT_MEMORY_KEEP_RECENT
} = {}) => {
  const pending = agentMessagesAfterSummary(messages, summary).filter(usableMessage)
  const tokens = pending.reduce((total, message) => total + estimateAgentTokens(
    `${messageText(message)}\n${String(message.selection?.text || '')}\n${coveredAttachmentText(message)}\n${message.receipt ? stringifyEvidence(message.receipt) : ''}\n${messageExecutionEvidence(message) ? stringifyEvidence(messageExecutionEvidence(message)) : ''}`
  ), 0)
  if (pending.length >= 36) return true
  const window = Math.max(0, Number(contextWindow) || 0)
  if (!window) return tokens >= 12_000
  const summaryTokens = estimateAgentTokens(String(summary?.text || ''))
  const available = Math.max(3000, Math.floor(window * 0.58) - Math.max(0, Number(systemTokens) || 0) - summaryTokens)
  return tokens >= available
}

export const buildAgentMemorySource = (messages, { maxChars = 36_000 } = {}) => {
  const blocks = (Array.isArray(messages) ? messages : []).filter(usableMessage).map(memoryBlock)
  const source = blocks.join('\n\n')
  const limit = Math.max(4000, Number(maxChars) || 36_000)
  return source.length <= limit ? source : ''
}

export const fallbackAgentMemory = (previousSummary, source, { maxChars = AGENT_MEMORY_MAX_CHARS } = {}) => {
  const prefix = previousSummary?.text
    ? `【此前记忆】\n${String(previousSummary.text)}\n\n【新增对话摘录】\n`
    : '【对话摘录】\n'
  const limit = normalizedMemoryLimit(maxChars)
  const combined = prefix + String(source || '')
  if (combined.length <= limit) return combined
  return null
}

export const usableProviderAgentMemory = (result, { maxChars = AGENT_MEMORY_MAX_CHARS } = {}) => {
  const rawText = typeof result?.text === 'string' ? result.text : ''
  const limit = normalizedMemoryLimit(maxChars)
  if (result?.refusal || result?.truncated || result?.terminalComplete !== true) return null
  if (rawText.length > limit) return null
  const text = rawText.trim()
  if (text.length < 40 || text.length > limit) return null
  return text
}

export const selectAgentMemoryCommit = ({
  previousSummary = null,
  source = '',
  providerResult = null,
  throughMessageId = '',
  sourceMessages = 0,
  updatedAt = 0,
  maxChars = AGENT_MEMORY_MAX_CHARS
} = {}) => {
  if (
    typeof throughMessageId !== 'string' ||
    !throughMessageId.trim() ||
    throughMessageId !== throughMessageId.trim() ||
    throughMessageId.length > 180
  ) return null
  let text = usableProviderAgentMemory(providerResult, { maxChars })
  let mode = 'model'
  if (!text) {
    text = fallbackAgentMemory(previousSummary, source, { maxChars })
    mode = 'extractive'
  }
  if (!text) return null
  const previousCount = Math.max(0, Number(previousSummary?.sourceCount) || 0)
  return {
    summary: {
      version: AGENT_MEMORY_VERSION,
      text,
      throughMessageId,
      sourceCount: previousCount + Math.max(0, Number(sourceMessages) || 0),
      updatedAt: Math.max(0, Number(updatedAt) || 0)
    },
    mode
  }
}
