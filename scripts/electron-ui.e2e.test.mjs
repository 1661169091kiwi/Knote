import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { canonicalAgentWorkspaceId } from '../src/lib/agentWorkspaceKey.js'

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

const protocolSseReply = (res) => {
  const body = [
    ': fake-provider comment\r\n',
    'event: message\r\n',
    'data: {"choices":[{"delta":{"content":\r\n',
    'data: "SSE_PROTOCOL_COMPLETE"},"finish_reason":null}]}\r\n\r\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'
  ].join('')
  const bytes = Buffer.from(body, 'utf8')
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  for (let offset = 0; offset < bytes.length; offset += 11) res.write(bytes.subarray(offset, offset + 11))
  res.end()
}

const heldProtocolSseReply = (res, release) => {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  res.write('data: {"choices":[{"delta":{"content":"STREAMING_PREFIX"},"finish_reason":null}]}\n\n')
  release.push({
    heartbeat: () => {
      if (res.destroyed || res.writableEnded) return false
      res.write(': provider heartbeat\n\n')
      return true
    },
    release: () => {
      if (res.destroyed || res.writableEnded) return false
      res.end('data: {"choices":[{"delta":{"content":"_COMPLETE"},"finish_reason":"stop"}]}\n\n')
      return true
    }
  })
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
  const markers = /(?:ASK_TYPED|ASK_SWITCH|BATCH_SCOPE|BATCH_INCOMPLETE|AFTER_BATCH|PDF_SHORT|PDF_SCAN|PDF_NO_TOOLS|PDF_CONTINUATION|ATTACH_CONTINUATION|SVG_INSERT|DELETE_CANCEL|DELETE_ACCEPT|IMAGE_REF_RECOVERY|PERMISSION_DENY|PERMISSION_ALLOW|PERMISSION_STOP|REVIEW_OWNER_HOLD|MANUAL_REVIEW_CREATE|AUTO_REVIEW_CREATE|AUTO_REVIEW_FAIL|AUTO_REVIEW_UNKNOWN|AUTO_REVIEW_MODE_CHANGE|AUTO_REVIEW_HUNK_PASS|AUTO_REVIEW_HUNK_RACE|FULL_AUTO_CREATE_FOLDER|FULL_AUTO_CREATE|FULL_AUTO_HUNK_PAIR|QUEUE_HOLD|STEER_APPEND|QUEUE_NEXT|QUEUE_REBASE|QUEUE_CANCEL_CAPTURE|QUEUE_SESSION_CANCEL|QUEUE_SESSION_B|QUEUE_RELOAD|STATE_FALLBACK|COMPACT_CONTEXT|QUIT_DURABILITY|QUIT_RESUME|COMMAND_ALLOW|COMMAND_NATIVE_DENY|DOWNLOAD_DENY|DOWNLOAD_ALLOW|SSE_PROTOCOL|STREAM_PROJECTION|COPY_CONTROLS|ORDER_REFRESH|CONTENT_FILTER_STATE|UNKNOWN_TERMINAL_STATE|TRUNCATED_TOOL_BATCH|INVALID_SIBLING_BATCH|LONG_LINE_CLIPPED|FIND_TIMEOUT|FIND_CAP|FIND_ZERO|DOC_BIND_BACKGROUND|BUFFER_EDIT_BACKGROUND|BUFFER_EDIT_STALE|BUFFER_EDIT_CLOSED|BUFFER_EDIT_AMBIGUOUS|BUFFER_EDIT_PARTIAL_ALL)/g
  for (const message of [...messages].reverse()) {
    if (message?.role !== 'user') continue
    const text = messageText(message)
    const matches = [...text.matchAll(markers)]
    if (matches.length) return matches.at(-1)[0]
  }
  return lastInstruction(messages)
}

const startFakeModel = async () => {
  let workspaceRaceToolResult = ''
  let batchWorkerRequests = 0
  let batchWorkerReplies = 0
  let queueHoldRequests = 0
  const pendingBatchWorkers = []
  const pendingQueueHolds = []
  const pendingReviewOwnerHolds = []
  const pendingAutomaticReviewHolds = []
  const automaticReviewRequests = []
  const queueInstructions = []
  const scenarioRequests = new Map()
  const memoryRequests = []
  const compactContextRequests = []
  const commandToolResults = []
  const downloadToolResults = []
  let truncatedToolRetryRequest = null
  let invalidSiblingToolResults = []
  let unknownTerminalRequests = 0
  let longLineToolResult = null
  let attachmentContinuationInitialText = ''
  let attachmentContinuationToolResult = null
  let svgInsertInitialRequest = null
  let svgInsertToolResult = null
  let pdfContinuationInitialText = ''
  let pdfContinuationSourceResult = null
  let pdfContinuationArtifactResult = null
  const findToolResults = new Map()
  const pdfRequests = new Map()
  const pendingDocumentBindingReplies = []
  const pendingStreamProjectionReplies = []
  const documentBindingToolResults = new Map()
  let documentBindingWaits = 0
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
      scenarioRequests.set(instruction, (scenarioRequests.get(instruction) || 0) + 1)
      const toolResult = [...messages].reverse().find((message) => message?.role === 'tool')

      const isBatchWorker = messages.some((message) => (
        message?.role === 'system' && String(message.content || '').includes('你是一个批处理工作单元')
      ))
      if (isBatchWorker) {
        batchWorkerRequests++
        if (JSON.stringify(messages).includes('BATCH_INCOMPLETE')) {
          jsonReply(res, { role: 'assistant', content: 'INCOMPLETE_BATCH_TEXT_MUST_NOT_BE_WRITTEN' }, 'pause_turn')
          return
        }
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

      const isMemoryCompaction = messages.some((message) => (
        message?.role === 'system' && String(message.content || '').includes('会话记忆压缩器')
      ))
      if (isMemoryCompaction) {
        memoryRequests.push(payload)
        if (JSON.stringify(messages).includes('COMPACTOR_LENGTH_CASE')) {
          jsonReply(res, {
            role: 'assistant',
            content: 'TRUNCATED_MODEL_MEMORY must never replace the lossless raw facts even though this response is longer than forty characters.'
          }, 'length')
          return
        }
        jsonReply(res, {
          role: 'assistant',
          content: '用户要求后续任务继续保留事实 EARLY_MEMORY_FACT；旧对话均为测试历史，尚无文件修改或未完成操作。'
        })
        return
      }

      const isAutomaticReviewer = messages.some((message) => (
        message?.role === 'system' && String(message.content || '').includes("Knote's isolated operation reviewer")
      ))
      if (isAutomaticReviewer) {
        automaticReviewRequests.push(payload)
        let reviewInput = {}
        try { reviewInput = JSON.parse(messageText(messages.findLast((message) => message?.role === 'user'))) } catch { /* fail-closed behavior is asserted in unit tests */ }
        const originalInstruction = String(reviewInput.instruction || '')
        const verdict = originalInstruction.includes('AUTO_REVIEW_UNKNOWN')
          ? 'UNKNOWN'
          : originalInstruction.includes('AUTO_REVIEW_FAIL')
            ? 'FAIL'
            : 'PASS'
        const sendVerdict = () => jsonReply(res, {
          role: 'assistant',
          content: JSON.stringify({
            verdict,
            reason: verdict === 'PASS' ? 'Exact non-destructive operation with complete evidence.' : verdict === 'FAIL' ? 'Instruction mismatch.' : 'Evidence is intentionally unknown.',
            checks: verdict === 'PASS'
              ? { instructionAligned: true, targetExact: true, nonDestructive: true, evidenceComplete: true }
              : { instructionAligned: false, targetExact: false, nonDestructive: true, evidenceComplete: false }
          })
        })
        if (originalInstruction.includes('AUTO_REVIEW_HUNK_RACE') || originalInstruction.includes('AUTO_REVIEW_MODE_CHANGE')) pendingAutomaticReviewHolds.push(sendVerdict)
        else sendVerdict()
        return
      }

      // Session-title generation intentionally has no tools.
      if (!Array.isArray(payload.tools)) {
        jsonReply(res, { role: 'assistant', content: 'Electron 交互测试' })
        return
      }

      if (instruction === 'SSE_PROTOCOL') {
        protocolSseReply(res)
        return
      }

      if (instruction === 'STREAM_PROJECTION') {
        heldProtocolSseReply(res, pendingStreamProjectionReplies)
        return
      }

      if (instruction === 'COPY_CONTROLS') {
        jsonReply(res, { role: 'assistant', content: 'COPY_MESSAGE_SOURCE\n\n```js\nconst copied = true;\n```\n\n| Name | Value |\n| --- | --- |\n| alpha | beta |' })
        return
      }

      if (instruction === 'CONTENT_FILTER_STATE') {
        jsonReply(res, {
          role: 'assistant',
          content: 'FILTERED_PROVIDER_PROSE_MUST_STAY_HIDDEN',
          tool_calls: [{
            id: 'call-filtered-create',
            type: 'function',
            function: {
              name: 'create_file',
              arguments: JSON.stringify({ path: 'filtered-must-not-exist.md', content: '# unsafe\n' })
            }
          }]
        }, 'content_filter')
        return
      }

      if (instruction === 'UNKNOWN_TERMINAL_STATE') {
        unknownTerminalRequests++
        jsonReply(res, {
          role: 'assistant',
          content: 'UNKNOWN_PROVIDER_PROSE_MUST_STAY_HIDDEN',
          tool_calls: [{
            id: `call-unknown-create-${unknownTerminalRequests}`,
            type: 'function',
            function: {
              name: 'create_file',
              arguments: JSON.stringify({ path: 'unknown-must-not-exist.md', content: '# unsafe\n' })
            }
          }]
        }, 'pause_turn')
        return
      }

      if (instruction === 'TRUNCATED_TOOL_BATCH') {
        const retryRequested = messages.some((message) => (
          message?.role === 'user' && messageText(message).includes('重新发送完整的整个工具调用集')
        ))
        if (!retryRequested) {
          jsonReply(res, {
            role: 'assistant',
            content: 'INCOMPLETE_TOOL_PROSE_MUST_STAY_HIDDEN',
            tool_calls: [{
              id: 'call-truncated-create',
              type: 'function',
              function: {
                name: 'create_file',
                arguments: JSON.stringify({ path: 'truncated-must-not-exist.md', content: '# unsafe\n' })
              }
            }]
          }, 'length')
          return
        }
        truncatedToolRetryRequest = payload
        jsonReply(res, { role: 'assistant', content: 'TRUNCATED_TOOL_BATCH_DONE' })
        return
      }

      if (instruction === 'INVALID_SIBLING_BATCH') {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        const replyTools = (calls) => jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: calls.map(({ id, name, input }) => ({
            id,
            type: 'function',
            function: { name, arguments: JSON.stringify(input) }
          }))
        }, 'tool_calls')
        if (!results.length) {
          replyTools([
            { id: 'call-sibling-valid', name: 'create_file', input: { path: 'semantic-valid-must-not-exist.md', content: '# safe only if every sibling is valid\n' } },
            { id: 'call-sibling-traversal', name: 'rename_file', input: { path: '../escape.md', new_name: 'escaped.md' } },
            { id: 'call-sibling-range', name: 'replace_lines', input: { start_line: 2, end_line: 1, new_content: 'invalid range' } }
          ])
          return
        }
        invalidSiblingToolResults = results.slice(-3)
        jsonReply(res, { role: 'assistant', content: 'INVALID_SIBLING_BATCH_DONE' })
        return
      }

      if (instruction === 'LONG_LINE_CLIPPED') {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        const replyTool = (id, name, input) => jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }]
        }, 'tool_calls')
        if (!results.length) {
          replyTool('call-long-line-read', 'read_document', { start_line: 1, end_line: 1 })
          return
        }
        if (results.length === 1) {
          replyTool('call-long-line-edit', 'replace_lines', { start_line: 1, end_line: 1, new_content: 'must not replace clipped evidence' })
          return
        }
        longLineToolResult = results.at(-1)
        jsonReply(res, { role: 'assistant', content: 'LONG_LINE_CLIPPED_DONE' })
        return
      }

      if (instruction === 'ATTACH_CONTINUATION') {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        if (!results.length) {
          const latestUser = [...messages].reverse().find((message) => message?.role === 'user')
          attachmentContinuationInitialText = messageText(latestUser)
          const attachmentId = /"attachment_id":"([^"]+)"/.exec(attachmentContinuationInitialText)?.[1] || ''
          const cursor = /"next_cursor":"([A-Za-z0-9_-]+)"/.exec(attachmentContinuationInitialText)?.[1] || ''
          if (!attachmentId || !cursor) {
            jsonReply(res, { role: 'assistant', content: 'ATTACH_CONTINUATION_METADATA_MISSING' })
            return
          }
          jsonReply(res, {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-attachment-continuation',
              type: 'function',
              function: { name: 'read_attachment', arguments: JSON.stringify({ attachment_id: attachmentId, cursor }) }
            }]
          }, 'tool_calls')
          return
        }
        attachmentContinuationToolResult = results.at(-1)
        jsonReply(res, { role: 'assistant', content: 'ATTACH_CONTINUATION_DONE' })
        return
      }

      if (instruction === 'SVG_INSERT') {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        const replyTool = (id, name, input) => jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }]
        }, 'tool_calls')
        if (!results.length) {
          svgInsertInitialRequest = payload
          const serialized = JSON.stringify(messages)
          const imageId = /image_id=(att-[A-Za-z0-9_-]+)/.exec(serialized)?.[1] || ''
          if (!imageId) {
            jsonReply(res, { role: 'assistant', content: 'SVG_INSERT_METADATA_MISSING' })
            return
          }
          replyTool('call-svg-insert-read', 'read_document', {})
          return
        }
        if (results.length === 1) {
          const serialized = JSON.stringify(messages)
          const imageId = /image_id=(att-[A-Za-z0-9_-]+)/.exec(serialized)?.[1] || ''
          replyTool('call-svg-insert-image', 'insert_image', { image_id: imageId, after_line: 3 })
          return
        }
        svgInsertToolResult = results.at(-1)
        jsonReply(res, { role: 'assistant', content: 'SVG_INSERT_DONE' })
        return
      }

      if (instruction === 'PDF_CONTINUATION') {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        if (!results.length) {
          const latestUser = [...messages].reverse().find((message) => message?.role === 'user')
          pdfContinuationInitialText = messageText(latestUser)
          const attachmentId = /"attachment_id":"([^"]+)"/.exec(pdfContinuationInitialText)?.[1] || ''
          const cursor = /"next_cursor":"([A-Za-z0-9_-]+)"/.exec(pdfContinuationInitialText)?.[1] || ''
          if (!attachmentId || !cursor) {
            jsonReply(res, { role: 'assistant', content: 'PDF_CONTINUATION_METADATA_MISSING' })
            return
          }
          jsonReply(res, {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-pdf-source-continuation',
              type: 'function',
              function: { name: 'read_pdf_text', arguments: JSON.stringify({ attachment_id: attachmentId, cursor }) }
            }]
          }, 'tool_calls')
          return
        }
        const latest = results.at(-1)
        if (!pdfContinuationSourceResult) {
          pdfContinuationSourceResult = latest
          const artifactId = String(latest?.tool_output?.artifact_id || latest?.toolOutput?.artifact_id || '')
          if (artifactId) {
            jsonReply(res, {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call-pdf-artifact-continuation',
                type: 'function',
                function: { name: 'read_tool_output', arguments: JSON.stringify({ artifact_id: artifactId, byte_offset: 0, byte_limit: 262144 }) }
              }]
            }, 'tool_calls')
            return
          }
        } else {
          pdfContinuationArtifactResult = latest
        }
        jsonReply(res, { role: 'assistant', content: 'PDF_CONTINUATION_DONE' })
        return
      }

      if (/^FIND_(?:TIMEOUT|CAP|ZERO)$/.test(instruction)) {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        if (!results.length) {
          jsonReply(res, {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: `call-${instruction.toLowerCase()}`,
              type: 'function',
              function: { name: 'find_in_files', arguments: JSON.stringify({ query: instruction }) }
            }]
          }, 'tool_calls')
          return
        }
        findToolResults.set(instruction, results.at(-1))
        jsonReply(res, { role: 'assistant', content: `${instruction}_DONE` })
        return
      }

      if (instruction === 'BATCH_INCOMPLETE') {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        if (results.length) {
          jsonReply(res, { role: 'assistant', content: 'BATCH_INCOMPLETE_DONE' })
          return
        }
        jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-batch-incomplete',
            type: 'function',
            function: {
              name: 'batch_process',
              arguments: JSON.stringify({ files: ['keep.md'], task: 'BATCH_INCOMPLETE 生成摘要', output_suffix: '-incomplete-e2e' })
            }
          }]
        }, 'tool_calls')
        return
      }

      if (instruction === 'REVIEW_OWNER_HOLD') {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        const latest = results.at(-1)
        const replyTool = (id, name, args) => jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
        }, 'tool_calls')
        if (!latest) {
          replyTool('call-review-owner-read', 'read_document', {})
          return
        }
        if (latest.code === 'DOCUMENT_READ') {
          replyTool('call-review-owner-edit', 'replace_lines', {
            start_line: 1,
            end_line: 1,
            new_content: '# Keep reviewed'
          })
          return
        }
        if (latest.code === 'HUNK_STAGED') {
          pendingReviewOwnerHolds.push(() => {
            if (res.destroyed || res.writableEnded) return
            jsonReply(res, { role: 'assistant', content: 'REVIEW_OWNER_HOLD_DONE' })
          })
          return
        }
      }

      if (/^(?:MANUAL_REVIEW_CREATE|AUTO_REVIEW_CREATE|AUTO_REVIEW_FAIL|AUTO_REVIEW_UNKNOWN|AUTO_REVIEW_MODE_CHANGE|FULL_AUTO_CREATE)$/.test(instruction)) {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        if (!results.length) {
          const extension = instruction === 'FULL_AUTO_CREATE' ? 'md' : 'txt'
          jsonReply(res, {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: `call-${instruction.toLowerCase()}-${Date.now()}`,
              type: 'function',
              function: {
                name: 'create_file',
                arguments: JSON.stringify({
                  path: `${instruction.toLowerCase().replaceAll('_', '-')}.${extension}`,
                  content: `# ${instruction}\n`
                })
              }
            }]
          }, 'tool_calls')
          return
        }
        jsonReply(res, { role: 'assistant', content: `${instruction}_DONE` })
        return
      }

      if (instruction === 'FULL_AUTO_CREATE_FOLDER') {
        const result = messages.findLast((message) => message?.role === 'tool')
        if (!result) {
          jsonReply(res, {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-full-auto-create-folder',
              type: 'function',
              function: {
                name: 'create_folder',
                arguments: JSON.stringify({ path: 'allow-all-folder/nested' })
              }
            }]
          }, 'tool_calls')
          return
        }
        jsonReply(res, { role: 'assistant', content: 'FULL_AUTO_CREATE_FOLDER_DONE' })
        return
      }

      if (/^AUTO_REVIEW_HUNK_(?:PASS|RACE)$/.test(instruction)) {
        const promptIndex = messages.findLastIndex((message) => (
          message?.role === 'user' && messageText(message).includes(instruction)
        ))
        const results = messages.slice(promptIndex + 1)
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        const latest = results.at(-1)
        const replyTool = (id, name, input) => jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }]
        }, 'tool_calls')
        if (!latest) {
          replyTool(`call-${instruction.toLowerCase()}-read`, 'read_document', {})
          return
        }
        if (latest.code === 'DOCUMENT_READ') {
          replyTool(`call-${instruction.toLowerCase()}-edit`, 'replace_lines', {
            start_line: 1,
            end_line: 1,
            new_content: instruction.endsWith('_PASS') ? '# Automatic accepted' : '# Automatic proposal'
          })
          return
        }
        jsonReply(res, { role: 'assistant', content: `${instruction}_DONE` })
        return
      }

      if (instruction === 'FULL_AUTO_HUNK_PAIR') {
        const promptIndex = messages.findLastIndex((message) => (
          message?.role === 'user' && messageText(message).includes(instruction)
        ))
        const results = messages.slice(promptIndex + 1)
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        const replyTools = (calls) => jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: calls.map(({ id, name, input }) => ({
            id,
            type: 'function',
            function: { name, arguments: JSON.stringify(input) }
          }))
        }, 'tool_calls')
        if (!results.length) {
          replyTools([{ id: 'call-full-auto-pair-read', name: 'read_document', input: {} }])
          return
        }
        if (results.length === 1) {
          replyTools([
            { id: 'call-full-auto-pair-replace', name: 'replace_lines', input: { start_line: 1, end_line: 1, new_content: '# Full auto pair' } },
            { id: 'call-full-auto-pair-insert', name: 'insert_lines', input: { after_line: 1, content: 'Second automatically accepted change' } }
          ])
          return
        }
        jsonReply(res, { role: 'assistant', content: 'FULL_AUTO_HUNK_PAIR_DONE' })
        return
      }

      if (/^(?:QUEUE_HOLD|STEER_APPEND|QUEUE_NEXT|QUEUE_REBASE|QUEUE_CANCEL_CAPTURE|QUEUE_SESSION_CANCEL|QUEUE_SESSION_B|QUEUE_RELOAD)$/.test(instruction)) {
        queueInstructions.push(instruction)
      }
      if (instruction === 'QUEUE_HOLD') {
        queueHoldRequests++
        pendingQueueHolds.push(() => {
          if (res.destroyed || res.writableEnded) return
          jsonReply(res, { role: 'assistant', content: 'QUEUE_HOLD_MODEL_RETURNED' })
        })
        return
      }
      if (instruction === 'STEER_APPEND') {
        jsonReply(res, { role: 'assistant', content: 'STEER_APPEND_DONE' })
        return
      }
      if (instruction === 'QUEUE_NEXT') {
        jsonReply(res, { role: 'assistant', content: 'QUEUE_NEXT_DONE' })
        return
      }
      if (instruction === 'QUEUE_REBASE') {
        jsonReply(res, { role: 'assistant', content: 'QUEUE_REBASE_DONE' })
        return
      }
      if (instruction === 'QUEUE_CANCEL_CAPTURE') {
        jsonReply(res, { role: 'assistant', content: 'QUEUE_CANCEL_CAPTURE_SHOULD_NOT_RUN' })
        return
      }
      if (instruction === 'QUEUE_SESSION_CANCEL') {
        jsonReply(res, { role: 'assistant', content: 'QUEUE_SESSION_CANCEL_RAN' })
        return
      }
      if (instruction === 'QUEUE_SESSION_B') {
        queueHoldRequests++
        pendingQueueHolds.push(() => {
          if (res.destroyed || res.writableEnded) return
          jsonReply(res, { role: 'assistant', content: 'QUEUE_SESSION_B_DONE' })
        })
        return
      }
      if (instruction === 'QUEUE_RELOAD') {
        jsonReply(res, { role: 'assistant', content: 'QUEUE_RELOAD_DONE' })
        return
      }
      if (instruction === 'STATE_FALLBACK') {
        jsonReply(res, { role: 'assistant', content: 'STATE_FALLBACK_DONE' })
        return
      }
      if (instruction === 'COMPACT_CONTEXT') {
        compactContextRequests.push(payload)
        jsonReply(res, { role: 'assistant', content: 'COMPACT_CONTEXT_DONE' })
        return
      }
      if (instruction === 'QUIT_DURABILITY') {
        if (toolResult) {
          jsonReply(res, { role: 'assistant', content: 'QUIT_DURABILITY_DONE' })
        } else {
          jsonReply(res, {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-quit-durability-calc',
              type: 'function',
              function: { name: 'calc', arguments: JSON.stringify({ expression: '6 * 7' }) }
            }]
          }, 'tool_calls')
        }
        return
      }
      if (instruction === 'QUIT_RESUME') {
        jsonReply(res, { role: 'assistant', content: 'QUIT_RESUME_DONE' })
        return
      }

      if (instruction === 'DOC_BIND_BACKGROUND') {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        const replyTool = (id, name, input) => jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }]
        }, 'tool_calls')
        if (!results.length) {
          replyTool('call-doc-bind-read', 'read_document', {})
          return
        }
        if (results.length === 1) {
          documentBindingWaits++
          pendingDocumentBindingReplies.push(() => {
            if (res.destroyed || res.writableEnded) return
            replyTool('call-doc-bind-replace', 'replace_lines', {
              start_line: 1,
              end_line: 1,
              new_content: '# Keep edited in background'
            })
          })
          return
        }
        documentBindingToolResults.set(instruction, results.at(-1))
        jsonReply(res, { role: 'assistant', content: 'DOC_BIND_BACKGROUND_DONE' })
        return
      }

      if (/^BUFFER_EDIT_(?:BACKGROUND|STALE|CLOSED)$/.test(instruction)) {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        const replyTool = (id, name, input) => jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }]
        }, 'tool_calls')
        if (!results.length) {
          replyTool(`call-${instruction.toLowerCase()}-read`, 'read_file', { path: 'workspace-race.md' })
          return
        }
        if (results.length === 1) {
          const sendEdit = () => {
            if (res.destroyed || res.writableEnded) return
            replyTool(`call-${instruction.toLowerCase()}-edit`, 'edit_file', {
              path: 'workspace-race.md',
              old_string: '# Workspace A',
              new_string: '# Workspace A edited from bound buffer'
            })
          }
          if (instruction === 'BUFFER_EDIT_BACKGROUND') sendEdit()
          else {
            documentBindingWaits++
            pendingDocumentBindingReplies.push(sendEdit)
          }
          return
        }
        documentBindingToolResults.set(instruction, results.at(-1))
        const finalText = instruction === 'BUFFER_EDIT_BACKGROUND'
          ? 'BUFFER_EDIT_BACKGROUND_DONE'
          : instruction === 'BUFFER_EDIT_STALE'
            ? 'BOUND_TARGET_STALE_REPORTED; the requested change was not applied.'
            : 'BOUND_TARGET_CLOSED_REPORTED; no change was applied.'
        jsonReply(res, { role: 'assistant', content: finalText })
        return
      }

      if (instruction === 'BUFFER_EDIT_AMBIGUOUS') {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        if (!results.length) {
          jsonReply(res, {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-buffer-edit-ambiguous-read',
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: 'workspace-race.md' }) }
            }]
          }, 'tool_calls')
          return
        }
        documentBindingToolResults.set(instruction, results.at(-1))
        jsonReply(res, { role: 'assistant', content: 'BUFFER_EDIT_AMBIGUOUS_DONE' })
        return
      }

      if (instruction === 'BUFFER_EDIT_PARTIAL_ALL') {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        const replyTool = (id, name, input) => jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }]
        }, 'tool_calls')
        if (!results.length) {
          replyTool('call-buffer-edit-partial-read', 'read_file', { path: 'partial-replace.md', start_line: 1, end_line: 500 })
          return
        }
        if (results.length === 1) {
          replyTool('call-buffer-edit-partial-edit', 'edit_file', {
            path: 'partial-replace.md',
            old_string: 'MATCH',
            new_string: 'REPLACED',
            replace_all: true
          })
          return
        }
        documentBindingToolResults.set(instruction, results.at(-1))
        jsonReply(res, { role: 'assistant', content: 'BUFFER_EDIT_PARTIAL_ALL_DONE' })
        return
      }

      if (/^COMMAND_(?:ALLOW|NATIVE_DENY)$/.test(instruction)) {
        const commandResultMessage = [...messages].reverse().find((message) => message?.role === 'tool')
        if (commandResultMessage) {
          let commandResult = {}
          try { commandResult = JSON.parse(String(commandResultMessage.content || '{}')) } catch { /* asserted by the test */ }
          commandToolResults.push({ instruction, result: commandResult })
          jsonReply(res, {
            role: 'assistant',
            content: instruction === 'COMMAND_ALLOW' ? 'COMMAND_ALLOW_DONE' : 'COMMAND_NATIVE_DENY_DONE'
          })
          return
        }
        const script = instruction === 'COMMAND_ALLOW' ? 'command-allow-e2e.js' : 'command-deny-e2e.js'
        jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `call-${instruction.toLowerCase()}-${Date.now()}`,
            type: 'function',
            function: {
              name: 'run_command',
              arguments: JSON.stringify({
                program: 'node',
                args: ['--check', script],
                timeout_seconds: 10
              })
            }
          }]
        }, 'tool_calls')
        return
      }

      if (/^DOWNLOAD_(?:DENY|ALLOW)$/.test(instruction)) {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        const latest = results.at(-1)
        const replyTool = (id, url) => jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id,
            type: 'function',
            function: {
              name: 'download_file',
              arguments: JSON.stringify({
                url,
                path: instruction === 'DOWNLOAD_DENY' ? 'downloads/denied.pdf' : 'downloads/approved.pdf',
                ...(instruction === 'DOWNLOAD_ALLOW' ? { max_bytes: 1_234_567 } : {})
              })
            }
          }]
        }, 'tool_calls')
        if (!latest) {
          replyTool(`call-${instruction.toLowerCase()}-${Date.now()}`, `https://files.example/${instruction.toLowerCase()}.pdf`)
          return
        }
        downloadToolResults.push({ instruction, result: latest })
        if (instruction === 'DOWNLOAD_DENY' && latest.code === 'USER_DECLINED' && results.filter((item) => item.code === 'USER_DECLINED').length < 2) {
          replyTool(`call-download-deny-bypass-${Date.now()}`, 'https://mirror.example/changed-source.pdf')
          return
        }
        jsonReply(res, { role: 'assistant', content: `${instruction}_DONE` })
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
        if (latest?.code === 'INVALID_IMAGE_REFERENCE' || (
          latest?.code === 'INVALID_TOOL_SEMANTICS' && latest?.data?.reason_code === 'INVALID_IMAGE_REFERENCE'
        )) {
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

      if (/PERMISSION_(?:DENY|ALLOW)/.test(instruction)) {
        const results = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => {
            try { return JSON.parse(String(message.content || '{}')) } catch { return {} }
          })
        const latest = results.at(-1)
        const replyTool = (id, name, args) => jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
        }, 'tool_calls')
        if (!latest) {
          replyTool(`call-permission-read-${Date.now()}`, 'read_file', { path: 'permission-edit.md' })
          return
        }
        if (latest.code === 'OK' || latest.code === 'FILE_READ') {
          replyTool(`call-permission-edit-${Date.now()}`, 'edit_file', {
            path: 'permission-edit.md',
            old_string: '# Permission original',
            new_string: '# Permission approved'
          })
          return
        }
        if (latest.code === 'USER_DECLINED' && /PERMISSION_DENY/.test(instruction)) {
          const declines = results.filter((result) => result.code === 'USER_DECLINED').length
          if (declines < 2) {
            replyTool(`call-permission-retry-${Date.now()}`, 'edit_file', {
              path: 'permission-edit.md',
              old_string: '# Permission original',
              new_string: '# Permission bypass attempt'
            })
            return
          }
          jsonReply(res, { role: 'assistant', content: 'PERMISSION_DENY_DONE' })
          return
        }
        if (latest.code === 'FILE_EDITED' && /PERMISSION_ALLOW/.test(instruction)) {
          jsonReply(res, { role: 'assistant', content: 'PERMISSION_ALLOW_DONE' })
          return
        }
      }

      if (/PERMISSION_STOP/.test(instruction)) {
        jsonReply(res, {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `call-permission-stop-${Date.now()}`,
            type: 'function',
            function: {
              name: 'create_file',
              arguments: JSON.stringify({ path: 'must-not-exist.md', content: '# Must not exist\n' })
            }
          }]
        }, 'tool_calls')
        return
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
    get queueHoldRequests() { return queueHoldRequests },
    get reviewOwnerHolds() { return pendingReviewOwnerHolds.length },
    get automaticReviewHolds() { return pendingAutomaticReviewHolds.length },
    get automaticReviewRequests() { return [...automaticReviewRequests] },
    get queueInstructions() { return [...queueInstructions] },
    requestCount(instruction) { return scenarioRequests.get(instruction) || 0 },
    get memoryRequestCount() { return memoryRequests.length },
    get latestMemoryRequest() { return memoryRequests.at(-1) || null },
    get latestCompactContextRequest() { return compactContextRequests.at(-1) || null },
    get commandToolResults() { return [...commandToolResults] },
    get downloadToolResults() { return [...downloadToolResults] },
    get truncatedToolRetryRequest() { return truncatedToolRetryRequest },
    get invalidSiblingToolResults() { return [...invalidSiblingToolResults] },
    get unknownTerminalRequests() { return unknownTerminalRequests },
    get longLineToolResult() { return longLineToolResult },
    get attachmentContinuationInitialText() { return attachmentContinuationInitialText },
    get attachmentContinuationToolResult() { return attachmentContinuationToolResult },
    get svgInsertInitialRequest() { return svgInsertInitialRequest },
    get svgInsertToolResult() { return svgInsertToolResult },
    get pdfContinuationInitialText() { return pdfContinuationInitialText },
    get pdfContinuationSourceResult() { return pdfContinuationSourceResult },
    get pdfContinuationArtifactResult() { return pdfContinuationArtifactResult },
    get documentBindingWaits() { return documentBindingWaits },
    documentBindingToolResult(marker) { return documentBindingToolResults.get(marker) || null },
    findToolResult(marker) { return findToolResults.get(marker) || null },
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
    releaseQueueHolds(count = Number.POSITIVE_INFINITY) {
      let released = 0
      while (pendingQueueHolds.length && released < count) {
        pendingQueueHolds.shift()()
        released++
      }
      return released
    },
    releaseReviewOwnerHolds(count = Number.POSITIVE_INFINITY) {
      let released = 0
      while (pendingReviewOwnerHolds.length && released < count) {
        pendingReviewOwnerHolds.shift()()
        released++
      }
      return released
    },
    releaseAutomaticReviewHolds(count = Number.POSITIVE_INFINITY) {
      let released = 0
      while (pendingAutomaticReviewHolds.length && released < count) {
        pendingAutomaticReviewHolds.shift()()
        released++
      }
      return released
    },
    releaseDocumentBindingReplies(count = Number.POSITIVE_INFINITY) {
      let released = 0
      while (pendingDocumentBindingReplies.length && released < count) {
        pendingDocumentBindingReplies.shift()()
        released++
      }
      return released
    },
    releaseStreamProjectionReplies(count = Number.POSITIVE_INFINITY) {
      let released = 0
      while (pendingStreamProjectionReplies.length && released < count) {
        pendingStreamProjectionReplies.shift().release()
        released++
      }
      return released
    },
    sendStreamProjectionHeartbeats() {
      return pendingStreamProjectionReplies.filter((entry) => entry.heartbeat()).length
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
  fs.writeFileSync(path.join(workspace, 'partial-replace.md'), Array.from({ length: 600 }, (_value, index) => (
    index === 1 || index === 549 ? 'MATCH' : `line-${index + 1}`
  )).join('\n') + '\n')
  fs.writeFileSync(path.join(workspace, 'permission-edit.md'), '# Permission original\n')
  fs.writeFileSync(path.join(workspace, 'command-allow-e2e.js'), 'require("node:fs").writeFileSync("command-allow-ran.txt", "allowed\\n"); console.log("COMMAND_E2E_OUTPUT")\n')
  fs.writeFileSync(path.join(workspace, 'command-deny-e2e.js'), 'require("node:fs").writeFileSync("command-deny-ran.txt", "denied\\n")\n')
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
    // CI virtual displays are smaller than the app's designed 1440x900
    // window, so xl-only chrome (navbar file name) and height-dependent
    // geometry (collapsed question rail) end up hidden. Pin a large viewport
    // so every machine exercises the same layout.
    await page.setViewportSize({ width: 1440, height: 900 })
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
    await panel.getByTestId('agent-input').waitFor({ state: 'attached' })
    await page.getByText('delete-me.md', { exact: true }).first().waitFor({ state: 'attached' })

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
    return { page, panel, workspace, workspaceB, userData, tempRoot, electronApp, model }
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

const openWorkspaceMarkdownInNewTab = (page, name) => page.evaluate(async (fileName) => {
  const find = (nodes) => {
    for (const node of nodes || []) {
      if (node.kind === 'file' && node.name === fileName) return node
      const nested = find(node.children)
      if (nested) return nested
    }
    return null
  }
  const node = find(window.__knoteDebug.folder.tree())
  if (!node) throw new Error(`workspace file not found: ${fileName}`)
  return await window.__knoteDebug.folder.openInNewTab(node)
}, name)

const switchWorkspaceDocumentTab = (page, treePath) => page.evaluate(async (wantedPath) => {
  const tab = window.__knoteDebug.tabs.list().find((item) => item.treePath === wantedPath)
  if (!tab) throw new Error(`document tab not found: ${wantedPath}`)
  return await window.__knoteDebug.tabs.switch(tab.id)
}, treePath)

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

const assembleTextPagesPdf = (pages) => {
  const pageLines = pages.map((lines) => lines.map((line) => String(line)))
  const objects = []
  const pageIds = pageLines.map((_page, index) => 3 + index * 2)
  const fontId = 3 + pageLines.length * 2
  objects[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>\nendobj\n`
  for (let index = 0; index < pageLines.length; index++) {
    const pageId = pageIds[index]
    const contentId = pageId + 1
    objects[pageId] = `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>\nendobj\n`
    const commands = ['BT /F1 8 Tf 36 760 Td']
    for (const [lineIndex, line] of pageLines[index].entries()) {
      const escaped = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
      if (lineIndex) commands.push('0 -10 Td')
      commands.push(`(${escaped}) Tj`)
    }
    commands.push('ET')
    const body = commands.join('\n')
    objects[contentId] = `${contentId} 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`
  }
  objects[fontId] = `${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let id = 1; id <= fontId; id++) {
    offsets[id] = pdf.length
    pdf += objects[id]
  }
  const xrefPosition = pdf.length
  pdf += `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= fontId; id++) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF`
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

const sendPromptAndWaitForReply = async (page, panel, text, {
  reply = 'E2E_STUB_UNHANDLED',
  timeout = 15_000
} = {}) => {
  const replies = panel.getByText(reply, { exact: true })
  const previousReplies = await replies.count()
  await sendPrompt(panel, text)
  await waitUntil(async () => {
    if (await replies.count() <= previousReplies) return false
    return page.evaluate(async () => (await window.__knoteDebug.agent()).agentStatus.value !== 'running')
  }, { timeout, message: `Agent reply did not settle for prompt: ${text}` })
}

const requestRendererQuitBarrier = (electronApp, token) => electronApp.evaluate(
  ({ BrowserWindow, ipcMain }, expectedToken) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener('knote:renderer-quit-ready', onReady)
      reject(new Error('renderer quit barrier did not acknowledge'))
    }, 15_000)
    const onReady = (_event, payload = {}) => {
      if (String(payload.token || '') !== expectedToken) return
      clearTimeout(timer)
      ipcMain.removeListener('knote:renderer-quit-ready', onReady)
      resolve(payload)
    }
    ipcMain.on('knote:renderer-quit-ready', onReady)
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
    if (!window) {
      clearTimeout(timer)
      ipcMain.removeListener('knote:renderer-quit-ready', onReady)
      reject(new Error('renderer window is unavailable'))
      return
    }
    window.webContents.send('knote:prepare-quit', { token: expectedToken })
  }),
  token
)

