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
  const launchApplication = async ({ initializeProfile = false } = {}) => {
    const applicationPath = String(process.env.KNOTE_E2E_APP || '.').trim() || '.'
    application = await electron.launch({
      args: ['--no-proxy-server', '--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND,MAP fonts.gstatic.com ~NOTFOUND', applicationPath, workspace],
      cwd: repoRoot,
      env: {
        ...process.env,
        KNOTE_E2E: '1',
        KNOTE_E2E_USER_DATA: userData
      },
      timeout: 90_000
    })
    assert.match(await application.evaluate(({ app }) => app.commandLine.getSwitchValue('host-resolver-rules')), /fonts\.googleapis\.com/)
    assert.equal(await application.evaluate(({ app }) => app.commandLine.hasSwitch('no-proxy-server')), true)
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), userData, 'native tests must use their disposable profile')
    application.process().stdout?.on('data', (chunk) => rememberLog('stdout: ', chunk))
    application.process().stderr?.on('data', (chunk) => rememberLog('stderr: ', chunk))
    const page = await application.firstWindow({ timeout: 90_000 })
    page.on('crash', () => { targetCrashed = true })
    page.on('pageerror', (error) => rememberLog('pageerror: ', error?.stack || error?.message || error))
    await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
    if (initializeProfile) {
      await page.evaluate(() => localStorage.setItem('knote-onboarding-complete-v1', '1'))
      await page.reload({ waitUntil: 'commit', timeout: 90_000 })
      await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
    }
    return page
  }

  try {
    const page = await launchApplication({ initializeProfile: true })
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
    const restart = async () => {
      await closeElectron(application)
      application = null
      return launchApplication()
    }
    return { application, page, workspace, restart }
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

test('block insert table flyout preserves menu width and scroll layout and inserts the chosen size', async t => {
  const { page, workspace } = await launchEditor(t, { 'insert.md': 'Start\n\n\n\nEnd\n' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, 'insert.md'))
  const editor = page.locator('.ProseMirror').first()
  await editor.waitFor({ state: 'visible' })
  await editor.evaluate(el => {
    let position
    el.editor.state.doc.forEach((node, pos) => { if (position == null && node.type.name === 'paragraph' && !node.content.size) position = pos + 1 })
    if (position == null) throw Error('Missing blank row fixture')
    el.editor.commands.setTextSelection(position)
    el.editor.commands.focus(undefined, { scrollIntoView: false })
  })
  await page.locator('.knote-gutter button').click()
  const menu = page.getByTestId('block-insert-menu'), trigger = page.getByTestId('table-picker-trigger')
  await trigger.scrollIntoViewIfNeeded()
  const before = await menu.evaluate(el => ({ width: el.clientWidth, height: el.scrollHeight, text: [...el.querySelectorAll('span')].map(n => n.getBoundingClientRect().width), rootWidth: document.documentElement.scrollWidth }))
  await trigger.click()
  const picker = page.getByTestId('table-size-picker')
  await picker.waitFor({ state: 'visible' })
  const samples = await menu.evaluate(async el => {
    const samples = []
    for (let i = 0; i < 8; i++) {
      await new Promise(requestAnimationFrame)
      samples.push({ width: el.clientWidth, height: el.scrollHeight, text: [...el.querySelectorAll('span')].map(n => n.getBoundingClientRect().width), rootWidth: document.documentElement.scrollWidth, scrollbar: getComputedStyle(el).scrollbarWidth })
    }
    return samples
  })
  for (const { scrollbar, ...sample } of samples) { assert.deepEqual(sample, before); assert.equal(scrollbar, 'none') }
  assert.equal(await picker.getAttribute('data-side'), 'right')
  const triggerBox = await trigger.boundingBox(), pickerBox = await picker.boundingBox()
  assert.ok(pickerBox.x >= triggerBox.x + triggerBox.width)
  await page.screenshot({ path: path.join(repoRoot, 'docs', 'screenshots', 'table-insert-flyout-1.1.90.png') })
  await page.keyboard.press('Escape')
  await picker.waitFor({ state: 'detached' })
  assert.equal(await menu.isVisible(), true)
  await trigger.click()
  await picker.locator('button').nth(10).hover()
  await picker.locator('button').nth(10).click()
  await menu.waitFor({ state: 'detached' })
  assert.equal(await editor.locator('table tr').count(), 2)
  assert.equal(await editor.locator('table tr').first().locator('th,td').count(), 3)
})

test('selection toolbar stays in the visible viewport while scrolling and formatting does not jump back', async t => {
  const source = Array.from({ length: 180 }, (_, i) => `TOOLBAR_ROW_${i} some ordinary selectable paragraph text.`).join('\n\n') + '\n'
  const { page, workspace } = await launchEditor(t, { 'toolbar.md': source })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, 'toolbar.md'))
  const editor = page.locator('.ProseMirror').first(), row = editor.locator('p').filter({ hasText: 'TOOLBAR_ROW_20 ' })
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await editor.evaluate(el => {
    let from
    el.editor.state.doc.descendants((node, pos) => { if (node.isText && node.text.startsWith('TOOLBAR_ROW_20 ')) from = pos })
    el.editor.commands.setTextSelection({ from, to: from + 14 })
  })
  const toolbar = page.getByTestId('text-selection-toolbar')
  await toolbar.waitFor({ state: 'visible' })
  const selection = await editor.evaluate(el => el.editor.state.selection.toJSON())
  const assertInView = async () => {
    const box = await toolbar.boundingBox()
    assert.ok(box && box.y >= 0 && box.y + box.height <= 901, JSON.stringify(box))
    assert.ok(box.x >= 0 && box.x + box.width <= 1441, JSON.stringify(box))
    assert.deepEqual(await editor.evaluate(el => el.editor.state.selection.toJSON()), selection)
  }
  await page.mouse.move(1100, 700)
  await page.mouse.wheel(0, 1100)
  await page.waitForTimeout(150)
  await assertInView()
  await page.screenshot({ path: path.join(repoRoot, 'docs', 'screenshots', 'selection-toolbar-docked-1.1.90.png') })
  const before = await page.locator('.knote-root').evaluate(el => el.scrollTop)
  await toolbar.locator('button').first().click()
  await page.waitForTimeout(180)
  assert.ok(Math.abs(await page.locator('.knote-root').evaluate(el => el.scrollTop) - before) < 5, 'formatting a docked selection must not scroll back to its anchor')
  assert.equal(await editor.evaluate(el => el.editor.isActive('bold')), true)
  await page.mouse.wheel(0, -1800)
  await page.waitForTimeout(150)
  await assertInView()
  await page.setViewportSize({ width: 1100, height: 700 })
  await page.waitForTimeout(150)
  const resized = await toolbar.boundingBox()
  assert.ok(resized.y >= 0 && resized.y + resized.height <= 701)
})

