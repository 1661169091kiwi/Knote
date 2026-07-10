<script setup>
// Knote 助手 · 像素猕猴桃 — a hand-animated pixel-art kiwi (matches the app
// icon) that replaces the plain floating agent ball. Its 7 states are driven
// by real agent state (idle / working / waiting-for-review / done / error /
// hello / sleep) and a speech bubble shows what it's busy with.
//
// The kiwi + particle rendering is ported verbatim from the design artifact
// (the frame math lives in a fixed 300px coordinate space); frame() just wraps
// every draw in a scale transform so the whole thing renders at a compact size.
// The speech bubble is reactive Vue markup, not canvas.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  state: { type: String, default: 'idle' }, // idle|working|waiting|done|error|hello|sleep
  message: { type: String, default: '' },
  size: { type: Number, default: 84 },
  t: { type: Function, default: (k) => k },
  grab: { type: Function, default: null } // parent's drag/click-to-open handler
})

const cv = ref(null)

// ---- speech bubble (reactive) ----
// "本次不再提示" mutes for THIS app session only (in-memory, not persisted):
// the bubble comes back on the next launch by design
const closedPerm = ref(false)
const closedOnce = ref(false)
const busy = computed(() => ['working', 'waiting', 'error'].includes(props.state) && !!props.message)
const bubbleShown = computed(() => busy.value && !closedPerm.value && !closedOnce.value)
const pillShown = computed(() => busy.value && !closedPerm.value && closedOnce.value)
// any state change is a new thing worth surfacing, so un-dismiss the bubble
// (a dismiss only silences the CURRENT state; step-message updates within one
// state don't change props.state, so they stay dismissed as expected)
watch(() => props.state, (now, prev) => { if (now !== prev) closedOnce.value = false })
const closeOnce = () => { closedOnce.value = true }
const closePerm = () => { closedPerm.value = true }
const reopen = () => { closedOnce.value = false }

