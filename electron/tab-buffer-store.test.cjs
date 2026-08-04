const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { TabBufferStore, REF_KIND, REF_VERSION } = require('./tab-buffer-store.cjs')

const roots = []

const fresh = async (options = {}) => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'knote-tab-buffer-'))
  roots.push(parent)
  const root = path.join(parent, 'user-data', 'tab-buffers', 'v1')
  return { parent, root, store: new TabBufferStore(root, options) }
}

const filesBelow = async (root) => {
  const out = []
  const walk = async (dir) => {
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const item = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(item)
      else out.push(item)
    }
  }
  await walk(root)
  return out
}

const onlyBuffer = async (root) => {
  const files = (await filesBelow(root)).filter((file) => file.endsWith('.buf'))
  assert.equal(files.length, 1)
  return files[0]
}

test.after(async () => {
  for (const root of roots) await fs.promises.rm(root, { recursive: true, force: true })
})

test('put/get round-trips unicode and returns an immutable opaque signed ref', async () => {
  const { root, store } = await fresh()
  const content = '# 超长文档\n\n🙂'.repeat(4096)
  const ref = await store.put('session/一号', 'tab:主文档', content)
  assert.equal(ref.kind, REF_KIND)
  assert.equal(ref.version, REF_VERSION)
  assert.equal(ref.size, Buffer.byteLength(content, 'utf8'))
  assert.equal(ref.hash, crypto.createHash('sha256').update(content, 'utf8').digest('hex'))
  assert.match(ref.session, /^[a-f0-9]{64}$/)
  assert.match(ref.tab, /^[a-f0-9]{64}$/)
  assert.match(ref.id, /^[a-f0-9]{32}$/)
  assert.match(ref.sig, /^[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(ref), true)
  assert.equal(Object.hasOwn(ref, 'path'), false)
  assert.equal(await store.get(JSON.parse(JSON.stringify(ref))), content)
  const target = await onlyBuffer(root)
  assert.equal(path.relative(root, target).startsWith('..'), false)
})

test('a serialized ref remains valid after constructing a new store for the same userData root', async () => {
  const { root, store } = await fresh()
  const ref = JSON.parse(JSON.stringify(await store.put('restart-session', 'restart-tab', 'survives process restart')))
  const restarted = new TabBufferStore(root)
  assert.equal(await restarted.get(ref), 'survives process restart')
})

test('drop deletes exactly one signed buffer and is idempotent for a missing target', async () => {
  const { store } = await fresh()
  const a = await store.put('s', 'a', 'A')
  const b = await store.put('s', 'b', 'B')
  assert.equal(await store.drop(a), true)
  assert.equal(await store.drop(a), false)
  assert.equal(await store.get(a), null)
  assert.equal(await store.get(b), 'B')
})

test('clearSession removes only the requested hashed session directory', async () => {
  const { store } = await fresh()
  const a1 = await store.put('session-A', 'one', 'A1')
  const a2 = await store.put('session-A', 'two', 'A2')
  const b = await store.put('session-B', 'one', 'B')
  assert.equal(await store.clearSession('session-A'), true)
  assert.equal(await store.clearSession('session-A'), false)
  assert.equal(await store.get(a1), null)
  assert.equal(await store.get(a2), null)
  assert.equal(await store.get(b), 'B')
})

test('startup initialization removes prior sessions and orphan temps but preserves the store key', async () => {
  const { root, store } = await fresh()
  const ref = await store.put('crashed-session', 'cold-tab', 'RECOVERED ELSEWHERE')
  const keyBefore = await fs.promises.readFile(path.join(root, 'store-key.bin'))
  const target = await onlyBuffer(root)
  await fs.promises.writeFile(path.join(path.dirname(target), '.crash-leftover.tmp'), 'TEMP', 'utf8')

  const removed = await store.initialize()
  assert.ok(removed.entries >= 2)
  assert.equal(await store.get(ref), null)
  assert.deepEqual(await fs.promises.readFile(path.join(root, 'store-key.bin')), keyBefore)
  assert.equal((await filesBelow(path.join(root, 'sessions'))).length, 0)

  const next = await store.put('new-session', 'tab', 'NEW')
  assert.equal(await store.get(next), 'NEW')
})

test('startup cleanup removes a session junction without touching its target', async (t) => {
  const { parent, root, store } = await fresh()
  const outside = path.join(parent, 'outside-startup')
  const sentinel = path.join(outside, 'keep.txt')
  const sessions = path.join(root, 'sessions')
  await fs.promises.mkdir(outside, { recursive: true })
  await fs.promises.mkdir(root, { recursive: true })
  await fs.promises.writeFile(sentinel, 'safe', 'utf8')
  try {
    await fs.promises.symlink(outside, sessions, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'UNKNOWN') {
      t.skip(`symlinks unavailable: ${error.code}`)
      return
    }
    throw error
  }
  await store.initialize()
  assert.equal(await fs.promises.readFile(sentinel, 'utf8'), 'safe')
  assert.equal((await fs.promises.lstat(sessions)).isDirectory(), true)
  assert.equal((await fs.promises.lstat(sessions)).isSymbolicLink(), false)
})

test('startup cleanup rejects a replaced store root without touching its target', async (t) => {
  const { parent, root, store } = await fresh()
  const outside = path.join(parent, 'outside-root')
  const victimDir = path.join(outside, 'sessions')
  const sentinel = path.join(victimDir, 'keep.txt')
  await fs.promises.mkdir(victimDir, { recursive: true })
  await fs.promises.mkdir(path.dirname(root), { recursive: true })
  await fs.promises.writeFile(sentinel, 'safe', 'utf8')
  try {
    await fs.promises.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'UNKNOWN') {
      t.skip(`symlinks unavailable: ${error.code}`)
      return
    }
    throw error
  }
  await assert.rejects(store.initialize(), /unsafe tab buffer root (?:directory|ancestor)/)
  assert.equal(await fs.promises.readFile(sentinel, 'utf8'), 'safe')
})

