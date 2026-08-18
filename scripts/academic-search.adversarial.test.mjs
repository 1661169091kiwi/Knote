import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAcademicRequestUrls,
  formatAcademicSearchResults,
  fuseAcademicRecords,
  normalizeCrossrefRecord,
  normalizeOpenAlexRecord,
  runAcademicSearch
} from '../src/lib/academicSearch.js'

const openAlexWork = (overrides = {}) => ({
  id: 'https://openalex.org/W1',
  doi: 'https://doi.org/10.1234/ABC',
  display_name: 'A Shared Study',
  publication_year: 2024,
  publication_date: '2024-03-02',
  cited_by_count: 12,
  type: 'article',
  is_retracted: false,
  authorships: [{ author: { display_name: 'Ada Author' } }],
  primary_location: { landing_page_url: 'https://journal.example/article', source: { display_name: 'Journal' } },
  best_oa_location: { landing_page_url: 'https://oa.example/article' },
  abstract_inverted_index: { Useful: [0], finding: [1] },
  ...overrides
})

const crossrefWork = (overrides = {}) => ({
  DOI: '10.1234/abc',
  title: ['A Shared Study'],
  author: [{ given: 'Ada', family: 'Author' }],
  published: { 'date-parts': [[2024, 3, 2]] },
  'container-title': ['Journal'],
  abstract: '<p>Crossref abstract</p>',
  type: 'journal-article',
  'is-referenced-by-count': 15,
  URL: 'https://doi.org/10.1234/abc',
  ...overrides
})

const observableEndlessBody = (initialText = '') => {
  let cancellationCount = 0
  let resolveCancelled
  const cancelled = new Promise((resolve) => { resolveCancelled = resolve })
  const encoded = new TextEncoder().encode(initialText)
  const body = new ReadableStream({
    start(controller) {
      if (encoded.byteLength) controller.enqueue(encoded)
    },
    pull() {},
    cancel(reason) {
      cancellationCount += 1
      resolveCancelled({ reason })
    }
  })
  return { body, cancelled, cancellationCount: () => cancellationCount }
}

const directScheduler = async (_source, operation, options) => operation({ signal: options.signal })

test('normalizers bound text and expose identifiers, OA, preprint, and retraction flags', () => {
  const openalex = normalizeOpenAlexRecord(openAlexWork({ type: 'preprint', is_retracted: true }), 2)
  assert.equal(openalex.doi, '10.1234/abc')
  assert.equal(openalex.oaUrl, 'https://oa.example/article')
  assert.equal(openalex.isPreprint, true)
  assert.equal(openalex.isRetracted, true)
  assert.equal(openalex.provenance[0].rank, 2)

  const crossref = normalizeCrossrefRecord(crossrefWork({
    type: 'posted-content',
    relation: { 'is-retracted-by': [{ id: '10.1/retraction' }] },
    abstract: `<p>${'x'.repeat(5000)}</p>`
  }), 1)
  assert.equal(crossref.isPreprint, true)
  assert.equal(crossref.isRetracted, true)
  assert.equal(crossref.snippet.length, 1200)
})

test('Crossref links require explicit open-license metadata before being labeled OA', () => {
  const arbitrary = normalizeCrossrefRecord(crossrefWork({
    link: [{ URL: 'https://publisher.example/full-text', 'content-type': 'application/pdf' }]
  }))
  assert.equal(arbitrary.oaUrl, '')

  const licensed = normalizeCrossrefRecord(crossrefWork({
    link: [{ URL: 'https://publisher.example/open/full-text' }],
    license: [{ URL: 'https://creativecommons.org/licenses/by/4.0/' }]
  }))
  assert.equal(licensed.oaUrl, 'https://publisher.example/open/full-text')
})

