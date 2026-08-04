import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagedElectronPath = String(process.env.KNOTE_E2E_EXECUTABLE || '').trim()

const jsonReply = (res, message, finishReason = 'stop') => {
  const body = JSON.stringify({
    id: `chatcmpl-e2e-${Date.now()}`,
    object: 'chat.completion',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 20, completion_tokens: 8 }
  })
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

const messageText = (message) => {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((part) => part && part.type === 'text')
    .map((part) => String(part.text || ''))
    .join('\n')
}

const lastInstruction = (messages) => {
  const users = messages.filter((message) => message?.role === 'user')
  return users.length ? messageText(users[users.length - 1]) : ''
}

const scenarioInstruction = (messages) => {
  const markers = /(?:ASK_TYPED|ASK_SWITCH|BATCH_SCOPE|AFTER_BATCH|PDF_SHORT|PDF_SCAN|PDF_NO_TOOLS|DELETE_CANCEL|DELETE_ACCEPT|IMAGE_REF_RECOVERY)/
  for (const message of [...messages].reverse()) {
    if (message?.role !== 'user') continue
    const text = messageText(message)
    const match = text.match(markers)
    if (match) return match[0]
  }
  return lastInstruction(messages)
}

const startFakeModel = async () => {
  let workspaceRaceToolResult = ''
  let batchWorkerRequests = 0
  let batchWorkerReplies = 0
  const pendingBatchWorkers = []
  const pdfRequests = new Map()
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/chat\/completions(?:\?|$)/.test(req.url || '')) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let payload
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400)
        res.end('bad json')
        return
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const instruction = scenarioInstruction(messages)
      const toolResult = [...messages].reverse().find((message) => message?.role === 'tool')

      const isBatchWorker = messages.some((message) => (
        message?.role === 'system' && String(message.content || '').includes('你是一个批处理工作单元')
      ))
      if (isBatchWorker) {
        batchWorkerRequests++
        pendingBatchWorkers.push(() => {
          if (res.destroyed || res.writableEnded) return
          batchWorkerReplies++
          jsonReply(res, { role: 'assistant', content: '# Batch worker output\n' })
        })
        return
      }

      if (/^PDF_(?:SHORT|SCAN|NO_TOOLS)$/.test(instruction) && Number(payload.max_tokens) !== 64) {
        const requests = pdfRequests.get(instruction) || []
        requests.push(payload)
        pdfRequests.set(instruction, requests)
        jsonReply(res, { role: 'assistant', content: `E2E_${instruction}_DONE` })
        return
      }

      // Session-title generation intentionally has no tools.
      if (!Array.isArray(payload.tools)) {
        jsonReply(res, { role: 'assistant', content: 'Electron 交互测试' })
        return
      }

      if (/WORKSPACE_RACE/.test(instruction)) {
        const toolResults = messages.filter((message) => message?.role === 'tool')
        if (toolResults.length >= 2) {
          workspaceRaceToolResult = String(toolResults[toolResults.length - 1]?.content || '')
        }
        const toolCall = (id, name, args) => jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) }
          }]
        }, 'tool_calls')

        if (toolResults.length === 0) {
          toolCall('call-workspace-race-read', 'read_file', { path: 'workspace-race.md' })
          return
        }
        if (toolResults.length === 1) {
          toolCall('call-workspace-race-edit', 'edit_file', {
            path: 'workspace-race.md',
            old_string: '# Workspace A',
            new_string: '# Workspace A edited'
          })
          return
        }
        jsonReply(res, { role: 'assistant', content: 'WORKSPACE_RACE_DONE' })
        return
      }

      if (/IMAGE_REF_RECOVERY/.test(instruction)) {
        const parsedResults = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        const latest = parsedResults[parsedResults.length - 1]
        const imageResult = parsedResults.find((result) => result?.data?.image_id)
        const imageId = imageResult?.data?.image_id
        const toolCall = (id, name, args) => jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) }
          }]
        }, 'tool_calls')

        if (!latest) {
          toolCall('call-read-image', 'read_workspace_image', { path: 'pixel.png' })
          return
        }
        if (latest?.data?.image_id) {
          toolCall('call-read-document', 'read_document', {})
          return
        }
        if (latest?.code === 'INVALID_IMAGE_REFERENCE') {
          toolCall('call-correct-image-ref', 'insert_lines', {
            after_line: 0,
            content: `![自动修正后的图片](${imageId})`
          })
          return
        }
        if (latest?.code === 'HUNK_STAGED') {
          jsonReply(res, { role: 'assistant', content: '错误引用已由系统拦截，并已使用原始图片 ID 重新提交。' })
          return
        }
        if (imageId) {
          toolCall('call-invalid-image-ref', 'insert_lines', {
            after_line: 0,
            content: `![错误引用](${imageId}.jpg0)`
          })
          return
        }
      }

      if (toolResult) {
        let result = {}
        try { result = JSON.parse(String(toolResult.content || '{}')) } catch { /* assertion happens in UI */ }
        if (/ASK_TYPED/.test(instruction)) {
          const answer = result?.data?.answer || '未知'
          jsonReply(res, { role: 'assistant', content: `已收到回答：${answer}` })
          return
        }
        if (/ASK_SWITCH/.test(instruction)) {
          const answer = result?.data?.answer || '未知'
          jsonReply(res, { role: 'assistant', content: `原会话已继续：${answer}` })
          return
        }
        if (/DELETE_CANCEL/.test(instruction)) {
          jsonReply(res, { role: 'assistant', content: '用户取消了删除，文件保持不变。' })
          return
        }
        if (/DELETE_ACCEPT/.test(instruction)) {
          jsonReply(res, { role: 'assistant', content: '文件已移入回收站。' })
          return
        }
      }

      if (/ASK_TYPED/.test(instruction)) {
        jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-ask-typed',
            type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({
                question: '应当如何处理这段内容？',
                options: ['保留原文', '重新组织']
              })
            }
          }]
        }, 'tool_calls')
        return
      }
      if (/ASK_SWITCH/.test(instruction)) {
        jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-ask-switch',
            type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({
                question: '请选择继续方案',
                options: ['方案甲', '方案乙']
              })
            }
          }]
        }, 'tool_calls')
        return
      }
      if (/BATCH_SCOPE/.test(instruction)) {
        if (toolResult) {
          jsonReply(res, { role: 'assistant', content: 'BATCH_SCOPE_DONE' })
          return
        }
        jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-batch-scope',
            type: 'function',
            function: {
              name: 'batch_process',
              arguments: JSON.stringify({
                files: ['keep.md', 'delete-me.md', 'notes/nested.md'],
                task: '为每个文件生成一行摘要',
                output_suffix: '-scope-e2e'
              })
            }
          }]
        }, 'tool_calls')
        return
      }
      if (/DELETE_(?:CANCEL|ACCEPT)/.test(instruction)) {
        jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `call-delete-${Date.now()}`,
            type: 'function',
            function: {
              name: 'delete_file',
              arguments: JSON.stringify({ path: 'delete-me.md' })
            }
          }]
        }, 'tool_calls')
        return
      }

      jsonReply(res, { role: 'assistant', content: 'E2E_STUB_UNHANDLED' })
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get workspaceRaceToolResult() { return workspaceRaceToolResult },
    get batchWorkerRequests() { return batchWorkerRequests },
    get batchWorkerReplies() { return batchWorkerReplies },
    pdfRequestCount(marker) { return (pdfRequests.get(marker) || []).length },
    latestPdfRequest(marker) { return (pdfRequests.get(marker) || []).at(-1) || null },
    releaseBatchWorkers(count = Number.POSITIVE_INFINITY) {
      let released = 0
      while (pendingBatchWorkers.length && released < count) {
        pendingBatchWorkers.shift()()
        released++
      }
      return released
    },
    close: () => new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      server.close(done)
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      setTimeout(done, 2_000)
    })
  }
}

const launchFixture = async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-electron-ui-'))
  const userData = path.join(tempRoot, 'profile')
  const workspace = path.join(tempRoot, 'workspace')
  // Deliberately give both folders the same leaf name. This catches the old
  // name-only workspace-key collision in addition to the delayed I/O race.
  const workspaceB = path.join(tempRoot, 'other', 'workspace')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(workspaceB, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'keep.md'), '# Keep\n')
  fs.writeFileSync(path.join(workspace, 'delete-me.md'), '# Delete me\n')
  fs.writeFileSync(path.join(workspace, 'slow.txt'), 'Slow preview must never replace a newer document.\n')
  fs.writeFileSync(path.join(workspace, 'workspace-race.md'), '# Workspace A\n')
  fs.writeFileSync(path.join(workspace, 'a-only.md'), '# A only\n')
  fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'notes', 'nested.md'), '# Nested\n')
  fs.writeFileSync(
    path.join(workspace, 'align.md'),
    '<img src="pixel.png" alt="pixel" style="width:40%;">\n'
  )
  fs.writeFileSync(path.join(workspaceB, 'workspace-race.md'), '# Workspace B\n')
  fs.writeFileSync(path.join(workspaceB, 'b-only.md'), '# B only\n')
  fs.writeFileSync(
    path.join(workspace, 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  )
  const model = await startFakeModel()
  const diagnostics = []
  let electronApp
  let page

  try {
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => typeof value === 'string')
    )
    const launchOptions = {
      args: packagedElectronPath ? [workspace] : ['.', workspace],
      cwd: repoRoot,
      env: {
        ...cleanEnv,
        KNOTE_E2E: '1',
        KNOTE_E2E_USER_DATA: userData
      },
      timeout: 90_000
    }
    // Development launches must use Playwright's built-in Electron loader.
    // Supplying Electron's executable path explicitly bypasses that loader
    // (and its app.whenReady inspector handshake), which made otherwise valid
    // fixtures sit idle for minutes. A packaged executable still needs its
    // explicit path because it has no project-local Electron entry point.
    if (packagedElectronPath) launchOptions.executablePath = packagedElectronPath
    electronApp = await electron.launch(launchOptions)
    const processOutput = (stream, label) => {
      if (!stream || typeof stream.on !== 'function') return
      stream.on('data', (chunk) => diagnostics.push(`${label}: ${String(chunk).trim()}`))
    }
    const electronProcess = electronApp.process()
    processOutput(electronProcess.stdout, 'main-stdout')
    processOutput(electronProcess.stderr, 'main-stderr')
    page = await electronApp.firstWindow({ timeout: 90_000 })
    page.on('console', (msg) => {
      if (msg.type() === 'error') diagnostics.push(`console: ${msg.text()}`)
    })
    page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`))
    // File-backed Electron pages can report network-idle before Playwright
    // records the DOMContentLoaded lifecycle event on a very slow Windows
    // machine. The actual app mount is the useful readiness contract.
    try {
      await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
    } catch (error) {
      const url = page.url()
      let html = ''
      try { html = (await page.content()).slice(0, 4000) } catch { /* window already closed */ }
      throw new Error(`Knote renderer did not mount. url=${url}\nhtml=${html}\n${error.message}`)
    }
    await page.evaluate(({ baseUrl }) => {
      localStorage.setItem('knote-onboarding-complete-v1', '1')
      localStorage.setItem('knote-agent-sidebar', '1')
      localStorage.setItem('knote-agent-config', JSON.stringify({
        config: {
          protocol: 'openai',
          baseUrl,
          apiKey: 'e2e-only',
          model: 'knote-e2e-model',
          webSearch: false,
          verify: false,
          reasoning: '',
          ctxWindow: 0
        },
        capabilities: {
          checked: true,
          checking: false,
          chat: true,
          vision: true,
          tools: true,
          pdf: false,
          error: '',
          notes: {}
        }
      }))
    }, { baseUrl: model.baseUrl })
    await page.reload({ waitUntil: 'commit', timeout: 90_000 })
    await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
    // Reloading is necessary for the module-level persisted config loader.
    // Re-register the fixture folder afterwards so the folder-scoped tools
    // are guaranteed to be offered even if the initial open event raced the
    // reload.
    const reopened = await page.evaluate((folder) => window.knoteDesktop.reopen('folder', folder), workspace)
    assert.equal(reopened, true)
    const panel = page.locator('[data-testid="agent-panel"][data-agent-mode="sidebar"]')
    await panel.waitFor({ state: 'visible', timeout: 15_000 })
    await panel.getByTestId('agent-input').waitFor({ state: 'visible' })
    await page.getByText('delete-me.md', { exact: true }).first().waitFor({ state: 'visible' })

    t.after(async () => {
      if (diagnostics.length) {
        // Keep renderer errors attached to a failing test without polluting a
        // successful run with harmless Chromium warnings.
        t.diagnostic(diagnostics.join('\n'))
      }
      if (electronApp) await closeElectron(electronApp)
      await model.close().catch(() => {})
      await removeFixture(tempRoot)
    })
    return { page, panel, workspace, workspaceB, electronApp, model }
  } catch (error) {
    if (page) {
      diagnostics.push(`url: ${page.url()}`)
      try { diagnostics.push(`html: ${(await page.content()).slice(0, 1200)}`) } catch { /* window already closed */ }
    }
    if (diagnostics.length && error && typeof error.message === 'string') {
      error.message += `\nRenderer diagnostics:\n${diagnostics.join('\n')}`
    }
    if (electronApp) await closeElectron(electronApp)
    await model.close().catch(() => {})
    await removeFixture(tempRoot)
    throw error
  }
}

const workspaceTreeRow = (page, name) => page
  .getByTestId('workspace-tree-row')
  .filter({ has: page.locator('span.truncate', { hasText: name }) })
  .filter({ hasText: name })
  .first()

const sendPrompt = async (panel, text) => {
  const input = panel.getByTestId('agent-input')
  await input.click()
  await input.fill(text)
  await panel.getByTestId('agent-send').click()
}

const waitUntil = async (predicate, {
  timeout = 10_000,
  interval = 25,
  message = 'condition was not met'
} = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(message)
}

const assemblePdf = (text = '') => {
  const escaped = String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const objects = []
  objects[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  objects[2] = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
  objects[3] = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n'
  const body = escaped ? `BT /F1 12 Tf 72 700 Td (${escaped}) Tj ET` : ''
  objects[4] = `4 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`
  objects[5] = '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 1; index <= 5; index++) {
    offsets[index] = pdf.length
    pdf += objects[index]
  }
  const xrefPosition = pdf.length
  pdf += 'xref\n0 6\n0000000000 65535 f \n'
  for (let index = 1; index <= 5; index++) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF`
  return Buffer.from(pdf, 'binary')
}

