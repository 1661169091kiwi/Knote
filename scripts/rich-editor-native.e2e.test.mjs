import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// A real-size image makes a native pointer click deterministic. A 1x1 fixture
// can place neighbouring image hit boxes on the same device-pixel after zoom.
const pixelPng = fs.readFileSync(path.join(repoRoot, 'src', 'icon', 'KnoteIcon-pixel.png'))

const waitUntil = async (predicate, { timeout = 12_000, interval = 50, message = 'condition was not met' } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(message)
}

const closeElectron = async (application) => {
  if (!application) return
  let closed = false
  const closeTask = application.close().catch(() => {}).finally(() => { closed = true })
  await Promise.race([closeTask, new Promise((resolve) => setTimeout(resolve, 8_000))])
  if (!closed) {
    try { application.process().kill() } catch { /* already gone */ }
  }
}

const removeFixture = async (target) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return
    } catch (error) {
      if (!error || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code) || attempt === 19) throw error
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

const launchEditor = async (t, files) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-native-editor-'))
  const userData = path.join(tempRoot, 'profile')
  const workspace = path.join(tempRoot, 'workspace')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  Object.entries(files).forEach(([name, value]) => {
    fs.writeFileSync(path.join(workspace, name), value)
  })

  let application
  const nativeLogs = []
  let targetCrashed = false
  const rememberLog = (prefix, chunk) => {
    nativeLogs.push(`${prefix}${String(chunk || '')}`)
    while (nativeLogs.join('').length > 24_000) nativeLogs.shift()
  }
  try {
    application = await electron.launch({
      args: ['.', workspace],
      cwd: repoRoot,
      env: {
        ...process.env,
        KNOTE_E2E: '1',
        KNOTE_E2E_USER_DATA: userData
      },
      timeout: 90_000
    })
    application.process().stdout?.on('data', (chunk) => rememberLog('stdout: ', chunk))
    application.process().stderr?.on('data', (chunk) => rememberLog('stderr: ', chunk))
    const page = await application.firstWindow({ timeout: 90_000 })
    page.on('crash', () => { targetCrashed = true })
    page.on('pageerror', (error) => rememberLog('pageerror: ', error?.stack || error?.message || error))
    await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
    await page.evaluate(() => localStorage.setItem('knote-onboarding-complete-v1', '1'))
    await page.reload({ waitUntil: 'commit', timeout: 90_000 })
    await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })

    t.after(async () => {
      if (targetCrashed) {
        const ledger = path.join(userData, 'crash-diagnostics', 'events.jsonl')
        let events = ''
        try { events = fs.readFileSync(ledger, 'utf8') } catch { /* crash reporter may not have flushed */ }
        t.diagnostic(`native Electron target crashed; ledger=${JSON.stringify(events)} logs=${JSON.stringify(nativeLogs.join(''))}`)
      }
      await closeElectron(application)
      await removeFixture(tempRoot)
    })
    return { application, page, workspace }
  } catch (error) {
    const ledger = path.join(userData, 'crash-diagnostics', 'events.jsonl')
    let events = ''
    try { events = fs.readFileSync(ledger, 'utf8') } catch { /* crash reporter may not have flushed */ }
    error.message += `\nnative launch ledger=${JSON.stringify(events)} logs=${JSON.stringify(nativeLogs.join(''))}`
    await closeElectron(application)
    await removeFixture(tempRoot)
    throw error
  }
}

