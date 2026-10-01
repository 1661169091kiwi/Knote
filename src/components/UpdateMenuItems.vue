<script setup>
import { computed, useId } from 'vue'
const props = defineProps({ state: Object, lang: String, prefix: { type: String, default: 'navbar' } })
const emit = defineEmits(['activate', 'refresh', 'toggle-auto'])
const busy = computed(() => ['checking', 'downloading'].includes(props.state.phase))
// Keep focus on this row during work so the focus-driven parent menu does
// not close and hide progress when a native disabled button would blur.
const activate = () => { if (!busy.value) emit('activate') }
const id = useId().replace(/[^a-z0-9]/gi, '')
const percent = computed(() => Math.min(props.state.phase === 'downloaded' ? 100 : 99.5, Math.max(0, (props.state.received / props.state.total || 0) * 100)))
const label = computed(() => {
  const zh = props.lang === 'zh', s = props.state
  if (s.phase === 'checking') return zh ? '正在检查更新…' : 'Checking for updates…'
  if (s.phase === 'downloading') return zh ? '正在下载更新' : 'Downloading update'
  if (s.phase === 'downloaded') return zh ? '查看已下载的安装包' : 'Show downloaded update'
  if (s.release) return `${zh ? '下载更新' : 'Download update'} ${s.release.version}`
  if (s.phase === 'error') return zh ? '检查失败，点击重试' : 'Check failed · retry'
  if (s.phase === 'current') return zh ? '已是最新版本' : 'You’re up to date'
  return zh ? '检查更新' : 'Check for updates'
})
const detail = computed(() => {
  const s = props.state, zh = props.lang === 'zh'
  if (s.phase === 'downloading') return `${(s.received / 1048576).toFixed(1)} / ${(s.total / 1048576).toFixed(1)} MB · ${Math.floor(percent.value)}%`
  if (s.phase === 'error') return zh ? '网络或文件校验失败，可重试' : 'Network or verification failed · retry'
  return s.phase === 'downloaded' ? (zh ? '校验完成，点击打开文件夹' : 'Verified · click to open folder') : `${zh ? '当前版本' : 'Current version'} ${s.currentVersion}`
})
</script>
<template>
  <li class="knote-update-item">
    <div :data-testid="`${prefix}-update-row`" class="knote-update-row">
      <svg v-if="state.phase === 'downloading'" class="knote-update-liquid" data-testid="update-progress-fill" viewBox="0 0 1000 64" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <clipPath :id="`update-wave-${id}`"><path :transform="`translate(${percent * 10},0)`" d="M-1000 0H0C16 15-16 49 0 64H-1000Z"><animate attributeName="d" dur="2.4s" repeatCount="indefinite" values="M-1000 0H0C16 15-16 49 0 64H-1000Z;M-1000 0H0C-16 15 16 49 0 64H-1000Z;M-1000 0H0C16 15-16 49 0 64H-1000Z" /></path></clipPath>
          <linearGradient :id="`update-flow-${id}`"><stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset=".5" stop-color="#ffffff" stop-opacity=".65"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
        </defs>
        <g :clip-path="`url(#update-wave-${id})`"><rect width="1000" height="64" fill="#e5f3cc"/><rect width="260" height="64" :fill="`url(#update-flow-${id})`"><animateTransform attributeName="transform" type="translate" from="-260 0" to="1000 0" dur="2.8s" repeatCount="indefinite" /></rect></g>
      </svg>
      <button :data-testid="`${prefix}-check-update`" class="knote-update-main" :aria-disabled="busy" @click.stop="activate">
        <svg class="knote-update-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/></svg>
        <span class="knote-update-copy"><span>{{ label }}</span><small>{{ detail }}</small></span>
      </button>
      <button :data-testid="`${prefix}-refresh-update`" class="knote-update-refresh" :aria-label="lang === 'zh' ? '重新检查更新' : 'Check for updates again'" :title="lang === 'zh' ? '重新检查更新' : 'Check for updates again'" :aria-disabled="busy" @click.stop="!busy && $emit('refresh')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.5 6.5a8 8 0 0 1 13 3M4.5 14.5a8 8 0 0 0 13 3"/></svg>
      </button>
      <span v-if="state.phase === 'downloading'" class="knote-update-progress-a11y" role="progressbar" aria-label="Update download" :aria-valuenow="Math.floor(percent)" aria-valuemin="0" aria-valuemax="100"></span>
    </div>
  </li>
  <li><button :data-testid="`${prefix}-auto-update-check`" class="knote-update-auto" role="menuitemcheckbox" :aria-checked="state.autoCheck" @click.stop="$emit('toggle-auto')"><span>{{ lang === 'zh' ? '启动时自动检查更新' : 'Check updates on startup' }}</span><svg v-if="state.autoCheck" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg></button></li>
</template>
<style scoped>
.knote-update-row{position:relative;isolation:isolate;display:flex!important;gap:8px;align-items:center;width:100%;min-height:52px;padding:9px 10px!important;border-radius:9px;overflow:hidden;background:var(--color-base-100,#fff);color:inherit}
.knote-update-main{display:flex!important;align-items:center;gap:8px;flex:1;min-width:0;padding:0!important;background:transparent;text-align:left;cursor:pointer}
.knote-update-refresh{display:grid!important;place-items:center;flex:none;width:28px;height:28px;padding:0!important;border-radius:8px;background:transparent;color:#638f30;cursor:pointer}
.knote-update-refresh:hover{background:var(--color-base-200,#f3f6ed)}
.knote-update-main[aria-disabled="true"],.knote-update-refresh[aria-disabled="true"]{cursor:default}.knote-update-main:focus-visible,.knote-update-refresh:focus-visible{outline:2px solid #84cc16;outline-offset:1px}.knote-update-liquid{position:absolute;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none}.knote-update-icon{width:17px;height:17px;flex:none;color:#638f30}.knote-update-copy{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:12px;font-weight:550}.knote-update-copy small{font-size:10px;font-weight:400;line-height:1.4;opacity:.6;overflow-wrap:anywhere}.knote-update-auto{display:flex!important;align-items:center;justify-content:space-between;gap:6px;width:100%;font-size:11px!important;padding:8px 10px!important}.knote-update-auto svg{color:#638f30;flex:none}.knote-update-progress-a11y{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
@media(prefers-reduced-motion:reduce){.knote-update-liquid animate,.knote-update-liquid animateTransform{display:none}}
</style>