test('selection toolbar stretches its formatting controls in English and Chinese without a blank color tail', async t => {
  const { page, workspace } = await launchEditor(t, { 'toolbar-locales.md': 'A paragraph to select for toolbar layout.\n' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, 'toolbar-locales.md'))
  const editor = page.locator('.ProseMirror').first()
  await editor.click()
  await editor.evaluate(el => el.editor.commands.setTextSelection({ from: 1, to: 12 }))
  const toolbar = page.getByTestId('text-selection-toolbar')
  await toolbar.waitFor({ state: 'visible' })
  for (const locale of ['en', 'zh']) {
    await page.locator('.knote-language-action').first().click()
    await waitUntil(async () => (await toolbar.innerText()).includes(locale === 'en' ? 'Condense' : '精简'))
    const geometry = await toolbar.evaluate(el => {
      const row = el.querySelector('.knote-selection-format-row'), children = [...row.children]
      const r = row.getBoundingClientRect(), last = children.at(-1), trigger = last.querySelector('[role="button"]')
      return { width: el.getBoundingClientRect().width, right: r.right, lastRight: last.getBoundingClientRect().right, buttonRight: trigger.getBoundingClientRect().right, slots: children.length, left: r.left, firstLeft: children[0].getBoundingClientRect().left }
    })
    assert.equal(geometry.slots, 8)
    assert.ok(Math.abs(geometry.right - geometry.lastRight) < 1 && Math.abs(geometry.right - geometry.buttonRight) < 1, JSON.stringify(geometry))
    assert.ok(Math.abs(geometry.left - geometry.firstLeft) < 1)
    await toolbar.locator('.dropdown-end > [role="button"]').hover()
    const palette = toolbar.locator('.dropdown-end > .dropdown-content')
    await palette.waitFor({ state: 'visible' })
    const box = await palette.boundingBox(), outer = await toolbar.boundingBox()
    assert.ok(Math.abs(box.x + box.width - outer.x - outer.width) < 2, JSON.stringify({ box, outer }))
    assert.ok(Math.abs(outer.width - geometry.width) < 1)
    await page.mouse.move(1100, 700)
    await page.waitForTimeout(250)
    await toolbar.screenshot({ path: path.join(repoRoot, 'docs', 'screenshots', `selection-toolbar-${locale}-1.1.91.png`) })
  }
})

test('selection toolbar follows the local long-document scroll viewport without changing its range', async t => {
  const source = Array.from({ length: 800 }, (_, i) => `LOCAL_TOOLBAR_${String(i).padStart(3, '0')} paragraph for testing local long document scroll geometry.`).join('\n\n') + '\n'
  const { page, workspace } = await launchEditor(t, { 'local-toolbar.md': source })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, 'local-toolbar.md'))
  const editor = page.getByTestId('large-document-rich-chunk').locator('.ProseMirror')
  await editor.waitFor({ state: 'visible' })
  await editor.locator('p').filter({ hasText: 'LOCAL_TOOLBAR_080 ' }).click()
  const initial = await editor.evaluate(el => {
    const from = el.editor.state.selection.$from.start()
    el.editor.commands.setTextSelection({ from, to: from + 12 })
    return el.editor.state.selection.toJSON()
  })
  const toolbar = page.getByTestId('text-selection-toolbar')
  await toolbar.waitFor({ state: 'visible' })
  const scroller = editor.locator('xpath=ancestor::*[contains(@class,"knote-doc-scroll")]').first()
  for (const delta of [1200, -2000]) {
    await scroller.evaluate((el, delta) => el.scrollBy(0, delta), delta)
    await page.waitForTimeout(180)
    const clip = await scroller.boundingBox(), box = await toolbar.boundingBox()
    assert.ok(box.y >= Math.max(0, clip.y) && box.y + box.height <= Math.min(900, clip.y + clip.height) + 1, JSON.stringify({ clip, box }))
    assert.deepEqual(await editor.evaluate(el => el.editor.state.selection.toJSON()), initial)
  }
})