test('native Windows dual-MIME Markdown paste stays two adjacent visual rows', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const { application, page, workspace } = await launchEditor(t, { 'paste.md': '' })
  const target = path.join(workspace, 'paste.md')
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
  const editor = page.locator('.ProseMirror').first()
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  await editor.click()

  const plain = 'RAL-Bench 主要研究：**基础 LLM 能否一次性生成满足功能与五类非功能属性的 Python 应用？**\r\n\r\nMAGIC-Bench 主要研究：**具有规划、文件编辑、Shell、构建和迭代调试能力的 Agent-System，能否完成跨语言项目重构；主干模型与 Agent Harness 分别如何影响七个质量维度？"**\r\n\r\n'
  // This is the important native clipboard shape missed by a DataTransfer-only
  // test: text/plain carries Markdown source, while text/html has already
  // rendered the same emphasis as <strong> and uses two paragraph blocks.
  const html = [
    '<p>RAL-Bench 主要研究：<strong>基础 LLM 能否一次性生成满足功能与五类非功能属性的 Python 应用？</strong></p>',
    '<p>MAGIC-Bench 主要研究：<strong>具有规划、文件编辑、Shell、构建和迭代调试能力的 Agent-System，能否完成跨语言项目重构；主干模型与 Agent Harness 分别如何影响七个质量维度？&quot;</strong></p>'
  ].join('\r\n')

  const oldClipboard = await application.evaluate(({ clipboard }) => ({
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    bookmark: clipboard.readBookmark(),
    image: clipboard.readImage().isEmpty() ? null : clipboard.readImage().toPNG().toString('base64')
  }))
  try {
    const before = await editor.evaluate((element) => ({ text: element.innerText, html: element.innerHTML }))
    const nativeClipboard = await application.evaluate(({ clipboard }, value) => {
      clipboard.write(value)
      return {
        formats: clipboard.availableFormats(),
        text: clipboard.readText(),
        html: clipboard.readHTML()
      }
    }, { text: plain, html })
    assert.ok(nativeClipboard.formats.some((format) => /text\/html|HTML Format/i.test(format)), nativeClipboard.formats)
    assert.match(nativeClipboard.html, /<strong>/i)

    // Keyboard paste makes Chromium read the actual Windows clipboard and create
    // its native ClipboardEvent. No DataTransfer or dispatchEvent is involved.
    await page.keyboard.press('Control+V')
    await page.waitForTimeout(700)

    const pasted = await editor.evaluate((element) => ({
      text: element.innerText,
      html: element.innerHTML,
      paragraphs: element.querySelectorAll('p').length,
      breaks: element.querySelectorAll('br').length,
      strong: element.querySelectorAll('strong').length
    }))
    t.diagnostic(`native paste DOM ${JSON.stringify({ before, after: pasted })}`)
    assert.equal(pasted.text.trim(), plain.replace(/\r\n/g, '\n').trim().replace(/\n+/g, '\n').replace(/\*\*/g, ''), JSON.stringify({ nativeClipboard, pasted }))
    assert.equal(pasted.paragraphs, 1, JSON.stringify({ nativeClipboard, pasted }))
    assert.equal(pasted.breaks, 1, JSON.stringify({ nativeClipboard, pasted }))
    assert.equal(pasted.strong, 2, JSON.stringify({ nativeClipboard, pasted }))

    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      const saved = fs.readFileSync(target, 'utf8')
      if (saved.includes('RAL-Bench') && saved.includes('MAGIC-Bench')) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const saved = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
    t.diagnostic(`native paste markdown ${JSON.stringify(saved)}`)
    assert.doesNotMatch(saved, /\n[ \t]*\n/, saved)
    assert.equal((saved.match(/\*\*/g) || []).length, 4, saved)
  } finally {
    await application.evaluate(({ clipboard, nativeImage }, value) => {
      const payload = {
        text: value.text || '',
        html: value.html || '',
        rtf: value.rtf || '',
        bookmark: value.bookmark || ''
      }
      if (value.image) payload.image = nativeImage.createFromBuffer(Buffer.from(value.image, 'base64'))
      clipboard.write(payload)
    }, oldClipboard)
  }
})

