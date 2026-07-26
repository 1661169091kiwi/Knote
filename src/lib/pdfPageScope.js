export const normalizePdfTargetPages = (rawPages, { totalPages = 0, maxPages = 8 } = {}) => {
  const pages = Array.isArray(rawPages)
    ? [...new Set(rawPages.map((page) => Math.floor(Number(page))))]
    : []
  const invalid = pages.filter((page) => (
    !Number.isFinite(page) || page < 1 || (totalPages > 0 && page > totalPages)
  ))
  if (!pages.length) return { pages: [], overflow: [], invalid: [] }
  if (invalid.length) return { pages: [], overflow: [], invalid }
  return {
    pages: pages.slice(0, maxPages),
    overflow: pages.slice(maxPages),
    invalid: []
  }
}

// The page visitor is intentionally driven only by the normalized target list.
// It never iterates 1..document.numPages, which makes page-scoped PDF tools
// incapable of silently expanding a request such as [3, 7, 8] to the full PDF.
export const visitPdfTargetPages = async (pages, visit, onProgress = null) => {
  const results = []
  const targetTotal = pages.length
  for (let index = 0; index < targetTotal; index += 1) {
    const sourcePage = pages[index]
    const progress = { targetIndex: index + 1, targetTotal, sourcePage }
    if (onProgress) onProgress(progress)
    results.push(await visit(sourcePage, progress))
  }
  return results
}
