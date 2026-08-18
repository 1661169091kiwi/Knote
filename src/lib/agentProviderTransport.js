import { Capacitor } from '@capacitor/core'
import { KnoteAndroid } from '@knote/capacitor-android'

const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024
const NATIVE_ERROR_RETRYABLE = new Map([
  ['PROVIDER_CANCELLED', false],
  ['PROVIDER_TIMEOUT', true],
  ['PROVIDER_NETWORK_ERROR', true],
  ['PROVIDER_REQUEST_TOO_LARGE', false],
  ['PROVIDER_RESPONSE_TOO_LARGE', false],
  ['PROVIDER_INVALID_RESPONSE', false],
  ['PROVIDER_INVALID_INPUT', false],
  ['PROVIDER_QUEUE_FULL', true]
])

const abortError = () => {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError()
}

const isAndroidNative = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'

const raceNativeWithAbort = (operation, signal, cancel) => {
  if (!signal) return Promise.resolve().then(operation)
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => {
      try {
        Promise.resolve(cancel()).catch(() => {})
      } catch {
        // Cancellation is best-effort; the caller still rejects immediately.
      }
      finish(reject, signal.reason instanceof Error ? signal.reason : abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    let pending
    try {
      pending = operation()
    } catch (error) {
      finish(reject, error)
      return
    }
    Promise.resolve(pending).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    )
  })
}

const exceedsUtf8Limit = (value, maximum) => {
  const text = String(value)
  return text.length > maximum || new TextEncoder().encode(text).byteLength > maximum
}

const providerError = (code, message, retryable = false, cause = null) => {
  const error = new Error(message)
  error.code = code
  error.retryable = retryable
  if (cause) error.cause = cause
  return error
}

const nativeResponse = (result, maximum) => {
  const statusValue = Number(result?.status)
  if (!Number.isInteger(statusValue) || statusValue < 200 || statusValue > 599) {
    throw providerError('PROVIDER_INVALID_RESPONSE', 'Android native provider response had an invalid status')
  }
  const body = result?.body
  if (typeof body !== 'string') {
    throw providerError('PROVIDER_INVALID_RESPONSE', 'Android native provider response was not text')
  }
  if (exceedsUtf8Limit(body, maximum)) {
    throw providerError('PROVIDER_RESPONSE_TOO_LARGE', 'Android native provider response exceeded the size limit')
  }
  if (
    typeof result?.contentType !== 'string' ||
    result.contentType.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(result.contentType)
  ) {
    throw providerError('PROVIDER_INVALID_RESPONSE', 'Android native provider response had an invalid content type')
  }
  const declaredType = result.contentType.trim()
  const contentType = declaredType || 'application/json; charset=utf-8'
  return new Response([204, 205, 304].includes(statusValue) ? null : body, {
    status: statusValue,
    headers: { 'content-type': contentType }
  })
}

const nativeProviderError = (cause) => {
  const code = String(cause?.code || '').toUpperCase()
  if (NATIVE_ERROR_RETRYABLE.has(code)) {
    return providerError(
      code,
      String(cause?.message || 'Android native provider transport failed'),
      NATIVE_ERROR_RETRYABLE.get(code),
      cause instanceof Error ? cause : null
    )
  }
  return providerError(
    'ANDROID_PROVIDER_TRANSPORT_FAILED',
    'Android native provider transport failed',
    false,
    cause instanceof Error ? cause : null
  )
}

let providerRequestSequence = 0
const newProviderRequestId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  providerRequestSequence += 1
  return `provider_${Date.now().toString(36)}_${providerRequestSequence.toString(36)}_${Math.random().toString(36).slice(2)}`
}

export const createProviderTransport = ({
  fetchImpl = (...args) => globalThis.fetch(...args),
  android = isAndroidNative,
  nativeRequest = (options) => KnoteAndroid.providerRequest(options),
  nativeCancel = (options) => KnoteAndroid.cancelProviderRequest(options),
  connectTimeout = 15_000,
  readTimeout = 120_000,
  maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES
} = {}) => {
  const maximum = Number.isSafeInteger(Number(maxBufferedBytes)) && Number(maxBufferedBytes) > 0
    ? Number(maxBufferedBytes)
    : DEFAULT_MAX_BUFFERED_BYTES
  return async (url, init = {}) => {
    throwIfAborted(init.signal)
    if (!android()) return fetchImpl(url, init)

    const method = String(init.method || 'GET').toUpperCase()
    if (method !== 'POST' || typeof init.body !== 'string') {
      throw providerError('PROVIDER_INVALID_INPUT', 'Android native provider transport permits JSON POST requests only')
    }
    if (exceedsUtf8Limit(init.body, maximum)) {
      throw providerError('PROVIDER_REQUEST_TOO_LARGE', 'Provider request exceeded the native buffer size limit')
    }

    let requestBody
    try {
      const parsed = JSON.parse(init.body)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError()
      requestBody = JSON.stringify({ ...parsed, stream: false })
    } catch {
      throw providerError('PROVIDER_INVALID_INPUT', 'Provider body must be a JSON object')
    }
    if (exceedsUtf8Limit(requestBody, maximum)) {
      throw providerError('PROVIDER_REQUEST_TOO_LARGE', 'Provider request exceeded the native buffer size limit')
    }

    let endpoint
    let headers
    try {
      endpoint = String(url)
      headers = {}
      for (const [name, value] of new Headers(init.headers || {}).entries()) headers[name] = value
    } catch (cause) {
      throw providerError('PROVIDER_INVALID_INPUT', 'Provider URL or headers were invalid', false, cause)
    }

    throwIfAborted(init.signal)
    const requestId = newProviderRequestId()
    let result
    try {
      result = await raceNativeWithAbort(
        () => nativeRequest({
          requestId,
          url: endpoint,
          method: 'POST',
          headers,
          body: requestBody,
          connectTimeout,
          readTimeout
        }),
        init.signal,
        () => nativeCancel({ requestId })
      )
    } catch (nativeCause) {
      throwIfAborted(init.signal)
      if (nativeCause?.name === 'AbortError') throw nativeCause
      throw nativeProviderError(nativeCause)
    }
    throwIfAborted(init.signal)
    return nativeResponse(result, maximum)
  }
}

export const providerFetch = createProviderTransport()