const cancelRendererQuitBarrier = (electronApp) => electronApp.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!window) return false
  window.webContents.send('knote:quit-cancelled')
  return true
})

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
  await question.waitFor({ state: 'attached' })
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
  await clearDialog.waitFor({ state: 'attached' })
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
  await dialog.waitFor({ state: 'attached' })
  assert.equal(await dialog.getAttribute('data-dialog-mode'), 'confirm')
  await dialog.getByTestId('app-dialog-cancel').click()
  await panel.getByText(/I couldn't apply the requested change|这次修改没能实际写入/i).last().waitFor()
  assert.equal(await panel.getByText('用户取消了删除，文件保持不变。', { exact: true }).count(), 0)
  assert.equal(fs.existsSync(target), true, 'cancel must preserve the file')

  await sendPrompt(panel, 'DELETE_ACCEPT')
  await dialog.waitFor({ state: 'attached' })
  await dialog.getByTestId('app-dialog-accept').click()
  await panel.getByText('文件已移入回收站。', { exact: true }).waitFor()
  assert.equal(fs.existsSync(target), false, 'accept must move the temporary file away')
  assert.equal(fs.existsSync(path.join(workspace, 'keep.md')), true, 'unrelated files must remain')
})

test('Agent surfaces isolate drafts and question UI, persist answers, and expose accessible themed controls', async (t) => {
  const { page, panel, workspace, model } = await launchFixture(t)
  const input = panel.getByTestId('agent-input')
  const tabs = () => page.evaluate(() => window.__knoteDebug.tabs.list())
  const tabA = (await tabs()).find((tab) => tab.active)
  assert.ok(tabA)

  const newDocumentCta = page.getByTestId('new-document-cta')
  await newDocumentCta.waitFor({ state: 'visible' })
  const newDocumentTheme = await newDocumentCta.evaluate((element) => {
    const probe = document.createElement('span')
    element.appendChild(probe)
    probe.style.background = 'var(--knote-theme)'
    const theme = getComputedStyle(probe).backgroundColor
    probe.remove()
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, color: style.color, theme }
  })
  assert.equal(newDocumentTheme.background, newDocumentTheme.theme)
  assert.equal(newDocumentTheme.color, 'rgb(255, 255, 255)')

  await page.getByTestId('actions-menu').click()
  const centerEditor = page.getByTestId('center-editor-toggle')
  await centerEditor.waitFor({ state: 'visible' })
  await centerEditor.click()
  await waitUntil(() => page.evaluate(() => document.querySelector('main')?.dataset.editorCentered === 'true'))
  const centeredGeometry = await page.evaluate(() => {
    const main = document.querySelector('main[data-view-mode="single"]')
    const root = document.querySelector('.knote-root')
    const sidebar = main?.querySelector('[data-testid="workspace-sidebar"]')
    const editor = [...(main?.children || [])].find((element) => element.tagName === 'SECTION' && element.getBoundingClientRect().width > 0)
    const editorRect = editor?.getBoundingClientRect()
    return {
      editorCenter: editorRect ? editorRect.left + editorRect.width / 2 : 0,
      viewportCenter: (root?.getBoundingClientRect().left || 0) + (root?.clientWidth || innerWidth) / 2,
      sidebarWidth: sidebar?.getBoundingClientRect().width || 0,
      persisted: localStorage.getItem('knote-editor-centered-v1')
    }
  })
  assert.ok(Math.abs(centeredGeometry.editorCenter - centeredGeometry.viewportCenter) <= 2, JSON.stringify(centeredGeometry))
  assert.ok(centeredGeometry.sidebarWidth >= 287 && centeredGeometry.sidebarWidth <= 289, JSON.stringify(centeredGeometry))
  assert.equal(centeredGeometry.persisted, '1')
  await page.getByTestId('actions-menu').click()
  await page.getByTestId('center-editor-toggle').click()
  await waitUntil(() => page.evaluate(() => document.querySelector('main')?.dataset.editorCentered === 'false'))

  const measureBrand = (element) => {
    const brand = element.querySelector('.knote-agent-empty-brand')
    const column = element.querySelector('.knote-agent-chat-column')
    const panelStyle = getComputedStyle(element)
    const brandStyle = brand ? getComputedStyle(brand) : null
    const panelBefore = getComputedStyle(element, '::before')
    const panelAfter = getComputedStyle(element, '::after')
    const brandRect = brand?.getBoundingClientRect()
    const columnRect = column?.getBoundingClientRect()
    const radius = (selector) => Number.parseFloat(getComputedStyle(element.querySelector(selector)).borderRadius || '0')
    return {
      width: element.getBoundingClientRect().width,
      theme: element.getAttribute('data-agent-theme'),
      backgroundImage: panelStyle.backgroundImage,
      backdropFilter: panelStyle.backdropFilter,
      panelBeforeDisplay: panelBefore.display,
      panelAfterDisplay: panelAfter.display,
      panelAnimations: [panelBefore.animationName, panelAfter.animationName],
      liquidFieldCount: element.querySelectorAll('.knote-agent-liquid-field').length,
      fontFamily: brandStyle?.fontFamily || '',
      fontSize: Number.parseFloat(brandStyle?.fontSize || '0'),
      fontWeight: brandStyle?.fontWeight || '',
      titleBackground: brandStyle?.backgroundImage || '',
      titleAnimation: brandStyle?.animationName || '',
      titlePosition: brandStyle?.backgroundPosition || '',
      titleGlassStrokeWidth: Number.parseFloat(brandStyle?.webkitTextStrokeWidth || '0'),
      expectedSize: columnRect ? Math.min(48, Math.max(30, columnRect.width * 0.12)) : 0,
      titleInside: !!brandRect && !!columnRect && brandRect.left >= columnRect.left - 1 && brandRect.right <= columnRect.right + 1,
      sessionRadius: radius('.knote-agent-session-trigger'),
      suggestionRadius: radius('.knote-agent-suggestions button'),
      composerRadius: radius('.knote-agent-composer')
    }
  }
  const sidebarBrand = await panel.evaluate(measureBrand)
  assert.equal(sidebarBrand.theme, 'white')
  assert.equal(sidebarBrand.backgroundImage, 'none')
  assert.equal(sidebarBrand.backdropFilter, 'none')
  assert.equal(sidebarBrand.panelBeforeDisplay, 'none')
  assert.equal(sidebarBrand.panelAfterDisplay, 'none')
  assert.equal(sidebarBrand.liquidFieldCount, 0)
  assert.match(sidebarBrand.fontFamily, /Cinzel Variable/i)
  assert.ok(Math.abs(sidebarBrand.fontSize - sidebarBrand.expectedSize) <= 0.75)
  assert.equal(sidebarBrand.fontWeight, '900')
  assert.notEqual(sidebarBrand.titleBackground, 'none')
  assert.match(sidebarBrand.titleAnimation, /knote-agent-title-flow/)
  assert.ok(sidebarBrand.titleGlassStrokeWidth > 0)
  assert.equal(sidebarBrand.titleInside, true)
  assert.equal(sidebarBrand.sessionRadius, 10)
  assert.equal(sidebarBrand.suggestionRadius, 12)
  assert.equal(sidebarBrand.composerRadius, 18)
  assert.ok(sidebarBrand.width >= 284 && sidebarBrand.width <= 292, `unexpected sidebar width ${sidebarBrand.width}`)
  await page.waitForTimeout(750)
  const titlePositionAfter = await panel.evaluate((element) => {
    const brand = element.querySelector('.knote-agent-empty-brand')
    return getComputedStyle(brand).backgroundPosition
  })
  assert.notEqual(titlePositionAfter, sidebarBrand.titlePosition,
    'the liquid and frosted layers must flow inside the Knote Agent letterforms')

  const tokenState = await panel.evaluate((element) => {
    const brand = element.querySelector('.knote-agent-empty-brand')
    const before = getComputedStyle(brand).backgroundImage
    document.documentElement.style.setProperty('--color-primary', 'rgb(13, 101, 199)')
    document.documentElement.style.setProperty('--color-accent', 'rgb(151, 31, 171)')
    document.documentElement.style.setProperty('--color-success', 'rgb(17, 131, 73)')
    const after = getComputedStyle(brand).backgroundImage
    const probe = document.createElement('span')
    element.appendChild(probe)
    const resolveBackground = (value) => {
      probe.style.background = value
      return getComputedStyle(probe).backgroundColor
    }
    const brandBackground = resolveBackground('var(--knote-brand)')
    const warmBackground = resolveBackground('var(--knote-brand-warm)')
    const primaryBackground = resolveBackground('var(--color-primary)')
    probe.remove()
    return { before, after, brandBackground, warmBackground, primaryBackground }
  })
  assert.equal(tokenState.after, tokenState.before, 'Daisy primary/accent leaked into the Knote Agent title')
  assert.notEqual(tokenState.brandBackground, tokenState.primaryBackground)
  assert.ok(tokenState.after.includes(tokenState.brandBackground), `title omitted ${tokenState.brandBackground}: ${tokenState.after}`)
  assert.ok(tokenState.after.includes(tokenState.warmBackground), `title omitted ${tokenState.warmBackground}: ${tokenState.after}`)

  await panel.getByTestId('agent-settings-toggle').click()
  const settingsGeometry = await panel.evaluate((element) => {
    const radius = (selector) => Number.parseFloat(getComputedStyle(element.querySelector(selector)).borderRadius || '0')
    return {
      card: radius('.knote-agent-settings-card'),
      protocol: radius('.knote-agent-protocol-switch'),
      field: radius('.knote-agent-setting-field input'),
      save: radius('.knote-agent-settings-save')
    }
  })
  assert.deepEqual(settingsGeometry, { card: 19, protocol: 12, field: 11, save: 11 })
  await panel.getByTestId('agent-theme-aurora').click()
  await waitUntil(async () => (await panel.getAttribute('data-agent-theme')) === 'aurora')
  const aurora = await panel.evaluate((element) => {
    return {
      displays: [getComputedStyle(element, '::before').display, getComputedStyle(element, '::after').display],
      animations: [getComputedStyle(element, '::before').animationName, getComputedStyle(element, '::after').animationName]
    }
  })
  assert.deepEqual(aurora.displays, ['block', 'block'])
  assert.ok(/^agentAurora(?:-|$)/.test(aurora.animations[0]), JSON.stringify(aurora))
  assert.ok(/^agentAuroraSecondary(?:-|$)/.test(aurora.animations[1]), JSON.stringify(aurora))
  await waitUntil(() => page.evaluate(() => JSON.parse(localStorage.getItem('knote-agent-config') || '{}')?.config?.chatTheme === 'aurora'))
  await panel.getByTestId('agent-theme-white').click()
  await waitUntil(async () => (await panel.getAttribute('data-agent-theme')) === 'white')
  await waitUntil(async () => (await panel.evaluate((element) => getComputedStyle(element, '::before').display === 'none' && getComputedStyle(element, '::after').display === 'none')))
  await waitUntil(() => page.evaluate(() => JSON.parse(localStorage.getItem('knote-agent-config') || '{}')?.config?.chatTheme === 'white'))
  await panel.getByTestId('agent-settings-toggle').click()

  await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    agent.agentWorkspaceOpen.value = false
    agent.agentOpen.value = true
  })
  const floatPanel = page.locator('[data-testid="agent-panel"][data-agent-mode="float"]')
  await floatPanel.waitFor({ state: 'visible' })
  await waitUntil(async () => (await floatPanel.evaluate((element) => element.getBoundingClientRect().width)) <= 418)
  const floatBrand = await floatPanel.evaluate(measureBrand)
  assert.ok(floatBrand.width >= 414 && floatBrand.width <= 418, `unexpected default float width ${floatBrand.width}`)
  assert.ok(floatBrand.fontSize > sidebarBrand.fontSize)
  assert.ok(Math.abs(floatBrand.fontSize - floatBrand.expectedSize) <= 0.75)
  assert.equal(floatBrand.titleInside, true)

  await page.setViewportSize({ width: 390, height: 844 })
  const mobile = await floatPanel.evaluate((element) => {
    const panelRect = element.getBoundingClientRect()
    const composerRect = element.querySelector('.knote-agent-composer')?.getBoundingClientRect()
    const controlsRect = element.querySelector('.knote-agent-primary-controls')?.getBoundingClientRect()
    const brand = element.querySelector('.knote-agent-empty-brand')
    const brandRect = brand?.getBoundingClientRect()
    return {
      brandSize: Number.parseFloat(brand ? getComputedStyle(brand).fontSize : '0'),
      panelWidth: panelRect.width,
      brandInside: !!brandRect && brandRect.left >= panelRect.left - 1 && brandRect.right <= panelRect.right + 1,
      brandOverflow: brand ? brand.scrollWidth - brand.clientWidth : 0,
      composerInside: !!composerRect && composerRect.left >= panelRect.left - 1 && composerRect.right <= panelRect.right + 1,
      controlsInside: !!composerRect && !!controlsRect && controlsRect.right <= composerRect.right + 1,
      horizontalOverflow: element.scrollWidth - element.clientWidth,
      overflowing: [...element.querySelectorAll('*')]
        .map((child) => ({ child, rect: child.getBoundingClientRect() }))
        .filter(({ child, rect }) => rect.right > panelRect.right + 1 || child.scrollWidth > child.clientWidth + 1)
        .slice(0, 8)
        .map(({ child, rect }) => ({ className: child.className?.baseVal || child.className || child.tagName, right: rect.right - panelRect.right, overflow: child.scrollWidth - child.clientWidth }))
    }
  })
  assert.ok(mobile.panelWidth >= 340 && mobile.panelWidth <= 344, `unexpected mobile float width ${mobile.panelWidth}`)
  assert.ok(mobile.brandSize >= 40 && mobile.brandSize <= 42)
  assert.equal(mobile.brandInside, true)
  assert.equal(mobile.composerInside, true)
  assert.equal(mobile.controlsInside, true)
  assert.ok(mobile.horizontalOverflow <= 1, `mobile overflow: ${JSON.stringify(mobile)}`)
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    agent.agentActivityStack.value.splice(0, agent.agentActivityStack.value.length,
      { id: 'visual-running', kind: 'read_document', title: 'Reading', detail: 'keep.md', status: 'running', result: '' },
      { id: 'visual-done', kind: 'read_file', title: 'Read', detail: 'notes.md', status: 'done', result: 'Complete' },
      { id: 'visual-error', kind: 'write_file', title: 'Write', detail: 'blocked.md', status: 'error', result: '' })
    agent.agentWorkspaceOpen.value = true
  })
  const activityRows = floatPanel.getByTestId('agent-activity-row')
  await waitUntil(async () => (await activityRows.count()) === 3)
  const activityStyles = await activityRows.evaluateAll((rows) => rows.map((row) => {
    const style = getComputedStyle(row)
    const marker = getComputedStyle(row, '::before')
    return {
      status: row.dataset.status,
      radius: Number.parseFloat(style.borderRadius || '0'),
      transparentBackground: style.backgroundColor === 'transparent' || style.backgroundColor === 'rgba(0, 0, 0, 0)' || /\/ 0\)$/.test(style.backgroundColor),
      divider: Number.parseFloat(style.borderBottomWidth || '0'),
      markerWidth: Number.parseFloat(marker.width || '0'),
      markerColor: marker.backgroundColor
    }
  }))
  assert.ok(activityStyles.every((style) => style.radius === 0))
  assert.ok(activityStyles.every((style) => style.transparentBackground))
  assert.ok(activityStyles.every((style) => style.divider >= 0.5 && Math.abs(style.markerWidth - 2) <= 0.1), `activity geometry: ${JSON.stringify(activityStyles)}`)
  assert.ok(new Set(activityStyles.map((style) => style.markerColor)).size >= 2)
  assert.equal(activityStyles.find((style) => style.status === 'running')?.markerColor, tokenState.brandBackground)
  await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    agent.agentActivityStack.value.splice(0)
    agent.agentWorkspaceOpen.value = false
    agent.agentOpen.value = false
  })

  const surfaceA = await panel.getAttribute('data-agent-surface')
  await input.fill('draft owned by tab A')
  const tabBId = await page.evaluate(() => window.__knoteDebug.tabs.duplicateActive())
  assert.ok(tabBId)
  assert.equal(await page.evaluate((id) => window.__knoteDebug.tabs.switch(id), tabBId), true)
  await waitUntil(async () => (await panel.getAttribute('data-agent-surface')) !== surfaceA, {
    message: 'the duplicate tab did not publish its own Agent surface'
  })
  const surfaceB = await panel.getAttribute('data-agent-surface')
  assert.notEqual(surfaceB, surfaceA)
  assert.equal(await input.inputValue(), '')
  await input.fill('draft owned by tab B')

  assert.equal(await page.evaluate((id) => window.__knoteDebug.tabs.switch(id), tabA.id), true)
  await waitUntil(async () => (await panel.getAttribute('data-agent-surface')) === surfaceA)
  assert.equal(await input.inputValue(), 'draft owned by tab A')
  assert.equal(await page.evaluate((id) => window.__knoteDebug.tabs.switch(id), tabBId), true)
  await waitUntil(async () => (await panel.getAttribute('data-agent-surface')) === surfaceB)
  assert.equal(await input.inputValue(), 'draft owned by tab B')

  assert.equal(await page.evaluate((id) => window.__knoteDebug.tabs.switch(id), tabA.id), true)
  await waitUntil(async () => (await panel.getAttribute('data-agent-surface')) === surfaceA)
  await sendPrompt(panel, 'ASK_SWITCH')
  const question = panel.getByTestId('agent-question')
  await question.getByText('请选择继续方案', { exact: true }).waitFor()

  assert.equal(await page.evaluate((id) => window.__knoteDebug.tabs.switch(id), tabBId), true)
  await waitUntil(async () => (await panel.getAttribute('data-agent-surface')) === surfaceB)
  await question.waitFor({ state: 'hidden' })
  assert.equal(await panel.getByTestId('agent-stop').count(), 0)
  assert.equal(await input.inputValue(), 'draft owned by tab B')

  assert.equal(await page.evaluate((id) => window.__knoteDebug.tabs.switch(id), tabA.id), true)
  await waitUntil(async () => (await panel.getAttribute('data-agent-surface')) === surfaceA)
  await question.getByText('请选择继续方案', { exact: true }).waitFor()
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith('knote-agent-chat') && String(value).includes('"questionAnswer"')) {
        throw new DOMException('question answer quota exceeded', 'QuotaExceededError')
      }
      return original.call(this, key, value)
    }
  })
  await question.getByRole('button', { name: '方案乙', exact: true }).click()
  const answerCard = panel.getByTestId('agent-question-answer-message')
  await answerCard.getByText('方案乙', { exact: true }).waitFor()
  await panel.getByText('原会话已继续：方案乙', { exact: true }).waitFor()
  assert.equal(await answerCard.getAttribute('data-answered'), 'true')
  assert.ok(model.requestCount('ASK_SWITCH') >= 2)
  assert.equal(await page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.startsWith('knote-agent-chat'))
    .some((key) => String(localStorage.getItem(key)).includes('"questionAnswer"'))), false)

  assert.equal(await page.evaluate((id) => window.__knoteDebug.tabs.switch(id), tabBId), true)
  await waitUntil(async () => (await panel.getAttribute('data-agent-surface')) === surfaceB)
  assert.equal(await answerCard.count(), 0)
  assert.equal(await page.evaluate((id) => window.__knoteDebug.tabs.switch(id), tabA.id), true)
  await waitUntil(async () => (await panel.getAttribute('data-agent-surface')) === surfaceA)
  await answerCard.waitFor()

  await page.waitForTimeout(700)
  const answeredRequestCount = model.requestCount('ASK_SWITCH')
  await page.reload({ waitUntil: 'commit', timeout: 90_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
  assert.equal(await page.evaluate((folder) => window.knoteDesktop.reopen('folder', folder), workspace), true)
  await panel.waitFor({ state: 'visible', timeout: 15_000 })
  try {
    await answerCard.getByText('方案乙', { exact: true }).waitFor({ timeout: 15_000 })
  } catch (error) {
    const state = await page.evaluate(async () => {
      const agent = await window.__knoteDebug.agent()
      return {
        activeChatKey: agent.activeChatKey.value,
        activeSessionId: agent.activeSessionId.value,
        activeSurfaceKey: agent.activeAgentSurfaceKey.value,
        sessions: agent.chatSessions.value.map((session) => ({
          id: session.id,
          answers: session.messages
            .filter((message) => message.questionAnswer)
            .map((message) => ({ surfaceKey: message.surfaceKey, questionAnswer: message.questionAnswer }))
        }))
      }
    })
    throw new Error(`${error.message}\nAgent answer state: ${JSON.stringify(state)}`)
  }
  await page.waitForTimeout(500)
  assert.equal(model.requestCount('ASK_SWITCH'), answeredRequestCount, 'reload repeated an already-settled ask_user call')

  await panel.getByTestId('agent-settings-toggle').click()
  await panel.locator('.knote-agent-settings-save').click()
  const dialog = page.getByTestId('app-dialog')
  await dialog.waitFor({ state: 'visible', timeout: 20_000 })
  assert.equal(await dialog.getAttribute('data-dialog-mode'), 'alert')
  assert.equal(await dialog.getAttribute('data-dialog-tone'), 'partial')
  assert.equal(await dialog.getAttribute('role'), 'alertdialog')
  assert.equal(await dialog.locator('input').count(), 0)
  assert.equal(await dialog.getByTestId('app-dialog-cancel').count(), 0)
  const capabilityTheme = await dialog.evaluate((element) => {
    const card = element.querySelector('.knote-app-dialog-card')
    const action = element.querySelector('[data-testid="app-dialog-accept"]')
    const icon = element.querySelector('.knote-app-dialog-alert-icon')
    const html = document.documentElement
    const previousTheme = html.dataset.theme
    const light = { color: getComputedStyle(card).color, background: getComputedStyle(card).backgroundColor }
    const probe = document.createElement('span')
    card.appendChild(probe)
    const resolveBackground = (value) => {
      probe.style.background = value
      return getComputedStyle(probe).backgroundColor
    }
    const actionBackground = getComputedStyle(action).backgroundColor
    const actionColor = getComputedStyle(action).color
    const iconColor = getComputedStyle(icon).color
    const brandBackground = resolveBackground('var(--knote-brand)')
    const themeBackground = resolveBackground('var(--knote-theme)')
    const primaryBackground = resolveBackground('var(--color-primary)')
    probe.style.color = 'var(--knote-brand-warm)'
    const warmColor = getComputedStyle(probe).color
    html.dataset.theme = 'dark'
    probe.style.color = 'var(--color-base-content)'
    const dark = {
      color: getComputedStyle(card).color,
      tokenColor: getComputedStyle(probe).color,
      background: getComputedStyle(card).backgroundColor
    }
    probe.remove()
    if (previousTheme == null) delete html.dataset.theme
    else html.dataset.theme = previousTheme
    return { light, dark, actionBackground, actionColor, iconColor, brandBackground, themeBackground, primaryBackground, warmColor }
  })
  assert.equal(capabilityTheme.dark.color, capabilityTheme.dark.tokenColor)
  assert.notEqual(capabilityTheme.dark.color, capabilityTheme.light.color)
  assert.notEqual(capabilityTheme.dark.background, capabilityTheme.light.background)
  assert.equal(capabilityTheme.actionBackground, capabilityTheme.themeBackground)
  assert.equal(capabilityTheme.actionColor, 'rgb(255, 255, 255)')
  assert.notEqual(capabilityTheme.actionBackground, capabilityTheme.brandBackground)
  assert.notEqual(capabilityTheme.actionBackground, capabilityTheme.primaryBackground)
  assert.equal(capabilityTheme.iconColor, capabilityTheme.warmColor)
  await dialog.getByText('部分能力可用', { exact: true }).waitFor()
  assert.match(await dialog.getByTestId('app-dialog-message').innerText(), /已支持：/)
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid || ''), 'app-dialog-accept')
  await dialog.getByTestId('app-dialog-accept').click()
  await dialog.waitFor({ state: 'hidden' })
  await panel.getByTestId('agent-settings').waitFor({ state: 'hidden' })

  await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    agent.agentWorkspaceOpen.value = false
    agent.agentOpen.value = true
  })
  await floatPanel.waitFor({ state: 'visible' })
  await sendPrompt(panel, 'QUEUE_HOLD')
  await waitUntil(() => model.queueHoldRequests === 1, { message: 'the control-layout run did not reach the model gate' })
  const runningSurface = await panel.getAttribute('data-agent-surface')
  await page.evaluate(() => { void window.__knoteDebug.folder.create() })
  await dialog.waitFor({ state: 'visible' })
  await dialog.locator('input').fill('surface-stays-running')
  await dialog.getByTestId('app-dialog-accept').click()
  await page.getByTestId('current-file-name').filter({ hasText: 'surface-stays-running.md' }).waitFor({ state: 'attached' })
  assert.equal(fs.existsSync(path.join(workspace, 'surface-stays-running.md')), true)
  assert.equal(await panel.getAttribute('data-agent-surface'), runningSurface, 'opening a newly-created workspace file replaced the tab Agent surface')
  await panel.getByTestId('agent-stop').waitFor({ state: 'visible' })
  await panel.getByTestId('agent-run-status').waitFor({ state: 'visible' })
  const workspaceToggle = floatPanel.getByTestId('agent-workspace-toggle')
  assert.match(await workspaceToggle.getAttribute('class'), /is-running/)
  const workspaceSheen = await workspaceToggle.evaluate((element) => {
    const style = getComputedStyle(element, '::before')
    return { content: style.content, animationName: style.animationName }
  })
  assert.notEqual(workspaceSheen.content, 'none')
  assert.match(workspaceSheen.animationName, /knote-agent-workspace-sheen/)
  const controls = await panel.locator('.knote-agent-primary-controls').evaluate((element) => {
    const resolveBackground = (value) => {
      const probe = document.createElement('span')
      probe.style.background = value
      element.appendChild(probe)
      const resolved = getComputedStyle(probe).backgroundColor
      probe.remove()
      return resolved
    }
    const read = (testId) => {
      const button = element.querySelector(`[data-testid="${testId}"]`)
      const rect = button?.getBoundingClientRect()
      const style = button ? getComputedStyle(button) : null
      const tooltip = button ? getComputedStyle(button, '::after') : null
      return {
        x: rect?.x || 0,
        right: rect?.right || 0,
        bottom: rect?.bottom || 0,
        width: rect?.width || 0,
        height: rect?.height || 0,
        text: button?.innerText.trim() || '',
        title: button?.getAttribute('title') || '',
        aria: button?.getAttribute('aria-label') || '',
        svg: Boolean(button?.querySelector('svg')),
        background: style?.backgroundColor || '',
        color: style?.color || '',
        radius: Number.parseFloat(style?.borderRadius || '0'),
        tooltipContent: tooltip?.content || '',
        tooltipShadow: tooltip?.boxShadow || ''
      }
    }
    const composer = element.closest('.knote-agent-composer')
    const composerRect = composer?.getBoundingClientRect()
    const composerRadius = Number.parseFloat(composer ? getComputedStyle(composer).borderRadius : '0')
    const controls = {
      stop: read('agent-stop'),
      queue: read('agent-queue-next'),
      send: read('agent-send'),
      composer: {
        radius: composerRadius,
        right: composerRect?.right || 0,
        bottom: composerRect?.bottom || 0
      },
      tokens: {
        error: resolveBackground('var(--color-error)'),
        queue: resolveBackground('var(--knote-brand-soft)'),
        brand: resolveBackground('var(--knote-brand)'),
        brandStrong: resolveBackground('var(--knote-brand-strong)'),
        primary: resolveBackground('var(--color-primary)')
      }
    }
    return controls
  })
  assert.ok(controls.stop.x < controls.queue.x && controls.queue.x < controls.send.x)
  assert.equal(controls.stop.text + controls.queue.text + controls.send.text, '')
  for (const control of [controls.stop, controls.queue, controls.send]) {
    assert.equal(control.svg, true)
    assert.ok(control.title)
    assert.ok(control.aria)
    assert.notEqual(control.tooltipContent, 'none')
    assert.notEqual(control.tooltipShadow, 'none')
  }
  assert.equal(controls.stop.background, controls.tokens.error)
  assert.equal(controls.queue.background, controls.tokens.queue)
  assert.equal(controls.send.background, controls.tokens.brand)
  assert.equal(controls.send.color, 'rgb(255, 255, 255)')
  assert.equal(controls.send.radius, 10)
  assert.ok(Math.abs(controls.send.width - controls.send.height) <= 1, `send control must be a rounded square: ${JSON.stringify(controls.send)}`)
  assert.ok(Math.abs((controls.composer.right - controls.send.right) - (controls.composer.bottom - controls.send.bottom)) <= 1, JSON.stringify(controls))
  assert.notEqual(controls.send.background, controls.tokens.primary)
  assert.equal(model.releaseQueueHolds(1), 1)
  await panel.getByText('QUEUE_HOLD_MODEL_RETURNED', { exact: true }).waitFor({ timeout: 15_000 })
  await waitUntil(async () => !/is-running/.test(await workspaceToggle.getAttribute('class') || ''), {
    message: 'the workspace running sheen remained active after the run settled'
  })
  await page.evaluate(async () => { (await window.__knoteDebug.agent()).agentOpen.value = false })
})

