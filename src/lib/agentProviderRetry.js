export const AGENT_PROVIDER_MAX_RECONNECTS = 10
export const AGENT_PROVIDER_RECONNECT_DELAY_MS = 10_000

const TRANSIENT_PROTOCOL_CODES = new Set([
  'PROVIDER_STREAM_ERROR',
  'SSE_BODY_UNREADABLE',
  'STREAM_EOF_BEFORE_TERMINAL'
])

const abortError = () => {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError')
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
}

const waitForReconnect = (delayMs, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(abortError())
    return
  }
  let timer = 0
  const onAbort = () => {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
    reject(abortError())
  }
  timer = setTimeout(() => {
    signal?.removeEventListener?.('abort', onAbort)
    resolve()
  }, delayMs)
  signal?.addEventListener?.('abort', onAbort, { once: true })
})

export const isTransientAgentProviderError = (error) => {
  if (!error || error.name === 'AbortError') return false
  const status = Number(error.status)
  if (Number.isInteger(status)) {
    return status === 408 || status === 425 || status === 429 || status >= 500
  }
  const code = String(error.code || '').toUpperCase()
  if (TRANSIENT_PROTOCOL_CODES.has(code)) return true
  if (/^(?:ECONN|ENET|EHOST|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR_)/.test(code)) return true
  if (error.name === 'TypeError') return true
  return /failed to fetch|fetch failed|network(?:error| request)?|socket|connection (?:closed|reset|refused)|timed? ?out|other side closed|load failed/i
    .test(String(error.message || ''))
}

export const runAgentProviderWithReconnect = async (operation, {
  signal,
  maxReconnects = AGENT_PROVIDER_MAX_RECONNECTS,
  delayMs = AGENT_PROVIDER_RECONNECT_DELAY_MS,
  onReconnect = null,
  wait = waitForReconnect
} = {}) => {
  const reconnectLimit = Math.max(0, Math.min(AGENT_PROVIDER_MAX_RECONNECTS, Math.floor(Number(maxReconnects) || 0)))
  const reconnectDelay = Math.max(0, Math.floor(Number(delayMs) || 0))
  let reconnects = 0
  for (;;) {
    if (signal?.aborted) throw abortError()
    try {
      return await operation(reconnects)
    } catch (error) {
      if (signal?.aborted) throw abortError()
      if (!isTransientAgentProviderError(error) || reconnects >= reconnectLimit) throw error
      reconnects += 1
      onReconnect?.({ attempt: reconnects, maxReconnects: reconnectLimit, delayMs: reconnectDelay, error })
      await wait(reconnectDelay, signal)
    }
  }
}