// ================= pixel kiwi renderer (ported) =================
let raf = 0
let stopped = false
onMounted(() => {
  let reduce = false
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch (e) { /* ignore */ }
  const DISP = props.size
  const cvEl = cv.value
  const ctx = cvEl.getContext('2d')
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
  cvEl.width = DISP * dpr; cvEl.height = DISP * dpr
  cvEl.style.width = cvEl.style.height = DISP + 'px'
  ctx.scale(dpr, dpr); ctx.imageSmoothingEnabled = false
  const SCALE = DISP / 300 // artifact math is authored in a 300px space

  const SS = 36; const sc = document.createElement('canvas'); sc.width = sc.height = SS; const s = sc.getContext('2d')
  const K = { rim: '#7bb04a', body: '#b5df84', bodyLt: '#cdea9f', cream: '#f4fbe6', seed: '#2e2a22', eye: '#33302a', white: '#fff', mouth: '#5a4636', pink: '#f4a6b0', limb: '#8fbf5a', limbD: '#6d9c3e', pith: '#7bb04a' }
  const CX = 18; const CY = 17
  function p (c, x, y, w, h) { s.fillStyle = c; s.fillRect(Math.round(x), Math.round(y), (w || 1), (h || 1)) }
  function ell (cx, cy, rx, ry, c) { for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) { const dx = (x - cx + 0.5) / rx; const dy = (y - cy + 0.5) / ry; if (dx * dx + dy * dy <= 1) p(c, x, y, 1, 1) } }
  function eyes (kind, ey) { const y = ey; let dx = 0; if (kind === 'look') dx = -1; if (kind === 'look2') dx = 1
    function one (x) { x += dx
      if (kind === 'blink' || kind === 'closed') { p(K.eye, x, y + 1, 2, 1); if (kind === 'closed') p(K.eye, x, y + 2, 1, 1) } else if (kind === 'happy') { p(K.eye, x - 1, y + 1, 1, 1); p(K.eye, x, y, 1, 1); p(K.eye, x + 1, y, 1, 1); p(K.eye, x + 2, y + 1, 1, 1) } else if (kind === 'focus' || kind === 'focus2') { p(K.eye, x, y - 2, 2, 1); p(K.eye, x, y + (kind === 'focus2' ? 1 : 0), 2, 2) } else if (kind === 'dizzy') { p(K.eye, x, y, 1, 1); p(K.eye, x + 2, y, 1, 1); p(K.eye, x + 1, y + 1, 1, 1); p(K.eye, x, y + 2, 1, 1); p(K.eye, x + 2, y + 2, 1, 1) } else { p(K.eye, x, y, 2, 3); p(K.white, x, y, 1, 1) } }
    one(CX - 4); one(CX + 3) }
  function mouth (kind, my) { const cx = CX
    if (kind === 'open') { p(K.mouth, cx - 2, my, 5, 1); p(K.mouth, cx - 2, my + 1, 1, 1); p(K.mouth, cx + 2, my + 1, 1, 1); p(K.pink, cx - 1, my + 1, 3, 1) } else if (kind === 'small') { p(K.mouth, cx, my, 1, 2); p(K.mouth, cx - 1, my + 1, 3, 1) } else if (kind === 'sleep') { p(K.mouth, cx, my + 1, 2, 1) } else if (kind === 'wavy') { p(K.mouth, cx - 2, my + 1, 1, 1); p(K.mouth, cx - 1, my, 1, 1); p(K.mouth, cx, my + 1, 1, 1); p(K.mouth, cx + 1, my, 1, 1); p(K.mouth, cx + 2, my + 1, 1, 1) } else if (kind === 'flat') { p(K.mouth, cx - 1, my + 1, 3, 1) } else { p(K.mouth, cx - 2, my + 1, 1, 1); p(K.mouth, cx - 1, my + 2, 3, 1); p(K.mouth, cx + 2, my + 1, 1, 1) } }
  function frameRect (x, y, w, h, c) { p(c, x, y, w, 1); p(c, x, y + h - 1, w, 1); p(c, x, y, 1, h); p(c, x + w - 1, y, 1, h) }
  function arm (side, ay, ax) { const hx = CX + side * 13 + (ax || 0) * side; const hy = CY + 3 + (ay || 0); const shx = CX + side * 9; const shy = CY + 3
    p(K.limbD, Math.round((shx + hx) / 2), Math.round((shy + hy) / 2), 2, 2)
    const hxx = side < 0 ? hx - 1 : hx; p(K.body, hxx, hy, 2, 2); p(K.limbD, hxx, hy + 1, 2, 1) }
  function leg (side, ly) { const fx = CX + side * 4 - (side < 0 ? 1 : 0); const fy = CY + 13 - (ly || 0); p(K.limb, fx, fy, 3, 2); p(K.limbD, fx, fy + 1, 3, 1) }
  function glasses (g) { const oy = Math.round((1 - g) * 5); const y = CY - 2 - oy
    frameRect(CX - 6, y, 5, 4, K.eye); frameRect(CX + 1, y, 5, 4, K.eye); p(K.eye, CX - 1, y + 1, 2, 1)
    p('#dff2f7', CX - 5, y + 1, 2, 1); p('#dff2f7', CX + 2, y + 1, 2, 1); p('#ffffff', CX - 5, y + 1, 1, 1); p('#ffffff', CX + 2, y + 1, 1, 1) }
  const LX = -2
  function faceUplight (off) { const top = CY + 1 + off
    s.save(); const g = s.createLinearGradient(0, top, 0, top - 11)
    g.addColorStop(0, 'rgba(150,246,168,0.34)'); g.addColorStop(0.4, 'rgba(150,244,172,0.15)'); g.addColorStop(1, 'rgba(160,244,180,0)')
    s.fillStyle = g; s.fillRect(CX - 10, top - 11, 20, 11); s.restore(); s.globalAlpha = 1
    s.save(); s.globalAlpha = 0.5; p('#c8ffc8', CX + LX - 11, top - 1, 12, 1); s.globalAlpha = 0.3; p('#e2ffe2', CX + LX - 10, top - 2, 7, 1); s.restore(); s.globalAlpha = 1 }
  function deck (off) { for (let i = 0; i <= 3; i++) { const y = CY + 10 + off + i; const tt = i / 3; const lx = CX + LX + Math.round(-9 + tt * 1); const rx = CX + LX + Math.round(2 + tt * 6); p('#34353f', lx, y, rx - lx + 1, 1); if (i === 2) p('#565a68', CX + LX + 1, y, Math.max(0, rx - (CX + LX + 1) - 1), 1) } }
  function lid (off) { const y0 = CY + 1 + off; const y1 = CY + 10 + off; const h = y1 - y0; const bx0 = CX + LX - 9; const bx1 = CX + LX + 3; const tx0 = CX + LX - 12; const tx1 = CX + LX + 1
    for (let y = y0; y <= y1; y++) { const tt = (y - y0) / h; const lx = Math.round(tx0 + (bx0 - tx0) * tt); const rx = Math.round(tx1 + (bx1 - tx1) * tt); p('#3a3d47', lx, y, rx - lx + 1, 1); p('#464b58', lx, y, 1, 1); p('#33353f', rx, y, 1, 1) }
    p('#4a4e5b', tx0 + 1, y0 + 1, (tx1 - tx0) - 1, 1); p('#bdf5bd', tx0 + 1, y0, (tx1 - tx0) - 1, 1) }
  function rightHand (f, off) { const ty = (f.type || 0); const hx = CX + LX + 5; const hy = CY + 12 + off - ty
    p(K.limbD, hx - 2, hy + 1, 2, 1); p(K.body, hx, hy, 2, 2); p(K.limbD, hx, hy + 2, 1, 1) }
  function sprite (f) { s.clearRect(0, 0, SS, SS)
    const lap = f.laptop || 0; const gl = f.glasses || 0; const loff = Math.round((1 - lap) * 10)
    leg(-1, f.llY || 0); leg(1, f.lrY || 0)
    if (!lap) { arm(-1, f.alY || 0, f.alX || 0); arm(1, f.arY || 0, f.arX || 0) }
    ell(CX, CY, 12, 13, K.rim); ell(CX, CY, 10.5, 11.5, K.body); ell(CX, CY - 2, 7, 7, K.bodyLt)
    for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2 + Math.PI / 12; for (let r = 6; r < 10; r++)p(K.pith, Math.round(CX + Math.cos(a) * r), Math.round(CY + Math.sin(a) * r), 1, 1) }
    ell(CX, CY + 1, 6, 6.2, K.cream); ell(CX, CY + 1, 5, 5, K.cream)
    for (let j = 0; j < 12; j++) { const b = j / 12 * Math.PI * 2 - Math.PI / 2; p(K.seed, Math.round(CX + Math.cos(b) * 7.6), Math.round(CY + Math.sin(b) * 7.9), 1, 1) }
    if (f.blush !== false && !gl) { p(K.pink, CX - 8, CY + 2, 2, 2); p(K.pink, CX + 7, CY + 2, 2, 2) }
    if (lap > 0) faceUplight(loff)
    eyes(f.eyes || 'open', CY - 1)
    if (gl > 0) glasses(gl)
    if (!lap) mouth(f.mouth || 'smile', CY + 3)
    if (lap > 0) { deck(loff); lid(loff); rightHand(f, loff) } }

  const D = { eyes: 'open', mouth: 'smile', blush: true }
  function Mk (o) { const r = {}; for (const k in D) r[k] = D[k]; for (const q in o) r[q] = o[q]; return r }
  const STATES = {
    idle: { label: '待机', fps: 7, frames: [Mk({ dy: 0 }), Mk({ dy: -1, sqy: 1.01 }), Mk({ dy: -2, sqy: 1.03, alY: -1, arY: -1 }), Mk({ dy: -2, sqy: 1.03, alY: -1, arY: -1 }), Mk({ dy: -1 }), Mk({ dy: 0, sqy: 0.98 }), Mk({ dy: 0, eyes: 'blink' }), Mk({ dy: 0 })] },
    working: { label: '工作中', fps: 8, loopFrom: 4, frames: [Mk({ eyes: 'happy', mouth: 'smile', arY: -4, alY: -4 }), Mk({ eyes: 'open', mouth: 'flat', glasses: 0.5, arY: -6, alY: -3 }), Mk({ eyes: 'focus', mouth: 'flat', glasses: 1, laptop: 0.45, blush: false }), Mk({ eyes: 'focus', mouth: 'flat', glasses: 1, laptop: 1, blush: false, type: 0 }), Mk({ eyes: 'focus', mouth: 'flat', glasses: 1, laptop: 1, blush: false, type: 0 }), Mk({ dy: -1, eyes: 'focus', mouth: 'flat', glasses: 1, laptop: 1, blush: false, type: 1 }), Mk({ eyes: 'focus2', mouth: 'flat', glasses: 1, laptop: 1, blush: false, type: 0 }), Mk({ dy: -1, eyes: 'focus', mouth: 'flat', glasses: 1, laptop: 1, blush: false, type: 1 })] },
    done: { label: '完成', fps: 10, confetti: true, check: true, revert: 'idle', ms: 2100, frames: [Mk({ dy: 3, sqx: 1.14, sqy: 0.83, eyes: 'happy', mouth: 'open' }), Mk({ dy: -6, sqx: 0.94, sqy: 1.1, alY: -6, arY: -6, eyes: 'happy', mouth: 'open' }), Mk({ dy: -16, sqx: 0.9, sqy: 1.14, alY: -8, arY: -8, llY: 3, lrY: 3, eyes: 'happy', mouth: 'open' }), Mk({ dy: -20, sqx: 0.92, sqy: 1.12, alY: -9, arY: -9, llY: 4, lrY: 4, eyes: 'happy', mouth: 'open' }), Mk({ dy: -11, sqx: 0.95, sqy: 1.07, alY: -7, arY: -7, llY: 2, lrY: 2, eyes: 'happy', mouth: 'open' }), Mk({ dy: 3, sqx: 1.16, sqy: 0.8, alY: -2, arY: -2, eyes: 'happy', mouth: 'open' }), Mk({ dy: 0, sqx: 1.02, sqy: 0.98, alY: -5, arY: -5, eyes: 'happy', mouth: 'open' }), Mk({ dy: -3, sqx: 0.98, sqy: 1.03, alY: -7, arY: -7, eyes: 'happy', mouth: 'open' }), Mk({ dy: 0, alY: -5, arY: -5, eyes: 'happy', mouth: 'open' }), Mk({ dy: 0, alY: -3, arY: -3, eyes: 'happy', mouth: 'open' })] },
    sleep: { label: '休眠', fps: 4, zzz: true, frames: [Mk({ dy: 0, sqy: 0.98, eyes: 'closed', mouth: 'sleep', alY: 1, arY: 1 }), Mk({ dy: -1, sqy: 1.02, eyes: 'closed', mouth: 'sleep', alY: 1, arY: 1 }), Mk({ dy: -1, sqy: 1.03, eyes: 'closed', mouth: 'sleep', alY: 1, arY: 1 }), Mk({ dy: 0, sqy: 0.99, eyes: 'closed', mouth: 'sleep', alY: 1, arY: 1 })] },
    waiting: { label: '等待确认', fps: 6, ask: true, frames: [Mk({ dy: 0, eyes: 'look', mouth: 'flat', lrY: 3, alY: -1 }), Mk({ dy: 0, eyes: 'look', mouth: 'flat' }), Mk({ dy: 0, eyes: 'look2', mouth: 'flat', lrY: 3 }), Mk({ dy: 0, eyes: 'look2', mouth: 'flat' }), Mk({ dy: -1, eyes: 'blink', mouth: 'flat' }), Mk({ dy: 0, eyes: 'look', mouth: 'flat' })] },
    error: { label: '受阻', fps: 10, ex: true, tint: '#f2668b', frames: [Mk({ dy: 0, tilt: -0.09, eyes: 'dizzy', mouth: 'wavy', blush: false, alY: -3, arY: 1 }), Mk({ dy: 1, tilt: 0.06, eyes: 'dizzy', mouth: 'wavy', blush: false, alY: 1, arY: -3 }), Mk({ dy: 0, tilt: 0.09, eyes: 'dizzy', mouth: 'wavy', blush: false, alY: -3, arY: 1 }), Mk({ dy: 1, tilt: -0.06, eyes: 'dizzy', mouth: 'wavy', blush: false, alY: 1, arY: -3 })] },
    hello: { label: '打招呼', fps: 9, revert: 'idle', ms: 1700, frames: [Mk({ dy: 3, sqx: 1.1, sqy: 0.88, eyes: 'happy', mouth: 'smile' }), Mk({ dy: -8, sqx: 0.95, sqy: 1.08, arY: -8, arX: 2, eyes: 'happy' }), Mk({ dy: -10, arY: -9, arX: 3, eyes: 'happy' }), Mk({ dy: -5, arY: -8, arX: 1, eyes: 'happy' }), Mk({ dy: 0, sqx: 1.08, sqy: 0.92, arY: -7, arX: 3, eyes: 'happy' }), Mk({ dy: 0, arY: -8, arX: -2, eyes: 'happy', mouth: 'open' }), Mk({ dy: 0, arY: -7, arX: 3, eyes: 'happy', mouth: 'open' }), Mk({ dy: 0, arY: -8, arX: -2, eyes: 'happy', mouth: 'open' })] }
  }

  let parts = []
  function confetti (cx, cy) { const cols = ['#a3e635', '#f2c94c', '#f79fbb', '#84cc16', '#eef9d8']; for (let i = 0; i < 26; i++)parts.push({ t: 'conf', x: cx + (Math.random() * 80 - 40), y: cy - 30, vx: Math.random() * 3 - 1.5, vy: -Math.random() * 4 - 2, g: 0.16, life: 1, rot: Math.random() * 6, vr: Math.random() * 0.4 - 0.2, c: cols[i % cols.length], ss: 3 + Math.random() * 3 }) }
  function zz (cx, cy) { parts.push({ t: 'z', x: cx + 10, y: cy - 30, vy: -0.35, vx: 0.18, life: 1, ss: 6 }) }
  function drawZ (x, y, ss, a) { ctx.globalAlpha = a; ctx.fillStyle = '#cfe8a0'; ctx.fillRect(x, y, ss, 1); ctx.fillRect(x, y + ss - 1, ss, 1); for (let i = 0; i < ss; i++)ctx.fillRect(x + ss - 1 - i, y + 1 + Math.floor(i * (ss - 2) / ss), 1, 1); ctx.globalAlpha = 1 }
  function updateParts (dt) { for (let i = 0; i < parts.length; i++) { const q = parts[i]; q.x += (q.vx || 0) * dt * 60; q.y += (q.vy || 0) * dt * 60; if (q.g) q.vy += q.g * dt * 60; q.life -= dt * (q.t === 'conf' ? 0.5 : 0.85); if (q.rot != null) q.rot += q.vr } parts = parts.filter(function (q) { return q.life > 0 })
    for (let k = 0; k < parts.length; k++) { const w = parts[k]; const a = Math.max(0, Math.min(1, w.life)); if (w.t === 'conf') { ctx.save(); ctx.translate(w.x, w.y); ctx.rotate(w.rot); ctx.globalAlpha = a; ctx.fillStyle = w.c; ctx.fillRect(-w.ss / 2, -w.ss / 2, w.ss, w.ss); ctx.restore() } else if (w.t === 'z') { drawZ(w.x, w.y, w.ss, a) } } }
  const FF = 'monospace'
  function mark (cx, cy, ch, col) { ctx.fillStyle = '#fbf7ec'; ctx.strokeStyle = col; ctx.lineWidth = 2; const w = 22; const h = 18; const x = cx - w / 2; const y = cy - 42; ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); ctx.fillStyle = col; ctx.font = 'bold 13px ' + FF; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(ch, cx, y + h / 2) }

  let cur = 'idle'; let stateStart = nowms(); let revertT = null; let zT = 0; let checkPop = 0
  function nowms () { return window.performance && performance.now ? performance.now() : Date.now() }
  function setState (k) {
    if (!STATES[k]) k = 'idle'
    cur = k; stateStart = nowms(); checkPop = STATES[k].check ? 1.3 : 0
    if (STATES[k].confetti && !reduce) confetti(150, 150)
    clearTimeout(revertT); if (STATES[k].revert) revertT = setTimeout(function () { applyExternal() }, STATES[k].ms)
  }
  // the desired state comes from the parent; done/hello are one-shots that then
  // fall back to whatever the parent currently wants
  function applyExternal () {
    const want = props.state
    // one-shots already playing shouldn't be interrupted by an equal request
    if ((want === 'done' || want === 'hello') && cur === want) return
    setState(want)
  }
  externalApply = applyExternal
  clearRevert = () => clearTimeout(revertT) // reads the latest revertT at call time

  let last = nowms()
  function frame () {
    if (stopped) { raf = 0; return }
    const now = nowms()
    const dt = Math.min(0.05, (now - last) / 1000); last = now
    const S = STATES[cur] || STATES.idle; const t = (now - stateStart) / 1000
    ctx.clearRect(0, 0, DISP, DISP)
    ctx.save(); ctx.scale(SCALE, SCALE) // render the 300px-space art at DISP
    const cx = 150; const cyBase = 150; const size = 210
    const raw = Math.floor(t * S.fps); const n = S.frames.length; let fi
    if (reduce) fi = Math.min(S.loopFrom != null ? S.loopFrom : 0, n - 1)
    else if (S.loopFrom != null) fi = (raw < n) ? raw : (S.loopFrom + (raw - n) % (n - S.loopFrom))
    else fi = raw % n
    const f = S.frames[fi]; sprite(f)
    const dyPx = (reduce ? 0 : (f.dy || 0)) * 3
    if (f.laptop) { const pa = (f.type ? 0.24 : 0.19); const gx = cx - 16; const gy = cyBase + dyPx + 30; const gg = ctx.createRadialGradient(gx, gy, 6, gx, gy, 120); gg.addColorStop(0, 'rgba(150,246,168,' + pa + ')'); gg.addColorStop(0.5, 'rgba(120,220,150,' + (pa * 0.5) + ')'); gg.addColorStop(1, 'rgba(120,220,150,0)'); ctx.fillStyle = gg; ctx.fillRect(0, 0, 300, 300) }
    ctx.save(); ctx.translate(cx, cyBase + dyPx); ctx.rotate(reduce ? 0 : (f.tilt || 0)); ctx.scale(f.sqx || 1, f.sqy || 1); ctx.imageSmoothingEnabled = false; ctx.drawImage(sc, -size / 2, -size / 2, size, size); ctx.restore()
    if (S.tint) { ctx.globalAlpha = 0.13; ctx.fillStyle = S.tint; ctx.beginPath(); ctx.arc(cx, cyBase, 90, 0, 7); ctx.fill(); ctx.globalAlpha = 1 }
    if (!reduce) {
      if (S.zzz) { zT -= dt; if (zT <= 0) { zz(cx, cyBase + dyPx); zT = 1.1 } }
      if (S.ask) mark(cx + 58, cyBase + dyPx * 0.5, '?', '#a3e635')
      if (S.tint) mark(cx + 58, cyBase + dyPx * 0.5, '!', '#f2668b')
      if (S.check && checkPop > 0) { checkPop -= dt * 0.55; ctx.globalAlpha = Math.min(1, checkPop * 1.6); ctx.fillStyle = '#f2c94c'; ctx.font = 'bold 30px ' + FF; ctx.textAlign = 'center'; ctx.fillText('✓', cx, cyBase - 104 + dyPx * 0.3); ctx.globalAlpha = 1 }
    }
    updateParts(dt)
    ctx.restore()
    raf = requestAnimationFrame(frame)
  }
  const kick = () => { if (!raf && !stopped) { last = nowms(); raf = requestAnimationFrame(frame) } }
  // pause when the window is hidden (saves CPU; rAF wouldn't fire anyway)
  const onVis = () => { if (document.hidden) { stopped = true; if (raf) { cancelAnimationFrame(raf); raf = 0 } } else { stopped = false; kick() } }
  document.addEventListener('visibilitychange', onVis)
  visCleanup = () => document.removeEventListener('visibilitychange', onVis)

  setState(props.state || 'idle')
  frame() // first frame synchronously
})

