import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const removeFixture = async (target) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code) || attempt === 19) throw error
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

const closeElectron = async (application) => {
  if (!application) return
  let closed = false
  const closing = application.close().catch(() => {}).finally(() => { closed = true })
  await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 10_000))])
  if (closed) return
  try { application.process().kill() } catch { /* already gone */ }
  await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 2_000))])
}

test('production Electron keeps the unverified Chromium task backend fail-closed', { timeout: 90_000 }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-agent-sandbox-e2e-'))
  const userData = path.join(tempRoot, 'profile')
  fs.mkdirSync(userData, { recursive: true })
  const diagnostics = []
  let electronApp
  t.after(async () => {
    if (diagnostics.length) t.diagnostic(diagnostics.join('\n'))
    await closeElectron(electronApp)
    await removeFixture(tempRoot)
  })

  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'))
  electronApp = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: { ...cleanEnv, KNOTE_E2E: '1', KNOTE_E2E_USER_DATA: userData },
    timeout: 60_000
  })
  electronApp.process().stdout?.on('data', (chunk) => diagnostics.push(`main-stdout: ${String(chunk).trim()}`))
  electronApp.process().stderr?.on('data', (chunk) => diagnostics.push(`main-stderr: ${String(chunk).trim()}`))
  const page = await electronApp.firstWindow({ timeout: 60_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 60_000 })

  assert.equal(await page.evaluate(() => window.knoteDesktop.agentSandboxEnabled), false)
  const capabilities = await page.evaluate(() => window.knoteDesktop.agentSandboxCapabilities())
  assert.equal(capabilities.ok, true)
  assert.equal(capabilities.capabilities.available, false)
  assert.deepEqual(capabilities.capabilities.languages, [])
  assert.equal(capabilities.capabilities.reason_code, 'NETWORK_ISOLATION_UNVERIFIED')
  assert.equal(capabilities.capabilities.isolation.network, 'unverified')

  const owner = { chatKey: 'chat:e2e', sessionId: 'session:e2e', runId: 'run:e2e' }
  const direct = await page.evaluate(({ owner }) => window.knoteDesktop.agentSandboxStart(owner, {
    language: 'javascript',
    code: 'return 42',
    timeoutMs: 5000
  }), { owner })
  assert.equal(direct.ok, false)
  assert.equal(direct.code, 'SANDBOX_UNAVAILABLE')

  const hiddenSandboxWindows = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => (
    !window.isDestroyed() && !window.isVisible() && window.webContents.getURL().startsWith('data:text/html')
  )).length)
  assert.equal(hiddenSandboxWindows, 0)

  await page.reload({ waitUntil: 'commit', timeout: 60_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 60_000 })
  const afterReload = await page.evaluate(() => window.knoteDesktop.agentSandboxCapabilities())
  assert.equal(afterReload.capabilities.available, false)
})
