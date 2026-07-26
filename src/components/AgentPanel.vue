<script setup>
// Agent chat panel — used twice (floating window + sidebar card), both
// instances render the same shared conversation from agentStore.
import { ref, nextTick, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  agentConfig, capabilities, chatMessages, agentStatus, agentActivity,
  agentActivityStack, agentWorkspaceOpen, agentPlan, agentQuestion,
  sendToAgent, stopAgent, clearChat, attachmentPool, addAttachment,
  answerAgentQuestion, dismissAgentQuestion,
  probeCapabilities, persistConfig, countPdfPages,
  chatSessions, activeSessionId, newSession, switchSession, deleteSession, sessionTitle,
  runningSessionId, selectionContext, agentBridge, pdfProcessing, batchState,
  pdfEnvState, hasPdfEnvSupport, installPdfEnv, uninstallPdfEnv, refreshPdfEnv,
  rollbackToMessage, contextUsage
} from '../lib/agentStore.js'
import { readDocumentFile, detectFtype } from '../lib/fileReader.js'
import PdfShimmer from './PdfShimmer.vue'
import KiwiMascot from './KiwiMascot.vue'

const props = defineProps({
  mode: { type: String, default: 'float' }, // 'float' | 'sidebar'
  t: { type: Function, required: true },
  // (text) => sanitized HTML — App provides its markdown-it + KaTeX pipeline
  renderMd: { type: Function, default: null }
})
const emit = defineEmits(['headerdown', 'collapse', 'ctxmenu'])
const questionDraft = ref('')
const activeQuestion = computed(() => (
  agentQuestion.value && agentQuestion.value.sessionId === activeSessionId.value
    ? agentQuestion.value
    : null
))
watch(() => activeQuestion.value && activeQuestion.value.id, () => { questionDraft.value = '' })
const submitQuestionAnswer = (answer = questionDraft.value) => {
  if (answerAgentQuestion(answer)) questionDraft.value = ''
}
const onQuestionKeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    submitQuestionAnswer()
  }
}
const displaySessionTitle = (session) => sessionTitle(session, props.t('agent_new_chat'))
const tr = (key, vars = {}) => {
  let value = String(props.t(key))
  for (const [name, replacement] of Object.entries(vars)) value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}
const receiptReviewText = (receipt) => {
  if (!receipt || !receipt.staged) return ''
  const ids = Array.isArray(receipt.hunkIds) ? [...new Set(receipt.hunkIds.map(String))] : []
  const total = ids.length || Number(receipt.staged) || 0
  const accepted = ids.length
    ? ids.filter((id) => (receipt.acceptedHunkIds || []).map(String).includes(id)).length
    : Number(receipt.accepted || 0)
  const rejected = ids.length
    ? ids.filter((id) => (receipt.rejectedHunkIds || []).map(String).includes(id)).length
    : Number(receipt.rejected || 0)
  const pending = Math.max(0, total - accepted - rejected)
  const parts = []
  if (pending) parts.push(tr('agent_receipt_staged', { n: pending }))
  if (accepted) parts.push(tr('agent_receipt_accepted', { n: accepted }))
  if (rejected) parts.push(tr('agent_receipt_rejected', { n: rejected }))
  return parts.join(' · ')
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
  try { await navigator.clipboard.writeText(s) } catch {
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

const input = ref('')
// Settings visibility is EXPLICIT state — never derived from the config
// fields (that made the form vanish mid-typing, before the user could fill
// the optional Jina key or press save). First run: open until a successful
// capability check closes it.
const settingsOpen = ref(false)
const panelRef = ref(null)
const listRef = ref(null)
const fileRef = ref(null)
const draftAtts = ref([]) // attachments staged for the next message

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
// Every chat model can receive a PDF: native document first, then page images,
// then locally parsed text. Tool support is only needed for later edits/crops.
const canAttachPdf = computed(() => true)
const pdfProcessLabel = computed(() => {
  const mode = pdfProcessing.value && pdfProcessing.value.mode
  if (mode === 'native') return props.t('agent_pdf_sending')
  if (mode === 'images') return props.t('agent_pdf_to_images')
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

const scrollToBottom = () => {
  nextTick(() => {
    if (listRef.value) {
      listRef.value.scrollTop = chatMessages.value.length ? listRef.value.scrollHeight : 0
      updateActiveQuestion()
    }
  })
}
watch(() => chatMessages.value.length, scrollToBottom)
watch(agentActivity, () => {
  const el = listRef.value
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) scrollToBottom()
})
// streaming: follow the growing last bubble, but only when already near the
// bottom — don't fight the user scrolling up to read
watch(() => {
  const m = chatMessages.value
  const last = m[m.length - 1]
  return last && last.text ? last.text.length : 0
}, () => {
  const el = listRef.value
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) scrollToBottom()
})
onMounted(scrollToBottom)

const send = () => {
  const text = input.value.trim()
  if (!text && !draftAtts.value.length) return
  if (agentStatus.value === 'running') return
  const atts = draftAtts.value
  draftAtts.value = []
  input.value = ''
  const sel = selectionContext.value
  selectionContext.value = null
  sendToAgent(text, atts, sel ? { selection: sel } : undefined)
}

// "第 N 行" links inside rendered assistant markdown (injected by the App)
const onListClick = (e) => {
  const a = e.target && e.target.closest && e.target.closest('.knote-line-ref')
  if (!a) return
  const n = Number(a.dataset.line)
  if (Number.isFinite(n) && n > 0) agentBridge.scrollToLine(n)
}

// The slim rail belongs to the active conversation, not the session switcher
// or settings. Each mark represents one concrete user question in this chat.
const userQuestionAnchors = computed(() => chatMessages.value
  .map((message, messageIndex) => {
    if (message?.role !== 'user') return null
    const text = String(message.text || '').replace(/\s+/g, ' ').trim()
    const attachmentName = message.attachments?.[0]?.name
    return {
      messageIndex,
      label: text || attachmentName || props.t('agent_attach')
    }
  })
  .filter(Boolean))
const activeQuestionMessageIndex = ref(-1)
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
watch(() => activeSessionId.value, () => nextTick(updateActiveQuestion))
watch(userQuestionAnchors, () => nextTick(updateActiveQuestion))

const fmtTok = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0))

