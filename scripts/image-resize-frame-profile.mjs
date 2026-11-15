// Read-only diagnosis: frame pacing while dragging the image width slider, per theme (classic /
// glass) and with the floating assistant window open or closed over the document. Uses a disposable
// workspace and profile; prints one JSON line per scenario.
//   node scripts/image-resize-frame-profile.mjs      (run it on the background desktop:
//   scripts/windows-background-test.ps1 -Task image-frame-profile -LogPath logs/image-frame.log)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright-core'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-image-frames-'))
const workspace = path.join(root, 'workspace'), profile = path.join(root, 'profile')
fs.mkdirSync(workspace); fs.mkdirSync(profile)
// a real-sized PNG (1440x900), like a pasted screenshot
fs.copyFileSync('docs/screenshots/glass-theme-light-1.1.101.png', path.join(workspace, 'big.png'))
const filler = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i} with **bold**, *italic* and \`code\` so the text wraps over a few lines in the editor column.\n\n`).join('')
fs.writeFileSync(path.join(workspace, 'resize.md'), `# Image resize frames\n\n${filler(4)}![big](big.png)\n\n${filler(60)}`)

const scenarios = [
  { theme: 'light', agent: false },
  { theme: 'glass', agent: false },
  { theme: 'glass', agent: true },
  { theme: 'light', agent: true }
]
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  const mean = values.reduce((sum, v) => sum + v, 0) / (values.length || 1)
  return { n: values.length, mean: +mean.toFixed(1), p50: +(at(0.5) || 0).toFixed(1), p95: +(at(0.95) || 0).toFixed(1), max: +(sorted.at(-1) || 0).toFixed(1) }
}

let application
try {
  application = await electron.launch({ args: ['.', '--no-proxy-server', '--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND,MAP fonts.gstatic.com ~NOTFOUND', workspace], cwd: process.cwd(), env: { ...process.env, KNOTE_E2E: '1', KNOTE_E2E_USER_DATA: profile }, timeout: 90000 })
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), profile)
  const page = await application.firstWindow()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  await page.locator('#app > *').first().waitFor({ timeout: 90000 })
  for (const scenario of scenarios) {
    await page.evaluate(({ theme }) => {
      localStorage.setItem('knote-onboarding-complete-v1', '1')
      localStorage.setItem('knote-theme-v1', theme)
      localStorage.setItem('knote-agent-display-v1', 'float')
    }, scenario)
    await page.reload({ waitUntil: 'commit' })
    await page.waitForFunction(() => !!window.__knoteDebug?.getContent)
    await page.evaluate((file) => window.knoteDesktop.reopen('file', file), path.join(workspace, 'resize.md'))
    const editor = page.locator('.ProseMirror').first()
    const image = editor.locator('img:not(.ProseMirror-separator)').first()
    await image.waitFor({ state: 'visible', timeout: 30000 })
    await image.evaluate((el) => el.decode())
    await page.evaluate(async (open) => { (await window.__knoteDebug.agent()).agentOpen.value = open }, scenario.agent)
    await page.waitForTimeout(900)
    await image.click()
    const slider = page.getByTestId('image-width-slider')
    await slider.waitFor({ state: 'visible' })
    const box = await slider.boundingBox()
    const y = box.y + box.height / 2
    await page.evaluate(() => {
      const record = { frames: [], longTasks: [] }
      window.__frameProfile = record
      let last = performance.now(), running = true
      const tick = (now) => { record.frames.push(now - last); last = now; if (running) requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
      record.stop = () => { running = false }
      try {
        record.observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) record.longTasks.push(entry.duration) })
        record.observer.observe({ entryTypes: ['longtask'] })
      } catch { /* no long-task timing */ }
    })
    // drag the thumb across the track and back three times, one move per step
    const moves = []
    await page.mouse.move(box.x + box.width - 4, y)
    await page.mouse.down()
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i <= 40; i++) {
        const t = pass % 2 === 0 ? 1 - i / 40 : i / 40
        const at = Date.now()
        await page.mouse.move(box.x + 4 + t * (box.width - 8), y)
        moves.push(Date.now() - at)
      }
    }
    const releaseAt = Date.now()
    await page.mouse.up()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const commitMs = Date.now() - releaseAt
    const record = await page.evaluate(() => {
      const r = window.__frameProfile
      r.stop(); r.observer?.disconnect()
      return { frames: r.frames.slice(2), longTasks: r.longTasks }
    })
    const glass = await page.evaluate(() => ({
      gl: document.documentElement.classList.contains('gl'),
      paneFilter: document.querySelector('.knote-agent-glass')?.style.backdropFilter || '',
      agentVisible: !!document.querySelector('.knote-agent-window')?.offsetWidth
    }))
    console.log(JSON.stringify({
      scenario: `${scenario.theme}${scenario.agent ? '+agent' : ''}`,
      glass,
      frameMs: stats(record.frames),
      slowFrames: record.frames.filter((ms) => ms > 34).length,
      moveMs: stats(moves),
      longTasks: stats(record.longTasks),
      commitMs
    }))
  }
} finally {
  await application?.close().catch(() => {})
  fs.rmSync(root, { recursive: true, force: true })
}