test('native dual-MIME paste keeps rich semantics absent from text/plain', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const { application, page, workspace } = await launchEditor(t, { 'rich-paste.md': '' })
  assert.equal(
    await page.evaluate((file) => window.knoteDesktop.reopen('file', file), path.join(workspace, 'rich-paste.md')),
    true
  )
  const editor = page.locator('.ProseMirror').first()
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  await editor.click()
  const oldClipboard = await application.evaluate(({ clipboard }) => ({
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    bookmark: clipboard.readBookmark(),
    image: clipboard.readImage().isEmpty() ? null : clipboard.readImage().toPNG().toString('base64')
  }))
  const writeClipboard = (payload) => application.evaluate(({ clipboard }, value) => clipboard.write(value), payload)
  try {
    await writeClipboard({
      text: 'Read [docs](https://example.com) and **note**',
      html: '<p>Read <a href="https://example.com">docs</a> and <strong>note</strong></p>'
    })
    await page.keyboard.press('Control+V')
    await page.waitForTimeout(350)
    assert.deepEqual(await editor.evaluate((element) => ({
      links: Array.from(element.querySelectorAll('a')).map((link) => link.getAttribute('href')),
      strong: element.querySelectorAll('strong').length,
      paragraphs: element.querySelectorAll('p').length
    })), { links: ['https://example.com'], strong: 1, paragraphs: 1 })

    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await writeClipboard({
      text: '**literal code**',
      html: '<pre><code>**literal code**</code></pre>'
    })
    await page.keyboard.press('Control+V')
    await page.waitForTimeout(350)
    const codeResult = await editor.evaluate((element) => ({
      text: element.innerText,
      codeBlocks: element.querySelectorAll('pre code').length,
      strong: element.querySelectorAll('strong').length
    }))
    t.diagnostic(`native protected-rich paste ${JSON.stringify(codeResult)}`)
    assert.match(codeResult.text, /\*\*literal code\*\*$/)
    assert.equal(codeResult.codeBlocks, 1)
    assert.equal(codeResult.strong, 0)
  } finally {
    await application.evaluate(({ clipboard, nativeImage }, value) => {
      const payload = {
        text: value.text || '',
        html: value.html || '',
        rtf: value.rtf || '',
        bookmark: value.bookmark || ''
      }
      if (value.image) payload.image = nativeImage.createFromBuffer(Buffer.from(value.image, 'base64'))
      clipboard.write(payload)
    }, oldClipboard)
  }
})

test('block separators and extra source blank lines survive native editor HTML and save round trip', async (t) => {
  const source = ['# top', '', 'one', '', '## two', '', '', 'three', '', '', '', '# four'].join('\n')
  const { page, workspace } = await launchEditor(t, { 'blank-rows.md': source })
  const target = path.join(workspace, 'blank-rows.md')

  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
  const editor = page.locator('.ProseMirror').first()
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  const rows = await editor.evaluate((element) =>
    Array.from(element.children).map((child) => child.textContent)
  )
  // The first blank line is the Markdown block separator; only additional
  // blank lines become visible editor rows.
  assert.deepEqual(rows, ['top', 'one', 'two', '', 'three', '', '', 'four'])

  const edited = `${source}!`
  assert.equal(await editor.evaluate((element) => {
    const tiptap = element.editor
    tiptap.view.dispatch(tiptap.state.tr.insertText('!', tiptap.state.doc.content.size - 1))
    return tiptap.state.doc.textContent.endsWith('four!')
  }), true)
  await page.waitForFunction(() => window.__knoteDebug.getContent().endsWith('four!'))
  assert.equal(await page.evaluate(() => window.__knoteDebug.getContent()), edited)
  await page.keyboard.press('Control+s')
  await waitUntil(
    () => fs.readFileSync(target, 'utf8') === edited,
    { message: `blank rows changed while saving: ${JSON.stringify(fs.readFileSync(target, 'utf8'))}` }
  )
  assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /knote:block-separator/)
})