const removeFixture = async (target) => {
  let lastError = null
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
      return
    } catch (error) {
      lastError = error
      if (!error || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw lastError
}

const closeElectron = async (application) => {
  if (!application) return
  let closed = false
  const closeTask = application.close()
    .catch(() => {})
    .finally(() => { closed = true })
  await Promise.race([
    closeTask,
    new Promise((resolve) => setTimeout(resolve, 10_000))
  ])
  if (closed) return
  try { application.process().kill() } catch { /* already gone */ }
  await Promise.race([
    closeTask,
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ])
}

const installWorkspaceRaceReadGate = async (electronApp, workspace, workspaceB) => {
  await electronApp.evaluate(async ({ ipcMain }, config) => {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const roots = config.roots.map((root) => path.resolve(root))
    const folded = (value) => process.platform === 'win32' ? value.toLowerCase() : value
    const insideRoots = (candidate) => {
      const resolved = path.resolve(candidate)
      return roots.some((root) => {
        const rel = path.relative(folded(root), folded(resolved))
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
      })
    }

    globalThis.__knoteE2eWorkspaceRaceReads = 0
    ipcMain.removeHandler('knote:read-file-bytes')
    ipcMain.handle('knote:read-file-bytes', async (_event, { path: candidate }) => {
      if (!insideRoots(candidate)) throw new Error('outside e2e workspace')
      const resolved = path.resolve(candidate)
      let stat
      try { stat = fs.statSync(resolved) } catch { throw new Error('not_found') }
      if (!stat.isFile()) throw new Error('not_a_file')
      const cap = 64 * 1024 * 1024
      if (stat.size > cap) throw new Error('too_large')
      if (path.basename(resolved) === 'workspace-race.md') {
        globalThis.__knoteE2eWorkspaceRaceReads += 1
        // The async delay keeps Electron responsive so the test can switch
        // folders while edit_file is suspended inside its disk re-read.
        await new Promise((resolve) => setTimeout(resolve, config.delayMs))
      }
      const buffer = fs.readFileSync(resolved)
      return {
        base64: buffer.toString('base64'),
        mime: 'application/octet-stream',
        size: stat.size
      }
    })
  }, { roots: [workspace, workspaceB], delayMs: 500 })
}

const installTreeFileReadRaceGate = async (electronApp, workspace) => {
  await electronApp.evaluate(async ({ ipcMain }, config) => {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    globalThis.__knoteE2eSlowTreeReads = 0
    const root = path.resolve(config.workspace)
    const foldedRoot = process.platform === 'win32' ? root.toLowerCase() : root
    ipcMain.removeHandler('knote:fs-read')
    ipcMain.handle('knote:fs-read', async (_event, { path: candidate }) => {
      const resolved = path.resolve(candidate)
      const folded = process.platform === 'win32' ? resolved.toLowerCase() : resolved
      const relative = path.relative(foldedRoot, folded)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside e2e workspace')
      if (path.basename(resolved) === 'keep.md') {
        globalThis.__knoteE2eSlowTreeReads += 1
        await new Promise((resolve) => setTimeout(resolve, config.slowDelayMs))
      }
      return fs.promises.readFile(resolved, 'utf8')
    })
  }, { workspace, slowDelayMs: 500 })
}

const installPreviewReadRaceGate = async (electronApp, workspace) => {
  await electronApp.evaluate(async ({ ipcMain }, config) => {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const root = path.resolve(config.workspace)
    const foldedRoot = process.platform === 'win32' ? root.toLowerCase() : root
    ipcMain.removeHandler('knote:read-file-bytes')
    ipcMain.handle('knote:read-file-bytes', async (_event, { path: candidate }) => {
      const resolved = path.resolve(candidate)
      const folded = process.platform === 'win32' ? resolved.toLowerCase() : resolved
      const relative = path.relative(foldedRoot, folded)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside e2e workspace')
      if (path.basename(resolved) === 'slow.txt') {
        await new Promise((resolve) => setTimeout(resolve, config.slowDelayMs))
      }
      const buffer = await fs.promises.readFile(resolved)
      return {
        base64: buffer.toString('base64'),
        mime: path.extname(resolved).toLowerCase() === '.txt' ? 'text/plain' : 'application/octet-stream',
        size: buffer.length
      }
    })
  }, { workspace, slowDelayMs: 500 })
}

const installMainOpenReadRaceGate = async (electronApp, slowPath) => {
  await electronApp.evaluate(async (_electron, config) => {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    if (!globalThis.__knoteE2eOriginalReadFile) {
      globalThis.__knoteE2eOriginalReadFile = fs.promises.readFile.bind(fs.promises)
    }
    const original = globalThis.__knoteE2eOriginalReadFile
    const target = path.resolve(config.slowPath)
    globalThis.__knoteE2eMainOpenReads = 0
    fs.promises.readFile = async (candidate, ...args) => {
      const resolved = path.resolve(String(candidate))
      if (resolved === target) {
        globalThis.__knoteE2eMainOpenReads += 1
        await new Promise((resolve) => setTimeout(resolve, config.slowDelayMs))
      }
      return original(candidate, ...args)
    }
  }, { slowPath, slowDelayMs: 500 })
}

const installProgressiveReadRaceGate = async (electronApp, targetPath) => {
  await electronApp.evaluate(async ({ ipcMain }, config) => {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const fold = (value) => process.platform === 'win32' ? String(value).toLowerCase() : String(value)
    const target = path.resolve(config.targetPath)
    let releaseFirst
    const firstReleased = new Promise((resolve) => { releaseFirst = resolve })
    const state = {
      waiting: false,
      released: false,
      returned: 0,
      complete: false,
      attempts: [],
      calls: [],
      release: () => {
        if (state.released) return false
        state.released = true
        releaseFirst()
        return true
      }
    }
    globalThis.__knoteE2eProgressiveReadGate = state

    const changed = () => {
      const error = new Error('file_changed_during_progressive_read')
      error.code = 'FILE_CHANGED_DURING_READ'
      return error
    }

    ipcMain.removeHandler('knote:fs-read-chunk')
    ipcMain.handle('knote:fs-read-chunk', async (_event, payload) => {
      const resolved = path.resolve(String(payload.path || ''))
      state.attempts.push({
        path: resolved,
        offset: Number(payload.offset),
        expectedSize: Number(payload.expectedSize),
        expectedMtimeMs: Number(payload.expectedMtimeMs)
      })
      if (fold(resolved) !== fold(target)) throw new Error('outside e2e progressive-read target')
      const start = Math.max(0, Math.trunc(Number(payload.offset) || 0))
      const requested = Math.max(1, Math.min(512 * 1024, Math.trunc(Number(payload.length) || 256 * 1024)))
      let result
      const handle = await fs.promises.open(resolved, 'r')
      try {
        const before = await handle.stat()
        if ((Number.isFinite(Number(payload.expectedSize)) && before.size !== Number(payload.expectedSize)) ||
            (Number.isFinite(Number(payload.expectedMtimeMs)) && before.mtimeMs !== Number(payload.expectedMtimeMs))) {
          throw changed()
        }
        const remaining = Math.max(0, before.size - start)
        const buffer = Buffer.allocUnsafe(Math.min(requested, remaining))
        const read = buffer.length
          ? await handle.read(buffer, 0, buffer.length, start)
          : { bytesRead: 0 }
        const after = await handle.stat()
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw changed()
        result = {
          bytes: buffer.subarray(0, read.bytesRead),
          bytesRead: read.bytesRead,
          size: before.size,
          mtimeMs: before.mtimeMs,
          done: start + read.bytesRead >= before.size
        }
      } finally {
        await handle.close()
      }

      state.calls.push({
        offset: start,
        requested,
        bytesRead: result.bytesRead,
        done: result.done,
        expectedSize: Number(payload.expectedSize)
      })
      if (state.calls.length === 1) {
        state.waiting = true
        await firstReleased
        state.waiting = false
      }
      state.returned += 1
      if (result.done) state.complete = true
      return result
    })
  }, { targetPath })

  return {
    status: () => electronApp.evaluate(() => {
      const state = globalThis.__knoteE2eProgressiveReadGate
      return state && {
        waiting: state.waiting,
        released: state.released,
        returned: state.returned,
        complete: state.complete,
        attempts: state.attempts.map((attempt) => ({ ...attempt })),
        calls: state.calls.map((call) => ({ ...call }))
      }
    }),
    release: () => electronApp.evaluate(() => globalThis.__knoteE2eProgressiveReadGate?.release() === true)
  }
}

const installSessionFolderListRaceGate = async (electronApp, workspace) => {
  await electronApp.evaluate(async ({ ipcMain }, config) => {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const root = path.resolve(config.workspace)
    const foldedRoot = process.platform === 'win32' ? root.toLowerCase() : root
    globalThis.__knoteE2eSessionFolderReads = 0
    ipcMain.removeHandler('knote:fs-list')
    ipcMain.handle('knote:fs-list', async (_event, { dir }) => {
      const resolved = path.resolve(dir)
      const folded = process.platform === 'win32' ? resolved.toLowerCase() : resolved
      const relative = path.relative(foldedRoot, folded)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside e2e workspace')
      if (relative === '') {
        globalThis.__knoteE2eSessionFolderReads += 1
        await new Promise((resolve) => setTimeout(resolve, config.slowDelayMs))
      }
      const entries = await fs.promises.readdir(resolved, { withFileTypes: true })
      return entries
        .filter((entry) => !entry.isSymbolicLink())
        .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }))
    })
  }, { workspace, slowDelayMs: 650 })
}

const installHistoryReadRaceGate = async (electronApp, markdown) => {
  await electronApp.evaluate(async ({ ipcMain }, config) => {
    globalThis.__knoteE2eHistoryReads = 0
    ipcMain.removeHandler('knote:history-get')
    ipcMain.handle('knote:history-get', async () => {
      globalThis.__knoteE2eHistoryReads += 1
      await new Promise((resolve) => setTimeout(resolve, config.slowDelayMs))
      return config.markdown
    })
  }, { markdown, slowDelayMs: 600 })
}

const installImageWriteRaceGate = async (electronApp, roots) => {
  await electronApp.evaluate(async ({ ipcMain }, config) => {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const allowedRoots = config.roots.map((root) => path.resolve(root))
    const folded = (value) => process.platform === 'win32' ? value.toLowerCase() : value
    const insideAllowedRoot = (candidate) => allowedRoots.some((root) => {
      const relative = path.relative(folded(root), folded(candidate))
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    })
    globalThis.__knoteE2eImageWrites = []
    ipcMain.removeHandler('knote:write-image-file')
    ipcMain.handle('knote:write-image-file', async (_event, { path: candidate, base64 }) => {
      const resolved = path.resolve(candidate)
      if (!insideAllowedRoot(resolved)) throw new Error('outside e2e workspace')
      globalThis.__knoteE2eImageWrites.push(resolved)
      if (globalThis.__knoteE2eImageWrites.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, config.slowDelayMs))
      }
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true })
      await fs.promises.writeFile(resolved, Buffer.from(String(base64 || ''), 'base64'))
      return true
    })
  }, { roots, slowDelayMs: 700 })
}

const installFailingDocumentSaveGate = async (electronApp) => {
  await electronApp.evaluate(async ({ ipcMain }) => {
    globalThis.__knoteE2eFailedSaves = 0
    ipcMain.removeHandler('knote:fs-write')
    ipcMain.handle('knote:fs-write', async () => {
      globalThis.__knoteE2eFailedSaves += 1
      await new Promise((resolve) => setTimeout(resolve, 500))
      throw new Error('e2e forced save failure')
    })
  })
}

test('ask_user renders a clickable question card and resumes with the typed answer', async (t) => {
  const { page, panel } = await launchFixture(t)
  await sendPrompt(panel, 'ASK_TYPED')

  const question = panel.getByTestId('agent-question')
  await question.waitFor({ state: 'visible' })
  await assert.doesNotReject(() => question.getByText('应当如何处理这段内容？').waitFor())

  const answer = question.getByTestId('agent-question-input')
  await answer.click()
  await answer.fill('保留原有结构')
  await question.getByTestId('agent-question-answer').click()

  await question.waitFor({ state: 'hidden' })
  const reply = panel.getByText('已收到回答：保留原有结构', { exact: true })
  await reply.waitFor()

  // The destructive chat-clear flow is also driven through the real custom
  // confirmation: cancellation preserves messages; acceptance removes them.
  await panel.getByTestId('agent-clear-chat').click()
  const clearDialog = panel.getByTestId('agent-clear-confirm')
  await clearDialog.waitFor({ state: 'visible' })
  await clearDialog.getByTestId('agent-clear-cancel').click()
  await reply.waitFor()

  await panel.getByTestId('agent-clear-chat').click()
  await clearDialog.getByTestId('agent-clear-accept').click()
  await reply.waitFor({ state: 'detached' })
})

test('assistant file deletion requires a mouse confirmation and honours cancel/accept', async (t) => {
  const { page, panel, workspace } = await launchFixture(t)
  const target = path.join(workspace, 'delete-me.md')
  assert.equal(fs.existsSync(target), true)

  await sendPrompt(panel, 'DELETE_CANCEL')
  const dialog = page.getByTestId('app-dialog')
  await dialog.waitFor({ state: 'visible' })
  assert.equal(await dialog.getAttribute('data-dialog-mode'), 'confirm')
  await dialog.getByTestId('app-dialog-cancel').click()
  await panel.getByText('用户取消了删除，文件保持不变。', { exact: true }).waitFor()
  assert.equal(fs.existsSync(target), true, 'cancel must preserve the file')

  await sendPrompt(panel, 'DELETE_ACCEPT')
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByTestId('app-dialog-accept').click()
  await panel.getByText('文件已移入回收站。', { exact: true }).waitFor()
  assert.equal(fs.existsSync(target), false, 'accept must move the temporary file away')
  assert.equal(fs.existsSync(path.join(workspace, 'keep.md')), true, 'unrelated files must remain')
})

