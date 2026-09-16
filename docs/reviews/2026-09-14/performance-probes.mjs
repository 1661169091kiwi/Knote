// Read-only, bounded probes of the CURRENT source. No app profile/API/network.
// These are microbenchmarks, not Electron end-to-end latency measurements.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { performance } from 'node:perf_hooks'
import { JSDOM } from 'jsdom'
import { Schema } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import MarkdownIt from 'markdown-it'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'
import { inspectLargeDocumentShape } from '../../../src/lib/largeDocumentPolicy.js'
import { buildLargeSourceOffsets } from '../../../src/lib/largeSourceDraft.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const app = read('src/App.vue')
const editor = read('src/components/RichEditor.vue')
const panel = read('src/components/AgentPanel.vue')
const slice = (s, start, end) => {
  const a = s.indexOf(start), b = s.indexOf(end, a)
  if (a < 0 || b < 0) throw Error(`Source anchors changed: ${start}`)
  return s.slice(a, b)
}
const result = { scope: 'Current-source microbenchmarks; no layout/paint or native app timing', cache: [], headings: [] }

// Use the current cache FUNCTION unchanged. Only the renderer dependencies
// are lightweight stubs: what we measure here is cache misses, not wall time.
const cacheSource = slice(app, 'const agentMdCache = new Map()', '// ---- selection')
for (const count of [100, 400, 401, 402, 600]) {
  let renders = 0
  const c = vm.createContext({
    watch: () => {}, imageStore: {}, relImages: {},
    activeResourceScopeKey: { value: 'probe' }, lang: { value: 'zh' },
    md: { render: (s) => { renders++; return s } },
    linkifyLineRefs: (s) => s, resolveAgentChatImages: (s) => s,
    sanitizeHtml: (s) => s, decorateAgentCopyControls: (s) => s
  })
  vm.runInContext(cacheSource + '\nglobalThis.renderProbe = renderAgentMd', c)
  const texts = Array.from({ length: count }, (_, i) => `reply-${i}`)
  texts.forEach(c.renderProbe)
  const first = renders
  texts.forEach(c.renderProbe)
  const second = renders - first
  texts.forEach(c.renderProbe)
  result.cache.push({ assistantMessages: count, firstPassMisses: first, unchangedSecondPassMisses: second, unchangedThirdPassMisses: renders - first - second })
}

