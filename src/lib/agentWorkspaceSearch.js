import { utf8ByteLength } from './agentSourceContinuation.js'

const normalizedPath = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')

const fingerprint = (value) => {
  const text = String(value || '')
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`
}

const normalizedSources = (sources) => (Array.isArray(sources) ? sources : [])
  .map((source) => ({
    path: normalizedPath(source?.path),
    revision: String(source?.revision || ''),
    loadText: typeof source?.loadText === 'function'
      ? source.loadText
      : async () => String(source?.text ?? '')
  }))
  .filter((source) => source.path && source.revision)
  .sort((left, right) => left.path.localeCompare(right.path))

export const workspaceSearchSnapshot = (sources) => fingerprint(JSON.stringify(
  normalizedSources(sources).map((source) => [source.path, source.revision])
))

const validPosition = (value, sourceCount) => {
  const source = value && typeof value === 'object' ? value : {}
  const fields = ['file_index', 'line_index', 'match_offset', 'skipped_regex_lines', 'failed_files']
  if (Object.keys(source).some((key) => !fields.includes(key))) return null
  const fileIndex = Number(source.file_index ?? 0)
  const lineIndex = Number(source.line_index ?? 0)
  const matchOffset = Number(source.match_offset ?? 0)
  const skippedRegexLines = Number(source.skipped_regex_lines ?? 0)
  const failedFiles = Number(source.failed_files ?? 0)
  if (
    !Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex > sourceCount ||
    !Number.isSafeInteger(lineIndex) || lineIndex < 0 ||
    !Number.isSafeInteger(matchOffset) || matchOffset < 0 ||
    !Number.isSafeInteger(skippedRegexLines) || skippedRegexLines < 0 ||
    !Number.isSafeInteger(failedFiles) || failedFiles < 0
  ) return null
  return { fileIndex, lineIndex, matchOffset, skippedRegexLines, failedFiles }
}

const excerptForMatch = (line, start, length) => {
  const radius = 80
  const from = Math.max(0, start - radius)
  const to = Math.min(line.length, start + Math.max(1, length) + radius)
  return {
    text: `${from > 0 ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`,
    snippetTruncated: from > 0 || to < line.length
  }
}

const nestedQuantifier = (query) => /\([^()]*[*+{][^()]*\)\s*[*+{]/.test(query)

const nextCodeUnitOffset = (text, offset) => {
  const codePoint = text.codePointAt(offset)
  return offset + (codePoint != null && codePoint > 0xffff ? 2 : 1)
}

const groupedHits = (hits) => {
  const groups = []
  for (const hit of hits) {
    let group = groups[groups.length - 1]
    if (!group || group.path !== hit.path) {
      group = { path: hit.path, hits: [] }
      groups.push(group)
    }
    group.hits.push({
      line: hit.line,
      column: hit.column,
      match_offset: hit.match_offset,
      text: hit.text,
      snippet_truncated: hit.snippet_truncated
    })
  }
  return groups
}

// Scans complete literal lines. Regex input remains bounded per physical line;
// every skipped regex line is carried through subsequent cursors so the final
// page can never be mislabeled SEARCH_COMPLETE.
export const searchWorkspaceSources = async (sourcesValue, {
  query,
  isRegex = false,
  position = null,
  expectedSnapshot = '',
  maxMatches = 200,
  maxPerFile = 25,
  timeBudgetMs = 3000,
  regexLineBytes = 2000,
  now = () => Date.now()
} = {}) => {
  const queryText = String(query || '')
  if (!queryText) return { error: 'empty_query' }
  if (isRegex && nestedQuantifier(queryText)) return { error: 'unsafe_regex' }
  let regex = null
  if (isRegex) {
    try { regex = new RegExp(queryText, 'giu') } catch (error) {
      return { error: 'invalid_regex', detail: String(error?.message || error) }
    }
  }
  const sources = normalizedSources(sourcesValue)
  const snapshot = workspaceSearchSnapshot(sources)
  if (expectedSnapshot && expectedSnapshot !== snapshot) {
    return { error: 'cursor_stale', snapshot }
  }
  const startPosition = validPosition(position, sources.length)
  if (!startPosition) return { error: 'cursor_invalid', snapshot }

  const matchLimit = Math.max(1, Math.min(500, Number(maxMatches) || 200))
  const fileLimit = Math.max(1, Math.min(100, Number(maxPerFile) || 25))
  const deadline = Math.max(1, Number(timeBudgetMs) || 3000)
  const regexLimit = Math.max(128, Number(regexLineBytes) || 2000)
  const startedAt = now()
  const hits = []
  let fileIndex = startPosition.fileIndex
  let lineIndex = startPosition.lineIndex
  let matchOffset = startPosition.matchOffset
  let skippedRegexLines = startPosition.skippedRegexLines
  let failedFiles = startPosition.failedFiles
  let timedOut = false
  let capReason = ''

  const timedOutNow = () => now() - startedAt >= deadline
  const nextPosition = () => ({
    file_index: fileIndex,
    line_index: lineIndex,
    match_offset: matchOffset,
    skipped_regex_lines: skippedRegexLines,
    failed_files: failedFiles
  })

  while (fileIndex < sources.length) {
    if (timedOutNow()) { timedOut = true; break }
    const source = sources[fileIndex]
    let text
    try { text = String(await source.loadText()) } catch {
      failedFiles++
      fileIndex++
      lineIndex = 0
      matchOffset = 0
      continue
    }
    const lines = text.split('\n')
    let hitsInFile = 0
    while (lineIndex < lines.length) {
      if (timedOutNow()) { timedOut = true; break }
      const line = lines[lineIndex]
      if (isRegex && utf8ByteLength(line) > regexLimit) {
        skippedRegexLines++
        lineIndex++
        matchOffset = 0
        continue
      }

      if (isRegex) {
        regex.lastIndex = Math.min(matchOffset, line.length)
        let match
        while ((match = regex.exec(line))) {
          const start = match.index
          const length = match[0].length
          const excerpt = excerptForMatch(line, start, length)
          hits.push({
            path: source.path,
            line: lineIndex + 1,
            column: start + 1,
            match_offset: start,
            text: excerpt.text,
            snippet_truncated: excerpt.snippetTruncated
          })
          hitsInFile++
          matchOffset = length > 0 ? start + length : nextCodeUnitOffset(line, start)
          regex.lastIndex = matchOffset
          if (hits.length >= matchLimit || hitsInFile >= fileLimit) {
            capReason = hits.length >= matchLimit ? 'global_match_limit' : 'file_match_limit'
            break
          }
          if (timedOutNow()) { timedOut = true; break }
        }
      } else {
        const lowerLine = line.toLowerCase()
        const lowerQuery = queryText.toLowerCase()
        let found = lowerLine.indexOf(lowerQuery, Math.min(matchOffset, lowerLine.length))
        while (found >= 0) {
          const excerpt = excerptForMatch(line, found, queryText.length)
          hits.push({
            path: source.path,
            line: lineIndex + 1,
            column: found + 1,
            match_offset: found,
            text: excerpt.text,
            snippet_truncated: excerpt.snippetTruncated
          })
          hitsInFile++
          matchOffset = found + Math.max(1, lowerQuery.length)
          if (hits.length >= matchLimit || hitsInFile >= fileLimit) {
            capReason = hits.length >= matchLimit ? 'global_match_limit' : 'file_match_limit'
            break
          }
          if (timedOutNow()) { timedOut = true; break }
          found = lowerLine.indexOf(lowerQuery, matchOffset)
        }
      }
      if (timedOut || capReason) break
      lineIndex++
      matchOffset = 0
    }
    if (timedOut || capReason) break
    fileIndex++
    lineIndex = 0
    matchOffset = 0
  }

  const hasMore = timedOut || !!capReason
  const unrecoverableReason = skippedRegexLines
    ? 'regex_line_limit'
    : failedFiles
      ? 'source_read_failed'
      : ''
  const sourceComplete = !hasMore && !unrecoverableReason
  return {
    snapshot,
    results: groupedHits(hits),
    returnedMatches: hits.length,
    timedOut,
    hitCap: capReason === 'global_match_limit',
    fileCap: capReason === 'file_match_limit',
    hasMore,
    nextPosition: hasMore ? nextPosition() : null,
    sourceComplete,
    skippedRegexLines,
    failedFiles,
    reason: timedOut ? 'time_budget' : capReason || unrecoverableReason || ''
  }
}
