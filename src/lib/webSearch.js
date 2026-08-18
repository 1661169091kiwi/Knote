import {
  enabledExecutableSearchEngines,
  isConcreteSearchEngine,
  normalizeEnabledSearchEngines
} from './agentSearchConfig.js'
import { throwIfSearchAborted } from './agentSearchScheduler.js'

const TRACKING_PARAM = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i

const bounded = (value, maximum) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maximum)

export const canonicalWebSearchUrl = (value) => {
  try {
    const url = new URL(String(value || '').trim())
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key)
    url.searchParams.sort()
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.href.slice(0, 4096)
  } catch { return '' }
}

export const fuseWebSearchResults = (groups, maximum = 12) => {
  const merged = new Map()
  for (const [groupIndex, group] of (groups || []).entries()) {
    const engine = bounded(group?.engine, 40)
    const source = bounded(group?.source || engine, 80)
    const groupSeen = new Set()
    for (const [resultIndex, item] of (Array.isArray(group?.results) ? group.results : []).entries()) {
      const url = canonicalWebSearchUrl(item?.url)
      const title = bounded(item?.title, 500)
      if (!url || !title || groupSeen.has(url)) continue
      groupSeen.add(url)
      const rank = resultIndex + 1
      const score = 1 / (60 + rank)
      const snippet = bounded(item?.snippet, 1200)
      const existing = merged.get(url)
      if (!existing) {
        merged.set(url, {
          title,
          url,
          snippet,
          snippets: snippet ? [snippet] : [],
          provenance: [{ engine, source, rank }],
          score,
          firstGroup: groupIndex,
          firstRank: rank
        })
        continue
      }
      existing.score += score
      existing.provenance.push({ engine, source, rank })
      if (snippet && !existing.snippets.includes(snippet)) existing.snippets.push(snippet)
      existing.snippet = existing.snippets.join(' / ').slice(0, 1200)
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || a.firstGroup - b.firstGroup || a.firstRank - b.firstRank || a.url.localeCompare(b.url))
    .slice(0, Math.max(1, Math.min(20, Number(maximum) || 12)))
    .map(({ firstGroup, firstRank, snippets, ...item }) => ({ ...item, score: Number(item.score.toFixed(8)) }))
}

const failureOf = (engine, error) => ({
  engine,
  code: bounded(error?.code || 'SEARCH_SOURCE_FAILED', 80),
  status: Number.isInteger(Number(error?.status ?? error?.rate?.status)) ? Number(error?.status ?? error?.rate?.status) : null,
  retryable: error?.retryable !== false
})

export const runMultiEngineWebSearch = async ({
  query,
  engine,
  enabledEngines,
  executableEngines,
  execute,
  maxResults = 8,
  signal
} = {}) => {
  throwIfSearchAborted(signal)
  const normalizedQuery = String(query || '').trim()
  if (!normalizedQuery) return { ok: false, code: 'INVALID_QUERY', retryable: true, results: [], failures: [] }
  const enabled = normalizeEnabledSearchEngines(enabledEngines)
  const executable = enabledExecutableSearchEngines(enabled, executableEngines)
  const requested = String(engine || '').trim().toLowerCase()
  if (requested !== 'all' && !isConcreteSearchEngine(requested)) {
    return { ok: false, code: 'INVALID_SEARCH_ENGINE', retryable: false, results: [], failures: [] }
  }
  if (requested !== 'all' && !enabled.includes(requested)) {
    return { ok: false, code: 'SEARCH_ENGINE_DISABLED', retryable: false, results: [], failures: [{ engine: requested, code: 'SEARCH_ENGINE_DISABLED', status: null, retryable: false }] }
  }
  if (requested !== 'all' && !executable.includes(requested)) {
    return { ok: false, code: 'SEARCH_ENGINE_UNAVAILABLE', retryable: false, results: [], failures: [{ engine: requested, code: 'SEARCH_ENGINE_UNAVAILABLE', status: null, retryable: false }] }
  }
  const targets = requested === 'all' ? executable : [requested]
  if (!targets.length) return { ok: false, code: 'WEB_SEARCH_UNAVAILABLE', retryable: false, results: [], failures: [] }
  if (typeof execute !== 'function') throw new TypeError('A concrete web search executor is required')

  const completed = await Promise.all(targets.map(async (target) => {
    try {
      const response = await execute(target, { query: normalizedQuery, maxResults, signal })
      if (!response || response.ok === false) {
        const error = new Error(response?.code || response?.error || 'Search source failed')
        Object.assign(error, response || {})
        throw error
      }
      const actual = String(response.engine || target)
      const allowedJinaFallback = target === 'duckduckgo' && actual === 'jina-duckduckgo'
      if (actual !== target && !allowedJinaFallback) {
        const error = new Error(`Search engine mismatch for ${target}`)
        error.code = 'SEARCH_ENGINE_MISMATCH'
        error.retryable = false
        throw error
      }
      return {
        ok: true,
        engine: target,
        source: actual,
        results: Array.isArray(response.results) ? response.results : []
      }
    } catch (error) {
      if (signal?.aborted) throwIfSearchAborted(signal)
      if (error?.name === 'AbortError') throw error
      return { ok: false, failure: failureOf(target, error) }
    }
  }))
  const successes = completed.filter((item) => item.ok)
  const failures = completed.filter((item) => !item.ok).map((item) => item.failure)
  if (!successes.length) {
    return { ok: false, code: failures[0]?.code || 'WEB_SEARCH_FAILED', retryable: failures.some((item) => item.retryable), results: [], failures }
  }
  const results = fuseWebSearchResults(successes, maxResults)
  return {
    ok: true,
    code: results.length ? 'WEB_SEARCHED' : 'SEARCH_NO_RESULTS',
    query: normalizedQuery,
    engine: requested,
    engines: successes.map((item) => item.engine),
    sources: successes.map((item) => item.source),
    partial: failures.length > 0,
    results,
    failures
  }
}

export const parseJinaDuckDuckGoResults = (textValue, maximum = 8) => {
  const text = String(textValue || '').slice(0, 500_000)
  const results = []
  const seen = new Set()
  const markdownLink = /\[([^\]]{1,500})\]\((https?:\/\/[^\s)]+)\)/g
  let match
  while ((match = markdownLink.exec(text)) && results.length < maximum) {
    const url = canonicalWebSearchUrl(match[2])
    if (!url || seen.has(url) || /(?:^|\.)r\.jina\.ai\b|html\.duckduckgo\.com\/html/i.test(url)) continue
    seen.add(url)
    const tail = text.slice(markdownLink.lastIndex, markdownLink.lastIndex + 600).split(/\n\s*\n/)[0]
    results.push({ title: bounded(match[1], 500), url, snippet: bounded(tail, 1200) })
  }
  if (results.length) return results
  const rawUrls = text.match(/https?:\/\/[^\s)\]}>]+/g) || []
  for (const rawUrl of rawUrls) {
    const url = canonicalWebSearchUrl(rawUrl)
    if (!url || seen.has(url) || /(?:^|\.)r\.jina\.ai\b|html\.duckduckgo\.com\/html/i.test(url)) continue
    seen.add(url)
    let title = ''
    try { title = new URL(url).hostname } catch { title = url }
    results.push({ title, url, snippet: '' })
    if (results.length >= maximum) break
  }
  return results
}
