import { Capacitor } from '@capacitor/core'
import { KnoteAndroid } from '@knote/capacitor-android'
import { addSnapshot, copySnapshots } from './snapshots.js'

const SAF_DIR_HANDLE = Symbol('SafDirHandle')
const SAF_FILE_HANDLE = Symbol('SafFileHandle')
const GRANT_ID = /^[A-Za-z0-9_-]{43}$/
const MAX_WRITE_BYTES = 32 * 1024 * 1024
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8')

let safPlugin = KnoteAndroid
let safSnapshotWriter = addSnapshot
let safSnapshotCopier = copySnapshots
const activeGrantOperations = new Map()
const grantReleasePromises = new Map()

export const isSafAndroidApp = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'

export const setSafPluginAdapter = (adapter = KnoteAndroid) => {
  safPlugin = adapter
}

export const setSafSnapshotAdapter = (writer = addSnapshot, copier = copySnapshots) => {
  safSnapshotWriter = writer
  safSnapshotCopier = copier
}

const namedError = (name, message, code = '') => {
  const error = new Error(message)
  error.name = name
  if (code) error.code = code
  return error
}

const pluginErrorCode = (error) => String(error?.code || error?.data?.code || '')

const mapPluginError = (error) => {
  const code = pluginErrorCode(error)
  if (code === 'PICKER_CANCELLED') return namedError('AbortError', 'Document picker was cancelled', code)
  if (code === 'NOT_FOUND') return namedError('NotFoundError', error?.message || 'Document was not found', code)
  if (code === 'TYPE_MISMATCH') return namedError('TypeMismatchError', error?.message || 'Document type mismatch', code)
  if (code === 'TARGET_EXISTS') return namedError('InvalidModificationError', error?.message || 'Destination already exists', code)
  if (code === 'ENTRY_CHANGED') return namedError('InvalidStateError', error?.message || 'Document entry changed; refresh the folder', code)
  if (code === 'BAD_PATH' || code === 'BAD_GRANT') return namedError('SecurityError', error?.message || 'Invalid SAF capability', code)
  if (code === 'GRANT_REVOKED' || code === 'READ_ONLY') return namedError('NotAllowedError', error?.message || 'SAF access is unavailable', code)
  if (code === 'UNSUPPORTED_OPERATION') return namedError('NotSupportedError', error?.message || 'Document provider does not support this operation', code)
  if (code === 'WRITE_COMMIT_UNCERTAIN' || code === 'MUTATION_COMMIT_UNCERTAIN') {
    return namedError('OperationError', error?.message || 'Document provider result is uncertain', code)
  }
  if (error instanceof Error) return error
  return namedError('OperationError', String(error || 'Android document operation failed'), code)
}

const finishGrantOperation = (grantId) => {
  const state = activeGrantOperations.get(grantId)
  if (!state) return
  state.count -= 1
  if (state.count > 0) return
  activeGrantOperations.delete(grantId)
  for (const resolve of state.waiters) resolve()
}

const waitForGrantOperations = (grantId) => {
  const state = activeGrantOperations.get(grantId)
  if (!state || state.count === 0) return Promise.resolve()
  return new Promise((resolve) => state.waiters.add(resolve))
}

const invoke = async (method, options) => {
  const grantId = method !== 'releaseGrant' && GRANT_ID.test(String(options?.grantId || ''))
    ? String(options.grantId)
    : ''
  if (grantId && grantReleasePromises.has(grantId)) {
    throw namedError('NotAllowedError', 'SAF grant is being released', 'GRANT_REVOKED')
  }
  if (grantId) {
    const state = activeGrantOperations.get(grantId) || { count: 0, waiters: new Set() }
    state.count += 1
    activeGrantOperations.set(grantId, state)
  }
  try {
    const operation = safPlugin?.[method]
    if (typeof operation !== 'function') throw new Error(`KnoteAndroid.${method} is unavailable`)
    return await operation.call(safPlugin, options)
  } catch (error) {
    throw mapPluginError(error)
  } finally {
    if (grantId) finishGrantOperation(grantId)
  }
}

const hasUnpairedSurrogate = (value) => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

