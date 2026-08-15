export const SOURCE_READ_RESULT_VERSION = 1
export const SOURCE_CURSOR_VERSION = 1

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/
const CURSOR_DOMAIN = 'knote-source-continuation-v1'

export class SourceContinuationError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'SourceContinuationError'
    this.code = code
    this.details = details
    Object.assign(this, details)
  }
}

const sourceError = (code, message, details) => new SourceContinuationError(code, message, details)

const safeInteger = (value, name, minimum = 0) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw sourceError('SOURCE_READ_INVALID', `${name} must be a safe integer of at least ${minimum}`)
  }
  return number
}

const cloneJson = (value, depth = 0) => {
  if (depth > 12) throw sourceError('CURSOR_INVALID', 'Cursor data is too deeply nested')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw sourceError('CURSOR_INVALID', 'Cursor numbers must be finite safe integers')
    }
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw sourceError('CURSOR_INVALID', 'Cursor arrays are too large')
    return value.map((item) => cloneJson(item, depth + 1))
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw sourceError('CURSOR_INVALID', 'Cursor data must be plain JSON')
  }
  const keys = Object.keys(value).sort()
  if (keys.length > 128) throw sourceError('CURSOR_INVALID', 'Cursor objects have too many fields')
  const result = {}
  for (const key of keys) {
    if (!key || key.length > 160 || value[key] === undefined) {
      throw sourceError('CURSOR_INVALID', 'Cursor object fields are invalid')
    }
    result[key] = cloneJson(value[key], depth + 1)
  }
  return result
}

const stableJson = (value) => JSON.stringify(cloneJson(value))

const bytesToBase64Url = (bytes) => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const base64UrlToBytes = (value) => {
  const text = String(value || '')
  if (!text || !BASE64URL_RE.test(text)) throw sourceError('CURSOR_INVALID', 'Cursor is not base64url')
  let base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4) base64 += '='
  let binary
  try { binary = atob(base64) } catch { throw sourceError('CURSOR_INVALID', 'Cursor base64url is malformed') }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const decodeUtf8 = (bytes, code = 'CURSOR_INVALID') => {
  try { return decoder.decode(bytes) } catch { throw sourceError(code, 'Cursor contains invalid UTF-8') }
}

const cryptoSubtle = () => {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw sourceError('CURSOR_INVALID', 'Cursor cryptography is unavailable')
  return subtle
}

