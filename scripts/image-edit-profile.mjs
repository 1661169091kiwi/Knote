// Read-only diagnosis of editor work, using disposable documents and profile.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright-core'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-image-profile-'))
const workspace = path.join(root, 'workspace'), profile = path.join(root, 'profile')
fs.mkdirSync(workspace); fs.mkdirSync(profile)
fs.copyFileSync('src/icon/KnoteIcon-pixel.png', path.join(workspace, 'pixel.png'))
const scenarios = {
  small: '# Image diagnosis\n\n![profile](pixel.png)\n\n' + 'A normal paragraph.\n\n'.repeat(30),
  headings: '# Heading diagnosis\n\n![profile](pixel.png)\n\n' + Array.from({ length: 500 }, (_, i) => `## Heading ${i}\n\nA normal paragraph with **formatting**.\n\n`).join(''),
  images: '# Many images\n\n![profile](pixel.png)\n\n' + Array.from({ length: 60 }, (_, i) => `Paragraph ${i}.\n\n![asset ${i}](pixel.png)\n\n`).join(''),
  heavyImages: '# More images\n\n![profile](pixel.png)\n\n' + Array.from({ length: 240 }, (_, i) => `Paragraph ${i}.\n\n![asset ${i}](pixel.png)\n\n`).join('')
}
const sourcePath = process.env.KNOTE_IMAGE_PROFILE_SOURCE
if (sourcePath) {
  const source = fs.readFileSync(sourcePath, 'utf8')
  for (const key of Object.keys(scenarios)) delete scenarios[key]
  scenarios.real = source
  // Copy only the document's local image assets to the disposable workspace.
  // Never open the original document for editing or launch its workspace.
  for (const match of source.matchAll(/!\[[^\]]*\]\(([^\n]+)\)|<img\b[^>]*src=["']([^"']+)["']/gi)) {
    const reference = (match[1] || match[2]).trim().replace(/\s+["'][^"']*["']$/, '')
    if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(reference)) continue
    const relative = decodeURIComponent(reference.split(/[?#]/)[0])
    const target = path.resolve(workspace, relative)
    if (!target.startsWith(workspace + path.sep)) throw Error('Image reference escapes temporary workspace')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.resolve(path.dirname(sourcePath), relative), target)
  }
}
for (const [name, source] of Object.entries(scenarios)) fs.writeFileSync(path.join(workspace, name + '.md'), source)
let application
try {
  application = await electron.launch({ args: [process.env.KNOTE_IMAGE_PROFILE_APP || '.', '--no-proxy-server', '--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND,MAP fonts.gstatic.com ~NOTFOUND', workspace], cwd: process.cwd(), env: { ...process.env, KNOTE_E2E: '1', KNOTE_E2E_USER_DATA: profile }, timeout: 90000 })
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), profile)
  console.log(JSON.stringify({ event: 'version', version: await application.evaluate(({ app }) => app.getVersion()) }))
  const page = await application.firstWindow()
  await page.locator('#app > *').first().waitFor({ timeout: 90000 })
  await page.evaluate(() => localStorage.setItem('knote-onboarding-complete-v1', '1'))
  await page.reload({ waitUntil: 'commit' })
  await page.waitForFunction(() => !!window.__knoteDebug?.getContent)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  for (const name of Object.keys(scenarios)) {
    await page.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, name + '.md'))
    const editor = page.locator('.ProseMirror').first(), image = editor.locator('img:not(.ProseMirror-separator)').nth(Number(process.env.KNOTE_IMAGE_PROFILE_IMAGE_INDEX || 0))
    await image.waitFor({ state: 'visible' })
    await image.evaluate(el => el.decode())
    await image.click()
    await page.waitForTimeout(250)
    console.log(JSON.stringify({ event: 'structure', scenario: name, ...(await editor.evaluate(el => {
      const doc = el.editor.state.doc, selected = el.editor.state.selection
      const imageNodes = []
      doc.descendants((node, pos) => {
        if (node.type.name !== 'image') return
        const resolved = doc.resolve(pos)
        imageNodes.push({ pos, srcLength: String(node.attrs.src || '').length, attrs: Object.fromEntries(Object.entries(node.attrs).filter(([key]) => /line/i.test(key))), ancestors: Array.from({ length: resolved.depth }, (_, i) => ({ type: resolved.node(i + 1).type.name, attrs: resolved.node(i + 1).attrs })) })
      })
      return { imageNodes, selected: selected.toJSON(), topLevelCount: doc.childCount, unanchoredBlocks: window.__knoteBlockSplice?.anchors()?.filter(anchor => anchor.start == null).length }
    })) }))
    await editor.evaluate(el => {
      const editor = el.editor
      window.__restoreImageProfile?.()
      window.__imageProfile = { timings: [], longTasks: [] }
      const restore = []
      window.__restoreImageProfile = () => restore.forEach(fn => fn())
      const wrap = (object, key, label) => {
        const original = object[key]
        restore.push(() => { object[key] = original })
        object[key] = function (...args) {
          const at = performance.now()
          try { return original.apply(this, args) }
          finally { window.__imageProfile.timings.push({ label, ms: performance.now() - at }) }
        }
      }
      wrap(editor.view, 'dispatch', 'dispatch')
      wrap(editor.storage.markdown.serializer, 'serialize', 'serialize')
      wrap(editor.storage.markdown.parser, 'parse', 'parse')
      if (!window.__imageLongTaskObserver) {
        window.__imageLongTaskObserver = new PerformanceObserver(list => window.__imageProfile.longTasks.push(...list.getEntries().map(entry => entry.duration)))
        window.__imageLongTaskObserver.observe({ type: 'longtask' })
      }
    })
    for (const [action, selector] of [['center', '[data-testid="image-align-center"]'], ['resize', '[data-testid="image-width-slider"]'], ['right', '[data-testid="image-align-right"]'], ['crop', '']]) {
      if (process.env.KNOTE_IMAGE_PROFILE_ACTIONS && !process.env.KNOTE_IMAGE_PROFILE_ACTIONS.split(',').includes(action)) continue
      if (action === 'crop') await page.locator('.knote-bubble button').filter({ has: page.locator('svg path[d^="M6 2v14"]') }).click()
      await cdp.send('Profiler.start')
      await page.evaluate(() => { window.__imageProfile.timings = []; window.__imageProfile.longTasks = [] })
      const started = Date.now()
      if (action === 'crop') await page.getByRole('button', { name: '确认裁剪', exact: true }).click()
      else if (action === 'resize') {
        await page.locator(selector).focus()
        await page.keyboard.press('Home')
        await page.keyboard.press('ArrowRight')
      } else await page.locator(selector).click()
      const clickMs = Date.now() - started
      await page.waitForTimeout(1000)
      // Flush observer delivery after delayed asset persistence/model updates,
      // so a late full parse cannot disappear from the reported long tasks.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const { profile: cpu } = await cdp.send('Profiler.stop')
      const top = cpu.nodes.filter(node => node.hitCount).sort((a, b) => b.hitCount - a.hitCount).slice(0, 20).map(node => ({ function: node.callFrame.functionName, hits: node.hitCount, url: node.callFrame.url.slice(-70), line: node.callFrame.lineNumber, column: node.callFrame.columnNumber }))
      const measured = await page.evaluate(() => ({ ...window.__imageProfile, writeBack: window.__knoteBlockSplice?.trace().slice(-3), sourceLength: window.__knoteDebug.getContent().length, selected: document.querySelector('.ProseMirror')?.editor?.state.selection.toJSON() }))
      console.log(JSON.stringify({ scenario: name, action, clickMs, ...measured, top }))
      if (process.env.KNOTE_IMAGE_PROFILE_ASSERT === '1') {
        if (measured.timings.some(item => item.label === 'parse')) throw Error(`${name}/${action}: image edit reparsed the document`)
        assert.equal(measured.selected?.type, 'node', `${name}/${action}: image selection was lost`)
        // Resource externalization and the final atomic save are asynchronous.
        // Check an explicit save boundary, not an intermediate autosave write.
        await page.keyboard.press('Control+s')
        const destination = path.join(workspace, name + '.md')
        const displayBytes = /data:image|knote-img:|knote-resource=|knote-token=/i
        let saved = ''
        const deadline = Date.now() + 15000
        do {
          saved = fs.readFileSync(destination, 'utf8')
          if (!displayBytes.test(saved)) break
          await page.waitForTimeout(100)
        } while (Date.now() < deadline)
        assert.ok(!displayBytes.test(saved), `${name}/${action}: display bytes remained on disk after save (length=${saved.length})`)
        const expectedReferences = name === 'heavyImages' ? 240 : name === 'images' ? 60 : 0
        if (action === 'crop' && name !== 'real') assert.equal((saved.match(/pixel\.png/g) || []).length, expectedReferences, `${name}: cropping changed untouched image references`)
      }
    }
  }
} finally {
  if (application) await application.close()
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('knote-image-profile-')) throw Error('Unsafe temporary path')
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}
