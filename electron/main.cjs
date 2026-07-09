// Knote desktop shell — a thin Electron wrapper around the built web app.
// The renderer stays sandboxed; the preload exposes exactly two capabilities
// (receive opened .md files, write those same files back for live-save).
const { app, BrowserWindow, shell, Tray, Menu, ipcMain, nativeImage, dialog, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const http = require('http')
const crypto = require('crypto')

// ---- PDF layout sidecar (PaddleOCR / PP-Structure) ----
// A local Python HTTP service does the heavy layout analysis. It's spawned
// lazily (first PDF-layout request) so it never slows startup, talks only on
// 127.0.0.1 behind a per-launch token, and is killed on quit. If Python or the
// script is missing the tools degrade to the vision-based crop.
let pdfSidecar = null // { proc, port, token }
let pdfSidecarStarting = null
const sidecarScriptPath = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'sidecar', 'knote_pdf_service.py')
  : path.join(__dirname, '..', 'sidecar', 'knote_pdf_service.py'))
const pythonCandidates = () => (process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'])
const startPdfSidecar = () => {
  if (pdfSidecar) return Promise.resolve(pdfSidecar)
  if (pdfSidecarStarting) return pdfSidecarStarting
  pdfSidecarStarting = new Promise((resolve, reject) => {
    const script = sidecarScriptPath()
    if (!fs.existsSync(script)) { pdfSidecarStarting = null; reject(new Error('sidecar script not found')); return }
    const token = crypto.randomBytes(16).toString('hex')
    const cands = pythonCandidates()
    let idx = 0
    const tryNext = () => {
      if (idx >= cands.length) { pdfSidecarStarting = null; reject(new Error('python not found — 请安装 Python 3')); return }
      const py = cands[idx++]
      let proc
      try { proc = spawn(py, [script, '--port', '0', '--token', token], { windowsHide: true }) } catch { tryNext(); return }
      let settled = false
      proc.on('error', () => { if (!settled) { settled = true; tryNext() } }) // ENOENT -> next candidate
      const to = setTimeout(() => { if (!settled) { settled = true; try { proc.kill() } catch { /* ignore */ } tryNext() } }, 12000)
      let buf = ''
      proc.stdout.on('data', (d) => {
        buf += d.toString()
        const m = buf.match(/KNOTE_PDF_SIDECAR READY (\d+)/)
        if (m && !settled) {
          settled = true; clearTimeout(to)
          pdfSidecar = { proc, port: parseInt(m[1], 10), token }
          proc.on('exit', () => { if (pdfSidecar && pdfSidecar.proc === proc) pdfSidecar = null })
          pdfSidecarStarting = null
          resolve(pdfSidecar)
        }
      })
      proc.stderr.on('data', () => { /* keep the pipe drained */ })
    }
    tryNext()
  })
  return pdfSidecarStarting
}
const sidecarRequest = (method, pathName, bodyObj, timeoutMs = 120000) => new Promise((resolve, reject) => {
  if (!pdfSidecar) { reject(new Error('sidecar not running')); return }
  const body = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null
  const req = http.request({
    host: '127.0.0.1', port: pdfSidecar.port, path: pathName, method,
    headers: { 'Content-Type': 'application/json', 'X-Knote-Token': pdfSidecar.token, ...(body ? { 'Content-Length': body.length } : {}) },
    timeout: timeoutMs
  }, (res) => {
    let data = ''
    res.on('data', (c) => { data += c })
    res.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch (e) { reject(e) } })
  })
  req.on('error', reject)
  req.on('timeout', () => req.destroy(new Error('sidecar timeout')))
  if (body) req.write(body)
  req.end()
})
const stopPdfSidecar = () => {
  if (!pdfSidecar) return
  const s = pdfSidecar; pdfSidecar = null
  try { s.proc.kill() } catch { /* ignore */ }
}
app.on('before-quit', stopPdfSidecar)

let win = null
let tray = null
let quitting = false
let rendererReady = false
// open targets queued until the window AND renderer exist. An array, not a
// single slot: two rapid opens during startup must both survive.
let pendingOpens = [] // [{ type: 'file'|'folder', path }]
// live-save may only write files the MAIN process handed to the renderer
const writablePaths = new Set()
// folder workspaces the renderer may browse/write (registered here only)
const folderRoots = new Set()
// folders the renderer may READ ONLY — the directory a file-associated .md
// lives in, so ![](relative/x.png) images next to it can be resolved (no
// write access, unlike folderRoots)
const imageReadRoots = new Set()
// folders the renderer may write IMAGE ASSETS into (the directory a
// file-associated .md lives in — for <docdir>/assets/*.png). Narrower than a
// full folder root: only used by the write-image-file IPC.
const assetWriteRoots = new Set()