test('table editing single clicks, rectangle gestures, clipboard, clear and undo preserve Markdown tables', async t => {
  const source = '# Table editing\n\nOutside paragraph.\n\n| Head A | Head B | Head C |\n| --- | :---: | ---: |\n| Alpha | Bravo | Charlie |\n| Delta | Echo | Foxtrot |\n| Golf | Hotel | India |\n\nAfter table.\n'
  const { application, page, workspace, restart } = await launchEditor(t, { 'table.md': source })
  await page.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, 'table.md'))
  let editor = page.locator('.ProseMirror').first()
  const cell = (row, col) => editor.locator('tr').nth(row).locator('th,td').nth(col)
  await cell(1, 0).click()
  await waitUntil(async () => await cell(1, 0).evaluate(el => el.classList.contains('knote-active-cell')))
  await page.keyboard.press('End')
  await page.keyboard.type('_EDIT')
  assert.equal(await cell(1, 0).innerText(), 'Alpha_EDIT', 'one text click must immediately allow typing')
  await page.keyboard.press('Control+z')
  await waitUntil(async () => (await cell(1, 0).innerText()) === 'Alpha')
  await page.keyboard.press('Tab')
  await waitUntil(async () => await cell(1, 1).evaluate(el => el.classList.contains('knote-active-cell')))
  await page.keyboard.press('Shift+Tab')
  await waitUntil(async () => await cell(1, 0).evaluate(el => el.classList.contains('knote-active-cell')))

  // Padding inside the cell must focus its own text, not the preceding row.
  let box = await cell(2, 2).boundingBox()
  await page.mouse.click(box.x + box.width - 8, box.y + box.height - 5)
  assert.equal(await editor.evaluate(el => el.editor.state.selection.$head.parent.textContent), 'Foxtrot')

  const before = await editor.evaluate(el => el.editor.getJSON())
  const from = await cell(1, 0).boundingBox(), to = await cell(2, 1).boundingBox()
  await page.mouse.move(from.x + 12, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + 30, to.y + to.height / 2, { steps: 18 })
  await page.mouse.up()
  await waitUntil(async () => await editor.locator('.selectedCell').count() === 4, { message: 'real cell drag must select a rectangle' })
  await editor.screenshot({ path: path.join(repoRoot, 'docs/reviews/2026-10-17/table-editing-1.1.87.png') })
  await page.mouse.move(to.x + 50, to.y + to.height + 30)
  assert.equal(await editor.locator('.selectedCell').count(), 4, 'mouse release must freeze rectangle')
  const clipboard = await editor.evaluate(el => {
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() })
    el.dispatchEvent(event)
    return { text: event.clipboardData.getData('text/plain'), html: event.clipboardData.getData('text/html'), prevented: event.defaultPrevented }
  })
  assert.equal(clipboard.text, 'Alpha\tBravo\nDelta\tEcho')
  assert.match(clipboard.html, /<table/)
  assert.equal(clipboard.prevented, true)
  const previousClipboard = await application.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage().toDataURL() }))
  try {
    await page.keyboard.press('Control+c')
    const nativeClipboard = await application.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }))
    assert.equal(nativeClipboard.text.replace(/\r\n/g, '\n'), 'Alpha\tBravo\nDelta\tEcho')
    assert.match(nativeClipboard.html, /<table/)
    await page.keyboard.press('Control+x')
    assert.equal(await cell(1, 0).textContent(), '')
    assert.equal(await editor.locator('tr').count(), 4, 'native cut must not remove table structure')
    await page.keyboard.press('Control+z')
    await waitUntil(async () => JSON.stringify(await editor.evaluate(el => el.editor.getJSON())) === JSON.stringify(before))
  } finally {
    await application.evaluate(({ clipboard, nativeImage }, value) => {
      const { image, ...text } = value
      const restoredImage = nativeImage.createFromDataURL(image)
      clipboard.write({ ...text, ...(!restoredImage.isEmpty() ? { image: restoredImage } : {}) })
    }, previousClipboard)
  }
  await page.keyboard.press('Delete')
  assert.equal(await editor.locator('tr').count(), 4)
  assert.equal(await cell(1, 0).textContent(), '')
  assert.equal(await cell(2, 1).textContent(), '')
  assert.equal(await cell(2, 2).innerText(), 'Foxtrot')
  await cell(1, 0).click()
  await page.keyboard.type('EmptyCellEdit')
  const emptyCellText = await cell(1, 0).innerText()
  if (emptyCellText !== 'EmptyCellEdit') t.diagnostic('cleared cell failure ' + JSON.stringify(await editor.evaluate(el => {
    const cell = el.querySelectorAll('tr')[1].querySelector('td'), r = cell.getBoundingClientRect()
    return { selection: el.editor.state.selection.toJSON(), focus: document.activeElement?.outerHTML?.slice(0, 200), text: el.textContent, hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.outerHTML?.slice(0, 300), dom: cell.outerHTML }
  })))
  assert.equal(emptyCellText, 'EmptyCellEdit', 'a cleared empty cell must immediately accept text')
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await waitUntil(async () => JSON.stringify(await editor.evaluate(el => el.editor.getJSON())) === JSON.stringify(before), { message: 'one undo must restore the entire selected rectangle' })

  // Band creates a single-cell selection; Shift-click extends it.
  box = await cell(1, 0).boundingBox()
  await page.mouse.click(box.x + 3, box.y + box.height / 2)
  await waitUntil(async () => await editor.locator('.selectedCell').count() === 1)
  await page.keyboard.down('Shift')
  await cell(3, 2).click()
  await page.keyboard.up('Shift')
  await waitUntil(async () => await editor.locator('.selectedCell').count() === 9)
  await page.keyboard.press('Escape')
  assert.equal(await editor.locator('.selectedCell').count(), 0)
  box = await cell(0, 0).boundingBox()
  await page.mouse.click(box.x + 3, box.y + box.height / 2)
  await page.keyboard.down('Shift')
  await cell(3, 2).click()
  await page.keyboard.up('Shift')
  await waitUntil(async () => await editor.locator('.selectedCell').count() === 12)
  await page.keyboard.press('Backspace')
  assert.equal(await editor.locator('table').count(), 1, 'clearing every selected cell must not trigger TipTap delete-table shortcut')
  assert.equal(await editor.locator('tr').count(), 4)
  await page.keyboard.press('Control+z')
  await waitUntil(async () => (await cell(1, 0).innerText()) === 'Alpha')
  await cell(1, 0).click()
  await page.keyboard.press('End')
  await page.keyboard.type('_SAVED')
  await page.keyboard.press('Control+s')
  await waitUntil(() => fs.readFileSync(path.join(workspace, 'table.md'), 'utf8').includes('Alpha_SAVED'))
  const saved = fs.readFileSync(path.join(workspace, 'table.md'), 'utf8')
  assert.match(saved, /\| Alpha_SAVED \|/)
  assert.doesNotMatch(saved, /knote-active-cell|selectedCell|<table/)
  const reopened = await restart()
  await reopened.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, 'table.md'))
  editor = reopened.locator('.ProseMirror').first()
  await waitUntil(async () => (await editor.innerText()).includes('Alpha_SAVED'))
  assert.equal(await editor.locator('tr').count(), 4)
})