test('image source, title, width and alignment survive a native editor round trip', async (t) => {
  const { page, workspace } = await launchEditor(t, {
    'one.png': pixelPng,
    // Deliberately identical bytes under a different durable path. A reverse
    // data-URL lookup must not silently rewrite two.png to one.png.
    'two.png': pixelPng,
    'images.md': ''
  })
  const target = path.join(workspace, 'images.md')
  const absoluteUrl = new URL(`file:///${path.join(workspace, 'one.png').replace(/\\/g, '/')}`).href
  const embedded = `data:image/png;base64,${pixelPng.toString('base64')}`
  fs.writeFileSync(target, [
    '![md-one](one.png "Title one")',
    '![md-two](two.png "Title two")',
    '<img src="one.png" alt="html-one" title="HTML title" style="width:40%;">',
    `<img src="${absoluteUrl}" alt="absolute" title="Absolute title" style="width:35%;">`,
    `<img src="${embedded}" alt="embedded" title="Embedded title" style="width:30%;">`
  ].join('\n\n'))

  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
  const editor = page.locator('.ProseMirror').first()
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  const mdTwo = editor.locator('img[alt="md-two"]').first()
  await mdTwo.waitFor({ state: 'visible', timeout: 10_000 })
  await waitUntil(
    () => mdTwo.evaluate((image) => image.complete && image.naturalWidth > 0),
    { message: 'the relative image never resolved to displayable bytes' }
  )
  // The app durably moves a genuine embedded data image into assets shortly
  // after open. Let that one-time external sync finish before testing a native
  // node click; otherwise its reset can legitimately replace our selection.
  await waitUntil(
    () => /src="assets\/knote-img-[^"]+"[^>]*alt="embedded"/i.test(fs.readFileSync(target, 'utf8')),
    { message: 'the embedded image was not durably persisted before interaction' }
  )
  await page.waitForTimeout(250)

  await mdTwo.click({ force: true })
  await waitUntil(
    () => editor.locator('img.ProseMirror-selectednode[alt="md-two"]').count().then(Boolean),
    { timeout: 5_000, message: 'the native image click selected a different node' }
  )
  const centerButton = page.getByTestId('image-align-center')
  await waitUntil(
    async () => await centerButton.count() > 0,
    {
      timeout: 5_000,
      message: JSON.stringify(await editor.evaluate((element) => ({
        html: element.innerHTML,
        selectedImages: element.querySelectorAll('img.ProseMirror-selectednode').length
      })))
    }
  )
  await centerButton.click()
  await waitUntil(
    () => /margin-left:auto;margin-right:auto/.test(fs.readFileSync(target, 'utf8')),
    { message: 'center alignment was not saved' }
  )
  let disk = fs.readFileSync(target, 'utf8')
  assert.match(disk, /src="two\.png"[^>]*title="Title two"/i, disk)
  assert.match(disk, /!\[md-one\]\(one\.png "Title one"\)/, disk)
  assert.doesNotMatch(disk, /knote-img:|data:image/i, disk)

  // A raw Markdown image starts at its natural size (capped by the editor).
  // The slider's 100% must reproduce that exact baseline; 90% must be smaller,
  // not 90% of the much wider editor container.
  const naturalBaseline = await mdTwo.evaluate((image) => ({
    renderedWidth: image.getBoundingClientRect().width,
    naturalWidth: image.naturalWidth,
    styleWidth: image.style.width
  }))
  assert.ok(naturalBaseline.naturalWidth > 0, JSON.stringify(naturalBaseline))
  assert.ok(naturalBaseline.renderedWidth > 0, JSON.stringify(naturalBaseline))
  assert.equal(naturalBaseline.styleWidth, '')

  // Range input is a real focusable control. Input events preview locally and
  // must neither steal focus nor move the toolbar nor write the whole document
  // on every pointer tick. The change/pointer-up commits exactly once.
  const slider = page.getByTestId('image-width-slider')
  await slider.waitFor({ state: 'visible', timeout: 5_000 })
  assert.equal(await slider.inputValue(), '100')
  await slider.focus()
  const toolbar = slider.locator('xpath=ancestor::div[contains(@class,"selection-toolbar")]')
  const before = await toolbar.boundingBox()
  const previewAt = async (value) => {
    await slider.evaluate((element, nextValue) => {
      element.value = String(nextValue)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }, value)
    await page.waitForTimeout(40)
    return mdTwo.evaluate((image) => ({
      renderedWidth: image.getBoundingClientRect().width,
      styleWidth: image.style.width
    }))
  }

  const ninety = await previewAt(90)
  assert.match(ninety.styleWidth, /^min\(90%,\s*\d+(?:\.\d+)?px\)$/)
  assert.ok(ninety.renderedWidth < naturalBaseline.renderedWidth, JSON.stringify({ naturalBaseline, ninety }))
  assert.ok(Math.abs(ninety.renderedWidth - naturalBaseline.renderedWidth * 0.9) < 2, JSON.stringify({ naturalBaseline, ninety }))

  const hundred = await previewAt(100)
  assert.match(hundred.styleWidth, /^min\(100%,\s*\d+(?:\.\d+)?px\)$/)
  assert.ok(Math.abs(hundred.renderedWidth - naturalBaseline.renderedWidth) < 2, JSON.stringify({ naturalBaseline, hundred }))

  const sixtyFive = await previewAt(65)
  await page.waitForTimeout(280)
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'image-width-slider')
  assert.match(sixtyFive.styleWidth, /^min\(65%,\s*\d+(?:\.\d+)?px\)$/)
  assert.ok(Math.abs(sixtyFive.renderedWidth - naturalBaseline.renderedWidth * 0.65) < 2, JSON.stringify({ naturalBaseline, sixtyFive }))
  const during = await toolbar.boundingBox()
  assert.ok(before && during)
  assert.ok(Math.abs(before.x - during.x) < 1 && Math.abs(before.y - during.y) < 1, JSON.stringify({ before, during }))
  assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /data-knote-scale="65"|width:min\(65%/)

  await slider.evaluate((element) => element.dispatchEvent(new Event('change', { bubbles: true })))
  await waitUntil(
    () => /data-knote-scale="65"/.test(fs.readFileSync(target, 'utf8')),
    { message: 'the committed natural-size scale was not saved' }
  )
  disk = fs.readFileSync(target, 'utf8')
  assert.match(disk, /src="two\.png"[^>]*title="Title two"[^>]*data-knote-scale="65"[^>]*data-knote-intrinsic-width="406"/i, disk)
  assert.match(disk, /width:min\(65%,263\.9px\)/, disk)
  assert.doesNotMatch(disk, /width:65%;|knote-img:|data:image/i, disk)
  // Physical pointer drag regression: keep sampling the actual toolbar rect
  // while the mouse button is held. The document must not change before
  // release, then exactly one distinct persisted state may appear.
  const sliderBox = await slider.boundingBox()
  assert.ok(sliderBox)
  const initialDragDisk = fs.readFileSync(target, 'utf8')
  const observedDiskStates = new Set([initialDragDisk])
  const diskPoll = setInterval(() => {
    try { observedDiskStates.add(fs.readFileSync(target, 'utf8')) } catch { /* atomic replace window */ }
  }, 8)
  t.after(() => clearInterval(diskPoll))
  await page.evaluate(() => {
    const slider = document.querySelector('[data-testid="image-width-slider"]')
    const toolbar = slider?.closest('.selection-toolbar')
    window.__knoteToolbarSamples = []
    window.__knoteToolbarSampling = true
    const sample = () => {
      if (!window.__knoteToolbarSampling || !toolbar) return
      const rect = toolbar.getBoundingClientRect()
      window.__knoteToolbarSamples.push({ x: rect.x, y: rect.y })
      requestAnimationFrame(sample)
    }
    sample()
  })
  const y = sliderBox.y + sliderBox.height / 2
  const startX = sliderBox.x + sliderBox.width * ((65 - 10) / 90)
  const endX = sliderBox.x + sliderBox.width * ((40 - 10) / 90)
  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(endX, y, { steps: 28 })
  await page.waitForTimeout(250)
  assert.equal(fs.readFileSync(target, 'utf8'), initialDragDisk, 'range input wrote the document before pointer-up')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'image-width-slider')
  const dragValue = Number(await slider.inputValue())
  t.diagnostic(`native range coordinates ${JSON.stringify({ sliderBox, startX, endX, dragValue })}`)
  assert.notEqual(dragValue, 65, 'the native pointer drag did not move the range thumb')
  await page.mouse.up()
  await waitUntil(
    () => new RegExp(`src="two\\.png"[^>]*data-knote-scale="${dragValue}"`, 'i').test(fs.readFileSync(target, 'utf8')),
    { message: `native pointer-up did not persist the previewed ${dragValue}% natural-size scale` }
  )
  const draggedImage = await mdTwo.evaluate((image) => ({
    renderedWidth: image.getBoundingClientRect().width,
    styleWidth: image.style.width
  }))
  assert.match(draggedImage.styleWidth, new RegExp(`^min\\(${dragValue}%,\\s*\\d+(?:\\.\\d+)?px\\)$`))
  assert.ok(
    Math.abs(draggedImage.renderedWidth - naturalBaseline.renderedWidth * dragValue / 100) < 2,
    JSON.stringify({ naturalBaseline, dragValue, draggedImage })
  )
  await page.waitForTimeout(250)
  clearInterval(diskPoll)
  const toolbarMotion = await page.evaluate(() => {
    window.__knoteToolbarSampling = false
    const rows = window.__knoteToolbarSamples || []
    const first = rows[0] || { x: 0, y: 0 }
    return {
      samples: rows.length,
      maxDisplacement: rows.reduce((max, row) => Math.max(max, Math.hypot(row.x - first.x, row.y - first.y)), 0)
    }
  })
  assert.ok(toolbarMotion.samples > 2, JSON.stringify(toolbarMotion))
  assert.ok(toolbarMotion.maxDisplacement < 1, JSON.stringify(toolbarMotion))
  assert.equal(observedDiskStates.size - 1, 1, `unexpected distinct writes: ${observedDiskStates.size - 1}`)
  t.diagnostic(`native width drag ${JSON.stringify({ dragValue, toolbarMotion, distinctWrites: observedDiskStates.size - 1 })}`)

  const htmlOne = editor.locator('img[alt="html-one"]').first()
  await htmlOne.click({ force: true })
  await waitUntil(
    () => editor.locator('img.ProseMirror-selectednode[alt="html-one"]').count().then(Boolean),
    { timeout: 5_000, message: 'the second native image click selected a different node' }
  )
  await page.getByTestId('image-align-right').click()
  await waitUntil(
    () => /alt="html-one"[^>]*style="[^"]*width:40%;[^"]*margin-left:auto/i.test(fs.readFileSync(target, 'utf8')),
    { message: 'right alignment was not saved' }
  )

  await page.reload({ waitUntil: 'commit', timeout: 90_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
  const reloaded = page.locator('.ProseMirror img[alt="md-two"]').first()
  await reloaded.waitFor({ state: 'visible', timeout: 10_000 })
  await waitUntil(
    () => reloaded.evaluate((image) => image.complete && image.naturalWidth > 0),
    { message: 'the aligned image broke after renderer reload' }
  )
  const reloadedState = await reloaded.evaluate((image) => ({
    width: image.style.width,
    renderedWidth: image.getBoundingClientRect().width,
    marginLeft: image.style.marginLeft,
    marginRight: image.style.marginRight,
    title: image.getAttribute('title'),
    scale: image.getAttribute('data-knote-scale'),
    intrinsicWidth: image.getAttribute('data-knote-intrinsic-width')
  }))
  assert.match(reloadedState.width, new RegExp(`^min\\(${dragValue}%,\\s*\\d+(?:\\.\\d+)?px\\)$`))
  assert.ok(
    Math.abs(reloadedState.renderedWidth - naturalBaseline.renderedWidth * dragValue / 100) < 2,
    JSON.stringify({ naturalBaseline, dragValue, reloadedState })
  )
  assert.equal(reloadedState.marginLeft, 'auto')
  assert.equal(reloadedState.marginRight, 'auto')
  assert.equal(reloadedState.title, 'Title two')
  assert.equal(reloadedState.scale, String(dragValue))
  assert.equal(Number(reloadedState.intrinsicWidth), naturalBaseline.naturalWidth)

  const rightReloaded = page.locator('.ProseMirror img[alt="html-one"]').first()
  await waitUntil(
    () => rightReloaded.evaluate((image) => image.complete && image.naturalWidth > 0),
    { message: 'the right-aligned image broke after renderer reload' }
  )
  assert.deepEqual(await rightReloaded.evaluate((image) => ({
    width: image.style.width,
    marginLeft: image.style.marginLeft,
    marginRight: image.style.marginRight,
    title: image.getAttribute('title')
  })), {
    width: '40%',
    marginLeft: 'auto',
    marginRight: '',
    title: 'HTML title'
  })
  t.diagnostic(`image markdown after reload: ${fs.readFileSync(target, 'utf8')}`)
})
