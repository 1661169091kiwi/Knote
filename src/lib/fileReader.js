// fileReader.js — extract text/HTML from various document formats
// In Electron desktop: uses main-process IPC (Node.js native mammoth + JSZip).
// In browser: falls back to lazily loaded mammoth + JSZip. Keeping these
// parsers out of the initial bundle matters on Web/Android; most sessions
// never open an Office document.

import { classifyAgentWritableFile } from './agentWorkspaceFile.js'

const loadJSZip = async () => (await import('jszip')).default
const loadMammoth = async () => (await import('mammoth')).default

const nativeExtract = () => (typeof window !== 'undefined' && window.knoteDesktop && window.knoteDesktop.extractDoc) || null

const FTYPE_MAP = {
  docx: /\.docx$/i, pptx: /\.pptx$/i, xlsx: /\.xlsx$/i,
  odt: /\.odt$/i, ods: /\.ods$/i, odp: /\.odp$/i
}

export const detectFtype = (name) => {
  for (const [ft, re] of Object.entries(FTYPE_MAP)) if (re.test(name)) return ft
  const writable = classifyAgentWritableFile(name)
  if (writable === 'markdown') return 'md'
  if (writable === 'txt' || writable === 'csv' || writable === 'rtf' || writable === 'code') return writable
  return null // SVG deliberately stays on the image-preview path.
}

const readAsBytes = async (file) => {
  const buf = await file.arrayBuffer()
  return new Uint8Array(buf)
}

const bufToArrayBuffer = (bytes) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

