// Lazy mermaid loader + render helpers. mermaid is ~heavy, so it's only
// imported the first time a diagram actually needs rendering (no cost for
// documents without diagrams).

let mermaidPromise = null
let curTheme = null
let seq = 0

const load = (dark) => {
  const theme = dark ? 'dark' : 'default'
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      const mermaid = m.default
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'inherit' })
      curTheme = theme
      return mermaid
    })
  } else if (theme !== curTheme) {
    mermaidPromise = mermaidPromise.then((mermaid) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'inherit' })
      curTheme = theme
      return mermaid
    })
  }
  return mermaidPromise
}

// Mermaid lays a diagram out in a temporary element and measures it. Appended
// to <body> of a long document, every measurement forced layout work for the
// whole page; an off-screen host with `contain: strict` keeps it to the
// diagram. One host per render, so concurrent renders never share (Mermaid
// clears the container it is given).
const isolatedHost = () => {
  if (typeof document === 'undefined' || !document.body) return undefined
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1600px;height:1200px;overflow:hidden;contain:strict;visibility:hidden;pointer-events:none'
  document.body.appendChild(host)
  return host
}

// Render one diagram source to an SVG string. Never throws — returns an
// { ok, svg | error } result so callers can show a graceful fallback.
export const renderMermaid = async (code, dark = false) => {
  let host
  try {
    const mermaid = await load(dark)
    const id = 'knote-mmd-' + (++seq)
    host = isolatedHost()
    const { svg } = await mermaid.render(id, code, host)
    return { ok: true, svg }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  } finally {
    host?.remove()
  }
}

// ---- Editor diagrams: one at a time, when the reader pauses ----
// Each Mermaid layout blocks the main thread (50–500ms in a long document), so
// drawing diagrams while the reader scrolls or types made both stutter. Queued
// diagrams are drawn one by one, only after the page has been free of scrolling
// and input for IDLE_MS; a job whose block is no longer wanted (scrolled away,
// edited, language changed) is dropped and queued again when it is. Results are
// cached by source and theme, so a diagram scrolled back into view (or a chunk
// mounted again) costs nothing. Exports keep calling renderMermaid directly.
const IDLE_MS = 250
const CACHE_LIMIT = 300
const cache = new Map()
const queue = []
let lastActivity = 0
let draining = false
let listening = false
const listenForActivity = () => {
  if (listening || typeof window === 'undefined') return
  listening = true
  const mark = () => { lastActivity = performance.now() }
  for (const type of ['scroll', 'wheel', 'keydown', 'pointerdown', 'touchmove']) {
    window.addEventListener(type, mark, { capture: true, passive: true })
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const cacheKey = (code, dark) => `${dark ? 1 : 0}\u0000${code}`
const remember = (key, result) => {
  cache.delete(key)
  cache.set(key, result)
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
}
const drain = async () => {
  if (draining) return
  draining = true
  try {
    while (queue.length) {
      const wait = IDLE_MS - (performance.now() - lastActivity)
      if (wait > 0) { await sleep(wait); continue }
      const job = queue.shift()
      if (!job.wanted()) { job.resolve(null); continue }
      const result = cache.get(job.key) || await renderMermaid(job.code, job.dark)
      if (result.ok) remember(job.key, result)
      job.resolve(result)
      await sleep(0)
    }
  } finally {
    draining = false
  }
}
// Resolves with { ok, svg | error }, or null when the job was dropped because
// `wanted()` turned false before its turn.
export const renderMermaidQueued = (code, dark = false, wanted = () => true) => {
  const key = cacheKey(code, dark)
  const cached = cache.get(key)
  if (cached) { remember(key, cached); return Promise.resolve(cached) }
  listenForActivity()
  return new Promise((resolve) => {
    queue.push({ code, dark, key, wanted, resolve })
    void drain()
  })
}

// The lazy form of renderMermaidIn for read-only renders that stay on screen
// (the static chunks of a stacked long document): each diagram is drawn only
// once near the viewport, through the editor's queue (one at a time while the
// reader pauses, cached). Returns a disposer.
export const renderMermaidLazilyIn = (root, dark = false) => {
  if (!root) return () => {}
  if (typeof IntersectionObserver === 'undefined') { void renderMermaidIn(root, dark); return () => {} }
  const blocks = [...root.querySelectorAll('code.language-mermaid[data-code]:not([data-mmd-done])')]
  if (!blocks.length) return () => {}
  const near = new Set()
  let disposed = false
  const draw = async (pre) => {
    const codeEl = pre.matches?.('code') ? pre : pre.querySelector('code.language-mermaid')
    if (!codeEl || codeEl.hasAttribute('data-mmd-done')) return
    let src = ''
    try { src = decodeURIComponent(codeEl.getAttribute('data-code') || '') } catch { src = codeEl.textContent || '' }
    const res = await renderMermaidQueued(src, dark, () => !disposed && near.has(pre) && pre.isConnected)
    if (!res || disposed || !pre.isConnected || codeEl.hasAttribute('data-mmd-done')) return
    codeEl.setAttribute('data-mmd-done', '1')
    const wrap = document.createElement('div')
    wrap.className = res.ok ? 'knote-mermaid' : 'knote-mermaid knote-mermaid-error'
    for (const name of ['data-sline', 'data-eline']) {
      const value = pre.getAttribute?.(name)
      if (value != null) wrap.setAttribute(name, value)
    }
    if (res.ok) wrap.innerHTML = res.svg
    else wrap.textContent = res.error
    observer.unobserve(pre)
    pre.replaceWith(wrap)
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) { near.add(entry.target); void draw(entry.target) } else near.delete(entry.target)
    }
  }, { rootMargin: '800px 0px' })
  for (const codeEl of blocks) observer.observe(codeEl.closest('pre') || codeEl)
  return () => { disposed = true; observer.disconnect() }
}

// Scan a rendered container for mermaid code blocks (produced by the
// markdown-it highlight rule as <pre><code class="language-mermaid"
// data-code="<uri-encoded source>">) and replace each with its diagram.
export const renderMermaidIn = async (root, dark = false, onProgress = null) => {
  if (!root) return
  const blocks = root.querySelectorAll('code.language-mermaid[data-code]:not([data-mmd-done])')
  let completed = 0
  for (const codeEl of blocks) {
    const pre = codeEl.closest('pre') || codeEl
    let src = ''
    try { src = decodeURIComponent(codeEl.getAttribute('data-code') || '') } catch { src = codeEl.textContent || '' }
    codeEl.setAttribute('data-mmd-done', '1')
    const res = await renderMermaid(src, dark)
    const wrap = document.createElement('div')
    wrap.className = 'knote-mermaid'
    // Preserve the source-line span the split preview tagged onto the <pre> (see
    // renderMarkdownLineMapped): the fence <pre> is replaced by this container, so
    // copy the line anchors across or this tall block loses scroll-sync alignment.
    const sline = pre.getAttribute && pre.getAttribute('data-sline')
    const eline = pre.getAttribute && pre.getAttribute('data-eline')
    if (sline != null) wrap.setAttribute('data-sline', sline)
    if (eline != null) wrap.setAttribute('data-eline', eline)
    if (res.ok) {
      wrap.innerHTML = res.svg
    } else {
      wrap.className = 'knote-mermaid knote-mermaid-error'
      wrap.textContent = res.error
    }
    if (pre.parentNode) pre.parentNode.replaceChild(wrap, pre)
    onProgress?.(++completed, blocks.length)
  }
}
