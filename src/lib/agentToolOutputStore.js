import { normalizeSourceGrounding } from './agentSourceContinuation.js'

const DB_NAME = 'knote-agent-tool-output'
const DB_VERSION = 2
const ARTIFACT_STORE = 'artifacts'
const TOMBSTONE_STORE = 'tombstones'
const STATE_STORE = 'state'
const OWNER_INDEX = 'ownerKey'
const SEQUENCE_STATE = 'artifactSequence'

const conservativeArtifactGrounding = () => ({
  requested_range_complete: false,
  source_complete: null,
  projection_complete: false,
  coverage: 'unknown',
  complete: false,
  clipped: true
})

const storedArtifactGrounding = (record) => record?.sourceGrounding
  ? normalizeSourceGrounding(record.sourceGrounding, {
      defaultRequested: false,
      defaultSource: null,
      defaultProjection: false
    })
  : conservativeArtifactGrounding()

const DAY_MS = 24 * 60 * 60 * 1000

export const AGENT_TOOL_OUTPUT_DEFAULTS = Object.freeze({
  maxArtifactBytes: 16 * 1024 * 1024,
  maxSessionArtifacts: 64,
  maxSessionBytes: 64 * 1024 * 1024,
  maxGlobalArtifacts: 512,
  maxGlobalBytes: 256 * 1024 * 1024,
  maxAgeMs: 7 * DAY_MS,
  maxTombstones: 1024,
  tombstoneMaxAgeMs: 30 * DAY_MS,
  previewHeadBytes: 24 * 1024,
  previewTailBytes: 24 * 1024,
  maxReadLines: 2000,
  maxReadBytes: 256 * 1024
})

export class AgentToolOutputError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'AgentToolOutputError'
    this.code = code
    this.details = details
    Object.assign(this, details)
  }
}

const artifactError = (code, message, details) => new AgentToolOutputError(code, message, details)

const integerOption = (options, key, fallback, minimum = 1) => {
  if (options?.[key] == null) return fallback
  const value = Number(options[key])
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw artifactError('ARTIFACT_INVALID_ARGUMENT', `${key} must be a safe integer of at least ${minimum}`)
  }
  return value
}

export const normalizeAgentToolOutputLimits = (options = {}) => ({
  maxArtifactBytes: integerOption(options, 'maxArtifactBytes', AGENT_TOOL_OUTPUT_DEFAULTS.maxArtifactBytes),
  maxSessionArtifacts: integerOption(options, 'maxSessionArtifacts', AGENT_TOOL_OUTPUT_DEFAULTS.maxSessionArtifacts),
  maxSessionBytes: integerOption(options, 'maxSessionBytes', AGENT_TOOL_OUTPUT_DEFAULTS.maxSessionBytes),
  maxGlobalArtifacts: integerOption(options, 'maxGlobalArtifacts', AGENT_TOOL_OUTPUT_DEFAULTS.maxGlobalArtifacts),
  maxGlobalBytes: integerOption(options, 'maxGlobalBytes', AGENT_TOOL_OUTPUT_DEFAULTS.maxGlobalBytes),
  maxAgeMs: integerOption(options, 'maxAgeMs', AGENT_TOOL_OUTPUT_DEFAULTS.maxAgeMs),
  maxTombstones: integerOption(options, 'maxTombstones', AGENT_TOOL_OUTPUT_DEFAULTS.maxTombstones),
  tombstoneMaxAgeMs: integerOption(options, 'tombstoneMaxAgeMs', AGENT_TOOL_OUTPUT_DEFAULTS.tombstoneMaxAgeMs),
  previewHeadBytes: integerOption(options, 'previewHeadBytes', AGENT_TOOL_OUTPUT_DEFAULTS.previewHeadBytes, 0),
  previewTailBytes: integerOption(options, 'previewTailBytes', AGENT_TOOL_OUTPUT_DEFAULTS.previewTailBytes, 0),
  maxReadLines: integerOption(options, 'maxReadLines', AGENT_TOOL_OUTPUT_DEFAULTS.maxReadLines),
  maxReadBytes: integerOption(options, 'maxReadBytes', AGENT_TOOL_OUTPUT_DEFAULTS.maxReadBytes)
})

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export const encodeAgentToolOutputText = (value) => textEncoder.encode(String(value ?? ''))