test('a running clarification stays bound to its original session while the user switches away', async (t) => {
  const { page, panel } = await launchFixture(t)
  await sendPrompt(panel, 'ASK_SWITCH')
  const question = panel.getByTestId('agent-question')
  await question.waitFor({ state: 'visible' })

  await panel.getByTestId('agent-new-session').click()
  await question.waitFor({ state: 'hidden' })

  await panel.getByTestId('agent-session-toggle').click()
  const blankRow = panel.locator('[data-testid="agent-session-row"][data-running="false"]').first()
  const blankSessionId = await blankRow.getAttribute('data-session-id')
  const runningRow = panel.locator('[data-testid="agent-session-row"][data-running="true"]')
  const runningSessionId = await runningRow.getAttribute('data-session-id')
  assert.ok(blankSessionId)
  assert.ok(runningSessionId)
  assert.notEqual(blankSessionId, runningSessionId)

  await runningRow.click()
  await question.waitFor({ state: 'visible' })
  await question.getByRole('button', { name: '方案乙', exact: true }).click()
  const originalReply = panel.getByText('原会话已继续：方案乙', { exact: true })
  await originalReply.waitFor()

  await panel.getByTestId('agent-session-toggle').click()
  await panel.locator(`[data-testid="agent-session-row"][data-session-id="${blankSessionId}"]`).click()
  await originalReply.waitFor({ state: 'detached' })

  await panel.getByTestId('agent-session-toggle').click()
  await panel.locator(`[data-testid="agent-session-row"][data-session-id="${runningSessionId}"]`).click()
  await originalReply.waitFor()
})

test('an attachment read cannot follow the UI into another Agent session', async (t) => {
  const { page, panel } = await launchFixture(t)
  await sendPrompt(panel, 'ATTACH_SCOPE_SEED')
  await panel.getByText('E2E_STUB_UNHANDLED', { exact: true }).last().waitFor()

  await panel.getByTestId('agent-session-toggle').click()
  const originalSessionId = await panel.locator('[data-testid="agent-session-row"][aria-current="true"]')
    .getAttribute('data-session-id')
  assert.ok(originalSessionId)
  await panel.getByTestId('agent-session-toggle').click()

  await page.evaluate(() => {
    const originalText = File.prototype.text
    globalThis.__knoteAttachmentReadStarted = 0
    globalThis.__knoteAttachmentReadFinished = 0
    globalThis.__knoteReleaseAttachmentRead = null
    File.prototype.text = function delayedAttachmentText() {
      const file = this
      globalThis.__knoteAttachmentReadStarted++
      return new Promise((resolve, reject) => {
        globalThis.__knoteReleaseAttachmentRead = async () => {
          try { resolve(await originalText.call(file)) } catch (error) { reject(error) }
          finally { globalThis.__knoteAttachmentReadFinished++ }
        }
      })
    }
  })

  await panel.getByTestId('agent-file-input').setInputFiles({
    name: 'slow-session-draft.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# belongs only to the abandoned draft\n')
  })
  await waitUntil(
    () => page.evaluate(() => globalThis.__knoteAttachmentReadStarted > 0),
    { message: 'the delayed attachment read never started' }
  )

  await panel.getByTestId('agent-new-session').click()
  await page.evaluate(() => globalThis.__knoteReleaseAttachmentRead())
  await waitUntil(
    () => page.evaluate(() => globalThis.__knoteAttachmentReadFinished > 0),
    { message: 'the delayed attachment read never resumed' }
  )
  await page.waitForTimeout(100)
  assert.equal(await panel.getByText('slow-session-draft.md', { exact: true }).count(), 0,
    'the completed read leaked into the newly active conversation')
  assert.equal(await panel.getByTestId('agent-send').isDisabled(), true)

  await panel.getByTestId('agent-session-toggle').click()
  await panel.locator(`[data-testid="agent-session-row"][data-session-id="${originalSessionId}"]`).click()
  assert.equal(await panel.getByText('slow-session-draft.md', { exact: true }).count(), 0,
    'a draft invalidated by leaving its conversation must stay discarded')
  assert.equal(await panel.getByTestId('agent-send').isDisabled(), true)
})

test('batch progress and late workers remain bound to the owning Agent session', async (t) => {
  const { page, panel, workspace, model } = await launchFixture(t)
  await sendPrompt(panel, 'BATCH_SCOPE')
  await waitUntil(
    () => model.batchWorkerRequests === 3,
    { timeout: 15_000, message: 'the three batch workers did not reach the model gate' }
  )

  const ownerBatch = panel.getByTestId('agent-batch-state')
  await ownerBatch.waitFor({ state: 'visible' })
  assert.match(await ownerBatch.innerText(), /0\s*\/\s*3/)
  await panel.getByTestId('agent-session-toggle').click()
  const ownerSessionId = await panel.locator('[data-testid="agent-session-row"][aria-current="true"]')
    .getAttribute('data-session-id')
  assert.ok(ownerSessionId)
  await panel.getByTestId('agent-session-toggle').click()

  await panel.getByTestId('agent-new-session').click()
  await ownerBatch.waitFor({ state: 'detached' })
  assert.equal(await panel.getByTestId('agent-batch-item').count(), 0)

  const outputPaths = [
    path.join(workspace, 'keep-scope-e2e.md'),
    path.join(workspace, 'delete-me-scope-e2e.md'),
    path.join(workspace, 'notes', 'nested-scope-e2e.md')
  ]
  assert.equal(model.releaseBatchWorkers(1), 1)
  await waitUntil(
    () => outputPaths.some((candidate) => fs.existsSync(candidate)),
    { timeout: 10_000, message: 'the released owner worker did not finish its verified write' }
  )
  assert.equal(model.batchWorkerReplies, 1)
  assert.equal(await panel.getByTestId('agent-batch-state').count(), 0,
    'background progress leaked into the newly active session')

  await panel.getByTestId('agent-session-toggle').click()
  await panel.locator(`[data-testid="agent-session-row"][data-session-id="${ownerSessionId}"]`).click()
  await ownerBatch.waitFor({ state: 'visible' })
  await waitUntil(
    async () => /1\s*\/\s*3/.test(await ownerBatch.innerText()),
    { message: 'the owner session did not retain its background progress' }
  )

  await panel.getByTestId('agent-stop').click()
  model.releaseBatchWorkers()
  await panel.getByTestId('agent-send').waitFor({ state: 'visible', timeout: 10_000 })
  await waitUntil(
    async () => /3\s*\/\s*3/.test(await ownerBatch.innerText()),
    { message: 'aborted batch items did not all reach a terminal state' }
  )
  const statuses = await panel.getByTestId('agent-batch-item').evaluateAll((items) => items.map((item) => item.dataset.status))
  assert.deepEqual(statuses.sort(), ['aborted', 'aborted', 'done'])
  assert.equal(outputPaths.filter((candidate) => fs.existsSync(candidate)).length, 1,
    'workers released after stop created additional output files')

  await sendPrompt(panel, 'AFTER_BATCH')
  await ownerBatch.waitFor({ state: 'detached' })
  await panel.getByText('E2E_STUB_UNHANDLED', { exact: true }).last().waitFor()
})

test('PDF delivery preserves short text, marks scans, and blocks unreadable no-tool requests', async (t) => {
  const { page, panel, model, workspace } = await launchFixture(t)
  const fileInput = panel.getByTestId('agent-file-input')
  const stagePdf = async (name, buffer) => {
    await fileInput.setInputFiles({ name, mimeType: 'application/pdf', buffer })
    await panel.locator(`[data-testid="agent-draft-attachment"][data-name="${name}"]`).waitFor({ state: 'visible', timeout: 10_000 })
  }

  await stagePdf('short-text.pdf', assemblePdf('Total: $5'))
  await sendPrompt(panel, 'PDF_SHORT')
  await panel.getByText('E2E_PDF_SHORT_DONE', { exact: true }).waitFor({ timeout: 20_000 })
  const shortPayload = JSON.stringify(model.latestPdfRequest('PDF_SHORT'))
  assert.match(shortPayload, /Total: \$5/)
  assert.match(shortPayload, /coverage=complete/)
  assert.doesNotMatch(shortPayload, /没有可提取的文本层/)

  await panel.getByTestId('agent-new-session').click()
  await stagePdf('scan.pdf', assemblePdf())
  await sendPrompt(panel, 'PDF_SCAN')
  await panel.getByText('E2E_PDF_SCAN_DONE', { exact: true }).waitFor({ timeout: 20_000 })
  const scanPayload = JSON.stringify(model.latestPdfRequest('PDF_SCAN'))
  assert.match(scanPayload, /coverage=none/)
  assert.match(scanPayload, /没有可提取的文本层/)
  assert.doesNotMatch(scanPayload, /已完整读取文本层/)

  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('knote-agent-config'))
    stored.capabilities.tools = false
    stored.capabilities.vision = false
    stored.capabilities.pdf = false
    localStorage.setItem('knote-agent-config', JSON.stringify(stored))
  })
  await page.reload({ waitUntil: 'commit', timeout: 90_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
  assert.equal(await page.evaluate((folder) => window.knoteDesktop.reopen('folder', folder), workspace), true)
  await page.getByText('keep.md', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
  const reloadedConfig = await page.evaluate(() => JSON.parse(localStorage.getItem('knote-agent-config')))
  assert.equal(reloadedConfig.capabilities.tools, false)
  assert.equal(reloadedConfig.capabilities.vision, false)
  const reloadedPanel = page.locator('[data-testid="agent-panel"][data-agent-mode="sidebar"]')
  await reloadedPanel.waitFor({ state: 'visible', timeout: 15_000 })
  const reloadedInput = reloadedPanel.getByTestId('agent-file-input')
  await reloadedInput.setInputFiles({ name: 'no-tools-scan.pdf', mimeType: 'application/pdf', buffer: assemblePdf() })
  await reloadedPanel.locator('[data-testid="agent-draft-attachment"][data-name="no-tools-scan.pdf"]').waitFor({ state: 'visible', timeout: 10_000 })
  await sendPrompt(reloadedPanel, 'PDF_NO_TOOLS')
  let noToolsPanelText = ''
  try {
    await waitUntil(async () => {
      noToolsPanelText = await reloadedPanel.innerText()
      return /请求失败|E2E_PDF_NO_TOOLS_DONE/.test(noToolsPanelText)
    }, { timeout: 20_000, message: 'the no-tool PDF run produced neither a local failure nor a provider reply' })
  } catch (error) {
    error.message += `\nPanel=${JSON.stringify(noToolsPanelText)}`
    throw error
  }
  const unexpectedRequest = model.latestPdfRequest('PDF_NO_TOOLS')
  assert.equal(model.pdfRequestCount('PDF_NO_TOOLS'), 0,
    `an unreadable scan reached the provider despite the local guard: ${JSON.stringify(unexpectedRequest).slice(0, 4000)}`)
  assert.match(noToolsPanelText, /coverage=none.*当前模型没有工具能力/)
})

test('a delayed read-to-write tool run cannot mutate the workspace opened after it started', async (t) => {
  const { page, panel, workspace, workspaceB, electronApp, model } = await launchFixture(t)
  const fileA = path.join(workspace, 'workspace-race.md')
  const fileB = path.join(workspaceB, 'workspace-race.md')
  await installWorkspaceRaceReadGate(electronApp, workspace, workspaceB)

  await sendPrompt(panel, 'WORKSPACE_RACE')

  // Count 1 is the model-requested read_file. Count 2 is edit_file's own
  // freshness re-read, which happens only after executeTool's workspace guard
  // has passed. Switching at this exact point exercises the historical race:
  // the old implementation resumed with the new live folderHandle and wrote B.
  await waitUntil(
    async () => (await electronApp.evaluate(() => globalThis.__knoteE2eWorkspaceRaceReads || 0)) >= 2,
    { timeout: 15_000, message: 'edit_file never reached its delayed freshness read' }
  )

  const reopened = await page.evaluate(
    (folder) => window.knoteDesktop.reopen('folder', folder),
    workspaceB
  )
  assert.equal(reopened, true)
  await page.getByText('b-only.md', { exact: true }).first().waitFor({ timeout: 10_000 })

  try {
    await waitUntil(
      () => fs.readFileSync(fileA, 'utf8').includes('# Workspace A edited'),
      { timeout: 15_000, message: 'the original workspace did not receive the bound edit' }
    )
  } catch (error) {
    await page.evaluate((folder) => window.knoteDesktop.reopen('folder', folder), workspace).catch(() => false)
    await page.getByText('a-only.md', { exact: true }).first().waitFor({ timeout: 10_000 }).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const chatStores = await page.evaluate(() => Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => key.startsWith('knote-agent-chat'))
        .map((key) => [key, localStorage.getItem(key)])
    )).catch(() => ({}))
    error.message += `\nA=${JSON.stringify(fs.readFileSync(fileA, 'utf8'))}` +
      `\nB=${JSON.stringify(fs.readFileSync(fileB, 'utf8'))}` +
      `\nAgent=${JSON.stringify((await panel.innerText()).slice(-4000))}` +
      `\nStores=${JSON.stringify(chatStores).slice(-8000)}` +
      `\nTool=${JSON.stringify(model.workspaceRaceToolResult)}`
    throw error
  }
  assert.equal(fs.readFileSync(fileA, 'utf8'), '# Workspace A edited\n')
  assert.equal(
    fs.readFileSync(fileB, 'utf8'),
    '# Workspace B\n',
    'the newly opened same-name workspace must remain byte-for-byte unchanged'
  )

  // Return to A to prove the detached run completed in its original
  // folder-scoped chat instead of leaking its reply into B's chat.
  assert.equal(await page.evaluate(
    (folder) => window.knoteDesktop.reopen('folder', folder),
    workspace
  ), true)
  await page.getByText('a-only.md', { exact: true }).first().waitFor({ timeout: 10_000 })
  await panel.getByText('WORKSPACE_RACE_DONE', { exact: true }).waitFor({ timeout: 15_000 })
})