// Extract the current heading-decoration implementation, with real
// ProseMirror nodes/decorations and jsdom buttons (no browser layout).
const dom = new JSDOM('<!doctype html><body></body>')
const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, text: { group: 'inline' },
  paragraph: { content: 'inline*', group: 'block' },
  heading: { content: 'inline*', group: 'block', attrs: { level: { default: 2 } } }
} })
let buttonsCreated = 0
const documentProxy = { createElement: (...args) => { buttonsCreated++; return dom.window.document.createElement(...args) } }
const fc = vm.createContext({ document: documentProxy, Decoration, DecorationSet })
vm.runInContext(slice(editor, 'const foldedRange =', 'const HeadingFold =') + '\nglobalThis.buildProbe = buildFoldDecos; globalThis.resetProbe = () => foldToggleCache.clear()', fc)
for (const count of [50, 200, 500, 1000]) {
  fc.resetProbe()
  const nodes = []
  for (let i = 0; i < count; i++) {
    nodes.push(schema.nodes.heading.create({ level: 2 }, schema.text(`Heading ${i}`)))
    nodes.push(schema.nodes.paragraph.create(null, schema.text('Short paragraph.')))
  }
  const doc = schema.nodes.doc.create(null, nodes)
  const before = buttonsCreated
  fc.buildProbe(doc, new Set())
  const initialButtons = buttonsCreated - before
  const samples = []
  for (let i = 0; i < 15; i++) {
    const start = performance.now()
    fc.buildProbe(doc, new Set())
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  result.headings.push({ headings: count, blocks: nodes.length, initialButtons, extraButtonsOn15Rebuilds: buttonsCreated - before - initialButtons, rebuildMedianMs: +samples[7].toFixed(3), rebuildP95Ms: +samples[14].toFixed(3) })
}
dom.window.close()

const splitContext = vm.createContext({})
vm.runInContext(slice(panel, 'const PROVISIONAL_SPLIT_MIN =', 'const provisionalHtml =') + '\nglobalThis.splitProbe = splitProvisionalDraft', splitContext)
const prose = 'This is a completed paragraph with **bold** words and a short sentence.\n\n'.repeat(500)
const fence = '```js\n' + 'const sample = "a line inside a long code block";\n'.repeat(800)
result.streamingSplit = [prose, fence].map((text, i) => {
  const { prefix, tail } = splitContext.splitProbe(text)
  return { shape: i ? 'one long unclosed code block' : 'many complete paragraphs', characters: text.length, cachedPrefixCharacters: prefix.length, liveTailCharacters: tail.length }
})

// Source is read only; never written/opened in the app. Report metadata only.
const realPath = 'D:/D-projects/开源agent技术/OpenCode/OpenCode源码技术全景与架构解析.md'
if (fs.existsSync(realPath)) {
  const source = fs.readFileSync(realPath, 'utf8')
  const start = performance.now()
  const shape = inspectLargeDocumentShape(source)
  const offsets = buildLargeSourceOffsets(source, 32000)
  const sizes = offsets.slice(1).map((end, i) => end - offsets[i])
  result.realDocument = { bytes: Buffer.byteLength(source), ...shape, chunks: sizes.length, maxChunkCharacters: Math.max(...sizes), policyAndOffsetsMs: +(performance.now() - start).toFixed(3) }
  const chunks = offsets.slice(1).map((end, i) => inspectLargeDocumentShape(source.slice(offsets[i], end)))
  result.realDocument.firstChunk = chunks[0]
  result.realDocument.maxMermaidFencesPerChunk = Math.max(...chunks.map((x) => x.mermaidFences))

  // Actual installed lowlight plugin + actual first-chunk fenced code. We
  // neither mount Mermaid nor disclose the document's text in this output.
  const codeSchema = new Schema({ nodes: {
    doc: { content: 'block+' }, text: { group: 'inline' },
    paragraph: { content: 'text*', group: 'block' },
    codeBlock: { content: 'text*', group: 'block', code: true, attrs: { language: { default: null } } }
  } })
  const fences = new MarkdownIt().parse(source.slice(0, offsets[1]), {}).filter((token) => token.type === 'fence')
  const codeNodes = fences.map((token) => codeSchema.nodes.codeBlock.create({ language: token.info.trim().split(/\s+/)[0] || null }, token.content ? codeSchema.text(token.content) : undefined))
  const lowlight = createLowlight(common)
  let auto = 0, explicit = 0
  const countedLowlight = {
    ...lowlight,
    highlight: (...args) => { explicit++; return lowlight.highlight(...args) },
    highlightAuto: (...args) => { auto++; return lowlight.highlightAuto(...args) }
  }
  const plugin = CodeBlockLowlight.config.addProseMirrorPlugins.call({ name: 'codeBlock', options: { lowlight: countedLowlight, defaultLanguage: null } })[0]
  if (codeNodes.length) {
    const codeDoc = codeSchema.nodes.doc.create(null, codeNodes)
    const initStart = performance.now()
    const state = EditorState.create({ schema: codeSchema, doc: codeDoc, selection: TextSelection.create(codeDoc, 1), plugins: [plugin] })
    const initial = { auto, explicit, ms: +(performance.now() - initStart).toFixed(3) }
    auto = 0; explicit = 0
    const editStart = performance.now()
    state.apply(state.tr.insertText('x', 1))
    result.lowlightFirstChunk = { codeBlocks: codeNodes.length, registeredGrammars: lowlight.listLanguages().length, mermaidRegistered: lowlight.listLanguages().includes('mermaid'), initial, oneCharacterEdit: { auto, explicit, ms: +(performance.now() - editStart).toFixed(3) } }
  }
}

// Baseline parser only, without highlighting, KaTeX, sanitizer or DOM layout.
const md = new MarkdownIt()
const sample = '# Response\n\nA **detailed** explanation with several points.\n\n- first\n- second\n\n```js\nconst x = 42;\n```\n'.repeat(15)
const started = performance.now()
for (let i = 0; i < 402; i++) md.render(sample + i)
result.parserOnly402MessagesMs = +(performance.now() - started).toFixed(3)
console.log(JSON.stringify(result, null, 2))