const forbiddenCodePoint = (codePoint) => (
  codePoint <= 0x1f ||
  (codePoint >= 0x7f && codePoint <= 0x9f) ||
  codePoint === 0x061c ||
  codePoint === 0x200e ||
  codePoint === 0x200f ||
  (codePoint >= 0x2028 && codePoint <= 0x202e) ||
  (codePoint >= 0x2066 && codePoint <= 0x206f) ||
  codePoint === 0xfeff ||
  codePoint === 0xfffd
)

const assertSafName = (input, label = 'SAF child name') => {
  if (typeof input !== 'string' || hasUnpairedSurrogate(input) || input.normalize('NFC') !== input) {
    throw new TypeError(`invalid ${label}`)
  }
  if (!input || input === '.' || input === '..' || input.includes('/') || input.includes('\\')) {
    throw new TypeError(`invalid ${label}`)
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input) || [...input].length > 255) {
    throw new TypeError(`invalid ${label}`)
  }
  for (const character of input) {
    if (forbiddenCodePoint(character.codePointAt(0))) throw new TypeError(`invalid ${label}`)
  }
  return input
}

const assertSafPath = (input, allowEmpty = true) => {
  if (typeof input !== 'string' || hasUnpairedSurrogate(input) || input.normalize('NFC') !== input) {
    throw new TypeError('invalid SAF relative path')
  }
  if (!input) {
    if (allowEmpty) return ''
    throw new TypeError('invalid SAF relative path')
  }
  const segments = input.split('/')
  if (segments.length > 64 || [...input].length > 1024) throw new TypeError('invalid SAF relative path')
  for (const segment of segments) assertSafName(segment, 'SAF path segment')
  return segments.join('/')
}

const joinPath = (parent, name) => {
  const safeParent = assertSafPath(parent)
  const safeName = assertSafName(name)
  return safeParent ? `${safeParent}/${safeName}` : safeName
}

const parentPath = (path) => {
  const segments = assertSafPath(path, false).split('/')
  segments.pop()
  return segments.join('/')
}

const safeDisplayName = (value, fallback) => {
  const normalized = typeof value === 'string' && !hasUnpairedSurrogate(value) ? value.normalize('NFC') : ''
  const cleaned = [...normalized].map((character) => {
    const codePoint = character.codePointAt(0)
    if (forbiddenCodePoint(codePoint)) return ' '
    return character === '/' || character === '\\' ? '_' : character
  }).join('').trim()
  return cleaned.slice(0, 255) || fallback
}

const assertGrant = (value, expectedKind = '') => {
  const grant = value && typeof value === 'object' ? value : null
  if (!grant || !GRANT_ID.test(String(grant.grantId || ''))) throw new TypeError('invalid SAF grant')
  if (grant.kind !== 'tree' && grant.kind !== 'document') throw new TypeError('invalid SAF grant kind')
  if (expectedKind && grant.kind !== expectedKind) throw namedError('TypeMismatchError', `expected a ${expectedKind} grant`)
  return {
    grantId: grant.grantId,
    kind: grant.kind,
    displayName: safeDisplayName(grant.displayName, grant.kind === 'tree' ? 'Folder' : 'Document'),
    readable: grant.readable === true,
    writable: grant.writable === true,
    persisted: grant.persisted === true,
    valid: grant.valid === true
  }
}

const validateMetadata = (raw, expectedPath, expectedKind = '') => {
  const path = assertSafPath(String(raw?.relativePath ?? ''))
  if (path !== assertSafPath(expectedPath)) throw new TypeError('SAF provider returned an unexpected path')
  const kind = raw?.kind
  if (kind !== 'file' && kind !== 'directory') throw new TypeError('SAF provider returned an invalid entry kind')
  if (expectedKind && kind !== expectedKind) throw namedError('TypeMismatchError', `expected ${expectedKind}: ${path || '(grant root)'}`)
  const expectedName = path ? path.split('/').pop() : ''
  const entryId = String(raw?.entryId || '')
  if ((path && !GRANT_ID.test(entryId)) || (!path && entryId)) {
    throw new TypeError('SAF provider returned an invalid entry capability')
  }
  const name = expectedName || safeDisplayName(raw?.name, kind === 'directory' ? 'Folder' : 'Document')
  if (expectedName && assertSafName(String(raw?.name || '')) !== expectedName) {
    throw new TypeError('SAF provider returned an unexpected entry name')
  }
  return {
    entryId,
    name,
    relativePath: path,
    kind,
    mimeType: typeof raw?.mimeType === 'string' ? raw.mimeType : '',
    size: Number.isFinite(Number(raw?.size)) && Number(raw.size) >= 0 ? Number(raw.size) : 0,
    lastModified: Number.isFinite(Number(raw?.lastModified)) && Number(raw.lastModified) > 0 ? Number(raw.lastModified) : 0,
    readable: raw?.readable === true,
    writable: raw?.writable === true,
    contentWritable: raw?.contentWritable === true
  }
}

