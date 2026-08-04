// Desktop (Electron) folder workspace: FileSystemHandle-shaped adapters over
// the preload's fs IPC. Needed because a folder dropped onto the Knote ICON
// (or passed on the command line) arrives as a PATH — the File System Access
// API can't mint a handle from a path, so these wrappers make path-backed
// folders quack like picker-opened ones. The main process confines every fs
// call to roots it registered itself (see folderRoots in electron/main.cjs),
// mirroring the writablePaths rule for single files.

const bridge = () => (typeof window !== 'undefined' ? window.knoteDesktop : null)

const PROGRESSIVE_TEXT_THRESHOLD = 384 * 1024
const PROGRESSIVE_TEXT_CHUNK = 256 * 1024
const yieldToRenderer = () => new Promise((resolve) => setTimeout(resolve, 0))
const ipcBytes = (value) => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value && Array.isArray(value.data)) return Uint8Array.from(value.data)
  return new Uint8Array(0)
}

export const readDesktopTextFile = async (filePath, statHint = null) => {
  const api = bridge()
  if (!api) throw new Error('desktop bridge unavailable')
  if (typeof api.fsReadChunk !== 'function' || typeof api.fsStat !== 'function') {
    return String(await api.fsRead(filePath))
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const stat = attempt === 0 && statHint && statHint.ok !== false
      ? statHint
      : await api.fsStat(filePath)
    if (!stat || stat.ok === false || Number(stat.size) < PROGRESSIVE_TEXT_THRESHOLD) {
      return String(await api.fsRead(filePath))
    }

    const decoder = new TextDecoder('utf-8')
    const textChunks = []
    let offset = 0
    try {
      while (offset < Number(stat.size)) {
        const part = await api.fsReadChunk(
          filePath,
          offset,
          PROGRESSIVE_TEXT_CHUNK,
          { size: Number(stat.size), mtimeMs: Number(stat.mtimeMs) }
        )
        const bytes = ipcBytes(part?.bytes)
        if (!part || Number(part.bytesRead) !== bytes.byteLength) throw new Error('invalid_progressive_read_chunk')
        textChunks.push(decoder.decode(bytes, { stream: !part.done }))
        offset += bytes.byteLength
        if (part.done) break
        if (!bytes.byteLength) throw new Error('empty_progressive_read_chunk')
        await yieldToRenderer()
      }
      textChunks.push(decoder.decode())
      return textChunks.join('')
    } catch (error) {
      if (attempt > 0 || !String(error?.message || error).includes('file_changed_during_progressive_read')) throw error
    }
  }
  throw new Error('progressive_read_failed')
}

const joinPath = (dir, name) => {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.startsWith('#') || /[\\/\0\r\n]/.test(name)) {
    throw new TypeError('invalid desktop child name')
  }
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

export const mkDesktopFileHandle = (filePath, name, parentPath) => {
  // mutable so move() makes the handle FOLLOW the rename, like a real
  // FileSystemFileHandle — otherwise later auto-saves would resurrect the
  // old file name and the renamed file would stop receiving edits
  let curPath = filePath
  const handle = {
    kind: 'file',
    name,
    get _deskPath () { return curPath },
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFile: async () => {
      const data = await readDesktopTextFile(curPath)
      return { name: handle.name, text: async () => data }
    },
    createWritable: async () => {
      let buf = ''
      return {
        write: async (chunk) => { buf += String(chunk) },
        close: async () => { await bridge().fsWrite(curPath, buf) }
      }
    },
    // in-place rename within the same directory (tree rename uses this)
    move: async (newName) => {
      const next = joinPath(parentPath, newName)
      await bridge().fsRename(curPath, next)
      curPath = next
      handle.name = newName
    }
  }
  return handle
}

export const mkDesktopDirHandle = (dirPath, name) => ({
  kind: 'directory',
  name,
  _deskPath: dirPath,
  queryPermission: async () => 'granted',
  requestPermission: async () => 'granted',
  entries: async function* () {
    const items = await bridge().fsList(dirPath)
    for (const it of items) {
      const p = joinPath(dirPath, it.name)
      yield [
        it.name,
        it.kind === 'directory'
          ? mkDesktopDirHandle(p, it.name)
          : mkDesktopFileHandle(p, it.name, dirPath)
      ]
    }
  },
  getFileHandle: async (n, opts) => {
    const p = joinPath(dirPath, n)
    const exists = await bridge().fsExists(p)
    if (!exists) {
      if (!opts || !opts.create) {
        const err = new Error(`file not found: ${n}`)
        err.name = 'NotFoundError'
        throw err
      }
      // Explicit creation is intentionally separate from ordinary writes.
      // The main process tombstones deleted/renamed paths so a late autosave
      // cannot resurrect them; only an explicit user create may clear it.
      await bridge().fsCreate(p)
    }
    return mkDesktopFileHandle(p, n, dirPath)
  },
  getDirectoryHandle: async (n, opts) => {
    const p = joinPath(dirPath, n)
    const exists = await bridge().fsExists(p)
    if (!exists) {
      if (!opts || !opts.create) {
        const err = new Error(`directory not found: ${n}`)
        err.name = 'NotFoundError'
        throw err
      }
      await bridge().fsMkdir(p)
    }
    return mkDesktopDirHandle(p, n)
  },
  removeEntry: async (n) => { await bridge().fsDelete(joinPath(dirPath, n)) }
})