test('DOI and title fallback dedupe use deterministic reciprocal-rank fusion', () => {
  const openalex = normalizeOpenAlexRecord(openAlexWork(), 1)
  const crossref = normalizeCrossrefRecord(crossrefWork(), 1)
  const titleOnly = normalizeCrossrefRecord(crossrefWork({ DOI: '', title: ['Title Only Record'] }), 2)
  const titleOnlyOther = normalizeOpenAlexRecord(openAlexWork({ doi: '', id: 'https://openalex.org/W2', display_name: 'Title Only Record' }), 3)
  const fused = fuseAcademicRecords([
    { source: 'openalex', records: [openalex, titleOnlyOther] },
    { source: 'crossref', records: [crossref, titleOnly] }
  ])
  assert.equal(fused.length, 2)
  assert.equal(fused[0].doi, '10.1234/abc')
  assert.deepEqual(fused[0].provenance.map((item) => item.source), ['openalex', 'crossref'])
  assert.match(fused[0].citation, /Ada Author \(2024\).*https:\/\/doi\.org\/10\.1234\/abc/)
  assert.equal(fused[1].title, 'Title Only Record')
  assert.equal(fused[1].provenance.length, 2)
})

test('different persistent identifiers are not collapsed merely because titles match', () => {
  const one = normalizeOpenAlexRecord(openAlexWork({ doi: 'https://doi.org/10.1000/one' }), 1)
  const two = normalizeCrossrefRecord(crossrefWork({ DOI: '10.1000/two' }), 1)
  assert.equal(fuseAcademicRecords([{ records: [one] }, { records: [two] }]).length, 2)
})

test('title fallback rejects generic-title collisions with different authors, years, or authorless venue matches', () => {
  const baseline = normalizeOpenAlexRecord(openAlexWork({
    doi: '',
    display_name: 'Editorial',
    publication_year: 2024,
    authorships: [{ author: { display_name: 'Ada Author' } }]
  }), 1)
  const differentAuthor = normalizeCrossrefRecord(crossrefWork({
    DOI: '',
    title: ['Editorial'],
    author: [{ given: 'Grace', family: 'Researcher' }]
  }), 1)
  const differentYear = normalizeCrossrefRecord(crossrefWork({
    DOI: '',
    title: ['Editorial'],
    author: [{ given: 'Ada', family: 'Author' }],
    published: { 'date-parts': [[2023, 3, 2]] }
  }), 2)
  assert.equal(fuseAcademicRecords([
    { records: [baseline] },
    { records: [differentAuthor, differentYear] }
  ]).length, 3)

  const authorlessOpenAlex = normalizeOpenAlexRecord(openAlexWork({
    doi: '',
    display_name: 'Introduction',
    authorships: []
  }), 1)
  const authorlessCrossref = normalizeCrossrefRecord(crossrefWork({
    DOI: '',
    title: ['Introduction'],
    author: []
  }), 1)
  assert.equal(fuseAcademicRecords([
    { records: [authorlessOpenAlex] },
    { records: [authorlessCrossref] }
  ]).length, 2)
})

test('merged records retain OA, preprint, and retraction flags from either provider', () => {
  const openalex = normalizeOpenAlexRecord(openAlexWork({ is_retracted: true }), 1)
  const crossref = normalizeCrossrefRecord(crossrefWork({ type: 'posted-content' }), 1)
  const [merged] = fuseAcademicRecords([{ records: [openalex] }, { records: [crossref] }])
  assert.equal(merged.oaUrl, 'https://oa.example/article')
  assert.equal(merged.isPreprint, true)
  assert.equal(merged.isRetracted, true)
})

test('PMID and arXiv aliases dedupe when DOI metadata is missing', () => {
  const pmidOpenAlex = normalizeOpenAlexRecord(openAlexWork({
    doi: '',
    ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/12345678' },
    display_name: 'PMID version'
  }), 1)
  const pmidCrossref = normalizeCrossrefRecord(crossrefWork({
    DOI: '',
    'alternative-id': ['PMID:12345678'],
    title: ['PMID enriched version']
  }), 1)
  assert.equal(fuseAcademicRecords([{ records: [pmidOpenAlex] }, { records: [pmidCrossref] }]).length, 1)

  const arxivOpenAlex = normalizeOpenAlexRecord(openAlexWork({
    doi: '',
    ids: { arxiv: 'https://arxiv.org/abs/2401.12345v2' },
    display_name: 'arXiv version'
  }), 1)
  const arxivCrossref = normalizeCrossrefRecord(crossrefWork({
    DOI: '',
    'alternative-id': ['arXiv:2401.12345v1'],
    title: ['arXiv enriched version']
  }), 1)
  assert.equal(fuseAcademicRecords([{ records: [arxivOpenAlex] }, { records: [arxivCrossref] }]).length, 1)
})

