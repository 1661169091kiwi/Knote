<script setup>
// Agent chat panel — used twice (floating window + sidebar card), both
// instances render the same shared conversation from agentStore.
import { ref, nextTick, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  agentConfig, capabilities, chatMessages, agentActivity,
  agentActivityStack, agentWorkspaceOpen, agentPlan, agentQuestion, agentPermission,
  sendToAgent, stopAgent, clearChat, addAttachment, getActiveAttachment, removeAttachment,
  answerAgentQuestion, dismissAgentQuestion, allowAgentPermission, denyAgentPermission,
  activeAgentQueue, activeAgentRuntime, agentSessionRuntime,
  cancelQueuedAgentMessage, runQueuedAgentMessageHere,
  probeCapabilities, persistConfig, countPdfPages,
  chatSessions, activeSessionId, newSession, switchSession, deleteSession, sessionTitle,
  sessionLastConversationAt, agentRuntimeTransportHealth,
  runningInActiveSession, runningInActiveSurface, activeChatKey, activeAgentSurfaceKey,
  activeAgentReviewMode, activeAgentAllowAllGranted, setAgentReviewMode,
  activeAgentDraftKey, agentInputDraft, clearAgentInputDraft,
  selectionContext, agentBridge, pdfProcessing, batchState,
  pdfEnvState, hasPdfEnvSupport, installPdfEnv, uninstallPdfEnv, refreshPdfEnv,
  rollbackToMessage, contextUsage, activeResourceScopeKey
} from '../lib/agentStore.js'
import {
  AGENT_REVIEW_DOCUMENT_MODES,
  AGENT_REVIEW_POLICIES,
  agentReviewModeFor,
  agentReviewModeProfile
} from '../lib/agentReview.js'
import { readDocumentFile, detectFtype } from '../lib/fileReader.js'
import { agentUsageTotalInput } from '../lib/agentUsage.js'
import PdfShimmer from './PdfShimmer.vue'

const props = defineProps({
  mode: { type: String, default: 'float' }, // 'float' | 'sidebar'
  t: { type: Function, required: true },
  showAppDialog: { type: Function, default: null },
  requestAppDialog: { type: Function, default: null },
  // (text) => sanitized HTML — App provides its markdown-it + KaTeX pipeline
  renderMd: { type: Function, default: null }
})
const emit = defineEmits(['headerdown', 'collapse', 'ctxmenu'])
const questionDraft = ref('')
const questionSubmitting = ref(false)
const activeQuestion = computed(() => (
  agentQuestion.value &&
  agentQuestion.value.chatKey === activeChatKey.value &&
  agentQuestion.value.sessionId === activeSessionId.value &&
  agentQuestion.value.surfaceKey === activeAgentSurfaceKey.value
    ? agentQuestion.value
    : null
))
const activePermission = computed(() => (
  agentPermission.value &&
  agentPermission.value.chatKey === activeChatKey.value &&
  agentPermission.value.sessionId === activeSessionId.value &&
  agentPermission.value.surfaceKey === activeAgentSurfaceKey.value
    ? agentPermission.value
    : null
))
const permissionTitle = computed(() => activePermission.value
  ? props.t(`agent_permission_${activePermission.value.tool}`)
  : '')
const permissionTarget = computed(() => {
  const permission = activePermission.value
  if (!permission) return ''
  const targets = Array.isArray(permission.targets) ? permission.targets : []
  if (!targets.length) return permission.target || ''
  const extra = Math.max(0, Number(permission.count || 0) - targets.length)
  return targets.join('\n') + (extra ? `\n+${extra}` : '')
})
const permissionByteSize = (value) => {
  const bytes = Number(value)
  if (!Number.isSafeInteger(bytes) || bytes < 0) return ''
  const mib = 1024 * 1024
  return bytes % mib === 0 ? `${bytes / mib} MiB (${bytes} bytes)` : `${bytes} bytes`
}
const permissionDetail = computed(() => {
  const permission = activePermission.value
  if (!permission) return ''
  if (permission.tool === 'create_file') return tr('agent_permission_chars', { n: permission.chars })
  if (permission.tool === 'edit_file') return props.t(permission.replaceAll ? 'agent_permission_replace_all' : 'agent_permission_replace_one')
  if (permission.tool === 'batch_process') return tr('agent_permission_batch_detail', { n: permission.count, suffix: permission.suffix })
  if (permission.tool === 'run_command') return tr('agent_permission_command_detail', { n: permission.timeout })
  if (permission.tool === 'run_code') return tr('agent_permission_code_detail', { n: permission.timeoutMs })
  if (permission.tool === 'download_file') {
    if (permission.maxBytes === null) return props.t('agent_permission_download_no_limit')
    return tr('agent_permission_download_detail', { size: permissionByteSize(permission.maxBytes) })
  }
  return ''
})
const permissionDestination = computed(() => activePermission.value?.destination
  ? tr('agent_permission_destination', { target: activePermission.value.destination })
  : '')
const permissionReviewReason = computed(() => activePermission.value?.review?.reason
  ? tr('agent_permission_review_fallback', { reason: activePermission.value.review.reason })
  : '')
watch(() => activeQuestion.value && activeQuestion.value.id, () => {
  questionDraft.value = ''
  questionSubmitting.value = false
})
const submitQuestionAnswer = async (answer = questionDraft.value) => {
  const question = activeQuestion.value
  const text = String(answer || '').trim()
  if (!question || !text || questionSubmitting.value) return
  questionSubmitting.value = true
  try {
    if (await answerAgentQuestion(question.id, text)) questionDraft.value = ''
  } finally {
    questionSubmitting.value = false
  }
}
const onQuestionKeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    submitQuestionAnswer()
  }
}
const displaySessionTitle = (session) => sessionTitle(session, props.t('agent_new_chat'))
const sessionIsRunning = (session) => {
  const runtime = agentSessionRuntime(session)
  return !!runtime.runId && runtime.phase !== 'idle' && runtime.phase !== 'queued'
}
const tr = (key, vars = {}) => {
  let value = String(props.t(key))
  for (const [name, replacement] of Object.entries(vars)) value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}
const receiptReviewText = (receipt) => {
  if (!receipt || !receipt.staged) return ''
  const ids = Array.isArray(receipt.hunkIds) ? [...new Set(receipt.hunkIds.map(String))] : []
  const fileIds = new Set((receipt.pendingFileHunkIds || []).map(String))
  const acceptedIds = new Set((receipt.acceptedHunkIds || []).map(String))
  const rejectedIds = new Set((receipt.rejectedHunkIds || []).map(String))
  const counts = (wanted) => {
    const accepted = wanted.filter((id) => acceptedIds.has(id)).length
    const rejected = wanted.filter((id) => rejectedIds.has(id)).length
    return { accepted, rejected, pending: Math.max(0, wanted.length - accepted - rejected) }
  }
  const file = counts(ids.filter((id) => fileIds.has(id)))
  const regularIds = ids.filter((id) => !fileIds.has(id))
  const regular = ids.length
    ? counts(regularIds)
    : { accepted: Number(receipt.accepted || 0), rejected: Number(receipt.rejected || 0), pending: Number(receipt.staged) || 0 }
  const parts = []
  if (regular.pending) parts.push(tr('agent_receipt_staged', { n: regular.pending }))
  if (regular.accepted) parts.push(tr('agent_receipt_accepted', { n: regular.accepted }))
  if (regular.rejected) parts.push(tr('agent_receipt_rejected', { n: regular.rejected }))
  if (file.pending) parts.push(tr('agent_receipt_file_staged', { n: file.pending }))
  if (file.accepted) parts.push(tr('agent_receipt_file_accepted', { n: file.accepted }))
  if (file.rejected) parts.push(tr('agent_receipt_file_rejected', { n: file.rejected }))
  return parts.join(' · ')
}
const reviewToolName = (review) => review?.tool === 'document_hunks'
  ? props.t('agent_document_changes')
  : props.t(`agent_permission_${review?.tool}`)
const reviewItemCount = (review) => {
  const declared = Number(review?.itemCount)
  if (Number.isSafeInteger(declared) && declared > 0) return declared
  if (review?.tool === 'document_hunks') {
    const ids = String(review.callId || '').split(',').map((id) => id.trim()).filter(Boolean)
    if (ids.length) return ids.length
  }
  return 1
}
const receiptAutomationText = (receipt) => {
  const reviews = Array.isArray(receipt?.reviews) ? receipt.reviews : []
  return reviews.slice(-4).map((review) => {
    const tool = reviewToolName(review)
    if (review.outcome === 'auto_accepted' || review.outcome === 'auto_executed') {
      return tr('agent_review_auto_pass', { n: reviewItemCount(review), tool })
    }
    if (['full_auto_accepted', 'full_auto_executed', 'allow_all_accepted', 'allow_all_executed'].includes(review.outcome)) {
      return tr('agent_review_allow_all_pass', { n: reviewItemCount(review), tool })
    }
    return tr('agent_review_manual_fallback', { reason: review.reason || review.reasonCode || 'UNKNOWN' })
  }).join(' · ')
}
const capabilityBadges = computed(() => [
  { on: capabilities.chat, key: 'chat', label: props.t('agent_cap_chat') },
  { on: capabilities.tools, key: 'tools', label: props.t('agent_cap_tools') },
  { on: capabilities.vision, key: 'vision', label: props.t('agent_cap_image') },
  { on: capabilities.pdf, key: 'pdf', label: props.t('agent_cap_pdf') }
])
const capabilityName = (key) => props.t(key === 'vision' ? 'agent_cap_image' : key === 'tools' ? 'agent_cap_tools' : key === 'pdf' ? 'agent_cap_pdf' : 'agent_cap_chat')
const capabilityNote = (key, note) => {
  if (note && typeof note === 'object') {
    if (note.type === 'ctx_detected') return tr('agent_cap_ctx_detected', { n: Number(note.tokens || 0).toLocaleString() })
    if (note.type === 'rejected') return tr('agent_cap_rejected', { capability: capabilityName(note.capability || key), detail: note.detail || '' })
  }
  const legacy = String(note || '')
  const ctx = legacy.match(/上下文窗口[：:]\s*([\d,]+)/)
  if (ctx) return tr('agent_cap_ctx_detected', { n: ctx[1] })
  const rejected = legacy.match(/接口拒绝[（(](.*)[）)]$/)
  if (rejected) return tr('agent_cap_rejected', { capability: capabilityName(key), detail: rejected[1] })
  return legacy
}
const capabilityErrorText = computed(() => {
  const error = capabilities.error
  if (error && typeof error === 'object' && error.type === 'probe_incomplete') {
    return tr('agent_cap_probe_incomplete', { capability: capabilityName(error.capability), detail: error.detail || '' })
  }
  return String(error || '')
})

// Right-click inside the panel: copy for selected text, cut/copy/paste for
// the input box (Electron shows NO native context menu, so without this the
// chat had no clipboard access at all).
const writeClipText = async (s) => {
  try {
    if (window.knoteDesktop?.writeClipboard) await window.knoteDesktop.writeClipboard(String(s || ''))
    else await navigator.clipboard.writeText(s)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = s; document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    ta.remove()
  }
}
const readClipText = async () => {
  try {
    if (window.knoteDesktop && window.knoteDesktop.readClipboard) return await window.knoteDesktop.readClipboard()
    return await navigator.clipboard.readText()
  } catch { return '' }
}
const onPanelContextMenu = (e) => {
  const target = e.target
  const isField = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')
  const sel = String(window.getSelection ? window.getSelection() : '')
  const fieldSel = isField ? String(target.value).slice(target.selectionStart ?? 0, target.selectionEnd ?? 0) : ''
  const items = []
  if (isField) {
    if (fieldSel) {
      items.push({ label: props.t('ctx_cut'), action: async () => {
        await writeClipText(fieldSel)
        target.setRangeText('', target.selectionStart, target.selectionEnd, 'end')
        target.dispatchEvent(new Event('input', { bubbles: true })) // v-model sync
      } })
      items.push({ label: props.t('ctx_copy'), action: () => writeClipText(fieldSel) })
    }
    items.push({ label: props.t('ctx_paste'), action: async () => {
      // Try clipboard files first (images/PDFs)
      try {
        const clipItems = await navigator.clipboard.read()
        const files = []
        for (const item of clipItems) {
          for (const type of item.types) {
            if (type.startsWith('image/') || type === 'application/pdf') {
              const blob = await item.getType(type)
              const ext = type === 'application/pdf' ? '.pdf' : (type.split('/')[1] || 'png')
              const name = `pasted-${Date.now()}.${ext}`
              files.push(new File([blob], name, { type }))
              break
            }
          }
        }
        if (files.length) { await addFilesToChat(files); return }
      } catch { /* clipboard read denied or no file items */ }
      // Fall back to text paste
      const txt = await readClipText()
      if (!txt) return
      const st = target.selectionStart ?? target.value.length
      const en = target.selectionEnd ?? target.value.length
      target.setRangeText(txt, st, en, 'end')
      target.dispatchEvent(new Event('input', { bubbles: true }))
      target.focus()
    } })
  } else if (sel) {
    items.push({ label: props.t('ctx_copy'), action: () => writeClipText(sel) })
  }
  if (!items.length) return
  e.preventDefault()
  e.stopPropagation()
  emit('ctxmenu', { x: e.clientX, y: e.clientY, items })
}

// The writable computed is store-owned: both mounted panels and every remount
// read the exact same tab + conversation draft.
const input = agentInputDraft
// Settings visibility is EXPLICIT state — never derived from the config
// fields (that made the form vanish mid-typing, before the user could fill
// the optional Jina key or press save). First run: open until a successful
// capability check closes it.
const settingsOpen = ref(false)
const panelRef = ref(null)
const listRef = ref(null)
const fileRef = ref(null)
const draftAtts = ref([]) // attachments staged for the next message
let draftScopeRevision = 0
let acceptsDraftAttachments = true
const discardDraftAttachments = () => {
  draftScopeRevision++
  const discarded = draftAtts.value
  draftAtts.value = []
  for (const attachment of discarded) removeAttachment(attachment)
}
watch(activeResourceScopeKey, discardDraftAttachments, { flush: 'sync' })

const configured = computed(() => agentConfig.baseUrl && agentConfig.apiKey && agentConfig.model)
onMounted(() => { settingsOpen.value = !configured.value; if (hasPdfEnvSupport()) refreshPdfEnv() })
watch(settingsOpen, async () => {
  await nextTick()
  if (panelRef.value) panelRef.value.scrollLeft = 0
})

// PDF layout environment (PaddleOCR) — state is SHARED in the store so the
// float + sidebar panel instances never desync. Desktop only.
const hasPdfEnv = hasPdfEnvSupport()
const pdfEnvLogRef = ref(null)
const pdfBusy = computed(() => pdfEnvState.running || pdfEnvState.installing)
const uninstallPdfEnvConfirmed = () => {
  if (pdfBusy.value) return
  if (!window.confirm(props.t('agent_pdf_env_uninstall_confirm'))) return
  uninstallPdfEnv()
}

// auto-scroll THIS panel's own log element as lines stream in
watch(() => pdfEnvState.log.length, () => nextTick(() => { const el = pdfEnvLogRef.value; if (el) el.scrollTop = el.scrollHeight }))
const canAttachImage = computed(() => capabilities.vision)
// Every chat model can receive a PDF: native document when supported, otherwise
// its complete text layer. Page pixels are rendered only by explicit tools.
const canAttachPdf = computed(() => true)
const pdfProcessLabel = computed(() => {
  const mode = pdfProcessing.value && pdfProcessing.value.mode
  if (mode === 'native') return props.t('agent_pdf_sending')
  if (mode === 'text') return props.t('agent_pdf_to_text')
  return props.t('agent_pdf_processing')
})
const pdfProcessSub = computed(() => {
  const state = pdfProcessing.value
  if (!state) return ''
  let progress = ''
  if (state.targetTotal && state.targetIndex && state.sourcePage) {
    progress = tr('agent_target_page_progress', {
      index: state.targetIndex,
      total: state.targetTotal,
      page: state.sourcePage
    })
  } else if (state.page && state.pages) {
    progress = tr('agent_page_progress', { page: state.page, total: state.pages })
  }
  return `${state.name || ''}${progress ? `  ·  ${progress}` : ''}`
})
const acceptTypes = computed(() => {
  const a = ['.md,.markdown,.txt,.csv,.rtf,text/markdown,text/plain,text/csv']
  a.push('.docx,.pptx,.xlsx,.odt,.ods,.odp,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.oasis.opendocument.text,application/vnd.oasis.opendocument.spreadsheet,application/vnd.oasis.opendocument.presentation')
  if (canAttachImage.value) a.push('image/*')
  if (canAttachPdf.value) a.push('.pdf,application/pdf')
  return a.join(',')
})

const nearMessageBottom = (element, threshold = 120) => (
  !!element && element.scrollHeight - element.scrollTop - element.clientHeight < threshold
)
const scrollToBottom = ({ force = false } = {}) => {
  const initial = listRef.value
  const shouldFollow = force || !initial || nearMessageBottom(initial)
  const initialScrollTop = Number(initial?.scrollTop) || 0
  nextTick(() => {
    const element = listRef.value
    if (!element) return
    // A wheel gesture between scheduling and DOM settlement wins over
    // automatic following; tool/stream updates never pull a reader downward.
    if (!force && (!shouldFollow || (element === initial && element.scrollTop < initialScrollTop - 2))) return
    element.scrollTop = chatMessages.value.length ? element.scrollHeight : 0
    updateActiveQuestion()
  })
}
watch(() => chatMessages.value.length, () => scrollToBottom())
watch(agentActivity, () => {
  const el = listRef.value
  if (nearMessageBottom(el)) scrollToBottom()
})
// streaming: follow the growing last bubble, but only when already near the
// bottom — don't fight the user scrolling up to read
watch(() => {
  const m = chatMessages.value
  const last = m[m.length - 1]
  return (last && last.text ? last.text.length : 0) + String(activeAgentRuntime.value.provisionalText || '').length
}, () => {
  const el = listRef.value
  if (nearMessageBottom(el)) scrollToBottom()
})
onMounted(() => scrollToBottom({ force: true }))

