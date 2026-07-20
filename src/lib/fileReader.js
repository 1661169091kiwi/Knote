// fileReader.js — extract text/HTML from various document formats
// In Electron desktop: uses main-process IPC (Node.js native mammoth + JSZip).
// In browser: falls back to lazily loaded mammoth + JSZip. Keeping these
// parsers out of the initial bundle matters on Web/Android; most sessions
// never open an Office document.

const loadJSZip = async () => (await import('jszip')).default
const loadMammoth = async () => (await import('mammoth')).default

const nativeExtract = () => (typeof window !== 'undefined' && window.knoteDesktop && window.knoteDesktop.extractDoc) || null

const FTYPE_MAP = {
  docx: /\.docx$/i, pptx: /\.pptx$/i, xlsx: /\.xlsx$/i,
  odt: /\.odt$/i, ods: /\.ods$/i, odp: /\.odp$/i,
  txt: /\.txt$/i, csv: /\.csv$/i, rtf: /\.rtf$/i,
  md: /\.(md|markdown)$/i
}

export const detectFtype = (name) => {
  for (const [ft, re] of Object.entries(FTYPE_MAP)) if (re.test(name)) return ft
  return null
}

const readAsBytes = async (file) => {
  const buf = await file.arrayBuffer()
  return new Uint8Array(buf)
}

const bufToArrayBuffer = (bytes) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

// Read a File, return { text, html, kind } or null.
export const readDocumentFile = async (file) => {
  const kind = detectFtype(file.name)
  if (!kind) return null

  // txt/csv/rtf: simple text, no need for main process
  if (kind === 'txt' || kind === 'csv' || kind === 'rtf') {
    try {
      const t = new TextDecoder('utf-8').decode(await readAsBytes(file))
      const html = kind === 'csv' ? `<table>${t.split('\n').filter(r=>r.trim()).map(r=>`<tr>${r.split(',').map(c=>`<td>${c.trim()}</td>`).join('')}</tr>`).join('')}</table>` : `<pre>${t.replace(/</g,'&lt;')}</pre>`
      return { text: t.slice(0, 200000), html: html.slice(0, 500000), kind }
    } catch { return { text: '', html: '', kind } }
  }

  // For docx/pptx/xlsx/odt/ods/odp: prefer Electron main process (IPC)
  const ne = nativeExtract()
  if (ne) {
    try {
      const bytes = await readAsBytes(file)
      const r = await ne(file.name, bytes)
      if (r && r.ok) {
        return { text: (r.text || '').slice(0, 200000), html: (r.html || '').slice(0, 500000), kind }
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
      return { text: (txtRes.value || '').slice(0, 200000), html: (htmlRes.value || '').slice(0, 500000), kind }
    }
    if (kind === 'pptx') {
      const JSZip = await loadJSZip()
      const zip = await JSZip.loadAsync(bytes)
      const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort()
      const parts = []; for (const f of slides) { const xml = await zip.files[f].async('string'); const t = xml.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); if (t) parts.push(`<div class="pptx-slide"><strong>Slide ${parts.length+1}</strong><p>${t}</p></div>`) }
      return { text: parts.join('\n'), html: parts.length ? `<div>${parts.join('')}</div>` : '<p>（无内容）</p>', kind }
    }
    if (kind === 'xlsx') {
      const JSZip = await loadJSZip()
      const zip = await JSZip.loadAsync(bytes)
      const ssXml = zip.files['xl/sharedStrings.xml'] ? await zip.files['xl/sharedStrings.xml'].async('string') : ''
      const ss = []; let m; const siRe = /<si[^>]*>([\s\S]*?)<\/si>/g
      while ((m = siRe.exec(ssXml))) ss.push(m[1].replace(/<[^>]+>/g,'').trim())
      const sheets = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort()
      // place values by their r="B7" column ref so empty/omitted cells keep
      // columns aligned (keep in sync with electron/main.cjs extract-doc)
      const colIdx = (col) => { let n = 0; for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64); return n - 1 }
      const textParts = []
      for (const sf of sheets) {
        const xml = await zip.files[sf].async('string')
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
            else if (/\bt="inlineStr"/.test(attrs)) { const im = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body); val = im ? im[1].replace(/<[^>]+>/g, '').trim() : '' }
            else val = vm ? vm[1].trim() : ''
            while (cells.length <= idx) cells.push('')
            cells[idx] = val
          }
          if (cells.some(c => c)) textParts.push(cells.join('\t'))
        }
      }
      const rows = textParts.map(r => `<tr>${r.split('\t').map(c => `<td>${c}</td>`).join('')}</tr>`)
      return { text: textParts.join('\n'), html: rows.length ? `<table>${rows.join('')}</table>` : '<p>（无数据）</p>', kind }
    }
    const JSZip = await loadJSZip()
    const zip = await JSZip.loadAsync(bytes)
    const xml = zip.files['content.xml'] ? await zip.files['content.xml'].async('string') : ''
    const t = xml.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()
    return { text: t, html: t ? `<div>${t}</div>` : '<p>（无内容）</p>', kind }
  } catch (err) {
    console.error('readDocumentFile fallback error:', err)
    return { text: '', html: '', kind }
  }
}

export const FTYPE_LABEL = {
  docx: 'DOCX', pptx: 'PPTX', xlsx: 'XLSX',
  odt: 'ODT', ods: 'ODS', odp: 'ODP',
  txt: 'TXT', csv: 'CSV', rtf: 'RTF'
}
