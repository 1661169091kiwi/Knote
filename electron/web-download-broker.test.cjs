'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter, once } = require('node:events')
const { PassThrough } = require('node:stream')
const Module = require('node:module')

const immediate = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const createHarness = async (options = {}) => {
  const ownsRoot = !options.root
  const root = options.root || await fs.promises.mkdtemp(path.join(os.tmpdir(), 'knote-web-broker-'))
  const userData = options.userData || path.join(root, 'user-data')
  const workspace = options.workspace || path.join(root, 'workspace')
  await fs.promises.mkdir(userData, { recursive: true })
  await fs.promises.mkdir(workspace, { recursive: true })

  class MockIpcMain extends EventEmitter {
    constructor () {
      super()
      this.handlers = new Map()
    }

    handle (channel, handler) {
      this.handlers.set(channel, handler)
    }
  }

  class MockWebContents extends EventEmitter {
    constructor () {
      super()
      this.id = 41
      this.sent = []
    }

    send (channel, payload) { this.sent.push({ channel, payload }) }
    setWindowOpenHandler () {}
    setBackgroundThrottling () {}
    setZoomFactor () {}
    capturePage () { return Promise.resolve({ isEmpty: () => true }) }
    executeJavaScript () { return Promise.resolve(null) }
    printToPDF () { return Promise.resolve(Buffer.from('%PDF')) }
  }

  const windows = []
  class MockBrowserWindow extends EventEmitter {
    constructor () {
      super()
      this.webContents = new MockWebContents()
      this.destroyed = false
      windows.push(this)
    }

    isDestroyed () { return this.destroyed }
    isMinimized () { return false }
    isMaximized () { return false }
    isFullScreen () { return false }
    restore () {}
    show () {}
    hide () {}
    focus () {}
    moveTop () {}
    loadFile () { return Promise.resolve() }
    setBackgroundColor () {}
    getBackgroundColor () { return '#ffffff' }
    setTitleBarOverlay () {}
  }
  MockBrowserWindow.fromWebContents = (sender) => windows.find((window) => window.webContents === sender) || null
  MockBrowserWindow.getAllWindows = () => [...windows]

  const ipcMain = new MockIpcMain()
  const app = new EventEmitter()
  app.isPackaged = false
  app.getPath = (name) => name === 'userData' ? userData : root
  app.setPath = () => {}
  app.getVersion = () => 'test'
  app.requestSingleInstanceLock = () => true
  app.disableHardwareAcceleration = () => {}
  app.whenReady = () => Promise.resolve()
  app.quit = () => {}
  app.exit = () => {}

  const responseScripts = []
  const resolutionScripts = []
  const requests = []
  const resolvedHosts = []
  const net = {
    async resolveHost (hostname) {
      resolvedHosts.push(hostname)
      if (resolutionScripts.length) {
        const resolution = resolutionScripts.shift()
        if (resolution instanceof Error) throw resolution
        return typeof resolution === 'function' ? resolution(hostname) : resolution
      }
      return { endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] }
    },
    request (options) {
      const script = responseScripts.shift()
      if (!script) throw new Error(`No mock response queued for ${options.url}`)
      const request = new EventEmitter()
      request.options = options
      request.headers = {}
      request.aborted = false
      request.setHeader = (name, value) => { request.headers[name.toLowerCase()] = String(value) }
      request.write = () => {}
      request.abort = () => {
        if (request.aborted) return
        request.aborted = true
        request.emit('abort')
        request.emit('close')
      }
      request.end = () => {
        setImmediate(() => {
          void (async () => {
          if (request.aborted) return
          if (script.type === 'redirect') {
            request.emit('redirect', script.statusCode || 302, 'GET', script.location, {
              location: [script.location]
            })
            return
          }
          const response = new PassThrough({ highWaterMark: script.highWaterMark || 16 * 1024 })
          response.statusCode = script.statusCode == null ? 200 : script.statusCode
          response.headers = script.headers || {}
          request.response = response
          request.emit('response', response)
          if (request.aborted) return
          script.onResponse?.(response, request)
          if (typeof script.run === 'function') {
            await script.run(response, request)
            return
          }
          const chunks = typeof script.chunks === 'function' ? script.chunks() : (script.chunks || [])
          for await (const chunk of chunks) {
            if (request.aborted || response.destroyed) return
            const writable = response.write(Buffer.from(chunk))
            script.maxBufferedBytes = Math.max(script.maxBufferedBytes || 0, response.readableLength)
            if (!writable) await once(response, 'drain')
            if (script.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, script.chunkDelayMs))
          }
           if (script.error) {
             if (typeof script.beforeError === 'function') await script.beforeError(response, request)
             if (script.errorDelayMs) await new Promise((resolve) => setTimeout(resolve, script.errorDelayMs))
             response.destroy(script.error)
           }
          else if (script.end !== false) response.end()
          })().catch((error) => {
            if (request.response && !request.response.destroyed) request.response.destroy(error)
          })
        })
      }
      requests.push(request)
      return request
    }
  }

  const dialog = {
    showOpenDialog: async () => ({ canceled: false, filePaths: [workspace] }),
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 1 })
  }
  const safeStorageKey = options.safeStorageKey || crypto.randomBytes(32)
  const sealForSafeStorage = (text) => {
    const nonce = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', safeStorageKey, nonce)
    const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()])
    return Buffer.concat([nonce, cipher.getAuthTag(), body])
  }
  const unsealForSafeStorage = (sealed) => {
    const value = Buffer.from(sealed)
    const decipher = crypto.createDecipheriv('aes-256-gcm', safeStorageKey, value.subarray(0, 12), { authTagLength: 16 })
    decipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
  }
  const safeStorageAvailable = options.safeStorageAvailable === true
  const electron = {
    app,
    BrowserWindow: MockBrowserWindow,
    shell: {
      openExternal: () => {},
      openPath: async () => '',
      showItemInFolder: () => {},
      trashItem: async () => {}
    },
    Tray: class extends EventEmitter { setToolTip () {} setContextMenu () {} },
    Menu: { buildFromTemplate: () => ({}) },
    ipcMain,
    nativeImage: {
      createFromPath: () => ({ resize () { return this } }),
      createFromDataURL: () => ({ isEmpty: () => true })
    },
    dialog,
    clipboard: {
      readText: () => '',
      readImage: () => ({ isEmpty: () => true }),
      readHTML: () => '',
      writeImage: () => {}
    },
    net,
    crashReporter: {},
    safeStorage: {
      isEncryptionAvailable: () => safeStorageAvailable,
      encryptString: sealForSafeStorage,
      decryptString: unsealForSafeStorage
    }
  }

  const mainPath = require.resolve('./main.cjs')
  const originalLoad = Module._load
  const oldE2E = process.env.KNOTE_E2E
  const oldPath = process.env.PATH
  const oldDefaultApp = process.defaultApp
  process.env.KNOTE_E2E = '1'
  process.env.PATH = ''
  process.defaultApp = true
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron
    if (parent?.filename === mainPath && request === './crash-diagnostics.cjs') {
      return { attachCrashDiagnostics: () => ({ attachWindow () {}, flush: async () => {} }) }
    }
    if (parent?.filename === mainPath && request === './quit-cleanup.cjs') {
      return {
        createQuitCleanupController: (controllerOptions) => ({
          install () {
            app.runTestQuitCleanup = async () => {
              controllerOptions.markQuitting?.()
              return controllerOptions.cleanup({ signal: new AbortController().signal })
            }
          }
        }),
        createRendererQuitHandshake: () => ({ request: async () => ({ status: 'unavailable' }), acknowledge () {} }),
        terminateProcessTree: async () => ({ status: 'exited' })
      }
    }
    if (parent?.filename === mainPath && request === './agent-sandbox-service.cjs') {
      return {
        AgentSandboxService: class { cancelAll () { return Promise.resolve() } },
        installAgentSandboxIpc: () => {}
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    delete require.cache[mainPath]
    require(mainPath)
  } finally {
    Module._load = originalLoad
  }
  await immediate()
  await immediate()
  const window = windows[0]
  assert(window, 'main process did not create its window')
  ipcMain.emit('knote:renderer-ready', { sender: window.webContents })
  await ipcMain.handlers.get('knote:pick-open')(
    { sender: window.webContents },
    { kind: 'folder' }
  )
  const opened = window.webContents.sent.find((item) => item.channel === 'knote:open-folder')
  assert(opened?.payload?.grantId, 'folder grant was not issued')

  const invoke = (channel, payload, sender = window.webContents) => {
    const handler = ipcMain.handlers.get(channel)
    assert(handler, `missing IPC handler ${channel}`)
    return handler({ sender }, payload)
  }
  const restore = async () => {
    delete require.cache[mainPath]
    if (oldE2E === undefined) delete process.env.KNOTE_E2E
    else process.env.KNOTE_E2E = oldE2E
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    process.defaultApp = oldDefaultApp
    if (ownsRoot && options.removeRoot !== false) await fs.promises.rm(root, { recursive: true, force: true })
  }
  return {
    workspace,
    userData,
    root,
    safeStorageKey,
    grantId: opened.payload.grantId,
    invoke,
    requests,
    resolvedHosts,
    enqueue: (script) => { responseScripts.push(script); return script },
    enqueueResolution: (resolution) => resolutionScripts.push(resolution),
    queuedResponses: () => responseScripts.length,
    queuedResolutions: () => resolutionScripts.length,
    runQuitCleanup: () => app.runTestQuitCleanup(),
    sender: window.webContents,
    quarantineFiles: async () => {
      try { return await fs.promises.readdir(path.join(userData, 'agent-download-quarantine', 'v2')) } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
      }
    },
    restore
  }
}

const agentDownloadRequest = (harness, id, relativePath, extra = {}) => ({
  id,
  url: extra.url || 'https://public.example/source.pdf',
  workspaceGrantId: harness.grantId,
  relativePath,
  maxBytes: extra.maxBytes === undefined ? null : extra.maxBytes,
  ...(extra.resumeId ? { resumeId: extra.resumeId } : {})
})

