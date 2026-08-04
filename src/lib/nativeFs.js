// Android (Capacitor) file-system adapter.
//
// The whole folder-workspace feature is built on the File System Access API
// (FileSystemDirectoryHandle / FileSystemFileHandle), which Android WebView
// doesn't have. These classes mimic exactly the handle surface Knote uses —
// entries() / getFileHandle / removeEntry / getFile / createWritable /
// queryPermission / requestPermission / move — on top of the official
// @capacitor/filesystem plugin, so buildFolderTree, openTreeFile, auto-save,
// create/rename and the agent's list_files/read_file all work unchanged.
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { addSnapshot, copySnapshots, importSnapshotsOnce } from './snapshots.js'

const ROOT = 'Knote'
const NATIVE_DIR_HANDLE = Symbol('NativeDirHandle')
const NATIVE_FILE_HANDLE = Symbol('NativeFileHandle')
const ALLOWED_DIRECTORIES = new Set([String(Directory.Documents), String(Directory.External)])
const NOT_FOUND_CODES = new Set(['ENOENT', 'NOT_FOUND', 'OS-PLUG-FILE-0008'])

export const isNativeApp = () => Capacitor.isNativePlatform()
let nativeFilesystem = Filesystem
let nativeSnapshotWriter = addSnapshot
let nativeSnapshotImporter = importSnapshotsOnce
let nativeSnapshotCopier = copySnapshots
const legacyImportJobs = new Map()
export const setNativeFilesystemAdapter = (adapter = Filesystem) => {
  nativeFilesystem = adapter
  legacyImportJobs.clear()
}
export const setNativeSnapshotAdapter = (
  adapter = addSnapshot,
  importer = importSnapshotsOnce,
  copier = copySnapshots
) => {
  nativeSnapshotWriter = adapter
  nativeSnapshotImporter = importer
  nativeSnapshotCopier = copier
  legacyImportJobs.clear()
}

const isNotFoundError = (error) => error?.name === 'NotFoundError' || NOT_FOUND_CODES.has(String(error?.code || ''))

const namedError = (name, message) => {
  const error = new Error(message)
  error.name = name
  return error
}