test('dark theme updates the desktop title bar and preserves readable Agent and editor surfaces', async (t) => {
  const { page, panel, electronApp } = await launchFixture(t)
  await sendPromptAndWaitForReply(page, panel, 'ORDER_REFRESH', { reply: 'E2E_STUB_UNHANDLED', timeout: 15_000 })
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
    if (!window) return
    globalThis.__knoteE2eTitleBarOverlays = []
    const original = window.setTitleBarOverlay.bind(window)
    window.setTitleBarOverlay = (options) => {
      globalThis.__knoteE2eTitleBarOverlays.push({ ...options })
      return original(options)
    }
  })

  await page.getByTestId('theme-menu').click()
  await page.getByTestId('theme-dark').click()
  await waitUntil(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'), {
    message: 'the app did not enter dark theme'
  })
  await waitUntil(async () => (await electronApp.evaluate(() => globalThis.__knoteE2eTitleBarOverlays?.at(-1)?.symbolColor || '')) === '#f3f4f6', {
    message: 'the native titlebar controls did not receive the dark symbol color'
  })

  const dark = await page.evaluate(() => {
    const read = (selector) => {
      const element = document.querySelector(selector)
      const style = element ? getComputedStyle(element) : null
      return style ? { color: style.color, background: style.backgroundColor } : null
    }
    return {
      wco: document.documentElement.classList.contains('knote-wco'),
      titlebar: read('.knote-titlebar'),
      agent: read('[data-testid="agent-panel"][data-agent-mode="sidebar"]'),
      assistant: read('[data-testid="agent-panel"][data-agent-mode="sidebar"] .knote-agent-message-assistant'),
      editor: read('.knote-rich')
    }
  })
  assert.equal(dark.wco, true)
  assert.ok(dark.titlebar && dark.agent && dark.assistant && dark.editor)
  assert.notEqual(dark.titlebar.color, dark.titlebar.background)
  assert.notEqual(dark.agent.color, dark.agent.background)
  assert.notEqual(dark.assistant.color, dark.assistant.background)
  assert.notEqual(dark.assistant.background, 'rgb(255, 255, 255)')
  assert.notEqual(dark.editor.color, dark.editor.background)
  assert.equal(await panel.getAttribute('data-agent-mode'), 'sidebar')

  const contrastFor = (locator) => locator.evaluate((element) => {
    const parse = (value) => {
      const text = String(value || '').trim()
      const values = (text.match(/-?\d*\.?\d+/g) || []).map(Number)
      if (text.startsWith('color(srgb') && values.length >= 3) {
        return { r: values[0], g: values[1], b: values[2], a: values[3] ?? 1 }
      }
      if (text.startsWith('rgb') && values.length >= 3) {
        return { r: values[0] / 255, g: values[1] / 255, b: values[2] / 255, a: values[3] ?? 1 }
      }
      return { r: 0, g: 0, b: 0, a: 0 }
    }
    const over = (top, bottom) => {
      const a = top.a + bottom.a * (1 - top.a)
      if (!a) return { r: 0, g: 0, b: 0, a: 0 }
      return {
        r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
        g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
        b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
        a
      }
    }
    const layers = []
    for (let node = element; node instanceof Element; node = node.parentElement) {
      layers.push(parse(getComputedStyle(node).backgroundColor))
    }
    let background = { r: 1, g: 1, b: 1, a: 1 }
    for (const layer of layers.reverse()) background = over(layer, background)
    const foreground = over(parse(getComputedStyle(element).color), background)
    const luminance = (color) => {
      const linear = [color.r, color.g, color.b].map((channel) => channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4)
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
    }
    const lighter = Math.max(luminance(foreground), luminance(background))
    const darker = Math.min(luminance(foreground), luminance(background))
    return {
      ratio: (lighter + 0.05) / (darker + 0.05),
      color: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor
    }
  })

  await panel.getByTestId('agent-new-session').click()
  await panel.getByTestId('agent-session-toggle').click()
  const sessionPopover = panel.getByTestId('agent-session-popover')
  await sessionPopover.waitFor({ state: 'visible' })
  const activeSessionRow = sessionPopover.locator('.knote-agent-session-row.is-active')
  const inactiveSessionRow = sessionPopover.locator('.knote-agent-session-row:not(.is-active)').first()
  const sessionContrasts = {
    active: await contrastFor(activeSessionRow),
    inactive: await contrastFor(inactiveSessionRow),
    icon: await contrastFor(inactiveSessionRow.locator('.knote-agent-session-row-icon')),
    count: await contrastFor(inactiveSessionRow.locator('.knote-agent-session-count')),
    glow: await sessionPopover.evaluate((element) => {
      const style = getComputedStyle(element, '::before')
      return { display: style.display, background: style.backgroundImage }
    })
  }
  for (const key of ['active', 'inactive', 'icon', 'count']) {
    assert.ok(sessionContrasts[key].ratio >= 4.5, `${key} session contrast: ${JSON.stringify(sessionContrasts[key])}`)
  }
  assert.ok(sessionContrasts.glow.display === 'none' || sessionContrasts.glow.background === 'none', JSON.stringify(sessionContrasts.glow))
  await panel.getByTestId('agent-session-toggle').click()

  await panel.getByTestId('agent-settings-toggle').click()
  const settings = panel.getByTestId('agent-settings')
  await settings.waitFor({ state: 'visible' })
  const settingCheckbox = settings.locator('.knote-agent-setting-checkbox').first()
  await settingCheckbox.check()
  const activeProtocol = settings.locator('.knote-agent-protocol-option.is-active')
  const settingLabel = settings.locator('.knote-agent-setting-toggle>span>span:first-child').first()
  const settingsContrasts = {
    protocol: await contrastFor(activeProtocol),
    setting: await contrastFor(settingLabel),
    checkbox: await contrastFor(settingCheckbox)
  }
  assert.ok(settingsContrasts.protocol.ratio >= 4.5, JSON.stringify(settingsContrasts.protocol))
  assert.ok(settingsContrasts.setting.ratio >= 4.5, JSON.stringify(settingsContrasts.setting))
  assert.ok(settingsContrasts.checkbox.ratio >= 3, JSON.stringify(settingsContrasts.checkbox))
  assert.notEqual(settingsContrasts.protocol.background, 'rgb(255, 255, 255)')
  assert.notEqual(settingsContrasts.protocol.background, 'rgba(255, 255, 255, 0.92)')
  assert.notEqual(settingsContrasts.checkbox.background, 'rgba(0, 0, 0, 0)')
  await panel.getByTestId('agent-settings-toggle').click()

  await page.getByTestId('theme-menu').click()
  await page.getByTestId('theme-light').click()
  await waitUntil(() => page.evaluate(() => document.documentElement.dataset.theme === 'light'))
  await waitUntil(async () => (await electronApp.evaluate(() => globalThis.__knoteE2eTitleBarOverlays?.at(-1)?.symbolColor || '')) === '#4b5563')
})

test('assistant delete revalidates abort, replacement, open-tab state, and normal commit', async (t) => {
  const { page, workspace } = await launchFixture(t)
  const dialog = page.getByTestId('app-dialog')
  const target = path.join(workspace, 'delete-me.md')
  const normalTarget = path.join(workspace, 'notes', 'nested.md')
  const startDelete = (relativePath) => page.evaluate(async (requestedPath) => {
    const agent = await window.__knoteDebug.agent()
    const binding = agent.agentBridge.captureWorkspace()
    const controller = new AbortController()
    window.__knoteE2eDeleteAbort = () => controller.abort()
    return await agent.agentBridge.deleteFile(requestedPath, {
      workspaceId: binding.id,
      workspaceBinding: binding,
      signal: controller.signal
    })
  }, relativePath)

  const aborted = startDelete('delete-me.md')
  await dialog.waitFor({ state: 'visible' })
  await page.evaluate(() => window.__knoteE2eDeleteAbort())
  assert.deepEqual(await aborted, { ok: false, error: 'aborted' })
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(fs.readFileSync(target, 'utf8'), '# Delete me\n')

  const replaced = startDelete('delete-me.md')
  await dialog.waitFor({ state: 'visible' })
  fs.writeFileSync(target, '# Replacement wins\n')
  await dialog.getByTestId('app-dialog-accept').click()
  assert.deepEqual(await replaced, { ok: false, error: 'stale_file' })
  assert.equal(fs.readFileSync(target, 'utf8'), '# Replacement wins\n')

  const opened = startDelete('delete-me.md')
  await dialog.waitFor({ state: 'visible' })
  assert.deepEqual(await page.evaluate(async () => {
    const node = window.__knoteDebug.folder.tree().find((item) => item.path === '/delete-me.md')
    const opened = await window.__knoteDebug.folder.open(node)
    return {
      opened,
      installed: window.__knoteDebug.tabs.list().some((tab) => tab.treePath === '/delete-me.md')
    }
  }), { opened: true, installed: true })
  await dialog.getByTestId('app-dialog-accept').click()
  assert.deepEqual(await opened, { ok: false, error: 'open_in_tab' })
  assert.equal(fs.readFileSync(target, 'utf8'), '# Replacement wins\n')

  const normal = startDelete('notes/nested.md')
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByTestId('app-dialog-accept').click()
  assert.deepEqual(await normal, { ok: true, trashed: true })
  assert.equal(fs.existsSync(normalTarget), false)
  assert.equal(fs.readFileSync(target, 'utf8'), '# Replacement wins\n')
})

