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

export const isNativeApp = () => Capacitor.isNativePlatform()

const join = (base, name) => (base ? `${base}/${name}` : name)

const nativeIdentity = (dir, filePath) => `native:${String(dir)}:${String(filePath).replace(/\\/g, '/')}`
const identityHash = async (value) => {
  if (globalThis.crypto && globalThis.crypto.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)))
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (const ch of String(value)) {
    const cp = ch.codePointAt(0)
    h1 = Math.imul(h1 ^ cp, 0x01000193)
    h2 = Math.imul(h2 ^ cp, 0x85ebca6b)
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

const writeNativeSnapshot = async (identity, content) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const docId = await identityHash(identity)
  await Filesystem.writeFile({
    path: `document-history/v1/${docId}/${stamp}.md`,
    directory: Directory.Data,
    data: String(content),
    encoding: Encoding.UTF8,
    recursive: true
  })
}

const durableNativeWrite = async (dir, filePath, content) => {
  const identity = nativeIdentity(dir, filePath)
  let oldContent = null
  try {
    const old = await Filesystem.readFile({ path: filePath, directory: dir, encoding: Encoding.UTF8 })
    oldContent = typeof old.data === 'string' ? old.data : ''
  } catch { /* new file */ }
  if (oldContent != null) await writeNativeSnapshot(identity, oldContent)
  await writeNativeSnapshot(identity, content)

  const suffix = `.knote-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const temp = `${filePath}${suffix}.tmp`
  const recovery = `${filePath}${suffix}.recovery`
  await Filesystem.writeFile({ path: temp, directory: dir, data: String(content), encoding: Encoding.UTF8, recursive: true })
  let movedOld = false
  try {
    if (oldContent != null) {
      await Filesystem.rename({ from: filePath, to: recovery, directory: dir, toDirectory: dir })
      movedOld = true
    }
    await Filesystem.rename({ from: temp, to: filePath, directory: dir, toDirectory: dir })
    if (movedOld) await Filesystem.deleteFile({ path: recovery, directory: dir }).catch(() => {})
  } catch (error) {
    if (movedOld) {
      await Filesystem.rename({ from: recovery, to: filePath, directory: dir, toDirectory: dir }).catch(() => {})
    }
    await Filesystem.deleteFile({ path: temp, directory: dir }).catch(() => {})
    throw error
  }
}

class NativeFileHandle {
  constructor(dir, path) {
    this.kind = 'file'
    this._dir = dir
    this._path = path
  }

  get name() { return this._path.split('/').pop() }
  get _knoteIdentity() { return nativeIdentity(this._dir, this._path) }

  async getFile() {
    const res = await Filesystem.readFile({ path: this._path, directory: this._dir, encoding: Encoding.UTF8 })
    const text = typeof res.data === 'string' ? res.data : ''
    return { name: this.name, text: async () => text }
  }

  async createWritable() {
    const dir = this._dir
    const path = this._path
    let buf = ''
    return {
      write: async (chunk) => { buf += String(chunk) },
      close: async () => {
        await durableNativeWrite(dir, path, buf)
      }
    }
  }

  async queryPermission() { return 'granted' }
  async requestPermission() { return 'granted' }

  // in-place rename, mirroring Chromium's FileSystemFileHandle.move(name)
  async move(newName) {
    const parent = this._path.split('/').slice(0, -1).join('/')
    const to = join(parent, newName)
    await Filesystem.rename({ from: this._path, to, directory: this._dir, toDirectory: this._dir })
    this._path = to
  }
}

class NativeDirHandle {
  constructor(dir, path, name) {
    this.kind = 'directory'
    this._dir = dir
    this._path = path
    this.name = name || this._path.split('/').pop() || 'Knote'
  }

  async *entries() {
    const res = await Filesystem.readdir({ path: this._path, directory: this._dir })
    for (const f of res.files || []) {
      const child = join(this._path, f.name)
      yield [
        f.name,
        f.type === 'directory' ? new NativeDirHandle(this._dir, child) : new NativeFileHandle(this._dir, child)
      ]
    }
  }

  async getFileHandle(name, opts = {}) {
    const p = join(this._path, name)
    let exists = true
    try { await Filesystem.stat({ path: p, directory: this._dir }) } catch { exists = false }
    if (!exists) {
      if (!opts.create) {
        const err = new Error(`file not found: ${p}`)
        err.name = 'NotFoundError'
        throw err
      }
      await Filesystem.writeFile({ path: p, directory: this._dir, data: '', encoding: Encoding.UTF8, recursive: true })
    }
    return new NativeFileHandle(this._dir, p)
  }

  async getDirectoryHandle(name, opts = {}) {
    const p = join(this._path, name)
    let exists = true
    try { await Filesystem.stat({ path: p, directory: this._dir }) } catch { exists = false }
    if (!exists) {
      if (!opts.create) {
        const err = new Error(`directory not found: ${p}`)
        err.name = 'NotFoundError'
        throw err
      }
      await Filesystem.mkdir({ path: p, directory: this._dir, recursive: true })
    }
    return new NativeDirHandle(this._dir, p)
  }

  async removeEntry(name) {
    const target = join(this._path, name)
    try {
      const old = await Filesystem.readFile({ path: target, directory: this._dir, encoding: Encoding.UTF8 })
      if (typeof old.data === 'string') await writeNativeSnapshot(nativeIdentity(this._dir, target), old.data)
    } catch (error) {
      // If a present file cannot be read/archived, refuse to destroy it.
      try { await Filesystem.stat({ path: target, directory: this._dir }) } catch { return }
      throw error
    }
    await Filesystem.deleteFile({ path: target, directory: this._dir })
  }

  async queryPermission() { return 'granted' }
  async requestPermission() { return 'granted' }
}

const ROOT = 'Knote'

// The tablet workspace is a standing "Knote" folder. Preferred home is the
// public Documents directory (visible in any file manager); if the OS
// version denies direct writes there, fall back to the app-scoped external
// dir (Android/data/com.kv.knote/files). A real write probe decides — mkdir
// alone can succeed where file writes later fail.
export const openNativeWorkspace = async () => {
  try { await Filesystem.requestPermissions() } catch { /* older plugin/OS combos */ }
  for (const dir of [Directory.Documents, Directory.External]) {
    try {
      await Filesystem.mkdir({ path: ROOT, directory: dir, recursive: true }).catch(() => {})
      const probe = `${ROOT}/.knote-probe`
      await Filesystem.writeFile({ path: probe, directory: dir, data: 'ok', encoding: Encoding.UTF8 })
      await Filesystem.deleteFile({ path: probe, directory: dir })
      return new NativeDirHandle(dir, ROOT, 'Knote')
    } catch { /* try the next location */ }
  }
  return null
}

// Exports (导出 MD/Word) on Android: blob-anchor downloads are ignored by the
// WebView — write the file into the workspace folder instead. Returns a
// human-readable location, or null when no location is writable.
export const nativeExportText = async (fileName, text) => {
  for (const dir of [Directory.Documents, Directory.External]) {
    try {
      await Filesystem.writeFile({ path: `${ROOT}/${fileName}`, directory: dir, data: text, encoding: Encoding.UTF8, recursive: true })
      return dir === Directory.Documents ? `文档/Knote/${fileName}` : `Android/data/com.kv.knote/files/Knote/${fileName}`
    } catch { /* try the next location */ }
  }
  return null
}
