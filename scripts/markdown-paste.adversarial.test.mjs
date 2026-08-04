import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  hasExplicitMarkdownSyntax,
  normalizePastedMarkdownText
} from '../src/lib/clipboardMarkdown.js'

test('terminal clipboard CRLF rows do not become visible Markdown rows', () => {
  assert.equal(normalizePastedMarkdownText('**bold**\r\n'), '**bold**')
  assert.equal(normalizePastedMarkdownText('*italic*\r\n\r\n'), '*italic*')
  assert.equal(normalizePastedMarkdownText('[link](https://example.com)\n\n\n'), '[link](https://example.com)')
  assert.equal(normalizePastedMarkdownText('`code`\r'), '`code`')
})

test('intentional internal blank lines and fenced-code rows remain exact', () => {
  assert.equal(normalizePastedMarkdownText('A\r\n\r\nB\r\n'), 'A\n\nB')
  assert.equal(
    normalizePastedMarkdownText('```js\r\nconst x = 1\r\n\r\nconsole.log(x)\r\n```\r\n'),
    '```js\nconst x = 1\n\nconsole.log(x)\n```'
  )
})

test('empty clipboard text stays empty', () => {
  assert.equal(normalizePastedMarkdownText(''), '')
  assert.equal(normalizePastedMarkdownText('\r\n\r\n'), '')
})

test('dual-MIME clipboard detection prefers only explicit Markdown source', () => {
  const exact = 'RAL-Bench 主要研究：**基础 LLM 能否一次性生成满足功能与五类非功能属性的 Python 应用？**\r\nMAGIC-Bench 主要研究：**具有规划、文件编辑、Shell、构建和迭代调试能力的 Agent-System，能否完成跨语言项目重构；主干模型与 Agent Harness 分别如何影响七个质量维度？"**'
  assert.equal(hasExplicitMarkdownSyntax(exact), true)
  assert.equal(hasExplicitMarkdownSyntax('# Heading\n\n- item'), true)
  assert.equal(hasExplicitMarkdownSyntax('*italic*'), true)
  assert.equal(hasExplicitMarkdownSyntax('_italic_'), true)
  assert.equal(hasExplicitMarkdownSyntax('\u8fd9\u662f*\u659c\u4f53*\u3002'), true)
  assert.equal(hasExplicitMarkdownSyntax('\uff08*\u659c\u4f53*\uff09'), true)
  assert.equal(hasExplicitMarkdownSyntax('\u8fd9\u662f _\u659c\u4f53_\u3002'), true)
  assert.equal(hasExplicitMarkdownSyntax('==highlight=='), true)
  assert.equal(hasExplicitMarkdownSyntax('++underline++'), true)
  assert.equal(hasExplicitMarkdownSyntax('A | B\n--- | ---'), true)
  assert.equal(hasExplicitMarkdownSyntax('---'), true)
  assert.equal(hasExplicitMarkdownSyntax('A normal paragraph.\nA second normal paragraph.'), false)
  assert.equal(hasExplicitMarkdownSyntax('Use a*b as ordinary prose.'), false)
  assert.equal(hasExplicitMarkdownSyntax('Use snake_case as ordinary prose.'), false)
})

test('the normalizer is wired ahead of tiptap-markdown in the real editor', async () => {
  const source = await readFile(new URL('../src/components/RichEditor.vue', import.meta.url), 'utf8')
  const extension = source.indexOf('const NormalizedMarkdownPaste = Extension.create')
  const priority = source.indexOf('priority: 1000', extension)
  const parser = source.indexOf('clipboardTextParser:', extension)
  const registered = source.indexOf('    NormalizedMarkdownPaste,')
  const markdown = source.indexOf('    Markdown.configure({', registered)
  assert.ok(extension >= 0 && priority > extension && parser > priority)
  assert.ok(registered > parser && markdown > registered)
  assert.match(source, /types\.includes\(['"]text\/html['"]\)/)
  assert.match(source, /hasExplicitMarkdownSyntax\(plain\)/)
  assert.match(source, /if\s*\(plainText\)\s*return\s+parseLiteralPlainTextSlice/)
  assert.match(source, /view\.input\?\.shiftKey/)
  assert.match(source, /parent\.type\.spec\.code/)
  assert.match(source, /querySelector\(['"]\[data-pm-slice\]/)
  assert.match(source, /querySelector\(['"]\[data-pm-slice\], img, svg/)
  assert.doesNotMatch(source, /querySelector\([^\n]+table, pre, code, a\[href\]/)
  assert.match(source, /view\.state\.tr\.insertText\(literal\)/)
  assert.match(source, /replace\(\/\\r\\n\?\/g, ['"]\\n['"]\)\.split\(['"]\\n['"]\)/)
  assert.match(source, /replaceSelection\(slice\)/)
})

test('a newly opened file is synchronized before its editor becomes interactive', async () => {
  const editorSource = await readFile(new URL('../src/components/RichEditor.vue', import.meta.url), 'utf8')
  const appSource = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
  const mainSource = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8')
  const watcher = editorSource.indexOf('watch(() => props.modelValue')
  const nextWatcher = editorSource.indexOf('watch(() => props.active', watcher)
  const body = editorSource.slice(watcher, nextWatcher)
  assert.ok(watcher >= 0 && nextWatcher > watcher)
  assert.match(body, /\{\s*flush:\s*['"]sync['"]\s*\}\)/)
  assert.doesNotMatch(body, /editor\.isFocused\s*&&\s*emitTimer/)
  assert.match(appSource, /restoreGeneration\s*!==\s*tabRestoreGeneration/)
  assert.match(appSource, /switchGeneration\s*!==\s*tabSwitchGeneration/)
  assert.match(appSource, /activeTabId\.value\s*!==\s*restoreTabId/)
  const restoreStart = appSource.indexOf('const restoreTab = (tb) =>')
  const restoreEnd = appSource.indexOf('const switchTab = async', restoreStart)
  const restoreBody = appSource.slice(restoreStart, restoreEnd)
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart)
  assert.ok(
    restoreBody.indexOf('richEditorRef.value.forceSync(richMarkdown.value)') < restoreBody.indexOf('nextTick(() =>'),
    'forceSync/resetHistory must finish before the restored tab becomes interactive'
  )
  assert.match(appSource, /if\s*\(foregroundOpenGeneration\s*>\s*0\)\s*return/)
  assert.match(appSource, /pendingSessionOpens\.set\(requestId,\s*\{/)
  assert.match(appSource, /token\.foregroundGeneration\s*===\s*foregroundOpenGeneration/)
  assert.match(appSource, /openRequest\.kind\s*===\s*['"]stale-session['"]/)
  assert.match(mainSource, /foregroundOpenIntentSequence/)
  assert.match(mainSource, /openSequence/)
  assert.match(appSource, /sequence\s*<\s*latestForegroundOpenSequence/)
  assert.match(appSource, /['"]stale-foreground['"]/)
  assert.match(appSource, /pendingSessionOpenCompletions\.set\(requestId/)
  assert.match(appSource, /await\s+Promise\.race\(\[/)
  assert.match(editorSource, /emit\(['"]localchange['"]\)/)
})
