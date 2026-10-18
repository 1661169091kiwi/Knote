<script setup>
import { computed, ref } from 'vue'

const props = defineProps({ lang: { type: String, default: 'zh' } })
const paused = ref(false)
const replayKey = ref(0)
const copy = computed(() => props.lang === 'en' ? {
  label: 'Resize a panel using its compact handle', sidebar: 'Sidebar', editor: 'Editor', assistant: 'Agent',
  phases: ['Hover the boundary', 'Move onto the short handle', 'Hold and drag to resize'],
  summary: 'Boundary = a hint. Green handle = drag here. Move away to hide it.',
  pause: 'Pause', play: 'Play', replay: 'Replay', static: 'Animation off · reduced motion'
} : {
  label: '使用中段短把手调整区域宽度', sidebar: '侧栏', editor: '编辑区', assistant: '助手',
  phases: ['悬浮边界，发现把手', '移到短把手，准备拖动', '按住拖动，调整宽度'],
  summary: '边界是提示，短把手才可拖动；移开鼠标后自动隐藏。',
  pause: '暂停', play: '播放', replay: '重播', static: '已减少动态效果 · 静态示意'
})
const replay = () => { replayKey.value++; paused.value = false }
</script>

<template>
  <figure class="resize-tour" data-testid="resize-tour" :aria-label="copy.label" :style="{ '--tour-play-state': paused ? 'paused' : 'running' }">
    <div class="resize-tour-heading"><span>WORKSPACE / RESIZE</span><i></i></div>
    <!-- One CSS-only scene. It exists only on this lesson, uses transforms and
         opacity rather than layout, and adds no pointer tracking or timers. -->
    <div :key="replayKey" class="resize-tour-scene">
      <svg viewBox="0 0 560 376" fill="none" aria-hidden="true">
        <rect x="8" y="18" width="544" height="336" rx="22" fill="#f2f5ed" />
        <rect x="8.5" y="18.5" width="543" height="335" rx="21.5" stroke="#dce4d5" />
        <circle cx="29" cy="40" r="3" fill="#a6ce6d" /><circle cx="40" cy="40" r="3" fill="#dfe5d8" /><circle cx="51" cy="40" r="3" fill="#dfe5d8" />
        <text x="531" y="44" text-anchor="end" class="scene-brand">Knote</text>
        <g class="scene-sidebar-surface"><rect x="20" y="62" width="112" height="280" rx="12" fill="white" /></g>
        <text x="34" y="88" class="scene-label">{{ copy.sidebar }}</text>
        <path d="M34 111H106M34 133H91M34 155H101M34 177H82" stroke="#e1e8db" stroke-width="5" stroke-linecap="round" />
        <rect x="32" y="201" width="75" height="22" rx="6" fill="#eef7df" />
        <path d="M40 212H83M34 244H101M34 266H88M34 288H96" stroke="#d6e4c7" stroke-width="4" stroke-linecap="round" />
        <g class="scene-editor-surface"><rect x="154" y="62" width="264" height="280" rx="12" fill="white" /></g>
        <g class="scene-editor-content">
          <text x="172" y="88" class="scene-label">{{ copy.editor }}</text>
          <text x="172" y="135" class="scene-title">Ideas, in focus.</text>
          <path d="M172 157H340M172 175H322M172 193H330M172 229H335M172 247H314M172 265H325" stroke="#e5eadd" stroke-width="5" stroke-linecap="round" />
          <rect x="172" y="289" width="104" height="5" rx="2.5" fill="#e9dda0" />
        </g>
        <rect x="438" y="62" width="102" height="280" rx="12" fill="#fcfdf9" />
        <text x="452" y="88" class="scene-label">{{ copy.assistant }}</text>
        <rect x="451" y="115" width="74" height="42" rx="9" fill="#edf7df" />
        <path d="M461 130H512M461 140H497M453 183H518M453 199H508M453 215H515" stroke="#dbe5d0" stroke-width="4" stroke-linecap="round" />
        <rect x="451" y="296" width="76" height="32" rx="9" stroke="#e0e7d7" />
        <g class="scene-boundary">
          <path class="scene-edge" d="M142 76V328" stroke="#a6ce6d" stroke-dasharray="2 6" />
          <path class="scene-handle" d="M142 148V180" stroke="#84cc16" stroke-width="4" stroke-linecap="round" />
          <path class="scene-other-handle" d="M151 227V259" stroke="#84cc16" stroke-width="4" stroke-linecap="round" />
        </g>
        <g class="scene-cursor">
          <circle class="scene-press" r="16" fill="#84cc16" fill-opacity=".14" stroke="#84cc16" stroke-opacity=".3" />
          <g class="scene-arrow-cursor"><path d="M-1-2L12 8L5 9L8 17L4 19L1 11L-4 16Z" fill="#283421" stroke="white" stroke-width="2" stroke-linejoin="round" /></g>
          <g class="scene-resize-cursor" stroke-linecap="round" stroke-linejoin="round"><path d="M-12 0H12M-7-5L-12 0L-7 5M7-5L12 0L7 5" stroke="white" stroke-width="5" /><path d="M-12 0H12M-7-5L-12 0L-7 5M7-5L12 0L7 5" stroke="#354729" stroke-width="2" /></g>
        </g>
      </svg>
      <div class="resize-tour-phases" aria-hidden="true"><span v-for="(phase, index) in copy.phases" :key="index" :class="`phase-${index}`"><b>0{{ index + 1 }}</b>{{ phase }}</span></div>
    </div>
    <figcaption>{{ copy.summary }}</figcaption>
    <div class="resize-tour-controls">
      <span class="resize-tour-static">{{ copy.static }}</span>
      <button class="resize-tour-motion-control" :aria-pressed="paused" @click="paused = !paused"><span aria-hidden="true">{{ paused ? '▶' : 'Ⅱ' }}</span>{{ paused ? copy.play : copy.pause }}</button>
      <button class="resize-tour-motion-control" @click="replay"><span aria-hidden="true">↺</span>{{ copy.replay }}</button>
    </div>
  </figure>