const encodedValue = (value) => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return encodeAgentToolOutputText(value)
}

const decodeAgentToolOutputText = (bytes) => {
  try {
    return textDecoder.decode(bytes)
  } catch {
    throw artifactError('ARTIFACT_CORRUPT', 'Artifact content is not valid UTF-8')
  }
}

export const countAgentToolOutputLines = (value) => {
  const bytes = encodedValue(value)
  let lines = 1
  for (const byte of bytes) if (byte === 0x0a) lines++
  return lines
}

const isContinuationByte = (byte) => (byte & 0xc0) === 0x80

const headBoundary = (bytes, limit) => {
  let end = Math.min(bytes.byteLength, limit)
  while (end > 0 && end < bytes.byteLength && isContinuationByte(bytes[end])) end--
  return end
}

const tailBoundary = (bytes, limit) => {
  let start = Math.max(0, bytes.byteLength - limit)
  while (start < bytes.byteLength && isContinuationByte(bytes[start])) start++
  return start
}

const previewFromBytes = (bytes, { headBytes, tailBytes }) => {
  const totalBytes = bytes.byteLength
  const totalLines = countAgentToolOutputLines(bytes)
  if (totalBytes <= headBytes + tailBytes) {
    const text = decodeAgentToolOutputText(bytes)
    return {
      text,
      head: text,
      tail: '',
      truncated: false,
      totalBytes,
      totalLines,
      headBytes: totalBytes,
      tailBytes: 0,
      omittedBytes: 0
    }
  }

  const headEnd = headBoundary(bytes, headBytes)
  const tailStart = Math.max(headEnd, tailBoundary(bytes, tailBytes))
  const head = decodeAgentToolOutputText(bytes.subarray(0, headEnd))
  const tail = decodeAgentToolOutputText(bytes.subarray(tailStart))
  const omittedBytes = tailStart - headEnd
  const marker = `... ${omittedBytes} UTF-8 bytes omitted ...`
  return {
    text: [head, marker, tail].filter((part) => part !== '').join('\n'),
    head,
    tail,
    truncated: true,
    totalBytes,
    totalLines,
    headBytes: headEnd,
    tailBytes: totalBytes - tailStart,
    omittedBytes
  }
}

export const buildAgentToolOutputPreview = (value, options = {}) => {
  const headBytes = integerOption(options, 'headBytes', AGENT_TOOL_OUTPUT_DEFAULTS.previewHeadBytes, 0)
  const tailBytes = integerOption(options, 'tailBytes', AGENT_TOOL_OUTPUT_DEFAULTS.previewTailBytes, 0)
  return previewFromBytes(encodeAgentToolOutputText(value), { headBytes, tailBytes })
}

const readRangeMode = (range) => {
  const hasLine = range?.lineOffset != null || range?.lineLimit != null
  const hasByte = range?.byteOffset != null || range?.byteLimit != null
  if (hasLine === hasByte) {
    throw artifactError(
      'ARTIFACT_RANGE_INVALID',
      'Specify exactly one complete lineOffset/lineLimit or byteOffset/byteLimit range'
    )
  }
  if (hasLine && (range.lineOffset == null || range.lineLimit == null)) {
    throw artifactError('ARTIFACT_RANGE_INVALID', 'lineOffset and lineLimit must be provided together')
  }
  if (hasByte && (range.byteOffset == null || range.byteLimit == null)) {
    throw artifactError('ARTIFACT_RANGE_INVALID', 'byteOffset and byteLimit must be provided together')
  }
  return hasLine ? 'lines' : 'bytes'
}