const pauseStableDownload = async (harness, options = {}) => {
  const body = Buffer.from(options.prefix || '%PDF')
  const total = options.total === undefined ? body.length + 8 : options.total
  const validatorHeaders = options.validatorHeaders || { etag: options.etag || '"resume-v1"' }
  const existingParts = new Set((await harness.quarantineFiles()).filter((name) => name.endsWith('.part')))
  harness.enqueue({
    type: 'response',
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(total),
      ...validatorHeaders
    },
    chunks: [body],
    beforeError: async () => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const parts = (await harness.quarantineFiles())
          .filter((name) => name.endsWith('.part') && !existingParts.has(name))
        for (const name of parts) {
          const stat = await fs.promises.stat(path.join(harness.userData, 'agent-download-quarantine', 'v2', name))
          if (stat.size >= body.length) {
            await immediate()
            return
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error('mock download prefix was not written before interruption')
    },
    error: Object.assign(new Error('simulated connection reset'), { code: 'ERR_CONNECTION_RESET' })
  })
  const request = agentDownloadRequest(
    harness,
    options.id || `pause-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    options.relativePath || 'paused.pdf',
    { url: options.url, maxBytes: options.maxBytes }
  )
  const result = await harness.invoke('knote:agent-download', request)
  return { body, total, request, result }
}

test('secure Electron web/download broker enforces network and filesystem boundaries', async (t) => {
  const harness = await createHarness()
  t.after(harness.restore)
  const baseRequest = (id, relativePath, maxBytes = null) => ({
    id,
    url: 'https://public.example/source.pdf',
    workspaceGrantId: harness.grantId,
    relativePath,
    maxBytes
  })

  await t.test('missing destination parents fail before any network request', async () => {
    const before = harness.requests.length
    const result = await harness.invoke('knote:agent-download', baseRequest('download-parent-missing', 'downloads/missing.pdf'))
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DOWNLOAD_PARENT_MISSING')
    assert.equal(harness.requests.length, before)
    assert.equal(await fs.promises.stat(path.join(harness.workspace, 'downloads')).then(() => true, () => false), false)
  })

  await t.test('writes and verifies a download when its existing parent is authorized', async () => {
    const parent = path.join(harness.workspace, 'downloads')
    const target = path.join(parent, 'normal.pdf')
    const body = Buffer.from('%PDF-1.7\nexisting parent\n')
    await fs.promises.mkdir(parent)
    const staleRoot = path.join(harness.userData, 'agent-download-quarantine', 'v1')
    await fs.promises.mkdir(staleRoot, { recursive: true })
    await fs.promises.writeFile(path.join(staleRoot, `${'a'.repeat(48)}.part`), 'stale private bytes')
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf', 'content-length': String(body.length) },
      chunks: [body]
    })
    const result = await harness.invoke('knote:agent-download', baseRequest('download-existing-parent', 'downloads/normal.pdf'))
    assert.equal(result.ok, true)
    assert.equal(result.bytes, body.length)
    assert.equal(result.sha256, crypto.createHash('sha256').update(body).digest('hex'))
    assert.equal(result.publication, 'atomic_hard_link_no_replace')
    assert.equal(result.internetZone, process.platform === 'win32' ? 'marked' : 'not_applicable')
    assert.equal(result.cleanupComplete, true)
    assert.deepEqual(await fs.promises.readFile(target), body)
    assert.equal((await fs.promises.stat(target)).nlink, 1)
    if (process.platform === 'win32') {
      assert.equal(await fs.promises.readFile(`${target}:Zone.Identifier`, 'utf8'), '[ZoneTransfer]\r\nZoneId=3\r\n')
      await assert.rejects(
        fs.promises.readFile(`${target}:Knote.DownloadStage`),
        (error) => error?.code === 'ENOENT'
      )
    }
    assert.equal((await fs.promises.readdir(parent)).some((name) => name.startsWith('.knote-download-')), false)
  })

  await t.test('streams a generated download above 30 MiB with bounded buffering when no limit was selected', async () => {
    const totalBytes = 31 * 1024 * 1024 + 137
    const chunkBytes = 64 * 1024
    const chunks = function * () {
      let offset = 0
      while (offset < totalBytes) {
        const chunk = Buffer.alloc(Math.min(chunkBytes, totalBytes - offset), 0x61)
        if (offset === 0) Buffer.from('%PDF-1.7\n').copy(chunk)
        offset += chunk.length
        yield chunk
      }
    }
    const expectedHash = crypto.createHash('sha256')
    for (const chunk of chunks()) expectedHash.update(chunk)
    const script = harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf', 'content-length': String(totalBytes) },
      chunks
    })
    const result = await harness.invoke('knote:agent-download', baseRequest('download-over-30-mib', 'over-30-mib.pdf'))
    assert.equal(result.ok, true)
    assert.equal(result.bytes, totalBytes)
    assert.equal(result.maxBytes, null)
    assert.equal(result.sha256, expectedHash.digest('hex'))
    assert.equal((await fs.promises.stat(path.join(harness.workspace, 'over-30-mib.pdf'))).size, totalBytes)
    assert.ok(script.maxBufferedBytes <= chunkBytes * 2, `network buffer grew to ${script.maxBufferedBytes} bytes`)
    assert.deepEqual(await harness.quarantineFiles(), [])
  })

  await t.test('streams an unknown Content-Length response to a verified destination', async () => {
    const chunks = [Buffer.from('%PDF-1.7\n'), Buffer.alloc(32 * 1024, 0x62), Buffer.from('\nEOF')]
    const expected = Buffer.concat(chunks)
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf' },
      chunks
    })
    const result = await harness.invoke('knote:agent-download', baseRequest('download-unknown-length', 'unknown-length.pdf'))
    assert.equal(result.ok, true)
    assert.equal(result.bytes, expected.length)
    assert.equal(result.sha256, crypto.createHash('sha256').update(expected).digest('hex'))
    assert.deepEqual(await fs.promises.readFile(path.join(harness.workspace, 'unknown-length.pdf')), expected)
    assert.deepEqual(await harness.quarantineFiles(), [])
  })

  await t.test('reserves one canonical target before DNS while allowing different targets to overlap', async () => {
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const firstBody = Buffer.from('%PDF-1.7\nfirst reservation\n')
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf' },
      run: async (response) => {
        response.write(firstBody)
        firstStarted.resolve()
        await releaseFirst.promise
        if (!response.destroyed) response.end()
      }
    })
    const first = harness.invoke('knote:agent-download', baseRequest('download-reserved-first', 'reserved.pdf'))
    await firstStarted.promise
    const requestsBeforeConflict = harness.requests.length
    const dnsBeforeConflict = harness.resolvedHosts.length
    const conflict = await harness.invoke('knote:agent-download', {
      ...baseRequest('download-reserved-second', 'reserved.pdf'),
      url: 'https://other.example/never-requested.pdf'
    })
    assert.equal(conflict.code, 'DOWNLOAD_DESTINATION_BUSY')
    assert.equal(harness.requests.length, requestsBeforeConflict)
    assert.equal(harness.resolvedHosts.length, dnsBeforeConflict)
    releaseFirst.resolve()
    assert.equal((await first).ok, true)

    const overlapRelease = deferred()
    const overlapStarted = [deferred(), deferred()]
    const overlapBodies = [
      Buffer.from('%PDF-1.7\noverlap one\n'),
      Buffer.from('%PDF-1.7\noverlap two\n')
    ]
    for (let index = 0; index < 2; index += 1) {
      harness.enqueue({
        type: 'response',
        headers: { 'content-type': 'application/pdf' },
        run: async (response) => {
          response.write(overlapBodies[index])
          overlapStarted[index].resolve()
          await overlapRelease.promise
          if (!response.destroyed) response.end()
        }
      })
    }
    const beforeOverlap = harness.requests.length
    const overlapOne = harness.invoke('knote:agent-download', baseRequest('download-overlap-one', 'overlap-one.pdf'))
    const overlapTwo = harness.invoke('knote:agent-download', baseRequest('download-overlap-two', 'overlap-two.pdf'))
    await Promise.all(overlapStarted.map((entry) => entry.promise))
    assert.equal(harness.requests.length, beforeOverlap + 2)
    assert.equal(await fs.promises.stat(path.join(harness.workspace, 'overlap-one.pdf')).then(() => true, () => false), false)
    assert.equal(await fs.promises.stat(path.join(harness.workspace, 'overlap-two.pdf')).then(() => true, () => false), false)
    overlapRelease.resolve()
    const overlapResults = await Promise.all([overlapOne, overlapTwo])
    assert.deepEqual(overlapResults.map((result) => result.ok), [true, true])
    const overlapWritten = await Promise.all([
      fs.promises.readFile(path.join(harness.workspace, 'overlap-one.pdf')),
      fs.promises.readFile(path.join(harness.workspace, 'overlap-two.pdf'))
    ])
    assert.deepEqual(overlapWritten.map((body) => body.toString('hex')).sort(), overlapBodies.map((body) => body.toString('hex')).sort())
    assert.deepEqual(await harness.quarantineFiles(), [])
  })

  await t.test('parent replacement before write emits zero payload bytes and cleans the exact created path', async (t) => {
    const parent = path.join(harness.workspace, 'race-parent')
    const displacedParent = path.join(harness.workspace, 'race-parent-original')
    const outside = path.join(path.dirname(harness.workspace), 'race-outside')
    const target = path.join(parent, 'raced.pdf')
    const outsideTarget = path.join(outside, 'raced.pdf')
    const probe = path.join(harness.workspace, 'junction-probe')
    await fs.promises.mkdir(parent)
    await fs.promises.mkdir(outside)
    try {
      await fs.promises.symlink(outside, probe, process.platform === 'win32' ? 'junction' : 'dir')
      await fs.promises.rm(probe, { force: true })
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('junction creation is unavailable')
      throw error
    }

    const body = Buffer.from('%PDF-1.7\nraced payload must not be written\n')
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf', 'content-length': String(body.length) },
      chunks: [body]
    })
    const originalOpen = fs.promises.open
    let payloadWriteCalls = 0
    let replaced = false
    fs.promises.open = async (...args) => {
      const [candidate, flags] = args
      if (
        !replaced &&
        path.resolve(path.dirname(String(candidate))) === path.resolve(parent) &&
        /^\.knote-download-[a-f0-9]{48}\.part$/.test(path.basename(String(candidate))) &&
        flags === 'wx+'
      ) {
        replaced = true
        await fs.promises.rename(parent, displacedParent)
        await fs.promises.symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
        const handle = await originalOpen(...args)
        return new Proxy(handle, {
          get (opened, property) {
            if (property === 'write') {
              return (...writeArgs) => {
                payloadWriteCalls += 1
                return opened.write(...writeArgs)
              }
            }
            const value = Reflect.get(opened, property, opened)
            return typeof value === 'function' ? value.bind(opened) : value
          }
        })
      }
      return originalOpen(...args)
    }
    let result
    try {
      result = await harness.invoke('knote:agent-download', baseRequest('download-parent-race', 'race-parent/raced.pdf'))
    } finally {
      fs.promises.open = originalOpen
    }

    assert.equal(result.ok, false)
    assert.equal(result.code, 'DOWNLOAD_DESTINATION_CHANGED')
    assert.equal(replaced, true)
    assert.equal(payloadWriteCalls, 0)
    assert.equal(await fs.promises.stat(target).then(() => true, () => false), false)
    assert.equal(await fs.promises.stat(outsideTarget).then(() => true, () => false), false)
    assert.deepEqual(await fs.promises.readdir(displacedParent), [])
  })

  await t.test('discards a completed body when the final hostname detectably rebinds to private DNS', async () => {
    const body = Buffer.from('%PDF-1.7\nbody received before rebinding check\n')
    const target = path.join(harness.workspace, 'rebound.pdf')
    const before = harness.requests.length
    harness.enqueueResolution({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] })
    harness.enqueueResolution({ endpoints: [{ address: '10.0.0.9', family: 'ipv4' }] })
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf', 'content-length': String(body.length) },
      chunks: [body]
    })
    const result = await harness.invoke('knote:agent-download', baseRequest('download-dns-rebind', 'rebound.pdf'))
    assert.equal(result.ok, false)
    assert.equal(result.code, 'ERR_NON_PUBLIC_ADDRESS')
    assert.equal(harness.requests.length, before + 1)
    assert.equal(harness.requests.at(-1).response.readableEnded, true)
    assert.deepEqual(harness.resolvedHosts.slice(-2), ['public.example', 'public.example'])
    assert.equal(harness.queuedResolutions(), 0)
    assert.equal(await fs.promises.stat(target).then(() => true, () => false), false)
    assert.deepEqual(await harness.quarantineFiles(), [])
  })

  await t.test('requires a second exact approval for a cross-origin redirect before body read or write', async () => {
    const body = Buffer.from('%PDF-1.7\ntrusted bytes\n')
    const target = path.join(harness.workspace, 'downloads', 'report.pdf')
    const before = harness.requests.length
    harness.enqueue({ type: 'redirect', location: 'https://cdn.example/final.pdf' })
    harness.enqueue({
      type: 'response',
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="final.pdf"',
        'content-length': String(body.length)
      },
      chunks: [body]
    })
    const approval = await harness.invoke('knote:agent-download', baseRequest('download-redirect', 'downloads\\report.pdf'))
    assert.deepEqual(approval, {
      ok: false,
      id: 'download-redirect',
      code: 'DOWNLOAD_REDIRECT_APPROVAL_REQUIRED',
      error: 'cross-origin download redirect requires another explicit approval',
      redirect_url: 'https://cdn.example/final.pdf',
      resume_id: approval.resume_id,
      committed_bytes: 0,
      known_total: null,
      origin: 'https://public.example',
      path: 'downloads/report.pdf'
    })
    assert.match(approval.resume_id, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(harness.requests.length, before + 1)
    assert.equal(harness.queuedResponses(), 1)
    assert.equal(await fs.promises.stat(target).then(() => true, () => false), false)
    assert.deepEqual(await harness.quarantineFiles(), [`${approval.resume_id}.part`], 'approval retains only the opaque private part without plaintext metadata')

    const result = await harness.invoke('knote:agent-download', {
      ...baseRequest('download-ok', 'downloads\\report.pdf'),
      url: approval.redirect_url,
      resumeId: approval.resume_id
    })
    assert.deepEqual(result, {
      ok: true,
      id: 'download-ok',
      relativePath: 'downloads/report.pdf',
      name: 'report.pdf',
      finalUrl: 'https://cdn.example/final.pdf',
      url: 'https://cdn.example/final.pdf',
      contentType: 'application/pdf',
      bytes: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      maxBytes: null,
      cleanupComplete: true,
      internetZone: process.platform === 'win32' ? 'marked' : 'not_applicable',
      publication: 'atomic_hard_link_no_replace',
      verificationSource: 'streamed_quarantine_atomic_publish_readback_motw'
    })
    assert.deepEqual(await fs.promises.readFile(target), body)
    assert.deepEqual(harness.resolvedHosts.slice(-4), ['public.example', 'cdn.example', 'cdn.example', 'cdn.example'])
    assert.equal(harness.requests.at(-1).options.redirect, 'manual')
    assert.equal(harness.requests.at(-1).options.bypassCustomProtocolHandlers, true)
  })

  await t.test('same-origin redirects continue under the displayed URL approval', async () => {
    const body = Buffer.from('%PDF-1.7\nsame origin\n')
    harness.enqueue({ type: 'redirect', location: '/files/final.pdf' })
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf', 'content-length': String(body.length) },
      chunks: [body]
    })
    const result = await harness.invoke('knote:agent-download', {
      ...baseRequest('download-same-origin', 'same-origin.pdf'),
      url: 'https://public.example/files/source.pdf'
    })
    assert.equal(result.ok, true)
    assert.equal(result.finalUrl, 'https://public.example/files/final.pdf')
    assert.deepEqual(await fs.promises.readFile(path.join(harness.workspace, 'same-origin.pdf')), body)
  })

  await t.test('rejects an HTTPS-to-HTTP redirect after public validation and before a second request', async () => {
    const before = harness.requests.length
    harness.enqueue({ type: 'redirect', location: 'http://cdn.example/final.pdf' })
    const result = await harness.invoke('knote:agent-download', baseRequest('download-downgrade', 'downgrade.pdf'))
    assert.equal(result.ok, false)
    assert.equal(result.code, 'ERR_HTTPS_DOWNGRADE')
    assert.equal(result.redirect_url, undefined)
    assert.equal(harness.requests.length, before + 1)
    assert.equal(await fs.promises.stat(path.join(harness.workspace, 'downgrade.pdf')).then(() => true, () => false), false)
  })

  await t.test('rejects mapped-IPv6 redirect aliases before a second request', async () => {
    const before = harness.requests.length
    harness.enqueue({ type: 'redirect', location: 'http://[::ffff:7f00:1]/private.pdf' })
    const result = await harness.invoke('knote:agent-download', baseRequest('download-mapped', 'mapped.pdf'))
    assert.equal(result.ok, false)
    assert.equal(result.code, 'ERR_NON_PUBLIC_ADDRESS')
    assert.equal(harness.requests.length, before + 1)
    assert.equal(await fs.promises.stat(path.join(harness.workspace, 'mapped.pdf')).then(() => true, () => false), false)
  })

  await t.test('never overwrites an existing destination', async () => {
    const target = path.join(harness.workspace, 'existing.pdf')
    await fs.promises.writeFile(target, 'original')
    const before = harness.requests.length
    const result = await harness.invoke('knote:agent-download', baseRequest('download-exists', 'existing.pdf'))
    assert.equal(result.code, 'FILE_EXISTS')
    assert.equal(await fs.promises.readFile(target, 'utf8'), 'original')
    assert.equal(harness.requests.length, before)
  })

  await t.test('recovers an app-owned crash staging link before authorizing the next target', async () => {
    const target = path.join(harness.workspace, 'recovered-after-crash.pdf')
    const staleStage = path.join(harness.workspace, `.knote-download-${'b'.repeat(48)}.part`)
    await fs.promises.writeFile(target, '%PDF-1.7\ncomplete before crash\n')
    await fs.promises.link(target, staleStage)
    if (process.platform === 'win32') {
      await fs.promises.writeFile(`${staleStage}:Knote.DownloadStage`, 'KnoteDownloadStage/1\r\n')
    }
    assert.equal((await fs.promises.stat(target)).nlink, 2)
    const before = harness.requests.length
    const result = await harness.invoke('knote:agent-download', baseRequest('download-stale-stage-recovery', 'recovered-after-crash.pdf'))
    assert.equal(result.code, process.platform === 'win32' ? 'FILE_EXISTS' : 'DOWNLOAD_FAILED')
    assert.equal(harness.requests.length, before)
    if (process.platform === 'win32') {
      assert.equal(await fs.promises.stat(staleStage).then(() => true, () => false), false)
      assert.equal((await fs.promises.stat(target)).nlink, 1)
      await assert.rejects(fs.promises.readFile(`${target}:Knote.DownloadStage`), (error) => error?.code === 'ENOENT')
    } else {
      await fs.promises.unlink(staleStage)
    }
  })

  await t.test('stale recovery ignores an unmarked user file in the reserved-looking namespace', async () => {
    const decoy = path.join(harness.workspace, `.knote-download-${'c'.repeat(48)}.part`)
    const target = path.join(harness.workspace, 'unmarked-stage-decoy.pdf')
    const body = Buffer.from('%PDF-1.7\nunmarked decoy remains\n')
    await fs.promises.writeFile(decoy, 'user-owned decoy')
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf', 'content-length': String(body.length) },
      chunks: [body]
    })
    const result = await harness.invoke('knote:agent-download', baseRequest('download-unmarked-stage-decoy', 'unmarked-stage-decoy.pdf'))
    assert.equal(result.ok, true)
    assert.equal(await fs.promises.readFile(decoy, 'utf8'), 'user-owned decoy')
    assert.deepEqual(await fs.promises.readFile(target), body)
    await fs.promises.unlink(decoy)
  })

  await t.test('keeps the final pathname absent until the complete staged file is verified', async () => {
    const target = path.join(harness.workspace, 'atomic-visible.pdf')
    const body = Buffer.from('%PDF-1.7\nfinal pathname must stay absent\n')
    const stagingWriteStarted = deferred()
    const releaseStagingWrite = deferred()
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf', 'content-length': String(body.length) },
      chunks: [body]
    })
    const originalOpen = fs.promises.open
    fs.promises.open = async (candidate, flags, ...rest) => {
      const handle = await originalOpen(candidate, flags, ...rest)
      if (
        path.resolve(path.dirname(String(candidate))) === path.resolve(harness.workspace) &&
        /^\.knote-download-[a-f0-9]{48}\.part$/.test(path.basename(String(candidate))) &&
        flags === 'wx+'
      ) {
        return new Proxy(handle, {
          get (opened, property) {
            if (property === 'write') {
              return async (...writeArgs) => {
                stagingWriteStarted.resolve()
                await releaseStagingWrite.promise
                return opened.write(...writeArgs)
              }
            }
            const value = Reflect.get(opened, property, opened)
            return typeof value === 'function' ? value.bind(opened) : value
          }
        })
      }
      return handle
    }
    let result
    let peerResult
    try {
      const pending = harness.invoke('knote:agent-download', baseRequest('download-atomic-visible', 'atomic-visible.pdf'))
      await stagingWriteStarted.promise
      assert.equal(await fs.promises.stat(target).then(() => true, () => false), false)
      const peerBody = Buffer.from('%PDF-1.7\npeer must not sweep active staging\n')
      harness.enqueue({
        type: 'response',
        headers: { 'content-type': 'application/pdf', 'content-length': String(peerBody.length) },
        chunks: [peerBody]
      })
      const peer = harness.invoke('knote:agent-download', baseRequest('download-active-stage-peer', 'active-stage-peer.pdf'))
      releaseStagingWrite.resolve()
      const settled = await Promise.all([pending, peer])
      result = settled[0]
      peerResult = settled[1]
    } finally {
      releaseStagingWrite.resolve()
      fs.promises.open = originalOpen
    }
    assert.equal(result.ok, true)
    assert.equal(peerResult.ok, true)
    assert.deepEqual(await fs.promises.readFile(target), body)
  })

  await t.test('an external create after networking wins without being overwritten', async () => {
    const target = path.join(harness.workspace, 'publication-race.pdf')
    const body = Buffer.from('%PDF-1.7\npublication race\n')
    const responseStarted = deferred()
    const finishResponse = deferred()
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf' },
      run: async (response) => {
        response.write(body)
        responseStarted.resolve()
        await finishResponse.promise
        if (!response.destroyed) response.end()
      }
    })
    const pending = harness.invoke('knote:agent-download', baseRequest('download-publication-race', 'publication-race.pdf'))
    await responseStarted.promise
    await fs.promises.writeFile(target, 'external winner', { flag: 'wx' })
    finishResponse.resolve()
    const result = await pending
    assert.equal(result.code, 'FILE_EXISTS')
    assert.equal(await fs.promises.readFile(target, 'utf8'), 'external winner')
    assert.deepEqual(await harness.quarantineFiles(), [])
  })

  await t.test('returns explicit sanitized filesystem error codes and removes quarantine parts', async () => {
    const originalOpen = fs.promises.open
    try {
      for (const code of ['ENOSPC', 'EDQUOT', 'EFBIG', 'EACCES', 'EPERM', 'EROFS', 'EIO']) {
        const relativePath = `filesystem-${code.toLowerCase()}.pdf`
        const target = path.join(harness.workspace, relativePath)
        const body = Buffer.from(`%PDF-1.7\n${code}\n`)
        harness.enqueue({
          type: 'response',
          headers: { 'content-type': 'application/pdf', 'content-length': String(body.length) },
          chunks: [body]
        })
        fs.promises.open = async (candidate, flags, ...rest) => {
          if (
            path.resolve(path.dirname(String(candidate))) === path.resolve(path.dirname(target)) &&
            /^\.knote-download-[a-f0-9]{48}\.part$/.test(path.basename(String(candidate))) &&
            flags === 'wx+'
          ) {
            const error = new Error(`sensitive path must not escape: ${target}`)
            error.code = code
            throw error
          }
          return originalOpen(candidate, flags, ...rest)
        }
        const result = await harness.invoke('knote:agent-download', baseRequest(`download-fs-${code.toLowerCase()}`, relativePath))
        assert.equal(result.code, code)
        assert.doesNotMatch(result.error, /sensitive path|knote-web-broker/i)
        assert.equal(await fs.promises.stat(target).then(() => true, () => false), false)
        assert.deepEqual(await harness.quarantineFiles(), [])
      }
    } finally {
      fs.promises.open = originalOpen
    }
  })

  await t.test('does not expose absolute paths from unexpected filesystem errors', async () => {
    const target = path.join(harness.workspace, 'sanitized-unknown.pdf')
    const body = Buffer.from('%PDF-1.7\nunknown filesystem failure\n')
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf', 'content-length': String(body.length) },
      chunks: [body]
    })
    const originalOpen = fs.promises.open
    fs.promises.open = async (candidate, flags, ...rest) => {
      if (
        path.resolve(path.dirname(String(candidate))) === path.resolve(harness.workspace) &&
        /^\.knote-download-[a-f0-9]{48}\.part$/.test(path.basename(String(candidate))) &&
        flags === 'wx+'
      ) {
        const error = new Error(`sensitive local path: ${target}`)
        error.code = 'EINVAL'
        throw error
      }
      return originalOpen(candidate, flags, ...rest)
    }
    let result
    try {
      result = await harness.invoke('knote:agent-download', baseRequest('download-sanitized-unknown', 'sanitized-unknown.pdf'))
    } finally {
      fs.promises.open = originalOpen
    }
    assert.deepEqual({ code: result.code, error: result.error }, {
      code: 'DOWNLOAD_FAILED',
      error: 'download failed'
    })
    assert.doesNotMatch(JSON.stringify(result), /sensitive local path|knote-web-broker/i)
    assert.deepEqual(await harness.quarantineFiles(), [])
  })

  await t.test('reports committed success with a cleanup warning instead of an inconsistent failure', async () => {
    const target = path.join(harness.workspace, 'cleanup-warning.pdf')
    const body = Buffer.from('%PDF-1.7\ncommitted cleanup warning\n')
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf', 'content-length': String(body.length) },
      chunks: [body]
    })
    const quarantineRoot = path.resolve(harness.userData, 'agent-download-quarantine', 'v2')
    const originalUnlink = fs.promises.unlink
    fs.promises.unlink = async (candidate, ...rest) => {
      if (
        path.resolve(path.dirname(String(candidate))) === quarantineRoot &&
        /^[A-Za-z0-9_-]{43}\.part$/.test(path.basename(String(candidate)))
      ) {
        const error = new Error('simulated quarantine lock')
        error.code = 'EBUSY'
        throw error
      }
      return originalUnlink(candidate, ...rest)
    }
    let result
    try {
      result = await harness.invoke('knote:agent-download', baseRequest('download-cleanup-warning', 'cleanup-warning.pdf'))
    } finally {
      fs.promises.unlink = originalUnlink
    }
    assert.equal(result.ok, true)
    assert.equal(result.cleanupComplete, false)
    assert.deepEqual(await fs.promises.readFile(target), body)
    for (const name of await harness.quarantineFiles()) {
      await fs.promises.unlink(path.join(quarantineRoot, name))
    }
  })

  await t.test('never reports success while a publication staging hard link remains', async () => {
    const target = path.join(harness.workspace, 'staging-recovery-required.pdf')
    const body = Buffer.from('%PDF-1.7\nstaging recovery required\n')
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf', 'content-length': String(body.length) },
      chunks: [body]
    })
    const isPublicationStage = (candidate) => (
      path.resolve(path.dirname(String(candidate))) === path.resolve(harness.workspace) &&
      /^\.knote-download-[a-f0-9]{48}\.part$/.test(path.basename(String(candidate)))
    )
    const quarantineRoot = path.resolve(harness.userData, 'agent-download-quarantine', 'v2')
    const isPrivatePart = (candidate) => (
      path.resolve(path.dirname(String(candidate))) === quarantineRoot &&
      /^[A-Za-z0-9_-]{43}\.part$/.test(path.basename(String(candidate)))
    )
    const originalUnlinkSync = fs.unlinkSync
    const originalUnlink = fs.promises.unlink
    fs.unlinkSync = (candidate, ...rest) => {
      if (isPublicationStage(candidate) || isPrivatePart(candidate)) {
        const error = new Error('simulated staging lock')
        error.code = 'EBUSY'
        throw error
      }
      return originalUnlinkSync(candidate, ...rest)
    }
    fs.promises.unlink = async (candidate, ...rest) => {
      if (isPublicationStage(candidate) || isPrivatePart(candidate)) {
        const error = new Error('simulated staging lock')
        error.code = 'EBUSY'
        throw error
      }
      return originalUnlink(candidate, ...rest)
    }
    let result
    try {
      result = await harness.invoke('knote:agent-download', baseRequest('download-staging-recovery-required', 'staging-recovery-required.pdf'))
    } finally {
      fs.unlinkSync = originalUnlinkSync
      fs.promises.unlink = originalUnlink
    }
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DOWNLOAD_PUBLICATION_RECOVERY_REQUIRED')
    assert.equal(result.cleanup_incomplete, true)
    assert.deepEqual(await fs.promises.readFile(target), body)
    assert.equal((await fs.promises.stat(target)).nlink, 2)
    for (const name of await harness.quarantineFiles()) {
      await fs.promises.unlink(path.join(quarantineRoot, name))
    }

    const before = harness.requests.length
    const recovered = await harness.invoke('knote:agent-download', baseRequest('download-staging-recovered', 'staging-recovery-required.pdf'))
    assert.equal(recovered.code, 'FILE_EXISTS')
    assert.equal(harness.requests.length, before)
    assert.equal((await fs.promises.stat(target)).nlink, 1)
  })

  await t.test('rejects dangerous target extensions, MIME, and payload signatures', async () => {
    const requestsBeforeNames = harness.requests.length
    for (const [index, unsafeName] of ['tool.exe', 'invoice.pdf;run.cmd', 'invoice.pdf#run.ps1'].entries()) {
      const rejected = await harness.invoke('knote:agent-download', baseRequest(`download-extension-${index}`, unsafeName))
      assert.equal(rejected.code, 'UNSAFE_DOWNLOAD_EXTENSION')
    }
    const internalName = `.knote-download-${'d'.repeat(48)}.part`
    const internal = await harness.invoke('knote:agent-download', baseRequest('download-internal-stage-name', internalName))
    assert.equal(internal.code, 'INVALID_DOWNLOAD_PATH')
    assert.equal(harness.requests.length, requestsBeforeNames)

    let result = await harness.invoke('knote:agent-download', {
      ...baseRequest('download-url-extension', 'safe-url-name.pdf'),
      url: 'https://public.example/invoice.pdf%3Brun.cmd'
    })
    assert.equal(result.code, 'UNSAFE_DOWNLOAD_EXTENSION')
    assert.equal(harness.requests.length, requestsBeforeNames)

    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/x-msdownload', 'content-length': '4' },
      chunks: ['safe']
    })
    result = await harness.invoke('knote:agent-download', baseRequest('download-mime', 'mime.pdf'))
    assert.equal(result.code, 'UNSAFE_DOWNLOAD_MIME')
    assert.equal(await fs.promises.stat(path.join(harness.workspace, 'mime.pdf')).then(() => true, () => false), false)

    let dangerousTailSent = false
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'text/plain' },
      run: async (response) => {
        response.write('MZ')
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (!response.destroyed) {
          dangerousTailSent = true
          response.end(Buffer.alloc(1024 * 1024, 0x61))
        }
      }
    })
    result = await harness.invoke('knote:agent-download', baseRequest('download-signature', 'signature.pdf'))
    assert.equal(result.code, 'UNSAFE_DOWNLOAD_PAYLOAD')
    assert.equal(dangerousTailSent, false, 'known executable prefix did not stop the response immediately')
    assert.equal(await fs.promises.stat(path.join(harness.workspace, 'signature.pdf')).then(() => true, () => false), false)
    assert.deepEqual(await harness.quarantineFiles(), [])
  })

  await t.test('enforces caller-selected limits and rejects truncated bodies without partial files', async () => {
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf', 'content-length': '5' },
      chunks: ['12345']
    })
    let result = await harness.invoke('knote:agent-download', baseRequest('download-large', 'large.pdf', 4))
    assert.equal(result.code, 'DOWNLOAD_TOO_LARGE')
    assert.equal(await fs.promises.stat(path.join(harness.workspace, 'large.pdf')).then(() => true, () => false), false)

    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf' },
      chunks: ['123', '45']
    })
    result = await harness.invoke('knote:agent-download', baseRequest('download-chunk-large', 'chunk-large.pdf', 4))
    assert.equal(result.code, 'DOWNLOAD_TOO_LARGE')
    assert.equal(await fs.promises.stat(path.join(harness.workspace, 'chunk-large.pdf')).then(() => true, () => false), false)

    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf', 'content-length': '10' },
      chunks: ['short']
    })
    result = await harness.invoke('knote:agent-download', baseRequest('download-partial', 'partial.pdf', 20))
    assert.equal(result.code, 'DOWNLOAD_INCOMPLETE')
    assert.equal(await fs.promises.stat(path.join(harness.workspace, 'partial.pdf')).then(() => true, () => false), false)
    assert.deepEqual(await harness.quarantineFiles(), [])
  })

  await t.test('cancel endpoint aborts the active Electron request', async () => {
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf' },
      chunks: ['waiting'],
      end: false
    })
    const before = harness.requests.length
    const pending = harness.invoke('knote:agent-download', baseRequest('download-cancel', 'cancelled.pdf'))
    while (harness.requests.length === before || !harness.requests.at(-1)?.response) await immediate()
    assert.equal(await harness.invoke('knote:agent-download-cancel', { id: 'download-cancel' }), true)
    const result = await pending
    assert.equal(result.code, 'DOWNLOAD_CANCELLED')
    assert.equal(harness.requests.at(-1).aborted, true)
    assert.equal(await fs.promises.stat(path.join(harness.workspace, 'cancelled.pdf')).then(() => true, () => false), false)
    assert.deepEqual(await harness.quarantineFiles(), [])
  })

  await t.test('cancellation during final handle close cannot cross the publication commit point', async () => {
    const target = path.join(harness.workspace, 'cancel-before-link.pdf')
    const body = Buffer.from('%PDF-1.7\ncancel before link\n')
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf', 'content-length': String(body.length) },
      chunks: [body]
    })
    const originalOpen = fs.promises.open
    let cancelledAtClose = false
    fs.promises.open = async (candidate, flags, ...rest) => {
      const handle = await originalOpen(candidate, flags, ...rest)
      if (
        path.resolve(path.dirname(String(candidate))) === path.resolve(harness.workspace) &&
        /^\.knote-download-[a-f0-9]{48}\.part$/.test(path.basename(String(candidate))) &&
        flags === 'wx+'
      ) {
        return new Proxy(handle, {
          get (opened, property) {
            if (property === 'close') {
              return async () => {
                if (!cancelledAtClose) {
                  cancelledAtClose = true
                  harness.sender.emit('render-process-gone', {}, { reason: 'crashed' })
                }
                return opened.close()
              }
            }
            const value = Reflect.get(opened, property, opened)
            return typeof value === 'function' ? value.bind(opened) : value
          }
        })
      }
      return handle
    }
    let result
    try {
      result = await harness.invoke('knote:agent-download', baseRequest('download-cancel-before-link', 'cancel-before-link.pdf'))
    } finally {
      fs.promises.open = originalOpen
    }
    assert.equal(cancelledAtClose, true)
    assert.equal(result.code, 'DOWNLOAD_CANCELLED')
    assert.equal(await fs.promises.stat(target).then(() => true, () => false), false)
    assert.deepEqual(await harness.quarantineFiles(), [])
  })

  await t.test('renderer crashes revoke ownership and cancel an active download', async () => {
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'application/pdf' },
      chunks: ['waiting'],
      end: false
    })
    const before = harness.requests.length
    const pending = harness.invoke('knote:agent-download', baseRequest('download-renderer-gone', 'renderer-gone.pdf'))
    while (harness.requests.length === before || !harness.requests.at(-1)?.response) await immediate()
    harness.sender.emit('render-process-gone', {}, { reason: 'crashed' })
    const result = await pending
    assert.equal(result.code, 'DOWNLOAD_CANCELLED')
    assert.equal(harness.requests.at(-1).aborted, true)
    assert.equal(await fs.promises.stat(path.join(harness.workspace, 'renderer-gone.pdf')).then(() => true, () => false), false)
    assert.deepEqual(await harness.quarantineFiles(), [])
  })

  await t.test('rejects forged senders and folder grants before networking', async () => {
    const forgedSender = new EventEmitter()
    const unavailable = await harness.invoke(
      'knote:agent-download',
      baseRequest('download-sender', 'sender.pdf'),
      forgedSender
    )
    assert.equal(unavailable.code, 'BROKER_UNAVAILABLE')
    const invalidGrant = await harness.invoke('knote:agent-download', {
      ...baseRequest('download-grant', 'grant.pdf'),
      workspaceGrantId: 'folder-forged'
    })
    assert.equal(invalidGrant.code, 'INVALID_WORKSPACE_GRANT')
    const forgedStatus = await harness.invoke('knote:agent-download-status', {
      resumeId: 'r'.repeat(43),
      workspaceGrantId: harness.grantId
    }, forgedSender)
    assert.equal(forgedStatus.code, 'BROKER_UNAVAILABLE')
    const invalidList = await harness.invoke('knote:agent-download-list-available', {
      workspaceGrantId: 'folder-forged'
    })
    assert.equal(invalidList.code, 'INVALID_WORKSPACE_GRANT')
    const invalidStatusSchema = await harness.invoke('knote:agent-download-status', {
      resumeId: 'r'.repeat(43),
      workspaceGrantId: harness.grantId,
      metadataPath: 'must-not-be-accepted'
    })
    assert.equal(invalidStatusSchema.code, 'INVALID_DOWNLOAD_REQUEST')
    assert.equal(harness.queuedResponses(), 0)
  })

  await t.test('web fetch uses the same redirect policy and reports final response metadata', async () => {
    const before = harness.requests.length
    harness.enqueue({ type: 'redirect', location: 'http://[::ffff:127.0.0.1]/admin' })
    const blocked = await harness.invoke('knote:web-fetch', {
      id: 'web-fetch-blocked',
      url: 'https://public.example/page',
      max: 12000
    })
    assert.equal(blocked.error, 'blocked_host')
    assert.equal(harness.requests.length, before + 1)

    harness.enqueue({ type: 'redirect', location: 'http://other.example/public' })
    const downgraded = await harness.invoke('knote:web-fetch', {
      id: 'web-fetch-downgrade',
      url: 'https://public.example/page',
      max: 12000
    })
    assert.equal(downgraded.ok, false)
    assert.equal(downgraded.error, 'blocked_redirect')
    assert.equal(harness.requests.length, before + 2)

    const html = Buffer.from('<html><body><main>Public text</main></body></html>')
    harness.enqueue({ type: 'redirect', location: 'https://reader.example/article' })
    harness.enqueue({
      type: 'response',
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': String(html.length) },
      chunks: [html]
    })
    const fetched = await harness.invoke('knote:web-fetch', {
      id: 'web-fetch-ok',
      url: 'https://public.example/page',
      max: 12000
    })
    assert.equal(fetched.ok, true)
    assert.equal(fetched.finalUrl, 'https://reader.example/article')
    assert.equal(fetched.contentType, 'text/html; charset=utf-8')
    assert.equal(fetched.bytes, html.length)
    assert.match(fetched.text, /Public text/)
  })

  await t.test('web search uses the same per-hop public URL policy', async () => {
    const before = harness.requests.length
    harness.enqueue({ type: 'redirect', location: 'http://[::ffff:10.0.0.1]/search' })
    const blocked = await harness.invoke('knote:web-search', {
      id: 'web-search-blocked',
      query: 'policy test',
      max: 4,
      engine: 'bing',
      region: 'auto'
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error, 'blocked_host')
    assert.equal(harness.requests.length, before + 1)
  })
})

test('download Range and If-Range resume protocol is strict and restart-safe', async (t) => {
  await t.test('strong ETag resumes across a new main process using the same encrypted userData', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'knote-download-restart-'))
    const safeStorageKey = crypto.randomBytes(32)
    let first
    let second
    try {
      first = await createHarness({ root, safeStorageAvailable: true, safeStorageKey })
      const paused = await pauseStableDownload(first, {
        id: 'etag-restart-pause',
        relativePath: 'etag-restart.pdf',
        prefix: '%PDF-',
        total: 12,
        etag: '"etag-restart-v1"',
        url: 'https://public.example/source.pdf?signature=restart-secret'
      })
      assert.equal(paused.result.code, 'DOWNLOAD_PAUSED')
      assert.equal(paused.result.committed_bytes, 5)
      assert.equal(paused.result.known_total, 12)
      assert.match(paused.result.resume_id, /^[A-Za-z0-9_-]{43}$/)
      assert.equal(first.requests.at(-1).headers['accept-encoding'], 'identity')
      assert.equal(first.requests.at(-1).headers['cache-control'], 'no-cache')
      await first.restore()
      first = null

      second = await createHarness({ root, safeStorageAvailable: true, safeStorageKey })
      const tail = Buffer.from('1.7\nEOF')
      second.enqueue({
        type: 'response',
        statusCode: 206,
        headers: {
          'content-type': 'application/pdf',
          'content-range': 'bytes 5-11/12',
          'content-length': String(tail.length),
          etag: '"etag-restart-v1"'
        },
        chunks: [tail]
      })
      const resumed = await second.invoke('knote:agent-download', agentDownloadRequest(
        second,
        'etag-restart-resume',
        'etag-restart.pdf',
        {
          url: 'https://public.example/source.pdf?signature=restart-secret',
          resumeId: paused.result.resume_id
        }
      ))
      assert.equal(resumed.ok, true)
      assert.deepEqual(await fs.promises.readFile(path.join(second.workspace, 'etag-restart.pdf')), Buffer.from('%PDF-1.7\nEOF'))
      assert.equal(second.requests.at(-1).headers.range, 'bytes=5-')
      assert.equal(second.requests.at(-1).headers['if-range'], '"etag-restart-v1"')
      assert.deepEqual(await second.quarantineFiles(), [])
    } finally {
      await first?.restore().catch(() => {})
      await second?.restore().catch(() => {})
      await fs.promises.rm(root, { recursive: true, force: true })
    }
  })

  await t.test('valid Last-Modified resumes, while weak or absent validators restart only from zero', async () => {
    const harness = await createHarness({ safeStorageAvailable: true })
    try {
      const modified = 'Wed, 12 Aug 2026 10:20:30 GMT'
      const paused = await pauseStableDownload(harness, {
        id: 'last-modified-pause',
        relativePath: 'last-modified.pdf',
        prefix: '%PDF',
        total: 8,
        validatorHeaders: { etag: 'W/"weak-is-not-enough"', 'last-modified': modified }
      })
      assert.equal(paused.result.code, 'DOWNLOAD_PAUSED')
      harness.enqueue({
        type: 'response',
        statusCode: 206,
        headers: {
          'content-type': 'application/pdf',
          'content-range': 'bytes 4-7/8',
          'content-length': '4',
          'last-modified': modified
        },
        chunks: ['tail']
      })
      const resumed = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'last-modified-resume', 'last-modified.pdf', {
        resumeId: paused.result.resume_id
      }))
      assert.equal(resumed.ok, true)
      assert.equal(harness.requests.at(-1).headers['if-range'], modified)

      for (const [index, validatorHeaders] of [{ etag: 'W/"weak-only"' }, {}].entries()) {
        const relativePath = `no-stable-validator-${index}.pdf`
        const failed = await pauseStableDownload(harness, {
          id: `no-stable-validator-${index}`,
          relativePath,
          prefix: '%PDF',
          total: 9,
          validatorHeaders
        })
        assert.equal(failed.result.code, 'DOWNLOAD_INCOMPLETE')
        assert.equal(failed.result.resume_id, undefined)
        harness.enqueue({
          type: 'response',
          headers: { 'content-type': 'application/pdf', 'content-length': '8' },
          chunks: ['%PDFfull']
        })
        const fresh = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, `fresh-no-validator-${index}`, relativePath))
        assert.equal(fresh.ok, true)
        assert.equal(harness.requests.at(-1).headers.range, undefined)
        assert.deepEqual(await fs.promises.readFile(path.join(harness.workspace, relativePath)), Buffer.from('%PDFfull'))
      }
    } finally { await harness.restore() }
  })

  await t.test('strict 206 rejects start, total, length, validator, syntax, multipart, encoding and 412 mismatches', async () => {
    const harness = await createHarness({ safeStorageAvailable: true })
    try {
      const cases = [
        { name: 'start', headers: { 'content-range': 'bytes 2-8/9', 'content-length': '7', etag: '"strict-v1"' } },
        { name: 'total', headers: { 'content-range': 'bytes 3-8/10', 'content-length': '6', etag: '"strict-v1"' } },
        { name: 'length', headers: { 'content-range': 'bytes 3-8/9', 'content-length': '5', etag: '"strict-v1"' } },
        { name: 'validator', headers: { 'content-range': 'bytes 3-8/9', 'content-length': '6', etag: '"strict-v2"' } },
        { name: 'syntax', headers: { 'content-range': 'bytes=3-8/9', 'content-length': '6', etag: '"strict-v1"' } },
        { name: 'multipart', headers: { 'content-type': 'multipart/byteranges; boundary=x', 'content-range': 'bytes 3-8/9', 'content-length': '6', etag: '"strict-v1"' } },
        { name: 'encoding', headers: { 'content-range': 'bytes 3-8/9', 'content-length': '6', 'content-encoding': 'gzip', etag: '"strict-v1"' } },
        { name: 'precondition', statusCode: 412, headers: { etag: '"strict-v1"' } }
      ]
      for (const [index, item] of cases.entries()) {
        const relativePath = `strict-${item.name}.pdf`
        const paused = await pauseStableDownload(harness, {
          id: `strict-pause-${index}`,
          relativePath,
          prefix: 'abc',
          total: 9,
          etag: '"strict-v1"'
        })
        assert.equal(paused.result.code, 'DOWNLOAD_PAUSED')
        harness.enqueue({
          type: 'response',
          statusCode: item.statusCode === undefined ? 206 : item.statusCode,
          headers: { 'content-type': 'application/pdf', ...item.headers },
          chunks: item.statusCode === 412 ? [] : ['defghi']
        })
        const result = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, `strict-resume-${index}`, relativePath, {
          resumeId: paused.result.resume_id
        }))
        assert.equal(result.code, 'DOWNLOAD_RANGE_MISMATCH', item.name)
        assert.equal(await fs.promises.stat(path.join(harness.workspace, relativePath)).then(() => true, () => false), false)
        const status = await harness.invoke('knote:agent-download-status', {
          resumeId: paused.result.resume_id,
          workspaceGrantId: harness.grantId
        })
        assert.equal(status.code, 'DOWNLOAD_RESUME_NOT_FOUND')
      }
      assert.deepEqual(await harness.quarantineFiles(), [])
    } finally { await harness.restore() }
  })

  await t.test('multiple strict 206 segments checkpoint and continue until total is complete', async () => {
    const harness = await createHarness({ safeStorageAvailable: true })
    try {
      const paused = await pauseStableDownload(harness, {
        id: 'segmented-pause',
        relativePath: 'segmented.pdf',
        prefix: 'abc',
        total: 10,
        etag: '"segmented-v1"'
      })
      const target = path.join(harness.workspace, 'segmented.pdf')
      harness.enqueue({
        type: 'response',
        statusCode: 206,
        headers: {
          'content-type': 'application/pdf',
          'content-range': 'bytes 3-5/10',
          'content-length': '3',
          etag: '"segmented-v1"'
        },
        chunks: ['def'],
        onResponse: () => assert.equal(fs.existsSync(target), false)
      })
      harness.enqueue({
        type: 'response',
        statusCode: 206,
        headers: {
          'content-type': 'application/pdf',
          'content-range': 'bytes 6-9/10',
          'content-length': '4',
          etag: '"segmented-v1"'
        },
        chunks: ['ghij']
      })
      const before = harness.requests.length
      const result = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'segmented-resume', 'segmented.pdf', {
        resumeId: paused.result.resume_id
      }))
      assert.equal(result.ok, true)
      assert.deepEqual(await fs.promises.readFile(target), Buffer.from('abcdefghij'))
      assert.deepEqual(harness.requests.slice(before).map((request) => request.headers.range), ['bytes=3-', 'bytes=6-'])
    } finally { await harness.restore() }
  })

  await t.test('a Range request receiving 200 truncates before body and treats it as a fresh representation', async () => {
    const harness = await createHarness({ safeStorageAvailable: true })
    try {
      const paused = await pauseStableDownload(harness, {
        id: 'range-200-pause',
        relativePath: 'range-200.pdf',
        prefix: '%PDF-old-prefix',
        total: 64,
        etag: '"old-representation"'
      })
      const replacement = Buffer.from('%PDF-new-complete')
      harness.enqueue({
        type: 'response',
        statusCode: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-length': String(replacement.length),
          etag: '"new-representation"'
        },
        chunks: [replacement]
      })
      const result = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'range-200-resume', 'range-200.pdf', {
        resumeId: paused.result.resume_id
      }))
      assert.equal(result.ok, true)
      assert.equal(harness.requests.at(-1).headers.range, `bytes=${paused.body.length}-`)
      assert.deepEqual(await fs.promises.readFile(path.join(harness.workspace, 'range-200.pdf')), replacement)
    } finally { await harness.restore() }
  })

  await t.test('416 publishes only an exact locally rehashed total with the same validator', async () => {
    const harness = await createHarness({ safeStorageAvailable: true })
    try {
      const completeLocal = await pauseStableDownload(harness, {
        id: 'range-416-valid-pause',
        relativePath: 'range-416-valid.pdf',
        prefix: '%PDF',
        total: 4,
        etag: '"range-416-v1"'
      })
      assert.equal(completeLocal.result.committed_bytes, 4)
      harness.enqueue({
        type: 'response',
        statusCode: 416,
        headers: { 'content-range': 'bytes */4', etag: '"range-416-v1"' },
        chunks: []
      })
      const valid = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'range-416-valid-resume', 'range-416-valid.pdf', {
        resumeId: completeLocal.result.resume_id
      }))
      assert.equal(valid.ok, true)
      assert.deepEqual(await fs.promises.readFile(path.join(harness.workspace, 'range-416-valid.pdf')), Buffer.from('%PDF'))

      for (const [index, headers] of [
        { 'content-range': 'bytes */5', etag: '"range-416-v1"' },
        { 'content-range': 'bytes */4', etag: '"range-416-other"' },
        { 'content-range': 'items */4', etag: '"range-416-v1"' }
      ].entries()) {
        const relativePath = `range-416-invalid-${index}.pdf`
        const paused = await pauseStableDownload(harness, {
          id: `range-416-invalid-pause-${index}`,
          relativePath,
          prefix: '%PDF',
          total: 4,
          etag: '"range-416-v1"'
        })
        harness.enqueue({ type: 'response', statusCode: 416, headers, chunks: [] })
        const invalid = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, `range-416-invalid-resume-${index}`, relativePath, {
          resumeId: paused.result.resume_id
        }))
        assert.equal(invalid.code, 'DOWNLOAD_RANGE_MISMATCH')
      }
    } finally { await harness.restore() }
  })

  await t.test('non-identity 206 and dangerous magic crossing the saved prefix boundary are discarded', async () => {
    const harness = await createHarness({ safeStorageAvailable: true })
    try {
      const encoded = await pauseStableDownload(harness, {
        id: 'encoded-range-pause',
        relativePath: 'encoded-range.pdf',
        prefix: 'abc',
        total: 6,
        etag: '"encoded-v1"'
      })
      harness.enqueue({
        type: 'response',
        statusCode: 206,
        headers: {
          'content-type': 'application/pdf',
          'content-range': 'bytes 3-5/6',
          'content-length': '3',
          'content-encoding': 'gzip',
          etag: '"encoded-v1"'
        },
        chunks: ['def']
      })
      const encodedResult = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'encoded-range-resume', 'encoded-range.pdf', {
        resumeId: encoded.result.resume_id
      }))
      assert.equal(encodedResult.code, 'DOWNLOAD_RANGE_MISMATCH')

      const magic = await pauseStableDownload(harness, {
        id: 'magic-boundary-pause',
        relativePath: 'magic-boundary.pdf',
        prefix: 'M',
        total: 3,
        etag: '"magic-v1"'
      })
      harness.enqueue({
        type: 'response',
        statusCode: 206,
        headers: {
          'content-type': 'application/pdf',
          'content-range': 'bytes 1-2/3',
          'content-length': '2',
          etag: '"magic-v1"'
        },
        chunks: ['Zx']
      })
      const magicResult = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'magic-boundary-resume', 'magic-boundary.pdf', {
        resumeId: magic.result.resume_id
      }))
      assert.equal(magicResult.code, 'UNSAFE_DOWNLOAD_PAYLOAD')
      assert.equal(await fs.promises.stat(path.join(harness.workspace, 'magic-boundary.pdf')).then(() => true, () => false), false)
      assert.deepEqual(await harness.quarantineFiles(), [])
    } finally { await harness.restore() }
  })

  await t.test('5xx and incomplete range bodies pause, while DNS rebinding and HTTPS downgrade discard', async () => {
    const harness = await createHarness({ safeStorageAvailable: true })
    try {
      const retryable = await pauseStableDownload(harness, {
        id: 'retryable-5xx-pause',
        relativePath: 'retryable-5xx.pdf',
        prefix: 'abc',
        total: 6,
        etag: '"retryable-v1"'
      })
      harness.enqueue({ type: 'response', statusCode: 503, headers: {}, chunks: [] })
      const unavailable = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'retryable-5xx-resume', 'retryable-5xx.pdf', {
        resumeId: retryable.result.resume_id
      }))
      assert.equal(unavailable.code, 'DOWNLOAD_PAUSED')
      assert.equal(unavailable.resume_id, retryable.result.resume_id)
      assert.equal(unavailable.committed_bytes, 3)
      assert.equal((await harness.invoke('knote:agent-download-discard', {
        resumeId: unavailable.resume_id,
        workspaceGrantId: harness.grantId
      })).ok, true)

      const incomplete = await pauseStableDownload(harness, {
        id: 'incomplete-range-pause',
        relativePath: 'incomplete-range.pdf',
        prefix: 'abc',
        total: 9,
        etag: '"incomplete-v1"'
      })
      harness.enqueue({
        type: 'response',
        statusCode: 206,
        headers: {
          'content-type': 'application/pdf',
          'content-range': 'bytes 3-8/9',
          'content-length': '6',
          etag: '"incomplete-v1"'
        },
        chunks: ['de']
      })
      const short = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'incomplete-range-resume', 'incomplete-range.pdf', {
        resumeId: incomplete.result.resume_id
      }))
      assert.equal(short.code, 'DOWNLOAD_PAUSED')
      assert.equal(short.committed_bytes, 5)
      assert.equal((await harness.invoke('knote:agent-download-discard', {
        resumeId: short.resume_id,
        workspaceGrantId: harness.grantId
      })).ok, true)

      const rebound = await pauseStableDownload(harness, {
        id: 'resume-rebind-pause',
        relativePath: 'resume-rebind.pdf',
        prefix: 'abc',
        total: 6,
        etag: '"rebind-v1"'
      })
      harness.enqueueResolution({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] })
      harness.enqueueResolution({ endpoints: [{ address: '10.0.0.7', family: 'ipv4' }] })
      harness.enqueue({
        type: 'response',
        statusCode: 206,
        headers: {
          'content-type': 'application/pdf',
          'content-range': 'bytes 3-5/6',
          'content-length': '3',
          etag: '"rebind-v1"'
        },
        chunks: ['def']
      })
      const reboundResult = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'resume-rebind-resume', 'resume-rebind.pdf', {
        resumeId: rebound.result.resume_id
      }))
      assert.equal(reboundResult.code, 'ERR_NON_PUBLIC_ADDRESS')
      assert.equal((await harness.invoke('knote:agent-download-status', {
        resumeId: rebound.result.resume_id,
        workspaceGrantId: harness.grantId
      })).code, 'DOWNLOAD_RESUME_NOT_FOUND')

      const downgrade = await pauseStableDownload(harness, {
        id: 'resume-downgrade-pause',
        relativePath: 'resume-downgrade.pdf',
        prefix: 'abc',
        total: 6,
        etag: '"downgrade-v1"'
      })
      harness.enqueue({ type: 'redirect', location: 'http://cdn.example/insecure.pdf' })
      const downgradeResult = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'resume-downgrade-resume', 'resume-downgrade.pdf', {
        resumeId: downgrade.result.resume_id
      }))
      assert.equal(downgradeResult.code, 'ERR_HTTPS_DOWNGRADE')
      assert.equal(downgradeResult.resume_id, undefined)
      assert.deepEqual(await harness.quarantineFiles(), [])
    } finally { await harness.restore() }
  })

  await t.test('same-origin redirects retain Range, cross-origin approval retains the id but resets to zero', async () => {
    const harness = await createHarness({ safeStorageAvailable: true })
    try {
      const same = await pauseStableDownload(harness, {
        id: 'same-origin-range-pause',
        relativePath: 'same-origin-range.pdf',
        prefix: 'abc',
        total: 6,
        etag: '"redirect-v1"',
        url: 'https://public.example/files/source.pdf'
      })
      harness.enqueue({ type: 'redirect', location: '/files/final.pdf' })
      harness.enqueue({
        type: 'response',
        statusCode: 206,
        headers: {
          'content-type': 'application/pdf',
          'content-range': 'bytes 3-5/6',
          'content-length': '3',
          etag: '"redirect-v1"'
        },
        chunks: ['def']
      })
      const beforeSame = harness.requests.length
      const sameResult = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'same-origin-range-resume', 'same-origin-range.pdf', {
        url: 'https://public.example/files/source.pdf',
        resumeId: same.result.resume_id
      }))
      assert.equal(sameResult.ok, true)
      assert.deepEqual(harness.requests.slice(beforeSame).map((request) => request.headers.range), ['bytes=3-', 'bytes=3-'])

      const cross = await pauseStableDownload(harness, {
        id: 'cross-origin-range-pause',
        relativePath: 'cross-origin-range.pdf',
        prefix: 'old',
        total: 9,
        etag: '"cross-v1"'
      })
      harness.enqueue({ type: 'redirect', location: 'https://cdn.example/new.pdf?token=redirect-secret' })
      const approval = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'cross-origin-range-approval', 'cross-origin-range.pdf', {
        resumeId: cross.result.resume_id
      }))
      assert.equal(approval.code, 'DOWNLOAD_REDIRECT_APPROVAL_REQUIRED')
      assert.equal(approval.resume_id, cross.result.resume_id)
      assert.equal(approval.committed_bytes, 3)
      const replacement = Buffer.from('%PDF-new')
      harness.enqueue({
        type: 'response',
        headers: { 'content-type': 'application/pdf', 'content-length': String(replacement.length), etag: '"cdn-v1"' },
        chunks: [replacement]
      })
      const approved = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'cross-origin-range-resume', 'cross-origin-range.pdf', {
        url: approval.redirect_url,
        resumeId: approval.resume_id
      }))
      assert.equal(approved.ok, true)
      assert.equal(harness.requests.at(-1).headers.range, undefined)
      assert.deepEqual(await fs.promises.readFile(path.join(harness.workspace, 'cross-origin-range.pdf')), replacement)
    } finally { await harness.restore() }
  })

  await t.test('renderer crash and app quit pause stable downloads; explicit cancel discards them', async () => {
    const crashHarness = await createHarness({ safeStorageAvailable: true })
    try {
      const crashBodySent = deferred()
      const holdCrashBody = deferred()
      crashHarness.enqueue({
        type: 'response',
        headers: { 'content-type': 'application/pdf', 'content-length': '12', etag: '"lifecycle-v1"' },
        run: async (response) => {
          response.write('%PDF')
          crashBodySent.resolve()
          await holdCrashBody.promise
        }
      })
      const before = crashHarness.requests.length
      const pending = crashHarness.invoke('knote:agent-download', agentDownloadRequest(crashHarness, 'renderer-crash-pause', 'renderer-crash-pause.pdf'))
      while (crashHarness.requests.length === before || !crashHarness.requests.at(-1)?.response) await immediate()
      await crashBodySent.promise
      while (crashHarness.requests.at(-1).response.readableLength > 0) await immediate()
      await immediate()
      crashHarness.sender.emit('render-process-gone', {}, { reason: 'crashed' })
      const paused = await pending
      holdCrashBody.resolve()
      assert.equal(paused.code, 'DOWNLOAD_PAUSED')
      assert.equal(paused.committed_bytes, 4)

      crashHarness.enqueue({
        type: 'response',
        headers: { 'content-type': 'application/pdf', 'content-length': '12', etag: '"cancel-v1"' },
        chunks: ['%PDF'],
        end: false
      })
      const cancelBefore = crashHarness.requests.length
      const cancelPending = crashHarness.invoke('knote:agent-download', agentDownloadRequest(crashHarness, 'explicit-discard', 'explicit-discard.pdf'))
      while (crashHarness.requests.length === cancelBefore || !crashHarness.requests.at(-1)?.response) await immediate()
      assert.equal(await crashHarness.invoke('knote:agent-download-cancel', { id: 'explicit-discard' }), true)
      const cancelled = await cancelPending
      assert.equal(cancelled.code, 'DOWNLOAD_CANCELLED')
      assert.equal(cancelled.resume_id, undefined)
    } finally { await crashHarness.restore() }

    const quitHarness = await createHarness({ safeStorageAvailable: true })
    try {
      const quitBodySent = deferred()
      const holdQuitBody = deferred()
      quitHarness.enqueue({
        type: 'response',
        headers: { 'content-type': 'application/pdf', 'content-length': '12', etag: '"quit-v1"' },
        run: async (response) => {
          response.write('%PDF')
          quitBodySent.resolve()
          await holdQuitBody.promise
        }
      })
      const before = quitHarness.requests.length
      const pending = quitHarness.invoke('knote:agent-download', agentDownloadRequest(quitHarness, 'app-quit-pause', 'app-quit-pause.pdf'))
      while (quitHarness.requests.length === before || !quitHarness.requests.at(-1)?.response) await immediate()
      await quitBodySent.promise
      while (quitHarness.requests.at(-1).response.readableLength > 0) await immediate()
      await immediate()
      await quitHarness.runQuitCleanup()
      const paused = await pending
      holdQuitBody.resolve()
      assert.equal(paused.code, 'DOWNLOAD_PAUSED')
      assert.equal(paused.committed_bytes, 4)
      assert.ok((await quitHarness.quarantineFiles()).some((name) => name === `${paused.resume_id}.part`))
    } finally { await quitHarness.restore() }
  })

  await t.test('one resume has one owner, paused targets advertise the opaque id, and external creates remain FILE_EXISTS', async () => {
    const harness = await createHarness({ safeStorageAvailable: true })
    try {
      const paused = await pauseStableDownload(harness, {
        id: 'owner-pause',
        relativePath: 'owner.pdf',
        prefix: 'abc',
        total: 6,
        etag: '"owner-v1"'
      })
      const available = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'owner-new-conflict', 'owner.pdf'))
      assert.equal(available.code, 'DOWNLOAD_RESUME_AVAILABLE')
      assert.equal(available.resume_id, paused.result.resume_id)

      harness.enqueue({
        type: 'response',
        statusCode: 206,
        headers: {
          'content-type': 'application/pdf',
          'content-range': 'bytes 3-5/6',
          'content-length': '3',
          etag: '"owner-v1"'
        },
        chunks: ['def'],
        end: false
      })
      const before = harness.requests.length
      const active = harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'owner-active', 'owner.pdf', {
        resumeId: paused.result.resume_id
      }))
      while (harness.requests.length === before || !harness.requests.at(-1)?.response) await immediate()
      const duplicate = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'owner-duplicate', 'owner.pdf', {
        resumeId: paused.result.resume_id
      }))
      assert.equal(duplicate.code, 'DOWNLOAD_DESTINATION_BUSY')
      assert.equal(await harness.invoke('knote:agent-download-cancel', { id: 'owner-active' }), true)
      assert.equal((await active).code, 'DOWNLOAD_CANCELLED')

      const external = await pauseStableDownload(harness, {
        id: 'external-create-pause',
        relativePath: 'external-create.pdf',
        prefix: 'abc',
        total: 6,
        etag: '"external-v1"'
      })
      await fs.promises.writeFile(path.join(harness.workspace, 'external-create.pdf'), 'external winner', { flag: 'wx' })
      const exists = await harness.invoke('knote:agent-download', agentDownloadRequest(harness, 'external-create-resume', 'external-create.pdf', {
        resumeId: external.result.resume_id
      }))
      assert.equal(exists.code, 'FILE_EXISTS')
      assert.equal(await fs.promises.readFile(path.join(harness.workspace, 'external-create.pdf'), 'utf8'), 'external winner')
      const discarded = await harness.invoke('knote:agent-download-discard', {
        resumeId: external.result.resume_id,
        workspaceGrantId: harness.grantId
      })
      assert.equal(discarded.ok, true)
    } finally { await harness.restore() }
  })

  await t.test('safeStorage unavailable never pauses a failed partial and encrypted status omits signed query data', async () => {
    const ephemeral = await createHarness({ safeStorageAvailable: false })
    try {
      const failed = await pauseStableDownload(ephemeral, {
        id: 'ephemeral-validator',
        relativePath: 'ephemeral-validator.pdf',
        prefix: '%PDF',
        total: 12,
        etag: '"would-resume-if-encrypted"'
      })
      assert.equal(failed.result.code, 'DOWNLOAD_INCOMPLETE')
      assert.equal(failed.result.resume_id, undefined)
      assert.deepEqual(await ephemeral.quarantineFiles(), [])
    } finally { await ephemeral.restore() }

    const encrypted = await createHarness({ safeStorageAvailable: true })
    try {
      const signedUrl = 'https://public.example/source.pdf?X-Amz-Signature=never-write-this-query'
      const paused = await pauseStableDownload(encrypted, {
        id: 'signed-url-pause',
        relativePath: 'signed-url.pdf',
        prefix: '%PDF',
        total: 12,
        etag: '"signed-v1"',
        url: signedUrl
      })
      assert.equal(paused.result.code, 'DOWNLOAD_PAUSED')
      assert.doesNotMatch(JSON.stringify(paused.result), /X-Amz|never-write-this-query|source\.pdf\?/)
      const status = await encrypted.invoke('knote:agent-download-status', {
        resumeId: paused.result.resume_id,
        workspaceGrantId: encrypted.grantId
      })
      assert.deepEqual({ origin: status.origin, path: status.path }, {
        origin: 'https://public.example',
        path: 'signed-url.pdf'
      })
      const diskFiles = await fs.promises.readdir(path.join(encrypted.userData, 'agent-download-quarantine', 'v2'))
      const disk = Buffer.concat(await Promise.all(diskFiles.map((name) => fs.promises.readFile(path.join(encrypted.userData, 'agent-download-quarantine', 'v2', name)))))
      assert.equal(disk.includes(Buffer.from('never-write-this-query')), false)
      const list = await encrypted.invoke('knote:agent-download-list-available', { workspaceGrantId: encrypted.grantId })
      assert.equal(list.ok, true)
      assert.equal(list.available.some((item) => item.resume_id === paused.result.resume_id), true)
      assert.doesNotMatch(JSON.stringify(list), /X-Amz|never-write-this-query/)
      assert.equal((await encrypted.invoke('knote:agent-download-discard', {
        resumeId: paused.result.resume_id,
        workspaceGrantId: encrypted.grantId
      })).ok, true)
    } finally { await encrypted.restore() }
  })
})

test('preload waits for Agent download settlement and gives committed success cancellation precedence', async () => {
  const preloadPath = require.resolve('./preload.cjs')
  const originalLoad = Module._load
  const calls = []
  let exposed = null
  let downloadReply = null
  const downloadDeferreds = []
  const ipcRenderer = new EventEmitter()
  ipcRenderer.sendSync = () => false
  ipcRenderer.invoke = (channel, payload) => {
    calls.push({ channel, payload })
    if (channel === 'knote:web-fetch') return new Promise(() => {})
    if (channel === 'knote:agent-download') {
      if (downloadReply) return Promise.resolve(downloadReply)
      const pending = deferred()
      downloadDeferreds.push(pending)
      return pending.promise
    }
    return Promise.resolve(true)
  }
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api } },
        ipcRenderer
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    delete require.cache[preloadPath]
    require(preloadPath)
  } finally {
    Module._load = originalLoad
    delete require.cache[preloadPath]
  }
  assert(exposed)
  const controller = new AbortController()
  const pending = exposed.webFetch('https://public.example/', 12000, {
    id: 'renderer-web-fetch',
    signal: controller.signal
  })
  controller.abort()
  await assert.rejects(pending, (error) => error?.name === 'AbortError')
  await immediate()
  assert.deepEqual(calls, [
    {
      channel: 'knote:web-fetch',
      payload: { url: 'https://public.example/', max: 12000, id: 'renderer-web-fetch' }
    },
    {
      channel: 'knote:web-request-cancel',
      payload: { id: 'renderer-web-fetch' }
    }
  ])

  calls.length = 0
  const downloadPending = exposed.agentDownload({
    id: 'renderer-agent-download',
    url: 'https://files.example/report.pdf',
    workspaceGrantId: 'folder-grant',
    relativePath: 'downloads/report.pdf'
  })
  const downloadCancellation = exposed.agentDownloadCancel('renderer-agent-download')
  await immediate()
  assert.deepEqual(calls, [
    {
      channel: 'knote:agent-download',
      payload: {
        id: 'renderer-agent-download',
        url: 'https://files.example/report.pdf',
        workspaceGrantId: 'folder-grant',
        relativePath: 'downloads/report.pdf',
        maxBytes: null
      }
    },
    {
      channel: 'knote:agent-download-cancel',
      payload: { id: 'renderer-agent-download' }
    }
  ])
  assert.equal(await Promise.race([
    downloadCancellation.then(() => 'settled', () => 'settled'),
    immediate().then(() => 'pending')
  ]), 'pending', 'download cancellation settled before main cleanup')
  const cancelledReply = {
    ok: false,
    id: 'renderer-agent-download',
    code: 'DOWNLOAD_CANCELLED',
    error: 'request was cancelled'
  }
  downloadDeferreds[0].resolve(cancelledReply)
  assert.deepEqual(await downloadPending, cancelledReply)
  await assert.rejects(downloadCancellation, (error) => error?.name === 'AbortError')
  assert.equal(typeof exposed.agentDownload, 'function')
  assert.equal(typeof exposed.agentDownloadCancel, 'function')

  calls.length = 0
  const committedPending = exposed.agentDownload({
    id: 'renderer-agent-committed',
    url: 'https://files.example/committed.pdf',
    workspaceGrantId: 'folder-grant',
    relativePath: 'downloads/committed.pdf',
    maxBytes: 4096
  })
  const committedCancellation = exposed.agentDownloadCancel('renderer-agent-committed')
  await immediate()
  const committedReply = { ok: true, id: 'renderer-agent-committed' }
  downloadDeferreds[1].resolve(committedReply)
  assert.equal(await committedPending, committedReply)
  assert.equal(await committedCancellation, committedReply)
  assert.deepEqual(calls.map((call) => call.channel), [
    'knote:agent-download',
    'knote:agent-download-cancel'
  ])

  calls.length = 0
  downloadReply = {
    ok: false,
    id: 'renderer-agent-redirect',
    code: 'DOWNLOAD_REDIRECT_APPROVAL_REQUIRED',
    error: 'cross-origin download redirect requires another explicit approval',
    redirect_url: 'https://cdn.example/report.pdf'
  }
  const redirectResult = await exposed.agentDownload({
    id: 'renderer-agent-redirect',
    url: 'https://files.example/report.pdf',
    workspaceGrantId: 'folder-grant',
    relativePath: 'downloads/report.pdf'
  })
  assert.deepEqual(redirectResult, downloadReply)
  assert.equal(calls.length, 1)
  assert.equal(typeof exposed.agentDownloadStatus, 'function')
  assert.equal(typeof exposed.agentDownloadListAvailable, 'function')
  assert.equal(typeof exposed.agentDownloadDiscard, 'function')

  calls.length = 0
  const resumeId = 'r'.repeat(43)
  await exposed.agentDownload({
    id: 'renderer-agent-resume',
    url: 'https://files.example/report.pdf?signature=current-turn-only',
    workspaceGrantId: 'folder-grant',
    relativePath: 'downloads/report.pdf',
    resumeId
  })
  await exposed.agentDownloadStatus(resumeId, 'folder-grant')
  await exposed.agentDownloadListAvailable('folder-grant')
  await exposed.agentDownloadDiscard(resumeId, 'folder-grant')
  assert.deepEqual(calls.map(({ channel, payload }) => ({ channel, payload })), [
    {
      channel: 'knote:agent-download',
      payload: {
        id: 'renderer-agent-resume',
        url: 'https://files.example/report.pdf?signature=current-turn-only',
        workspaceGrantId: 'folder-grant',
        relativePath: 'downloads/report.pdf',
        maxBytes: null,
        resumeId
      }
    },
    { channel: 'knote:agent-download-status', payload: { resumeId, workspaceGrantId: 'folder-grant' } },
    { channel: 'knote:agent-download-list-available', payload: { workspaceGrantId: 'folder-grant' } },
    { channel: 'knote:agent-download-discard', payload: { resumeId, workspaceGrantId: 'folder-grant' } }
  ])
})
