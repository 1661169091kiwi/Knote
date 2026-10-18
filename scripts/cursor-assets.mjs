// Build-time artwork only: no DOM access, tracking, timers or network resources.
// Native cursor dimensions/hotspots are in CSS pixels at every display scale.
export const CURSOR_SIZE = 32
const arrow = '<path d="M5 4L24 19L15 20L20 28L15 30L11 22L5 27Z"/>'
const pointing = '<path d="M10 18V6C10 2 15 2 15 6V13C15 9 20 10 20 14C20 10 25 12 25 16C25 13 29 14 29 18V23C29 28 26 30 21 30H15C12 30 11 28 9 26L4 20C1 16 5 13 8 16Z"/>'
const openHand = '<path d="M7 18V10C7 6 12 6 12 10V14V6C12 2 17 2 17 6V14V8C17 4 22 4 22 8V15V11C22 7 27 8 27 12V22C27 27 24 30 19 30H14C11 30 9 28 7 26L3 21C0 17 4 14 7 18Z"/>'
const closedHand = '<path d="M7 14V12C7 8 12 8 12 12V10C12 6 17 6 17 10V11C17 7 22 7 22 11V13C22 9 27 10 27 14V22C27 27 24 30 19 30H14C10 30 8 27 6 25L3 21C1 17 4 14 7 17Z"/>'
const handAccent = '<path d="M25 20C25 24 23 27 20 28H23C26 27 27 24 27 21V18Z" fill="#84cc16" stroke="none"/>'
const arrowAccent = '<path d="M8 10L19 18L12 18L8 22Z" fill="#84cc16" stroke="none"/>'
const horizontal = '<path d="M3 16L11 9V13H21V9L29 16L21 23V19H11V23Z"/>'
const vertical = '<path d="M16 3L23 11H19V21H23L16 29L9 21H13V11H9Z"/>'
const horizontalAccent = '<path d="M5 16L9 12V20ZM27 16L23 12V20Z" fill="#84cc16" stroke="none"/>'
const ring = '<circle cx="16" cy="16" r="10" fill="none"/><path d="M16 6A10 10 0 0 1 26 16" fill="none" stroke="#84cc16" stroke-width="3"/>'

export const CURSOR_DEFINITIONS = Object.freeze([
  { name: 'default', label: '默认箭头', hotspot: [5, 4], shape: arrow, accent: arrowAccent },
  { name: 'pointer', label: '链接点击', hotspot: [12, 4], shape: pointing, accent: handAccent },
  { name: 'text', label: '文本选择', hotspot: [16, 16], shape: '<path d="M11 6H21M16 6V26M11 26H21" fill="none"/>', accent: '<path d="M20 26H21" fill="none" stroke="#84cc16" stroke-width="2.8"/>' },
  { name: 'grab', label: '可抓取', hotspot: [16, 16], shape: openHand, accent: handAccent },
  { name: 'grabbing', label: '抓取中', hotspot: [16, 16], shape: closedHand, accent: handAccent },
  { name: 'move', label: '移动', hotspot: [16, 16], shape: '<path d="M16 8V24M8 16H24" fill="none"/><path d="M16 2L21 8H11ZM30 16L24 21V11ZM16 30L11 24H21ZM2 16L8 11V21Z"/>', accent: '<path d="M16 4L18 7H14ZM28 16L25 18V14ZM16 28L14 25H18ZM4 16L7 14V18Z" fill="#84cc16" stroke="none"/>' },
  { name: 'ew-resize', label: '横向缩放', hotspot: [16, 16], shape: horizontal, accent: horizontalAccent },
  { name: 'ns-resize', label: '纵向缩放', hotspot: [16, 16], shape: vertical, accent: `<g transform="rotate(90 16 16)">${horizontalAccent}</g>` },
  { name: 'nwse-resize', label: '斜向缩放 ↘', hotspot: [16, 16], shape: `<g transform="rotate(45 16 16)">${horizontal}</g>`, accent: `<g transform="rotate(45 16 16)">${horizontalAccent}</g>` },
  { name: 'nesw-resize', label: '斜向缩放 ↗', hotspot: [16, 16], shape: `<g transform="rotate(-45 16 16)">${horizontal}</g>`, accent: `<g transform="rotate(-45 16 16)">${horizontalAccent}</g>` },
  { name: 'zoom-in', label: '放大', hotspot: [13, 13], shape: '<circle cx="13" cy="13" r="9"/><path d="M20 20L28 28" fill="none" stroke-width="4"/>', accent: '<path d="M8 13H18M13 8V18" fill="none" stroke="#84cc16" stroke-width="2.5"/>' },
  { name: 'zoom-out', label: '缩小', hotspot: [13, 13], shape: '<circle cx="13" cy="13" r="9"/><path d="M20 20L28 28" fill="none" stroke-width="4"/>', accent: '<path d="M8 13H18" fill="none" stroke="#84cc16" stroke-width="2.5"/>' },
  { name: 'not-allowed', label: '不可操作', hotspot: [16, 16], shape: '<circle cx="16" cy="16" r="11"/>', accent: '<path d="M8 8L24 24" fill="none" stroke="#84cc16" stroke-width="3"/>' },
  { name: 'help', label: '帮助', hotspot: [5, 4], shape: `<g transform="translate(1 1) scale(.75)">${arrow}</g><path d="M24 6C24 2 30 2 30 6C30 9 27 9 27 12M27 16H27.01" fill="none"/>`, accent: `<g transform="translate(1 1) scale(.75)">${arrowAccent}</g>` },
  { name: 'wait', label: '等待', hotspot: [16, 16], shape: ring },
  { name: 'progress', label: '后台处理中', hotspot: [5, 4], shape: `<g transform="translate(1 1) scale(.7)">${arrow}</g><g transform="translate(15 14) scale(.48)">${ring}</g>`, accent: `<g transform="translate(1 1) scale(.7)">${arrowAccent}</g>` }
].map(value => Object.freeze({ ...value, hotspot: Object.freeze(value.hotspot) })))