test('table editing preserves native within-cell text selection and stops edge scrolling on release or document switch', async t => {
  const source = '# Table scrolling\n\n| A | B |\n| --- | --- |\n' + Array.from({ length: 85 }, (_, i) => `| ROW_${i.toString().padStart(2, '0')}_TEXT | VALUE_${i} |`).join('\n') + '\n\nAfter table.\n'
  const { page, workspace } = await launchEditor(t, { 'long-table.md': source, 'other.md': '# Other\n\nOther document.\n' })
  await page.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, 'long-table.md'))
  const editor = page.locator('.ProseMirror').first()
  const first = editor.locator('td').first()
  await first.click()
  await page.keyboard.press('Home')
  const points = await first.evaluate(el => {
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
    const range = document.createRange()
    const at = n => { range.setStart(node, n); range.setEnd(node, n + 1); const r = range.getBoundingClientRect(); return { x: r.x + 1, y: r.y + r.height / 2 } }
    return [at(1), at(7)]
  })
  await page.mouse.move(points[0].x, points[0].y)
  await page.mouse.down()
  await page.mouse.move(points[1].x, points[1].y, { steps: 12 })
  await page.mouse.up()
  assert.equal(await editor.locator('.selectedCell').count(), 0)
  assert.ok(await editor.evaluate(el => !el.editor.state.selection.empty && el.editor.state.selection.toJSON().type === 'text'))

  const box = await first.boundingBox()
  const viewport = await editor.evaluate(el => {
    let node = el.parentElement
    while (node.parentElement && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement
    window.__tableTestScroller = node
    const r = node.getBoundingClientRect()
    return { top: Math.max(0, r.top), bottom: Math.min(innerHeight, r.bottom), initial: node.scrollTop }
  })
  await page.mouse.move(box.x + 3, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 30, viewport.bottom - 7, { steps: 20 })
  await waitUntil(async () => await page.evaluate(() => window.__tableTestScroller.scrollTop) > viewport.initial + 40, { message: 'active rectangular drag near viewport edge should scroll' })
  await page.mouse.up()
  const stopped = await page.evaluate(() => window.__tableTestScroller.scrollTop)
  await page.waitForTimeout(350)
  assert.equal(await page.evaluate(() => window.__tableTestScroller.scrollTop), stopped)
  const visible = await editor.locator('td').evaluateAll(cells => {
    for (const cell of cells) {
      const r = cell.getBoundingClientRect()
      if (r.top > 120 && r.bottom < innerHeight - 90) return { x: r.x + 3, y: r.y + r.height / 2 }
    }
    throw Error('no visible cell for the interrupted-drag test')
  })
  await page.mouse.move(visible.x, visible.y)
  await page.mouse.down()
  await page.mouse.move(visible.x + 30, viewport.bottom - 7, { steps: 12 })
  await waitUntil(async () => await page.evaluate(() => window.__tableTestScroller.scrollTop) > stopped + 20)
  await page.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, 'other.md'))
  await waitUntil(async () => (await editor.innerText()).includes('Other document'))
  assert.equal(await editor.locator('.selectedCell,.knote-active-cell').count(), 0)
  const switched = await page.evaluate(() => document.querySelector('.knote-root').scrollTop)
  await page.waitForTimeout(350)
  assert.equal(await page.evaluate(() => document.querySelector('.knote-root').scrollTop), switched, 'switching documents during drag must stop the previous table scroll loop')
  await page.mouse.up()
})

test('table editing hover uses approved bright lemon and corner selections follow the rounded table', async t => {
  const { page, workspace } = await launchEditor(t, { 'table-visuals.md': '# Table visuals\n\n| A | B | C |\n| --- | --- | --- |\n| Alpha | Bravo | Charlie |\n| Delta | Echo | Foxtrot |\n\nOutside table.\n\n- **Jacobian lens（雅可比透镜，简称 J-lens）** 是论文提出的新可解释性技术，目标是找出**“随时可以被说出来”**的内部表征。\n- 对词表里的每一个 token，J-lens 都会找到一个向量，表示**“模型此刻更倾向于在未来某个时刻说出这个词”**。\n' })
  await page.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, 'table-visuals.md'))
  const editor = page.locator('.ProseMirror').first()
  const cell = (row, col) => editor.locator('tr').nth(row).locator('th,td').nth(col)
  const initial = await editor.evaluate(el => el.editor.getJSON())
  for (const theme of ['light', 'dark']) {
    await page.getByTestId('theme-menu').click()
    await page.getByTestId(`theme-${theme}`).click()
    for (const [row, col, corner] of [[0, 0, 'borderTopLeftRadius'], [0, 2, 'borderTopRightRadius'], [2, 0, 'borderBottomLeftRadius'], [2, 2, 'borderBottomRightRadius']]) {
      const box = await cell(row, col).boundingBox()
      await page.mouse.click(box.x + 3, box.y + box.height / 2)
      const style = await cell(row, col).evaluate((el, corner) => ({ selected: el.classList.contains('selectedCell'), radius: parseFloat(getComputedStyle(el)[corner]), shadow: getComputedStyle(el).boxShadow }), corner)
      assert.equal(style.selected, true)
      assert.ok(style.radius >= 10, `${theme}/${corner} must follow the table's rounded silhouette`)
      assert.notEqual(style.shadow, 'none')
    }
    const box = await cell(0, 0).boundingBox()
    await page.mouse.click(box.x + 3, box.y + box.height / 2)
    const hovered = cell(1, 1)
    await hovered.hover()
    const colors = await hovered.evaluate((el, theme) => {
      const probe = document.createElement('span')
      probe.style.backgroundColor = theme === 'light' ? '#fffdb3' : 'color-mix(in srgb, #fffdb3 18%, var(--color-base-100, #1d232a))'
      el.closest('.knote-rich').appendChild(probe)
      const actual = getComputedStyle(el).backgroundColor, expected = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { actual, expected, radius: getComputedStyle(el).borderTopLeftRadius }
    }, theme)
    assert.equal(colors.actual, colors.expected)
    if (theme === 'light') assert.equal(colors.actual, 'rgb(255, 253, 179)', 'use the exact approved swatch, not another yellow mixture')
    assert.notEqual(colors.actual, 'rgba(0, 0, 0, 0)', 'matching transparent/invalid colors is not a working hover effect')
    assert.equal(parseFloat(colors.radius), 0, 'internal cell corners stay square')
    assert.equal(await editor.locator('.selectedCell').count(), 1, 'hover must not change the selected cell')
    await editor.locator('.tableWrapper').first().screenshot({ path: path.join(repoRoot, `docs/reviews/2026-10-18/table-hover-1.1.89-${theme}.png`) })
  }
  const quoted = editor.locator('li').filter({ hasText: '随时可以被说出来' })
  assert.equal(await quoted.locator('strong').count(), 2)
  assert.equal(await quoted.locator('strong').last().innerText(), '“随时可以被说出来”')
  assert.equal(await editor.locator('strong').filter({ hasText: '模型此刻更倾向于' }).count(), 1)
  assert.deepEqual(await editor.evaluate(el => el.editor.getJSON()), initial, 'hover and corner decorations must not dirty the table')
})

