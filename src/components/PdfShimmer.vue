<script setup>
defineProps({
  label: { type: String, default: '' },
  sub: { type: String, default: '' },
  mode: { type: String, default: 'extract' }
})

// Keep the established 22 × 3 shimmer exactly: the only visual difference in
// the tile field is that a few former lime tiles are now plain white gaps.
const COLS = 22
const ROWS = 3
const whiteTiles = new Set([3, 9, 16, 24, 31, 39, 47, 55, 62])
const tiles = Array.from({ length: COLS * ROWS }, (_, index) => {
  const col = index % COLS
  const ramp = 0.18 + 0.82 * (col / (COLS - 1))
  const peak = Math.min(1, ramp * (0.75 + Math.random() * 0.45))
  return {
    id: index,
    peak: peak.toFixed(3),
    delay: `${(Math.random() * 1.8).toFixed(2)}s`,
    duration: `${(1.4 + Math.random() * 1.4).toFixed(2)}s`,
    white: whiteTiles.has(index)
  }
})
</script>

<template>
  <div class="pdfx" :class="`pdfx--${mode}`" role="status" aria-live="polite">
    <div class="pdfx-flow" aria-hidden="true">
      <div class="pdfx-icon pdfx-icon--source">
        <svg viewBox="0 0 48 48" fill="none">
          <path class="pdfx-paper" d="M13.5 6.5h14l7 7v28h-21z"/>
          <path class="pdfx-fold" d="M27.5 6.5v7h7"/>
          <path class="pdfx-pdf-line" d="M18 22h12M18 27h9M18 32h11"/>
          <text x="24" y="40" text-anchor="middle" class="pdfx-pdf-text">PDF</text>
        </svg>
      </div>

      <div class="pdfx-transform">
        <div class="pdfx-rain">
          <span
            v-for="tile in tiles"
            :key="tile.id"
            class="pdfx-pixel"
            :class="{ 'pdfx-pixel--white': tile.white }"
            :style="{
              '--pdfx-peak': tile.peak,
              animationDelay: tile.delay,
              animationDuration: tile.duration
            }"
          ></span>
        </div>
      </div>

      <div class="pdfx-icon pdfx-icon--vector">
        <span class="pdfx-glow"></span>
        <svg viewBox="0 0 48 48" fill="none">
          <path class="pdfx-vector-paper" d="M13.5 6.5h14l7 7v28h-21z"/>
          <path class="pdfx-vector-fold" d="M27.5 6.5v7h7"/>
          <path class="pdfx-vector-line" d="M19 22h10M19 28h8M19 34h11"/>
          <circle class="pdfx-node pdfx-node--one" cx="18" cy="22" r="1.7"/>
          <circle class="pdfx-node pdfx-node--two" cx="29" cy="28" r="1.7"/>
          <circle class="pdfx-node pdfx-node--three" cx="22" cy="34" r="1.7"/>
        </svg>
        <span class="pdfx-scan"></span>
      </div>
    </div>

    <div class="pdfx-copy">
      <div class="pdfx-title">{{ label || 'PDF' }}</div>
      <div v-if="sub" class="pdfx-sub">{{ sub }}</div>
    </div>
  </div>
</template>

<style scoped>
.pdfx {
  --pdfx-green: #84cc16;
  --pdfx-ink: color-mix(in srgb, var(--color-base-content) 84%, transparent);
  padding: 11px 12px 10px;
  border: 1px solid color-mix(in srgb, var(--pdfx-green) 22%, var(--color-base-200));
  border-radius: 13px;
  background:
    radial-gradient(circle at 82% 24%, color-mix(in srgb, var(--pdfx-green) 6%, transparent), transparent 34%),
    color-mix(in srgb, var(--color-base-100) 97%, transparent);
  box-shadow: 0 6px 22px color-mix(in srgb, var(--pdfx-green) 7%, transparent);
  overflow: hidden;
}

