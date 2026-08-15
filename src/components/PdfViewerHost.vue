<script setup>
// Official pdf.js PDFViewer hosted in a Shadow DOM, so the full
// upstream pdf_viewer.css applies WITHOUT polluting the app's global styles.
// Canvas rendering, all-page layout, selectable text and pointer-anchored zoom
// are maintained by pdf.js itself — no hand-rolled page coordinates.
import { onMounted, onBeforeUnmount, ref } from 'vue'
import pdfCss from 'pdfjs-dist/web/pdf_viewer.css?raw'

const emit = defineEmits(['ready', 'pagechange', 'scalechange', 'error'])

const hostEl = ref(null)
let shadowRoot = null
let containerEl = null
let viewerEl = null
let pdfViewer = null
let linkService = null
let eventBus = null
let loadingTask = null
let openGeneration = 0
let zoomAnchorRevision = 0
let viewerModulePromise = null

const onViewerWheel = (event) => {
  // Never let a PDF gesture reach Knote's root scroller or global UI zoom.
  event.stopPropagation()
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  if (!pdfViewer || !containerEl) return
  const modeFactor = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? containerEl.clientHeight
      : 1
  const delta = Math.max(-180, Math.min(180, event.deltaY * modeFactor))
  const factor = Math.exp(-delta * 0.0015)
  zoomBy(factor, [event.clientX, event.clientY])
}

// pdfjs-dist v6's pdf_viewer.mjs destructures every API from
// globalThis.pdfjsLib — install the module there before importing it (it is
// otherwise only loadable as a global script). Import lazily so the app shell
// never pays for it until a PDF is opened.
const loadViewerModule = async () => {
  if (!viewerModulePromise) {
    viewerModulePromise = (async () => {
      const pdfjs = await import('pdfjs-dist')
      if (!globalThis.pdfjsLib) globalThis.pdfjsLib = pdfjs
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      const viewerModule = await import('pdfjs-dist/web/pdf_viewer.mjs')
      return viewerModule
    })()
  }
  return viewerModulePromise
}

onMounted(() => {
  shadowRoot = hostEl.value.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = pdfCss
  shadowRoot.appendChild(style)
  const hostCss = document.createElement('style')
  hostCss.textContent = `
    :host { display: block; width: 100%; height: 100%; position: relative; }
    #viewerContainer {
      position: absolute; inset: 0; overflow: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
      background: var(--pdf-viewer-bg, transparent);
    }
  `
  shadowRoot.appendChild(hostCss)
  containerEl = document.createElement('div')
  containerEl.id = 'viewerContainer'
  containerEl.dataset.testid = 'pdf-scroll-container'
  containerEl.tabIndex = 0
  containerEl.addEventListener('wheel', onViewerWheel, { passive: false })
  viewerEl = document.createElement('div')
  viewerEl.className = 'pdfViewer'
  containerEl.appendChild(viewerEl)
  shadowRoot.appendChild(containerEl)
})

const closePdf = () => {
  openGeneration += 1
  zoomAnchorRevision += 1
  if (pdfViewer) {
    try { pdfViewer.setDocument(null) } catch { /* already closed */ }
    pdfViewer = null
  }
  linkService = null
  eventBus = null
  if (loadingTask) {
    try { void loadingTask.destroy() } catch { /* ignore */ }
    loadingTask = null
  }
  if (viewerEl) viewerEl.replaceChildren()
}

const openPdf = async (bytes) => {
  closePdf()
  if (!shadowRoot || !containerEl || !viewerEl) return
  const gen = ++openGeneration
  const { PDFViewer, PDFLinkService, EventBus, GenericL10n } = await loadViewerModule()
  const pdfjs = globalThis.pdfjsLib
  const task = pdfjs.getDocument({ data: bytes.slice(0), useSystemFonts: true })
  loadingTask = task
  let doc
  try {
    doc = await task.promise
  } catch (err) {
    if (gen === openGeneration) emit('error', err)
    return
  }
  if (gen !== openGeneration) {
    try { await task.destroy() } catch { /* ignore */ }
    return
  }
  eventBus = new EventBus()
  linkService = new PDFLinkService({ eventBus })
  pdfViewer = new PDFViewer({
    container: containerEl,
    viewer: viewerEl,
    eventBus,
    linkService,
    l10n: new GenericL10n('en-US'),
    enableSelectionRendering: false
  })
  linkService.setViewer(pdfViewer)
  eventBus.on('pagechanging', ({ pageNumber }) => {
    if (gen === openGeneration) emit('pagechange', pageNumber)
  })
  eventBus.on('pagesinit', () => {
    if (gen !== openGeneration) return
    // PDFViewer has no concrete internal scale until its first page exists.
    // Applying page-width earlier leaves _currentScale at UNKNOWN_SCALE (0),
    // which makes the first updateScale call collapse to pdf.js's 10% floor.
    pdfViewer.currentScaleValue = 'page-width'
    emit('ready', { numPages: pdfViewer.pagesCount })
  })
  eventBus.on('scalechanging', ({ scale }) => {
    if (gen === openGeneration) emit('scalechange', scale)
  })
  pdfViewer.setDocument(doc)
}

const zoomBy = (factor, origin = null) => {
  if (!pdfViewer) return
  const current = Number(pdfViewer.currentScale) || 1
  const next = Math.min(5, Math.max(0.25, current * factor))
  if (Math.abs(next - current) < 0.0001) return
  const anchorPage = Array.isArray(origin)
    ? [...viewerEl.querySelectorAll('.page')].find((page) => {
        const rect = page.getBoundingClientRect()
        return origin[0] >= rect.left && origin[0] <= rect.right && origin[1] >= rect.top && origin[1] <= rect.bottom
      })
    : null
  const anchorRect = anchorPage?.getBoundingClientRect()
  const anchor = anchorRect
    ? {
        x: (origin[0] - anchorRect.left) / anchorRect.width,
        y: (origin[1] - anchorRect.top) / anchorRect.height
      }
    : null
  const anchorRevision = ++zoomAnchorRevision
  pdfViewer.updateScale({
    scaleFactor: next / current,
    origin,
    drawingDelay: 150
  })
  if (!anchorPage || !anchor || !containerEl) return
  const restorePointerAnchor = () => {
    if (anchorRevision !== zoomAnchorRevision || !anchorPage.isConnected) return
    const rect = anchorPage.getBoundingClientRect()
    containerEl.scrollLeft += rect.left + anchor.x * rect.width - origin[0]
    containerEl.scrollTop += rect.top + anchor.y * rect.height - origin[1]
  }
  // refresh() normally updates page geometry synchronously. The frame retry
  // covers delayed browser layout without accumulating corrections.
  restorePointerAnchor()
  requestAnimationFrame(restorePointerAnchor)
}

const zoomIn = () => zoomBy(1.25)
const zoomOut = () => zoomBy(0.8)
const resetZoom = () => {
  if (pdfViewer) pdfViewer.currentScaleValue = 'page-width'
}

const currentScale = () => (pdfViewer ? pdfViewer.currentScale : 1)

defineExpose({ openPdf, closePdf, zoomIn, zoomOut, resetZoom, currentScale })

onBeforeUnmount(() => {
  containerEl?.removeEventListener('wheel', onViewerWheel)
  closePdf()
})
</script>

<template>
  <div ref="hostEl" class="knote-pdf-host w-full h-full"></div>
</template>