const sha256Hex = async (value) => {
  const digest = await cryptoSubtle().digest('SHA-256', encoder.encode(String(value)))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const sourceRevisionFingerprint = async (value) => {
  const bytes = typeof value === 'string'
    ? encoder.encode(value)
    : value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : encoder.encode(String(value ?? ''))
  const digest = await cryptoSubtle().digest('SHA-256', bytes)
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const signPayload = async (payloadText, cursorKey) => {
  const keyText = String(cursorKey || '')
  if (keyText.length < 16) throw sourceError('CURSOR_INVALID', 'Cursor signing key is unavailable')
  const key = await cryptoSubtle().importKey(
    'raw',
    encoder.encode(`${CURSOR_DOMAIN}\0${keyText}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return new Uint8Array(await cryptoSubtle().sign('HMAC', key, encoder.encode(payloadText)))
}

const signaturesMatch = (left, right) => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
  return difference === 0
}

const requiredCursorBinding = (value, name) => {
  const text = String(value || '')
  if (!text || text.length > 4096) throw sourceError('CURSOR_INVALID', `${name} is unavailable`)
  return text
}

// Cursors contain no raw source/owner identity. The signed payload carries only
// their SHA-256 bindings, a revision, query options and the exact next position.
export const createSourceCursor = async ({
  kind,
  sourceId,
  revision,
  options = {},
  position,
  ownerKey,
  cursorKey
} = {}) => {
  const normalizedKind = requiredCursorBinding(kind, 'kind')
  const normalizedRevision = requiredCursorBinding(revision, 'revision')
  const payload = {
    v: SOURCE_CURSOR_VERSION,
    k: normalizedKind,
    s: await sha256Hex(requiredCursorBinding(sourceId, 'sourceId')),
    r: normalizedRevision,
    o: await sha256Hex(requiredCursorBinding(ownerKey, 'ownerKey')),
    q: cloneJson(options),
    p: cloneJson(position)
  }
  const payloadText = stableJson(payload)
  const envelope = {
    v: SOURCE_CURSOR_VERSION,
    p: bytesToBase64Url(encoder.encode(payloadText)),
    m: bytesToBase64Url(await signPayload(payloadText, cursorKey))
  }
  return bytesToBase64Url(encoder.encode(JSON.stringify(envelope)))
}

export const readSourceCursor = async (cursor, {
  kind,
  sourceId,
  revision,
  options,
  ownerKey,
  cursorKey
} = {}) => {
  const encoded = String(cursor || '')
  if (!encoded || encoded.length > 16_384 || !BASE64URL_RE.test(encoded)) {
    throw sourceError('CURSOR_INVALID', 'Cursor is malformed')
  }
  let envelope
  try { envelope = JSON.parse(decodeUtf8(base64UrlToBytes(encoded))) } catch (error) {
    if (error instanceof SourceContinuationError) throw error
    throw sourceError('CURSOR_INVALID', 'Cursor envelope is malformed')
  }
  if (
    !envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
    envelope.v !== SOURCE_CURSOR_VERSION || typeof envelope.p !== 'string' ||
    typeof envelope.m !== 'string' || Object.keys(envelope).some((key) => !['v', 'p', 'm'].includes(key))
  ) throw sourceError('CURSOR_INVALID', 'Cursor envelope version or fields are invalid')

  const payloadText = decodeUtf8(base64UrlToBytes(envelope.p))
  const suppliedSignature = base64UrlToBytes(envelope.m)
  const expectedSignature = await signPayload(payloadText, cursorKey)
  if (!signaturesMatch(suppliedSignature, expectedSignature)) {
    throw sourceError('CURSOR_INVALID', 'Cursor signature is invalid')
  }

  let payload
  try { payload = JSON.parse(payloadText) } catch { throw sourceError('CURSOR_INVALID', 'Cursor payload is malformed') }
  if (
    !payload || typeof payload !== 'object' || Array.isArray(payload) ||
    payload.v !== SOURCE_CURSOR_VERSION || typeof payload.k !== 'string' ||
    typeof payload.s !== 'string' || typeof payload.r !== 'string' ||
    typeof payload.o !== 'string' || !payload.p || typeof payload.p !== 'object' ||
    Object.keys(payload).some((key) => !['v', 'k', 's', 'r', 'o', 'q', 'p'].includes(key))
  ) throw sourceError('CURSOR_INVALID', 'Cursor payload fields are invalid')

  const expectedKind = requiredCursorBinding(kind, 'kind')
  const expectedSource = await sha256Hex(requiredCursorBinding(sourceId, 'sourceId'))
  const expectedOwner = await sha256Hex(requiredCursorBinding(ownerKey, 'ownerKey'))
  if (payload.k !== expectedKind || payload.s !== expectedSource || payload.o !== expectedOwner) {
    throw sourceError('CURSOR_INVALID', 'Cursor does not belong to this source owner')
  }
  if (revision != null && payload.r !== String(revision)) {
    throw sourceError('CURSOR_STALE', 'Source revision changed after the cursor was issued')
  }
  if (options !== undefined && stableJson(payload.q) !== stableJson(options)) {
    throw sourceError('CURSOR_INVALID', 'Cursor query options do not match this request')
  }
  return Object.freeze({
    version: payload.v,
    revision: payload.r,
    options: cloneJson(payload.q),
    position: cloneJson(payload.p)
  })
}

const triState = (value, name) => {
  if (value === null || typeof value === 'boolean') return value
  throw sourceError('SOURCE_READ_INVALID', `${name} must be true, false, or null`)
}

export const createSourceReadContract = ({
  unit,
  returned,
  total = null,
  truncated = false,
  hasMore = false,
  nextCursor = null,
  reason = '',
  requestedRangeComplete,
  sourceComplete,
  projectionComplete,
  coverage = 'unknown'
} = {}) => {
  const normalizedUnit = String(unit || '').trim()
  if (!normalizedUnit || normalizedUnit.length > 80) throw sourceError('SOURCE_READ_INVALID', 'continuation.unit is required')
  const normalizedReturned = safeInteger(returned, 'continuation.returned')
  const normalizedTotal = total == null ? null : safeInteger(total, 'continuation.total')
  if (normalizedTotal != null && normalizedReturned > normalizedTotal) {
    throw sourceError('SOURCE_READ_INVALID', 'continuation.returned cannot exceed continuation.total')
  }
  const normalizedHasMore = triState(hasMore, 'continuation.has_more')
  const normalizedCursor = nextCursor == null || nextCursor === '' ? null : String(nextCursor)
  if ((normalizedHasMore === true) !== (normalizedCursor !== null)) {
    throw sourceError('SOURCE_READ_INVALID', 'next_cursor must exist if and only if has_more is true')
  }
  if (normalizedCursor && (!BASE64URL_RE.test(normalizedCursor) || normalizedCursor.length > 16_384)) {
    throw sourceError('SOURCE_READ_INVALID', 'next_cursor must be opaque base64url')
  }
  const normalizedReason = String(reason || '').slice(0, 160)
  const requested = triState(requestedRangeComplete, 'grounding.requested_range_complete')
  const source = triState(sourceComplete, 'grounding.source_complete')
  const projection = triState(projectionComplete, 'grounding.projection_complete')
  const normalizedCoverage = String(coverage || 'unknown').slice(0, 80)
  const complete = requested === true && projection === true
  const clipped = truncated === true || requested !== true || projection !== true
  return Object.freeze({
    schema_version: SOURCE_READ_RESULT_VERSION,
    continuation: Object.freeze({
      unit: normalizedUnit,
      returned: normalizedReturned,
      total: normalizedTotal,
      truncated: truncated === true,
      has_more: normalizedHasMore,
      next_cursor: normalizedCursor,
      reason: normalizedReason
    }),
    grounding: Object.freeze({
      requested_range_complete: requested,
      source_complete: source,
      projection_complete: projection,
      coverage: normalizedCoverage,
      // Legacy providers and tests consume these fields. `complete` deliberately
      // means requested range + projection, never whole-source completeness.
      complete,
      clipped
    })
  })
}

export const validateSourceReadResult = (value) => {
  if (!value || typeof value !== 'object') throw sourceError('SOURCE_READ_INVALID', 'SourceReadResultV1 must be an object')
  const continuation = value.continuation
  const grounding = value.grounding
  const rebuilt = createSourceReadContract({
    unit: continuation?.unit,
    returned: continuation?.returned,
    total: continuation?.total,
    truncated: continuation?.truncated,
    hasMore: continuation?.has_more,
    nextCursor: continuation?.next_cursor,
    reason: continuation?.reason,
    requestedRangeComplete: grounding?.requested_range_complete,
    sourceComplete: grounding?.source_complete,
    projectionComplete: grounding?.projection_complete,
    coverage: grounding?.coverage
  })
  if (grounding?.complete !== rebuilt.grounding.complete || grounding?.clipped !== rebuilt.grounding.clipped) {
    throw sourceError('SOURCE_READ_INVALID', 'Legacy complete/clipped fields conflict with three-layer grounding')
  }
  return rebuilt
}

export const normalizeSourceGrounding = (value, {
  defaultRequested = false,
  defaultSource = null,
  defaultProjection = false,
  legacySourceComplete = false
} = {}) => {
  const grounding = value && typeof value === 'object' ? value : {}
  const legacyComplete = typeof grounding.complete === 'boolean' ? grounding.complete : null
  const requested = typeof grounding.requested_range_complete === 'boolean' || grounding.requested_range_complete === null
    ? grounding.requested_range_complete
    : legacyComplete == null ? defaultRequested : legacyComplete
  const source = typeof grounding.source_complete === 'boolean' || grounding.source_complete === null
    ? grounding.source_complete
    : legacySourceComplete && legacyComplete === true ? true : defaultSource
  const projection = typeof grounding.projection_complete === 'boolean' || grounding.projection_complete === null
    ? grounding.projection_complete
    : legacyComplete == null ? defaultProjection : legacyComplete
  const coverage = String(grounding.coverage || 'unknown').slice(0, 80)
  return {
    requested_range_complete: requested,
    source_complete: source,
    projection_complete: projection,
    coverage,
    complete: requested === true && projection === true,
    clipped: grounding.clipped === true || requested !== true || projection !== true
  }
}

export const utf8ByteLength = (value) => encoder.encode(String(value ?? '')).byteLength

const isContinuationByte = (byte) => (byte & 0xc0) === 0x80

export const paginateUtf8Text = (value, { byteOffset = 0, byteLimit } = {}) => {
  const bytes = encoder.encode(String(value ?? ''))
  const start = safeInteger(byteOffset, 'byteOffset')
  const limit = safeInteger(byteLimit, 'byteLimit', 1)
  if (start > bytes.byteLength) throw sourceError('SOURCE_RANGE_INVALID', 'byteOffset is past the source end')
  if (start < bytes.byteLength && isContinuationByte(bytes[start])) {
    throw sourceError('SOURCE_UTF8_BOUNDARY', 'byteOffset must point to a UTF-8 code point boundary')
  }
  let end = Math.min(bytes.byteLength, start + limit)
  while (end > start && end < bytes.byteLength && isContinuationByte(bytes[end])) end--
  if (end === start && start < bytes.byteLength) {
    throw sourceError('SOURCE_BYTE_LIMIT_TOO_SMALL', 'byteLimit cannot hold the next complete UTF-8 code point')
  }
  return Object.freeze({
    text: decodeUtf8(bytes.subarray(start, end), 'SOURCE_UTF8_INVALID'),
    byteOffset: start,
    byteEnd: end,
    bytesRead: end - start,
    totalBytes: bytes.byteLength,
    hasMore: end < bytes.byteLength,
    nextByteOffset: end
  })
}

const lineByteIndex = (value) => {
  const text = String(value ?? '')
  const bytes = encoder.encode(text)
  const lines = []
  let start = 0
  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] !== 0x0a) continue
    lines.push({ start, end: index })
    start = index + 1
  }
  lines.push({ start, end: bytes.byteLength })
  return { bytes, lines }
}

// Returns one bounded page from an inclusive physical-line range. Cursor byte
// offsets and every returned interval are half-open in the normalized source.
export const paginateUtf8LineRange = (value, {
  startLine = 1,
  endLine,
  byteOffset = null,
  byteLimit
} = {}) => {
  const { bytes, lines } = lineByteIndex(value)
  const first = safeInteger(startLine, 'startLine', 1)
  const last = endLine == null ? lines.length : safeInteger(endLine, 'endLine', 1)
  if (first === lines.length + 1 && last === first) {
    const eofOffset = bytes.byteLength
    const start = byteOffset == null ? eofOffset : safeInteger(byteOffset, 'byteOffset')
    safeInteger(byteLimit, 'byteLimit', 1)
    if (start !== eofOffset) throw sourceError('CURSOR_INVALID', 'EOF cursor byte offset is invalid')
    return Object.freeze({
      fragments: Object.freeze([]),
      byteOffset: eofOffset,
      byteEnd: eofOffset,
      bytesRead: 0,
      rangeStart: eofOffset,
      rangeEnd: eofOffset,
      totalBytes: 0,
      totalLines: lines.length,
      startLine: first,
      endLine: last,
      hasMore: false,
      nextByteOffset: eofOffset,
      eof: true
    })
  }
  if (first > lines.length || last < first || last > lines.length) {
    throw sourceError('SOURCE_RANGE_INVALID', 'Requested physical-line range is invalid', { totalLines: lines.length })
  }
  const rangeStart = lines[first - 1].start
  const rangeEnd = lines[last - 1].end
  const start = byteOffset == null ? rangeStart : safeInteger(byteOffset, 'byteOffset')
  if (start < rangeStart || start > rangeEnd) throw sourceError('CURSOR_INVALID', 'Cursor byte offset is outside its requested line range')
  if (start < bytes.byteLength && isContinuationByte(bytes[start])) throw sourceError('CURSOR_INVALID', 'Cursor byte offset splits UTF-8')
  const limit = safeInteger(byteLimit, 'byteLimit', 1)

  let end
  if (start === rangeEnd) {
    end = start
  } else {
    const bounded = paginateUtf8Text(decodeUtf8(bytes.subarray(start, rangeEnd), 'SOURCE_UTF8_INVALID'), {
      byteOffset: 0,
      byteLimit: limit
    })
    end = start + bounded.bytesRead
    // Prefer a complete physical-line boundary whenever one fits. If the first
    // remaining line itself is oversized there is no LF and byte paging wins.
    if (end < rangeEnd) {
      let boundary = -1
      for (let index = start; index < end; index++) if (bytes[index] === 0x0a) boundary = index + 1
      if (boundary > start) end = boundary
    }
  }

  const fragments = []
  for (let lineIndex = first - 1; lineIndex < last; lineIndex++) {
    const line = lines[lineIndex]
    const fragmentStart = Math.max(start, line.start)
    const fragmentEnd = Math.min(end, line.end)
    const emptyVisible = line.start === line.end && start <= line.start && end >= line.end && (
      end > start || rangeEnd === rangeStart
    )
    if (fragmentEnd <= fragmentStart && !emptyVisible) continue
    fragments.push(Object.freeze({
      line: lineIndex + 1,
      byteStart: Math.max(0, fragmentStart - line.start),
      byteEnd: Math.max(0, fragmentEnd - line.start),
      totalBytes: line.end - line.start,
      text: decodeUtf8(bytes.subarray(fragmentStart, fragmentEnd), 'SOURCE_UTF8_INVALID'),
      completeLine: fragmentStart === line.start && fragmentEnd === line.end
    }))
  }
  return Object.freeze({
    fragments: Object.freeze(fragments),
    byteOffset: start,
    byteEnd: end,
    bytesRead: end - start,
    rangeStart,
    rangeEnd,
    totalBytes: rangeEnd - rangeStart,
    totalLines: lines.length,
    startLine: first,
    endLine: last,
    hasMore: end < rangeEnd,
    nextByteOffset: end,
    eof: false
  })
}

export const formatNumberedSourceFragments = (fragments) => (fragments || []).map((fragment) => {
  const range = fragment.completeLine
    ? ''
    : ` [UTF-8 bytes ${fragment.byteStart}-${fragment.byteEnd}/${fragment.totalBytes}]`
  return `${fragment.line}|${range} ${fragment.text}`
}).join('\n')

export const mergeHalfOpenByteRanges = (ranges, startValue, endValue) => {
  const start = safeInteger(startValue, 'start')
  const end = safeInteger(endValue, 'end')
  if (end < start) throw sourceError('SOURCE_RANGE_INVALID', 'end must not precede start')
  const values = [...(Array.isArray(ranges) ? ranges : []).map((range) => [Number(range?.[0]), Number(range?.[1])]), [start, end]]
    .filter((range) => Number.isSafeInteger(range[0]) && Number.isSafeInteger(range[1]) && range[1] >= range[0])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged = []
  for (const range of values) {
    const previous = merged[merged.length - 1]
    if (!previous || range[0] > previous[1]) merged.push([...range])
    else previous[1] = Math.max(previous[1], range[1])
  }
  return merged
}

export const halfOpenRangeCovered = (ranges, start, end) => (ranges || []).some((range) => (
  Number(range?.[0]) <= start && Number(range?.[1]) >= end
))

// Page-sequence pagination is shared by PDF text extraction tests and runtime.
// A page is never reported complete until its final UTF-8 byte was returned.
export const paginateUtf8PageSequence = (pagesValue, {
  pageIndex = 0,
  byteOffset = 0,
  byteLimit
} = {}) => {
  const pages = (Array.isArray(pagesValue) ? pagesValue : []).map((page, index) => ({
    id: page?.id ?? index + 1,
    text: String(page?.text ?? ''),
    sourceComplete: page?.sourceComplete !== false,
    reason: String(page?.reason || '')
  }))
  let index = safeInteger(pageIndex, 'pageIndex')
  let offset = safeInteger(byteOffset, 'byteOffset')
  let remaining = safeInteger(byteLimit, 'byteLimit', 1)
  if (index > pages.length) throw sourceError('CURSOR_INVALID', 'Cursor page index is past the requested pages')
  const fragments = []
  let returned = 0
  while (index < pages.length) {
    const page = pages[index]
    const totalBytes = utf8ByteLength(page.text)
    if (offset > totalBytes) throw sourceError('CURSOR_INVALID', 'Cursor byte offset is past its PDF page')
    if (totalBytes === 0 || offset === totalBytes) {
      fragments.push(Object.freeze({
        id: page.id,
        text: '',
        byteStart: offset,
        byteEnd: offset,
        totalBytes,
        pageComplete: true,
        sourceComplete: page.sourceComplete,
        reason: page.reason
      }))
      index++
      offset = 0
      continue
    }
    const part = paginateUtf8Text(page.text, { byteOffset: offset, byteLimit: remaining })
    fragments.push(Object.freeze({
      id: page.id,
      text: part.text,
      byteStart: offset,
      byteEnd: part.nextByteOffset,
      totalBytes,
      pageComplete: !part.hasMore,
      sourceComplete: page.sourceComplete,
      reason: page.reason
    }))
    returned += part.bytesRead
    remaining -= part.bytesRead
    if (part.hasMore) {
      offset = part.nextByteOffset
      break
    }
    index++
    offset = 0
    if (remaining <= 0) break
  }
  const hasMore = index < pages.length
  return Object.freeze({
    fragments: Object.freeze(fragments),
    returnedBytes: returned,
    totalBytes: pages.reduce((total, page) => total + utf8ByteLength(page.text), 0),
    hasMore,
    nextPosition: Object.freeze({ pageIndex: index, byteOffset: offset })
  })
}