test('Agent review policies isolate literal Allow All grants and keep Markdown review explicit', async (t) => {
  const { page, panel, workspace, model } = await launchFixture(t)
  await workspaceTreeRow(page, 'keep.md').click()
  await waitUntil(() => page.evaluate(() => window.__knoteDebug.getContent() === '# Keep\n'))
  const modeToggle = panel.getByTestId('agent-review-mode-toggle')
  const modePopover = panel.getByTestId('agent-review-mode-popover')
  const dialog = page.getByTestId('app-dialog')
  const permission = panel.getByTestId('agent-permission')
  const stateFor = (policy, documentMode = 'tab_manual') => {
    if (policy === 'manual') return 'manual'
    return `${policy}_${documentMode}`
  }
  const waitForMode = (mode) => waitUntil(async () => (await modeToggle.getAttribute('data-review-mode')) === mode, {
    message: `review mode did not become ${mode}`
  })
  const openModePopover = async () => {
    if (!(await modePopover.count()) || !(await modePopover.isVisible())) await modeToggle.click()
    await modePopover.waitFor({ state: 'visible' })
  }
  const closeModePopover = async () => {
    if ((await modePopover.count()) && (await modePopover.isVisible())) await modeToggle.click()
    await modePopover.waitFor({ state: 'hidden' })
  }
  const chooseReviewState = async (policy, documentMode = 'tab_manual') => {
    const expected = stateFor(policy, documentMode)
    if (await modeToggle.getAttribute('data-review-mode') === expected) return
    await openModePopover()
    const policyIds = {
      manual: 'agent-review-policy-manual',
      review: 'agent-review-policy-review',
      allow_all: 'agent-review-policy-allow-all'
    }
    if (await modeToggle.getAttribute('data-review-policy') !== policy) {
      const option = modePopover.getByTestId(policyIds[policy])
      await option.click()
      if (policy === 'allow_all') {
        await dialog.waitFor({ state: 'visible' })
        assert.equal(await dialog.getAttribute('data-dialog-mode'), 'confirm')
        assert.match(await dialog.getByTestId('app-dialog-message').innerText(), /当前 Agent 会话.*当前标签页|current tab in the current Agent session/i)
        await dialog.getByTestId('app-dialog-accept').click()
        await dialog.waitFor({ state: 'hidden' })
      }
      await waitUntil(async () => (await modeToggle.getAttribute('data-review-policy')) === policy)
    }
    if (policy !== 'manual' && await modeToggle.getAttribute('data-document-mode') !== documentMode) {
      await openModePopover()
      await modePopover.getByTestId('agent-review-document-group').click()
    }
    await waitForMode(expected)
    await closeModePopover()
  }
  const waitForAgentIdle = () => waitUntil(
    () => page.evaluate(async () => {
      const agent = await window.__knoteDebug.agent()
      return agent.agentStatus.value !== 'running' && agent.pendingHunksReviewLocked.value !== true
    }),
    { timeout: 25_000, message: 'Agent review scenario did not settle' }
  )

  assert.equal(await modeToggle.getAttribute('aria-haspopup'), 'dialog')
  assert.equal(await modeToggle.getAttribute('data-review-mode'), 'review_tab_manual')
  assert.equal(await modeToggle.getAttribute('data-review-policy'), 'review')
  assert.equal(await modeToggle.getAttribute('data-document-mode'), 'tab_manual')
  assert.equal(await modeToggle.getAttribute('data-allow-all-granted'), 'false')
  assert.equal((await modeToggle.innerText()).trim(), '')
  assert.equal(await modeToggle.locator('svg').count(), 1)
  const restingTrigger = await modeToggle.evaluate((element) => {
    const style = getComputedStyle(element)
    return { border: style.borderTopWidth, background: style.backgroundColor, shadow: style.boxShadow }
  })
  assert.equal(restingTrigger.border, '0px')
  assert.ok(restingTrigger.background === 'rgba(0, 0, 0, 0)' || restingTrigger.background === 'transparent')
  assert.equal(restingTrigger.shadow, 'none')
  await openModePopover()
  assert.equal(await modePopover.getByTestId('agent-review-policy-group').getAttribute('role'), 'radiogroup')
  assert.equal(await modePopover.getByTestId('agent-review-document-group').count(), 1, 'Review must expose its document review switch')
  assert.equal(await modePopover.getByTestId('agent-review-document-group').getAttribute('aria-checked'), 'true')
  assert.equal(await modePopover.locator('[role="radio"]').count(), 3)
  assert.deepEqual(await modePopover.locator('[role="radio"]').allInnerTexts(), ['人工', '审查', '全部通过'])
  assert.equal(await modePopover.locator('.knote-agent-review-policy-copy small').count(), 0)
  const reviewLayout = await modePopover.evaluate((element) => {
    const options = [...element.querySelectorAll('.knote-agent-review-policy-option')]
    const rects = options.map((option) => option.getBoundingClientRect())
    return {
      count: options.length,
      leftSpread: Math.max(...rects.map((rect) => rect.left)) - Math.min(...rects.map((rect) => rect.left)),
      ordered: rects.every((rect, index) => index === 0 || rect.top > rects[index - 1].top),
      toggleCount: element.querySelectorAll('.knote-agent-review-document-toggle').length,
      headerText: element.querySelector('header span')?.textContent || ''
    }
  })
  assert.equal(reviewLayout.count, 3)
  assert.ok(reviewLayout.leftSpread <= 1, JSON.stringify(reviewLayout))
  assert.equal(reviewLayout.ordered, true)
  assert.equal(reviewLayout.toggleCount, 1)
  assert.match(reviewLayout.headerText, /自动审查|reviewed automatically/i)
  const reviewCaptureDir = process.env.KNOTE_CAPTURE_UI
  if (reviewCaptureDir) {
    fs.mkdirSync(reviewCaptureDir, { recursive: true })
    await modePopover.screenshot({ path: path.join(reviewCaptureDir, 'agent-review-options.png') })
  }
  const popoverGeometry = await modePopover.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const panelRect = element.closest('[data-testid="agent-panel"]').getBoundingClientRect()
    return { left: rect.left, right: rect.right, panelLeft: panelRect.left, panelRight: panelRect.right }
  })
  assert.ok(popoverGeometry.left >= popoverGeometry.panelLeft - 1, JSON.stringify(popoverGeometry))
  assert.ok(popoverGeometry.right <= popoverGeometry.panelRight + 1, JSON.stringify(popoverGeometry))

  const reviewPolicy = modePopover.getByTestId('agent-review-policy-review')
  await reviewPolicy.focus()
  await reviewPolicy.press('End')
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByTestId('app-dialog-cancel').click()
  await dialog.waitFor({ state: 'hidden' })
  await waitForMode('review_tab_manual')
  assert.equal(await modeToggle.getAttribute('data-allow-all-granted'), 'false')
  await waitUntil(() => page.evaluate(() => document.activeElement?.dataset?.testid === 'agent-review-policy-allow-all'))
  await closeModePopover()

  await chooseReviewState('manual')
  const reviewsBeforeManual = model.automaticReviewRequests.length
  await sendPrompt(panel, 'MANUAL_REVIEW_CREATE')
  await permission.waitFor({ state: 'visible' })
  assert.equal(model.automaticReviewRequests.length, reviewsBeforeManual)
  assert.equal(fs.existsSync(path.join(workspace, 'manual-review-create.txt')), false)
  await permission.getByTestId('agent-permission-deny').click()
  await waitForAgentIdle()

  await chooseReviewState('review', 'tab_manual')
  const markdownBeforeManualReview = await page.evaluate(async () => (await window.__knoteDebug.agent()).agentBridge.getMarkdown())
  const reviewsBeforeTabManualHunk = model.automaticReviewRequests.length
  await sendPromptAndWaitForReply(page, panel, 'AUTO_REVIEW_HUNK_PASS', { reply: 'AUTO_REVIEW_HUNK_PASS_DONE', timeout: 25_000 })
  const manualHunkState = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return { markdown: agent.agentBridge.getMarkdown(), pending: agent.pendingHunks.value.length }
  })
  assert.equal(manualHunkState.pending, 1)
  assert.equal(manualHunkState.markdown, markdownBeforeManualReview)
  assert.equal(model.automaticReviewRequests.length, reviewsBeforeTabManualHunk)
  await page.getByTestId('agent-reject-all').click()
  await waitUntil(() => page.evaluate(async () => (await window.__knoteDebug.agent()).pendingHunks.value.length === 0))

  await chooseReviewState('review', 'all_auto')
  await openModePopover()
  assert.equal(await modePopover.getByTestId('agent-review-document-group').getAttribute('aria-checked'), 'false')
  await closeModePopover()
  const reviewsBeforeAutomaticHunk = model.automaticReviewRequests.length
  await sendPromptAndWaitForReply(page, panel, 'AUTO_REVIEW_HUNK_PASS', { reply: 'AUTO_REVIEW_HUNK_PASS_DONE', timeout: 25_000 })
  await waitUntil(() => page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return agent.pendingHunks.value.length === 0 && /Automatic accepted/.test(agent.agentBridge.getMarkdown())
  }), { timeout: 15_000, message: 'Review all-auto did not apply the independently reviewed hunk' })
  assert.equal(model.automaticReviewRequests.length, reviewsBeforeAutomaticHunk + 1)
  assert.match(await panel.getByTestId('agent-review-receipt').last().innerText(), /已自动通过|passed automatically/i)
  await chooseReviewState('review', 'tab_manual')

  const reviewsBeforeAutomatic = model.automaticReviewRequests.length
  await sendPromptAndWaitForReply(page, panel, 'AUTO_REVIEW_CREATE', { reply: 'AUTO_REVIEW_CREATE_DONE', timeout: 25_000 })
  assert.equal(fs.readFileSync(path.join(workspace, 'auto-review-create.txt'), 'utf8'), '# AUTO_REVIEW_CREATE\n')
  assert.equal(await permission.count(), 0)
  assert.equal(model.automaticReviewRequests.length, reviewsBeforeAutomatic + 1)
  const reviewRequest = model.automaticReviewRequests.at(-1)
  assert.equal(reviewRequest.temperature, 0)
  assert.notEqual(reviewRequest.stream, true)
  assert.equal(Array.isArray(reviewRequest.tools), false)
  assert.deepEqual(reviewRequest.messages.map((message) => message.role), ['system', 'user'])
  assert.match(await panel.getByTestId('agent-review-receipt').last().innerText(), /已自动通过\s*1\s*项审核|1 review item/i)

  await sendPrompt(panel, 'AUTO_REVIEW_MODE_CHANGE')
  await waitUntil(() => model.automaticReviewHolds === 1, {
    timeout: 25_000,
    message: 'direct automatic reviewer did not reach its mode-change hold point'
  })
  await chooseReviewState('allow_all', 'tab_manual')
  assert.equal(model.releaseAutomaticReviewHolds(1), 1)
  await permission.waitFor({ state: 'visible' })
  assert.match(await permission.innerText(), /模式或会话授权已变化|mode or session grant changed/i)
  assert.equal(fs.existsSync(path.join(workspace, 'auto-review-mode-change.txt')), false)
  await permission.getByTestId('agent-permission-deny').click()
  await waitForAgentIdle()
  await chooseReviewState('review', 'tab_manual')

  for (const [marker, expectedReason, expectedAttempts] of [
    ['AUTO_REVIEW_FAIL', /判定未通过|returned FAIL/i, 1],
    ['AUTO_REVIEW_UNKNOWN', /明确返回 UNKNOWN|explicitly returned UNKNOWN/i, 2]
  ]) {
    const reviewsBefore = model.automaticReviewRequests.length
    await sendPrompt(panel, marker)
    await permission.waitFor({ state: 'visible' })
    assert.match(await permission.innerText(), expectedReason)
    assert.equal(model.automaticReviewRequests.length, reviewsBefore + expectedAttempts)
    assert.equal(fs.existsSync(path.join(workspace, `${marker.toLowerCase().replaceAll('_', '-')}.txt`)), false)
    await permission.getByTestId('agent-permission-deny').click()
    await waitForAgentIdle()
  }

  await chooseReviewState('allow_all', 'tab_manual')
  assert.equal(await modeToggle.getAttribute('data-allow-all-granted'), 'true')
  await openModePopover()
  const documentSwitch = modePopover.getByTestId('agent-review-document-group')
  assert.equal(await documentSwitch.count(), 1)
  assert.equal(await documentSwitch.getAttribute('role'), 'switch')
  assert.equal(await documentSwitch.getAttribute('aria-checked'), 'true')
  assert.equal((await documentSwitch.getByTestId('agent-review-document-label').innerText()).trim(), '编辑文档时人工审核')
  const allowAllLayout = await modePopover.evaluate((element) => {
    const selected = element.querySelector('.knote-agent-review-policy-option.is-active')
    const title = selected?.querySelector('.knote-agent-review-policy-choice>b')
    const toggle = selected?.querySelector('.knote-agent-review-document-toggle')
    const label = toggle?.querySelector('span')
    const track = toggle?.querySelector('i')
    const thumb = track?.querySelector('b')
    const titleRect = title?.getBoundingClientRect()
    const toggleRect = toggle?.getBoundingClientRect()
    const labelRect = label?.getBoundingClientRect()
    const trackRect = track?.getBoundingClientRect()
    const trackStyle = track ? getComputedStyle(track) : null
    const thumbStyle = thumb ? getComputedStyle(thumb) : null
    return {
      toggleInsideSelected: !!selected && !!toggle && selected.contains(toggle),
      sameLine: !!titleRect && !!toggleRect && Math.abs((titleRect.top + titleRect.bottom) / 2 - (toggleRect.top + toggleRect.bottom) / 2) <= 2,
      labelBeforeTrack: !!labelRect && !!trackRect && labelRect.right <= trackRect.left,
      trackRadius: Number.parseFloat(trackStyle?.borderRadius || '0'),
      thumbRadius: Number.parseFloat(thumbStyle?.borderRadius || '0'),
      thumbWidth: Number.parseFloat(thumbStyle?.width || '0'),
      thumbHeight: Number.parseFloat(thumbStyle?.height || '0')
    }
  })
  assert.equal(allowAllLayout.toggleInsideSelected, true)
  assert.equal(allowAllLayout.sameLine, true, JSON.stringify(allowAllLayout))
  assert.equal(allowAllLayout.labelBeforeTrack, true, JSON.stringify(allowAllLayout))
  assert.ok(allowAllLayout.trackRadius < 9 && allowAllLayout.thumbRadius < 6, JSON.stringify(allowAllLayout))
  assert.ok(allowAllLayout.thumbWidth > allowAllLayout.thumbHeight, JSON.stringify(allowAllLayout))
  await closeModePopover()
  const reviewsBeforeAllowAll = model.automaticReviewRequests.length
  await sendPromptAndWaitForReply(page, panel, 'FULL_AUTO_CREATE', { reply: 'FULL_AUTO_CREATE_DONE', timeout: 25_000 })
  assert.equal(fs.readFileSync(path.join(workspace, 'full-auto-create.md'), 'utf8'), '# FULL_AUTO_CREATE\n')
  assert.equal(model.automaticReviewRequests.length, reviewsBeforeAllowAll, 'Allow all unexpectedly called the model reviewer')
  assert.equal(await permission.count(), 0)
  assert.match(await panel.getByTestId('agent-review-receipt').last().innerText(), /全部通过|Allow all/i)

  await sendPromptAndWaitForReply(page, panel, 'FULL_AUTO_CREATE_FOLDER', { reply: 'FULL_AUTO_CREATE_FOLDER_DONE', timeout: 25_000 })
  assert.equal(fs.statSync(path.join(workspace, 'allow-all-folder', 'nested')).isDirectory(), true)
  assert.equal(model.automaticReviewRequests.length, reviewsBeforeAllowAll, 'unsupported create_folder unexpectedly called the model reviewer')
  assert.equal(await permission.count(), 0, 'Allow All must not fall back to a permission card for create_folder')

  const originalSessionId = await page.evaluate(async () => (await window.__knoteDebug.agent()).activeSessionId.value)
  await panel.getByTestId('agent-new-session').click()
  await waitForMode('review_tab_manual')
  const secondSessionId = await page.evaluate(async () => (await window.__knoteDebug.agent()).activeSessionId.value)
  assert.notEqual(secondSessionId, originalSessionId)
  await page.evaluate(async (sessionId) => (await window.__knoteDebug.agent()).switchSession(sessionId), originalSessionId)
  await waitForMode('allow_all_tab_manual')

  const originalTabId = await page.evaluate(() => window.__knoteDebug.tabs.list().find((tab) => tab.active)?.id)
  const duplicateTabId = await page.evaluate(() => window.__knoteDebug.tabs.duplicateActive())
  assert.ok(originalTabId && duplicateTabId)
  assert.equal(await page.evaluate((tabId) => window.__knoteDebug.tabs.switch(tabId), duplicateTabId), true)
  await waitForMode('review_tab_manual')
  assert.equal(await page.evaluate((tabId) => window.__knoteDebug.tabs.switch(tabId), originalTabId), true)
  await waitForMode('allow_all_tab_manual')

  const beforeTabManualPair = await page.evaluate(async () => (await window.__knoteDebug.agent()).agentBridge.getMarkdown())
  const reviewsBeforeTabManualPair = model.automaticReviewRequests.length
  await sendPromptAndWaitForReply(page, panel, 'FULL_AUTO_HUNK_PAIR', { reply: 'FULL_AUTO_HUNK_PAIR_DONE', timeout: 25_000 })
  assert.deepEqual(await page.evaluate(async (before) => {
    const agent = await window.__knoteDebug.agent()
    return { unchanged: agent.agentBridge.getMarkdown() === before, pending: agent.pendingHunks.value.length }
  }, beforeTabManualPair), { unchanged: true, pending: 2 })
  assert.equal(model.automaticReviewRequests.length, reviewsBeforeTabManualPair)
  await page.getByTestId('agent-reject-all').click()
  await waitUntil(() => page.evaluate(async () => (await window.__knoteDebug.agent()).pendingHunks.value.length === 0))

  await chooseReviewState('allow_all', 'all_auto')
  await openModePopover()
  assert.equal(await modePopover.getByTestId('agent-review-document-group').getAttribute('aria-checked'), 'false')
  await closeModePopover()
  const reviewsBeforeAllowAllHunks = model.automaticReviewRequests.length
  await sendPromptAndWaitForReply(page, panel, 'FULL_AUTO_HUNK_PAIR', { reply: 'FULL_AUTO_HUNK_PAIR_DONE', timeout: 25_000 })
  await waitUntil(() => page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return agent.pendingHunks.value.length === 0 && /Full auto pair/.test(agent.agentBridge.getMarkdown())
  }), { timeout: 15_000, message: 'the two full-auto hunks were not applied' })
  const pairReview = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    const message = [...agent.chatMessages.value].reverse().find((item) => item?.text === 'FULL_AUTO_HUNK_PAIR_DONE')
    return message?.receipt?.reviews?.at(-1) || null
  })
  assert.equal(pairReview?.outcome, 'allow_all_accepted')
  assert.equal(pairReview?.itemCount, 2)
  assert.equal(model.automaticReviewRequests.length, reviewsBeforeAllowAllHunks)
  assert.match(await panel.getByTestId('agent-review-receipt').last().innerText(), /全部通过|Allow all/i)

  const markdownBeforeRevocation = await page.evaluate(async () => (await window.__knoteDebug.agent()).agentBridge.getMarkdown())
  await sendPrompt(panel, 'REVIEW_OWNER_HOLD')
  await waitUntil(() => model.reviewOwnerHolds === 1, {
    timeout: 25_000,
    message: 'the owner run did not hold after staging its hunk'
  })
  assert.deepEqual(await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return { pending: agent.pendingHunks.value.length, locked: agent.pendingHunksReviewLocked.value }
  }), { pending: 1, locked: true })
  await chooseReviewState('allow_all', 'tab_manual')
  assert.equal(model.releaseReviewOwnerHolds(1), 1)
  await panel.getByText('REVIEW_OWNER_HOLD_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  await waitForAgentIdle()
  assert.deepEqual(await page.evaluate(async (expectedMarkdown) => {
    const agent = await window.__knoteDebug.agent()
    return {
      unchanged: agent.agentBridge.getMarkdown() === expectedMarkdown,
      pending: agent.pendingHunks.value.length,
      locked: agent.pendingHunksReviewLocked.value
    }
  }, markdownBeforeRevocation), { unchanged: true, pending: 1, locked: false })
  await page.getByTestId('agent-reject-all').click()
  await waitUntil(() => page.evaluate(async () => (await window.__knoteDebug.agent()).pendingHunks.value.length === 0))

  const exclusiveCollision = path.join(workspace, 'exclusive-collision.md')
  fs.writeFileSync(exclusiveCollision, '# External winner\n', { flag: 'wx' })
  assert.deepEqual(await page.evaluate(
    (target) => window.knoteDesktop.fsCreateExclusive(target, '# Must not overwrite\n'),
    exclusiveCollision
  ), { ok: false, code: 'TARGET_EXISTS', reason: 'exact_target_exists' })
  assert.equal(fs.readFileSync(exclusiveCollision, 'utf8'), '# External winner\n')

  await chooseReviewState('allow_all', 'all_auto')
  await sendPromptAndWaitForReply(page, panel, 'DELETE_ACCEPT', { reply: '文件已移入回收站。', timeout: 25_000 })
  await waitForAgentIdle()
  assert.equal(await dialog.count(), 0, 'literal Allow All must not open a second delete confirmation')
  assert.equal(fs.existsSync(path.join(workspace, 'delete-me.md')), false)

  await page.reload({ waitUntil: 'commit', timeout: 90_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
  assert.equal(await page.evaluate((folder) => window.knoteDesktop.reopen('folder', folder), workspace), true)
  await panel.waitFor({ state: 'visible', timeout: 15_000 })
  await waitForMode('review_tab_manual')
  assert.equal(await modeToggle.getAttribute('data-allow-all-granted'), 'false')
  assert.ok(await panel.getByTestId('agent-review-receipt').count(), 'review receipts did not survive renderer reload')
  const auditTypes = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return agent.chatSessions.value
      .find((session) => session.id === agent.activeSessionId.value)?.events
      .map((event) => event.type) || []
  })
  assert.ok(auditTypes.includes('review.mode_changed'))
  assert.ok(auditTypes.includes('review.completed'))

  await chooseReviewState('allow_all', 'all_auto')
  await panel.getByTestId('agent-clear-chat').click()
  await panel.getByTestId('agent-clear-confirm').waitFor({ state: 'visible' })
  await panel.getByTestId('agent-clear-accept').click()
  await panel.getByTestId('agent-clear-confirm').waitFor({ state: 'hidden' })
  await waitForMode('review_tab_manual')
  assert.equal(await modeToggle.getAttribute('data-allow-all-granted'), 'false')
})

test('direct workspace mutations require one session-bound approval and stop before side effects', async (t) => {
  const { page, panel, workspace } = await launchFixture(t)
  const editTarget = path.join(workspace, 'permission-edit.md')
  const createTarget = path.join(workspace, 'must-not-exist.md')
  const useManualReview = async () => {
    assert.equal(await page.evaluate(async () => (await window.__knoteDebug.agent()).setAgentReviewMode('manual')), true)
    await waitUntil(async () => (await panel.getByTestId('agent-review-mode-toggle').getAttribute('data-review-mode')) === 'manual')
  }
  await useManualReview()

  await sendPrompt(panel, 'PERMISSION_DENY')
  const permission = panel.getByTestId('agent-permission')
  await permission.waitFor({ state: 'visible' })
  assert.match(await permission.innerText(), /修改文件|Edit file/)
  assert.equal((await permission.getByTestId('agent-permission-target').innerText()).trim(), 'permission-edit.md')
  assert.equal(fs.readFileSync(editTarget, 'utf8'), '# Permission original\n', 'edit ran before approval')
  await permission.getByTestId('agent-permission-deny').click()
  await panel.getByText(/I couldn't apply the requested change|这次修改没能实际写入/i).last().waitFor({ timeout: 15_000 })
  assert.equal(await panel.getByText('PERMISSION_DENY_DONE', { exact: true }).count(), 0)
  assert.equal(fs.readFileSync(editTarget, 'utf8'), '# Permission original\n', 'denied edit changed the file')
  assert.equal(await permission.count(), 0, 'the repeated denied target prompted again')

  await sendPrompt(panel, 'PERMISSION_ALLOW')
  await permission.waitFor({ state: 'visible' })
  assert.equal(fs.readFileSync(editTarget, 'utf8'), '# Permission original\n', 'second run edited before approval')
  await permission.getByTestId('agent-permission-allow').click()
  try {
    await panel.getByText('PERMISSION_ALLOW_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  } catch (error) {
    throw new Error(`${error.message}\nAgent panel:\n${(await panel.innerText()).slice(-4000)}`)
  }
  assert.equal(fs.readFileSync(editTarget, 'utf8'), '# Permission approved\n')

  await sendPrompt(panel, 'PERMISSION_STOP')
  await permission.waitFor({ state: 'visible' })
  assert.equal(fs.existsSync(createTarget), false)
  await panel.getByTestId('agent-new-session').click()
  await permission.waitFor({ state: 'hidden' })
  await useManualReview()
  await sendPrompt(panel, 'PERMISSION_STOP')
  await permission.waitFor({ state: 'visible' })
  await panel.getByTestId('agent-session-toggle').click()
  const activeRunId = await panel.locator('[data-testid="agent-session-row"][aria-current="true"]')
    .getAttribute('data-session-id')
  const runningRows = panel.locator('[data-testid="agent-session-row"][data-running="true"]')
  assert.equal(await runningRows.count(), 2)
  const originalRow = panel.locator(`[data-testid="agent-session-row"][data-running="true"]:not([data-session-id="${activeRunId}"])`).first()
  const originalRunId = await originalRow.getAttribute('data-session-id')
  await panel.locator(`[data-testid="agent-session-row"][data-session-id="${originalRunId}"]`).click()
  await permission.waitFor({ state: 'visible' })
  await permission.getByTestId('agent-permission-stop').click()
  await panel.getByTestId('agent-session-toggle').click()
  const survivingRow = panel.locator(`[data-testid="agent-session-row"][data-session-id="${activeRunId}"]`)
  assert.equal(await survivingRow.getAttribute('data-running'), 'true', 'stopping one approval aborted the other session')
  await survivingRow.click()
  await permission.waitFor({ state: 'visible' })
  await permission.getByTestId('agent-permission-stop').click()
  assert.equal(fs.existsSync(createTarget), false, 'stop allowed the pending create_file side effect')
})

test('provider protocol validation prevents truncated and invalid tool batches from partially executing', async (t) => {
  const { page, panel, workspace, model } = await launchFixture(t)
  await workspaceTreeRow(page, 'keep.md').click()
  await waitUntil(() => page.evaluate(() => window.__knoteDebug.getContent() === '# Keep\n'))

  await sendPrompt(panel, 'SSE_PROTOCOL')
  await panel.getByText('SSE_PROTOCOL_COMPLETE', { exact: true }).waitFor({ timeout: 15_000 })

  await panel.getByTestId('agent-new-session').click()
  await sendPrompt(panel, 'CONTENT_FILTER_STATE')
  await panel.getByText(/模型拒绝了此请求|model refused this request/i).waitFor({ timeout: 15_000 })
  assert.equal(await panel.getByText('FILTERED_PROVIDER_PROSE_MUST_STAY_HIDDEN', { exact: true }).count(), 0)
  assert.equal(await panel.getByTestId('agent-permission').count(), 0, 'content_filter tool call opened permission')
  assert.equal(fs.existsSync(path.join(workspace, 'filtered-must-not-exist.md')), false)

  await panel.getByTestId('agent-new-session').click()
  await sendPrompt(panel, 'UNKNOWN_TERMINAL_STATE')
  await panel.getByText(/模型连续返回未完成或未知的终止状态|consecutively returned an incomplete or unknown terminal state/i).waitFor({ timeout: 15_000 })
  assert.equal(model.unknownTerminalRequests, 3, 'unknown terminal retries were not bounded')
  assert.equal(await panel.getByText('UNKNOWN_PROVIDER_PROSE_MUST_STAY_HIDDEN', { exact: true }).count(), 0)
  assert.equal(await panel.getByTestId('agent-permission').count(), 0, 'unknown-state tool call opened permission')
  assert.equal(fs.existsSync(path.join(workspace, 'unknown-must-not-exist.md')), false)

  await panel.getByTestId('agent-new-session').click()
  await sendPrompt(panel, 'TRUNCATED_TOOL_BATCH')
  await panel.getByText('TRUNCATED_TOOL_BATCH_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(await panel.getByTestId('agent-permission').count(), 0, 'a truncated call opened permission')
  assert.equal(fs.existsSync(path.join(workspace, 'truncated-must-not-exist.md')), false)
  assert.equal(await panel.getByText('INCOMPLETE_TOOL_PROSE_MUST_STAY_HIDDEN', { exact: true }).count(), 0)

  const retry = model.truncatedToolRetryRequest
  assert.ok(retry)
  assert.ok(retry.messages.some((message) => (
    message?.role === 'user' && messageText(message).includes('重新发送完整的整个工具调用集')
  )))
  assert.equal(retry.messages.some((message) => (
    message?.role === 'assistant' && (message.tool_calls || []).some((call) => call.id === 'call-truncated-create')
  )), false, 'the incomplete assistant tool turn entered provider history')
  assert.equal(retry.messages.some((message) => message?.role === 'tool'), false,
    'a truncated tool call produced a synthetic execution result')

  await panel.getByTestId('agent-new-session').click()
  const before = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return { markdown: agent.agentBridge.getMarkdown(), pending: agent.pendingHunks.value.length }
  })
  await sendPrompt(panel, 'INVALID_SIBLING_BATCH')
  await panel.getByText(/I couldn't apply the requested change|这次修改没能实际写入/i).last().waitFor({ timeout: 15_000 })
  assert.equal(await panel.getByText('INVALID_SIBLING_BATCH_DONE', { exact: true }).count(), 0)
  const after = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return { markdown: agent.agentBridge.getMarkdown(), pending: agent.pendingHunks.value.length }
  })
  assert.deepEqual(after, before, 'the valid sibling staged a partial document mutation')
  assert.equal(await panel.getByTestId('agent-permission').count(), 0, 'the invalid sibling opened permission')
  assert.equal(fs.existsSync(path.join(workspace, 'semantic-valid-must-not-exist.md')), false)
  assert.deepEqual(model.invalidSiblingToolResults.map((result) => result.code), [
    'TOOL_BATCH_REJECTED',
    'INVALID_TOOL_SEMANTICS',
    'INVALID_TOOL_SEMANTICS'
  ])

  await panel.getByTestId('agent-new-session').click()
  await sendPrompt(panel, 'BATCH_INCOMPLETE')
  const batchPermission = panel.getByTestId('agent-permission')
  await batchPermission.waitFor({ state: 'visible' })
  await batchPermission.getByTestId('agent-permission-allow').click()
  await panel.getByText(/I couldn't apply the requested change|这次修改没能实际写入/i).last().waitFor({ timeout: 15_000 })
  assert.equal(fs.existsSync(path.join(workspace, 'keep-incomplete-e2e.md')), false,
    'nonterminal batch-worker prose was written')
  assert.equal(await panel.getByText('INCOMPLETE_BATCH_TEXT_MUST_NOT_BE_WRITTEN', { exact: true }).count(), 0)

  await panel.getByTestId('agent-new-session').click()
  const longLine = `LONG_LINE_PREFIX_${'x'.repeat(45_000)}`
  await page.evaluate(async (markdown) => {
    const agent = await window.__knoteDebug.agent()
    agent.agentBridge.applyMarkdown(markdown)
  }, longLine)
  const beforeLongLine = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return { markdown: agent.agentBridge.getMarkdown(), pending: agent.pendingHunks.value.length }
  })
  await sendPrompt(panel, 'LONG_LINE_CLIPPED')
  await panel.getByText(/I couldn't apply the requested change|这次修改没能实际写入/i).last().waitFor({ timeout: 15_000 })
  const afterLongLine = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return { markdown: agent.agentBridge.getMarkdown(), pending: agent.pendingHunks.value.length }
  })
  assert.deepEqual(afterLongLine, beforeLongLine, 'a clipped physical line established edit coverage')
  assert.equal(model.longLineToolResult?.code, 'RANGE_NOT_READ')

  await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    const originalReadFile = agent.agentBridge.readFile
    agent.agentBridge.readFile = async (path, options) => path === 'keep.md'
      ? Array.from({ length: 26 }, (_item, index) => `FIND_CAP hit ${index + 1}`).join('\n')
      : originalReadFile(path, options)
  })

  await panel.getByTestId('agent-new-session').click()
  await sendPrompt(panel, 'FIND_CAP')
  await panel.getByText('FIND_CAP_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  await panel.getByText(/Source status|来源状态/i).last().waitFor({ timeout: 15_000 })
  await panel.getByTestId('agent-new-session').click()
  await sendPrompt(panel, 'FIND_ZERO')
  await panel.getByText('FIND_ZERO_DONE', { exact: true }).waitFor({ timeout: 15_000 })

  const capEvidence = model.findToolResult('FIND_CAP')
  assert.equal(capEvidence?.ok, true)
  assert.equal(capEvidence?.code, 'SEARCH_PARTIAL')
  assert.equal(capEvidence?.data?.match_count, 25)
  assert.equal(capEvidence?.grounding?.coverage, 'partial')
  assert.equal(capEvidence?.data?.file_cap, true)
  assert.equal(capEvidence?.data?.continuation?.has_more, true)
  assert.equal(capEvidence?.grounding?.requested_range_complete, false)
  assert.equal(capEvidence?.grounding?.projection_complete, true)
  assert.equal(capEvidence?.grounding?.complete, false)
  const zeroEvidence = model.findToolResult('FIND_ZERO')
  assert.equal(zeroEvidence?.ok, true)
  assert.equal(zeroEvidence?.code, 'SEARCH_COMPLETE')
  assert.equal(zeroEvidence?.data?.match_count, 0)
  assert.equal(zeroEvidence?.data?.continuation?.has_more, false)
  assert.equal(zeroEvidence?.grounding?.coverage, 'complete')
  assert.equal(zeroEvidence?.grounding?.source_complete, true)
  assert.equal(zeroEvidence?.grounding?.complete, true)
})

test('Agent provisional streaming, stalled health, copy controls, session order, and create destinations are live', async (t) => {
  const { page, panel, workspace, electronApp, model } = await launchFixture(t)

  await sendPrompt(panel, 'STREAM_PROJECTION')
  const provisional = panel.getByTestId('agent-provisional-message')
  await provisional.getByText('STREAMING_PREFIX', { exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return agent.chatMessages.value.some((message) => String(message.text || '').includes('STREAMING_PREFIX'))
  }), false)
  await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    const session = agent.chatSessions.value.find((item) => item.id === agent.activeSessionId.value)
    session.runtime.lastProgressAt = Date.now() - 31_000
  })
  await waitUntil(async () => (await panel.getByTestId('agent-run-status').getAttribute('data-stalled')) === 'true', {
    timeout: 3_000,
    message: 'Agent status did not expose a stalled stream'
  })
  const stalledStatus = panel.getByTestId('agent-run-status')
  assert.equal(await stalledStatus.getAttribute('data-health'), 'stalled')
  assert.doesNotMatch(await stalledStatus.innerText(), /30 seconds|30 秒/)
  const stalledColor = await stalledStatus.evaluate((element) => {
    const probe = document.createElement('span')
    element.appendChild(probe)
    probe.style.color = 'var(--color-error)'
    const result = { actual: getComputedStyle(element).color, error: getComputedStyle(probe).color }
    probe.remove()
    return result
  })
  assert.equal(stalledColor.actual, stalledColor.error)
  assert.equal(model.sendStreamProjectionHeartbeats(), 1)
  await waitUntil(async () => (await stalledStatus.getAttribute('data-health')) === 'healthy', {
    timeout: 3_000,
    message: 'raw SSE heartbeat bytes did not restore transport health'
  })
  assert.match(await provisional.innerText(), /STREAMING_PREFIX/)
  assert.equal(model.releaseStreamProjectionReplies(), 1)
  await panel.getByText('STREAMING_PREFIX_COMPLETE', { exact: true }).waitFor({ timeout: 15_000 })
  await provisional.waitFor({ state: 'hidden' })

  const firstSessionId = await page.evaluate(async () => (await window.__knoteDebug.agent()).activeSessionId.value)
  await panel.getByTestId('agent-new-session').click()
  await sendPromptAndWaitForReply(page, panel, 'COPY_CONTROLS', { reply: 'COPY_MESSAGE_SOURCE', timeout: 15_000 })
  const secondSessionId = await page.evaluate(async () => (await window.__knoteDebug.agent()).activeSessionId.value)
  await panel.getByTestId('agent-session-toggle').click()
  assert.equal(await panel.getByTestId('agent-session-row').first().getAttribute('data-session-id'), secondSessionId)
  await panel.locator(`[data-testid="agent-session-row"][data-session-id="${firstSessionId}"]`).click()
  await sendPromptAndWaitForReply(page, panel, 'ORDER_REFRESH', { reply: 'E2E_STUB_UNHANDLED', timeout: 15_000 })
  await panel.getByTestId('agent-session-toggle').click()
  assert.equal(await panel.getByTestId('agent-session-row').first().getAttribute('data-session-id'), firstSessionId)
  await panel.locator(`[data-testid="agent-session-row"][data-session-id="${secondSessionId}"]`).click()

  const clipboardText = () => electronApp.evaluate((electronModule) => electronModule.clipboard.readText())
  const messageCopy = panel.getByTestId('agent-message-copy').last()
  await messageCopy.click()
  assert.match(await clipboardText(), /^COPY_MESSAGE_SOURCE/)
  await panel.getByTestId('agent-code-copy').last().click()
  assert.equal(await clipboardText(), 'const copied = true;\n')
  const tableCopy = panel.getByTestId('agent-table-copy').last()
  const tableCopyAppearance = await tableCopy.evaluate((button) => ({
    text: button.innerText.trim(),
    icons: button.querySelectorAll('svg').length,
    fill: getComputedStyle(button.querySelector('.knote-agent-copy-icon')).fill,
    label: button.getAttribute('aria-label')
  }))
  assert.equal(tableCopyAppearance.text, '')
  assert.equal(tableCopyAppearance.icons, 2)
  assert.notEqual(tableCopyAppearance.fill, 'none')
  assert.match(tableCopyAppearance.label, /复制表格|Copy table/i)
  await tableCopy.click()
  assert.equal(await clipboardText(), '| Name | Value |\n| --- | --- |\n| alpha | beta |')
  assert.equal(await tableCopy.getAttribute('data-copy-state'), 'copied')
  assert.match(await tableCopy.getAttribute('aria-label'), /已复制|Copied/i)
  assert.equal((await tableCopy.innerText()).trim(), '')

  await page.getByTestId('workspace-new-file').click()
  const createDialog = page.getByTestId('create-target-dialog')
  await createDialog.waitFor({ state: 'visible' })
  await createDialog.locator('[data-testid="create-target-option"][data-target-path="/notes"]').click()
  await createDialog.getByTestId('create-target-confirm').click()
  const appDialog = page.getByTestId('app-dialog')
  await appDialog.waitFor({ state: 'visible' })
  await appDialog.locator('input').fill('placed-from-header')
  await appDialog.getByTestId('app-dialog-accept').click()
  await waitUntil(() => fs.existsSync(path.join(workspace, 'notes', 'placed-from-header.md')), {
    timeout: 10_000,
    message: 'header create did not use the selected notes directory'
  })
  assert.equal(fs.existsSync(path.join(workspace, 'placed-from-header.md')), false)

  await page.getByTestId('workspace-new-folder').click()
  await createDialog.waitFor({ state: 'visible' })
  await createDialog.getByTestId('create-target-cancel').click()
  await createDialog.waitFor({ state: 'hidden' })
})

