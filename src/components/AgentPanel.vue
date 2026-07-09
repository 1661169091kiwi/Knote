<script setup>
// Agent chat panel — used twice (floating window + sidebar card), both
// instances render the same shared conversation from agentStore.
import { ref, nextTick, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  agentConfig, capabilities, chatMessages, agentStatus, agentActivity,
  attachmentPool, addAttachment, sendToAgent, stopAgent, clearChat,
  probeCapabilities, persistConfig, countPdfPages,
  chatSessions, activeSessionId, newSession, switchSession, deleteSession, sessionTitle,
  runningSessionId, selectionContext, agentBridge, pdfProcessing, batchState,
  pdfEnvState, hasPdfEnvSupport, installPdfEnv, uninstallPdfEnv, refreshPdfEnv
} from '../lib/agentStore.js'
import PdfShimmer from './PdfShimmer.vue'

const props = defineProps({
  mode: { type: String, default: 'float' }, // 'float' | 'sidebar'
  t: { type: Function, required: true },
  // (text) => sanitized HTML — App provides its markdown-it + KaTeX pipeline
  renderMd: { type: Function, default: null }
})
const emit = defineEmits(['headerdown', 'collapse'])

const input = ref('')
// Settings visibility is EXPLICIT state — never derived from the config
// fields (that made the form vanish mid-typing, before the user could fill
// the optional Jina key or press save). First run: open until a successful
// capability check closes it.
const settingsOpen = ref(false)
const listRef = ref(null)
const fileRef = ref(null)
const draftAtts = ref([]) // attachments staged for the next message

const configured = computed(() => agentConfig.baseUrl && agentConfig.apiKey && agentConfig.model)
onMounted(() => { settingsOpen.value = !configured.value; if (hasPdfEnvSupport()) refreshPdfEnv() })

// PDF layout environment (PaddleOCR) — state is SHARED in the store so the
// float + sidebar panel instances never desync. Desktop only.
const hasPdfEnv = hasPdfEnvSupport()
const pdfEnvLogRef = ref(null)
const pdfBusy = computed(() => pdfEnvState.running || pdfEnvState.installing)
const uninstallPdfEnvConfirmed = () => {
  if (pdfBusy.value) return
  if (!window.confirm(t('agent_pdf_env_uninstall_confirm'))) return
  uninstallPdfEnv()
}
// auto-scroll THIS panel's own log element as lines stream in
watch(() => pdfEnvState.log.length, () => nextTick(() => { const el = pdfEnvLogRef.value; if (el) el.scrollTop = el.scrollHeight }))
const canAttachImage = computed(() => capabilities.vision)
// PDFs are useful only if the model can read them natively (anthropic pdf)
// or page-render them — which needs BOTH vision and tool calling
const canAttachPdf = computed(() => capabilities.pdf || (capabilities.vision && capabilities.tools))
const acceptTypes = computed(() => {
  const a = []
  if (canAttachImage.value) a.push('image/*')
  if (canAttachPdf.value) a.push('.pdf,application/pdf')
  return a.join(',')
})

const scrollToBottom = () => {
  nextTick(() => {
    if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight
  })
}
watch(() => chatMessages.value.length, scrollToBottom)
watch(agentActivity, scrollToBottom)
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

const fmtTok = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0))

const onKeydown = (e) => {
  // keyCode 229 covers WebKit's compositionend-before-keydown IME quirk
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault()
    send()
  }
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
      draftAtts.value.push(addAttachment({ kind: 'pdf', name: f.name, bytes, base64, pages }))
      added++
    } else {
      skipped++
    }
  }
  return { added, skipped }
}

const onFiles = async (e) => {
  const files = e.target.files
  e.target.value = ''
  await addFilesToChat(files)
}