.pdfx-flow {
  display: grid;
  grid-template-columns: 38px minmax(150px, 1fr) 38px;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.pdfx-icon {
  position: relative;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.pdfx-icon svg {
  position: relative;
  z-index: 2;
  width: 36px;
  height: 36px;
}

.pdfx-icon--source {
  color: #ef6f68;
  animation: pdfx-source-breathe 3.2s ease-in-out infinite;
}

.pdfx-paper,
.pdfx-fold,
.pdfx-pdf-line {
  stroke: currentColor;
  stroke-width: 1.65;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.pdfx-pdf-line { opacity: .48; }
.pdfx-pdf-text {
  fill: currentColor;
  font: 700 5.5px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .65px;
}

.pdfx-transform {
  position: relative;
  min-width: 0;
  height: auto;
  display: grid;
  place-items: center;
}

.pdfx-rain {
  position: relative;
  z-index: 2;
  width: 100%;
  display: grid;
  grid-template-columns: repeat(22, minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
}

.pdfx-pixel {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 2.5px;
  background: var(--pdfx-green);
  opacity: calc(var(--pdfx-peak) * .3);
  animation-name: pdfx-twinkle;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
  will-change: transform, opacity;
}

.pdfx-pixel--white {
  background: #fff;
  border: 0;
  box-shadow: none;
}

.pdfx-icon--vector {
  color: var(--pdfx-green);
  animation: pdfx-vector-float 3.2s ease-in-out infinite;
}

.pdfx-glow {
  position: absolute;
  inset: 9px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--pdfx-green) 24%, transparent);
  filter: blur(11px);
  animation: pdfx-glow-pulse 2.25s ease-in-out infinite;
}

.pdfx-vector-paper,
.pdfx-vector-fold,
.pdfx-vector-line {
  stroke: currentColor;
  stroke-width: 1.55;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.pdfx-vector-line { opacity: .58; }
.pdfx-node {
  fill: color-mix(in srgb, var(--pdfx-green) 82%, white);
  filter: drop-shadow(0 0 2px color-mix(in srgb, var(--pdfx-green) 70%, transparent));
}

.pdfx-node--one { animation: pdfx-node-pulse 1.8s .1s ease-in-out infinite; }
.pdfx-node--two { animation: pdfx-node-pulse 1.8s .45s ease-in-out infinite; }
.pdfx-node--three { animation: pdfx-node-pulse 1.8s .8s ease-in-out infinite; }

.pdfx-scan {
  position: absolute;
  z-index: 3;
  left: 13px;
  right: 13px;
  height: 1px;
  top: 14px;
  opacity: 0;
  background: linear-gradient(90deg, transparent, #b8ed66, transparent);
  box-shadow: 0 0 7px color-mix(in srgb, var(--pdfx-green) 60%, transparent);
  animation: pdfx-scan 2.4s .3s ease-in-out infinite;
}

.pdfx-copy {
  min-width: 0;
  margin-top: 9px;
  text-align: center;
}

.pdfx-title {
  color: var(--pdfx-ink);
  font-size: 12.5px;
  font-weight: 650;
  line-height: 1.25;
}

.pdfx-sub {
  margin-top: 3px;
  color: color-mix(in srgb, var(--color-base-content) 48%, transparent);
  font-size: 10.5px;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@keyframes pdfx-source-breathe {
  0%, 100% { transform: translateY(0) rotate(0); opacity: .78; }
  50% { transform: translateY(-1.5px) rotate(-.7deg); opacity: 1; }
}

@keyframes pdfx-vector-float {
  0%, 100% { transform: translateY(0) scale(.985); }
  50% { transform: translateY(-2px) scale(1); }
}

@keyframes pdfx-glow-pulse {
  0%, 100% { opacity: .35; transform: scale(.8); }
  50% { opacity: .88; transform: scale(1.08); }
}

@keyframes pdfx-twinkle {
  0%, 100% { opacity: calc(var(--pdfx-peak) * .22); }
  50% { opacity: var(--pdfx-peak); }
}

@keyframes pdfx-node-pulse {
  0%, 100% { opacity: .4; transform: scale(.8); transform-origin: center; }
  50% { opacity: 1; transform: scale(1.2); transform-origin: center; }
}

@keyframes pdfx-scan {
  0%, 15% { top: 14px; opacity: 0; }
  30% { opacity: .85; }
  72% { opacity: .65; }
  88%, 100% { top: 40px; opacity: 0; }
}

@media (max-width: 430px) {
  .pdfx-flow {
    grid-template-columns: 32px minmax(84px, 1fr) 32px;
    gap: 7px;
  }
  .pdfx-icon { width: 32px; height: 32px; }
  .pdfx-icon svg { width: 31px; height: 31px; }
  .pdfx-rain { gap: 1.5px; }
}

@media (prefers-reduced-motion: reduce) {
  .pdfx-icon--source,
  .pdfx-icon--vector,
  .pdfx-pixel,
  .pdfx-glow,
  .pdfx-node,
  .pdfx-scan { animation: none; }
  .pdfx-pixel { opacity: calc(var(--pdfx-peak) * .75); }
  .pdfx-glow { opacity: .55; }
}
</style>