let externalApply = null
let visCleanup = null
let clearRevert = null
watch(() => props.state, () => { if (externalApply) externalApply() })

onBeforeUnmount(() => { stopped = true; if (raf) cancelAnimationFrame(raf); if (clearRevert) clearRevert(); if (visCleanup) visCleanup() })
</script>

<template>
  <div class="knote-mascot">
    <!-- speech bubble: what the assistant is busy with -->
    <div v-if="bubbleShown" class="knote-mascot-bubble" @mousedown.stop>
      <span class="km-x" :title="t('mascot_close_once')" @click.stop="closeOnce">✕</span>
      <div class="km-msg">{{ message }}<span class="km-dots"></span></div>
      <div class="km-mute" @click.stop="closePerm">{{ t('mascot_mute') }}</div>
      <div class="km-tail"></div>
    </div>
    <div v-else-if="pillShown" class="knote-mascot-pill" @mousedown.stop @click.stop="reopen">
      <b></b> {{ t('mascot_busy') }}
    </div>
    <canvas ref="cv" class="knote-mascot-canvas" :title="t('agent')" @mousedown="grab && grab($event)"></canvas>
  </div>
</template>

<style scoped>
.knote-mascot { position: relative; display: flex; flex-direction: column; align-items: center; }
.knote-mascot-canvas {
  cursor: grab;
  image-rendering: pixelated;
  filter: drop-shadow(0 3px 5px rgba(0, 0, 0, 0.28));
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.knote-mascot-canvas:active { cursor: grabbing; }
/* speech bubble — pinned above the kiwi */
.knote-mascot-bubble {
  position: absolute;
  left: 50%;
  bottom: calc(100% - 6px);
  transform: translateX(-50%);
  width: max-content;
  max-width: 15rem;
  background: #fbf7ec;
  border: 2px solid #3f342a;
  border-radius: 13px;
  color: #3f342a;
  box-shadow: 3px 4px 0 rgba(0, 0, 0, 0.32);
  padding: 9px 26px 9px 12px;
  z-index: 5;
  -webkit-app-region: no-drag;
  app-region: no-drag;
  animation: km-pop 0.16s ease-out;
}
@keyframes km-pop { from { opacity: 0; transform: translateX(-50%) translateY(4px); } }
.knote-mascot-bubble .km-msg { font-size: 12.5px; line-height: 1.35; font-weight: 500; }
.knote-mascot-bubble .km-dots::after { content: ''; animation: km-dots 1.4s steps(4, end) infinite; }
@keyframes km-dots { 0% { content: ''; } 25% { content: '·'; } 50% { content: '··'; } 75% { content: '···'; } }
.knote-mascot-bubble .km-x { position: absolute; top: 4px; right: 6px; width: 16px; height: 16px; display: grid; place-items: center; border-radius: 5px; color: #a89878; cursor: pointer; font-size: 11px; line-height: 1; }
.knote-mascot-bubble .km-x:hover { background: #efe3cd; color: #7a3b3b; }
.knote-mascot-bubble .km-mute { font-size: 10px; color: #a89878; margin-top: 4px; cursor: pointer; }
.knote-mascot-bubble .km-mute:hover { color: #3f342a; text-decoration: underline; }
.knote-mascot-bubble .km-tail { position: absolute; left: 50%; bottom: -9px; transform: translateX(-50%); width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-top: 9px solid #fbf7ec; filter: drop-shadow(0 2px 0 #3f342a); }
.knote-mascot-pill {
  position: absolute;
  left: 50%;
  bottom: calc(100% - 4px);
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  background: #fbf7ec;
  border: 2px solid #3f342a;
  border-radius: 11px;
  padding: 3px 10px;
  cursor: pointer;
  box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.3);
  font-size: 10px;
  color: #5a4a2c;
  z-index: 5;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.knote-mascot-pill b { width: 6px; height: 6px; border-radius: 50%; background: #84cc16; }
</style>
