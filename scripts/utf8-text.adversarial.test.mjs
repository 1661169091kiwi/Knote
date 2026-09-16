// Adversarial coverage for the editor's strict UTF-8 decode lane.
//
// Regression guard for the GBK-destruction bug: Blob.text() and
// readFile('utf8') decode with U+FFFD replacement, so a GBK/UTF-16 note
// opened through them displayed mojibake and the first auto-save wrote that
// lossy text back over the original bytes. Every editor-bound read must now
// decode strictly and raise INVALID_UTF8 instead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeUtf8Strict, readFileTextStrict, isInvalidUtf8Error, invalidUtf8Error } from '../src/lib/utf8Text.js'

// Array.prototype.flat does NOT flatten typed arrays — walk explicitly.
const bytes = (...parts) => {
  const out = []
  for (const part of parts.flat(Infinity)) {
    if (typeof part === 'number') out.push(part)
    else out.push(...part)
  }
  return new Uint8Array(out)
}
const gbkChinese = () => bytes([0xd6, 0xd0, 0xce, 0xc4]) // “中文” in GBK
const utf16LeBomChinese = () => bytes([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65])

test('valid UTF-8 roundtrips byte-exactly, including CJK, emoji and astral planes', () => {
  const source = '# 中文标题\n\nemoji \u{1F95D} \u{1F600}, astral \u{2000B}\u{2B740}, combining á\n\ttrailing spaces   '
  assert.equal(decodeUtf8Strict(new TextEncoder().encode(source)), source)
})

test('GBK bytes are rejected, never decoded into mojibake or U+FFFD', () => {
  assert.throws(() => decodeUtf8Strict(gbkChinese()), (error) => isInvalidUtf8Error(error))
  assert.throws(() => decodeUtf8Strict(bytes([[0x23, 0x20], gbkChinese(), [0x0a]])), (error) => isInvalidUtf8Error(error))
})

test('UTF-16 (BOM) and UTF-8 truncations are rejected', () => {
  assert.throws(() => decodeUtf8Strict(utf16LeBomChinese()), isInvalidUtf8Error)
  // truncated 3-byte sequence
  assert.throws(() => decodeUtf8Strict(bytes([0x41, 0xe4, 0xb8])), isInvalidUtf8Error)
  // lone surrogate encoding (CESU-8 style) is invalid UTF-8
  assert.throws(() => decodeUtf8Strict(bytes([0xed, 0xa0, 0x80])), isInvalidUtf8Error)
  // overlong NUL
  assert.throws(() => decodeUtf8Strict(bytes([0xc0, 0x80])), isInvalidUtf8Error)
})

test('a leading UTF-8 BOM is stripped like Blob.text(), not kept as content', () => {
  const withBom = bytes([[0xef, 0xbb, 0xbf], [...new TextEncoder().encode('# hi\n')]])
  assert.equal(decodeUtf8Strict(withBom), '# hi\n')
  // interior BOMs are content and must survive
  const interior = new TextEncoder().encode('a\uFEFFb')
  assert.equal(decodeUtf8Strict(interior), 'a\uFEFFb')
})

test('an empty file decodes to empty text', () => {
  assert.equal(decodeUtf8Strict(new Uint8Array(0)), '')
})

test('readFileTextStrict rejects File blobs with invalid UTF-8 and carries the file name', async () => {
  const bad = new File([gbkChinese()], '旧笔记.md', { type: 'text/markdown' })
  await assert.rejects(() => readFileTextStrict(bad, '旧笔记.md'), (error) => {
    assert.equal(isInvalidUtf8Error(error), true)
    assert.match(error.message, /旧笔记\.md/)
    return true
  })
  const good = new File([new TextEncoder().encode('你好\n')], 'ok.md')
  assert.equal(await readFileTextStrict(good), '你好\n')
})

test('desktop { name, text() } handle shims are read through text(), not arrayBuffer', async () => {
  // mkDesktopFileHandle.getFile() returns a shim without arrayBuffer; its
  // text is already strictly decoded by readDesktopTextFile upstream.
  const shim = { name: 'a.md', text: async () => 'already strict\n' }
  assert.equal(await readFileTextStrict(shim), 'already strict\n')
})

test('error classification only accepts the coded error', () => {
  assert.equal(isInvalidUtf8Error(invalidUtf8Error('x.md')), true)
  assert.equal(isInvalidUtf8Error(new Error('file is not valid UTF-8')), false)
  assert.equal(isInvalidUtf8Error(new TypeError('The encoded data is not valid.')), false)
  assert.equal(isInvalidUtf8Error(null), false)
})