const iconPath = path.join(__dirname, '..', 'build', 'icon.png')

// .md file OR folder path from a launch/second-instance argv (file
// association, drag onto the exe/shortcut icon). Relative paths resolve
// against the SENDING instance's cwd (second-instance passes it along).
const openTargetFromArgv = (argv, workingDirectory) => {
  const args = argv.slice(app.isPackaged ? 1 : 2)
  for (const a of args) {
    if (!a || a.startsWith('-')) continue
    try {
      const p = path.resolve(workingDirectory || process.cwd(), a)
      const st = fs.statSync(p)
      if (st.isDirectory()) return { type: 'folder', path: p }
      if (st.isFile() && /\.(md|markdown)$/i.test(p)) return { type: 'file', path: p }
    } catch { /* not a real path — ignore */ }
  }
  return null
}

const sendOpenFile = (p) => {
  if (!p) return
  if (!win || !rendererReady) { pendingOpens.push({ type: 'file', path: p }); return }
  try {
    const data = fs.readFileSync(p, 'utf8')
    writablePaths.add(p)
    imageReadRoots.add(path.dirname(path.resolve(p))) // read images next to it
    assetWriteRoots.add(path.dirname(path.resolve(p))) // write <dir>/assets/*.png
    win.webContents.send('knote:open-file', { path: p, name: path.basename(p), data })
  } catch { /* unreadable — ignore */ }
}

const sendOpenFolder = (p) => {
  if (!p) return
  if (!win || !rendererReady) { pendingOpens.push({ type: 'folder', path: p }); return }
  folderRoots.add(p)
  win.webContents.send('knote:open-folder', { path: p, name: path.basename(p) })
}

const sendOpenTarget = (target) => {
  if (!target) return
  if (target.type === 'folder') sendOpenFolder(target.path)
  else sendOpenFile(target.path)
}

const showWindow = () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

const createWindow = () => {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    icon: iconPath,
    // custom frosted title bar: the app header is the drag region; the
    // native min/max/close buttons stay as a Windows controls overlay
    // opaque window (no acrylic/transparency — that showed black edges on
    // some GPU/DWM configs); the frosted look is a CSS tint on the bar
    backgroundColor: '#e5e7eb',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#4b5563',
      height: 40
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  // external links (markdown links, docs, ...) open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (/^https?:/i.test(url)) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })
  // background residence: closing hides to the tray instead of quitting
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })
  return win
}

const createTray = () => {
  const img = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  tray = new Tray(img)
  tray.setToolTip('Knote')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 Knote', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } }
  ]))
  tray.on('double-click', showWindow)
  tray.on('click', showWindow)
}

