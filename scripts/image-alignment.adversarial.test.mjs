import test from 'node:test'
import assert from 'node:assert/strict'

import {
  inferImageAlignment,
  inferImageSizing,
  migrateLegacyImageAlign,
  scaledImageCssWidth,
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

test('natural-size scaling keeps 100 percent equal to the intrinsic baseline', () => {
  assert.equal(
    scaledImageCssWidth({ scale: 100, intrinsicWidth: 406 }),
    'min(100%,406px)'
  )
  assert.equal(
    scaledImageCssWidth({ scale: 90, intrinsicWidth: 406 }),
    'min(90%,365.4px)'
  )

  const out = serializeKnoteImage({
    src: 'image.png',
    alt: 'scaled',
    scale: 90,
    intrinsicWidth: 406,
    align: 'center'
  })
  assert.match(out, /data-knote-scale="90"/)
  assert.match(out, /data-knote-intrinsic-width="406"/)
  assert.match(out, /width:min\(90%,365\.4px\)/)
  assert.match(out, /margin-right:auto/)
  assert.doesNotMatch(out, /width:90%;/)

  assert.deepEqual(
    inferImageSizing({ scale: '90', intrinsicWidth: '406' }),
    { scale: 90, intrinsicWidth: 406 }
  )
  assert.deepEqual(
    inferImageSizing({ cssWidth: 'min(90%, 365.4px)' }),
    { scale: 90, intrinsicWidth: 406 }
  )
})

test('legacy container percentages remain byte-compatible', () => {
  const out = serializeKnoteImage({ src: 'legacy.png', alt: 'legacy', width: 60 })
  assert.match(out, /width:60%/)
  assert.doesNotMatch(out, /data-knote-scale|data-knote-intrinsic-width|width:min\(/)
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

test('image titles survive ordinary, styled and legacy serialization', () => {
  assert.equal(
    serializeKnoteImage({ src: 'image one(2).png', alt: 'a [b]', title: 'A "title"' }),
    '![a \\[b\\]](<image one(2).png> "A \\"title\\"")'
  )
  const styled = serializeKnoteImage({
    src: 'image.png',
    alt: 'plain',
    title: 'Durable & titled',
    width: 65,
    align: 'center'
  })
  assert.match(styled, /title="Durable &amp; titled"/)
  assert.match(styled, /width:65%/)
  assert.match(styled, /margin-right:auto/)
  assert.match(
    migrateLegacyImageAlign('::: align:right ::: ![plain](image.png "Legacy title")'),
    /title="Legacy title"/
  )
})

test('absolute file images use durable HTML instead of a rejected Markdown URL', () => {
  const out = serializeKnoteImage({ src: 'file:///D:/Notes/a.png', alt: 'absolute', title: 'Local' })
  assert.equal(out, '<img src="file:///D:/Notes/a.png" alt="absolute" title="Local">')
})