test('native selected text drag is cancelled while block handles and input editing stay usable', async t => {
  const source = '# Native drag interactions\n\nALPHA_SELECTED_TEXT stays in its original paragraph.\n\nDROP_TARGET stays separate.\n'
  const { page, workspace } = await launchEditor(t, { 'text-drag.md': source })
  await page.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, 'text-drag.md'))
  const editor = page.locator('.ProseMirror').first()
  const paragraph = editor.locator('p').filter({ hasText: /^ALPHA_SELECTED_TEXT/ })
  await paragraph.click()
  await page.keyboard.press('Home')
  await page.keyboard.down('Shift')
  await page.keyboard.press('End')
  await page.keyboard.up('Shift')
  const originalText = await editor.innerText()
  const point = await paragraph.evaluate(element => {
    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()
    const range = document.createRange()
    range.setStart(text, 2)
    range.setEnd(text, 7)
    const rect = range.getBoundingClientRect()
    window.__nativeTextDragEvents = []
    document.addEventListener('dragstart', event => window.__nativeTextDragEvents.push({ prevented: event.defaultPrevented, target: event.target.tagName }))
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  const drop = await editor.locator('p').filter({ hasText: /^DROP_TARGET/ }).boundingBox()
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.waitForTimeout(250)
  await page.mouse.move(drop.x + 80, drop.y + drop.height / 2, { steps: 24 })
  await page.waitForTimeout(100)
  await page.mouse.up()
  assert.equal(await editor.innerText(), originalText)
  assert.ok((await page.evaluate(() => window.__nativeTextDragEvents)).some(event => event.prevented), 'a real native text dragstart must have been cancelled')

  // Exercise the actual block-handle event handler with a real DataTransfer;
  // it must still arm ProseMirror's move slice, without moving a user file.
  await paragraph.click()
  const handle = page.locator('.knote-gutter button[draggable="true"]').first()
  await handle.waitFor({ state: 'visible' })
  const blockDrag = await handle.evaluate(element => {
    const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })
    element.dispatchEvent(event)
    const view = document.querySelector('.ProseMirror').editor.view
    const result = { prevented: event.defaultPrevented, armed: Boolean(view.dragging?.move && view.dragging.slice), node: view.state.selection.node?.type.name }
    view.dragging = null
    return result
  })
  assert.deepEqual(blockDrag, { prevented: false, armed: true, node: 'paragraph' })
  await paragraph.click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' STILL_EDITABLE')
  assert.match(await paragraph.innerText(), /STILL_EDITABLE$/)

  await page.getByTestId('view-split').click()
  const input = page.getByTestId('markdown-source-editor')
  const blocked = await input.evaluate(element => {
    element.focus()
    element.setSelectionRange(2, 8)
    const before = element.value
    const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })
    element.dispatchEvent(event)
    return { prevented: event.defaultPrevented, unchanged: element.value === before }
  })
  assert.deepEqual(blocked, { prevented: true, unchanged: true })
})

test('selection scrolling keeps a clicked rich-text row and a dragged range at the current viewport', async t => {
  const source = Array.from({ length: 240 }, (_, index) => `ROW_${String(index).padStart(3, '0')} ordinary paragraph text for selection and scroll regression.`).join('\n\n') + '\n'
  const { page, workspace } = await launchEditor(t, { 'scroll.md': source })
  await page.setViewportSize({ width: 1440, height: 900 })
  assert.equal(await page.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, 'scroll.md')), true)
  const editor = page.locator('.ProseMirror').first()
  await editor.locator('p').filter({ hasText: 'ROW_000' }).click()
  await page.evaluate(() => {
    const root = document.querySelector('.knote-root')
    window.__selectionScrollTrace = []
    root.addEventListener('scroll', () => window.__selectionScrollTrace.push({ at: performance.now(), top: root.scrollTop, focus: document.activeElement?.className, selection: window.getSelection()?.toString().length }), { passive: true })
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
    Object.defineProperty(Element.prototype, 'scrollTop', { ...descriptor, set(value) {
      window.__selectionScrollTrace.push({ set: value, target: this.className, stack: new Error().stack })
      descriptor.set.call(this, value)
    } })
    const focus = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function(...args) {
      window.__selectionScrollTrace.push({ focusCall: this.className, args, stack: new Error().stack })
      return focus.apply(this, args)
    }
  })
  const target = editor.locator('p').filter({ hasText: 'ROW_080' })
  await target.scrollIntoViewIfNeeded()
  await page.waitForTimeout(120)
  const initialTop = await page.locator('.knote-root').evaluate(element => element.scrollTop)
  const box = await target.boundingBox()
  await page.mouse.click(box.x + 35, box.y + Math.min(15, box.height / 2))
  await page.waitForTimeout(350)
  const afterClick = await page.locator('.knote-root').evaluate(element => element.scrollTop)
  const clickedRow = await editor.evaluate(element => element.editor.state.selection.$head.parent.textContent)
  t.diagnostic(JSON.stringify({ initialTop, afterClick, clickedRow, trace: await page.evaluate(() => window.__selectionScrollTrace) }))
  assert.match(clickedRow, /ROW_080/, 'a click must choose the current row, not the old caret')
  assert.ok(Math.abs(afterClick - initialTop) < 5, 'clicking a visible row jumped back to an old scroll position')

  await page.getByTestId('view-single').click()
  const distant = editor.locator('p').filter({ hasText: 'ROW_160' })
  await distant.scrollIntoViewIfNeeded()
  const blurredTop = await page.locator('.knote-root').evaluate(element => element.scrollTop)
  const distantBox = await distant.boundingBox()
  await page.mouse.click(distantBox.x + 35, distantBox.y + Math.min(15, distantBox.height / 2))
  await page.waitForTimeout(350)
  const refocusedTop = await page.locator('.knote-root').evaluate(element => element.scrollTop)
  const refocusedRow = await editor.evaluate(element => element.editor.state.selection.$head.parent.textContent)
  t.diagnostic(JSON.stringify({ blurredTop, refocusedTop, refocusedRow, trace: (await page.evaluate(() => window.__selectionScrollTrace)).slice(-12) }))
  assert.match(refocusedRow, /ROW_160/)
  assert.ok(Math.abs(refocusedTop - blurredTop) < 5, 'refocusing a visible row restored the old caret viewport')

  await target.scrollIntoViewIfNeeded()
  const start = await target.boundingBox()
  const x = start.x + 30, y = start.y + Math.min(12, start.height / 2)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 50, Math.min(850, y + 150), { steps: 12 })
  await page.mouse.wheel(0, 1200)
  await page.waitForTimeout(150)
  const lowerTop = await page.locator('.knote-root').evaluate(element => element.scrollTop)
  await page.mouse.move(x + 50, 790, { steps: 12 })
  await page.waitForTimeout(350)
  const duringDrag = await page.locator('.knote-root').evaluate(element => element.scrollTop)
  await page.mouse.up()
  await page.waitForTimeout(350)
  const afterDrag = await page.locator('.knote-root').evaluate(element => element.scrollTop)
  const selected = await page.evaluate(() => window.getSelection()?.toString() || '')
  t.diagnostic(JSON.stringify({ lowerTop, duringDrag, afterDrag, selectedLength: selected.length, trace: (await page.evaluate(() => window.__selectionScrollTrace)).slice(-20) }))
  assert.ok(lowerTop > initialTop + 500, 'fixture did not scroll while the pointer was held')
  assert.ok(duringDrag >= lowerTop - 5 && afterDrag >= lowerTop - 5, 'dragging a selection scrolled back to its anchor')
  assert.ok(selected.length > 400, 'dragging must keep an extended text range')

  await target.scrollIntoViewIfNeeded()
  const edgeStart = await target.boundingBox()
  await page.mouse.click(edgeStart.x + 15, edgeStart.y + 12)
  await page.mouse.move(edgeStart.x + 30, edgeStart.y + 12)
  await page.mouse.down()
  const edgeSamples = []
  for (let step = 0; step < 18; step++) {
    await page.mouse.move(edgeStart.x + 45, 898 - (step % 2))
    await page.waitForTimeout(100)
    edgeSamples.push(await page.locator('.knote-root').evaluate(element => element.scrollTop))
  }
  await page.mouse.up()
  t.diagnostic(JSON.stringify({ edgeSamples, trace: (await page.evaluate(() => window.__selectionScrollTrace)).slice(-20) }))
  assert.ok(edgeSamples.at(-1) > edgeSamples[0] + 100, 'dragging at the viewport edge must auto-scroll')
  assert.ok(edgeSamples.every((top, index) => index === 0 || top >= edgeSamples[index - 1] - 5), 'edge drag unexpectedly scrolled backwards')
})

