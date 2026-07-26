import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { selectPdfDeliveryMode } from '../src/lib/pdfDelivery.js'
import { normalizePdfTargetPages, visitPdfTargetPages } from '../src/lib/pdfPageScope.js'
import { createPdfCropCache, pdfCropCacheKey } from '../src/lib/pdfCropCache.js'

const readRepo = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')

test('native Anthropic PDF wins over image and text fallbacks', () => {
  assert.equal(selectPdfDeliveryMode({
    protocol: 'anthropic',
    pdf: true,
    vision: true,
    hasBinary: true
  }), 'native')
})

test('OpenAI-compatible chat never receives an unsupported native document block', () => {
  assert.equal(selectPdfDeliveryMode({
    protocol: 'openai',
    pdf: true,
    vision: true,
    hasBinary: true
  }), 'images')
})

test('vision fallback does not depend on tool calling', () => {
  assert.equal(selectPdfDeliveryMode({
    protocol: 'openai',
    pdf: false,
    vision: true,
    hasBinary: true
  }), 'images')
})

test('text-only models still receive a locally parsed PDF', () => {
  assert.equal(selectPdfDeliveryMode({
    protocol: 'openai',
    pdf: false,
    vision: false,
    hasBinary: true
  }), 'text')
})

test('workspace tool results can explicitly disable native document delivery', () => {
  assert.equal(selectPdfDeliveryMode({
    protocol: 'anthropic',
    pdf: true,
    vision: true,
    hasBinary: true,
    allowNative: false
  }), 'images')
})

test('missing binary data cannot select native delivery', () => {
  assert.equal(selectPdfDeliveryMode({
    protocol: 'anthropic',
    pdf: true,
    vision: false,
    hasBinary: false
  }), 'text')
})

