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

class NativeFileHandle {
  constructor(dir, path) {
    this.kind = 'file'
    this._dir = dir
    this._path = path
  }

  get name() { return this._path.split('/').pop() }

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
        await Filesystem.writeFile({ path, directory: dir, data: buf, encoding: Encoding.UTF8, recursive: true })
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
    await Filesystem.deleteFile({ path: join(this._path, name), directory: this._dir })
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
