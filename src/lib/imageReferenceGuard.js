// Model-generated Markdown may contain compact, session-local image handles.
// They are capabilities, not filenames: an exact ID must exist in the current
// resource pool and suffixes such as ".jpg" must never be guessed or stripped.

const INTERNAL_ID = /^(?:el-\d+|(?:att|img)-[A-Za-z0-9_-]+)$/
// Generated handles always start with a numeric sequence. Keep ordinary
// relative filenames such as "el-diagram.png" legal; reserve only actual
// handle-shaped sources (plus the explicit knote-img: scheme).
const INTERNAL_LOOKING = /^(?:knote-img:|(?:el|att|img)-\d)/i
const CODE_SEGMENTS = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g
const MARKDOWN_IMAGE = /!\[([^\]\r\n]*)\]\(\s*([^\s)]+)(\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
const HTML_IMAGE_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi

export const canonicalInternalImageId = (source) => {
  const raw = String(source || '').trim()
  const id = raw.replace(/^knote-img:/i, '')
  return INTERNAL_ID.test(id) ? id : null
}

export const isInternalLookingImageSource = (source) => INTERNAL_LOOKING.test(String(source || '').trim())

const transformOutsideCode = (text, transform) => String(text ?? '')
  .split(CODE_SEGMENTS)
  .map((segment, index) => (index % 2 ? segment : transform(segment)))
  .join('')

const rewriteImageSources = (text, visit) => transformOutsideCode(text, (segment) => {
  let out = segment.replace(MARKDOWN_IMAGE, (whole, alt, source, title = '') => {
    const next = visit(source)
    return next === source ? whole : `![${alt}](${next}${title})`
  })
  out = out.replace(HTML_IMAGE_SRC, (whole, prefix, doubleQuoted, singleQuoted, unquoted) => {
    const source = doubleQuoted ?? singleQuoted ?? unquoted ?? ''
    const next = visit(source)
    if (next === source) return whole
    return `${prefix}"${String(next).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`
  })
  return out
})

export const validateInternalImageReferences = (text, { hasImage = () => false } = {}) => {
  const valid = []
  const invalid = []
  const normalized = rewriteImageSources(text, (source) => {
    if (!isInternalLookingImageSource(source)) return source
    const id = canonicalInternalImageId(source)
    if (!id) {
      invalid.push({ source, reason: 'malformed' })
      return source
    }
    if (!hasImage(id)) {
      invalid.push({ source, id, reason: 'not_found' })
      return source
    }
    valid.push(id)
    return `knote-img:${id}`
  })
  return {
    text: normalized,
    valid: [...new Set(valid)],
    invalid: invalid.filter((item, index, all) => (
      all.findIndex((candidate) => candidate.source === item.source && candidate.reason === item.reason) === index
    ))
  }
}

// Last-resort display guard for old/external documents. Tool writes are
// rejected earlier; this keeps a pre-existing bad handle visible and
// diagnosable instead of rendering a silent blank image.
export const replaceInvalidInternalImageReferences = (
  text,
  { hasImage = () => false, label = '图片引用无效' } = {}
) => rewriteImageSources(text, (source) => {
  if (!isInternalLookingImageSource(source)) return source
  const id = canonicalInternalImageId(source)
  if (id && hasImage(id)) return `knote-img:${id}`
  // The visitor normally returns a URL. A sentinel is used here and expanded
  // below because replacing only the URL would still create an <img>.
  return `knote-invalid-image-ref:${encodeURIComponent(source)}`
}).replace(
  /!\[([^\]\r\n]*)\]\(\s*knote-invalid-image-ref:([^)]+)\s*\)/g,
  (_whole, _alt, encoded) => `⚠ ${label}：\`${decodeURIComponent(encoded)}\``
).replace(
  /<img\b[^>]*\bsrc\s*=\s*"knote-invalid-image-ref:([^"]+)"[^>]*>/gi,
  (_whole, encoded) => `⚠ ${label}：\`${decodeURIComponent(encoded.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))}\``
)

export const imageResourceDescriptor = ({ id, type = 'image', page = null, caption = '' } = {}) => ({
  image_id: id,
  element_id: String(id || '').startsWith('el-') ? id : undefined,
  type,
  page,
  caption,
  markdown_reference: `![${String(caption || type || 'image').replace(/[\[\]]/g, ' ')}](${id})`,
  insert_image_args: { image_id: id }
})