test('upload and send paths cannot restart legacy whole-PDF structuring', () => {
  const store = readRepo('src/lib/agentStore.js')
  const panel = readRepo('src/components/AgentPanel.vue')
  assert.doesNotMatch(panel, /structurePdfAttachment|pdfStructured/)
  assert.doesNotMatch(store, /structurePdfAttachment\s*\(/)
  assert.match(store, /preparePdfAttachmentForModel\(a,\s*signal\)/)
})

test('image insertion policy is precise-first and page-scoped', () => {
  const store = readRepo('src/lib/agentStore.js')
  assert.match(store, /只对确定需要的页调用 pdf_prepare 精确提取/)
  assert.match(store, /只有整页本身适合插入、精确提取没有必要/)
  assert.match(store, /不要预解析整份 PDF/)
})

test('conversion indicator contains both document states and an irregular rectangular rain field', () => {
  const shimmer = readRepo('src/components/PdfShimmer.vue')
  assert.match(shimmer, /pdfx-icon--source/)
  assert.match(shimmer, /pdfx-icon--vector/)
  assert.match(shimmer, /const COLS = 22/)
  assert.match(shimmer, /const ROWS = 3/)
  assert.match(shimmer, /pdfx-twinkle/)
  assert.match(shimmer, /Math\.random\(\) \* 1\.8/)
  assert.match(shimmer, /pdfx-pixel--white/)
  assert.match(shimmer, /\.pdfx-pixel\s*\{[\s\S]{0,120}width:\s*100%;[\s\S]{0,80}aspect-ratio:\s*1;/)
  assert.match(shimmer, /\.pdfx-rain\s*\{[\s\S]{0,180}grid-template-columns:\s*repeat\(22,[\s\S]{0,80}gap:\s*2px;/)
  assert.match(shimmer, /\.pdfx-icon\s*\{[\s\S]{0,220}border:\s*0;[\s\S]{0,80}background:\s*transparent;[\s\S]{0,80}box-shadow:\s*none;/)
  assert.doesNotMatch(shimmer, /\.pdfx-transform\s*\{[\s\S]{0,260}(?:border:|border-radius:|background:)/)
  assert.doesNotMatch(shimmer, /halfHeights|pdfx-particle-cross|pdfx-rail|pdfx-rain-fall|pdfx-tile-wave/)
  assert.doesNotMatch(shimmer, /pdfx-track/)
})

test('page-scoped extraction visits only explicitly requested PDF pages', async () => {
  const scope = normalizePdfTargetPages([3, 7, 8, 7], { totalPages: 39, maxPages: 8 })
  assert.deepEqual(scope, { pages: [3, 7, 8], overflow: [], invalid: [] })

  const visited = []
  const progress = []
  const results = await visitPdfTargetPages(
    scope.pages,
    async (page) => {
      visited.push(page)
      return `page-${page}`
    },
    (state) => progress.push(state)
  )

  assert.deepEqual(visited, [3, 7, 8])
  assert.deepEqual(results, ['page-3', 'page-7', 'page-8'])
  assert.deepEqual(progress, [
    { targetIndex: 1, targetTotal: 3, sourcePage: 3 },
    { targetIndex: 2, targetTotal: 3, sourcePage: 7 },
    { targetIndex: 3, targetTotal: 3, sourcePage: 8 }
  ])
  assert.ok(!visited.includes(1))
  assert.ok(!visited.includes(39))
})

test('page scope rejects invalid pages and caps an oversized request without widening it', () => {
  assert.deepEqual(
    normalizePdfTargetPages([0, 3, 40], { totalPages: 39, maxPages: 8 }),
    { pages: [], overflow: [], invalid: [0, 40] }
  )
  assert.deepEqual(
    normalizePdfTargetPages([9, 8, 7, 6], { totalPages: 39, maxPages: 3 }),
    { pages: [9, 8, 7], overflow: [6], invalid: [] }
  )
})

test('pdf_prepare is wired to the page-scope executor and reports that other pages were not scanned', () => {
  const store = readRepo('src/lib/agentStore.js')
  const prepareStart = store.indexOf('const execPdfPrepare = async')
  const prepareEnd = store.indexOf('const execPdfGetElement', prepareStart)
  const prepare = store.slice(prepareStart, prepareEnd)
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart)
  assert.match(prepare, /normalizePdfTargetPages\(input\.pages/)
  assert.match(prepare, /visitPdfTargetPages\(wanted/)
  assert.match(prepare, /未扫描其他页面/)
  assert.doesNotMatch(prepare, /for\s*\(\s*let\s+page\s*=\s*1\s*;\s*page\s*<=\s*doc\.numPages/)
})

test('vision probing verifies image content instead of treating HTTP success as vision support', () => {
  const store = readRepo('src/lib/agentStore.js')
  assert.match(store, /fillText\('K7'/)
  assert.match(store, /visionProbeMatches/)
  assert.match(store, /capabilityMismatch/)
  assert.match(store, /content_mismatch/)
})

test('PDF page images preserve enough resolution and JPEG quality for model inspection', () => {
  const store = readRepo('src/lib/agentStore.js')
  assert.match(store, /PDF_VISION_MAX_EDGE\s*=\s*1440/)
  assert.match(store, /PDF_VISION_JPEG_QUALITY\s*=\s*0\.9/)
  assert.doesNotMatch(store, /renderPdfPageCanvas\(p,\s*1024\)/)
})

test('PDF progress distinguishes requested-page progress from total document pages', () => {
  const panel = readRepo('src/components/AgentPanel.vue')
  const app = readRepo('src/App.vue')
  assert.match(panel, /state\.targetTotal\s*&&\s*state\.targetIndex\s*&&\s*state\.sourcePage/)
  assert.match(panel, /agent_target_page_progress/)
  assert.match(app, /目标 \{index\} \/ \{total\} · PDF 第 \{page\} 页/)
  assert.match(app, /Target \{index\} \/ \{total\} · PDF page \{page\}/)
})

test('identical PDF crop coordinates produce one canonical cache key', () => {
  const a = pdfCropCacheKey({
    attachmentId: 'att-pdf',
    page: 7,
    bbox: [0.1, 0.2, 0.8, 0.9]
  })
  const b = pdfCropCacheKey({
    attachmentId: 'att-pdf',
    page: 7.9,
    bbox: ['0.1000001', '0.2000001', '0.8000001', '0.9000001']
  })
  assert.equal(a, b)
  assert.notEqual(a, pdfCropCacheKey({
    attachmentId: 'att-pdf',
    page: 8,
    bbox: [0.1, 0.2, 0.8, 0.9]
  }))
})

test('completed and in-flight duplicate crops share one image resource', async () => {
  const cache = createPdfCropCache()
  const key = pdfCropCacheKey({
    attachmentId: 'att-pdf',
    page: 3,
    bbox: [0.15, 0.25, 0.75, 0.85]
  })
  let created = 0
  const create = async () => {
    created += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { imageId: 'att-crop-1' }
  }

  const [first, concurrent] = await Promise.all([
    cache.resolve(key, create),
    cache.resolve(key, create)
  ])
  const later = await cache.resolve(key, create)

  assert.equal(created, 1)
  assert.equal(first.resource.imageId, 'att-crop-1')
  assert.equal(concurrent.resource.imageId, 'att-crop-1')
  assert.equal(later.resource.imageId, 'att-crop-1')
  assert.equal(first.reused, false)
  assert.equal(concurrent.reused, true)
  assert.equal(concurrent.source, 'in_flight')
  assert.equal(later.reused, true)
  assert.equal(later.source, 'cache')
})

test('a stale crop id is recreated instead of being returned', async () => {
  const cache = createPdfCropCache()
  const key = pdfCropCacheKey({
    attachmentId: 'att-pdf',
    page: 3,
    bbox: [0.1, 0.2, 0.8, 0.9]
  })
  let sequence = 0
  const create = async () => ({ imageId: `att-crop-${++sequence}` })
  await cache.resolve(key, create)
  const recreated = await cache.resolve(key, create, () => false)
  assert.equal(sequence, 2)
  assert.equal(recreated.reused, false)
  assert.equal(recreated.resource.imageId, 'att-crop-2')
})

test('crop tool enforces reuse and gives the model one unambiguous insertion contract', () => {
  const store = readRepo('src/lib/agentStore.js')
  const cropStart = store.indexOf('const execPdfCropRegion = async')
  const cropEnd = store.indexOf('// Layout analysis of a PDF page', cropStart)
  const crop = store.slice(cropStart, cropEnd)
  assert.ok(cropStart >= 0 && cropEnd > cropStart)
  assert.match(crop, /pdfCropCache\.resolve/)
  assert.match(crop, /没有重新渲染或生成副本/)
  assert.match(crop, /reused:\s*true/)
  assert.match(store, /【图片资源复用】/)
  assert.match(store, /绝不能擅自简写成 img-1/)
  assert.doesNotMatch(store, /不要把 image_id 当图片地址写进正文/)
})

test('precise PDF tools use the fast layout channel and recover captions from the PDF text layer', () => {
  const store = readRepo('src/lib/agentStore.js')
  const layoutStart = store.indexOf('const execPdfLayout = async')
  const layoutEnd = store.indexOf('// Ingest chosen PDF pages', layoutStart)
  const prepareStart = store.indexOf('const execPdfPrepare = async')
  const prepareEnd = store.indexOf('const execPdfGetElement', prepareStart)
  const layout = store.slice(layoutStart, layoutEnd)
  const prepare = store.slice(prepareStart, prepareEnd)

  assert.ok(layoutStart >= 0 && layoutEnd > layoutStart)
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart)
  assert.match(store, /const pdfTextContextElements = async/)
  assert.match(layout, /pdfTextContextElements\(p,\s*viewport\)/)
  assert.match(prepare, /pdfTextContextElements\(p,\s*viewport\)/)
  assert.match(layout, /pdfAnalyze\(dataUrl,\s*0\.5,\s*'layout'\)/)
  assert.match(prepare, /pdfAnalyze\(canvas\.toDataURL\('image\/png'\),\s*0\.5,\s*'layout'\)/)
  assert.doesNotMatch(layout, /pdfAnalyze\([^)]*'full'/)
  assert.doesNotMatch(prepare, /pdfAnalyze\([^)]*'full'/)
})

test('precise PDF failures automatically yield model-visible page images instead of a sidecar error', () => {
  const store = readRepo('src/lib/agentStore.js')
  const prepareStart = store.indexOf('const execPdfPrepare = async')
  const prepareEnd = store.indexOf('const execPdfGetElement', prepareStart)
  const prepare = store.slice(prepareStart, prepareEnd)

  assert.match(prepare, /自动降级/)
  assert.match(prepare, /addAttachment\(\{\s*kind:\s*'image'/)
  assert.match(prepare, /fallbackUrls\.push\(dataUrl\)/)
  assert.match(prepare, /imageDataUrls:\s*fallbackUrls/)
  assert.match(store, /【PDF 自动降级】/)
  assert.match(store, /不要向用户讲 sidecar、timeout、PaddleOCR/)
  assert.match(store, /普通图片绝不能调用本工具/)
})

test('sidecar timeouts kill the complete Python tree, restart once, and serialize inference', () => {
  const main = readRepo('electron/main.cjs')
  assert.match(main, /let pdfAnalyzeQueue = Promise\.resolve\(\)/)
  assert.match(main, /taskkill\.exe/)
  assert.match(main, /'\/T',\s*'\/F'/)
  assert.match(main, /analyzeWithSidecarRecovery/)
  assert.match(main, /payload\.mode === 'layout' \? 30000 : 120000/)
  assert.match(main, /await stopPdfSidecar\(\)[\s\S]{0,180}return await run\(\)/)
  assert.match(main, /const run = pdfAnalyzeQueue\.then\(\(\) => analyzeWithSidecarRecovery\(payload\)\)/)
  assert.match(main, /if \(recoverableSidecarError\(retryErr\)\) await stopPdfSidecar\(\)/)
})
