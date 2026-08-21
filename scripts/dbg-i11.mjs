import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-i11dbg2-'))
const workspace = path.join(tempRoot, 'ws')
fs.mkdirSync(path.join(tempRoot, 'profile'), { recursive: true })
fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(workspace, 't.md'), '# T\n')

const launchEnv = { ...process.env, KNOTE_E2E: '1', KNOTE_E2E_USER_DATA: path.join(tempRoot, 'profile') }
delete launchEnv.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.', workspace], cwd: repoRoot, env: launchEnv, timeout: 90_000 })
const page = await app.firstWindow({ timeout: 90_000 })
await page.setViewportSize({ width: 1440, height: 900 })
await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
await page.evaluate(() => localStorage.setItem('knote-onboarding-complete-v1', '1'))
await page.reload({ waitUntil: 'commit', timeout: 90_000 })
await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
await page.evaluate((f) => window.knoteDesktop.reopen('folder', f), workspace)
await page.getByText('t.md', { exact: true }).first().click()
const pm = page.locator('.ProseMirror').first()
await pm.waitFor({ state: 'visible', timeout: 30_000 })
await pm.click()
await page.keyboard.type('hello world')
await page.keyboard.press('End')
await page.keyboard.press('Control+Shift+ArrowLeft')
const selInfo = () => page.evaluate(() => {
  const sel = window.getSelection()
  return { text: sel.toString(), anchor: sel.anchorOffset, focus: sel.focusOffset }
})
console.log('SEL=' + JSON.stringify(await selInfo()))
await page.keyboard.type('`')
await page.waitForTimeout(400)
console.log('AFTER1 codes=' + await pm.locator('code').count() + ' sel=' + JSON.stringify(await selInfo()))
await page.keyboard.type('`')
await page.waitForTimeout(400)
console.log('AFTER2 codes=' + await pm.locator('code').count() + ' sel=' + JSON.stringify(await selInfo()))
console.log('CONTENT=' + JSON.stringify(await page.evaluate(() => window.__knoteDebug.getContent())))
await app.close()
process.exit(0)