test('startup cleanup rejects a junction in a root ancestor without touching its target', async (t) => {
  const { parent, root, store } = await fresh()
  const outside = path.join(parent, 'outside-ancestor')
  const victimDir = path.join(outside, 'v1', 'sessions')
  const sentinel = path.join(victimDir, 'keep.txt')
  const redirectedParent = path.dirname(root)
  await fs.promises.mkdir(victimDir, { recursive: true })
  await fs.promises.mkdir(path.dirname(redirectedParent), { recursive: true })
  await fs.promises.writeFile(sentinel, 'safe', 'utf8')
  try {
    await fs.promises.symlink(outside, redirectedParent, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'UNKNOWN') {
      t.skip(`symlinks unavailable: ${error.code}`)
      return
    }
    throw error
  }
  await assert.rejects(store.initialize(), /unsafe tab buffer root ancestor|escaped its boundary/)
  assert.equal(await fs.promises.readFile(sentinel, 'utf8'), 'safe')
})

test('a store root replaced after trust is established is revalidated before mutation', async (t) => {
  const { parent, root, store } = await fresh()
  await store.put('trusted', 'tab', 'inside')
  await fs.promises.rm(root, { recursive: true, force: true })
  const outside = path.join(parent, 'outside-after-trust')
  const victimDir = path.join(outside, 'sessions')
  const sentinel = path.join(victimDir, 'keep.txt')
  await fs.promises.mkdir(victimDir, { recursive: true })
  await fs.promises.writeFile(sentinel, 'safe', 'utf8')
  try {
    await fs.promises.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'UNKNOWN') {
      t.skip(`symlinks unavailable: ${error.code}`)
      return
    }
    throw error
  }
  await assert.rejects(store.initialize(), /unsafe tab buffer root directory|root directory changed/)
  assert.equal(await fs.promises.readFile(sentinel, 'utf8'), 'safe')
})

