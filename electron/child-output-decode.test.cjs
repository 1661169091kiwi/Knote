'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { decodeChildLineBytes, createChildLineDecoder } = require('./child-output-decode.cjs')

test('decodes UTF-8 and falls back to GBK per line', () => {
  assert.equal(decodeChildLineBytes(Buffer.from('KNOTE_MODELS_READY', 'utf8')), 'KNOTE_MODELS_READY')
  assert.equal(decodeChildLineBytes(Buffer.from('模型已就绪', 'utf8')), '模型已就绪')
  // GBK bytes for 模型 (C4 A3 D0 CD) are invalid UTF-8 → GBK fallback
  assert.equal(decodeChildLineBytes(Buffer.from([0xC4, 0xA3, 0xD0, 0xCD])), '模型')
})

test('stream decoder handles chunk-split multibyte characters and mixed lines', () => {
  const dec = createChildLineDecoder()
  const utf8Line = Buffer.from('安装完成\n', 'utf8')
  const gbkLine = Buffer.from([0xC4, 0xA3, 0xD0, 0xCD, 0xD2, 0xD1, 0xBE, 0xCD, 0xD0, 0xF7, 0x0A]) // 模型已就绪\n in GBK
  const combined = Buffer.concat([utf8Line, gbkLine])
  // feed byte-by-byte to prove chunk boundaries never corrupt multibyte chars
  const out = []
  for (const byte of combined) out.push(...dec.take(Buffer.from([byte])))
  out.push(...dec.flush())
  assert.deepEqual(out, ['安装完成', '模型已就绪'])
})

test('flush returns a trailing partial line', () => {
  const dec = createChildLineDecoder()
  assert.deepEqual(dec.take(Buffer.from('no newline', 'utf8')), [])
  assert.deepEqual(dec.flush(), ['no newline'])
  assert.deepEqual(dec.flush(), [])
})
