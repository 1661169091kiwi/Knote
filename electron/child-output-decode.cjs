// child-output-decode.cjs — decode pip/python child-process output that may
// mix encodings. Our own Python prints UTF-8 (PYTHONUTF8), but PaddleOCR's
// C++/glog and locale-bound components write the SYSTEM codepage (GBK on
// Chinese Windows). Decode per line: strict UTF-8 first, GBK fallback.
// Splitting raw bytes on 0x0A is safe: neither UTF-8 nor GBK uses 0x0A as a
// trail byte, so a newline byte can never sit inside a multibyte character.
'use strict'

const utf8Strict = () => new TextDecoder('utf-8', { fatal: true })
const gbk = new TextDecoder('gbk')

const decodeChildLineBytes = (bytes) => {
  try { return utf8Strict().decode(bytes) } catch { return gbk.decode(bytes) }
}

// Incremental splitter for stream chunks: emits complete lines only, keeping
// the partial tail for the next chunk. flush() returns the final partial line.
const createChildLineDecoder = () => {
  let pending = Buffer.alloc(0)
  const take = (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    const lines = []
    let start = 0
    for (let i = 0; i < pending.length; i++) {
      if (pending[i] === 0x0A) {
        lines.push(decodeChildLineBytes(pending.subarray(start, i)))
        start = i + 1
      }
    }
    pending = pending.subarray(start)
    return lines
  }
  const flush = () => {
    if (!pending.length) return []
    const rest = pending
    pending = Buffer.alloc(0)
    return [decodeChildLineBytes(rest)]
  }
  return { take, flush }
}

module.exports = { decodeChildLineBytes, createChildLineDecoder }
