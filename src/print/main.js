// Runs only in the disposable, isolated print renderer. No full-document
// parsing, highlighting, sanitation or layout occurs in the editor renderer.
import MarkdownIt from 'markdown-it'
import { full as emoji } from 'markdown-it-emoji'
import taskLists from 'markdown-it-task-lists'
import footnote from 'markdown-it-footnote'
import sub from 'markdown-it-sub'
import sup from 'markdown-it-sup'
import abbr from 'markdown-it-abbr'
import deflist from 'markdown-it-deflist'
import ins from 'markdown-it-ins'
import mark from 'markdown-it-mark'
import markdownItCjkFriendly from 'markdown-it-cjk-friendly'
import * as mdKatex from '@vscode/markdown-it-katex'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js'
import 'katex/dist/katex.min.css'
import { toInternal } from '../lib/emptyRows.js'
import { collectImageResourcePaths, rewriteImageResourcePaths } from '../lib/imagePathMapping.js'
import { installKnoteMarkdownImagePolicy } from '../lib/markdownImagePolicy.js'
import { installKnoteMarkdownWikilinks } from '../lib/markdownWikilinks.js'
import { installKnoteMarkdownLinkifyCjk } from '../lib/markdownLinkifyCjk.js'
import { installKnoteMarkdownTableBoundary } from '../lib/markdownTableBoundary.js'
import { installKnoteMarkdownFrontmatter } from '../lib/markdownFrontmatter.js'
import { renderMermaidIn } from '../lib/mermaidRender.js'
import { documentPrintCss } from '../lib/documentPrint.js'

const bridge = window.knotePrint
const progress = (stage, percent, completed = 0, total = 0) => bridge.progress({ stage, percent, completed, total })
const yieldTurn = () => new Promise(resolve => setTimeout(resolve, 0))

const md = new MarkdownIt({ html: true, breaks: true, linkify: true, typographer: false,
  highlight: (code, language) => {
    const escaped = md.utils.escapeHtml(code)
    if (language === 'mermaid') return `<pre><code class="language-mermaid" data-code="${encodeURIComponent(code)}">${escaped}</code></pre>`
    const body = language && hljs.getLanguage(language) ? hljs.highlight(code, { language }).value : escaped
    return `<pre class="hljs"><code>${body}</code></pre>`
  }
}).use(markdownItCjkFriendly).use(emoji).use(taskLists, { enabled: true, label: true })
  .use(footnote).use(sub).use(sup).use(abbr).use(deflist).use(ins).use(mark)
  .use(mdKatex.default || mdKatex, { throwOnError: false })
installKnoteMarkdownImagePolicy(md)
installKnoteMarkdownWikilinks(md)
installKnoteMarkdownLinkifyCjk(md)
installKnoteMarkdownTableBoundary(md)
installKnoteMarkdownFrontmatter(md)
md.linkify?.set({ fuzzyLink: false })
md.core.ruler.after('block', 'knote_callouts', (state) => {
  for (let i = 0; i < state.tokens.length - 2; i++) {
    const tokens = state.tokens, inline = tokens[i + 2]
    if (tokens[i].type !== 'blockquote_open' || tokens[i + 1].type !== 'paragraph_open' || inline.type !== 'inline') continue
    const match = /^\[!(\w+)\]\s*(.*)$/s.exec(inline.content)
    if (!match) continue
    const kind = /^(note|info|tip|success|warning|danger|question|quote)$/.test(match[1].toLowerCase()) ? match[1].toLowerCase() : 'note'
    tokens[i].attrJoin('class', `knote-callout knote-callout-${kind}`)
    tokens[i].attrSet('data-callout', kind)
    inline.content = match[2]
    if (inline.children?.[0]?.type === 'text') inline.children[0].content = inline.children[0].content.replace(/^\[!\w+\]\s*/, '')
  }
})

const run = async () => {
  const job = await bridge.getJob()
  document.documentElement.lang = job.lang || 'zh'
  document.title = job.title || 'Knote'
  const stylesReady = []
  for (const href of job.stylesheets || []) {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href
    stylesReady.push(new Promise(resolve => { link.onload = resolve; link.onerror = resolve }))
    document.head.append(link)
  }
  const style = document.createElement('style')
  style.textContent = [...(job.inlineStyles || []), documentPrintCss].join('\n')
  document.head.append(style)
  progress('images', 8)
  await yieldTurn()
  let source = String(job.source || '')
  for (const [id, url] of job.storedImages || []) source = source.split(`knote-img:${id}`).join(url)
  const mappings = [...(job.imageMappings || [])]
  const known = new Set(mappings.map(([name]) => name))
  const resources = source.includes('![') || /<img\b/i.test(source) ? collectImageResourcePaths(source).filter(resource => !known.has(resource) && !/^(data:|https?:|knote-img:|blob:|file:|#|\/)/i.test(resource)) : []
  for (let i = 0; i < resources.length; i++) {
    try { const url = await bridge.readImage(resources[i]); if (url) mappings.push([resources[i], url]) } catch { /* missing image remains visible as missing */ }
    progress('images', 8 + (i + 1) / resources.length * 10, i + 1, resources.length)
  }
  source = rewriteImageResourcePaths(source, mappings)
  progress('parsing', 20)
  await yieldTurn()
  const html = job.preview || md.render(toInternal(source))
  progress('sanitizing', 35)
  await yieldTurn()
  const root = document.querySelector('article')
  root.innerHTML = DOMPurify.sanitize(html, {
    ADD_TAGS: ['input', 'mark', 'ins', 'sub', 'sup'],
    ADD_ATTR: ['style', 'data-code', 'data-knote-emoji'],
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|file):|[a-zA-Z]:[\\/]|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  })
  const diagrams = root.querySelectorAll('code.language-mermaid').length
  if (diagrams) {
    progress('diagrams', 42, 0, diagrams)
    await yieldTurn()
    await renderMermaidIn(root, false, (completed, total) => progress('diagrams', 42 + completed / total * 14, completed, total))
  }
  progress('layout', 60)
  // Images/fonts are bounded: a slow external image must not hang an export
  // forever. Timed-out resources stay missing rather than freezing the app.
  const images = [...document.images]
  let completed = 0
  const pending = images.map(image => new Promise(resolve => {
    const done = () => { image.removeEventListener('load', done); image.removeEventListener('error', done); completed++; progress('layout', 60 + completed / Math.max(1, images.length) * 10, completed, images.length); resolve() }
    if (image.complete) done()
    else { image.addEventListener('load', done, { once: true }); image.addEventListener('error', done, { once: true }) }
  }))
  let timer
  await Promise.race([Promise.all([...pending, Promise.all(stylesReady).then(() => document.fonts.ready)]), new Promise(resolve => { timer = setTimeout(resolve, 20000) })])
  clearTimeout(timer)
  await yieldTurn()
  await bridge.ready({ ok: true })
}
run().catch(error => bridge.ready({ ok: false, error: String(error.message || error) }))