// single instance: launching a second Knote (e.g. double-clicking another
// .md) routes into the running one. Probe/dev runs skip the lock — they'd
// otherwise be swallowed by an installed (tray-resident) instance.
const isProbe = !!(process.env.KNOTE_SMOKE || process.env.KNOTE_SHOT || process.env.KNOTE_PDF)
// software rendering makes capturePage deterministic for the visual probe
if (process.env.KNOTE_SHOT) app.disableHardwareAcceleration()
const gotLock = isProbe ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv, workingDirectory) => {
    showWindow()
    sendOpenTarget(openTargetFromArgv(argv, workingDirectory))
  })

  ipcMain.on('knote:renderer-ready', () => {
    rendererReady = true
    const queued = pendingOpens
    pendingOpens = []
    queued.forEach(sendOpenTarget)
  })

  ipcMain.handle('knote:write-file', async (_e, { path: p, data }) => {
    if (!writablePaths.has(p)) throw new Error('not an opened file')
    await fs.promises.writeFile(p, String(data), 'utf8')
    return true
  })

  // ---- folder-workspace fs (paths confined to registered roots) ----
  const under = (p, roots) => {
    const r = path.resolve(String(p || ''))
    for (const root of roots) {
      if (r === root || r.startsWith(root + path.sep)) return true
    }
    return false
  }
  const insideRoot = (p) => under(p, folderRoots)            // read + write
  const insideReadRoot = (p) => under(p, folderRoots) || under(p, imageReadRoots) // read only
  ipcMain.handle('knote:fs-list', (_e, { dir }) => {
    if (!insideReadRoot(dir)) throw new Error('outside workspace')
    return fs.readdirSync(dir, { withFileTypes: true })
      .map((d) => ({ name: d.name, kind: d.isDirectory() ? 'directory' : 'file' }))
  })
  ipcMain.handle('knote:fs-read', (_e, { path: p }) => {
    if (!insideReadRoot(p)) throw new Error('outside workspace')
    return fs.readFileSync(p, 'utf8')
  })
  ipcMain.handle('knote:fs-exists', (_e, { path: p }) => insideReadRoot(p) && fs.existsSync(p))
  // read a BINARY image next to an opened file/folder and return a data URL
  // (fs-read is utf8-only and would corrupt binary); read-only roots only
  ipcMain.handle('knote:read-image-file', (_e, { path: p }) => {
    if (!insideReadRoot(p)) throw new Error('outside workspace')
    const buf = fs.readFileSync(p)
    const ext = path.extname(p).toLowerCase()
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif' }[ext] || 'application/octet-stream'
    return `data:${mime};base64,${buf.toString('base64')}`
  })
  ipcMain.handle('knote:fs-write', async (_e, { path: p, data }) => {
    if (!insideRoot(p) && !writablePaths.has(p)) throw new Error('outside workspace')
    await fs.promises.writeFile(p, String(data), 'utf8')
    return true
  })
  ipcMain.handle('knote:fs-delete', (_e, { path: p }) => {
    if (!insideRoot(p)) throw new Error('outside workspace')
    fs.rmSync(p, { force: true, recursive: true })
    return true
  })
  ipcMain.handle('knote:fs-mkdir', (_e, { path: p }) => {
    if (!insideRoot(p)) throw new Error('outside workspace')
    fs.mkdirSync(p, { recursive: true })
    return true
  })
  // write an image asset (base64 -> raw bytes) into a folder root or a
  // file-associated doc's own directory; creates the parent (assets/) folder
  ipcMain.handle('knote:write-image-file', (_e, { path: p, base64 }) => {
    const abs = path.resolve(String(p || ''))
    if (!insideRoot(abs) && !under(abs, assetWriteRoots)) throw new Error('outside workspace')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, Buffer.from(String(base64 || ''), 'base64'))
    return true
  })
  // PDF layout sidecar: status (spawns + health-checks) and analyze
  ipcMain.handle('knote:pdf-sidecar-status', async () => {
    try {
      await startPdfSidecar()
      const h = await sidecarRequest('GET', '/health', null, 8000)
      return { available: true, paddle: !!h.paddle, ready: !!h.ready, version: h.version, engineError: h.engine_error || null }
    } catch (e) {
      return { available: false, error: String((e && e.message) || e) }
    }
  })
  ipcMain.handle('knote:pdf-analyze', async (_e, { imageBase64, minScore }) => {
    await startPdfSidecar()
    return await sidecarRequest('POST', '/analyze', { image_base64: imageBase64, min_score: typeof minScore === 'number' ? minScore : 0.5 })
  })
  ipcMain.handle('knote:fs-rename', (_e, { from, to }) => {
    if (!insideRoot(from) || !insideRoot(to)) throw new Error('outside workspace')
    fs.renameSync(from, to)
    return true
  })
  // delete to the OS recycle bin instead of unlinking (undoable in Explorer)
  ipcMain.handle('knote:trash', async (_e, { path: p }) => {
    if (!insideRoot(p) && !writablePaths.has(p)) throw new Error('outside workspace')
    await shell.trashItem(path.resolve(p))
    return true
  })

  // session restore: re-open remembered file/folder paths on startup. Paths
  // are validated to still exist; re-registers them as writable/browsable.
  ipcMain.handle('knote:reopen', (_e, { type, path: p }) => {
    try {
      if (!p || !fs.existsSync(p)) return false
      if (type === 'folder') sendOpenFolder(path.resolve(p))
      else sendOpenFile(path.resolve(p))
      return true
    } catch { return false }
  })

  ipcMain.handle('knote:clipboard-read-text', () => clipboard.readText())

  // bitmap in the clipboard (screenshot tools, right-click copy image) —
  // the sandboxed renderer's async clipboard API can't always see it.
  // Huge bitmaps are downscaled BEFORE the synchronous PNG encode: an
  // unbounded encode blocks the main process and ships a giant string
  // over IPC into the document.
  ipcMain.handle('knote:clipboard-read-image', () => {
    let img = clipboard.readImage()
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    const MAX_EDGE = 4096
    if (Math.max(width, height) > MAX_EDGE) {
      img = width >= height ? img.resize({ width: MAX_EDGE }) : img.resize({ height: MAX_EDGE })
    }
    return img.toDataURL()
  })

  // rich clipboard flavor for the context-menu paste — without it the
  // right-click paste degrades everything to plain text
  ipcMain.handle('knote:clipboard-read-html', () => clipboard.readHTML() || '')

  // Ctrl+wheel UI zoom: Chromium-native zoom + keep the native window
  // buttons strip (WCO) as tall as the CSS title bar (40 CSS px = 40*Z DIP)
  ipcMain.handle('knote:ui-zoom', (_e, { factor }) => {
    if (!win) return false
    const f = Math.min(2.5, Math.max(0.5, Number(factor) || 1))
    win.webContents.setZoomFactor(f)
    try {
      win.setTitleBarOverlay({ color: '#00000000', symbolColor: '#4b5563', height: Math.round(40 * f) })
    } catch { /* pre-creation or unsupported — harmless */ }
    return true
  })

  ipcMain.handle('knote:clipboard-write-image', (_e, { dataUrl }) => {
    const img = nativeImage.createFromDataURL(String(dataUrl || ''))
    if (img.isEmpty()) return false
    clipboard.writeImage(img)
    return true
  })

  // Export the current document to PDF via Chromium's print pipeline (honors
  // the @media print CSS), saving where the user picks.
  ipcMain.handle('knote:export-pdf', async (_e, { defaultName }) => {
    if (!win) return { ok: false, error: 'no window' }
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出 PDF',
      defaultPath: `${defaultName || 'knote'}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    // The window's opaque gray backgroundColor bleeds into the PDF's page
    // margins (printBackground composites the transparent margin area against
    // the window color) — a gray border around the page. Flip the window to
    // white for the render, then restore, so margins print clean.
    const prevBg = win.getBackgroundColor()
    try {
      win.setBackgroundColor('#ffffff')
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
      })
      await fs.promises.writeFile(filePath, pdf)
      shell.openPath(filePath)
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: String(err && err.message) }
    } finally {
      win.setBackgroundColor(prevBg || '#e5e7eb')
    }
  })

  app.whenReady().then(() => {
    createWindow()
    createTray()
    const target = openTargetFromArgv(process.argv)
    if (target) pendingOpens.push(target)

    // visual probe: KNOTE_SHOT=<path> captures the window into a PNG and exits
    if (process.env.KNOTE_SHOT) {
      win.webContents.setBackgroundThrottling(false)
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          win.show()
          win.focus()
          win.moveTop()
          for (let attempt = 0; attempt < 4; attempt++) {
            await new Promise((r) => setTimeout(r, 600))
            try {
              const img = await win.webContents.capturePage()
              if (!img.isEmpty()) {
                fs.writeFileSync(process.env.KNOTE_SHOT, img.toPNG())
                console.log('KNOTE_SHOT_SAVED')
                break
              }
            } catch (err) {
              if (attempt === 3) console.log('KNOTE_SHOT_ERR:' + String(err && err.message))
            }
          }
          quitting = true
          app.exit(0)
        }, 2500)
      })
    }

    // print probe: KNOTE_PDF=<path> renders the page via the print CSS and exits
    if (process.env.KNOTE_PDF) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            win.setBackgroundColor('#ffffff')
            const pdf = await win.webContents.printToPDF({
              printBackground: true,
              margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
            })
            fs.writeFileSync(process.env.KNOTE_PDF, pdf)
            console.log('KNOTE_PDF_SAVED')
          } catch (err) {
            console.log('KNOTE_PDF_ERR:' + String(err && err.message))
          }
          quitting = true
          app.exit(0)
        }, 3000)
      })
    }

    // CI/agent smoke test: KNOTE_SMOKE=1 probes the loaded app and exits
    if (process.env.KNOTE_SMOKE) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            const probe = await win.webContents.executeJavaScript(`({
              title: document.title,
              appMounted: !!document.querySelector('#app') && document.querySelector('#app').children.length > 0,
              editorMounted: !!document.querySelector('.ProseMirror'),
              fsaFilePicker: 'showOpenFilePicker' in window,
              fsaDirPicker: 'showDirectoryPicker' in window,
              wco: !!(navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible),
              wcoClass: document.documentElement.classList.contains('knote-wco'),
              desktopBridge: !!window.knoteDesktop,
              tabs: [...document.querySelectorAll('.knote-tab')].map((el) => ({
                label: (el.querySelector('.knote-tab-label') || {}).textContent,
                active: el.classList.contains('is-active'),
                folder: el.classList.contains('is-folder')
              })),
              folderTreeRows: document.querySelectorAll('.knote-tree-row, [class*=tree]').length,
              titlebar: (() => {
                const tb = document.querySelector('.knote-titlebar')
                if (!tb) return null
                const r = tb.getBoundingClientRect()
                const cs = getComputedStyle(tb)
                return { top: r.top, height: r.height, drag: cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region') }
              })(),
              scroller: (() => {
                const root = document.querySelector('.knote-root')
                if (!root) return null
                root.scrollTop = 200
                const docScrolls = document.documentElement.scrollHeight > document.documentElement.clientHeight
                return {
                  rootTop: Math.round(root.getBoundingClientRect().top),
                  rootScrolled: root.scrollTop > 0,
                  documentScrolls: docScrolls,
                  glowClass: root.classList.contains('knote-scrolling')
                }
              })(),
              openedDoc: document.querySelector('.ProseMirror') ? document.querySelector('.ProseMirror').textContent.slice(0, 60) : ''
            })`)
            console.log('KNOTE_SMOKE:' + JSON.stringify(probe))
            const bootErr = await win.webContents.executeJavaScript('window.__knoteBootError || null')
            if (bootErr) console.log('KNOTE_SMOKE_BOOTERR:' + bootErr)
            // relative-image resolution: are editor <img> srcs data URLs (resolved)?
            const imgs = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.ProseMirror img')].map(i => (i.getAttribute('src')||'').slice(0,16))`)
            console.log('KNOTE_SMOKE_IMGS:' + JSON.stringify(imgs))
            // UI zoom probe: native zoom shrinks the CSS viewport width
            const wBefore = await win.webContents.executeJavaScript('window.innerWidth')
            await win.webContents.executeJavaScript('window.knoteDesktop.setZoom(1.5)')
            await new Promise((r) => setTimeout(r, 400))
            const wAfter = await win.webContents.executeJavaScript('window.innerWidth')
            await win.webContents.executeJavaScript('window.knoteDesktop.setZoom(1)')
            await new Promise((r) => setTimeout(r, 200))
            console.log('KNOTE_SMOKE_ZOOM:' + JSON.stringify({ wBefore, wAfter, zoomWorks: wAfter < wBefore - 100 }))
            // PDF layout sidecar: spawns the real Python service and health-checks it
            try {
              const sc = await win.webContents.executeJavaScript('window.knoteDesktop.pdfSidecarStatus()')
              console.log('KNOTE_SMOKE_SIDECAR:' + JSON.stringify(sc))
            } catch (e) { console.log('KNOTE_SMOKE_SIDECAR_ERR:' + String(e && e.message)) }
            // live-save probe: type into the doc, wait out the debounce,
            // then check the opened file on disk actually changed
            const opened = [...writablePaths][0]
            if (opened) {
              await win.webContents.executeJavaScript(`(() => {
                const pm = document.querySelector('.ProseMirror')
                pm.focus()
                return document.execCommand('insertText', false, 'IPC写盘验证')
              })()`)
              await new Promise((r) => setTimeout(r, 2200))
              const onDisk = fs.readFileSync(opened, 'utf8')
              // ROUND-TRIP DATA INTEGRITY: after an edit + save, relative image
              // paths must be PRESERVED and never inlined as data: URLs
              console.log('KNOTE_SMOKE_SAVE:' + JSON.stringify({
                liveSaved: onDisk.includes('IPC写盘验证'),
                relPathsKept: (onDisk.match(/assets\/week13/g) || []).length,
                inlinedDataUrls: (onDisk.match(/data:image\//g) || []).length
              }))
            }
            // folder-workspace probe: open a file from the tree, type, and
            // verify the auto-save reached the disk through the fs IPC
            const root = [...folderRoots][0]
            if (root) {
              const clicked = await win.webContents.executeJavaScript(`(async () => {
                const row = document.querySelector('[title$=".md"]')
                if (!row) return { clicked: false }
                row.click()
                await new Promise((r) => setTimeout(r, 900))
                const pm = document.querySelector('.ProseMirror')
                pm.focus()
                document.execCommand('insertText', false, '文件夹IPC写盘')
                return { clicked: true, name: row.getAttribute('title') }
              })()`)
              await new Promise((r) => setTimeout(r, 2200))
              let treeSaved = false
              if (clicked && clicked.clicked) {
                const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
                  d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)])
                treeSaved = walk(root).some((f) => {
                  try { return /\.md$/i.test(f) && fs.readFileSync(f, 'utf8').includes('文件夹IPC写盘') } catch { return false }
                })
              }
              console.log('KNOTE_SMOKE_FOLDER:' + JSON.stringify({ ...clicked, treeSaved }))
              // folder-create probe: mkdir via the workspace IPC + confirm
              if (process.env.KNOTE_MKDIR) {
                const newDir = path.join(root, '烟测新文件夹')
                try {
                  await win.webContents.executeJavaScript(`window.knoteDesktop.fsMkdir(${JSON.stringify(newDir)})`)
                  await new Promise((r) => setTimeout(r, 400))
                } catch (err) { console.log('mkdir err ' + err.message) }
                const made = fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()
                console.log('KNOTE_SMOKE_MKDIR:' + JSON.stringify({ made }))
                try { fs.rmSync(newDir, { recursive: true, force: true }) } catch { /* cleanup */ }
              }
              // recycle-bin probe: trash a file via the IPC and confirm gone
              if (process.env.KNOTE_TRASH) {
                const target = path.resolve(process.env.KNOTE_TRASH)
                const existedBefore = fs.existsSync(target)
                try { await win.webContents.executeJavaScript(`window.knoteDesktop.trash(${JSON.stringify(target)})`) } catch (err) { console.log('trash err ' + err.message) }
                await new Promise((r) => setTimeout(r, 800))
                console.log('KNOTE_SMOKE_TRASH:' + JSON.stringify({ existedBefore, goneAfter: !fs.existsSync(target) }))
              }
            }
            // session persistence: what the renderer saved for next launch
            const sess = await win.webContents.executeJavaScript('localStorage.getItem("knote-session")')
            console.log('KNOTE_SMOKE_SESSION:' + JSON.stringify({ saved: sess }))
            const recents = await win.webContents.executeJavaScript('localStorage.getItem("knote-recents")')
            console.log('KNOTE_SMOKE_RECENTS:' + JSON.stringify({ recents }))
            // multi-file probe: replicate double-clicking a SECOND md while
            // the app is running (second-instance → sendOpenFile), then
            // re-opening the first (deskKey dedupe → tab switch)
            if (process.env.KNOTE_FILE2) {
              const probeTabs = `({
                doc: document.querySelector('.ProseMirror').textContent.slice(0, 60),
                tabs: [...document.querySelectorAll('.knote-tab')].map((el) => ({
                  label: (el.querySelector('.knote-tab-label') || {}).textContent,
                  active: el.classList.contains('is-active')
                }))
              })`
              const first = [...writablePaths][0]
              sendOpenFile(path.resolve(process.env.KNOTE_FILE2))
              await new Promise((r) => setTimeout(r, 1600))
              console.log('KNOTE_SMOKE_FILE2:' + JSON.stringify(await win.webContents.executeJavaScript(probeTabs)))
              if (first) {
                sendOpenFile(first)
                await new Promise((r) => setTimeout(r, 1600))
                console.log('KNOTE_SMOKE_BACK:' + JSON.stringify(await win.webContents.executeJavaScript(probeTabs)))
              }
              // the regression trigger: opening a FRESH file AFTER a tab
              // restore — a poisoned editor state would render it blank
              if (process.env.KNOTE_FILE3) {
                sendOpenFile(path.resolve(process.env.KNOTE_FILE3))
                await new Promise((r) => setTimeout(r, 1600))
                console.log('KNOTE_SMOKE_FILE3:' + JSON.stringify(await win.webContents.executeJavaScript(probeTabs)))
              }
            }
          } catch (err) {
            console.log('KNOTE_SMOKE_ERR:' + String(err && err.message))
          }
          quitting = true
          app.exit(0)
        }, 3000)
      })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showWindow()
    })
  })

  app.on('before-quit', () => { quitting = true })

  app.on('window-all-closed', () => {
    // tray keeps the app alive; real exit goes through the tray menu
    if (quitting) app.quit()
  })
}