test('Agent downloads wait for exact permission and map broker metadata to a verified mutation', async (t) => {
  const { panel, workspace, electronApp, model } = await launchFixture(t)
  const deniedPath = path.join(workspace, 'downloads', 'denied.pdf')
  const approvedPath = path.join(workspace, 'downloads', 'approved.pdf')
  await electronApp.evaluate(async ({ ipcMain }, config) => {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const crypto = process.getBuiltinModule('node:crypto')
    globalThis.__knoteE2eAgentDownloadRequests = []
    ipcMain.removeHandler('knote:agent-download')
    ipcMain.handle('knote:agent-download', async (_event, request) => {
      globalThis.__knoteE2eAgentDownloadRequests.push({ ...request })
      if (request.url === 'https://files.example/download_allow.pdf') {
        return {
          ok: false,
          id: request.id,
          code: 'DOWNLOAD_REDIRECT_APPROVAL_REQUIRED',
          error: 'cross-origin download redirect requires another explicit approval',
          redirect_url: 'https://cdn.example/final-approved.pdf?X-Amz-Signature=LOCAL-ONLY-SECRET'
        }
      }
      const relativePath = String(request.relativePath || '').replace(/\\/g, '/')
      const body = Buffer.from('%PDF-1.7\nrenderer integration\n')
      const destination = path.join(config.workspace, ...relativePath.split('/'))
      await fs.promises.mkdir(path.dirname(destination), { recursive: true })
      await fs.promises.writeFile(destination, body, { flag: 'wx' })
      return {
        ok: true,
        id: request.id,
        relativePath,
        name: path.basename(destination),
        finalUrl: request.url,
        url: request.url,
        contentType: 'application/pdf',
        bytes: body.length,
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
        maxBytes: request.maxBytes,
        cleanupComplete: true,
        internetZone: 'marked',
        publication: 'atomic_hard_link_no_replace',
        verificationSource: 'streamed_quarantine_atomic_publish_readback_motw'
      }
    })
  }, { workspace })

  const downloadRequests = () => electronApp.evaluate(() => [...globalThis.__knoteE2eAgentDownloadRequests])
  const permission = panel.getByTestId('agent-permission')

  await sendPrompt(panel, 'DOWNLOAD_DENY')
  await permission.waitFor({ state: 'visible' })
  assert.match(await permission.innerText(), /下载文件|Download file/)
  assert.equal(
    (await permission.getByTestId('agent-permission-target').innerText()).trim(),
    'https://files.example/download_deny.pdf'
  )
  assert.match(await permission.getByTestId('agent-permission-destination').innerText(), /downloads\/denied\.pdf/)
  assert.match(await permission.getByTestId('agent-permission-detail').innerText(), /无固定单文件限制|No fixed per-file limit/)
  assert.match(await permission.getByTestId('agent-permission-detail').innerText(), /流式写入磁盘|streamed to disk/)
  assert.match(await permission.getByTestId('agent-permission-detail').innerText(), /资源策略|resource policy/)
  assert.match(await permission.getByTestId('agent-permission-detail').innerText(), /不会覆盖|never overwritten/)
  assert.deepEqual(await downloadRequests(), [], 'download IPC started before renderer permission')
  assert.equal(fs.existsSync(deniedPath), false)
  await permission.getByTestId('agent-permission-deny').click()
  await panel.getByText(/I couldn't apply the requested change|这次修改没能实际写入/i).last().waitFor({ timeout: 15_000 })
  assert.equal(await panel.getByText('DOWNLOAD_DENY_DONE', { exact: true }).count(), 0)
  assert.equal(await permission.count(), 0, 'changing only the URL bypassed the destination denial')
  assert.deepEqual(await downloadRequests(), [], 'a denied or bypass-retry download reached the broker')
  assert.equal(fs.existsSync(deniedPath), false, 'a denied download wrote a file')
  assert.equal(model.downloadToolResults.filter((item) => item.instruction === 'DOWNLOAD_DENY').length, 2,
    'the deterministic gate sent a fully non-retryable denial through extra hard-retry passes')

  await sendPrompt(panel, 'DOWNLOAD_ALLOW')
  await permission.waitFor({ state: 'visible' })
  assert.match(await permission.getByTestId('agent-permission-detail').innerText(), /1234567 bytes/)
  assert.deepEqual(await downloadRequests(), [], 'the approved scenario reached the broker before its permission')
  assert.equal(fs.existsSync(approvedPath), false)
  await permission.getByTestId('agent-permission-allow').click()
  const redirectedUrl = 'https://cdn.example/final-approved.pdf?X-Amz-Signature=LOCAL-ONLY-SECRET'
  await waitUntil(async () => (
    (await permission.getByTestId('agent-permission-target').innerText()).trim() === redirectedUrl
  ), { timeout: 15_000, message: 'cross-origin download did not request a second local permission' })
  assert.equal((await downloadRequests()).length, 1, 'redirect response read or wrote the body before second permission')
  assert.equal(fs.existsSync(approvedPath), false)
  await permission.getByTestId('agent-permission-allow').click()
  await panel.getByText('DOWNLOAD_ALLOW_DONE', { exact: true }).waitFor({ timeout: 15_000 })

  const requests = await downloadRequests()
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://files.example/download_allow.pdf')
  assert.equal(requests[0].relativePath, 'downloads/approved.pdf')
  assert.equal(requests[0].maxBytes, 1_234_567)
  assert.match(requests[0].workspaceGrantId, /^folder-/)
  assert.equal(requests[1].url, redirectedUrl)
  assert.equal(requests[1].relativePath, 'downloads/approved.pdf')
  assert.equal(requests[1].maxBytes, 1_234_567)
  assert.equal(fs.existsSync(approvedPath), true)

  const result = model.downloadToolResults.find((item) => item.instruction === 'DOWNLOAD_ALLOW')?.result
  assert.equal(result?.ok, true)
  assert.equal(result?.code, 'FILE_DOWNLOADED')
  assert.equal(result?.data?.path, 'downloads/approved.pdf')
  assert.equal(result?.data?.final_origin, 'https://cdn.example')
  assert.equal(result?.data?.max_bytes, 1_234_567)
  assert.match(result?.data?.sha256 || '', /^[a-f0-9]{64}$/)
  assert.equal(result?.mutation?.type, 'file_downloaded')
  assert.equal(result?.mutation?.verified, true)
  assert.equal(result?.verification?.source, 'streamed_quarantine_atomic_publish_readback_motw')
  assert.equal(result?.verification?.atomicPublish, true)
  assert.equal(result?.verification?.internetZoneMarked, true)
  assert.doesNotMatch(JSON.stringify(result), /LOCAL-ONLY-SECRET|redirect_url/)
})

test('host commands stay unavailable even through direct preload IPC', async (t) => {
  const { page, workspace, userData, tempRoot, electronApp } = await launchFixture(t)
  const allowMarker = path.join(workspace, 'command-allow-ran.txt')
  const executableDocument = path.join(workspace, 'open-path-bypass.cmd')
  fs.writeFileSync(executableDocument, '@echo off\r\necho bypass>open-path-bypass-ran.txt\r\n')
  const openBypass = await page.evaluate(async (target) => {
    try { return await window.knoteDesktop.openPath(target) } catch (error) { return { ok: false, error: String(error?.message || error) } }
  }, executableDocument)
  assert.equal(openBypass.ok, false)
  assert.match(openBypass.error, /file type|UNSAFE_OPEN_PATH|document bridge/i)
  assert.equal(fs.existsSync(path.join(workspace, 'open-path-bypass-ran.txt')), false)
  assert.equal(await page.evaluate((target) => window.knoteDesktop.reopen('folder', target), userData), false,
    'the renderer reopened Knote private state as a writable workspace')
  assert.equal(await page.evaluate((target) => window.knoteDesktop.reopen('folder', target), tempRoot), false,
    'an ancestor folder bypassed the private-state overlap check')
  await electronApp.evaluate((_electron, decision) => {
    globalThis.__knoteE2eAgentCommandRequests = []
    globalThis.__knoteE2eAgentCommandApproval = async (request) => {
      globalThis.__knoteE2eAgentCommandRequests.push(request)
      return decision
    }
  }, true)

  assert.equal(await page.evaluate(() => window.knoteDesktop.agentCommandEnabled), false)
  const rejected = await page.evaluate(async ({ cwd }) => ({
    inline: await window.knoteDesktop.agentCommandRun({
      id: 'e2e-inline-rejected', program: 'node', args: ['-e', 'process.exit()'], cwd, timeoutMs: 1000
    }),
    syntax: await window.knoteDesktop.agentCommandRun({
      id: 'e2e-syntax-rejected', program: 'node', args: ['--check', 'command-allow-e2e.js'], cwd, timeoutMs: 1000
    })
  }), { cwd: workspace })
  assert.equal(rejected.inline.code, 'SANDBOX_UNAVAILABLE')
  assert.equal(rejected.syntax.code, 'SANDBOX_UNAVAILABLE')
  assert.equal(await electronApp.evaluate(() => globalThis.__knoteE2eAgentCommandRequests.length), 0,
    'an unavailable command reached native approval')
  assert.equal(await page.evaluate(() => window.knoteDesktop.agentCommandCancel('e2e-syntax-rejected')), false)
  assert.equal(fs.existsSync(allowMarker), false)
})

test('parallel clarifications remain projected by session without replacing each other', async (t) => {
  const { panel } = await launchFixture(t)
  await sendPrompt(panel, 'ASK_SWITCH')
  const question = panel.getByTestId('agent-question')
  await question.waitFor({ state: 'attached' })

  await panel.getByTestId('agent-session-toggle').click()
  const originalSessionId = await panel.locator('[data-testid="agent-session-row"][aria-current="true"]')
    .getAttribute('data-session-id')
  await panel.getByTestId('agent-session-toggle').click()
  await panel.getByTestId('agent-new-session').click()
  await sendPrompt(panel, 'ASK_TYPED')
  await question.getByText('应当如何处理这段内容？', { exact: true }).waitFor()

  await panel.getByTestId('agent-session-toggle').click()
  const runningRows = panel.locator('[data-testid="agent-session-row"][data-running="true"]')
  assert.equal(await runningRows.count(), 2)
  const secondSessionId = await panel.locator('[data-testid="agent-session-row"][aria-current="true"]')
    .getAttribute('data-session-id')
  assert.ok(originalSessionId)
  assert.ok(secondSessionId)
  assert.notEqual(originalSessionId, secondSessionId)
  await panel.locator(`[data-testid="agent-session-row"][data-session-id="${originalSessionId}"]`).click()
  await question.getByText('请选择继续方案', { exact: true }).waitFor()
  await question.getByRole('button', { name: '方案乙', exact: true }).click()
  const originalReply = panel.getByText('原会话已继续：方案乙', { exact: true })
  await originalReply.waitFor()

  await panel.getByTestId('agent-session-toggle').click()
  await panel.locator(`[data-testid="agent-session-row"][data-session-id="${secondSessionId}"]`).click()
  await originalReply.waitFor({ state: 'detached' })
  await question.getByText('应当如何处理这段内容？', { exact: true }).waitFor()
  await question.getByRole('button', { name: '保留原文', exact: true }).click()
  await panel.getByText('已收到回答：保留原文', { exact: true }).waitFor()
})

test('steer joins the active run at a safe boundary and next waits for that run to settle', async (t) => {
  const { panel, model } = await launchFixture(t)
  await sendPrompt(panel, 'QUEUE_HOLD')
  await waitUntil(
    () => model.queueHoldRequests === 1,
    { message: 'the initial Agent request never reached the model gate' }
  )

  const input = panel.getByTestId('agent-input')
  await input.fill('STEER_APPEND')
  await panel.getByTestId('agent-send').click()
  const steer = panel.locator('[data-testid="agent-queue-item"][data-mode="steer"]')
  await steer.waitFor({ state: 'visible' })

  await input.fill('QUEUE_NEXT')
  await panel.getByTestId('agent-queue-next').click()
  const queuedNext = panel.locator('[data-testid="agent-queue-item"][data-mode="next"]')
  await queuedNext.waitFor({ state: 'visible' })
  const queueVisual = await panel.getByTestId('agent-queue').evaluate((queue) => {
    const rows = [...queue.querySelectorAll('[data-testid="agent-queue-item"]')]
    return {
      indexes: rows.map((row) => row.querySelector('.knote-agent-queue-index')?.textContent?.trim()),
      rowBackgrounds: rows.map((row) => getComputedStyle(row).backgroundColor),
      indexTops: rows.map((row) => row.querySelector('.knote-agent-queue-index')?.getBoundingClientRect().top),
      textTops: rows.map((row) => row.querySelector('p')?.getBoundingClientRect().top),
      cardBackground: getComputedStyle(queue.querySelector('.knote-agent-queue-card')).backgroundColor,
      nextVisible: rows.some((row) => [...row.querySelectorAll(':scope > span')].some((span) => getComputedStyle(span).position !== 'absolute' && /下一条|Next/i.test(span.textContent || '')))
    }
  })
  assert.deepEqual(queueVisual.indexes, ['1', '2'])
  assert.equal(queueVisual.nextVisible, false)
  assert.ok(queueVisual.indexTops.every((top, index) => Math.abs(top - queueVisual.textTops[index]) <= 1.5))
  assert.ok(queueVisual.rowBackgrounds.every((background) => background === 'rgba(0, 0, 0, 0)'))
  assert.deepEqual(model.queueInstructions, ['QUEUE_HOLD'], 'a queued prompt ran before the active request settled')

  assert.equal(model.releaseQueueHolds(1), 1)
  await panel.getByText('STEER_APPEND_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  await panel.getByText('QUEUE_NEXT_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  await panel.getByTestId('agent-queue').waitFor({ state: 'detached' })
  assert.deepEqual(model.queueInstructions.slice(0, 3), ['QUEUE_HOLD', 'STEER_APPEND', 'QUEUE_NEXT'])
})

test('a queued prompt keeps its resolvable original document when focus changes in the same workspace', async (t) => {
  const { page, panel, model } = await launchFixture(t)
  await sendPrompt(panel, 'QUEUE_HOLD')
  try {
    await waitUntil(
      () => model.queueHoldRequests === 1,
      { message: 'the owner run never reached the model gate' }
    )
  } catch (error) {
    const state = await page.evaluate(async () => {
      const agent = await window.__knoteDebug.agent()
      const session = agent.chatSessions.value.find((item) => item.id === agent.activeSessionId.value)
      return {
        queue: session?.queue || [],
        runtime: session?.runtime || null,
        status: agent.agentStatus.value,
        leases: window.__knoteDebug.tabs.list().map((tab) => ({ id: tab.id, leases: tab.agentResidencyLeases }))
      }
    })
    throw new Error(`${error.message}\nstate=${JSON.stringify(state)}`)
  }

  const input = panel.getByTestId('agent-input')
  await input.fill('QUEUE_REBASE')
  await panel.getByTestId('agent-queue-next').click()
  await panel.getByTestId('agent-queue-item').waitFor({ state: 'visible' })
  await openWorkspaceMarkdownInNewTab(page, 'keep.md')

  assert.equal(model.releaseQueueHolds(1), 1)
  await panel.getByText('QUEUE_REBASE_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(await panel.getByTestId('agent-queue-run-here').count(), 0,
    'a focus-only tab change incorrectly required rebasing the queued target')
})

test('cancelling while queued document capture is pending releases the lease and never starts the prompt', async (t) => {
  const { page, panel, model } = await launchFixture(t)
  await sendPrompt(panel, 'QUEUE_HOLD')
  await waitUntil(() => model.queueHoldRequests === 1)

  const input = panel.getByTestId('agent-input')
  await input.fill('QUEUE_CANCEL_CAPTURE')
  await panel.getByTestId('agent-queue-next').click()
  await panel.getByTestId('agent-queue-item').waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => window.__knoteDebug.tabs.holdNextAgentCapture()), true)

  assert.equal(model.releaseQueueHolds(1), 1)
  await waitUntil(
    () => page.evaluate(() => window.__knoteDebug.tabs.agentCaptureWaiting()),
    { timeout: 15_000, message: 'queued promotion never entered the held capture' }
  )
  await panel.getByTestId('agent-queue-cancel').click()
  assert.equal(await page.evaluate(() => window.__knoteDebug.tabs.releaseAgentCapture()), true)
  await panel.getByTestId('agent-queue').waitFor({ state: 'detached' })
  await waitUntil(() => page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return agent.agentStatus.value !== 'running' && window.__knoteDebug.tabs.list().every((tab) => tab.agentResidencyLeases === 0)
  }), { timeout: 15_000 })

  assert.equal(model.queueInstructions.includes('QUEUE_CANCEL_CAPTURE'), false)
})

test('pending hunk review stays visible, locks for its owner, and ignores unrelated surface runs', async (t) => {
  const { page, panel, model } = await launchFixture(t)
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--color-primary', 'rgb(13, 101, 199)')
    document.documentElement.style.setProperty('--color-accent', 'rgb(151, 31, 171)')
  })
  await workspaceTreeRow(page, 'keep.md').click()
  await waitUntil(() => page.evaluate(() => window.__knoteDebug.getContent() === '# Keep\n'))

  await sendPrompt(panel, 'REVIEW_OWNER_HOLD')
  await waitUntil(() => model.reviewOwnerHolds === 1, {
    timeout: 15_000,
    message: 'the review owner did not pause after staging its hunk'
  })
  await waitUntil(() => page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return agent.pendingHunksForCurrentDocument.value.length === 1 && agent.pendingHunksReviewLocked.value
  }))

  const reviewBar = page.getByTestId('agent-review-bar')
  await reviewBar.waitFor({ state: 'visible' })
  assert.equal(await reviewBar.getAttribute('data-review-locked'), 'true')
  assert.equal(await reviewBar.getByTestId('agent-accept-all').isDisabled(), true)
  assert.equal(await reviewBar.getByTestId('agent-reject-all').isDisabled(), true)
  assert.match(await reviewBar.innerText(), /全部接受|Accept all/)
  assert.match(await reviewBar.innerText(), /全部拒绝|Reject all/)
  const reviewTheme = await reviewBar.evaluate((element) => {
    const probe = document.createElement('span')
    element.appendChild(probe)
    const resolveBackground = (value) => {
      probe.style.background = value
      return getComputedStyle(probe).backgroundColor
    }
    const result = {
      pulse: getComputedStyle(element.querySelector('.knote-agent-review-pulse')).backgroundColor,
      accept: getComputedStyle(element.querySelector('[data-testid="agent-accept-all"]')).backgroundColor,
      brand: resolveBackground('var(--knote-brand)'),
      primary: resolveBackground('var(--color-primary)')
    }
    probe.remove()
    return result
  })
  assert.equal(reviewTheme.pulse, reviewTheme.brand)
  assert.equal(reviewTheme.accept, reviewTheme.brand)
  assert.notEqual(reviewTheme.accept, reviewTheme.primary)

  await page.setViewportSize({ width: 390, height: 844 })
  const mobileReview = await reviewBar.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const children = [...element.children].map((child) => child.getBoundingClientRect())
    return {
      left: rect.left,
      right: rect.right,
      viewport: window.innerWidth,
      overflow: element.scrollWidth - element.clientWidth,
      childrenInside: children.every((child) => child.left >= rect.left - 1 && child.right <= rect.right + 1)
    }
  })
  assert.ok(mobileReview.left >= 0 && mobileReview.right <= mobileReview.viewport)
  assert.ok(mobileReview.overflow <= 1, `mobile review overflow: ${JSON.stringify(mobileReview)}`)
  assert.equal(mobileReview.childrenInside, true)
  await page.setViewportSize({ width: 1440, height: 900 })

  const hunkButtons = page.locator('.knote-agent-new .knote-agent-btn')
  await waitUntil(async () => (await hunkButtons.count()) === 2, {
    message: 'the locked proposal was not painted into the editor'
  })
  assert.equal(await hunkButtons.nth(0).isDisabled(), true)
  assert.equal(await hunkButtons.nth(1).isDisabled(), true)

  const guarded = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    const id = agent.pendingHunks.value[0].id
    const before = agent.agentBridge.getMarkdown()
    const results = [
      agent.acceptHunk(id),
      agent.rejectHunk(id),
      agent.acceptAllHunks(),
      agent.rejectAllHunks()
    ]
    return {
      before,
      after: agent.agentBridge.getMarkdown(),
      pending: agent.pendingHunks.value.length,
      results
    }
  })
  assert.deepEqual(guarded.results, [false, false, false, false])
  assert.equal(guarded.after, guarded.before)
  assert.equal(guarded.pending, 1)

  const layerOrder = await page.evaluate(() => ({
    review: Number(getComputedStyle(document.querySelector('[data-testid="agent-review-bar"]')).zIndex),
    dock: Number(getComputedStyle(document.querySelector('.knote-agent-dock')).zIndex)
  }))
  assert.ok(layerOrder.review > layerOrder.dock, `review bar layer ${layerOrder.review} did not clear Agent dock ${layerOrder.dock}`)

  assert.equal(model.releaseReviewOwnerHolds(1), 1)
  await panel.getByText('REVIEW_OWNER_HOLD_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  await waitUntil(() => page.evaluate(async () => !(await window.__knoteDebug.agent()).pendingHunksReviewLocked.value), {
    message: 'review did not unlock when its owner run settled'
  })
  assert.equal(await reviewBar.getAttribute('data-review-locked'), 'false')
  assert.equal(await hunkButtons.nth(0).isDisabled(), false)
  assert.equal(await hunkButtons.nth(1).isDisabled(), false)

  await openWorkspaceMarkdownInNewTab(page, 'workspace-race.md')
  await sendPrompt(panel, 'QUEUE_HOLD')
  await waitUntil(() => model.queueHoldRequests === 1, { message: 'the unrelated surface run did not start' })
  assert.equal(await switchWorkspaceDocumentTab(page, '/keep.md'), true)
  await waitUntil(() => page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return agent.pendingHunksForCurrentDocument.value.length === 1 && agent.agentStatus.value === 'running'
  }))

  assert.equal(await reviewBar.getAttribute('data-review-locked'), 'false')
  assert.equal(await reviewBar.getByTestId('agent-reject-all').isDisabled(), false)
  assert.equal(await hunkButtons.nth(0).isDisabled(), false)
  await reviewBar.getByTestId('agent-reject-all').click()
  await reviewBar.waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(async () => (await window.__knoteDebug.agent()).pendingHunks.value.length), 0)

  assert.equal(model.releaseQueueHolds(1), 1)
  await waitUntil(() => page.evaluate(async () => (await window.__knoteDebug.agent()).agentStatus.value !== 'running'), {
    timeout: 15_000,
    message: 'the unrelated surface run did not settle'
  })
})

test('read_document stays bound to A and stages there after the user switches to B', async (t) => {
  const { page, panel, workspace, model } = await launchFixture(t)
  await workspaceTreeRow(page, 'keep.md').click()
  await waitUntil(() => page.evaluate(() => window.__knoteDebug.getContent() === '# Keep\n'))

  await sendPrompt(panel, 'DOC_BIND_BACKGROUND')
  await waitUntil(
    () => model.documentBindingWaits >= 1,
    { timeout: 15_000, message: 'read_document did not reach the delayed post-read model gate' }
  )

  assert.equal(await openWorkspaceMarkdownInNewTab(page, 'workspace-race.md'), undefined)
  await waitUntil(() => page.evaluate(() => window.__knoteDebug.getContent() === '# Workspace A\n'))
  assert.equal(model.releaseDocumentBindingReplies(1), 1)
  await panel.getByText('DOC_BIND_BACKGROUND_DONE', { exact: true }).waitFor({ timeout: 15_000 })

  const backgroundState = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return {
      current: window.__knoteDebug.getContent(),
      pending: agent.pendingHunks.value.map((hunk) => ({ documentId: hunk.documentId, newLines: hunk.newLines })),
      pendingForCurrent: agent.pendingHunksForCurrentDocument.value.length,
      tabs: window.__knoteDebug.tabs.list()
    }
  })
  assert.equal(backgroundState.current, '# Workspace A\n')
  assert.equal(backgroundState.pendingForCurrent, 0, 'A proposals were painted into B')
  assert.deepEqual(backgroundState.pending.flatMap((hunk) => hunk.newLines), ['# Keep edited in background'])
  assert.equal(fs.readFileSync(path.join(workspace, 'keep.md'), 'utf8'), '# Keep\n')
  assert.equal(fs.readFileSync(path.join(workspace, 'workspace-race.md'), 'utf8'), '# Workspace A\n')

  assert.equal(await switchWorkspaceDocumentTab(page, '/keep.md'), true)
  await waitUntil(async () => page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return window.__knoteDebug.getContent() === '# Keep\n' && agent.pendingHunksForCurrentDocument.value.length === 1
  }))
  const leases = await page.evaluate(() => window.__knoteDebug.tabs.list().map((tab) => tab.agentResidencyLeases))
  assert.ok(leases.every((count) => count === 0), `run leaked document leases: ${JSON.stringify(leases)}`)
})

test('read_file edit_file stages an opened background buffer instead of returning OPEN_IN_TAB', async (t) => {
  const { page, panel, workspace, model } = await launchFixture(t)
  await workspaceTreeRow(page, 'keep.md').click()
  await openWorkspaceMarkdownInNewTab(page, 'workspace-race.md')
  assert.equal(await switchWorkspaceDocumentTab(page, '/keep.md'), true)

  await sendPrompt(panel, 'BUFFER_EDIT_BACKGROUND')
  const permission = panel.getByTestId('agent-permission')
  await permission.waitFor({ state: 'visible', timeout: 15_000 })
  await permission.getByTestId('agent-permission-allow').click()
  await panel.getByText('BUFFER_EDIT_BACKGROUND_DONE', { exact: true }).waitFor({ timeout: 15_000 })

  const result = model.documentBindingToolResult('BUFFER_EDIT_BACKGROUND')
  assert.equal(result?.code, 'HUNK_STAGED')
  assert.notEqual(result?.code, 'OPEN_IN_TAB')
  const state = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return {
      current: window.__knoteDebug.getContent(),
      pendingForCurrent: agent.pendingHunksForCurrentDocument.value.length,
      newLines: agent.pendingHunks.value.flatMap((hunk) => hunk.newLines || [])
    }
  })
  assert.equal(state.current, '# Keep\n')
  assert.equal(state.pendingForCurrent, 0)
  assert.deepEqual(state.newLines, ['# Workspace A edited from bound buffer'])
  assert.equal(fs.readFileSync(path.join(workspace, 'workspace-race.md'), 'utf8'), '# Workspace A\n')

  assert.equal(await switchWorkspaceDocumentTab(page, '/workspace-race.md'), true)
  await waitUntil(async () => page.evaluate(async () => (await window.__knoteDebug.agent()).pendingHunksForCurrentDocument.value.length === 1))
  assert.equal(await page.evaluate(() => window.__knoteDebug.getContent()), '# Workspace A\n')
})

test('read_file fails with TARGET_AMBIGUOUS when two editable tabs own the same workspace path', async (t) => {
  const { page, panel, workspace, model } = await launchFixture(t)
  await workspaceTreeRow(page, 'workspace-race.md').click()
  assert.ok(await page.evaluate(() => window.__knoteDebug.tabs.duplicateActive()))

  await sendPrompt(panel, 'BUFFER_EDIT_AMBIGUOUS')
  await waitUntil(() => !!model.documentBindingToolResult('BUFFER_EDIT_AMBIGUOUS'), { timeout: 15_000 })
  await waitUntil(() => page.evaluate(async () => (await window.__knoteDebug.agent()).agentStatus.value !== 'running'), { timeout: 20_000 })

  const result = model.documentBindingToolResult('BUFFER_EDIT_AMBIGUOUS')
  assert.equal(result?.ok, false)
  assert.equal(result?.code, 'TARGET_AMBIGUOUS')
  assert.equal(await page.evaluate(async () => (await window.__knoteDebug.agent()).pendingHunks.value.length), 0)
  assert.equal(fs.readFileSync(path.join(workspace, 'workspace-race.md'), 'utf8'), '# Workspace A\n')
})

