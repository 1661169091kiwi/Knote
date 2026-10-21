// Markdown examples in fenced/inline code must remain literal. The editor emits
// image HTML on one line, so a small code-aware line scanner is enough here and
// avoids introducing a full Markdown parse on every keystroke.
import { wikilinkImageTarget } from './markdownWikilinks.js'
import { htmlImageTags } from './htmlImageTags.js'
const forEachEditableSegment = (source, visit) => {
  const text = String(source || '')
  const lines = text.split(/(\r?\n)/)
  let fenced = null

  return lines.map((line) => {
    if (/^\r?\n$/.test(line)) return line
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fence) {
      const token = fence[1]
      if (!fenced) fenced = { char: token[0], length: token.length }
      else if (token[0] === fenced.char && token.length >= fenced.length) fenced = null
      return line
    }
    if (fenced || !line.includes('`')) return fenced ? line : visit(line)

    let out = ''
    let cursor = 0
    while (cursor < line.length) {
      const open = line.slice(cursor).match(/`+/)
      if (!open) { out += visit(line.slice(cursor)); break }
      const start = cursor + open.index
      out += visit(line.slice(cursor, start))
      const ticks = open[0]
      const close = line.indexOf(ticks, start + ticks.length)
      if (close < 0) { out += line.slice(start); break }
      out += line.slice(start, close + ticks.length)
      cursor = close + ticks.length
    }
    return out
  }).join('')
}

const RESOURCE_MARKER = 'knote-resource='
const RESOURCE_TOKEN_MARKER = 'knote-token='
const RESOURCE_TOKEN = globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2)}`

const isDataImage = (value) => /^data:image\//i.test(String(value || ''))

const unsafeDecodedSegment = (value, first) => {
  const segment = String(value || '')
  return !segment || segment === '.' || segment === '..' || /[\\/\0\r\n]/.test(segment) ||
    (first && /^(?:[a-z][a-z0-9+.-]*:|[a-z]:|#)/i.test(segment))
}

export const decodeRelativeResourcePath = (value) => {
  const path = String(value || '')
  if (!path || /[\\\0\r\n]/.test(path) || /^(?:[a-z][a-z0-9+.-]*:|[\/]|#)/i.test(path)) return null
  const clean = path.replace(/^\.\//, '')
  const rawSegments = clean.split('/')
  if (!rawSegments.length || rawSegments.some((segment) => !segment)) return null
  const decoded = []
  for (let index = 0; index < rawSegments.length; index++) {
    let segment
    try { segment = decodeURIComponent(rawSegments[index]) } catch { return null }
    if (unsafeDecodedSegment(segment, index === 0)) return null
    // Decode only once for the actual lookup, but inspect bounded nested
    // encodings so `%252e%252e%252f...` cannot become traversal downstream.
    let probe = segment
    for (let depth = 0; depth < 3 && probe.includes('%'); depth++) {
      let next
      try { next = decodeURIComponent(probe) } catch { break }
      if (next === probe) break
      probe = next
      if (unsafeDecodedSegment(probe, index === 0)) return null
    }
    decoded.push(segment)
  }
  return decoded
}

const isDurableRelativePath = (value) => decodeRelativeResourcePath(value) !== null

const tagResolvedDataUrl = (dataUrl, resourcePath) => {
  const source = String(dataUrl)
  const hash = source.indexOf('#')
  const base = hash < 0 ? source : source.slice(0, hash) + source.slice(hash).replace(/([#&])knote-(?:resource|token)=[^&#]*/gi, '')
  const separator = base.includes('#') ? '&' : '#'
  return `${base}${separator}${RESOURCE_MARKER}${encodeURIComponent(resourcePath)}&${RESOURCE_TOKEN_MARKER}${encodeURIComponent(RESOURCE_TOKEN)}`
}

const restoreTaggedResource = (value) => {
  const source = String(value || '')
  if (!isDataImage(source)) return null
  // Provenance is a URL fragment, never part of its image payload. Avoid
  // repeatedly running both expressions across the Base64 bytes.
  const fragmentStart = source.indexOf('#')
  if (fragmentStart < 0) return null
  const fragment = source.slice(fragmentStart)
  const match = /(?:#|&)knote-resource=([^&#]*)/i.exec(fragment)
  const tokenMatch = /(?:#|&)knote-token=([^&#]*)/i.exec(fragment)
  if (!match || !tokenMatch) return null
  try {
    if (decodeURIComponent(tokenMatch[1]) !== RESOURCE_TOKEN) return null
    const path = decodeURIComponent(match[1])
    return isDurableRelativePath(path) ? path : null
  } catch {
    return null
  }
}

const decodeHtmlAttr = (value) => String(value || '')
  .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
    const n = code[0].toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10)
    return Number.isFinite(n) ? String.fromCodePoint(n) : _
  })
  .replace(/&quot;/gi, '"')
  .replace(/&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&amp;/gi, '&')

const encodeHtmlAttr = (value, quote = '"') => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&#39;')

// Walk Markdown image destinations without treating a balanced `)` inside the
// path as the end of the image. The title, whitespace and original angle form
// are left byte-for-byte unchanged.
const rewriteMarkdownImageUrls = (source, transform, collectOnly = false) => {
  let out = ''
  let cursor = 0
  // Let the native regexp engine skip ordinary URL runs (including megabytes
  // of Base64). Only Markdown delimiters need JavaScript-level handling.
  // Keep this local: transforms may themselves invoke another rewrite.
  const delimiters = /[\\()\s]/g
  while (cursor < source.length) {
    const start = source.indexOf('![', cursor)
    if (start < 0) { out += source.slice(cursor); break }
    // `![[file.ext]]` wikilink embeds: rewrite just the file part in place so
    // sibling-file resolution and the data-URL display swap work for the
    // Obsidian form exactly as for `![alt](file.ext)`. A `|300` size suffix
    // and non-image targets are left untouched (they fall through to the
    // standard scanner, which skips this form).
    if (source.startsWith('[[', start + 1)) {
      const close = source.indexOf(']]', start + 3)
      const inner = close > 0 ? source.slice(start + 3, close) : null
      const bare = inner !== null ? wikilinkImageTarget(inner) : null
      if (bare) {
        out += source.slice(cursor, start + 3) + transform(bare) + inner.slice(bare.length) + ']]'
        cursor = close + 2
        continue
      }
    }
    let altEnd = start + 2
    for (; altEnd < source.length; altEnd += 1) {
      if (source[altEnd] === ']' && source[altEnd - 1] !== '\\') break
    }
    if (altEnd >= source.length || source[altEnd + 1] !== '(') {
      out += source.slice(cursor, start + 2)
      cursor = start + 2
      continue
    }
    let valueStart = altEnd + 2
    while (/\s/.test(source[valueStart] || '')) valueStart += 1
    let valueEnd = valueStart
    let angle = false
    if (source[valueStart] === '<') {
      angle = true
      valueStart += 1
      valueEnd = source.indexOf('>', valueStart)
      if (valueEnd < 0) {
        out += source.slice(cursor, start + 2)
        cursor = start + 2
        continue
      }
    } else {
      let depth = 0
      delimiters.lastIndex = valueStart
      valueEnd = source.length
      let delimiter
      while ((delimiter = delimiters.exec(source))) {
        const ch = delimiter[0]
        if (ch === '\\') { delimiters.lastIndex += 1; continue }
        if (ch === '(') { depth += 1; continue }
        if (ch === ')') {
          if (depth === 0) { valueEnd = delimiter.index; break }
          depth -= 1
          continue
        }
        if (depth === 0) { valueEnd = delimiter.index; break }
      }
    }
    const value = source.slice(valueStart, valueEnd)
    const next = transform(value)
    out += source.slice(cursor, valueStart)
    out += collectOnly ? value : next
    cursor = valueEnd
    // `>` belongs to the source suffix and remains intact.
    if (angle && source[cursor] !== '>') cursor = valueEnd
  }
  return out
}

// Separate quote branches let the regex engine skip the value in native code;
// a lazy dot plus a quote backreference checks every Base64 character.
const SRC_ATTR = /(\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i

const rewriteHtmlImageUrls = (source, transform) => {
  if (source.indexOf('<') < 0) return source
  const parts = []
  let cursor = 0
  for (const { start, end } of htmlImageTags(source)) {
    const tag = source.slice(start, end)
    const rewritten = tag.replace(SRC_ATTR, (whole, prefix, doubleQuoted, singleQuoted, unquoted) => {
      const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : ''
      const value = decodeHtmlAttr(doubleQuoted ?? singleQuoted ?? unquoted)
      const next = transform(value)
      if (next === value) return whole
      const durableQuote = quote || '"'
      return `${prefix}${durableQuote}${encodeHtmlAttr(next, durableQuote)}${durableQuote}`
    })
    if (rewritten === tag) continue
    parts.push(source.slice(cursor, start), rewritten)
    cursor = end
  }
  return parts.length ? parts.join('') + source.slice(cursor) : source
}

const rewriteImageUrls = (source, transform) => {
  const markdown = rewriteMarkdownImageUrls(source, transform)
  return rewriteHtmlImageUrls(markdown, transform)
}

export const rewriteImageResourcePaths = (markdown, mappings) => {
  const rows = (Array.isArray(mappings) ? mappings : Object.entries(mappings || {}))
    .filter((row) => Array.isArray(row) && row.length >= 2 && row[0] && row[1])
    .map(([from, to]) => [String(from), String(to)])
  const map = new Map(rows)
  const resolved = new Map()
  const forwardDisplayMap = rows.some(([from, to]) => isDurableRelativePath(from) && isDataImage(to))

  return forEachEditableSegment(markdown, (segment) => rewriteImageUrls(segment, (value) => {
    // New display URLs carry their durable source path. Restore this before
    // consulting the volatile cache, so a tab switch/cache clear cannot turn a
    // relative image into an embedded or `knote-img:` resource.
    const tagged = restoreTaggedResource(value)
    if (tagged) return forwardDisplayMap ? value : tagged

    const mapped = map.get(value)
    if (!mapped) return value
    if (isDurableRelativePath(value) && isDataImage(mapped)) {
      if (!resolved.has(value)) resolved.set(value, tagResolvedDataUrl(mapped, value))
      return resolved.get(value)
    }
    // A bare data URL may be a genuine embedded image. Reverse maps are
    // therefore intentionally accepted only through the marker above; mapping
    // an untagged value silently aliases equal-byte images to the first path.
    if (isDataImage(value) && isDurableRelativePath(mapped)) return value
    return mapped
  }))
}

export const collectImageResourcePaths = (markdown) => {
  const paths = new Set()
  forEachEditableSegment(markdown, (segment) => {
    rewriteImageUrls(segment, (value) => {
      paths.add(restoreTaggedResource(value) || value)
      return value
    })
    return segment
  })
  return [...paths].filter(isDurableRelativePath)
}

// Display-cache updates are not document replacements. Only accept changes
// explained entirely by this session's authenticated relative-image markers;
// real text/format/path changes must still take the normal external-edit path.
export const imageDisplaySourceChanges = (previousValue, nextValue) => {
  const previous = String(previousValue ?? '')
  const next = String(nextValue ?? '')
  if (previous === next) return null
  if (!previous.includes(RESOURCE_MARKER) && !next.includes(RESOURCE_MARKER)) return null
  if (rewriteImageResourcePaths(previous, []) !== rewriteImageResourcePaths(next, [])) {
    // Saving a newly cropped/embedded image can externalize its exact bytes
    // into a local asset. That is a display-source update too, not a reason
    // to reparse the whole document and lose selection/history. Only trust
    // authenticated next URLs, byte-identical payloads and unchanged markup.
    const byPayload = new Map()
    const withoutProvenance = value => value.replace(/([#&])knote-(?:resource|token)=[^&#]*/gi, '')
    forEachEditableSegment(next, segment => rewriteImageUrls(segment, value => {
      if (restoreTaggedResource(value)) {
        const payload = withoutProvenance(value)
        if (!byPayload.has(payload)) byPayload.set(payload, value)
        else if (byPayload.get(payload) !== value) byPayload.set(payload, null)
      }
      return value
    }))
    const changes = new Map()
    const normalized = forEachEditableSegment(previous, segment => rewriteImageUrls(segment, value => {
      const replacement = isDataImage(value) && !restoreTaggedResource(value) ? byPayload.get(value) : null
      if (!replacement) return value
      changes.set(value, replacement)
      return replacement
    }))
    return changes.size && normalized === next ? changes : null
  }
  const nextSources = new Map()
  let conflicting = false
  forEachEditableSegment(next, segment => rewriteImageUrls(segment, value => {
    const resource = restoreTaggedResource(value)
    if (resource) {
      if (nextSources.has(resource) && nextSources.get(resource) !== value) conflicting = true
      nextSources.set(resource, value)
    }
    return value
  }))
  if (conflicting) return null
  const changes = new Map()
  forEachEditableSegment(previous, segment => rewriteImageUrls(segment, value => {
    const resource = restoreTaggedResource(value) || (isDurableRelativePath(value) ? value : null)
    if (resource) {
      const replacement = nextSources.get(resource) || resource
      if (replacement !== value) changes.set(value, replacement)
    }
    return value
  }))
  return changes.size ? changes : null
}

export const rewriteImageDisplaySources = (source, changes, onChange) => forEachEditableSegment(
  source, segment => rewriteImageUrls(segment, value => {
    const next = changes.get(value)
    if (!next || next === value) return value
    onChange?.(value, next)
    return next
  })
)