const safeRangeInteger = (value, name, minimum) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw artifactError('ARTIFACT_RANGE_INVALID', `${name} must be a safe integer of at least ${minimum}`)
  }
  return number
}

const sliceEncodedAgentToolOutput = (bytes, range, options = {}) => {
  const mode = readRangeMode(range)
  const maxReadLines = integerOption(options, 'maxReadLines', AGENT_TOOL_OUTPUT_DEFAULTS.maxReadLines)
  const maxReadBytes = integerOption(options, 'maxReadBytes', AGENT_TOOL_OUTPUT_DEFAULTS.maxReadBytes)
  const totalBytes = bytes.byteLength

  if (mode === 'lines') {
    const lineOffset = safeRangeInteger(range.lineOffset, 'lineOffset', 1)
    const lineLimit = safeRangeInteger(range.lineLimit, 'lineLimit', 1)
    if (lineLimit > maxReadLines) {
      throw artifactError('ARTIFACT_READ_LIMIT_EXCEEDED', 'lineLimit exceeds the bounded read limit', {
        requested: lineLimit,
        maximum: maxReadLines
      })
    }
    let totalLines = 1
    let byteOffset = lineOffset === 1 ? 0 : null
    let byteEnd = null
    const afterRequestedLine = lineOffset + lineLimit
    for (let index = 0; index < totalBytes; index++) {
      if (bytes[index] !== 0x0a) continue
      totalLines++
      if (totalLines === lineOffset) byteOffset = index + 1
      if (totalLines === afterRequestedLine && byteEnd === null) byteEnd = index
    }
    if (lineOffset > totalLines) {
      throw artifactError('ARTIFACT_RANGE_INVALID', 'lineOffset is past the end of the artifact', {
        lineOffset,
        totalLines
      })
    }

    const firstIndex = lineOffset - 1
    const afterIndex = Math.min(totalLines, firstIndex + lineLimit)
    if (byteEnd === null) byteEnd = totalBytes
    const bytesRead = byteEnd - byteOffset
    if (bytesRead > maxReadBytes) {
      throw artifactError(
        'ARTIFACT_LINE_TOO_LARGE',
        'The requested line range is too large; use byteOffset/byteLimit paging',
        { bytesRead, maximum: maxReadBytes, byteOffset }
      )
    }

    return {
      mode,
      text: decodeAgentToolOutputText(bytes.subarray(byteOffset, byteEnd)),
      totalBytes,
      totalLines,
      lineOffset,
      lineLimit,
      linesRead: afterIndex - firstIndex,
      byteOffset,
      bytesRead,
      eof: afterIndex >= totalLines,
      nextLineOffset: afterIndex + 1,
      nextByteOffset: null
    }
  }

  const byteOffset = safeRangeInteger(range.byteOffset, 'byteOffset', 0)
  const byteLimit = safeRangeInteger(range.byteLimit, 'byteLimit', 1)
  if (byteLimit > maxReadBytes) {
    throw artifactError('ARTIFACT_READ_LIMIT_EXCEEDED', 'byteLimit exceeds the bounded read limit', {
      requested: byteLimit,
      maximum: maxReadBytes
    })
  }
  if (byteOffset > totalBytes) {
    throw artifactError('ARTIFACT_RANGE_INVALID', 'byteOffset is past the end of the artifact', {
      byteOffset,
      totalBytes
    })
  }
  if (byteOffset < totalBytes && isContinuationByte(bytes[byteOffset])) {
    throw artifactError('ARTIFACT_UTF8_BOUNDARY', 'byteOffset must point to a UTF-8 code point boundary', {
      byteOffset
    })
  }
  const totalLines = countAgentToolOutputLines(bytes)

  let byteEnd = byteLimit > totalBytes - byteOffset ? totalBytes : byteOffset + byteLimit
  while (byteEnd > byteOffset && byteEnd < totalBytes && isContinuationByte(bytes[byteEnd])) byteEnd--
  if (byteEnd === byteOffset && byteOffset < totalBytes) {
    throw artifactError(
      'ARTIFACT_BYTE_LIMIT_TOO_SMALL',
      'byteLimit is too small to return the next complete UTF-8 code point',
      { byteOffset, byteLimit }
    )
  }

  return {
    mode,
    text: decodeAgentToolOutputText(bytes.subarray(byteOffset, byteEnd)),
    totalBytes,
    totalLines,
    lineOffset: null,
    byteOffset,
    byteLimit,
    bytesRead: byteEnd - byteOffset,
    eof: byteEnd >= totalBytes,
    nextLineOffset: null,
    nextByteOffset: byteEnd
  }
}