const send = async (delivery = runningInActiveSession.value ? 'steer' : 'next') => {
  const rawDraft = input.value
  const draftKey = activeAgentDraftKey.value
  const text = rawDraft.trim()
  if (!text && !draftAtts.value.length) return
  const atts = draftAtts.value
  const sel = selectionContext.value
  const accepted = await sendToAgent(text, atts, {
    delivery,
    ...(sel ? { selection: sel } : {})
  })
  if (!accepted?.ok) {
    dropNote.value = accepted?.code === 'QUEUE_ATTACHMENTS_UNSUPPORTED'
      ? props.t('agent_queue_attachments_blocked')
      : accepted?.code === 'QUEUE_FULL'
        ? props.t('agent_queue_full')
        : accepted?.code === 'AGENT_STORAGE_FULL'
          ? props.t('agent_queue_storage_failed')
          : accepted?.code === 'PROMPT_TOO_LONG'
            ? props.t('agent_queue_prompt_too_long')
            : props.t('agent_queue_failed')
    setTimeout(() => { dropNote.value = '' }, 3200)
    return
  }
  // Attachments still being decoded belonged to this outgoing draft. They
  // must not appear later as an accidental second-message draft.
  draftScopeRevision++
  draftAtts.value = []
  clearAgentInputDraft(draftKey, rawDraft)
  selectionContext.value = null
}
const copyStates = ref({})
const copyWithFeedback = async (key, text) => {
  await writeClipText(String(text || ''))
  copyStates.value = { ...copyStates.value, [key]: true }
  window.setTimeout(() => {
    if (!copyStates.value[key]) return
    const next = { ...copyStates.value }
    delete next[key]
    copyStates.value = next
  }, 1400)
}
const tableToMarkdown = (table) => {
  const rows = Array.from(table?.querySelectorAll('tr') || [])
  if (!rows.length) return ''
  const columns = Math.max(...rows.map((row) => row.children.length))
  const escape = (cell) => String(cell?.innerText || '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim()
  const output = []
  rows.forEach((row, index) => {
    output.push(`| ${Array.from({ length: columns }, (_, column) => escape(row.children[column])).join(' | ')} |`)
    if (index === 0) output.push(`| ${Array(columns).fill('---').join(' | ')} |`)
  })
  return output.join('\n')
}

// "第 N 行" links inside rendered assistant markdown (injected by the App)
const onListClick = async (e) => {
  const target = e.target
  const copy = target?.closest?.('[data-agent-copy]')
  if (copy) {
    const row = copy.closest('[data-chat-message-index]')
    const index = Number(row?.dataset.chatMessageIndex)
    const message = chatMessages.value[index]
    const kind = copy.dataset.agentCopy
    let text = ''
    if (kind === 'message') text = message?.text || ''
    if (kind === 'code') {
      const code = copy.closest('.knote-agent-copy-block')?.querySelector('code')
      try { text = decodeURIComponent(code?.dataset.code || '') } catch { text = code?.textContent || '' }
      if (!text) text = code?.textContent || ''
    }
    if (kind === 'table') text = tableToMarkdown(copy.closest('.knote-agent-copy-block')?.querySelector('table'))
    if (text && kind === 'message') void copyWithFeedback(copy.dataset.copyKey || `${index}:${kind}`, text)
    if (text && kind !== 'message') {
      await writeClipText(text)
      const original = kind === 'code' ? props.t('agent_copy_code') : props.t('agent_copy_table')
      const copied = props.t('agent_copied')
      copy.dataset.copyState = 'copied'
      copy.setAttribute('aria-label', copied)
      copy.title = copied
      if (kind === 'code') copy.textContent = copied
      window.setTimeout(() => {
        if (!copy.isConnected) return
        delete copy.dataset.copyState
        copy.setAttribute('aria-label', original)
        copy.title = original
        if (kind === 'code') copy.textContent = original
      }, 1400)
    }
    return
  }
  const a = target?.closest?.('.knote-line-ref')
  if (a) {
    const n = Number(a.dataset.line)
    if (Number.isFinite(n) && n > 0) agentBridge.scrollToLine(n)
  }
}

// The slim rail belongs to the active conversation, not the session switcher
// or settings. Each mark represents one concrete user question in this chat.
const userQuestionAnchors = computed(() => chatMessages.value
  .map((message, messageIndex) => {
    if (message?.role !== 'user' || message.programGenerated) return null
    const text = String(message.text || '').replace(/\s+/g, ' ').trim()
    const attachmentName = message.attachments?.[0]?.name
    return {
      messageIndex,
      label: text || attachmentName || props.t('agent_attach')
    }
  })
  .filter(Boolean))
const activeQuestionMessageIndex = ref(-1)
const QUESTION_RAIL_COLLAPSED_LIMIT = 10
const questionRailExpanded = ref(false)
const questionRailListRef = ref(null)
let questionRailScrollTimer = 0
const clearQuestionRailScrollbar = () => {
  clearTimeout(questionRailScrollTimer)
  questionRailScrollTimer = 0
  questionRailListRef.value
    ?.closest('.knote-agent-question-rail')
    ?.classList.remove('is-user-scrolling')
}
const revealQuestionRailScrollbar = (event) => {
  if (!questionRailExpanded.value) return
  const list = event.currentTarget
  const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight)
  if (!event.deltaY || maxScrollTop <= 1) return
  const rail = event.currentTarget?.closest('.knote-agent-question-rail')
  if (!rail) return
  rail.classList.add('is-user-scrolling')
  clearTimeout(questionRailScrollTimer)
  questionRailScrollTimer = window.setTimeout(() => {
    questionRailScrollTimer = 0
    rail.classList.remove('is-user-scrolling')
  }, 650)
}
const syncQuestionRailToActive = () => {
  if (questionRailExpanded.value) return
  const list = questionRailListRef.value
  const active = list?.querySelector('.is-active')
  if (!list || !active) return
  const top = active.offsetTop
  const bottom = top + active.offsetHeight
  let target = list.scrollTop
  if (top < target) target = top
  else if (bottom > target + list.clientHeight) target = bottom - list.clientHeight

  // A fractional mark at both viewport edges makes eleven 22px ticks appear
  // inside a nominal ten-tick rail. Snap programmatic scrolling to the tick
  // grid, while using the exact maximum at the tail so the last mark is whole.
  const step = active.offsetHeight || 22
  const max = Math.max(0, list.scrollHeight - list.clientHeight)
  const snapped = max - target < step / 2
    ? max
    : Math.max(0, Math.min(max, Math.round(target / step) * step))
  if (Math.abs(list.scrollTop - snapped) > 0.5) list.scrollTop = snapped
}
const expandQuestionRail = () => {
  clearQuestionRailScrollbar()
  questionRailExpanded.value = true
}
const collapseQuestionRail = () => {
  clearQuestionRailScrollbar()
  questionRailExpanded.value = false
  nextTick(syncQuestionRailToActive)
}
let questionScrollFrame = 0
const updateActiveQuestion = () => {
  cancelAnimationFrame(questionScrollFrame)
  questionScrollFrame = requestAnimationFrame(() => {
    const scroller = listRef.value
    const questions = userQuestionAnchors.value
    if (!scroller || !questions.length) {
      activeQuestionMessageIndex.value = -1
      return
    }
    const threshold = scroller.scrollTop + Math.min(88, scroller.clientHeight * 0.24)
    let active = questions[0].messageIndex
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8) {
      active = questions[questions.length - 1].messageIndex
    } else {
      for (const question of questions) {
        const row = scroller.querySelector(`[data-chat-message-index="${question.messageIndex}"]`)
        if (row && row.offsetTop <= threshold) active = question.messageIndex
      }
    }
    activeQuestionMessageIndex.value = active
  })
}
const scrollToUserQuestion = (question) => {
  const scroller = listRef.value
  const row = scroller?.querySelector(`[data-chat-message-index="${question.messageIndex}"]`)
  if (!scroller || !row) return
  activeQuestionMessageIndex.value = question.messageIndex
  scroller.scrollTo({
    top: Math.max(0, row.offsetTop - 18),
    behavior: 'smooth'
  })
}
watch(() => activeQuestionMessageIndex.value, () => nextTick(syncQuestionRailToActive))
watch(() => activeSessionId.value, () => {
  questionRailExpanded.value = false
  scrollToBottom({ force: true })
  nextTick(updateActiveQuestion)
})
watch(userQuestionAnchors, (questions) => {
  if (questions.length < 2) questionRailExpanded.value = false
  nextTick(updateActiveQuestion)
})

const fmtTok = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0))

const onKeydown = (e) => {
  // keyCode 229 covers WebKit's compositionend-before-keydown IME quirk
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault()
    void send()
  }
}

// Paste handler: scan clipboard for images/PDFs before letting text through.
// The textarea alone can only accept plain text — image/PDF pastes are silently
// dropped by the browser unless we intercept them here and stage them as
// attachments (same as drag-and-drop / file picker).
const handlePaste = (e) => {
  const items = e.clipboardData && e.clipboardData.items
  if (!items || !items.length) return // let default text paste flow through

  const files = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const file = item.getAsFile && item.getAsFile()
    if (file) files.push(file)
  }
  if (!files.length) return // no file items — default text paste

  // If the clipboard carries file data AND plain text, prefer the files.
  // If it carries file data WITHOUT text, the browser would drop it on a
  // plain textarea anyway — so always consume it.
  e.preventDefault()
  addFilesToChat(files)
}

// settings edits take effect live — persist them without requiring the
// "detect capabilities" button
watch(agentConfig, persistConfig, { deep: true })

const pickFiles = () => fileRef.value && fileRef.value.click()

// Shared by the file picker AND drag-and-drop. Returns how many files were
// accepted vs skipped (unsupported type / capability off) so the drop path
// can surface a hint.
const addFilesToChat = async (fileList) => {
  const operation = {
    scope: activeResourceScopeKey.value,
    revision: draftScopeRevision
  }
  const isCurrentDraft = () => (
    acceptsDraftAttachments &&
    operation.revision === draftScopeRevision &&
    operation.scope === activeResourceScopeKey.value
  )
  const cancelled = (skipped) => ({ added: 0, skipped, cancelled: true })
  const stageAttachment = (attachment) => {
    if (!isCurrentDraft()) return false
    draftAtts.value.push(addAttachment(attachment))
    return true
  }
  let added = 0
  let skipped = 0
  for (const f of [...(fileList || [])]) {
    if (!isCurrentDraft()) return cancelled(skipped)
    if (f.type.startsWith('image/')) {
      if (!canAttachImage.value) { skipped++; continue }
      const dataUrl = await readAsDataUrl(f)
      let visionDataUrl = dataUrl
      if (!/^data:image\/(?:png|jpeg|gif|webp);/i.test(dataUrl)) {
        try { visionDataUrl = await prepareAttachmentVisionImage(dataUrl, f.type) } catch { skipped++; continue }
      }
      if (!stageAttachment({ kind: 'image', name: f.name, dataUrl, visionDataUrl })) return cancelled(skipped)
      added++
    } else if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      if (!canAttachPdf.value) { skipped++; continue }
      const buf = await f.arrayBuffer()
      if (!isCurrentDraft()) return cancelled(skipped)
      const bytes = new Uint8Array(buf)
      let pages = 0
      try { pages = await countPdfPages(bytes) } catch { pages = 0 }
      if (!stageAttachment({ kind: 'pdf', name: f.name, bytes, pages })) return cancelled(skipped)
      added++
    } else if (/\.(md|markdown|txt|csv|rtf)$/i.test(f.name) || f.type === 'text/markdown' || f.type === 'text/plain' || f.type === 'text/csv') {
      // plain text / markdown — always accepted
      let text
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(await f.arrayBuffer()) } catch {
        skipped++
        continue
      }
      if (!stageAttachment({
        kind: 'md',
        name: f.name,
        text: String(text),
        sourceFormat: detectFtype(f.name)?.toUpperCase() || 'TEXT',
        sourceComplete: true
      })) return cancelled(skipped)
      added++
    } else if (/\.(docx|pptx|xlsx|odt|ods|odp)$/i.test(f.name) || f.type.includes('officedocument') || f.type.includes('opendocument')) {
      // Office / OpenDocument — extract text, send as md context
      const result = await readDocumentFile(f)
      if (!isCurrentDraft()) return cancelled(skipped)
      if (result && result.text) {
        const label = detectFtype(f.name)?.toUpperCase() || 'DOC'
        if (!stageAttachment({
          kind: 'md',
          name: f.name,
          text: String(result.text),
          sourceFormat: label,
          sourceComplete: result.source_complete !== false,
          sourceTotalChars: result.source_total_chars,
          sourceTotalBytes: result.source_total_bytes
        })) return cancelled(skipped)
        added++
      } else {
        skipped++
      }
    } else {
      skipped++
    }
  }
  return { added, skipped }
}

const onFiles = async (e) => {
  // COPY before clearing: Chromium's FileList is live — resetting value
  // empties the captured reference too, so the picker silently uploaded
  // nothing while drag-and-drop (whose FileList is never cleared) worked
  const files = [...(e.target.files || [])]
  e.target.value = ''
  await addFilesToChat(files)
}

// ---- drag & drop images / PDFs onto the chat ----
const dragOver = ref(false)
let dragDepth = 0
const dropNote = ref('')

// ---- rollback / branch: rewind the session to a user message ----
const doRollback = (i) => {
  if (runningInActiveSession.value || activeAgentQueue.value.length) return
  const text = rollbackToMessage(i)
  if (text === null) return
  input.value = text // back into the box for editing + resending
  dropNote.value = props.t('agent_rollback_done')
  setTimeout(() => { if (dropNote.value === props.t('agent_rollback_done')) dropNote.value = '' }, 2600)
  nextTick(() => { if (inputRef.value) inputRef.value.focus() })
}

// ---- thinking depth: a cycle-pill in the chat footer (默认→低→中→高) ----
const REASONING_ORDER = ['', 'low', 'medium', 'high']
const cycleReasoning = () => {
  const i = REASONING_ORDER.indexOf(agentConfig.reasoning || '')
  agentConfig.reasoning = REASONING_ORDER[(i + 1) % REASONING_ORDER.length]
  persistConfig() // footer changes persist immediately (no save button here)
}
const reasoningLabel = computed(() => ({
  '': props.t('agent_reasoning_default'),
  low: props.t('agent_reasoning_low'),
  medium: props.t('agent_reasoning_medium'),
  high: props.t('agent_reasoning_high')
})[agentConfig.reasoning || ''])

// ---- context-window usage ring (shown when ctxWindow is known) ----
const CTX_RING_C = 2 * Math.PI * 7 // r=7 circle circumference
const ctxRing = computed(() => {
  const win = Number(agentConfig.ctxWindow) || 0
  if (!win) return null
  const used = contextUsage() // reads reactive chatMessages — recomputes live
  const pct = Math.min(1, used / win)
  return {
    used,
    win,
    pct,
    dash: `${(pct * CTX_RING_C).toFixed(2)} ${CTX_RING_C.toFixed(2)}`,
    color: pct < 0.7 ? '#84cc16' : (pct < 0.9 ? '#eab308' : '#ef4444'),
    label: `${Math.round(pct * 100)}%`
  }
})
const fmtCtx = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n))
// v-model.number leaves '' for a cleared field and allows negatives — settle
// anything invalid back to 0 (= ring off) when the field loses focus
const normalizeCtxWindow = () => {
  const v = Number(agentConfig.ctxWindow)
  if (!Number.isFinite(v) || v < 0) agentConfig.ctxWindow = 0
}

const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'))
const onDragEnter = (e) => {
  if (!hasFiles(e)) return // md/txt attachments always work — never gate the drop zone
  dragDepth++
  dragOver.value = true
}
const onDragOver = (e) => {
  if (!hasFiles(e)) return
  e.preventDefault()
  e.stopPropagation() // don't let App's window drop-to-open-tab handler see it
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}
const onDragLeave = () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragOver.value = false
}
const onDrop = async (e) => {
  dragDepth = 0
  dragOver.value = false
  if (!hasFiles(e)) return
  e.preventDefault()
  e.stopPropagation()
  const files = (e.dataTransfer && e.dataTransfer.files) || []
  const { added, skipped, cancelled } = await addFilesToChat(files)
  if (!cancelled && !added && skipped) {
    // md/txt always works, so a full rejection means image/pdf without the
    // capability (config) or a genuinely unsupported type
    dropNote.value = (!canAttachImage.value && !canAttachPdf.value)
      ? props.t('agent_drop_need_config')
      : props.t('agent_drop_unsupported')
    setTimeout(() => { dropNote.value = '' }, 2600)
  }
}

const readAsDataUrl = (file) => new Promise((res, rej) => {
  const r = new FileReader()
  r.onload = () => res(r.result)
  r.onerror = rej
  r.readAsDataURL(file)
})

const prepareAttachmentVisionImage = (dataUrl, mime) => new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => {
    try {
      const sourceWidth = image.naturalWidth || 1200
      const sourceHeight = image.naturalHeight || 1200
      const scale = Math.min(1, 1568 / Math.max(sourceWidth, sourceHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(sourceWidth * scale))
      canvas.height = Math.max(1, Math.round(sourceHeight * scale))
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/png'))
    } catch (error) { reject(error) }
  }
  image.onerror = () => reject(new Error(`Unsupported vision image: ${mime || 'unknown'}`))
  image.src = dataUrl
})

const removeDraft = (id) => {
  const attachment = draftAtts.value.find((a) => a.id === id)
  draftAtts.value = draftAtts.value.filter((a) => a.id !== id)
  if (attachment) removeAttachment(attachment)
}

const saveSettings = async () => {
  persistConfig()
  let result
  try {
    result = await probeCapabilities()
  } catch (error) {
    result = { ...capabilities, chat: false, error: String(error?.message || error) }
  }
  // Keep settings mounted until the queued in-app result is acknowledged.
  if (props.showAppDialog) await props.showAppDialog(result)
  if (capabilities.chat) settingsOpen.value = false
}

// clearing a chat is destructive — ask first (our own dialog, not confirm())
const confirmClearOpen = ref(false)
const doClearChat = () => {
  if (clearChat()) {
    confirmClearOpen.value = false
    discardDraftAttachments()
  } else {
    globalThis.alert(props.t('agent_queue_storage_failed'))
  }
}

// quick-start suggestions on an empty chat (document actions need tools)
const suggestions = computed(() => (configured.value && capabilities.tools
  ? [props.t('agent_sugg_1'), props.t('agent_sugg_2'), props.t('agent_sugg_3')]
  : []))
const sendSuggestion = (s) => {
  void sendToAgent(s, [], { delivery: 'next' })
}

const stopCurrentAgent = () => stopAgent({
  chatKey: activeChatKey.value,
  sessionId: activeSessionId.value,
  surfaceKey: activeAgentSurfaceKey.value
})
const messageBelongsToActiveSurface = (message) => (
  !message?.surfaceKey || message.surfaceKey === activeAgentSurfaceKey.value
)
const queueModeLabel = (item) => props.t(item.mode === 'steer' ? 'agent_steer' : 'agent_queue_next')
const queueBlockedLabel = (item) => item.blocked === 'context_changed'
  ? props.t('agent_queue_context_changed')
  : item.blocked === 'attachments_unavailable'
    ? props.t('agent_queue_attachments_missing')
    : item.blocked === 'storage_failed'
      ? props.t('agent_queue_storage_failed')
      : item.blocked === 'context_limit'
        ? props.t('agent_queue_context_limit')
    : item.blocked === 'agent_not_configured'
      ? props.t('agent_queue_not_configured')
      : item.blocked === 'prompt_too_long'
        ? props.t('agent_queue_prompt_too_long')
    : item.paused ? props.t('agent_queue_paused') : ''

const attThumb = (a) => {
  const live = getActiveAttachment(a.id)
  return live && live.kind === 'image' ? live.dataUrl : null
}

