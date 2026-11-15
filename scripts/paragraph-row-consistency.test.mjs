import test from 'node:test'
import assert from 'node:assert/strict'
import MarkdownIt from 'markdown-it'
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { fromInternal, toInternal, needsBlankBetween, withoutTrailingBlankLines } from '../src/lib/emptyRows.js'
import { frameRegion, exactSerializedBlockLines } from '../src/lib/markdownSourceLines.js'

// Blank lines follow the Typora model: between two blocks the first blank line
// is the paragraph boundary (not shown), every further blank line is one
// visible empty row; at the start or end of the file every blank line is a row.
const render = source => new MarkdownIt({ breaks: true }).render(toInternal(source))
const visibleBlankRows = source => (render(source).match(/<p> <\/p>/g) || []).length
const paragraphs = source => (render(source).match(/<p>(?! <\/p>)/g) || []).length

test('one blank line between paragraphs is the boundary, never a visible row', () => {
  const source = fromInternal('ALPHA\n\nOMEGA')
  assert.equal(source, 'ALPHA\n\nOMEGA', 'Enter between paragraphs writes the standard blank line')
  assert.equal(visibleBlankRows(source), 0)
  assert.equal(paragraphs(source), 2, 'two paragraphs, as every other Markdown tool reads them')
})

test('each explicit empty editor row adds one blank line after the boundary', () => {
  for (let count = 1; count <= 4; count++) {
    const internal = ['ALPHA', ...Array(count).fill('&nbsp;'), 'OMEGA'].join('\n\n')
    const source = fromInternal(internal)
    assert.equal(source, `ALPHA${'\n'.repeat(count + 2)}OMEGA`)
    assert.equal(visibleBlankRows(source), count)
    assert.equal(fromInternal(toInternal(source)), source)
  }
})

test('a paragraph typed into the middle keeps both boundaries and adds no rows', () => {
  const source = fromInternal('ALPHA\n\nMIDDLE\n\nOMEGA')
  assert.equal(source, 'ALPHA\n\nMIDDLE\n\nOMEGA')
  assert.equal(visibleBlankRows(source), 0)
  assert.equal(paragraphs(source), 3)
})

test('blank lines at the start or end of the file are rows, and keep their bytes', () => {
  assert.equal(visibleBlankRows('\nALPHA'), 1)
  assert.equal(visibleBlankRows('ALPHA\n'), 1)
  assert.equal(fromInternal('&nbsp;\n\nALPHA'), '\nALPHA')
  assert.equal(fromInternal('ALPHA\n\n&nbsp;'), 'ALPHA\n', 'no boundary is written when no block follows')
})

test('exports drop the file\'s final newline instead of printing a trailing empty row', () => {
  assert.equal(withoutTrailingBlankLines('ALPHA\n'), 'ALPHA')
  assert.equal(withoutTrailingBlankLines('ALPHA\n\n \n\t\n'), 'ALPHA')
  assert.equal(withoutTrailingBlankLines('\nALPHA\n\n\nOMEGA'), '\nALPHA\n\n\nOMEGA', 'leading and inner rows are content')
  assert.equal(visibleBlankRows(withoutTrailingBlankLines('ALPHA\n')), 0)
})

test('existing source blanks, tight adjacency and fenced code retain their exact bytes', () => {
  for (const source of ['ALPHA\n\nOMEGA', 'ALPHA\n\n\nOMEGA', 'ALPHA\n\n\n\n\nOMEGA', '\nALPHA\n', 'ALPHA\nOMEGA', '## H\nTEXT', '- a\n\n- b', '- a\n\n\n  b', '```txt\nALPHA\n\nOMEGA\n```']) {
    assert.equal(fromInternal(toInternal(source)), source, JSON.stringify(source))
  }
  assert.equal(visibleBlankRows('```txt\nALPHA\n\n\nOMEGA\n```'), 0, 'blank lines inside a fence are code')
})

