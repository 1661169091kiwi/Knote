// Knote desktop shell — a thin Electron wrapper around the built web app.
// The renderer stays sandboxed; the preload exposes exactly two capabilities
// (receive opened .md files, write those same files back for live-save).
const { app, BrowserWindow, shell, Tray, Menu, ipcMain, nativeImage, dialog, clipboard, net, crashReporter, safeStorage, session } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const http = require('http')
const https = require('https')
const { pipeline } = require('stream')
const crypto = require('crypto')
const { pathToFileURL } = require('node:url')
const { createQuitCleanupController, createRendererQuitHandshake, terminateProcessTree } = require('./quit-cleanup.cjs')
const { createFsMutationCoordinator } = require('./fs-mutation-coordinator.cjs')
const { createFsWriteIfUnchanged } = require('./fs-write-if-unchanged.cjs')
const { statMtimeMs } = require('./file-stat-time.cjs')
const { DocumentRetentionStore, fileStatIdentity, fileStatIdentityMatches, readFileState } = require('./document-retention.cjs')
const { TabBufferStore } = require('./tab-buffer-store.cjs')
const { OpenTargetCapabilityStore } = require('./open-target-capability.cjs')
const { attachCrashDiagnostics } = require('./crash-diagnostics.cjs')
const {
  DownloadPolicyError,
  PublicUrlPolicyError,
  assertSafeDownloadName,
  assertSafeDownloadPayload,
  assertSafeDownloadResponseMetadata,
  assertSafeDownloadUrl,
  createPublicUrlPolicy,
  normalizeDownloadRelativePath
} = require('./public-url-policy.cjs')
const {
  AgentDownloadResumeStore,
  AgentDownloadResumeStoreError,
  validLastModified,
  validStrongETag
} = require('./agent-download-resume-store.cjs')
const { AgentSandboxService, installAgentSandboxIpc } = require('./agent-sandbox-service.cjs')
const {
  authorizeCreatableAssetImagePath,
  authorizeCreatableAssetPath,
  authorizeCreatableImagePath,
  authorizeCreatablePath,
  authorizeExistingAssetPath,
  authorizeExistingImagePath,
  authorizeExistingMarkdownPath,
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
const isE2E = !app.isPackaged && process.defaultApp === true && process.env.KNOTE_E2E === '1'
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
let stopAgentCommands = () => Promise.resolve()
let stopAgentSandboxTasks = () => Promise.resolve()
let stopBrokerRequests = () => Promise.resolve()

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
let openTargetCapabilityStore = null
const openTargetCapabilities = () => {
  if (!openTargetCapabilityStore) {
    const encrypted = safeStorage.isEncryptionAvailable()
    openTargetCapabilityStore = new OpenTargetCapabilityStore(
      path.join(app.getPath('userData'), 'open-target-capabilities', 'v1'),
      {
        persist: encrypted,
        seal: (value) => safeStorage.encryptString(Buffer.from(value).toString('base64')),
        unseal: (value) => Buffer.from(safeStorage.decryptString(Buffer.from(value)), 'base64')
      }
    )
  }
  return openTargetCapabilityStore
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
const executablesOnPath = (names) => {
  const pathValue = String(process.env.PATH || process.env.Path || process.env.path || '')
  const found = []
  for (const rawDir of pathValue.split(path.delimiter)) {
    const dir = rawDir.trim().replace(/^"|"$/g, '')
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (!fs.statSync(candidate).isFile()) continue
        const resolved = canonicalExistingPath(candidate)
        if (!found.includes(resolved)) found.push(resolved)
      } catch { /* try the next PATH entry */ }
    }
  }
  return found
}
const systemPythonExecutables = () => executablesOnPath(
  process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']
)
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
const pdfProcessCwd = () => {
  const dir = path.join(app.getPath('userData'), 'pdf-process-cwd')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const isolatedPdfChildEnvironment = ({ noProxy = false } = {}) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => (
    typeof value === 'string' &&
    !/^(?:PYTHON|PIP)/i.test(key) &&
    !(noProxy && /^(?:https?|all)_proxy$/i.test(key))
  )))
  env.PYTHONNOUSERSITE = '1'
  env.PYTHONSAFEPATH = '1'
  env.PYTHONDONTWRITEBYTECODE = '1'
  env.PIP_CONFIG_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1'
  env.PIP_NO_INPUT = '1'
  return env
}
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
    // Only the managed environment may host the sidecar. System Python is used
    // in isolated mode solely to create that protected environment.
    const vpy = venvPython()
    const cands = vpy ? [vpy] : []
    let idx = 0
    const tryNext = () => {
      if (finished) return
      if (stopped()) { fail(new Error('sidecar start cancelled')); return }
      if (idx >= cands.length) { fail(new Error('python not found — 请安装 Python 3')); return }
      const py = cands[idx++]
      let proc
      try {
        proc = spawn(py, ['-I', script, '--port', '0', '--token', token], {
          windowsHide: true,
          cwd: pdfProcessCwd(),
          env: isolatedPdfChildEnvironment()
        })
      } catch { tryNext(); return }
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
      stopPdfEnvChild(),
      stopAgentCommands(),
      stopAgentSandboxTasks(),
      stopBrokerRequests()
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
  const env = isolatedPdfChildEnvironment({ noProxy: !!opts.noProxy })
  try { proc = spawn(cmd, args, { windowsHide: true, env, cwd: pdfProcessCwd() }) } catch (e) { reject(e); return }
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
  await runStreaming(py, ['-I', getPip, '--no-warn-script-location', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'], { noProxy: true })
  try { fs.unlinkSync(getPip) } catch { /* ignore */ }
  return py
}
// the first system python whose `--version` runs (for creating the venv)
const firstWorkingPython = () => new Promise((resolve) => {
  const cands = systemPythonExecutables(); let i = 0
  const tryOne = () => {
    if (i >= cands.length) { resolve(null); return }
    const py = cands[i++]
    let proc
    try {
      proc = spawn(py, ['-I', '-S', '--version'], {
        windowsHide: true,
        cwd: pdfProcessCwd(),
        env: isolatedPdfChildEnvironment()
      })
    } catch { tryOne(); return }
    proc.on('error', () => tryOne())
    proc.on('close', (code) => (code === 0 ? resolve(py) : tryOne()))
  }
  tryOne()
})

let win = null
let tray = null
let rendererReady = false
let titleBarDark = false
let titleBarZoomFactor = 1
const applyTitleBarOverlay = () => {
  if (!win || win.isDestroyed()) return false
  try {
    win.setTitleBarOverlay({
      color: '#00000000',
      symbolColor: titleBarDark ? '#f3f4f6' : '#4b5563',
      height: Math.round(40 * titleBarZoomFactor)
    })
    return true
  } catch { return false }
}
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
const folderGrantIds = new Map()
const folderGrantsById = new Map()
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
const grantDirectory = (paths, grants, dir, expectedFile = null) => {
  const abs = path.resolve(String(dir || ''))
  const grant = createBoundaryRoot(abs)
  if (expectedFile && !openTargetCapabilities().matches('file', expectedFile)) throw new Error('open target destination changed')
  paths.add(abs)
  if (!grants.some((item) => pathKey(item.lexical) === pathKey(grant.lexical))) grants.push(grant)
  return abs
}
const canonicalExistingPath = (target) => {
  const resolved = path.resolve(String(target || ''))
  return path.resolve(fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved))
}
const canonicalPathContains = (root, candidate) => {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return candidate === root || candidate.startsWith(prefix)
}
const filesystemIdentity = (target) => {
  const stat = fs.statSync(target, { bigint: true })
  return `${String(stat.dev)}:${String(stat.ino)}`
}
const ancestorChainContainsIdentity = (target, identity) => {
  let current = canonicalExistingPath(target)
  for (let depth = 0; depth < 256; depth++) {
    if (filesystemIdentity(current) === identity) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
  return false
}
const pathsOverlapByFilesystemIdentity = (left, right) => {
  const leftIdentity = filesystemIdentity(left)
  const rightIdentity = filesystemIdentity(right)
  return ancestorChainContainsIdentity(left, rightIdentity) || ancestorChainContainsIdentity(right, leftIdentity)
}
const assertFolderGrantDoesNotOverlapAppAuthority = (dir) => {
  const selected = canonicalExistingPath(dir)
  const protectedRoots = [app.getPath('userData')]
  if (app.isPackaged) protectedRoots.push(process.resourcesPath, path.dirname(process.execPath))
  for (const executable of systemPythonExecutables()) {
    const parent = path.dirname(executable)
    protectedRoots.push(path.basename(parent).toLowerCase() === 'scripts' ? path.dirname(parent) : parent)
  }
  for (const protectedPath of protectedRoots) {
    const authority = canonicalExistingPath(protectedPath)
    if (
      canonicalPathContains(selected, authority) ||
      canonicalPathContains(authority, selected) ||
      pathsOverlapByFilesystemIdentity(selected, authority)
    ) {
      const error = new Error('folder overlaps Knote private executable state')
      error.code = 'PROTECTED_WORKSPACE_ROOT'
      throw error
    }
  }
  return selected
}
const grantFolderRoot = (dir, expected = null) => {
  const abs = path.resolve(String(dir || ''))
  assertFolderGrantDoesNotOverlapAppAuthority(abs)
  const grant = createBoundaryRoot(abs)
  if (expected && (
    expected.path !== abs ||
    expected.canonical !== grant.canonical ||
    expected.dev !== grant.dev ||
    expected.ino !== grant.ino ||
    expected.kind !== 'folder'
  )) throw new Error('open target destination changed')
  folderRoots.add(abs)
  if (!folderRootGrants.some((item) => pathKey(item.lexical) === pathKey(grant.lexical))) folderRootGrants.push(grant)
  const key = pathKey(abs)
  let id = folderGrantIds.get(key)
  if (!id) {
    id = `folder-${crypto.randomBytes(18).toString('base64url')}`
    folderGrantIds.set(key, id)
  }
  const registeredGrant = folderRootGrants.find((item) => pathKey(item.lexical) === key)
  if (registeredGrant) folderGrantsById.set(id, registeredGrant)
  return { abs, id }
}
const grantWritablePath = (filePath, expected = null) => {
  const abs = path.resolve(String(filePath || ''))
  if (expected && !openTargetCapabilities().matches('file', expected)) throw new Error('open target destination changed')
  const parent = createBoundaryRoot(path.dirname(abs))
  if (expected && !openTargetCapabilities().matches('file', expected)) throw new Error('open target destination changed')
  writablePaths.add(abs)
  writablePathGrants.set(pathKey(abs), { lexical: abs, parent, expected })
  return abs
}
const authorizeWritablePath = (candidate, { creatable = false } = {}) => {
  const abs = path.resolve(String(candidate || ''))
  const grant = writablePathGrants.get(pathKey(abs))
  if (!grant || pathKey(grant.lexical) !== pathKey(abs)) throw new Error('outside workspace')
  if (grant.expected && !openTargetCapabilities().matches('file', grant.expected)) throw new Error('open target destination changed')
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
    const capabilitySnapshot = meta.capabilitySnapshot || openTargetCapabilities().snapshot('file', p)
    // Establish every capability before yielding. The asynchronous disk read
    // must not observe a renderer-provided path that changed authorization
    // while the main event loop was free to process another request.
    const granted = grantWritablePath(p, capabilitySnapshot)
    grantDirectory(imageReadRoots, imageReadRootGrants, path.dirname(granted), capabilitySnapshot) // read images next to it
    grantDirectory(assetWriteRoots, assetWriteRootGrants, path.dirname(granted), capabilitySnapshot) // write <dir>/assets/*.png
    const target = authorizeWritablePath(granted)
    const handle = await fs.promises.open(target, 'r')
    let stat
    let data
    let progressive = false
    try {
      const identity = await handle.stat({ bigint: true })
      if (
        String(identity.dev) !== capabilitySnapshot.dev ||
        String(identity.ino) !== capabilitySnapshot.ino
      ) throw new Error('open target destination changed')
      stat = { size: Number(identity.size), mtimeMs: statMtimeMs(identity) }
      progressive = stat.size >= PROGRESSIVE_TEXT_THRESHOLD
      data = progressive ? null : await handle.readFile('utf8')
    } finally {
      await handle.close().catch(() => {})
    }
    if (!win || win.isDestroyed() || !rendererReady) {
      pendingOpens.push({ type: 'file', path: target, requestId, openSequence })
      return true
    }
    win.webContents.send('knote:open-file', {
      path: target,
      capability: openTargetCapabilities().issueSnapshot('file', capabilitySnapshot),
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
  try {
    const capabilitySnapshot = meta.capabilitySnapshot || openTargetCapabilities().snapshot('folder', p)
    const granted = grantFolderRoot(p, capabilitySnapshot)
    const root = granted.abs
    win.webContents.send('knote:open-folder', {
      path: root,
      grantId: granted.id,
      capability: openTargetCapabilities().issueSnapshot('folder', capabilitySnapshot),
      name: path.basename(root),
      requestId,
      openSequence
    })
    return true
  } catch { return false }
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
  // The Chromium prototype cannot prove no-network execution (WebRTC/new-realm
  // bypasses exist), so production IPC stays fail-closed until a native broker
  // with an independently verified token and network policy replaces it.
  const agentSandboxService = new AgentSandboxService({
    BrowserWindow,
    session,
    allowUnverifiedExecution: false
  })
  installAgentSandboxIpc({
    ipcMain,
    service: agentSandboxService,
    validateSender: (sender) => !!(
      !quitting &&
      win &&
      !win.isDestroyed() &&
      sender === win.webContents &&
      !sender.isDestroyed()
    )
  })
  stopAgentSandboxTasks = () => agentSandboxService.cancelAll('APP_QUIT')

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

  ipcMain.on('knote:e2e-status', (event) => {
    event.returnValue = isE2E
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
  // A folder workspace may open any allowlisted document under its root. A
  // single-file workspace may open only that exact document, Markdown files
  // under its frozen parent, sibling images, and files below its assets/
  // directory; its parent is never exposed as a generic read grant.
  const existingOpenPath = (p) => {
    let workspaceError
    try { return existingReadPath(p) } catch (error) { workspaceError = error }
    try { return authorizeWritablePath(p) } catch { /* exact document only */ }
    try { return authorizeExistingMarkdownPath(p, imageReadRootGrants).lexical } catch { /* linked Markdown only */ }
    try { return authorizeExistingImagePath(p, imageReadRootGrants).lexical } catch { /* image siblings only */ }
    try { return authorizeExistingAssetPath(p, assetWriteRootGrants).lexical } catch { throw workspaceError }
  }
  const OPENABLE_DOCUMENT_EXTENSIONS = new Set([
    '.md', '.markdown', '.txt', '.rtf', '.csv', '.pdf', '.html', '.htm',
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.odt', '.ods', '.odp', '.png', '.jpg', '.jpeg', '.gif',
    '.webp', '.bmp', '.avif', '.svg', '.zip', '.7z', '.rar'
  ])
  const assertOpenableDocument = (target) => {
    const checked = path.resolve(String(target || ''))
    const stat = fs.statSync(checked)
    if (!stat.isFile() || !OPENABLE_DOCUMENT_EXTENSIONS.has(path.extname(checked).toLowerCase())) {
      const error = new Error('This file type cannot be opened through the document bridge')
      error.code = 'UNSAFE_OPEN_PATH'
      throw error
    }
    return checked
  }
  const existingWriteOrWritablePath = (p) => {
    try { return existingWritePath(p) } catch (writeError) {
      try { return authorizeWritablePath(p) } catch { throw writeError }
    }
  }
  const creatableWriteOrWritableAuthorization = (p) => {
    try { return authorizeCreatablePath(p, writeGrants()) } catch (writeError) {
      const abs = path.resolve(String(p || ''))
      const grant = writablePathGrants.get(pathKey(abs))
      if (!grant || pathKey(grant.lexical) !== pathKey(abs)) throw writeError
      if (grant.expected && !openTargetCapabilities().matches('file', grant.expected)) {
        throw new Error('open target destination changed')
      }
      try { return authorizeCreatablePath(abs, [grant.parent]) } catch { throw writeError }
    }
  }
  const creatableWriteOrWritablePath = (p) => creatableWriteOrWritableAuthorization(p).lexical
  const agentCommandFailure = (code, message) => ({
    ok: false,
    code: String(code || 'COMMAND_FAILED'),
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: '',
    truncated: false,
    terminationPending: false,
    durationMs: 0,
    error: String(message || code || 'command failed')
  })
  ipcMain.handle('knote:agent-command-run', async (event) => {
    if (quitting || !win || win.isDestroyed() || event.sender !== win.webContents) {
      return agentCommandFailure('COMMAND_UNAVAILABLE', 'command execution is unavailable')
    }
    return agentCommandFailure(
      'SANDBOX_UNAVAILABLE',
      'native AppContainer command execution is not installed and host execution is forbidden'
    )
  })
  ipcMain.handle('knote:agent-command-cancel', () => false)
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
      const st = await fs.promises.stat(target, { bigint: true })
      return {
        ok: true,
        mtimeMs: statMtimeMs(st),
        size: Number(st.size),
        statIdentity: fileStatIdentity(st)
      }
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

  const fsWriteIfUnchanged = createFsWriteIfUnchanged({
    serialize: serializeFsMutation,
    authorizeTarget: existingWritePath,
    assertWritable: (target) => fsMutations.assertWritable(target),
    readText: (target) => readFileState(target),
    saveDocument: (target, data, condition) => retention().saveDocument(target, data, {
      label: 'agent-edit',
      expectedContent: condition.expectedContent,
      expectedStat: condition.expectedStat
    })
  })

  ipcMain.handle('knote:fs-write', (_e, { path: p, data }) => serializeFsMutation(async () => {
    const target = creatableWriteOrWritablePath(p)
    fsMutations.assertWritable(target)
    await retention().saveDocument(target, String(data), { label: 'save' })
    return true
  }))
  ipcMain.handle('knote:fs-write-if-unchanged', (_e, request) => fsWriteIfUnchanged(request))
  ipcMain.handle('knote:fs-create', (_e, { path: p }) => serializeFsMutation(async () => {
    const target = creatableWriteOrWritablePath(p)
    const handle = await fs.promises.open(target, 'a')
    await handle.close()
    clearStaleWritePath(target)
    return true
  }))
  ipcMain.handle('knote:fs-create-exclusive', (_e, { path: p, data }) => serializeFsMutation(async () => {
    const initial = creatableWriteOrWritableAuthorization(p)
    const target = initial.lexical
    if (initial.exists) return { ok: false, code: 'TARGET_EXISTS', reason: 'exact_target_exists' }
    const parentPath = path.dirname(target)
    const root = initial.root
    const identityOf = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino) })
    const sameIdentity = (stat, identity) => String(stat.dev) === identity.dev && String(stat.ino) === identity.ino
    const fail = (code, reason) => ({ ok: false, code, reason })
    const parentState = () => {
      let checked
      try { checked = authorizeExistingPath(parentPath, [root]).lexical } catch (error) {
        if (['not_found', 'ENOENT'].includes(String(error?.code || ''))) return { failure: fail('PARENT_MISSING', 'parent_directory_missing') }
        if (['not_a_directory', 'ENOTDIR'].includes(String(error?.code || ''))) return { failure: fail('PARENT_MISSING', 'parent_not_directory') }
        throw error
      }
      const stat = fs.statSync(checked, { bigint: true })
      if (!stat.isDirectory()) return { failure: fail('PARENT_MISSING', 'parent_not_directory') }
      return { checked, stat, identity: identityOf(stat) }
    }
    const initialParent = parentState()
    if (initialParent.failure) return initialParent.failure
    const assertParentUnchanged = () => {
      const current = parentState()
      if (current.failure || !sameIdentity(current.stat, initialParent.identity)) {
        const error = new Error('create destination parent changed')
        error.code = 'WORKSPACE_CHANGED'
        throw error
      }
      return current
    }
    const assertTargetStillCreatable = () => {
      const authorization = authorizeCreatablePath(target, [root])
      if (authorization.exists) {
        const error = new Error('target exists')
        error.code = 'EEXIST'
        throw error
      }
      return authorization
    }
    const stagingPath = path.join(parentPath, `.knote-create-${crypto.randomBytes(24).toString('hex')}.tmp`)
    let stagingHandle = null
    let stagingIdentity = null
    let stagingRemoved = false
    let published = false
    try {
      stagingHandle = await fs.promises.open(stagingPath, 'wx', 0o600)
      const opened = await stagingHandle.stat({ bigint: true })
      stagingIdentity = identityOf(opened)
      if (!opened.isFile() || Number(opened.nlink) !== 1) {
        const error = new Error('invalid create staging object')
        error.code = 'WORKSPACE_CHANGED'
        throw error
      }
      assertParentUnchanged()
      assertTargetStillCreatable()
      const stagedBeforeWrite = fs.lstatSync(authorizeExistingPath(stagingPath, [root]).lexical, { bigint: true })
      if (!stagedBeforeWrite.isFile() || stagedBeforeWrite.isSymbolicLink() || Number(stagedBeforeWrite.nlink) !== 1 || !sameIdentity(stagedBeforeWrite, stagingIdentity)) {
        const error = new Error('create staging identity changed')
        error.code = 'WORKSPACE_CHANGED'
        throw error
      }
      const body = String(data == null ? '' : data)
      await stagingHandle.writeFile(body, 'utf8')
      await stagingHandle.sync()
      const written = await stagingHandle.stat({ bigint: true })
      if (!written.isFile() || Number(written.nlink) !== 1 || Number(written.size) !== Buffer.byteLength(body, 'utf8') || !sameIdentity(written, stagingIdentity)) {
        const error = new Error('create staging write verification failed')
        error.code = 'WORKSPACE_CHANGED'
        throw error
      }
      await stagingHandle.close()
      stagingHandle = null
      try {
        // Keep the final validation and no-replace publication in one synchronous
        // turn. Node has no parent-handle-relative link API, so post-publication
        // identity checks remain mandatory as well.
        assertParentUnchanged()
        assertTargetStillCreatable()
        const staged = fs.lstatSync(authorizeExistingPath(stagingPath, [root]).lexical, { bigint: true })
        if (!staged.isFile() || staged.isSymbolicLink() || Number(staged.nlink) !== 1 || !sameIdentity(staged, stagingIdentity)) {
          const error = new Error('create staging identity changed before publication')
          error.code = 'WORKSPACE_CHANGED'
          throw error
        }
        fs.linkSync(stagingPath, target)
        published = true
      } catch (error) {
        if (error?.code === 'EEXIST') return { ok: false, code: 'TARGET_EXISTS', reason: 'exact_target_exists' }
        throw error
      }

      try {
        assertParentUnchanged()
        const stagedAfterLink = fs.lstatSync(stagingPath, { bigint: true })
        const targetAfterLink = fs.lstatSync(target, { bigint: true })
        if (!sameIdentity(stagedAfterLink, stagingIdentity) || !sameIdentity(targetAfterLink, stagingIdentity) || Number(stagedAfterLink.nlink) !== 2) {
          return fail('CREATE_PUBLICATION_UNCERTAIN', 'published_object_identity_unconfirmed')
        }
        fs.unlinkSync(stagingPath)
        stagingRemoved = true
      } catch {
        return fail('CREATE_PUBLICATION_RECOVERY_REQUIRED', 'staging_link_cleanup_incomplete')
      }

      try {
        assertParentUnchanged()
        const checkedTarget = authorizeExistingPath(target, [root]).lexical
        const finalStat = fs.lstatSync(checkedTarget, { bigint: true })
        if (!finalStat.isFile() || finalStat.isSymbolicLink() || Number(finalStat.nlink) !== 1 || !sameIdentity(finalStat, stagingIdentity)) {
          return fail('CREATE_PUBLICATION_UNCERTAIN', 'final_target_identity_unconfirmed')
        }
      } catch {
        return fail('CREATE_PUBLICATION_UNCERTAIN', 'final_target_revalidation_failed')
      }
      clearStaleWritePath(target)
      return { ok: true, publication: 'atomic_hard_link_no_replace' }
    } catch (error) {
      if (error?.code === 'EEXIST') return fail('TARGET_EXISTS', 'exact_target_exists')
      if (error?.code === 'WORKSPACE_CHANGED' || ['workspace_root_changed', 'reparse_point_blocked', 'hard_link_blocked', 'not_found', 'not_a_directory'].includes(String(error?.code || ''))) {
        return fail(published ? 'CREATE_PUBLICATION_UNCERTAIN' : 'WORKSPACE_CHANGED', 'workspace_identity_changed')
      }
      throw error
    } finally {
      if (stagingHandle) await stagingHandle.close().catch(() => {})
      if (!stagingRemoved && stagingIdentity) {
        try {
          const current = await fs.promises.lstat(stagingPath, { bigint: true })
          if (sameIdentity(current, stagingIdentity)) await fs.promises.unlink(stagingPath)
        } catch { /* identity-safe cleanup is best effort; failure was not reported as success */ }
      }
    }
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
  const pendingImportSources = new Map()
  const closeImportSource = (entry) => {
    try { void entry?.handle?.close().catch(() => {}) } catch { /* already closed */ }
  }
  const discardImportSource = (token) => {
    const entry = pendingImportSources.get(token)
    pendingImportSources.delete(token)
    closeImportSource(entry)
  }
  const importDestination = (dir, target = '') => {
    const documentDir = path.resolve(String(dir || ''))
    const targetDir = target ? path.resolve(String(target)) : path.join(documentDir, 'assets')
    creatableAssetPath(path.join(targetDir, '__knote_import_probe__'))
    return { documentDir, targetDir }
  }
  const openImportSource = async (source) => {
    const sourcePath = path.resolve(String(source || ''))
    const handle = await fs.promises.open(sourcePath, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('attachment source is not a file')
      return { handle, name: path.basename(sourcePath), size: stat.size }
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
  }
  const issueImportSource = (entry, senderId, destination) => {
    for (const [key, pending] of pendingImportSources) {
      if (pending.expiresAt < Date.now()) discardImportSource(key)
    }
    while (pendingImportSources.size >= 32) discardImportSource(pendingImportSources.keys().next().value)
    const token = `import-${crypto.randomBytes(24).toString('base64url')}`
    pendingImportSources.set(token, {
      ...entry,
      senderId,
      documentDir: destination.documentDir,
      targetDir: destination.targetDir,
      expiresAt: Date.now() + 5 * 60_000
    })
    return token
  }
  const consumeImportSource = (token, senderId, destination) => {
    const key = String(token || '')
    const entry = pendingImportSources.get(key)
    pendingImportSources.delete(key)
    if (
      !entry ||
      entry.senderId !== senderId ||
      entry.expiresAt < Date.now() ||
      pathKey(entry.documentDir) !== pathKey(destination.documentDir) ||
      pathKey(entry.targetDir) !== pathKey(destination.targetDir)
    ) {
      closeImportSource(entry)
      return null
    }
    return entry
  }
  const copyImportSource = async (entry, destination, authorizeDestination) => {
    const output = await fs.promises.open(destination, 'wx')
    try {
      const opened = await output.stat({ bigint: true })
      const authorized = authorizeDestination()
      const current = fs.statSync(authorized, { bigint: true })
      if (String(opened.dev) !== String(current.dev) || String(opened.ino) !== String(current.ino)) {
        throw new Error('attachment destination changed before copy')
      }
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      let position = 0
      for (;;) {
        const { bytesRead } = await entry.handle.read(buffer, 0, buffer.length, position)
        if (!bytesRead) break
        let written = 0
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, position + written)
          written += result.bytesWritten
        }
        position += bytesRead
      }
      if (position !== Number(entry.size)) throw new Error('attachment source changed during copy')
    } finally {
      await output.close().catch(() => {})
      // Never unlink by pathname after a failed identity check: an attacker may
      // have retargeted that pathname again. At worst the wx open left an empty
      // file; no selected bytes are written until the opened object is verified.
    }
  }
  const pickImport = async (dir, target = '', sourceToken = '', senderId = 0) => {
    // Validate the target BEFORE consuming a token or showing the dialog.
    const destination = importDestination(dir, target)
    let sourceEntry = sourceToken ? consumeImportSource(sourceToken, senderId, destination) : null
    if (sourceToken && !sourceEntry) throw new Error('invalid_or_expired_import_source')
    if (!sourceEntry) {
      const result = await dialog.showOpenDialog(win, {
        title: 'Attach a file / 附加一个文件',
        properties: ['openFile'],
        filters: [{ name: 'All Files', extensions: ['*'] }]
      })
      if (result.canceled || !result.filePaths.length) return null
      try { sourceEntry = await openImportSource(result.filePaths[0]) } catch { return null }
    }
    return {
      sourceEntry,
      targetDir: destination.targetDir,
      uniqueName: await nextAvailableName(destination.targetDir, sourceEntry.name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim() || 'attachment')
    }
  }
  ipcMain.handle('knote:import-attachment', async (event, { dir, target, source }) => {
    let picked
    try {
      picked = await pickImport(dir, target, source, event.sender.id)
    } catch (error) {
      return { canceled: true, error: String(error?.message || error) }
    }
    if (!picked) return { canceled: true }
    let result
    try {
      result = await serializeFsMutation(async () => {
        const dest = path.join(picked.targetDir, picked.uniqueName)
        const checked = creatableAssetPath(dest)
        fsMutations.assertWritable(checked)
        await fs.promises.mkdir(path.dirname(checked), { recursive: true })
        // Re-authorize after mkdir so an externally-created junction or hard link
        // cannot be smuggled into the previously missing path.
        const rechecked = creatableAssetPath(checked)
        fsMutations.assertWritable(rechecked)
        await copyImportSource(picked.sourceEntry, rechecked, () => {
          const openedTarget = creatableAssetPath(rechecked)
          fsMutations.assertWritable(openedTarget)
          return openedTarget
        })
        const relative = path.relative(path.resolve(String(dir || '')), rechecked).replace(/\\/g, '/')
        return { canceled: false, relative, name: path.basename(rechecked) }
      })
    } finally {
      closeImportSource(picked.sourceEntry)
    }
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
  const pickedOpenPaths = new Map()
  const MAX_PICKED_OPEN_PATHS = 128
  const registerPickedOpenPath = (p) => {
    const abs = path.resolve(String(p || ''))
    const snapshot = openTargetCapabilities().verify('file', openTargetCapabilities().issue('file', abs))
    if (pickedOpenPaths.size >= MAX_PICKED_OPEN_PATHS) pickedOpenPaths.delete(pickedOpenPaths.keys().next().value)
    pickedOpenPaths.set(abs, snapshot)
    return abs
  }
  ipcMain.handle('knote:pick-file-to-link', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Link a file / 链接一个文件',
      properties: ['openFile'],
      filters: [{ name: 'Documents', extensions: [...OPENABLE_DOCUMENT_EXTENSIONS].map((extension) => extension.slice(1)) }]
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
  ipcMain.handle('knote:pick-import-file', async (event, { dir, target } = {}) => {
    let destination
    try { destination = importDestination(dir, target) } catch (error) {
      return { canceled: true, error: String(error?.message || error) }
    }
    const result = await dialog.showOpenDialog(win, {
      title: 'Pick file to attach / 选择要插入的文件',
      properties: ['openFile'],
      filters: [{ name: 'All Files', extensions: ['*'] }]
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    const sourcePath = path.resolve(result.filePaths[0])
    let sourceEntry
    try { sourceEntry = await openImportSource(sourcePath) } catch { return { canceled: true } }
    return {
      canceled: false,
      source: issueImportSource(sourceEntry, event.sender.id, destination),
      name: sourceEntry.name
    }
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
  const AGENT_DOWNLOAD_SNIFF_BYTES = 8192
  const AGENT_DOWNLOAD_COPY_CHUNK_BYTES = 1024 * 1024
  const AGENT_DOWNLOAD_INACTIVITY_TIMEOUT_MS = 90_000
  const AGENT_DOWNLOAD_TOTAL_TIMEOUT_MS = 60 * 60 * 1000
  const AGENT_DOWNLOAD_CHECKPOINT_BYTES = 8 * 1024 * 1024
  const AGENT_DOWNLOAD_CHECKPOINT_MS = 2_000
  const AGENT_DOWNLOAD_ZONE_MARKER = '[ZoneTransfer]\r\nZoneId=3\r\n'
  const AGENT_DOWNLOAD_STAGE_MARKER = 'KnoteDownloadStage/1\r\n'
  const AGENT_DOWNLOAD_STAGE_MARKER_STREAM = 'Knote.DownloadStage'
  const AGENT_DOWNLOAD_STAGING_NAME_RE = /^\.knote-download-[a-f0-9]{48}\.part$/
  const activeBrokerRequests = new Map()
  const activeDownloadDestinations = new Map()
  const activeDownloadStagingPaths = new Set()
  const downloadResumeOwners = new Map()
  const downloadResumeOwnerListeners = new WeakSet()
  const releaseDownloadResumeOwnersForSender = (sender) => {
    for (const [resumeId, owner] of downloadResumeOwners) {
      if (owner === sender) downloadResumeOwners.delete(resumeId)
    }
  }
  const bindDownloadResumeOwner = (resumeId, sender) => {
    downloadResumeOwners.set(resumeId, sender)
    if (downloadResumeOwnerListeners.has(sender)) return
    downloadResumeOwnerListeners.add(sender)
    sender.once('destroyed', () => releaseDownloadResumeOwnersForSender(sender))
    sender.once('render-process-gone', () => releaseDownloadResumeOwnersForSender(sender))
    sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) releaseDownloadResumeOwnersForSender(sender)
    })
  }
  const brokerError = (code, message, details) => {
    const error = new Error(message || code)
    error.code = code
    error.safeForRenderer = true
    if (details !== undefined) error.details = details
    return error
  }
  const signalError = (signal) => {
    if (signal?.reason instanceof Error) return signal.reason
    const error = brokerError('REQUEST_CANCELLED', 'request was cancelled')
    error.name = 'AbortError'
    return error
  }
  const throwIfBrokerAborted = (signal) => {
    if (signal?.aborted) throw signalError(signal)
  }
  const awaitWithBrokerSignal = (value, signal) => {
    if (!signal) return Promise.resolve(value)
    throwIfBrokerAborted(signal)
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, result) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        fn(result)
      }
      const onAbort = () => finish(reject, signalError(signal))
      signal.addEventListener('abort', onAbort, { once: true })
      Promise.resolve(value).then(
        (result) => finish(resolve, result),
        (error) => finish(reject, error)
      )
    })
  }
  const firstHeader = (headers, name) => {
    const lowerName = String(name).toLowerCase()
    const direct = headers && headers[lowerName]
    const value = direct == null && headers
      ? headers[Object.keys(headers).find((key) => key.toLowerCase() === lowerName)]
      : direct
    return value == null ? '' : String(Array.isArray(value) ? value[0] : value)
  }
  const resolvePublicHost = async (hostname) => {
    const resolved = await net.resolveHost(hostname)
    return Array.isArray(resolved?.endpoints)
      ? resolved.endpoints.map((endpoint) => ({ address: endpoint.address, family: endpoint.family }))
      : []
  }
  const publicWebUrlPolicy = createPublicUrlPolicy({ resolver: resolvePublicHost })
  let downloadResumeEncryptionAvailable = false
  try { downloadResumeEncryptionAvailable = safeStorage.isEncryptionAvailable() === true } catch { /* current download remains ephemeral */ }
  const downloadResumeRoot = path.join(app.getPath('userData'), 'agent-download-quarantine', 'v2')
  const downloadResumeStore = new AgentDownloadResumeStore(downloadResumeRoot, {
    boundaryDir: app.getPath('userData'),
    legacyRoot: path.join(app.getPath('userData'), 'agent-download-quarantine', 'v1'),
    persist: downloadResumeEncryptionAvailable,
    seal: downloadResumeEncryptionAvailable
      ? (clear) => safeStorage.encryptString(Buffer.from(String(clear), 'utf8').toString('base64'))
      : undefined,
    unseal: downloadResumeEncryptionAvailable
      ? (sealed) => Buffer.from(safeStorage.decryptString(Buffer.from(sealed)), 'base64').toString('utf8')
      : undefined
  })
  let downloadResumeInitialization = null
  const ensureDownloadResumeStore = () => {
    if (!downloadResumeInitialization) {
      downloadResumeInitialization = downloadResumeStore.initialize().catch((error) => {
        downloadResumeInitialization = null
        throw error
      })
    }
    return downloadResumeInitialization
  }
  // Keep Chromium's net stack so OS proxy, PAC and authenticated-proxy behavior
  // remain intact. Electron exposes no lookup/socket option that can bind this
  // policy resolution to net.request; the request may resolve again locally or
  // at a proxy. Preflight, per-redirect and post-body checks narrow SSRF and
  // withhold bodies after detectable rebinding, but cannot pin the request or
  // eliminate the documented request-side/remote-proxy-DNS race.
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
  const requestNetHop = (url, options) => new Promise((resolve, reject) => {
    const { method, body, headers, maxBytes, signal, validateResponse } = options
    let req = null
    let responseStarted = false
    let responseEnded = false
    let settled = false
    const finish = (fn, value) => {
      if (settled) return false
      settled = true
      signal?.removeEventListener('abort', onSignalAbort)
      fn(value)
      return true
    }
    const fail = (error, abort = true) => {
      const shouldAbort = finish(reject, error)
      if (shouldAbort && abort && req) {
        try { req.abort() } catch { /* request is already closed */ }
      }
    }
    const onSignalAbort = () => fail(signalError(signal))
    try {
      req = net.request({
        method,
        url,
        redirect: 'manual',
        cache: 'no-store',
        bypassCustomProtocolHandlers: true
      })
      req.setHeader('User-Agent', BROWSER_UA)
      req.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
      req.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8')
      req.setHeader('Accept-Encoding', 'identity')
      req.setHeader('Cache-Control', 'no-cache')
      for (const [key, value] of Object.entries(headers)) req.setHeader(key, value)
    } catch (error) {
      fail(error, false)
      return
    }
    if (signal?.aborted) {
      fail(signalError(signal))
      return
    }
    signal?.addEventListener('abort', onSignalAbort, { once: true })

    // redirect:'manual' emits this event instead of a response for ordinary
    // redirects. Preserve the raw Location header when available so explicit
    // credentials and odd relative forms reach the URL policy unchanged.
    req.on('redirect', (statusCode, _method, redirectUrl, responseHeaders = {}) => {
      const location = firstHeader(responseHeaders, 'location') || String(redirectUrl || '')
      const completed = finish(resolve, { redirect: true, location, statusCode })
      if (completed) {
        try { req.abort() } catch { /* Chromium already cancelled manual redirect */ }
      }
    })
    req.on('response', (res) => {
      if (settled) return
      responseStarted = true
      const statusCode = Number(res.statusCode)
      if (statusCode >= 300 && statusCode < 400) {
        const location = firstHeader(res.headers, 'location')
        if (!location) {
          res.removeListener('error', onEarlyResponseError)
          fail(brokerError('INVALID_REDIRECT', 'redirect response omitted Location'))
          return
        }
        res.removeListener('error', onEarlyResponseError)
        const completed = finish(resolve, { redirect: true, location, statusCode })
        if (completed) {
          try { req.abort() } catch { /* response is already closing */ }
        }
        return
      }
      if (statusCode === 206 || firstHeader(res.headers, 'content-range')) {
        fail(brokerError('PARTIAL_RESPONSE', 'unsolicited partial response was rejected'))
        return
      }
      if (statusCode < 200 || statusCode >= 400) {
        fail(brokerError('HTTP_ERROR', `HTTP ${statusCode}`, { statusCode }))
        return
      }

      const contentType = firstHeader(res.headers, 'content-type')
      const contentDisposition = firstHeader(res.headers, 'content-disposition')
      const contentEncoding = firstHeader(res.headers, 'content-encoding').trim().toLowerCase()
      const lengthText = firstHeader(res.headers, 'content-length').trim()
      let expectedBytes = null
      if (lengthText) {
        if (!/^[0-9]+$/.test(lengthText) || !Number.isSafeInteger(Number(lengthText))) {
          fail(brokerError('INVALID_RESPONSE_LENGTH', 'response has an invalid Content-Length'))
          return
        }
        expectedBytes = Number(lengthText)
        if (expectedBytes > maxBytes) {
          fail(brokerError('BODY_TOO_LARGE', 'response body exceeds the configured limit', {
            maxBytes,
            observedBytes: expectedBytes
          }))
          return
        }
      }

      const chunks = []
      let receivedBytes = 0
      let bodyEnded = false
      let metadataValidated = false
      const completeBody = () => {
        if (settled || !bodyEnded || !metadataValidated) return
        // Chromium may expose compressed Content-Length while delivering a
        // decoded body. Only compare lengths when no content coding is active.
        if (expectedBytes !== null && (!contentEncoding || contentEncoding === 'identity') && receivedBytes !== expectedBytes) {
          fail(brokerError('INCOMPLETE_BODY', 'response body byte count did not match Content-Length', {
            expectedBytes,
            receivedBytes
          }))
          return
        }
        const buffer = Buffer.concat(chunks, receivedBytes)
        finish(resolve, {
          redirect: false,
          buffer,
          contentType,
          contentDisposition,
          statusCode,
          bytes: receivedBytes,
          complete: true
        })
      }
      if (typeof res.pause === 'function') res.pause()
      res.on('end', () => {
        responseEnded = true
        bodyEnded = true
        completeBody()
      })
      res.on('aborted', () => {
        if (!settled) fail(brokerError('INCOMPLETE_BODY', 'response body was aborted', { receivedBytes }), false)
      })
      res.on('error', (error) => {
        if (!settled) fail(brokerError('INCOMPLETE_BODY', 'response body failed before completion', { receivedBytes, cause: error }), false)
      })
      res.on('data', (chunk) => {
        if (settled) return
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const nextBytes = receivedBytes + value.length
        if (nextBytes > maxBytes) {
          fail(brokerError('BODY_TOO_LARGE', 'response body exceeds the configured limit', {
            maxBytes,
            observedBytes: nextBytes
          }))
          return
        }
        receivedBytes = nextBytes
        chunks.push(value)
      })

      Promise.resolve()
        .then(() => validateResponse?.({
          url,
          statusCode,
          headers: res.headers,
          contentType,
          contentDisposition,
          expectedBytes
        }))
        .then(() => {
          metadataValidated = true
          if (!settled && typeof res.resume === 'function') res.resume()
          completeBody()
        }, (error) => fail(error))
    })
    req.on('error', (error) => {
      if (!settled) fail(error, false)
    })
    req.on('abort', () => {
      if (!settled) fail(signal?.aborted ? signalError(signal) : brokerError('REQUEST_ABORTED', 'network request was aborted'), false)
    })
    req.on('close', () => {
      if (responseStarted && !responseEnded && !settled) {
        fail(brokerError('INCOMPLETE_BODY', 'connection closed before the response body completed'), false)
      }
    })
    try {
      if (body !== null && body !== undefined) {
        if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
          req.setHeader('Content-Type', 'application/x-www-form-urlencoded')
        }
        req.write(body)
      }
      req.end()
    } catch (error) {
      fail(error)
    }
  })

  // One deadline covers DNS policy checks, every redirect and the complete
  // final body. A capped body is an error, never a successful partial result.
  const netGet = (url, opts = {}) => {
    const {
      method = 'GET',
      body = null,
      headers = {},
      timeout = 15000,
      maxBytes = 3_000_000,
      maxRedirects = 5,
      signal: externalSignal,
      validateUrl,
      validateResponse,
      onValidatedRedirect,
      decodeText = true
    } = opts
    const deadlineMs = Math.max(1, Math.min(120_000, Math.trunc(Number(timeout) || 15000)))
    const byteLimit = Math.max(1, Math.trunc(Number(maxBytes) || 3_000_000))
    const redirectLimit = Math.max(0, Math.min(10, Math.trunc(Number(maxRedirects) || 0)))
    const controller = new AbortController()
    const onExternalAbort = () => {
      const error = brokerError('REQUEST_CANCELLED', 'request was cancelled')
      error.name = 'AbortError'
      controller.abort(error)
    }
    if (externalSignal?.aborted) onExternalAbort()
    else externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
    const deadline = setTimeout(() => {
      const error = brokerError('REQUEST_TIMEOUT', 'request deadline exceeded')
      error.name = 'TimeoutError'
      controller.abort(error)
    }, deadlineMs)

    const operation = (async () => {
      let target = await publicWebUrlPolicy.validate(url, { signal: controller.signal })
      let currentMethod = String(method || 'GET').toUpperCase()
      let currentBody = body
      for (let redirects = 0; ; redirects += 1) {
        throwIfBrokerAborted(controller.signal)
        if (validateUrl) await awaitWithBrokerSignal(validateUrl(target), controller.signal)
        const response = await requestNetHop(target.url, {
          method: currentMethod,
          body: currentBody,
          headers,
          maxBytes: byteLimit,
          signal: controller.signal,
          validateResponse
        })
        if (!response.redirect) {
          // net.request cannot be pinned to the policy lookup. Re-resolve only
          // after the complete body has arrived and do not expose that body if
          // the final hostname has detectably rebound to a non-public address.
          const containedTarget = await publicWebUrlPolicy.validate(target.url, { signal: controller.signal })
          return {
            text: decodeText ? decodeBody(response.buffer, response.contentType) : null,
            buf: response.buffer,
            buffer: response.buffer,
            ct: response.contentType,
            contentType: response.contentType,
            contentDisposition: response.contentDisposition,
            finalUrl: containedTarget.url,
            statusCode: response.statusCode,
            bytes: response.bytes,
            complete: true
          }
        }
        if (redirects >= redirectLimit) throw brokerError('TOO_MANY_REDIRECTS', 'too many redirects')
        const redirected = await publicWebUrlPolicy.validateRedirect(response.location, target.url, { signal: controller.signal })
        if (validateUrl) await awaitWithBrokerSignal(validateUrl(redirected), controller.signal)
        if (new URL(target.url).protocol === 'https:' && new URL(redirected.url).protocol === 'http:') {
          throw brokerError('ERR_HTTPS_DOWNGRADE', 'HTTPS redirects to HTTP are not allowed')
        }
        if (onValidatedRedirect) {
          await awaitWithBrokerSignal(onValidatedRedirect({ from: target, to: redirected }), controller.signal)
        }
        target = redirected
        currentMethod = 'GET'
        currentBody = null
      }
    })()
    return operation.finally(() => {
      clearTimeout(deadline)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    })
  }
  const normalizeBrokerRequestId = (value) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
      throw brokerError('INVALID_REQUEST_ID', 'request id is missing or invalid')
    }
    return value
  }
  const assertBrokerSender = (event) => {
    if (quitting || !win || win.isDestroyed() || event?.sender !== win.webContents) {
      throw brokerError('BROKER_UNAVAILABLE', 'secure web broker is unavailable')
    }
    return event.sender
  }
  const runBrokerRequest = (event, requestId, kind, task) => {
    const sender = assertBrokerSender(event)
    const id = normalizeBrokerRequestId(requestId)
    if (activeBrokerRequests.has(id)) throw brokerError('DUPLICATE_REQUEST_ID', 'request id is already active')
    if (activeBrokerRequests.size >= 8) throw brokerError('BROKER_BUSY', 'too many broker requests are active')
    const controller = new AbortController()
    const entry = { id, kind, sender, controller, done: null }
    const abortEntry = (message, downloadAction = 'pause') => {
      if (controller.signal.aborted) return
      const error = brokerError('REQUEST_CANCELLED', message)
      error.name = 'AbortError'
      if (kind === 'download') error.downloadAction = downloadAction
      controller.abort(error)
    }
    const cancelForRendererExit = () => abortEntry('renderer ownership ended', 'pause')
    const cancelForMainFrameNavigation = (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) cancelForRendererExit()
    }
    sender.once('destroyed', cancelForRendererExit)
    sender.once('render-process-gone', cancelForRendererExit)
    sender.on('did-start-navigation', cancelForMainFrameNavigation)
    activeBrokerRequests.set(id, entry)
    const operation = Promise.resolve().then(() => task(controller.signal, id))
    entry.done = operation
    return operation.finally(() => {
      sender.removeListener('destroyed', cancelForRendererExit)
      sender.removeListener('render-process-gone', cancelForRendererExit)
      sender.removeListener('did-start-navigation', cancelForMainFrameNavigation)
      if (activeBrokerRequests.get(id) === entry) activeBrokerRequests.delete(id)
    })
  }
  const cancelBrokerRequest = async (event, requestId, kind) => {
    let id
    try { id = normalizeBrokerRequestId(requestId) } catch { return false }
    const entry = activeBrokerRequests.get(id)
    if (!entry || entry.sender !== event?.sender || entry.kind !== kind) return false
    const error = brokerError('REQUEST_CANCELLED', 'request was cancelled')
    error.name = 'AbortError'
    if (kind === 'download') error.downloadAction = quitting ? 'pause' : 'discard'
    entry.controller.abort(error)
    if (entry.done) await Promise.allSettled([entry.done])
    return true
  }
  stopBrokerRequests = async () => {
    const pending = []
    for (const entry of activeBrokerRequests.values()) {
      const error = brokerError('REQUEST_CANCELLED', 'application is quitting')
      error.name = 'AbortError'
      if (entry.kind === 'download') error.downloadAction = 'pause'
      entry.controller.abort(error)
      if (entry.done) pending.push(entry.done)
    }
    await Promise.allSettled(pending)
  }

  const SAFE_DOWNLOAD_FILESYSTEM_ERRORS = Object.freeze({
    ENOSPC: 'download storage has no free space',
    EDQUOT: 'download storage quota was exceeded',
    EFBIG: 'the filesystem rejected the download as too large',
    EACCES: 'the filesystem denied access to the download path',
    EPERM: 'the filesystem denied the download operation',
    EROFS: 'the download destination is read-only',
    EIO: 'the filesystem reported an I/O error while handling the download'
  })
  const DOWNLOAD_PUBLICATION_STATE_CODES = new Set([
    'DOWNLOAD_PUBLICATION_UNCERTAIN',
    'DOWNLOAD_PUBLICATION_RECOVERY_REQUIRED'
  ])
  const electronNetworkErrorCode = (error) => {
    const explicit = String(error?.code || '')
    if (/^ERR_[A-Z0-9_]+$/.test(explicit)) return explicit
    const matched = /\bnet::(ERR_[A-Z0-9_]+)\b/.exec(String(error?.message || ''))
    return matched ? matched[1] : ''
  }
  const downloadFailure = (id, error) => {
    const aliases = {
      BODY_TOO_LARGE: 'DOWNLOAD_TOO_LARGE',
      INCOMPLETE_BODY: 'DOWNLOAD_INCOMPLETE',
      PARTIAL_RESPONSE: 'DOWNLOAD_INCOMPLETE',
      REQUEST_ABORTED: 'DOWNLOAD_CANCELLED',
      REQUEST_CANCELLED: 'DOWNLOAD_CANCELLED',
      REQUEST_TIMEOUT: 'DOWNLOAD_TIMEOUT'
    }
    const networkCode = electronNetworkErrorCode(error)
    const originalCode = networkCode || String(error?.code || 'DOWNLOAD_FAILED')
    const safeFilesystemMessage = Object.hasOwn(SAFE_DOWNLOAD_FILESYSTEM_ERRORS, originalCode)
      ? SAFE_DOWNLOAD_FILESYSTEM_ERRORS[originalCode]
      : ''
    const controlledError = error?.safeForRenderer === true ||
      error instanceof PublicUrlPolicyError ||
      error instanceof DownloadPolicyError ||
      error instanceof AgentDownloadResumeStoreError
    const exposedCode = safeFilesystemMessage || controlledError || networkCode
      ? (aliases[originalCode] || originalCode)
      : 'DOWNLOAD_FAILED'
    const exposedMessage = safeFilesystemMessage ||
      (controlledError ? String(error?.message || originalCode) : '') ||
      (networkCode ? `network request failed (${networkCode})` : '') ||
      'download failed'
    const failure = {
      ok: false,
      id: typeof id === 'string' ? id.slice(0, 160) : '',
      code: exposedCode,
      error: exposedMessage.slice(0, 240)
    }
    if (
      originalCode === 'DOWNLOAD_REDIRECT_APPROVAL_REQUIRED' &&
      typeof error?.details?.redirect_url === 'string'
    ) failure.redirect_url = error.details.redirect_url
    const resumeId = error?.details?.resumeId
    if (AgentDownloadResumeStore.isResumeId(resumeId)) failure.resume_id = resumeId
    if (Number.isSafeInteger(error?.details?.committedBytes) && error.details.committedBytes >= 0) {
      failure.committed_bytes = error.details.committedBytes
    }
    if (error?.details?.knownTotal === null || (Number.isSafeInteger(error?.details?.knownTotal) && error.details.knownTotal >= 0)) {
      failure.known_total = error.details.knownTotal
    }
    if (typeof error?.details?.origin === 'string') failure.origin = error.details.origin.slice(0, 512)
    if (typeof error?.details?.relativePath === 'string') failure.path = error.details.relativePath.slice(0, 1024)
    if (originalCode === 'DOWNLOAD_PAUSED') failure.retryable = true
    if (error?.cleanupIncomplete === true) failure.cleanup_incomplete = true
    return failure
  }
  const safeDownloadFilesystemError = (error, phase) => {
    const code = String(error?.code || '')
    if (!Object.hasOwn(SAFE_DOWNLOAD_FILESYSTEM_ERRORS, code)) return error
    return brokerError(code, SAFE_DOWNLOAD_FILESYSTEM_ERRORS[code], { phase })
  }
  const sameFilesystemObject = (stat, identity) => (
    String(stat.dev) === identity.dev && String(stat.ino) === identity.ino
  )
  const statIdentity = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino) })
  const sameFilesystemIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino
  const boundaryGrantIdentity = (grant) => ({
    lexical: path.resolve(grant.lexical),
    canonical: path.resolve(grant.canonical),
    dev: String(grant.dev),
    ino: String(grant.ino)
  })
  const sameBoundaryGrantIdentity = (left, right) => (
    pathKey(left.lexical) === pathKey(right.lexical) &&
    pathKey(left.canonical) === pathKey(right.canonical) &&
    left.dev === right.dev &&
    left.ino === right.ino
  )
  const downloadDestinationKey = (target) => {
    const resolved = path.resolve(String(target || ''))
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const authorizeDownloadParent = (target, grant) => {
    const parent = path.dirname(target)
    let checked
    try {
      checked = authorizeExistingPath(parent, [grant]).lexical
    } catch (error) {
      if (['not_found', 'ENOENT'].includes(String(error?.code || ''))) {
        throw brokerError('DOWNLOAD_PARENT_MISSING', 'download destination parent does not exist; create it first')
      }
      if (['not_a_directory', 'ENOTDIR'].includes(String(error?.code || ''))) {
        throw brokerError('DOWNLOAD_PARENT_NOT_DIRECTORY', 'download destination parent is not a directory')
      }
      throw error
    }
    let stat
    try {
      stat = fs.statSync(checked, { bigint: true })
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw brokerError('DOWNLOAD_PARENT_MISSING', 'download destination parent does not exist; create it first')
      }
      if (error?.code === 'ENOTDIR') {
        throw brokerError('DOWNLOAD_PARENT_NOT_DIRECTORY', 'download destination parent is not a directory')
      }
      throw error
    }
    if (!stat.isDirectory()) {
      throw brokerError('DOWNLOAD_PARENT_NOT_DIRECTORY', 'download destination parent is not a directory')
    }
    return { lexical: checked, identity: statIdentity(stat) }
  }
  const removeExactDownloadFile = async (target, identity, phase = 'cleanup') => {
    try {
      // Boundary authorization may now fail precisely because a raced parent
      // was replaced. Only unlink the exact pathname when it still names the
      // object created and identified through this operation's open handle.
      const current = await fs.promises.lstat(target, { bigint: true })
      if (!sameFilesystemObject(current, identity)) return false
      await fs.promises.unlink(target)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      throw safeDownloadFilesystemError(error, phase)
    }
  }
  const cleanupStaleDestinationDownloadStages = (parent) => {
    if (process.platform !== 'win32') return
    let entries
    try { entries = fs.readdirSync(parent, { withFileTypes: true }) } catch (cause) {
      throw brokerError('DOWNLOAD_STAGING_RECOVERY_FAILED', 'could not inspect the download destination for stale staging files', { cause })
    }
    for (const entry of entries) {
      if (!AGENT_DOWNLOAD_STAGING_NAME_RE.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue
      const candidate = path.join(parent, entry.name)
      if (activeDownloadStagingPaths.has(downloadDestinationKey(candidate))) continue
      try {
        const markerPath = `${candidate}:${AGENT_DOWNLOAD_STAGE_MARKER_STREAM}`
        if (fs.readFileSync(markerPath, 'utf8') !== AGENT_DOWNLOAD_STAGE_MARKER) continue
        const stat = fs.lstatSync(candidate, { bigint: true })
        if (!stat.isFile() || stat.isSymbolicLink()) continue
        if (fs.readFileSync(markerPath, 'utf8') !== AGENT_DOWNLOAD_STAGE_MARKER) continue
        fs.unlinkSync(markerPath)
        try { fs.unlinkSync(candidate) } catch (cause) {
          try { fs.writeFileSync(markerPath, AGENT_DOWNLOAD_STAGE_MARKER, { flag: 'wx', mode: 0o600 }) } catch { /* recovery remains fail-closed */ }
          throw cause
        }
      } catch (cause) {
        if (['ENOENT', 'ENODATA', 'EINVAL', 'ENOTSUP'].includes(String(cause?.code || ''))) continue
        throw brokerError('DOWNLOAD_STAGING_RECOVERY_FAILED', 'could not remove a stale download publication file', { cause })
      }
    }
  }
  const resolveAgentDownloadTarget = (request) => {
    const grantId = typeof request?.workspaceGrantId === 'string' ? request.workspaceGrantId : ''
    const grant = folderGrantsById.get(grantId)
    if (!grant) throw brokerError('INVALID_WORKSPACE_GRANT', 'workspace grant is missing or invalid')
    const relativePath = normalizeDownloadRelativePath(request?.relativePath)
    assertSafeDownloadName(path.posix.basename(relativePath), 'relative-path')
    const target = path.resolve(grant.lexical, ...relativePath.split('/'))
    const parent = authorizeDownloadParent(target, grant)
    cleanupStaleDestinationDownloadStages(parent.lexical)
    const authorization = authorizeCreatablePath(target, [grant])
    if (authorization.exists) throw brokerError('FILE_EXISTS', 'download destination already exists')
    return {
      grantId,
      grantIdentity: boundaryGrantIdentity(grant),
      relativePath,
      target: authorization.lexical,
      canonicalTarget: authorization.canonicalPath,
      destinationKey: downloadDestinationKey(authorization.canonicalPath),
      parentIdentity: parent.identity
    }
  }
  const downloadResumeBinding = (destination, maxBytes) => ({
    workspace: destination.grantIdentity,
    parent: {
      ...destination.parentIdentity,
      destinationKey: destination.destinationKey
    },
    relativePath: destination.relativePath,
    maxBytes
  })
  const downloadResumeMatchesDestination = (metadata, destination, maxBytes) => (
    metadata &&
    sameBoundaryGrantIdentity(metadata.workspace, destination.grantIdentity) &&
    sameFilesystemIdentity(metadata.parent, destination.parentIdentity) &&
    metadata.parent.destinationKey === destination.destinationKey &&
    metadata.relativePath === destination.relativePath &&
    metadata.maxBytes === maxBytes
  )
  const reserveAgentDownloadDestination = (destination, id) => {
    if (activeDownloadDestinations.has(destination.destinationKey)) {
      throw brokerError('DOWNLOAD_DESTINATION_BUSY', 'another download is already targeting this destination')
    }
    const reservation = { id, destinationKey: destination.destinationKey }
    activeDownloadDestinations.set(destination.destinationKey, reservation)
    return () => {
      if (activeDownloadDestinations.get(destination.destinationKey) === reservation) {
        activeDownloadDestinations.delete(destination.destinationKey)
      }
    }
  }
  const createAgentDownloadActivity = (externalSignal) => {
    const controller = new AbortController()
    let inactivityTimer = null
    let disposed = false
    const onExternalAbort = () => controller.abort(signalError(externalSignal))
    const markProgress = () => {
      if (disposed || controller.signal.aborted) return
      clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => {
        const error = brokerError('REQUEST_TIMEOUT', 'download made no progress before the inactivity timeout')
        error.name = 'TimeoutError'
        controller.abort(error)
      }, AGENT_DOWNLOAD_INACTIVITY_TIMEOUT_MS)
    }
    if (externalSignal?.aborted) onExternalAbort()
    else externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
    const totalTimer = setTimeout(() => {
      const error = brokerError('REQUEST_TIMEOUT', 'download exceeded the total operation deadline')
      error.name = 'TimeoutError'
      controller.abort(error)
    }, AGENT_DOWNLOAD_TOTAL_TIMEOUT_MS)
    markProgress()
    return {
      signal: controller.signal,
      markProgress,
      dispose: () => {
        if (disposed) return
        disposed = true
        clearTimeout(inactivityTimer)
        clearTimeout(totalTimer)
        externalSignal?.removeEventListener('abort', onExternalAbort)
      }
    }
  }
  const writeDownloadBuffer = async (handle, buffer, position, signal, markProgress) => {
    let sourceOffset = 0
    while (sourceOffset < buffer.length) {
      throwIfBrokerAborted(signal)
      const length = Math.min(AGENT_DOWNLOAD_COPY_CHUNK_BYTES, buffer.length - sourceOffset)
      const { bytesWritten } = await handle.write(buffer, sourceOffset, length, position + sourceOffset)
      if (!bytesWritten) throw brokerError('DOWNLOAD_WRITE_INCOMPLETE', 'download write made no progress')
      sourceOffset += bytesWritten
      markProgress?.()
    }
  }
  const downloadHeader = (headers, name) => {
    const lowerName = String(name).toLowerCase()
    const key = headers && Object.keys(headers).find((candidate) => candidate.toLowerCase() === lowerName)
    const value = key ? headers[key] : undefined
    if (Array.isArray(value) && value.length !== 1) {
      throw brokerError('INVALID_DOWNLOAD_RESPONSE', `response has multiple ${name} headers`)
    }
    return value == null ? '' : String(Array.isArray(value) ? value[0] : value)
  }
  const downloadHeaderMetadata = (headers) => ({
    contentType: downloadHeader(headers, 'content-type'),
    contentDisposition: downloadHeader(headers, 'content-disposition'),
    contentEncoding: downloadHeader(headers, 'content-encoding').trim().toLowerCase()
  })
  const parseDownloadLength = (headers) => {
    const text = downloadHeader(headers, 'content-length').trim()
    if (!text) return null
    if (!/^(?:0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text))) {
      throw brokerError('INVALID_RESPONSE_LENGTH', 'response has an invalid Content-Length')
    }
    return Number(text)
  }
  const downloadValidatorFromHeaders = (headers, contentEncoding = '') => {
    if (contentEncoding && contentEncoding !== 'identity') return null
    const etag = downloadHeader(headers, 'etag').trim()
    if (validStrongETag(etag)) return { kind: 'etag', value: etag }
    const lastModified = downloadHeader(headers, 'last-modified').trim()
    if (validLastModified(lastModified)) return { kind: 'last-modified', value: lastModified }
    return null
  }
  const downloadValidatorMatches = (validator, headers) => {
    if (!validator) return false
    if (validator.kind === 'etag') return downloadHeader(headers, 'etag').trim() === validator.value && validStrongETag(validator.value)
    return downloadHeader(headers, 'last-modified').trim() === validator.value && validLastModified(validator.value)
  }
  const parseDownloadContentRange = (headers) => {
    const text = downloadHeader(headers, 'content-range').trim()
    const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/i.exec(text)
    if (!match) throw brokerError('DOWNLOAD_RANGE_MISMATCH', 'download response has an invalid Content-Range')
    const values = match.slice(1).map(Number)
    if (values.some((value) => !Number.isSafeInteger(value))) {
      throw brokerError('DOWNLOAD_RANGE_MISMATCH', 'download response Content-Range exceeds the supported integer range')
    }
    return { start: values[0], end: values[1], total: values[2] }
  }
  const parseUnsatisfiedDownloadRange = (headers) => {
    const text = downloadHeader(headers, 'content-range').trim()
    const match = /^bytes \*\/([0-9]+)$/i.exec(text)
    if (!match || !Number.isSafeInteger(Number(match[1]))) {
      throw brokerError('DOWNLOAD_RANGE_MISMATCH', 'download 416 response has an invalid Content-Range')
    }
    return Number(match[1])
  }
  const downloadFailureDetails = (entry) => {
    const metadata = entry?.metadata || {}
    let origin = ''
    try { origin = new URL(metadata.finalUrl || metadata.currentUrl).origin } catch { /* invalid metadata is not exposed */ }
    return {
      resumeId: metadata.resumeId,
      committedBytes: metadata.committedBytes,
      knownTotal: metadata.knownTotal,
      origin,
      relativePath: metadata.relativePath
    }
  }
  const requestAgentDownloadHop = (url, options) => new Promise((resolve, reject) => {
    const { headers = {}, signal, markProgress, onResponse } = options
    let req = null
    let response = null
    let responseEnded = false
    let processingResponse = false
    let settled = false
    const finish = (fn, value) => {
      if (settled) return false
      settled = true
      signal?.removeEventListener('abort', onSignalAbort)
      fn(value)
      return true
    }
    const abortTransport = (error) => {
      if (response && !response.destroyed && typeof response.destroy === 'function') {
        try { response.destroy() } catch { /* response is already closed */ }
      }
      if (req && !req.aborted) {
        try { req.abort() } catch { /* request is already closed */ }
      }
    }
    const fail = (error, abort = true) => {
      if (processingResponse) {
        if (abort) abortTransport(error)
        return
      }
      const completed = finish(reject, error)
      if (completed && abort) abortTransport(error)
    }
    const onSignalAbort = () => fail(signalError(signal))
    try {
      req = net.request({
        method: 'GET',
        url,
        redirect: 'manual',
        cache: 'no-store',
        bypassCustomProtocolHandlers: true
      })
      req.setHeader('User-Agent', BROWSER_UA)
      req.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
      req.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8')
      req.setHeader('Accept-Encoding', 'identity')
      req.setHeader('Cache-Control', 'no-cache')
      for (const [key, value] of Object.entries(headers)) req.setHeader(key, value)
    } catch (error) {
      fail(error, false)
      return
    }
    if (signal?.aborted) {
      fail(signalError(signal))
      return
    }
    signal?.addEventListener('abort', onSignalAbort, { once: true })
    req.on('redirect', (statusCode, _method, redirectUrl, responseHeaders = {}) => {
      markProgress()
      const location = firstHeader(responseHeaders, 'location') || String(redirectUrl || '')
      const completed = finish(resolve, { redirect: true, location, statusCode })
      if (completed) abortTransport()
    })
    req.on('response', (res) => {
      if (settled) return
      response = res
      markProgress()
      res.once('end', () => { responseEnded = true })
      // The socket can fail while async header/metadata checks are still
      // running and before the body iterator has attached its own listener.
      // Keep that early error observed; the stream's errored state is still
      // delivered to the iterator and classified as an incomplete body.
      const onEarlyResponseError = () => {}
      res.on('error', onEarlyResponseError)
      const statusCode = Number(res.statusCode)
      if (statusCode >= 300 && statusCode < 400) {
        const location = firstHeader(res.headers, 'location')
        if (!location) {
          fail(brokerError('INVALID_REDIRECT', 'redirect response omitted Location'))
          return
        }
        const completed = finish(resolve, { redirect: true, location, statusCode })
        if (completed) abortTransport()
        return
      }
      if (typeof res.pause === 'function') res.pause()
      processingResponse = true
      Promise.resolve()
        .then(() => onResponse(res, { statusCode, headers: res.headers }))
        .then(
          (result) => {
            res.removeListener('error', onEarlyResponseError)
            finish(resolve, { redirect: false, ...result })
          },
          (error) => {
            res.removeListener('error', onEarlyResponseError)
            const completed = finish(reject, signal?.aborted ? signalError(signal) : error)
            if (completed) abortTransport()
          }
        )
    })
    req.on('error', (error) => fail(error, false))
    req.on('abort', () => {
      if (!settled) fail(signal?.aborted ? signalError(signal) : brokerError('REQUEST_ABORTED', 'network request was aborted'), false)
    })
    req.on('close', () => {
      if (response && !responseEnded && !settled) {
        fail(brokerError('INCOMPLETE_BODY', 'connection closed before the response body completed'), true)
      }
    })
    try { req.end() } catch (error) { fail(error) }
  })
  const newDownloadHashState = (entry) => ({
    entry,
    bytes: 0,
    hasher: crypto.createHash('sha256'),
    sniff: Buffer.allocUnsafe(AGENT_DOWNLOAD_SNIFF_BYTES),
    sniffBytes: 0,
    lastCheckpointBytes: 0,
    lastCheckpointAt: Date.now()
  })
  const addDownloadSniff = (state, chunk) => {
    if (state.sniffBytes >= state.sniff.length) return
    const copied = Math.min(state.sniff.length - state.sniffBytes, chunk.length)
    chunk.copy(state.sniff, state.sniffBytes, 0, copied)
    state.sniffBytes += copied
    assertSafeDownloadPayload(state.sniff.subarray(0, state.sniffBytes))
  }
  const rebuildDownloadHashState = async (entry, signal, markProgress) => {
    const state = newDownloadHashState(entry)
    state.signal = signal
    state.markProgress = markProgress
    const expected = entry.metadata.committedBytes
    const buffer = Buffer.allocUnsafe(AGENT_DOWNLOAD_COPY_CHUNK_BYTES)
    while (state.bytes < expected) {
      throwIfBrokerAborted(signal)
      const length = Math.min(buffer.length, expected - state.bytes)
      const { bytesRead } = await entry.part.handle.read(buffer, 0, length, state.bytes)
      if (!bytesRead) throw brokerError('DOWNLOAD_RESUME_PART_SHORT', 'download resume part ended before its committed offset')
      const chunk = buffer.subarray(0, bytesRead)
      addDownloadSniff(state, chunk)
      state.hasher.update(chunk)
      state.bytes += bytesRead
      markProgress()
    }
    const stat = await entry.part.handle.stat({ bigint: true })
    if (
      !sameFilesystemObject(stat, entry.part.identity) || Number(stat.nlink) !== 1 ||
      Number(stat.size) !== expected
    ) throw brokerError('DOWNLOAD_RESUME_PART_INVALID', 'download resume part changed during prefix verification')
    assertSafeDownloadPayload(state.sniff.subarray(0, state.sniffBytes))
    state.lastCheckpointBytes = state.bytes
    state.lastCheckpointAt = Date.now()
    return state
  }
  const checkpointDownloadState = async (state, patch = {}) => {
    const metadata = await downloadResumeStore.commit(state.entry, {
      ...patch,
      state: patch.state || 'ACTIVE',
      committedBytes: state.bytes
    })
    state.lastCheckpointBytes = state.bytes
    state.lastCheckpointAt = Date.now()
    return metadata
  }
  const validateDownloadCheckpointHost = async (state, useActiveSignal = true) => {
    await publicWebUrlPolicy.validate(state.entry.metadata.finalUrl || state.entry.metadata.currentUrl, {
      signal: useActiveSignal ? state.signal : undefined
    })
    state.markProgress?.()
  }
  const resetDownloadState = async (state, patch = {}) => {
    await state.entry.part.handle.truncate(0)
    await state.entry.part.handle.sync()
    const stat = await state.entry.part.handle.stat({ bigint: true })
    if (
      !sameFilesystemObject(stat, state.entry.part.identity) || Number(stat.nlink) !== 1 || Number(stat.size) !== 0
    ) throw brokerError('DOWNLOAD_RESUME_PART_INVALID', 'download resume part could not be reset safely')
    state.bytes = 0
    state.hasher = crypto.createHash('sha256')
    state.sniff = Buffer.allocUnsafe(AGENT_DOWNLOAD_SNIFF_BYTES)
    state.sniffBytes = 0
    state.lastCheckpointBytes = 0
    state.lastCheckpointAt = Date.now()
    await checkpointDownloadState(state, {
      knownTotal: null,
      validator: null,
      contentEncoding: '',
      contentType: '',
      contentDisposition: '',
      ...patch
    })
  }
  const streamDownloadResponseBody = async (res, state, options) => {
    const { maxBytes, signal, markProgress } = options
    let ended = false
    let aborted = false
    const start = state.bytes
    const onEnd = () => { ended = true }
    const onAborted = () => { aborted = true }
    res.once('end', onEnd)
    res.once('aborted', onAborted)
    try {
      for await (const rawChunk of res) {
        throwIfBrokerAborted(signal)
        markProgress()
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
        const nextBytes = state.bytes + chunk.length
        if (!Number.isSafeInteger(nextBytes)) {
          throw brokerError('DOWNLOAD_RESOURCE_LIMIT', 'download byte count exceeded the supported integer range')
        }
        if (maxBytes !== null && nextBytes > maxBytes) {
          throw brokerError('BODY_TOO_LARGE', 'response body exceeds the configured limit', { maxBytes, observedBytes: nextBytes })
        }
        addDownloadSniff(state, chunk)
        await writeDownloadBuffer(state.entry.part.handle, chunk, state.bytes, signal, markProgress)
        state.hasher.update(chunk)
        state.bytes = nextBytes
        if (
          state.bytes - state.lastCheckpointBytes >= AGENT_DOWNLOAD_CHECKPOINT_BYTES ||
          Date.now() - state.lastCheckpointAt >= AGENT_DOWNLOAD_CHECKPOINT_MS
        ) {
          await validateDownloadCheckpointHost(state)
          await checkpointDownloadState(state)
        }
      }
      if (!ended || aborted) {
        throw brokerError('INCOMPLETE_BODY', 'connection closed before the response body completed', { receivedBytes: state.bytes - start })
      }
      return state.bytes - start
    } catch (error) {
      if (signal?.aborted) throw signalError(signal)
      if (error?.safeForRenderer || error instanceof DownloadPolicyError || error instanceof AgentDownloadResumeStoreError) throw error
      throw brokerError('INCOMPLETE_BODY', 'response body failed before completion', {
        receivedBytes: state.bytes - start,
        cause: error
      })
    } finally {
      res.removeListener('end', onEnd)
      res.removeListener('aborted', onAborted)
    }
  }
  const verifyDownloadPartForPublication = async (state) => {
    assertSafeDownloadPayload(state.sniff.subarray(0, state.sniffBytes))
    await checkpointDownloadState(state, { knownTotal: state.bytes })
    const stat = await state.entry.part.handle.stat({ bigint: true })
    if (
      !sameFilesystemObject(stat, state.entry.part.identity) || Number(stat.size) !== state.bytes || Number(stat.nlink) !== 1
    ) throw brokerError('DOWNLOAD_INTEGRITY_FAILED', 'private download part failed final identity verification')
    return {
      entry: state.entry,
      part: state.entry.part,
      bytes: state.bytes,
      sha256: state.hasher.digest('hex'),
      contentType: state.entry.metadata.contentType,
      contentDisposition: state.entry.metadata.contentDisposition,
      statusCode: 200,
      complete: true
    }
  }
  const safeDownloadFailureCheckpoint = async (state) => {
    const stat = await state.entry.part.handle.stat({ bigint: true })
    if (!sameFilesystemObject(stat, state.entry.part.identity) || Number(stat.nlink) !== 1) {
      throw brokerError('DOWNLOAD_RESUME_PART_INVALID', 'download resume part changed before failure checkpoint')
    }
    const size = Number(stat.size)
    if (!Number.isSafeInteger(size) || size < state.bytes) {
      throw brokerError('DOWNLOAD_RESUME_PART_SHORT', 'download resume part shortened before failure checkpoint')
    }
    if (size > state.bytes) {
      await state.entry.part.handle.truncate(state.bytes)
      await state.entry.part.handle.sync()
    }
    if (state.bytes > state.lastCheckpointBytes) await validateDownloadCheckpointHost(state, false)
    await checkpointDownloadState(state)
  }
  const retryableDownloadInterruption = (error, signal) => {
    if (signal?.aborted) {
      return signal.reason?.downloadAction === 'pause' || String(signal.reason?.code || '') === 'REQUEST_TIMEOUT'
    }
    if (error instanceof PublicUrlPolicyError || error instanceof DownloadPolicyError || error instanceof AgentDownloadResumeStoreError) return false
    const code = String(error?.code || '')
    if (['DOWNLOAD_HTTP_RETRYABLE', 'INCOMPLETE_BODY', 'REQUEST_ABORTED', 'REQUEST_TIMEOUT'].includes(code)) return true
    return new Set([
      'ERR_ADDRESS_UNREACHABLE', 'ERR_CONNECTION_ABORTED', 'ERR_CONNECTION_CLOSED',
      'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_TIMED_OUT',
      'ERR_INTERNET_DISCONNECTED', 'ERR_NAME_NOT_RESOLVED', 'ERR_NETWORK_CHANGED',
      'ERR_PROXY_CONNECTION_FAILED', 'ERR_TIMED_OUT', 'ERR_TUNNEL_CONNECTION_FAILED'
    ]).has(electronNetworkErrorCode(error))
  }
  const discardDownloadEntry = async (entry, cause) => {
    const removed = await downloadResumeStore.discard(entry)
    cause.resumeDisposition = 'discarded'
    downloadResumeOwners.delete(entry.metadata.resumeId)
    if (!removed) throw brokerError('DOWNLOAD_CLEANUP_FAILED', 'failed to remove a private download resume part', { cause })
  }
  const pauseDownloadEntry = async (state, cause) => {
    await safeDownloadFailureCheckpoint(state)
    const details = downloadFailureDetails(state.entry)
    await downloadResumeStore.pause(state.entry, {
      state: 'PAUSED_RETRYABLE',
      committedBytes: state.bytes
    })
    const paused = brokerError('DOWNLOAD_PAUSED', 'download paused after a retryable interruption', {
      ...details,
      committedBytes: state.bytes,
      knownTotal: state.entry.metadata.knownTotal,
      interruptedBy: String(cause?.code || electronNetworkErrorCode(cause) || 'network')
    })
    paused.resumeDisposition = 'paused'
    return paused
  }
  const streamAgentDownloadToQuarantine = async (url, options) => {
    const { entry, maxBytes, signal, markProgress } = options
    let state = null
    try {
      assertSafeDownloadUrl(url)
      let target = await publicWebUrlPolicy.validate(url, { signal })
      markProgress()
      assertSafeDownloadUrl(target.url)
      state = await rebuildDownloadHashState(entry, signal, markProgress)

      const pendingRedirect = entry.metadata.redirect?.state === 'AWAITING_APPROVAL'
        ? entry.metadata.redirect.pendingUrl
        : ''
      if (pendingRedirect) {
        if (target.url !== pendingRedirect || new URL(target.url).origin !== entry.metadata.redirect.toOrigin) {
          throw brokerError('DOWNLOAD_RESUME_BINDING_MISMATCH', 'download resume does not match the approved redirect')
        }
        await resetDownloadState(state, {
          currentUrl: target.url,
          finalUrl: target.url,
          approvedOrigin: new URL(target.url).origin,
          redirect: {
            count: entry.metadata.redirect.count,
            state: 'APPROVED_RESET_REQUIRED',
            pendingUrl: '',
            fromOrigin: entry.metadata.redirect.fromOrigin,
            toOrigin: entry.metadata.redirect.toOrigin
          }
        })
      } else if (new URL(target.url).origin !== entry.metadata.approvedOrigin) {
        throw brokerError('DOWNLOAD_RESUME_BINDING_MISMATCH', 'download resume origin changed without redirect approval')
      } else if (target.url !== entry.metadata.currentUrl) {
        await checkpointDownloadState(state, { currentUrl: target.url, finalUrl: target.url })
      }

      let rangeMode = state.bytes > 0 && !!entry.metadata.validator &&
        (!entry.metadata.contentEncoding || entry.metadata.contentEncoding === 'identity')
      for (let redirects = 0; ; redirects += 1) {
        throwIfBrokerAborted(signal)
        const requestHeaders = rangeMode
          ? { Range: `bytes=${state.bytes}-`, 'If-Range': entry.metadata.validator.value }
          : {}
        const response = await requestAgentDownloadHop(target.url, {
          headers: requestHeaders,
          signal,
          markProgress,
          onResponse: async (res, responseInfo) => {
            const { statusCode, headers } = responseInfo
            const responseMetadata = downloadHeaderMetadata(headers)
            const contentRangeText = downloadHeader(headers, 'content-range').trim()
            const isMultipart = /^multipart\/byteranges(?:;|$)/i.test(responseMetadata.contentType.trim())

            if (rangeMode && statusCode === 416) {
              if ((responseMetadata.contentEncoding && responseMetadata.contentEncoding !== 'identity') || isMultipart) {
                throw brokerError('DOWNLOAD_RANGE_MISMATCH', 'download 416 response used an invalid representation')
              }
              const total = parseUnsatisfiedDownloadRange(headers)
              if (
                total !== state.bytes || entry.metadata.knownTotal !== total ||
                !downloadValidatorMatches(entry.metadata.validator, headers)
              ) throw brokerError('DOWNLOAD_RANGE_MISMATCH', 'download 416 response did not prove local completion')
              if (typeof res.destroy === 'function') res.destroy()
              state = await rebuildDownloadHashState(entry, signal, markProgress)
              return { kind: 'complete-416', total }
            }

            if (rangeMode && statusCode === 206) {
              if ((responseMetadata.contentEncoding && responseMetadata.contentEncoding !== 'identity') || isMultipart) {
                throw brokerError('DOWNLOAD_RANGE_MISMATCH', 'resumed response must use one identity byte range')
              }
              assertSafeDownloadResponseMetadata(responseMetadata)
              const range = parseDownloadContentRange(headers)
              if (range.start !== state.bytes || range.end < range.start || range.total <= range.end) {
                throw brokerError('DOWNLOAD_RANGE_MISMATCH', 'download Content-Range did not match the committed offset')
              }
              if (entry.metadata.knownTotal !== null && entry.metadata.knownTotal !== range.total) {
                throw brokerError('DOWNLOAD_RANGE_MISMATCH', 'download total changed while resuming')
              }
              if (!downloadValidatorMatches(entry.metadata.validator, headers)) {
                throw brokerError('DOWNLOAD_RANGE_MISMATCH', 'download validator changed while resuming')
              }
              const span = range.end - range.start + 1
              const expectedBytes = parseDownloadLength(headers)
              if (expectedBytes !== null && expectedBytes !== span) {
                throw brokerError('DOWNLOAD_RANGE_MISMATCH', 'resumed Content-Length did not match Content-Range')
              }
              if (maxBytes !== null && range.total > maxBytes) {
                throw brokerError('BODY_TOO_LARGE', 'resumed download exceeds the configured limit', { maxBytes, observedBytes: range.total })
              }
              await checkpointDownloadState(state, {
                currentUrl: target.url,
                finalUrl: target.url,
                knownTotal: range.total,
                contentEncoding: responseMetadata.contentEncoding || 'identity',
                contentType: responseMetadata.contentType,
                contentDisposition: responseMetadata.contentDisposition
              })
              const actual = await streamDownloadResponseBody(res, state, { maxBytes, signal, markProgress })
              if (actual !== span) {
                throw brokerError('INCOMPLETE_BODY', 'resumed response body did not match Content-Range span', { expectedBytes: span, receivedBytes: actual })
              }
              return { kind: 'range', range }
            }

            if (rangeMode && statusCode !== 200) {
              if (typeof res.destroy === 'function') res.destroy()
              if (statusCode >= 500 && statusCode <= 599) {
                throw brokerError('DOWNLOAD_HTTP_RETRYABLE', 'download server returned a retryable error', { statusCode })
              }
              throw brokerError('DOWNLOAD_RANGE_MISMATCH', `download resume request returned HTTP ${statusCode}`)
            }
            if (rangeMode && contentRangeText) {
              if (typeof res.destroy === 'function') res.destroy()
              throw brokerError('DOWNLOAD_RANGE_MISMATCH', 'download resume 200 response included Content-Range')
            }

            if (statusCode !== 200 || contentRangeText || statusCode === 206) {
              if (typeof res.destroy === 'function') res.destroy()
              if (statusCode >= 500 && statusCode <= 599) {
                throw brokerError('DOWNLOAD_HTTP_RETRYABLE', 'download server returned a retryable error', { statusCode })
              }
              if (statusCode === 206 || contentRangeText) {
                throw brokerError('PARTIAL_RESPONSE', 'unsolicited partial response was rejected')
              }
              throw brokerError('HTTP_ERROR', `HTTP ${statusCode}`, { statusCode })
            }

            assertSafeDownloadResponseMetadata(responseMetadata)
            const expectedBytes = parseDownloadLength(headers)
            if (maxBytes !== null && expectedBytes !== null && expectedBytes > maxBytes) {
              throw brokerError('BODY_TOO_LARGE', 'response body exceeds the configured limit', { maxBytes, observedBytes: expectedBytes })
            }
            if (rangeMode) {
              // If-Range returning 200 means the representation/range cannot be
              // appended. Reset before consuming a single byte of the body.
              await resetDownloadState(state, {
                currentUrl: target.url,
                finalUrl: target.url,
                approvedOrigin: new URL(target.url).origin,
                redirect: { count: redirects, state: 'NONE', pendingUrl: '', fromOrigin: '', toOrigin: '' }
              })
              rangeMode = false
            }
            const validator = downloadValidatorFromHeaders(headers, responseMetadata.contentEncoding)
            await checkpointDownloadState(state, {
              currentUrl: target.url,
              finalUrl: target.url,
              knownTotal: (!responseMetadata.contentEncoding || responseMetadata.contentEncoding === 'identity') ? expectedBytes : null,
              validator,
              contentEncoding: responseMetadata.contentEncoding,
              contentType: responseMetadata.contentType,
              contentDisposition: responseMetadata.contentDisposition,
              redirect: { count: redirects, state: 'NONE', pendingUrl: '', fromOrigin: '', toOrigin: '' }
            })
            const actual = await streamDownloadResponseBody(res, state, { maxBytes, signal, markProgress })
            if (
              expectedBytes !== null &&
              (!responseMetadata.contentEncoding || responseMetadata.contentEncoding === 'identity') &&
              actual !== expectedBytes
            ) {
              throw brokerError('INCOMPLETE_BODY', 'response body byte count did not match Content-Length', { expectedBytes, receivedBytes: actual })
            }
            return { kind: 'fresh', total: state.bytes }
          }
        })

        if (response.redirect) {
          if (redirects >= 5) throw brokerError('TOO_MANY_REDIRECTS', 'too many redirects')
          markProgress()
          const redirected = await publicWebUrlPolicy.validateRedirect(response.location, target.url, { signal })
          markProgress()
          assertSafeDownloadUrl(redirected.url)
          if (new URL(target.url).protocol === 'https:' && new URL(redirected.url).protocol === 'http:') {
            throw brokerError('ERR_HTTPS_DOWNGRADE', 'HTTPS redirects to HTTP are not allowed')
          }
          if (new URL(redirected.url).origin !== entry.metadata.approvedOrigin) {
            await safeDownloadFailureCheckpoint(state)
            const details = downloadFailureDetails(entry)
            await downloadResumeStore.pause(entry, {
              state: 'AWAITING_REDIRECT_APPROVAL',
              committedBytes: state.bytes,
              currentUrl: target.url,
              finalUrl: target.url,
              redirect: {
                count: redirects + 1,
                state: 'AWAITING_APPROVAL',
                pendingUrl: redirected.url,
                fromOrigin: new URL(target.url).origin,
                toOrigin: new URL(redirected.url).origin
              }
            })
            const approval = brokerError(
              'DOWNLOAD_REDIRECT_APPROVAL_REQUIRED',
              'cross-origin download redirect requires another explicit approval',
              { ...details, committedBytes: state.bytes, redirect_url: redirected.url }
            )
            approval.resumeDisposition = 'paused'
            throw approval
          }
          await checkpointDownloadState(state, {
            currentUrl: redirected.url,
            finalUrl: redirected.url,
            redirect: {
              count: redirects + 1,
              state: 'FOLLOWING_SAME_ORIGIN',
              pendingUrl: '',
              fromOrigin: new URL(target.url).origin,
              toOrigin: new URL(redirected.url).origin
            }
          })
          target = redirected
          continue
        }

        // net.request cannot pin the policy DNS answer. No segment becomes a
        // trusted checkpoint or publication candidate until the final host is
        // resolved again after its complete body (or strict 416 proof).
        const containedTarget = await publicWebUrlPolicy.validate(target.url, { signal })
        markProgress()
        target = containedTarget
        if (response.kind === 'range' && response.range.end < response.range.total - 1) {
          await checkpointDownloadState(state, {
            currentUrl: target.url,
            finalUrl: target.url,
            knownTotal: response.range.total
          })
          rangeMode = true
          continue
        }
        await checkpointDownloadState(state, { currentUrl: target.url, finalUrl: target.url, knownTotal: state.bytes })
        const streamed = await verifyDownloadPartForPublication(state)
        return { ...streamed, finalUrl: target.url }
      }
    } catch (rawError) {
      const error = safeDownloadFilesystemError(rawError, 'quarantine-stream')
      if (error?.resumeDisposition) throw error
      if (
        state && entry.persistent && entry.metadata.validator &&
        (!entry.metadata.contentEncoding || entry.metadata.contentEncoding === 'identity') &&
        retryableDownloadInterruption(error, signal)
      ) {
        try { throw await pauseDownloadEntry(state, error) } catch (pauseError) {
          if (pauseError?.code === 'DOWNLOAD_PAUSED') throw pauseError
          await discardDownloadEntry(entry, pauseError)
          throw pauseError
        }
      }
      await discardDownloadEntry(entry, error)
      throw error
    }
  }
  const writeAgentDownloadZoneMarker = async (stagingPath) => {
    if (process.platform !== 'win32') return 'not_applicable'
    const markerPath = `${stagingPath}:Zone.Identifier`
    try {
      await fs.promises.writeFile(markerPath, AGENT_DOWNLOAD_ZONE_MARKER, { flag: 'wx', mode: 0o600 })
      const verified = await fs.promises.readFile(markerPath, 'utf8')
      if (verified !== AGENT_DOWNLOAD_ZONE_MARKER) {
        throw brokerError('DOWNLOAD_MOTW_UNAVAILABLE', 'Windows Internet Zone marker failed verification')
      }
      return 'marked'
    } catch (cause) {
      if (cause?.safeForRenderer) throw cause
      throw brokerError('DOWNLOAD_MOTW_UNAVAILABLE', 'Windows Internet Zone marker could not be applied', { cause })
    }
  }
  const writeAgentDownloadStageMarker = async (stagingPath) => {
    if (process.platform !== 'win32') return
    const markerPath = `${stagingPath}:${AGENT_DOWNLOAD_STAGE_MARKER_STREAM}`
    try {
      await fs.promises.writeFile(markerPath, AGENT_DOWNLOAD_STAGE_MARKER, { flag: 'wx', mode: 0o600 })
      if (await fs.promises.readFile(markerPath, 'utf8') !== AGENT_DOWNLOAD_STAGE_MARKER) {
        throw brokerError('DOWNLOAD_STAGING_UNAVAILABLE', 'download staging ownership marker failed verification')
      }
    } catch (cause) {
      if (cause?.safeForRenderer) throw cause
      throw brokerError('DOWNLOAD_STAGING_UNAVAILABLE', 'download staging ownership marker could not be applied', { cause })
    }
  }
  const removeAgentDownloadStageMarker = (publishedPath) => {
    if (process.platform !== 'win32') return
    const markerPath = `${publishedPath}:${AGENT_DOWNLOAD_STAGE_MARKER_STREAM}`
    try {
      try { fs.unlinkSync(markerPath) } catch (cause) {
        if (cause?.code !== 'ENOENT') throw cause
      }
      try {
        fs.readFileSync(markerPath)
        throw brokerError('DOWNLOAD_STAGING_MARKER_RETAINED', 'download staging ownership marker remained on the published file')
      } catch (cause) {
        if (cause?.safeForRenderer) throw cause
        if (cause?.code !== 'ENOENT') throw cause
      }
    } catch (cause) {
      if (cause?.safeForRenderer) throw cause
      throw brokerError('DOWNLOAD_STAGING_MARKER_RETAINED', 'download staging ownership marker could not be removed from the published file', { cause })
    }
  }
  const publishVerifiedDownload = (destination, streamed, signal, markProgress) => serializeFsMutation(async () => {
    throwIfBrokerAborted(signal)
    const grant = folderGrantsById.get(destination.grantId)
    if (!grant || !sameBoundaryGrantIdentity(boundaryGrantIdentity(grant), destination.grantIdentity)) {
      throw brokerError('DOWNLOAD_DESTINATION_CHANGED', 'download workspace grant changed before publication')
    }
    const target = path.resolve(grant.lexical, ...destination.relativePath.split('/'))
    let authorization
    let openedParent
    try {
      authorization = authorizeCreatablePath(target, [grant])
      openedParent = authorizeDownloadParent(target, grant)
    } catch (cause) {
      throw brokerError('DOWNLOAD_DESTINATION_CHANGED', 'download destination changed before publication', { cause })
    }
    if (
      downloadDestinationKey(authorization.canonicalPath) !== destination.destinationKey ||
      !sameFilesystemIdentity(openedParent.identity, destination.parentIdentity)
    ) {
      throw brokerError('DOWNLOAD_DESTINATION_CHANGED', 'download destination parent changed before publication')
    }
    fsMutations.assertWritable(authorization.lexical)
    if (authorization.exists) throw brokerError('FILE_EXISTS', 'download destination already exists')

    let sourceHandle = null
    let stagingHandle = null
    let stagingPath = ''
    let stagingKey = ''
    let stagingIdentity = null
    let linked = false
    let published = false
    const assertStagingUnchanged = async (stage, requireMissingTarget = true) => {
      let currentParent
      let checkedStage
      let currentStage
      try {
        currentParent = authorizeDownloadParent(target, grant)
        checkedStage = authorizeExistingPath(stagingPath, [grant]).lexical
        currentStage = await fs.promises.lstat(checkedStage, { bigint: true })
      } catch (cause) {
        throw brokerError('DOWNLOAD_DESTINATION_CHANGED', `download staging path changed ${stage}`, { cause })
      }
      if (
        !sameFilesystemIdentity(currentParent.identity, destination.parentIdentity) ||
        downloadDestinationKey(checkedStage) !== downloadDestinationKey(stagingPath) ||
        !sameFilesystemObject(currentStage, stagingIdentity) ||
        !currentStage.isFile() ||
        currentStage.isSymbolicLink() ||
        Number(currentStage.nlink) !== 1
      ) {
        throw brokerError('DOWNLOAD_DESTINATION_CHANGED', `download staging path changed ${stage}`)
      }
      if (requireMissingTarget) {
        let currentTarget
        try { currentTarget = authorizeCreatablePath(target, [grant]) } catch (cause) {
          throw brokerError('DOWNLOAD_DESTINATION_CHANGED', `download destination changed ${stage}`, { cause })
        }
        if (currentTarget.exists) throw brokerError('FILE_EXISTS', 'download destination already exists')
      }
    }
    const closeStaging = async () => {
      if (!stagingHandle) return
      await stagingHandle.close().catch(() => {})
      stagingHandle = null
    }
    const cleanupStaging = async () => {
      await closeStaging()
      if (!stagingIdentity || !stagingPath) return true
      const removed = await removeExactDownloadFile(stagingPath, stagingIdentity, 'publication-staging-cleanup')
      if (removed && stagingKey) activeDownloadStagingPaths.delete(stagingKey)
      return removed
    }
    try {
      try {
        sourceHandle = await fs.promises.open(streamed.part.path, 'r')
      } catch (cause) {
        throw brokerError('DOWNLOAD_QUARANTINE_CHANGED', 'private download part disappeared before publication', { cause })
      }
      const sourceStat = await sourceHandle.stat({ bigint: true })
      if (
        !sameFilesystemObject(sourceStat, streamed.part.identity) ||
        Number(sourceStat.size) !== streamed.bytes ||
        Number(sourceStat.nlink) !== 1
      ) {
        throw brokerError('DOWNLOAD_QUARANTINE_CHANGED', 'private download part changed before publication')
      }

      for (let attempt = 0; attempt < 8; attempt += 1) {
        stagingPath = path.join(openedParent.lexical, `.knote-download-${crypto.randomBytes(24).toString('hex')}.part`)
        stagingKey = downloadDestinationKey(stagingPath)
        activeDownloadStagingPaths.add(stagingKey)
        try {
          stagingHandle = await fs.promises.open(stagingPath, 'wx+', 0o600)
          break
        } catch (error) {
          activeDownloadStagingPaths.delete(stagingKey)
          stagingKey = ''
          if (error?.code === 'EEXIST') continue
          if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            throw brokerError('DOWNLOAD_DESTINATION_CHANGED', 'download destination parent changed before staging')
          }
          throw error
        }
      }
      if (!stagingHandle) throw brokerError('DOWNLOAD_DESTINATION_BUSY', 'could not allocate an atomic publication staging file')
      stagingIdentity = statIdentity(await stagingHandle.stat({ bigint: true }))
      await writeAgentDownloadStageMarker(stagingPath)
      await assertStagingUnchanged('before copy')

      const copyHasher = crypto.createHash('sha256')
      const copyBuffer = Buffer.allocUnsafe(AGENT_DOWNLOAD_COPY_CHUNK_BYTES)
      let copiedBytes = 0
      while (copiedBytes < streamed.bytes) {
        throwIfBrokerAborted(signal)
        await assertStagingUnchanged('during copy')
        const requested = Math.min(copyBuffer.length, streamed.bytes - copiedBytes)
        const { bytesRead } = await sourceHandle.read(copyBuffer, 0, requested, copiedBytes)
        if (!bytesRead) throw brokerError('DOWNLOAD_WRITE_INCOMPLETE', 'private download part ended during publication')
        const chunk = copyBuffer.subarray(0, bytesRead)
        copyHasher.update(chunk)
        await writeDownloadBuffer(stagingHandle, chunk, copiedBytes, signal, markProgress)
        copiedBytes += bytesRead
      }
      const sourceAfterCopy = await sourceHandle.stat({ bigint: true })
      if (
        !sameFilesystemObject(sourceAfterCopy, streamed.part.identity) ||
        Number(sourceAfterCopy.size) !== streamed.bytes ||
        Number(sourceAfterCopy.nlink) !== 1 ||
        copiedBytes !== streamed.bytes ||
        copyHasher.digest('hex') !== streamed.sha256
      ) {
        throw brokerError('DOWNLOAD_INTEGRITY_FAILED', 'private download part changed during publication')
      }

      await stagingHandle.sync()
      const writtenStat = await stagingHandle.stat({ bigint: true })
      if (
        !sameFilesystemObject(writtenStat, stagingIdentity) ||
        Number(writtenStat.size) !== streamed.bytes ||
        Number(writtenStat.nlink) !== 1
      ) {
        throw brokerError('DOWNLOAD_WRITE_INCOMPLETE', 'staged download byte count verification failed')
      }
      const verifier = crypto.createHash('sha256')
      let verifiedBytes = 0
      while (verifiedBytes < streamed.bytes) {
        throwIfBrokerAborted(signal)
        const requested = Math.min(copyBuffer.length, streamed.bytes - verifiedBytes)
        const { bytesRead } = await stagingHandle.read(copyBuffer, 0, requested, verifiedBytes)
        if (!bytesRead) throw brokerError('DOWNLOAD_WRITE_INCOMPLETE', 'staged download ended during verification')
        verifier.update(copyBuffer.subarray(0, bytesRead))
        verifiedBytes += bytesRead
        markProgress()
      }
      const verifiedSha256 = verifier.digest('hex')
      const stagedAfterReadback = await stagingHandle.stat({ bigint: true })
      if (
        !sameFilesystemObject(stagedAfterReadback, stagingIdentity) ||
        Number(stagedAfterReadback.size) !== streamed.bytes ||
        Number(stagedAfterReadback.nlink) !== 1 ||
        verifiedBytes !== streamed.bytes ||
        verifiedSha256 !== streamed.sha256
      ) {
        throw brokerError('DOWNLOAD_INTEGRITY_FAILED', 'staged download failed SHA-256 readback verification')
      }
      const internetZone = await writeAgentDownloadZoneMarker(stagingPath)
      const readyForPublicationStat = await stagingHandle.stat({ bigint: true })
      throwIfBrokerAborted(signal)
      await assertStagingUnchanged('before atomic publication')
      await closeStaging()
      // No asynchronous gap is allowed between this final cancellation check
      // and the no-replace link/unlink metadata transaction.
      throwIfBrokerAborted(signal)
      const prePublishStat = fs.lstatSync(stagingPath, { bigint: true })
      if (
        !sameFilesystemObject(prePublishStat, stagingIdentity) ||
        !prePublishStat.isFile() ||
        prePublishStat.isSymbolicLink() ||
        Number(prePublishStat.size) !== streamed.bytes ||
        Number(prePublishStat.nlink) !== 1 ||
        prePublishStat.mtimeNs !== readyForPublicationStat.mtimeNs ||
        prePublishStat.ctimeNs !== readyForPublicationStat.ctimeNs
      ) {
        throw brokerError('DOWNLOAD_DESTINATION_CHANGED', 'download staging path changed at the publication commit point')
      }
      try {
        fs.linkSync(stagingPath, target)
        linked = true
      } catch (error) {
        if (error?.code === 'EEXIST') throw brokerError('FILE_EXISTS', 'download destination already exists')
        throw brokerError('DOWNLOAD_ATOMIC_PUBLISH_UNAVAILABLE', 'filesystem could not atomically publish the verified download without overwrite', { cause: error })
      }

      let stagingRemoved = false
      try {
        fs.unlinkSync(stagingPath)
        stagingRemoved = true
        if (stagingKey) activeDownloadStagingPaths.delete(stagingKey)
      } catch {
        // Antivirus and sync clients can transiently hold the app-owned name.
        // A successful exact retry restores nlink=1 before we report success.
        try { stagingRemoved = await cleanupStaging() } catch { stagingRemoved = false }
      }
      if (!stagingRemoved) {
        throw brokerError('DOWNLOAD_PUBLICATION_RECOVERY_REQUIRED', 'verified target was linked but its app-owned staging name could not be removed')
      }
      stagingPath = ''
      removeAgentDownloadStageMarker(target)

      let publishedStat
      let publishedParent
      try {
        publishedStat = fs.lstatSync(target, { bigint: true })
        publishedParent = authorizeDownloadParent(target, grant)
      } catch (cause) {
        throw brokerError('DOWNLOAD_DESTINATION_CHANGED', 'download destination changed during atomic publication', { cause })
      }
      if (
        !sameFilesystemObject(publishedStat, stagingIdentity) ||
        !sameFilesystemIdentity(publishedParent.identity, destination.parentIdentity) ||
        !publishedStat.isFile() ||
        publishedStat.isSymbolicLink() ||
        Number(publishedStat.size) !== streamed.bytes ||
        Number(publishedStat.nlink) !== 1
      ) {
        throw brokerError('DOWNLOAD_DESTINATION_CHANGED', 'download destination changed during atomic publication')
      }
      published = true
      try { clearStaleWritePath(target) } catch { /* verified publication is already committed */ }

      return {
        bytes: verifiedBytes,
        sha256: verifiedSha256,
        internetZone,
        cleanupComplete: true,
        publication: 'atomic_hard_link_no_replace'
      }
    } catch (rawError) {
      const error = safeDownloadFilesystemError(rawError, 'atomic-publication')
      if (sourceHandle) {
        await sourceHandle.close().catch(() => {})
        sourceHandle = null
      }
      await closeStaging()
      let stagingCleanupComplete = true
      if (stagingIdentity && stagingPath) {
        try { stagingCleanupComplete = await cleanupStaging() } catch { stagingCleanupComplete = false }
      }
      if (linked && !published) {
        // Never unlink a user-visible pathname after an external race: a
        // pathname check followed by unlink could delete a replacement file.
        throw brokerError(
          stagingCleanupComplete ? 'DOWNLOAD_PUBLICATION_UNCERTAIN' : 'DOWNLOAD_PUBLICATION_RECOVERY_REQUIRED',
          stagingCleanupComplete
            ? 'verified publication could not be fully revalidated; the target was left untouched'
            : 'verified target was linked but its app-owned staging name still requires recovery',
          { cause: error }
        )
      }
      if (!stagingCleanupComplete) {
        throw brokerError('DOWNLOAD_CLEANUP_FAILED', 'failed to remove the exact publication staging file', { cause: error })
      }
      throw error
    } finally {
      if (sourceHandle) await sourceHandle.close().catch(() => {})
      await closeStaging()
      if (stagingKey) activeDownloadStagingPaths.delete(stagingKey)
    }
  })
  const agentDownload = async (request, signal, id, sender) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw brokerError('INVALID_DOWNLOAD_REQUEST', 'download request must be an object')
    }
    const allowedKeys = new Set(['id', 'url', 'workspaceGrantId', 'relativePath', 'maxBytes', 'resumeId'])
    if (Object.keys(request).some((key) => !allowedKeys.has(key))) {
      throw brokerError('INVALID_DOWNLOAD_REQUEST', 'download request contains an unsupported field')
    }
    if (typeof request.url !== 'string') throw brokerError('INVALID_DOWNLOAD_URL', 'download URL is required')
    assertSafeDownloadUrl(request.url)
    const requestedResumeId = request.resumeId === undefined || request.resumeId === null ? '' : request.resumeId
    if (requestedResumeId && !AgentDownloadResumeStore.isResumeId(requestedResumeId)) {
      throw brokerError('DOWNLOAD_RESUME_INVALID', 'download resume id is invalid')
    }
    const maxBytes = request.maxBytes === undefined || request.maxBytes === null ? null : request.maxBytes
    if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) {
      throw brokerError('INVALID_MAX_BYTES', 'maxBytes must be null or a positive safe integer')
    }
    const activity = createAgentDownloadActivity(signal)
    let destination = null
    let releaseDestination = () => {}
    let resumeEntry = null
    let streamed = null
    let committed = false
    let primaryError = null
    try {
      destination = resolveAgentDownloadTarget(request)
      releaseDestination = reserveAgentDownloadDestination(destination, id)
      await ensureDownloadResumeStore()
      const binding = downloadResumeBinding(destination, maxBytes)
      if (requestedResumeId) {
        const owner = downloadResumeOwners.get(requestedResumeId)
        if (owner && owner !== sender) throw brokerError('DOWNLOAD_RESUME_NOT_OWNED', 'download resume belongs to another renderer')
        resumeEntry = await downloadResumeStore.open(requestedResumeId, binding)
      } else {
        const available = await downloadResumeStore.findByDestination(destination.destinationKey)
        if (available) {
          if (!downloadResumeMatchesDestination(available, destination, maxBytes)) {
            await downloadResumeStore.discard(available.resumeId).catch(() => {})
            throw brokerError('DOWNLOAD_RESUME_BINDING_MISMATCH', 'stored download resume no longer matches this workspace')
          }
          if (available.state === 'ACTIVE') {
            throw brokerError('DOWNLOAD_DESTINATION_BUSY', 'another download is already targeting this destination')
          }
          bindDownloadResumeOwner(available.resumeId, sender)
          throw brokerError('DOWNLOAD_RESUME_AVAILABLE', 'a paused download is available for this destination', {
            ...downloadFailureDetails({ metadata: available }),
            resumeId: available.resumeId
          })
        }
        resumeEntry = await downloadResumeStore.create({
          ...binding,
          currentUrl: request.url,
          finalUrl: request.url,
          approvedOrigin: new URL(request.url).origin
        })
      }
      bindDownloadResumeOwner(resumeEntry.metadata.resumeId, sender)
      streamed = await streamAgentDownloadToQuarantine(request.url, {
        entry: resumeEntry,
        maxBytes,
        signal: activity.signal,
        markProgress: activity.markProgress
      })
      const written = await publishVerifiedDownload(
        destination,
        streamed,
        activity.signal,
        activity.markProgress
      )
      const finalUrl = streamed.finalUrl
      const contentType = streamed.contentType
      committed = true
      // Publication is now verified and immutable from this operation's point
      // of view. A later cancellation cannot turn that committed result into
      // an uncertain failure, but IPC still waits for private-part cleanup.
      let privateCleanupComplete = false
      try { privateCleanupComplete = await downloadResumeStore.complete(resumeEntry) } catch { privateCleanupComplete = false }
      if (privateCleanupComplete) {
        downloadResumeOwners.delete(resumeEntry.metadata.resumeId)
        resumeEntry = null
        streamed = null
      }
      return {
        ok: true,
        id,
        relativePath: destination.relativePath,
        name: path.posix.basename(destination.relativePath),
        finalUrl,
        url: finalUrl,
        contentType,
        bytes: written.bytes,
        sha256: written.sha256,
        maxBytes,
        cleanupComplete: written.cleanupComplete && privateCleanupComplete,
        internetZone: written.internetZone,
        publication: written.publication,
        verificationSource: 'streamed_quarantine_atomic_publish_readback_motw'
      }
    } catch (error) {
      primaryError = error
      if (
        resumeEntry && !error?.resumeDisposition && !committed &&
        retryableDownloadInterruption(error, activity.signal) && resumeEntry.persistent && resumeEntry.metadata.validator &&
        !DOWNLOAD_PUBLICATION_STATE_CODES.has(String(error?.code || '')) && resumeEntry.part?.handle
      ) {
        try {
          const details = downloadFailureDetails(resumeEntry)
          await downloadResumeStore.pause(resumeEntry, {
            state: 'PAUSED_RETRYABLE',
            committedBytes: resumeEntry.metadata.committedBytes
          })
          const paused = brokerError('DOWNLOAD_PAUSED', 'download paused before verified publication', details)
          paused.resumeDisposition = 'paused'
          primaryError = paused
          throw paused
        } catch (pauseError) {
          if (pauseError?.code === 'DOWNLOAD_PAUSED') throw pauseError
        }
      }
      throw error
    } finally {
      activity.dispose()
      if (resumeEntry && primaryError?.resumeDisposition === 'paused' && signal?.reason?.downloadAction === 'pause') {
        downloadResumeOwners.delete(resumeEntry.metadata.resumeId)
      }
      try {
        if (resumeEntry && !primaryError?.resumeDisposition) {
          let cleanupError = null
          try {
            const removed = await downloadResumeStore.discard(resumeEntry)
            if (!removed) cleanupError = brokerError('DOWNLOAD_CLEANUP_FAILED', 'failed to remove a private download resume part')
          } catch (error) {
            cleanupError = error
          }
          downloadResumeOwners.delete(resumeEntry.metadata.resumeId)
          if (cleanupError && !committed) {
            if (DOWNLOAD_PUBLICATION_STATE_CODES.has(String(primaryError?.code || ''))) {
              primaryError.cleanupIncomplete = true
            } else {
              throw cleanupError
            }
          }
        }
      } finally {
        releaseDestination()
      }
    }
  }
  const publicWebFailure = (error) => {
    const code = String(error?.code || '')
    if (['ERR_NON_PUBLIC_ADDRESS', 'ERR_BLOCKED_HOSTNAME'].includes(code)) return 'blocked_host'
    if (['ERR_INVALID_URL', 'ERR_UNSUPPORTED_PROTOCOL', 'ERR_URL_CREDENTIALS', 'ERR_INVALID_HOSTNAME'].includes(code)) return 'bad_url'
    if (code === 'ERR_HTTPS_DOWNGRADE') return 'blocked_redirect'
    if (code === 'BODY_TOO_LARGE') return 'too_large'
    if (['INCOMPLETE_BODY', 'PARTIAL_RESPONSE'].includes(code)) return 'incomplete_body'
    if (code === 'REQUEST_TIMEOUT') return 'timeout'
    if (code === 'REQUEST_CANCELLED') return 'cancelled'
    return 'network'
  }
  const decodeEntities = (s) => String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return _ } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d) } catch { return _ } })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'").replace(/&nbsp;/g, ' ')
  const escapeHtml = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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
    while ((sm = sre.exec(html)) && i < out.length) { out[i].snippet = stripTags(sm[1]); i++ }
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
      snippets.push(stripTags(m[1]))
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
  ipcMain.handle('knote:web-search', async (event, payload = {}) => {
    try {
      return await runBrokerRequest(event, payload.id, 'web', async (signal, id) => {
        const rawQ = String(payload.query || '').trim()
        if (!rawQ) return { ok: false, id, error: 'empty_query' }
        // Support site: filtering — extract and pass through to engine query
        const siteM = /(?:^|\s)site:(\S+)/i.exec(rawQ)
        const q = rawQ.replace(/\s*site:\S+\s*/gi, ' ').trim() // clean for URL encoding
        const siteFilter = siteM ? siteM[1] : ''
        const n = Math.min(Math.max(1, Number(payload.max) || 8), 12)
        // Filter engines by user preference; 'auto' or unset = try all
        const engines = (payload.engine && payload.engine !== 'auto')
          ? SEARCH_ENGINES.filter((item) => item.name === payload.engine)
          : SEARCH_ENGINES
        if (!engines.length) return { ok: false, id, error: 'bad_engine', detail: `unknown engine: ${payload.engine}` }
        let lastError = null
        for (const engine of engines) {
          try {
            const qs = siteFilter ? `${q} site:${siteFilter}` : q
            const url = buildEngineUrl(engine, qs, payload.region)
            const { text: html } = await netGet(url, {
              timeout: 15000,
              maxBytes: 3_000_000,
              signal
            })
            const results = engine.parse(html)
            if (results.length) return { ok: true, id, engine: engine.name, results: results.slice(0, n) }
          } catch (error) {
            if (signal.aborted) throw error
            lastError = error
          }
        }
        // Every engine either errored or served a resultless bot/landing page.
        return {
          ok: false,
          id,
          error: lastError ? publicWebFailure(lastError) : 'blocked',
          detail: String(lastError?.message || '').slice(0, 120)
        }
      })
    } catch (error) {
      return { ok: false, id: typeof payload.id === 'string' ? payload.id.slice(0, 160) : '', error: publicWebFailure(error), detail: String(error?.message || error).slice(0, 120) }
    }
  })
  ipcMain.handle('knote:web-fetch', async (event, payload = {}) => {
    try {
      return await runBrokerRequest(event, payload.id, 'web', async (signal, id) => {
        if (typeof payload.url !== 'string') return { ok: false, id, error: 'bad_url' }
        // Keep the extracted text complete within the broker's existing 3 MB
        // response-body ceiling. The renderer persists large results as
        // resumable artifacts before sending a bounded preview to the model.
        const fetched = await netGet(payload.url, { timeout: 20000, maxBytes: 3_000_000, signal })
        const html = fetched.text
        let title = ''; let text = ''
        // Readability parses synchronously on main's event loop, so use the
        // cheap fallback for large pages rather than freezing the desktop UI.
        if (html.length <= 800_000) {
          try {
            const { JSDOM } = require('jsdom')
            const { Readability } = require('@mozilla/readability')
            const dom = new JSDOM(html, { url: fetched.finalUrl })
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
        return {
          ok: true,
          id,
          title,
          url: fetched.finalUrl,
          finalUrl: fetched.finalUrl,
          contentType: fetched.contentType,
          bytes: fetched.bytes,
          sourceComplete: fetched.complete === true,
          clipped: false,
          text
        }
      })
    } catch (error) {
      return { ok: false, id: typeof payload.id === 'string' ? payload.id.slice(0, 160) : '', error: publicWebFailure(error), detail: String(error?.message || error).slice(0, 120) }
    }
  })
  ipcMain.handle('knote:web-request-cancel', (event, { id } = {}) => cancelBrokerRequest(event, id, 'web'))
  const resumeGrantForRequest = (request) => {
    const grantId = typeof request?.workspaceGrantId === 'string' ? request.workspaceGrantId : ''
    const grant = folderGrantsById.get(grantId)
    if (!grant) throw brokerError('INVALID_WORKSPACE_GRANT', 'workspace grant is missing or invalid')
    return grant
  }
  const resumeMetadataMatchesGrant = (metadata, grant) => (
    metadata && sameBoundaryGrantIdentity(metadata.workspace, boundaryGrantIdentity(grant))
  )
  const sanitizedResumeStatus = (metadata) => {
    let origin = ''
    try { origin = new URL(metadata.finalUrl || metadata.currentUrl).origin } catch { /* encrypted record validation already rejects this */ }
    return {
      resume_id: metadata.resumeId,
      state: metadata.state,
      committed_bytes: metadata.committedBytes,
      known_total: metadata.knownTotal,
      origin,
      path: metadata.relativePath,
      retryable: metadata.state === 'PAUSED_RETRYABLE',
      expires_at: metadata.expiresAt
    }
  }
  const assertResumeOwner = (resumeId, sender) => {
    const owner = downloadResumeOwners.get(resumeId)
    if (owner && owner !== sender) throw brokerError('DOWNLOAD_RESUME_NOT_OWNED', 'download resume belongs to another renderer')
  }
  ipcMain.handle('knote:agent-download', async (event, request = {}) => {
    try {
      return await runBrokerRequest(event, request?.id, 'download', (signal, id) => agentDownload(request, signal, id, event.sender))
    } catch (error) {
      return downloadFailure(request?.id, error)
    }
  })
  ipcMain.handle('knote:agent-download-cancel', (event, { id } = {}) => cancelBrokerRequest(event, id, 'download'))
  ipcMain.handle('knote:agent-download-status', async (event, request = {}) => {
    try {
      const sender = assertBrokerSender(event)
      if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some((key) => !['resumeId', 'workspaceGrantId'].includes(key))) {
        throw brokerError('INVALID_DOWNLOAD_REQUEST', 'download resume status request is invalid')
      }
      if (!AgentDownloadResumeStore.isResumeId(request.resumeId)) throw brokerError('DOWNLOAD_RESUME_INVALID', 'download resume id is invalid')
      const grant = resumeGrantForRequest(request)
      assertResumeOwner(request.resumeId, sender)
      await ensureDownloadResumeStore()
      const metadata = await downloadResumeStore.status(request.resumeId)
      if (!metadata || !resumeMetadataMatchesGrant(metadata, grant)) throw brokerError('DOWNLOAD_RESUME_NOT_FOUND', 'download resume is unavailable')
      bindDownloadResumeOwner(metadata.resumeId, sender)
      return { ok: true, ...sanitizedResumeStatus(metadata) }
    } catch (error) {
      return downloadFailure('', error)
    }
  })
  ipcMain.handle('knote:agent-download-list-available', async (event, request = {}) => {
    try {
      const sender = assertBrokerSender(event)
      if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some((key) => key !== 'workspaceGrantId')) {
        throw brokerError('INVALID_DOWNLOAD_REQUEST', 'download resume list request is invalid')
      }
      const grant = resumeGrantForRequest(request)
      await ensureDownloadResumeStore()
      const available = []
      for (const metadata of await downloadResumeStore.scan()) {
        if (!['PAUSED_RETRYABLE', 'AWAITING_REDIRECT_APPROVAL'].includes(metadata.state)) continue
        if (!resumeMetadataMatchesGrant(metadata, grant)) continue
        const owner = downloadResumeOwners.get(metadata.resumeId)
        if (owner && owner !== sender) continue
        bindDownloadResumeOwner(metadata.resumeId, sender)
        available.push(sanitizedResumeStatus(metadata))
      }
      return { ok: true, available }
    } catch (error) {
      return downloadFailure('', error)
    }
  })
  ipcMain.handle('knote:agent-download-discard', async (event, request = {}) => {
    try {
      const sender = assertBrokerSender(event)
      if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some((key) => !['resumeId', 'workspaceGrantId'].includes(key))) {
        throw brokerError('INVALID_DOWNLOAD_REQUEST', 'download resume discard request is invalid')
      }
      if (!AgentDownloadResumeStore.isResumeId(request.resumeId)) throw brokerError('DOWNLOAD_RESUME_INVALID', 'download resume id is invalid')
      const grant = resumeGrantForRequest(request)
      assertResumeOwner(request.resumeId, sender)
      await ensureDownloadResumeStore()
      const metadata = await downloadResumeStore.status(request.resumeId)
      if (!metadata || !resumeMetadataMatchesGrant(metadata, grant)) throw brokerError('DOWNLOAD_RESUME_NOT_FOUND', 'download resume is unavailable')
      const discarded = await downloadResumeStore.discard(metadata.resumeId)
      if (!discarded) throw brokerError('DOWNLOAD_CLEANUP_FAILED', 'download resume could not be fully discarded')
      downloadResumeOwners.delete(metadata.resumeId)
      return { ok: true, resume_id: metadata.resumeId }
    } catch (error) {
      return downloadFailure('', error)
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
    const xmlSourceText = (xml) => decodeEntities(String(xml || '')
      .replace(/<(?:a:br|text:line-break)\b[^>]*\/?\s*>/gi, '\n')
      .replace(/<text:tab\b[^>]*\/?\s*>/gi, '\t')
      .replace(/<\/a:p\s*>/gi, '\n')
      .replace(/<\/(?:text:p|text:h)\s*>/gi, '\n')
      .replace(/<\/table:table-cell\s*>/gi, '\t')
      .replace(/<\/table:table-row\s*>/gi, '\n')
      .replace(/<\/draw:page\s*>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .split('\n')
      .map((line) => line.replace(/[ \f\v]+/g, ' ').replace(/\s*\t\s*/g, '\t').trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim())
    const numberedArchiveEntrySort = (left, right) => {
      const leftNumber = Number(/(\d+)\.xml$/i.exec(left)?.[1] || 0)
      const rightNumber = Number(/(\d+)\.xml$/i.exec(right)?.[1] || 0)
      return leftNumber - rightNumber || left.localeCompare(right)
    }
    try {
      if (/\.docx$/i.test(fname)) {
        const mammoth = require('mammoth')
        const [htmlRes, txtRes] = await Promise.all([
          mammoth.convertToHtml({ buffer: buf }),
          mammoth.extractRawText({ buffer: buf })
        ])
        return { ok: true, html: htmlRes.value || '', text: txtRes.value || '', source_complete: true }
      }
      if (/\.(pptx|xlsx|odt|ods|odp)$/i.test(fname)) {
        const JSZip = require('jszip')
        const zip = await JSZip.loadAsync(buf)
        const textParts = []
        if (/\.pptx$/i.test(fname)) {
          const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort(numberedArchiveEntrySort)
          for (let index = 0; index < slides.length; index++) {
            const xml = await zip.files[slides[index]].async('string')
            const text = xmlSourceText(xml)
            textParts.push(`[Slide ${index + 1}]${text ? `\n${text}` : ''}`)
          }
          return { ok: true, html: textParts.length ? textParts.map((text) => `<div class="pptx-slide"><pre>${escapeHtml(text)}</pre></div>`).join('') : '<p>（无内容）</p>', text: textParts.join('\n\n'), source_complete: true }
        }
        if (/\.xlsx$/i.test(fname)) {
          const ssXml = zip.files['xl/sharedStrings.xml'] ? await zip.files['xl/sharedStrings.xml'].async('string') : ''
          const ss = []; let m; const siRe = /<si[^>]*>([\s\S]*?)<\/si>/g
          while ((m = siRe.exec(ssXml))) ss.push(xmlSourceText(m[1]))
          const sheets = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort(numberedArchiveEntrySort)
          // place values by their r="B7" column ref: matching only <v>-bearing
          // cells used to collapse away empty/omitted cells and shift every
          // column left of a gap (keep in sync with src/lib/fileReader.js)
          const colIdx = (col) => { let n = 0; for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64); return n - 1 }
          for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
            const sf = sheets[sheetIndex]
            const xml = await zip.files[sf].async('string')
            textParts.push(`[Sheet ${sheetIndex + 1}]`)
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
                else if (/\bt="inlineStr"/.test(attrs)) val = xmlSourceText(body)
                else val = vm ? decodeEntities(vm[1]).trim() : ''
                while (cells.length <= idx) cells.push('')
                cells[idx] = val
              }
              if (cells.some(c => c)) textParts.push(cells.join('\t'))
            }
          }
          const rows = textParts.map(r => `<tr>${r.split('\t').map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
          return { ok: true, html: rows.length ? `<table>${rows.join('')}</table>` : '<p>（无数据）</p>', text: textParts.join('\n'), source_complete: true }
        }
        // odt/ods/odp: extract from content.xml
        const contentXml = zip.files['content.xml'] ? await zip.files['content.xml'].async('string') : ''
        const text = xmlSourceText(contentXml)
        return { ok: true, html: text ? `<pre>${escapeHtml(text)}</pre>` : '<p>（无内容）</p>', text, source_complete: true }
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
          await runStreaming(venvPython(), ['-I', '-m', 'pip', '--version'])
        } catch {
          emitEnvProgress('检测到损坏的旧环境，清理重建…')
          await rmDirWithRetry(dir)
        }
      }
      if (!venvPython()) {
        const sysPy = await firstWorkingPython()
        if (sysPy) {
          emitEnvProgress(`使用 ${sysPy} 创建虚拟环境…`)
          await runStreaming(sysPy, ['-I', '-S', '-m', 'venv', dir])
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
      await runStreaming(vpy, ['-I', '--version'])
      // pip goes DIRECT to a China-hosted mirror: local proxies truncate the
      // multi-hundred-MB paddle wheels, which looks like a silent hang
      const pipMirror = ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple']
      emitEnvProgress('升级 pip…')
      await runStreaming(vpy, ['-I', '-m', 'pip', 'install', '--upgrade', 'pip', '--disable-pip-version-check', ...pipMirror], { noProxy: true })
      emitEnvProgress('安装 PaddleOCR 及依赖（较大，请耐心等待，可能数分钟）…')
      await runStreaming(vpy, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', ...pipMirror, '-r', path.join(sidecarDir(), 'requirements.txt')], { noProxy: true })
      emitEnvProgress('校验安装…')
      await runStreaming(vpy, ['-I', '-c', 'import paddleocr; print("paddleocr", getattr(paddleocr, "__version__", "?"))'])
      // pre-download the PP-Structure models so the first real analysis is fast
      // (non-fatal — models also lazy-download on first use if this can't finish)
      emitEnvProgress('预下载 PaddleOCR 模型（首次较大，请耐心等待，可能数分钟）…')
      try {
        await runStreaming(vpy, ['-I', path.join(sidecarDir(), 'knote_pdf_service.py'), '--warmup'])
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
  // Open workspace attachments with the OS default application. Markdown is
  // routed back through Knote's normal open-file pipeline into a new tab.
  // The open helper preserves the narrower single-file/image/assets scopes.
  ipcMain.handle('knote:open-path', async (_e, { path: p }) => {
    let abs
    try {
      abs = existingOpenPath(p)
    } catch (workspaceError) {
      const resolved = path.resolve(String(p || ''))
      const snapshot = pickedOpenPaths.get(resolved)
      if (!snapshot || !openTargetCapabilities().matches('file', snapshot)) throw workspaceError
      abs = resolved
    }
    try {
      abs = assertOpenableDocument(abs)
    } catch (error) {
      return { ok: false, code: error?.code || 'UNSAFE_OPEN_PATH', error: String(error?.message || error) }
    }
    if (/\.(?:md|markdown)$/i.test(abs)) {
      const opened = await sendOpenFile(abs)
      return { ok: opened, error: opened ? '' : 'open_failed' }
    }
    const err = await shell.openPath(abs)
    return { ok: !err, error: err || '' }
  })
  // delete to the OS recycle bin instead of unlinking (undoable in Explorer)
  ipcMain.handle('knote:trash', (_e, { path: p, expected = null }) => serializeFsMutation(async () => {
    const target = existingWriteOrWritablePath(p)
    await preserveFiles(await markdownFilesUnder(target), 'before-trash')
    if (expected && typeof expected === 'object') {
      let currentStat
      try { currentStat = fileStatIdentity(await fs.promises.stat(target, { bigint: true })) } catch (error) {
        if (error?.code === 'ENOENT') return { ok: false, stale: true, error: 'stale_file' }
        throw error
      }
      if (expected.stat && !fileStatIdentityMatches(expected.stat, currentStat)) {
        return { ok: false, stale: true, error: 'stale_file' }
      }
      if (typeof expected.content === 'string') {
        const current = await readFileState(target)
        if (!current.stable || current.content !== expected.content ||
            (expected.stat && !fileStatIdentityMatches(expected.stat, current.stat))) {
          return { ok: false, stale: true, error: 'stale_file' }
        }
      }
    }
    await shell.trashItem(target)
    markStaleWritePath(target)
    return { ok: true }
  }))

  // session restore: re-open remembered file/folder paths on startup. Paths
  // are validated to still exist; re-registers them as writable/browsable.
  ipcMain.handle('knote:reopen', async (_e, { type, capability, requestId }) => {
    try {
      const normalizedType = type === 'folder' ? 'folder' : 'file'
      let target
      let capabilitySnapshot = null
      try {
        capabilitySnapshot = openTargetCapabilities().verify(normalizedType, capability)
        target = capabilitySnapshot.path
      } catch {
        if (!isE2E) return false
        target = path.resolve(String(capability || ''))
      }
      if (!target || !fs.existsSync(target)) return false
      const meta = { requestId: normalizeOpenRequestId(requestId), capabilitySnapshot }
      if (normalizedType === 'folder') return sendOpenFolder(target, meta)
      return await sendOpenFile(target, meta)
    } catch { return false }
  })

  ipcMain.handle('knote:clipboard-read-text', () => clipboard.readText())
  ipcMain.handle('knote:clipboard-write-text', (_event, payload = {}) => {
    const text = String(payload?.text || '')
    if (text.length > 8 * 1024 * 1024) throw new Error('CLIPBOARD_TEXT_TOO_LARGE')
    clipboard.writeText(text)
    return true
  })

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
    titleBarZoomFactor = f
    win.webContents.setZoomFactor(f)
    applyTitleBarOverlay()
    return true
  })

  ipcMain.handle('knote:titlebar-theme', (_e, { dark }) => {
    titleBarDark = dark === true
    return applyTitleBarOverlay()
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
    const safeName = path.basename(String(defaultName || 'knote')).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/\.pdf$/i, '') || 'knote'
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出 PDF',
      defaultPath: `${safeName}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    return serializeFsMutation(async () => {
      const prevBg = win.getBackgroundColor()
      let output = null
      try {
        // Open and verify the exact user-selected object before the long render.
        // Later path swaps cannot redirect writes made through this pinned handle.
        const outputRoot = createBoundaryRoot(path.dirname(filePath))
        const existed = fs.existsSync(filePath)
        output = await fs.promises.open(filePath, existed ? 'r+' : 'wx')
        const checked = authorizeCreatablePath(filePath, [outputRoot]).lexical
        const opened = await output.stat({ bigint: true })
        const current = fs.statSync(checked, { bigint: true })
        if (String(opened.dev) !== String(current.dev) || String(opened.ino) !== String(current.ino)) {
          throw new Error('PDF export destination changed before rendering')
        }
        // The window background would otherwise bleed into transparent margins.
        win.setBackgroundColor('#ffffff')
        const pdf = await win.webContents.printToPDF({
          printBackground: true,
          margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
        })
        await output.truncate(0)
        await output.writeFile(pdf)
        shell.showItemInFolder(filePath)
        return { ok: true, path: filePath }
      } catch (err) {
        return { ok: false, error: String(err && err.message) }
      } finally {
        if (output) await output.close().catch(() => {})
        win.setBackgroundColor(prevBg || '#e5e7eb')
      }
    })
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
      if (!win || win.isDestroyed()) createWindow()
      else showWindow()
    })
  })

}
