// Desktop (Electron) folder workspace: FileSystemHandle-shaped adapters over
// the preload's fs IPC. Needed because a folder dropped onto the Knote ICON
// (or passed on the command line) arrives as a PATH — the File System Access
// API can't mint a handle from a path, so these wrappers make path-backed
// folders quack like picker-opened ones. The main process confines every fs
// call to roots it registered itself (see folderRoots in electron/main.cjs),
// mirroring the writablePaths rule for single files.

const bridge = () => (typeof window !== 'undefined' ? window.knoteDesktop : null)

const joinPath = (dir, name) => {
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
      const data = await bridge().fsRead(curPath)
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
      await bridge().fsWrite(p, '')
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