test('global byte and entry quotas serialize concurrent sessions without evicting live refs', async () => {
  const { root, store } = await fresh({ maxBytes: 10, maxEntries: 2 })
  const secondStore = new TabBufferStore(root, { maxBytes: 10, maxEntries: 2 })
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) => (index % 2 ? store : secondStore).put(`session-${index}`, 'tab', '1234'))
  )
  const refs = attempts.filter((result) => result.status === 'fulfilled').map((result) => result.value)
  const failures = attempts.filter((result) => result.status === 'rejected')
  assert.equal(refs.length, 2)
  assert.equal(failures.length, 6)
  assert.ok(failures.every((result) => result.reason?.code === 'TAB_BUFFER_QUOTA_EXCEEDED'))
  assert.deepEqual(await Promise.all(refs.map((ref) => store.get(ref))), ['1234', '1234'])

  const buffers = (await filesBelow(root)).filter((file) => file.endsWith('.buf'))
  const bytes = (await Promise.all(buffers.map((file) => fs.promises.stat(file)))).reduce((sum, stat) => sum + stat.size, 0)
  assert.equal(buffers.length, 2)
  assert.equal(bytes, 8)
  await store.drop(refs[0])
  const replacement = await store.put('replacement', 'tab', '12')
  assert.equal(await store.get(replacement), '12')
  assert.equal(await store.get(refs[1]), '1234')
})

test('an individually oversized buffer is rejected before publishing any file', async () => {
  const { root, store } = await fresh({ maxBytes: 3, maxEntries: 2 })
  await assert.rejects(
    store.put('session', 'tab', '1234'),
    (error) => error?.code === 'TAB_BUFFER_QUOTA_EXCEEDED'
  )
  assert.equal((await filesBelow(root)).some((file) => file.endsWith('.buf') || file.endsWith('.tmp')), false)
})

test('path-like session and tab ids are hashed and cannot escape userData', async () => {
  const { parent, root, store } = await fresh()
  const sentinel = path.join(parent, 'DO-NOT-DELETE.txt')
  await fs.promises.writeFile(sentinel, 'safe', 'utf8')
  const ref = await store.put('../../outside/C:\\Windows', '..\\..\\evil.md', 'contained')
  assert.equal(await store.get(ref), 'contained')
  assert.equal(await store.clearSession('../../outside/C:\\Windows'), true)
  assert.equal(await fs.promises.readFile(sentinel, 'utf8'), 'safe')
  const remaining = await filesBelow(root)
  assert(remaining.every((file) => path.resolve(file).startsWith(path.resolve(root))))
})

test('forged or shape-shifted refs cannot read or delete a real buffer', async () => {
  const { store } = await fresh()
  const ref = JSON.parse(JSON.stringify(await store.put('secure', 'tab', 'SECRET')))
  const changes = [
    { session: '0'.repeat(64) },
    { tab: '1'.repeat(64) },
    { id: '2'.repeat(32) },
    { hash: '3'.repeat(64) },
    { size: ref.size + 1 },
    { sig: '4'.repeat(64) },
    { path: 'C:\\Windows\\win.ini' }
  ]
  for (const change of changes) {
    const forged = { ...ref, ...change }
    await assert.rejects(store.get(forged), /invalid|untrusted/)
    await assert.rejects(store.drop(forged), /invalid|untrusted/)
  }
  assert.equal(await store.get(ref), 'SECRET')
})

for (const point of ['after-temp', 'after-fsync', 'after-rename']) {
  test(`a ${point} failure never returns success and leaves no published buffer`, async () => {
    let fail = true
    const { root, store } = await fresh({
      fault: (seen) => {
        if (fail && seen === point) throw new Error(`injected ${point}`)
      }
    })
    await assert.rejects(store.put('failure-session', 'tab', 'must-not-publish'), new RegExp(`injected ${point}`))
    const leftovers = await filesBelow(root)
    assert.equal(leftovers.some((file) => file.endsWith('.tmp') || file.endsWith('.buf')), false)
    fail = false
    const ref = await store.put('failure-session', 'tab', 'later-success')
    assert.equal(await store.get(ref), 'later-success')
  })
}