export function cursorSvg(definition, dark = false) {
  const ink = dark && definition.name !== 'text' ? '#f1f5f9' : '#1f2937'
  const fill = dark ? '#253329' : '#ffffff'
  const strokeWidth = definition.name === 'text' ? 2.8 : 1.8
  const outline = definition.name === 'text' ? `<g fill="none" stroke="#ffffff" stroke-width="5.2">${definition.shape}</g>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g stroke-linejoin="round" stroke-linecap="round">${outline}<g fill="${fill}" stroke="${ink}" stroke-width="${strokeWidth}">${definition.shape}</g>${definition.accent || ''}</g></svg>`
}

export function cursorValue(definition, dark = false) {
  const encoded = encodeURIComponent(cursorSvg(definition, dark)).replaceAll("'", '%27')
  return `url("data:image/svg+xml,${encoded}") ${definition.hotspot.join(' ')}, ${definition.name}`
}

export function buildCursorCss() {
  const variables = dark => CURSOR_DEFINITIONS.map(def => `  --knote-cursor-${def.name}: ${cursorValue(def, dark)};`).join('\n')
  const classes = CURSOR_DEFINITIONS.map(def => `.cursor-${def.name}, [data-knote-cursor="${def.name}"] { cursor: var(--knote-cursor-${def.name}); }`).join('\n')
  return `/* Generated from scripts/cursor-assets.mjs. Native CSS cursors only; no tracking. */\n:root, [data-theme="light"], [data-theme="retro"] {\n${variables(false)}\n}\n[data-theme="dark"] {\n${variables(true)}\n}\n/* Deliberately outside cascade layers: match Tailwind utilities without affecting hit testing. */\nhtml, body, #app { cursor: var(--knote-cursor-default); }\nbody :where(textarea, input:not([type]), input[type=\"text\"], input[type=\"search\"], input[type=\"password\"], input[type=\"email\"], input[type=\"url\"], input[type=\"number\"], [contenteditable=\"true\"], .knote-md-render) { cursor: var(--knote-cursor-text); caret-color: var(--knote-caret); }\n:where(button, a[href], .menu a, summary, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], input[type="range"]) { cursor: var(--knote-cursor-pointer); }\n:where(button:disabled, input:disabled, select:disabled, textarea:disabled, button[aria-disabled="true"], [role="button"][aria-disabled="true"]), .cursor-pointer:disabled { cursor: var(--knote-cursor-not-allowed); }\n${classes}\n.cursor-col-resize { cursor: var(--knote-cursor-ew-resize); }\n.cursor-row-resize { cursor: var(--knote-cursor-ns-resize); }\n/* User choice overrides every theme, including nested light/dark surfaces. */\n:root[data-cursor-style="system"], :root[data-cursor-style="system"] [data-theme] {\n${CURSOR_DEFINITIONS.map(def => `  --knote-cursor-${def.name}: ${def.name};`).join('\n')}\n}\n@media (forced-colors: active) {\n  :root, [data-theme] {\n${CURSOR_DEFINITIONS.map(def => `    --knote-cursor-${def.name}: ${def.name};`).join('\n')}\n  }\n}\n`
}
