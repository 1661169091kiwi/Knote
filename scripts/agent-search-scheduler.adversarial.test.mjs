import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createAgentSearchScheduler,
  createSearchHttpError,
  parseRetryAfterMs,
  runSearchAttemptWithTimeout,
  sanitizedRateMetadata
} from '../src/lib/agentSearchScheduler.js'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('one source is FIFO with at least two seconds between starts', async () => {
  let clock = 0
  const waits = []
  const scheduler = createAgentSearchScheduler({
    now: () => clock,
    wait: async (ms) => { waits.push(ms); clock += ms },
    random: () => 0
  })
  const gate = deferred()
  const starts = []
  const first = scheduler.schedule('bing', async () => { starts.push(clock); await gate.promise; return 'first' })
  const second = scheduler.schedule('bing', async () => { starts.push(clock); return 'second' })
  await tick()
  assert.deepEqual(starts, [0])
  gate.resolve()
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.deepEqual(starts, [0, 2000])
  assert.deepEqual(waits, [2000])
})

test('different source lanes start concurrently', async () => {
  let clock = 20
  const scheduler = createAgentSearchScheduler({ now: () => clock, wait: async (ms) => { clock += ms } })
  const gate = deferred()
  const starts = []
  const one = scheduler.schedule('openalex', async () => { starts.push(['openalex', clock]); await gate.promise })
  const two = scheduler.schedule('crossref', async () => { starts.push(['crossref', clock]); await gate.promise })
  await tick()
  assert.deepEqual(starts, [['openalex', 20], ['crossref', 20]])
  gate.resolve()
  await Promise.all([one, two])
})

test('per-attempt deadlines abort the transport and remain retryable', async () => {
  let clock = 0
  const attempts = []
  const scheduler = createAgentSearchScheduler({
    now: () => clock,
    wait: async (ms) => { clock += ms },
    random: () => 0
  })
  await assert.rejects(scheduler.schedule('stalled-source', async () => {
    const attempt = { signal: null }
    attempts.push(attempt)
    return runSearchAttemptWithTimeout((signal) => {
      attempt.signal = signal
      return new Promise(() => {})
    }, { timeoutMs: 5 })
  }), (error) => (
    error.name === 'SearchTimeoutError' &&
    error.code === 'SEARCH_TIMEOUT' &&
    error.retryable === true &&
    error.network === true
  ))
  assert.equal(attempts.length, 3)
  assert.equal(attempts.every(({ signal }) => signal?.aborted), true)
})

test('completed attempts clear their deadline and caller abort listener', async () => {
  const caller = new AbortController()
  let attemptSignal
  const value = await runSearchAttemptWithTimeout(async (signal) => {
    attemptSignal = signal
    return 'complete'
  }, { signal: caller.signal, timeoutMs: 5 })
  assert.equal(value, 'complete')

  await new Promise((resolve) => setTimeout(resolve, 15))
  caller.abort()
  assert.equal(attemptSignal.aborted, false)
})

test('failed attempts abort their transport with the original error before rejecting', async () => {
  const failure = Object.assign(new Error('invalid response'), { code: 'SEARCH_RESPONSE_INVALID', retryable: false })
  let attemptSignal
  await assert.rejects(runSearchAttemptWithTimeout(async (signal) => {
    attemptSignal = signal
    throw failure
  }, { timeoutMs: 1000 }), (error) => error === failure)
  assert.equal(attemptSignal.aborted, true)
  assert.equal(attemptSignal.reason, failure)
})

test('caller cancellation aborts an active attempt without becoming a timeout', async () => {
  const caller = new AbortController()
  let attemptSignal
  const pending = runSearchAttemptWithTimeout((signal) => {
    attemptSignal = signal
    return new Promise(() => {})
  }, { signal: caller.signal, timeoutMs: 1000 })
  await tick()
  caller.abort()

  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(attemptSignal.aborted, true)
  assert.equal(attemptSignal.reason?.name, 'AbortError')
})

test('queue residence consumes the wait budget before a queued job can start', async () => {
  let clock = 0
  const gate = deferred()
  const scheduler = createAgentSearchScheduler({
    now: () => clock,
    wait: async (ms) => { clock += ms },
    maxCumulativeWaitMs: 3000
  })
  const first = scheduler.schedule('bing', async () => gate.promise)
  let secondStarts = 0
  const second = scheduler.schedule('bing', async () => { secondStarts += 1 })
  await tick()
  clock = 3001
  gate.resolve('first')
  assert.equal(await first, 'first')
  await assert.rejects(second, (error) => error.code === 'SEARCH_WAIT_LIMIT' && error.retryable === false)
  assert.equal(secondStarts, 0)
})

test('timer throttling is charged by actual elapsed time and cannot start a retry after budget', async () => {
  let clock = 0
  const waits = []
  const scheduler = createAgentSearchScheduler({
    now: () => clock,
    wait: async (ms) => { waits.push(ms); clock += 120_001 },
    random: () => 0
  })
  let attempts = 0
  await assert.rejects(scheduler.schedule('openalex', async () => {
    attempts += 1
    const error = new Error('limited')
    error.status = 429
    error.retryAfterMs = 5000
    throw error
  }), (error) => error.schedulerWaitLimit === true)
  assert.deepEqual(waits, [5000])
  assert.equal(attempts, 1)
})