test('pathless same-name browser workspaces keep distinct durable Agent identities', async (t) => {
  const { page } = await launchFixture(t)
  const openOpfsWorkspace = (parentName) => page.evaluate(async (parent) => {
    if (!navigator.storage?.getDirectory) throw new Error('OPFS is unavailable')
    const root = await navigator.storage.getDirectory()
    const testRoot = await root.getDirectoryHandle('knote-e2e-workspace-identities', { create: true })
    const parentHandle = await testRoot.getDirectoryHandle(parent, { create: true })
    const handle = await parentHandle.getDirectoryHandle('workspace', { create: true })
    const opened = await window.__knoteDebug.tabs.openFolderHandle(handle, handle.name)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const agent = await window.__knoteDebug.agent()
    return {
      opened,
      key: agent.activeChatKey.value,
      workspaceId: agent.agentBridge.getWorkspaceIdentity(),
      tabCount: window.__knoteDebug.tabs.list().length
    }
  }, parentName)

  const first = await openOpfsWorkspace('parent-a')
  const second = await openOpfsWorkspace('parent-b')
  assert.equal(first.opened, true)
  assert.equal(second.opened, true)
  assert.match(first.key, /^knote-agent-chat:folder:fsa\/v1\//)
  assert.match(second.key, /^knote-agent-chat:folder:fsa\/v1\//)
  assert.notEqual(first.key, second.key)
  assert.notEqual(first.workspaceId, second.workspaceId)

  const firstReopened = await openOpfsWorkspace('parent-a')
  assert.equal(firstReopened.key, first.key)
  assert.equal(firstReopened.tabCount, second.tabCount)

  await page.reload({ waitUntil: 'commit', timeout: 90_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
  await page.waitForTimeout(900)
  const firstAfterReload = await openOpfsWorkspace('parent-a')
  assert.equal(firstAfterReload.key, first.key)
  assert.equal(firstAfterReload.workspaceId, first.workspaceId)
})

test('an invalid model-written image suffix is rejected atomically and corrected in the same Agent run', async (t) => {
  const { page, panel } = await launchFixture(t)
  await sendPrompt(panel, 'IMAGE_REF_RECOVERY')

  await panel.getByText('错误引用已由系统拦截，并已使用原始图片 ID 重新提交。', { exact: true }).waitFor({
    timeout: 20_000
  })
  await page.getByText(/1\s*处待审核改动/).first().waitFor()

  const stagedMarkdown = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return agent.pendingHunks.value.flatMap((hunk) => hunk.newLines || []).join('\n')
  })
  assert.match(stagedMarkdown, /knote-img:img-/)
  assert.doesNotMatch(stagedMarkdown, /knote-img:(?:att|el)-/)

  const bodyText = await page.locator('body').innerText()
  assert.doesNotMatch(bodyText, /图片引用无效：.*\.jpg0/)
  assert.doesNotMatch(bodyText, /错误引用\]\(att-\d+[^)]*\.jpg0/)
})

test('the quick rail navigates user questions in only the active chat', async (t) => {
  const { page, panel } = await launchFixture(t)
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  assert.equal(await panel.locator('.knote-agent-header .knote-agent-brand-orb').count(), 0)
  const messageScroller = panel.locator('.knote-agent-message-list')
  const emptyMetrics = await messageScroller.evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth
  }))
  assert.equal(emptyMetrics.scrollTop, 0)
  assert.ok(emptyMetrics.scrollWidth <= emptyMetrics.clientWidth)
  const sidebarLayout = await panel.evaluate((element) => ({
    panelWidth: element.getBoundingClientRect().width,
    chatWidth: element.querySelector('.knote-agent-chat-column')?.getBoundingClientRect().width || 0,
    hasWorkspace: Boolean(element.querySelector('.knote-agent-workspace'))
  }))
  assert.equal(sidebarLayout.hasWorkspace, false)
  assert.ok(Math.abs(sidebarLayout.panelWidth - sidebarLayout.chatWidth) <= 1)
  const unifiedSurface = await panel.evaluate((element) => {
    const read = (selector) => {
      const node = element.querySelector(selector)
      const style = node ? getComputedStyle(node) : null
      return style && {
        backgroundImage: style.backgroundImage,
        backgroundColor: style.backgroundColor,
        backdropFilter: style.backdropFilter
      }
    }
    const composer = element.querySelector('.knote-agent-composer')
    const composerGlow = composer ? getComputedStyle(composer, '::before') : null
    return {
      chat: read('.knote-agent-chat-column'),
      header: read('.knote-agent-header'),
      composerWrap: read('.knote-agent-composer-wrap'),
      composerGlow: composerGlow && {
        content: composerGlow.content,
        backgroundImage: composerGlow.backgroundImage
      }
    }
  })
  for (const surface of [unifiedSurface.chat, unifiedSurface.header, unifiedSurface.composerWrap]) {
    assert.equal(surface.backgroundImage, 'none')
    assert.equal(surface.backgroundColor, 'rgba(0, 0, 0, 0)')
    assert.equal(surface.backdropFilter, 'none')
  }
  assert.ok(
    unifiedSurface.composerGlow.content === 'none' ||
    unifiedSurface.composerGlow.backgroundImage === 'none',
    'the composer must not create a second local glow'
  )

  const captureDir = process.env.KNOTE_CAPTURE_UI
  if (captureDir) {
    fs.mkdirSync(captureDir, { recursive: true })
    await panel.screenshot({ path: path.join(captureDir, 'agent-sidebar-empty.png') })
  }

  const prompts = Array.from(
    { length: 14 },
    (_, index) => `QUESTION_RAIL_${index + 1} 快速导航问题 ${index + 1}`
  )
  for (const prompt of prompts) {
    await sendPrompt(panel, prompt)
    await panel.getByText('E2E_STUB_UNHANDLED', { exact: true }).last().waitFor()
  }

  const userMessage = panel.locator('.knote-agent-message-user').first()
  const assistantMessage = panel.locator('.knote-agent-message-assistant').first()
  const messageSurface = await userMessage.evaluate((element) => {
    const style = getComputedStyle(element)
    const row = element.closest('.knote-agent-message-row')
    const list = element.closest('.knote-agent-message-list')
    const rect = element.getBoundingClientRect()
    const listRect = list?.getBoundingClientRect()
    return {
      backgroundImage: style.backgroundImage,
      backgroundColor: style.backgroundColor,
      borderRightWidth: style.borderRightWidth,
      boxShadow: style.boxShadow,
      rowAlignedRight: row?.classList.contains('items-end') || false,
      fitsMessageList: Boolean(listRect && rect.right <= listRect.right + 1),
      hasHorizontalOverflow: element.scrollWidth > element.clientWidth + 1
    }
  })
  const assistantSurface = await assistantMessage.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backgroundImage: style.backgroundImage,
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow
    }
  })
  assert.equal(messageSurface.backgroundImage, 'none')
  assert.equal(messageSurface.boxShadow, 'none')
  assert.ok(
    Number.parseFloat(messageSurface.borderRightWidth) >= 2.5,
    'the user bubble needs a clearly visible right-edge identity line'
  )
  assert.equal(messageSurface.rowAlignedRight, true)
  assert.equal(messageSurface.fitsMessageList, true)
  assert.equal(messageSurface.hasHorizontalOverflow, false)
  assert.notEqual(messageSurface.backgroundColor, assistantSurface.backgroundColor)
  assert.equal(assistantSurface.backgroundImage, 'none')

  if (captureDir) {
    await panel.screenshot({ path: path.join(captureDir, 'agent-user-message-contrast.png') })
  }

  const author = panel.locator('.knote-agent-message-author').first()
  await author.waitFor({ state: 'visible' })
  assert.equal((await author.innerText()).trim(), 'Knote Agent')
  assert.equal(await author.locator('canvas,img,svg').count(), 0)

  const rail = panel.getByTestId('agent-question-rail')
  const railList = panel.getByTestId('agent-question-rail-list')
  assert.equal(await rail.getAttribute('data-expanded'), 'false')
  const collapsedLimit = Number(await rail.getAttribute('data-collapsed-limit'))
  assert.equal(collapsedLimit, 10)
  const visibleQuestionCount = () => railList.evaluate((element) => {
    const viewport = element.getBoundingClientRect()
    return [...element.querySelectorAll('[data-testid="agent-question-quick"]')]
      .filter((button) => {
        const rect = button.getBoundingClientRect()
        return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1
      })
      .length
  })
  await waitUntil(
    async () => {
      const count = await visibleQuestionCount()
      return count > 1 && count <= collapsedLimit
    },
    { timeout: 2_000, message: 'the collapsed rail did not settle to its fixed mark limit' }
  )
  const restingVisible = await visibleQuestionCount()
  const collapsedGeometry = await rail.evaluate((element) => {
    const list = element.querySelector('.knote-agent-question-rail-list')
    const railRect = element.getBoundingClientRect()
    const listRect = list?.getBoundingClientRect()
    const visibleMarks = [...(list?.querySelectorAll('.knote-agent-question-mark') || [])]
      .map((mark) => mark.getBoundingClientRect())
      .filter((rect) => listRect && rect.bottom > listRect.top + 1 && rect.top < listRect.bottom - 1)
    const centers = visibleMarks.map((rect) => rect.top + rect.height / 2)
    const gaps = centers.slice(1).map((center, index) => center - centers[index])
    return {
      railWidth: railRect.width,
      railCenter: railRect.top + railRect.height / 2,
      listHeight: listRect?.height || 0,
      listCenter: listRect ? listRect.top + listRect.height / 2 : 0,
      maxMarkGap: gaps.length ? Math.max(...gaps) : 0
    }
  })
  const collapsedWidth = collapsedGeometry.railWidth
  t.diagnostic(`collapsed rail: ${JSON.stringify({ restingVisible, collapsedLimit, collapsedGeometry })}`)
  assert.ok(
    restingVisible > 1 && restingVisible <= collapsedLimit,
    `the resting rail must never exceed its fixed maximum of marks: ${JSON.stringify({ restingVisible, collapsedLimit, collapsedGeometry })}`
  )
  assert.ok(collapsedWidth <= 24)
  assert.equal(restingVisible, collapsedLimit, JSON.stringify({ restingVisible, collapsedLimit, collapsedGeometry }))
  assert.ok(collapsedGeometry.listHeight <= 224, JSON.stringify(collapsedGeometry))
  assert.ok(Math.abs(collapsedGeometry.listCenter - collapsedGeometry.railCenter) <= 2, JSON.stringify(collapsedGeometry))
  assert.ok(collapsedGeometry.maxMarkGap <= 24, JSON.stringify(collapsedGeometry))
  assert.equal(
    await panel.locator('.knote-agent-question-label').first().evaluate((element) => getComputedStyle(element).display),
    'none',
    'question labels must stay hidden until the rail is hovered'
  )

  if (captureDir) {
    await panel.screenshot({ path: path.join(captureDir, 'agent-question-rail-collapsed.png') })
  }

  const expectedExpandedWidth = await rail.evaluate((element) => (
    Math.min(216, Math.max(0, (element.parentElement?.getBoundingClientRect().width || 0) - 14))
  ))
  await rail.hover()
  await waitUntil(
    async () => (await rail.getAttribute('data-expanded')) === 'true',
    { timeout: 2_000, message: 'the question rail did not expand on hover' }
  )
  assert.equal(
    await rail.evaluate((element) => element.classList.contains('is-user-scrolling')),
    false,
    'hover expansion alone must not reveal the scrollbar'
  )
  await waitUntil(
    async () => (
      (await rail.evaluate((element) => element.getBoundingClientRect().width)) >= expectedExpandedWidth - 3
    ),
    { timeout: 2_000, message: 'the hovered question rail did not visibly widen' }
  )
  const questionTicks = panel.getByTestId('agent-question-quick')
  assert.equal(await questionTicks.count(), prompts.length)
  assert.notEqual(
    await panel.locator('.knote-agent-question-label').first().evaluate((element) => getComputedStyle(element).display),
    'none'
  )
  const expandedGeometry = await rail.evaluate((element) => {
    const list = element.querySelector('.knote-agent-question-rail-list')
    const button = element.querySelector('.knote-agent-question-tick')
    const label = element.querySelector('.knote-agent-question-label')
    return {
      railWidth: element.getBoundingClientRect().width,
      listWidth: list?.getBoundingClientRect().width || 0,
      buttonWidth: button?.getBoundingClientRect().width || 0,
      labelWidth: label?.getBoundingClientRect().width || 0
    }
  })
  assert.ok(Math.abs(expandedGeometry.railWidth - expectedExpandedWidth) <= 3, JSON.stringify({ expandedGeometry, expectedExpandedWidth }))
  assert.ok(Math.abs(expandedGeometry.listWidth - expectedExpandedWidth) <= 3, JSON.stringify({ expandedGeometry, expectedExpandedWidth }))
  assert.ok(expandedGeometry.buttonWidth > 160, JSON.stringify(expandedGeometry))
  assert.ok(expandedGeometry.labelWidth > 100, JSON.stringify(expandedGeometry))
  assert.equal(
    await rail.evaluate((element) => element.classList.contains('is-user-scrolling')),
    false,
    'the scrollbar must remain hidden after the width transition settles'
  )
  const hiddenScrollbar = await railList.evaluate((element) => ({
    scrollbarColor: getComputedStyle(element).scrollbarColor,
    thumbColor: getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor
  }))
  assert.ok(
    hiddenScrollbar.scrollbarColor.startsWith('rgba(0, 0, 0, 0)') ||
      hiddenScrollbar.scrollbarColor.startsWith('transparent'),
    JSON.stringify(hiddenScrollbar)
  )
  assert.ok(
    hiddenScrollbar.thumbColor === 'rgba(0, 0, 0, 0)' ||
      hiddenScrollbar.thumbColor === 'transparent',
    JSON.stringify(hiddenScrollbar)
  )
  if (captureDir) {
    await panel.screenshot({ path: path.join(captureDir, 'agent-question-rail-expanded-initial.png') })
  }
  const wheelBurst = await railList.evaluate(async (element) => {
    const buttonCountBefore = element.querySelectorAll('[data-testid="agent-question-quick"]').length
    const descendantCountBefore = element.querySelectorAll('*').length
    const longTasks = []
    const observer = typeof PerformanceObserver === 'function'
      ? new PerformanceObserver((list) => {
          longTasks.push(...list.getEntries().map((entry) => entry.duration))
        })
      : null
    try {
      observer?.observe({ type: 'longtask', buffered: false })
    } catch {
      // Older runtimes may not expose the longtask entry type.
    }
    const started = performance.now()
    for (let index = 0; index < 250; index += 1) {
      element.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -1,
        bubbles: true,
        cancelable: true
      }))
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    observer?.disconnect()
    return {
      elapsed: performance.now() - started,
      longestTask: longTasks.length ? Math.max(...longTasks) : 0,
      buttonCountBefore,
      buttonCountAfter: element.querySelectorAll('[data-testid="agent-question-quick"]').length,
      descendantCountBefore,
      descendantCountAfter: element.querySelectorAll('*').length
    }
  })
  assert.ok(wheelBurst.elapsed < 375, JSON.stringify(wheelBurst))
  assert.ok(wheelBurst.longestTask < 250, JSON.stringify(wheelBurst))
  assert.equal(wheelBurst.buttonCountAfter, wheelBurst.buttonCountBefore)
  assert.equal(wheelBurst.descendantCountAfter, wheelBurst.descendantCountBefore)
  t.diagnostic(
    `question rail wheel burst: ${wheelBurst.elapsed.toFixed(2)}ms total, ` +
      `${wheelBurst.longestTask.toFixed(2)}ms longest task, ` +
      `${wheelBurst.buttonCountAfter} buttons`
  )
  await waitUntil(
    async () => rail.evaluate((element) => !element.classList.contains('is-user-scrolling')),
    { timeout: 2_000, message: 'the stress-test scrollbar did not return to rest' }
  )
  await railList.hover()
  await waitUntil(
    async () => (await rail.getAttribute('data-expanded')) === 'true',
    { timeout: 2_000, message: 'the expanded list lost hover before scrolling' }
  )
  for (let index = 0; index < prompts.length; index += 1) {
    assert.equal(await questionTicks.nth(index).getAttribute('title'), prompts[index])
  }

  const railScroll = await railList.evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY
  }))
  assert.ok(railScroll.scrollHeight > railScroll.clientHeight, 'the expanded question list must be vertically scrollable')
  assert.ok(railScroll.scrollTop > 0)
  assert.equal(railScroll.overflowY, 'auto')
  const chatBeforeRailWheel = await messageScroller.evaluate((element) => element.scrollTop)
  await page.mouse.wheel(0, -180)
  await waitUntil(
    async () => rail.evaluate((element) => element.classList.contains('is-user-scrolling')),
    { timeout: 1_000, message: 'the scrollbar did not appear during real wheel input' }
  )
  await waitUntil(
    async () => (await railList.evaluate((element) => element.scrollTop)) < railScroll.scrollTop,
    { timeout: 2_000, message: 'mouse-wheel input did not scroll the expanded question list' }
  )
  await waitUntil(
    async () => rail.evaluate((element) => !element.classList.contains('is-user-scrolling')),
    { timeout: 2_000, message: 'the scrollbar did not fade after scrolling stopped' }
  )
  assert.equal(await rail.getAttribute('data-expanded'), 'true', 'scrolling inside the rail must keep it expanded')
  assert.equal(
    await messageScroller.evaluate((element) => element.scrollTop),
    chatBeforeRailWheel,
    'question-list wheel input must not leak into the chat scroller'
  )

  const visibleTarget = await railList.evaluate((element) => {
    const viewport = element.getBoundingClientRect()
    const buttons = [...element.querySelectorAll('[data-testid="agent-question-quick"]')]
    const button = buttons.find((candidate) => {
      const rect = candidate.getBoundingClientRect()
      return candidate.getAttribute('aria-current') !== 'true' &&
        rect.top >= viewport.top + 1 &&
        rect.bottom <= viewport.bottom - 1
    })
    return button && {
      order: buttons.indexOf(button),
      messageIndex: Number(button.dataset.messageIndex)
    }
  })
  assert.ok(visibleTarget)
  const targetTick = questionTicks.nth(visibleTarget.order)
  const railTopBeforeClick = await railList.evaluate((element) => element.scrollTop)
  const before = await messageScroller.evaluate((element) => element.scrollTop)
  await targetTick.click()
  assert.equal(await rail.getAttribute('data-expanded'), 'true', 'clicking a question must not collapse the hovered rail')
  await waitUntil(
    async () => panel.evaluate((element, messageIndex) => {
      const scroller = element.querySelector('.knote-agent-message-list')
      const row = element.querySelector(`[data-chat-message-index="${messageIndex}"]`)
      if (!scroller || !row) return false
      const viewport = scroller.getBoundingClientRect()
      const target = row.getBoundingClientRect()
      return target.top >= viewport.top - 2 && target.top < viewport.bottom
    }, visibleTarget.messageIndex),
    { timeout: 3_000, message: 'the selected question did not become visible after quick navigation' }
  )
  assert.ok(
    Math.abs((await railList.evaluate((element) => element.scrollTop)) - railTopBeforeClick) <= 2,
    'clicking a currently visible question must preserve the hovered list position'
  )
  const afterTarget = await messageScroller.evaluate((element) => element.scrollTop)
  assert.ok(afterTarget < before, 'an earlier visible question should scroll the chat upward')
  assert.match(await targetTick.getAttribute('class'), /is-active/)
  const targetVisible = await panel.evaluate((element, messageIndex) => {
    const scroller = element.querySelector('.knote-agent-message-list')
    const row = element.querySelector(`[data-chat-message-index="${messageIndex}"]`)
    if (!scroller || !row) return false
    const viewport = scroller.getBoundingClientRect()
    const target = row.getBoundingClientRect()
    return target.top >= viewport.top - 2 && target.top < viewport.bottom
  }, visibleTarget.messageIndex)
  assert.equal(targetVisible, true)

  await questionTicks.last().click()
  assert.equal(await rail.getAttribute('data-expanded'), 'true')
  await waitUntil(
    async () => (
      (await messageScroller.evaluate((element) => element.scrollTop)) > afterTarget &&
      /is-active/.test(await questionTicks.last().getAttribute('class') || '')
    ),
    { timeout: 3_000, message: 'the last question tick did not scroll downward' }
  )
  const afterLast = await messageScroller.evaluate((element) => element.scrollTop)
  assert.ok(afterLast > afterTarget, 'the last question tick should scroll downward')
  assert.match(await questionTicks.last().getAttribute('class'), /is-active/)

  const auroraBefore = await panel.evaluate((element) => {
    const style = getComputedStyle(element, '::before')
    return {
      name: style.animationName,
      state: style.animationPlayState,
      transform: style.transform,
      opacity: style.opacity
    }
  })
  assert.match(auroraBefore.name, /agentAurora/)
  assert.equal(auroraBefore.state, 'running')
  await page.waitForTimeout(1250)
  const auroraAfter = await panel.evaluate((element) => {
    const style = getComputedStyle(element, '::before')
    return { transform: style.transform, opacity: style.opacity }
  })
  assert.notDeepEqual(auroraAfter, {
    transform: auroraBefore.transform,
    opacity: auroraBefore.opacity
  }, 'the aurora should drift slowly instead of remaining static')

  if (captureDir) {
    await panel.screenshot({ path: path.join(captureDir, 'agent-question-rail.png') })
  }

  await panel.getByTestId('agent-input').hover()
  await waitUntil(
    async () => (await rail.getAttribute('data-expanded')) === 'false',
    { timeout: 2_000, message: 'the question rail did not collapse after the pointer left' }
  )
  await waitUntil(
    async () => (await rail.evaluate((element) => element.getBoundingClientRect().width)) <= 24,
    { timeout: 2_000, message: 'the question rail did not finish collapsing' }
  )
  const collapsedVisibleAgain = await visibleQuestionCount()
  assert.ok(collapsedVisibleAgain > 1 && collapsedVisibleAgain <= collapsedLimit)
  assert.ok((await rail.evaluate((element) => element.getBoundingClientRect().width)) <= 24)
  assert.equal(
    await panel.locator('.knote-agent-question-label').first().evaluate((element) => getComputedStyle(element).display),
    'none'
  )

  await panel.getByTestId('agent-session-toggle').click()
  const popover = panel.getByTestId('agent-session-popover')
  await popover.waitFor({ state: 'visible' })
  assert.equal(await popover.getByTestId('agent-session-quick').count(), 0)
  await panel.getByTestId('agent-session-toggle').click()

  await panel.getByTestId('agent-settings-toggle').click()
  const settings = panel.getByTestId('agent-settings')
  await settings.waitFor({ state: 'visible' })
  assert.equal(await settings.getByTestId('agent-settings-quick').count(), 0)
  await questionTicks.first().waitFor({ state: 'hidden' })
  assert.equal(await panel.evaluate((element) => element.scrollLeft), 0)

  if (captureDir) {
    await panel.screenshot({ path: path.join(captureDir, 'agent-settings.png') })
  }

  await panel.getByTestId('agent-settings-toggle').click()
  await panel.getByTestId('agent-new-session').click()
  assert.equal(await panel.getByTestId('agent-question-quick').count(), 0)
  await sendPrompt(panel, 'NEW_CHAT_ONLY_1 当前会话的第一个问题')
  await panel.getByText('E2E_STUB_UNHANDLED', { exact: true }).last().waitFor()
  assert.equal(await panel.getByTestId('agent-question-quick').count(), 0)
  await sendPrompt(panel, 'NEW_CHAT_ONLY_2 当前会话的第二个问题')
  await panel.getByText('E2E_STUB_UNHANDLED', { exact: true }).last().waitFor()
  const newChatTicks = panel.getByTestId('agent-question-quick')
  assert.equal(await newChatTicks.count(), 2)
  assert.match(await newChatTicks.first().getAttribute('title'), /NEW_CHAT_ONLY_1/)
  assert.match(await newChatTicks.last().getAttribute('title'), /NEW_CHAT_ONLY_2/)
  const compactRail = panel.getByTestId('agent-question-rail')
  const compactRailList = panel.getByTestId('agent-question-rail-list')
  await compactRail.hover()
  await waitUntil(
    async () => (await compactRail.getAttribute('data-expanded')) === 'true',
    { timeout: 2_000, message: 'the two-question rail did not expand on hover' }
  )
  const compactGeometry = await compactRailList.evaluate((element) => {
    const style = getComputedStyle(element)
    const buttons = [...element.querySelectorAll('[data-testid="agent-question-quick"]')]
    const first = buttons[0]?.getBoundingClientRect()
    const last = buttons.at(-1)?.getBoundingClientRect()
    const contentHeight = first && last ? last.bottom - first.top : 0
    const chromeHeight = [
      style.paddingTop,
      style.paddingBottom,
      style.borderTopWidth,
      style.borderBottomWidth
    ].reduce((sum, value) => sum + Number.parseFloat(value || '0'), 0)
    return {
      height: element.getBoundingClientRect().height,
      expectedHeight: contentHeight + chromeHeight,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    }
  })
  assert.ok(Math.abs(compactGeometry.height - compactGeometry.expectedHeight) <= 2, JSON.stringify(compactGeometry))
  assert.ok(compactGeometry.height <= 100, JSON.stringify(compactGeometry))
  assert.ok(compactGeometry.scrollHeight <= compactGeometry.clientHeight + 1, JSON.stringify(compactGeometry))
})