test('selection scrolling keeps a new click when a long-document edit is committed', async t => {
  const source = Array.from({ length: 800 }, (_, index) => `LONG_ROW_${String(index).padStart(3, '0')} ordinary paragraph text for the pending structural edit regression.`).join('\n\n') + '\n'
  const { page, workspace } = await launchEditor(t, { 'long-scroll.md': source })
  await page.setViewportSize({ width: 1440, height: 900 })
  assert.equal(await page.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, 'long-scroll.md')), true)
  const editor = page.getByTestId('large-document-rich-chunk').locator('.ProseMirror')
  await editor.waitFor({ state: 'visible' })
  const origin = editor.locator('p').filter({ hasText: 'LONG_ROW_080' })
  await origin.click()
  await page.waitForTimeout(80)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('STRUCTURAL_EDIT_MUST_SURVIVE')
  const target = editor.locator('p').filter({ hasText: 'LONG_ROW_140' })
  await target.scrollIntoViewIfNeeded()
  const intended = await editor.evaluate(element => ({ root: document.querySelector('.knote-root').scrollTop, local: element.closest('.knote-doc-scroll').scrollTop, marker: element.textContent.indexOf('STRUCTURAL_EDIT_MUST_SURVIVE'), origin: element.textContent.indexOf('LONG_ROW_080'), next: element.textContent.indexOf('LONG_ROW_081') }))
  const box = await target.boundingBox()
  await page.mouse.click(box.x + 30, box.y + 12)
  await page.waitForTimeout(1500)
  const after = await editor.evaluate(element => ({ row: element.editor.view.state.selection.$head.parent.textContent, selection: element.editor.view.state.selection.toJSON(), root: document.querySelector('.knote-root').scrollTop, local: element.closest('.knote-doc-scroll').scrollTop, hasEdit: element.textContent.includes('STRUCTURAL_EDIT_MUST_SURVIVE') }))
  t.diagnostic(JSON.stringify({ intended, after }))
  assert.equal(after.hasEdit, true)
  assert.ok(intended.marker > intended.origin && intended.marker < intended.next, 'a chunk commit moved new typing to a stale caret')
  assert.match(after.row, /LONG_ROW_140/, 'a delayed chunk commit reset the user\'s newer click')
  assert.ok(Math.abs(after.root - intended.root) < 100 && Math.abs(after.local - intended.local) < 100, 'a chunk commit restored an old viewport after a newer click')

  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('SECOND_STRUCTURAL_EDIT')
  const dragStart = editor.locator('p').filter({ hasText: 'LONG_ROW_180' })
  await dragStart.scrollIntoViewIfNeeded()
  const start = await dragStart.boundingBox()
  await page.mouse.click(start.x + 10, start.y + 12)
  await page.mouse.move(start.x + 20, start.y + 12)
  await page.mouse.down()
  const samples = []
  for (let step = 0; step < 14; step++) {
    await page.mouse.move(start.x + 70, 898 - (step % 2))
    await page.waitForTimeout(100)
    samples.push(await page.locator('.knote-root').evaluate(element => element.scrollTop))
  }
  await page.mouse.up()
  await page.waitForTimeout(50)
  const range = await editor.evaluate(element => element.editor.view.state.selection.toJSON())
  t.diagnostic(JSON.stringify({ samples, range }))
  assert.ok(samples.at(-1) > samples[0] + 100)
  assert.ok(samples.every((top, index) => index === 0 || top >= samples[index - 1] - 5), 'idle commit pulled an active drag to an old viewport')
  assert.ok(Math.abs(range.anchor - range.head) > 400, 'idle commit discarded the active selection')
  const beforeDelete = await editor.evaluate(element => element.editor.view.state.doc.toJSON())
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(250)
  assert.notDeepEqual(await editor.evaluate(element => element.editor.view.state.doc.toJSON()), beforeDelete)
  await page.keyboard.press('Control+z')
  await waitUntil(async () => JSON.stringify(await editor.evaluate(element => element.editor.view.state.doc.toJSON())) === JSON.stringify(beforeDelete), { message: 'chunk commits destroyed undo for a large selection deletion' })
  await page.keyboard.press('Control+s')
  await waitUntil(() => fs.readFileSync(path.join(workspace, 'long-scroll.md'), 'utf8').includes('SECOND_STRUCTURAL_EDIT'))
  assert.match(fs.readFileSync(path.join(workspace, 'long-scroll.md'), 'utf8'), /LONG_ROW_799/)
})