test('tampering between rename and read-back makes put fail and removes the unverified target', async () => {
  const { root, store } = await fresh({
    fault: async (point, context) => {
      if (point === 'tamper') await fs.promises.appendFile(context.target, 'CORRUPTION', 'utf8')
    }
  })
  await assert.rejects(store.put('tamper-session', 'tab', 'original'), /read-back verification failed/)
  const leftovers = await filesBelow(root)
  assert.equal(leftovers.some((file) => file.endsWith('.tmp') || file.endsWith('.buf')), false)
})

test('get detects on-disk size and hash corruption before returning text', async () => {
  const { root, store } = await fresh()
  const ref = await store.put('integrity', 'tab', 'verified text')
  const target = await onlyBuffer(root)
  await fs.promises.appendFile(target, '!')
  await assert.rejects(store.get(ref), /size mismatch/)
  await fs.promises.writeFile(target, 'x'.repeat(ref.size), 'utf8')
  await assert.rejects(store.get(ref), /hash mismatch/)
  assert.equal(await store.drop(ref), true)
})

test('concurrent puts remain isolated and clearSession waits for all of them', async () => {
  const { store } = await fresh()
  const contents = Array.from({ length: 40 }, (_, index) => `TAB-${index}:${'x'.repeat(index * 17)}`)
  const refs = await Promise.all(contents.map((content, index) => store.put('shared-session', `tab-${index}`, content)))
  assert.equal(new Set(refs.map((ref) => ref.id)).size, refs.length)
  assert.deepEqual(await Promise.all(refs.map((ref) => store.get(ref))), contents)
  assert.equal(await store.clearSession('shared-session'), true)
  assert((await Promise.all(refs.map((ref) => store.get(ref)))).every((value) => value === null))
})

test('a session-directory junction cannot redirect get/drop/clear outside the store', async (t) => {
  const { parent, root, store } = await fresh()
  const ref = await store.put('junction-session', 'tab', 'inside')
  const target = await onlyBuffer(root)
  const sessionDir = path.dirname(target)
  const outside = path.join(parent, 'outside')
  const sentinel = path.join(outside, path.basename(target))
  await fs.promises.mkdir(outside, { recursive: true })
  await fs.promises.writeFile(sentinel, 'outside-safe', 'utf8')
  await fs.promises.rm(sessionDir, { recursive: true, force: true })
  try {
    await fs.promises.symlink(outside, sessionDir, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'UNKNOWN') {
      t.skip(`symlinks unavailable: ${error.code}`)
      return
    }
    throw error
  }
  await assert.rejects(store.get(ref), /unsafe|escaped/)
  await assert.rejects(store.drop(ref), /unsafe|escaped/)
  await assert.rejects(store.clearSession('junction-session'), /unsafe|escaped/)
  assert.equal(await fs.promises.readFile(sentinel, 'utf8'), 'outside-safe')
})

test('an 8 MiB cold-tab write verifies by stream and keeps the event loop alive', async (t) => {
  const { store } = await fresh()
  const content = '# large\n' + 'alpha beta gamma delta\n'.repeat(Math.ceil((8 * 1024 * 1024) / 23))
  let ticks = 0
  const ticker = setInterval(() => { ticks++ }, 1)
  const started = process.hrtime.bigint()
  const ref = await store.put('pressure-session', 'large-tab', content)
  const writeMs = Number(process.hrtime.bigint() - started) / 1e6
  clearInterval(ticker)
  assert.ok(ticks > 0, `streaming verification never yielded to the event loop (${writeMs.toFixed(1)}ms)`)
  assert.equal(await store.get(ref), content)
  t.diagnostic(`8MiB tab-buffer verified write: ${writeMs.toFixed(1)}ms, event-loop ticks: ${ticks}`)
})