test('OpenAlex derives only valid arXiv IDs from a bounded set of location URLs', () => {
  const primary = normalizeOpenAlexRecord(openAlexWork({
    doi: '',
    ids: {},
    primary_location: { landing_page_url: 'https://arxiv.org/abs/2401.12345v2' },
    best_oa_location: null
  }))
  assert.equal(primary.arxiv, '2401.12345')

  const best = normalizeOpenAlexRecord(openAlexWork({
    doi: '',
    ids: {},
    best_oa_location: { pdf_url: 'https://arxiv.org/pdf/2502.01234v3.pdf?download=1' }
  }))
  assert.equal(best.arxiv, '2502.01234')

  const location = normalizeOpenAlexRecord(openAlexWork({
    doi: '',
    ids: {},
    best_oa_location: null,
    locations: [
      { landing_page_url: 'https://arxiv.org.evil.invalid/abs/2401.11111' },
      { pdf_url: 'http://arxiv.org/pdf/hep-th/9901001v4.pdf' }
    ]
  }))
  assert.equal(location.arxiv, 'hep-th/9901001')

  const beyondBound = normalizeOpenAlexRecord(openAlexWork({
    doi: '',
    ids: { arxiv: 'arXiv:2413.12345' },
    primary_location: null,
    best_oa_location: null,
    locations: [
      ...Array.from({ length: 50 }, () => ({ landing_page_url: 'https://example.invalid/not-arxiv' })),
      { landing_page_url: 'https://arxiv.org/abs/2403.12345' }
    ]
  }))
  assert.equal(beyondBound.arxiv, '')
})

test('conflicting DOI, PMID, or arXiv namespaces do not merge and quarantine the shared alias', () => {
  const makeRecord = (label, identifiers) => normalizeOpenAlexRecord(openAlexWork({
    id: `https://openalex.org/${label}`,
    doi: identifiers.doi || '',
    ids: {
      ...(identifiers.pmid ? { pmid: `https://pubmed.ncbi.nlm.nih.gov/${identifiers.pmid}` } : {}),
      ...(identifiers.arxiv ? { arxiv: `https://arxiv.org/abs/${identifiers.arxiv}` } : {})
    },
    display_name: `Identifier candidate ${label}`
  }))
  const scenarios = [
    {
      name: 'doi',
      left: { doi: '10.6000/one', pmid: '111' },
      right: { doi: '10.6000/two', pmid: '111' },
      bridge: { pmid: '111' }
    },
    {
      name: 'pmid',
      left: { doi: '10.6001/shared', pmid: '222' },
      right: { doi: '10.6001/shared', pmid: '333' },
      bridge: { doi: '10.6001/shared' }
    },
    {
      name: 'arxiv',
      left: { doi: '10.6002/shared', arxiv: '2401.12345' },
      right: { doi: '10.6002/shared', arxiv: '2402.12345' },
      bridge: { doi: '10.6002/shared' }
    }
  ]

  for (const scenario of scenarios) {
    const left = makeRecord(`${scenario.name}-left`, scenario.left)
    const right = makeRecord(`${scenario.name}-right`, scenario.right)
    const bridge = makeRecord(`${scenario.name}-bridge`, scenario.bridge)
    const fused = fuseAcademicRecords([
      { records: [left, right] },
      { records: [bridge] }
    ])
    assert.equal(fused.length, 3, `${scenario.name} conflict was collapsed`)
    assert.equal(fused.every((record) => record.provenance.length === 1), true)
  }
})