test('document paste, single-file context menu and Agent editing stay isolated', async (t) => {
  const { page, panel, workspace } = await launchFixture(t)
  // Deterministically arm the historical startup race: a saved folder replay
  // is scheduled 300ms after this reload, then an explicit file open and paste
  // must win permanently. The old implementation cleared the paste when the
  // delayed saved.active navigation arrived.
  await page.evaluate((folder) => {
    localStorage.setItem('knote-session', JSON.stringify({
      open: [{ type: 'folder', path: folder }],
      active: `folder:${folder}`
    }))
  }, workspace)
  await page.reload({ waitUntil: 'commit', timeout: 90_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
  // The shared fixture opens a folder workspace and intentionally shows its
  // "choose a file" shield. Open the path-backed document before exercising
  // the editor so the test uses the same single-file state as Explorer/file
  // association launches instead of force-clicking through an overlay.
  const target = path.join(workspace, 'keep.md')
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
  const singleRow = page.getByTestId('single-file-row')
  await singleRow.waitFor({ state: 'visible', timeout: 10_000 })
  const editor = page.locator('.ProseMirror').first()
  await editor.waitFor({ state: 'visible' })

  // Reproduce the exact two-line formatted Markdown reported by the user.
  // It must remain two adjacent visual rows: never an empty paragraph/row
  // between them, while both strong spans still parse as formatting.
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  const exactMarkdown = 'RAL-Bench 主要研究：**基础 LLM 能否一次性生成满足功能与五类非功能属性的 Python 应用？**\r\nMAGIC-Bench 主要研究：**具有规划、文件编辑、Shell、构建和迭代调试能力的 Agent-System，能否完成跨语言项目重构；主干模型与 Agent Harness 分别如何影响七个质量维度？"**\r\n\r\n'
  const pasteResult = await editor.evaluate((element, markdown) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', markdown)
    clipboardData.setData(
      'text/html',
      markdown
        .replace(/\r\n\r\n$/, '')
        .split(/\r\n/)
        .map((line) => `<p>${line}</p>`)
        .join('')
    )
    const propagated = element.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData
    }))
    return { propagated, html: element.innerHTML, text: element.innerText }
  }, exactMarkdown)
  assert.equal(pasteResult.propagated, false, `ProseMirror should consume the Markdown paste: ${JSON.stringify(pasteResult)}`)
  await page.waitForTimeout(700)
  const pasted = await editor.evaluate((element) => ({
    text: element.innerText,
    html: element.innerHTML,
    paragraphs: element.querySelectorAll('p').length,
    breaks: element.querySelectorAll('br').length,
    strong: element.querySelectorAll('strong').length
  }))
  assert.equal(
    pasted.text.trim(),
    exactMarkdown.replace(/\r\n/g, '\n').trim().replace(/\*\*/g, ''),
    JSON.stringify({ pasteResult, pasted })
  )
  assert.equal(pasted.paragraphs, 1, JSON.stringify(pasted))
  assert.equal(pasted.breaks, 1, JSON.stringify(pasted))
  assert.equal(pasted.strong, 2, JSON.stringify(pasted))

  // The regression originally surfaced after serialization/reopen as well as
  // immediately after paste. Verify the actual Markdown file, then reload the
  // complete renderer and parse that saved file again.
  await waitUntil(() => {
    const saved = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
    return saved.includes('RAL-Bench') && saved.includes('MAGIC-Bench')
  }, { timeout: 12_000, message: 'formatted paste was not saved to disk' })
  const savedPaste = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
  assert.doesNotMatch(savedPaste, /\n[ \t]*\n/, savedPaste)
  assert.equal((savedPaste.match(/\*\*/g) || []).length, 4, savedPaste)

  await page.reload({ waitUntil: 'commit', timeout: 90_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForFunction(() => document.querySelector('.ProseMirror')?.innerText.includes('MAGIC-Bench'))
  const reopenedPaste = await editor.evaluate((element) => ({
    text: element.innerText,
    paragraphs: element.querySelectorAll('p').length,
    breaks: element.querySelectorAll('br').length,
    strong: element.querySelectorAll('strong').length
  }))
  assert.equal(reopenedPaste.paragraphs, 1, JSON.stringify(reopenedPaste))
  assert.equal(reopenedPaste.breaks, 1, JSON.stringify(reopenedPaste))
  assert.equal(reopenedPaste.strong, 2, JSON.stringify(reopenedPaste))

  // Shift+Paste is explicitly plain text. The dual-MIME Markdown-source
  // override must not steal that gesture and re-apply formatting.
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  await editor.evaluate((element) => {
    // Synthetic ClipboardEvent has no modifier fields. Drive the same
    // keydown/paste/keyup sequence ProseMirror observes for native Shift+Paste.
    element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'v', code: 'KeyV', keyCode: 86, which: 86,
      shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true
    }))
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', '**literal markdown**')
    clipboardData.setData('text/html', '<p>**literal markdown**</p>')
    element.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData
    }))
    element.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'v', code: 'KeyV', keyCode: 86, which: 86,
      shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true
    }))
  })
  await page.waitForTimeout(300)
  const shiftedPaste = await editor.evaluate((element) => ({
    text: element.innerText,
    html: element.innerHTML,
    strong: element.querySelectorAll('strong').length
  }))
  assert.equal(shiftedPaste.text.trim(), '**literal markdown**', JSON.stringify(shiftedPaste))
  assert.equal(shiftedPaste.strong, 0, JSON.stringify(shiftedPaste))

  // Native textarea undo/redo/delete must remain inside Agent and must not
  // focus or mutate the document behind it.
  const documentBefore = await editor.innerHTML()
  const input = panel.getByTestId('agent-input')
  await input.click()
  await input.fill('alpha')
  await input.press('End')
  await input.type(' beta')
  await input.press('Control+z')
  assert.equal(await input.inputValue(), 'alpha')
  await input.press('Control+y')
  assert.equal(await input.inputValue(), 'alpha beta')
  await input.press('Backspace')
  assert.equal(await input.inputValue(), 'alpha bet')
  await input.press('Delete')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'agent-input')
  assert.equal(await editor.innerHTML(), documentBefore)

  // A path-opened single file uses a dedicated sidebar row; it must expose the
  // same document menu as ordinary file-tree rows.
  assert.equal(await singleRow.evaluate((element) => getComputedStyle(element).cursor), 'pointer')
  await singleRow.click({ button: 'right' })
  const contextMenu = page.locator('.knote-ctxmenu')
  await contextMenu.waitFor({ state: 'visible' })
  assert.ok(await contextMenu.getByRole('button').count() >= 1)
})

