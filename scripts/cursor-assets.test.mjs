import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CURSOR_SIZE, CURSOR_DEFINITIONS, buildCursorCss, cursorSvg, cursorValue } from './cursor-assets.mjs'

test('cursor family has sixteen distinct, bounded native hotspots and semantic fallbacks', () => {
  assert.equal(CURSOR_DEFINITIONS.length, 16)
  assert.equal(new Set(CURSOR_DEFINITIONS.map(def => def.name)).size, 16)
  for (const definition of CURSOR_DEFINITIONS) {
    for (const coordinate of definition.hotspot) {
      assert.ok(Number.isInteger(coordinate) && coordinate >= 0 && coordinate < CURSOR_SIZE)
    }
    assert.match(cursorValue(definition), new RegExp(` ${definition.hotspot.join(' ')}, ${definition.name}$`))
  }
  assert.deepEqual(CURSOR_DEFINITIONS.find(def => def.name === 'pointer').hotspot, [12, 4])
  assert.deepEqual(CURSOR_DEFINITIONS.find(def => def.name === 'text').hotspot, [16, 16])
})

test('cursor assets stay vector-clean and only the text cursor has an explicit white contrast outline', () => {
  for (const definition of CURSOR_DEFINITIONS) {
    for (const dark of [false, true]) {
      const svg = cursorSvg(definition, dark)
      assert.match(svg, /width="32" height="32" viewBox="0 0 32 32"/)
      assert.ok(svg.includes(dark && definition.name !== 'text' ? '#f1f5f9' : '#1f2937'))
      assert.ok(svg.includes('#84cc16'))
      if (definition.name === 'text') {
        assert.match(svg, /stroke="#ffffff" stroke-width="5\.2"/)
        assert.equal((svg.match(/M11 6H21M16 6V26M11 26H21/g) || []).length, 2, 'outline follows the exact I-beam silhouette')
        assert.match(svg, /stroke-width="2\.8"/)
        assert.match(svg, /stroke-linecap="round"/)
      } else assert.doesNotMatch(svg, /stroke="#ffffff"/)
      assert.doesNotMatch(svg, /<script|<foreignObject|<image|<rect|<filter|<animate|href=|https?:\/\/(?!www\.w3\.org\/2000\/svg)/)
      const value = cursorValue(definition, dark)
      assert.ok(value.length < 7000, 'each cursor stays a tiny local CSS resource')
      assert.ok(value.includes('data:image/svg+xml,'))
    }
  }
})

test('checked-in cursor CSS matches its artwork source exactly', () => {
  assert.equal(fs.readFileSync(new URL('../src/cursors.css', import.meta.url), 'utf8').replaceAll('\r\n', '\n'), buildCursorCss())
})

test('cursor theme respects forced-colors and preserves directional resize semantics', () => {
  const css = buildCursorCss()
  assert.match(css, /@media \(forced-colors: active\)/)
  for (const definition of CURSOR_DEFINITIONS) assert.ok(css.includes(`--knote-cursor-${definition.name}: ${definition.name};`))
  assert.match(css, /\.cursor-col-resize \{ cursor: var\(--knote-cursor-ew-resize\)/)
  assert.match(css, /\.cursor-row-resize \{ cursor: var\(--knote-cursor-ns-resize\)/)
  assert.doesNotMatch(css, /cursor:\s*none|pointer-events|position:|animation:|transition:|!important/)
  assert.doesNotMatch(css, /;\\n/)
  assert.match(css, /:root\[data-cursor-style="system"\]/)
})

test('cursor artwork is build-only and never registers mouse tracking or animation loops', () => {
  const entry = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  assert.ok(entry.includes("import './cursors.css'"))
  assert.doesNotMatch(entry, /cursor-assets/)
  const generator = fs.readFileSync(new URL('./cursor-assets.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(generator, /addEventListener|requestAnimationFrame|setInterval|setTimeout|fetch\(/)
})
