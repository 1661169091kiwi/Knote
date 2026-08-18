import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  canonicalWebSearchUrl,
  fuseWebSearchResults,
  runMultiEngineWebSearch
} from '../src/lib/webSearch.js'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('canonical URLs remove tracking and deterministic fusion merges snippets and provenance', () => {
  assert.equal(canonicalWebSearchUrl('https://EXAMPLE.com/report/?utm_source=x&b=2&a=1#part'), 'https://example.com/report?a=1&b=2')
  const fused = fuseWebSearchResults([
    { engine: 'bing', source: 'bing', results: [
      { title: 'Shared', url: 'https://example.com/paper?utm_source=bing', snippet: 'Bing text' },
      { title: 'B only', url: 'https://b.example/item', snippet: '' }
    ] },
    { engine: 'duckduckgo', source: 'jina-duckduckgo', results: [
      { title: 'Shared alternate', url: 'https://example.com/paper#top', snippet: 'DDG text' }
    ] }
  ], 8)
  assert.equal(fused.length, 2)
  assert.equal(fused[0].url, 'https://example.com/paper')
  assert.equal(fused[0].snippet, 'Bing text / DDG text')
  assert.deepEqual(fused[0].provenance, [
    { engine: 'bing', source: 'bing', rank: 1 },
    { engine: 'duckduckgo', source: 'jina-duckduckgo', rank: 1 }
  ])
  assert.equal(Object.hasOwn(fused[0], 'snippets'), false)
  assert.ok(fused[0].score > fused[1].score)
})

test('executor rejects disabled and unavailable concrete engines before I/O', async () => {
  let calls = 0
  const execute = async () => { calls += 1; return { ok: true, results: [] } }
  const disabled = await runMultiEngineWebSearch({
    query: 'test', engine: 'mojeek', enabledEngines: ['bing'], executableEngines: ['bing', 'mojeek'], execute
  })
  assert.equal(disabled.code, 'SEARCH_ENGINE_DISABLED')
  const unavailable = await runMultiEngineWebSearch({
    query: 'test', engine: 'bing', enabledEngines: ['bing'], executableEngines: ['duckduckgo'], execute
  })
  assert.equal(unavailable.code, 'SEARCH_ENGINE_UNAVAILABLE')
  assert.equal(calls, 0)
})

test('aggregation preserves a custom caller abort reason and performs no source I/O', async () => {
  const controller = new AbortController()
  const reason = new Error('stop aggregate search')
  let calls = 0
  controller.abort(reason)

  await assert.rejects(runMultiEngineWebSearch({
    query: 'cancelled',
    engine: 'duckduckgo',
    enabledEngines: ['duckduckgo'],
    executableEngines: ['duckduckgo'],
    signal: controller.signal,
    execute: async () => { calls += 1 }
  }), (error) => error === reason)
  assert.equal(calls, 0)
})