export const sliceAgentToolOutput = (value, range, options = {}) => (
  sliceEncodedAgentToolOutput(encodeAgentToolOutputText(value), range, options)
)

export const sha256AgentToolOutput = async (value) => {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw artifactError('ARTIFACT_CRYPTO_UNAVAILABLE', 'SHA-256 is unavailable in this environment')
  const digest = await subtle.digest('SHA-256', encodedValue(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

let persistenceRequest = null

const requestPersistence = () => {
  if (persistenceRequest || typeof navigator === 'undefined' || !navigator.storage?.persist) return
  persistenceRequest = Promise.resolve(navigator.storage.persist()).catch(() => false)
}

const openDatabase = () => {
  requestPersistence()
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(artifactError('ARTIFACT_STORAGE_UNAVAILABLE', 'Agent tool output storage is unavailable'))
      return
    }
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    let request
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (error) {
      fail(error)
      return
    }
    request.onupgradeneeded = (event) => {
      const database = request.result
      const transaction = request.transaction
      const artifacts = database.objectStoreNames.contains(ARTIFACT_STORE)
        ? transaction.objectStore(ARTIFACT_STORE)
        : database.createObjectStore(ARTIFACT_STORE, { keyPath: 'id' })
      if (!artifacts.indexNames.contains(OWNER_INDEX)) {
        artifacts.createIndex(OWNER_INDEX, 'ownerKey', { unique: false })
      }
      const tombstones = database.objectStoreNames.contains(TOMBSTONE_STORE)
        ? transaction.objectStore(TOMBSTONE_STORE)
        : database.createObjectStore(TOMBSTONE_STORE, { keyPath: 'id' })
      if (!tombstones.indexNames.contains(OWNER_INDEX)) {
        tombstones.createIndex(OWNER_INDEX, 'ownerKey', { unique: false })
      }
      if (!database.objectStoreNames.contains(STATE_STORE)) {
        database.createObjectStore(STATE_STORE, { keyPath: 'key' })
      }
      // V1 artifacts did not retain the upstream source/request grounding.
      // Migrate them conservatively instead of inferring completeness merely
      // because their captured bytes are internally complete.
      if (Number(event?.oldVersion || 0) > 0 && Number(event.oldVersion) < 2) {
        const cursorRequest = artifacts.openCursor()
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result
          if (!cursor) return
          const record = cursor.value
          if (!record.sourceGrounding) {
            record.sourceGrounding = conservativeArtifactGrounding()
            cursor.update(record)
          }
          cursor.continue()
        }
      }
    }
    request.onblocked = () => fail(artifactError(
      'ARTIFACT_STORAGE_BLOCKED',
      'Agent tool output storage upgrade is blocked by another Knote window'
    ))
    request.onerror = () => fail(request.error || new Error('Could not open Agent tool output storage'))
    request.onsuccess = () => {
      const database = request.result
      if (settled) {
        database.close()
        return
      }
      settled = true
      database.onversionchange = () => database.close()
      resolve(database)
    }
  })
}

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error || new Error('Agent tool output request failed'))
})

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onabort = () => reject(transaction.error || new Error('Agent tool output transaction aborted'))
  transaction.onerror = () => reject(transaction.error || new Error('Agent tool output transaction failed'))
})