const HTML_PREVIEW_CHARS = 500000
const textEncoder = new TextEncoder()
const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
const decodeXmlEntities = (value) => String(value || '')
  .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(Number(number)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
const xmlSourceText = (xml) => decodeXmlEntities(String(xml || '')
  .replace(/<(?:a:br|text:line-break)\b[^>]*\/?\s*>/gi, '\n')
  .replace(/<text:tab\b[^>]*\/?\s*>/gi, '\t')
  .replace(/<\/a:p\s*>/gi, '\n')
  .replace(/<\/(?:text:p|text:h)\s*>/gi, '\n')
  .replace(/<\/table:table-cell\s*>/gi, '\t')
  .replace(/<\/table:table-row\s*>/gi, '\n')
  .replace(/<\/draw:page\s*>/gi, '\n\n')
  .replace(/<[^>]+>/g, ' ')
  .split('\n')
  .map((line) => line.replace(/[ \f\v]+/g, ' ').replace(/\s*\t\s*/g, '\t').trimEnd())
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim())
const numberedArchiveEntrySort = (left, right) => {
  const leftNumber = Number(/(\d+)\.xml$/i.exec(left)?.[1] || 0)
  const rightNumber = Number(/(\d+)\.xml$/i.exec(right)?.[1] || 0)
  return leftNumber - rightNumber || left.localeCompare(right)
}
const sourceResult = (textValue, htmlValue, kind, sourceComplete = true) => {
  const text = String(textValue || '')
  const html = String(htmlValue || '')
  return {
    text,
    html: html.slice(0, HTML_PREVIEW_CHARS),
    kind,
    source_complete: sourceComplete === true,
    source_total_chars: text.length,
    source_total_bytes: textEncoder.encode(text).byteLength,
    preview: {
      unit: 'character',
      returned: Math.min(html.length, HTML_PREVIEW_CHARS),
      total: html.length,
      truncated: html.length > HTML_PREVIEW_CHARS
    }
  }
}

// Read a File, return { text, html, kind } or null.
export const readDocumentFile = async (file) => {
  const kind = detectFtype(file.name)
  if (!kind) return null

  // txt/csv/rtf/code: simple UTF-8 text, no need for main process
  if (kind === 'txt' || kind === 'csv' || kind === 'rtf' || kind === 'code') {
    try {
      const t = new TextDecoder('utf-8', { fatal: true }).decode(await readAsBytes(file))
      const html = kind === 'csv' ? `<table>${t.split('\n').filter(r=>r.trim()).map(r=>`<tr>${r.split(',').map(c=>`<td>${escapeHtml(c.trim())}</td>`).join('')}</tr>`).join('')}</table>` : `<pre>${escapeHtml(t)}</pre>`
      return sourceResult(t, html, kind)
    } catch { return sourceResult('', '', kind, false) }
  }

  // For docx/pptx/xlsx/odt/ods/odp: prefer Electron main process (IPC)
  const ne = nativeExtract()
  if (ne) {
    try {
      const bytes = await readAsBytes(file)
      const r = await ne(file.name, bytes)
      if (r && r.ok) {
        return sourceResult(r.text, r.html, kind, r.source_complete !== false)
      }
      console.error('IPC extractDoc failed:', r && r.error)
    } catch (err) { console.error('IPC extractDoc error:', err) }
  }

  // Fallback: use bundled mammoth/JSZip
  try {
    const bytes = await readAsBytes(file)
    if (kind === 'docx') {
      const mammoth = await loadMammoth()
      const ab = bufToArrayBuffer(bytes)
      const [htmlRes, txtRes] = await Promise.all([
        mammoth.convertToHtml({ arrayBuffer: ab }),
        mammoth.extractRawText({ arrayBuffer: ab })
      ])
      return sourceResult(txtRes.value, htmlRes.value, kind)
    }
    if (kind === 'pptx') {
      const JSZip = await loadJSZip()
      const zip = await JSZip.loadAsync(bytes)
      const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort(numberedArchiveEntrySort)
      const textParts = []; const htmlParts = []
      for (let index = 0; index < slides.length; index++) {
        const xml = await zip.files[slides[index]].async('string')
        const text = xmlSourceText(xml)
        textParts.push(`[Slide ${index + 1}]${text ? `\n${text}` : ''}`)
        htmlParts.push(`<div class="pptx-slide"><strong>Slide ${index + 1}</strong>${text ? `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>` : ''}</div>`)
      }
      return sourceResult(textParts.join('\n\n'), htmlParts.length ? `<div>${htmlParts.join('')}</div>` : '<p>（无内容）</p>', kind)
    }
    if (kind === 'xlsx') {
      const JSZip = await loadJSZip()
      const zip = await JSZip.loadAsync(bytes)
      const ssXml = zip.files['xl/sharedStrings.xml'] ? await zip.files['xl/sharedStrings.xml'].async('string') : ''
      const ss = []; let m; const siRe = /<si[^>]*>([\s\S]*?)<\/si>/g
      while ((m = siRe.exec(ssXml))) ss.push(xmlSourceText(m[1]))
      const sheets = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort(numberedArchiveEntrySort)
      // place values by their r="B7" column ref so empty/omitted cells keep
      // columns aligned (keep in sync with electron/main.cjs extract-doc)
      const colIdx = (col) => { let n = 0; for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64); return n - 1 }
      const textParts = []
      for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
        const sf = sheets[sheetIndex]
        const xml = await zip.files[sf].async('string')
        textParts.push(`[Sheet ${sheetIndex + 1}]`)
        const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g; let rm
        while ((rm = rowRe.exec(xml))) {
          const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm; const cells = []
          while ((cm = cellRe.exec(rm[1]))) {
            const attrs = cm[1] || ''; const body = cm[2] || ''
            const ref = /\br="([A-Z]+)\d+"/.exec(attrs)
            const idx = ref ? colIdx(ref[1]) : cells.length
            const vm = /<v>([\s\S]*?)<\/v>/.exec(body)
            let val = ''
            if (/\bt="s"/.test(attrs)) val = vm ? (ss[+vm[1]] || '') : ''
            else if (/\bt="inlineStr"/.test(attrs)) val = xmlSourceText(body)
            else val = vm ? decodeXmlEntities(vm[1]).trim() : ''
            while (cells.length <= idx) cells.push('')
            cells[idx] = val
          }
          if (cells.some(c => c)) textParts.push(cells.join('\t'))
        }
      }
      const rows = textParts.map(r => `<tr>${r.split('\t').map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
      return sourceResult(textParts.join('\n'), rows.length ? `<table>${rows.join('')}</table>` : '<p>（无数据）</p>', kind)
    }
    const JSZip = await loadJSZip()
    const zip = await JSZip.loadAsync(bytes)
    const xml = zip.files['content.xml'] ? await zip.files['content.xml'].async('string') : ''
    const t = xmlSourceText(xml)
    return sourceResult(t, t ? `<pre>${escapeHtml(t)}</pre>` : '<p>（无内容）</p>', kind)
  } catch (err) {
    console.error('readDocumentFile fallback error:', err)
    return sourceResult('', '', kind, false)
  }
}

export const FTYPE_LABEL = {
  docx: 'DOCX', pptx: 'PPTX', xlsx: 'XLSX',
  odt: 'ODT', ods: 'ODS', odp: 'ODP',
  txt: 'TXT', csv: 'CSV', rtf: 'RTF', code: 'CODE'
}
