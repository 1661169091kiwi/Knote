const escapeAttribute = (value) => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// The body comes from the FULL Markdown source, never the currently mounted
// editor chunk. An isolated document has no selection, tooltip, toolbar or chat.
export const documentPrintCss = `
@page { size: A4; margin: 12mm; }
html,body { height:auto!important; min-height:0!important; margin:0!important; padding:0!important; overflow:visible!important; background:#fff!important; color:#20251c!important; }
body { font:11pt/1.65 'Segoe UI','Microsoft YaHei',system-ui,sans-serif; }
.knote-print-document { max-width:none!important; width:auto!important; overflow:visible!important; padding:0!important; margin:0!important; }
.knote-print-document h1,.knote-print-document h2,.knote-print-document h3 { break-after:avoid; }
.knote-print-document h1 { font-size:24pt; } .knote-print-document h2 { font-size:18pt; } .knote-print-document h3 { font-size:14pt; }
.knote-print-document p { orphans:3; widows:3; }
.knote-print-document pre { white-space:pre-wrap; overflow-wrap:anywhere; overflow:visible!important; background:#f6f8f3; border-radius:6px; padding:10px; }
.knote-print-document img,.knote-print-document svg { max-width:100%; height:auto; }
.knote-print-document table { width:100%; min-width:0; table-layout:auto; border-collapse:collapse; font-size:10pt; }
.knote-print-document th,.knote-print-document td { min-width:0; border:1px solid #d6dccf; padding:5px 8px; overflow-wrap:anywhere; }
.knote-print-document thead { display:table-header-group; } .knote-print-document tr { break-inside:avoid; }
.knote-print-document blockquote { border-left:3px solid #84cc16; padding-left:12px; }
.knote-print-document .knote-frontmatter { white-space:pre-wrap!important; }
.knote-print-document .knote-md-tw { overflow:visible!important; }
* { animation:none!important; transition:none!important; caret-color:transparent!important; }
::selection { background:transparent!important; }
`

export const buildDocumentPrintHtml = ({ bodyHtml, title = 'Knote', lang = 'zh', baseUrl = '', stylesheets = [], inlineStyles = [] }) => `<!doctype html>
<html lang="${escapeAttribute(lang)}" data-theme="light"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline' file: https: http:; img-src data: blob: file: https: http:; font-src data: file: https: http:; base-uri file: https: http:;">
<base href="${escapeAttribute(baseUrl)}"><title>${escapeAttribute(title)}</title>
${stylesheets.map(href => `<link rel="stylesheet" href="${escapeAttribute(href)}">`).join('\n')}
${inlineStyles.map(css => `<style>${String(css).replace(/<\/style/gi, '<\\/style')}</style>`).join('\n')}
<style>${documentPrintCss}</style></head><body><article class="knote-print-document knote-md-render prose">${bodyHtml}</article></body></html>`