test('selection scrolling survives a relative image completing after the caret moved', async t => {
  const source = '![](slow.png)\n\n' + Array.from({ length: 180 }, (_, index) => `ASSET_ROW_${String(index).padStart(3, '0')} text before a late image finishes loading.`).join('\n\n') + '\n'
  const { application, page, workspace } = await launchEditor(t, { 'asset-scroll.md': source, 'slow.png': pixelPng })
  await page.setViewportSize({ width: 1440, height: 900 })
  await application.evaluate(({ ipcMain }, fixture) => {
    const ready = new Promise(resolve => { globalThis.__releaseSelectionImage = resolve })
    ipcMain.removeHandler('knote:read-image-file')
    ipcMain.handle('knote:read-image-file', async (_event, { path: candidate }) => {
      if (candidate !== fixture.file) throw new Error('outside image fixture')
      await ready
      return fixture.url
    })
  }, { file: path.join(workspace, 'slow.png'), url: 'data:image/png;base64,' + pixelPng.toString('base64') })
  assert.equal(await page.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, 'asset-scroll.md')), true)
  const editor = page.locator('.ProseMirror').first()
  const target = editor.locator('p').filter({ hasText: 'ASSET_ROW_080' })
  await target.click()
  await page.waitForTimeout(100)
  await page.keyboard.insertText('PENDING_USER_TEXT')
  const before = await editor.evaluate(element => ({ selection: element.editor.view.state.selection.toJSON(), row: element.editor.view.state.selection.$head.parent.textContent, scroll: document.querySelector('.knote-root').scrollTop, emitted: window.__knoteDebug.getContent().includes('PENDING_USER_TEXT') }))
  assert.match(before.row, /ASSET_ROW_080/, 'the image gate must remain held until the actual mouse selection settles')
  assert.equal(before.emitted, false, 'the regression must exercise an edit still in the emission debounce')
  await application.evaluate(() => globalThis.__releaseSelectionImage())
  await page.waitForFunction(() => document.querySelector('.ProseMirror img')?.src.startsWith('data:image/'))
  await page.waitForTimeout(350)
  const after = await editor.evaluate(element => ({ selection: element.editor.state.selection.toJSON(), row: element.editor.state.selection.$head.parent.textContent, scroll: document.querySelector('.knote-root').scrollTop }))
  t.diagnostic(JSON.stringify({ before, after }))
  assert.deepEqual(after.selection, before.selection, 'a display-only image resolution reset the current caret')
  assert.match(after.row, /ASSET_ROW_080/)
  assert.ok(after.scroll >= before.scroll - 5, 'a late image completion jumped back to an earlier viewport')
  const content = await page.evaluate(() => window.__knoteDebug.getContent())
  assert.match(content, /PENDING_USER_TEXT/)
  assert.ok(content.startsWith('![](slow.png)\n'), 'a display-only refresh rewrote an untouched image block')
})

test('selection scrolling does not pull a split-source range back to its starting row', async t => {
  const source = Array.from({ length: 180 }, (_, index) => `LINE_${index} selection scroll regression`).join('\n')
  const { page, workspace } = await launchEditor(t, { 'split-scroll.md': source })
  assert.equal(await page.evaluate(file => window.knoteDesktop.reopen('file', file), path.join(workspace, 'split-scroll.md')), true)
  await page.getByTestId('view-split').click()
  const input = page.getByTestId('markdown-source-editor')
  await input.waitFor({ state: 'visible' })
  const positions = await input.evaluate(element => {
    const scroller = element.closest('.knote-source-stack').parentElement
    element.focus({ preventScroll: true })
    element.setSelectionRange(0, element.value.indexOf('LINE_100'), 'forward')
    scroller.scrollTop = 1400
    return { before: scroller.scrollTop, start: element.selectionStart, end: element.selectionEnd }
  })
  assert.ok(positions.before >= 1000, 'fixture must really scroll the source pane')
  await page.waitForTimeout(150)
  await input.dispatchEvent('mouseup')
  await page.waitForTimeout(100)
  const after = await input.evaluate(element => ({ top: element.closest('.knote-source-stack').parentElement.scrollTop, start: element.selectionStart, end: element.selectionEnd }))
  t.diagnostic(JSON.stringify({ positions, after }))
  assert.equal(after.start, positions.start)
  assert.equal(after.end, positions.end)
  assert.ok(after.top >= positions.before - 5, 'source selection handler scrolled back to the fixed anchor')
})

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

    await editor.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    const blankPlain = '**first**\r\n\r\n**second**\r\n'
    const blankHtml = '<p>**first**</p><p>**second**</p>'
    await application.evaluate(({ clipboard }, value) => clipboard.write(value), {
      text: blankPlain,
      html: blankHtml
    })
    await page.keyboard.press('Control+V')
    await page.waitForTimeout(700)
    assert.deepEqual(await editor.evaluate((element) =>
      Array.from(element.children).map((child) => child.textContent)
    ), ['first', '', 'second'])

    const expectedBlank = '**first**\n\n**second**'
    await waitUntil(
      () => fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') === expectedBlank,
      { message: `native paste deleted or expanded a source blank row: ${JSON.stringify(fs.readFileSync(target, 'utf8'))}` }
    ).catch(async (error) => { error.message += '\nLive state: ' + JSON.stringify({ disk: fs.readFileSync(target, 'utf8'), ui: await page.evaluate(() => ({ content: window.__knoteDebug.getContent(), html: document.querySelector('.ProseMirror').innerHTML, splice: window.__knoteBlockSplice?.last(), trace: window.__knoteBlockSplice?.trace() })) }); throw error })

    await editor.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    const boundaryPlain = '\r\n \r\n**edge first**\r\n**edge second**\r\n\t\r\n\r\n'
    const boundaryHtml = '<p><br></p><p><strong>edge first</strong></p><p><strong>edge second</strong></p><p><br></p>'
    await application.evaluate(({ clipboard }, value) => clipboard.write(value), {
      text: boundaryPlain,
      html: boundaryHtml
    })
    await page.keyboard.press('Control+V')
    await page.waitForTimeout(700)
    const boundaryDom = await editor.evaluate((element) => ({
      text: element.innerText,
      paragraphs: element.querySelectorAll('p').length,
      firstEmpty: !element.firstElementChild?.textContent,
      lastEmpty: !element.lastElementChild?.textContent
    }))
    assert.equal(boundaryDom.text.trim(), 'edge first\nedge second', JSON.stringify(boundaryDom))
    assert.equal(boundaryDom.paragraphs, 1, JSON.stringify(boundaryDom))
    assert.equal(boundaryDom.firstEmpty, false, JSON.stringify(boundaryDom))
    assert.equal(boundaryDom.lastEmpty, false, JSON.stringify(boundaryDom))
    await waitUntil(() => {
      const savedBoundary = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
      return savedBoundary.includes('edge first') && savedBoundary.includes('edge second')
    })
    const savedBoundary = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
    assert.equal(savedBoundary.startsWith('\n'), false, JSON.stringify(savedBoundary))
    assert.equal(savedBoundary.endsWith('\n'), false, JSON.stringify(savedBoundary))
    assert.doesNotMatch(savedBoundary, /\n[ \t]*\n/, savedBoundary)
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