const runTransaction = async (database, stores, mode, work) => {
  const transaction = database.transaction(stores, mode)
  const done = transactionDone(transaction)
  try {
    const result = await work(transaction)
    await done
    return result
  } catch (error) {
    try { transaction.abort() } catch { /* already complete or aborted */ }
    try { await done } catch { /* preserve the request error */ }
    throw error
  }
}

const withDatabase = async (work) => {
  const database = await openDatabase()
  try {
    return await work(database)
  } finally {
    database.close()
  }
}

const requiredString = (value, name) => {
  if (value == null || String(value) === '') {
    throw artifactError('ARTIFACT_INVALID_ARGUMENT', `${name} is required`)
  }
  return String(value)
}

const normalizeOwner = (value) => {
  const chatKey = requiredString(value?.chatKey, 'chatKey')
  const sessionId = requiredString(value?.sessionId, 'sessionId')
  return { chatKey, sessionId, ownerKey: JSON.stringify([chatKey, sessionId]) }
}

const opaqueArtifactId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const currentTime = (options) => {
  if (options?.now == null) return Date.now()
  const now = Number(options.now)
  if (!Number.isSafeInteger(now) || now < 0) {
    throw artifactError('ARTIFACT_INVALID_ARGUMENT', 'now must be a non-negative safe integer')
  }
  return now
}

const artifactSize = (record) => {
  const value = Number(record?.totalBytes)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

const retentionMetadata = (record) => ({
  id: record?.id,
  chatKey: record?.chatKey,
  sessionId: record?.sessionId,
  ownerKey: record?.ownerKey,
  sequence: record?.sequence,
  createdAt: record?.createdAt,
  expiresAt: record?.expiresAt,
  totalBytes: record?.totalBytes
})

const collectArtifactRetentionMetadata = (store) => new Promise((resolve, reject) => {
  const records = []
  const request = store.openCursor()
  request.onerror = () => reject(request.error || new Error('Agent tool output cursor failed'))
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) {
      resolve(records)
      return
    }
    // A cursor clones at most one inline payload at a time; retain only the
    // small fields used by the cleanup planner before advancing it.
    records.push(retentionMetadata(cursor.value))
    cursor.continue()
  }
})

const artifactOrder = (left, right) => (
  Number(left?.sequence || 0) - Number(right?.sequence || 0) ||
  Number(left?.createdAt || 0) - Number(right?.createdAt || 0) ||
  String(left?.id || '').localeCompare(String(right?.id || ''))
)

const planArtifactCleanup = (recordsValue, limits, now, protectedIds = new Set()) => {
  const records = [...(recordsValue || [])]
  const deleted = new Map()
  const mark = (record, reason) => {
    if (!record || protectedIds.has(record.id) || deleted.has(record.id)) return false
    deleted.set(record.id, { record, reason })
    return true
  }

  for (const record of records) {
    if (Number(record.expiresAt) <= now) mark(record, 'expired')
  }

  const trim = (candidates, maxCount, maxBytes, reason) => {
    let retained = candidates.filter((record) => !deleted.has(record.id)).sort(artifactOrder)
    let bytes = retained.reduce((total, record) => total + artifactSize(record), 0)
    while (retained.length > maxCount || bytes > maxBytes) {
      const candidate = retained.find((record) => !protectedIds.has(record.id))
      if (!candidate || !mark(candidate, reason)) {
        throw artifactError('ARTIFACT_RETENTION_LIMIT', 'Artifact cannot fit within retention limits')
      }
      retained = retained.filter((record) => record.id !== candidate.id)
      bytes -= artifactSize(candidate)
    }
  }

  const ownerKeys = new Set(records.filter((record) => !deleted.has(record.id)).map((record) => record.ownerKey))
  for (const ownerKey of ownerKeys) {
    trim(
      records.filter((record) => record.ownerKey === ownerKey),
      limits.maxSessionArtifacts,
      limits.maxSessionBytes,
      'session_retention'
    )
  }
  trim(records, limits.maxGlobalArtifacts, limits.maxGlobalBytes, 'global_retention')
  return deleted
}