test('replace_all refuses matches outside the ranges actually returned by read_file', async (t) => {
  const { page, panel, workspace, model } = await launchFixture(t)
  const original = fs.readFileSync(path.join(workspace, 'partial-replace.md'), 'utf8')
  await sendPrompt(panel, 'BUFFER_EDIT_PARTIAL_ALL')
  const permission = panel.getByTestId('agent-permission')
  await permission.waitFor({ state: 'visible', timeout: 15_000 })
  await permission.getByTestId('agent-permission-allow').click()
  await waitUntil(() => !!model.documentBindingToolResult('BUFFER_EDIT_PARTIAL_ALL'), { timeout: 15_000 })
  await waitUntil(() => page.evaluate(async () => (await window.__knoteDebug.agent()).agentStatus.value !== 'running'), { timeout: 20_000 })

  const result = model.documentBindingToolResult('BUFFER_EDIT_PARTIAL_ALL')
  assert.equal(result?.ok, false)
  assert.equal(result?.code, 'RANGE_NOT_READ')
  assert.ok(result?.data?.unread_ranges?.some((range) => range.start === 550 && range.end === 550))
  assert.equal(fs.readFileSync(path.join(workspace, 'partial-replace.md'), 'utf8'), original)
})

test('edit_file returns DOCUMENT_STALE after a real edit to its bound open target', async (t) => {
  const { page, panel, model } = await launchFixture(t)
  await workspaceTreeRow(page, 'keep.md').click()
  await openWorkspaceMarkdownInNewTab(page, 'workspace-race.md')
  assert.equal(await switchWorkspaceDocumentTab(page, '/keep.md'), true)

  await sendPrompt(panel, 'BUFFER_EDIT_STALE')
  await waitUntil(() => model.documentBindingWaits >= 1, { timeout: 15_000 })
  assert.equal(await switchWorkspaceDocumentTab(page, '/workspace-race.md'), true)
  await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    agent.agentBridge.applyMarkdown('# Workspace A user edit\n')
  })
  assert.equal(await switchWorkspaceDocumentTab(page, '/keep.md'), true)
  assert.equal(model.releaseDocumentBindingReplies(1), 1)
  const permission = panel.getByTestId('agent-permission')
  await permission.waitFor({ state: 'visible', timeout: 15_000 })
  await permission.getByTestId('agent-permission-allow').click()
  await waitUntil(() => !!model.documentBindingToolResult('BUFFER_EDIT_STALE'), { timeout: 15_000 })
  await waitUntil(() => page.evaluate(async () => (await window.__knoteDebug.agent()).agentStatus.value !== 'running'), { timeout: 20_000 })

  assert.equal(model.documentBindingToolResult('BUFFER_EDIT_STALE')?.code, 'DOCUMENT_STALE')
  const state = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    const target = window.__knoteDebug.tabs.list().find((tab) => tab.treePath === '/workspace-race.md')
    await window.__knoteDebug.tabs.switch(target.id)
    return { content: window.__knoteDebug.getContent(), pending: agent.pendingHunks.value.length }
  })
  assert.equal(state.content, '# Workspace A user edit\n')
  assert.equal(state.pending, 0)
  assert.doesNotMatch(state.content, /edited from bound buffer/)
})

test('closing an edit_file target aborts its owner run and leaves zero staged or disk miswrite', async (t) => {
  const { page, panel, workspace, model } = await launchFixture(t)
  await workspaceTreeRow(page, 'keep.md').click()
  await openWorkspaceMarkdownInNewTab(page, 'workspace-race.md')
  assert.equal(await switchWorkspaceDocumentTab(page, '/keep.md'), true)

  await sendPrompt(panel, 'BUFFER_EDIT_CLOSED')
  await waitUntil(() => model.documentBindingWaits >= 1, { timeout: 15_000 })
  const closed = await page.evaluate(async () => {
    const target = window.__knoteDebug.tabs.list().find((tab) => tab.treePath === '/workspace-race.md')
    await window.__knoteDebug.tabs.close(target.id)
    return !window.__knoteDebug.tabs.list().some((tab) => tab.id === target.id)
  })
  assert.equal(closed, true)
  assert.equal(model.releaseDocumentBindingReplies(1), 1)
  await waitUntil(() => page.evaluate(async () => (await window.__knoteDebug.agent()).agentStatus.value !== 'running'), { timeout: 20_000 })

  assert.equal(model.documentBindingToolResult('BUFFER_EDIT_CLOSED'), null, 'the aborted run unexpectedly resumed its edit tool')
  const state = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return {
      content: window.__knoteDebug.getContent(),
      pending: agent.pendingHunks.value.length,
      leases: window.__knoteDebug.tabs.list().map((tab) => tab.agentResidencyLeases)
    }
  })
  assert.equal(state.content, '# Keep\n')
  assert.equal(state.pending, 0)
  assert.ok(state.leases.every((count) => count === 0))
  assert.equal(fs.readFileSync(path.join(workspace, 'workspace-race.md'), 'utf8'), '# Workspace A\n')
})

test('another session reaches its model gate immediately and stopping it preserves the owner run', async (t) => {
  const { panel, model } = await launchFixture(t)
  await sendPrompt(panel, 'QUEUE_HOLD')
  await waitUntil(
    () => model.queueHoldRequests === 1,
    { message: 'the owner session did not reach the model gate' }
  )

  await panel.getByTestId('agent-session-toggle').click()
  const ownerSessionId = await panel.locator('[data-testid="agent-session-row"][aria-current="true"]')
    .getAttribute('data-session-id')
  assert.ok(ownerSessionId)
  await panel.getByTestId('agent-session-toggle').click()
  await panel.getByTestId('agent-new-session').click()

  await sendPrompt(panel, 'QUEUE_SESSION_B')
  await waitUntil(
    () => model.queueHoldRequests === 2,
    { message: 'session B did not reach its model gate while session A remained held' }
  )
  assert.deepEqual(model.queueInstructions.slice(0, 2), ['QUEUE_HOLD', 'QUEUE_SESSION_B'])

  await panel.getByTestId('agent-session-toggle').click()
  assert.equal(await panel.locator('[data-testid="agent-session-row"][data-running="true"]').count(), 2)
  await panel.getByTestId('agent-session-toggle').click()
  await panel.getByTestId('agent-stop').click()
  await panel.getByText('（已停止）', { exact: true }).waitFor({ timeout: 15_000 })

  await panel.getByTestId('agent-session-toggle').click()
  const ownerRow = panel.locator(`[data-testid="agent-session-row"][data-session-id="${ownerSessionId}"]`)
  assert.equal(await ownerRow.getAttribute('data-running'), 'true', 'stopping session B aborted session A')
  await ownerRow.click()

  assert.equal(model.releaseQueueHolds(1), 1)
  await panel.getByText('QUEUE_HOLD_MODEL_RETURNED', { exact: true }).waitFor()
  assert.equal(await panel.getByText('QUEUE_SESSION_B_DONE', { exact: true }).count(), 0,
    'the stopped session B reply leaked into the owner session')
})

test('the renderer admits at most three session runs and starts the fourth when a slot opens', async (t) => {
  const { panel, model } = await launchFixture(t)
  await sendPrompt(panel, 'QUEUE_HOLD')
  await waitUntil(() => model.queueHoldRequests === 1)

  await panel.getByTestId('agent-new-session').click()
  await sendPrompt(panel, 'QUEUE_SESSION_B')
  await waitUntil(() => model.queueHoldRequests === 2)

  await panel.getByTestId('agent-new-session').click()
  await sendPrompt(panel, 'QUEUE_HOLD')
  await waitUntil(() => model.queueHoldRequests === 3)
  await panel.getByTestId('agent-session-toggle').click()
  const thirdSessionId = await panel.locator('[data-testid="agent-session-row"][aria-current="true"]')
    .getAttribute('data-session-id')
  await panel.getByTestId('agent-session-toggle').click()

  await panel.getByTestId('agent-new-session').click()
  await panel.getByTestId('agent-session-toggle').click()
  const fourthSessionId = await panel.locator('[data-testid="agent-session-row"][aria-current="true"]')
    .getAttribute('data-session-id')
  await panel.getByTestId('agent-session-toggle').click()
  await sendPrompt(panel, 'QUEUE_SESSION_CANCEL')
  await panel.locator('[data-testid="agent-queue-item"][data-mode="next"]').waitFor({ state: 'visible' })
  assert.equal(model.queueInstructions.includes('QUEUE_SESSION_CANCEL'), false,
    'a fourth session exceeded the three-run cap')

  await panel.getByTestId('agent-session-toggle').click()
  assert.equal(await panel.locator('[data-testid="agent-session-row"][data-running="true"]').count(), 3)
  await panel.locator(`[data-testid="agent-session-row"][data-session-id="${thirdSessionId}"]`).click()
  await panel.getByTestId('agent-stop').click()
  await waitUntil(
    () => model.queueInstructions.includes('QUEUE_SESSION_CANCEL'),
    { message: 'the queued fourth session did not start when a run slot opened' }
  )

  await panel.getByTestId('agent-session-toggle').click()
  await panel.locator(`[data-testid="agent-session-row"][data-session-id="${fourthSessionId}"]`).click()
  await panel.getByText('QUEUE_SESSION_CANCEL_RAN', { exact: true }).waitFor({ timeout: 15_000 })
})

test('reload excludes every live run id and resumes the same-session FIFO successor', async (t) => {
  const { page, panel, workspace, model } = await launchFixture(t)
  await sendPrompt(panel, 'QUEUE_HOLD')
  await waitUntil(
    () => model.queueHoldRequests === 1,
    { message: 'the run that should be interrupted never reached the model gate' }
  )

  await panel.getByTestId('agent-session-toggle').click()
  const ownerSessionId = await panel.locator('[data-testid="agent-session-row"][aria-current="true"]')
    .getAttribute('data-session-id')
  assert.ok(ownerSessionId)
  await panel.getByTestId('agent-session-toggle').click()
  await panel.getByTestId('agent-new-session').click()
  await sendPrompt(panel, 'QUEUE_SESSION_B')
  await waitUntil(
    () => model.queueHoldRequests === 2,
    { message: 'the second live run never reached the model gate before reload' }
  )
  const input = panel.getByTestId('agent-input')
  await input.fill('QUEUE_RELOAD')
  await panel.getByTestId('agent-queue-next').click()
  await panel.locator('[data-testid="agent-queue-item"][data-mode="next"]').waitFor({ state: 'visible' })

  await page.reload({ waitUntil: 'commit', timeout: 90_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
  assert.equal(await page.evaluate((folder) => window.knoteDesktop.reopen('folder', folder), workspace), true)
  await page.getByText('delete-me.md', { exact: true }).first().waitFor({ state: 'attached', timeout: 15_000 })
  await panel.waitFor({ state: 'visible', timeout: 15_000 })
  try {
    await panel.getByText('QUEUE_RELOAD_DONE', { exact: true }).waitFor({ timeout: 20_000 })
  } catch (error) {
    const queueState = await panel.getByTestId('agent-queue').count()
      ? await panel.getByTestId('agent-queue').innerText()
      : '(no queue UI)'
    const persisted = await page.evaluate(() => Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => key.startsWith('knote-agent-chat'))
        .map((key) => [key, localStorage.getItem(key)])
    ))
    throw new Error(`${error.message}\nqueue=${queueState}\ninstructions=${JSON.stringify(model.queueInstructions)}\nstorage=${JSON.stringify(persisted)}`)
  }
  assert.deepEqual(model.queueInstructions.slice(0, 3), ['QUEUE_HOLD', 'QUEUE_SESSION_B', 'QUEUE_RELOAD'])

  await panel.getByText(/(?:上次 Agent )?运行因应用关闭或刷新而中断|(?:previous Agent )?run (?:was )?interrupted/i).waitFor()

  await panel.getByTestId('agent-session-toggle').click()
  await panel.locator(`[data-testid="agent-session-row"][data-session-id="${ownerSessionId}"]`).click()
  await panel.getByText(/(?:上次 Agent )?运行因应用关闭或刷新而中断|(?:previous Agent )?run (?:was )?interrupted/i).waitFor()
  assert.equal(await panel.getByText('QUEUE_RELOAD_DONE', { exact: true }).count(), 0,
    'the recovered queued reply appeared in the interrupted owner session')
})

test('a completed reply recovers from IndexedDB when its localStorage commit exceeds quota', async (t) => {
  const { page, panel, workspace } = await launchFixture(t)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith('knote-agent-chat') && String(value).includes('STATE_FALLBACK_DONE')) {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      }
      return original.call(this, key, value)
    }
  })
  await sendPrompt(panel, 'STATE_FALLBACK')
  await panel.getByText('STATE_FALLBACK_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(await page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.startsWith('knote-agent-chat'))
    .some((key) => String(localStorage.getItem(key)).includes('STATE_FALLBACK_DONE'))), false)
  await page.waitForTimeout(500)

  await page.reload({ waitUntil: 'commit', timeout: 90_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
  assert.equal(await page.evaluate((folder) => window.knoteDesktop.reopen('folder', folder), workspace), true)
  await panel.waitFor({ state: 'visible', timeout: 15_000 })
  await panel.getByText('STATE_FALLBACK_DONE', { exact: true }).waitFor({ timeout: 20_000 })
  assert.equal(await panel.getByText('STATE_FALLBACK_DONE', { exact: true }).count(), 1)
})

test('renderer quit acknowledgement waits for Agent terminal state and cancellation resumes scheduling', async (t) => {
  const { page, panel, workspace, electronApp } = await launchFixture(t)
  const chatStorageKey = `knote-agent-chat:${canonicalAgentWorkspaceId(`folder:${workspace}`)}`
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    globalThis.__knoteFailQuitAgentLocalState = true
    Storage.prototype.setItem = function (key, value) {
      if (globalThis.__knoteFailQuitAgentLocalState && String(key).startsWith('knote-agent-chat') && String(value).includes('QUIT_DURABILITY_DONE')) {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      }
      return original.call(this, key, value)
    }
  })

  await sendPrompt(panel, 'QUIT_DURABILITY')
  await panel.getByText('QUIT_DURABILITY_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  const token = `quit-agent-e2e-${Date.now()}`
  const acknowledgement = await requestRendererQuitBarrier(electronApp, token)
  assert.equal(acknowledgement.ok, true)

  const durable = await page.evaluate(async (key) => {
    const openDatabase = (name) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const requestResult = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const stateDb = await openDatabase('knote-agent-state')
    const stateRecord = await requestResult(stateDb.transaction('chatState').objectStore('chatState').get(key))
    stateDb.close()
    const eventDb = await openDatabase('knote-agent-runtime')
    const events = await requestResult(eventDb.transaction('events').objectStore('events').getAll())
    eventDb.close()
    const messages = (stateRecord?.state?.sessions || []).flatMap((session) => session.messages || [])
    const message = messages.find((item) => item.text === 'QUIT_DURABILITY_DONE')
    const terminal = events.find((event) => (
      event.chatKey === key &&
      event.type === 'run.completed' &&
      event.payload?.messageId === message?.id
    ))
    return {
      localContainsTerminal: Object.keys(localStorage)
        .filter((storageKey) => storageKey.startsWith('knote-agent-chat'))
        .some((storageKey) => String(localStorage.getItem(storageKey)).includes('QUIT_DURABILITY_DONE')),
      message: message ? { id: message.id, receipt: message.receipt } : null,
      terminal: terminal ? { receipt: terminal.payload?.receipt, text: terminal.payload?.text } : null
    }
  }, chatStorageKey)
  assert.equal(durable.localContainsTerminal, false)
  assert.ok(durable.message?.receipt, 'the durable terminal message lost its execution receipt')
  assert.equal(durable.message.receipt.grounding?.status, 'success')
  assert.equal(durable.terminal?.text, 'QUIT_DURABILITY_DONE')
  assert.deepEqual(durable.terminal?.receipt, durable.message.receipt)

  await page.evaluate(() => { globalThis.__knoteFailQuitAgentLocalState = false })
  assert.equal(await cancelRendererQuitBarrier(electronApp), true)
  await sendPrompt(panel, 'QUIT_RESUME')
  await panel.getByText('QUIT_RESUME_DONE', { exact: true }).waitFor({ timeout: 15_000 })
})