const unsafeNativeName = (value) => {
  if (typeof value !== 'string' || !value || value === '.' || value === '..') return true
  if (/[\\/\0\r\n]/.test(value) || /^(?:[a-z][a-z0-9+.-]*:|[a-z]:|#)/i.test(value)) return true
  let probe = value
  for (let depth = 0; depth < 3 && probe.includes('%'); depth++) {
    let decoded
    try { decoded = decodeURIComponent(probe) } catch { break }
    if (decoded === probe) break
    probe = decoded
    if (!probe || probe === '.' || probe === '..' || /[\\/\0\r\n]/.test(probe) || /^(?:[a-z][a-z0-9+.-]*:|[a-z]:|#)/i.test(probe)) return true
  }
  return false
}

const assertNativeChildName = (value, label = 'native child name') => {
  if (unsafeNativeName(value)) throw new TypeError(`invalid ${label}`)
  return value
}

const assertNativePath = (dir, value) => {
  const path = String(value || '')
  if (!ALLOWED_DIRECTORIES.has(String(dir)) || !path || path.startsWith('/') || path.endsWith('/') || path.includes('//') || /[\\\0\r\n]/.test(path)) {
    throw new TypeError('native path is outside the Knote workspace')
  }
  const segments = path.split('/')
  if (segments[0] !== ROOT || segments.some((segment) => unsafeNativeName(segment))) {
    throw new TypeError('native path is outside the Knote workspace')
  }
  return path
}

const join = (dir, base, name) => `${assertNativePath(dir, base)}/${assertNativeChildName(name)}`

const nativeIdentity = (dir, filePath) => `native:${String(dir)}:${String(filePath).replace(/\\/g, '/')}`

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8')
const isMarkdownPath = (value) => /\.(?:md|markdown)$/i.test(String(value || ''))
const legacyIdentityHashes = async (identity) => {
  const hashes = []
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', textEncoder.encode(String(identity)))
    hashes.push([...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''))
  }
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (const char of String(identity)) {
    const codePoint = char.codePointAt(0)
    h1 = Math.imul(h1 ^ codePoint, 0x01000193)
    h2 = Math.imul(h2 ^ codePoint, 0x85ebca6b)
  }
  hashes.push(`${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`)
  return [...new Set(hashes)]
}

const migrateLegacySnapshots = async (dir, filePath) => {
  if (!isMarkdownPath(filePath)) return false
  const identity = nativeIdentity(dir, filePath)
  let job = legacyImportJobs.get(identity)
  if (!job) {
    job = (async () => {
      const items = []
      for (const hash of await legacyIdentityHashes(identity)) {
        const legacyDir = `document-history/v1/${hash}`
        let entries
        try {
          entries = await nativeFilesystem.readdir({ path: legacyDir, directory: Directory.Data })
        } catch (error) {
          if (isNotFoundError(error)) continue
          throw error
        }
        for (const entry of entries.files || []) {
          const match = /^(\d{10,17})-[a-z0-9]{1,16}\.md$/i.exec(String(entry?.name || ''))
          if (!match || (entry.type && entry.type !== 'file')) continue
          const path = `${legacyDir}/${entry.name}`
          const result = await nativeFilesystem.readFile({
            path,
            directory: Directory.Data,
            encoding: Encoding.UTF8
          })
          const content = result.data instanceof Blob ? await result.data.text() : String(result.data ?? '')
          items.push({ content, t: Number(match[1]), label: 'legacy-native' })
        }
      }
      // The source files are deliberately retained as an independent recovery
      // copy. The import marker is committed atomically with these bodies.
      items.sort((a, b) => a.t - b.t)
      return nativeSnapshotImporter(identity, 'android-directory-data-v1', items)
    })()
    legacyImportJobs.set(identity, job)
  }
  try {
    return await job
  } catch (error) {
    legacyImportJobs.delete(identity)
    throw error
  }
}

const tryLegacyMigration = async (dir, filePath) => {
  try { return await migrateLegacySnapshots(dir, filePath) } catch { return false }
}

const bytesToBase64 = (value) => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0)
  let binary = ''
  const block = 0x8000
  for (let index = 0; index < bytes.length; index += block) {
    binary += String.fromCharCode(...bytes.subarray(index, index + block))
  }
  return btoa(binary)
}
const base64ToBytes = (value) => {
  const binary = atob(String(value || ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
const normalizeWriteChunk = async (chunk) => {
  if (typeof chunk === 'string') return textEncoder.encode(chunk)
  if (chunk instanceof Blob) return new Uint8Array(await chunk.arrayBuffer())
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk.slice(0))
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength))
  }
  throw new TypeError('native file writes require text, Blob, ArrayBuffer, or typed-array data')
}
const concatBytes = (chunks) => {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}
const readNativeBytes = async (dir, filePath) => {
  const result = await nativeFilesystem.readFile({ path: filePath, directory: dir })
  if (result.data instanceof Blob) return new Uint8Array(await result.data.arrayBuffer())
  return base64ToBytes(result.data)
}
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

