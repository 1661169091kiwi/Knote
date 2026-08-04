import { estimateAgentTokens } from './tokenEstimate.js'

const rangeFrom = (start, total) => {
  const values = []
  for (let page = start; page <= total; page++) values.push(page)
  return values
}

const pageRanges = (pages) => {
  const values = [...new Set((pages || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b)
  const ranges = []
  let start = null
  let end = null
  for (const page of values) {
    if (start === null) { start = page; end = page; continue }
    if (page === end + 1) { end = page; continue }
    ranges.push(start === end ? `${start}` : `${start}-${end}`)
    start = page
    end = page
  }
  if (start !== null) ranges.push(start === end ? `${start}` : `${start}-${end}`)
  return ranges.join('、')
}

export const pdfTextTokenBudget = ({ ctxWindow = 0, baseTokens = 0, pdfCount = 1 } = {}) => {
  const count = Math.max(1, Math.floor(Number(pdfCount) || 1))
  const context = Math.max(0, Math.floor(Number(ctxWindow) || 0))
  if (!context) return Math.floor(12000 / count)
  const outputReserve = Math.min(8192, Math.max(2048, Math.floor(context * 0.25)))
  const available = Math.max(0, context - outputReserve - Math.max(0, Number(baseTokens) || 0) - 512)
  return Math.floor(available / count)
}

export const createPdfTextDelivery = ({ attachmentName, attachmentId, numPages, maxTokens }) => {
  const totalPages = Math.max(0, Math.floor(Number(numPages) || 0))
  const tokenLimit = Math.max(0, Math.floor(Number(maxTokens) || 0))
  const contentLimit = Math.max(0, tokenLimit - 512)
  const blocks = []
  const includedPages = []
  const textPages = []
  const emptyPages = []
  const failedPages = []
  let omittedPages = []
  let usedTokens = 0

  const addBlock = (page, body, kind) => {
    const block = `【第 ${page} 页】\n${body}`
    const tokens = estimateAgentTokens(block)
    if (usedTokens + tokens > contentLimit) {
      omittedPages = rangeFrom(page, totalPages)
      return false
    }
    blocks.push(block)
    includedPages.push(page)
    usedTokens += tokens
    if (kind === 'text') textPages.push(page)
    else if (kind === 'empty') emptyPages.push(page)
    else if (kind === 'failed') failedPages.push(page)
    return true
  }

  const addTextPage = (page, text) => addBlock(page, String(text || ''), 'text')
  const addEmptyPage = (page) => addBlock(
    page,
    '（该页没有可提取的文本层；需要查看时请显式调用 render_pdf_page 或 pdf_prepare。）',
    'empty'
  )
  const addFailedPage = (page) => addBlock(
    page,
    '（该页文本层读取失败；需要查看时请显式调用 render_pdf_page 或 pdf_prepare。）',
    'failed'
  )

  const finish = () => {
    const unreadable = emptyPages.length + failedPages.length + omittedPages.length
    const coverage = textPages.length === 0
      ? 'none'
      : unreadable === 0 && includedPages.length === totalPages ? 'complete' : 'partial'
    const notes = []
    if (emptyPages.length) notes.push(`第 ${pageRanges(emptyPages)} 页没有文本层。`)
    if (failedPages.length) notes.push(`第 ${pageRanges(failedPages)} 页文本层读取失败。`)
    if (omittedPages.length) notes.push(`受上下文预算限制，第 ${pageRanges(omittedPages)} 页尚未读取。`)
    const status = coverage === 'complete' ? '完整' : coverage === 'partial' ? '部分' : '没有可用'
    const text = [
      `【PDF《${attachmentName}》文本层${status}读取（attachment_id=${attachmentId}，共 ${totalPages} 页，coverage=${coverage}）。${coverage === 'complete' ? '需要图、表时仍只解析确定页码。' : '不得把未覆盖页面视为已读；有工具时按页继续读取或渲染。'}】`,
      ...blocks,
      ...notes.map((note) => `【提示：${note}】`)
    ].join('\n\n')
    return {
      text,
      coverage,
      includedPages,
      textPages,
      emptyPages,
      failedPages,
      omittedPages,
      contentChars: blocks.reduce((total, block) => total + block.length, 0),
      textTokens: estimateAgentTokens(text),
      textBudgetTokens: tokenLimit
    }
  }

  return { addTextPage, addEmptyPage, addFailedPage, finish }
}