test('active operation duration is excluded from cumulative scheduler wait', async () => {
  let clock = 0
  const starts = []
  const scheduler = createAgentSearchScheduler({
    now: () => clock,
    wait: async (ms) => { clock += ms },
    maxCumulativeWaitMs: 3000,
    random: () => 0
  })
  let attempts = 0
  const value = await scheduler.schedule('crossref', async () => {
    starts.push(clock)
    attempts += 1
    if (attempts === 1) {
      clock += 300_000
      const error = new Error('limited after a long request')
      error.status = 429
      error.retryAfterMs = 2000
      throw error
    }
    return 'ok'
  })
  assert.equal(value, 'ok')
  assert.deepEqual(starts, [0, 302_000])
})

test('429 Retry-After is bounded, spaced, jitter-deterministic, and capped at three attempts', async () => {
  let clock = 0
  const starts = []
  const activity = []
  const scheduler = createAgentSearchScheduler({
    now: () => clock,
    wait: async (ms) => { clock += ms },
    random: () => 0
  })
  let attempts = 0
  const value = await scheduler.schedule('duckduckgo', async () => {
    starts.push(clock)
    attempts += 1
    if (attempts < 3) {
      const error = new Error('rate limited')
      error.status = 429
      error.retryAfterMs = 5000
      throw error
    }
    return 'ok'
  }, { onActivity: (event) => activity.push(event.phase) })
  assert.equal(value, 'ok')
  assert.deepEqual(starts, [0, 5000, 10000])
  assert.equal(activity.filter((phase) => phase === 'retry').length, 2)

  const failing = createAgentSearchScheduler({ now: () => clock, wait: async (ms) => { clock += ms }, random: () => 0 })
  let failedAttempts = 0
  await assert.rejects(failing.schedule('mojeek', async () => {
    failedAttempts += 1
    const error = new TypeError('network')
    throw error
  }), TypeError)
  assert.equal(failedAttempts, 3)
})

test('long rate waits pulse activity and never exceed the cumulative wait budget', async () => {
  let clock = 0
  const waits = []
  const phases = []
  const scheduler = createAgentSearchScheduler({
    now: () => clock,
    wait: async (ms) => { waits.push(ms); clock += ms },
    random: () => 0
  })
  let attempts = 0
  await scheduler.schedule('openalex', async () => {
    attempts += 1
    if (attempts === 1) {
      const error = new Error('limited')
      error.status = 429
      error.retryAfterMs = 25_000
      throw error
    }
    return 'ok'
  }, { onActivity: (event) => phases.push(event.phase) })
  assert.deepEqual(waits, [10_000, 10_000, 5_000])
  assert.equal(phases.filter((phase) => phase === 'cooldown').length, 3)

  const bounded = createAgentSearchScheduler({
    now: () => clock,
    wait: async (ms) => { clock += ms },
    maxCumulativeWaitMs: 3000,
    random: () => 0
  })
  let boundedAttempts = 0
  await assert.rejects(bounded.schedule('crossref', async () => {
    boundedAttempts += 1
    const error = new Error('limited')
    error.status = 429
    error.retryAfterMs = 5000
    throw error
  }), (error) => error.schedulerWaitLimit === true)
  assert.equal(boundedAttempts, 1)
  assert.equal(parseRetryAfterMs('999', 0), 120_000)
})

test('Retry-After accepts real headers, HTTP dates, and the full 120 second policy window', async () => {
  const now = Date.UTC(2026, 7, 17, 12, 0, 0)
  assert.deepEqual(sanitizedRateMetadata(429, { 'rEtRy-AfTeR': '7' }, now), {
    status: 429,
    retryAfterMs: 7000
  })
  assert.equal(
    sanitizedRateMetadata(503, new Headers({ 'Retry-After': new Date(now + 12_000).toUTCString() }), now).retryAfterMs,
    12_000
  )

  let clock = 0
  const starts = []
  const scheduler = createAgentSearchScheduler({
    now: () => clock,
    wait: async (ms) => { clock += ms },
    random: () => 0
  })
  let attempts = 0
  await scheduler.schedule('openalex', async () => {
    starts.push(clock)
    attempts += 1
    if (attempts === 1) throw createSearchHttpError(429, new Headers({ 'Retry-After': '90' }))
    return 'ok'
  })
  assert.deepEqual(starts, [0, 90_000])
})

