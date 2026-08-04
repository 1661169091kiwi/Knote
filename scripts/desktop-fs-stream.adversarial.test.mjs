import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDesktopTextFile } from '../src/lib/desktopFs.js'

const here = path.dirname(fileURLToPath(import.meta.url))

test('586 KB-class UTF-8 files cross IPC in bounded chunks without corrupting split code points', async () => {
  const source = ('Markdown unicode \u{1F95D}\n'.repeat(24_000)) + '**tail**'
  const encoded = new TextEncoder().encode(source)
  assert.ok(encoded.length > 500_000 && encoded.length < 1_000_000)
  let fullReads = 0
  let chunkReads = 0
  globalThis.window = {
    knoteDesktop: {
      fsStat: async () => ({ ok: true, size: encoded.length, mtimeMs: 123 }),
      fsRead: async () => { fullReads += 1; return source },
      fsReadChunk: async (_path, offset, length, expected) => {
        assert.equal(expected.size, encoded.length)
        assert.equal(expected.mtimeMs, 123)
        chunkReads += 1
        const bytes = encoded.slice(offset, Math.min(encoded.length, offset + length))
        return {
          bytes,
          bytesRead: bytes.length,
          size: encoded.length,
          mtimeMs: 123,
          done: offset + bytes.length >= encoded.length
        }
      }
    }
  }
  try {
    assert.equal(await readDesktopTextFile('D:/notes/huge.md'), source)
    assert.equal(fullReads, 0)
    assert.ok(chunkReads > 1)
  } finally {
    delete globalThis.window
  }
})

test('small files keep the low-overhead one-shot path', async () => {
  let chunks = 0
  globalThis.window = {
    knoteDesktop: {
      fsStat: async () => ({ ok: true, size: 12, mtimeMs: 1 }),
      fsRead: async () => 'small text',
      fsReadChunk: async () => { chunks += 1; throw new Error('unexpected') }
    }
  }
  try {
    assert.equal(await readDesktopTextFile('D:/notes/small.md'), 'small text')
    assert.equal(chunks, 0)
  } finally {
    delete globalThis.window
  }
})

test('desktop open payloads avoid eager full reads for large documents', () => {
  const main = fs.readFileSync(path.join(here, '..', 'electron', 'main.cjs'), 'utf8')
  const preload = fs.readFileSync(path.join(here, '..', 'electron', 'preload.cjs'), 'utf8')
  const app = fs.readFileSync(path.join(here, '..', 'src', 'App.vue'), 'utf8')
  assert.match(main, /const PROGRESSIVE_TEXT_THRESHOLD\s*=\s*384\s*\*\s*1024/)
  assert.match(main, /progressive\s*=\s*stat\.size\s*>=\s*PROGRESSIVE_TEXT_THRESHOLD/)
  assert.match(fs.readFileSync(path.join(here, '..', 'src', 'lib', 'desktopFs.js'), 'utf8'), /const PROGRESSIVE_TEXT_THRESHOLD\s*=\s*384\s*\*\s*1024/)
  assert.match(main, /data\s*=\s*progressive\s*\?\s*null/)
  assert.match(main, /knote:fs-read-chunk/)
  assert.match(preload, /fsReadChunk/)
  assert.match(app, /readDesktopTextFile\(p,\s*\{\s*ok:\s*true,\s*size,\s*mtimeMs\s*\}\)/)
})

test('exact single-file writable grants also authorize later text re-reads', () => {
  const main = fs.readFileSync(path.join(here, '..', 'electron', 'main.cjs'), 'utf8')
  const start = main.indexOf("ipcMain.handle('knote:fs-read'")
  const end = main.indexOf("ipcMain.handle('knote:fs-read-chunk'", start)
  const handler = main.slice(start, end)
  assert.ok(start >= 0 && end > start)
  assert.match(handler, /existingReadOrWritablePath\(p\)/)
  assert.doesNotMatch(handler, /existingReadPath\(p\)/)
})