const onKeydown = (e) => {
  // keyCode 229 covers WebKit's compositionend-before-keydown IME quirk
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault()
    send()
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
  let added = 0
  let skipped = 0
  for (const f of [...(fileList || [])]) {
    if (f.type.startsWith('image/')) {
      if (!canAttachImage.value) { skipped++; continue }
      const dataUrl = await readAsDataUrl(f)
      draftAtts.value.push(addAttachment({ kind: 'image', name: f.name, dataUrl }))
      added++
    } else if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      if (!canAttachPdf.value) { skipped++; continue }
      const buf = await f.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let pages = 0
      try { pages = await countPdfPages(bytes) } catch { pages = 0 }
      const base64 = capabilities.pdf ? bufToBase64(bytes) : null
      const rec = addAttachment({ kind: 'pdf', name: f.name, bytes, base64, pages })
      draftAtts.value.push(rec)
      added++
    } else if (/\.(md|markdown|txt|csv|rtf)$/i.test(f.name) || f.type === 'text/markdown' || f.type === 'text/plain' || f.type === 'text/csv') {
      // plain text / markdown — always accepted
      const text = await f.text()
      draftAtts.value.push(addAttachment({ kind: 'md', name: f.name, text: String(text).slice(0, 200000) }))
      added++
    } else if (/\.(docx|pptx|xlsx|odt|ods|odp)$/i.test(f.name) || f.type.includes('officedocument') || f.type.includes('opendocument')) {
      // Office / OpenDocument — extract text, send as md context
      const result = await readDocumentFile(f)
      if (result && result.text) {
        const label = detectFtype(f.name)?.toUpperCase() || 'DOC'
        const intro = `【用户上传的 ${label} 文件《${f.name}》内容如下】\n`
        draftAtts.value.push(addAttachment({ kind: 'md', name: f.name, text: intro + String(result.text).slice(0, 200000) }))
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
  if (agentStatus.value === 'running' && runningSessionId.value === activeSessionId.value) return
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
  const { added, skipped } = await addFilesToChat(files)
  if (!added && skipped) {
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

const bufToBase64 = (bytes) => {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

const removeDraft = (id) => {
  draftAtts.value = draftAtts.value.filter((a) => a.id !== id)
  delete attachmentPool[id]
}

const saveSettings = async () => {
  persistConfig()
  await probeCapabilities()
  // a working config flows straight into the chat; failures keep the form
  // open with the error visible
  if (capabilities.chat) settingsOpen.value = false
}

// clearing a chat is destructive — ask first (our own dialog, not confirm())
const confirmClearOpen = ref(false)
const doClearChat = () => {
  confirmClearOpen.value = false
  clearChat()
}

// quick-start suggestions on an empty chat (document actions need tools)
const suggestions = computed(() => (configured.value && capabilities.tools
  ? [props.t('agent_sugg_1'), props.t('agent_sugg_2'), props.t('agent_sugg_3')]
  : []))
const sendSuggestion = (s) => {
  if (agentStatus.value === 'running') return
  sendToAgent(s, [])
}

const attThumb = (a) => {
  const live = attachmentPool[a.id]
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
const workspaceIconColor = (a) => (a.status === 'error' ? 'text-rose-500/70' : a.status === 'running' ? 'text-[#4d7c0f]' : 'text-base-content/45')
const planDone = computed(() => agentPlan.value.filter((s) => s.status === 'completed').length)
// batch (sub-agent) progress renders in the workspace panel when it's showing
// (float + open); otherwise it stays in the chat so sidebar mode / a collapsed
// panel still surface it — never both at once
const inWorkspacePanel = computed(() => props.mode === 'float' && agentWorkspaceOpen.value)
const showBatchInChat = computed(() => !!batchState.value && !inWorkspacePanel.value)

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
const sessionListRef = ref(null)
const orderedSessions = computed(() => [...chatSessions.value].reverse())
const toggleSessions = () => { sessionsOpen.value = !sessionsOpen.value }
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
const closeSessionsOnOutside = () => { if (sessionsOpen.value) sessionsOpen.value = false }
onMounted(() => document.addEventListener('mousedown', closeSessionsOnOutside))
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', closeSessionsOnOutside)
  cancelAnimationFrame(questionScrollFrame)
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
              :data-running="s.id === runningSessionId ? 'true' : 'false'"
              :aria-current="s.id === activeSessionId ? 'true' : 'false'"
              class="knote-agent-session-row group"
              :class="{ 'is-active': s.id === activeSessionId }"
              @click="pickSession(s.id)"
            >
              <span class="knote-agent-session-row-icon">
                <span v-if="s.id === runningSessionId" class="loading loading-spinner"></span>
                <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a8.38 8.38 0 0 1-.9 3.8A8.5 8.5 0 0 1 12.5 21a8.38 8.38 0 0 1-3.8-.9L3 21l.9-5.7A8.38 8.38 0 0 1 3 11.5 8.5 8.5 0 0 1 8.2 3.9 8.38 8.38 0 0 1 12 3h.5A8.48 8.48 0 0 1 21 11.5Z"/></svg>
              </span>
              <span class="truncate flex-1">{{ displaySessionTitle(s) }}</span>
              <span v-if="s.id === runningSessionId" class="knote-agent-session-running">{{ t('agent_running_badge') }}</span>
              <span v-else class="knote-agent-session-count">{{ s.messages.length }}</span>
              <button
                v-if="s.id !== runningSessionId"
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
      <div class="ml-auto flex items-center gap-0.5 shrink-0" @mousedown.stop>
        <button v-if="configured" data-testid="agent-new-session" class="btn btn-xs btn-ghost btn-square" :title="t('agent_new_chat')" @click="startNewSession">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
        </button>
        <button v-if="configured" data-testid="agent-clear-chat" class="btn btn-xs btn-ghost btn-square" :title="t('agent_clear')" :disabled="runningSessionId === activeSessionId" @click="confirmClearOpen = true">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>
        </button>
        <button v-if="mode === 'sidebar'" class="btn btn-xs btn-ghost btn-square" :title="t('agent_hide')" @click="$emit('collapse')">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5"/></svg>
        </button>
        <!-- workspace panel toggle (float only): shows the live agent work stack -->
        <button v-if="mode === 'float' && configured" class="btn btn-xs btn-ghost btn-square relative" :class="{ 'text-[#84cc16]': agentWorkspaceOpen }" :title="t('agent_workspace')" :aria-label="t('agent_workspace')" :aria-pressed="agentWorkspaceOpen" @click="agentWorkspaceOpen = !agentWorkspaceOpen">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M15 4v16"/></svg>
          <span v-if="!agentWorkspaceOpen && agentStatus === 'running'" class="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-[#84cc16] animate-pulse"></span>
        </button>
        <button v-if="configured" data-testid="agent-settings-toggle" class="btn btn-xs btn-ghost btn-square" :class="{ 'text-[#84cc16]': settingsOpen }" :title="t('agent_settings')" @click="settingsOpen = !settingsOpen">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        </button>
      </div>
    </div>

    <!-- settings: takes over the WHOLE panel body while open (a stacked
         section with a faint divider read as part of the chat) -->
    <div v-if="settingsOpen" class="knote-agent-settings flex-1 min-h-0" data-testid="agent-settings">
      <div class="knote-agent-settings-aurora" aria-hidden="true"></div>
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
          <input type="checkbox" v-model="agentConfig.webSearch" class="checkbox checkbox-xs mt-0.5 [--chkbg:#84cc16] [--chkfg:white]" />
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
          <input type="checkbox" v-model="agentConfig.verify" class="checkbox checkbox-xs mt-0.5 [--chkbg:#84cc16] [--chkfg:white]" />
          <span class="min-w-0">
            <span class="text-[11px] font-bold">{{ t('agent_verify') }}</span>
            <span class="block text-[10px] opacity-45 leading-relaxed">{{ t('agent_verify_hint') }}</span>
          </span>
        </label>
      </section>

      <!-- ③ PDF layout analysis env (PaddleOCR) — one-click install; desktop only -->
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
        <div class="knote-agent-empty-mascot"><KiwiMascot state="waiting" :size="56" static /></div>
        <div class="knote-agent-empty-kicker">Knote Agent</div>
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
          v-if="!(m.role === 'assistant' && !m.text && !m.error && !m.receipt && i !== chatMessages.length - 1)"
          class="knote-agent-message-row group flex flex-col"
          :class="m.role === 'user' ? 'items-end is-user' : 'items-start is-assistant'"
          :data-chat-message-index="i"
          :data-user-question="m.role === 'user' ? 'true' : null"
        >
        <div v-if="m.role === 'assistant' && (m.text || m.error || m.receipt)" class="knote-agent-message-author">
          <span><KiwiMascot state="idle" :size="17" static /></span>
          <b>Knote Agent</b>
        </div>
        <div
          v-if="m.selection"
          class="max-w-[92%] mb-1 border-l-2 border-[#84cc16]/50 bg-base-200/50 rounded-r-lg px-2 py-1 text-[10px] text-base-content/50 whitespace-pre-wrap break-words max-h-14 overflow-hidden"
        >{{ m.selection.text }}<span v-if="m.selection.lineHint" class="opacity-60">（{{ m.selection.lineHint }}）</span></div>
        <!-- empty assistant segments (tool-only bubbles) render no text box -->
        <div
          v-if="m.role === 'assistant' && !m.error && renderMd && m.text"
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
          v-if="m.trace && m.trace.length && i === chatMessages.length - 1"
          class="mt-1 flex items-center gap-1.5 text-[10px] text-base-content/45"
        >
          <svg v-if="m.trace[m.trace.length - 1].done && !m.trace[m.trace.length - 1].error" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#84cc16" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="m5 13 4 4L19 7"/></svg>
          <svg v-else-if="m.trace[m.trace.length - 1].error" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" class="text-error"><path stroke-linecap="round" d="m7 7 10 10M17 7 7 17"/></svg>
          <span v-else class="loading loading-spinner" style="width:10px;height:10px"></span>
          <span>{{ m.trace[m.trace.length - 1].label }}<template v-if="m.trace[m.trace.length - 1].args">：{{ m.trace[m.trace.length - 1].args }}</template></span>
          <span v-if="m.trace.length > 1" class="opacity-50 tabular-nums">{{ tr('agent_step_n', { n: m.trace.length }) }}</span>
        </div>
        <div
          v-if="m.role === 'assistant' && receiptReviewText(m.receipt)"
          class="mt-1 flex items-center gap-1.5 text-[10px] text-base-content/55"
        >{{ receiptReviewText(m.receipt) }}</div>
        <div
          v-if="m.role === 'assistant' && m.usage && (m.usage.input || m.usage.output)"
          class="mt-0.5 text-[9px] font-mono text-base-content/30"
        >{{ m.usage.estimated ? '≈ ' : '' }}{{ t('agent_tok_in') }} {{ fmtTok(m.usage.input) }} · {{ t('agent_tok_out') }} {{ fmtTok(m.usage.output) }} tokens</div>
        <!-- rollback: rewind the session to this user message (the original
             timeline is kept as a sibling 分支 session) -->
        <button
          v-if="m.role === 'user' && !(agentStatus === 'running' && runningSessionId === activeSessionId)"
          class="mt-0.5 flex items-center gap-1 text-[10px] text-base-content/40 opacity-0 group-hover:opacity-100 hover:!text-[#4d7c0f] transition-opacity"
          :title="t('agent_rollback_hint')"
          @click="doRollback(i)"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>
          {{ t('agent_rollback') }}
        </button>
      </div>
      </template>
      <div v-if="agentStatus === 'running' && runningSessionId === activeSessionId" class="flex items-center gap-2 text-xs text-base-content/50 px-1" role="status">
        <span class="loading loading-dots loading-xs"></span>
        <span>{{ agentActivity }}</span>
      </div>
      <div v-else-if="agentStatus === 'running'" class="flex items-center gap-2 text-[11px] text-base-content/40 px-1" role="status">
        <span class="loading loading-spinner" style="width:10px;height:10px"></span>
        <span>{{ t('agent_running_elsewhere') }}</span>
      </div>
      </div>

      <nav
        v-if="userQuestionAnchors.length > 1"
        class="knote-agent-question-rail"
        :aria-label="t('agent_quick_nav')"
      >
        <button
          v-for="question in userQuestionAnchors"
          :key="question.messageIndex"
          type="button"
          data-testid="agent-question-quick"
          class="knote-agent-question-tick"
          :class="{ 'is-active': activeQuestionMessageIndex === question.messageIndex }"
          :title="question.label"
          @click="scrollToUserQuestion(question)"
        ></button>
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
      <div v-if="showBatchInChat" class="rounded-xl border border-base-200 bg-base-100/80 p-2.5">
        <div class="flex items-center gap-2 mb-1.5">
          <span v-if="batchState.running" class="loading loading-dots loading-xs"></span>
          <svg v-else class="w-3.5 h-3.5 text-[#84cc16]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          <span class="text-xs font-semibold">{{ t('batch_title') }}</span>
          <span class="text-[11px] opacity-50 ml-auto tabular-nums">{{ batchState.done }} / {{ batchState.total }}</span>
        </div>
        <div class="h-1.5 rounded-full bg-base-200 overflow-hidden mb-1.5">
          <div class="h-full bg-[#84cc16] transition-[width] duration-300" :style="{ width: (batchState.total ? Math.round(batchState.done / batchState.total * 100) : 0) + '%' }"></div>
        </div>
        <div class="max-h-28 overflow-auto space-y-0.5">
          <div v-for="it in batchState.items" :key="it.path" class="flex items-center gap-1.5 text-[11px]">
            <span class="shrink-0 w-3 text-center">
              <span v-if="it.status === 'done'" class="text-[#84cc16]">✓</span>
              <span v-else-if="it.status === 'error'" class="text-error">✕</span>
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
      <div v-for="a in draftAtts" :key="a.id" class="relative group">
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

    <!-- tool-driven clarification: answering resumes the same Agent turn -->
    <div v-if="!settingsOpen && activeQuestion" data-testid="agent-question" class="px-3 pt-2 pb-2.5 border-t border-base-200/70 shrink-0">
      <div class="rounded-2xl border border-[#84cc16]/30 bg-[#84cc16]/5 p-3 shadow-sm">
        <div class="flex items-start gap-2">
          <svg class="w-4 h-4 mt-0.5 shrink-0 text-[#65a30d]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M9.5 9a2.5 2.5 0 1 1 4.6 1.4c-.7.8-2.1 1-2.1 2.35"/><path d="M12 16h.01"/></svg>
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
            class="px-2.5 py-1 rounded-full border border-base-300 bg-base-100 text-[11px] hover:border-[#84cc16]/60 hover:text-[#4d7c0f] transition-colors"
            @click="submitQuestionAnswer(option)"
          >{{ option }}</button>
        </div>
        <div class="mt-2.5 flex items-end gap-1.5">
          <textarea
            v-model="questionDraft"
            data-testid="agent-question-input"
            rows="1"
            class="flex-1 min-w-0 resize-none rounded-xl border border-base-300 bg-base-100 px-2.5 py-2 text-xs leading-relaxed outline-none focus:border-[#84cc16]/60"
            :placeholder="t('agent_question_placeholder')"
            @keydown="onQuestionKeydown"
          ></textarea>
          <button type="button" data-testid="agent-question-answer" class="btn btn-sm btn-circle border-none text-white disabled:opacity-30" style="background:#84cc16" :disabled="!questionDraft.trim()" :title="t('agent_answer')" @click="submitQuestionAnswer()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12 3.27 3.13a59.77 59.77 0 0 1 18.02 8.87 59.77 59.77 0 0 1-18.02 8.87L6 12Zm0 0h7.5"/></svg>
          </button>
        </div>
        <button type="button" class="mt-2 text-[10px] text-base-content/40 hover:text-base-content/70" @click="dismissAgentQuestion">{{ t('agent_question_skip') }}</button>
      </div>
    </div>

    <!-- normal input -->
    <div v-show="!settingsOpen && !activeQuestion" class="knote-agent-composer-wrap shrink-0">
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
        <div class="flex items-center gap-1">
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
            class="flex items-center gap-1 h-6 px-2 rounded-full text-[10px] leading-none border transition-colors whitespace-nowrap shrink-0"
            :class="agentConfig.reasoning
              ? 'bg-[#84cc16]/15 text-[#4d7c0f] border-[#84cc16]/35 font-semibold'
              : 'text-base-content/40 border-transparent hover:bg-base-200/80 hover:text-base-content/70'"
            :title="t('agent_reasoning_hint')"
            @click="cycleReasoning"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 1 7 7c0 2.4-1.2 4.2-2.6 5.6-.6.6-.9 1.4-.9 2.2V18a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-1.2c0-.8-.3-1.6-.9-2.2C6.2 13.2 5 11.4 5 9a7 7 0 0 1 7-7z"/><path d="M9.5 22h5"/></svg>
            {{ t('agent_reasoning') }}·{{ reasoningLabel }}
          </button>
          <span class="flex-1"></span>
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
          <button
            v-if="agentStatus === 'running'"
            type="button"
            class="btn btn-sm btn-circle border-none text-white"
            style="background:#ef4444"
            :title="t('agent_stop')" :aria-label="t('agent_stop')"
            @click="stopAgent"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          </button>
          <button
            v-else
            type="button"
            data-testid="agent-send"
            class="btn btn-sm btn-circle border-none text-white disabled:opacity-30"
            style="background:#84cc16"
            :disabled="!input.trim() && !draftAtts.length"
            :title="t('agent_send')" :aria-label="t('agent_send')"
            @click="send"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12 3.27 3.13a59.77 59.77 0 0 1 18.02 8.87 59.77 59.77 0 0 1-18.02 8.87L6 12Zm0 0h7.5"/></svg>
          </button>
        </div>
      </div>
      <input ref="fileRef" type="file" multiple :accept="acceptTypes" class="hidden" @change="onFiles" />
    </div>
    </div>
    <!-- /LEFT chat column -->

    <!-- RIGHT: live workspace panel (float only) — the agent's current work stack -->
    <aside
      v-if="mode === 'float' && agentWorkspaceOpen && !settingsOpen"
      class="knote-agent-workspace flex flex-col w-56 shrink-0 min-h-0 h-full border-l border-base-200/70 bg-base-200/25"
      :aria-label="t('agent_workspace_aria')"
    >
      <div class="flex items-center gap-1.5 px-3 py-2 border-b border-base-200/70 shrink-0">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-[#4d7c0f]"><rect x="3" y="4" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M15 4v16"/></svg>
        <span class="text-[11px] font-bold uppercase tracking-wider text-base-content/50 flex-1">{{ t('agent_workspace') }}</span>
        <span v-if="agentStatus === 'running'" class="text-[9px] font-bold text-[#84cc16]">{{ t('agent_workspace_running') }}</span>
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
                <svg v-if="s.status === 'completed'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="text-[#84cc16]"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
                <span v-else-if="s.status === 'in_progress'" class="loading loading-spinner text-[#84cc16] block" style="width:11px;height:11px"></span>
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-base-content/30"><circle cx="12" cy="12" r="9"/></svg>
              </span>
              <span :class="s.status === 'completed' ? 'line-through text-base-content/40' : s.status === 'in_progress' ? 'text-[#4d7c0f] font-semibold' : 'text-base-content/70'">{{ s.title }}</span>
            </li>
          </ol>
        </div>
        <!-- multi-agent batch: one sub-agent per file, progress + per-file status -->
        <div v-if="batchState" class="mb-3">
          <div class="flex items-center gap-1 mb-1.5 text-[10px] font-bold uppercase tracking-wider text-base-content/40">
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="m12 2 9 5-9 5-9-5 9-5Zm9 10-9 5-9-5m18 5-9 5-9-5"/></svg>
            <span class="flex-1">{{ t('agent_subagents') }}</span>
            <span class="font-mono normal-case">{{ batchState.done }}/{{ batchState.total }}</span>
          </div>
          <div class="h-1.5 rounded-full bg-base-200 overflow-hidden mb-1.5">
            <div class="h-full bg-[#84cc16] transition-[width] duration-300" :style="{ width: (batchState.total ? Math.round(batchState.done / batchState.total * 100) : 0) + '%' }"></div>
          </div>
          <ol class="space-y-1">
            <li v-for="it in batchState.items" :key="it.path" class="flex items-center gap-1.5 text-[11px]">
              <span class="shrink-0">
                <svg v-if="it.status === 'done'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="text-[#84cc16]"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
                <svg v-else-if="it.status === 'error'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="text-rose-500"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
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
        <ol v-if="agentActivityStack.length" class="space-y-1.5">
          <li
            v-for="a in agentActivityStack" :key="a.id"
            class="rounded-lg border px-2 py-1.5 transition-colors"
            :class="a.status === 'running'
              ? 'border-[#84cc16]/45 bg-[#84cc16]/10'
              : a.status === 'error'
                ? 'border-rose-400/40 bg-rose-400/5'
                : a.status === 'aborted'
                  ? 'border-base-300/60 bg-base-200/40 opacity-70'
                  : 'border-base-200 bg-base-100'"
          >
            <div class="flex items-center gap-1.5">
              <span class="shrink-0" :class="workspaceIconColor(a)" v-html="workspaceIcon(a.kind)"></span>
              <span class="text-[11px] font-semibold text-base-content/80 truncate flex-1">{{ a.title }}</span>
              <!-- status glyph: never colour-only (a11y) -->
              <span v-if="a.status === 'running'" class="loading loading-spinner shrink-0 text-[#84cc16]" style="width:9px;height:9px"></span>
              <svg v-else-if="a.status === 'done'" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 text-[#84cc16]"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
              <svg v-else-if="a.status === 'error'" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 text-rose-500"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 text-base-content/40"><path stroke-linecap="round" stroke-linejoin="round" d="M18 6 6 18"/></svg>
            </div>
            <div v-if="a.detail" class="mt-0.5 text-[10px] text-base-content/50 break-all leading-snug" :title="a.detail">{{ a.detail }}</div>
            <div v-if="a.result" class="mt-0.5 text-[10px] text-[#4d7c0f]/80 truncate">{{ a.result }}</div>
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
  isolation:isolate;
  overflow:hidden;
  overscroll-behavior:none;
  color:var(--agent-ink);
  background:
    radial-gradient(circle at 12% 5%,rgba(242,218,105,.12),transparent 34%),
    radial-gradient(circle at 88% 100%,rgba(142,208,43,.09),transparent 38%),
    rgba(252,253,250,.96);
}
.knote-agent-panel::before{
  content:"";
  position:absolute;
  inset:-38% -30%;
  z-index:0;
  pointer-events:none;
  opacity:.58;
  filter:blur(42px);
  background:
    radial-gradient(circle at 24% 32%,rgba(252,225,109,.30),transparent 24%),
    radial-gradient(circle at 72% 58%,rgba(157,218,73,.24),transparent 28%),
    radial-gradient(circle at 48% 78%,rgba(238,246,219,.45),transparent 23%);
  will-change:transform,opacity;
  animation:agentAurora 24s cubic-bezier(.45,.05,.55,.95) infinite alternate;
}
.knote-agent-panel::after{
  content:"";
  position:absolute;
  inset:-30% -24%;
  z-index:0;
  pointer-events:none;
  opacity:.34;
  filter:blur(48px);
  background:
    radial-gradient(circle at 74% 28%,rgba(247,220,101,.25),transparent 22%),
    radial-gradient(circle at 30% 70%,rgba(143,208,49,.21),transparent 25%);
  will-change:transform,opacity;
  animation:agentAuroraSecondary 31s cubic-bezier(.42,0,.58,1) infinite alternate-reverse;
}
.knote-agent-chat-column,.knote-agent-workspace{position:relative;z-index:1}
.knote-agent-chat-column{background:rgba(255,255,255,.46);backdrop-filter:blur(18px)}
.knote-agent-header{
  position:relative;z-index:30;overflow:visible;
  min-height:47px;
  border-bottom:1px solid rgba(26,38,23,.07);
  background:rgba(255,255,255,.58);
  backdrop-filter:blur(20px) saturate(1.08);
}
.knote-agent-message-author :deep(canvas),.knote-agent-empty-mascot :deep(canvas){cursor:default!important}
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
.knote-agent-session-kicker,.knote-agent-settings-kicker,.knote-agent-empty-kicker{font-size:8.5px;text-transform:uppercase;letter-spacing:.18em;font-weight:750;color:rgba(70,88,59,.46)}
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
  border-radius:13px;font-size:12px;color:rgba(24,32,25,.62);cursor:pointer;
  transition:background .18s ease,color .18s ease,transform .18s ease;
}
.knote-agent-session-row:hover{background:rgba(119,151,92,.07);color:rgba(24,32,25,.84);transform:translateX(1px)}
.knote-agent-session-row.is-active{background:linear-gradient(100deg,rgba(151,215,66,.16),rgba(244,220,111,.08));color:#4d7c0f;font-weight:680}
.knote-agent-session-row-icon{width:22px;height:22px;border-radius:8px;display:grid;place-items:center;flex:none;background:rgba(112,135,94,.07)}
.knote-agent-session-row-icon .loading{width:10px;height:10px;color:var(--agent-lime)}
.knote-agent-session-count{font-size:9px;opacity:.42;font-variant-numeric:tabular-nums}
.knote-agent-session-running{font-size:8px;color:#74b51e;font-weight:700}
.knote-agent-session-remove{width:20px;height:20px;border-radius:7px;display:grid;place-items:center;opacity:0;color:#d05252;transition:opacity .16s ease,background .16s ease}
.knote-agent-session-row:hover .knote-agent-session-remove{opacity:.5}.knote-agent-session-remove:hover{opacity:1!important;background:rgba(220,70,70,.08)}
.knote-agent-settings{
  position:relative;display:flex;flex-direction:column;align-self:stretch;
  width:100%;min-width:0;max-width:100%;overflow:hidden;box-sizing:border-box;
  background:linear-gradient(150deg,rgba(250,251,247,.86),rgba(255,255,255,.92));
}
.knote-agent-settings-aurora{
  position:absolute;inset:-80px -90px auto;height:290px;pointer-events:none;opacity:.68;filter:blur(32px);
  background:radial-gradient(circle at 22% 34%,rgba(250,221,100,.31),transparent 34%),radial-gradient(circle at 76% 38%,rgba(153,215,69,.25),transparent 38%);
  will-change:transform,opacity;
  animation:agentSettingsGlow 22s cubic-bezier(.45,.05,.55,.95) infinite alternate;
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
.knote-agent-protocol-switch{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:3px;margin-bottom:10px;border-radius:12px;background:rgba(107,127,93,.07)}
.knote-agent-protocol-option{height:29px;border-radius:9px;font-size:10px;font-weight:650;color:rgba(31,43,27,.50);transition:all .18s ease}
.knote-agent-protocol-option:hover{color:rgba(31,43,27,.78)}.knote-agent-protocol-option.is-active{color:#47720b;background:rgba(255,255,255,.92);box-shadow:0 3px 10px rgba(38,56,27,.08),inset 0 0 0 1px rgba(132,204,22,.17)}
.knote-agent-setting-field{display:block;margin-top:9px}.knote-agent-setting-field>span:first-child{display:block;margin:0 2px 4px;font-size:9px;font-weight:650;color:rgba(29,42,25,.48)}
.knote-agent-setting-field>input,.knote-agent-setting-field>select,.knote-agent-setting-field>textarea{
  width:100%;min-height:34px;padding:7px 10px;border:1px solid rgba(78,98,65,.14);border-radius:11px;outline:0;
  font-size:10.5px;line-height:1.35;color:rgba(20,30,18,.82);background:rgba(249,251,247,.85);
  transition:border .18s ease,box-shadow .18s ease,background .18s ease;
}
.knote-agent-setting-field>textarea{resize:vertical;min-height:58px}
.knote-agent-setting-field>input:focus,.knote-agent-setting-field>select:focus,.knote-agent-setting-field>textarea:focus{border-color:rgba(132,204,22,.5);background:#fff;box-shadow:0 0 0 3px rgba(132,204,22,.09)}
.knote-agent-setting-field>span:not(:first-child){display:block;margin:4px 2px 0;font-size:8.5px;line-height:1.45;color:rgba(33,45,29,.40)}
.knote-agent-setting-toggle{display:flex;align-items:flex-start;gap:9px;margin-top:10px;padding:10px;border-radius:13px;cursor:pointer;background:rgba(247,249,245,.75);border:1px solid rgba(75,94,64,.08)}
.knote-agent-settings-footer{
  position:relative;z-index:2;flex:none;display:flex;align-items:center;gap:10px;
  width:100%;min-width:0;box-sizing:border-box;padding:10px 14px 11px;
  border-top:1px solid rgba(69,87,58,.08);background:rgba(253,254,251,.78);backdrop-filter:blur(16px);
}
.knote-agent-settings-footer>span{font-size:8.5px;line-height:1.35;color:rgba(35,47,31,.39)}
.knote-agent-settings-save{
  height:31px;padding:0 12px;border-radius:11px;display:flex;align-items:center;gap:6px;flex:none;
  color:#fff;font-size:10px;font-weight:700;background:linear-gradient(135deg,#93d432,#78bd1e);
  box-shadow:0 7px 16px rgba(113,180,27,.20);transition:transform .18s ease,box-shadow .18s ease,opacity .18s ease;
}
.knote-agent-settings-save:hover{transform:translateY(-1px);box-shadow:0 9px 20px rgba(113,180,27,.25)}.knote-agent-settings-save:disabled{opacity:.45;transform:none}
.knote-agent-message-stage{position:relative;overflow:hidden}
.knote-agent-message-list{position:relative;padding:16px 14px 22px;scroll-behavior:smooth}
.knote-agent-message-list.has-question-rail{padding-right:30px}
.knote-agent-question-rail{
  position:absolute;z-index:8;right:6px;top:8px;bottom:8px;width:19px;padding:8px 0;
  display:flex;flex-direction:column;justify-content:space-evenly;align-items:center;
  pointer-events:none;
}
.knote-agent-question-tick{
  display:block;flex:none;appearance:none;border:0;padding:0;pointer-events:auto;
  width:9px;height:3px;min-height:3px;border-radius:999px;background:rgba(91,108,82,.26);
  transition:width .2s ease,background .2s ease,box-shadow .2s ease,transform .2s ease;
}
.knote-agent-question-tick:hover{width:14px;background:rgba(132,204,22,.58);transform:scaleY(1.25)}
.knote-agent-question-tick.is-active{width:17px;background:#79c31f;box-shadow:0 2px 8px rgba(106,183,20,.28)}
.knote-agent-empty-state{min-height:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px 10px 30px}
.knote-agent-empty-mascot{width:74px;height:74px;display:grid;place-items:center;border-radius:27px;background:rgba(255,255,255,.62);border:1px solid rgba(90,113,75,.10);box-shadow:0 20px 40px rgba(54,74,43,.10)}
.knote-agent-empty-kicker{margin-top:15px;color:rgba(86,111,69,.46)}
.knote-agent-empty-state h3{margin:4px 0 5px;font-size:19px;line-height:1.2;font-weight:660;letter-spacing:-.035em;color:rgba(24,32,25,.88)}
.knote-agent-empty-state>p{max-width:300px;margin:0;font-size:11px;line-height:1.6;color:rgba(31,43,27,.46)}
.knote-agent-empty-rule{width:34px;height:2px;margin:15px 0 12px;border-radius:99px;background:linear-gradient(90deg,#f2d869,#8ed02b)}
.knote-agent-suggestions{width:min(100%,330px);display:flex;flex-direction:column;gap:5px}
.knote-agent-suggestions button{display:grid;grid-template-columns:24px 1fr 14px;align-items:center;gap:7px;padding:8px 10px;border-radius:12px;text-align:left;color:rgba(32,44,28,.55);border:1px solid rgba(77,98,64,.09);background:rgba(255,255,255,.52);transition:all .18s ease}
.knote-agent-suggestions button:hover{color:#4d7c0f;border-color:rgba(132,204,22,.24);background:rgba(249,253,243,.88);transform:translateX(2px)}
.knote-agent-suggestions button>span{font-size:8px;letter-spacing:.08em;opacity:.42}.knote-agent-suggestions button>b{font-size:10.5px;font-weight:570;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.knote-agent-suggestions button>svg{opacity:.42}
.knote-agent-message-row{margin-bottom:16px}
.knote-agent-message-author{display:flex;align-items:center;gap:6px;margin:0 0 5px 2px;color:rgba(33,45,29,.48)}
.knote-agent-message-author>span{width:22px;height:22px;display:grid;place-items:center;border-radius:8px;background:rgba(255,255,255,.72);border:1px solid rgba(82,101,70,.10)}
.knote-agent-message-author>b{font-size:9px;font-weight:650;letter-spacing:.01em}
.knote-agent-message{padding:9px 12px;border-radius:16px;font-size:12.5px;line-height:1.62;box-shadow:0 7px 18px rgba(42,57,34,.045)}
.knote-agent-message-assistant{color:rgba(24,32,25,.82);background:rgba(255,255,255,.70);border:1px solid rgba(78,98,65,.10);border-top-left-radius:7px}
.knote-agent-message-user{color:rgba(35,54,25,.84);background:linear-gradient(135deg,rgba(155,215,75,.18),rgba(248,222,107,.13));border:1px solid rgba(132,204,22,.18);border-top-right-radius:7px}
.knote-agent-message-error{color:#c33d4e;background:rgba(255,241,243,.80);border:1px solid rgba(239,68,68,.18)}
.knote-agent-composer-wrap{padding:9px 12px 12px;border-top:1px solid rgba(66,84,55,.07);background:rgba(253,254,251,.66);backdrop-filter:blur(16px)}
.knote-agent-composer{position:relative;padding:10px 11px 7px;border:1px solid rgba(72,93,59,.14);border-radius:18px;background:rgba(255,255,255,.75);box-shadow:0 9px 25px rgba(45,62,35,.06);transition:border .2s ease,box-shadow .2s ease,transform .2s ease}
.knote-agent-composer::before{content:"";position:absolute;inset:auto 30px -9px;height:18px;z-index:-1;background:radial-gradient(ellipse,rgba(139,205,48,.13),transparent 70%);filter:blur(8px)}
.knote-agent-composer:focus-within{border-color:rgba(132,204,22,.40);box-shadow:0 11px 28px rgba(45,62,35,.08),0 0 0 3px rgba(132,204,22,.08);transform:translateY(-1px)}
.knote-agent-composer .knote-agent-input{font-size:12.5px}
.knote-agent-workspace{background:rgba(246,249,242,.58)!important;backdrop-filter:blur(18px)}

@keyframes agentAurora{
  0%{transform:translate3d(-8%,-5%,0) scale(1);opacity:.50}
  48%{transform:translate3d(5%,7%,0) scale(1.10);opacity:.72}
  100%{transform:translate3d(10%,-2%,0) scale(1.04);opacity:.57}
}
@keyframes agentAuroraSecondary{
  0%{transform:translate3d(7%,-6%,0) scale(1.04);opacity:.25}
  52%{transform:translate3d(-6%,4%,0) scale(1.12);opacity:.44}
  100%{transform:translate3d(2%,10%,0) scale(1);opacity:.31}
}
@keyframes agentSettingsGlow{
  0%{transform:translate3d(-9%,-4%,0) scale(1);opacity:.55}
  52%{transform:translate3d(8%,8%,0) scale(1.12);opacity:.78}
  100%{transform:translate3d(-2%,13%,0) scale(1.04);opacity:.62}
}

.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-header{min-height:44px;padding:7px 9px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-session-trigger{padding:0 7px;font-size:11.5px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-empty-state{justify-content:flex-start;padding:24px 14px 20px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-empty-mascot{width:58px;height:58px;border-radius:21px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-empty-kicker{margin-top:11px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-empty-state h3{font-size:17px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-empty-state>p{max-width:270px;font-size:10px;line-height:1.55}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-empty-rule{margin:11px 0 10px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-suggestions{gap:5px}
.knote-agent-panel[data-agent-mode="sidebar"] .knote-agent-suggestions button{padding:7px 9px}
@media(max-width:520px){
  .knote-agent-settings-hero{padding-right:24px}.knote-agent-settings-state{display:none}
  .knote-agent-session-popover{width:min(286px,calc(100vw - 20px))}
}
@media(prefers-reduced-motion:reduce){
  .knote-agent-panel::before,.knote-agent-panel::after,.knote-agent-settings-aurora{animation:none}
  .knote-agent-session-row,.knote-agent-suggestions button,.knote-agent-composer,.knote-agent-question-tick{transition:none}
}
</style>
