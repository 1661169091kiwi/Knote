// Strict UTF-8 decoding for every path that feeds the editor's document.
//
// Blob.text() and readFile(path, 'utf8') both decode with replacement: invalid
// byte sequences silently become U+FFFD. A GBK/Big5/UTF-16 note opened that
// way displays mojibake, and the first auto-save then writes the lossy string
// back over the original bytes — irreversible, unrecoverable corruption of the
// whole file. Editor-bound reads therefore decode strictly and refuse to
// install undecodable content (the same contract the Agent read path already
// enforces; see the fatal TextDecoder in agentBridge.readFile).
//
// The Agent edit lane keeps its own byte-exact decode WITHOUT BOM stripping:
// its CAS compares against raw disk bytes. Only the editor lane strips one
// leading BOM here, matching Blob.text() semantics so valid files behave
// exactly as before.
export const isInvalidUtf8Error = (error) => error?.code === 'INVALID_UTF8'

export const invalidUtf8Error = (fileName = '') => {
  const error = new Error(fileName
    ? `文件「${fileName}」不是有效的 UTF-8 编码文本`
    : 'file is not valid UTF-8')
  error.code = 'INVALID_UTF8'
  return error
}

export const decodeUtf8Strict = (bytes) => {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    throw invalidUtf8Error()
  }
}

export const readFileTextStrict = async (file, fileName = '') => {
  if (typeof file?.arrayBuffer === 'function') {
    const bytes = new Uint8Array(await file.arrayBuffer())
    try {
      return decodeUtf8Strict(bytes)
    } catch {
      throw invalidUtf8Error(fileName || file?.name || '')
    }
  }
  // Desktop bridge handles expose a { name, text() } shim without
  // arrayBuffer; its text is produced by readDesktopTextFile, which already
  // decodes strictly — trust it instead of crashing on the missing method.
  return String(await file.text())
}