test('a region is framed with the boundary it needs, and nothing more', () => {
  // typing into a former empty row between two paragraphs
  assert.deepEqual(frameRegion(['MIDDLE'], { above: 'ALPHA', below: 'OMEGA', firstWas: '', lastWas: '' }), { lines: ['', 'MIDDLE', ''], lead: 1 })
  // a new paragraph inserted between two blocks that sat apart
  assert.deepEqual(frameRegion(['NEW'], { above: 'ALPHA', below: 'OMEGA' }), { lines: ['', 'NEW', ''], lead: 1 })
  // a paragraph deleted from between two others: only the boundary stays
  assert.deepEqual(frameRegion([], { above: 'ALPHA', below: 'OMEGA', firstWas: '', lastWas: '' }), { lines: [''], lead: 1 })
  // rows next to content always come with the boundary
  assert.deepEqual(frameRegion(['', 'X'], { above: 'ALPHA', below: 'OMEGA', firstWas: '', lastWas: '' }), { lines: ['', '', 'X', ''], lead: 1 })
  assert.deepEqual(frameRegion(['X', ''], { above: 'ALPHA', below: 'OMEGA', firstWas: '', lastWas: '' }), { lines: ['', 'X', '', ''], lead: 1 })
  // rows at the end of the file have no boundary to hold
  assert.deepEqual(frameRegion(['', ''], { above: 'ALPHA' }), { lines: ['', ''], lead: 0 })
  // a paragraph the source kept right under its heading (or a table) stays there
  assert.deepEqual(frameRegion(['TEXT2'], { above: '## H', firstWas: 'TEXT', lastWas: 'TEXT' }), { lines: ['TEXT2'], lead: 0 })
  assert.deepEqual(frameRegion(['TEXT2'], { above: '| a | b |', firstWas: 'TEXT', lastWas: 'TEXT' }), { lines: ['TEXT2'], lead: 0 })
  // ...but a heading turned into text under a paragraph would merge: separate it
  assert.deepEqual(frameRegion(['H'], { above: 'TEXT', firstWas: '## H', lastWas: '## H' }), { lines: ['', 'H'], lead: 1 })
})

test('structural separators still prevent a paragraph becoming a setext heading or swallowing a list', () => {
  assert.equal(fromInternal('ALPHA\n\n---'), 'ALPHA\n\n---')
  assert.equal(needsBlankBetween('ALPHA', '---'), true)
  assert.equal(needsBlankBetween('ALPHA', '2. ITEM'), true)
  assert.equal(needsBlankBetween('- item', 'TEXT'), true, 'text under a list item would continue it lazily')
  assert.equal(needsBlankBetween('## H', 'TEXT'), false)
  assert.equal(needsBlankBetween('TEXT', '## H'), false)
  assert.equal(needsBlankBetween('TEXT', ''), false)
  for (const start of [2, 3, 10]) {
    const source = fromInternal(`ALPHA\n\n${start}. ITEM`)
    assert.equal(source, `ALPHA\n\n${start}. ITEM`)
    assert.match(new MarkdownIt().render(toInternal(source)), new RegExp(`<ol start="${start}">`))
  }
})

test('local source anchors use exact serialized block bytes, including true empty rows', () => {
  assert.deepEqual(exactSerializedBlockLines('ALPHA\nOMEGA', ['ALPHA', 'OMEGA']), [[0, 0], [1, 1]])
  assert.deepEqual(exactSerializedBlockLines('\nALPHA', ['', 'ALPHA']), [[0, 0], [1, 1]])
  assert.deepEqual(exactSerializedBlockLines('A\nB\n**C**', ['A\nB', '**C**']), [[0, 1], [2, 2]])
  assert.equal(exactSerializedBlockLines('A\nB', ['A', 'C']), null)
  assert.equal(exactSerializedBlockLines('A\n\nB', ['A', 'B']), null, 'a boundary line is nobody\'s: pair by parse instead')
  assert.equal(exactSerializedBlockLines('', []), null)
})

test('a thousand ordinary editor paragraphs read back as a thousand paragraphs with no blank rows', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => `ROW_${i}`)
  const source = fromInternal(rows.join('\n\n'))
  assert.equal(source, rows.join('\n\n'))
  assert.equal(visibleBlankRows(source), 0)
  assert.equal(paragraphs(source), 1000)
  assert.equal(fromInternal(toInternal(source)), source)
})

test('row invariants are required by the ordinary test command and both Windows release gates', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(pkg.scripts.test, /npm run test:rows/)
  assert.match(pkg.scripts['test:rows'], /paragraph-row-consistency\.test\.mjs/)
  for (const workflow of ['release.yml', 'release-preflight.yml']) {
    const source = await readFile(new URL(`../.github/workflows/${workflow}`, import.meta.url), 'utf8')
    const definition = parseYaml(source)
    const steps = Object.values(definition.jobs).flatMap(job => job.steps || [])
    assert.ok(steps.some(step => /npm run test:rows/.test(step.run || '')), `${workflow}: executable unit gate is missing`)
    assert.ok(steps.some(step => /--test-name-pattern="native ordinary paragraph rows" scripts\/rich-editor-native\.e2e\.test\.mjs/.test(step.run || '') && /exit \$LASTEXITCODE/.test(step.run)), `${workflow}: fail-closed native gate is missing`)
  }
})
