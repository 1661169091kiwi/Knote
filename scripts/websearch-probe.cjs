// Probe the HARDENED web search/fetch path in real Electron: SSRF guard
// (localhost/private blocked, per-hop), charset decode, DDG parse, Readability.
// Usage: npx electron scripts/websearch-probe.cjs
const { app, net } = require('electron')
const dns = require('dns')
const nodeNet = require('net')

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const isBlockedIP = (ip) => {
  const v = nodeNet.isIP(ip)
  if (v === 4) { const p = ip.split('.').map(Number); return p[0] === 0 || p[0] === 127 || p[0] === 10 || p[0] >= 224 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) }
  if (v === 6) { const lo = ip.toLowerCase(); const m = /::ffff:(\d+\.\d+\.\d+\.\d+)/.exec(lo); if (m) return isBlockedIP(m[1]); return lo === '::1' || lo === '::' || lo.startsWith('fe8') || lo.startsWith('fe9') || lo.startsWith('fea') || lo.startsWith('feb') || lo.startsWith('fc') || lo.startsWith('fd') || lo.startsWith('ff') }
  return false
}
const dnsLookupAll = (host) => new Promise((res, rej) => dns.lookup(host, { all: true }, (e, a) => e ? rej(e) : res(a)))
const assertPublicUrl = async (u) => {
  let host; try { host = new URL(u).hostname.replace(/^\[|\]$/g, '') } catch { throw new Error('bad_url') }
  if (nodeNet.isIP(host)) { if (isBlockedIP(host)) throw new Error('blocked_host'); return }
  let addrs; try { addrs = await dnsLookupAll(host) } catch { throw new Error('dns_failed') }
  if (!addrs.length || addrs.some((a) => isBlockedIP(a.address))) throw new Error('blocked_host')
}
const decodeBody = (buf, ct) => {
  let cs = ''; const hm = /charset=["']?\s*([\w-]+)/i.exec(ct || ''); if (hm) cs = hm[1].toLowerCase()
  if (!cs) { const head = buf.slice(0, 2048).toString('latin1'); const mm = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head); if (mm) cs = mm[1].toLowerCase() }
  if (!cs || cs === 'utf-8' || cs === 'utf8') return buf.toString('utf8')
  try { return new TextDecoder(cs).decode(buf) } catch { return buf.toString('utf8') }
}
const netGet = (url, opts = {}) => {
  const { method = 'GET', body = null, timeout = 15000, maxBytes = 3_000_000, maxRedirects = 5 } = opts
  const hop = async (u, left, m, b) => {
    await assertPublicUrl(u)
    const r = await new Promise((resolve, reject) => {
      let req; try { req = net.request({ method: m, url: u, redirect: 'manual' }) } catch (e) { reject(e); return }
      req.setHeader('User-Agent', BROWSER_UA); req.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8'); req.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
      let settled = false; const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(to); fn(v) }
      const to = setTimeout(() => { try { req.abort() } catch {} done(reject, new Error('timeout')) }, timeout)
      req.on('response', (res) => {
        const sc = res.statusCode; const loc = res.headers.location && [].concat(res.headers.location)[0]
        if (sc >= 300 && sc < 400 && loc) { res.on('data', () => {}); res.on('end', () => { let next; try { next = new URL(loc, u).href } catch { done(reject, new Error('bad_redirect')); return } done(resolve, { redirect: next }) }); return }
        if (sc >= 400) { res.on('data', () => {}); done(reject, new Error('HTTP ' + sc)); return }
        const ct = (res.headers['content-type'] && [].concat(res.headers['content-type'])[0]) || ''
        const chunks = []; let len = 0
        res.on('data', (c) => { if (settled) return; len += c.length; chunks.push(c); if (len > maxBytes) { try { req.abort() } catch {} done(resolve, { buf: Buffer.concat(chunks), ct }) } })
        res.on('end', () => done(resolve, { buf: Buffer.concat(chunks), ct })); res.on('error', (e) => done(reject, e))
      })
      req.on('error', (e) => done(reject, e)); if (b) { req.setHeader('Content-Type', 'application/x-www-form-urlencoded'); req.write(b) } req.end()
    })
    if (r.redirect) { if (left <= 0) throw new Error('too_many_redirects'); return hop(r.redirect, left - 1, 'GET', null) }
    return { text: decodeBody(r.buf, r.ct), ct: r.ct }
  }
  return hop(url, maxRedirects, method, body)
}

app.whenReady().then(async () => {
  const out = {}
  // 1. SSRF guard: localhost must be rejected BEFORE any connection
  for (const bad of ['http://127.0.0.1:9999/', 'http://localhost:8080/', 'http://192.168.1.1/', 'http://169.254.169.254/', 'http://10.0.0.5/']) {
    try { await netGet(bad, { timeout: 4000 }); out[bad] = 'NOT BLOCKED ✗' } catch (e) { out[bad] = e.message === 'blocked_host' ? 'blocked ✓' : ('err:' + e.message) }
  }
  // 2. public search still works
  // A/B: manual-POST vs follow-GET, to tell redirect-mode from rate-limiting
  try { const { text } = await netGet('https://html.duckduckgo.com/html/', { method: 'POST', body: 'q=vue' }); out.searchManualPost = ((text.match(/result__a/g) || []).length) + ' results, len=' + text.length } catch (e) { out.searchManualPost = 'FAIL:' + e.message }
  try {
    const followText = await new Promise((resolve, reject) => {
      const req = net.request({ method: 'GET', url: 'https://html.duckduckgo.com/html/?q=vue+router', redirect: 'follow' })
      req.setHeader('User-Agent', BROWSER_UA); req.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8')
      const chunks = []; req.on('response', (res) => { res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); res.on('error', reject) }); req.on('error', reject); req.end()
    })
    out.searchFollowGet = ((followText.match(/result__a/g) || []).length) + ' results, len=' + followText.length
  } catch (e) { out.searchFollowGet = 'FAIL:' + e.message }
  // 3. public fetch + charset decode
  try { const { text, ct } = await netGet('https://vuejs.org/guide/introduction.html'); out.fetchPublic = text.length > 1000 ? `ok ✓ (${text.length}B, ct=${ct.slice(0,40)})` : 'short ✗' } catch (e) { out.fetchPublic = 'FAIL:' + e.message }
  console.log(JSON.stringify(out, null, 1))
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