const safIdentity = (grant, path) => {
  const encodedPath = assertSafPath(path).split('/').filter(Boolean).map(encodeURIComponent).join('/')
  return `android-saf:${grant.kind}:v1:${grant.grantId}${encodedPath ? `/${encodedPath}` : ''}`
}

const isMarkdownPath = (value) => /\.(?:md|markdown)$/i.test(String(value || ''))

const mimeForPath = (value) => {
  const extension = String(value || '').split('.').pop().toLowerCase()
  return ({
    md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })[extension] || 'application/octet-stream'
}

const bytesToBase64 = (value) => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0)
  if (bytes.byteLength > MAX_WRITE_BYTES) throw new TypeError('Android SAF writes are limited to 32 MiB')
  let binary = ''
  const block = 0x8000
  for (let index = 0; index < bytes.length; index += block) {
    binary += String.fromCharCode(...bytes.subarray(index, index + block))
  }
  return btoa(binary)
}

const base64ToBytes = (value) => {
  const encoded = String(value || '')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new TypeError('SAF provider returned invalid base64 data')
  }
  const binary = atob(encoded)
  if (binary.length > MAX_WRITE_BYTES) throw new TypeError('SAF provider returned an oversized document')
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const normalizeWriteChunk = async (chunk) => {
  if (typeof chunk === 'string') return textEncoder.encode(chunk)
  if (chunk instanceof Blob) return new Uint8Array(await chunk.arrayBuffer())
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk.slice(0))
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength))
  throw new TypeError('SAF file writes require text, Blob, ArrayBuffer, or typed-array data')
}

