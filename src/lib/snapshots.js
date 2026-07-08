// Local version snapshots: lightweight document history in localStorage.
// A snapshot is taken at each disk save (and periodically) so the user can
// browse past versions and roll back — a safety net beyond Ctrl+Z that
// survives reloads. Storage is capped hard so a big document's history can
// never blow the localStorage quota.

const PREFIX = 'knote-snap:'
const MAX_PER_DOC = 25
const MAX_BYTES_PER_DOC = 1_200_000 // ~1.2 MB of history per document

const keyFor = (docKey) => PREFIX + docKey

const read = (docKey) => {
  try {
    const raw = localStorage.getItem(keyFor(docKey))
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

const write = (docKey, list) => {
  try {
    localStorage.setItem(keyFor(docKey), JSON.stringify(list))
    return true
  } catch {
    // quota: drop the oldest half and retry once
    try {
      localStorage.setItem(keyFor(docKey), JSON.stringify(list.slice(Math.ceil(list.length / 2))))
      return true
    } catch { return false }
  }
}

// Add a snapshot. No-ops when the content matches the most recent snapshot
// (so repeated saves without edits don't pile up). `now` is passed in by the
// caller (Date.now() isn't available to some sandboxes). Returns true if a
// new snapshot was stored.
export const addSnapshot = (docKey, content, now, label = '') => {
  if (!docKey || content == null) return false
  const list = read(docKey)
  if (list.length && list[list.length - 1].content === content) return false
  list.push({ t: now, content, label })
  // trim by count
  while (list.length > MAX_PER_DOC) list.shift()
  // trim by bytes (keep newest)
  let bytes = list.reduce((s, x) => s + x.content.length, 0)
  while (list.length > 1 && bytes > MAX_BYTES_PER_DOC) {
    bytes -= list[0].content.length
    list.shift()
  }
  return write(docKey, list)
}

// Newest-first list, content omitted from the summary to stay light
export const listSnapshots = (docKey) =>
  read(docKey).map((x, i) => ({ index: i, t: x.t, label: x.label, size: x.content.length }))
    .reverse()

export const getSnapshot = (docKey, index) => {
  const list = read(docKey)
  return list[index] ? list[index].content : null
}

export const clearSnapshots = (docKey) => {
  try { localStorage.removeItem(keyFor(docKey)) } catch { /* ignore */ }
}
