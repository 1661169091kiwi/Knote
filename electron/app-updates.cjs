'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const RELEASE_API = 'https://api.github.com/repos/1661169091kiwi/Knote/releases/latest'
const RELEASE_ROOT = 'https://github.com/1661169091kiwi/Knote/'
const MAX_ASSET_BYTES = 1024 * 1024 * 1024
const versionParts = (value) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''))?.slice(1).map(Number) || null
const newerVersion = (candidate, current) => {
  const a = versionParts(candidate), b = versionParts(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i] }
  return false
}
const loopbackUrl = (value) => {
  try { const u = new URL(value); return u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname) } catch { return false }
}
const selectRelease = (data, current, platform, allowTestUrls = false) => {
  if (!data || data.draft || data.prerelease || !newerVersion(data.tag_name, current)) return null
  const version = versionParts(data.tag_name).join('.')
  const name = platform === 'win32' ? `Knote-Setup-${version}.exe` : platform === 'linux' ? `Knote-${version}.AppImage` : ''
  const asset = data.assets?.find((item) => item.name === name)
  if (!asset) throw new Error('No update package is available for this platform')
  const size = Number(asset.size)
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '')?.[1]?.toLowerCase()
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ASSET_BYTES || !digest) throw new Error('Update package metadata is incomplete')
  const expectedUrl = `${RELEASE_ROOT}releases/download/${data.tag_name}/${name}`
  if (asset.browser_download_url !== expectedUrl && !(allowTestUrls && loopbackUrl(asset.browser_download_url))) throw new Error('Invalid update package URL')
  return { version, name, size, digest, url: asset.browser_download_url, releaseUrl: `${RELEASE_ROOT}releases/tag/${data.tag_name}` }
}

