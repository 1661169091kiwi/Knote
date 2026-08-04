// Knote desktop shell — a thin Electron wrapper around the built web app.
// The renderer stays sandboxed; the preload exposes exactly two capabilities
// (receive opened .md files, write those same files back for live-save).
const { app, BrowserWindow, shell, Tray, Menu, ipcMain, nativeImage, dialog, clipboard, net, crashReporter } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const http = require('http')
const https = require('https')
const dns = require('dns')
const nodeNet = require('net') // Node's net (has isIP); electron's `net` above has only request
const { pipeline } = require('stream')
const crypto = require('crypto')
const { pathToFileURL } = require('node:url')
const { createQuitCleanupController, createRendererQuitHandshake, terminateProcessTree } = require('./quit-cleanup.cjs')
const { createFsMutationCoordinator } = require('./fs-mutation-coordinator.cjs')
const { DocumentRetentionStore } = require('./document-retention.cjs')
const { TabBufferStore } = require('./tab-buffer-store.cjs')
const { attachCrashDiagnostics } = require('./crash-diagnostics.cjs')
const {
  authorizeCreatableAssetImagePath,
  authorizeCreatableAssetPath,
  authorizeCreatableImagePath,
  authorizeCreatablePath,
  authorizeExistingImagePath,
  authorizeExistingPath,
  createBoundaryRoot,
  pathKey
} = require('./workspace-boundary.cjs')

const installerShutdownRequestFromArgv = (argv) => {
  const args = Array.isArray(argv) ? argv : []
  const index = args.indexOf('--knote-installer-shutdown')
  if (index < 0 || !args[index + 1]) return null
  try {
    const target = path.resolve(String(args[index + 1]))
    const ackCandidate = args[index + 2] ? path.resolve(String(args[index + 2])) : ''
    const ackPath = ackCandidate &&
      pathKey(path.dirname(ackCandidate)) === pathKey(os.tmpdir()) &&
      /^knote-installer-shutdown-[a-z0-9._-]+\.ack$/i.test(path.basename(ackCandidate))
      ? ackCandidate
      : ''
    return { target, ackPath }
  } catch { return null }
}

// Electron UI tests run the real desktop shell, but must never share the
// developer/user profile (API keys, chats, recents or document history).
// This switch is deliberately environment-only and is not exposed to the
// renderer in production builds.
const isE2E = process.env.KNOTE_E2E === '1'
if (isE2E && process.env.KNOTE_E2E_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.KNOTE_E2E_USER_DATA))
}

// Native Chromium/Electron failures do not reach Vue's error boundary. Keep
// local-only minidumps plus a small, secret-safe lifecycle ledger under
// userData so a future STATUS_BREAKPOINT can be tied to the renderer/GPU/main
// process that actually exited. Nothing is uploaded and document text, paths,
// stacks and command lines are deliberately excluded from the ledger.
const crashDiagnostics = attachCrashDiagnostics({ app, crashReporter })

// The filesystem coordinator is installed with the IPC handlers later in
// startup. Keep a stable quit-time hook here so cleanup can wait for whatever
// coordinator is active without depending on declaration order.
let waitForFsMutations = () => Promise.resolve()

// User data lives outside the installation directory, so immutable document
// history survives an in-place program update (and is never replaced by the
// installer). Construct lazily because Electron resolves userData at runtime.
let retentionStore = null
const retention = () => {
  if (!retentionStore) retentionStore = new DocumentRetentionStore(path.join(app.getPath('userData'), 'document-history', 'v1'))
  return retentionStore
}
let tabBufferStore = null
const tabBuffers = () => {
  if (!tabBufferStore) {
    const userData = app.getPath('userData')
    tabBufferStore = new TabBufferStore(path.join(userData, 'tab-buffers', 'v1'), { boundaryDir: userData })
  }
  return tabBufferStore
}

// ---- PDF layout sidecar (PaddleOCR / PP-Structure) ----
// A local Python HTTP service does the heavy layout analysis. It's spawned
// lazily (first PDF-layout request) so it never slows startup, talks only on
// 127.0.0.1 behind a per-launch token, and is killed on quit. If Python or the
// script is missing the tools degrade to the vision-based crop.
let pdfSidecar = null // { proc, port, token }
let pdfSidecarStarting = null
let pdfSidecarStartingProc = null
let pdfSidecarStartGeneration = 0
let pdfSidecarStopPromise = null
const pdfSidecarProcesses = new Set()
let pdfAnalyzeQueue = Promise.resolve()
let pdfEnvBusy = false // true during env install / reinstall / uninstall
let pdfEnvChild = null // the in-flight pip/venv process (killed on quit)
let pdfEnvStopPromise = null
let quitting = false
const sidecarScriptPath = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'sidecar', 'knote_pdf_service.py')
  : path.join(__dirname, '..', 'sidecar', 'knote_pdf_service.py'))
const pythonCandidates = () => (process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'])
// managed virtual-env (created by the in-app "download & configure" flow) that
// holds PaddleOCR, kept in the writable user-data dir so it survives updates
// and uninstalling it = deleting a folder. The sidecar prefers this venv's
// python (which has PaddleOCR) over a bare system python.
const pdfEnvDir = () => path.join(app.getPath('userData'), 'pdf-env')
const venvPython = () => {
  // two managed layouts share pdf-env: a venv (Scripts\python.exe, created
  // from a system python) or the self-contained EMBEDDED python placed at the
  // root when no system python exists
  const cands = process.platform === 'win32'
    ? [path.join(pdfEnvDir(), 'Scripts', 'python.exe'), path.join(pdfEnvDir(), 'python.exe')]
    : [path.join(pdfEnvDir(), 'bin', 'python')]
  return cands.find((p) => fs.existsSync(p)) || null
}
const envReadyMarker = () => path.join(pdfEnvDir(), '.knote_ready')
const pdfEnvInstalled = () => !!venvPython() && fs.existsSync(envReadyMarker())
const sidecarDir = () => path.dirname(sidecarScriptPath())
const startPdfSidecar = () => {
  if (quitting) return Promise.reject(new Error('应用正在退出'))
  // never spawn a sidecar (which would lock the venv python) while the env is
  // being installed / uninstalled
  if (pdfEnvBusy) return Promise.reject(new Error('环境正在安装/卸载中，请稍候再试'))
  if (pdfSidecar) return Promise.resolve(pdfSidecar)
  if (pdfSidecarStarting) return pdfSidecarStarting
  if (pdfSidecarStopPromise) return pdfSidecarStopPromise.then(startPdfSidecar)
  const generation = pdfSidecarStartGeneration
  let finished = false
  const starting = new Promise((resolve, reject) => {
    const fail = (error) => {
      if (finished) return
      finished = true
      reject(error)
    }
    const stopped = () => quitting || generation !== pdfSidecarStartGeneration
    const script = sidecarScriptPath()
    if (!fs.existsSync(script)) { fail(new Error('sidecar script not found')); return }
    const token = crypto.randomBytes(16).toString('hex')
    // prefer the managed venv (has PaddleOCR); fall back to a system python
    const vpy = venvPython()
    const cands = vpy ? [vpy, ...pythonCandidates()] : pythonCandidates()
    let idx = 0
    const tryNext = () => {
      if (finished) return
      if (stopped()) { fail(new Error('sidecar start cancelled')); return }
      if (idx >= cands.length) { fail(new Error('python not found — 请安装 Python 3')); return }
      const py = cands[idx++]
      let proc
      try { proc = spawn(py, [script, '--port', '0', '--token', token], { windowsHide: true }) } catch { tryNext(); return }
      pdfSidecarStartingProc = proc
      pdfSidecarProcesses.add(proc)
      proc.once('close', () => { pdfSidecarProcesses.delete(proc) })
      let settled = false
      let to = null
      const advance = () => {
        if (settled) return
        settled = true
        if (to) clearTimeout(to)
        if (pdfSidecarStartingProc === proc) pdfSidecarStartingProc = null
        if (stopped()) fail(new Error('sidecar start cancelled'))
        else tryNext()
      }
      proc.once('error', advance) // ENOENT -> next candidate
      proc.once('close', advance)
      to = setTimeout(() => {
        if (settled) return
        settled = true
        terminateProcessTree(proc, { timeoutMs: 3500 }).finally(() => {
          if (pdfSidecarStartingProc === proc) pdfSidecarStartingProc = null
          if (stopped()) fail(new Error('sidecar start cancelled'))
          else tryNext()
        })
      }, 12000)
      let buf = ''
      proc.stdout.on('data', (d) => {
        buf += d.toString()
        const m = buf.match(/KNOTE_PDF_SIDECAR READY (\d+)/)
        if (m && !settled) {
          settled = true; clearTimeout(to)
          if (stopped()) {
            terminateProcessTree(proc, { timeoutMs: 3500 })
            fail(new Error('sidecar start cancelled'))
            return
          }
          if (pdfSidecarStartingProc === proc) pdfSidecarStartingProc = null
          pdfSidecar = { proc, port: parseInt(m[1], 10), token }
          proc.on('exit', () => { if (pdfSidecar && pdfSidecar.proc === proc) pdfSidecar = null })
          finished = true
          resolve(pdfSidecar)
        }
      })
      proc.stderr.on('data', () => { /* keep the pipe drained */ })
    }
    tryNext()
  })
  pdfSidecarStarting = starting
  const clearStarting = () => { if (pdfSidecarStarting === starting) pdfSidecarStarting = null }
  starting.then(clearStarting, clearStarting)
  return starting
}
const sidecarRequest = (method, pathName, bodyObj, timeoutMs = 120000) => new Promise((resolve, reject) => {
  if (!pdfSidecar) { reject(new Error('sidecar not running')); return }
  const body = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null
  const req = http.request({
    host: '127.0.0.1', port: pdfSidecar.port, path: pathName, method,
    headers: { 'Content-Type': 'application/json', 'X-Knote-Token': pdfSidecar.token, ...(body ? { 'Content-Length': body.length } : {}) },
    timeout: timeoutMs
  }, (res) => {
    // accumulate BUFFERS and decode once at the end: per-chunk toString would
    // corrupt a multi-byte UTF-8 char split across chunk boundaries (the
    // sidecar streams CJK OCR text as raw UTF-8, and big /analyze responses
    // span several chunks) into U+FFFD — silently, since JSON.parse succeeds
    const chunks = []
    res.on('data', (c) => { chunks.push(c) })
    res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(e) } })
  })
  req.on('error', reject)
  req.on('timeout', () => {
    const err = new Error('sidecar timeout')
    err.code = 'SIDECAR_TIMEOUT'
    req.destroy(err)
  })
  if (body) req.write(body)
  req.end()
})
const stopPdfSidecar = () => {
  if (pdfSidecarStopPromise) return pdfSidecarStopPromise
  pdfSidecarStartGeneration += 1
  const processes = new Set(pdfSidecarProcesses)
  if (pdfSidecar) processes.add(pdfSidecar.proc)
  if (pdfSidecarStartingProc) processes.add(pdfSidecarStartingProc)
  pdfSidecar = null
  pdfSidecarStarting = null
  pdfSidecarStartingProc = null
  if (processes.size === 0) return Promise.resolve()
  // A Windows venv launcher spawns the real system-python process. proc.kill()
  // only kills the tiny launcher and leaves a multi-GB Paddle inference alive.
  // taskkill /T is required to release the complete process tree.
  const pending = Promise.allSettled(
    [...processes].map((proc) => terminateProcessTree(proc, { timeoutMs: 3500 }))
  ).finally(() => {
    if (pdfSidecarStopPromise === pending) pdfSidecarStopPromise = null
  })
  pdfSidecarStopPromise = pending
  return pending
}
const recoverableSidecarError = (err) => (
  err && (err.code === 'SIDECAR_TIMEOUT' || /(?:sidecar timeout|ECONNRESET|EPIPE|socket hang up)/i.test(String(err.message || err)))
)
const analyzeWithSidecarRecovery = async (payload) => {
  const timeout = payload.mode === 'layout' ? 30000 : 120000
  const run = async () => {
    await startPdfSidecar()
    return sidecarRequest('POST', '/analyze', payload, timeout)
  }
  try {
    return await run()
  } catch (err) {
    if (!recoverableSidecarError(err)) throw err
    await stopPdfSidecar()
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      return await run()
    } catch (retryErr) {
      // Never leave a timed-out Paddle worker consuming CPU/RAM indefinitely.
      if (recoverableSidecarError(retryErr)) await stopPdfSidecar()
      throw retryErr
    }
  }
}
const stopPdfEnvChild = () => {
  if (pdfEnvStopPromise) return pdfEnvStopPromise
  const child = pdfEnvChild
  if (!child) return Promise.resolve()
  pdfEnvChild = null
  const pending = terminateProcessTree(child, { timeoutMs: 3500 }).finally(() => {
    if (pdfEnvStopPromise === pending) pdfEnvStopPromise = null
  })
  pdfEnvStopPromise = pending
  return pending
}