test('exact DOI fast path and generated filters use only fixed HTTPS hosts', () => {
  const exact = buildAcademicRequestUrls({ query: 'https://doi.org/10.1234/ABC', max_results: 20 })
  assert.equal(exact.options.doi, '10.1234/abc')
  assert.equal(new URL(exact.openalex).origin, 'https://api.openalex.org')
  assert.equal(new URL(exact.crossref).origin, 'https://api.crossref.org')
  assert.match(exact.openalex, /filter=doi%3A10\.1234%2Fabc/)
  assert.doesNotMatch(exact.openalex + exact.crossref, /localhost|file:|host=/i)

  const discovery = buildAcademicRequestUrls({
    query: 'safe topic', mode: 'author', sort: 'newest', year: 2025, preprint: 'only', max_results: 4,
    host: 'https://evil.invalid', filter: 'raw:evil'
  })
  assert.equal(new URL(discovery.crossref).searchParams.get('query.author'), 'safe topic')
  assert.match(new URL(discovery.openalex).searchParams.get('filter'), /^raw_author_name\.search:"safe topic",publication_year:2025,type:preprint$/)
  assert.equal(new URL(discovery.openalex).searchParams.has('search'), false)
  assert.doesNotMatch(discovery.openalex + discovery.crossref, /evil/)

  const escapedAuthor = buildAcademicRequestUrls({ query: 'Ada "Ace"\\Name,type:preprint', mode: 'author' })
  const escapedFilter = new URL(escapedAuthor.openalex).searchParams.get('filter')
  assert.equal(escapedFilter, String.raw`raw_author_name.search:"Ada \"Ace\"\\Name type:preprint"`)
  assert.equal(escapedFilter.split(',').length, 1)
  assert.equal(new URL(escapedAuthor.crossref).searchParams.get('query.author'), 'Ada "Ace"\\Name,type:preprint')

  const title = buildAcademicRequestUrls({ query: 'specific title', mode: 'title' })
  assert.match(new URL(title.openalex).searchParams.get('filter'), /^title\.search:specific title$/)
  assert.equal(new URL(title.openalex).searchParams.has('search'), false)
})

test('requested year is enforced on final exact-DOI records from both providers', async () => {
  const scheduler = async (_source, operation, options) => operation({ signal: options.signal })
  const result = await runAcademicSearch({ query: '10.1234/abc', year: 2025 }, {
    scheduler,
    fetchImpl: async (url) => new URL(url).hostname === 'api.openalex.org'
      ? new Response(JSON.stringify({ results: [openAlexWork({ publication_year: 2024 })] }), { status: 200 })
      : new Response(JSON.stringify({ message: crossrefWork({ published: { 'date-parts': [[2024, 1, 1]] } }) }), { status: 200 })
  })
  assert.equal(result.ok, true)
  assert.equal(result.exactDoi, '10.1234/abc')
  assert.equal(result.code, 'ACADEMIC_NO_RESULTS')
  assert.deepEqual(result.results, [])
})

test('HTTP 200 provider envelopes are validated while valid empty arrays remain successful coverage', async () => {
  const scheduler = async (_source, operation, options) => operation({ signal: options.signal })
  const runWith = (input, openalexEnvelope, crossrefEnvelope) => runAcademicSearch(input, {
    scheduler,
    fetchImpl: async (url) => new URL(url).hostname === 'api.openalex.org'
      ? new Response(JSON.stringify(openalexEnvelope), { status: 200 })
      : new Response(JSON.stringify(crossrefEnvelope), { status: 200 })
  })

  const empty = await runWith({ query: 'empty coverage' }, { results: [] }, { message: { items: [] } })
  assert.equal(empty.ok, true)
  assert.equal(empty.partial, false)
  assert.deepEqual(empty.providers, ['openalex', 'crossref'])
  assert.equal(empty.code, 'ACADEMIC_NO_RESULTS')

  const badOpenAlex = await runWith({ query: 'bad openalex' }, { meta: { count: 0 } }, { message: { items: [] } })
  assert.equal(badOpenAlex.ok, true)
  assert.equal(badOpenAlex.partial, true)
  assert.deepEqual(badOpenAlex.providers, ['crossref'])
  assert.deepEqual(badOpenAlex.failures.map(({ source, code, retryable }) => ({ source, code, retryable })), [
    { source: 'openalex', code: 'ACADEMIC_RESPONSE_INVALID', retryable: false }
  ])

  const badDiscovery = await runWith({ query: 'bad crossref' }, { results: [] }, { message: {} })
  assert.equal(badDiscovery.partial, true)
  assert.deepEqual(badDiscovery.providers, ['openalex'])
  assert.equal(badDiscovery.failures[0].retryable, false)

  const badExact = await runWith({ query: '10.1234/abc' }, { results: [] }, { message: [] })
  assert.equal(badExact.partial, true)
  assert.deepEqual(badExact.providers, ['openalex'])
  assert.equal(badExact.failures[0].code, 'ACADEMIC_RESPONSE_INVALID')
  assert.equal(badExact.failures[0].retryable, false)
})

