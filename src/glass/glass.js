// Glass theme: liquid glass engine and small helpers. Drop-in, no dependencies, no build step.
// Source: Research Index's glass.js (D:\D-projects\Idea_of_papers\portal\src\glass.js), after FlClash's
// prism_ui liquid glass. Pair it with glass.css.
//
//   <nav class="gl-dock" data-glass="dock">…</nav>      kinds: dock | pill | round | panel | banner | menu
//   <script src="glass.js" defer></script>
//
// What it does
//   - Bends the backdrop of every [data-glass] pane: a light frost, the backdrop pulled inward across a bevel at
//     the rim (circular profile, so the outer band shows what lies further in, squeezed), then saturated. This
//     is an SVG filter used as the pane's backdrop-filter, one per pane size. Chromium only (Chrome, Edge,
//     Electron, Android WebView). Elsewhere, and under reduced transparency or on low-end devices, the plain
//     blur from glass.css stays.
//   - Pressing a pane sets .is-pressed, --gx/--gy (where) and --swell (how far it may grow) for glass.css.
//   - Keeps .gl-tab-ink under the chosen tab of every [data-gl-tabs] row, springing and stretching on change.
//     The chosen tab is the child with .is-on or aria-selected="true", so any framework can drive it.
//   - Marks a scrolling element .is-scrolling for 1.2 s (glass.css shows thin scrollbars only then).
//   - Fires `glass:scheme` on document ({ detail: { dark } }) when light/dark changes, for window chrome.
//
// API: window.LiquidGlass = { enabled(), dark(), refresh(), plain(on?), mode() }
//   mode() says what panes show right now: 'bend' | 'frost' | 'solid'
//   enabled: override to gate the bending, e.g. LiquidGlass.enabled = () => root.classList.contains('gl')
//   plain(true|false) toggles html.gl-plain (solid panes) and remembers it in localStorage 'gl-plain'.
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.LiquidGlass) return;
  const root = document.documentElement;
  const darkMQ = matchMedia('(prefers-color-scheme: dark)');
  const plainMQ = matchMedia('(prefers-reduced-transparency: reduce)');
  const forcedMQ = matchMedia('(forced-colors: active)');

  // the app's two presets, light | dark: `regular` for bars and buttons, `menu` for what holds rows of text
  const STYLE = {
    regular: [{ blur: 2.5, refraction: 60, bevel: 20, saturation: 2.08, brightness: 1 }, { blur: 2.5, refraction: 60, bevel: 20, saturation: 2.84, brightness: 1 }],
    menu: [{ blur: 8, refraction: 70, bevel: 22, saturation: 2.3, brightness: 1.05 }, { blur: 8, refraction: 70, bevel: 22, saturation: 1.9, brightness: 1.2 }],
  };
  const KIND = { dock: 'regular', pill: 'regular', round: 'regular', panel: 'regular', banner: 'regular', menu: 'menu' };
  const NS = 'http://www.w3.org/2000/svg';

  const api = {
    enabled: () => true,
    dark: () => root.dataset.theme === 'dark' || (root.dataset.theme !== 'light' && darkMQ.matches),
    refresh: () => { panes.forEach(later); tabRows.forEach(placeInk); },
    plain(on) {
      root.classList.toggle('gl-plain', !!on);
      try { localStorage.setItem('gl-plain', on ? '1' : '0'); } catch { /* storage blocked */ }
      api.refresh();
    },
    // what panes are showing: 'bend' (SVG liquid glass), 'frost' (the CSS blur) or 'solid' (a fallback)
    mode() {
      const noBackdrop = !CSS.supports('backdrop-filter', 'blur(1px)') && !CSS.supports('-webkit-backdrop-filter', 'blur(1px)');
      if (noBackdrop || root.classList.contains('gl-plain') || plainMQ.matches || forcedMQ.matches) return 'solid';
      return canBend() ? 'bend' : 'frost';
    },
  };
  window.LiquidGlass = api;
  try { if (localStorage.getItem('gl-plain') === '1') root.classList.add('gl-plain'); } catch { /* storage blocked */ }

  // WebKit (Safari, iOS) takes backdrop-filter but not url(#filter) inside it, so the bend is Chromium only;
  // elsewhere the pane would lose its blur too
  const chromium = /Chrome\/|Chromium|Electron/.test(navigator.userAgent);
  const lowEnd = () => (navigator.deviceMemory && navigator.deviceMemory < 3) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4);
  const canBend = () => api.enabled() && chromium && CSS.supports('backdrop-filter', 'blur(1px)')
    && !plainMQ.matches && !forcedMQ.matches && !root.classList.contains('gl-plain') && !lowEnd();

  // ---------- the bending ----------
  const filters = new Map(); // key -> filter id
  let defs = null, seq = 0;
  function sprite() {
    if (defs) return defs;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;pointer-events:none';
    defs = document.createElementNS(NS, 'defs');
    svg.appendChild(defs);
    document.body.appendChild(svg);
    return defs;
  }
  // Where each point reads the backdrop from: inside a band `bevel` wide along the rim, inward along the rim's
  // normal by depth·(1 − √(1 − rise²)) (rise 0 at the band's inner edge, 1 at the rim). R and G carry x and y,
  // 0.5 being no shift.
  function displacementMap(w, h, r, bevel, depth, scale) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    const d = img.data;
    const hx = w / 2, hy = h / 2, rr = Math.min(r, hx, hy);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + 0.5 - hx, py = y + 0.5 - hy;
        const qx = Math.abs(px) - (hx - rr), qy = Math.abs(py) - (hy - rr);
        let inset, nx, ny;
        if (qx > 0 && qy > 0) {
          const len = Math.hypot(qx, qy) || 1;
          inset = rr - len;
          nx = (qx / len) * Math.sign(px); ny = (qy / len) * Math.sign(py);
        } else if (qx > qy) { inset = rr - qx; nx = Math.sign(px); ny = 0; }
        else { inset = rr - qy; nx = 0; ny = Math.sign(py); }
        const rise = 1 - Math.min(Math.max(inset / bevel, 0), 1);
        const shift = rise > 0 ? depth * (1 - Math.sqrt(Math.max(0, 1 - rise * rise))) : 0;
        const i = (y * w + x) * 4;
        d[i] = Math.round(255 * Math.min(1, Math.max(0, 0.5 - (nx * shift) / scale)));
        d[i + 1] = Math.round(255 * Math.min(1, Math.max(0, 0.5 - (ny * shift) / scale)));
        d[i + 2] = 128;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }
  function saturate(s, b) {
    const L = [0.2126, 0.7152, 0.0722];
    const row = (k) => [0, 1, 2].map((j) => (b * ((j === k ? 1 : 0) * s + L[j] * (1 - s))).toFixed(4)).join(' ');
    return `${row(0)} 0 0 ${row(1)} 0 0 ${row(2)} 0 0 0 0 0 1 0`;
  }
  function filterFor(w, h, r, kind) {
    const dark = api.dark() ? 1 : 0;
    const key = `${kind}|${w}x${h}|${r}|${dark}`;
    if (filters.has(key)) return filters.get(key);
    const P = STYLE[kind][dark];
    const half = Math.min(w, h) / 2;
    const depth = Math.min(P.refraction, half);
    const bevel = Math.max(1, Math.min(P.bevel, half * 0.5));
    const scale = 2 * depth + 2;
    const id = `gl-lg${++seq}`;
    const f = document.createElementNS(NS, 'filter');
    f.setAttribute('id', id);
    f.setAttribute('x', '0'); f.setAttribute('y', '0');
    f.setAttribute('width', String(w)); f.setAttribute('height', String(h));
    f.setAttribute('filterUnits', 'userSpaceOnUse');
    f.setAttribute('primitiveUnits', 'userSpaceOnUse');
    f.setAttribute('color-interpolation-filters', 'sRGB'); // or the map is read in linear RGB and every shift is off
    f.innerHTML = `<feGaussianBlur in="SourceGraphic" stdDeviation="${P.blur}" edgeMode="duplicate" result="frost"/>`
      + `<feImage href="${displacementMap(w, h, r, bevel, depth, scale)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>`
      + `<feDisplacementMap in="frost" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="bent"/>`
      + `<feColorMatrix in="bent" type="matrix" values="${saturate(P.saturation, P.brightness)}"/>`;
    sprite().appendChild(f);
    filters.set(key, id);
    // a long session that resizes a lot: forget the oldest
    if (filters.size > 80) { const [k, old] = filters.entries().next().value; filters.delete(k); document.getElementById(old)?.remove(); }
    return id;
  }

  const panes = new Set();
  // Knote addition: a big pane (the assistant's window) that is being resized or animating its width
  // shows the CSS frost meanwhile and bends again once its size holds still, instead of building a new
  // full-size displacement map every frame.
  const BIG_PANE = 120000, SETTLE_MS = 180;
  function paint(el, settled) {
    if (!el.isConnected) { panes.delete(el); ro.unobserve(el); return; }
    if (!canBend()) { el.style.backdropFilter = ''; el.style.webkitBackdropFilter = ''; return; }
    const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
    if (w < 8 || h < 8) return; // hidden: keep what it had
    const size = `${w}x${h}`;
    if (!settled && w * h > BIG_PANE && el._glSize && el._glSize !== size) {
      el._glSize = size;
      el.style.backdropFilter = ''; el.style.webkitBackdropFilter = '';
      clearTimeout(el._glSettle);
      el._glSettle = setTimeout(() => paint(el, true), SETTLE_MS);
      return;
    }
    clearTimeout(el._glSettle);
    el._glSize = size;
    const r = Math.round(Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, Math.min(w, h) / 2));
    const v = `url(#${filterFor(w, h, r, KIND[el.dataset.glass] || 'regular')})`;
    el.style.backdropFilter = v;
    el.style.webkitBackdropFilter = v;
  }
  let queued = new Set(), frame = 0;
  function later(el) {
    queued.add(el);
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; const q = queued; queued = new Set(); q.forEach((el) => paint(el)); });
  }
  const ro = new ResizeObserver((entries) => entries.forEach((e) => {
    if (e.target.matches('[data-glass]')) later(e.target);
    if (e.target.matches('[data-gl-tabs]')) placeInk(e.target, true);
  }));
  function watch(el) {
    if (panes.has(el)) return;
    panes.add(el);
    ro.observe(el, { box: 'border-box' });
    later(el);
  }

  // ---------- tabs: a primary pill that springs to the chosen tab and stretches on the way ----------
  const tabRows = new Set();
  const chosen = (row) => row.querySelector(':scope > .is-on, :scope > [aria-selected="true"]');
  function placeInk(row, instant) {
    if (!row.isConnected) { tabRows.delete(row); return; }
    let ink = row.querySelector(':scope > .gl-tab-ink');
    if (!ink) { ink = document.createElement('span'); ink.className = 'gl-tab-ink'; ink.setAttribute('aria-hidden', 'true'); row.prepend(ink); }
    if (!row.classList.contains('gl-js-ink')) row.classList.add('gl-js-ink');
    const tab = chosen(row);
    if (!tab || !tab.offsetWidth) { ink.style.opacity = '0'; return; }
    const to = { x: tab.offsetLeft, y: tab.offsetTop, w: tab.offsetWidth, h: tab.offsetHeight };
    const from = ink._at;
    ink._at = to;
    const set = (p) => { ink.style.setProperty('--x', `${p.x}px`); ink.style.setProperty('--y', `${p.y}px`); ink.style.setProperty('--w', `${p.w}px`); ink.style.setProperty('--h', `${p.h}px`); };
    if (instant || !from || ink.style.opacity === '0') {
      ink.style.transition = 'none'; set(to); void ink.offsetWidth; ink.style.transition = ''; ink.style.opacity = '';
      return;
    }
    if (from.x === to.x && from.w === to.w) return;
    set(to);
    ink.classList.remove('is-moving'); void ink.offsetWidth; ink.classList.add('is-moving');   // restart the jelly
    clearTimeout(ink._t); ink._t = setTimeout(() => ink.classList.remove('is-moving'), 560);
  }
  function watchTabs(row) {
    if (tabRows.has(row)) return;
    tabRows.add(row);
    ro.observe(row);
    placeInk(row, true);
    // whoever owns the state (plain JS, React, Vue) only has to move .is-on / aria-selected. Changes this file
    // makes itself (the row's marker class, the ink's jelly) are ignored, or the observer would feed itself.
    new MutationObserver((recs) => {
      if (recs.some((r) => r.type === 'childList' || (r.target !== row && !r.target.classList?.contains('gl-tab-ink')))) placeInk(row);
    }).observe(row, { subtree: true, attributes: true, attributeFilter: ['class', 'aria-selected'], childList: true });
  }
  // plain pages: a click on a tab chooses it unless the row says it is managed elsewhere (data-gl-tabs="managed")
  document.addEventListener('click', (e) => {
    const tab = e.target.closest?.('[data-gl-tabs] > button, [data-gl-tabs] > a');
    if (!tab) return;
    const row = tab.parentElement;
    if (row.dataset.glTabs === 'managed') return;
    for (const t of row.children) {
      if (t.classList.contains('gl-tab-ink')) continue;
      t.classList.toggle('is-on', t === tab);
      if (t.hasAttribute('aria-selected')) t.setAttribute('aria-selected', String(t === tab));
    }
  });

  // ---------- discovery ----------
  function scan(node = document) {
    if (node.nodeType === 1 && node.matches('[data-glass]')) watch(node);
    if (node.nodeType === 1 && node.matches('[data-gl-tabs]')) watchTabs(node);
    node.querySelectorAll?.('[data-glass]').forEach(watch);
    node.querySelectorAll?.('[data-gl-tabs]').forEach(watchTabs);
  }
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
  }).observe(root, { childList: true, subtree: true });

  // ---------- scheme: system changes, or <html data-theme> / .gl-plain switched by the app ----------
  let lastDark = null, lastLook = '';
  function schemeChanged() {
    // <html>'s class changes for many reasons (.is-scrolling on every scroll): act only on what matters here
    const dark = api.dark(), look = `${dark}|${root.classList.contains('gl-plain')}|${root.classList.contains('gl')}`;
    if (look === lastLook) return;
    lastLook = look;
    api.refresh();
    if (dark !== lastDark) { lastDark = dark; document.dispatchEvent(new CustomEvent('glass:scheme', { detail: { dark } })); }
  }
  darkMQ.addEventListener?.('change', schemeChanged);
  plainMQ.addEventListener?.('change', api.refresh);
  new MutationObserver(schemeChanged).observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] });

  // ---------- pressing glass: it swells under the finger and lights from where it was touched ----------
  let pressed = null;
  const release = () => { if (pressed) { pressed.classList.remove('is-pressed'); pressed = null; } };
  document.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const el = e.target.closest?.('[data-glass]');
    if (!el || el.dataset.glass === 'menu' || el.dataset.glass === 'panel') return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--gx', `${e.clientX - r.left}px`);
    el.style.setProperty('--gy', `${e.clientY - r.top}px`);
    el.style.setProperty('--swell', String(1 + Math.min(0.25, 16 / Math.max(r.width, r.height, 1))));
    release();
    pressed = el;
    el.classList.add('is-pressed');
  }, { passive: true });
  ['pointerup', 'pointercancel', 'blur'].forEach((t) => window.addEventListener(t, release, { passive: true }));

  // ---------- scrollbars show while something scrolls, and for a moment after ----------
  document.addEventListener('scroll', (e) => {
    release();
    // Knote addition: only while the glass theme is on (its scrollbar rules are html.gl-only), and never
    // inside the editable document: a class written into ProseMirror's DOM reads as an edit there, so the
    // node is redrawn (a scrolled code-block language menu closed under the pointer).
    if (!root.classList.contains('gl')) return;
    const el = e.target === document ? document.scrollingElement : e.target;
    if (!(el instanceof Element)) return;
    if (el.closest('.ProseMirror, [contenteditable="true"]')) return;
    el.classList.add('is-scrolling');
    clearTimeout(el._glScroll);
    el._glScroll = setTimeout(() => el.classList.remove('is-scrolling'), 1200);
  }, { passive: true, capture: true });

  function start() {
    root.classList.add('gl-js');
    scan();
    schemeChanged();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.addEventListener('load', api.refresh);
  document.fonts?.ready?.then(api.refresh);
})();
