import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createProviderTransport } from '../src/lib/agentProviderTransport.js'
import { isTransientAgentProviderError } from '../src/lib/agentProviderRetry.js'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const request = (signal) => ({
  method: 'POST',
  headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
  signal
})

test('Android uses native transport first and preserves bounded provider HTTP errors', async () => {
  let rendererCalls = 0
  const nativeCalls = []
  const transport = createProviderTransport({
    android: () => true,
    fetchImpl: async () => { rendererCalls += 1; throw new TypeError('must not fetch') },
    nativeRequest: async (options) => {
      nativeCalls.push(options)
      return {
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: { type: 'rate_limit_error', message: 'bounded' } })
      }
    }
  })
  const response = await transport('https://provider.example/v1/chat/completions', request())
  assert.equal(rendererCalls, 0)
  assert.equal(nativeCalls.length, 1)
  assert.equal(response.status, 429)
  assert.deepEqual(await response.json(), { error: { type: 'rate_limit_error', message: 'bounded' } })
})

test('Android sends one bounded non-streaming native POST without renderer replay', async () => {
  let rendererCalls = 0
  const nativeCalls = []
  const transport = createProviderTransport({
    android: () => true,
    fetchImpl: async () => { rendererCalls += 1; throw new TypeError('must not fetch') },
    nativeRequest: async (options) => {
      nativeCalls.push(options)
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] })
      }
    }
  })
  const response = await transport('https://provider.example/v1/chat/completions', request())
  assert.equal(rendererCalls, 0)
  assert.equal(nativeCalls.length, 1)
  assert.equal(nativeCalls[0].method, 'POST')
  assert.equal(nativeCalls[0].connectTimeout, 15000)
  assert.equal(nativeCalls[0].readTimeout, 120000)
  assert.match(nativeCalls[0].requestId, /^[A-Za-z0-9_-]{16,128}$/)
  assert.equal(JSON.parse(nativeCalls[0].body).stream, false)
  assert.equal((await response.json()).choices[0].message.content, 'ok')
})

test('browser and desktop remain fetch-first and CORS-bound', async () => {
  let nativeCalls = 0
  let rendererCalls = 0
  const browser = createProviderTransport({
    android: () => false,
    fetchImpl: async () => { rendererCalls += 1; throw new TypeError('Failed to fetch') },
    nativeRequest: async () => { nativeCalls += 1 }
  })
  await assert.rejects(browser('https://provider.example', request()), TypeError)
  assert.equal(rendererCalls, 1)
  assert.equal(nativeCalls, 0)
})

test('native transport is JSON POST-only and ignores any raw response header object', async () => {
  let nativeCalls = 0
  const transport = createProviderTransport({
    android: () => true,
    fetchImpl: async () => assert.fail('Android must not fetch'),
    nativeRequest: async () => {
      nativeCalls += 1
      return {
        status: 400,
        contentType: 'application/json',
        body: '{"error":"bounded"}',
        headers: { 'content-type': 'text/event-stream', 'x-secret': 'must-not-cross' }
      }
    }
  })
  await assert.rejects(
    transport('https://provider.example', { ...request(), method: 'GET' }),
    (error) => error.code === 'PROVIDER_INVALID_INPUT' && error.retryable === false
  )
  assert.equal(nativeCalls, 0)

  const response = await transport('https://provider.example', request())
  assert.equal(response.status, 400)
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.equal(response.headers.has('x-secret'), false)
  assert.deepEqual(await response.json(), { error: 'bounded' })
  assert.equal(nativeCalls, 1)
})

test('signals are checked before and after the buffered native request', async () => {
  const before = new AbortController()
  before.abort()
  let nativeCalls = 0
  const transport = createProviderTransport({
    android: () => true,
    fetchImpl: async () => { throw new TypeError('Failed to fetch') },
    nativeRequest: async () => { nativeCalls += 1; return { status: 200, contentType: 'application/json', body: '{}' } }
  })
  await assert.rejects(transport('https://provider.example', request(before.signal)), { name: 'AbortError' })
  assert.equal(nativeCalls, 0)

  const after = new AbortController()
  const cancelled = []
  const afterTransport = createProviderTransport({
    android: () => true,
    fetchImpl: async () => { throw new TypeError('Failed to fetch') },
    nativeRequest: async () => { after.abort(); return { status: 200, contentType: 'application/json', body: '{}' } },
    nativeCancel: async (options) => { cancelled.push(options) }
  })
  await assert.rejects(afterTransport('https://provider.example', request(after.signal)), { name: 'AbortError' })
  assert.equal(cancelled.length, 1)
  assert.match(cancelled[0].requestId, /^[A-Za-z0-9_-]{16,128}$/)
})