// Electron does not await async before-quit listeners. One durability gate
// holds the first quit for renderer saves and PDF child cleanup, then permits
// exactly one re-entry. The outer deadline exceeds every inner deadline.
const rendererQuitHandshake = createRendererQuitHandshake({
  getWebContents: () => (rendererReady && win && !win.isDestroyed() ? win.webContents : null),
  timeoutMs: 7000
})
let installerShutdownAckPath = ''
const durableQuitCleanup = createQuitCleanupController({
  app,
  markQuitting: () => {
    quitting = true
    pdfEnvBusy = true
  },
  cleanup: async ({ signal } = {}) => {
    const assertCurrentAttempt = () => {
      if (!signal?.aborted) return
      const error = new Error('quit cleanup attempt was cancelled')
      error.code = 'QUIT_CLEANUP_CANCELLED'
      throw error
    }
    const [rendererResult] = await Promise.all([
      rendererQuitHandshake.request(),
      stopPdfSidecar(),
      stopPdfEnvChild()
    ])
    assertCurrentAttempt()
    if (!['acked', 'unavailable', 'disposed'].includes(rendererResult.status)) {
      const error = new Error(`renderer durability barrier failed: ${rendererResult.status}`)
      error.code = 'RENDERER_QUIT_BARRIER_FAILED'
      throw error
    }
    await waitForFsMutations()
    assertCurrentAttempt()
    await crashDiagnostics.flush()
    assertCurrentAttempt()
    const ackPath = installerShutdownAckPath
    installerShutdownAckPath = ''
    if (ackPath) await fs.promises.writeFile(ackPath, 'ready', { flag: 'wx' }).catch(() => {})
    assertCurrentAttempt()
    // Renderer swap refs remain valid until every durability step succeeds. If
    // quit is cancelled earlier, the live renderer can still hydrate cold tabs.
    if (rendererResult.tabBufferSessionId && tabBufferStore) {
      void tabBufferStore.clearSession(rendererResult.tabBufferSessionId).catch((error) => {
        console.error('[tab-buffer-quit-cleanup]', error && error.message ? error.message : error)
      })
    }
    return { renderer: rendererResult }
  },
  timeoutMs: 12000,
  onError: (error) => {
    installerShutdownAckPath = ''
    quitting = false
    pdfEnvBusy = false
    console.error('[quit-cleanup]', error && error.message ? error.message : error)
    try { if (win && !win.isDestroyed()) win.webContents.send('knote:quit-cancelled') } catch { /* renderer may be gone */ }
    showWindow()
    const owner = win && !win.isDestroyed() ? win : undefined
    const options = {
      type: 'error',
      title: 'Knote',
      message: '文档尚未安全保存，Knote 已取消退出。',
      detail: '请确认文件仍可写，然后再次退出。Knote 不会在保存或恢复失败时强制关闭。'
    }
    void (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)).catch(() => {})
  }
})
durableQuitCleanup.install()