// ---- drag & drop images / PDFs onto the chat ----
const dragOver = ref(false)
let dragDepth = 0
const dropNote = ref('')
const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'))
const onDragEnter = (e) => {
  if (!hasFiles(e) || (!canAttachImage.value && !canAttachPdf.value)) return
  dragDepth++
  dragOver.value = true
}
const onDragOver = (e) => {
  if (!hasFiles(e) || (!canAttachImage.value && !canAttachPdf.value)) return
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
  if (!canAttachImage.value && !canAttachPdf.value) {
    dropNote.value = t('agent_drop_need_config')
    setTimeout(() => { dropNote.value = '' }, 2600)
    return
  }
  const files = (e.dataTransfer && e.dataTransfer.files) || []
  const { added, skipped } = await addFilesToChat(files)
  if (!added && skipped) {
    dropNote.value = t('agent_drop_unsupported')
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
    class="relative flex flex-col h-full min-h-0 bg-base-100"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- drag-and-drop overlay for images / PDFs -->
    <div v-if="dragOver" class="knote-agent-drop absolute inset-0 z-[60] flex items-center justify-center pointer-events-none">
      <div class="flex flex-col items-center gap-2 text-[#4d7c0f]">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 16.5V9m0 0L8.5 12.5M12 9l3.5 3.5M20 16.5A3.5 3.5 0 0 0 18 10a5.5 5.5 0 0 0-10.9-1A4 4 0 0 0 6 17"/></svg>
        <span class="text-xs font-bold">{{ t('agent_drop_hint') }}</span>
      </div>
    </div>
    <!-- header -->
    <div class="flex items-center gap-2 px-3 py-2 border-b border-base-200/70 shrink-0 select-none">
      <span class="w-2 h-2 rounded-full shrink-0" :class="agentStatus === 'running' ? 'bg-[#84cc16] animate-pulse' : configured ? 'bg-[#84cc16]/50' : 'bg-base-300'"></span>
      <!-- first run: no sessions to switch — just the setup title -->
      <span v-if="!configured" class="text-xs font-bold text-base-content/70 truncate">{{ t('agent_setup_title') }}</span>
      <!-- session switcher -->
      <div v-else class="relative min-w-0 flex-1" @mousedown.stop>
        <button class="flex items-center gap-1 max-w-full text-xs font-bold text-base-content/70 hover:text-base-content" @click="sessionsOpen = !sessionsOpen">
          <span class="truncate">{{ sessionTitle(chatSessions.find(s => s.id === activeSessionId) || chatSessions[0]) }}</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 opacity-50"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/></svg>
        </button>
        <div v-if="sessionsOpen" class="absolute left-0 top-6 z-50 w-56 max-h-64 overflow-y-auto bg-base-100 border border-base-200 rounded-xl shadow-xl p-1.5">
          <button class="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-base-200 text-xs text-left text-[#84cc16] font-bold" @click="startNewSession">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
            {{ t('agent_new_chat') }}
          </button>
          <div class="divider my-0.5"></div>
          <div
            v-for="s in [...chatSessions].reverse()" :key="s.id"
            class="group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-base-200 text-xs cursor-pointer"
            :class="{ 'bg-[#84cc16]/10 text-[#84cc16] font-bold': s.id === activeSessionId }"
            @click="pickSession(s.id)"
          >
            <span class="truncate flex-1">{{ sessionTitle(s) }}</span>
            <span v-if="s.id === runningSessionId" class="shrink-0 flex items-center gap-1 text-[9px] font-bold text-[#84cc16]">
              <span class="loading loading-spinner" style="width:8px;height:8px"></span>{{ t('agent_running_badge') }}
            </span>
            <span v-else class="opacity-40 text-[10px] shrink-0">{{ s.messages.length }}</span>
            <button
              v-if="s.id !== runningSessionId"
              class="hidden group-hover:block opacity-50 hover:opacity-100 hover:text-error shrink-0"
              @click="removeSession(s.id, $event)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="ml-auto flex items-center gap-0.5 shrink-0" @mousedown.stop>
        <button v-if="configured" class="btn btn-xs btn-ghost btn-square" :title="t('agent_new_chat')" @click="startNewSession">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
        </button>
        <button v-if="configured" class="btn btn-xs btn-ghost btn-square" :title="t('agent_clear')" :disabled="runningSessionId === activeSessionId" @click="confirmClearOpen = true">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>
        </button>
        <button v-if="mode === 'sidebar'" class="btn btn-xs btn-ghost btn-square" :title="t('agent_hide')" @click="$emit('collapse')">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5"/></svg>
        </button>
        <button v-if="configured" class="btn btn-xs btn-ghost btn-square" :class="{ 'text-[#84cc16]': settingsOpen }" :title="t('agent_settings')" @click="settingsOpen = !settingsOpen">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        </button>
      </div>
    </div>

    <!-- settings: takes over the WHOLE panel body while open (a stacked
         section with a faint divider read as part of the chat) -->
    <div v-if="settingsOpen" class="flex-1 min-h-0 px-3 py-2.5 space-y-2 overflow-y-auto">
      <p v-if="!configured" class="text-[11px] text-base-content/50 leading-relaxed">{{ t('agent_setup_desc') }}</p>
      <div class="grid grid-cols-2 gap-1.5">
        <button
          v-for="p in ['openai', 'anthropic']" :key="p"
          class="btn btn-xs"
          :class="agentConfig.protocol === p ? 'text-white border-none' : 'btn-ghost border border-base-300'"
          :style="agentConfig.protocol === p ? 'background:#84cc16' : ''"
          @click="agentConfig.protocol = p"
        >{{ p === 'openai' ? 'OpenAI 兼容' : 'Anthropic' }}</button>
      </div>
      <label class="block">
        <span class="text-[10px] font-bold opacity-45">{{ t('agent_base_url') }}</span>
        <input v-model.trim="agentConfig.baseUrl" class="input input-xs input-bordered w-full font-mono mt-0.5" placeholder="https://api.deepseek.com" />
      </label>
      <label class="block">
        <span class="text-[10px] font-bold opacity-45">{{ t('agent_api_key') }}</span>
        <input v-model.trim="agentConfig.apiKey" type="password" class="input input-xs input-bordered w-full font-mono mt-0.5" placeholder="sk-…" />
      </label>
      <label class="block">
        <span class="text-[10px] font-bold opacity-45">{{ t('agent_model') }}</span>
        <input v-model.trim="agentConfig.model" class="input input-xs input-bordered w-full font-mono mt-0.5" placeholder="deepseek-chat" />
      </label>
      <label class="block">
        <span class="text-[10px] font-bold opacity-45">{{ t('agent_persona') }}</span>
        <textarea
          v-model.trim="agentConfig.systemExtra"
          rows="2"
          class="textarea textarea-bordered textarea-xs w-full mt-0.5 leading-snug"
          :placeholder="t('agent_persona_ph')"
        ></textarea>
      </label>
      <label class="block">
        <span class="text-[10px] font-bold opacity-45">{{ t('agent_jina_key') }}</span>
        <input v-model.trim="agentConfig.jinaKey" class="input input-xs input-bordered w-full font-mono mt-0.5" placeholder="jina_…" />
      </label>
      <p class="text-[10px] opacity-45 leading-relaxed">{{ t('agent_jina_hint') }}</p>
      <label class="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" v-model="agentConfig.verify" class="checkbox checkbox-xs mt-0.5 [--chkbg:#84cc16] [--chkfg:white]" />
        <span class="min-w-0">
          <span class="text-[11px] font-bold">{{ t('agent_verify') }}</span>
          <span class="block text-[10px] opacity-45 leading-relaxed">{{ t('agent_verify_hint') }}</span>
        </span>
      </label>
      <!-- PDF layout analysis env (PaddleOCR) — one-click install; desktop only -->
      <div v-if="hasPdfEnv" class="rounded-lg border border-base-200 p-2">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-[11px] font-bold flex-1">{{ t('agent_pdf_layout') }}</span>
          <span v-if="pdfEnvState.installed && !pdfBusy" class="badge badge-xs badge-success text-white gap-1">✓ {{ t('agent_pdf_env_ready') }}</span>
        </div>
        <p class="text-[10px] opacity-45 mt-1 leading-relaxed">{{ t('agent_pdf_layout_hint') }}</p>
        <!-- actions -->
        <div class="flex items-center gap-1.5 mt-1.5">
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
        <pre v-if="pdfEnvState.log.length" ref="pdfEnvLogRef" class="pdf-env-log mt-1.5 max-h-32 overflow-auto text-[9.5px] leading-snug bg-base-200/60 rounded p-1.5 whitespace-pre-wrap break-all">{{ pdfEnvState.log.join('\n') }}</pre>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn btn-xs text-white border-none" style="background:#84cc16" :disabled="capabilities.checking" @click="saveSettings">
          <span v-if="capabilities.checking" class="loading loading-spinner loading-xs"></span>
          {{ t('agent_check') }}
        </button>
        <span class="text-[10px] opacity-50">{{ t('agent_key_local_hint') }}</span>
      </div>
      <div v-if="capabilities.checked" class="flex flex-wrap gap-1">
        <span class="badge badge-xs gap-1" :class="capabilities.chat ? 'badge-success text-white' : 'badge-ghost opacity-50'">对话</span>
        <span class="badge badge-xs gap-1" :class="capabilities.tools ? 'badge-success text-white' : 'badge-ghost opacity-50'">工具</span>
        <span class="badge badge-xs gap-1" :class="capabilities.vision ? 'badge-success text-white' : 'badge-ghost opacity-50'">图片</span>
        <span class="badge badge-xs gap-1" :class="capabilities.pdf ? 'badge-success text-white' : 'badge-ghost opacity-50'">PDF 直读</span>
      </div>
      <p v-if="capabilities.error" class="text-[10px] text-error break-all">{{ capabilities.error }}</p>
      <!-- why a capability was marked unsupported (probe rejection details) -->
      <p
        v-for="(n, k) in (capabilities.notes || {})" :key="k"
        class="text-[10px] opacity-45 break-all leading-snug"
      >{{ n }}</p>
      <p v-if="capabilities.checked && capabilities.vision && capabilities.tools && !capabilities.pdf" class="text-[10px] opacity-45">
        {{ t('agent_pdf_page_hint') }}
      </p>
      <p v-if="capabilities.checked && !capabilities.tools" class="text-[10px] text-warning">{{ t('agent_no_tools_hint') }}</p>
    </div>

    <!-- messages (hidden while the settings view owns the panel) -->
    <div v-show="!settingsOpen" ref="listRef" class="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2.5" @click="onListClick">
      <div v-if="!chatMessages.length" class="px-1 py-3 space-y-3">
        <p class="text-xs text-base-content/40 leading-relaxed">{{ t('agent_empty_hint') }}</p>
        <div v-if="suggestions.length" class="flex flex-col gap-1.5">
          <button
            v-for="s in suggestions" :key="s"
            class="text-left text-xs px-2.5 py-1.5 rounded-lg border border-base-200 text-base-content/60 hover:border-[#84cc16]/50 hover:text-[#84cc16] hover:bg-[#84cc16]/5 transition-colors"
            @click="sendSuggestion(s)"
          >{{ s }}</button>
        </div>
      </div>
      <div v-for="(m, i) in chatMessages" :key="i" class="flex flex-col" :class="m.role === 'user' ? 'items-end' : 'items-start'">
        <div
          v-if="m.selection"
          class="max-w-[92%] mb-1 border-l-2 border-[#84cc16]/50 bg-base-200/50 rounded-r-lg px-2 py-1 text-[10px] text-base-content/50 whitespace-pre-wrap break-words max-h-14 overflow-hidden"
        >{{ m.selection.text }}<span v-if="m.selection.lineHint" class="opacity-60">（{{ m.selection.lineHint }}）</span></div>
        <div
          v-if="m.role === 'assistant' && !m.error && renderMd"
          class="knote-agent-md max-w-[92%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed break-words bg-base-200/70 border border-base-200"
          v-html="renderMd(m.text)"
        ></div>
        <div
          v-else
          class="max-w-[92%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words"
          :class="m.role === 'user'
            ? 'bg-[#84cc16]/15 border border-[#84cc16]/25'
            : m.error ? 'bg-error/10 border border-error/30 text-error' : 'bg-base-200/70 border border-base-200'"
        >{{ m.text }}</div>
        <div v-if="m.attachments && m.attachments.length" class="flex flex-wrap gap-1 mt-1" :class="m.role === 'user' ? 'justify-end' : ''">
          <span v-for="(a, j) in m.attachments" :key="j" class="badge badge-ghost badge-xs gap-1 max-w-[10rem]">
            <svg v-if="a.kind === 'pdf'" xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.7"/><path d="m5 18.5 4.8-5.3 3.2 3.5 2.4-2.6 3.6 4"/></svg>
            <span class="truncate">{{ a.name }}</span>
          </span>
        </div>
        <div v-if="m.trace && m.trace.length" class="mt-1 space-y-0.5">
          <div v-for="(s, j) in m.trace" :key="j" class="flex items-center gap-1.5 text-[10px] text-base-content/45">
            <svg v-if="s.done" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#84cc16" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="m5 13 4 4L19 7"/></svg>
            <span v-else class="loading loading-spinner" style="width:10px;height:10px"></span>
            <span>{{ s.label }}<template v-if="s.args">：{{ s.args }}</template></span>
          </div>
        </div>
        <div
          v-if="m.role === 'assistant' && m.usage && (m.usage.input || m.usage.output)"
          class="mt-0.5 text-[9px] font-mono text-base-content/30"
        >{{ m.usage.estimated ? '≈ ' : '' }}{{ t('agent_tok_in') }} {{ fmtTok(m.usage.input) }} · {{ t('agent_tok_out') }} {{ fmtTok(m.usage.output) }} tokens</div>
      </div>
      <div v-if="agentStatus === 'running' && runningSessionId === activeSessionId" class="flex items-center gap-2 text-xs text-base-content/50 px-1">
        <span class="loading loading-dots loading-xs"></span>
        <span>{{ agentActivity }}</span>
      </div>
      <div v-else-if="agentStatus === 'running'" class="flex items-center gap-2 text-[11px] text-base-content/40 px-1">
        <span class="loading loading-spinner" style="width:10px;height:10px"></span>
        <span>{{ t('agent_running_elsewhere') }}</span>
      </div>
      <!-- PDF → agent-processable format: mosaic shimmer while converting -->
      <PdfShimmer
        v-if="pdfProcessing"
        class="mt-1"
        :sub="pdfProcessing.name + (pdfProcessing.pages ? ('  ·  第 ' + pdfProcessing.page + ' / ' + pdfProcessing.pages + ' 页') : '')"
      />
      <!-- multi-agent batch progress -->
      <div v-if="batchState" class="mt-1 rounded-xl border border-base-200 bg-base-100/80 p-2.5">
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
        <button class="shrink-0 opacity-50 hover:opacity-100 hover:text-error" @click="selectionContext = null">
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>

    <!-- draft attachments -->
    <div v-if="draftAtts.length && !settingsOpen" class="px-3 pb-1 flex flex-wrap gap-1.5 shrink-0">
      <div v-for="a in draftAtts" :key="a.id" class="relative group">
        <img v-if="attThumb(a)" :src="attThumb(a)" class="w-10 h-10 object-cover rounded-lg border border-base-300" />
        <div v-else class="w-auto h-10 px-2 flex items-center gap-1 rounded-lg border border-base-300 bg-base-200/60 text-[10px]">
          PDF<span class="opacity-60">{{ a.pages ? `${a.pages}页` : '' }}</span>
        </div>
        <button class="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-base-300 text-[9px] leading-none hidden group-hover:flex items-center justify-center" @click="removeDraft(a.id)">✕</button>
      </div>
    </div>

    <!-- transient drop hint (unsupported type / not configured) -->
    <div v-if="dropNote && !settingsOpen" class="px-3 pb-1 shrink-0">
      <p class="text-[10px] text-warning leading-snug">{{ dropNote }}</p>
    </div>

    <!-- input -->
    <div v-show="!settingsOpen" class="px-3 pt-2 pb-2.5 border-t border-base-200/70 shrink-0">
      <div class="rounded-2xl border border-base-300 bg-base-200/30 focus-within:border-[#84cc16]/60 focus-within:shadow-[0_0_0_3px_rgba(132,204,22,0.12)] transition-all px-3 pt-2 pb-1.5">
        <textarea
          ref="inputRef"
          v-model="input"
          rows="2"
          class="knote-agent-input w-full bg-transparent border-none outline-none resize-none leading-relaxed text-sm min-h-[3.2rem]"
          :placeholder="configured ? t('agent_input_placeholder') : t('agent_configure_first')"
          @keydown="onKeydown"
        ></textarea>
        <div class="flex items-center gap-1">
          <button
            v-if="canAttachImage || canAttachPdf"
            class="btn btn-xs btn-ghost btn-circle opacity-60 hover:opacity-100"
            :title="t('agent_attach')"
            @click="pickFiles"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13"/></svg>
          </button>
          <span class="flex-1"></span>
          <span v-if="agentConfig.model" class="text-[10px] font-mono opacity-30 truncate max-w-[8rem] mr-1">{{ agentConfig.model }}</span>
          <button
            v-if="agentStatus === 'running'"
            class="btn btn-sm btn-circle border-none text-white"
            style="background:#ef4444"
            :title="t('agent_stop')"
            @click="stopAgent"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          </button>
          <button
            v-else
            class="btn btn-sm btn-circle border-none text-white disabled:opacity-30"
            style="background:#84cc16"
            :disabled="!input.trim() && !draftAtts.length"
            :title="t('agent_send')"
            @click="send"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12 3.27 3.13a59.77 59.77 0 0 1 18.02 8.87 59.77 59.77 0 0 1-18.02 8.87L6 12Zm0 0h7.5"/></svg>
          </button>
        </div>
      </div>
      <input ref="fileRef" type="file" multiple :accept="acceptTypes" class="hidden" @change="onFiles" />
    </div>

    <!-- clear-chat confirmation (in-panel dialog, not the browser confirm) -->
    <div
      v-if="confirmClearOpen"
      class="absolute inset-0 z-50 flex items-center justify-center bg-base-content/20 backdrop-blur-[1px]"
      @mousedown.stop
      @click.self="confirmClearOpen = false"
    >
      <div class="bg-base-100 border border-base-200 rounded-xl shadow-2xl p-4 w-64 max-w-[85%] space-y-2">
        <div class="text-sm font-bold">{{ t('agent_clear_title') }}</div>
        <p class="text-xs opacity-60 leading-relaxed">{{ t('agent_clear_desc') }}</p>
        <div class="flex justify-end gap-2 pt-1">
          <button class="btn btn-xs btn-ghost" @click="confirmClearOpen = false">{{ t('agent_cancel') }}</button>
          <button class="btn btn-xs text-white border-none" style="background:#ef4444" @click="doClearChat">{{ t('agent_clear_do') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
