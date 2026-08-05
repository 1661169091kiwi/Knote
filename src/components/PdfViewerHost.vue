<script setup>
// Official pdf.js PDFSinglePageViewer hosted in a Shadow DOM, so the full
// upstream pdf_viewer.css applies WITHOUT polluting the app's global styles.
// Canvas rendering, the selectable text layer, page layout and zoom are all
// maintained by pdf.js itself — no hand-rolled coordinates.
import { onMounted, onBeforeUnmount, ref } from 'vue'
import pdfCss from 'pdfjs-dist/web/pdf_viewer.css?raw'

const emit = defineEmits(['ready', 'pagechange', 'error'])

const hostEl = ref(null)
let shadowRoot = null
let containerEl = null
let viewerEl = null
let pdfViewer = null
let linkService = null
let eventBus = null
let loadingTask = null
let openGeneration = 0
let viewerModulePromise = null

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
      background: var(--pdf-viewer-bg, transparent);
    }
  `
  shadowRoot.appendChild(hostCss)
  containerEl = document.createElement('div')
  containerEl.id = 'viewerContainer'
  containerEl.tabIndex = 0
  viewerEl = document.createElement('div')
  viewerEl.className = 'pdfViewer singlePageViewer'
  containerEl.appendChild(viewerEl)
  shadowRoot.appendChild(containerEl)
})

const closePdf = () => {
  openGeneration += 1
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
  const { PDFSinglePageViewer, PDFLinkService, EventBus, GenericL10n } = await loadViewerModule()
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
  pdfViewer = new PDFSinglePageViewer({
    container: containerEl,
    viewer: viewerEl,
    eventBus,
    linkService,
    l10n: new GenericL10n('en-US')
  })
  linkService.setViewer(pdfViewer)
  eventBus.on('pagechanging', ({ pageNumber }) => {
    if (gen === openGeneration) emit('pagechange', pageNumber)
  })
  eventBus.on('pagesinit', () => {
    if (gen === openGeneration) emit('ready', { numPages: pdfViewer.pagesCount })
  })
  pdfViewer.setDocument(doc)
  pdfViewer.currentScaleValue = 'page-width'
}

const zoomBy = (factor) => {
  if (!pdfViewer) return
  const next = Math.min(5, Math.max(0.25, pdfViewer.currentScale * factor))
  pdfViewer.currentScaleValue = String(next)
}

const zoomIn = () => zoomBy(1.25)
const zoomOut = () => zoomBy(0.8)
const resetZoom = () => {
  if (pdfViewer) pdfViewer.currentScaleValue = 'page-width'
}

const currentScale = () => (pdfViewer ? pdfViewer.currentScale : 1)

defineExpose({ openPdf, closePdf, zoomIn, zoomOut, resetZoom, currentScale })

onBeforeUnmount(closePdf)
</script>

<template>
  <div ref="hostEl" class="knote-pdf-host w-full h-full"></div>
</template>
