import test from 'node:test'
import assert from 'node:assert/strict'

import {
  inferImageAlignment,
  migrateLegacyImageAlign,
  serializeKnoteImage
} from '../src/lib/imageMarkdown.js'

test('center alignment is stored on the image without a visible sentinel', () => {
  const out = serializeKnoteImage({ src: 'knote-img:a', alt: '图', align: 'center' })
  assert.doesNotMatch(out, /:::\s*align/)
  assert.match(out, /margin-left:auto/)
  assert.match(out, /margin-right:auto/)
  assert.equal(inferImageAlignment({ marginLeft: 'auto', marginRight: 'auto' }), 'center')
})

test('right alignment survives independently from center alignment', () => {
  const out = serializeKnoteImage({ src: 'knote-img:b', alt: '图', width: 60, align: 'right' })
  assert.match(out, /width:60%/)
  assert.match(out, /margin-left:auto/)
  assert.doesNotMatch(out, /margin-right:auto/)
  assert.equal(inferImageAlignment({ marginLeft: 'auto', marginRight: '' }), 'right')
})

test('legacy center and right sentinels migrate on the same or next line', () => {
  const center = migrateLegacyImageAlign('::: align:center ::: ![图](knote-img:c)')
  const right = migrateLegacyImageAlign('::: align:right :::\n![图](knote-img:r)')
  assert.doesNotMatch(center, /:::\s*align/)
  assert.doesNotMatch(right, /:::\s*align/)
  assert.match(center, /margin-right:auto/)
  assert.match(right, /margin-left:auto/)
  assert.doesNotMatch(right, /margin-right:auto/)
})

test('ordinary markdown images stay ordinary markdown', () => {
  assert.equal(serializeKnoteImage({ src: 'image.png', alt: 'plain' }), '![plain](image.png)')
  const input = '正文\n\n![plain](image.png)'
  assert.equal(migrateLegacyImageAlign(input), input)
})