// ---- One-click PaddleOCR environment install / reinstall / uninstall ----
const emitEnvProgress = (line) => { try { if (win && !win.isDestroyed()) win.webContents.send('knote:pdf-env-progress', String(line)) } catch { /* ignore */ } }
// delete a directory, retrying to absorb Windows handle-release lag (a just-
// killed python keeps file locks briefly). Returns true only if it's gone.
const rmDirWithRetry = async (dir, tries = 6) => {
  for (let i = 0; i < tries; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* locked — retry */ }
    if (!fs.existsSync(dir)) return true
    await new Promise((r) => setTimeout(r, 450))
  }
  return !fs.existsSync(dir)
}
// spawn a command, stream stdout+stderr lines to the UI, resolve on exit 0
const runStreaming = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  if (quitting) { reject(new Error('应用正在退出')); return }
  let proc
  // noProxy: local proxies (Clash 等) routinely truncate/stall the multi-
  // hundred-MB paddle wheels and model tars — the child then hangs forever
  // with zero output. pip/model downloads use China-direct mirrors instead.
  const env = opts.noProxy
    ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?|all)_proxy$/i.test(k)))
    : process.env
  try { proc = spawn(cmd, args, { windowsHide: true, env }) } catch (e) { reject(e); return }
  pdfEnvChild = proc
  const onData = (d) => d.toString().split(/\r?\n/).forEach((l) => { if (l.trim()) emitEnvProgress(l) })
  proc.stdout.on('data', onData)
  proc.stderr.on('data', onData)
  const release = () => { if (pdfEnvChild === proc) pdfEnvChild = null }
  proc.on('error', (e) => { release(); reject(e) })
  proc.on('close', (code) => { release(); code === 0 ? resolve() : reject(new Error(`${path.basename(String(cmd))} 退出码 ${code}`)) })
})
// Plain https download, redirect-following, DIRECT connection (node core
// ignores proxy env vars — deliberate: the sources below are China-hosted
// mirrors, and local proxies truncate large binaries).
const downloadFile = (url, dest, label, redirects = 0) => new Promise((resolve, reject) => {
  if (redirects > 5) { reject(new Error('too many redirects')); return }
  const req = https.get(url, { headers: { 'User-Agent': 'Knote' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume()
      downloadFile(new URL(res.headers.location, url).href, dest, label, redirects + 1).then(resolve, reject)
      return
    }
    if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return }
    const total = Number(res.headers['content-length'] || 0)
    let got = 0
    let lastPct = -10
    const out = fs.createWriteStream(dest)
    res.on('data', (d) => {
      got += d.length
      if (total) {
        const pct = Math.floor((got / total) * 100)
        if (pct >= lastPct + 10) { lastPct = pct; emitEnvProgress(`${label} 下载中 ${pct}%…`) }
      }
    })
    // pipeline destroys BOTH streams on any failure — a bare pipe leaks the
    // fd and lets a fallback attempt interleave writes into the same file
    pipeline(res, out, (err) => {
      if (err) { reject(err); return }
      if (total && got < total) reject(new Error(`下载不完整（${got}/${total}）`))
      else resolve()
    })
  })
  req.on('error', reject)
  req.setTimeout(60000, () => req.destroy(new Error('下载超时')))
})
const downloadWithFallbacks = async (urls, dest, label) => {
  let last = null
  for (const u of urls) {
    try { await downloadFile(u, dest, label); return } catch (e) { last = e; emitEnvProgress(`${label} 源 ${new URL(u).host} 失败（${String((e && e.message) || e)}），换源…`) }
  }
  throw new Error(`${label} 下载失败：${String((last && last.message) || last)}`)
}
// No system python? Bootstrap the official EMBEDDABLE CPython (≈11 MB)
// straight into pdf-env — zero user setup. China-hosted mirrors first;
// python.org as the last resort. pip is added via get-pip.
const EMBED_PY_VER = '3.11.9'
const ensureEmbeddedPython = async (dir) => {
  if (process.platform !== 'win32') throw new Error('未找到 Python，请先安装 Python 3（建议 3.10 / 3.11）')
  fs.mkdirSync(dir, { recursive: true })
  const zip = path.join(dir, 'python-embed.zip')
  emitEnvProgress('未检测到系统 Python——自动下载内置版 Python（约 11 MB）…')
  await downloadWithFallbacks([
    `https://registry.npmmirror.com/-/binary/python/${EMBED_PY_VER}/python-${EMBED_PY_VER}-embed-amd64.zip`,
    `https://mirrors.huaweicloud.com/python/${EMBED_PY_VER}/python-${EMBED_PY_VER}-embed-amd64.zip`,
    `https://www.python.org/ftp/python/${EMBED_PY_VER}/python-${EMBED_PY_VER}-embed-amd64.zip`
  ], zip, '内置 Python')
  emitEnvProgress('解压内置 Python…')
  try {
    try {
      await runStreaming('tar', ['-xf', zip, '-C', dir]) // Windows 10+ bsdtar reads zip
    } catch {
      // old LTSC/Server images lack tar.exe — PowerShell can always unzip
      await runStreaming('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`])
    }
  } finally {
    try { fs.unlinkSync(zip) } catch { /* ignore */ }
  }
  // the embeddable distro ships with site-packages DISABLED — enable it, or
  // pip-installed packages are invisible
  const pth = fs.readdirSync(dir).find((f) => /^python\d+\._pth$/.test(f))
  if (pth) {
    const p = path.join(dir, pth)
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^#\s*import site/m, 'import site'))
  }
  const py = path.join(dir, 'python.exe')
  if (!fs.existsSync(py)) throw new Error('内置 Python 解压失败')
  emitEnvProgress('安装 pip…')
  const getPip = path.join(dir, 'get-pip.py')
  // pypa first: aliyun mirrors an OLD get-pip (installs pip 20.x) — workable
  // only because the installer upgrades pip right after; prefer current
  await downloadWithFallbacks([
    'https://bootstrap.pypa.io/get-pip.py',
    'https://mirrors.aliyun.com/pypi/get-pip.py'
  ], getPip, 'get-pip')
  await runStreaming(py, [getPip, '--no-warn-script-location', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'], { noProxy: true })
  try { fs.unlinkSync(getPip) } catch { /* ignore */ }
  return py
}
// the first system python whose `--version` runs (for creating the venv)
const firstWorkingPython = () => new Promise((resolve) => {
  const cands = pythonCandidates(); let i = 0
  const tryOne = () => {
    if (i >= cands.length) { resolve(null); return }
    const py = cands[i++]
    let proc
    try { proc = spawn(py, ['--version'], { windowsHide: true }) } catch { tryOne(); return }
    proc.on('error', () => tryOne())
    proc.on('close', (code) => (code === 0 ? resolve(py) : tryOne()))
  }
  tryOne()
})

let win = null
let tray = null
let rendererReady = false
// open targets queued until the window AND renderer exist. An array, not a
// single slot: two rapid opens during startup must both survive.
let pendingOpens = [] // [{ type: 'file'|'folder', path, requestId?, openSequence? }]
// Foreground opens can finish out of order now that file reads are async.  The
// renderer uses this intent-time sequence (not delivery order) so a slow A can
// never overwrite the B the user opened afterwards.
let foregroundOpenIntentSequence = 0
// live-save may only write files the MAIN process handed to the renderer
const writablePaths = new Set()
// folder workspaces the renderer may browse/write (registered here only)
const folderRoots = new Set()
const folderRootGrants = []
// folders the renderer may READ ONLY — the directory a file-associated .md
// lives in, so ![](relative/x.png) images next to it can be resolved (no
// write access, unlike folderRoots)
const imageReadRoots = new Set()
const imageReadRootGrants = []
// folders the renderer may write IMAGE ASSETS into (the directory a
// file-associated .md lives in — for <docdir>/assets/*.png). Narrower than a
// full folder root: only used by the write-image-file IPC.
const assetWriteRoots = new Set()
const assetWriteRootGrants = []
// Exact single-file grants use a frozen canonical parent. This prevents a
// previously opened path from being replaced with a symlink to another file.
const writablePathGrants = new Map()
const grantDirectory = (paths, grants, dir) => {
  const abs = path.resolve(String(dir || ''))
  const grant = createBoundaryRoot(abs)
  paths.add(abs)
  if (!grants.some((item) => pathKey(item.lexical) === pathKey(grant.lexical))) grants.push(grant)
  return abs
}
const grantWritablePath = (filePath) => {
  const abs = path.resolve(String(filePath || ''))
  const parent = createBoundaryRoot(path.dirname(abs))
  writablePaths.add(abs)
  writablePathGrants.set(pathKey(abs), { lexical: abs, parent })
  return abs
}
const authorizeWritablePath = (candidate, { creatable = false } = {}) => {
  const abs = path.resolve(String(candidate || ''))
  const grant = writablePathGrants.get(pathKey(abs))
  if (!grant || pathKey(grant.lexical) !== pathKey(abs)) throw new Error('outside workspace')
  return (creatable ? authorizeCreatablePath : authorizeExistingPath)(abs, [grant.parent]).lexical
}

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

const normalizeOpenRequestId = (value) => typeof value === 'string'
  ? value.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 128)
  : ''

const foregroundSequenceFor = (meta, requestId) => {
  const supplied = Number(meta && meta.openSequence)
  if (Number.isSafeInteger(supplied) && supplied > 0) {
    foregroundOpenIntentSequence = Math.max(foregroundOpenIntentSequence, supplied)
    return supplied
  }
  // Session replay is ordered by its requestId/ack protocol and must not look
  // like a new foreground intent when main echoes it back.
  if (requestId) return 0
  foregroundOpenIntentSequence += 1
  return foregroundOpenIntentSequence
}

const PROGRESSIVE_TEXT_THRESHOLD = 384 * 1024

const sendOpenFile = async (p, meta = {}) => {
  if (!p) return false
  const requestId = normalizeOpenRequestId(meta.requestId)
  const openSequence = foregroundSequenceFor(meta, requestId)
  if (!win || !rendererReady) { pendingOpens.push({ type: 'file', path: p, requestId, openSequence }); return true }
  try {
    // Establish every capability before yielding. The asynchronous disk read
    // must not observe a renderer-provided path that changed authorization
    // while the main event loop was free to process another request.
    const granted = grantWritablePath(p)
    grantDirectory(imageReadRoots, imageReadRootGrants, path.dirname(granted)) // read images next to it
    grantDirectory(assetWriteRoots, assetWriteRootGrants, path.dirname(granted)) // write <dir>/assets/*.png
    const target = authorizeWritablePath(granted)
    const stat = await fs.promises.stat(target)
    const progressive = stat.size >= PROGRESSIVE_TEXT_THRESHOLD
    const data = progressive ? null : await fs.promises.readFile(target, 'utf8')
    if (!win || win.isDestroyed() || !rendererReady) {
      pendingOpens.push({ type: 'file', path: target, requestId, openSequence })
      return true
    }
    win.webContents.send('knote:open-file', {
      path: target,
      name: path.basename(target),
      data,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      requestId,
      openSequence
    })
    return true
  } catch { return false }
}

const sendOpenFolder = (p, meta = {}) => {
  if (!p) return false
  const requestId = normalizeOpenRequestId(meta.requestId)
  const openSequence = foregroundSequenceFor(meta, requestId)
  if (!win || !rendererReady) { pendingOpens.push({ type: 'folder', path: p, requestId, openSequence }); return true }
  const root = grantDirectory(folderRoots, folderRootGrants, p)
  win.webContents.send('knote:open-folder', {
    path: root,
    name: path.basename(root),
    requestId,
    openSequence
  })
  return true
}

const sendOpenTarget = (target) => {
  if (!target) return
  if (target.type === 'folder') sendOpenFolder(target.path, target)
  else void sendOpenFile(target.path, target)
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
  // Attach before loadFile so an initial renderer crash is not missed.
  crashDiagnostics.attachWindow(win)
  const windowState = () => ({
    maximized: win ? win.isMaximized() : false,
    minimized: win ? win.isMinimized() : false,
    fullscreen: win ? win.isFullScreen() : false
  })
  const emitWindowState = () => {
    try { if (win && !win.isDestroyed()) win.webContents.send('knote:window-state', windowState()) } catch { /* closing */ }
  }
  win.on('maximize', emitWindowState)
  win.on('unmaximize', emitWindowState)
  win.on('restore', emitWindowState)
  win.on('enter-full-screen', emitWindowState)
  win.on('leave-full-screen', emitWindowState)
  win.webContents.on('did-finish-load', emitWindowState)
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  // external links (markdown links, docs, ...) open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  const appHtmlUrlKey = () => pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href
  const urlKey = (value) => process.platform === 'win32' ? String(value).toLowerCase() : String(value)
  win.webContents.on('will-navigate', (e, url) => {
    if (/^https?:/i.test(url)) {
      e.preventDefault()
      shell.openExternal(url)
      return
    }
    // A click on a local-file markdown link ([x](assets/report.pdf)) would
    // otherwise navigate the whole window away from the app. The renderer
    // intercepts supported relative links itself (open with the OS default
    // app); anything else that isn't a reload of the app shell is dropped.
    if (urlKey(url) === urlKey(appHtmlUrlKey())) return
    e.preventDefault()
  })
  // Windows logoff/shutdown closes windows through the session-end path. Mark
  // it as a real quit before the ordinary close handler runs, otherwise the
  // tray behaviour below can hide the window and fight the OS shutdown. That
  // close/quit re-entry has produced native breakpoint failures in Electron
  // tray applications on some Windows builds.
  win.on('query-session-end', (event) => {
    quitting = true
    event.preventDefault()
    app.quit()
  })
  win.on('session-end', () => { quitting = true })
  // background residence: closing hides to the tray instead of quitting
  win.on('close', (e) => {
    if (!quitting && !isE2E) {
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
const isProbe = !!(process.env.KNOTE_SMOKE || process.env.KNOTE_SHOT || process.env.KNOTE_PDF || isE2E)
// Software rendering is needed only for deterministic capturePage output.
// Interactive E2E must use the same GPU path as production: forcing
// SwiftShader here made Chromium abort when that optional DLL could not load.
if (process.env.KNOTE_SHOT) app.disableHardwareAcceleration()
const gotLock = isProbe ? true : app.requestSingleInstanceLock()
const initialInstallerShutdownRequest = installerShutdownRequestFromArgv(process.argv)
const handleInstallerShutdownRequest = (request) => {
  if (!request || pathKey(request.target) !== pathKey(process.execPath) || !request.ackPath) return false
  installerShutdownAckPath = request.ackPath
  quitting = true
  app.quit()
  return true
}
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv, workingDirectory) => {
    if (handleInstallerShutdownRequest(installerShutdownRequestFromArgv(argv))) return
    showWindow()
    sendOpenTarget(openTargetFromArgv(argv, workingDirectory))
  })

  ipcMain.on('knote:renderer-ready', () => {
    rendererReady = true
    const queued = pendingOpens
    pendingOpens = []
    queued.forEach(sendOpenTarget)
  })

  ipcMain.on('knote:renderer-quit-ready', (event, payload) => {
    rendererQuitHandshake.acknowledge(event.sender, payload)
  })

  ipcMain.handle('knote:write-file', (_e, { path: p, data }) => serializeFsMutation(async () => {
    const target = authorizeWritablePath(p, { creatable: true })
    fsMutations.assertWritable(target)
    await retention().saveDocument(target, String(data), { label: 'save' })
    return true
  }))

  ipcMain.handle('knote:history-add', async (_e, { identity, content, time, label }) => {
    return retention().addSnapshot(identity, String(content == null ? '' : content), { time, label })
  })
  ipcMain.handle('knote:history-list', (_e, { identity }) => retention().listSnapshots(identity))
  ipcMain.handle('knote:history-get', (_e, { identity, id }) => retention().getSnapshot(identity, id))

  // Verified, renderer-opaque swap space for cold editor tabs. References are
  // signed by the store and never contain filesystem paths, so the renderer
  // cannot turn these methods into a general file read/write primitive.
  ipcMain.handle('knote:tab-buffer-put', (_e, { sessionId, tabId, content }) => {
    return tabBuffers().put(sessionId, tabId, content)
  })
  ipcMain.handle('knote:tab-buffer-get', (_e, { ref }) => tabBuffers().get(ref))
  ipcMain.handle('knote:tab-buffer-drop', (_e, { ref }) => tabBuffers().drop(ref))
  ipcMain.handle('knote:tab-buffer-clear-session', (_e, { sessionId }) => tabBuffers().clearSession(sessionId))

  // ---- folder-workspace fs (paths confined to registered roots) ----
  const writeGrants = () => folderRootGrants
  // A single-file open grants its exact document plus narrowly-scoped image
  // access. Its parent must never become a general list/read/binary root.
  const readGrants = () => folderRootGrants
  const existingWritePath = (p) => authorizeExistingPath(p, writeGrants()).lexical
  const creatableWritePath = (p) => authorizeCreatablePath(p, writeGrants()).lexical
  const existingReadPath = (p) => authorizeExistingPath(p, readGrants()).lexical
  const creatableReadPath = (p) => authorizeCreatablePath(p, readGrants()).lexical
  const existingImagePath = (p) => {
    try { return authorizeExistingImagePath(p, readGrants()).lexical } catch (folderError) {
      try { return authorizeExistingImagePath(p, imageReadRootGrants).lexical } catch { throw folderError }
    }
  }
  const creatableImagePath = (p) => {
    try { return authorizeCreatableImagePath(p, writeGrants()).lexical } catch (folderError) {
      try { return authorizeCreatableAssetImagePath(p, assetWriteRootGrants).lexical } catch { throw folderError }
    }
  }
  // extension-agnostic sibling of creatableImagePath: attachments (pdf/docx/
  // zip/...) copied into a doc's assets/ folder. Folder workspaces accept any
  // path under the root (like images); single-file docs must stay below their
  // own assets/ directory.
  const creatableAssetPath = (p) => {
    try { return authorizeCreatablePath(p, writeGrants()).lexical } catch (folderError) {
      try { return authorizeCreatableAssetPath(p, assetWriteRootGrants).lexical } catch { throw folderError }
    }
  }
  // Last-chosen attachment destination folder per document directory. Persisted
  // to userData (never inside a workspace), so "insert attachment" opens with
  // the folder used last time; every stored value is re-authorized with the
  // creatable probe on read and silently dropped when it no longer qualifies.
  const attachmentTargetStore = (() => {
    let cache = null
    let storeFile = null
    const filePath = () => {
      if (!storeFile) storeFile = path.join(app.getPath('userData'), 'attachment-targets.json')
      return storeFile
    }
    const load = async () => {
      if (cache) return cache
      try { cache = JSON.parse(await fs.promises.readFile(filePath(), 'utf8')) } catch { cache = {} }
      return cache
    }
    const persist = async () => {
      try {
        await fs.promises.mkdir(path.dirname(filePath()), { recursive: true })
        await fs.promises.writeFile(filePath(), JSON.stringify(cache || {}))
      } catch { /* best-effort persistence */ }
    }
    const qualifies = (abs) => {
      try { creatableAssetPath(path.join(abs, '__knote_attach_probe__')); return true } catch { return false }
    }
    return {
      async get(docDir) {
        const key = path.resolve(String(docDir || ''))
        const data = await load()
        const stored = data[key] || ''
        if (stored && qualifies(path.resolve(stored))) return { target: path.resolve(stored) }
        return { target: path.join(key, 'assets') }
      },
      async set(docDir, target) {
        const key = path.resolve(String(docDir || ''))
        const abs = path.resolve(String(target || ''))
        if (!qualifies(abs)) return { ok: false }
        const data = await load()
        data[key] = abs
        cache = data
        await persist()
        return { ok: true }
      }
    }
  })()
  const existingReadOrWritablePath = (p) => {
    try { return existingReadPath(p) } catch (readError) {
      try { return authorizeWritablePath(p) } catch { throw readError }
    }
  }
  // open-with-OS-app is wider than read/write: a single-file document's own
  // directory is only an image-read/asset-write root, yet links in that doc
  // point at <docdir>/assets/... attachments that must be openable too.
  const openGrants = () => [...folderRootGrants, ...imageReadRootGrants, ...assetWriteRootGrants]
  const existingOpenPath = (p) => authorizeExistingPath(p, openGrants()).lexical
  const existingWriteOrWritablePath = (p) => {
    try { return existingWritePath(p) } catch (writeError) {
      try { return authorizeWritablePath(p) } catch { throw writeError }
    }
  }
  const creatableWriteOrWritablePath = (p) => {
    try { return creatableWritePath(p) } catch (writeError) {
      try { return authorizeWritablePath(p, { creatable: true }) } catch { throw writeError }
    }
  }
  ipcMain.handle('knote:fs-list', async (_e, { dir }) => {
    const target = existingReadPath(dir)
    const entries = await fs.promises.readdir(target, { withFileTypes: true })
    return entries
      .filter((d) => !d.isSymbolicLink())
      .map((d) => ({ name: d.name, kind: d.isDirectory() ? 'directory' : 'file' }))
  })
  ipcMain.handle('knote:fs-read', async (_e, { path: p }) => {
    const target = existingReadOrWritablePath(p)
    return fs.promises.readFile(target, 'utf8')
  })
  ipcMain.handle('knote:fs-read-chunk', async (_e, {
    path: p,
    offset,
    length,
    expectedSize,
    expectedMtimeMs
  }) => {
    const target = existingReadOrWritablePath(p)
    const start = Math.max(0, Math.trunc(Number(offset) || 0))
    const requested = Math.max(1, Math.min(512 * 1024, Math.trunc(Number(length) || 256 * 1024)))
    const handle = await fs.promises.open(target, 'r')
    try {
      const before = await handle.stat()
      if ((Number.isFinite(Number(expectedSize)) && before.size !== Number(expectedSize)) ||
          (Number.isFinite(Number(expectedMtimeMs)) && before.mtimeMs !== Number(expectedMtimeMs))) {
        const error = new Error('file_changed_during_progressive_read')
        error.code = 'FILE_CHANGED_DURING_READ'
        throw error
      }
      const remaining = Math.max(0, before.size - start)
      const buffer = Buffer.allocUnsafe(Math.min(requested, remaining))
      const read = buffer.length
        ? await handle.read(buffer, 0, buffer.length, start)
        : { bytesRead: 0 }
      const after = await handle.stat()
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        const error = new Error('file_changed_during_progressive_read')
        error.code = 'FILE_CHANGED_DURING_READ'
        throw error
      }
      return {
        bytes: buffer.subarray(0, read.bytesRead),
        bytesRead: read.bytesRead,
        size: before.size,
        mtimeMs: before.mtimeMs,
        done: start + read.bytesRead >= before.size
      }
    } finally {
      await handle.close()
    }
  })
  ipcMain.handle('knote:fs-exists', async (_e, { path: p }) => {
    let target
    try { target = creatableReadPath(p) } catch { return false }
    try {
      await fs.promises.access(target, fs.constants.F_OK)
      return true
    } catch { return false }
  })
  // mtime probe for the external-change watcher — stat only, no content read.
  // writablePaths covers file-association singles whose dir is only an
  // image-read root.
  ipcMain.handle('knote:fs-stat', async (_e, { path: p }) => {
    const target = existingReadOrWritablePath(p)
    try {
      // async: this fires every 2s from the watcher — a sync stat on a slow
      // network/removable drive would block the whole main event loop
      const st = await fs.promises.stat(target)
      return { ok: true, mtimeMs: st.mtimeMs, size: st.size }
    } catch { return { ok: false } }
  })
  // read a BINARY image next to an opened file/folder and return a data URL
  // (fs-read is utf8-only and would corrupt binary); read-only roots only
  ipcMain.handle('knote:read-image-file', async (_e, { path: p }) => {
    const target = existingImagePath(p)
    const buf = await fs.promises.readFile(target)
    const ext = path.extname(target).toLowerCase()
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif' }[ext] || 'application/octet-stream'
    return `data:${mime};base64,${buf.toString('base64')}`
  })
  // read ANY workspace file as raw bytes (base64) — used by the agent's
  // read_workspace_pdf / read_workspace_image tools. Confined to read-only
  // roots and hard-capped so a giant file can't exhaust main-process memory.
  ipcMain.handle('knote:read-file-bytes', async (_e, { path: p }) => {
    const target = existingReadPath(p)
    let st
    try { st = await fs.promises.stat(target) } catch { throw new Error('not_found') }
    if (!st.isFile()) throw new Error('not_a_file')
    const CAP = 64 * 1024 * 1024
    if (st.size > CAP) throw new Error('too_large')
    const buf = await fs.promises.readFile(target)
    // The file may have grown between stat and read. Cap the bytes actually
    // retained as well, not only the earlier metadata snapshot.
    if (buf.length > CAP) throw new Error('too_large')
    const ext = path.extname(target).toLowerCase()
    const mime = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream'
    return { base64: buf.toString('base64'), mime, size: buf.length }
  })
  // Serialize filesystem mutations and tombstone paths that were deleted or
  // renamed during this renderer session. A delayed save that arrives after a
  // destructive operation must fail instead of recreating the old pathname.
  const fsMutations = createFsMutationCoordinator({ toKey: pathKey, separator: path.sep })
  waitForFsMutations = () => fsMutations.whenIdle()
  const serializeFsMutation = (task) => fsMutations.run(task)
  const stalePathContains = (target) => fsMutations.isStale(target)
  const markStaleWritePath = (target) => fsMutations.markStale(target)
  const clearStaleWritePath = (target) => fsMutations.clearStale(target)

  ipcMain.handle('knote:fs-write', (_e, { path: p, data }) => serializeFsMutation(async () => {
    const target = creatableWriteOrWritablePath(p)
    fsMutations.assertWritable(target)
    await retention().saveDocument(target, String(data), { label: 'save' })
    return true
  }))
  ipcMain.handle('knote:fs-create', (_e, { path: p }) => serializeFsMutation(async () => {
    const target = creatableWriteOrWritablePath(p)
    const handle = await fs.promises.open(target, 'a')
    await handle.close()
    clearStaleWritePath(target)
    return true
  }))
  const markdownFilesUnder = async (target) => {
    const checked = existingWriteOrWritablePath(target)
    let st
    try { st = await fs.promises.lstat(checked) } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    if (st.isSymbolicLink()) return []
    if (st.isFile()) return /\.(md|markdown)$/i.test(checked) ? [checked] : []
    if (!st.isDirectory()) return []
    const result = []
    const entries = await fs.promises.readdir(checked, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      result.push(...await markdownFilesUnder(path.join(checked, entry.name)))
    }
    return result
  }
  const preserveFiles = async (files, label) => {
    for (const file of files) {
      let text
      try {
        text = await fs.promises.readFile(file, 'utf8')
      } catch (error) {
        if (error.code === 'ENOENT') continue // externally removed during the scan
        throw error
      }
      // Deliberately propagate history write failures. A delete/rename must be
      // refused when its recovery copy could not be made; proceeding would
      // violate the no-data-loss guarantee.
      await retention().addSnapshot(`file:${file}`, text, { time: Date.now(), label })
    }
  }
  ipcMain.handle('knote:fs-delete', (_e, { path: p }) => serializeFsMutation(async () => {
    const target = existingWritePath(p)
    await preserveFiles(await markdownFilesUnder(target), 'before-delete')
    await fs.promises.rm(target, { force: true, recursive: true })
    markStaleWritePath(target)
    return true
  }))
  ipcMain.handle('knote:fs-mkdir', (_e, { path: p }) => serializeFsMutation(async () => {
    const target = creatableWritePath(p)
    await fs.promises.mkdir(target, { recursive: true })
    clearStaleWritePath(target)
    return true
  }))
  // write an image asset (base64 -> raw bytes) into a folder root or a
  // file-associated doc's own directory; creates the parent (assets/) folder
  ipcMain.handle('knote:write-image-file', (_e, { path: p, base64 }) => serializeFsMutation(async () => {
    const target = creatableImagePath(p)
    fsMutations.assertWritable(target)
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    // Re-authorize after mkdir so an externally-created junction or hard link
    // cannot be smuggled into the previously missing path.
    const checked = creatableImagePath(target)
    fsMutations.assertWritable(checked)
    await fs.promises.writeFile(checked, Buffer.from(String(base64 || ''), 'base64'))
    return true
  }))
  // Import an arbitrary local file (email-attachment style: pdf/docx/zip/...)
  // into <docDir>/assets/ and hand back the relative markdown-link target. The
  // SOURCE comes from a native dialog in main (a renderer-supplied path could
  // turn this IPC into an arbitrary copy primitive); the DESTINATION must be a
  // creatable asset path inside a registered root. Name collisions get a -2/-3
  // suffix so re-imports never overwrite an existing attachment.
  const nextAvailableName = async (assetsDir, base) => {
    const ext = path.extname(base)
    const stem = ext ? base.slice(0, -ext.length) : base
    let candidate = base
    let index = 2
    for (;;) {
      try {
        await fs.promises.access(path.join(assetsDir, candidate), fs.constants.F_OK)
      } catch {
        return candidate
      }
      candidate = `${stem}-${index}${ext}`
      index += 1
    }
  }
  // Native picker + pre-copy validation, OUTSIDE the mutation lock so a user
  // thinking at the dialog never stalls autosaves. Returns null on cancel.
  // The copy lands in <dir>/assets/ by default, or in a user-chosen target
  // folder inside the granted writable roots (the attachment folder picker
  // knote:attachment-dirs only ever lists creatable targets). A caller-provided
  // source skips the native file dialog (the renderer picks it first inside
  // the insert-attachment popup).
  const pickImport = async (dir, target = '', source = '') => {
    const targetDir = target ? path.resolve(String(target)) : path.join(path.resolve(String(dir || '')), 'assets')
    // Validate the target BEFORE showing the dialog so a path outside every
    // granted root is rejected without waiting for a human pick.
    try { creatableAssetPath(path.join(targetDir, '__knote_import_probe__')) } catch (error) { throw error }
    const sourcePath = String(source || '')
    if (!sourcePath) {
      const result = await dialog.showOpenDialog(win, {
        title: 'Attach a file / 附加一个文件',
        properties: ['openFile'],
        filters: [{ name: 'All Files', extensions: ['*'] }]
      })
      if (result.canceled || !result.filePaths.length) return null
      return pickImport(dir, targetDir, result.filePaths[0])
    }
    let stat
    try { stat = await fs.promises.stat(sourcePath) } catch { return null }
    if (!stat.isFile()) return null
    return { source: sourcePath, targetDir, uniqueName: await nextAvailableName(targetDir, path.basename(sourcePath).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim() || 'attachment') }
  }
  ipcMain.handle('knote:import-attachment', async (_e, { dir, target, source }) => {
    const picked = await pickImport(dir, target, source)
    if (!picked) return { canceled: true }
    const result = await serializeFsMutation(async () => {
      const dest = path.join(picked.targetDir, picked.uniqueName)
      const checked = creatableAssetPath(dest)
      fsMutations.assertWritable(checked)
      await fs.promises.mkdir(path.dirname(checked), { recursive: true })
      // Re-authorize after mkdir so an externally-created junction or hard link
      // cannot be smuggled into the previously missing path.
      const rechecked = creatableAssetPath(checked)
      fsMutations.assertWritable(rechecked)
      await fs.promises.copyFile(picked.source, rechecked)
      const relative = path.relative(path.resolve(String(dir || '')), rechecked).replace(/\\/g, '/')
      return { canceled: false, relative, name: path.basename(rechecked) }
    })
    // The chosen destination folder becomes the default for the NEXT insert
    // (persisted to disk, re-authorized on every read).
    if (result && !result.canceled) {
      try { await attachmentTargetStore.set(dir, picked.targetDir) } catch { /* best-effort persistence */ }
    }
    return result
  })
  // pick any local file and return its absolute path WITHOUT copying: the
  // renderer turns it into a markdown link referencing the file in place.
  // The picked path is registered as an explicitly user-chosen open target —
  // clicking the link later calls knote:open-path, which must be able to open
  // it even when it lives OUTSIDE every workspace root (that is the point of
  // an in-place reference). Nothing outside this set ever passes open-path.
  const pickedOpenPaths = new Set()
  const MAX_PICKED_OPEN_PATHS = 128
  const registerPickedOpenPath = (p) => {
    const abs = path.resolve(String(p || ''))
    if (pickedOpenPaths.size >= MAX_PICKED_OPEN_PATHS) pickedOpenPaths.delete(pickedOpenPaths.values().next().value)
    pickedOpenPaths.add(abs)
    return abs
  }
  ipcMain.handle('knote:pick-file-to-link', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Link a file / 链接一个文件',
      properties: ['openFile'],
      filters: [{ name: 'All Files', extensions: ['*'] }]
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    return { canceled: false, path: registerPickedOpenPath(result.filePaths[0]) }
  })
  // Destination folders for an attachment copy, RESTRICTED to the current
  // document's file tree: only directories that pass the same creatable probe
  // used by the actual copy (creatableAssetPath) are listed, so the renderer
  // can never steer an import outside the granted roots. Single-file documents
  // only expose their <dir>/assets subtree; folder workspaces expose every
  // subdirectory (the doc dir itself included).
  ipcMain.handle('knote:attachment-dirs', async (_e, { dir }) => {
    const root = path.resolve(String(dir || ''))
    const dirs = []
    const seen = new Set()
    const push = (abs, rel) => {
      if (seen.has(abs)) return
      try { creatableAssetPath(path.join(abs, '__knote_attach_probe__')) } catch { return }
      seen.add(abs)
      dirs.push({ abs, rel })
    }
    const assets = path.join(root, 'assets')
    push(assets, 'assets')
    const walk = async (abs, rel, depth) => {
      if (depth > 6) return
      let entries
      try { entries = await fs.promises.readdir(abs, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const nextRel = rel ? `${rel}/${entry.name}` : entry.name
        const nextAbs = path.join(abs, entry.name)
        push(nextAbs, nextRel)
        await walk(nextAbs, nextRel, depth + 1)
      }
    }
    const underFolderRoot = folderRootGrants.some((r) => {
      const base = path.resolve(r.lexical || r)
      const rel = path.relative(base, root)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    })
    if (underFolderRoot) {
      push(root, '.')
      await walk(root, '', 0)
    } else {
      await walk(assets, 'assets', 0)
    }
    dirs.sort((a, b) => {
      if (a.abs === assets) return -1
      if (b.abs === assets) return 1
      return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0
    })
    return { dirs }
  })
  // The renderer picks the SOURCE file first (inside the insert popup); the
  // copy itself happens in knote:import-attachment. Not registered as an open
  // target: the link points at the COPY inside the document tree.
  ipcMain.handle('knote:pick-import-file', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Pick file to attach / 选择要插入的文件',
      properties: ['openFile'],
      filters: [{ name: 'All Files', extensions: ['*'] }]
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    return { canceled: false, source: result.filePaths[0] }
  })
  // Last-chosen attachment folder per document directory, persisted to disk
  // (userData) and re-authorized on every read, so a stale or moved folder
  // falls back to the default <dir>/assets.
  ipcMain.handle('knote:attachment-target-get', async (_e, { dir }) => attachmentTargetStore.get(dir))
  ipcMain.handle('knote:attachment-target-set', async (_e, { dir, target }) => attachmentTargetStore.set(dir, target))
  // Create / rename attachment destination folders from inside the insert
  // popup. Every path goes through the SAME creatable probe as the copy, so
  // these helpers can only touch folders the import is allowed to write into.
  ipcMain.handle('knote:attachment-mkdir', (_e, { dir, parent, name }) => serializeFsMutation(async () => {
    const clean = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim()
    if (!clean) return { ok: false, error: 'invalid_name' }
    const checked = creatableAssetPath(path.join(path.resolve(String(parent || '')), clean))
    fsMutations.assertWritable(checked)
    await fs.promises.mkdir(checked, { recursive: false })
    const rechecked = creatableAssetPath(checked)
    clearStaleWritePath(rechecked)
    const rel = path.relative(path.resolve(String(dir || '')), rechecked).replace(/\\/g, '/')
    return { ok: true, folder: { abs: rechecked, rel } }
  }))
  ipcMain.handle('knote:attachment-rename-dir', (_e, { dir, target, name }) => serializeFsMutation(async () => {
    const clean = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim()
    if (!clean) return { ok: false, error: 'invalid_name' }
    const oldPath = path.resolve(String(target || ''))
    const newPath = path.join(path.dirname(oldPath), clean)
    if (pathKey(oldPath) === pathKey(newPath)) {
      const rel = path.relative(path.resolve(String(dir || '')), oldPath).replace(/\\/g, '/')
      return { ok: true, folder: { abs: oldPath, rel } }
    }
    creatableAssetPath(path.join(oldPath, '__knote_attach_probe__'))
    const checked = creatableAssetPath(newPath)
    fsMutations.assertWritable(oldPath)
    await fs.promises.rename(oldPath, checked)
    markStaleWritePath(oldPath)
    clearStaleWritePath(checked)
    const rel = path.relative(path.resolve(String(dir || '')), checked).replace(/\\/g, '/')
    return { ok: true, folder: { abs: checked, rel } }
  }))
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
  // native Open dialog for the in-app 打开 buttons: the picked path is fed
  // through the SAME pipeline as double-click/argv opens (sendOpenFile/
  // sendOpenFolder), so path-backed handles, permission roots and the
  // recents list all work identically — Chromium's FS-Access picker used
  // before this returned pathless handles that could never be recorded
  // ---- native web search / fetch (no Jina) ----
  // Electron's net stack follows the OS proxy, so requests use the USER's own
  // network reach —搜索词直接从用户 IP 发给引擎,不经任何第三方中转。
  const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  // ---- SSRF guard ----
  // web_fetch's URL is chosen by the MODEL from UNTRUSTED search results, so a
  // lured/redirected fetch could hit the PDF sidecar on localhost, a LAN
  // device, or an intranet host and exfiltrate its response. Block any target
  // that resolves to loopback/private/link-local/ULA/multicast — on the first
  // hop AND every redirect (redirect:'manual', re-validated per hop).
  const isBlockedIP = (ip) => {
    const v = nodeNet.isIP(ip)
    if (v === 4) {
      const p = ip.split('.').map(Number)
      return p[0] === 0 || p[0] === 127 || p[0] === 10 || p[0] >= 224 ||
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
        (p[0] === 192 && p[1] === 168) ||
        (p[0] === 169 && p[1] === 254) ||
        (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
    }
    if (v === 6) {
      const lo = ip.toLowerCase().replace(/^\[|\]$/g, '')
      const m = /::ffff:(\d+\.\d+\.\d+\.\d+)/.exec(lo)
      if (m) return isBlockedIP(m[1])
      return lo === '::1' || lo === '::' || lo.startsWith('fe8') || lo.startsWith('fe9') ||
        lo.startsWith('fea') || lo.startsWith('feb') || lo.startsWith('fc') || lo.startsWith('fd') || lo.startsWith('ff')
    }
    return false
  }
  const dnsLookupAll = (host) => new Promise((res, rej) => dns.lookup(host, { all: true }, (e, a) => e ? rej(e) : res(a)))
  const assertPublicUrl = async (u) => {
    let host
    try { host = new URL(u).hostname.replace(/^\[|\]$/g, '') } catch { throw new Error('bad_url') }
    if (nodeNet.isIP(host)) { if (isBlockedIP(host)) throw new Error('blocked_host'); return }
    let addrs
    try { addrs = await dnsLookupAll(host) } catch { throw new Error('dns_failed') }
    if (!addrs.length || addrs.some((a) => isBlockedIP(a.address))) throw new Error('blocked_host')
  }
  // charset-aware body reader: net delivers raw (decompressed) bytes in the
  // page's own encoding — CJK sites (this app's audience) still serve GBK/
  // Big5/Shift_JIS, which force-UTF-8 turns to mojibake. Detect from
  // Content-Type / <meta charset> and decode via full-ICU TextDecoder.
  const decodeBody = (buf, ct) => {
    let cs = ''
    const hm = /charset=["']?\s*([\w-]+)/i.exec(ct || '')
    if (hm) cs = hm[1].toLowerCase()
    if (!cs) {
      const head = buf.slice(0, 2048).toString('latin1')
      const mm = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head)
      if (mm) cs = mm[1].toLowerCase()
    }
    if (!cs || cs === 'utf-8' || cs === 'utf8' || cs === 'ascii' || cs === 'us-ascii') return buf.toString('utf8')
    try { return new TextDecoder(cs).decode(buf) } catch { return buf.toString('utf8') }
  }
  // HTTP with per-hop SSRF checks. Uses Electron net.request with
  // redirect:'manual' so we can validate every redirect target before
  // following it. The 'redirect' event (not 'response') fires for 3xx.
  const netGet = (url, opts = {}) => {
    const { method = 'GET', body = null, headers = {}, timeout = 15000, maxBytes = 3_000_000, maxRedirects = 5 } = opts
    const hop = async (u, left, m, b) => {
      await assertPublicUrl(u)
      const r = await new Promise((resolve, reject) => {
        let req
        try { req = net.request({ method: m, url: u, redirect: 'manual' }) } catch (e) { reject(e); return }
        req.setHeader('User-Agent', BROWSER_UA)
        req.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
        req.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8')
        req.setHeader('Cache-Control', 'no-cache')
        for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)
        let settled = false
        const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(to); fn(v) }
        const to = setTimeout(() => { try { req.abort() } catch { /* ignore */ } done(reject, new Error('timeout')) }, timeout)
        // redirect:'manual' fires 'redirect' (NOT 'response') for 3xx.
        // We catch it here, validate the target URL, and follow manually.
        req.on('redirect', (statusCode, method, redirectUrl) => {
          try { req.abort() } catch { /* ignore */ }
          let next
          try { next = new URL(redirectUrl, u).href } catch { done(reject, new Error('bad_redirect')); return }
          done(resolve, { redirect: next })
        })
        req.on('response', (res) => {
          const sc = res.statusCode
          // redirect:'manual' means 3xx should never reach here, but guard anyway
          if (sc >= 300 && sc < 400) {
            const loc = res.headers.location && [].concat(res.headers.location)[0]
            res.on('data', () => {})
            res.on('end', () => {
              let next
              try { next = new URL(loc, u).href } catch { done(reject, new Error('bad_redirect')); return }
              done(resolve, { redirect: next })
            })
            return
          }
          if (sc >= 400) { res.on('data', () => {}); done(reject, new Error(`HTTP ${sc}`)); return }
          const ct = (res.headers['content-type'] && [].concat(res.headers['content-type'])[0]) || ''
          const chunks = []; let len = 0
          res.on('data', (c) => { if (settled) return; len += c.length; chunks.push(c); if (len > maxBytes) { try { req.abort() } catch { /* ignore */ } done(resolve, { buf: Buffer.concat(chunks), ct }) } })
          res.on('end', () => done(resolve, { buf: Buffer.concat(chunks), ct }))
          res.on('error', (e) => done(reject, e))
        })
        req.on('error', (e) => done(reject, e))
        if (b) { req.setHeader('Content-Type', 'application/x-www-form-urlencoded'); req.write(b) }
        req.end()
      })
      if (r.redirect) {
        if (left <= 0) throw new Error('too_many_redirects')
        return hop(r.redirect, left - 1, 'GET', null) // standard: follow redirects as GET, no body
      }
      return { text: decodeBody(r.buf, r.ct), ct: r.ct }
    }
    return hop(url, maxRedirects, method, body)
  }
  const decodeEntities = (s) => String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return _ } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d) } catch { return _ } })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'").replace(/&nbsp;/g, ' ')
  const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
  // DDG result anchors point at a /l/?uddg=<encoded real url> redirect
  const uddgReal = (href) => {
    const m = /[?&]uddg=([^&]+)/.exec(href || '')
    if (m) { try { return decodeURIComponent(m[1]) } catch { return null } }
    return /^https?:\/\//.test(href) ? href : null
  }
  // ---- search-engine parsers (Bing + DDG + Mojeek in order) ----
  const isInternalHost = (u) => /^https?:\/\/(?:[^/]*\.)?(?:bing|microsoft|msn|go\.microsoft|mojeek|duckduckgo)\.com/i.test(u)
  // Bing wraps organic titles in <h2><a href="bing.com/ck/a?...&u=a1<base64url>">;
  // decode the u= param to the real destination
  const bingRealUrl = (href) => {
    const m = /[?&]u=a1([^&]+)/.exec(href || '')
    if (m) { try { let b = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '='; return Buffer.from(b, 'base64').toString('utf8') } catch { return null } }
    return /^https?:\/\//.test(href) ? href : null
  }
  const parseBing = (html) => {
    const out = []
    const re = /<h2[^>]*>\s*<a\b[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    let m
    while ((m = re.exec(html)) && out.length < 20) {
      const url = bingRealUrl(decodeEntities(m[1]))
      const title = stripTags(m[2])
      if (url && title && !isInternalHost(url)) out.push({ title, url, snippet: '' })
    }
    return out
  }
  const parseMojeek = (html) => {
    const out = []
    const re = /<a\b(?=[^>]*\bclass="title")[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    let m
    while ((m = re.exec(html)) && out.length < 20) {
      const url = decodeEntities(m[1])
      const title = stripTags(m[2])
      if (/^https?:\/\//.test(url) && title) out.push({ title, url, snippet: '' })
    }
    // snippets sit in <p class="s"> in the same order (no header pollution here)
    const sre = /<p class="s">([\s\S]*?)<\/p>/g
    let i = 0; let sm
    while ((sm = sre.exec(html)) && i < out.length) { out[i].snippet = stripTags(sm[1]).slice(0, 300); i++ }
    return out
  }
  // DDG HTML endpoint (non-JS, lightweight). Results: <a class="result__a"> title + href,
  // <a class="result__snippet"> snippet, <a class="result__url"> display URL.
  const parseDdgHtml = (html) => {
    const out = []
    const blockRe = /<a\b[^>]*\bclass="result__a"\s[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    const snippetRe = /<a\b[^>]*\bclass="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    const titles = []; const snippets = []
    let m
    while ((m = blockRe.exec(html))) {
      // result__a hrefs are //duckduckgo.com/l/?uddg=<encoded real url> —
      // unwrap them or every result fails the protocol/internal-host filter
      const url = uddgReal(decodeEntities(m[1]))
      const title = stripTags(m[2])
      if (url && title && !isInternalHost(url)) titles.push({ url, title })
    }
    while ((m = snippetRe.exec(html))) {
      snippets.push(stripTags(m[1]).slice(0, 300))
    }
    for (let i = 0; i < titles.length && out.length < 20; i++) {
      out.push({ title: titles[i].title, url: titles[i].url, snippet: snippets[i] || '' })
    }
    return out
  }
  // Engines are tried in order; the first that returns results wins.
  // Each engine gets region/language params to bias toward English/international
  // results — Chinese IPs otherwise drown in local aggregator spam (CSDN, ai-bot.cn…)
  const SEARCH_ENGINES = [
    { name: 'bing', url: (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q), parse: parseBing },
    { name: 'duckduckgo', url: (q) => 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), parse: parseDdgHtml },
    { name: 'mojeek', url: (q) => 'https://www.mojeek.com/search?q=' + encodeURIComponent(q), parse: parseMojeek }
  ]
  // Engines with optional region/language override. Region is injected as
  // extra query params so the user (or agent) can switch between cn/en based
  // on their VPN/proxy situation. 'auto' = no override (engine decides by IP).
  const ENGINE_REGION_PARAMS = {
    bing: { en: '&setlang=en&cc=us', zh: '&setlang=zh&cc=cn' },
    duckduckgo: { en: '&kl=us-en', zh: '&kl=cn-zh' }
  }
  const buildEngineUrl = (eng, q, region) => {
    let url = eng.url(q)
    const params = ENGINE_REGION_PARAMS[eng.name]
    if (params && region && region !== 'auto') {
      url += (params[region] || '')
    }
    return url
  }
  ipcMain.handle('knote:web-search', async (_e, { query, max, engine, region }) => {
    const rawQ = String(query || '').trim()
    if (!rawQ) return { ok: false, error: 'empty_query' }
    // Support site: filtering — extract and pass through to engine query
    const siteM = /(?:^|\s)site:(\S+)/i.exec(rawQ)
    const q = rawQ.replace(/\s*site:\S+\s*/gi, ' ').trim() // clean for URL encoding
    const siteFilter = siteM ? siteM[1] : ''
    const n = Math.min(Math.max(1, Number(max) || 8), 12)
    // Filter engines by user preference; 'auto' or unset = try all
    const engines = (engine && engine !== 'auto')
      ? SEARCH_ENGINES.filter((e) => e.name === engine)
      : SEARCH_ENGINES
    if (!engines.length) return { ok: false, error: 'bad_engine', detail: `unknown engine: ${engine}` }
    let lastErr = ''
    for (const eng of engines) {
      try {
        const qs = siteFilter ? `${q} site:${siteFilter}` : q
        const url = buildEngineUrl(eng, qs, region)
        const { text: html } = await netGet(url, { timeout: 15000, maxBytes: 3_000_000 })
        const results = eng.parse(html)
        if (results.length) return { ok: true, engine: eng.name, results: results.slice(0, n) }
      } catch (err) { lastErr = String((err && err.message) || err) }
    }
    // every engine either errored or served a resultless bot/landing page
    return { ok: false, error: lastErr ? 'network' : 'blocked', detail: lastErr.slice(0, 120) }
  })
  ipcMain.handle('knote:web-fetch', async (_e, { url, max }) => {
    const u = String(url || '').trim()
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'bad_url' }
    const cap = Math.min(Math.max(2000, Number(max) || 12000), 40000)
    try {
      const { text: html } = await netGet(u, { timeout: 20000, maxBytes: 3_000_000 })
      let title = ''; let text = ''
      // primary: Readability main-content extraction (same job as Jina reader,
      // done locally) — lazy-required so it never slows startup. JSDOM parses
      // synchronously on the main-process event loop, so a very large page
      // would freeze the UI: skip the DOM path above ~800KB and use the cheap
      // strip fallback instead.
      if (html.length <= 800_000) {
        try {
          const { JSDOM } = require('jsdom')
          const { Readability } = require('@mozilla/readability')
          const dom = new JSDOM(html, { url: u })
          const article = new Readability(dom.window.document).parse()
          if (article && article.content) {
            title = article.title || ''
            const TurndownService = require('turndown')
            text = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(article.content)
          }
        } catch { /* fall through to crude strip */ }
      }
      if (!text) {
        text = String(html)
          .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
        text = decodeEntities(text).replace(/\s+/g, ' ').trim()
      }
      return { ok: true, title, url: u, clipped: text.length > cap, text: text.slice(0, cap) }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err).slice(0, 120) }
    }
  })
  // ---- document text extraction (docx/pptx/xlsx/odt/ods/odp) ----
  // Feeds the agent's workspace reads, chat attachments and the web build's
  // read-only preview. Double-clicking an office doc in the tree does NOT
  // preview in-app — it opens with the OS default application (knote:open-path).
  ipcMain.handle('knote:extract-doc', async (_e, { name, bytes }) => {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || [])
    if (!buf.length) return { ok: false, error: 'bad_bytes' }
    const fname = String(name || '')
    try {
      if (/\.docx$/i.test(fname)) {
        const mammoth = require('mammoth')
        const [htmlRes, txtRes] = await Promise.all([
          mammoth.convertToHtml({ buffer: buf }),
          mammoth.extractRawText({ buffer: buf })
        ])
        return { ok: true, html: htmlRes.value || '', text: txtRes.value || '' }
      }
      if (/\.(pptx|xlsx|odt|ods|odp)$/i.test(fname)) {
        const JSZip = require('jszip')
        const zip = await JSZip.loadAsync(buf)
        const textParts = []
        if (/\.pptx$/i.test(fname)) {
          const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort()
          for (const f of slides) {
            const xml = await zip.files[f].async('string')
            const t = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
            if (t) textParts.push(t)
          }
          return { ok: true, html: textParts.length ? textParts.map((t,i) => `<div class="pptx-slide"><strong>Slide ${i+1}</strong><p>${t}</p></div>`).join('') : '<p>（无内容）</p>', text: textParts.join('\n\n') }
        }
        if (/\.xlsx$/i.test(fname)) {
          const ssXml = zip.files['xl/sharedStrings.xml'] ? await zip.files['xl/sharedStrings.xml'].async('string') : ''
          const ss = []; let m; const siRe = /<si[^>]*>([\s\S]*?)<\/si>/g
          while ((m = siRe.exec(ssXml))) ss.push(m[1].replace(/<[^>]+>/g, '').trim())
          const sheets = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort()
          // place values by their r="B7" column ref: matching only <v>-bearing
          // cells used to collapse away empty/omitted cells and shift every
          // column left of a gap (keep in sync with src/lib/fileReader.js)
          const colIdx = (col) => { let n = 0; for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64); return n - 1 }
          for (const sf of sheets) {
            const xml = await zip.files[sf].async('string')
            const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g; let rm
            while ((rm = rowRe.exec(xml))) {
              const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm; const cells = []
              while ((cm = cellRe.exec(rm[1]))) {
                const attrs = cm[1] || ''; const body = cm[2] || ''
                const ref = /\br="([A-Z]+)\d+"/.exec(attrs)
                const idx = ref ? colIdx(ref[1]) : cells.length
                const vm = /<v>([\s\S]*?)<\/v>/.exec(body)
                let val = ''
                if (/\bt="s"/.test(attrs)) val = vm ? (ss[+vm[1]] || '') : ''
                else if (/\bt="inlineStr"/.test(attrs)) { const im = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body); val = im ? im[1].replace(/<[^>]+>/g, '').trim() : '' }
                else val = vm ? vm[1].trim() : ''
                while (cells.length <= idx) cells.push('')
                cells[idx] = val
              }
              if (cells.some(c => c)) textParts.push(cells.join('\t'))
            }
          }
          const rows = textParts.map(r => `<tr>${r.split('\t').map(c => `<td>${c}</td>`).join('')}</tr>`)
          return { ok: true, html: rows.length ? `<table>${rows.join('')}</table>` : '<p>（无数据）</p>', text: textParts.join('\n') }
        }
        // odt/ods/odp: extract from content.xml
        const contentXml = zip.files['content.xml'] ? await zip.files['content.xml'].async('string') : ''
        const text = contentXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        return { ok: true, html: text ? `<div>${text}</div>` : '<p>（无内容）</p>', text }
      }
      return { ok: false, error: 'unsupported_format' }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err).slice(0, 200) }
    }
  })
  ipcMain.handle('knote:pick-open', async (_e, { kind }) => {
    const isFolder = kind === 'folder'
    const r = await dialog.showOpenDialog(win, isFolder
      ? { properties: ['openDirectory'] }
      : { properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }, { name: 'All Files', extensions: ['*'] }] })
    if (r.canceled || !r.filePaths.length) return { ok: false }
    if (isFolder) sendOpenFolder(r.filePaths[0])
    else sendOpenFile(r.filePaths[0])
    return { ok: true }
  })
  ipcMain.handle('knote:pick-save', async (_e, { defaultName }) => {
    const safeName = String(defaultName || 'document.md').replace(/[<>:"/\\|?*]/g, '_')
    const r = await dialog.showSaveDialog(win, {
      defaultPath: safeName,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false }
    const target = path.resolve(r.filePath)
    grantWritablePath(target)
    grantDirectory(imageReadRoots, imageReadRootGrants, path.dirname(target))
    grantDirectory(assetWriteRoots, assetWriteRootGrants, path.dirname(target))
    return { ok: true, path: target, name: path.basename(target) }
  })
  ipcMain.handle('knote:pdf-analyze', async (_e, { imageBase64, minScore, mode }) => {
    // Paddle's HTTP server and model objects are not safe/useful under
    // concurrent inference. Serialize requests so one heavy page cannot make
    // every parallel caller time out, and restart the complete process tree
    // once when a request genuinely stalls.
    const payload = {
      image_base64: imageBase64,
      min_score: typeof minScore === 'number' ? minScore : 0.5,
      mode: mode === 'layout' ? 'layout' : 'full'
    }
    const run = pdfAnalyzeQueue.then(() => analyzeWithSidecarRecovery(payload))
    pdfAnalyzeQueue = run.catch(() => {})
    return await run
  })
  ipcMain.handle('knote:pdf-env-status', async () => ({
    installed: pdfEnvInstalled(),
    installing: pdfEnvBusy,
    hasVenv: !!venvPython()
  }))
  ipcMain.handle('knote:pdf-env-uninstall', async () => {
    if (pdfEnvBusy) return { ok: false, error: '正在安装/卸载中，请稍候' }
    pdfEnvBusy = true // block concurrent install + sidecar spawn during removal
    try {
      await stopPdfSidecar() // release the venv python if the sidecar is holding it
      await new Promise((r) => setTimeout(r, 400))
      const gone = await rmDirWithRetry(pdfEnvDir())
      return gone ? { ok: true } : { ok: false, error: '无法删除环境目录（可能有进程占用），请重试' }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    } finally {
      pdfEnvBusy = false
    }
  })
  // create the venv (if needed) and pip install PaddleOCR + deps, streaming
  // progress to the renderer via 'knote:pdf-env-progress'
  ipcMain.handle('knote:pdf-env-install', async (_e, { reinstall } = {}) => {
    if (pdfEnvBusy) return { ok: false, error: '已经在安装中' }
    pdfEnvBusy = true
    await stopPdfSidecar()
    await new Promise((r) => setTimeout(r, 300))
    try {
      const dir = pdfEnvDir()
      if (reinstall) {
        emitEnvProgress('清理旧环境…')
        const gone = await rmDirWithRetry(dir)
        if (!gone) throw new Error('无法删除旧环境（可能有进程占用），请关闭相关程序后重试')
      }
      // a half-completed earlier bootstrap (python.exe extracted but pip
      // missing) must not brick the install forever — probe pip and wipe a
      // broken env before deciding how to (re)create it
      if (venvPython()) {
        try {
          await runStreaming(venvPython(), ['-m', 'pip', '--version'])
        } catch {
          emitEnvProgress('检测到损坏的旧环境，清理重建…')
          await rmDirWithRetry(dir)
        }
      }
      if (!venvPython()) {
        const sysPy = await firstWorkingPython()
        if (sysPy) {
          emitEnvProgress(`使用 ${sysPy} 创建虚拟环境…`)
          await runStreaming(sysPy, ['-m', 'venv', dir])
        } else {
          // one-click promise: no system python is NOT a dead end — bootstrap
          // a self-contained embedded CPython into pdf-env (packages install
          // directly into it; the whole thing uninstalls as one folder). A
          // failed bootstrap removes its half-state so the next attempt
          // starts clean.
          try {
            await ensureEmbeddedPython(dir)
          } catch (e) {
            await rmDirWithRetry(dir)
            throw e
          }
        }
      }
      const vpy = venvPython()
      if (!vpy) throw new Error('虚拟环境创建失败')
      await runStreaming(vpy, ['--version'])
      // pip goes DIRECT to a China-hosted mirror: local proxies truncate the
      // multi-hundred-MB paddle wheels, which looks like a silent hang
      const pipMirror = ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple']
      emitEnvProgress('升级 pip…')
      await runStreaming(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip', '--disable-pip-version-check', ...pipMirror], { noProxy: true })
      emitEnvProgress('安装 PaddleOCR 及依赖（较大，请耐心等待，可能数分钟）…')
      await runStreaming(vpy, ['-m', 'pip', 'install', '--disable-pip-version-check', ...pipMirror, '-r', path.join(sidecarDir(), 'requirements.txt')], { noProxy: true })
      emitEnvProgress('校验安装…')
      await runStreaming(vpy, ['-c', 'import paddleocr; print("paddleocr", getattr(paddleocr, "__version__", "?"))'])
      // pre-download the PP-Structure models so the first real analysis is fast
      // (non-fatal — models also lazy-download on first use if this can't finish)
      emitEnvProgress('预下载 PaddleOCR 模型（首次较大，请耐心等待，可能数分钟）…')
      try {
        await runStreaming(vpy, [path.join(sidecarDir(), 'knote_pdf_service.py'), '--warmup'])
      } catch (e) {
        emitEnvProgress('提示：模型预下载未完成（' + String((e && e.message) || e) + '），将在首次使用时自动下载')
      }
      fs.writeFileSync(envReadyMarker(), new Date().toISOString())
      emitEnvProgress('✅ 环境配置完成，PDF 版面分析已就绪')
      return { ok: true }
    } catch (e) {
      const msg = String((e && e.message) || e)
      emitEnvProgress('❌ 失败：' + msg)
      return { ok: false, error: msg }
    } finally {
      pdfEnvBusy = false
    }
  })
  ipcMain.handle('knote:fs-rename', (_e, { from, to }) => serializeFsMutation(async () => {
    const source = existingWritePath(from)
    const destination = creatableWritePath(to)
    const files = await markdownFilesUnder(source)
    await preserveFiles(files, 'before-rename')
    for (const oldFile of files) {
      const newFile = path.join(destination, path.relative(source, oldFile))
      await retention().copyIdentityHistory(`file:${oldFile}`, `file:${newFile}`)
    }
    await fs.promises.rename(source, destination)
    markStaleWritePath(source)
    clearStaleWritePath(destination)
    return true
  }))
  // open the OS file manager at a path: files are revealed+selected in their
  // folder, directories open directly. Confined to registered roots.
  ipcMain.handle('knote:reveal', (_e, { path: p }) => {
    const abs = existingReadOrWritablePath(p)
    let isDir = false
    try { isDir = fs.statSync(abs).isDirectory() } catch { throw new Error('not found') }
    if (isDir) shell.openPath(abs)
    else shell.showItemInFolder(abs)
    return true
  })
  // open a workspace file with the OS default application (double-clicking an
  // office doc in the tree launches Word/Excel/WPS/... instead of an in-app
  // preview, and clicking a local-file markdown link opens its attachment).
  // Wider than read/write grants — see existingOpenPath.
  ipcMain.handle('knote:open-path', async (_e, { path: p }) => {
    let abs
    try {
      abs = existingOpenPath(p)
    } catch (workspaceError) {
      const resolved = path.resolve(String(p || ''))
      if (!pickedOpenPaths.has(resolved)) throw workspaceError
      abs = resolved
    }
    const err = await shell.openPath(abs)
    return { ok: !err, error: err || '' }
  })
  // delete to the OS recycle bin instead of unlinking (undoable in Explorer)
  ipcMain.handle('knote:trash', (_e, { path: p }) => serializeFsMutation(async () => {
    const target = existingWriteOrWritablePath(p)
    await preserveFiles(await markdownFilesUnder(target), 'before-trash')
    await shell.trashItem(target)
    markStaleWritePath(target)
    return true
  }))

  // session restore: re-open remembered file/folder paths on startup. Paths
  // are validated to still exist; re-registers them as writable/browsable.
  ipcMain.handle('knote:reopen', async (_e, { type, path: p, requestId }) => {
    try {
      if (!p || !fs.existsSync(p)) return false
      const meta = { requestId: normalizeOpenRequestId(requestId) }
      if (type === 'folder') return sendOpenFolder(path.resolve(p), meta)
      return await sendOpenFile(path.resolve(p), meta)
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

  ipcMain.handle('knote:window-state', () => ({
    maximized: win ? win.isMaximized() : false,
    minimized: win ? win.isMinimized() : false,
    fullscreen: win ? win.isFullScreen() : false
  }))

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

  app.whenReady().then(async () => {
    if (handleInstallerShutdownRequest(initialInstallerShutdownRequest)) return
    // Normal launches own the single-instance lock, so no live renderer can
    // reference a prior session. Probe launches skip this global cleanup to
    // avoid disturbing an independently running installed instance.
    if (!isProbe) {
      await tabBuffers().initialize().catch((error) => {
        console.error('[tab-buffer-startup-cleanup]', error && error.message ? error.message : error)
      })
    }
    createWindow()
    // A tray process would outlive the automated window and make the suite
    // hang. Normal application launches still keep the existing tray model.
    if (!isE2E) createTray()
    // KNOTE_FILE1 is an explicit isolated smoke target; do not mistake the
    // development app directory in argv for a user-opened workspace.
    const target = process.env.KNOTE_FILE1 ? null : openTargetFromArgv(process.argv)
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
        }, Number(process.env.KNOTE_SHOT_DELAY || 2500))
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
              const ev = await win.webContents.executeJavaScript('window.knoteDesktop.pdfEnvStatus()')
              console.log('KNOTE_SMOKE_PDFENV:' + JSON.stringify(ev))
            } catch (e) { console.log('KNOTE_SMOKE_SIDECAR_ERR:' + String(e && e.message)) }
            if (process.env.KNOTE_FILE1) {
              sendOpenFile(path.resolve(process.env.KNOTE_FILE1))
              await new Promise((r) => setTimeout(r, 1200))
            }
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
              if (process.env.KNOTE_RETENTION_PROBE && first) {
                const second = path.resolve(process.env.KNOTE_FILE2)
                // Edit A and switch immediately, before the 1s debounce fires;
                // then do the symmetric B -> A switch. This recreates the old
                // cross-document overwrite race in a real renderer/main pair.
                await win.webContents.executeJavaScript(`(() => {
                  const pm = document.querySelector('.ProseMirror'); pm.focus()
                  document.execCommand('insertText', false, 'A-PENDING-SWITCH')
                })()`)
                sendOpenFile(second)
                await new Promise((r) => setTimeout(r, 500))
                await win.webContents.executeJavaScript(`(() => {
                  const pm = document.querySelector('.ProseMirror'); pm.focus()
                  document.execCommand('insertText', false, 'B-PENDING-SWITCH')
                })()`)
                sendOpenFile(first)
                await new Promise((r) => setTimeout(r, 2600))
                const aDisk = fs.readFileSync(first, 'utf8')
                const bDisk = fs.readFileSync(second, 'utf8')
                const aHistory = await retention().listSnapshots(`file:${first}`)
                const bHistory = await retention().listSnapshots(`file:${second}`)
                console.log('KNOTE_SMOKE_RETENTION:' + JSON.stringify({
                  aKept: aDisk.includes('A-PENDING-SWITCH'),
                  bKept: bDisk.includes('B-PENDING-SWITCH'),
                  aNotB: !aDisk.includes('B-PENDING-SWITCH'),
                  bNotA: !bDisk.includes('A-PENDING-SWITCH'),
                  aHistory: aHistory.length,
                  bHistory: bHistory.length
                }))
              }
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

}