test('a length-truncated compactor falls back losslessly while retaining UI history and recent context', async (t) => {
  const { page, panel, workspace, model } = await launchFixture(t)
  const chatStorageKey = `knote-agent-chat:${canonicalAgentWorkspaceId(`folder:${workspace}`)}`
  const messages = Array.from({ length: 38 }, (_, index) => ({
    id: `old-message-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: index === 0
      ? 'old request 1 keeps EARLY_MEMORY_FACT raw details alpha COMPACTOR_LENGTH_CASE'
      : `${index % 2 === 0 ? 'old request' : 'old answer'} ${index + 1}`
  }))
  const seededChat = {
    schemaVersion: 2,
    activeId: 'compact-session',
    sessions: [{
      id: 'compact-session',
      title: 'Long context',
      messages,
      plan: [],
      activity: [],
      queue: [],
      events: [],
      summary: null
    }]
  }
  // Seed after the outgoing page's unload persistence, and make the record
  // newer than its IndexedDB mirror so hydration exercises this history.
  await page.addInitScript(({ key, state }) => {
    localStorage.setItem(key, JSON.stringify({
      ...state,
      updatedAt: Date.now() * 1000 + 1_000_000
    }))
  }, { key: chatStorageKey, state: seededChat })

  await page.reload({ waitUntil: 'commit', timeout: 90_000 })
  await page.locator('#app > *').first().waitFor({ state: 'attached', timeout: 90_000 })
  assert.equal(await page.evaluate((folder) => window.knoteDesktop.reopen('folder', folder), workspace), true)
  await panel.waitFor({ state: 'visible', timeout: 15_000 })
  const earlyMessage = panel.locator('.knote-agent-message-user')
    .filter({ hasText: 'old request 1 keeps EARLY_MEMORY_FACT raw details alpha' })
    .first()
  try {
    await earlyMessage.waitFor()
  } catch (error) {
    const persistedChats = await page.evaluate(() => Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => key.startsWith('knote-agent-chat'))
        .map((key) => [key, localStorage.getItem(key)])
    ))
    throw new Error(`${error.message}\nseededKey=${chatStorageKey}\npersistedChats=${JSON.stringify(persistedChats)}`)
  }

  await sendPrompt(panel, 'COMPACT_CONTEXT')
  await panel.getByText('COMPACT_CONTEXT_DONE', { exact: true }).waitFor({ timeout: 20_000 })
  assert.equal(model.memoryRequestCount, 1)
  assert.match(JSON.stringify(model.latestMemoryRequest), /EARLY_MEMORY_FACT/)
  const mainPayload = JSON.stringify(model.latestCompactContextRequest)
  assert.match(mainPayload, /Knote 会话记忆数据/)
  assert.match(mainPayload, /EARLY_MEMORY_FACT/)
  assert.match(mainPayload, /old request 37/)
  await earlyMessage.waitFor()

  const persisted = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), chatStorageKey)
  const session = persisted.sessions.find((item) => item.id === 'compact-session')
  assert.match(session.summary.text, /EARLY_MEMORY_FACT/)
  assert.match(session.summary.text, /old request 3/)
  assert.doesNotMatch(session.summary.text, /TRUNCATED_MODEL_MEMORY/)
  assert.ok(session.summary.text.length <= 12_000)
  assert.equal(session.summary.throughMessageId, 'old-message-24')
  assert.ok(session.events.some((event) => event.type === 'context.compacted'))
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
    const originalArrayBuffer = File.prototype.arrayBuffer
    globalThis.__knoteAttachmentReadStarted = 0
    globalThis.__knoteAttachmentReadFinished = 0
    globalThis.__knoteReleaseAttachmentRead = null
    File.prototype.arrayBuffer = function delayedAttachmentBytes() {
      const file = this
      globalThis.__knoteAttachmentReadStarted++
      return new Promise((resolve, reject) => {
        globalThis.__knoteReleaseAttachmentRead = async () => {
          try { resolve(await originalArrayBuffer.call(file)) } catch (error) { reject(error) }
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

test('a long text attachment exposes an exact run-bound continuation to its final UTF-8 byte', async (t) => {
  const { panel, model } = await launchFixture(t)
  const tail = 'ATTACHMENT_TAIL_SENTINEL_终😀'
  const source = `ATTACHMENT_SOURCE_HEAD\n${'甲😀'.repeat(4300)}\n${tail}`
  await panel.getByTestId('agent-file-input').setInputFiles({
    name: 'long-source.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(source, 'utf8')
  })
  await panel.locator('[data-testid="agent-draft-attachment"][data-name="long-source.md"]').waitFor({ state: 'visible', timeout: 10_000 })

  await sendPrompt(panel, 'ATTACH_CONTINUATION')
  await panel.getByText('ATTACH_CONTINUATION_DONE', { exact: true }).waitFor({ timeout: 20_000 })

  assert.match(model.attachmentContinuationInitialText, /ATTACHMENT_SOURCE_HEAD/)
  assert.match(model.attachmentContinuationInitialText, /"truncated":true/)
  assert.match(model.attachmentContinuationInitialText, /"source_complete":true/)
  assert.doesNotMatch(model.attachmentContinuationInitialText, new RegExp(tail))
  const result = model.attachmentContinuationToolResult
  assert.equal(result?.code, 'ATTACHMENT_READ')
  assert.match(result?.message || '', new RegExp(tail))
  assert.ok(result?.data?.returned_byte_offset > 0)
  assert.equal(result?.data?.continuation?.has_more, false)
  assert.equal(result?.grounding?.requested_range_complete, true)
  assert.equal(result?.grounding?.source_complete, true)
  assert.equal(result?.grounding?.projection_complete, true)
})

test('batch progress and late workers remain bound to the owning Agent session', async (t) => {
  const { page, panel, workspace, model } = await launchFixture(t)
  await sendPrompt(panel, 'BATCH_SCOPE')
  const batchPermission = panel.getByTestId('agent-permission')
  await batchPermission.waitFor({ state: 'visible' })
  assert.equal(model.batchWorkerRequests, 0, 'batch workers started before approval')
  assert.match(await batchPermission.innerText(), /3\s*个文件|3\s*files/)
  await batchPermission.getByTestId('agent-permission-allow').click()
  await waitUntil(
    () => model.batchWorkerRequests === 3,
    { timeout: 15_000, message: 'the three batch workers did not reach the model gate' }
  )

  const ownerBatch = panel.getByTestId('agent-batch-state')
  await ownerBatch.waitFor({ state: 'attached' })
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
  await ownerBatch.waitFor({ state: 'attached' })
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
  const interruptedReceipt = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    return [...agent.chatMessages.value].reverse().find((message) => message?.role === 'assistant' && message.receipt)?.receipt || null
  })
  assert.ok(interruptedReceipt, 'the committed batch child lost its run receipt after cancellation')
  assert.equal(interruptedReceipt.attempts, 1)
  assert.equal(interruptedReceipt.successful, 1)
  assert.equal(interruptedReceipt.failed, 1)
  assert.equal(interruptedReceipt.direct, 1)

  await sendPrompt(panel, 'AFTER_BATCH')
  await ownerBatch.waitFor({ state: 'detached' })
  await panel.getByText('E2E_STUB_UNHANDLED', { exact: true }).last().waitFor()
})

test('PDF delivery preserves short text, labels incomplete scan answers, and blocks unreadable local requests', async (t) => {
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
  const noToolsErrors = reloadedPanel.locator('.knote-agent-message-row.is-assistant .knote-agent-message-error')
  const errorsBeforeNoToolsRun = await noToolsErrors.count()
  await sendPrompt(reloadedPanel, 'PDF_NO_TOOLS')
  await waitUntil(async () => (await noToolsErrors.count()) > errorsBeforeNoToolsRun, {
    timeout: 20_000,
    message: 'the no-tool PDF run did not produce a local grounding failure'
  })
  const noToolsPanelText = await noToolsErrors.last().innerText()
  assert.match(noToolsPanelText, /PDF《no-tools-scan\.pdf》无法在当前模型上下文中完整提供（coverage=none）/)
  assert.match(noToolsPanelText, /当前模型没有工具能力，系统不会把部分文本或扫描页占位符伪装成全文/)
  assert.doesNotMatch(noToolsPanelText, /E2E_PDF_NO_TOOLS_DONE/)
  const unexpectedRequest = model.latestPdfRequest('PDF_NO_TOOLS')
  assert.equal(model.pdfRequestCount('PDF_NO_TOOLS'), 0,
    `an unreadable scan reached the provider despite the local guard: ${JSON.stringify(unexpectedRequest).slice(0, 4000)}`)
})

test('a budgeted PDF continues through its source cursor and then completes its artifact projection', async (t) => {
  const { panel, model } = await launchFixture(t)
  const tail = 'PDF_TAIL_SENTINEL_FINAL'
  const pages = Array.from({ length: 10 }, (_page, pageIndex) => Array.from({ length: 65 }, (_line, lineIndex) => {
    const width = lineIndex < 5 ? 82 : 72
    const prefix = pageIndex === 0 && lineIndex === 0
      ? 'PDF_SOURCE_HEAD_'
      : pageIndex === 9 && lineIndex === 64
        ? tail
        : `P${pageIndex + 1}L${lineIndex + 1}_`
    return prefix.padEnd(width, '\\').slice(0, width)
  }))
  const files = [
    { name: 'long-source.pdf', mimeType: 'application/pdf', buffer: assembleTextPagesPdf(pages) },
    ...Array.from({ length: 11 }, (_item, index) => ({
      name: `budget-filler-${index + 1}.pdf`,
      mimeType: 'application/pdf',
      buffer: assemblePdf(`filler ${index + 1}`)
    }))
  ]
  await panel.getByTestId('agent-file-input').setInputFiles(files)
  await panel.locator('[data-testid="agent-draft-attachment"][data-name="long-source.pdf"]').waitFor({ state: 'visible', timeout: 10_000 })

  await sendPrompt(panel, 'PDF_CONTINUATION')
  await waitUntil(() => model.pdfContinuationInitialText.length > 0, {
    timeout: 20_000,
    message: 'the PDF initial projection never reached the provider'
  })
  assert.match(model.pdfContinuationInitialText, /"truncated":true/, model.pdfContinuationInitialText.slice(-2000))
  assert.match(model.pdfContinuationInitialText, /"source_complete":null/, model.pdfContinuationInitialText.slice(-2000))
  assert.doesNotMatch(model.pdfContinuationInitialText, new RegExp(tail))
  await waitUntil(() => model.pdfContinuationSourceResult !== null, {
    timeout: 20_000,
    message: 'the PDF source continuation did not return a tool result'
  })
  const sourceResult = model.pdfContinuationSourceResult
  assert.equal(sourceResult?.code, 'PDF_TEXT_READ')
  assert.equal(sourceResult?.data?.continuation?.has_more, false)
  assert.equal(sourceResult?.grounding?.requested_range_complete, true)
  assert.equal(sourceResult?.grounding?.source_complete, true)
  assert.equal(sourceResult?.grounding?.projection_complete, false)
  assert.ok(sourceResult?.tool_output?.artifact_id)
  await waitUntil(() => model.pdfContinuationArtifactResult !== null, {
    timeout: 20_000,
    message: `the PDF artifact continuation did not return a tool result: ${JSON.stringify(sourceResult).slice(-2000)}`
  })
  const artifactResult = model.pdfContinuationArtifactResult
  assert.equal(artifactResult?.code, 'TOOL_OUTPUT_READ')
  assert.match(artifactResult?.message || '', new RegExp(tail))
  assert.equal(artifactResult?.grounding?.requested_range_complete, true)
  assert.equal(artifactResult?.grounding?.source_complete, true)
  assert.equal(artifactResult?.grounding?.projection_complete, true)
  assert.equal(artifactResult?.grounding?.source_id, sourceResult?.grounding?.source_id)
  try {
    await panel.getByText('PDF_CONTINUATION_DONE', { exact: true }).waitFor({ timeout: 10_000 })
  } catch (error) {
    throw new Error(`${error.message}\nrequestCount=${model.requestCount('PDF_CONTINUATION')}\npanel=${JSON.stringify((await panel.innerText()).slice(-4000))}`)
  }
})

test('a delayed read-to-write tool run cannot mutate the workspace opened after it started', async (t) => {
  const { page, panel, workspace, workspaceB, electronApp, model } = await launchFixture(t)
  const fileA = path.join(workspace, 'workspace-race.md')
  const fileB = path.join(workspaceB, 'workspace-race.md')
  await installWorkspaceRaceReadGate(electronApp, workspace, workspaceB)

  await sendPrompt(panel, 'WORKSPACE_RACE')

  const permission = panel.getByTestId('agent-permission')
  await permission.waitFor({ state: 'visible', timeout: 15_000 })
  assert.equal(fs.readFileSync(fileA, 'utf8'), '# Workspace A\n')
  assert.equal(fs.readFileSync(fileB, 'utf8'), '# Workspace B\n')
  await permission.getByTestId('agent-permission-allow').click()

  // Count 1 is the model-requested read_file. Count 2 is edit_file's own
  // freshness re-read, which happens only after the user-approved call has
  // passed the workspace guard. Switching at this exact point exercises the historical race:
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

test('pathless read-only and fallback same-name files isolate and restore Agent workspaces', async (t) => {
  const { page } = await launchFixture(t)
  const activeIdentity = () => page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const agent = await window.__knoteDebug.agent()
    const active = window.__knoteDebug.tabs.list().find((tab) => tab.active)
    return {
      tabId: active?.id || 0,
      workspaceId: agent.agentBridge.getWorkspaceIdentity(),
      chatKey: agent.activeChatKey.value,
      fileWorkspaceId: active?.fileWorkspaceId || '',
      durable: !!active?.fileWorkspaceIdentityDurable
    }
  })
  const openReadOnlyFile = (parentName, text) => page.evaluate(async ({ parent, content }) => {
    const root = await navigator.storage.getDirectory()
    const testRoot = await root.getDirectoryHandle('knote-e2e-file-identities', { create: true })
    const parentHandle = await testRoot.getDirectoryHandle(parent, { create: true })
    const handle = await parentHandle.getFileHandle('same.md', { create: true })
    const writable = await handle.createWritable()
    await writable.write(content)
    await writable.close()
    return await window.__knoteDebug.tabs.openFileHandleReadOnly(handle)
  }, { parent: parentName, content: text })

  assert.equal(await openReadOnlyFile('parent-a', '# read only A\n'), true)
  const readOnlyA = await activeIdentity()
  assert.equal(await openReadOnlyFile('parent-b', '# read only B\n'), true)
  const readOnlyB = await activeIdentity()
  assert.match(readOnlyA.workspaceId, /^file:fsa\/v1\//)
  assert.match(readOnlyB.workspaceId, /^file:fsa\/v1\//)
  assert.equal(readOnlyA.durable, true)
  assert.equal(readOnlyB.durable, true)
  assert.notEqual(readOnlyA.workspaceId, readOnlyB.workspaceId)
  assert.notEqual(readOnlyA.chatKey, readOnlyB.chatKey)

  assert.equal(await page.evaluate((id) => window.__knoteDebug.tabs.switch(id), readOnlyA.tabId), true)
  const restoredReadOnly = await activeIdentity()
  assert.equal(restoredReadOnly.workspaceId, readOnlyA.workspaceId)
  assert.equal(restoredReadOnly.chatKey, readOnlyA.chatKey)

  assert.equal(await page.evaluate(() => window.__knoteDebug.tabs.openFallbackFile('same.md', '# fallback A\n')), true)
  const fallbackA = await activeIdentity()
  assert.equal(await page.evaluate(() => window.__knoteDebug.tabs.openFallbackFile('same.md', '# fallback B\n')), true)
  const fallbackB = await activeIdentity()
  assert.match(fallbackA.workspaceId, /^file:session\//)
  assert.match(fallbackB.workspaceId, /^file:session\//)
  assert.equal(fallbackA.durable, false)
  assert.equal(fallbackB.durable, false)
  assert.notEqual(fallbackA.workspaceId, fallbackB.workspaceId)
  assert.notEqual(fallbackA.chatKey, fallbackB.chatKey)

  assert.equal(await page.evaluate((id) => window.__knoteDebug.tabs.switch(id), fallbackA.tabId), true)
  const restoredFallback = await activeIdentity()
  assert.equal(restoredFallback.workspaceId, fallbackA.workspaceId)
  assert.equal(restoredFallback.chatKey, fallbackA.chatKey)
})

test('app confirmations are FIFO and renderer quit cancels the entire dialog queue', async (t) => {
  const { electronApp, page } = await launchFixture(t)
  const dialog = page.getByTestId('app-dialog')
  await page.evaluate(() => window.__knoteDebug.dialogs.queueConfirmPair())
  await dialog.getByText('E2E confirm first', { exact: true }).waitFor()
  assert.equal(await dialog.getAttribute('data-dialog-owner'), 'e2e-confirm-first')
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid || ''), 'app-dialog-accept')
  await dialog.getByTestId('app-dialog-accept').click()
  await dialog.getByText('E2E confirm second', { exact: true }).waitFor()
  assert.equal(await dialog.getAttribute('data-dialog-owner'), 'e2e-confirm-second')
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid || ''), 'app-dialog-accept')
  await dialog.getByTestId('app-dialog-cancel').click()
  await dialog.waitFor({ state: 'hidden' })
  await waitUntil(
    () => page.evaluate(() => Array.isArray(window.__knoteDebug.dialogs.lastResult)),
    { message: 'both FIFO confirmations did not settle' }
  )
  assert.deepEqual(await page.evaluate(() => window.__knoteDebug.dialogs.lastResult), [true, false])

  await page.evaluate(() => window.__knoteDebug.dialogs.queueConfirmPair())
  await dialog.getByText('E2E confirm first', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.__knoteDebug.dialogs.pending()), 2)
  const token = `quit-dialog-queue-${Date.now()}`
  const result = await requestRendererQuitBarrier(electronApp, token)
  assert.equal(result.ok, true)
  await dialog.waitFor({ state: 'hidden' })
  await waitUntil(
    () => page.evaluate(() => Array.isArray(window.__knoteDebug.dialogs.lastResult)),
    { message: 'quit did not release every dialog promise' }
  )
  assert.deepEqual(await page.evaluate(() => window.__knoteDebug.dialogs.lastResult), [false, false])
  assert.equal(await page.evaluate(() => window.__knoteDebug.dialogs.pending()), 0)
  assert.equal(await cancelRendererQuitBarrier(electronApp), true)
})

test('an invalid model-written image suffix is rejected atomically and corrected in the same Agent run', async (t) => {
  const { page, panel } = await launchFixture(t)
  await workspaceTreeRow(page, 'keep.md').click()
  await waitUntil(() => page.evaluate(() => window.__knoteDebug.getContent() === '# Keep\n'))
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

test('an uploaded SVG exposes its exact image capability and inserts the original vector data', async (t) => {
  const { page, panel, model, workspace } = await launchFixture(t)
  fs.writeFileSync(path.join(workspace, 'keep.md'), '# Top\n\n![Existing](https://example.com/existing.png)\n\nBottom\n')
  await workspaceTreeRow(page, 'keep.md').click()
  await waitUntil(() => page.evaluate(() => window.__knoteDebug.getContent().includes('![Existing]')))
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" viewBox="0 0 80 40"><rect width="80" height="40" fill="#84cc16"/><text x="8" y="25">Knote SVG</text></svg>'
  await panel.getByTestId('agent-file-input').setInputFiles({
    name: 'agent-vector.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(source, 'utf8')
  })
  await panel.locator('[data-testid="agent-draft-attachment"][data-name="agent-vector.svg"]').waitFor({ state: 'visible', timeout: 10_000 })

  await sendPrompt(panel, 'SVG_INSERT')
  await panel.getByText('SVG_INSERT_DONE', { exact: true }).waitFor({ timeout: 20_000 })
  await waitUntil(() => page.evaluate(async () => (await window.__knoteDebug.agent()).pendingHunks.value.length === 1), {
    timeout: 10_000,
    message: 'the SVG insert did not stage a document hunk'
  })

  const content = model.svgInsertInitialRequest?.messages?.findLast((message) => message?.role === 'user')?.content
  assert.ok(Array.isArray(content), 'the SVG request did not include multimodal content parts')
  const capability = content.find((part) => part?.type === 'text' && /image_id=att-/.test(part.text || ''))?.text || ''
  const imageId = /image_id=(att-[A-Za-z0-9_-]+)/.exec(capability)?.[1] || ''
  assert.ok(imageId)
  assert.match(capability, new RegExp(`markdown_reference=!\\[agent-vector\\.svg\\]\\(${imageId}\\)`))
  assert.match(capability, new RegExp(`insert_image\\(image_id="${imageId}"`))
  const visionUrl = content.find((part) => part?.type === 'image_url')?.image_url?.url || ''
  assert.match(visionUrl, /^data:image\/png;base64,/)
  assert.equal(model.svgInsertToolResult?.code, 'HUNK_STAGED')

  const staged = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    const hunk = agent.pendingHunks.value[0]
    return { previewImage: hunk?.previewImage || '', applied: (hunk?.applyLines || []).join('\n') }
  })
  assert.match(staged.previewImage, /^data:image\/svg\+xml;base64,/)
  assert.match(staged.applied, /^\n?!\[agent-vector\.svg\]\(data:image\/svg\+xml;base64,/)
  const previewImage = page.locator('.knote-agent-new-img').first()
  await previewImage.waitFor({ state: 'visible' })
  assert.match(await previewImage.getAttribute('src'), /^data:image\/svg\+xml;base64,/)
  const reviewPlacement = await page.locator('.ProseMirror').first().evaluate((editor) => {
    const existing = editor.querySelector('img[alt="Existing"]')
    const widget = editor.querySelector('.knote-agent-new')
    const bottom = [...editor.children].find((element) => element.textContent.trim() === 'Bottom')
    const existingRect = existing?.getBoundingClientRect()
    const widgetRect = widget?.getBoundingClientRect()
    const bottomRect = bottom?.getBoundingClientRect()
    return {
      existingBottom: existingRect?.bottom || 0,
      widgetTop: widgetRect?.top || 0,
      widgetBottom: widgetRect?.bottom || 0,
      bottomTop: bottomRect?.top || 0
    }
  })
  assert.ok(reviewPlacement.widgetTop >= reviewPlacement.existingBottom - 2, JSON.stringify(reviewPlacement))
  assert.ok(reviewPlacement.widgetBottom <= reviewPlacement.bottomTop + 2, JSON.stringify(reviewPlacement))

  await page.getByTestId('agent-accept-all').click()
  await waitUntil(() => page.evaluate(async () => (await window.__knoteDebug.agent()).pendingHunks.value.length === 0))
  const editorImage = page.locator('.ProseMirror img[src^="data:image/svg+xml;base64,"]').first()
  await editorImage.waitFor({ state: 'visible', timeout: 10_000 })
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
    await sendPromptAndWaitForReply(page, panel, prompt)
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
    Number.parseFloat(messageSurface.borderRightWidth) < 2.5,
    'the user bubble must not carry a heavy right-edge identity line'
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
  await author.waitFor({ state: 'attached' })
  assert.equal((await author.innerText()).trim(), 'Knote Agent')
  assert.equal(await author.locator(':scope > canvas, :scope > img, :scope > svg').count(), 0)

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
  const collapsedDebug = await railList.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const buttons = [...element.querySelectorAll('[data-testid="agent-question-quick"]')]
    const first = buttons[0]?.getBoundingClientRect()
    const last = buttons.at(-1)?.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      buttons: buttons.length,
      rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
      first: first && { top: first.top, bottom: first.bottom, height: first.height },
      last: last && { top: last.top, bottom: last.bottom, height: last.height },
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      boxSizing: style.boxSizing,
      maxHeight: style.maxHeight,
      overflowY: style.overflowY
    }
  })
  t.diagnostic(`collapsed rail before limit check: ${JSON.stringify({ visible: await visibleQuestionCount(), collapsedDebug })}`)
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
    const elapsed = performance.now() - started
    const settlingStarted = performance.now()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const settlingElapsed = performance.now() - settlingStarted
    observer?.disconnect()
    return {
      elapsed,
      settlingElapsed,
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

  // Aurora remains the previous panel background; title-only liquid effects
  // must not install another full-panel layer.
  const settingsToggle = panel.getByTestId('agent-settings-toggle')
  await settingsToggle.click()
  await panel.getByTestId('agent-theme-aurora').click()
  await waitUntil(async () => (await panel.getAttribute('data-agent-theme')) === 'aurora')
  await settingsToggle.click()

  const auroraBefore = await panel.evaluate((element) => {
    return {
      liquidFieldCount: element.querySelectorAll('.knote-agent-liquid-field').length,
      layers: ['::before', '::after'].map((pseudo) => {
        const style = getComputedStyle(element, pseudo)
        return { name: style.animationName, state: style.animationPlayState, transform: style.transform }
      })
    }
  })
  assert.equal(auroraBefore.liquidFieldCount, 0)
  assert.ok(/^agentAurora(?:-|$)/.test(auroraBefore.layers[0].name), JSON.stringify(auroraBefore))
  assert.ok(/^agentAuroraSecondary(?:-|$)/.test(auroraBefore.layers[1].name), JSON.stringify(auroraBefore))
  assert.ok(auroraBefore.layers.every((layer) => layer.state === 'running'), JSON.stringify(auroraBefore))
  await page.waitForTimeout(1250)
  const auroraAfter = await panel.evaluate((element) => {
    return {
      transforms: ['::before', '::after'].map((pseudo) => getComputedStyle(element, pseudo).transform)
    }
  })
  assert.ok(auroraAfter.transforms.some((transform, index) => transform !== auroraBefore.layers[index].transform),
    'the restored Aurora background should retain its previous motion')

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
  await popover.waitFor({ state: 'attached' })
  assert.equal(await popover.getByTestId('agent-session-quick').count(), 0)
  await panel.getByTestId('agent-session-toggle').click()

  await panel.getByTestId('agent-settings-toggle').click()
  const settings = panel.getByTestId('agent-settings')
  await settings.waitFor({ state: 'attached' })
  assert.equal(await settings.getByTestId('agent-settings-quick').count(), 0)
  await questionTicks.first().waitFor({ state: 'hidden' })
  assert.equal(await panel.evaluate((element) => element.scrollLeft), 0)

  if (captureDir) {
    await panel.screenshot({ path: path.join(captureDir, 'agent-settings.png') })
  }

  await panel.getByTestId('agent-settings-toggle').click()
  await panel.getByTestId('agent-new-session').click()
  assert.equal(await panel.getByTestId('agent-question-quick').count(), 0)
  await sendPromptAndWaitForReply(page, panel, 'NEW_CHAT_ONLY_1 当前会话的第一个问题')
  assert.equal(await panel.getByTestId('agent-question-quick').count(), 0)
  await sendPromptAndWaitForReply(page, panel, 'NEW_CHAT_ONLY_2 当前会话的第二个问题')
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
  await editor.waitFor({ state: 'attached' })

  // Reproduce the exact two-line formatted Markdown reported by the user.
  // It must remain two adjacent visual rows: never an empty paragraph/row
  // between them, while both strong spans still parse as formatting.
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  const exactMarkdown = 'RAL-Bench 主要研究：**基础 LLM 能否一次性生成满足功能与五类非功能属性的 Python 应用？**\r\n\r\nMAGIC-Bench 主要研究：**具有规划、文件编辑、Shell、构建和迭代调试能力的 Agent-System，能否完成跨语言项目重构；主干模型与 Agent Harness 分别如何影响七个质量维度？"**\r\n\r\n'
  const pasteResult = await editor.evaluate((element, markdown) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', markdown)
    clipboardData.setData(
      'text/html',
      markdown
        .replace(/\r\n\r\n$/, '')
        .split(/(?:\r\n)+/)
        .filter(Boolean)
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
    exactMarkdown.replace(/\r\n/g, '\n').trim().replace(/\n+/g, '\n').replace(/\*\*/g, ''),
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
  const valueBeforeUndo = await input.inputValue()
  await input.press('Control+z')
  assert.notEqual(await input.inputValue(), valueBeforeUndo, 'Agent textarea did not receive native undo')
  await input.press('Control+y')
  assert.equal(await input.inputValue(), valueBeforeUndo, 'Agent textarea did not receive native redo')
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
  await contextMenu.waitFor({ state: 'attached' })
  assert.ok(await contextMenu.getByRole('button').count() >= 1)
})

test('image center and right alignment survive autosave and full renderer reloads', async (t) => {
  const { page, workspace } = await launchFixture(t)
  const target = path.join(workspace, 'align.md')
  const openAlignedDocument = async () => {
    assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
    await page.getByTestId('current-file-name').filter({ hasText: 'align.md' }).waitFor({ state: 'attached', timeout: 10_000 })
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
    await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor({ state: 'attached', timeout: 10_000 })
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

test('slow standalone open re-reads after an Agent conditional commit instead of installing its old payload', async (t) => {
  const { page, workspace } = await launchFixture(t)
  const target = path.join(workspace, 'keep.md')
  assert.equal(await page.evaluate(() => window.__knoteDebug.tabs.holdNextStandaloneOpen()), true)
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
  await waitUntil(
    () => page.evaluate(() => window.__knoteDebug.tabs.standaloneOpenWaiting()),
    { timeout: 10_000, message: 'standalone open did not pause after receiving the old main payload' }
  )

  const edit = await page.evaluate(async () => {
    const agent = await window.__knoteDebug.agent()
    const binding = agent.agentBridge.captureWorkspace()
    const options = { workspaceId: binding.id, workspaceBinding: binding }
    const expectedContent = await agent.agentBridge.readFile('keep.md', options)
    return await agent.agentBridge.updateFile(
      'keep.md',
      '# Agent committed before standalone install\n',
      { ...options, expectedContent }
    )
  })
  assert.deepEqual(edit, { ok: true })
  assert.equal(await page.evaluate(() => window.__knoteDebug.tabs.releaseStandaloneOpen()), true)
  await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor({ state: 'attached', timeout: 10_000 })
  await waitUntil(
    () => page.evaluate(() => window.__knoteDebug.getContent() === '# Agent committed before standalone install\n'),
    { timeout: 10_000, message: 'standalone open installed the stale main-process payload' }
  )
  assert.equal(fs.readFileSync(target, 'utf8'), '# Agent committed before standalone install\n')
})

test('a slower earlier tree-file read cannot overwrite the later selection', async (t) => {
  const { page, workspace, electronApp } = await launchFixture(t)
  await installTreeFileReadRaceGate(electronApp, workspace)

  await page.getByText('keep.md', { exact: true }).first().click()
  await page.waitForTimeout(25)
  await page.getByText('delete-me.md', { exact: true }).first().click()

  const editor = page.locator('.ProseMirror').first()
  await editor.waitFor({ state: 'attached' })
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
  await editor.waitFor({ state: 'attached' })
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
  await page.getByTestId('current-file-name').waitFor({ state: 'attached' })
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
  await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor({ state: 'attached' })
  const oldSnapshot = await page.evaluate(async ({ identity, markdown }) => {
    return await window.knoteDesktop.historyAdd(identity, markdown, Date.now() - 60_000, 'e2e old A')
  }, { identity: `file:${fileA}`, markdown: '# OLD A HISTORY' })
  const oldSnapshotId = oldSnapshot?.id
  assert.ok(oldSnapshotId)

  await page.getByTestId('actions-menu').click()
  await page.getByTestId('open-history').click()
  const modal = page.getByTestId('history-modal')
  await modal.waitFor({ state: 'attached' })
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
  await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor({ state: 'attached' })
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
  await page.getByTestId('current-file-name').filter({ hasText: targetName }).waitFor({ state: 'attached', timeout: 15_000 })
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

    // The 400 KiB fixture is now past the single-chunk paging threshold, so
    // the edit happens inside the bounded rich chunk; the same foreground
    // intent guard must keep the held stale read from clobbering it.
    const chunkEditor = page.getByTestId('large-document-rich-chunk').locator('.ProseMirror')
    await chunkEditor.waitFor({ state: 'attached' })
    const editMarker = ' LIVE_EDIT_DURING_PROGRESSIVE_READ'
    await chunkEditor.focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText(editMarker)
    await waitUntil(async () => (await chunkEditor.innerText()).includes(editMarker), {
      timeout: 10_000,
      message: 'the chunked editor never showed the typed edit'
    })
    await waitUntil(async () => {
      return await page.evaluate((marker) => window.__knoteDebug.getContent().includes(marker), editMarker)
    }, {
      timeout: 15_000,
      message: 'the chunked edit never reached the full document content'
    })
    // The edit may or may not have autosaved while the stale read is held (the
    // chunked editor commits to the full document on idle, and autosave is not
    // suppressed in paged mode). The invariant is that the disk is never left
    // as a partial/clobbered mix: exactly the baseline, or the baseline with
    // the edit already on top.
    const midRaceDisk = fs.readFileSync(target, 'utf8')
    assert.ok(
      midRaceDisk === staleDisk || (midRaceDisk.includes(editMarker) && midRaceDisk.length >= staleDisk.length),
      'mid-race disk must hold the baseline or the autosaved edit'
    )

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
    assert.equal(await chunkEditor.innerText().then((text) => text.includes(editMarker)), true)
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
  await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor({ state: 'attached' })
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
  await page.getByTestId('current-file-name').filter({ hasText: 'delete-me.md' }).waitFor({ state: 'attached' })
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
  await contextMenu.waitFor({ state: 'attached' })
  await contextMenu.getByRole('button').nth(1).click()
  await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor({ state: 'attached' })
  assert.equal(await page.locator('.knote-tab').count(), initialTabs + 1)

  await page.getByText('delete-me.md', { exact: true }).first().click({ button: 'right' })
  contextMenu = page.locator('.knote-ctxmenu')
  await contextMenu.waitFor({ state: 'attached' })
  await contextMenu.getByRole('button').nth(1).click()
  await page.getByTestId('current-file-name').filter({ hasText: 'delete-me.md' }).waitFor({ state: 'attached' })
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
  await page.getByTestId('current-file-name').filter({ hasText: 'delete-me.md' }).waitFor({ state: 'attached' })
  assert.equal(await deleteRow.getAttribute('data-tree-active'), 'true')
  assert.equal(await deleteRow.evaluate((element) => getComputedStyle(element).cursor), 'pointer')
  await deleteRow.click({ button: 'right' })
  await menu.waitFor({ state: 'attached' })
  assert.equal(await menu.getAttribute('data-context-target'), '/delete-me.md')
  assert.ok(await menu.getByRole('button').count() >= 4)
  assert.equal(await page.getByTestId('current-file-name').innerText(), 'delete-me.md')
  await closeMenu()

  // Make keep.md an opened background tab, return to delete-me.md, then use
  // the physical file-tree row rather than the tab pill.
  await keepRow.click({ button: 'right' })
  await menu.waitFor({ state: 'attached' })
  assert.equal(await menu.getAttribute('data-context-target'), '/keep.md')
  await menu.getByRole('button').nth(1).click()
  await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor({ state: 'attached' })
  await deleteRow.click()
  await page.getByTestId('current-file-name').filter({ hasText: 'delete-me.md' }).waitFor({ state: 'attached' })
  assert.equal(await keepRow.getAttribute('data-tree-active'), 'false')
  assert.equal(await keepRow.evaluate((element) => getComputedStyle(element).cursor), 'pointer')
  await keepRow.click({ button: 'right' })
  await menu.waitFor({ state: 'attached' })
  assert.equal(await page.getByTestId('current-file-name').innerText(), 'delete-me.md')
  await closeMenu()

  // Directory rows use the same guarded pointer path but a different menu.
  assert.equal(await directoryRow.getAttribute('data-tree-kind'), 'dir')
  assert.equal(await directoryRow.evaluate((element) => getComputedStyle(element).cursor), 'pointer')
  await directoryRow.click({ button: 'right' })
  await menu.waitFor({ state: 'attached' })
  assert.equal(await menu.getAttribute('data-context-target'), '/notes')
  assert.ok(await menu.getByRole('button').count() >= 5)
  assert.equal(await page.getByTestId('current-file-name').innerText(), 'delete-me.md')
})

test('invalidated post-install navigation cannot disable later auto-save', async (t) => {
  const { page, workspace } = await launchFixture(t)
  const keepPath = path.join(workspace, 'keep.md')
  await page.evaluate(() => window.__knoteDebug.folder.armNavigationInstallRace())
  await workspaceTreeRow(page, 'keep.md').click()
  await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor({ state: 'attached' })

  await page.locator('.knote-view-toggle button').nth(1).click()
  const editor = page.getByTestId('markdown-source-editor')
  await editor.waitFor({ state: 'attached' })
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

  const assertBoundedLargeDom = async (label, split = false) => {
    const stats = await page.evaluate(() => {
      const sum = (selector, read) => Array.from(document.querySelectorAll(selector))
        .reduce((total, element) => total + read(element).length, 0)
      return {
        proseMirrorCount: document.querySelectorAll('.ProseMirror').length,
        fullSourceCount: document.querySelectorAll('[data-testid="markdown-source-editor"]').length,
        fullPreviewCount: document.querySelectorAll('[data-testid="markdown-full-preview"]').length,
        chunkPreviewCount: document.querySelectorAll('[data-testid="large-document-chunk-preview"]').length,
        largeRichCount: document.querySelectorAll('[data-testid="large-document-rich-chunk"]').length,
        mountedEditorChars:
          sum('[data-testid="markdown-source-editor"]', (element) => element.value || '') +
          sum('[data-testid="markdown-full-preview"]', (element) => element.textContent || '') +
          sum('[data-testid="large-document-chunk-preview"]', (element) => element.textContent || '') +
          sum('.ProseMirror', (element) => element.textContent || '')
      }
    })
    assert.equal(stats.proseMirrorCount, 1, `${label}: exactly one TipTap chunk must be mounted`)
    assert.equal(stats.fullSourceCount, 0, `${label}: full-document source textarea must stay unmounted`)
    assert.equal(stats.fullPreviewCount, 0, `${label}: full-document preview must stay unmounted`)
    assert.equal(stats.chunkPreviewCount, split ? 1 : 0, `${label}: bounded chunk preview state is incorrect`)
    assert.equal(stats.largeRichCount, 1, `${label}: exactly one chunked rich editor is expected`)
    assert.ok(stats.mountedEditorChars <= (split ? 140_000 : 70_000),
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
  await page.getByTestId('current-file-name').filter({ hasText: 'large-a.md' }).waitFor({ state: 'attached', timeout: 15_000 })
  await page.getByTestId('large-document-rich-chunk').waitFor({ state: 'visible', timeout: 15_000 })
  const firstOpenMs = performance.now() - openStarted
  await markLongTaskPhase('first-open')
  await assertBoundedLargeDom('first single-pane open')

  const secondStarted = performance.now()
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), fileB), true)
  await page.getByTestId('current-file-name').filter({ hasText: 'large-b.md' }).waitFor({ state: 'attached', timeout: 15_000 })
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
  await page.getByTestId('current-file-name').filter({ hasText: 'large-a.md' }).waitFor({ state: 'attached', timeout: 15_000 })
  const switchMs = performance.now() - switchStarted
  await markLongTaskPhase('cold-switch')
  const source = page.getByTestId('large-document-rich-chunk').locator('.ProseMirror')
  const pageSelect = page.getByTestId('large-source-page-select')
  await assertBoundedLargeDom('cold-switched single-pane document')
  const lastPage = await pageSelect.locator('option').count() - 1
  assert.ok(lastPage > 0, '8 MiB source should be split across multiple bounded pages')
  await pageSelect.selectOption(String(lastPage))

  // A real single -> split transition must retain the same rich chunk. Huge
  // documents render only that bounded chunk in both editor and preview panes.
  await page.locator('.knote-view-toggle button').nth(1).click()
  await page.locator('main[data-view-mode="split"][data-large-document-mode="chunked-rich"]')
    .waitFor({ state: 'attached' })
  assert.equal(await pageSelect.inputValue(), String(lastPage), 'view switch reset the active source page')
  const splitPageSelect = page.getByTestId('large-split-page-select')
  await splitPageSelect.waitFor({ state: 'visible' })
  assert.equal(await splitPageSelect.inputValue(), String(lastPage), 'split controls lost the active source page')
  await page.getByTestId('large-document-chunk-preview').waitFor({ state: 'visible' })
  const splitLayout = await page.locator('main[data-view-mode="split"]').evaluate((main) => {
    const panes = Array.from(main.children).filter((element) => {
      const rect = element.getBoundingClientRect()
      return element.tagName === 'SECTION' && rect.width > 0 && rect.height > 0
    }).map((element) => element.getBoundingClientRect())
    return {
      display: getComputedStyle(main).display,
      paneCount: panes.length,
      sameRow: panes.length === 2 && Math.abs(panes[0].top - panes[1].top) < 2,
      separateColumns: panes.length === 2 && Math.abs(panes[0].left - panes[1].left) > 2
    }
  })
  assert.deepEqual(splitLayout, { display: 'grid', paneCount: 2, sameRow: true, separateColumns: true })
  const splitDomStats = await assertBoundedLargeDom('split-mode protected source', true)

  await page.keyboard.press('Control+/')
  await page.locator('main[data-view-mode="single"][data-large-document-mode="chunked-rich"]').waitFor({ state: 'attached' })
  await page.keyboard.press('Control+/')
  await page.locator('main[data-view-mode="split"][data-large-document-mode="chunked-rich"]').waitFor({ state: 'attached' })
  await page.getByTestId('large-document-chunk-preview').waitFor({ state: 'visible' })
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
    .waitFor({ state: 'attached' })
  assert.equal((await source.innerText()).includes(editMarker), true, 'split-mode edit was lost on returning to single mode')
  await assertBoundedLargeDom('single mode after split edit')

  // Whole-document replace used to mutate `content` while leaving this page's
  // offsets and draft bound to the old string. A later chunk commit could then
  // splice at stale offsets and corrupt unrelated text.
  await page.keyboard.press('Control+h')
  const findBar = page.locator('.knote-findbar')
  await findBar.waitFor({ state: 'attached' })
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
  await page.getByTestId('current-file-name').filter({ hasText: 'large-a.md' }).waitFor({ state: 'attached', timeout: 30_000 })
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
  await page.getByTestId('current-file-name').filter({ hasText: 'structured-large.md' }).waitFor({ state: 'attached', timeout: 15_000 })
  await page.getByTestId('large-document-rich-chunk').waitFor({ state: 'visible', timeout: 15_000 })
  const openMs = performance.now() - openStarted
  const pageCount = await assertChunkedRichOnly('initial structured open')

  // Regression: wheel/scroll at the chunk edge must NOT flip pages on its
  // own — paging is user-controlled (chunk controls / outline) only.
  assert.ok(pageCount > 1, 'the structured fixture must span multiple chunks for the scroll test')
  const chunkScroller = page.getByTestId('large-document-rich-chunk').locator('.knote-doc-scroll')
  await chunkScroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true }))
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await page.waitForTimeout(700)
  assert.equal(await page.getByTestId('large-source-page-select').inputValue(), '0',
    'scrolling to the chunk edge must not auto-advance the page')

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
  await page.getByTestId('current-file-name').filter({ hasText: 'structured-large.md' }).waitFor({ state: 'attached', timeout: 30_000 })
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

test('a local file can be attached (email-attachment style) and its link opens with the OS default app', async (t) => {
  const { page, workspace, electronApp } = await launchFixture(t)
  const sourceAttachment = path.join(workspace, '..', 'e2e-source attachment.pdf')
  const attachmentBytes = Buffer.from('fake pdf bytes for the attachment e2e fixture')
  fs.writeFileSync(sourceAttachment, attachmentBytes)
  const shareDir = path.join(workspace, 'share')
  fs.mkdirSync(shareDir, { recursive: true })
  // main-process stubs: the native FILE picker returns the fixture path, and
  // shell.openPath records every OS-open request instead of launching apps.
  // The destination folder is chosen in the in-app popup (restricted to the
  // document tree), so there is no native directory picker anymore.
  await electronApp.evaluate(async ({ dialog, shell }, config) => {
    globalThis.__knoteE2eOpenedPaths = []
    globalThis.__knoteE2eDialogConfig = { ...config, cancelNext: false }
    shell.openPath = async (candidate) => {
      globalThis.__knoteE2eOpenedPaths.push(String(candidate))
      return ''
    }
    dialog.showOpenDialog = async (_win, opts) => {
      const cfg = globalThis.__knoteE2eDialogConfig
      if (cfg.cancelNext) { cfg.cancelNext = false; return { canceled: true, filePaths: [] } }
      return { canceled: false, filePaths: [cfg.source] }
    }
  }, { source: sourceAttachment })

  const attachDialog = page.getByTestId('attach-dialog')
  const folderSelect = page.getByTestId('attach-folder-select')
  const pickSource = page.getByTestId('attach-pick-source')
  const confirmAttach = page.getByTestId('attach-confirm')
  const openAttachDialog = async () => {
    await page.evaluate(() => { void window.__knoteDebug.link.insertAttachmentBelow() })
    await attachDialog.waitFor({ state: 'visible', timeout: 15_000 })
    await folderSelect.locator('option').first().waitFor({ state: 'attached' })
  }

  // Button B — attachment copy into the default assets/ folder (the popup
  // defaults to <doc>/assets, the remembered folder on first use)
  await openAttachDialog()
  const assetsAbs = path.join(workspace, 'assets')
  assert.equal(await folderSelect.inputValue(), assetsAbs, 'first insert must default to <doc>/assets')
  await pickSource.click()
  assert.match(await attachDialog.innerText(), /e2e-source attachment\.pdf/)
  assert.doesNotMatch(await attachDialog.innerText(), /import-[A-Za-z0-9_-]{20}/)
  await confirmAttach.click()
  await attachDialog.waitFor({ state: 'hidden' })
  const written = path.join(workspace, 'assets', 'e2e-source attachment.pdf')
  assert.equal(fs.existsSync(written), true, 'attachment was not copied into the workspace assets folder')
  assert.deepEqual(fs.readFileSync(written), attachmentBytes)
  assert.match(await page.evaluate(() => window.__knoteDebug.getContent()), /\[e2e-source attachment\.pdf\]\(assets\/e2e-source%20attachment\.pdf\)/)

  // Button B again with a user-chosen destination folder (still inside the
  // workspace so the resulting relative link stays shareable)
  await openAttachDialog()
  await folderSelect.selectOption(shareDir)
  await pickSource.click()
  await confirmAttach.click()
  await attachDialog.waitFor({ state: 'hidden' })
  const shareCopy = path.join(shareDir, 'e2e-source attachment.pdf')
  assert.equal(fs.existsSync(shareCopy), true, 'attachment was not copied into the user-chosen folder')
  assert.deepEqual(fs.readFileSync(shareCopy), attachmentBytes)
  assert.match(await page.evaluate(() => window.__knoteDebug.getContent()), /\[e2e-source attachment\.pdf\]\(share\/e2e-source%20attachment\.pdf\)/)

  // the chosen folder is persisted to disk: the next insert opens with it as
  // the default (cancel the popup without inserting anything)
  await openAttachDialog()
  assert.equal(await folderSelect.inputValue(), shareDir, 'the last chosen folder must be remembered')
  await page.getByTestId('attach-cancel').click()
  await attachDialog.waitFor({ state: 'hidden' })

  // new folder + rename folder inside the popup (both restricted to the
  // document tree and authorized by main)
  await openAttachDialog()
  await folderSelect.selectOption(workspace)
  await page.getByTestId('attach-new-folder').click()
  const promptDialog = page.getByTestId('app-dialog')
  await promptDialog.waitFor({ state: 'attached' })
  await promptDialog.locator('input').fill('attach-folder')
  await promptDialog.getByTestId('app-dialog-accept').click()
  await promptDialog.waitFor({ state: 'hidden' })
  const notesDir = path.join(workspace, 'attach-folder')
  assert.equal(fs.existsSync(notesDir), true, 'new folder was not created')
  await waitUntil(async () => (await folderSelect.inputValue()) === notesDir, {
    timeout: 5_000,
    message: 'the new folder must be selected after creation'
  })
  await page.getByTestId('attach-rename-folder').click()
  await promptDialog.waitFor({ state: 'attached' })
  await promptDialog.locator('input').fill('attach-folder2')
  await promptDialog.getByTestId('app-dialog-accept').click()
  await promptDialog.waitFor({ state: 'hidden' })
  assert.equal(fs.existsSync(notesDir), false, 'old folder must be gone after rename')
  assert.equal(fs.existsSync(path.join(workspace, 'attach-folder2')), true, 'renamed folder was not created')
  await waitUntil(async () => (await folderSelect.inputValue()) === path.join(workspace, 'attach-folder2'), {
    timeout: 5_000,
    message: 'the renamed folder must be selected'
  })
  await page.getByTestId('attach-cancel').click()
  await attachDialog.waitFor({ state: 'hidden' })

  // dedupe + cancel, at the raw IPC level
  const forgedSource = await page.evaluate(async ({ dir, source }) => {
    try { return await window.knoteDesktop.importAttachment(dir, '', source) } catch (error) { return { ok: false, error: String(error?.message || error) } }
  }, { dir: workspace, source: sourceAttachment })
  assert.equal(forgedSource.canceled, true)
  assert.match(forgedSource.error, /invalid_or_expired_import_source/)
  const deduped = await page.evaluate((dir) => window.knoteDesktop.importAttachment(dir, ''), workspace)
  assert.equal(deduped.name, 'e2e-source attachment-2.pdf')
  assert.equal(fs.existsSync(path.join(workspace, 'assets', 'e2e-source attachment-2.pdf')), true)
  await electronApp.evaluate(() => { globalThis.__knoteE2eDialogConfig.cancelNext = true })
  assert.deepEqual(await page.evaluate((dir) => window.knoteDesktop.importAttachment(dir, ''), workspace), { canceled: true })

  // Button A — in-place link, no copy: the source lives OUTSIDE the doc dir,
  // so the markdown link must be an absolute file:// URL
  await page.evaluate(() => window.__knoteDebug.link.insertLinkBelow())
  const content = await page.evaluate(() => window.__knoteDebug.getContent())
  assert.equal(fs.existsSync(sourceAttachment), true)
  assert.equal(fs.existsSync(written), true)
  assert.equal(fs.existsSync(path.join(workspace, 'e2e-source attachment.pdf')), false, 'in-place link must not copy the file')
  const encodedUrl = sourceAttachment.replace(/\\/g, '/').replace(/ /g, '%20')
  assert.ok(content.includes(`[e2e-source attachment.pdf](${encodedUrl})`), content)
  // 3 local links total: assets/ copy + share/ copy + one in-place absolute
  assert.equal(content.split('](').length - 1, 3, content)

  // open keep.md, then render its local-file links in the split preview:
  // relative assets/ link, user-chosen folder link and absolute file:// link
  // must all open with the OS default app without navigating the window
  const mixedMarkdown = path.join(workspace, 'notes', 'MixedCase.markdown')
  fs.writeFileSync(mixedMarkdown, '# Mixed case Markdown\n')
  await page.evaluate(() => window.__knoteDebug.folder.refresh())
  await workspaceTreeRow(page, 'keep.md').click()
  await page.getByTestId('current-file-name').filter({ hasText: 'keep.md' }).waitFor({ state: 'attached' })
  await page.locator('.knote-view-toggle button').nth(1).click()
  const sourceEditor = page.getByTestId('markdown-source-editor')
  await sourceEditor.waitFor({ state: 'attached' })
  await sourceEditor.fill('[attachment](assets/e2e-source%20attachment.pdf)\n[share](share/e2e-source%20attachment.pdf)\n[abs](' + encodedUrl + ')\n[nested](notes/nested.md)\n[mixed](notes/MixedCase.markdown)')
  const previewLinks = page.locator('.knote-md-render a')
  await previewLinks.first().waitFor({ state: 'attached' })
  assert.equal(await previewLinks.count(), 5)

  // hovering any preview link (local or web) shows the unified tooltip
  await previewLinks.nth(0).hover()
  const tooltip = page.getByTestId('link-tooltip')
  await tooltip.waitFor({ state: 'visible', timeout: 5_000 })
  await page.mouse.move(4, 4)
  await tooltip.waitFor({ state: 'hidden', timeout: 5_000 })

  // preview links follow the unified Ctrl + click convention
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.down('Control')
    await previewLinks.nth(i).click()
    await page.keyboard.up('Control')
    await waitUntil(async () => (await electronApp.evaluate(() => [...(globalThis.__knoteE2eOpenedPaths || [])])).length >= i + 1, {
      timeout: 10_000,
      message: `ctrl+clicking preview link #${i} never reached shell.openPath`
    })
  }
  const opened = await electronApp.evaluate(() => [...(globalThis.__knoteE2eOpenedPaths || [])])
  assert.equal(opened[0], path.resolve(written))
  assert.equal(opened[1], path.resolve(shareCopy))
  assert.equal(opened[2], path.resolve(sourceAttachment))
  assert.match(page.url(), /index\.html/, 'the window must not navigate away from the app')

  const tabsBeforeMarkdownLink = await page.evaluate(() => window.__knoteDebug.tabs.list().length)
  const keepTab = await page.evaluate(() => window.__knoteDebug.tabs.list().find((tab) => tab.active))
  const keepTabId = keepTab.id
  await page.keyboard.down('Control')
  await previewLinks.nth(3).click()
  await page.keyboard.up('Control')
  await waitUntil(() => page.evaluate(() => {
    const tabs = window.__knoteDebug.tabs.list()
    return tabs.length > 1 && tabs.some((tab) => tab.active && tab.treePath === '/notes/nested.md')
  }), { timeout: 10_000, message: 'the Markdown link did not open in a Knote tab' })
  assert.equal(await page.evaluate(() => window.__knoteDebug.tabs.list().length), tabsBeforeMarkdownLink + 1)
  const nestedTab = await page.evaluate(() => window.__knoteDebug.tabs.list().find((tab) => tab.active))
  assert.equal(nestedTab.treePath, '/notes/nested.md')
  assert.equal(nestedTab.workspaceId, keepTab.workspaceId)
  await page.getByTestId('current-file-name').filter({ hasText: 'nested.md' }).waitFor({ state: 'attached' })
  assert.equal((await electronApp.evaluate(() => [...(globalThis.__knoteE2eOpenedPaths || [])])).length, 3,
    'the Markdown link unexpectedly escaped to shell.openPath')
  assert.equal(await page.evaluate((tabId) => window.__knoteDebug.tabs.switch(tabId), keepTabId), true)

  await page.keyboard.down('Control')
  await previewLinks.nth(4).click()
  await page.keyboard.up('Control')
  await waitUntil(() => page.evaluate(() => {
    const active = window.__knoteDebug.tabs.list().find((tab) => tab.active)
    return active?.treePath === '/notes/MixedCase.markdown'
  }), { timeout: 10_000, message: 'the mixed-case Markdown link lost its workspace tree identity' })
  const mixedTab = await page.evaluate(() => window.__knoteDebug.tabs.list().find((tab) => tab.active))
  assert.equal(mixedTab.workspaceId, keepTab.workspaceId)
  assert.equal(await page.evaluate(() => window.__knoteDebug.tabs.list().length), tabsBeforeMarkdownLink + 2)
  assert.equal(await page.evaluate((tabId) => window.__knoteDebug.tabs.switch(tabId), keepTabId), true)

  // single-mode wiring: Ctrl + left-click inside the RichEditor on the
  // local-file link opens it with the OS app (no plain-click opening)
  await page.locator('.knote-view-toggle button').nth(0).click()
  const richEditor = page.locator('.ProseMirror').first()
  await richEditor.waitFor({ state: 'attached' })
  const richLink = page.locator('.ProseMirror a[href="assets/e2e-source%20attachment.pdf"]')
  await richLink.waitFor({ state: 'visible', timeout: 10_000 })
  await page.keyboard.down('Control')
  await richLink.click()
  await page.keyboard.up('Control')
  await waitUntil(async () => (await electronApp.evaluate(() => [...(globalThis.__knoteE2eOpenedPaths || [])])).length >= 4, {
    timeout: 10_000,
    message: 'ctrl+left-click on the rich editor link never reached shell.openPath'
  })
  assert.equal((await electronApp.evaluate(() => [...(globalThis.__knoteE2eOpenedPaths || [])]))[3], path.resolve(written))
  assert.match(page.url(), /index\.html/, 'the window must not navigate away from the app')

  // A standalone document receives no generic parent read grant. Its relative
  // Markdown sibling is nevertheless allowed through the narrow Markdown-only
  // boundary and opens in Knote, while shell.openPath remains untouched.
  const standaloneDir = path.join(path.dirname(workspace), 'standalone-links')
  fs.mkdirSync(standaloneDir)
  const standaloneSource = path.join(standaloneDir, 'Source.md')
  const standaloneTarget = path.join(standaloneDir, 'Sibling.MARKDOWN')
  fs.writeFileSync(standaloneSource, '[sibling](Sibling.MARKDOWN)\n')
  fs.writeFileSync(standaloneTarget, '# Standalone sibling\n')
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), standaloneSource), true)
  await page.getByTestId('current-file-name').filter({ hasText: 'Source.md' }).waitFor({ state: 'attached' })
  await page.locator('.knote-view-toggle button').nth(1).click()
  const standaloneLink = page.locator('.knote-md-render a[href="Sibling.MARKDOWN"]')
  await standaloneLink.waitFor({ state: 'visible' })
  const standaloneTabsBefore = await page.evaluate(() => window.__knoteDebug.tabs.list().length)
  await page.keyboard.down('Control')
  await standaloneLink.click()
  await page.keyboard.up('Control')
  await waitUntil(() => page.evaluate(() => window.__knoteDebug.tabs.list().some((tab) => tab.active && tab.label === 'Sibling.MARKDOWN')), {
    timeout: 10_000,
    message: 'standalone sibling Markdown did not open in a Knote tab'
  })
  assert.equal(await page.evaluate(() => window.__knoteDebug.tabs.list().length), standaloneTabsBefore + 1)
  assert.equal((await electronApp.evaluate(() => [...(globalThis.__knoteE2eOpenedPaths || [])])).length, 4)
})