test('native formatted copy has no outer padding and retains intentional internal blank rows', async t => {
  const { application, page, workspace } = await launchEditor(t, { 'copy.md': 'first **bold**\nsecond\n\nthird **strong**' })
  const target = path.join(workspace, 'copy.md')
  await page.evaluate(file => window.knoteDesktop.reopen('file', file), target)
  await page.waitForFunction(() => window.__knoteDebug.getContent().includes('first **bold**'))
  const editor = page.locator('.ProseMirror').first()
  await editor.waitFor({ state: 'visible' })
  const old = await application.evaluate(({ clipboard }) => ({
    text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), bookmark: clipboard.readBookmark(),
    image: clipboard.readImage().isEmpty() ? null : clipboard.readImage().toPNG().toString('base64')
  }))
  try {
    await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
    await page.bringToFront()
    await editor.click()
    await editor.evaluate(element => { const editor = element.editor; editor.commands.setTextSelection({ from: 1, to: editor.state.doc.firstChild.nodeSize - 1 }); editor.commands.focus() })
    await page.waitForTimeout(100)
    await page.keyboard.press('Control+C')
    const row = await application.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }))
    assert.equal(row.text.replace(/\r\n/g, '\n'), 'first bold\nsecond')
    assert.match(row.html, /<strong>bold<\/strong>/)
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Control+C')
    const all = await application.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }))
    assert.equal(all.text.replace(/\r\n/g, '\n'), 'first bold\nsecond\n\nthird strong')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Control+V')
    await page.waitForTimeout(700)
    assert.equal(await page.evaluate(() => window.__knoteDebug.getContent()), 'first **bold**\nsecond\n\nthird **strong**')
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Control+C')
    assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText().replace(/\r\n/g, '\n')), all.text.replace(/\r\n/g, '\n'))
  } finally {
    await application.evaluate(({ clipboard, nativeImage }, value) => {
      const payload = { text: value.text, html: value.html, rtf: value.rtf, bookmark: value.bookmark }
      if (value.image) payload.image = nativeImage.createFromBuffer(Buffer.from(value.image, 'base64'))
      clipboard.write(payload)
    }, old)
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

test('source and keyboard-created blank rows survive tab switches, save and app restart', async (t) => {
  const source = ['# top', 'one', '', '## two', '', '', 'three', '', '', '', '# four'].join('\n')
  const fixture = await launchEditor(t, { 'blank-rows.md': source })
  const { workspace, restart } = fixture
  let page = fixture.page
  const target = path.join(workspace, 'blank-rows.md')

  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
  const editor = page.locator('.ProseMirror').first()
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  const rows = await editor.evaluate((element) =>
    Array.from(element.children).map((child) => child.textContent)
  )
  assert.deepEqual(rows, ['top', 'one', '', 'two', '', '', 'three', '', '', '', 'four'])

  const edited = `${source}!`
  assert.equal(await editor.evaluate((element) => {
    const tiptap = element.editor
    tiptap.view.dispatch(tiptap.state.tr.insertText('!', tiptap.state.doc.content.size - 1))
    return tiptap.state.doc.textContent.endsWith('four!')
  }), true)
  await page.waitForFunction(() => window.__knoteDebug.getContent().endsWith('four!'))
  assert.equal(await page.evaluate(() => window.__knoteDebug.getContent()), edited)

  const sourceTabId = await page.evaluate(() => window.__knoteDebug.tabs.list().find((tab) => tab.active).id)
  await page.evaluate(() => window.__knoteDebug.tabs.create())
  const scratchTabId = await page.evaluate(() => window.__knoteDebug.tabs.list().find((tab) => tab.active).id)
  assert.notEqual(scratchTabId, sourceTabId)
  assert.equal(await page.evaluate((id) => window.__knoteDebug.tabs.switch(id), sourceTabId), true)
  await page.waitForFunction((expected) => window.__knoteDebug.getContent() === expected, edited)
  assert.deepEqual(await editor.evaluate((element) =>
    Array.from(element.children).map((child) => child.textContent)
  ), ['top', 'one', '', 'two', '', '', 'three', '', '', '', 'four!'])

  await page.keyboard.press('Control+s')
  await waitUntil(
    () => fs.readFileSync(target, 'utf8') === edited,
    { message: `blank rows changed while saving: ${JSON.stringify(fs.readFileSync(target, 'utf8'))}` }
  )
  assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /knote:block-separator/)

  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('alpha')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('omega')
  const typed = 'alpha\n\nomega'
  await page.waitForFunction((expected) => window.__knoteDebug.getContent() === expected, typed).catch(async (error) => { error.message += '\nLive state: ' + JSON.stringify(await page.evaluate(() => ({ content: window.__knoteDebug.getContent(), html: document.querySelector('.ProseMirror').innerHTML, focus: document.activeElement?.outerHTML?.slice(0, 300), splice: window.__knoteBlockSplice?.last(), trace: window.__knoteBlockSplice?.trace() }))); throw error })

  assert.equal(await page.evaluate((id) => window.__knoteDebug.tabs.switch(id), scratchTabId), true)
  assert.equal(await page.evaluate((id) => window.__knoteDebug.tabs.switch(id), sourceTabId), true)
  await page.waitForFunction((expected) => window.__knoteDebug.getContent() === expected, typed)
  assert.deepEqual(await editor.evaluate((element) =>
    Array.from(element.children).map((child) => child.textContent)
  ), ['alpha', '', 'omega'])

  await page.keyboard.press('Control+s')
  await waitUntil(
    () => fs.readFileSync(target, 'utf8') === typed,
    { message: `keyboard-created blank row changed while saving: ${JSON.stringify(fs.readFileSync(target, 'utf8'))}` }
  )

  page = await restart()
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
  await page.waitForFunction((expected) => window.__knoteDebug.getContent() === expected, typed)
  assert.deepEqual(await page.locator('.ProseMirror').first().evaluate((element) =>
    Array.from(element.children).map((child) => child.textContent)
  ), ['alpha', '', 'omega'])
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
  await slider.waitFor({ state: 'visible', timeout: 5_000 }).catch(async (error) => { error.message += '\nSelection: ' + JSON.stringify(await editor.evaluate((element) => ({ selection: element.editor.state.selection.toJSON(), toolbar: document.querySelector('.selection-toolbar')?.outerHTML?.slice(0, 500), selected: [...element.querySelectorAll('.ProseMirror-selectednode')].map(image => image.alt) }))); throw error })
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
  assert.match(disk, /width:min\(65%,265\.2px\)/, disk)
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