// ---- workspace panel: per-activity-kind icons (static markup, safe v-html) ----
const WS_ICONS = {
  search: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path stroke-linecap="round" d="m21 21-4.3-4.3"/></svg>',
  fetch: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
  pdf: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  image: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="1.6"/><path stroke-linecap="round" stroke-linejoin="round" d="m21 15-5-5L5 21"/></svg>',
  file: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path stroke-linecap="round" d="M9 13h6M9 17h4"/></svg>',
  edit: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m16.86 4.49 1.69-1.69a1.87 1.87 0 1 1 2.65 2.65L9.58 16.07a4.5 4.5 0 0 1-1.9 1.13L6 18l.8-2.69a4.5 4.5 0 0 1 1.13-1.9z"/></svg>',
  batch: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="m12 2 9 5-9 5-9-5 9-5Zm9 10-9 5-9-5m18 5-9 5-9-5"/></svg>',
  tool: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.3-2.3z"/></svg>'
}
const workspaceIcon = (kind) => WS_ICONS[kind] || WS_ICONS.tool
const workspaceIconColor = (a) => (a.status === 'error' ? 'text-error/70' : a.status === 'running' ? 'knote-agent-brand-text' : a.status === 'done' ? 'text-success' : 'text-base-content/45')
const planDone = computed(() => agentPlan.value.filter((s) => s.status === 'completed').length)
// batch (sub-agent) progress renders in the workspace panel when it's showing
// (float + open); otherwise it stays in the chat so sidebar mode / a collapsed
// panel still surface it — never both at once
const inWorkspacePanel = computed(() => props.mode === 'float' && agentWorkspaceOpen.value)
const showBatchInChat = computed(() => !!batchState.value && !inWorkspacePanel.value)
const batchSucceeded = computed(() => !!batchState.value && !batchState.value.running && batchState.value.items.every((item) => item.status === 'done'))

// auto-grow the input up to ~6 rows; overflow scrolls only past that
const inputRef = ref(null)
const autoGrow = () => {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  const max = 148
  el.style.height = `${Math.min(el.scrollHeight, max)}px`
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
}
watch(input, () => nextTick(autoGrow))
onMounted(autoGrow)

const sessionsOpen = ref(false)
const reviewModeBusy = ref(false)
const reviewModeOpen = ref(false)
const reviewModeToggleRef = ref(null)
const reviewModePopoverRef = ref(null)
const sessionListRef = ref(null)
const orderedSessions = computed(() => [...chatSessions.value].sort((left, right) => (
  sessionLastConversationAt(right) - sessionLastConversationAt(left) ||
  String(right.id || '').localeCompare(String(left.id || ''))
)))
const statusNow = ref(Date.now())
let statusClock = 0
const provisionalText = computed(() => String(activeAgentRuntime.value.provisionalText || ''))
const activeRunHealth = computed(() => agentRuntimeTransportHealth(activeAgentRuntime.value, statusNow.value))
const activeRunStalled = computed(() => activeRunHealth.value !== 'healthy')
const activeRunStatusText = computed(() => activeAgentRuntime.value.activity || agentActivity.value)
const toggleSessions = () => {
  reviewModeOpen.value = false
  sessionsOpen.value = !sessionsOpen.value
}
const reviewPolicyOptions = computed(() => [
  { policy: AGENT_REVIEW_POLICIES.MANUAL, testid: 'agent-review-policy-manual', label: props.t('agent_review_policy_manual') },
  { policy: AGENT_REVIEW_POLICIES.REVIEW, testid: 'agent-review-policy-review', label: props.t('agent_review_policy_review') },
  { policy: AGENT_REVIEW_POLICIES.ALLOW_ALL, testid: 'agent-review-policy-allow-all', label: props.t('agent_review_policy_allow_all') }
])
const activeReviewProfile = computed(() => agentReviewModeProfile(activeAgentReviewMode.value))
const activeReviewPolicyLabel = computed(() => reviewPolicyOptions.value.find((option) => option.policy === activeReviewProfile.value.policy)?.label || props.t('agent_review_policy_review'))
const activeReviewDocumentLabel = computed(() => activeReviewProfile.value.policy === AGENT_REVIEW_POLICIES.ALLOW_ALL
  ? `${props.t('agent_review_document_label')}: ${activeReviewProfile.value.documentMode === AGENT_REVIEW_DOCUMENT_MODES.TAB_MANUAL ? props.t('agent_review_document_tab_manual') : props.t('agent_review_document_all_auto')}`
  : '')
const activeReviewModeDescription = computed(() => {
  if (activeReviewProfile.value.policy === AGENT_REVIEW_POLICIES.MANUAL) return props.t('agent_review_policy_manual_desc')
  if (activeReviewProfile.value.policy === AGENT_REVIEW_POLICIES.REVIEW) return props.t('agent_review_policy_review_desc')
  const documentMode = activeReviewProfile.value.documentMode === AGENT_REVIEW_DOCUMENT_MODES.ALL_AUTO
    ? props.t('agent_review_document_all_auto_desc')
    : props.t('agent_review_document_tab_manual_desc')
  return `${props.t('agent_review_policy_allow_all_desc')} ${documentMode}`
})
const focusReviewOption = async (selector) => {
  await nextTick()
  reviewModePopoverRef.value?.querySelector(selector)?.focus()
}
const toggleReviewModePopover = () => {
  sessionsOpen.value = false
  reviewModeOpen.value = !reviewModeOpen.value
  if (reviewModeOpen.value) void focusReviewOption(`[data-review-policy="${activeReviewProfile.value.policy}"]`)
}
const closeReviewModePopover = (restoreFocus = false) => {
  reviewModeOpen.value = false
  if (restoreFocus) nextTick(() => reviewModeToggleRef.value?.focus())
}
const chooseReviewMode = async (mode) => {
  if (reviewModeBusy.value || mode === activeAgentReviewMode.value) return
  const owner = {
    chatKey: activeChatKey.value,
    sessionId: activeSessionId.value,
    surfaceKey: activeAgentSurfaceKey.value
  }
  const nextProfile = agentReviewModeProfile(mode)
  const currentProfile = activeReviewProfile.value
  let confirmed = !nextProfile.requiresGrant || (
    currentProfile.policy === AGENT_REVIEW_POLICIES.ALLOW_ALL && activeAgentAllowAllGranted.value
  )
  if (!confirmed) {
    if (!props.requestAppDialog) return
    const restoreElement = document.activeElement
    reviewModeBusy.value = true
    try {
      confirmed = await props.requestAppDialog({
        mode: 'confirm',
        owner: `agent-review-mode:${owner.chatKey}:${owner.sessionId}:${owner.surfaceKey}`,
        title: props.t('agent_review_allow_all_confirm_title'),
        message: props.t('agent_review_allow_all_confirm_message')
      })
    } finally {
      reviewModeBusy.value = false
      if (restoreElement instanceof HTMLElement && restoreElement.isConnected) {
        await nextTick()
        restoreElement.focus()
      } else {
        await nextTick()
        reviewModeToggleRef.value?.focus()
      }
    }
  }
  if (!confirmed || owner.chatKey !== activeChatKey.value || owner.sessionId !== activeSessionId.value || owner.surfaceKey !== activeAgentSurfaceKey.value) return
  setAgentReviewMode(mode, { ...owner, confirmed })
}
const chooseReviewPolicy = (policy) => {
  const documentMode = policy === AGENT_REVIEW_POLICIES.ALLOW_ALL && activeReviewProfile.value.policy === AGENT_REVIEW_POLICIES.ALLOW_ALL
    ? activeReviewProfile.value.documentMode
    : AGENT_REVIEW_DOCUMENT_MODES.TAB_MANUAL
  return chooseReviewMode(agentReviewModeFor(policy, documentMode))
}
const chooseReviewDocumentMode = (documentMode) => {
  if (activeReviewProfile.value.policy !== AGENT_REVIEW_POLICIES.ALLOW_ALL) return
  return chooseReviewMode(agentReviewModeFor(AGENT_REVIEW_POLICIES.ALLOW_ALL, documentMode))
}
const moveReviewRadio = (event, options, activeValue, valueKey, choose, dataKey) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const current = Math.max(0, options.findIndex((option) => option[valueKey] === activeValue))
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? options.length - 1
      : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length
  const value = options[next][valueKey]
  Promise.resolve(choose(value)).finally(() => focusReviewOption(`[data-${dataKey}="${value}"]`))
}
watch(sessionsOpen, (open) => {
  if (!open) return
  nextTick(() => {
    const active = sessionListRef.value?.querySelector('[aria-current="true"]')
    const list = sessionListRef.value
    if (!active || !list) return
    const rowTop = active.offsetTop
    const rowBottom = rowTop + active.offsetHeight
    if (rowTop < list.scrollTop) list.scrollTop = rowTop
    else if (rowBottom > list.scrollTop + list.clientHeight) list.scrollTop = rowBottom - list.clientHeight
  })
})
// close on outside click — inner clicks never reach document because the
// switcher wrapper has @mousedown.stop, so an unconditional close is safe
const closeHeaderPopoversOnOutside = () => {
  if (sessionsOpen.value) sessionsOpen.value = false
  if (reviewModeOpen.value && !reviewModeBusy.value) reviewModeOpen.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', closeHeaderPopoversOnOutside)
  statusClock = window.setInterval(() => { statusNow.value = Date.now() }, 1000)
})
onBeforeUnmount(() => {
  acceptsDraftAttachments = false
  discardDraftAttachments()
  document.removeEventListener('mousedown', closeHeaderPopoversOnOutside)
  cancelAnimationFrame(questionScrollFrame)
  clearTimeout(questionRailScrollTimer)
  clearInterval(statusClock)
})
const pickSession = (id) => {
  switchSession(id)
  sessionsOpen.value = false
}
const removeSession = (id, e) => {
  e.stopPropagation()
  deleteSession(id)
}
const startNewSession = () => {
  newSession()
  sessionsOpen.value = false
}
</script>