</template>

<style scoped>
.resize-tour{width:min(580px,100%);min-width:0;justify-self:end;margin:0;padding:22px 20px 16px;box-sizing:border-box;border:1px solid #dfe6d8;border-radius:28px;background:rgba(255,255,255,.8);box-shadow:0 28px 75px rgba(56,70,43,.09);color:#35432b}
.resize-tour-heading{display:flex;align-items:center;justify-content:space-between;padding:0 7px;font:600 9px/1.4 ui-monospace,Consolas,monospace;letter-spacing:.14em;color:#85917a}.resize-tour-heading i{width:6px;height:6px;border-radius:50%;background:#a6ce6d}
.resize-tour-scene{position:relative;margin:8px -3px 0;padding-bottom:36px}.resize-tour-scene svg{display:block;width:100%;overflow:visible}.scene-brand{font:700 10px 'Segoe UI',sans-serif;fill:#809173}.scene-label{font:600 10px 'Segoe UI','Microsoft YaHei UI',sans-serif;fill:#8c9784}.scene-title{font:600 18px 'Segoe UI',sans-serif;fill:#37452e;letter-spacing:-.5px}
.scene-sidebar-surface{transform-box:fill-box;transform-origin:left center;animation:resizeTourSidebar 10s ease-in-out infinite}.scene-editor-surface{transform-box:fill-box;transform-origin:left center;animation:resizeTourEditor 10s ease-in-out infinite}.scene-editor-content,.scene-boundary{animation:resizeTourMove 10s ease-in-out infinite}.scene-cursor{animation:resizeTourCursor 10s ease-in-out infinite}.scene-edge,.scene-handle{opacity:0;animation:resizeTourReveal 10s ease-in-out infinite}.scene-other-handle{opacity:0}.scene-resize-cursor{opacity:0;animation:resizeTourResizeCursor 10s step-end infinite}.scene-arrow-cursor{animation:resizeTourArrowCursor 10s step-end infinite}.scene-press{opacity:0;animation:resizeTourPress 10s ease-in-out infinite}
.resize-tour-phases{position:absolute;bottom:6px;left:0;right:0;height:28px;display:grid;place-items:center;font-size:12px;color:#576b42}.resize-tour-phases span{grid-area:1/1;display:flex;align-items:center;gap:9px;opacity:0;animation:resizeTourPhase 10s step-end infinite}.resize-tour-phases b{font:600 9px ui-monospace,Consolas,monospace;color:#92a47c}.resize-tour-phases .phase-1{animation-name:resizeTourPhaseTwo}.resize-tour-phases .phase-2{animation-name:resizeTourPhaseThree}
.resize-tour-scene *{animation-play-state:var(--tour-play-state,running)}
figcaption{margin:8px 7px 0;text-align:center;font-size:11px;line-height:1.7;color:#86917d}.resize-tour-controls{display:flex;justify-content:center;gap:18px;margin-top:13px}.resize-tour-controls button{display:flex;align-items:center;gap:6px;padding:5px 9px;border:0;border-radius:8px;background:transparent;color:#6d7a61;font-size:11px;cursor:var(--knote-cursor-pointer)}.resize-tour-controls button:hover{background:#eef5e5;color:#3d6126}.resize-tour-controls button:focus-visible{outline:2px solid #84cc16;outline-offset:2px}.resize-tour-controls button span{font-size:13px}.resize-tour-static{display:none;font-size:10px;color:#86917d}
@keyframes resizeTourSidebar{0%,40%,100%{transform:scaleX(1)}64%,82%{transform:scaleX(1.518)}}
@keyframes resizeTourEditor{0%,40%,100%{transform:translateX(0) scaleX(1)}64%,82%{transform:translateX(58px) scaleX(.7803)}}
@keyframes resizeTourMove{0%,40%,100%{transform:translateX(0)}64%,82%{transform:translateX(58px)}}
@keyframes resizeTourCursor{0%,5%{opacity:0;transform:translate(202px,111px)}12%,23%{opacity:1;transform:translate(142px,111px)}34%,40%{opacity:1;transform:translate(142px,164px)}64%,73%{opacity:1;transform:translate(200px,164px)}81%{opacity:1;transform:translate(260px,196px)}87%,100%{opacity:0;transform:translate(260px,196px)}}
@keyframes resizeTourReveal{0%,9%,82%,100%{opacity:0}12%,74%{opacity:1}}
@keyframes resizeTourResizeCursor{0%,80%,100%{opacity:0}12%{opacity:1}}
@keyframes resizeTourArrowCursor{0%,80%,100%{opacity:1}12%{opacity:0}}
@keyframes resizeTourPress{0%,36%,72%,100%{opacity:0;transform:scale(.75)}40%,66%{opacity:1;transform:scale(1)}}
@keyframes resizeTourPhase{0%{opacity:1}26%,100%{opacity:0}}
@keyframes resizeTourPhaseTwo{0%,40%,100%{opacity:0}26%{opacity:1}}
@keyframes resizeTourPhaseThree{0%,90%,100%{opacity:0}40%{opacity:1}}
@media(max-width:850px){.resize-tour{justify-self:center;width:min(580px,100%)}}
@media(max-width:520px){.resize-tour{padding:16px 12px 12px;border-radius:22px}.resize-tour-phases{font-size:11px}figcaption{font-size:10px}}
@media(prefers-reduced-motion:reduce){.resize-tour-scene *{animation:none!important}.scene-cursor{transform:translate(142px,164px)}.scene-arrow-cursor,.scene-edge{opacity:0}.scene-handle,.scene-other-handle,.scene-resize-cursor{opacity:1}.resize-tour-phases .phase-2{opacity:1}.resize-tour-controls .resize-tour-motion-control{display:none}.resize-tour-static{display:inline}}
</style>