const staleRow = (record, reason, now) => ({
  id: record.id,
  chatKey: record.chatKey,
  sessionId: record.sessionId,
  ownerKey: record.ownerKey,
  staleAt: now,
  sequence: Number(record.sequence || 0),
  reason
})

const applyArtifactCleanup = (transaction, plan, now) => {
  const artifacts = transaction.objectStore(ARTIFACT_STORE)
  const tombstones = transaction.objectStore(TOMBSTONE_STORE)
  for (const { record, reason } of plan.values()) {
    artifacts.delete(record.id)
    tombstones.put(staleRow(record, reason, now))
  }
}

const pruneTombstones = async (transaction, limits, now) => {
  const store = transaction.objectStore(TOMBSTONE_STORE)
  const rows = await requestResult(store.getAll())
  const cutoff = now - limits.tombstoneMaxAgeMs
  let retained = rows.filter((row) => {
    if (Number(row.staleAt || 0) < cutoff) {
      store.delete(row.id)
      return false
    }
    return true
  }).sort((left, right) => (
    Number(left.staleAt || 0) - Number(right.staleAt || 0) || artifactOrder(left, right)
  ))
  while (retained.length > limits.maxTombstones) {
    const row = retained.shift()
    store.delete(row.id)
  }
}

const publicMetadata = (record) => ({
  artifactId: record.id,
  chatKey: record.chatKey,
  sessionId: record.sessionId,
  runId: record.runId,
  callId: record.callId,
  tool: record.tool,
  contentType: record.contentType,
  encoding: 'utf-8',
  totalBytes: record.totalBytes,
  totalLines: record.totalLines,
  sha256: record.sha256,
  captureComplete: record.captureComplete === true,
  sourceGrounding: storedArtifactGrounding(record),
  sourceContinuation: record?.sourceContinuation && typeof record.sourceContinuation === 'object'
    ? record.sourceContinuation
    : null,
  sourceId: typeof record?.sourceId === 'string' && record.sourceId ? record.sourceId : null,
  createdAt: record.createdAt,
  expiresAt: record.expiresAt
})