test('active aggregation preserves a custom caller abort reason instead of recording a source failure', async () => {
  const controller = new AbortController()
  const reason = new Error('stop active aggregate search')
  let resolveStarted
  const started = new Promise((resolve) => { resolveStarted = resolve })
  const pending = runMultiEngineWebSearch({
    query: 'active cancellation',
    engine: 'duckduckgo',
    enabledEngines: ['duckduckgo'],
    executableEngines: ['duckduckgo'],
    signal: controller.signal,
    execute: async (_engine, options) => new Promise((resolve, reject) => {
      resolveStarted()
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
  })
  await started
  controller.abort(reason)

  await assert.rejects(pending, (error) => error === reason)
})

test('a concrete request never invokes another engine', async () => {
  const calls = []
  const result = await runMultiEngineWebSearch({
    query: 'fixed',
    engine: 'bing',
    enabledEngines: ['bing', 'duckduckgo'],
    executableEngines: ['bing', 'duckduckgo'],
    execute: async (engine) => {
      calls.push(engine)
      return { ok: true, engine, results: [{ title: 'One', url: 'https://example.com/one' }] }
    }
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['bing'])
})

test('all fans out every enabled executable engine and returns partial success', async () => {
  const calls = []
  const result = await runMultiEngineWebSearch({
    query: 'multi',
    engine: 'all',
    enabledEngines: ['bing', 'duckduckgo', 'mojeek'],
    executableEngines: ['bing', 'duckduckgo'],
    execute: async (engine) => {
      calls.push(engine)
      if (engine === 'duckduckgo') {
        const error = new Error('limited')
        error.code = 'RATE_LIMITED'
        error.status = 429
        throw error
      }
      return { ok: true, engine, results: [{ title: 'Bing', url: 'https://example.com/result' }] }
    }
  })
  assert.deepEqual(calls, ['bing', 'duckduckgo'])
  assert.equal(result.ok, true)
  assert.equal(result.partial, true)
  assert.deepEqual(result.engines, ['bing'])
  assert.equal(result.failures[0].status, 429)
  assert.equal(result.results.length, 1)
})

test('all never executes a disabled engine even when the runtime can execute it', async () => {
  const calls = []
  const result = await runMultiEngineWebSearch({
    query: 'authorized only',
    engine: 'all',
    enabledEngines: ['bing'],
    executableEngines: ['bing', 'duckduckgo', 'mojeek'],
    execute: async (engine) => {
      calls.push(engine)
      return { ok: true, engine, results: [{ title: engine, url: `https://${engine}.example/result` }] }
    }
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['bing'])
  assert.deepEqual(result.engines, ['bing'])
})

test('aggregation order is independent of source completion order', async () => {
  const aggregate = async (completionOrder) => {
    const gates = Object.fromEntries(['bing', 'duckduckgo', 'mojeek'].map((engine) => [engine, deferred()]))
    const pending = runMultiEngineWebSearch({
      query: 'deterministic',
      engine: 'all',
      enabledEngines: ['mojeek', 'duckduckgo', 'bing'],
      executableEngines: ['mojeek', 'duckduckgo', 'bing'],
      execute: (engine) => gates[engine].promise
    })
    for (const engine of completionOrder) {
      gates[engine].resolve({
        ok: true,
        engine,
        results: [
          { title: 'Shared', url: 'https://example.com/shared', snippet: `${engine} text` },
          { title: engine, url: `https://${engine}.example/item` }
        ]
      })
    }
    return pending
  }
  const forward = await aggregate(['bing', 'duckduckgo', 'mojeek'])
  const reverse = await aggregate(['mojeek', 'duckduckgo', 'bing'])
  assert.deepEqual(reverse, forward)
  assert.deepEqual(forward.engines, ['bing', 'duckduckgo', 'mojeek'])
  assert.deepEqual(forward.results[0].provenance.map((item) => item.engine), ['bing', 'duckduckgo', 'mojeek'])
  assert.equal(forward.results.every((item) => !Object.hasOwn(item, 'snippets')), true)
})

test('engine mismatch is rejected rather than silently substituted', async () => {
  const result = await runMultiEngineWebSearch({
    query: 'mismatch', engine: 'bing', enabledEngines: ['bing'], executableEngines: ['bing'],
    execute: async () => ({ ok: true, engine: 'mojeek', results: [{ title: 'Wrong', url: 'https://example.com' }] })
  })
  assert.equal(result.ok, false)
  assert.equal(result.failures[0].code, 'SEARCH_ENGINE_MISMATCH')
})

test('native paths expose only bounded rate fields, never raw response headers or bodies', () => {
  const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8')
  const android = fs.readFileSync(new URL('../src/lib/safFs.js', import.meta.url), 'utf8')
  const sanitizer = main.slice(main.indexOf('const sanitizedWebRateMetadata ='), main.indexOf('const resolvePublicHost ='))
  assert.match(sanitizer, /retryAfterMs/)
  assert.match(sanitizer, /remaining/)
  assert.doesNotMatch(sanitizer, /body|buffer|res\.headers/)
  assert.match(android, /retryAfterMs: Math\.min\(120_000/)
  assert.doesNotMatch(android.slice(android.indexOf('export const nativeAndroidWebSearch')), /headers:/)
})
