const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const MAX_RATE_WAIT_MS = 120_000
export const DEFAULT_SEARCH_ATTEMPT_TIMEOUT_MS = 20_000
const MIN_PLAUSIBLE_UNIX_SECONDS = 946_684_800
const MAX_PLAUSIBLE_UNIX_SECONDS = 4_102_444_800
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENETDOWN', 'ENETRESET', 'ENETUNREACH',
  'EHOSTUNREACH', 'ETIMEDOUT', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_TIMED_OUT', 'ERR_INTERNET_DISCONNECTED', 'ERR_NAME_NOT_RESOLVED',
  'ERR_NETWORK_CHANGED', 'REQUEST_TIMEOUT'
])

const abortError = () => {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

export const throwIfSearchAborted = (signal) => {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError()
}

export const cancelSearchResponseBody = async (response, reason) => {
  const body = response?.body
  if (!body || typeof body.cancel !== 'function') return
  try { await body.cancel(reason) } catch { /* a locked or already-failed reader owns cleanup */ }
}

const searchTimeoutError = () => {
  const error = new Error('Search source request timed out')
  error.name = 'SearchTimeoutError'
  error.code = 'SEARCH_TIMEOUT'
  error.retryable = true
  error.network = true
  return error
}

export const runSearchAttemptWithTimeout = (operation, {
  signal,
  timeoutMs = DEFAULT_SEARCH_ATTEMPT_TIMEOUT_MS
} = {}) => {
  if (typeof operation !== 'function') return Promise.reject(new TypeError('Search attempt operation is required'))
  try { throwIfSearchAborted(signal) } catch (error) { return Promise.reject(error) }
  const requested = Number(timeoutMs)
  const delay = Number.isFinite(requested) && requested > 0
    ? Math.max(1, Math.min(MAX_RATE_WAIT_MS, Math.floor(requested)))
    : DEFAULT_SEARCH_ATTEMPT_TIMEOUT_MS
  const controller = new AbortController()

  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
    }
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }
    const interrupt = (error) => {
      controller.abort(error)
      finish(reject, error)
    }
    const onCallerAbort = () => interrupt(signal?.reason instanceof Error ? signal.reason : abortError())

    signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (signal?.aborted) {
      onCallerAbort()
      return
    }
    timer = setTimeout(() => interrupt(searchTimeoutError()), delay)
    Promise.resolve().then(() => operation(controller.signal)).then(
      (value) => finish(resolve, value),
      (error) => interrupt(error)
    )
  })
}

export const abortableSearchWait = (milliseconds, signal) => {
  const delay = Math.max(0, Math.floor(Number(milliseconds) || 0))
  if (!delay) {
    throwIfSearchAborted(signal)
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    let timer
    const settle = (callback, value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => settle(reject, signal?.reason instanceof Error ? signal.reason : abortError())
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => settle(resolve), delay)
  })
}

export const parseRetryAfterMs = (value, now = Date.now(), maximum = 120_000) => {
  const text = String(value == null ? '' : value).trim()
  if (!text) return null
  const maximumMs = Math.max(0, Math.min(MAX_RATE_WAIT_MS, Math.floor(Number(maximum) || 0)))
  let milliseconds
  if (/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) milliseconds = Number(text) * 1000
  else {
    const timestamp = Date.parse(text)
    if (!Number.isFinite(timestamp)) return null
    milliseconds = timestamp - Number(now)
  }
  if (!Number.isFinite(milliseconds)) return null
  return Math.max(0, Math.min(maximumMs, Math.ceil(milliseconds)))
}

const parseRateReset = (value, now) => {
  const text = String(value == null ? '' : value).trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null
  const seconds = Number(text)
  const nowMs = Number(now)
  if (!Number.isFinite(seconds) || !Number.isFinite(nowMs)) return null

  if (seconds >= MIN_PLAUSIBLE_UNIX_SECONDS && seconds <= MAX_PLAUSIBLE_UNIX_SECONDS) {
    const resetAt = Math.ceil(seconds * 1000)
    return {
      resetAt,
      retryAfterMs: Math.max(0, Math.min(MAX_RATE_WAIT_MS, Math.ceil(resetAt - nowMs)))
    }
  }

  if (seconds >= MIN_PLAUSIBLE_UNIX_SECONDS) return null
  const resetAfterMs = Math.ceil(seconds * 1000)
  const retryAfterMs = Math.max(0, Math.min(MAX_RATE_WAIT_MS, resetAfterMs))
  return {
    resetAt: Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(nowMs + resetAfterMs)),
    retryAfterMs
  }
}

