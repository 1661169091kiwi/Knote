// One-off probe: runs the ACTUAL main-process web search/fetch path inside a
// real Electron process, so we learn whether Electron's net (OS proxy) can
// reach the search engine on THIS machine — the crux of "用用户的环境".
// Usage: npx electron scripts/websearch-probe.cjs
const { app, net } = require('electron')

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const netGet = (url, { timeout = 15000, maxBytes = 3_000_000 } = {}) => new Promise((resolve, reject) => {
  let req
  try { req = net.request({ method: 'GET', url, redirect: 'follow' }) } catch (e) { reject(e); return }
  req.setHeader('User-Agent', BROWSER_UA)
  req.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8')
  let settled = false
  const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(to); fn(v) }
  const to = setTimeout(() => { try { req.abort() } catch {} done(reject, new Error('timeout')) }, timeout)
  req.on('response', (res) => {
    if (res.statusCode >= 400) { res.on('data', () => {}); done(reject, new Error('HTTP ' + res.statusCode)); return }
    const chunks = []; let len = 0
    res.on('data', (c) => { if (settled) return; len += c.length; chunks.push(c); if (len > maxBytes) { try { req.abort() } catch {} done(resolve, Buffer.concat(chunks).toString('utf8')) } })
    res.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')))
    res.on('error', (e) => done(reject, e))
  })
  req.on('error', (e) => done(reject, e))
  req.end()
})
const decodeEntities = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'").replace(/&nbsp;/g, ' ')
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
const uddgReal = (href) => { const m = /[?&]uddg=([^&]+)/.exec(href || ''); if (m) { try { return decodeURIComponent(m[1]) } catch { return null } } return /^https?:\/\//.test(href) ? href : null }

app.whenReady().then(async () => {
  try {
    console.log('[1] DDG search via Electron net (system proxy)…')
    const html = await netGet('https://html.duckduckgo.com/html/?q=vue+3+composition+api')
    const results = []
    const re = /<a\b[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g
    let m
    while ((m = re.exec(html)) && results.length < 8) { const url = uddgReal(decodeEntities(m[1])); const title = stripTags(m[2]); if (url && title) results.push({ title, url }) }
    console.log('    results:', results.length)
    results.slice(0, 3).forEach((r, i) => console.log(`    ${i + 1}. ${r.title}\n       ${r.url}`))
    if (!results.length) { console.log('    NO RESULTS — html head:', html.slice(0, 200)); app.exit(2); return }

    console.log('[2] web_fetch first result via Readability…')
    const page = await netGet(results[0].url, { maxBytes: 5_000_000, timeout: 20000 })
    const { JSDOM } = require('jsdom')
    const { Readability } = require('@mozilla/readability')
    const TurndownService = require('turndown')
    const dom = new JSDOM(page, { url: results[0].url })
    const article = new Readability(dom.window.document).parse()
    const md = article && article.content ? new TurndownService({ headingStyle: 'atx' }).turndown(article.content) : ''
    console.log('    article title:', article ? article.title : '(none)')
    console.log('    markdown length:', md.length)
    console.log('    excerpt:', md.replace(/\n+/g, ' ').slice(0, 200))
    console.log(md.length > 200 ? 'PROBE OK' : 'PROBE WEAK (short extract)')
    app.exit(0)
  } catch (e) {
    console.log('PROBE FAILED:', e && e.message)
    console.log('(if this is a proxy/timeout error, Electron net could not reach the engine — the user needs a SYSTEM proxy, not just an env var)')
    app.exit(1)
  }
}).catch((e) => { console.error(e); app.exit(1) })
