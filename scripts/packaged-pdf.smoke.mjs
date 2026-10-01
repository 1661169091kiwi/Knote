// Verify the built ASAR's file:// module/CSP/preload loading, without launching
// the installed user profile. Uses the exact bundled Electron version and a
// fresh E2E profile; neither installs Knote nor writes a user's document.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright-core'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-packaged-pdf-'))
const workspace = path.join(root, 'workspace'), profile = path.join(root, 'profile')
fs.mkdirSync(workspace); fs.mkdirSync(profile)
const source = path.join(workspace, 'packaged.md'), output = path.join(root, 'packaged.pdf')
fs.writeFileSync(source, '# PACKAGED_PDF_SENTINEL\n\n**Packaged Markdown formatting.**\n\n```mermaid\nflowchart LR\nA[Source] --> B[PDF]\n```\n\nPACKAGED_PDF_END\n')
let application
try {
  application = await electron.launch({ args: [path.resolve('release/win-unpacked/resources/app.asar'), workspace], cwd: process.cwd(), env: { ...process.env, KNOTE_E2E: '1', KNOTE_E2E_USER_DATA: profile }, timeout: 90000 })
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), profile, 'never run the smoke in the user profile')
  const page = await application.firstWindow()
  page.on('pageerror', error => console.error('packaged page error:', error.message))
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 30000 })
  await page.evaluate(() => localStorage.setItem('knote-onboarding-complete-v1', '1'))
  await page.reload({ waitUntil: 'commit' })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 30000 })
  await page.waitForFunction(() => !!window.__knoteDebug?.getContent)
  assert.equal(await page.evaluate(file => window.knoteDesktop.reopen('file', file), source), true)
  await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('PACKAGED_PDF_SENTINEL')).catch(async error => {
    console.log(JSON.stringify(await page.evaluate(() => ({ mode: document.querySelector('.ProseMirror')?.textContent, content: window.__knoteDebug?.getContent?.(), body: document.body.innerText.slice(0, 1200) }))))
    throw error
  })
  await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, output)
  await page.getByTestId('actions-menu').click()
  await page.getByTestId('export-pdf').click()
  const deadline = Date.now() + 45000
  while (!fs.existsSync(output) || fs.statSync(output).size === 0) {
    if (Date.now() > deadline) throw new Error('Packaged PDF did not finish')
    const error = page.locator('.knote-pdf-progress-error')
    if (await error.count()) throw new Error(await error.innerText())
    await page.waitForTimeout(100)
  }
  assert.equal(fs.readFileSync(output).subarray(0, 4).toString(), '%PDF')
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = getDocument({ data: new Uint8Array(fs.readFileSync(output)), useSystemFonts: true })
  const pdf = await loading.promise
  try {
    let text = ''
    for (let n = 1; n <= pdf.numPages; n++) text += (await (await pdf.getPage(n)).getTextContent()).items.map(item => item.str).join(' ')
    assert.match(text, /PACKAGED_PDF_SENTINEL/)
    assert.match(text, /PACKAGED_PDF_END/)
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
    console.log(JSON.stringify({ packagedAsarPdf: true, version: await application.evaluate(({ app }) => app.getVersion()), pages: pdf.numPages, bytes: fs.statSync(output).size, printerReclaimed: true }))
  } finally { await loading.destroy() }
} finally {
  if (application) await application.close()
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('knote-packaged-pdf-')) throw new Error('Unsafe smoke cleanup path')
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}