test('one provider success is returned as bounded, explicitly untrusted partial coverage', async () => {
  const seen = []
  const scheduler = async (_source, operation, options) => operation({ signal: options.signal })
  const result = await runAcademicSearch({ query: 'topic', max_results: 3 }, {
    scheduler,
    fetchImpl: async (url) => {
      seen.push(url)
      if (new URL(url).hostname === 'api.crossref.org') throw new TypeError('network blocked')
      return new Response(JSON.stringify({ results: [openAlexWork()] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.partial, true)
  assert.deepEqual(result.providers, ['openalex'])
  assert.equal(result.results.length, 1)
  assert.equal(result.externalTextUntrusted, true)
  assert.match(formatAcademicSearchResults(result), /^\[UNTRUSTED EXTERNAL ACADEMIC DATA/)
  assert.equal(seen.length, 2)
})

test('HTTP and declared-size failures cancel endless academic response bodies before returning', async () => {
  for (const scenario of [
    { status: 429, headers: {} },
    { status: 200, headers: { 'content-length': '2000001' } }
  ]) {
    const observed = observableEndlessBody('{"results":[')
    const result = await runAcademicSearch({ query: `cleanup ${scenario.status}` }, {
      scheduler: directScheduler,
      fetchImpl: async (url) => new URL(url).hostname === 'api.openalex.org'
        ? new Response(observed.body, { status: scenario.status, headers: scenario.headers })
        : new Response(JSON.stringify({ message: { items: [] } }), { status: 200 })
    })
    const cancellation = await observed.cancelled

    assert.equal(result.ok, true)
    assert.equal(result.partial, true)
    assert.equal(observed.cancellationCount(), 1)
    assert.ok(cancellation.reason instanceof Error)
  }
})

test('academic parse failures abort the completed attempt signal before becoming provider failures', async () => {
  let failedSignal
  const result = await runAcademicSearch({ query: 'invalid provider JSON' }, {
    scheduler: directScheduler,
    fetchImpl: async (url, options) => {
      if (new URL(url).hostname === 'api.openalex.org') {
        failedSignal = options.signal
        return new Response('{not-json', { status: 200 })
      }
      return new Response(JSON.stringify({ message: { items: [] } }), { status: 200 })
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.partial, true)
  assert.equal(result.failures[0].code, 'ACADEMIC_RESPONSE_INVALID')
  assert.equal(failedSignal.aborted, true)
  assert.equal(failedSignal.reason?.code, 'ACADEMIC_RESPONSE_INVALID')
})

test('academic search preserves a custom caller abort reason instead of returning source failures', async () => {
  const controller = new AbortController()
  const reason = new Error('stop academic search')
  let fetchCalls = 0
  controller.abort(reason)

  await assert.rejects(runAcademicSearch({ query: 'cancelled' }, {
    signal: controller.signal,
    fetchImpl: async () => { fetchCalls += 1 }
  }), (error) => error === reason)
  assert.equal(fetchCalls, 0)
})

test('active academic requests preserve a custom abort reason and cancel both provider bodies', async () => {
  const controller = new AbortController()
  const reason = new Error('stop active academic search')
  const bodies = [
    observableEndlessBody('{"results":['),
    observableEndlessBody('{"message":{"items":[')
  ]
  let starts = 0
  let resolveStarted
  const started = new Promise((resolve) => { resolveStarted = resolve })
  const pending = runAcademicSearch({ query: 'active cancellation' }, {
    signal: controller.signal,
    scheduler: directScheduler,
    fetchImpl: async (url) => {
      const index = new URL(url).hostname === 'api.openalex.org' ? 0 : 1
      starts += 1
      if (starts === 2) resolveStarted()
      return new Response(bodies[index].body, { status: 200 })
    }
  })
  await started
  controller.abort(reason)

  await assert.rejects(pending, (error) => error === reason)
  const cancellations = await Promise.all(bodies.map((body) => body.cancelled))
  assert.deepEqual(bodies.map((body) => body.cancellationCount()), [1, 1])
  assert.equal(cancellations.every((item) => item.reason === reason), true)
})

test('a stalled provider times out while successful peer coverage remains usable', async () => {
  let stalledSignal
  const stalled = observableEndlessBody('{"results":[')
  const result = await runAcademicSearch({ query: 'bounded provider lifetime', max_results: 3 }, {
    scheduler: directScheduler,
    attemptTimeoutMs: 50,
    fetchImpl: async (url, options) => {
      if (new URL(url).hostname === 'api.openalex.org') {
        stalledSignal = options.signal
        return new Response(stalled.body, { status: 200 })
      }
      return new Response(JSON.stringify({ message: { items: [crossrefWork()] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  })
  const cancellation = await stalled.cancelled

  assert.equal(stalledSignal.aborted, true)
  assert.equal(stalled.cancellationCount(), 1)
  assert.equal(cancellation.reason?.code, 'SEARCH_TIMEOUT')
  assert.equal(result.ok, true)
  assert.equal(result.partial, true)
  assert.deepEqual(result.providers, ['crossref'])
  assert.equal(result.results.length, 1)
  assert.deepEqual(result.failures.map(({ source, code, retryable }) => ({ source, code, retryable })), [
    { source: 'openalex', code: 'SEARCH_TIMEOUT', retryable: true }
  ])
})

test('academic response bodies are stream-bounded and filters run before result truncation', async () => {
  const scheduler = async (_source, operation, options) => operation({ signal: options.signal })
  const oversized = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1_100_000))
      controller.enqueue(new Uint8Array(1_100_000))
      controller.close()
    }
  })
  const bounded = await runAcademicSearch({ query: 'bounded', max_results: 1 }, {
    scheduler,
    fetchImpl: async (url) => new URL(url).hostname === 'api.openalex.org'
      ? new Response(oversized, { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ message: { items: [crossrefWork()] } }), { status: 200 })
  })
  assert.equal(bounded.ok, true)
  assert.equal(bounded.partial, true)
  assert.equal(bounded.failures[0].code, 'ACADEMIC_RESPONSE_TOO_LARGE')

  const filtered = await runAcademicSearch({ query: 'filter', preprint: 'exclude', max_results: 1 }, {
    scheduler,
    fetchImpl: async (url) => {
      if (new URL(url).hostname === 'api.crossref.org') throw new TypeError('offline')
      return new Response(JSON.stringify({ results: [
        openAlexWork({ id: 'https://openalex.org/preprint', doi: '10.1/preprint', type: 'preprint' }),
        openAlexWork({ id: 'https://openalex.org/article', doi: '10.1/article', display_name: 'Eligible article' })
      ] }), { status: 200 })
    }
  })
  assert.equal(filtered.results.length, 1)
  assert.equal(filtered.results[0].title, 'Eligible article')
})

test('preprint exclusion finds eligible OpenAlex and Crossref records on later fixed-host pages', async () => {
  const requested = []
  const scheduled = []
  const scheduler = async (source, operation, options) => {
    scheduled.push(source)
    return operation({ signal: options.signal })
  }
  const result = await runAcademicSearch({ query: 'later article', preprint: 'exclude', max_results: 2 }, {
    scheduler,
    fetchImpl: async (url) => {
      const parsed = new URL(url)
      requested.push(parsed)
      if (parsed.hostname === 'api.openalex.org') {
        const page = Number(parsed.searchParams.get('page') || 1)
        const results = page === 1
          ? Array.from({ length: 4 }, (_, index) => openAlexWork({
            id: `https://openalex.org/P${index + 1}`,
            doi: `10.7000/open-preprint-${index + 1}`,
            display_name: `OpenAlex preprint ${index + 1}`,
            type: 'preprint'
          }))
          : [1, 2].map((index) => openAlexWork({
            id: `https://openalex.org/A${index}`,
            doi: `10.7000/open-article-${index}`,
            display_name: `OpenAlex eligible ${index}`
          }))
        return new Response(JSON.stringify({ meta: { count: 6 }, results }), { status: 200 })
      }
      const offset = Number(parsed.searchParams.get('offset') || 0)
      const items = offset === 0
        ? Array.from({ length: 4 }, (_, index) => crossrefWork({
          DOI: `10.8000/cross-preprint-${index + 1}`,
          title: [`Crossref preprint ${index + 1}`],
          type: 'posted-content'
        }))
        : [1, 2].map((index) => crossrefWork({
          DOI: `10.8000/cross-article-${index}`,
          title: [`Crossref eligible ${index}`]
        }))
      return new Response(JSON.stringify({ message: { 'total-results': 6, items } }), { status: 200 })
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.partial, false)
  assert.equal(result.results.length, 2)
  assert.equal(result.results.every((record) => !record.isPreprint), true)
  assert.deepEqual(requested.filter((url) => url.hostname === 'api.openalex.org').map((url) => url.searchParams.get('page')), [null, '2'])
  assert.deepEqual(requested.filter((url) => url.hostname === 'api.crossref.org').map((url) => url.searchParams.get('offset')), [null, '4'])
  assert.equal(requested.every((url) => ['https://api.openalex.org', 'https://api.crossref.org'].includes(url.origin)), true)
  assert.equal(scheduled.filter((source) => source === 'academic:openalex').length, 2)
  assert.equal(scheduled.filter((source) => source === 'academic:crossref').length, 2)
  assert.deepEqual(result.coveragePartialProviders, [])
})

test('preprint exclusion stops at its strict page cap and marks both provider coverages partial', async () => {
  const requested = []
  const scheduler = async (_source, operation, options) => operation({ signal: options.signal })
  const result = await runAcademicSearch({ query: 'preprint flood', preprint: 'exclude', max_results: 1 }, {
    scheduler,
    fetchImpl: async (url) => {
      const parsed = new URL(url)
      requested.push(parsed)
      if (parsed.hostname === 'api.openalex.org') {
        const page = Number(parsed.searchParams.get('page') || 1)
        return new Response(JSON.stringify({
          meta: { count: 100 },
          results: [1, 2].map((index) => openAlexWork({
            id: `https://openalex.org/cap-${page}-${index}`,
            doi: `10.9000/open-${page}-${index}`,
            display_name: `Open preprint ${page}-${index}`,
            type: 'preprint'
          }))
        }), { status: 200 })
      }
      const offset = Number(parsed.searchParams.get('offset') || 0)
      return new Response(JSON.stringify({
        message: {
          'total-results': 100,
          items: [1, 2].map((index) => crossrefWork({
            DOI: `10.9100/cross-${offset}-${index}`,
            title: [`Cross preprint ${offset}-${index}`],
            type: 'posted-content'
          }))
        }
      }), { status: 200 })
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.code, 'ACADEMIC_NO_RESULTS')
  assert.equal(result.partial, true)
  assert.deepEqual(result.coveragePartialProviders, ['openalex', 'crossref'])
  assert.deepEqual(result.failures, [])
  assert.deepEqual(requested.filter((url) => url.hostname === 'api.openalex.org').map((url) => url.searchParams.get('page')), [null, '2', '3'])
  assert.deepEqual(requested.filter((url) => url.hostname === 'api.crossref.org').map((url) => url.searchParams.get('offset')), [null, '2', '4'])
  assert.match(formatAcademicSearchResults(result), /Partial provider coverage; incomplete: openalex, crossref\./)
})