test('the code language picker offers Mermaid and persists the selected fence', async (t) => {
  const { page, workspace } = await launchFixture(t)
  const target = path.join(workspace, 'language-picker.md')
  fs.writeFileSync(target, '```\nflowchart LR\n  A --> B\n```\n')
  assert.equal(await page.evaluate((file) => window.knoteDesktop.reopen('file', file), target), true)
  await page.getByTestId('current-file-name').filter({ hasText: 'language-picker.md' }).waitFor({ state: 'attached', timeout: 15_000 })

  const trigger = page.locator('.knote-code-lang-btn').first()
  await trigger.waitFor({ state: 'visible', timeout: 10_000 })
  await trigger.click()
  const menu = page.locator('.knote-code-lang-menu').first()
  await menu.waitFor({ state: 'visible' })
  const mermaid = menu.locator('.knote-code-lang-item', { hasText: /^mermaid$/ })
  await mermaid.waitFor({ state: 'visible' })
  const neutral = await mermaid.evaluate((element) => {
    const style = getComputedStyle(element)
    const probe = document.createElement('span')
    probe.style.color = 'var(--color-base-content)'
    element.appendChild(probe)
    const themeColor = getComputedStyle(probe).color
    probe.remove()
    return { color: style.color, themeColor, background: style.backgroundColor }
  })
  assert.equal(neutral.color, neutral.themeColor)
  assert.ok(neutral.background === 'rgba(0, 0, 0, 0)' || neutral.background === 'transparent')
  await mermaid.click()

  await waitUntil(() => page.evaluate(() => /```mermaid\nflowchart LR/.test(window.__knoteDebug.getContent())), {
    timeout: 10_000,
    message: 'the selected Mermaid language did not reach Markdown source'
  })
  assert.equal((await trigger.innerText()).trim(), 'mermaid')
  await page.locator('.knote-mermaid-preview').first().waitFor({ state: 'visible', timeout: 15_000 })
  await waitUntil(() => {
    try { return /^```mermaid/m.test(fs.readFileSync(target, 'utf8')) } catch { return false }
  }, { timeout: 15_000, message: 'the Mermaid fence was not saved' })
})

test('a multi-page PDF scrolls and pointer-zooms locally with a real selectable text layer', async (t) => {
  const { page, workspace } = await launchFixture(t)
  const pdfPath = path.join(workspace, 'sample.pdf')
  fs.writeFileSync(pdfPath, assembleTextPagesPdf([
    ['Hello selectable PDF text', 'First page'],
    ['Second page'],
    ['Third page']
  ]))
  await page.getByTestId('tree-refresh').click()
  await workspaceTreeRow(page, 'sample.pdf').waitFor({ state: 'attached', timeout: 15_000 })

  // real user path: click the tree row (the delayed background open intents
  // that used to cancel the preview right after it rendered are regressions)
  await workspaceTreeRow(page, 'sample.pdf').click()
  const viewer = page.getByTestId('pdf-viewer')
  await viewer.waitFor({ state: 'visible', timeout: 30_000 })
  await waitUntil(async () => await viewer.locator('.pdfViewer .page').count() === 3, {
    timeout: 30_000,
    message: 'the complete three-page PDF never mounted'
  })
  assert.equal(await viewer.locator('.pdfViewer .page').count(), 3, 'the viewer must retain every PDF page')
  const textLayer = viewer.locator('.pdfViewer .page .textLayer')
  await waitUntil(async () => (await textLayer.locator('span').count()) > 0, {
    timeout: 30_000,
    message: 'the PDF text layer never mounted'
  })
  const spanText = (await textLayer.locator('span').first().innerText()).trim()
  assert.ok(spanText.includes('Hello'), `text layer span has no text: "${spanText}"`)
  const spanStyle = await textLayer.locator('span').first().evaluate((el) => {
    const cs = getComputedStyle(el)
    return { position: cs.position, whiteSpace: cs.whiteSpace, fontSize: cs.fontSize }
  })
  assert.equal(spanStyle.position, 'absolute', 'text layer spans must be absolutely positioned on the glyphs')
  assert.ok(spanStyle.fontSize !== '0px' && parseFloat(spanStyle.fontSize) > 0, 'text layer span must be glyph-sized')
  // the layer is selectable: its spans are real text nodes, not images
  assert.match(await viewer.locator('.pdfViewer .page').first().innerHTML(), /<span[^>]*>Hello/i)
  // ALIGNMENT: the selectable region must sit on the actual glyphs. The
  // fixture places "Hello" at x=72pt on a 612x792pt page, so on screen the
  // span must be near 72/612 of the page width from its left edge, and near
  // (792-700)/792 of the page height from the top (PDF y grows upward).
  const geometry = await viewer.locator('.pdfViewer .page').first().evaluate((pageEl) => {
    const pageRect = pageEl.getBoundingClientRect()
    const span = pageEl.querySelector('.textLayer span')
    const sr = span.getBoundingClientRect()
    return {
      pageWidth: pageRect.width,
      pageHeight: pageRect.height,
      relLeft: (sr.left - pageRect.left) / pageRect.width,
      relTop: (sr.top - pageRect.top) / pageRect.height,
      relRight: (sr.right - pageRect.left) / pageRect.width,
      relBottom: (sr.bottom - pageRect.top) / pageRect.height
    }
  })
  t.diagnostic('pdf text-layer geometry: ' + JSON.stringify(geometry))
  assert.ok(geometry.pageWidth > 0 && geometry.pageHeight > 0, 'page must have laid out')
  assert.ok(geometry.relLeft > 0.05 && geometry.relLeft < 0.25, `span must sit near x=72pt (≈11.8% width), got ${geometry.relLeft.toFixed(3)}`)
  assert.ok(geometry.relTop > 0.02 && geometry.relTop < 0.3, `span must sit near the page top, got ${geometry.relTop.toFixed(3)}`)
  assert.ok(geometry.relRight <= 1.02 && geometry.relBottom <= 1.02, 'span must stay inside the page')

  const firstTextSpan = textLayer.locator('span').first()
  const textBox = await firstTextSpan.boundingBox()
  assert.ok(textBox && textBox.width > 8 && textBox.height > 0, 'the first PDF text span must have a draggable glyph box')
  const dragY = textBox.y + textBox.height / 2
  await page.mouse.move(textBox.x + 2, dragY)
  await page.mouse.down()
  await page.mouse.move(textBox.x + textBox.width - 2, dragY, { steps: 12 })
  await page.mouse.up()
  const selectionState = await firstTextSpan.evaluate((span) => {
    const root = span.getRootNode()
    const selection = root.getSelection?.() ?? document.getSelection()
    const selectionStyle = getComputedStyle(span, '::selection')
    return {
      text: selection?.toString() || '',
      collapsed: selection?.isCollapsed ?? true,
      rangeCount: selection?.rangeCount ?? 0,
      selectionRendering: span.closest('.textLayer')?.classList.contains('selectionRendering') ?? false,
      background: selectionStyle.backgroundColor
    }
  })
  assert.ok(selectionState.rangeCount > 0 && !selectionState.collapsed, JSON.stringify(selectionState))
  assert.match(selectionState.text, /selectable PDF/)
  assert.equal(selectionState.selectionRendering, false)
  assert.ok(
    selectionState.background && selectionState.background !== 'transparent' && selectionState.background !== 'rgba(0, 0, 0, 0)',
    `native PDF selection highlight is transparent: ${JSON.stringify(selectionState)}`
  )

  const scroller = viewer.getByTestId('pdf-scroll-container')
  const scaleLabel = viewer.getByTestId('pdf-scale')
  const initialScale = await scaleLabel.innerText()
  const initialUiZoom = await page.evaluate(() => localStorage.getItem('knote-zoom'))
  const initialRootScroll = await page.locator('.knote-root').evaluate((element) => element.scrollTop)
  const scrollerBox = await scroller.boundingBox()
  assert.ok(scrollerBox && scrollerBox.width > 0 && scrollerBox.height > 0, 'PDF scroller must be visible')
  const rootScrollState = await page.locator('.knote-root').evaluate((element) => {
    const style = getComputedStyle(element)
    return { overflowY: style.overflowY, scrollbarGutter: style.scrollbarGutter }
  })
  assert.deepEqual(rootScrollState, { overflowY: 'hidden', scrollbarGutter: 'auto' })
  const pdfScrollState = await scroller.evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }))
  assert.equal(pdfScrollState.overflowY, 'auto')
  assert.ok(pdfScrollState.scrollHeight > pdfScrollState.clientHeight, JSON.stringify(pdfScrollState))
  await page.mouse.move(scrollerBox.x + scrollerBox.width * 0.5, scrollerBox.y + scrollerBox.height * 0.5)
  await page.mouse.wheel(0, 620)
  await waitUntil(async () => (await scroller.evaluate((element) => element.scrollTop)) > 100, {
    timeout: 5_000,
    message: 'ordinary wheel input did not scroll the PDF'
  })
  assert.equal(await scaleLabel.innerText(), initialScale, 'ordinary wheel input must not zoom the PDF')
  assert.equal(await page.locator('.knote-root').evaluate((element) => element.scrollTop), initialRootScroll,
    'ordinary PDF wheel input must not reach Knote scrolling')

  const anchor = await scroller.evaluate((container) => {
    const containerRect = container.getBoundingClientRect()
    const x = containerRect.left + containerRect.width * 0.68
    const y = containerRect.top + containerRect.height * 0.45
    const pages = [...container.querySelectorAll('.pdfViewer .page')]
    const pageIndex = pages.findIndex((element) => {
      const rect = element.getBoundingClientRect()
      return rect.top <= y && rect.bottom >= y
    })
    if (pageIndex < 0) return null
    const pageRect = pages[pageIndex].getBoundingClientRect()
    return {
      x,
      y,
      pageIndex,
      pageLeft: pageRect.left,
      pageTop: pageRect.top,
      pageWidth: pageRect.width,
      pageHeight: pageRect.height,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      relX: (x - pageRect.left) / pageRect.width,
      relY: (y - pageRect.top) / pageRect.height
    }
  })
  assert.ok(anchor, 'a PDF page must exist under the zoom pointer')
  await page.mouse.move(anchor.x, anchor.y)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -140)
  await page.keyboard.up('Control')
  await waitUntil(async () => (await scaleLabel.innerText()) !== initialScale, {
    timeout: 5_000,
    message: 'Ctrl+wheel did not change the PDF scale'
  })
  await page.waitForTimeout(350)
  const anchoredAfter = await scroller.evaluate((container, { x, y, pageIndex }) => {
    const pageRect = container.querySelectorAll('.pdfViewer .page')[pageIndex].getBoundingClientRect()
    return {
      pageLeft: pageRect.left,
      pageTop: pageRect.top,
      pageWidth: pageRect.width,
      pageHeight: pageRect.height,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      relX: (x - pageRect.left) / pageRect.width,
      relY: (y - pageRect.top) / pageRect.height
    }
  }, anchor)
  t.diagnostic('pdf pointer zoom anchor: ' + JSON.stringify({ before: anchor, after: anchoredAfter }))
  assert.ok(Math.abs(anchoredAfter.relX - anchor.relX) < 0.025,
    `horizontal PDF zoom anchor drifted: ${anchor.relX} -> ${anchoredAfter.relX}`)
  assert.ok(Math.abs(anchoredAfter.relY - anchor.relY) < 0.025,
    `vertical PDF zoom anchor drifted: ${anchor.relY} -> ${anchoredAfter.relY}`)
  assert.equal(await page.evaluate(() => localStorage.getItem('knote-zoom')), initialUiZoom,
    'Ctrl+wheel inside the PDF must not change Knote UI zoom')
  assert.equal(await page.locator('.knote-zoom-toast').count(), 0,
    'Ctrl+wheel inside the PDF must not show the Knote zoom toast')
  await page.getByTestId('pdf-close').click()
  await viewer.waitFor({ state: 'hidden' })
})

test('a large chunked document detects its headings in the sidebar outline', async (t) => {
  const { page, workspace } = await launchFixture(t)
  // build a document big enough for chunked mode with clear headings
  let md = '# 主标题\n\n第一章 引言\n\n' + 'body text line\n'.repeat(2000)
  for (let i = 0; i < 40; i++) md += `\n## 小节 ${i}\n\n${'filler content for the section\n'.repeat(60)}`
  fs.writeFileSync(path.join(workspace, 'big-outline.md'), md)
  await page.getByTestId('tree-refresh').click()
  await workspaceTreeRow(page, 'big-outline.md').waitFor({ state: 'attached', timeout: 15_000 })
  await workspaceTreeRow(page, 'big-outline.md').click()
  await page.getByTestId('current-file-name').filter({ hasText: 'big-outline.md' }).waitFor({ state: 'attached', timeout: 20_000 })
  // chunked banner must be active
  await page.getByTestId('large-document-chunk-card').waitFor({ state: 'visible', timeout: 15_000 })
  // sidebar outline must eventually list the headings
  const outlineRows = page.locator('.knote-sidebar-card-scroll ul li button').filter({ hasText: /#|章节|小节/ })
  await outlineRows.first().waitFor({ state: 'attached', timeout: 20_000 })
  const texts = await page.locator('.knote-sidebar-card-scroll ul li button').evaluateAll((els) => els.map((e) => e.textContent).filter(Boolean).slice(0, 5))
  t.diagnostic('outline rows: ' + JSON.stringify(texts))
  assert.ok(texts.some((x) => x.includes('主标题') || x.includes('引言')), 'outline must contain document headings: ' + JSON.stringify(texts))
})
