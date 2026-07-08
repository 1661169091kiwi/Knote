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

// Render one diagram source to an SVG string. Never throws — returns an
// { ok, svg | error } result so callers can show a graceful fallback.
export const renderMermaid = async (code, dark = false) => {
  try {
    const mermaid = await load(dark)
    const id = 'knote-mmd-' + (++seq)
    const { svg } = await mermaid.render(id, code)
    return { ok: true, svg }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// Scan a rendered container for mermaid code blocks (produced by the
// markdown-it highlight rule as <pre><code class="language-mermaid"
// data-code="<uri-encoded source>">) and replace each with its diagram.
export const renderMermaidIn = async (root, dark = false) => {
  if (!root) return
  const blocks = root.querySelectorAll('code.language-mermaid[data-code]:not([data-mmd-done])')
  for (const codeEl of blocks) {
    const pre = codeEl.closest('pre') || codeEl
    let src = ''
    try { src = decodeURIComponent(codeEl.getAttribute('data-code') || '') } catch { src = codeEl.textContent || '' }
    codeEl.setAttribute('data-mmd-done', '1')
    const res = await renderMermaid(src, dark)
    const wrap = document.createElement('div')
    wrap.className = 'knote-mermaid'
    if (res.ok) {
      wrap.innerHTML = res.svg
    } else {
      wrap.className = 'knote-mermaid knote-mermaid-error'
      wrap.textContent = res.error
    }
    if (pre.parentNode) pre.parentNode.replaceChild(wrap, pre)
  }
}
