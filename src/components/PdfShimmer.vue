<script setup>
// "PDF → agent-processable format" indicator, styled after Claude Code's
// ultracode effort track: a horizontal strip of small rounded pixel tiles in
// the THEME LIME only, intensity ramping left→right with a dithered random
// twinkle so the whole bar reads as a living gradient. Shown while a PDF is
// being converted (page render / layout analysis).
defineProps({
  label: { type: String, default: '' },
  sub: { type: String, default: '' }
})
const COLS = 22
const ROWS = 3
// per-tile: intensity ramps with the column, dithered per tile so the bar
// looks pixel-shaded rather than a flat gradient; each tile twinkles on its
// own rhythm (random delay/duration), denser+brighter toward the right
const tiles = Array.from({ length: COLS * ROWS }, (_, i) => {
  const col = i % COLS
  const ramp = 0.18 + 0.82 * (col / (COLS - 1))
  const peak = Math.min(1, ramp * (0.75 + Math.random() * 0.45))
  return {
    i,
    peak: peak.toFixed(3),
    delay: (Math.random() * 1.8).toFixed(2),
    dur: (1.4 + Math.random() * 1.4).toFixed(2)
  }
})
const tags = ['标题', '正文', '公式', '图', '表']
</script>

<template>
  <div class="pdfx" role="status">
    <div class="pdfx-head">
      <svg class="pdfx-doc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <path d="M9 13h6M9 17h4"/>
      </svg>
      <div class="pdfx-txt">
        <div class="pdfx-title">{{ label || '正在解析 PDF…' }}</div>
        <div v-if="sub" class="pdfx-sub">{{ sub }}</div>
      </div>
      <div class="pdfx-tags">
        <span v-for="(tg, k) in tags" :key="tg" class="pdfx-tag" :style="{ animationDelay: (k * 0.22) + 's' }">{{ tg }}</span>
      </div>
    </div>
    <div class="pdfx-track" aria-hidden="true">
      <span
        v-for="t in tiles"
        :key="t.i"
        class="pdfx-px"
        :style="{ '--pk': t.peak, animationDelay: t.delay + 's', animationDuration: t.dur + 's' }"
      ></span>
    </div>
  </div>
</template>

<style scoped>
.pdfx {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--color-base-100) 92%, transparent);
  border: 1px solid color-mix(in srgb, #84cc16 26%, transparent);
  box-shadow: 0 4px 16px color-mix(in srgb, #84cc16 10%, transparent);
}
.pdfx-head { display: flex; align-items: center; gap: 9px; }
.pdfx-doc {
  width: 20px; height: 20px; flex: none;
  color: #84cc16;
  animation: pdfx-doc-pulse 1.8s ease-in-out infinite;
}
@keyframes pdfx-doc-pulse {
  0%, 100% { opacity: 0.55; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-1px); }
}
.pdfx-txt { flex: 1 1 auto; min-width: 0; }
.pdfx-title {
  font-size: 12.5px; font-weight: 600; line-height: 1.2;
  color: var(--color-base-content);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pdfx-sub {
  font-size: 10.5px; margin-top: 1px;
  color: color-mix(in srgb, var(--color-base-content) 50%, transparent);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pdfx-tags { display: flex; gap: 4px; flex: none; }
.pdfx-tag {
  font-size: 9px; line-height: 1; padding: 3px 5px; border-radius: 5px;
  color: #4d7c0f;
  background: color-mix(in srgb, #84cc16 16%, transparent);
  animation: pdfx-tag-blink 1.4s ease-in-out infinite;
}
@keyframes pdfx-tag-blink {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}

/* the ultracode-style pixel track: theme lime only, intensity ramping
   left→right, every tile twinkling on its own rhythm */
.pdfx-track {
  display: grid;
  grid-template-columns: repeat(22, 1fr);
  gap: 2px;
  padding: 2px;
  border-radius: 7px;
  background: color-mix(in srgb, #84cc16 8%, transparent);
}
.pdfx-px {
  aspect-ratio: 1;
  border-radius: 2.5px;
  background: #84cc16;
  opacity: calc(var(--pk) * 0.3);
  animation-name: pdfx-twinkle;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
@keyframes pdfx-twinkle {
  0%, 100% { opacity: calc(var(--pk) * 0.22); }
  50% { opacity: var(--pk); }
}
@media (prefers-reduced-motion: reduce) {
  .pdfx-doc, .pdfx-tag, .pdfx-px { animation: none; }
  .pdfx-px { opacity: calc(var(--pk) * 0.75); }
}
</style>
