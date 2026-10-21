// Read-only product diagnosis: use a disposable wide-table document/profile.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright-core'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-table-scrollbar-'))
const workspace = path.join(root, 'workspace'), profile = path.join(root, 'profile')
fs.mkdirSync(workspace); fs.mkdirSync(profile)
const file = path.join(workspace, 'wide.md')
const row = cells => '| ' + cells.join(' | ') + ' |\n'
fs.writeFileSync(file, '# Wide table\n\n' + row(Array.from({ length: 12 }, (_, i) => `Column ${i}`)) + row(Array(12).fill('---')) + Array.from({ length: 4 }, (_, i) => row(Array.from({ length: 12 }, (_, j) => `Cell ${i}/${j}`))).join('') + '\nAfter table.\n')
let application
try {
  application = await electron.launch({ args: ['.', '--no-proxy-server', '--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND,MAP fonts.gstatic.com ~NOTFOUND', workspace], cwd: process.cwd(), env: { ...process.env, KNOTE_E2E: '1', KNOTE_E2E_USER_DATA: profile }, timeout: 90000 })
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), profile)
  const page = await application.firstWindow()
  await page.locator('#app > *').first().waitFor({ state: 'attached' })
  await page.evaluate(() => localStorage.setItem('knote-onboarding-complete-v1', '1'))
  await page.reload({ waitUntil: 'commit' })
  await page.locator('#app > *').first().waitFor({ state: 'attached' })
  await page.setViewportSize({ width: 1440, height: 900 })
  assert.equal(await page.evaluate(file => window.knoteDesktop.reopen('file', file), file), true)
  const wrapper = page.locator('.ProseMirror .tableWrapper').first()
  await wrapper.waitFor({ state: 'visible' })
  await wrapper.scrollIntoViewIfNeeded()
  await page.evaluate(() => { window.__scrollbarNode = document.querySelector('.tableWrapper'); window.__scrollbarEvents = []; document.addEventListener('mousedown', event => window.__scrollbarEvents.push({ target: event.target.className, x: event.clientX, y: event.clientY }), true) })
  const sample = async phase => console.log(JSON.stringify({ phase, ...await wrapper.evaluate(el => ({ sameNode: el === window.__scrollbarNode, color: getComputedStyle(el).scrollbarColor, rootColor: getComputedStyle(document.querySelector('.knote-root')).scrollbarColor, width: el.clientWidth, scrollWidth: el.scrollWidth, left: el.scrollLeft, height: el.offsetHeight, clientHeight: el.clientHeight, selection: document.querySelector('.ProseMirror').editor.state.selection.toJSON(), events: window.__scrollbarEvents })) }))
  await page.locator('.knote-root').evaluate(el => el.dispatchEvent(new Event('scroll')))
  await sample('after-root-scroll')
  const geometry = await wrapper.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.left + 24, y: r.bottom - (el.offsetHeight - el.clientHeight) / 2, overflow: el.scrollWidth - el.clientWidth } })
  assert.ok(geometry.overflow > 100, 'fixture must have an actual horizontal scrollbar')
  await page.mouse.move(geometry.x, geometry.y)
  await page.mouse.down()
  await sample('pressed')
  await page.waitForTimeout(1300)
  await sample('held-1300ms')
  await page.mouse.move(geometry.x + 180, geometry.y, { steps: 12 })
  await sample('dragged')
  await page.mouse.up()
  await sample('released')
} finally {
  if (application) await application.close()
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('knote-table-scrollbar-')) throw Error('Unsafe temporary path')
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}