test('image center and right alignment survive autosave and full renderer reloads', async (t) => {
  const { page, workspace } = await launchFixture(t)
  const target = path.join(workspace, 'align.md')
  const openAlignedDocument = async () => {
    assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
    await page.getByTestId('current-file-name').filter({ hasText: 'align.md' }).waitFor({ timeout: 10_000 })
    const image = page.locator('.ProseMirror img[alt="pixel"]').first()
    await image.waitFor({ state: 'visible', timeout: 10_000 })
    await waitUntil(
      async () => String(await image.getAttribute('src') || '').startsWith('data:image/'),
      { timeout: 10_000, message: 'relative/assets image did not finish resolving for display' }
    )
    return image
  }
  const reloadAndOpen = async () => {
    await page.reload({ waitUntil: 'commit', timeout: 90_000 })
    await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
    const other = path.join(workspace, 'keep.md')
    assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), other), true)
    await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor({ timeout: 10_000 })
    await page.locator('.ProseMirror').first().getByText('Keep', { exact: true }).waitFor({ timeout: 10_000 })
    return openAlignedDocument()
  }
  const selectAndApplyAlignment = async (targetImage, buttonTestId) => {
    await targetImage.click({ force: true })
    const button = page.getByTestId(buttonTestId)
    await button.waitFor({ state: 'visible', timeout: 5_000 })
    await button.evaluate((element) => element.click())
  }

  let image = await openAlignedDocument()
  await selectAndApplyAlignment(image, 'image-align-center')
  await waitUntil(
    async () => image.evaluate((element) => element.style.marginLeft === 'auto' && element.style.marginRight === 'auto'),
    { timeout: 3_000, message: 'center command never reached the live image node' }
  )
  await waitUntil(
    async () => /margin-left:auto;margin-right:auto/.test(fs.readFileSync(target, 'utf8')),
    { timeout: 12_000, message: 'center alignment never reached the Markdown file' }
  )
  let disk = fs.readFileSync(target, 'utf8')
  assert.match(disk, /<img\b[^>]*style="[^"]*margin-left:auto;margin-right:auto[^"]*"/)
  assert.doesNotMatch(disk, /:::\s*align/)

  image = await reloadAndOpen()
  assert.deepEqual(await image.evaluate((element) => ({
    marginLeft: element.style.marginLeft,
    marginRight: element.style.marginRight
  })), { marginLeft: 'auto', marginRight: 'auto' })

  await selectAndApplyAlignment(image, 'image-align-right')
  await waitUntil(
    async () => {
      const value = fs.readFileSync(target, 'utf8')
      return /margin-left:auto/.test(value) && !/margin-right:auto/.test(value)
    },
    { timeout: 12_000, message: 'right alignment never replaced center alignment on disk' }
  )
  disk = fs.readFileSync(target, 'utf8')
  assert.match(disk, /<img\b[^>]*style="[^"]*margin-left:auto[^"]*"/)
  assert.doesNotMatch(disk, /margin-right:auto|:::\s*align/)

  image = await reloadAndOpen()
  assert.deepEqual(await image.evaluate((element) => ({
    marginLeft: element.style.marginLeft,
    marginRight: element.style.marginRight
  })), { marginLeft: 'auto', marginRight: '' })
})

test('a slower earlier tree-file read cannot overwrite the later selection', async (t) => {
  const { page, workspace, electronApp } = await launchFixture(t)
  await installTreeFileReadRaceGate(electronApp, workspace)

  await page.getByText('keep.md', { exact: true }).first().click()
  await page.waitForTimeout(25)
  await page.getByText('delete-me.md', { exact: true }).first().click()

  const editor = page.locator('.ProseMirror').first()
  await editor.waitFor({ state: 'visible' })
  await page.waitForTimeout(800)
  assert.match((await editor.innerText()).trim(), /Delete me/)
  assert.doesNotMatch((await editor.innerText()).trim(), /Keep/)
  assert.equal(await page.getByTestId('current-file-name').innerText(), 'delete-me.md')
})

test('a slower document preview cannot clear the newer Markdown selection', async (t) => {
  const { page, workspace, electronApp } = await launchFixture(t)
  await installPreviewReadRaceGate(electronApp, workspace)

  await page.getByText('slow.txt', { exact: true }).first().click()
  await page.waitForTimeout(25)
  await page.getByText('delete-me.md', { exact: true }).first().click()

  const editor = page.locator('.ProseMirror').first()
  await editor.waitFor({ state: 'visible' })
  await page.waitForTimeout(800)
  assert.equal(await page.getByTestId('current-file-name').innerText(), 'delete-me.md')
  assert.match((await editor.innerText()).trim(), /Delete me/)
  assert.doesNotMatch((await editor.innerText()).trim(), /Slow preview/)
})

test('a late foreground open event cannot overwrite the user\'s newer file intent', async (t) => {
  const { page, workspace, electronApp } = await launchFixture(t)
  const olderPath = path.join(workspace, 'keep.md')
  const newerPath = path.join(workspace, 'delete-me.md')

  // Reproduce an async main-process read finishing out of order: B (sequence
  // 2) is delivered first, then the older A (sequence 1) arrives late.
  await electronApp.evaluate(({ BrowserWindow }, payload) => {
    const target = BrowserWindow.getAllWindows()[0]
    target.webContents.send('knote:open-file', {
      path: payload.newerPath,
      name: 'delete-me.md',
      data: '# Delete me',
      requestId: '',
      openSequence: 2
    })
    setTimeout(() => {
      if (!target.isDestroyed()) {
        target.webContents.send('knote:open-file', {
          path: payload.olderPath,
          name: 'keep.md',
          data: '# Keep',
          requestId: '',
          openSequence: 1
        })
      }
    }, 80)
  }, { olderPath, newerPath })

  const editor = page.locator('.ProseMirror').first()
  await page.getByTestId('current-file-name').waitFor({ state: 'visible' })
  await page.waitForTimeout(500)
  assert.equal(await page.getByTestId('current-file-name').innerText(), 'delete-me.md')
  assert.match((await editor.innerText()).trim(), /Delete me/)
  assert.doesNotMatch((await editor.innerText()).trim(), /Keep/)
})

test('main-process async file reads preserve the newest open intent', async (t) => {
  const { page, workspace, workspaceB, electronApp } = await launchFixture(t)
  const olderPath = path.join(workspace, 'keep.md')
  const newerPath = path.join(workspaceB, 'b-only.md')
  await installMainOpenReadRaceGate(electronApp, olderPath)

  const reopened = await page.evaluate(async ({ olderPath: older, newerPath: newer }) => {
    const first = window.knoteDesktop.reopen('file', older)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = window.knoteDesktop.reopen('file', newer)
    return await Promise.all([first, second])
  }, { olderPath, newerPath })
  assert.deepEqual(reopened, [true, true])

  await page.waitForTimeout(850)
  assert.equal(await page.getByTestId('current-file-name').innerText(), 'b-only.md')
  assert.match((await page.locator('.ProseMirror').first().innerText()).trim(), /B only/)
})

test('an in-flight session folder restore cannot replace a foreground file', async (t) => {
  const { page, workspace, workspaceB, electronApp } = await launchFixture(t)
  await installSessionFolderListRaceGate(electronApp, workspace)
  await page.evaluate((folder) => {
    localStorage.setItem('knote-session', JSON.stringify({
      open: [{ type: 'folder', path: folder }],
      active: `folder:${folder}`
    }))
  }, workspace)
  await page.reload({ waitUntil: 'commit', timeout: 90_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
  await waitUntil(
    () => electronApp.evaluate(() => Number(globalThis.__knoteE2eSessionFolderReads || 0) > 0),
    { timeout: 10_000, message: 'session folder build never entered the delayed fs-list handler' }
  )

  const target = path.join(workspaceB, 'b-only.md')
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
  await page.waitForTimeout(1000)
  assert.equal(await page.getByTestId('current-file-name').innerText(), 'b-only.md')
  assert.match((await page.locator('.ProseMirror').first().innerText()).trim(), /B only/)
})

test('a delayed history restore cannot write document A into document B', async (t) => {
  const { page, workspace, workspaceB, electronApp } = await launchFixture(t)
  const fileA = path.join(workspace, 'keep.md')
  const fileB = path.join(workspaceB, 'b-only.md')
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), fileA), true)
  await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor()
  const oldSnapshot = await page.evaluate(async ({ identity, markdown }) => {
    return await window.knoteDesktop.historyAdd(identity, markdown, Date.now() - 60_000, 'e2e old A')
  }, { identity: `file:${fileA}`, markdown: '# OLD A HISTORY' })
  const oldSnapshotId = oldSnapshot?.id
  assert.ok(oldSnapshotId)

  await page.getByTestId('actions-menu').click()
  await page.getByTestId('open-history').click()
  const modal = page.getByTestId('history-modal')
  await modal.waitFor({ state: 'visible' })
  const historyItems = modal.locator('.knote-history-item')
  await waitUntil(async () => await historyItems.count() >= 2, { message: 'history list did not contain current + old snapshot' })
  await modal.locator(`.knote-history-item[data-snapshot-id="${oldSnapshotId}"]`).click()
  await modal.locator('.knote-history-content').getByText('OLD A HISTORY', { exact: false }).waitFor()

  await installHistoryReadRaceGate(electronApp, '# OLD A HISTORY')
  await modal.getByTestId('history-restore').click()
  await waitUntil(
    () => electronApp.evaluate(() => Number(globalThis.__knoteE2eHistoryReads || 0) > 0),
    { message: 'history restore did not enter delayed history-get' }
  )
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), fileB), true)
  await page.waitForTimeout(900)

  assert.equal(await page.getByTestId('current-file-name').innerText(), 'b-only.md')
  assert.match((await page.locator('.ProseMirror').first().innerText()).trim(), /B only/)
  assert.doesNotMatch(fs.readFileSync(fileB, 'utf8'), /OLD A HISTORY/)
})