test('an abort promptly cancels only its request while another native request completes', async () => {
  const firstController = new AbortController()
  const firstStarted = deferred()
  const nativeRequests = new Map()
  const cancellations = []
  const transport = createProviderTransport({
    android: () => true,
    fetchImpl: async () => { throw new TypeError('Failed to fetch') },
    nativeRequest: (options) => {
      const pending = deferred()
      nativeRequests.set(options.requestId, pending)
      if (nativeRequests.size === 1) firstStarted.resolve(options.requestId)
      return pending.promise
    },
    nativeCancel: async (options) => { cancellations.push(options.requestId) }
  })
  const first = transport('https://provider.example/first', request(firstController.signal))
  const second = transport('https://provider.example/second', request())
  const firstRequestId = await firstStarted.promise
  while (nativeRequests.size < 2) await new Promise((resolve) => setImmediate(resolve))
  const secondRequestId = [...nativeRequests.keys()].find((id) => id !== firstRequestId)

  firstController.abort()
  const observed = first.then(
    () => 'resolved',
    (error) => error.name
  )
  const outcome = await Promise.race([
    observed,
    new Promise((resolve) => setImmediate(() => resolve('still-pending')))
  ])
  assert.equal(outcome, 'AbortError')
  assert.deepEqual(cancellations, [firstRequestId])

  nativeRequests.get(secondRequestId).resolve({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  assert.deepEqual(await (await second).json(), { ok: true })
  nativeRequests.get(firstRequestId).resolve({ status: 200, contentType: 'application/json', body: '{}' })
})

test('native JSON request and response buffers have stable nonretryable size errors', async () => {
  let nativeCalls = 0
  const oversizedRequest = createProviderTransport({
    android: () => true,
    maxBufferedBytes: 128,
    fetchImpl: async () => { throw new TypeError('Failed to fetch') },
    nativeRequest: async () => { nativeCalls += 1 }
  })
  await assert.rejects(
    oversizedRequest('https://provider.example', {
      ...request(),
      body: JSON.stringify({ payload: 'x'.repeat(256) })
    }),
    (error) => error.code === 'PROVIDER_REQUEST_TOO_LARGE' && error.retryable === false
  )
  assert.equal(nativeCalls, 0)

  const oversizedResponse = createProviderTransport({
    android: () => true,
    maxBufferedBytes: 128,
    fetchImpl: async () => { throw new TypeError('Failed to fetch') },
    nativeRequest: async () => {
      nativeCalls += 1
      return { status: 200, contentType: 'application/json', body: JSON.stringify({ payload: 'x'.repeat(256) }) }
    }
  })
  await assert.rejects(
    oversizedResponse('https://provider.example', request()),
    (error) => error.code === 'PROVIDER_RESPONSE_TOO_LARGE' && error.retryable === false
  )
  assert.equal(nativeCalls, 1)
})

test('native provider errors retain stable codes and authoritative retryability', async () => {
  const expectations = new Map([
    ['PROVIDER_CANCELLED', false],
    ['PROVIDER_TIMEOUT', true],
    ['PROVIDER_NETWORK_ERROR', true],
    ['PROVIDER_REQUEST_TOO_LARGE', false],
    ['PROVIDER_RESPONSE_TOO_LARGE', false],
    ['PROVIDER_INVALID_RESPONSE', false],
    ['PROVIDER_INVALID_INPUT', false],
    ['PROVIDER_QUEUE_FULL', true]
  ])

  for (const [code, retryable] of expectations) {
    const transport = createProviderTransport({
      android: () => true,
      fetchImpl: async () => assert.fail('Android must not fetch'),
      nativeRequest: async () => { throw Object.assign(new Error(`native ${code}`), { code }) }
    })
    await assert.rejects(
      transport('https://provider.example', request()),
      (error) => {
        assert.equal(error.code, code)
        assert.equal(error.retryable, retryable)
        assert.equal(isTransientAgentProviderError(error), retryable)
        return true
      }
    )
  }

  assert.equal(
    isTransientAgentProviderError(Object.assign(new Error('native timeout'), { code: 'PROVIDER_TIMEOUT' })),
    true
  )
  assert.equal(
    isTransientAgentProviderError(Object.assign(new Error('native network'), { code: 'PROVIDER_NETWORK_ERROR' })),
    true
  )
  assert.equal(
    isTransientAgentProviderError(Object.assign(new Error('network-looking invalid response'), {
      code: 'PROVIDER_INVALID_RESPONSE'
    })),
    false
  )
})

test('malformed native bridge responses fail closed without becoming retryable', async () => {
  const transport = createProviderTransport({
    android: () => true,
    nativeRequest: async () => ({ status: 0, contentType: 'application/json', body: '{}' })
  })
  await assert.rejects(
    transport('https://provider.example', request()),
    (error) => error.code === 'PROVIDER_INVALID_RESPONSE' &&
      error.retryable === false &&
      isTransientAgentProviderError(error) === false
  )
})

test('Capacitor Android logging and WebView debugging are statically disabled', () => {
  const config = JSON.parse(readFileSync(new URL('../capacitor.config.json', import.meta.url), 'utf8'))
  assert.equal(config.android?.loggingBehavior, 'none')
  assert.equal(config.android?.webContentsDebuggingEnabled, false)
})