const concatBytes = (chunks) => {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  if (size > MAX_WRITE_BYTES) throw new TypeError('Android SAF writes are limited to 32 MiB')
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

const refreshGrant = async (grant) => {
  const restored = assertGrant(await invoke('restoreGrant', { grantId: grant.grantId }), grant.kind)
  Object.assign(grant, restored)
  return grant
}

const permissionFor = async (grant, mode = 'read') => {
  try {
    await refreshGrant(grant)
    return grant.readable && (mode !== 'readwrite' || grant.writable) ? 'granted' : 'denied'
  } catch (error) {
    if (['BAD_GRANT', 'GRANT_REVOKED', 'NOT_FOUND', 'READ_ONLY'].includes(String(error?.code || ''))) return 'denied'
    throw error
  }
}

const filePermissionFor = async (handle, mode = 'read') => {
  try {
    await refreshGrant(handle._grant)
    const metadata = validateMetadata(await invoke('stat', {
      grantId: handle._grant.grantId,
      relativePath: handle._path,
      entryId: handle._entryId || undefined
    }), handle._path, 'file')
    handle._entryId = metadata.entryId
    handle._name = handle._path ? handle._path.split('/').pop() : safeDisplayName(metadata.name, handle._name)
    handle._contentWritable = metadata.contentWritable
    return metadata.readable && (mode !== 'readwrite' || metadata.contentWritable) ? 'granted' : 'denied'
  } catch (error) {
    if (['BAD_GRANT', 'GRANT_REVOKED', 'NOT_FOUND', 'READ_ONLY'].includes(String(error?.code || ''))) return 'denied'
    throw error
  }
}

const archiveMarkdown = async (grant, path, entryId, label = 'before-delete', traversal = { remaining: 2_048 }, depth = 0) => {
  if (traversal.remaining-- <= 0 || depth > 64) {
    throw namedError('NotSupportedError', 'The SAF tree is too large to archive safely before deletion')
  }
  const metadata = validateMetadata(await invoke('stat', {
    grantId: grant.grantId,
    relativePath: path,
    entryId: entryId || undefined
  }), path)
  if (metadata.kind === 'file') {
    if (!isMarkdownPath(path || metadata.name)) return
    const result = await invoke('readFile', { grantId: grant.grantId, relativePath: path, entryId: metadata.entryId || undefined })
    validateMetadata(result?.metadata, path, 'file')
    await safSnapshotWriter(safIdentity(grant, path), textDecoder.decode(base64ToBytes(result?.data)), Date.now(), label)
    return
  }
  const result = await invoke('list', { grantId: grant.grantId, relativePath: path, entryId: metadata.entryId || undefined })
  if (!Array.isArray(result?.entries)) throw new TypeError('SAF provider returned an invalid directory listing')
  for (const entry of result.entries) {
    const name = assertSafName(String(entry?.name || ''))
    const childPath = joinPath(path, name)
    const childMetadata = validateMetadata(entry, childPath)
    await archiveMarkdown(grant, childPath, childMetadata.entryId, label, traversal, depth + 1)
  }
}

const copyMarkdownHistoryTree = async (handle, destinationPath, traversal = { remaining: 2_048 }, depth = 0) => {
  if (traversal.remaining-- <= 0 || depth > 64) {
    throw namedError('NotSupportedError', 'The SAF tree is too large to migrate history safely')
  }
  if (handle.kind === 'file') {
    if (isMarkdownPath(handle._path || handle.name)) {
      await safSnapshotCopier(handle._knoteIdentity, safIdentity(handle._grant, destinationPath))
    }
    return
  }
  for await (const [, child] of handle.entries()) {
    await copyMarkdownHistoryTree(child, joinPath(destinationPath, child.name), traversal, depth + 1)
  }
}

export class SafFileHandle {
  constructor(grantValue, path = '', metadata = null) {
    this.kind = 'file'
    this._grant = assertGrant(grantValue)
    this._path = assertSafPath(path)
    if (this._grant.kind === 'document' && this._path) throw new TypeError('document grants only expose their root')
    if (this._grant.kind === 'tree' && !this._path) throw new TypeError('tree file handles require a child path')
    this._name = this._path ? this._path.split('/').pop() : safeDisplayName(metadata?.name || this._grant.displayName, 'Document')
    this._entryId = String(metadata?.entryId || '')
    if (this._grant.kind === 'tree' && !GRANT_ID.test(this._entryId)) throw new TypeError('tree file handle requires an entry capability')
    this._contentWritable = metadata?.contentWritable === true
    this._knoteSafGrantId = this._grant.grantId
    this._knoteSafGrantKind = this._grant.kind
    this[SAF_FILE_HANDLE] = true
  }

  get name() { return this._name }
  get _knoteIdentity() { return safIdentity(this._grant, this._path) }

  async getFile() {
    const result = await invoke('readFile', {
      grantId: this._grant.grantId,
      relativePath: this._path,
      entryId: this._entryId || undefined
    })
    const metadata = validateMetadata(result?.metadata, this._path, 'file')
    const bytes = base64ToBytes(result?.data)
    this._entryId = metadata.entryId
    this._contentWritable = metadata.contentWritable
    this._name = this._path ? this._path.split('/').pop() : safeDisplayName(metadata.name, this._name)
    return new File([bytes], this.name, {
      type: metadata.mimeType || mimeForPath(this.name),
      lastModified: metadata.lastModified
    })
  }

  async createWritable(options = {}) {
    if (options?.keepExistingData === true) {
      throw namedError('NotSupportedError', 'Android SAF writable streams replace the complete file')
    }
    const grantId = this._grant.grantId
    const path = this._path
    const entryId = this._entryId
    const chunks = []
    let byteLength = 0
    let state = 'open'
    const assertOpen = () => {
      if (state !== 'open') throw namedError('InvalidStateError', 'SAF writable stream is no longer open')
    }
    return {
      write: async (chunk) => {
        assertOpen()
        const bytes = await normalizeWriteChunk(chunk)
        if (bytes.byteLength > MAX_WRITE_BYTES - byteLength) {
          throw new TypeError('Android SAF writes are limited to 32 MiB')
        }
        chunks.push(bytes)
        byteLength += bytes.byteLength
      },
      close: async () => {
        assertOpen()
        state = 'closing'
        const data = bytesToBase64(concatBytes(chunks))
        try {
          const metadata = validateMetadata(await invoke('writeFile', {
            grantId,
            relativePath: path,
            entryId: entryId || undefined,
            data
          }), path, 'file')
          this._entryId = metadata.entryId
          this._contentWritable = metadata.contentWritable
          state = 'closed'
        } catch (error) {
          state = 'failed'
          throw error
        }
      },
      abort: async () => {
        assertOpen()
        chunks.length = 0
        byteLength = 0
        state = 'aborted'
      }
    }
  }

  async queryPermission(options = {}) { return filePermissionFor(this, options.mode) }
  async requestPermission(options = {}) { return filePermissionFor(this, options.mode) }

  async move(destinationOrName, requestedName) {
    if (this._grant.kind !== 'tree') throw namedError('NotSupportedError', 'A standalone document cannot be renamed or moved')
    const destination = destinationOrName?.[SAF_DIR_HANDLE] === true ? destinationOrName : null
    const name = destination ? (requestedName == null ? this.name : requestedName) : destinationOrName
    const safeName = assertSafName(name, 'SAF destination name')
    if (destination) {
      if (destination._grant.grantId !== this._grant.grantId) throw namedError('NotSupportedError', 'SAF moves must stay within one granted tree')
      if (safeName !== this.name) throw namedError('NotSupportedError', 'Rename and move must be separate SAF operations')
      const targetPath = joinPath(destination._path, this.name)
      await archiveMarkdown(this._grant, this._path, this._entryId, 'before-move')
      await copyMarkdownHistoryTree(this, targetPath)
      const metadata = validateMetadata(await invoke('move', {
        grantId: this._grant.grantId,
        relativePath: this._path,
        destinationPath: destination._path,
        entryId: this._entryId,
        destinationEntryId: destination._entryId || undefined
      }), targetPath, 'file')
      this._path = metadata.relativePath
      this._name = metadata.name
      this._entryId = metadata.entryId
      return
    }
    const targetPath = joinPath(parentPath(this._path), safeName)
    await archiveMarkdown(this._grant, this._path, this._entryId, 'before-rename')
    await copyMarkdownHistoryTree(this, targetPath)
    const metadata = validateMetadata(await invoke('rename', {
      grantId: this._grant.grantId,
      relativePath: this._path,
      entryId: this._entryId,
      newName: safeName
    }), targetPath, 'file')
    this._path = metadata.relativePath
    this._name = metadata.name
    this._entryId = metadata.entryId
  }
}

export class SafDirHandle {
  constructor(grantValue, path = '', metadata = null) {
    this.kind = 'directory'
    this._grant = assertGrant(grantValue, 'tree')
    this._path = assertSafPath(path)
    this.name = this._path ? this._path.split('/').pop() : safeDisplayName(metadata?.name || this._grant.displayName, 'Folder')
    this._entryId = String(metadata?.entryId || '')
    if (this._path && !GRANT_ID.test(this._entryId)) throw new TypeError('tree directory handle requires an entry capability')
    this._knoteSafGrantId = this._grant.grantId
    this._knoteSafGrantKind = this._grant.kind
    this[SAF_DIR_HANDLE] = true
  }

  get _knoteIdentity() { return safIdentity(this._grant, this._path) }

  async *entries() {
    const result = await invoke('list', {
      grantId: this._grant.grantId,
      relativePath: this._path,
      entryId: this._entryId || undefined
    })
    if (!Array.isArray(result?.entries)) throw new TypeError('SAF provider returned an invalid directory listing')
    for (const raw of result.entries) {
      const name = assertSafName(String(raw?.name || ''))
      const childPath = joinPath(this._path, name)
      const metadata = validateMetadata(raw, childPath)
      yield [name, metadata.kind === 'directory'
        ? new SafDirHandle(this._grant, childPath, metadata)
        : new SafFileHandle(this._grant, childPath, metadata)]
    }
  }

  async getFileHandle(name, options = {}) {
    const path = joinPath(this._path, name)
    let metadata
    try {
      metadata = validateMetadata(await invoke('stat', {
        grantId: this._grant.grantId,
        relativePath: path,
        parentEntryId: this._entryId || undefined
      }), path)
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error
    }
    if (!metadata) {
      if (!options.create) throw namedError('NotFoundError', `file not found: ${path}`)
      metadata = validateMetadata(await invoke('createFile', {
        grantId: this._grant.grantId,
        relativePath: path,
        parentEntryId: this._entryId || undefined,
        mimeType: mimeForPath(path)
      }), path, 'file')
    } else if (metadata.kind !== 'file') {
      throw namedError('TypeMismatchError', `not a file: ${path}`)
    }
    return new SafFileHandle(this._grant, path, metadata)
  }

  async getDirectoryHandle(name, options = {}) {
    const path = joinPath(this._path, name)
    let metadata
    try {
      metadata = validateMetadata(await invoke('stat', {
        grantId: this._grant.grantId,
        relativePath: path,
        parentEntryId: this._entryId || undefined
      }), path)
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error
    }
    if (!metadata) {
      if (!options.create) throw namedError('NotFoundError', `directory not found: ${path}`)
      metadata = validateMetadata(await invoke('createDirectory', {
        grantId: this._grant.grantId,
        relativePath: path,
        parentEntryId: this._entryId || undefined
      }), path, 'directory')
    } else if (metadata.kind !== 'directory') {
      throw namedError('TypeMismatchError', `not a directory: ${path}`)
    }
    return new SafDirHandle(this._grant, path, metadata)
  }

  async removeEntry(name, options = {}) {
    const path = joinPath(this._path, name)
    let metadata
    try {
      metadata = validateMetadata(await invoke('stat', {
        grantId: this._grant.grantId,
        relativePath: path,
        parentEntryId: this._entryId || undefined
      }), path)
    } catch (error) {
      if (error?.name === 'NotFoundError') return
      throw error
    }
    if (metadata.kind === 'directory' && options.recursive !== true) {
      throw namedError('InvalidModificationError', 'recursive is required for directory deletion')
    }
    await archiveMarkdown(this._grant, path, metadata.entryId)
    await invoke('delete', {
      grantId: this._grant.grantId,
      relativePath: path,
      entryId: metadata.entryId,
      recursive: metadata.kind === 'directory'
    })
  }

  async queryPermission(options = {}) { return permissionFor(this._grant, options.mode) }
  async requestPermission(options = {}) { return permissionFor(this._grant, options.mode) }

  async move(destinationOrName, requestedName) {
    if (!this._path) throw namedError('NotSupportedError', 'The granted tree root cannot be renamed or moved')
    const destination = destinationOrName?.[SAF_DIR_HANDLE] === true ? destinationOrName : null
    const name = destination ? (requestedName == null ? this.name : requestedName) : destinationOrName
    const safeName = assertSafName(name, 'SAF destination name')
    if (destination) {
      if (destination._grant.grantId !== this._grant.grantId) throw namedError('NotSupportedError', 'SAF moves must stay within one granted tree')
      if (safeName !== this.name) throw namedError('NotSupportedError', 'Rename and move must be separate SAF operations')
      const targetPath = joinPath(destination._path, this.name)
      await archiveMarkdown(this._grant, this._path, this._entryId, 'before-move')
      await copyMarkdownHistoryTree(this, targetPath)
      const metadata = validateMetadata(await invoke('move', {
        grantId: this._grant.grantId,
        relativePath: this._path,
        destinationPath: destination._path,
        entryId: this._entryId,
        destinationEntryId: destination._entryId || undefined
      }), targetPath, 'directory')
      this._path = metadata.relativePath
      this.name = metadata.name
      this._entryId = metadata.entryId
      return
    }
    const targetPath = joinPath(parentPath(this._path), safeName)
    await archiveMarkdown(this._grant, this._path, this._entryId, 'before-rename')
    await copyMarkdownHistoryTree(this, targetPath)
    const metadata = validateMetadata(await invoke('rename', {
      grantId: this._grant.grantId,
      relativePath: this._path,
      entryId: this._entryId,
      newName: safeName
    }), targetPath, 'directory')
    this._path = metadata.relativePath
    this.name = metadata.name
    this._entryId = metadata.entryId
  }
}

export const openSafGrant = async (grantValue) => {
  const grant = assertGrant(grantValue)
  if (!grant.valid || !grant.readable) throw namedError('NotAllowedError', 'SAF grant is no longer readable')
  if (grant.kind === 'tree') return new SafDirHandle(grant)
  const metadata = validateMetadata(await invoke('stat', { grantId: grant.grantId, relativePath: '' }), '', 'file')
  return new SafFileHandle(grant, '', metadata)
}

export const pickSafDocument = async (options = {}) => openSafGrant(await invoke('pickDocument', {
  mimeTypes: Array.isArray(options.mimeTypes) ? options.mimeTypes : undefined,
  writable: options.writable !== false
}))

export const createSafDocument = async (suggestedName, mimeType = mimeForPath(suggestedName)) => {
  const safeName = assertSafName(String(suggestedName || ''), 'suggested document name')
  return openSafGrant(await invoke('createDocument', { suggestedName: safeName, mimeType }))
}

export const pickSafTree = async (options = {}) => openSafGrant(await invoke('pickTree', {
  writable: options.writable !== false
}))

export const listSafGrants = async () => {
  const result = await invoke('listGrants')
  if (!Array.isArray(result?.grants)) throw new TypeError('KnoteAndroid returned an invalid grant list')
  return result.grants.map((grant) => assertGrant(grant))
}

export const restoreSafGrant = async (grantId) => {
  if (!GRANT_ID.test(String(grantId || ''))) throw new TypeError('invalid SAF grant identifier')
  return openSafGrant(await invoke('restoreGrant', { grantId }))
}

export const releaseSafGrant = async (grantId) => {
  if (!GRANT_ID.test(String(grantId || ''))) throw new TypeError('invalid SAF grant identifier')
  const existing = grantReleasePromises.get(grantId)
  if (existing) return existing
  const release = (async () => {
    await waitForGrantOperations(grantId)
    await invoke('releaseGrant', { grantId })
  })()
  grantReleasePromises.set(grantId, release)
  try { await release } finally {
    if (grantReleasePromises.get(grantId) === release) grantReleasePromises.delete(grantId)
  }
}

const abortError = () => namedError('AbortError', 'The operation was aborted')

export const nativeAndroidWebSearch = async (queryValue, maxValue = 10, options = {}) => {
  const query = String(queryValue || '').trim().normalize('NFC')
  if (!query) return { ok: true, engine: 'auto', results: [] }
  const signal = options.signal
  if (signal?.aborted) throw abortError()
  const region = ({ auto: '', en: 'us-en', zh: 'cn-zh' })[options.region] ?? (typeof options.region === 'string' ? options.region : '')
  const request = invoke('webSearch', {
    query,
    max: Math.max(1, Math.min(20, Number(maxValue) || 10)),
    engine: ['auto', 'bing', 'duckduckgo', 'mojeek'].includes(options.engine) ? options.engine : 'auto',
    region
  })
  let result
  if (signal) {
    let onAbort
    try {
      result = await Promise.race([
        request,
        new Promise((_, reject) => {
          onAbort = () => {
            void invoke('cancelWebSearch').catch(() => {})
            reject(abortError())
          }
          signal.addEventListener('abort', onAbort, { once: true })
        })
      ])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  } else {
    result = await request
  }
  if (signal?.aborted) throw abortError()
  const engine = ['auto', 'bing', 'duckduckgo', 'mojeek'].includes(result?.engine) ? result.engine : 'auto'
  const entries = Array.isArray(result?.results) ? result.results : []
  const results = entries.slice(0, Math.max(1, Math.min(20, Number(maxValue) || 10))).flatMap((entry) => {
    const title = String(entry?.title || '').trim()
    const url = String(entry?.url || '').trim()
    const snippet = String(entry?.snippet || '').trim()
    if (!title || !/^https:\/\//i.test(url)) return []
    return [{ title: title.slice(0, 300), url: url.slice(0, 2048), snippet: snippet.slice(0, 1200) }]
  })
  return { ok: result?.ok === true, engine, results }
}