test('an image asset write started in A cannot mutate B after a file switch', async (t) => {
  const { page, workspace, workspaceB, electronApp } = await launchFixture(t)
  const fileA = path.join(workspace, 'keep.md')
  const fileB = path.join(workspaceB, 'b-only.md')
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), fileA), true)
  await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor()
  await installImageWriteRaceGate(electronApp, [workspace, workspaceB])

  const editor = page.locator('.ProseMirror').first()
  const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const pasteImage = async (name) => editor.evaluate((element, payload) => {
    const binary = atob(payload.base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const file = new File([bytes], payload.name, { type: 'image/png' })
    const clipboardData = new DataTransfer()
    clipboardData.items.add(file)
    element.focus()
    element.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData
    }))
  }, { name, base64: onePixelPng })
  await editor.click()
  await pasteImage('first.png')
  await waitUntil(async () => await editor.locator('img').count() >= 1, { message: 'first pasted image did not render' })
  await page.keyboard.press('ArrowRight')
  await pasteImage('second.png')
  await waitUntil(async () => await editor.locator('img').count() >= 2, { message: 'second pasted image did not render' })
  await waitUntil(
    () => electronApp.evaluate(() => Array.isArray(globalThis.__knoteE2eImageWrites) && globalThis.__knoteE2eImageWrites.length > 0),
    { timeout: 10_000, message: 'asset migration never started' }
  )

  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), fileB), true)
  await page.waitForTimeout(1100)
  const writes = await electronApp.evaluate(() => [...(globalThis.__knoteE2eImageWrites || [])])
  assert.ok(writes.length >= 1)
  for (const written of writes) {
    const relative = path.relative(path.resolve(workspace), path.resolve(written))
    assert.ok(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), written)
  }
  assert.equal(fs.existsSync(path.join(workspaceB, 'assets')), false)
  assert.equal(await page.getByTestId('current-file-name').innerText(), 'b-only.md')
  assert.match((await editor.innerText()).trim(), /B only/)
})

test('stale progressive chunks cannot overwrite an edit made during a same-file reopen', async (t) => {
  const { page, workspace, electronApp } = await launchFixture(t)
  const targetName = 'progressive-read-race.md'
  const target = path.join(workspace, targetName)
  const byteSize = 400 * 1024
  const row = `${'stale-on-disk '.repeat(28)}\n`
  const staleDisk = (`# STALE_PROGRESSIVE_DISK_CONTENT\n\n${row.repeat(Math.ceil(byteSize / row.length) + 1)}`).slice(0, byteSize)
  assert.equal(Buffer.byteLength(staleDisk), byteSize)
  assert.ok(byteSize >= 384 * 1024)
  fs.writeFileSync(target, staleDisk)

  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
  await page.getByTestId('current-file-name').filter({ hasText: targetName }).waitFor({ timeout: 15_000 })
  await page.getByTestId('large-document-loading').waitFor({ state: 'hidden', timeout: 15_000 })
  await waitUntil(async () => {
    const state = await page.evaluate(() => window.__knoteDebug.documentPersistence())
    return !state.ahead && !state.autoSaveDirty && !state.saving
  }, {
    timeout: 15_000,
    message: 'the initial progressive document never reached a saved baseline'
  })
  const diskStat = await page.evaluate((file) => window.knoteDesktop.fsStat(file), target)
  assert.equal(diskStat?.ok, true)
  assert.equal(diskStat?.size, byteSize)
  const tabCount = await page.locator('.knote-tab').count()
  const readGate = await installProgressiveReadRaceGate(electronApp, target)
  let released = false

  try {
    assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
    try {
      await waitUntil(async () => (await readGate.status())?.waiting === true, {
        timeout: 10_000,
        message: 'the progressive same-file read never reached its held first chunk'
      })
    } catch (error) {
      error.message += `: ${JSON.stringify(await readGate.status())}`
      throw error
    }
    const blocked = await readGate.status()
    assert.equal(blocked.returned, 0)
    assert.deepEqual(blocked.calls.map((call) => call.offset), [0])
    assert.equal(blocked.calls[0].expectedSize, byteSize)

    await page.locator('.knote-view-toggle button').nth(1).click()
    const source = page.getByTestId('markdown-source-editor')
    await source.waitFor({ state: 'visible' })
    const editMarker = ' LIVE_EDIT_DURING_PROGRESSIVE_READ'
    await source.focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(editMarker)
    assert.equal(await source.evaluate((element, marker) => element.value.includes(marker), editMarker), true)
    assert.equal(await page.evaluate((marker) => window.__knoteDebug.getContent().includes(marker), editMarker), true)
    assert.equal(fs.readFileSync(target, 'utf8'), staleDisk)

    assert.equal(await readGate.release(), true)
    released = true
    await waitUntil(async () => {
      const state = await readGate.status()
      return state?.complete && state.returned === state.calls.length
    }, {
      timeout: 10_000,
      message: 'the released progressive read did not return its final chunk'
    })
    const completed = await readGate.status()
    assert.deepEqual(completed.calls.map((call) => call.offset), [0, 256 * 1024])
    assert.equal(completed.returned, 2)
    assert.equal(completed.calls.at(-1).done, true)

    await page.waitForTimeout(300)
    assert.equal(await page.getByTestId('current-file-name').innerText(), targetName)
    assert.equal(await page.locator('.knote-tab').count(), tabCount)
    assert.equal(await source.evaluate((element, marker) => element.value.includes(marker), editMarker), true)
    assert.equal(await page.evaluate((marker) => window.__knoteDebug.getContent().includes(marker), editMarker), true)
    await waitUntil(() => fs.readFileSync(target, 'utf8').includes(editMarker), {
      timeout: 15_000,
      interval: 100,
      message: 'the retained edit was not autosaved'
    })
    assert.equal(fs.readFileSync(target, 'utf8').split(editMarker).length - 1, 1)
  } finally {
    if (!released) await readGate.release().catch(() => false)
  }
})

test('a failed save remains in editor memory when the same file is reopened', async (t) => {
  const { page, workspace, electronApp } = await launchFixture(t)
  const target = path.join(workspace, 'keep.md')
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
  await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor()
  await installFailingDocumentSaveGate(electronApp)

  const editor = page.locator('.ProseMirror').first()
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('UNSAVED-E2E-CONTENT')
  await waitUntil(
    () => electronApp.evaluate(() => Number(globalThis.__knoteE2eFailedSaves || 0) > 0),
    { timeout: 10_000, message: 'autosave did not enter the failing save handler' }
  )
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
  await page.waitForTimeout(900)
  assert.match(await editor.innerText(), /UNSAVED-E2E-CONTENT/)
  assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /UNSAVED-E2E-CONTENT/)
})

test('clicking the active document cancels an older slow tree-file intent', async (t) => {
  const { page, workspace, electronApp } = await launchFixture(t)
  await installTreeFileReadRaceGate(electronApp, workspace)
  await workspaceTreeRow(page, 'delete-me.md').click()
  await page.getByTestId('current-file-name').filter({ hasText: 'delete-me.md' }).waitFor()
  await workspaceTreeRow(page, 'keep.md').click()
  await waitUntil(
    () => electronApp.evaluate(() => Number(globalThis.__knoteE2eSlowTreeReads || 0) > 0),
    { message: 'slow B never entered the delayed tree-file read' }
  )
  await workspaceTreeRow(page, 'delete-me.md').click()
  await page.waitForTimeout(800)
  assert.equal(await page.getByTestId('current-file-name').innerText(), 'delete-me.md')
  assert.match((await page.locator('.ProseMirror').first().innerText()).trim(), /Delete me/)
})

test('the same physical workspace file cannot be opened in two editable tabs', async (t) => {
  const { page } = await launchFixture(t)
  await page.getByText('delete-me.md', { exact: true }).first().click()
  const initialTabs = await page.locator('.knote-tab').count()

  await page.getByText('keep.md', { exact: true }).first().click({ button: 'right' })
  let contextMenu = page.locator('.knote-ctxmenu')
  await contextMenu.waitFor({ state: 'visible' })
  await contextMenu.getByRole('button').nth(1).click()
  await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor()
  assert.equal(await page.locator('.knote-tab').count(), initialTabs + 1)

  await page.getByText('delete-me.md', { exact: true }).first().click({ button: 'right' })
  contextMenu = page.locator('.knote-ctxmenu')
  await contextMenu.waitFor({ state: 'visible' })
  await contextMenu.getByRole('button').nth(1).click()
  await page.getByTestId('current-file-name').filter({ hasText: 'delete-me.md' }).waitFor()
  assert.equal(await page.locator('.knote-tab').count(), initialTabs + 1)
})

test('file-tree right click survives active/open-background state and directory rows', async (t) => {
  const { page } = await launchFixture(t)
  const menu = page.locator('.knote-ctxmenu')
  const closeMenu = async () => {
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
  }

  const deleteRow = workspaceTreeRow(page, 'delete-me.md')
  const keepRow = workspaceTreeRow(page, 'keep.md')
  const directoryRow = workspaceTreeRow(page, 'notes')

  // Active/open file: the exact state that used to lose the event to the
  // document selection/navigation path.
  await deleteRow.click()
  await page.getByTestId('current-file-name').filter({ hasText: 'delete-me.md' }).waitFor()
  assert.equal(await deleteRow.getAttribute('data-tree-active'), 'true')
  assert.equal(await deleteRow.evaluate((element) => getComputedStyle(element).cursor), 'pointer')
  await deleteRow.click({ button: 'right' })
  await menu.waitFor({ state: 'visible' })
  assert.equal(await menu.getAttribute('data-context-target'), '/delete-me.md')
  assert.ok(await menu.getByRole('button').count() >= 4)
  assert.equal(await page.getByTestId('current-file-name').innerText(), 'delete-me.md')
  await closeMenu()

  // Make keep.md an opened background tab, return to delete-me.md, then use
  // the physical file-tree row rather than the tab pill.
  await keepRow.click({ button: 'right' })
  await menu.waitFor({ state: 'visible' })
  assert.equal(await menu.getAttribute('data-context-target'), '/keep.md')
  await menu.getByRole('button').nth(1).click()
  await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor()
  await deleteRow.click()
  await page.getByTestId('current-file-name').filter({ hasText: 'delete-me.md' }).waitFor()
  assert.equal(await keepRow.getAttribute('data-tree-active'), 'false')
  assert.equal(await keepRow.evaluate((element) => getComputedStyle(element).cursor), 'pointer')
  await keepRow.click({ button: 'right' })
  await menu.waitFor({ state: 'visible' })
  assert.equal(await page.getByTestId('current-file-name').innerText(), 'delete-me.md')
  await closeMenu()

  // Directory rows use the same guarded pointer path but a different menu.
  assert.equal(await directoryRow.getAttribute('data-tree-kind'), 'dir')
  assert.equal(await directoryRow.evaluate((element) => getComputedStyle(element).cursor), 'pointer')
  await directoryRow.click({ button: 'right' })
  await menu.waitFor({ state: 'visible' })
  assert.equal(await menu.getAttribute('data-context-target'), '/notes')
  assert.ok(await menu.getByRole('button').count() >= 5)
  assert.equal(await page.getByTestId('current-file-name').innerText(), 'delete-me.md')
})

test('invalidated post-install navigation cannot disable later auto-save', async (t) => {
  const { page, workspace } = await launchFixture(t)
  const keepPath = path.join(workspace, 'keep.md')
  await page.evaluate(() => window.__knoteDebug.folder.armNavigationInstallRace())
  await workspaceTreeRow(page, 'keep.md').click()
  await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor()

  await page.locator('.knote-view-toggle button').nth(1).click()
  const editor = page.getByTestId('markdown-source-editor')
  await editor.waitFor({ state: 'visible' })
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('POST_RACE_AUTOSAVE')
  await page.waitForFunction(() => window.__knoteDebug.getContent().includes('POST_RACE_AUTOSAVE'))
  await waitUntil(async () => {
    try { return fs.readFileSync(keepPath, 'utf8').includes('POST_RACE_AUTOSAVE') } catch { return false }
  }, {
    timeout: 15_000,
    interval: 100,
    message: 'navigation cleanup race left auto-save suppressed'
  })
})

