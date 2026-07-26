const escapeHtmlAttr = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')

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

export const serializeKnoteImage = ({ src = '', alt = '', width = null, align = null } = {}) => {
  const cleanAlt = String(alt || '').replace(/[\[\]]/g, ' ')
  const durableAlign = align === 'center' || align === 'right' ? align : null
  if (!width && !durableAlign) return `![${cleanAlt}](${src})`
  const style = []
  if (width) style.push(`width:${width}%`)
  if (durableAlign === 'center') style.push('display:block', 'margin-left:auto', 'margin-right:auto')
  if (durableAlign === 'right') style.push('display:block', 'margin-left:auto')
  return `<img src="${escapeHtmlAttr(src)}" alt="${escapeHtmlAttr(cleanAlt)}" style="${style.join(';')};">`
}

const addLegacyImageAlignment = (image, align) => {
  const css = alignmentCss(align)
  if (/^<img\b/i.test(image)) {
    if (/\bstyle\s*=\s*"[^"]*"/i.test(image)) {
      return image.replace(/\bstyle\s*=\s*"([^"]*)"/i, (_, old) => `style="${old.replace(/\s*;?\s*$/, ';')}${css}"`)
    }
    return image.replace(/^<img\b/i, `<img style="${css}"`)
  }
  const match = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)$/.exec(image.trim())
  if (!match) return null
  return `<img src="${escapeHtmlAttr(match[2])}" alt="${escapeHtmlAttr(match[1])}" style="${css}">`
}

// One-time compatibility path for documents serialized by older Knote builds.
// Accept same-line and next-line sentinels and convert both center/right before
// Markdown parsing, so the sentinel cannot become visible editor text.
export const migrateLegacyImageAlign = (markdown) => String(markdown || '').replace(
  /^:::\s*align:(center|right)\s*:::\s*(?:\r?\n[ \t]*)?(!\[[^\]\r\n]*\]\([^\r\n]*\)|<img\b[^\r\n>]*>)\s*$/gmi,
  (whole, align, image) => addLegacyImageAlignment(image, align) || whole
)
