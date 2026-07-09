<script setup>
// "PDF → agent-processable format" shimmer. A page icon dissolves into a wave
// of gradient tiles (the PDF being carved into data elements: title / text /
// formula / figure / table), with a moving highlight sweep. Shown while a PDF
// is being converted (page render today, layout structuring later).
defineProps({
  label: { type: String, default: '' },
  sub: { type: String, default: '' }
})
const COLS = 16
const ROWS = 3
const tiles = Array.from({ length: COLS * ROWS }, (_, i) => ({
  i,
  delay: ((i % COLS) * 0.045 + Math.floor(i / COLS) * 0.02).toFixed(3)
}))
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
        <div class="pdfx-title">{{ label || '正在解析 PDF 版面结构…' }}</div>
        <div v-if="sub" class="pdfx-sub">{{ sub }}</div>
      </div>
      <div class="pdfx-tags">
        <span v-for="(tg, k) in tags" :key="tg" class="pdfx-tag" :style="{ animationDelay: (k * 0.22) + 's' }">{{ tg }}</span>
      </div>
    </div>
    <div class="pdfx-grid" aria-hidden="true">
      <span v-for="t in tiles" :key="t.i" class="pdfx-tile" :style="{ animationDelay: t.delay + 's' }"></span>
      <div class="pdfx-sweep"></div>
    </div>
  </div>
</template>

<style scoped>
.pdfx {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--color-base-100) 90%, transparent);
  border: 1px solid color-mix(in srgb, #22d3ee 22%, transparent);
  box-shadow: 0 6px 20px color-mix(in srgb, #6366f1 12%, transparent);
}
.pdfx-head { display: flex; align-items: center; gap: 9px; }
.pdfx-doc {
  width: 20px; height: 20px; flex: none;
  color: #22d3ee;
  animation: pdfx-doc-pulse 1.8s ease-in-out infinite;
}
@keyframes pdfx-doc-pulse {
  0%, 100% { opacity: 0.6; transform: translateY(0); }
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
  color: #0e7490;
  background: color-mix(in srgb, #22d3ee 16%, transparent);
  animation: pdfx-tag-blink 1.4s ease-in-out infinite;
}
@keyframes pdfx-tag-blink {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}

/* the mosaic: a gradient carved into a grid of tiles, each fading in a wave */
.pdfx-grid {
  position: relative;
  display: grid;
  grid-template-columns: repeat(16, 1fr);
  gap: 2px;
  height: 26px;
  padding: 2px;
  border-radius: 8px;
  overflow: hidden;
  /* the "agent-processable" gradient the tiles reveal */
  background: linear-gradient(100deg, #84cc16 0%, #22d3ee 46%, #a78bfa 100%);
}
.pdfx-tile {
  border-radius: 2px;
  /* a translucent dark cover; the wave animation makes it fade so the gradient
     shines through in a moving diagonal band (the mosaic shimmer) */
  background: color-mix(in srgb, var(--color-base-100) 82%, transparent);
  animation: pdfx-tile-wave 1.5s ease-in-out infinite;
}
@keyframes pdfx-tile-wave {
  0%, 100% { opacity: 0.9; transform: scale(0.86); }
  45% { opacity: 0.06; transform: scale(1); }
}
/* a bright highlight sweeping across, on top of the tiles */
.pdfx-sweep {
  position: absolute;
  top: 0; bottom: 0; left: 0;
  width: 34%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.55), transparent);
  filter: blur(1px);
  animation: pdfx-sweep 1.6s linear infinite;
}
@keyframes pdfx-sweep {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(420%); }
}
@media (prefers-reduced-motion: reduce) {
  .pdfx-doc, .pdfx-tag, .pdfx-tile, .pdfx-sweep { animation: none; }
  .pdfx-tile { opacity: 0.25; }
}
</style>