test('8 MiB documents open and cold-switch with one bounded rich chunk', async (t) => {
  const { page, workspace } = await launchFixture(t)
  const editMarker = 'KNOTE_RICH_CHUNK_EDIT'
  const replacementMarker = 'KNOTE_RICH_CHUNK_REPLACED_WITH_LONGER_TEXT'
  const unit = '# Heading\nalpha beta gamma delta\nplain text\n'
  const large = unit.repeat(Math.ceil((8 * 1024 * 1024) / unit.length)).slice(0, 8 * 1024 * 1024)
  const fileA = path.join(workspace, 'large-a.md')
  const fileB = path.join(workspace, 'large-b.md')
  fs.writeFileSync(fileA, large)
  fs.writeFileSync(fileB, large.replace('# Heading', '# Other'))

  const assertBoundedLargeDom = async (label) => {
    const stats = await page.evaluate(() => {
      const sum = (selector, read) => Array.from(document.querySelectorAll(selector))
        .reduce((total, element) => total + read(element).length, 0)
      return {
        proseMirrorCount: document.querySelectorAll('.ProseMirror').length,
        fullSourceCount: document.querySelectorAll('[data-testid="markdown-source-editor"]').length,
        fullPreviewCount: document.querySelectorAll('[data-testid="markdown-full-preview"]').length,
        largeRichCount: document.querySelectorAll('[data-testid="large-document-rich-chunk"]').length,
        mountedEditorChars:
          sum('[data-testid="markdown-source-editor"]', (element) => element.value || '') +
          sum('[data-testid="markdown-full-preview"]', (element) => element.textContent || '') +
          sum('.ProseMirror', (element) => element.textContent || '')
      }
    })
    assert.equal(stats.proseMirrorCount, 1, `${label}: exactly one TipTap chunk must be mounted`)
    assert.equal(stats.fullSourceCount, 0, `${label}: full-document source textarea must stay unmounted`)
    assert.equal(stats.fullPreviewCount, 0, `${label}: full-document preview must stay unmounted`)
    assert.equal(stats.largeRichCount, 1, `${label}: exactly one chunked rich editor is expected`)
    assert.ok(stats.mountedEditorChars <= 70_000,
      `${label}: mounted editor payload grew to ${stats.mountedEditorChars} characters`)
    return stats
  }

  await page.evaluate(() => {
    globalThis.__knoteLongTasks = []
    globalThis.__knoteLongTaskMarks = [{ label: 'observer-start', at: performance.now() }]
    if (typeof PerformanceObserver === 'function') {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          globalThis.__knoteLongTasks.push({ startTime: entry.startTime, duration: entry.duration })
        }
      })
      try { observer.observe({ entryTypes: ['longtask'] }) } catch { /* unsupported Chromium build */ }
      globalThis.__knoteLongTaskObserver = observer
    }
  })
  const markLongTaskPhase = (label) => page.evaluate((phase) => {
    globalThis.__knoteLongTaskMarks.push({ label: phase, at: performance.now() })
  }, label)

  const openStarted = performance.now()
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), fileA), true)
  await page.getByTestId('current-file-name').filter({ hasText: 'large-a.md' }).waitFor({ timeout: 15_000 })
  await page.getByTestId('large-document-rich-chunk').waitFor({ state: 'visible', timeout: 15_000 })
  const firstOpenMs = performance.now() - openStarted
  await markLongTaskPhase('first-open')
  await assertBoundedLargeDom('first single-pane open')

  const secondStarted = performance.now()
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), fileB), true)
  await page.getByTestId('current-file-name').filter({ hasText: 'large-b.md' }).waitFor({ timeout: 15_000 })
  await page.getByTestId('large-document-rich-chunk').waitFor({ state: 'visible', timeout: 15_000 })
  const secondOpenMs = performance.now() - secondStarted
  await markLongTaskPhase('second-open')

  await waitUntil(async () => {
    const tabs = await page.evaluate(() => window.__knoteDebug?.tabs.list() || [])
    const a = tabs.find((tab) => tab.label === 'large-a.md')
    return !!a && a.resident === false && a.buffered === true &&
      a.signedBuffer === true && a.contentLength === null
  }, { timeout: 15_000, interval: 100, message: '8 MiB background tab was not cooled to disk' })

  const switchStarted = performance.now()
  await page.locator('.knote-tab').filter({ hasText: 'large-a.md' }).click()
  await page.getByTestId('current-file-name').filter({ hasText: 'large-a.md' }).waitFor({ timeout: 15_000 })
  const switchMs = performance.now() - switchStarted
  await markLongTaskPhase('cold-switch')
  const source = page.getByTestId('large-document-rich-chunk').locator('.ProseMirror')
  const pageSelect = page.getByTestId('large-source-page-select')
  await assertBoundedLargeDom('cold-switched single-pane document')
  const lastPage = await pageSelect.locator('option').count() - 1
  assert.ok(lastPage > 0, '8 MiB source should be split across multiple bounded pages')
  await pageSelect.selectOption(String(lastPage))

  // A real single -> split transition must retain the same rich chunk. The
  // ordinary split implementation is intentionally suppressed for huge docs:
  // full textarea and rendered preview stay suppressed; one TipTap remains.
  await page.locator('.knote-view-toggle button').nth(1).click()
  await page.locator('main[data-view-mode="split"][data-large-document-mode="chunked-rich"]')
    .waitFor({ state: 'visible' })
  assert.equal(await pageSelect.inputValue(), String(lastPage), 'view switch reset the active source page')
  const splitDomStats = await assertBoundedLargeDom('split-mode protected source')
  await markLongTaskPhase('split-mode')

  await source.focus()
  await page.keyboard.press('Control+End')
  const inputStarted = performance.now()
  await page.keyboard.insertText(editMarker)
  await page.waitForFunction((marker) => document.querySelector('[data-testid="large-document-rich-chunk"] .ProseMirror')?.textContent.includes(marker), editMarker)
  const inputMs = performance.now() - inputStarted
  await markLongTaskPhase('input')

  // Switch back before auto-save: the exact draft edited in split mode must
  // remain installed, rather than being replaced by stale single-mode state.
  await page.locator('.knote-view-toggle button').nth(0).click()
  await page.locator('main[data-view-mode="single"][data-large-document-mode="chunked-rich"]')
    .waitFor({ state: 'visible' })
  assert.equal((await source.innerText()).includes(editMarker), true, 'split-mode edit was lost on returning to single mode')
  await assertBoundedLargeDom('single mode after split edit')

  // Whole-document replace used to mutate `content` while leaving this page's
  // offsets and draft bound to the old string. A later chunk commit could then
  // splice at stale offsets and corrupt unrelated text.
  await page.keyboard.press('Control+h')
  const findBar = page.locator('.knote-findbar')
  await findBar.waitFor({ state: 'visible' })
  const findInputs = findBar.locator('input')
  await findInputs.nth(0).fill(editMarker)
  await findInputs.nth(1).fill(replacementMarker)
  await findBar.locator('.knote-findbar-row').nth(1).locator('button').last().click()
  await page.waitForFunction((marker) => document.querySelector('[data-testid="large-document-rich-chunk"] .ProseMirror')?.textContent.includes(marker), replacementMarker)
  assert.equal((await source.innerText()).includes(editMarker), false)
  await findBar.locator('.knote-findbar-row').first().locator('button').last().click()
  await assertBoundedLargeDom('whole-document replace after split edit')

  const saveStarted = performance.now()
  await waitUntil(async () => {
    try { return fs.readFileSync(fileA, 'utf8').includes(replacementMarker) } catch { return false }
  }, { timeout: 30_000, interval: 100, message: 'large-document edit was not written to disk' })
  const saveMs = performance.now() - saveStarted
  await markLongTaskPhase('save')
  const savedLarge = fs.readFileSync(fileA, 'utf8')
  assert.ok(savedLarge.includes(replacementMarker), 'saved large document must contain the replacement edit')
  assert.equal(savedLarge.includes(editMarker), false, 'saved large document retained the stale pre-replacement marker')

  const longTaskState = await page.evaluate(() => ({
    tasks: [...(globalThis.__knoteLongTasks || [])],
    marks: [...(globalThis.__knoteLongTaskMarks || [])]
  }))
  const maxLongTaskMs = longTaskState.tasks.length
    ? Math.max(...longTaskState.tasks.map((entry) => entry.duration))
    : 0
  const reloadStarted = performance.now()
  await page.reload({ waitUntil: 'commit', timeout: 90_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), fileA), true)
  await page.getByTestId('current-file-name').filter({ hasText: 'large-a.md' }).waitFor({ timeout: 30_000 })
  await page.getByTestId('large-document-rich-chunk').waitFor({ state: 'visible', timeout: 30_000 })
  const reloadMs = performance.now() - reloadStarted
  await assertBoundedLargeDom('renderer reload and disk reopen')
  const reloadPageSelect = page.getByTestId('large-source-page-select')
  const reloadLastPage = await reloadPageSelect.locator('option').count() - 1
  await reloadPageSelect.selectOption(String(reloadLastPage))
  assert.equal(await page.getByTestId('large-document-rich-chunk').locator('.ProseMirror').innerText().then((value) => value.includes(replacementMarker)), true,
    'large-document edit must survive a renderer reload and disk reopen')

  const openSamples = [firstOpenMs, secondOpenMs].sort((a, b) => a - b)
  const medianOpenMs = (openSamples[0] + openSamples[1]) / 2
  t.diagnostic(`8MiB Electron after paging: open median ${medianOpenMs.toFixed(1)}ms (first ${firstOpenMs.toFixed(1)}, second ${secondOpenMs.toFixed(1)}); cold switch ${switchMs.toFixed(1)}ms; input ${inputMs.toFixed(1)}ms; save ${saveMs.toFixed(1)}ms; reload+reopen ${reloadMs.toFixed(1)}ms; max long task ${maxLongTaskMs.toFixed(1)}ms; split DOM payload ${splitDomStats.mountedEditorChars} chars, ProseMirror ${splitDomStats.proseMirrorCount}`)
  t.diagnostic(`8MiB long-task trace: ${JSON.stringify(longTaskState)}`)
  assert.ok(firstOpenMs < 3_000, `first open took ${firstOpenMs.toFixed(1)}ms`)
  assert.ok(secondOpenMs < 3_000, `second open took ${secondOpenMs.toFixed(1)}ms`)
  assert.ok(switchMs < 3_000, `cold switch took ${switchMs.toFixed(1)}ms`)
  assert.ok(inputMs < 500, `bounded-chunk input took ${inputMs.toFixed(1)}ms`)
  assert.ok(maxLongTaskMs < 500, `largest renderer long task was ${maxLongTaskMs.toFixed(1)}ms`)
})

test('350k structured Markdown opens in chunked rich mode and preserves responsive edits across reload', async (t) => {
  const { page, workspace } = await launchFixture(t)
  const editMarker = 'KNOTE_RICH_CHUNK_EDIT'
  const sections = 500
  const lines = []
  for (let index = 0; index < sections; index += 1) {
    const id = String(index).padStart(4, '0')
    lines.push(
      `## Synthetic section ${id}`,
      'This generated paragraph exercises structured long-document loading without copying any private source text.',
      '',
      '| Field | Value | Notes |',
      '| --- | --- | --- |',
      `| section | ${id} | deterministic heading and table coverage |`,
      '| status | active | synthetic parser-shape fixture only |',
      '',
      '```ts',
      `export const section${id} = { id: ${index}, enabled: true, label: 'synthetic-fixture' }`,
      `export function compute${id}(input) { return \`${'${input}'}:${id}\` }`,
      '```',
      '```mermaid',
      'flowchart LR',
      `  S${id}[Input ${id}] --> P${id}[Transform] --> O${id}[Output]`,
      '```'
    )
  }

  // Keep the fixture at the reported real-world shape: about 350k characters
  // and exactly 8,000 lines, while distributing padding across ordinary prose
  // instead of creating one artificial pathological line.
  const targetChars = 350_000
  let remaining = targetChars - `${lines.join('\n')}\n`.length
  assert.ok(remaining >= 0, 'structured fixture unexpectedly exceeded its target size')
  for (let section = 0; section < sections && remaining > 0; section += 1) {
    const share = Math.ceil(remaining / (sections - section))
    const seed = ' synthetic-load-profile'
    const padding = seed.repeat(Math.ceil(share / seed.length)).slice(0, share)
    lines[(section * 16) + 1] += padding
    remaining -= padding.length
  }
  const markdown = `${lines.join('\n')}\n`
  assert.equal(lines.length, 8_000, 'structured fixture must retain the intended line count')
  assert.equal(markdown.length, targetChars, 'structured fixture must retain the intended character count')

  const file = path.join(workspace, 'structured-large.md')
  fs.writeFileSync(file, markdown)

  const assertChunkedRichOnly = async (label) => {
    const state = await page.evaluate(() => ({
      largeRichCount: document.querySelectorAll('[data-testid="large-document-rich-chunk"]').length,
      sourcePageCount: document.querySelector('[data-testid="large-source-page-select"]')?.options.length || 0,
      proseMirrorCount: document.querySelectorAll('.ProseMirror').length,
      fullSourceCount: document.querySelectorAll('[data-testid="markdown-source-editor"]').length,
      fullPreviewCount: document.querySelectorAll('[data-testid="markdown-full-preview"]').length
    }))
    assert.equal(state.largeRichCount, 1, `${label}: one chunked rich editor must be mounted`)
    assert.ok(state.sourcePageCount > 1, `${label}: the structured source must be split into multiple pages`)
    assert.equal(state.proseMirrorCount, 1, `${label}: exactly one ProseMirror chunk must be mounted`)
    assert.equal(state.fullSourceCount, 0, `${label}: the complete source textarea must stay unmounted`)
    assert.equal(state.fullPreviewCount, 0, `${label}: the complete rendered preview must stay unmounted`)
    return state.sourcePageCount
  }

  const openStarted = performance.now()
  assert.equal(await page.evaluate((candidate) => window.knoteDesktop.reopen('file', candidate), file), true)
  await page.getByTestId('current-file-name').filter({ hasText: 'structured-large.md' }).waitFor({ timeout: 15_000 })
  await page.getByTestId('large-document-rich-chunk').waitFor({ state: 'visible', timeout: 15_000 })
  const openMs = performance.now() - openStarted
  const pageCount = await assertChunkedRichOnly('initial structured open')

  const pageSelect = page.getByTestId('large-source-page-select')
  await pageSelect.selectOption(String(pageCount - 1))
  const source = page.getByTestId('large-document-rich-chunk').locator('.ProseMirror')
  await source.focus()
  await page.keyboard.press('Control+End')
  const inputStarted = performance.now()
  await page.keyboard.insertText(editMarker)
  await page.waitForFunction((marker) => document.querySelector('[data-testid="large-document-rich-chunk"] .ProseMirror')?.textContent.includes(marker), editMarker)
  const inputMs = performance.now() - inputStarted

  const saveStarted = performance.now()
  await waitUntil(async () => {
    try { return fs.readFileSync(file, 'utf8').includes(editMarker) } catch { return false }
  }, { timeout: 15_000, interval: 100, message: 'structured large-document edit was not saved' })
  const saveMs = performance.now() - saveStarted

  const reloadStarted = performance.now()
  await page.reload({ waitUntil: 'commit', timeout: 90_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
  assert.equal(await page.evaluate((candidate) => window.knoteDesktop.reopen('file', candidate), file), true)
  await page.getByTestId('current-file-name').filter({ hasText: 'structured-large.md' }).waitFor({ timeout: 30_000 })
  await page.getByTestId('large-document-rich-chunk').waitFor({ state: 'visible', timeout: 30_000 })
  const reloadMs = performance.now() - reloadStarted
  const reloadedPageCount = await assertChunkedRichOnly('structured reload')
  await page.getByTestId('large-source-page-select').selectOption(String(reloadedPageCount - 1))
  assert.equal((await page.getByTestId('large-document-rich-chunk').locator('.ProseMirror').innerText()).includes(editMarker), true,
    'the structured large-document edit must survive save and renderer reload')

  t.diagnostic(`350k structured Electron paging: open ${openMs.toFixed(1)}ms; input ${inputMs.toFixed(1)}ms; save ${saveMs.toFixed(1)}ms; reload+reopen ${reloadMs.toFixed(1)}ms; pages ${pageCount}`)
  assert.ok(openMs < 3_000, `structured document open took ${openMs.toFixed(1)}ms`)
  assert.ok(inputMs < 500, `structured bounded-chunk input took ${inputMs.toFixed(1)}ms`)
})
