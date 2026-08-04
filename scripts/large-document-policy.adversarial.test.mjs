import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  inspectLargeDocumentShape,
  shouldUsePagedSource,
  LARGE_SOURCE_CHUNK_SIZE
} from '../src/lib/largeDocumentPolicy.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const makeArchitectureFixture = () => {
  const lines = []
  for (let section = 0; section < 161; section++) {
    lines.push(`# Module ${section}`)
    lines.push(`## Data flow ${section}`)
    lines.push('| component | responsibility |')
    lines.push('| --- | --- |')
    lines.push('```mermaid')
    lines.push(`graph TD; A${section}-->B${section}`)
    lines.push('```')
    for (let row = 0; row < 45; row++) {
      lines.push(`Architecture note ${section}.${row}: flow and state.`)
    }
  }
  return lines.join('\n')
}

test('a 350k-class architecture document with many diagrams selects chunked rich editing', () => {
  const source = makeArchitectureFixture()
  const shape = inspectLargeDocumentShape(source)
  assert.ok(shape.characters > 280_000 && shape.characters < 450_000)
  assert.ok(shape.lines > 8_000)
  assert.equal(shape.mermaidFences, 161)
  assert.equal(shape.usePagedSource, true)
})

test('simple prose shorter than a single chunk stays in the whole-document editor', () => {
  const source = 'plain prose '.repeat(2_000)
  assert.ok(source.length < LARGE_SOURCE_CHUNK_SIZE)
  assert.equal(shouldUsePagedSource(source), false)
})

test('text longer than one chunk triggers chunked editing regardless of shape', () => {
  const source = 'plain prose '.repeat(4_000)
  assert.ok(source.length > LARGE_SOURCE_CHUNK_SIZE)
  assert.equal(shouldUsePagedSource(source), true)
  assert.equal(LARGE_SOURCE_CHUNK_SIZE, 32_000, 'chunk length must stay in sync with the paging threshold')
})

test('four-space indented examples are not mistaken for Markdown fences', () => {
  const shape = inspectLargeDocumentShape('    ```mermaid\n    graph TD\n    ```')
  assert.equal(shape.fenceMarkers, 0)
  assert.equal(shape.mermaidFences, 0)
})

test('the hard safety limit still pages unstructured million-character input', () => {
  assert.equal(shouldUsePagedSource('x'.repeat(1_000_000)), true)
})

test('hard-limit documents return before any line scan while preserving the result shape', () => {
  const originalIndexOf = String.prototype.indexOf
  let indexOfCalls = 0
  let shape
  String.prototype.indexOf = function (...args) {
    indexOfCalls++
    return originalIndexOf.apply(this, args)
  }
  try {
    shape = inspectLargeDocumentShape('x'.repeat(8 * 1024 * 1024))
  } finally {
    String.prototype.indexOf = originalIndexOf
  }
  assert.equal(indexOfCalls, 0)
  assert.deepEqual(Object.keys(shape).sort(), [
    'characters', 'complexity', 'fenceMarkers', 'headings', 'lines',
    'mermaidFences', 'tableRows', 'usePagedSource'
  ])
  assert.equal(shape.characters, 8 * 1024 * 1024)
  assert.equal(shape.complexity, shape.characters)
  assert.equal(shape.lines, 0)
  assert.equal(shape.usePagedSource, true)
})

test('every App entry point uses the same adaptive policy', () => {
  const app = fs.readFileSync(path.join(here, '..', 'src', 'App.vue'), 'utf8')
  assert.match(app, /import \{ shouldUsePagedSource(?:, LARGE_SOURCE_CHUNK_SIZE)? \} from '\.\/lib\/largeDocumentPolicy\.js'/)
  assert.match(app, /const plain = shouldUsePagedSource\(nextContent\)/)
  assert.equal((app.match(/shouldUsePagedSource\(/g) || []).length, 1, 'large-document policy should be centralized in stageLargeEditorLoad')
  assert.match(app, /const editorLoad = stageLargeEditorLoad\(nextContent/)
  assert.match(app, /const editorLoad = stageLargeEditorLoad\(tb\.content/)
  assert.doesNotMatch(app, /LARGE_DOCUMENT_PLAIN_THRESHOLD/)
  assert.match(app, /data-large-document-mode="largeDocumentPlainMode \? 'chunked-rich' : 'off'"/)
  assert.match(app, /data-testid="large-document-rich-chunk"/)
  assert.match(app, /:content-key="largeSourceEditorVersion"/)
  assert.doesNotMatch(app, /data-testid="large-document-source"/)
})