const storedBytes = (record) => {
  if (!(record?.bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(record?.bytes)) {
    throw artifactError('ARTIFACT_CORRUPT', 'Artifact bytes are missing')
  }
  const bytes = encodedValue(record.bytes)
  if (
    record?.captureComplete !== true ||
    bytes.byteLength !== record.totalBytes ||
    countAgentToolOutputLines(bytes) !== record.totalLines
  ) {
    throw artifactError('ARTIFACT_CORRUPT', 'Artifact metadata does not match its stored content')
  }
  return bytes
}

export const storeAgentToolOutputArtifact = async (input, options = {}) => {
  const owner = normalizeOwner(input)
  if (typeof input?.text !== 'string') {
    throw artifactError('ARTIFACT_INVALID_ARGUMENT', 'text must be a string')
  }
  const runId = requiredString(input.runId, 'runId')
  const callId = requiredString(input.callId, 'callId')
  const tool = requiredString(input.tool, 'tool')
  const contentType = input.contentType == null
    ? 'text/plain; charset=utf-8'
    : requiredString(input.contentType, 'contentType')
  const limits = normalizeAgentToolOutputLimits(options)
  const now = currentTime(options)
  const bytes = encodeAgentToolOutputText(input.text)
  const acceptedBytes = Math.min(limits.maxArtifactBytes, limits.maxSessionBytes, limits.maxGlobalBytes)
  if (bytes.byteLength > acceptedBytes) {
    throw artifactError('ARTIFACT_TOO_LARGE', 'Tool output exceeds the maximum accepted artifact size', {
      totalBytes: bytes.byteLength,
      maxArtifactBytes: acceptedBytes
    })
  }

  const id = opaqueArtifactId()
  const sha256 = await sha256AgentToolOutput(bytes)
  const baseRecord = {
    id,
    ...owner,
    runId,
    callId,
    tool,
    contentType,
    encoding: 'utf-8',
    totalBytes: bytes.byteLength,
    totalLines: countAgentToolOutputLines(bytes),
    sha256,
    captureComplete: true,
    sourceGrounding: input?.grounding && typeof input.grounding === 'object'
      ? normalizeSourceGrounding(input.grounding, {
          defaultRequested: false,
          defaultSource: null,
          defaultProjection: false,
          legacySourceComplete: true
        })
      : conservativeArtifactGrounding(),
    sourceContinuation: input?.continuation && typeof input.continuation === 'object'
      ? JSON.parse(JSON.stringify(input.continuation))
      : null,
    sourceId: typeof input?.sourceId === 'string' && input.sourceId
      ? input.sourceId.slice(0, 4096)
      : null,
    createdAt: now,
    expiresAt: Math.min(Number.MAX_SAFE_INTEGER, now + limits.maxAgeMs),
    bytes
  }

  const stored = await withDatabase((database) => runTransaction(
    database,
    [ARTIFACT_STORE, TOMBSTONE_STORE, STATE_STORE],
    'readwrite',
    async (transaction) => {
      const state = transaction.objectStore(STATE_STORE)
      const previous = await requestResult(state.get(SEQUENCE_STATE))
      const sequence = Number(previous?.value || 0) + 1
      if (!Number.isSafeInteger(sequence)) {
        throw artifactError('ARTIFACT_SEQUENCE_EXHAUSTED', 'Artifact sequence is exhausted')
      }
      state.put({ key: SEQUENCE_STATE, value: sequence })
      const record = { ...baseRecord, sequence }
      const artifacts = transaction.objectStore(ARTIFACT_STORE)
      const existing = await collectArtifactRetentionMetadata(artifacts)
      const cleanup = planArtifactCleanup([...existing, retentionMetadata(record)], limits, now, new Set([id]))
      applyArtifactCleanup(transaction, cleanup, now)
      await requestResult(artifacts.add(record))
      await pruneTombstones(transaction, limits, now)
      return { record, cleaned: cleanup.size }
    }
  ))

  // Previewing happens only after the complete byte artifact has committed.
  const preview = previewFromBytes(bytes, {
    headBytes: limits.previewHeadBytes,
    tailBytes: limits.previewTailBytes
  })
  return { ...publicMetadata(stored.record), preview, cleaned: stored.cleaned }
}

const lookupOwnedArtifact = async (artifactId, owner, now, limits) => withDatabase((database) => runTransaction(
  database,
  [ARTIFACT_STORE, TOMBSTONE_STORE],
  'readwrite',
  async (transaction) => {
    const artifacts = transaction.objectStore(ARTIFACT_STORE)
    const tombstones = transaction.objectStore(TOMBSTONE_STORE)
    const record = await requestResult(artifacts.get(artifactId))
    if (record) {
      if (record.chatKey !== owner.chatKey || record.sessionId !== owner.sessionId) return { status: 'owner' }
      if (Number(record.expiresAt) <= now) {
        artifacts.delete(artifactId)
        tombstones.put(staleRow(record, 'expired', now))
        await pruneTombstones(transaction, limits, now)
        return { status: 'stale', reason: 'expired' }
      }
      return { status: 'found', record }
    }
    const stale = await requestResult(tombstones.get(artifactId))
    if (!stale) return { status: 'missing' }
    if (stale.chatKey !== owner.chatKey || stale.sessionId !== owner.sessionId) return { status: 'owner' }
    return { status: 'stale', reason: stale.reason }
  }
))

const throwLookupError = (lookup, artifactId) => {
  if (lookup.status === 'owner') {
    throw artifactError('ARTIFACT_OWNER_MISMATCH', 'Artifact does not belong to this chat session', { artifactId })
  }
  if (lookup.status === 'stale') {
    throw artifactError('ARTIFACT_STALE', 'Artifact is stale and is no longer retained', {
      artifactId,
      reason: lookup.reason || 'retention'
    })
  }
  if (lookup.status === 'missing') {
    throw artifactError('ARTIFACT_MISSING', 'Artifact does not exist', { artifactId })
  }
}

export const readAgentToolOutputArtifact = async (request, options = {}) => {
  const owner = normalizeOwner(request)
  const artifactId = requiredString(request?.artifactId, 'artifactId')
  readRangeMode(request)
  const limits = normalizeAgentToolOutputLimits(options)
  const lookup = await lookupOwnedArtifact(artifactId, owner, currentTime(options), limits)
  if (lookup.status !== 'found') throwLookupError(lookup, artifactId)
  const bytes = storedBytes(lookup.record)
  const page = sliceEncodedAgentToolOutput(bytes, request, options)
  return { ...publicMetadata(lookup.record), ...page }
}

export const deleteAgentToolOutputArtifact = async (request, options = {}) => {
  const owner = normalizeOwner(request)
  const artifactId = requiredString(request?.artifactId, 'artifactId')
  const now = currentTime(options)
  const limits = normalizeAgentToolOutputLimits(options)
  const result = await withDatabase((database) => runTransaction(
    database,
    [ARTIFACT_STORE, TOMBSTONE_STORE],
    'readwrite',
    async (transaction) => {
      const artifacts = transaction.objectStore(ARTIFACT_STORE)
      const tombstones = transaction.objectStore(TOMBSTONE_STORE)
      const record = await requestResult(artifacts.get(artifactId))
      if (!record) {
        const stale = await requestResult(tombstones.get(artifactId))
        if (!stale) return { status: 'missing' }
        if (stale.chatKey !== owner.chatKey || stale.sessionId !== owner.sessionId) return { status: 'owner' }
        return { status: 'stale', reason: stale.reason }
      }
      if (record.chatKey !== owner.chatKey || record.sessionId !== owner.sessionId) return { status: 'owner' }
      artifacts.delete(artifactId)
      tombstones.put(staleRow(record, 'deleted', now))
      await pruneTombstones(transaction, limits, now)
      return { status: 'deleted' }
    }
  ))
  if (result.status !== 'deleted') throwLookupError(result, artifactId)
  return true
}

export const deleteAgentToolOutputSession = async (request, options = {}) => {
  const owner = normalizeOwner(request)
  const now = currentTime(options)
  const limits = normalizeAgentToolOutputLimits(options)
  return withDatabase((database) => runTransaction(
    database,
    [ARTIFACT_STORE, TOMBSTONE_STORE],
    'readwrite',
    async (transaction) => {
      const artifacts = transaction.objectStore(ARTIFACT_STORE)
      const tombstones = transaction.objectStore(TOMBSTONE_STORE)
      const rows = await requestResult(artifacts.index(OWNER_INDEX).getAll(owner.ownerKey))
      let deleted = 0
      for (const record of rows) {
        if (record.chatKey !== owner.chatKey || record.sessionId !== owner.sessionId) continue
        artifacts.delete(record.id)
        tombstones.put(staleRow(record, 'session_deleted', now))
        deleted++
      }
      await pruneTombstones(transaction, limits, now)
      return deleted
    }
  ))
}

export const cleanupAgentToolOutputArtifacts = async (options = {}) => {
  const limits = normalizeAgentToolOutputLimits(options)
  const now = currentTime(options)
  return withDatabase((database) => runTransaction(
    database,
    [ARTIFACT_STORE, TOMBSTONE_STORE],
    'readwrite',
    async (transaction) => {
      const artifacts = transaction.objectStore(ARTIFACT_STORE)
      const records = await collectArtifactRetentionMetadata(artifacts)
      const cleanup = planArtifactCleanup(records, limits, now)
      applyArtifactCleanup(transaction, cleanup, now)
      await pruneTombstones(transaction, limits, now)
      const retained = records.filter((record) => !cleanup.has(record.id))
      return {
        deleted: cleanup.size,
        remainingArtifacts: retained.length,
        remainingBytes: retained.reduce((total, record) => total + artifactSize(record), 0)
      }
    }
  ))
}
