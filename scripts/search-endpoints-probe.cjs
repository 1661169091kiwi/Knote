// Probe several keyless search endpoints through Electron net (the user's own
// network + OS proxy) to find one that still returns scrapable HTML results.
// Usage: npx electron scripts/search-endpoints-probe.cjs
const { app, net } = require('electron')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const get = (url, { method = 'GET', body = null, headers = {} } = {}) => new Promise((resolve, reject) => {
  let req
  try { req = net.request({ method, url, redirect: 'follow' }) } catch (e) { reject(e); return }
  req.setHeader('User-Agent', UA)
  req.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
  req.setHeader('Accept-Language', 'en-US,en;q=0.9,zh-CN;q=0.8')
  for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)
  const chunks = []
  const to = setTimeout(() => { try { req.abort() } catch {} reject(new Error('timeout')) }, 15000)
  req.on('response', (res) => {
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => { clearTimeout(to); resolve({ status: res.statusCode, html: Buffer.concat(chunks).toString('utf8') }) })
    res.on('error', (e) => { clearTimeout(to); reject(e) })
  })
  req.on('error', (e) => { clearTimeout(to); reject(e) })
  if (body) { req.setHeader('Content-Type', 'application/x-www-form-urlencoded'); req.write(body) }
  req.end()
})

const Q = 'vue composition api'
const sample = (re, html, n = 2) => {
  const out = []
  let m
  while ((m = re.exec(html)) && out.length < n) out.push((m[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 60))
  return out
}

const tests = [
  ['bing', () => get('https://www.bing.com/search?q=' + encodeURIComponent(Q) + '&setlang=en'), (h) => (h.match(/<li class="b_algo"/g) || []).length, (h) => sample(/<h2><a[^>]*>([\s\S]*?)<\/a>/g, h)],
  ['bing-cn', () => get('https://cn.bing.com/search?q=' + encodeURIComponent(Q) + '&setlang=en'), (h) => (h.match(/<li class="b_algo"/g) || []).length, (h) => sample(/<h2><a[^>]*>([\s\S]*?)<\/a>/g, h)],
  ['ddg-lite', () => get('https://lite.duckduckgo.com/lite/', { method: 'POST', body: 'q=' + encodeURIComponent(Q) }), (h) => (h.match(/result-link|class="result-link"|href="\/\/duckduckgo/g) || []).length, (h) => sample(/class="result-link"[^>]*>([\s\S]*?)<\/a>/g, h)],
  ['ddg-html', () => get('https://html.duckduckgo.com/html/', { method: 'POST', body: 'q=' + encodeURIComponent(Q) }), (h) => (h.match(/result__a/g) || []).length, (h) => sample(/result__a"[^>]*>([\s\S]*?)<\/a>/g, h)],
  ['mojeek', () => get('https://www.mojeek.com/search?q=' + encodeURIComponent(Q)), (h) => (h.match(/class="results-standard"|<a class="title"|ob"/g) || []).length, (h) => sample(/<a class="title"[^>]*>([\s\S]*?)<\/a>/g, h)],
  ['brave', () => get('https://search.brave.com/search?q=' + encodeURIComponent(Q)), (h) => (h.match(/snippet-title|result-header|<a[^>]+class="[^"]*result/g) || []).length, (h) => sample(/snippet-title[^>]*>([\s\S]*?)<\/[a-z]/g, h)],
  ['startpage', () => get('https://www.startpage.com/sp/search?query=' + encodeURIComponent(Q)), (h) => (h.match(/class="w-gl__result-title"|result-title/g) || []).length, () => []],
  ['searx-be', () => get('https://searx.be/search?q=' + encodeURIComponent(Q) + '&format=json', { headers: { Accept: 'application/json' } }), (h) => { try { return (JSON.parse(h).results || []).length } catch { return 0 } }, (h) => { try { return (JSON.parse(h).results || []).slice(0, 2).map((r) => (r.title || '').slice(0, 60)) } catch { return [] } }]
]

app.whenReady().then(async () => {
  for (const [name, run, count, samp] of tests) {
    try {
      const { status, html } = await run()
      const n = count(html)
      const canon = /rel="canonical"\s+href="https:\/\/(duckduckgo|www\.startpage)\.com\/?"/.test(html) ? ' [landing]' : ''
      console.log(`${name.padEnd(11)} status=${status} len=${String(html.length).padEnd(7)} results=${n}${canon}  sample=${JSON.stringify(samp(html))}`)
    } catch (e) {
      console.log(`${name.padEnd(11)} FAIL: ${e.message}`)
    }
  }
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
