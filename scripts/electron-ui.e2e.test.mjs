import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
  const markers = /(?:ASK_TYPED|ASK_SWITCH|DELETE_CANCEL|DELETE_ACCEPT|IMAGE_REF_RECOVERY)/
  for (const message of [...messages].reverse()) {
    if (message?.role !== 'user') continue
    const text = messageText(message)
    const match = text.match(markers)
    if (match) return match[0]
  }
  return lastInstruction(messages)
}

const startFakeModel = async () => {
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

      // Session-title generation intentionally has no tools.
      if (!Array.isArray(payload.tools)) {
        jsonReply(res, { role: 'assistant', content: 'Electron 交互测试' })
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
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

const launchFixture = async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-electron-ui-'))
  const userData = path.join(tempRoot, 'profile')
  const workspace = path.join(tempRoot, 'workspace')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'keep.md'), '# Keep\n')
  fs.writeFileSync(path.join(workspace, 'delete-me.md'), '# Delete me\n')
  fs.writeFileSync(
    path.join(workspace, 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  )
  const model = await startFakeModel()
  const diagnostics = []
  let electronApp

  try {
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => typeof value === 'string')
    )
    electronApp = await electron.launch({
      executablePath: electronPath,
      args: ['.', workspace],
      cwd: repoRoot,
      env: {
        ...cleanEnv,
        KNOTE_E2E: '1',
        KNOTE_E2E_USER_DATA: userData
      },
      timeout: 30_000
    })
    const page = await electronApp.firstWindow()
    page.on('console', (msg) => {
      if (msg.type() === 'error') diagnostics.push(`console: ${msg.text()}`)
    })
    page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`))
    await page.waitForLoadState('domcontentloaded')
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
    await page.reload({ waitUntil: 'domcontentloaded' })
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
      if (electronApp) await electronApp.close().catch(() => {})
      await model.close().catch(() => {})
      fs.rmSync(tempRoot, { recursive: true, force: true })
    })
    return { page, panel, workspace }
  } catch (error) {
    if (electronApp) await electronApp.close().catch(() => {})
    await model.close().catch(() => {})
    fs.rmSync(tempRoot, { recursive: true, force: true })
    throw error
  }
}

const sendPrompt = async (panel, text) => {
  const input = panel.getByTestId('agent-input')
  await input.click()
  await input.fill(text)
  await panel.getByTestId('agent-send').click()
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

test('an invalid model-written image suffix is rejected atomically and corrected in the same Agent run', async (t) => {
  const { page, panel } = await launchFixture(t)
  await sendPrompt(panel, 'IMAGE_REF_RECOVERY')

  await panel.getByText('错误引用已由系统拦截，并已使用原始图片 ID 重新提交。', { exact: true }).waitFor({
    timeout: 20_000
  })
  await page.getByText(/1\s*处待审核改动/).first().waitFor()

  const bodyText = await page.locator('body').innerText()
  assert.doesNotMatch(bodyText, /图片引用无效：.*\.jpg0/)
  assert.doesNotMatch(bodyText, /错误引用\]\(att-\d+[^)]*\.jpg0/)
})