export const sanitizedRateMetadata = (statusValue, headers, now = Date.now()) => {
  const status = Number(statusValue)
  if (!Number.isInteger(status) || status < 100 || status > 599) return null
  const header = (name) => {
    if (headers && typeof headers.get === 'function') return headers.get(name)
    if (!headers || typeof headers !== 'object') return null
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    const value = key ? headers[key] : null
    return Array.isArray(value) ? value[0] : value
  }
  const headerRetryAfterMs = parseRetryAfterMs(header('retry-after'), now)
  const remainingText = String(header('x-ratelimit-remaining') ?? '').trim()
  const remaining = /^\d+$/.test(remainingText) && Number.isSafeInteger(Number(remainingText))
    ? Number(remainingText)
    : null
  const reset = parseRateReset(header('x-ratelimit-reset'), now)
  const honorReset = status === 429 || remaining === 0
  const retryAfterMs = honorReset && reset
    ? Math.max(headerRetryAfterMs ?? 0, reset.retryAfterMs)
    : headerRetryAfterMs
  return {
    status,
    ...(retryAfterMs !== null ? { retryAfterMs } : {}),
    ...(remaining !== null ? { remaining } : {}),
    ...(reset ? { resetAt: reset.resetAt } : {})
  }
}

export const createSearchHttpError = (status, headers, message = '') => {
  const error = new Error(message || `Search source returned HTTP ${status}`)
  error.name = 'SearchHttpError'
  error.status = Number(status)
  error.rate = sanitizedRateMetadata(status, headers)
  error.retryable = RETRYABLE_STATUS.has(error.status)
  if (error.rate?.retryAfterMs != null) error.retryAfterMs = error.rate.retryAfterMs
  return error
}

export const isRetryableSearchError = (error) => {
  if (!error || error.name === 'AbortError') return false
  if (typeof error.retryable === 'boolean') return error.retryable
  const status = Number(error.status ?? error.rate?.status)
  if (RETRYABLE_STATUS.has(status)) return true
  if (error.network === true || error instanceof TypeError) return true
  return RETRYABLE_NETWORK_CODES.has(String(error.code || '').toUpperCase())
}

const raceActiveOperation = (operation, signal) => {
  if (!signal) return operation
  throwIfSearchAborted(signal)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject, signal.reason instanceof Error ? signal.reason : abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    )
  })
}