<template>
  <div
    ref="panelRef"
    class="knote-agent-panel relative flex flex-row w-full h-full min-h-0"
    data-testid="agent-panel"
    :data-agent-mode="mode"
    :data-agent-theme="agentConfig.chatTheme === 'aurora' ? 'aurora' : 'white'"
    :data-agent-surface="activeAgentSurfaceKey"
    :data-settings-open="settingsOpen ? 'true' : 'false'"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @contextmenu="onPanelContextMenu"
  >
    <!-- drag-and-drop overlay for images / PDFs -->
    <div v-if="dragOver" class="knote-agent-drop absolute inset-0 z-[60] flex items-center justify-center pointer-events-none">
      <div class="flex flex-col items-center gap-2 text-[#4d7c0f]">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 16.5V9m0 0L8.5 12.5M12 9l3.5 3.5M20 16.5A3.5 3.5 0 0 0 18 10a5.5 5.5 0 0 0-10.9-1A4 4 0 0 0 6 17"/></svg>
        <span class="text-xs font-bold">{{ t('agent_drop_hint') }}</span>
      </div>
    </div>

    <!-- LEFT: chat column (header · settings · messages · input) -->
    <div class="knote-agent-chat-column flex flex-col flex-1 min-w-0 min-h-0 h-full">
    <!-- header -->
    <div class="knote-agent-header flex items-center gap-2 px-3 py-2.5 shrink-0 select-none">
      <!-- first run: no sessions to switch — just the setup title -->
      <span v-if="!configured" class="text-xs font-semibold text-base-content/75 truncate">{{ t('agent_setup_title') }}</span>
      <!-- session switcher -->
      <div v-else class="relative min-w-0 flex-1" @mousedown.stop>
        <button type="button" data-testid="agent-session-toggle" class="knote-agent-session-trigger flex items-center gap-1.5 max-w-full" aria-haspopup="menu" :aria-expanded="sessionsOpen" @click="toggleSessions">
          <span class="truncate">{{ displaySessionTitle(chatSessions.find(s => s.id === activeSessionId) || chatSessions[0]) }}</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 opacity-50"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/></svg>
        </button>
        <div v-if="sessionsOpen" class="knote-agent-session-popover absolute left-0 top-8 z-50" data-testid="agent-session-popover">
          <div class="knote-agent-session-popover-head">
            <div>
              <div class="knote-agent-session-kicker">Knote Agent</div>
              <div class="knote-agent-session-heading">{{ t('agent_sessions') }}</div>
            </div>
            <button data-testid="agent-new-session-menu" class="knote-agent-session-new" :title="t('agent_new_chat')" @click="startNewSession">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
            </button>
          </div>
          <div ref="sessionListRef" class="knote-agent-session-list knote-sidebar-card-scroll">
            <div
              v-for="s in orderedSessions" :key="s.id"
              data-testid="agent-session-row"
              :data-session-id="s.id"
              :data-running="sessionIsRunning(s) ? 'true' : 'false'"
              :data-runtime-phase="agentSessionRuntime(s).phase"
              :aria-current="s.id === activeSessionId ? 'true' : 'false'"
              class="knote-agent-session-row group"
              :class="{ 'is-active': s.id === activeSessionId }"
              @click="pickSession(s.id)"
            >
              <span class="knote-agent-session-row-icon">
                <span v-if="sessionIsRunning(s)" class="loading loading-spinner"></span>
                <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a8.38 8.38 0 0 1-.9 3.8A8.5 8.5 0 0 1 12.5 21a8.38 8.38 0 0 1-3.8-.9L3 21l.9-5.7A8.38 8.38 0 0 1 3 11.5 8.5 8.5 0 0 1 8.2 3.9 8.38 8.38 0 0 1 12 3h.5A8.48 8.48 0 0 1 21 11.5Z"/></svg>
              </span>
              <span class="truncate flex-1">{{ displaySessionTitle(s) }}</span>
              <span v-if="sessionIsRunning(s)" class="knote-agent-session-running">{{ t('agent_running_badge') }}</span>
              <span v-else-if="(s.queue || []).length" class="knote-agent-session-running">{{ t('agent_queued') }} {{ s.queue.length }}</span>
              <span v-else class="knote-agent-session-count">{{ s.messages.length }}</span>
              <button
                v-if="!sessionIsRunning(s) && !(s.queue || []).length"
                class="knote-agent-session-remove"
                :aria-label="t('agent_clear')"
                @click="removeSession(s.id, $event)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="knote-agent-header-actions ml-auto flex items-center gap-0.5 shrink-0" @mousedown.stop>
        <div v-if="configured" class="knote-agent-review-mode-wrap" @mousedown.stop>
          <button
            ref="reviewModeToggleRef"
            type="button"
            data-testid="agent-review-mode-toggle"
            class="knote-agent-review-mode-trigger"
            :data-review-mode="activeAgentReviewMode"
            :data-review-policy="activeReviewProfile.policy"
            :data-document-mode="activeReviewProfile.documentMode || 'none'"
            :data-allow-all-granted="activeAgentAllowAllGranted ? 'true' : 'false'"
            :title="`${t('agent_review_mode')}: ${activeReviewPolicyLabel}${activeReviewDocumentLabel ? ` · ${activeReviewDocumentLabel}` : ''}`"
            :aria-label="`${t('agent_review_mode')}: ${activeReviewPolicyLabel}${activeReviewDocumentLabel ? `, ${activeReviewDocumentLabel}` : ''}`"
            aria-haspopup="dialog"
            :aria-expanded="reviewModeOpen"
            aria-controls="agent-review-mode-popover"
            :disabled="reviewModeBusy"
            @click="toggleReviewModePopover"
          >
            <svg v-if="activeReviewProfile.policy === AGENT_REVIEW_POLICIES.MANUAL" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 12.25a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5Zm-7.5 7.3c0-3.54 3.36-5.8 7.5-5.8s7.5 2.26 7.5 5.8a.7.7 0 0 1-.7.7H5.2a.7.7 0 0 1-.7-.7Z"/></svg>
            <svg v-else-if="activeReviewProfile.policy === AGENT_REVIEW_POLICIES.REVIEW" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M12 2.6c2.4 1.7 5.05 2.52 7.3 2.8v5.17c0 5.2-3.06 9.18-7.3 10.83-4.24-1.65-7.3-5.63-7.3-10.83V5.4c2.25-.28 4.9-1.1 7.3-2.8Zm3.7 6.54a.9.9 0 0 0-1.28.02l-3.5 3.62-1.38-1.4a.9.9 0 1 0-1.28 1.27l2.03 2.05a.9.9 0 0 0 1.29 0l4.14-4.28a.9.9 0 0 0-.02-1.28Z" clip-rule="evenodd"/></svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.14 2.75 5.38 13.2a.75.75 0 0 0 .6 1.2h4.55l-.83 6.02a.75.75 0 0 0 1.35.55l7.58-10.34a.75.75 0 0 0-.6-1.2h-4.4l.86-6.1a.75.75 0 0 0-1.35-.58Z"/></svg>
          </button>
          <div
            v-if="reviewModeOpen"
            id="agent-review-mode-popover"
            ref="reviewModePopoverRef"
            data-testid="agent-review-mode-popover"
            class="knote-agent-review-mode-popover"
            role="dialog"
            :aria-label="t('agent_review_mode')"
            @keydown.esc.prevent.stop="closeReviewModePopover(true)"
          >
            <header>
              <b>{{ t('agent_review_mode') }}</b>
              <span>{{ activeReviewModeDescription }}</span>
            </header>
            <div
              data-testid="agent-review-policy-group"
              class="knote-agent-review-policy-grid"
              role="radiogroup"
              :aria-label="t('agent_review_policy_label')"
              @keydown="moveReviewRadio($event, reviewPolicyOptions, activeReviewProfile.policy, 'policy', chooseReviewPolicy, 'review-policy')"
            >
              <div
                v-for="option in reviewPolicyOptions"
                :key="option.policy"
                class="knote-agent-review-policy-option"
                :class="{ 'is-active': activeReviewProfile.policy === option.policy }"
              >
                <div class="knote-agent-review-policy-row">
                  <button
                    type="button"
                    class="knote-agent-review-policy-choice"
                    role="radio"
                    :data-testid="option.testid"
                    :data-review-policy="option.policy"
                    :aria-checked="activeReviewProfile.policy === option.policy"
                    :tabindex="activeReviewProfile.policy === option.policy ? 0 : -1"
                    :disabled="reviewModeBusy"
                    @click="chooseReviewPolicy(option.policy)"
                  >
                    <span class="knote-agent-review-policy-icon" aria-hidden="true">
                      <svg v-if="option.policy === AGENT_REVIEW_POLICIES.MANUAL" viewBox="0 0 24 24"><path fill="currentColor" d="M12 12.25a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5Zm-7.5 7.3c0-3.54 3.36-5.8 7.5-5.8s7.5 2.26 7.5 5.8a.7.7 0 0 1-.7.7H5.2a.7.7 0 0 1-.7-.7Z"/></svg>
                      <svg v-else-if="option.policy === AGENT_REVIEW_POLICIES.REVIEW" viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M12 2.6c2.4 1.7 5.05 2.52 7.3 2.8v5.17c0 5.2-3.06 9.18-7.3 10.83-4.24-1.65-7.3-5.63-7.3-10.83V5.4c2.25-.28 4.9-1.1 7.3-2.8Zm3.7 6.54a.9.9 0 0 0-1.28.02l-3.5 3.62-1.38-1.4a.9.9 0 1 0-1.28 1.27l2.03 2.05a.9.9 0 0 0 1.29 0l4.14-4.28a.9.9 0 0 0-.02-1.28Z" clip-rule="evenodd"/></svg>
                      <svg v-else viewBox="0 0 24 24"><path fill="currentColor" d="M13.14 2.75 5.38 13.2a.75.75 0 0 0 .6 1.2h4.55l-.83 6.02a.75.75 0 0 0 1.35.55l7.58-10.34a.75.75 0 0 0-.6-1.2h-4.4l.86-6.1a.75.75 0 0 0-1.35-.58Z"/></svg>
                    </span>
                    <b>{{ option.label }}</b>
                  </button>
                  <button
                    v-if="activeReviewProfile.policy === option.policy && option.policy === AGENT_REVIEW_POLICIES.ALLOW_ALL"
                    type="button"
                    data-testid="agent-review-document-group"
                    class="knote-agent-review-document-toggle"
                    role="switch"
                    :aria-label="t('agent_review_document_label')"
                    :aria-checked="activeReviewProfile.documentMode === AGENT_REVIEW_DOCUMENT_MODES.TAB_MANUAL"
                    :data-document-mode="activeReviewProfile.documentMode"
                    :disabled="reviewModeBusy"
                    @keydown.stop
                    @click.stop="chooseReviewDocumentMode(activeReviewProfile.documentMode === AGENT_REVIEW_DOCUMENT_MODES.TAB_MANUAL ? AGENT_REVIEW_DOCUMENT_MODES.ALL_AUTO : AGENT_REVIEW_DOCUMENT_MODES.TAB_MANUAL)"
                  >
                    <span data-testid="agent-review-document-label">{{ t('agent_review_document_label') }}</span>
                    <i aria-hidden="true"><b></b></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <button v-if="configured" data-testid="agent-new-session" class="btn btn-xs btn-ghost btn-square" :title="t('agent_new_chat')" @click="startNewSession">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
        </button>
        <button v-if="configured" data-testid="agent-clear-chat" class="btn btn-xs btn-ghost btn-square" :title="t('agent_clear')" :disabled="runningInActiveSession" @click="confirmClearOpen = true">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>
        </button>
        <button v-if="mode === 'sidebar'" class="btn btn-xs btn-ghost btn-square" :title="t('agent_hide')" @click="$emit('collapse')">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5"/></svg>
        </button>
        <!-- workspace panel toggle (float only): shows the live agent work stack -->
        <button v-if="mode === 'float' && configured" data-testid="agent-workspace-toggle" class="btn btn-xs btn-ghost btn-square relative knote-agent-workspace-toggle" :class="{ 'text-[#84cc16]': agentWorkspaceOpen, 'is-running': activeAgentRuntime.phase !== 'idle' }" :title="t('agent_workspace')" :aria-label="t('agent_workspace')" :aria-pressed="agentWorkspaceOpen" @click="agentWorkspaceOpen = !agentWorkspaceOpen">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M15 4v16"/></svg>
        </button>
        <button v-if="configured" data-testid="agent-settings-toggle" class="btn btn-xs btn-ghost btn-square" :class="{ 'text-[#84cc16]': settingsOpen }" :title="t('agent_settings')" @click="settingsOpen = !settingsOpen">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        </button>
      </div>
    </div>

    <!-- settings: takes over the WHOLE panel body while open (a stacked
         section with a faint divider read as part of the chat) -->
    <div v-if="settingsOpen" class="knote-agent-settings flex-1 min-h-0" data-testid="agent-settings">
      <header class="knote-agent-settings-hero">
        <div>
          <div class="knote-agent-settings-kicker">Knote Agent</div>
          <h2>{{ t('agent_settings') }}</h2>
          <p>{{ t('agent_settings_desc') }}</p>
        </div>
        <div class="knote-agent-settings-state" :class="{ 'is-ready': configured && capabilities.chat }">
          <span></span>
          {{ configured && capabilities.chat ? t('agent_settings_ready') : t('agent_settings_pending') }}
        </div>
      </header>
      <div class="knote-agent-settings-body knote-sidebar-card-scroll">
      <p v-if="!configured" class="knote-agent-settings-intro">{{ t('agent_setup_desc') }}</p>

      <!-- ① connection & model -->
      <section data-settings-section="connection" class="knote-agent-settings-card">
        <div class="knote-agent-settings-section-head">
          <span class="knote-agent-settings-section-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg></span>
          <div>
            <h3>{{ t('agent_sec_conn') }}</h3>
            <p>{{ t('agent_sec_conn_desc') }}</p>
          </div>
        </div>
        <div class="knote-agent-protocol-switch">
          <button
            v-for="p in ['openai', 'anthropic']" :key="p"
            type="button"
            class="knote-agent-protocol-option"
            :class="agentConfig.protocol === p
              ? 'is-active'
              : ''"
            @click="agentConfig.protocol = p"
          >{{ p === 'openai' ? t('agent_protocol_openai') : 'Anthropic' }}</button>
        </div>
        <label class="knote-agent-setting-field">
          <span>{{ t('agent_base_url') }}</span>
          <input v-model.trim="agentConfig.baseUrl" class="font-mono" placeholder="https://api.deepseek.com" />
        </label>
        <label class="knote-agent-setting-field">
          <span>{{ t('agent_api_key') }}</span>
          <input v-model.trim="agentConfig.apiKey" type="password" class="font-mono" placeholder="sk-…" />
        </label>
        <label class="knote-agent-setting-field">
          <span>{{ t('agent_model') }}</span>
          <input v-model.trim="agentConfig.model" class="font-mono" placeholder="deepseek-chat" />
        </label>
        <!-- capability chips carry a ✓/✕ glyph, not colour alone (WCAG:
             state must not rely on colour); aria-label spells out支持/不支持 -->
        <div v-if="capabilities.checked" class="flex flex-wrap gap-1" role="group" :aria-label="t('agent_capabilities')">
          <span
            v-for="c in capabilityBadges"
            :key="c.label"
            class="badge badge-xs gap-0.5" :class="c.on ? 'badge-success text-white' : 'badge-ghost opacity-50'"
            :aria-label="`${c.label}: ${c.on ? t('agent_supported') : t('agent_unsupported')}`"
          ><span aria-hidden="true">{{ c.on ? '✓' : '✕' }}</span>{{ c.label }}</span>
        </div>
        <p v-if="capabilities.error" class="text-[10px] text-error break-all">{{ capabilityErrorText }}</p>
        <p
          v-for="(n, k) in (capabilities.notes || {})" :key="k"
          class="text-[10px] opacity-45 break-all leading-snug"
        >{{ capabilityNote(k, n) }}</p>
        <p v-if="capabilities.checked && capabilities.vision && capabilities.tools && !capabilities.pdf" class="text-[10px] opacity-45">
          {{ t('agent_pdf_page_hint') }}
        </p>
        <p v-if="capabilities.checked && !capabilities.tools" class="text-[10px] text-warning">{{ t('agent_no_tools_hint') }}</p>
      </section>

      <!-- ② enhancements -->
      <section data-settings-section="enhancements" class="knote-agent-settings-card">
        <div class="knote-agent-settings-section-head">
          <span class="knote-agent-settings-section-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg></span>
          <div>
            <h3>{{ t('agent_sec_extra') }}</h3>
            <p>{{ t('agent_sec_extra_desc') }}</p>
          </div>
        </div>
        <label class="knote-agent-setting-toggle">
          <input type="checkbox" v-model="agentConfig.webSearch" class="knote-agent-setting-checkbox" />
          <span class="min-w-0">
            <span class="text-[11px] font-bold">{{ t('agent_web_search') }}</span>
            <span class="block text-[10px] opacity-45 leading-relaxed">{{ t('agent_web_search_hint') }}</span>
          </span>
        </label>
        <label v-if="agentConfig.webSearch !== false" class="knote-agent-setting-field">
          <span>{{ t('agent_search_engine') }}</span>
          <select v-model="agentConfig.searchEngine">
            <option value="auto">{{ t('agent_search_engine_auto') }}</option>
            <option value="bing">Bing</option>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="mojeek">Mojeek</option>
          </select>
          <span class="block text-[10px] opacity-45 leading-relaxed mt-0.5">{{ t('agent_search_engine_hint') }}</span>
        </label>
        <label v-if="agentConfig.webSearch !== false" class="knote-agent-setting-field">
          <span>{{ t('agent_search_region') }}</span>
          <select v-model="agentConfig.searchRegion">
            <option value="auto">{{ t('agent_search_region_auto') }}</option>
            <option value="en">{{ t('agent_search_region_en') }}</option>
            <option value="zh">{{ t('agent_search_region_zh') }}</option>
          </select>
          <span class="block text-[10px] opacity-45 leading-relaxed mt-0.5">{{ t('agent_search_region_hint') }}</span>
        </label>
        <label class="knote-agent-setting-field">
          <span>{{ t('agent_persona') }}</span>
          <textarea
            v-model.trim="agentConfig.systemExtra"
            rows="2"
            :placeholder="t('agent_persona_ph')"
          ></textarea>
        </label>
        <label class="knote-agent-setting-field">
          <span>{{ t('agent_jina_key') }}</span>
          <input v-model.trim="agentConfig.jinaKey" class="font-mono" placeholder="jina_…" />
          <span class="block text-[10px] opacity-45 leading-relaxed mt-0.5">{{ t('agent_jina_hint') }}</span>
        </label>
        <label class="knote-agent-setting-field">
          <span>{{ t('agent_ctx_window') }}</span>
          <input
            v-model.number="agentConfig.ctxWindow"
            type="number" min="0" step="1000"
            class="font-mono"
            placeholder="0"
            @input="agentConfig.ctxWinUser = true"
            @blur="normalizeCtxWindow"
          />
          <span class="block text-[10px] opacity-45 leading-relaxed mt-0.5">{{ t('agent_ctx_window_hint') }}</span>
        </label>
        <label class="knote-agent-setting-toggle">
          <input type="checkbox" v-model="agentConfig.verify" class="knote-agent-setting-checkbox" @change="agentConfig.verifyOptIn = true" />
          <span class="min-w-0">
            <span class="text-[11px] font-bold">{{ t('agent_verify') }}</span>
            <span class="block text-[10px] opacity-45 leading-relaxed">{{ t('agent_verify_hint') }}</span>
          </span>
        </label>
      </section>

      <!-- ③ appearance -->
      <section data-settings-section="appearance" class="knote-agent-settings-card">
        <div class="knote-agent-settings-section-head">
          <span class="knote-agent-settings-section-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9c0-1.1-.9-2-2-2h-1.2a2 2 0 0 1-2-2V6.8A3.8 3.8 0 0 0 12 3Z"/><circle cx="7.5" cy="11" r=".7" fill="currentColor"/><circle cx="10" cy="7.5" r=".7" fill="currentColor"/><circle cx="8.5" cy="15" r=".7" fill="currentColor"/></svg></span>
          <div>
            <h3>{{ t('agent_chat_theme') }}</h3>
            <p>{{ t('agent_chat_theme_desc') }}</p>
          </div>
        </div>
        <div class="knote-agent-theme-switch" role="radiogroup" :aria-label="t('agent_chat_theme')">
          <button
            v-for="theme in ['white', 'aurora']"
            :key="theme"
            type="button"
            :data-testid="`agent-theme-${theme}`"
            class="knote-agent-theme-option"
            :class="{ 'is-active': agentConfig.chatTheme === theme }"
            role="radio"
            :aria-checked="agentConfig.chatTheme === theme"
            @click="agentConfig.chatTheme = theme"
          >
            <span class="knote-agent-theme-swatch" :data-theme-swatch="theme" aria-hidden="true"></span>
            {{ t(`agent_chat_theme_${theme}`) }}
          </button>
        </div>
      </section>

      <!-- ④ PDF layout analysis env (PaddleOCR) — one-click install; desktop only -->
      <section v-if="hasPdfEnv" data-settings-section="pdf" class="knote-agent-settings-card">
        <div class="knote-agent-settings-section-head">
          <span class="knote-agent-settings-section-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>
          <div class="min-w-0 flex-1">
            <h3>{{ t('agent_pdf_layout') }}</h3>
            <p>{{ t('agent_pdf_layout_hint') }}</p>
          </div>
          <span v-if="pdfEnvState.installed && !pdfBusy" class="badge badge-xs badge-success text-white gap-1 normal-case tracking-normal">✓ {{ t('agent_pdf_env_ready') }}</span>
        </div>
        <div class="flex items-center gap-1.5">
          <template v-if="pdfBusy">
            <span class="loading loading-spinner loading-xs"></span>
            <span class="text-[10px] opacity-60">{{ t('agent_pdf_env_installing') }}</span>
          </template>
          <template v-else-if="pdfEnvState.installed">
            <button class="btn btn-xs btn-ghost" @click="installPdfEnv(true)">{{ t('agent_pdf_env_reinstall') }}</button>
            <button class="btn btn-xs btn-ghost text-error" @click="uninstallPdfEnvConfirmed">{{ t('agent_pdf_env_uninstall') }}</button>
          </template>
          <template v-else>
            <button class="btn btn-xs text-white border-none" style="background:#84cc16" @click="installPdfEnv(false)">{{ t('agent_pdf_env_install') }}</button>
          </template>
        </div>
        <!-- streamed progress log (this panel's own element) -->
        <pre v-if="pdfEnvState.log.length" ref="pdfEnvLogRef" class="pdf-env-log max-h-32 overflow-auto text-[9.5px] leading-snug bg-base-200/60 rounded p-1.5 whitespace-pre-wrap break-all">{{ pdfEnvState.log.join('\n') }}</pre>
      </section>

      </div>
      <div class="knote-agent-settings-footer">
        <button class="knote-agent-settings-save" :disabled="capabilities.checking" @click="saveSettings">
          <span v-if="capabilities.checking" class="loading loading-spinner loading-xs"></span>
          <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path stroke-linecap="round" stroke-linejoin="round" d="M20 6 9 17l-5-5"/></svg>
          {{ t('agent_check') }}
        </button>
        <span>{{ t('agent_key_local_hint') }}</span>
      </div>
    </div>

    <!-- messages (hidden while the settings view owns the panel).
         role=log + aria-live: a screen reader announces each new assistant
         reply as it streams in without the user leaving the editor. -->
    <div v-show="!settingsOpen" class="knote-agent-message-stage flex-1 min-h-0">
      <div
        ref="listRef"
        class="knote-agent-message-list knote-sidebar-card-scroll h-full min-h-0 overflow-y-auto"
        :class="{ 'has-question-rail': userQuestionAnchors.length > 1 }"
        role="log" aria-live="polite" aria-relevant="additions text"
        :aria-label="t('agent')"
        @click="onListClick"
        @scroll="updateActiveQuestion"
      >
      <div v-if="!chatMessages.length" class="knote-agent-empty-state">
        <div class="knote-agent-empty-brand" data-testid="agent-empty-brand" lang="en">Knote Agent</div>
        <h3>{{ t('agent_empty_title') }}</h3>
        <p>{{ t('agent_empty_hint') }}</p>
        <div class="knote-agent-empty-rule"></div>
        <div v-if="suggestions.length" class="knote-agent-suggestions">
          <button
            v-for="(s, suggestionIndex) in suggestions" :key="s"
            @click="sendSuggestion(s)"
          >
            <span>{{ String(suggestionIndex + 1).padStart(2, '0') }}</span>
            <b>{{ s }}</b>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m9 18 6-6-6-6"/></svg>
          </button>
        </div>
      </div>
      <template v-for="(m, i) in chatMessages" :key="i">
        <!-- skip empty tool-only assistant segments (no text, not the last
             message whose trace chips would still be visible) -->
        <div
          v-if="(!m.programGenerated || messageBelongsToActiveSurface(m)) && !(m.role === 'assistant' && !m.text && !m.error && !m.receipt && i !== chatMessages.length - 1)"
          class="knote-agent-message-row group flex flex-col"
          :class="m.questionAnswer ? 'items-stretch is-question-answer' : m.role === 'user' ? 'items-end is-user' : 'items-start is-assistant'"
          :data-chat-message-index="i"
          :data-user-question="m.role === 'user' && !m.programGenerated ? 'true' : null"
        >
        <div v-if="m.role === 'assistant' && (m.text || m.error || m.receipt)" class="knote-agent-message-author">
          <b>Knote Agent</b>
          <button
            v-if="m.text"
            type="button"
            data-testid="agent-message-copy"
            data-agent-copy="message"
            :data-copy-key="`${i}:message`"
            class="knote-agent-message-copy"
            :class="{ 'is-copied': copyStates[`${i}:message`] }"
            :aria-label="copyStates[`${i}:message`] ? t('agent_copied') : t('agent_copy_message')"
            :title="copyStates[`${i}:message`] ? t('agent_copied') : t('agent_copy_message')"
          >
            <svg v-if="!copyStates[`${i}:message`]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m5 12 4 4L19 6"/></svg>
          </button>
        </div>
        <div
          v-if="m.selection"
          class="max-w-[92%] mb-1 border-l-2 border-[#84cc16]/50 bg-base-200/50 rounded-r-lg px-2 py-1 text-[10px] text-base-content/50 whitespace-pre-wrap break-words max-h-14 overflow-hidden"
        >{{ m.selection.text }}<span v-if="m.selection.lineHint" class="opacity-60">（{{ m.selection.lineHint }}）</span></div>
        <!-- empty assistant segments (tool-only bubbles) render no text box -->
        <article
          v-if="m.questionAnswer"
          data-testid="agent-question-answer-message"
          data-answered="true"
          class="knote-agent-question-answer-message"
        >
          <header>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m5 12 4 4L19 6"/></svg>
            <span>{{ t('agent_question_answered') }}</span>
          </header>
          <p class="knote-agent-question-answer-prompt">{{ m.questionAnswer.question }}</p>
          <p class="knote-agent-question-answer-value">{{ m.questionAnswer.answer }}</p>
        </article>
        <div
          v-else-if="m.role === 'assistant' && !m.error && renderMd && m.text"
          class="knote-agent-message knote-agent-message-assistant knote-agent-md max-w-[92%]"
          v-html="renderMd(m.text)"
        ></div>
        <div
          v-else-if="m.role === 'user' || m.error || m.text"
          class="knote-agent-message max-w-[92%] whitespace-pre-wrap break-words"
          :class="m.role === 'user'
            ? 'knote-agent-message-user'
            : m.error ? 'knote-agent-message-error' : 'knote-agent-message-assistant'"
        >{{ m.text }}</div>
        <div v-if="m.attachments && m.attachments.length" class="flex flex-wrap gap-1 mt-1" :class="m.role === 'user' ? 'justify-end' : ''">
          <span v-for="(a, j) in m.attachments" :key="j" class="badge badge-ghost badge-xs gap-1 max-w-[10rem]">
            <svg v-if="a.kind === 'pdf'" xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.7"/><path d="m5 18.5 4.8-5.3 3.2 3.5 2.4-2.6 3.6 4"/></svg>
            <span class="truncate">{{ a.name }}</span>
          </span>
        </div>
        <!-- tool status: ONLY on the newest message, ONLY the latest call —
             accumulating every call blew the chat up on long tool runs -->
        <div
          v-if="m.trace && m.trace.length && i === chatMessages.length - 1 && messageBelongsToActiveSurface(m)"
          class="mt-1 flex items-center gap-1.5 text-[10px] text-base-content/45"
        >
          <svg v-if="m.trace[m.trace.length - 1].done && !m.trace[m.trace.length - 1].error" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="text-success"><path stroke-linecap="round" stroke-linejoin="round" d="m5 13 4 4L19 7"/></svg>
          <svg v-else-if="m.trace[m.trace.length - 1].error" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" class="text-error"><path stroke-linecap="round" d="m7 7 10 10M17 7 7 17"/></svg>
          <span v-else class="loading loading-spinner knote-agent-brand-text" style="width:10px;height:10px"></span>
          <span>{{ m.trace[m.trace.length - 1].label }}<template v-if="m.trace[m.trace.length - 1].args">：{{ m.trace[m.trace.length - 1].args }}</template></span>
          <span v-if="m.trace.length > 1" class="opacity-50 tabular-nums">{{ tr('agent_step_n', { n: m.trace.length }) }}</span>
        </div>
        <div
          v-if="m.role === 'assistant' && receiptReviewText(m.receipt)"
          class="mt-1 flex items-center gap-1.5 text-[10px] text-base-content/55"
        >{{ receiptReviewText(m.receipt) }}</div>
        <div
          v-if="m.role === 'assistant' && receiptAutomationText(m.receipt)"
          data-testid="agent-review-receipt"
          class="mt-1 flex items-center gap-1.5 text-[10px] leading-relaxed text-base-content/55"
        >{{ receiptAutomationText(m.receipt) }}</div>
        <div
          v-if="m.role === 'assistant' && m.usage && (agentUsageTotalInput(m.usage) || m.usage.output)"
          class="mt-0.5 text-[9px] font-mono text-base-content/30"
        >{{ m.usage.estimated ? '≈ ' : '' }}{{ t('agent_tok_in') }} {{ fmtTok(agentUsageTotalInput(m.usage)) }} · {{ t('agent_tok_out') }} {{ fmtTok(m.usage.output) }} tokens</div>
        <!-- rollback: rewind the session to this user message (the original
             timeline is kept as a sibling 分支 session) -->
        <button
          v-if="m.role === 'user' && !m.programGenerated && !runningInActiveSession && !activeAgentQueue.length"
          class="mt-0.5 flex items-center gap-1 text-[10px] text-base-content/40 opacity-0 group-hover:opacity-100 hover:!text-[#4d7c0f] transition-opacity"
          :title="t('agent_rollback_hint')"
          @click="doRollback(i)"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>
          {{ t('agent_rollback') }}
        </button>
      </div>
      </template>
      <div
        v-if="provisionalText"
        data-testid="agent-provisional-message"
        data-provisional="true"
        class="knote-agent-message-row is-assistant items-start"
        aria-busy="true"
      >
        <div class="knote-agent-message-author"><b>Knote Agent</b><span class="knote-agent-testing-badge">{{ t('agent_streaming_draft') }}</span></div>
        <div class="knote-agent-message knote-agent-message-assistant knote-agent-message-provisional knote-agent-md max-w-[92%]" v-html="renderMd(provisionalText)"></div>
      </div>
      <div
        v-if="runningInActiveSession"
        data-testid="agent-run-status"
        :data-stalled="activeRunStalled ? 'true' : 'false'"
        :data-health="activeRunHealth"
        :data-verifying="activeAgentRuntime.verifying ? 'true' : 'false'"
        class="knote-agent-run-status flex items-center gap-2 text-xs text-base-content/50 px-1"
        :class="{ 'is-stalled': activeRunStalled }"
        role="status"
      >
        <svg class="knote-agent-heartbeat" viewBox="0 0 68 18" fill="none" aria-hidden="true"><path d="M1 9h15l4-6 6 12 6-9 5 3h30"/></svg>
        <span>{{ activeRunStatusText }}</span>
        <span v-if="activeAgentRuntime.verifying" class="knote-agent-testing-badge">{{ t('agent_testing') }}</span>
      </div>
      <div v-else-if="runningInActiveSurface" class="flex items-center gap-2 text-[11px] text-base-content/40 px-1" role="status">
        <span class="loading loading-spinner" style="width:10px;height:10px"></span>
        <span>{{ t('agent_running_elsewhere') }}</span>
      </div>
      </div>

      <nav
        v-if="userQuestionAnchors.length > 1"
        class="knote-agent-question-rail"
        :class="{ 'is-expanded': questionRailExpanded }"
        data-testid="agent-question-rail"
        :data-expanded="questionRailExpanded ? 'true' : 'false'"
        :data-collapsed-limit="QUESTION_RAIL_COLLAPSED_LIMIT"
        :aria-label="t('agent_quick_nav')"
        @mouseenter="expandQuestionRail"
        @mouseleave="collapseQuestionRail"
      >
        <div
          ref="questionRailListRef"
          class="knote-agent-question-rail-list"
          data-knote-local-scrollbar="true"
          data-testid="agent-question-rail-list"
          @wheel.stop.passive="revealQuestionRailScrollbar"
        >
          <button
            v-for="question in userQuestionAnchors"
            :key="question.messageIndex"
            type="button"
            data-testid="agent-question-quick"
            class="knote-agent-question-tick"
            :class="{ 'is-active': activeQuestionMessageIndex === question.messageIndex }"
            :title="question.label"
            :aria-label="question.label"
            :aria-current="activeQuestionMessageIndex === question.messageIndex ? 'true' : undefined"
            :data-message-index="question.messageIndex"
            @click="scrollToUserQuestion(question)"
          >
            <span class="knote-agent-question-label">{{ question.label }}</span>
            <span class="knote-agent-question-mark" aria-hidden="true"></span>
          </button>
        </div>
      </nav>
    </div>

    <!-- PDF shimmer + batch progress live OUTSIDE the scrollable message list:
         inside it they'd sit below the fold of a long conversation and the
         "cool animation" would simply never be seen -->
    <div v-if="!settingsOpen && (pdfProcessing || showBatchInChat)" class="px-3 pb-1 shrink-0 space-y-1">
      <!-- PDF → agent-processable format: mosaic shimmer while converting -->
      <PdfShimmer
        v-if="pdfProcessing"
        :label="pdfProcessLabel"
        :mode="pdfProcessing.mode || 'extract'"
        :sub="pdfProcessSub"
      />
      <!-- multi-agent batch progress (hidden here when the workspace panel shows it) -->
      <div v-if="showBatchInChat" data-testid="agent-batch-state" class="rounded-xl border border-base-200 bg-base-100/80 p-2.5">
        <div class="flex items-center gap-2 mb-1.5">
          <span v-if="batchState.running" class="loading loading-dots loading-xs"></span>
          <svg v-else-if="batchSucceeded" class="w-3.5 h-3.5 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          <svg v-else class="w-3.5 h-3.5 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 8v5m0 3h.01"/><circle cx="12" cy="12" r="9"/></svg>
          <span class="text-xs font-semibold">{{ t('batch_title') }}</span>
          <span class="text-[11px] opacity-50 ml-auto tabular-nums">{{ batchState.done }} / {{ batchState.total }}</span>
        </div>
        <div class="h-1.5 rounded-full bg-base-200 overflow-hidden mb-1.5">
          <div class="h-full bg-[#84cc16] transition-[width] duration-300" :style="{ width: (batchState.total ? Math.round(batchState.done / batchState.total * 100) : 0) + '%' }"></div>
        </div>
        <div class="max-h-28 overflow-auto space-y-0.5">
          <div v-for="it in batchState.items" :key="it.path" data-testid="agent-batch-item" :data-status="it.status" class="flex items-center gap-1.5 text-[11px]">
            <span class="shrink-0 w-3 text-center">
              <span v-if="it.status === 'done'" class="text-success">✓</span>
              <span v-else-if="it.status === 'error'" class="text-error">✕</span>
              <span v-else-if="it.status === 'aborted'" class="text-amber-500">−</span>
              <span v-else-if="it.status === 'running'" class="loading loading-spinner loading-xs" style="width:9px;height:9px"></span>
              <span v-else class="opacity-30">·</span>
            </span>
            <span class="truncate opacity-70" :title="it.error || it.out || it.path">{{ it.path }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- staged selection context ("问助手" quote chip) -->
    <div v-if="selectionContext && !settingsOpen" class="px-3 pb-1 shrink-0">
      <div class="flex items-start gap-1.5 text-[10px] bg-[#84cc16]/10 border border-[#84cc16]/25 rounded-lg px-2 py-1">
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 mt-0.5 text-[#84cc16]"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"/></svg>
        <span class="flex-1 text-base-content/60 whitespace-pre-wrap break-words max-h-10 overflow-hidden">{{ selectionContext.text }}</span>
        <span v-if="selectionContext.lineHint" class="opacity-40 shrink-0">{{ selectionContext.lineHint }}</span>
        <button class="shrink-0 opacity-50 hover:opacity-100 hover:text-error" :aria-label="t('agent_remove_selection')" @click="selectionContext = null">
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>

    <!-- draft attachments -->
    <div v-if="draftAtts.length && !settingsOpen" class="px-3 pb-1 flex flex-wrap gap-1.5 shrink-0">
      <div v-for="a in draftAtts" :key="a.id" data-testid="agent-draft-attachment" :data-name="a.name" class="relative group">
        <img v-if="attThumb(a)" :src="attThumb(a)" class="w-10 h-10 object-cover rounded-lg border border-base-300" />
        <div v-else-if="a.kind === 'md'" class="w-auto h-10 px-2 flex items-center gap-1 rounded-lg border border-[#84cc16]/40 bg-[#84cc16]/10 text-[10px] max-w-[9rem]">
          MD<span class="opacity-60 truncate">{{ a.name }}</span>
        </div>
        <div v-else class="w-auto h-10 px-2 flex items-center gap-1 rounded-lg border border-base-300 bg-base-200/60 text-[10px]">
          PDF<span class="opacity-60">{{ a.pages ? tr('agent_pages_short', { n: a.pages }) : '' }}</span>
        </div>
        <button class="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-base-300 text-[9px] leading-none hidden group-hover:flex items-center justify-center" :aria-label="tr('agent_remove_attachment', { name: a.name })" @click="removeDraft(a.id)"><span aria-hidden="true">✕</span></button>
      </div>
    </div>

    <!-- transient drop hint (unsupported type / not configured) -->
    <div v-if="dropNote && !settingsOpen" class="px-3 pb-1 shrink-0">
      <p class="text-[10px] text-warning leading-snug">{{ dropNote }}</p>
    </div>

    <div v-if="!settingsOpen && activeAgentQueue.length" data-testid="agent-queue" class="px-3 pb-2 shrink-0">
      <div class="knote-agent-queue-card rounded-lg border overflow-hidden">
        <div class="flex items-center gap-2 px-2.5 py-1.5 border-b border-base-200/70 text-[10px] font-bold uppercase tracking-wider text-base-content/45">
          <span>{{ t('agent_queue_title') }}</span>
          <span class="ml-auto font-mono normal-case">{{ activeAgentQueue.length }}</span>
        </div>
        <div class="max-h-28 overflow-y-auto divide-y divide-base-200/70">
          <div v-for="(item, queueIndex) in activeAgentQueue" :key="item.id" data-testid="agent-queue-item" :data-mode="item.mode" class="knote-agent-queue-item px-2.5 py-2 flex items-start gap-2">
            <span class="knote-agent-queue-index" aria-hidden="true">{{ queueIndex + 1 }}</span>
            <span class="sr-only">{{ queueModeLabel(item) }}</span>
            <div class="min-w-0 flex-1">
              <p class="text-[11px] leading-snug truncate" :title="item.text">{{ item.text }}</p>
              <p v-if="queueBlockedLabel(item)" class="mt-0.5 text-[9px] text-amber-600">{{ queueBlockedLabel(item) }}</p>
            </div>
            <button v-if="item.paused || item.blocked" type="button" data-testid="agent-queue-run-here" class="text-[9px] knote-agent-brand-text hover:underline whitespace-nowrap" @click="runQueuedAgentMessageHere(item.id)">{{ t('agent_queue_run_here') }}</button>
            <button type="button" data-testid="agent-queue-cancel" class="shrink-0 opacity-45 hover:opacity-100 hover:text-error" :aria-label="t('agent_queue_cancel')" @click="cancelQueuedAgentMessage(item.id)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path stroke-linecap="round" d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- program-owned permission: no controlled write/execution runs before this settles -->
    <div v-if="!settingsOpen && activePermission" data-testid="agent-permission" class="px-3 pt-2 pb-2.5 border-t border-base-200/70 shrink-0" aria-live="polite">
      <div class="knote-agent-permission-card rounded-lg border p-3">
        <div class="flex items-start gap-2">
          <svg class="w-4 h-4 mt-0.5 shrink-0 text-amber-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.7 3.2 7.8 7.5 9.5 4.3-1.7 7.5-4.8 7.5-9.5V6L12 3Z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
          <div class="min-w-0 flex-1">
            <div class="text-[10px] uppercase tracking-wider text-base-content/45 mb-1">{{ t('agent_permission_title') }}</div>
            <p class="text-xs font-semibold text-base-content/80">{{ permissionTitle }}</p>
          </div>
        </div>
        <pre data-testid="agent-permission-target" class="mt-2 whitespace-pre-wrap break-all rounded-lg border border-base-300/70 bg-base-100/80 px-2.5 py-2 text-[11px] leading-relaxed font-mono text-base-content/75">{{ permissionTarget }}</pre>
        <p v-if="permissionDestination" data-testid="agent-permission-destination" class="mt-1.5 text-[11px] text-base-content/60 break-all">{{ permissionDestination }}</p>
        <p v-if="permissionDetail" data-testid="agent-permission-detail" class="mt-1.5 text-[11px] text-base-content/60">{{ permissionDetail }}</p>
        <p v-if="permissionReviewReason" data-testid="agent-permission-review-reason" class="mt-2 border-l-2 border-warning/60 pl-2 text-[10px] leading-relaxed text-base-content/60">{{ permissionReviewReason }}</p>
        <p class="mt-2 text-[10px] leading-relaxed text-base-content/45">{{ t('agent_permission_once') }}</p>
        <div class="mt-2.5 flex items-center gap-2">
          <button type="button" data-testid="agent-permission-allow" class="btn btn-xs knote-agent-brand-action" @click="allowAgentPermission(activePermission.id)">{{ t('agent_permission_allow') }}</button>
          <button type="button" data-testid="agent-permission-deny" class="btn btn-xs btn-outline border-base-300" @click="denyAgentPermission(activePermission.id)">{{ t('agent_permission_deny') }}</button>
          <button type="button" data-testid="agent-permission-stop" class="ml-auto text-[10px] text-base-content/40 hover:text-error" @click="stopCurrentAgent">{{ t('agent_permission_stop') }}</button>
        </div>
      </div>
    </div>

    <!-- tool-driven clarification: answering resumes the same Agent turn -->
    <div v-if="!settingsOpen && activeQuestion && !activePermission" data-testid="agent-question" class="px-3 pt-2 pb-2.5 border-t border-base-200/70 shrink-0">
      <article class="knote-agent-question-card">
        <div class="flex items-start gap-2">
          <svg class="w-4 h-4 mt-0.5 shrink-0 knote-agent-brand-text" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M9.5 9a2.5 2.5 0 1 1 4.6 1.4c-.7.8-2.1 1-2.1 2.35"/><path d="M12 16h.01"/></svg>
          <div class="min-w-0 flex-1">
            <div class="text-[10px] uppercase tracking-wider text-base-content/45 mb-1">{{ t('agent_question_title') }}</div>
            <p class="text-xs leading-relaxed whitespace-pre-wrap break-words">{{ activeQuestion.question }}</p>
          </div>
        </div>
        <div v-if="activeQuestion.options.length" class="flex flex-wrap gap-1.5 mt-2.5">
          <button
            v-for="option in activeQuestion.options"
            :key="option"
            type="button"
            data-testid="agent-question-option"
            class="knote-agent-question-option"
            :disabled="questionSubmitting"
            @click="submitQuestionAnswer(option)"
          >{{ option }}</button>
        </div>
        <div class="mt-2.5 flex items-end gap-1.5">
          <textarea
            v-model="questionDraft"
            data-testid="agent-question-input"
            rows="1"
            class="knote-agent-question-input flex-1 min-w-0 resize-none"
            :placeholder="t('agent_question_placeholder')"
            :disabled="questionSubmitting"
            @keydown="onQuestionKeydown"
          ></textarea>
          <button type="button" data-testid="agent-question-answer" class="knote-agent-icon-control is-send" :disabled="!questionDraft.trim() || questionSubmitting" :title="t('agent_answer')" :aria-label="t('agent_answer')" :data-tooltip="t('agent_answer')" @click="submitQuestionAnswer()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12 3.27 3.13a59.77 59.77 0 0 1 18.02 8.87 59.77 59.77 0 0 1-18.02 8.87L6 12Zm0 0h7.5"/></svg>
          </button>
        </div>
        <button type="button" class="mt-2 text-[10px] text-base-content/40 hover:text-base-content/70" @click="dismissAgentQuestion(activeQuestion.id)">{{ t('agent_question_skip') }}</button>
      </article>
    </div>

    <!-- normal input -->
    <div v-show="!settingsOpen && !activeQuestion && !activePermission" class="knote-agent-composer-wrap shrink-0">
      <div class="knote-agent-composer">
        <textarea
          ref="inputRef"
          v-model="input"
          data-testid="agent-input"
          rows="2"
          class="knote-agent-input w-full bg-transparent border-none outline-none resize-none leading-relaxed text-sm min-h-[3.2rem]"
          :placeholder="configured ? t('agent_input_placeholder') : t('agent_configure_first')"
          @keydown="onKeydown"
          @paste="handlePaste"
        ></textarea>
        <div class="knote-agent-composer-toolbar">
          <button
            type="button"
            class="btn btn-xs btn-ghost btn-circle opacity-60 hover:opacity-100"
            :title="t('agent_attach')" :aria-label="t('agent_attach')"
            @click="pickFiles"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13"/></svg>
          </button>
          <!-- thinking depth: click to cycle 默认→低→中→高 (lime when active) -->
          <button
            class="knote-agent-reasoning-control flex items-center gap-1 h-6 px-2 rounded-full text-[10px] leading-none border transition-colors whitespace-nowrap shrink-0"
            :class="agentConfig.reasoning
              ? 'bg-[#84cc16]/15 text-[#4d7c0f] border-[#84cc16]/35 font-semibold'
              : 'text-base-content/40 border-transparent hover:bg-base-200/80 hover:text-base-content/70'"
            :title="t('agent_reasoning_hint')"
            :aria-label="`${t('agent_reasoning')} · ${reasoningLabel}`"
            @click="cycleReasoning"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 1 7 7c0 2.4-1.2 4.2-2.6 5.6-.6.6-.9 1.4-.9 2.2V18a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-1.2c0-.8-.3-1.6-.9-2.2C6.2 13.2 5 11.4 5 9a7 7 0 0 1 7-7z"/><path d="M9.5 22h5"/></svg>
            {{ t('agent_reasoning') }}·{{ reasoningLabel }}
          </button>
          <span class="knote-agent-composer-spacer"></span>
          <!-- context-window usage ring (only when the window size is known).
               Native title: a CSS tooltip gets clipped by the panel's
               overflow-hidden edges -->
          <span
            v-if="ctxRing"
            class="flex items-center gap-1 mr-1.5 cursor-default"
            role="img"
            :title="`${t('agent_ctx_used')} ≈${fmtCtx(ctxRing.used)} / ${fmtCtx(ctxRing.win)} tokens（${ctxRing.label}）`"
            :aria-label="`${t('agent_ctx_used')} ${ctxRing.label}`"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <circle cx="9" cy="9" r="7" fill="none" stroke="color-mix(in srgb, currentColor 15%, transparent)" stroke-width="2.5" />
              <circle
                cx="9" cy="9" r="7" fill="none"
                :stroke="ctxRing.color" stroke-width="2.5" stroke-linecap="round"
                :stroke-dasharray="ctxRing.dash"
                transform="rotate(-90 9 9)"
                style="transition: stroke-dasharray 0.4s ease, stroke 0.4s ease"
              />
            </svg>
            <span class="text-[9px] font-mono tabular-nums" :style="{ color: ctxRing.color, opacity: 0.85 }">{{ ctxRing.label }}</span>
          </span>
          <span v-if="agentConfig.model" class="text-[10px] font-mono opacity-30 truncate min-w-0 max-w-[8rem] mr-1">{{ agentConfig.model }}</span>
          <div class="knote-agent-primary-controls" :data-running="runningInActiveSession ? 'true' : 'false'">
            <button
              v-if="runningInActiveSession"
              type="button"
              data-testid="agent-stop"
              data-control-position="left"
              class="knote-agent-icon-control is-stop"
              :title="t('agent_stop')" :aria-label="t('agent_stop')" :data-tooltip="t('agent_stop')"
              @click="stopCurrentAgent"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
            </button>
            <button
              v-if="runningInActiveSession"
              type="button"
              data-testid="agent-queue-next"
              data-control-position="center"
              class="knote-agent-icon-control is-queue"
              :disabled="!input.trim() || draftAtts.length > 0"
              :title="t('agent_queue_next_hint')"
              :aria-label="t('agent_queue_next')"
              :data-tooltip="t('agent_queue_next')"
              @click="send('next')"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" d="M8 7h11M8 12h11M8 17h7"/><circle cx="4" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="17" r="1" fill="currentColor" stroke="none"/></svg>
            </button>
            <button
              type="button"
              data-testid="agent-send"
              data-control-position="right"
              class="knote-agent-icon-control is-send"
              :disabled="!input.trim() && !draftAtts.length"
              :title="runningInActiveSession ? t('agent_steer_hint') : t('agent_send')"
              :aria-label="runningInActiveSession ? t('agent_steer') : t('agent_send')"
              :data-tooltip="runningInActiveSession ? t('agent_steer') : t('agent_send')"
              @click="send(runningInActiveSession ? 'steer' : 'next')"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12 3.27 3.13a59.77 59.77 0 0 1 18.02 8.87 59.77 59.77 0 0 1-18.02 8.87L6 12Zm0 0h7.5"/></svg>
            </button>
          </div>
        </div>
      </div>
      <input ref="fileRef" data-testid="agent-file-input" type="file" multiple :accept="acceptTypes" class="hidden" @change="onFiles" />
    </div>
    </div>
    <!-- /LEFT chat column -->

    <!-- RIGHT: live workspace panel (float only) — the agent's current work stack -->
    <aside
      v-if="mode === 'float' && agentWorkspaceOpen && !settingsOpen"
      class="knote-agent-workspace flex flex-col w-56 shrink-0 min-h-0 h-full border-l border-base-200/70"
      :aria-label="t('agent_workspace_aria')"
    >
      <div class="flex items-center gap-1.5 px-3 py-2 border-b border-base-200/70 shrink-0">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-[#4d7c0f]"><rect x="3" y="4" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M15 4v16"/></svg>
        <span class="text-[11px] font-bold uppercase tracking-wider text-base-content/50 flex-1">{{ t('agent_workspace') }}</span>
        <span v-if="activeAgentRuntime.phase !== 'idle'" class="text-[9px] font-bold text-[#84cc16]">{{ activeAgentRuntime.phase === 'queued' ? t('agent_queued') : t('agent_workspace_running') }}</span>
        <button class="btn btn-xs btn-ghost btn-square -mr-1" :title="t('agent_workspace_hide')" :aria-label="t('agent_workspace_hide')" @click="agentWorkspaceOpen = false">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m15.75 4.5-7.5 7.5 7.5 7.5"/></svg>
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto px-2.5 py-2.5" role="log" aria-live="polite" aria-relevant="additions">
        <!-- empty state (no plan, sub-agents, or activity) -->
        <div v-if="!agentPlan.length && !batchState && !agentActivityStack.length" class="h-full flex flex-col items-center justify-center gap-2 text-center px-2 text-base-content/35">
          <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M15 4v16M7 9h4M7 13h4"/></svg>
          <span class="text-[11px] leading-relaxed">{{ t('agent_workspace_empty') }}</span>
        </div>
        <!-- plan checklist -->
        <div v-if="agentPlan.length" class="mb-3">
          <div class="flex items-center gap-1 mb-1.5 text-[10px] font-bold uppercase tracking-wider text-base-content/40">
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4"/></svg>
            <span class="flex-1">{{ t('agent_plan') }}</span>
            <span class="font-mono normal-case">{{ planDone }}/{{ agentPlan.length }}</span>
          </div>
          <ol class="space-y-1">
            <li v-for="(s, i) in agentPlan" :key="i" class="flex items-start gap-1.5 text-[11px] leading-snug">
              <span class="shrink-0 mt-[1px]">
                <svg v-if="s.status === 'completed'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="text-success"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
                <span v-else-if="s.status === 'in_progress'" class="loading loading-spinner text-[#84cc16] block" style="width:11px;height:11px"></span>
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-base-content/30"><circle cx="12" cy="12" r="9"/></svg>
              </span>
              <span :class="s.status === 'completed' ? 'line-through text-base-content/40' : s.status === 'in_progress' ? 'text-[#4d7c0f] font-semibold' : 'text-base-content/70'">{{ s.title }}</span>
            </li>
          </ol>
        </div>
        <!-- multi-agent batch: one sub-agent per file, progress + per-file status -->
        <div v-if="batchState" data-testid="agent-batch-state" class="mb-3">
          <div class="flex items-center gap-1 mb-1.5 text-[10px] font-bold uppercase tracking-wider text-base-content/40">
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="m12 2 9 5-9 5-9-5 9-5Zm9 10-9 5-9-5m18 5-9 5-9-5"/></svg>
            <span class="flex-1">{{ t('agent_subagents') }}</span>
            <span class="font-mono normal-case">{{ batchState.done }}/{{ batchState.total }}</span>
          </div>
          <div class="h-1.5 rounded-full bg-base-200 overflow-hidden mb-1.5">
            <div class="h-full bg-[#84cc16] transition-[width] duration-300" :style="{ width: (batchState.total ? Math.round(batchState.done / batchState.total * 100) : 0) + '%' }"></div>
          </div>
          <ol class="space-y-1">
            <li v-for="it in batchState.items" :key="it.path" data-testid="agent-batch-item" :data-status="it.status" class="flex items-center gap-1.5 text-[11px]">
              <span class="shrink-0">
                <svg v-if="it.status === 'done'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="text-success"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
                <svg v-else-if="it.status === 'error'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="text-rose-500"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
                <svg v-else-if="it.status === 'aborted'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="text-amber-500"><path stroke-linecap="round" d="M6 12h12"/></svg>
                <span v-else-if="it.status === 'running'" class="loading loading-spinner text-[#84cc16] block" style="width:11px;height:11px"></span>
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-base-content/30"><circle cx="12" cy="12" r="9"/></svg>
              </span>
              <span class="truncate text-base-content/70" :title="it.error || it.out || it.path">{{ it.path }}</span>
            </li>
          </ol>
        </div>
        <!-- live activity header (only when something sits above it) -->
        <div v-if="(agentPlan.length || batchState) && agentActivityStack.length" class="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-base-content/40">{{ t('agent_workspace_activity') }}</div>
        <!-- activity stack (newest first) -->
        <ol v-if="agentActivityStack.length" class="knote-agent-activity-list">
          <li
            v-for="a in agentActivityStack" :key="a.id"
            data-testid="agent-activity-row"
            :data-status="a.status"
            class="knote-agent-activity-row"
          >
            <div class="flex items-center gap-1.5">
              <span class="shrink-0" :class="workspaceIconColor(a)" v-html="workspaceIcon(a.kind)"></span>
              <span class="text-[11px] font-semibold text-base-content/80 truncate flex-1">{{ a.title }}</span>
              <!-- status glyph: never colour-only (a11y) -->
              <span v-if="a.status === 'running'" class="loading loading-spinner shrink-0 knote-agent-brand-text" style="width:9px;height:9px"></span>
              <svg v-else-if="a.status === 'done'" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 text-success"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
              <svg v-else-if="a.status === 'error'" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 text-error"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 text-base-content/40"><path stroke-linecap="round" stroke-linejoin="round" d="M18 6 6 18"/></svg>
            </div>
            <div v-if="a.detail" class="mt-0.5 text-[10px] text-base-content/50 break-all leading-snug" :title="a.detail">{{ a.detail }}</div>
            <div v-if="a.result" class="mt-0.5 text-[10px] text-success/80 truncate">{{ a.result }}</div>
          </li>
        </ol>
      </div>
    </aside>

    <!-- clear-chat confirmation (in-panel dialog, not the browser confirm) -->
    <div
      v-if="confirmClearOpen"
      data-testid="agent-clear-confirm"
      class="absolute inset-0 z-50 flex items-center justify-center bg-base-content/20 backdrop-blur-[1px]"
      @mousedown.stop
      @click.self="confirmClearOpen = false"
    >
      <div class="bg-base-100 border border-base-200 rounded-xl shadow-2xl p-4 w-64 max-w-[85%] space-y-2">
        <div class="text-sm font-bold">{{ t('agent_clear_title') }}</div>
        <p class="text-xs opacity-60 leading-relaxed">{{ t('agent_clear_desc') }}</p>
        <div class="flex justify-end gap-2 pt-1">
          <button data-testid="agent-clear-cancel" class="btn btn-xs btn-ghost" @click="confirmClearOpen = false">{{ t('agent_cancel') }}</button>
          <button data-testid="agent-clear-accept" class="btn btn-xs text-white border-none" style="background:#ef4444" @click="doClearChat">{{ t('agent_clear_do') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.knote-agent-panel{
  --agent-lime:#8ed02b;
  --agent-lime-deep:#5f9418;
  --agent-ink:#182019;
  --agent-glass:rgba(255,255,255,.48);
  --agent-glass-strong:rgba(255,255,255,.64);
  --agent-composer-radius:18px;
  isolation:isolate;
  overflow:hidden;
  overscroll-behavior:none;
  color:var(--agent-ink);
  background:
    radial-gradient(circle at 12% 5%,rgba(242,218,105,.12),transparent 34%),
    radial-gradient(circle at 88% 100%,rgba(142,208,43,.09),transparent 38%),
    rgba(252,253,250,.96);
}
.knote-agent-panel[data-agent-theme="white"]{--agent-glass:rgba(255,255,255,.76);--agent-glass-strong:rgba(255,255,255,.90);background:#fff}
.knote-agent-panel[data-agent-theme="white"]::before,.knote-agent-panel[data-agent-theme="white"]::after{display:none}
.knote-agent-panel::before{
  content:"";position:absolute;inset:-38% -30%;z-index:0;pointer-events:none;opacity:.58;filter:blur(42px);
  background:radial-gradient(circle at 24% 32%,rgba(252,225,109,.30),transparent 24%),radial-gradient(circle at 72% 58%,rgba(157,218,73,.24),transparent 28%),radial-gradient(circle at 48% 78%,rgba(238,246,219,.45),transparent 23%);
  will-change:transform,opacity;animation:agentAurora 24s cubic-bezier(.45,.05,.55,.95) infinite alternate
}
.knote-agent-panel::after{
  content:"";position:absolute;inset:-30% -24%;z-index:0;pointer-events:none;opacity:.34;filter:blur(48px);
  background:radial-gradient(circle at 74% 28%,rgba(247,220,101,.25),transparent 22%),radial-gradient(circle at 30% 70%,rgba(143,208,49,.21),transparent 25%);
  will-change:transform,opacity;animation:agentAuroraSecondary 31s cubic-bezier(.42,0,.58,1) infinite alternate-reverse
}
:global([data-theme="dark"] .knote-agent-panel){
  --agent-lime-deep:var(--agent-lime);--agent-ink:#edf4e8;--agent-glass:rgba(27,36,27,.76);--agent-glass-strong:rgba(31,41,31,.90);
  color:var(--agent-ink);background:#111812
}
:global([data-theme="dark"] .knote-agent-panel[data-agent-theme="white"]){--agent-glass:rgba(27,36,27,.82);--agent-glass-strong:rgba(31,41,31,.94);background:#111812}
:global([data-theme="dark"] .knote-agent-panel .knote-agent-header){border-color:rgba(226,240,220,.09)}
:global([data-theme="dark"] .knote-agent-panel .knote-agent-session-trigger),
:global([data-theme="dark"] .knote-agent-panel .knote-agent-session-heading),
:global([data-theme="dark"] .knote-agent-panel .knote-agent-settings-hero h2),
:global([data-theme="dark"] .knote-agent-panel .knote-agent-settings-section-head h3),
:global([data-theme="dark"] .knote-agent-panel .knote-agent-empty-state h3),
:global([data-theme="dark"] .knote-agent-panel .knote-agent-message-assistant){color:rgba(237,244,232,.90)}
:global([data-theme="dark"] .knote-agent-panel .knote-agent-settings-hero p),
:global([data-theme="dark"] .knote-agent-panel .knote-agent-settings-section-head p),
:global([data-theme="dark"] .knote-agent-panel .knote-agent-empty-state>p),
:global([data-theme="dark"] .knote-agent-panel .knote-agent-message-author){color:rgba(226,238,220,.56)}
:global([data-theme="dark"] .knote-agent-panel .knote-agent-session-popover),
:global([data-theme="dark"] .knote-agent-panel .knote-agent-review-mode-popover),
:global([data-theme="dark"] .knote-agent-panel .knote-agent-settings-card),
:global([data-theme="dark"] .knote-agent-panel .knote-agent-settings-intro),
:global([data-theme="dark"] .knote-agent-panel .knote-agent-question-rail.is-expanded .knote-agent-question-rail-list){background:#172018;border-color:rgba(220,238,210,.11);box-shadow:0 20px 54px rgba(0,0,0,.30)}
:global([data-theme="dark"] .knote-agent-panel .knote-agent-setting-field>input),
:global([data-theme="dark"] .knote-agent-panel .knote-agent-setting-field>select),
:global([data-theme="dark"] .knote-agent-panel .knote-agent-setting-field>textarea){color:#edf4e8;background:#111812;border-color:rgba(220,238,210,.13)}
:global([data-theme="dark"] .knote-agent-panel .knote-agent-suggestions button){color:rgba(237,244,232,.68);background:rgba(31,41,31,.72);border-color:rgba(220,238,210,.10)}
:global([data-theme="dark"] .knote-agent-panel .knote-agent-message-user){color:#e9f5df;background:rgba(65,91,45,.76)}
:global([data-theme="dark"] .knote-agent-panel .knote-agent-message-provisional){border-color:rgba(163,230,53,.28);background:rgba(28,40,27,.72)}
:global([data-theme="dark"] .knote-agent-panel .knote-agent-session-popover::before){display:none}
.knote-agent-chat-column,.knote-agent-workspace{position:relative;z-index:1}
.knote-agent-chat-column{container:agent-chat / inline-size;background:transparent;backdrop-filter:none}
.knote-agent-brand-text{color:var(--knote-brand)}
.knote-agent-brand-action{color:#fff!important;background:var(--knote-brand)!important;border-color:var(--knote-brand)!important}
.knote-agent-brand-action:hover,.knote-agent-brand-action:focus-visible{color:#fff!important;background:var(--knote-brand-strong)!important;border-color:var(--knote-brand-strong)!important}
.knote-agent-header{
  position:relative;z-index:30;overflow:visible;
  min-height:47px;
  border-bottom:1px solid rgba(26,38,23,.07);
  background:transparent;
  backdrop-filter:none;
}
.knote-agent-session-trigger{
  height:28px;padding:0 9px;border-radius:10px;
  font-size:12px;font-weight:650;color:rgba(24,32,25,.72);
  transition:background .2s ease,color .2s ease;
}
.knote-agent-session-trigger:hover,.knote-agent-session-trigger[aria-expanded="true"]{background:rgba(126,166,74,.09);color:var(--agent-ink)}
.knote-agent-session-popover{
  width:min(300px,calc(100vw - 28px));padding:12px 11px 12px;
  border:1px solid rgba(72,91,62,.11);border-radius:24px;
  background:#fdfefb;backdrop-filter:blur(24px) saturate(1.08);
  box-shadow:0 24px 60px rgba(32,44,27,.16),inset 0 1px rgba(255,255,255,.9);
  overflow:hidden;
}
.knote-agent-session-popover::before{
  content:"";position:absolute;inset:-70px -30px auto;height:140px;pointer-events:none;
  background:radial-gradient(circle at 25% 45%,rgba(246,221,110,.20),transparent 42%),radial-gradient(circle at 76% 20%,rgba(157,217,79,.17),transparent 38%);
  filter:blur(16px);
}
.knote-agent-session-popover-head{position:relative;display:flex;align-items:center;justify-content:space-between;padding:2px 7px 9px 8px}
.knote-agent-session-kicker,.knote-agent-settings-kicker{font-size:8.5px;text-transform:uppercase;letter-spacing:.18em;font-weight:750;color:rgba(70,88,59,.46)}
.knote-agent-session-heading{font-size:14px;font-weight:700;letter-spacing:-.01em;color:rgba(24,32,25,.88);margin-top:2px}
.knote-agent-session-new{
  width:29px;height:29px;border-radius:10px;display:grid;place-items:center;
  color:#5f9418;background:rgba(145,205,57,.10);border:1px solid rgba(132,204,22,.16);
  transition:transform .2s ease,background .2s ease;
}
.knote-agent-session-new:hover{transform:translateY(-1px);background:rgba(145,205,57,.18)}
.knote-agent-session-list{
  position:relative;max-height:270px;overflow-y:auto;overflow-x:hidden;padding:3px;
  scrollbar-width:none;
}
.knote-agent-session-list::-webkit-scrollbar{display:none}
.knote-agent-session-row{
  display:flex;align-items:center;gap:8px;min-height:38px;padding:6px 8px;
  border-radius:13px;font-size:12px;color:color-mix(in srgb,var(--agent-ink) 62%,transparent);cursor:pointer;
  transition:background .18s ease,color .18s ease,transform .18s ease;
}
.knote-agent-session-row:hover{background:color-mix(in srgb,var(--agent-ink) 7%,transparent);color:color-mix(in srgb,var(--agent-ink) 84%,transparent);transform:translateX(1px)}
.knote-agent-session-row.is-active{background:linear-gradient(100deg,color-mix(in srgb,var(--knote-brand) 16%,transparent),color-mix(in srgb,var(--knote-theme) 8%,transparent));color:var(--agent-lime-deep);font-weight:680}
.knote-agent-session-row-icon{width:22px;height:22px;border-radius:8px;display:grid;place-items:center;flex:none;background:color-mix(in srgb,var(--agent-ink) 7%,transparent)}
.knote-agent-session-row-icon .loading{width:10px;height:10px;color:var(--agent-lime)}
.knote-agent-session-count{font-size:9px;color:color-mix(in srgb,var(--agent-ink) 56%,transparent);opacity:1;font-variant-numeric:tabular-nums}
.knote-agent-session-running{font-size:8px;color:#74b51e;font-weight:700}
.knote-agent-session-remove{width:20px;height:20px;border-radius:7px;display:grid;place-items:center;opacity:0;color:#d05252;transition:opacity .16s ease,background .16s ease}
.knote-agent-session-row:hover .knote-agent-session-remove{opacity:.5}.knote-agent-session-remove:hover{opacity:1!important;background:rgba(220,70,70,.08)}
.knote-agent-review-mode-trigger{
  display:grid;place-items:center;width:29px;height:29px;padding:0;border:0;border-radius:9px;
  color:color-mix(in srgb,var(--agent-ink) 68%,transparent);background:transparent;box-shadow:none;transition:color .16s ease
}
.knote-agent-review-mode-wrap{position:static}
.knote-agent-review-mode-trigger>svg{width:16px;height:16px}
.knote-agent-review-mode-trigger[aria-expanded="true"],.knote-agent-review-mode-trigger:hover{color:var(--agent-lime-deep);background:transparent;box-shadow:none}
.knote-agent-review-mode-trigger:focus-visible{outline:2px solid color-mix(in srgb,var(--knote-brand) 48%,transparent);outline-offset:2px}
.knote-agent-review-mode-trigger:disabled{opacity:.58;cursor:wait}
.knote-agent-review-mode-popover{
  position:absolute;z-index:55;right:9px;top:calc(100% + 7px);width:min(310px,calc(100cqw - 18px));box-sizing:border-box;
  padding:13px;border:1px solid color-mix(in srgb,var(--agent-ink) 12%,transparent);border-radius:14px;
  color:var(--agent-ink);background:#fdfefb;box-shadow:0 20px 52px rgba(32,44,27,.18),inset 0 1px rgba(255,255,255,.9)
}
.knote-agent-review-mode-popover header{display:grid;gap:3px;margin-bottom:10px}
.knote-agent-review-mode-popover header b{font-size:11px;white-space:nowrap}
.knote-agent-review-mode-popover header span{min-width:0;font-size:8.5px;line-height:1.35;color:color-mix(in srgb,var(--agent-ink) 48%,transparent)}
.knote-agent-review-policy-grid{display:grid;grid-template-columns:1fr;gap:6px}
.knote-agent-review-policy-option{min-width:0;border:1px solid color-mix(in srgb,var(--agent-ink) 10%,transparent);border-radius:11px;color:color-mix(in srgb,var(--agent-ink) 64%,transparent);background:color-mix(in srgb,var(--agent-glass-strong) 62%,transparent);overflow:hidden;transition:border-color .16s ease,background .16s ease,color .16s ease}
.knote-agent-review-policy-option.is-active{color:var(--agent-lime-deep);border-color:color-mix(in srgb,var(--knote-brand) 38%,transparent);background:color-mix(in srgb,var(--knote-brand) 11%,var(--agent-glass-strong))}
.knote-agent-review-policy-row{display:flex;align-items:center;min-width:0;min-height:39px}
.knote-agent-review-policy-choice{flex:1;min-width:0;min-height:39px;padding:7px 10px;display:flex;align-items:center;gap:8px;text-align:left;color:inherit;background:transparent;line-height:1.2}
.knote-agent-review-policy-choice>b{font-size:10px;font-weight:720}
.knote-agent-review-policy-choice:focus-visible,.knote-agent-review-document-toggle:focus-visible{outline:2px solid color-mix(in srgb,var(--knote-brand) 48%,transparent);outline-offset:-2px}
.knote-agent-review-policy-icon{width:20px;height:20px;display:grid;place-items:center}.knote-agent-review-policy-icon svg{width:18px;height:18px}
.knote-agent-review-document-toggle{flex:none;min-height:31px;margin-right:8px;padding:4px 2px 4px 5px;border:0;border-radius:8px;display:flex;align-items:center;gap:6px;background:transparent;font-size:8.5px;font-weight:650;color:color-mix(in srgb,var(--agent-ink) 62%,transparent)}
.knote-agent-review-document-toggle>span{white-space:nowrap;transition:color .16s ease}
.knote-agent-review-document-toggle>i{position:relative;width:30px;height:17px;border-radius:6px;background:color-mix(in srgb,var(--agent-ink) 14%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--agent-ink) 8%,transparent)}
.knote-agent-review-document-toggle>i>b{position:absolute;left:3px;top:3px;width:12px;height:11px;border-radius:3px;background:var(--agent-glass-strong);box-shadow:0 1px 4px color-mix(in srgb,var(--agent-ink) 22%,transparent);transition:transform .16s ease,background .16s ease}
.knote-agent-review-document-toggle[aria-checked="true"]>i{background:color-mix(in srgb,var(--knote-brand) 46%,transparent)}.knote-agent-review-document-toggle[aria-checked="true"]>i>b{transform:translateX(12px);background:var(--knote-brand)}
.knote-agent-workspace-toggle{overflow:hidden;isolation:isolate}
.knote-agent-workspace-toggle>svg{position:relative;z-index:1}
.knote-agent-workspace-toggle.is-running::before{content:"";position:absolute;z-index:0;inset:-45%;background:linear-gradient(105deg,transparent 34%,rgba(255,255,255,.86) 48%,color-mix(in srgb,var(--knote-brand) 45%,transparent) 54%,transparent 68%);transform:translateX(-80%) rotate(8deg);animation:knote-agent-workspace-sheen 1.55s ease-in-out infinite}
.knote-agent-settings{
  position:relative;display:flex;flex-direction:column;align-self:stretch;
  width:100%;min-width:0;max-width:100%;overflow:hidden;box-sizing:border-box;
  background:transparent;
}
.knote-agent-settings-hero{
  position:relative;z-index:1;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
  flex:none;width:100%;min-width:0;box-sizing:border-box;
  padding:19px 30px 15px 18px;border-bottom:1px solid rgba(68,87,57,.08);
}
.knote-agent-settings-hero>div:first-child{min-width:0}
.knote-agent-settings-hero h2{margin:3px 0 3px;font-size:20px;line-height:1.1;font-weight:670;letter-spacing:-.035em;color:var(--agent-ink)}
.knote-agent-settings-hero p{margin:0;max-width:310px;font-size:10px;line-height:1.5;color:rgba(35,47,31,.46)}
.knote-agent-settings-state{
  display:flex;align-items:center;gap:6px;flex:none;margin-top:4px;padding:5px 8px;border-radius:999px;
  font-size:8.5px;font-weight:650;color:rgba(41,52,37,.46);background:rgba(255,255,255,.52);border:1px solid rgba(75,94,65,.10)
}
.knote-agent-settings-state span{width:6px;height:6px;border-radius:50%;background:#cbd0c8}.knote-agent-settings-state.is-ready{color:#5f8d27}.knote-agent-settings-state.is-ready span{background:#8fd334;box-shadow:0 0 0 3px rgba(142,208,43,.13)}
.knote-agent-settings-body{
  position:relative;z-index:1;flex:1;width:100%;min-width:0;min-height:0;
  overflow-y:auto;overflow-x:hidden;box-sizing:border-box;
  padding:13px 14px 20px;scroll-behavior:smooth;scrollbar-width:none;
}
.knote-agent-settings-body::-webkit-scrollbar{display:none}
.knote-agent-settings-intro{margin:0 2px 10px;padding:10px 12px;border-radius:13px;font-size:10px;line-height:1.55;color:rgba(39,53,34,.57);background:rgba(255,255,255,.64);border:1px solid rgba(91,112,75,.10)}
.knote-agent-settings-card{
  width:100%;min-width:0;box-sizing:border-box;
  margin-bottom:11px;padding:14px;border:1px solid rgba(76,96,64,.10);border-radius:19px;
  background:rgba(255,255,255,.72);box-shadow:0 9px 28px rgba(45,63,35,.055),inset 0 1px rgba(255,255,255,.9);
  scroll-margin-top:16px;
}
.knote-agent-settings-section-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:12px}
.knote-agent-settings-section-icon{width:29px;height:29px;display:grid;place-items:center;flex:none;border-radius:10px;color:#6da81e;background:linear-gradient(145deg,rgba(153,215,69,.16),rgba(246,221,108,.10));border:1px solid rgba(132,204,22,.13)}
.knote-agent-settings-section-head h3{margin:1px 0 1px;font-size:12px;font-weight:700;color:rgba(24,32,25,.82)}
.knote-agent-settings-section-head p{margin:0;font-size:9px;line-height:1.45;color:rgba(35,47,31,.43)}
.knote-agent-protocol-switch{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:3px;margin-bottom:10px;border-radius:12px;background:color-mix(in srgb,var(--agent-ink) 7%,transparent)}
.knote-agent-protocol-option{height:29px;border-radius:9px;font-size:10px;font-weight:650;color:color-mix(in srgb,var(--agent-ink) 50%,transparent);transition:color .18s ease,background .18s ease,box-shadow .18s ease}
.knote-agent-protocol-option:hover{color:color-mix(in srgb,var(--agent-ink) 78%,transparent)}.knote-agent-protocol-option.is-active{color:var(--agent-lime-deep);background:var(--agent-glass-strong);box-shadow:0 3px 10px color-mix(in srgb,var(--agent-ink) 8%,transparent),inset 0 0 0 1px color-mix(in srgb,var(--knote-brand) 22%,transparent)}
.knote-agent-theme-switch{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.knote-agent-theme-option{display:flex;align-items:center;gap:7px;min-height:34px;padding:6px 8px;border:1px solid rgba(78,98,65,.14);border-radius:9px;color:rgba(31,43,27,.50);font-size:10px;font-weight:650;text-align:left;transition:border-color .18s ease,background .18s ease,color .18s ease}
.knote-agent-theme-option:hover{color:rgba(31,43,27,.78);background:rgba(107,127,93,.07)}
.knote-agent-theme-option.is-active{color:var(--knote-brand-strong);border-color:color-mix(in srgb,var(--knote-brand) 38%,transparent);background:var(--knote-brand-soft)}
.knote-agent-theme-swatch{width:24px;height:18px;flex:none;border:1px solid rgba(78,98,65,.14);border-radius:6px;background:#fff}
.knote-agent-theme-swatch[data-theme-swatch="aurora"]{background:linear-gradient(135deg,color-mix(in srgb,var(--knote-brand) 30%,#fff),color-mix(in srgb,var(--knote-brand-warm) 24%,#fff),color-mix(in srgb,var(--knote-brand) 18%,#fff))}
.knote-agent-setting-field{display:block;margin-top:9px}.knote-agent-setting-field>span:first-child{display:block;margin:0 2px 4px;font-size:9px;font-weight:650;color:rgba(29,42,25,.48)}
.knote-agent-setting-field>input,.knote-agent-setting-field>select,.knote-agent-setting-field>textarea{
  width:100%;min-height:34px;padding:7px 10px;border:1px solid rgba(78,98,65,.14);border-radius:11px;outline:0;
  font-size:10.5px;line-height:1.35;color:rgba(20,30,18,.82);background:rgba(249,251,247,.85);
  transition:border .18s ease,box-shadow .18s ease,background .18s ease;
}
.knote-agent-setting-field>textarea{resize:vertical;min-height:58px}
.knote-agent-setting-field>input:focus,.knote-agent-setting-field>select:focus,.knote-agent-setting-field>textarea:focus{border-color:rgba(132,204,22,.5);background:#fff;box-shadow:0 0 0 3px rgba(132,204,22,.09)}
.knote-agent-setting-field>span:not(:first-child){display:block;margin:4px 2px 0;font-size:8.5px;line-height:1.45;color:rgba(33,45,29,.40)}
.knote-agent-setting-toggle{display:flex;align-items:flex-start;gap:9px;margin-top:10px;padding:10px;border-radius:13px;cursor:pointer;color:var(--agent-ink);background:color-mix(in srgb,var(--agent-glass-strong) 74%,transparent);border:1px solid color-mix(in srgb,var(--agent-ink) 10%,transparent)}
.knote-agent-setting-checkbox{appearance:none;display:grid;place-content:center;flex:none;width:16px;height:16px;margin-top:2px;padding:0;border:1px solid color-mix(in srgb,var(--agent-ink) 34%,transparent);border-radius:4px;color:#15200f;background:transparent;cursor:pointer;transition:border-color .16s ease,background-color .16s ease}
.knote-agent-setting-checkbox::before{content:"";width:4px;height:8px;border:solid currentColor;border-width:0 2px 2px 0;opacity:0;transform:translateY(-1px) rotate(45deg) scale(.6);transition:opacity .12s ease,transform .12s ease}
.knote-agent-setting-checkbox:checked{border-color:#84cc16;background-color:#84cc16}
.knote-agent-setting-checkbox:checked::before{opacity:1;transform:translateY(-1px) rotate(45deg) scale(1)}
.knote-agent-setting-checkbox:focus-visible{outline:2px solid color-mix(in srgb,var(--knote-brand) 48%,transparent);outline-offset:2px}
.knote-agent-settings-footer{
  position:relative;z-index:2;flex:none;display:flex;align-items:center;gap:10px;
  width:100%;min-width:0;box-sizing:border-box;padding:10px 14px 11px;
  border-top:1px solid rgba(69,87,58,.08);background:transparent;backdrop-filter:none;
}
.knote-agent-settings-footer>span{font-size:8.5px;line-height:1.35;color:rgba(35,47,31,.39)}
.knote-agent-settings-save{
  height:31px;padding:0 12px;border-radius:11px;display:flex;align-items:center;gap:6px;flex:none;
  color:#fff;font-size:10px;font-weight:700;background:linear-gradient(135deg,#93d432,#78bd1e);
  box-shadow:0 7px 16px rgba(113,180,27,.20);transition:transform .18s ease,box-shadow .18s ease,opacity .18s ease;
}
.knote-agent-settings-save:hover{transform:translateY(-1px);box-shadow:0 9px 20px rgba(113,180,27,.25)}.knote-agent-settings-save:disabled{opacity:.45;transform:none}
.knote-agent-message-stage{position:relative;overflow:hidden}
.knote-agent-message-list{position:relative;width:100%;max-width:100%;min-width:0;box-sizing:border-box;overflow-x:hidden;padding:16px 14px 22px}
.knote-agent-message-list.has-question-rail{padding-right:30px;scrollbar-width:none}
.knote-agent-message-list.has-question-rail::-webkit-scrollbar{display:none;width:0;height:0}
.knote-agent-question-rail{
  position:absolute;z-index:8;right:5px;top:8px;bottom:8px;width:22px;
  display:flex;align-items:center;justify-content:flex-end;pointer-events:auto;
  transition:width .28s cubic-bezier(.22,.8,.2,1);
}
.knote-agent-question-rail.is-expanded{width:min(216px,calc(100% - 14px))}
.knote-agent-question-rail-list{
  width:100%;height:auto;max-height:min(220px,calc(100% - 4px));padding:0 3px;display:flex;flex-direction:column;
  justify-content:flex-start;align-items:flex-end;overflow:hidden;
  border:1px solid transparent;border-radius:20px;background:transparent;box-shadow:none;
  overscroll-behavior:contain;scrollbar-gutter:stable;
  transition:padding .24s ease,border-color .24s ease,background .24s ease,box-shadow .24s ease;
}
.knote-agent-question-rail.is-expanded .knote-agent-question-rail-list{
  height:auto;max-height:min(430px,calc(100% - 4px));min-height:0;padding:10px 7px 10px 12px;
  justify-content:flex-start;align-items:stretch;overflow-x:hidden;overflow-y:auto;
  border-color:rgba(71,90,58,.09);background:rgba(255,255,255,.82);
  box-shadow:0 18px 44px rgba(48,63,40,.11);
  backdrop-filter:blur(18px);scrollbar-width:thin;scrollbar-color:transparent transparent;
}
.knote-agent-question-rail-list::-webkit-scrollbar{width:5px}
.knote-agent-question-rail-list::-webkit-scrollbar-track{background:transparent}
.knote-agent-question-rail-list::-webkit-scrollbar-thumb{border-radius:99px;background:transparent}
.knote-agent-question-rail-list::-webkit-scrollbar-button{display:none!important;width:0;height:0}
.knote-agent-question-rail.is-user-scrolling .knote-agent-question-rail-list{scrollbar-color:rgba(101,118,92,.25) transparent}
.knote-agent-question-rail.is-user-scrolling .knote-agent-question-rail-list::-webkit-scrollbar-thumb{background:rgba(101,118,92,.25)}
.knote-agent-question-rail-list::-webkit-scrollbar-thumb:hover{background:transparent}
.knote-agent-question-rail.is-user-scrolling .knote-agent-question-rail-list::-webkit-scrollbar-thumb:hover{background:rgba(101,118,92,.25)}
.knote-agent-question-tick{
  display:flex;flex:0 0 22px;appearance:none;border:0;padding:0;pointer-events:auto;
  width:17px;height:22px;min-height:22px;align-items:center;justify-content:flex-end;gap:10px;
  color:rgba(38,48,33,.48);background:transparent;
  transition:width .22s ease,color .2s ease,background .2s ease,transform .2s ease;
}
.knote-agent-question-label{
  display:none;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  text-align:right;font-size:11px;line-height:1.35;font-weight:430;
}
.knote-agent-question-mark{
  display:block;flex:none;width:9px;height:3px;border-radius:999px;background:rgba(91,108,82,.26);
  transition:width .2s ease,background .2s ease,box-shadow .2s ease,transform .2s ease;
}
.knote-agent-question-tick:hover .knote-agent-question-mark{width:14px;background:rgba(132,204,22,.58);transform:scaleY(1.25)}
.knote-agent-question-tick.is-active .knote-agent-question-mark{width:17px;background:#79c31f;box-shadow:0 2px 8px rgba(106,183,20,.28)}
.knote-agent-question-rail.is-expanded .knote-agent-question-tick{
  width:100%;height:34px;min-height:34px;flex:none;padding:0 4px 0 8px;border-radius:10px;
}
.knote-agent-question-rail.is-expanded .knote-agent-question-label{display:block}
.knote-agent-question-rail.is-expanded .knote-agent-question-tick:hover{color:rgba(28,37,24,.82);background:rgba(142,208,43,.07)}
.knote-agent-question-rail.is-expanded .knote-agent-question-tick.is-active{color:#4d7c0f;font-weight:650}
.knote-agent-empty-state{width:100%;max-width:100%;min-width:0;min-height:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;text-align:center;padding:24px 10px 30px}
.knote-agent-empty-brand{position:relative;display:inline-block;max-width:100%;margin:0 0 9px;font-family:'Cinzel Variable',serif;font-size:clamp(30px,12cqi,48px);line-height:1;font-weight:900;letter-spacing:-.035em;white-space:nowrap;background:linear-gradient(118deg,rgba(255,255,255,.08) 8%,rgba(255,255,255,.62) 28%,rgba(255,255,255,.12) 47%,rgba(255,255,255,.46) 67%,rgba(255,255,255,.06) 88%),radial-gradient(ellipse at center,var(--knote-brand),transparent 68%),radial-gradient(ellipse at center,var(--knote-theme),transparent 66%),radial-gradient(ellipse at center,color-mix(in srgb,var(--knote-brand) 64%,var(--knote-theme)),transparent 70%),linear-gradient(108deg,color-mix(in srgb,var(--color-base-content) 82%,var(--knote-brand)),var(--knote-brand),var(--knote-theme),color-mix(in srgb,var(--color-base-content) 78%,var(--knote-theme)));background-size:240% 180%,155% 185%,190% 145%,170% 205%,100% 100%;background-position:12% 28%,8% 22%,88% 18%,36% 86%,50% 50%;-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;-webkit-text-stroke:.25px color-mix(in srgb,#fff 24%,transparent);will-change:background-position;animation:knote-agent-title-flow 23s linear -7s infinite}
.knote-agent-empty-state h3{margin:4px 0 5px;font-size:19px;line-height:1.2;font-weight:660;letter-spacing:-.035em;color:rgba(24,32,25,.88)}
.knote-agent-empty-state>p{max-width:300px;margin:0;font-size:11px;line-height:1.6;color:rgba(31,43,27,.46)}
.knote-agent-empty-rule{width:34px;height:2px;margin:15px 0 12px;border-radius:99px;background:linear-gradient(90deg,#f2d869,#8ed02b)}
.knote-agent-suggestions{width:min(100%,330px);max-width:100%;min-width:0;display:flex;flex-direction:column;gap:5px}
.knote-agent-suggestions button{width:100%;min-width:0;box-sizing:border-box;display:grid;grid-template-columns:24px minmax(0,1fr) 14px;align-items:center;gap:7px;padding:8px 10px;border-radius:12px;text-align:left;color:rgba(32,44,28,.55);border:1px solid rgba(77,98,64,.09);background:rgba(255,255,255,.52);transition:all .18s ease}
.knote-agent-suggestions button:hover{color:#4d7c0f;border-color:rgba(132,204,22,.24);background:rgba(249,253,243,.88);transform:translateX(2px)}
.knote-agent-suggestions button>span{font-size:8px;letter-spacing:.08em;opacity:.42}.knote-agent-suggestions button>b{font-size:10.5px;font-weight:570;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.knote-agent-suggestions button>svg{opacity:.42}
.knote-agent-message-row{margin-bottom:16px}
.knote-agent-message-author{display:flex;align-items:center;gap:6px;margin:0 0 5px 2px;color:rgba(33,45,29,.48)}
.knote-agent-message-author>b{font-size:9px;font-weight:650;letter-spacing:.01em}
.knote-agent-message-copy{width:20px;height:20px;display:grid;place-items:center;margin-left:auto;border-radius:6px;color:color-mix(in srgb,var(--agent-ink) 42%,transparent);opacity:0;transition:opacity .16s ease,color .16s ease,background .16s ease}
.knote-agent-message-row:hover .knote-agent-message-copy,.knote-agent-message-copy:focus-visible,.knote-agent-message-copy.is-copied{opacity:1}
.knote-agent-message-copy:hover,.knote-agent-message-copy:focus-visible{color:var(--knote-brand-strong);background:var(--knote-brand-soft)}
.knote-agent-message-copy svg{width:12px;height:12px}.knote-agent-message-copy.is-copied{color:var(--color-success)}
.knote-agent-message{padding:9px 12px;border-radius:16px;font-size:12.5px;line-height:1.62;box-shadow:none}
.knote-agent-message-assistant{color:rgba(24,32,25,.82);background:var(--agent-glass);border:1px solid rgba(78,98,65,.10);border-top-left-radius:7px}
.knote-agent-message-provisional{border-style:dashed;border-color:color-mix(in srgb,var(--knote-brand) 34%,transparent);background:color-mix(in srgb,var(--agent-glass) 80%,transparent)}
.knote-agent-testing-badge{display:inline-flex;align-items:center;min-height:18px;padding:1px 6px;border:1px solid color-mix(in srgb,var(--knote-brand) 24%,transparent);border-radius:999px;color:var(--knote-brand-strong);background:var(--knote-brand-soft);font-size:8px;font-weight:750;letter-spacing:.04em;white-space:nowrap}
.knote-agent-run-status{min-height:22px}.knote-agent-run-status.is-stalled{color:var(--color-error)}
.knote-agent-heartbeat{width:36px;height:14px;flex:none;overflow:visible;color:var(--knote-brand-strong)}
.knote-agent-heartbeat path{stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:72;animation:knote-agent-heartbeat 1.7s linear infinite}
.knote-agent-run-status.is-stalled .knote-agent-heartbeat{color:var(--color-error)}
.knote-agent-run-status.is-stalled .knote-agent-heartbeat path{animation-duration:3.4s}
.knote-agent-message-user{
  color:rgba(27,42,20,.94);background:rgba(232,244,213,.90);
  border:1px solid rgba(105,151,47,.30);
  border-top-right-radius:7px;font-weight:520;box-shadow:none
}
.knote-agent-message-error{color:#c33d4e;background:rgba(255,241,243,.80);border:1px solid rgba(239,68,68,.18)}
.knote-agent-question-answer-message{width:100%;padding:10px 12px;border-left:3px solid var(--color-success);border-top:1px solid color-mix(in srgb,var(--color-base-content) 10%,transparent);border-bottom:1px solid color-mix(in srgb,var(--color-base-content) 10%,transparent);background:color-mix(in srgb,var(--color-base-100) 50%,transparent);color:color-mix(in srgb,var(--color-base-content) 82%,transparent)}
.knote-agent-question-answer-message header{display:flex;align-items:center;gap:6px;margin-bottom:7px;color:var(--color-success);font-size:9px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}
.knote-agent-question-answer-message header svg{width:13px;height:13px;flex:none}
.knote-agent-question-answer-prompt{margin:0 0 6px;font-size:10.5px;line-height:1.45;color:color-mix(in srgb,var(--color-base-content) 52%,transparent)}
.knote-agent-question-answer-value{margin:0;padding-left:9px;border-left:1px solid color-mix(in srgb,var(--color-success) 30%,transparent);font-size:12px;line-height:1.6;font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere}
.knote-agent-question-card{padding:11px 12px;border-left:3px solid var(--knote-brand);border-top:1px solid color-mix(in srgb,var(--color-base-content) 10%,transparent);border-bottom:1px solid color-mix(in srgb,var(--color-base-content) 10%,transparent);background:color-mix(in srgb,var(--color-base-100) 46%,transparent)}
.knote-agent-question-option{min-height:30px;padding:5px 9px;border:1px solid color-mix(in srgb,var(--color-base-content) 18%,transparent);border-radius:6px;background:color-mix(in srgb,var(--color-base-100) 72%,transparent);color:color-mix(in srgb,var(--color-base-content) 78%,transparent);font-size:11px;line-height:1.35;transition:border-color .16s ease,background .16s ease,color .16s ease,box-shadow .16s ease}
.knote-agent-question-option:hover,.knote-agent-question-option:focus-visible{border-color:color-mix(in srgb,var(--knote-brand) 48%,transparent);background:var(--color-base-100);color:var(--knote-brand-strong);box-shadow:0 6px 20px color-mix(in srgb,var(--color-base-content) 10%,transparent)}
.knote-agent-question-input{min-height:34px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--color-base-content) 20%,transparent);border-radius:6px;background:color-mix(in srgb,var(--color-base-100) 78%,transparent);color:var(--color-base-content);font-size:12px;line-height:1.5;outline:none}
.knote-agent-question-input:focus{border-color:color-mix(in srgb,var(--knote-brand) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--knote-brand) 10%,transparent)}
.knote-agent-composer-wrap{padding:9px 12px 12px;border-top:1px solid rgba(66,84,55,.07);background:transparent;backdrop-filter:none}
.knote-agent-composer{position:relative;padding:10px 8px 8px 11px;border:1px solid rgba(72,93,59,.14);border-radius:var(--agent-composer-radius);background:var(--agent-glass-strong);box-shadow:none;transition:border .2s ease,box-shadow .2s ease,transform .2s ease}
.knote-agent-composer:focus-within{border-color:rgba(132,204,22,.40);box-shadow:0 11px 28px rgba(45,62,35,.08),0 0 0 3px rgba(132,204,22,.08);transform:translateY(-1px)}
.knote-agent-composer .knote-agent-input{font-size:12.5px}
.knote-agent-composer-toolbar{display:flex;align-items:center;gap:4px;min-width:0}
.knote-agent-composer-spacer{flex:1;min-width:4px}
.knote-agent-primary-controls{display:grid;grid-template-columns:repeat(3,32px);align-items:center;justify-items:center;gap:4px;width:104px;flex:none}
.knote-agent-primary-controls[data-running="false"]{grid-template-columns:32px;width:32px}
.knote-agent-primary-controls[data-running="false"] .is-send{grid-column:1}
.knote-agent-icon-control{position:relative;display:grid;place-items:center;width:32px;height:32px;min-width:32px;padding:0;border:1px solid color-mix(in srgb,var(--color-base-content) 14%,transparent);border-radius:8px;color:color-mix(in srgb,var(--color-base-content) 82%,transparent);background:color-mix(in srgb,var(--color-base-100) 78%,transparent);transition:color .16s ease,background .16s ease,border-color .16s ease,box-shadow .16s ease,transform .16s ease}
.knote-agent-icon-control.is-secondary{width:28px;height:28px;min-width:28px;border-color:transparent;background:transparent;color:color-mix(in srgb,var(--color-base-content) 55%,transparent)}
.knote-agent-icon-control.is-secondary.is-active{color:var(--knote-brand-strong);background:var(--knote-brand-soft);border-color:color-mix(in srgb,var(--knote-brand) 24%,transparent)}
.knote-agent-icon-control.is-stop{grid-column:1;color:#fff;background:var(--color-error);border-color:color-mix(in srgb,var(--color-error) 72%,var(--color-base-content))}
.knote-agent-icon-control.is-queue{grid-column:2;color:var(--knote-brand-strong);background:var(--knote-brand-soft);border-color:color-mix(in srgb,var(--knote-brand) 30%,transparent)}
.knote-agent-icon-control.is-send{grid-column:3;width:32px;min-width:32px;border-radius:10px;color:#fff;background:var(--knote-brand);border-color:var(--knote-brand)}
.knote-agent-icon-control:hover:not(:disabled),.knote-agent-icon-control:focus-visible:not(:disabled){transform:translateY(-1px);border-color:color-mix(in srgb,var(--knote-brand) 48%,transparent);box-shadow:0 6px 20px color-mix(in srgb,var(--color-base-content) 18%,transparent),0 2px 6px color-mix(in srgb,var(--color-base-content) 12%,transparent)}
.knote-agent-icon-control.is-send:hover:not(:disabled),.knote-agent-icon-control.is-send:focus-visible:not(:disabled){color:#fff;background:color-mix(in srgb,var(--knote-brand) 88%,#fff);border-color:var(--knote-brand)}
.knote-agent-icon-control:disabled{opacity:.34;cursor:not-allowed}
.knote-agent-icon-control::before,.knote-agent-icon-control::after{display:none;position:absolute;z-index:90;pointer-events:none;opacity:0;visibility:hidden}
.knote-agent-icon-control::after{content:attr(data-tooltip);left:50%;bottom:calc(100% + 10px);transform:translate(-50%,4px);width:max-content;max-width:210px;padding:6px 12px;border:1px solid color-mix(in srgb,var(--color-base-content) 12%,transparent);border-radius:8px;color:var(--color-base-content);background:var(--color-base-100);box-shadow:0 6px 20px color-mix(in srgb,var(--color-base-content) 18%,transparent),0 2px 6px color-mix(in srgb,var(--color-base-content) 12%,transparent);font-size:12px;font-weight:600;line-height:1.25;white-space:normal;text-align:center}
.knote-agent-icon-control::before{content:"";left:50%;bottom:calc(100% + 5px);width:10px;height:10px;transform:translate(-50%,4px) rotate(45deg);background:var(--color-base-100);border-right:1px solid color-mix(in srgb,var(--color-base-content) 12%,transparent);border-bottom:1px solid color-mix(in srgb,var(--color-base-content) 12%,transparent);border-radius:2px}
.knote-agent-icon-control:hover::before,.knote-agent-icon-control:hover::after,.knote-agent-icon-control:focus-visible::before,.knote-agent-icon-control:focus-visible::after{display:block;opacity:1;visibility:visible}
.knote-agent-icon-control:hover::after,.knote-agent-icon-control:focus-visible::after{transform:translate(-50%,0)}
.knote-agent-icon-control:hover::before,.knote-agent-icon-control:focus-visible::before{transform:translate(-50%,0) rotate(45deg)}
.knote-agent-primary-controls .is-send::after{left:auto;right:0;transform:translateY(4px)}
.knote-agent-primary-controls .is-send::before{left:auto;right:11px;transform:translateY(4px) rotate(45deg)}
.knote-agent-primary-controls .is-send:hover::after,.knote-agent-primary-controls .is-send:focus-visible::after{transform:translateY(0)}
.knote-agent-primary-controls .is-send:hover::before,.knote-agent-primary-controls .is-send:focus-visible::before{transform:translateY(0) rotate(45deg)}
.knote-agent-queue-card{border-color:color-mix(in srgb,var(--color-base-content) 12%,transparent);background:color-mix(in srgb,var(--color-base-content) 5%,var(--color-base-100))}
.knote-agent-queue-item{background:transparent}
.knote-agent-queue-index{flex:0 0 1rem;color:var(--knote-brand-strong);font-size:11px;line-height:1.375;font-weight:750;font-variant-numeric:tabular-nums;text-align:center}
.knote-agent-permission-card{border-color:color-mix(in srgb,var(--knote-brand-warm) 30%,color-mix(in srgb,var(--color-base-content) 10%,transparent));background:color-mix(in srgb,var(--knote-brand-warm) 8%,var(--color-base-100));box-shadow:0 8px 24px color-mix(in srgb,var(--color-base-content) 7%,transparent)}
.knote-agent-activity-list{border-top:1px solid color-mix(in srgb,var(--color-base-content) 10%,transparent)}
.knote-agent-activity-row{position:relative;padding:8px 4px 8px 11px;border-bottom:1px solid color-mix(in srgb,var(--color-base-content) 10%,transparent);background:transparent;transition:background .18s ease}
.knote-agent-activity-row:hover{background:color-mix(in srgb,var(--knote-brand) 5%,transparent)}
.knote-agent-activity-row::before{content:"";position:absolute;left:0;top:7px;bottom:7px;width:2px;border-radius:2px;background:color-mix(in srgb,var(--color-base-content) 28%,transparent)}
.knote-agent-activity-row[data-status="running"]::before{background:var(--knote-brand)}
.knote-agent-activity-row[data-status="done"]::before{background:var(--color-success)}
.knote-agent-activity-row[data-status="error"]::before{background:var(--color-error)}
.knote-agent-activity-row[data-status="aborted"]{opacity:.68}
.knote-agent-workspace{background:transparent!important;backdrop-filter:none}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-header{min-height:44px;padding:7px 9px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-header-actions{gap:0;max-width:126px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-session-trigger{padding:0 7px;font-size:11.5px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-review-mode-trigger{width:29px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-composer-toolbar{flex-wrap:wrap}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-composer-spacer{min-width:0}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-primary-controls{margin-left:auto}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-empty-state{justify-content:flex-start;padding:24px 14px 20px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-empty-brand{margin-bottom:7px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-empty-state h3{font-size:17px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-empty-state>p{max-width:270px;font-size:10px;line-height:1.55}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-empty-rule{margin:11px 0 10px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-suggestions{gap:5px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-suggestions button{padding:7px 9px}
@media(max-width:520px){
  .knote-agent-settings-hero{padding-right:24px}.knote-agent-settings-state{display:none}
  .knote-agent-session-popover{width:min(286px,calc(100vw - 20px))}
  .knote-agent-primary-controls{grid-template-columns:repeat(3,30px);width:98px}
  .knote-agent-primary-controls[data-running="false"]{grid-template-columns:30px;width:30px}
  .knote-agent-icon-control{width:30px;height:30px;min-width:30px}
  .knote-agent-icon-control.is-send{width:30px;min-width:30px}
  .knote-agent-composer-toolbar>span[role="img"],.knote-agent-composer-toolbar>span.font-mono{display:none}
}
@media(prefers-reduced-motion:reduce){
  .knote-agent-session-row,.knote-agent-review-mode-trigger,.knote-agent-suggestions button,.knote-agent-composer,.knote-agent-question-tick{transition:none}
  .knote-agent-panel::before,.knote-agent-panel::after,.knote-agent-empty-brand,.knote-agent-workspace-toggle.is-running::before,.knote-agent-heartbeat path{animation:none}
}
@media(forced-colors:active){
  .knote-agent-empty-brand{background:none;color:CanvasText;-webkit-text-fill-color:CanvasText;forced-color-adjust:auto}
  .knote-agent-review-mode-popover,.knote-agent-review-policy-option,.knote-agent-review-document-toggle{border:1px solid CanvasText}
}
@keyframes agentAurora{0%{transform:translate3d(-8%,-5%,0) scale(1);opacity:.50}48%{transform:translate3d(5%,7%,0) scale(1.10);opacity:.72}100%{transform:translate3d(10%,-2%,0) scale(1.04);opacity:.57}}
@keyframes agentAuroraSecondary{0%{transform:translate3d(7%,-6%,0) scale(1.04);opacity:.25}52%{transform:translate3d(-6%,4%,0) scale(1.12);opacity:.44}100%{transform:translate3d(2%,10%,0) scale(1);opacity:.31}}
@keyframes knote-agent-title-flow{0%,100%{background-position:12% 28%,8% 22%,88% 18%,36% 86%,50% 50%}12.5%{background-position:32% 8%,28% 8%,94% 42%,18% 70%,50% 50%}25%{background-position:58% 4%,54% 5%,86% 70%,12% 44%,50% 50%}37.5%{background-position:84% 22%,80% 18%,64% 90%,26% 16%,50% 50%}50%{background-position:94% 52%,92% 48%,38% 94%,54% 6%,50% 50%}62.5%{background-position:76% 84%,76% 78%,14% 76%,82% 22%,50% 50%}75%{background-position:46% 94%,46% 92%,7% 48%,92% 50%,50% 50%}87.5%{background-position:18% 72%,20% 68%,30% 20%,72% 82%,50% 50%}}
@keyframes knote-agent-workspace-sheen{0%,18%{transform:translateX(-88%) rotate(8deg)}72%,100%{transform:translateX(88%) rotate(8deg)}}
@keyframes knote-agent-heartbeat{from{stroke-dashoffset:72}to{stroke-dashoffset:-72}}
</style>
