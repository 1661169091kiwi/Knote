const escapeHtmlAttr = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/[\r\n]+/g, ' ')

const escapeMarkdownAlt = (value) => String(value || '')
  .replace(/\\/g, '\\\\')
  .replace(/([\[\]])/g, '\\$1')
  .replace(/[\r\n]+/g, ' ')

const escapeMarkdownTitle = (value) => String(value || '')
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/[\r\n]+/g, ' ')

const markdownDestination = (src) => {
  const value = String(src || '')
  // Angle destinations keep spaces and parentheses unambiguous. A literal
  // `>` cannot be represented there safely, so the caller falls back to HTML.
  if (/[\s()]/.test(value)) return value.includes('>') ? null : `<${value}>`
  return value
}

const finiteNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const formatCssNumber = (value) => String(Math.round(Number(value) * 1000) / 1000)

export const normalizeImageScale = (value) => {
  const number = finiteNumber(value)
  return number !== null && number > 0 && number <= 100 ? number : null
}

export const normalizeImageIntrinsicWidth = (value) => {
  const number = finiteNumber(value)
  return number !== null && number > 0 && number <= 10_000_000 ? number : null
}

// A natural-size image initially occupies min(intrinsicWidth, containerWidth).
// Applying the same scale to BOTH limits preserves that meaning at every
// viewport width: min(scale% of the container, scale% of the intrinsic width).
export const scaledImageCssWidth = ({ scale = null, intrinsicWidth = null } = {}) => {
  const safeScale = normalizeImageScale(scale)
  const safeIntrinsicWidth = normalizeImageIntrinsicWidth(intrinsicWidth)
  if (safeScale === null || safeIntrinsicWidth === null) return ''
  return `min(${formatCssNumber(safeScale)}%,${formatCssNumber(safeIntrinsicWidth * safeScale / 100)}px)`
}

const SCALED_IMAGE_WIDTH_RE = /^min\(\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)px\s*\)$/i

// Prefer the durable data attributes, but recover from the portable CSS width
// if another Markdown editor preserved style while dropping data-* metadata.
export const inferImageSizing = ({ scale = '', intrinsicWidth = '', cssWidth = '' } = {}) => {
  let safeScale = normalizeImageScale(scale)
  let safeIntrinsicWidth = normalizeImageIntrinsicWidth(intrinsicWidth)
  const match = SCALED_IMAGE_WIDTH_RE.exec(String(cssWidth || '').trim())
  if (match) {
    const cssScale = normalizeImageScale(match[1])
    const scaledPixels = normalizeImageIntrinsicWidth(match[2])
    if (safeScale === null) safeScale = cssScale
    if (safeIntrinsicWidth === null && safeScale !== null && scaledPixels !== null) {
      safeIntrinsicWidth = normalizeImageIntrinsicWidth(scaledPixels * 100 / safeScale)
    }
  }
  if (safeScale === null || safeIntrinsicWidth === null) {
    return { scale: null, intrinsicWidth: null }
  }
  return { scale: safeScale, intrinsicWidth: safeIntrinsicWidth }
}

const alignmentCss = (align) => align === 'center'
  ? 'display:block;margin-left:auto;margin-right:auto;'
  : 'display:block;margin-left:auto;'

export const inferImageAlignment = ({ parentTextAlign = '', marginLeft = '', marginRight = '' } = {}) => {
  const parent = String(parentTextAlign).toLowerCase()
  if (parent === 'center' || parent === 'right') return parent
  const left = String(marginLeft).toLowerCase()
  const right = String(marginRight).toLowerCase()
  if (left === 'auto' && right === 'auto') return 'center'
  if (left === 'auto') return 'right'
  return null
}

export const serializeKnoteImage = ({
  src = '',
  alt = '',
  title = '',
  width = null,
  scale = null,
  intrinsicWidth = null,
  align = null
} = {}) => {
  const source = String(src || '')
  const cleanAlt = String(alt || '').replace(/[\r\n]+/g, ' ')
  const cleanTitle = String(title || '').replace(/[\r\n]+/g, ' ')
  const durableAlign = align === 'center' || align === 'right' ? align : null
  const sizing = inferImageSizing({ scale, intrinsicWidth })
  const scaledWidth = scaledImageCssWidth(sizing)
  const destination = markdownDestination(source)
  const requiresHtml = Boolean(width || scaledWidth || durableAlign) || destination === null || /^(?:file:|[a-zA-Z]:[\\/])/.test(source)
  if (!requiresHtml) {
    const titlePart = cleanTitle ? ` "${escapeMarkdownTitle(cleanTitle)}"` : ''
    return `![${escapeMarkdownAlt(cleanAlt)}](${destination}${titlePart})`
  }
  const style = []
  if (scaledWidth) style.push(`width:${scaledWidth}`)
  else if (width) style.push(`width:${width}%`)
  if (durableAlign === 'center') style.push('display:block', 'margin-left:auto', 'margin-right:auto')
  if (durableAlign === 'right') style.push('display:block', 'margin-left:auto')
  const titleAttr = cleanTitle ? ` title="${escapeHtmlAttr(cleanTitle)}"` : ''
  const scaleAttrs = scaledWidth
    ? ` data-knote-scale="${formatCssNumber(sizing.scale)}" data-knote-intrinsic-width="${formatCssNumber(sizing.intrinsicWidth)}"`
    : ''
  const styleAttr = style.length ? ` style="${style.join(';')};"` : ''
  return `<img src="${escapeHtmlAttr(source)}" alt="${escapeHtmlAttr(cleanAlt)}"${titleAttr}${scaleAttrs}${styleAttr}>`
}

const addLegacyImageAlignment = (image, align) => {
  const css = alignmentCss(align)
  if (/^<img\b/i.test(image)) {
    if (/\bstyle\s*=\s*"[^"]*"/i.test(image)) {
      return image.replace(/\bstyle\s*=\s*"([^"]*)"/i, (_, old) => `style="${old.replace(/\s*;?\s*$/, ';')}${css}"`)
    }
    return image.replace(/^<img\b/i, `<img style="${css}"`)
  }
  const match = /^!\[([^\]]*)\]\(\s*(?:<([^>\r\n]*)>|((?:\\.|[^)\s])+))(?:\s+(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'))?\s*\)$/.exec(image.trim())
  if (!match) return null
  const unescapeMarkdown = (value) => String(value || '').replace(/\\([\\"'\[\]])/g, '$1')
  return serializeKnoteImage({
    src: unescapeMarkdown(match[2] || match[3]),
    alt: unescapeMarkdown(match[1]),
    title: unescapeMarkdown(match[4] || match[5]),
    align
  })
}

// One-time compatibility path for documents serialized by older Knote builds.
// Accept same-line and next-line sentinels and convert both center/right before
// Markdown parsing, so the sentinel cannot become visible editor text.
export const migrateLegacyImageAlign = (markdown) => String(markdown || '').replace(
  /^:::\s*align:(center|right)\s*:::\s*(?:\r?\n[ \t]*)?(!\[[^\]\r\n]*\]\([^\r\n]*\)|<img\b[^\r\n>]*>)\s*$/gmi,
  (whole, align, image) => addLegacyImageAlignment(image, align) || whole
)