test('rate-limit reset supports relative and epoch seconds and becomes the effective retry delay', async () => {
  const now = Date.UTC(2026, 7, 17, 12, 0, 0)
  assert.deepEqual(sanitizedRateMetadata(429, new Headers({
    'X-RateLimit-Reset': '5'
  }), now), {
    status: 429,
    retryAfterMs: 5000,
    resetAt: now + 5000
  })

  const epochSeconds = (now + 45_000) / 1000
  assert.deepEqual(sanitizedRateMetadata(429, new Headers({
    'Retry-After': '2',
    'X-RateLimit-Reset': String(epochSeconds)
  }), now), {
    status: 429,
    retryAfterMs: 45_000,
    resetAt: now + 45_000
  })

  assert.deepEqual(sanitizedRateMetadata(503, new Headers({
    'Retry-After': '1',
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': '7'
  }), now), {
    status: 503,
    retryAfterMs: 7000,
    remaining: 0,
    resetAt: now + 7000
  })
  assert.equal(sanitizedRateMetadata(503, new Headers({
    'Retry-After': '1',
    'X-RateLimit-Remaining': '1',
    'X-RateLimit-Reset': '7'
  }), now).retryAfterMs, 1000)
  assert.equal(sanitizedRateMetadata(429, new Headers({ 'X-RateLimit-Reset': '300' }), now).retryAfterMs, 120_000)
  assert.deepEqual(sanitizedRateMetadata(429, new Headers({
    'X-RateLimit-Reset': String(4_102_444_801)
  }), now), { status: 429 })

  let clock = 0
  const starts = []
  const scheduler = createAgentSearchScheduler({
    now: () => clock,
    wait: async (ms) => { clock += ms },
    random: () => 0
  })
  let attempts = 0
  await scheduler.schedule('openalex-reset', async () => {
    starts.push(clock)
    attempts += 1
    if (attempts === 1) {
      throw createSearchHttpError(429, new Headers({
        'Retry-After': '1',
        'X-RateLimit-Reset': '5'
      }))
    }
    return 'ok'
  })
  assert.deepEqual(starts, [0, 5000])

  const blockedStarts = []
  const blocked = createAgentSearchScheduler({
    now: () => clock,
    wait: async (ms) => { clock += ms },
    maxCumulativeWaitMs: 4999,
    random: () => 0
  })
  await assert.rejects(blocked.schedule('openalex-reset-budget', async () => {
    blockedStarts.push(clock)
    throw createSearchHttpError(429, new Headers({ 'X-RateLimit-Reset': '5' }))
  }), (error) => error.schedulerWaitLimit === true)
  assert.deepEqual(blockedStarts, [5000])
})

test('HTTP 408 and 425 remain retryable through the shared scheduler policy', async () => {
  for (const status of [408, 425]) {
    const error = createSearchHttpError(status, new Headers())
    assert.equal(error.retryable, true)

    let clock = 0
    let attempts = 0
    const scheduler = createAgentSearchScheduler({
      now: () => clock,
      wait: async (ms) => { clock += ms },
      random: () => 0
    })
    const result = await scheduler.schedule(`status-${status}`, async () => {
      attempts += 1
      if (attempts === 1) throw createSearchHttpError(status, new Headers())
      return 'ok'
    })
    assert.equal(result, 'ok')
    assert.equal(attempts, 2)
  }
})

test('a final retryable failure leaves its lane cooldown for the next FIFO job', async () => {
  let clock = 0
  const starts = []
  const scheduler = createAgentSearchScheduler({
    now: () => clock,
    wait: async (ms) => { clock += ms },
    random: () => 0
  })
  let attempts = 0
  const first = scheduler.schedule('crossref', async () => {
    starts.push(['first', clock])
    attempts += 1
    const error = new Error('limited')
    error.status = 429
    error.retryAfterMs = attempts === 3 ? 7000 : 2000
    throw error
  })
  const second = scheduler.schedule('crossref', async () => {
    starts.push(['second', clock])
    return 'second'
  })
  await assert.rejects(first, /limited/)
  assert.equal(await second, 'second')
  assert.deepEqual(starts, [
    ['first', 0],
    ['first', 2000],
    ['first', 4000],
    ['second', 11_000]
  ])
})

test('queued, cooldown, and active operations are abortable', async () => {
  let clock = 0
  const firstGate = deferred()
  const cooldownGate = deferred()
  const scheduler = createAgentSearchScheduler({
    now: () => clock,
    wait: (ms, signal) => new Promise((resolve, reject) => {
      const onAbort = () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      cooldownGate.promise.then(() => { clock += ms; signal?.removeEventListener('abort', onAbort); resolve() })
    })
  })
  const first = scheduler.schedule('bing', async () => firstGate.promise)
  const queuedAbort = new AbortController()
  const queued = scheduler.schedule('bing', async () => 'never', { signal: queuedAbort.signal })
  queuedAbort.abort()
  await assert.rejects(queued, { name: 'AbortError' })
  firstGate.resolve('first')
  assert.equal(await first, 'first')

  const cooldownAbort = new AbortController()
  const cooldown = scheduler.schedule('bing', async () => 'never', { signal: cooldownAbort.signal })
  await tick()
  cooldownAbort.abort()
  await assert.rejects(cooldown, { name: 'AbortError' })

  const activeAbort = new AbortController()
  const active = scheduler.schedule('crossref', async () => new Promise(() => {}), { signal: activeAbort.signal })
  await tick()
  activeAbort.abort()
  await assert.rejects(active, { name: 'AbortError' })
})