// One check and one streaming download per application. The UI receives events;
// neither startup nor an open menu needs a polling loop or child process.
const createAppUpdateService = ({ currentVersion, platform = process.platform, directory, fetch, onState = () => {}, apiUrl = RELEASE_API, allowTestUrls = false, checkTimeoutMs = 12000, idleTimeoutMs = 30000 }) => {
  if (apiUrl !== RELEASE_API && !(allowTestUrls && loopbackUrl(apiUrl))) throw new Error('Invalid update API')
  const configPath = path.join(directory, 'preferences.json')
  let autoCheck = true
  try { autoCheck = JSON.parse(fs.readFileSync(configPath, 'utf8')).autoCheck !== false } catch { /* first launch defaults on */ }
  let state = { phase: 'idle', currentVersion, autoCheck, release: null, received: 0, total: 0, error: null }
  let selected = null, downloadedPath = null, checking = null, downloading = null, controller = null, started = false, disposed = false
  const snapshot = () => ({ ...state, release: state.release ? { ...state.release } : null })
  const publish = (patch) => { state = { ...state, ...patch }; if (!disposed) onState(snapshot()); return snapshot() }
  const setAutoCheck = (enabled) => {
    fs.mkdirSync(directory, { recursive: true })
    const tmp = `${configPath}.${crypto.randomUUID()}.tmp`
    try { fs.writeFileSync(tmp, JSON.stringify({ autoCheck: enabled === true }), { flag: 'wx' }); fs.renameSync(tmp, configPath) }
    finally { try { fs.unlinkSync(tmp) } catch { /* already renamed */ } }
    return publish({ autoCheck: enabled === true })
  }
  const check = ({ silent = false } = {}) => {
    if (disposed || downloading) return Promise.resolve(snapshot())
    if (checking) return checking
    checking = (async () => {
      const previous = snapshot()
      const abort = new AbortController(); controller = abort
      const timer = setTimeout(() => abort.abort(new Error('Update check timed out')), checkTimeoutMs)
      publish({ phase: 'checking', error: null })
      try {
        const response = await fetch(apiUrl, { signal: abort.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Knote/${currentVersion}`, 'X-GitHub-Api-Version': '2022-11-28' } })
        if (response.status === 404) { selected = null; return publish({ phase: 'current', release: null }) }
        if (!response.ok) throw new Error(`Update check failed (HTTP ${response.status})`)
        // A release response is small. Bound it before JSON parsing rather than
        // trusting an unbounded response.json() allocation.
        const reader = response.body.getReader(); let bytes = 0, chunks = []
        try {
          while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 2 * 1024 * 1024) throw new Error('Update response is too large'); chunks.push(Buffer.from(value)) }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
        selected = selectRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')), currentVersion, platform, allowTestUrls)
        if (!selected) return publish({ phase: 'current', release: null, received: 0, total: 0 })
        if (previous.release?.version === selected.version && previous.phase === 'downloaded' && downloadedPath) return publish({ ...previous, autoCheck: state.autoCheck })
        downloadedPath = null
        return publish({ phase: 'available', release: { version: selected.version, name: selected.name, size: selected.size, releaseUrl: selected.releaseUrl }, received: 0, total: selected.size })
      } catch (error) {
        return silent ? publish({ ...previous, autoCheck: state.autoCheck, error: null }) : publish({ phase: 'error', error: String(error.message || error) })
      } finally { clearTimeout(timer); if (controller === abort) controller = null }
    })().finally(() => { checking = null })
    return checking
  }
  const download = () => {
    if (disposed) return Promise.resolve(snapshot())
    if (downloading) return downloading
    if (!selected || checking) return Promise.resolve(snapshot())
    if (state.phase === 'downloaded' && downloadedPath) return Promise.resolve(snapshot())
    const release = { ...selected }
    downloading = (async () => {
      const abort = new AbortController(); controller = abort
      let timer, handle, stageDir, reader, finished = false
      const armTimeout = () => { clearTimeout(timer); timer = setTimeout(() => abort.abort(new Error('Update download stalled')), idleTimeoutMs) }
      publish({ phase: 'downloading', received: 0, total: release.size, error: null })
      try {
        fs.mkdirSync(directory, { recursive: true })
        stageDir = await fs.promises.mkdtemp(path.join(directory, `${release.version}-`))
        const part = path.join(stageDir, `${release.name}.part`)
        handle = await fs.promises.open(part, 'wx')
        armTimeout()
        const response = await fetch(release.url, { signal: abort.signal, headers: { 'User-Agent': `Knote/${currentVersion}` } })
        if (!response.ok || !response.body) throw new Error(`Update download failed (HTTP ${response.status})`)
        const declared = response.headers.get('content-length')
        if (declared && Number(declared) !== release.size) throw new Error('Update package size does not match')
        reader = response.body.getReader()
        const hash = crypto.createHash('sha256'); let received = 0, lastEvent = 0
        while (true) {
          const { done, value } = await reader.read(); if (done) break
          armTimeout()
          received += value.byteLength
          if (received > release.size) throw new Error('Update package is larger than expected')
          hash.update(value)
          // FileHandle.write can be short; never assume a complete disk write.
          let offset = 0
          while (offset < value.byteLength) { const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset); if (!bytesWritten) throw new Error('Update disk write failed'); offset += bytesWritten }
          if (Date.now() - lastEvent >= 100 || received === release.size) { lastEvent = Date.now(); publish({ received }) }
        }
        if (abort.signal.aborted) throw abort.signal.reason
        if (received !== release.size || hash.digest('hex') !== release.digest) throw new Error('Update package verification failed')
        await handle.sync(); await handle.close(); handle = null
        const target = path.join(stageDir, release.name)
        await fs.promises.rename(part, target)
        if (platform === 'linux') await fs.promises.chmod(target, 0o755)
        downloadedPath = target; finished = true
        return publish({ phase: 'downloaded', received: release.size, error: null })
      } catch (error) {
        downloadedPath = null
        return publish({ phase: 'error', error: String(error?.message || error) })
      } finally {
        clearTimeout(timer)
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
        if (handle) await handle.close().catch(() => {})
        // Delete only our unique staging file, never a user download or folder.
        if (stageDir && !finished) { await fs.promises.unlink(path.join(stageDir, `${release.name}.part`)).catch(() => {}); await fs.promises.rmdir(stageDir).catch(() => {}) }
        if (controller === abort) controller = null
      }
    })().finally(() => { downloading = null })
    return downloading
  }
  return {
    snapshot, check, download, setAutoCheck,
    downloadedPath: () => downloadedPath,
    start: () => { if (started || disposed) return; started = true; if (state.autoCheck) void check({ silent: true }) },
    dispose: async () => { disposed = true; controller?.abort(new Error('Application is closing')); await Promise.allSettled([checking, downloading].filter(Boolean)) }
  }
}
module.exports = { createAppUpdateService, selectRelease, newerVersion }
