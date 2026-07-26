import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  decodeToolInput,
  normalizeProviderToolCalls,
  providerStreamError,
  providerText
} from '../src/lib/agentToolProtocol.js'

test('OpenAI array-form text is flattened instead of becoming [object Object]', () => {
  assert.equal(providerText([
    { type: 'text', text: '第一段' },
    { type: 'output_text', text: '第二段' },
    '第三段'
  ]), '第一段第二段第三段')
  assert.equal(providerText({ text: 'not a supported top-level shape' }), '')
})

test('malformed or non-object tool arguments are never silently accepted as an empty object', () => {
  const broken = decodeToolInput('{"path":"a.md"')
  assert.deepEqual(broken.input, {})
  assert.match(broken.error, /不是有效 JSON/)

  const array = decodeToolInput('["a.md"]')
  assert.deepEqual(array.input, {})
  assert.match(array.error, /顶层必须是对象/)

  const valid = decodeToolInput('{"path":"a.md"}')
  assert.deepEqual(valid, { input: { path: 'a.md' }, error: null })
})

test('missing and duplicate provider call IDs become unique protocol-safe IDs', () => {
  const calls = normalizeProviderToolCalls([
    { id: '', name: 'read_document', input: '{}' },
    { id: 'same', name: 'read_file', input: '{"path":"a.md"}' },
    { id: 'same', name: 'read_file', input: '{"path":"b.md"}' }
  ], { prefix: 'probe' })
  assert.deepEqual(calls.map((call) => call.id), ['probe_1', 'same', 'same_2'])
  assert.equal(new Set(calls.map((call) => call.id)).size, calls.length)
  assert.deepEqual(calls[2].input, { path: 'b.md' })
})

test('HTTP-200 stream error events are surfaced as actual request failures', () => {
  assert.equal(providerStreamError({ error: { message: 'upstream disconnected' } }), 'upstream disconnected')
  assert.equal(providerStreamError({ type: 'message_delta' }), '')
})

test('agent loop rejects unoffered tools, reports malformed arguments, and continues truncated output', () => {
  const source = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
  assert.match(source, /offeredToolNames\.has\(call\.name\)/)
  assert.match(source, /code: 'TOOL_NOT_AVAILABLE'/)
  assert.match(source, /code: 'INVALID_TOOL_ARGUMENTS'/)
  assert.match(source, /resp\.truncated && round < 19/)
  assert.match(source, /上一段输出因模型长度上限被截断/)
  assert.match(source, /code: 'QUESTION_MUST_BE_EXCLUSIVE'/)
  assert.match(source, /ask_user 必须是该次模型输出中唯一的工具调用/)
  assert.match(source, /工具 \$\{group\.call\.name\}（call_id=\$\{group\.call\.id\}）返回的/)
})

test('tool instructions distinguish data from authority and remove ambiguous PDF/file routing', () => {
  const source = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
  assert.match(source, /当前文档、工作区文件.*不可信数据/)
  assert.match(source, /一批并行调用中只要有一个失败/)
  assert.match(source, /不要再对同一页调用 pdf_layout 做重复分析/)
  assert.match(source, /长文件可传 start_line\/end_line 分段读取/)
  assert.match(source, /normalizeWorkspacePath\(input\.path\)/)
  assert.match(source, /code: 'RANGE_NOT_READ'/)
  assert.match(source, /lastReadDocRanges = \[\]/)
  assert.match(source, /为避免静默截断，本文件未处理/)
  assert.doesNotMatch(source, /old_string 仍可引用未显示部分/)
})

test('every advertised tool has exactly one executor branch across the full tool surface', () => {
  const source = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
  const toolBlock = source.slice(source.indexOf('const TOOLS = ['), source.indexOf('const SYSTEM_PROMPT'))
  const switchBlock = source.slice(source.indexOf('const executeTool ='), source.indexOf('const ACTIVITY_LABEL'))
  const advertised = [...toolBlock.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1])
  const executed = [...switchBlock.matchAll(/case\s+'([^']+)'/g)].map((match) => match[1])
  const expected = [
    'read_document', 'ask_user', 'replace_lines', 'insert_lines', 'discard_hunks',
    'continue_hunk', 'create_file', 'create_folder', 'list_files', 'read_file',
    'edit_file', 'read_workspace_pdf', 'read_workspace_image', 'web_search',
    'web_fetch', 'read_pdf_text', 'render_pdf_page', 'pdf_prepare',
    'pdf_get_element', 'pdf_crop_region', 'pdf_layout', 'insert_image',
    'batch_process', 'update_plan', 'get_datetime', 'find_in_files', 'get_outline',
    'move_file', 'rename_file', 'delete_file', 'calc'
  ]
  assert.deepEqual(advertised, expected)
  assert.equal(new Set(advertised).size, advertised.length)
  assert.deepEqual([...executed].sort(), [...expected].sort())
})
