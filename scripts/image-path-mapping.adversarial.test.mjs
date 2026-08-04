import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  collectImageResourcePaths,
  decodeRelativeResourcePath,
  rewriteImageResourcePaths
} from '../src/lib/imagePathMapping.js'

const appSource = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
const stripResourceTokens = (value) => String(value).replace(/(?:&|&amp;)knote-token=[^\s)"'>]+/g, '')

test('relative images survive center/right HTML serialization in both directions', () => {
  const rel = 'assets/diagram one.png'
  const data = 'data:image/png;base64,AAABBB=='
  const source = [
    `<img src="${rel}" alt="center" style="display:block;margin-left:auto;margin-right:auto;">`,
    `<img src='${rel}' alt="right" style="display:block;margin-left:auto;">`
  ].join('\n')
  const displayed = rewriteImageResourcePaths(source, [[rel, data]])
  assert.equal((displayed.match(/#knote-resource=assets%2Fdiagram%20one\.png/g) || []).length, 2)
  assert.match(displayed, /margin-right:auto/)
  assert.match(displayed, /margin-left:auto/)
  assert.equal(rewriteImageResourcePaths(displayed, [[data, rel]]), source)
})

test('ordinary Markdown images and title-bearing images are mapped', () => {
  const source = '![a](assets/a.png)\n![b](assets/a.png "caption")\n![space](<assets/a.png>)'
  const displayed = rewriteImageResourcePaths(source, { 'assets/a.png': 'data:image/png;base64,AAAA' })
  assert.equal((displayed.match(/#knote-resource=assets%2Fa\.png&knote-token=/g) || []).length, 3)
  assert.equal(rewriteImageResourcePaths(displayed, []), source)
})

test('matching prose, code and non-image HTML attributes remain untouched', () => {
  const source = [
    'assets/a.png',
    '`assets/a.png`',
    '`![inline](assets/a.png)`',
    '```md',
    '![fenced](assets/a.png)',
    '<img src="assets/a.png">',
    '```',
    '<a href="assets/a.png">download</a>',
    '<img data-source="assets/a.png" src="assets/a.png">'
  ].join('\n')
  const out = rewriteImageResourcePaths(source, [['assets/a.png', 'RESOLVED']])
  assert.equal(out, [
    'assets/a.png',
    '`assets/a.png`',
    '`![inline](assets/a.png)`',
    '```md',
    '![fenced](assets/a.png)',
    '<img src="assets/a.png">',
    '```',
    '<a href="assets/a.png">download</a>',
    '<img data-source="assets/a.png" src="RESOLVED">'
  ].join('\n'))
})

test('unquoted imported img sources are supported without rewriting longer paths partially', () => {
  const source = '<img src=assets/a-long.png> <img src=assets/a.png>'
  const out = rewriteImageResourcePaths(source, [
    ['assets/a.png', 'SHORT'],
    ['assets/a-long.png', 'LONG']
  ])
  assert.equal(out, '<img src="LONG"> <img src="SHORT">')
})

test('aligned HTML images are rediscovered after the in-memory cache is cleared', () => {
  const source = [
    '<img src="assets/center.png" style="display:block;margin:auto">',
    "<img src='assets/right one.png' style='display:block;margin-left:auto'>",
    '![ordinary](assets/ordinary.png)',
    '`![example](assets/not-an-image.png)`',
    '```html',
    '<img src="assets/not-an-image-2.png">',
    '```'
  ].join('\n')
  assert.deepEqual(collectImageResourcePaths(source), [
    'assets/center.png',
    'assets/right one.png',
    'assets/ordinary.png'
  ])
})

test('replacement strings containing dollar tokens are copied literally', () => {
  const source = '![x](assets/x.png) <img src="assets/x.png">'
  assert.equal(
    stripResourceTokens(rewriteImageResourcePaths(source, [['assets/x.png', 'data:image/png;base64,$&$1']])),
    '![x](data:image/png;base64,$&$1#knote-resource=assets%2Fx.png) <img src="data:image/png;base64,$&amp;$1#knote-resource=assets%2Fx.png">'
  )
})

test('equal-byte local images stay distinct and a genuine embedded image is never aliased', () => {
  const data = 'data:image/png;base64,SAME=='
  const source = [
    '![one](one.png)',
    '![two](two.png)',
    `![embedded](${data})`
  ].join('\n')
  const displayed = rewriteImageResourcePaths(source, [['one.png', data], ['two.png', data]])
  assert.match(displayed, /SAME==#knote-resource=one\.png/)
  assert.match(displayed, /SAME==#knote-resource=two\.png/)
  assert.match(displayed, new RegExp(`!\\[embedded\\]\\(${data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`))
  assert.equal(
    rewriteImageResourcePaths(displayed, [[data, 'one.png'], [data, 'two.png']]),
    source
  )
})

test('HTML entities and balanced Markdown destinations are mapped exactly', () => {
  const dataA = 'data:image/png;base64,A'
  const dataB = 'data:image/png;base64,B'
  const source = '<img src="assets/a&amp;b.png">\n![paren](assets/a(b).png "title")'
  const displayed = rewriteImageResourcePaths(source, [
    ['assets/a&b.png', dataA],
    ['assets/a(b).png', dataB]
  ])
  const stable = stripResourceTokens(displayed)
  assert.match(stable, /src="data:image\/png;base64,A#knote-resource=assets%2Fa%26b\.png"/)
  assert.match(stable, /B#knote-resource=assets%2Fa\(b\)\.png "title"/)
  assert.deepEqual(collectImageResourcePaths(source), ['assets/a&b.png', 'assets/a(b).png'])
})

test('encoded image paths are decoded only after traversal and scheme validation', () => {
  assert.deepEqual(decodeRelativeResourcePath('assets/diagram%20one.png'), ['assets', 'diagram one.png'])
  for (const path of [
    'assets/%2e%2e/secret.png',
    'assets/%252e%252e%252fsecret.png',
    'assets%2f..%2fsecret.png',
    'file%3A%2F%2Fsecret.png',
    'C%3A%5Csecret.png',
    'assets/%00secret.png'
  ]) {
    assert.equal(decodeRelativeResourcePath(path), null, path)
  }
  const source = '![safe](assets/ok.png)\n![escape](assets/%2e%2e/secret.png)'
  assert.deepEqual(collectImageResourcePaths(source), ['assets/ok.png'])
})

test('only generated data URLs can carry local-resource provenance', () => {
  const forged = 'https://example.invalid/image.png#knote-resource=assets%2Flocal.png'
  const forgedData = 'data:image/png;base64,AAAA#knote-resource=assets%2Flocal.png&knote-token=forged'
  assert.deepEqual(collectImageResourcePaths(`![remote](${forged})`), [])
  assert.equal(rewriteImageResourcePaths(`![remote](${forged})`, []), `![remote](${forged})`)
  assert.equal(rewriteImageResourcePaths(`![embedded](${forgedData})`, []), `![embedded](${forgedData})`)

  const reverseWrapper = appSource.match(/const dataUrlsToRelPaths = \(mdText\) => \{[\s\S]*?\n\}/)?.[0] || ''
  assert.match(reverseWrapper, /return rewriteImageResourcePaths\(/)
  assert.doesNotMatch(reverseWrapper, /mappings\.length/)
})