const durableNativeWrite = async (dir, filePath, bytesValue, options = {}) => {
  assertNativePath(dir, filePath)
  await tryLegacyMigration(dir, filePath)
  const identity = nativeIdentity(dir, filePath)
  const bytes = bytesValue instanceof Uint8Array ? bytesValue : new Uint8Array(bytesValue || 0)
  let oldBytes = null
  try {
    oldBytes = await readNativeBytes(dir, filePath)
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }
  if (!options.knoteHistoryProtected && isMarkdownPath(filePath)) {
    if (oldBytes != null) await nativeSnapshotWriter(identity, textDecoder.decode(oldBytes), Date.now(), 'before-save')
    await nativeSnapshotWriter(identity, textDecoder.decode(bytes), Date.now(), 'pending-save')
  }

  const suffix = `.knote-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const temp = `${filePath}${suffix}.tmp`
  const recovery = `${filePath}${suffix}.recovery`
  await nativeFilesystem.writeFile({ path: temp, directory: dir, data: bytesToBase64(bytes), recursive: true })
  let movedOld = false
  try {
    if (oldBytes != null) {
      await nativeFilesystem.rename({ from: filePath, to: recovery, directory: dir, toDirectory: dir })
      movedOld = true
    }
    await nativeFilesystem.rename({ from: temp, to: filePath, directory: dir, toDirectory: dir })
    if (movedOld) await nativeFilesystem.deleteFile({ path: recovery, directory: dir }).catch(() => {})
  } catch (error) {
    if (movedOld) {
      await nativeFilesystem.rename({ from: recovery, to: filePath, directory: dir, toDirectory: dir }).catch(() => {})
    }
    await nativeFilesystem.deleteFile({ path: temp, directory: dir }).catch(() => {})
    throw error
  }
  if (!options.knoteHistoryProtected && isMarkdownPath(filePath)) {
    await nativeSnapshotWriter(identity, textDecoder.decode(bytes), Date.now(), 'save')
  }
}

export class NativeFileHandle {
  constructor(dir, path) {
    this.kind = 'file'
    this._dir = dir
    this._path = assertNativePath(dir, path)
    this[NATIVE_FILE_HANDLE] = true
  }

  get name() { return this._path.split('/').pop() }
  get _knoteIdentity() { return nativeIdentity(this._dir, this._path) }

  async getFile() {
    assertNativePath(this._dir, this._path)
    await tryLegacyMigration(this._dir, this._path)
    const [bytes, stat] = await Promise.all([
      readNativeBytes(this._dir, this._path),
      nativeFilesystem.stat({ path: this._path, directory: this._dir }).catch((error) => {
        if (isNotFoundError(error)) return null
        throw error
      })
    ])
    return new File([bytes], this.name, {
      type: mimeForPath(this._path),
      lastModified: Number(stat?.mtime) || Date.now()
    })
  }

  async createWritable(options = {}) {
    assertNativePath(this._dir, this._path)
    const dir = this._dir
    const path = this._path
    const chunks = []
    return {
      write: async (chunk) => { chunks.push(await normalizeWriteChunk(chunk)) },
      close: async () => {
        await durableNativeWrite(dir, path, concatBytes(chunks), options)
      }
    }
  }

  async queryPermission() { return 'granted' }
  async requestPermission() { return 'granted' }

  // Supports Chromium's move(name) and move(destinationDirectory, name).
  async move(destinationOrName, requestedName) {
    assertNativePath(this._dir, this._path)
    const destination = destinationOrName && destinationOrName[NATIVE_DIR_HANDLE] === true
      ? destinationOrName
      : null
    const name = destination ? requestedName : destinationOrName
    assertNativeChildName(name, 'native destination name')
    if (destination) assertNativePath(destination._dir, destination._path)
    const targetDir = destination ? destination._dir : this._dir
    const parent = destination ? destination._path : this._path.split('/').slice(0, -1).join('/')
    const to = join(targetDir, parent, name)
    const fromDir = this._dir
    const fromPath = this._path
    if (isMarkdownPath(fromPath)) {
      await migrateLegacySnapshots(fromDir, fromPath)
      await migrateLegacySnapshots(targetDir, to)
      // Copy before mutating the filesystem. A crash can leave an orphan target
      // history, but never a moved file whose recoverable history is stranded
      // exclusively under the old identity.
      await nativeSnapshotCopier(nativeIdentity(fromDir, fromPath), nativeIdentity(targetDir, to))
    }
    await nativeFilesystem.rename({ from: fromPath, to, directory: fromDir, toDirectory: targetDir })
    this._dir = targetDir
    this._path = to
  }
}

const archiveNativeMarkdownTree = async (dir, targetPath) => {
  assertNativePath(dir, targetPath)
  const stat = await nativeFilesystem.stat({ path: targetPath, directory: dir })
  if (stat.type !== 'directory') {
    if (isMarkdownPath(targetPath)) {
      await migrateLegacySnapshots(dir, targetPath)
      const bytes = await readNativeBytes(dir, targetPath)
      await nativeSnapshotWriter(nativeIdentity(dir, targetPath), textDecoder.decode(bytes), Date.now(), 'before-delete')
    }
    return
  }
  const entries = await nativeFilesystem.readdir({ path: targetPath, directory: dir })
  for (const entry of entries.files || []) {
    await archiveNativeMarkdownTree(dir, join(dir, targetPath, entry.name))
  }
}

export class NativeDirHandle {
  constructor(dir, path, name) {
    this.kind = 'directory'
    this._dir = dir
    this._path = assertNativePath(dir, path)
    this.name = name == null ? (this._path.split('/').pop() || ROOT) : assertNativeChildName(name, 'native directory name')
    this[NATIVE_DIR_HANDLE] = true
  }

  get _knoteIdentity() { return nativeIdentity(this._dir, this._path) }

  async *entries() {
    assertNativePath(this._dir, this._path)
    const res = await nativeFilesystem.readdir({ path: this._path, directory: this._dir })
    for (const f of res.files || []) {
      const child = join(this._dir, this._path, f.name)
      if (f.type !== 'directory' && f.type !== 'file') throw new TypeError('invalid native directory entry type')
      yield [
        f.name,
        f.type === 'directory' ? new NativeDirHandle(this._dir, child) : new NativeFileHandle(this._dir, child)
      ]
    }
  }

  async getFileHandle(name, opts = {}) {
    const p = join(this._dir, this._path, name)
    let stat = null
    try { stat = await nativeFilesystem.stat({ path: p, directory: this._dir }) } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
    if (!stat) {
      if (!opts.create) {
        throw namedError('NotFoundError', `file not found: ${p}`)
      }
      await nativeFilesystem.writeFile({ path: p, directory: this._dir, data: '', encoding: Encoding.UTF8, recursive: true })
    } else if (stat.type !== 'file') {
      throw namedError('TypeMismatchError', `not a file: ${p}`)
    }
    return new NativeFileHandle(this._dir, p)
  }

  async getDirectoryHandle(name, opts = {}) {
    const p = join(this._dir, this._path, name)
    let stat = null
    try { stat = await nativeFilesystem.stat({ path: p, directory: this._dir }) } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
    if (!stat) {
      if (!opts.create) {
        throw namedError('NotFoundError', `directory not found: ${p}`)
      }
      await nativeFilesystem.mkdir({ path: p, directory: this._dir, recursive: true })
    } else if (stat.type !== 'directory') {
      throw namedError('TypeMismatchError', `not a directory: ${p}`)
    }
    return new NativeDirHandle(this._dir, p)
  }

  async removeEntry(name, options = {}) {
    const target = join(this._dir, this._path, name)
    let stat
    try { stat = await nativeFilesystem.stat({ path: target, directory: this._dir }) } catch (error) {
      if (isNotFoundError(error)) return
      throw error
    }
    if (stat.type !== 'directory' && stat.type !== 'file') throw new TypeError('invalid native entry type')
    await archiveNativeMarkdownTree(this._dir, target)
    if (stat.type === 'directory') {
      await nativeFilesystem.rmdir({
        path: target,
        directory: this._dir,
        recursive: options.recursive === true
      })
    } else {
      await nativeFilesystem.deleteFile({ path: target, directory: this._dir })
    }
  }

  async queryPermission() { return 'granted' }
  async requestPermission() { return 'granted' }
}

// The tablet workspace is a standing "Knote" folder. Preferred home is the
// public Documents directory (visible in any file manager); if the OS
// version denies direct writes there, fall back to the app-scoped external
// dir (Android/data/com.kv.knote/files). A real write probe decides — mkdir
// alone can succeed where file writes later fail.
export const openNativeWorkspace = async () => {
  try { await nativeFilesystem.requestPermissions() } catch { /* older plugin/OS combos */ }
  for (const dir of [Directory.Documents, Directory.External]) {
    try {
      await nativeFilesystem.mkdir({ path: ROOT, directory: dir, recursive: true }).catch(() => {})
      const probe = `${ROOT}/.knote-probe`
      await nativeFilesystem.writeFile({ path: probe, directory: dir, data: 'ok', encoding: Encoding.UTF8 })
      await nativeFilesystem.deleteFile({ path: probe, directory: dir })
      return new NativeDirHandle(dir, ROOT, 'Knote')
    } catch { /* try the next location */ }
  }
  return null
}

// Exports (导出 MD/Word) on Android: blob-anchor downloads are ignored by the
// WebView — write the file into the workspace folder instead. Returns a
// human-readable location, or null when no location is writable.
export const nativeExportText = async (fileName, text) => {
  assertNativeChildName(fileName, 'native export file name')
  for (const dir of [Directory.Documents, Directory.External]) {
    try {
      await nativeFilesystem.writeFile({ path: `${ROOT}/${fileName}`, directory: dir, data: text, encoding: Encoding.UTF8, recursive: true })
      return dir === Directory.Documents ? `文档/Knote/${fileName}` : `Android/data/com.kv.knote/files/Knote/${fileName}`
    } catch { /* try the next location */ }
  }
  return null
}