export const createAgentSearchScheduler = ({
  now = () => Date.now(),
  wait = abortableSearchWait,
  random = Math.random,
  minimumSpacingMs = 2_000,
  maxAttempts = 3,
  maxCumulativeWaitMs = 120_000,
  maxRetryDelayMs = MAX_RATE_WAIT_MS,
  retryBaseMs = 1_000,
  activityPulseMs = 10_000
} = {}) => {
  const lanes = new Map()
  const retryDelayLimitMs = Math.max(0, Math.min(MAX_RATE_WAIT_MS, Math.floor(Number(maxRetryDelayMs) || 0)))
  const emit = (job, phase, details = {}) => {
    try { job.onActivity?.({ source: job.source, phase, ...details }) } catch { /* UI activity is best-effort */ }
  }

  const runJob = async (lane, job) => {
    let attempt = 0
    let completedWaitMs = 0
    let waitingSince = Number(job.queuedAt)
    let cumulativeWaitMs = 0
    let lastError = null
    const measuredWaitAt = (timestamp) => completedWaitMs + Math.max(0, Math.ceil(Number(timestamp) - waitingSince))
    const throwWaitLimit = () => {
      if (lastError) {
        lastError.schedulerWaitLimit = true
        throw lastError
      }
      const error = new Error('Search scheduler wait limit exceeded')
      error.code = 'SEARCH_WAIT_LIMIT'
      error.retryable = false
      throw error
    }
    while (attempt < maxAttempts) {
      throwIfSearchAborted(job.signal)
      let current = Number(now())
      cumulativeWaitMs = measuredWaitAt(current)
      if (cumulativeWaitMs > maxCumulativeWaitMs) throwWaitLimit()
      const spacedAt = lane.lastStartedAt == null ? current : lane.lastStartedAt + minimumSpacingMs
      const startAt = Math.max(current, spacedAt, lane.cooldownUntil)
      const waitMs = Math.max(0, Math.ceil(startAt - current))
      if (waitMs) {
        if (cumulativeWaitMs + waitMs > maxCumulativeWaitMs) throwWaitLimit()
        const chunk = Math.min(waitMs, Math.max(1, activityPulseMs))
        emit(job, 'cooldown', { attempt: attempt + 1, waitMs, cumulativeWaitMs })
        await wait(chunk, job.signal)
        throwIfSearchAborted(job.signal)
        current = Number(now())
        cumulativeWaitMs = measuredWaitAt(current)
        if (cumulativeWaitMs > maxCumulativeWaitMs) throwWaitLimit()
        continue
      }

      let operationStarted = false
      const nextAttempt = attempt + 1
      try {
        return await raceActiveOperation(Promise.resolve().then(() => {
          throwIfSearchAborted(job.signal)
          cumulativeWaitMs = measuredWaitAt(Number(now()))
          if (cumulativeWaitMs > maxCumulativeWaitMs) throwWaitLimit()
          emit(job, 'active', { attempt: nextAttempt, cumulativeWaitMs })

          const startedAt = Number(now())
          cumulativeWaitMs = measuredWaitAt(startedAt)
          if (cumulativeWaitMs > maxCumulativeWaitMs) throwWaitLimit()
          attempt = nextAttempt
          lane.lastStartedAt = startedAt
          completedWaitMs = cumulativeWaitMs
          waitingSince = null
          operationStarted = true
          return job.operation({
            source: job.source,
            signal: job.signal,
            attempt
          })
        }), job.signal)
      } catch (error) {
        if (error?.schedulerWaitLimit || error?.code === 'SEARCH_WAIT_LIMIT') throw error
        if (error?.name === 'AbortError' || job.signal?.aborted) throw error
        if (!operationStarted) throw error
        const operationEndedAt = Number(now())
        lastError = error
        const retryable = isRetryableSearchError(error)
        if (retryable) {
          const retryAfterMs = Number(error.retryAfterMs ?? error.rate?.retryAfterMs)
          const exponential = retryBaseMs * (2 ** (attempt - 1))
          const jitter = exponential * 0.25 * Math.max(0, Math.min(1, Number(random()) || 0))
          const desired = Math.max(exponential + jitter, Number.isFinite(retryAfterMs) ? retryAfterMs : 0)
          const retryDelayMs = Math.min(retryDelayLimitMs, Math.max(0, Math.ceil(desired)))
          lane.cooldownUntil = Math.max(lane.cooldownUntil, operationEndedAt + retryDelayMs)
          if (attempt < maxAttempts) {
            emit(job, 'retry', { attempt, nextAttempt: attempt + 1, waitMs: retryDelayMs, cumulativeWaitMs })
          }
        }
        if (attempt >= maxAttempts || !retryable) throw error
        waitingSince = operationEndedAt
      }
    }
    throw lastError || new Error('Search operation failed')
  }

  const drain = async (lane) => {
    if (lane.draining) return
    lane.draining = true
    try {
      while (lane.queue.length) {
        const job = lane.queue.shift()
        if (job.signal?.aborted) {
          job.cleanup()
          job.reject(job.signal.reason instanceof Error ? job.signal.reason : abortError())
          continue
        }
        job.started = true
        job.cleanupQueuedAbort()
        try {
          job.resolve(await runJob(lane, job))
        } catch (error) {
          job.reject(error)
        } finally {
          job.cleanup()
        }
      }
    } finally {
      lane.draining = false
      if (lane.queue.length) queueMicrotask(() => { void drain(lane) })
    }
  }

  const schedule = (sourceValue, operation, { signal, onActivity } = {}) => {
    const source = String(sourceValue || '').trim()
    if (!source) return Promise.reject(new TypeError('Search scheduler source is required'))
    if (typeof operation !== 'function') return Promise.reject(new TypeError('Search scheduler operation is required'))
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : abortError())
    let lane = lanes.get(source)
    if (!lane) {
      lane = { queue: [], draining: false, lastStartedAt: null, cooldownUntil: 0 }
      lanes.set(source, lane)
    }
    return new Promise((resolve, reject) => {
      const job = {
        source,
        operation,
        signal,
        onActivity,
        resolve,
        reject,
        started: false,
        queuedAt: Number(now()),
        cleanupQueuedAbort: () => {},
        cleanup: () => {}
      }
      const onQueuedAbort = () => {
        if (job.started) return
        const index = lane.queue.indexOf(job)
        if (index >= 0) lane.queue.splice(index, 1)
        job.cleanup()
        reject(signal.reason instanceof Error ? signal.reason : abortError())
      }
      job.cleanupQueuedAbort = () => signal?.removeEventListener('abort', onQueuedAbort)
      job.cleanup = job.cleanupQueuedAbort
      signal?.addEventListener('abort', onQueuedAbort, { once: true })
      if (lane.draining || lane.queue.length) emit(job, 'queued', { position: lane.queue.length + 1 })
      lane.queue.push(job)
      queueMicrotask(() => { void drain(lane) })
    })
  }

  return {
    schedule,
    pending: (source) => {
      const lane = lanes.get(String(source || ''))
      return lane ? lane.queue.length + (lane.draining ? 1 : 0) : 0
    }
  }
}

const processSearchScheduler = createAgentSearchScheduler()

export const scheduleAgentSearch = (source, operation, options) => (
  processSearchScheduler.schedule(source, operation, options)
)
