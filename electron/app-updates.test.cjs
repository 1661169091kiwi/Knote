'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createAppUpdateService, newerVersion, selectRelease } = require('./app-updates.cjs')
const bytes = Buffer.from('Knote update test payload\n'.repeat(10000))
const release = (data = bytes) => ({ tag_name: 'v1.1.81', draft: false, prerelease: false, assets: [{ name: 'Knote-Setup-1.1.81.exe', size: data.length, digest: `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`, browser_download_url: 'https://github.com/1661169091kiwi/Knote/releases/download/v1.1.81/Knote-Setup-1.1.81.exe' }] })
const fixture = (t, options = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knote-update-test-'))
  const service = createAppUpdateService({ currentVersion: '1.1.80', platform: 'win32', directory, ...options })
  t.after(async () => { await service.dispose(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { service, directory }
}
test('update versions compare numerically and exclude draft/prerelease/missing packages', () => {
  assert.equal(newerVersion('v1.1.10', '1.1.9'), true)
  assert.equal(newerVersion('v1.1.80', '1.1.80'), false)
  assert.equal(newerVersion('v1.1.81-beta', '1.1.80'), false)
  assert.equal(selectRelease({ ...release(), draft: true }, '1.1.80', 'win32'), null)
  assert.equal(selectRelease({ ...release(), prerelease: true }, '1.1.80', 'win32'), null)
  assert.throws(() => selectRelease(release(), '1.1.80', 'linux'), /platform/)
})
test('an executable update requires the exact official URL, size and SHA-256', () => {
  assert.equal(selectRelease(release(), '1.1.80', 'win32').version, '1.1.81')
  const bad = release(); bad.assets[0].browser_download_url = 'https://example.com/evil.exe'
  assert.throws(() => selectRelease(bad, '1.1.80', 'win32'), /URL/)
  const missing = release(); delete missing.assets[0].digest
  assert.throws(() => selectRelease(missing, '1.1.80', 'win32'), /metadata/)
  assert.throws(() => createAppUpdateService({ directory: '.', currentVersion: '1.1.80', fetch: () => {}, apiUrl: 'http://127.0.0.1/latest' }), /API/)
})
test('automatic startup checking is enabled by default and only runs once', async (t) => {
  let calls = 0
  const { service } = fixture(t, { fetch: async () => { calls++; return Response.json(release()) } })
  service.start(); service.start()
  await service.check()
  assert.equal(calls, 1)
  assert.equal(service.snapshot().phase, 'available')
})
test('disabled automatic checking persists and prevents requests on a later launch', async (t) => {
  const { service, directory } = fixture(t, { fetch: () => { throw new Error('must not run') } })
  service.setAutoCheck(false)
  const reopened = createAppUpdateService({ currentVersion: '1.1.80', directory, fetch: () => { throw new Error('must not run') } })
  reopened.start()
  assert.equal(reopened.snapshot().autoCheck, false)
  assert.equal(reopened.snapshot().phase, 'idle')
  await reopened.dispose()
})
test('automatic network errors stay silent while explicit checks expose retry state', async (t) => {
  const { service } = fixture(t, { fetch: async () => { throw new Error('offline') } })
  await service.check({ silent: true })
  assert.equal(service.snapshot().phase, 'idle')
  assert.equal(service.snapshot().error, null)
  await service.check()
  assert.equal(service.snapshot().phase, 'error')
  assert.match(service.snapshot().error, /offline/)
})
test('a stalled update check is aborted and remains retryable', async (t) => {
  const { service } = fixture(t, { checkTimeoutMs: 30, fetch: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) })
  await service.check({ silent: true })
  assert.equal(service.snapshot().phase, 'idle')
  await service.check()
  assert.match(service.snapshot().error, /timed out/)
})
test('downloads stream to disk, report progress, verify content and share one request', async (t) => {
  let calls = 0; const progress = []
  const { service } = fixture(t, { onState: (state) => { if (state.phase === 'downloading') progress.push(state.received) }, fetch: async (url) => {
    calls++
    if (url.includes('api.github.com')) return Response.json(release())
    return new Response(new ReadableStream({ start(controller) { for (let at = 0; at < bytes.length; at += 4096) controller.enqueue(bytes.subarray(at, at + 4096)); controller.close() } }), { headers: { 'content-length': String(bytes.length) } })
  } })
  await service.check()
  const a = service.download(), b = service.download()
  assert.equal(a, b)
  await a
  assert.equal(calls, 2)
  assert.equal(service.snapshot().phase, 'downloaded')
  assert.deepEqual(fs.readFileSync(service.downloadedPath()), bytes)
  assert.ok(progress.includes(0) && progress.includes(bytes.length))
  await service.download()
  assert.equal(calls, 2)
})
test('failed digest checks never expose an installer and remove the staging file', async (t) => {
  const { service, directory } = fixture(t, { fetch: async (url) => url.includes('api.github.com') ? Response.json(release()) : new Response(Buffer.alloc(bytes.length)) })
  await service.check(); await service.download()
  assert.equal(service.snapshot().phase, 'error')
  assert.match(service.snapshot().error, /verification/)
  assert.equal(service.downloadedPath(), null)
  assert.deepEqual(fs.readdirSync(directory), [])
})
test('truncated and oversized package bodies fail before publication', async (t) => {
  for (const length of [bytes.length - 1, bytes.length + 1]) {
    const { service } = fixture(t, { fetch: async (url) => url.includes('api.github.com') ? Response.json(release()) : new Response(Buffer.alloc(length)) })
    await service.check(); await service.download()
    assert.equal(service.snapshot().phase, 'error')
    assert.equal(service.downloadedPath(), null)
  }
})
test('quit cancels an in-flight download and reclaims its partial file', async (t) => {
  const { service, directory } = fixture(t, { fetch: async (url, { signal }) => {
    if (url.includes('api.github.com')) return Response.json(release())
    return new Promise((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  } })
  await service.check()
  const download = service.download()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await service.dispose(); await download
  assert.equal(service.downloadedPath(), null)
  assert.deepEqual(fs.readdirSync(directory), [])
})
