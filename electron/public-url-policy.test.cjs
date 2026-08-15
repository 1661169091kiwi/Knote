'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  DownloadPolicyError,
  ELECTRON_NET_DNS_BINDING_LIMITATION,
  PublicUrlPolicyError,
  assertSafeDownloadName,
  assertSafeDownloadPayload,
  assertSafeDownloadResponseMetadata,
  assertSafeDownloadUrl,
  classifyIpAddress,
  createPublicUrlPolicy,
  detectExecutablePayload,
  normalizeDownloadRelativePath,
  normalizeHostname,
  normalizeIpAddress,
  normalizePublicUrl,
  validatePublicUrl,
  validateRedirectUrl
} = require('./public-url-policy.cjs')

const rejectsCode = async (promise, code, check) => {
  await assert.rejects(promise, (error) => {
    assert(error instanceof PublicUrlPolicyError)
    assert.equal(error.code, code)
    if (check) check(error)
    return true
  })
}

test('normalizes strict IP addresses and WHATWG numeric host aliases', () => {
  assert.equal(normalizeIpAddress('192.0.2.1'), '192.0.2.1')
  assert.equal(normalizeIpAddress('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1')
  assert.equal(normalizeIpAddress('[2606:4700:4700::1111]'), '2606:4700:4700::1111')
  assert.equal(normalizeHostname('2130706433'), '127.0.0.1')
  assert.equal(normalizeHostname('0177.0.0.1'), '127.0.0.1')
  assert.equal(normalizeHostname('0x7f.1'), '127.0.0.1')
  assert.throws(() => normalizeIpAddress('0177.0.0.1'), (error) => error.code === 'ERR_INVALID_IP')
  assert.throws(() => normalizeIpAddress('1.2.3.999'), (error) => error.code === 'ERR_INVALID_IP')
  assert.throws(() => normalizeIpAddress('fe80::1%eth0'), (error) => error.code === 'ERR_INVALID_IP')
})

test('classifies non-public IPv4 ranges conservatively', () => {
  const cases = [
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'reserved'],
    ['10.20.30.40', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.254', 'cgnat'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link-local'],
    ['192.0.2.1', 'documentation'],
    ['198.51.100.2', 'documentation'],
    ['203.0.113.3', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['192.0.0.1', 'reserved'],
    ['192.88.99.1', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved']
  ]
  for (const [address, category] of cases) {
    assert.deepEqual(
      { category: classifyIpAddress(address).category, public: classifyIpAddress(address).public },
      { category, public: false },
      address
    )
  }
  assert.equal(classifyIpAddress('8.8.8.8').public, true)
  assert.equal(classifyIpAddress('100.63.255.255').public, true)
  assert.equal(classifyIpAddress('100.128.0.0').public, true)
})

test('classifies native, mapped, and compatible IPv6 without textual bypasses', () => {
  const cases = [
    ['::', 'ipv6', 'unspecified'],
    ['::1', 'ipv6', 'loopback'],
    ['fc00::1', 'ipv6', 'ula'],
    ['fdff::1', 'ipv6', 'ula'],
    ['fe80::1', 'ipv6', 'link-local'],
    ['fec0::1', 'ipv6', 'site-local'],
    ['ff02::1', 'ipv6', 'multicast'],
    ['2001:db8::1', 'ipv6', 'documentation'],
    ['3fff:0::1', 'ipv6', 'documentation'],
    ['100::1', 'ipv6', 'reserved'],
    ['2001::1', 'ipv6', 'reserved'],
    ['2002:0808:0808::1', 'ipv6', 'reserved'],
    ['::ffff:127.0.0.1', 'ipv4-mapped', 'loopback'],
    ['::ffff:7f00:1', 'ipv4-mapped', 'loopback'],
    ['::ffff:10.0.0.1', 'ipv4-mapped', 'private'],
    ['::ffff:a00:1', 'ipv4-mapped', 'private'],
    ['::127.0.0.1', 'ipv4-compatible', 'loopback'],
    ['::7f00:1', 'ipv4-compatible', 'loopback'],
    ['::192.168.1.1', 'ipv4-compatible', 'private']
  ]
  for (const [address, kind, category] of cases) {
    const result = classifyIpAddress(address)
    assert.equal(result.kind, kind, address)
    assert.equal(result.category, category, address)
    assert.equal(result.public, false, address)
  }

  const dotted = classifyIpAddress('::ffff:127.0.0.1')
  const hex = classifyIpAddress('::ffff:7f00:1')
  assert.equal(dotted.address, '::ffff:7f00:1')
  assert.deepEqual(dotted, hex)
  assert.equal(dotted.embeddedAddress, '127.0.0.1')
  assert.equal(classifyIpAddress('::ffff:8.8.8.8').category, 'ipv4-mapped')
  assert.equal(classifyIpAddress('::ffff:8.8.8.8').public, false)
  assert.equal(classifyIpAddress('2606:4700:4700::1111').public, true)
  assert.equal(classifyIpAddress('2001:4860:4860::8888').public, true)
})

test('accepts only credential-free HTTP(S) URLs', () => {
  assert.equal(normalizePublicUrl('HTTP://Example.COM:80/a b?q=1#x'), 'http://example.com/a%20b?q=1#x')
  assert.equal(normalizePublicUrl('https://example.com.:443/path'), 'https://example.com/path')
  assert.throws(() => normalizePublicUrl('file:///etc/passwd'), (error) => error.code === 'ERR_UNSUPPORTED_PROTOCOL')
  assert.throws(() => normalizePublicUrl('ftp://example.com/file'), (error) => error.code === 'ERR_UNSUPPORTED_PROTOCOL')
  assert.throws(() => normalizePublicUrl('javascript:alert(1)'), (error) => error.code === 'ERR_INVALID_URL')
  assert.throws(() => normalizePublicUrl('//example.com/path'), (error) => error.code === 'ERR_INVALID_URL')
  assert.throws(() => normalizePublicUrl('http://user:pass@example.com/'), (error) => error.code === 'ERR_URL_CREDENTIALS')
  assert.throws(() => normalizePublicUrl('http://@example.com/'), (error) => error.code === 'ERR_URL_CREDENTIALS')
  assert.throws(() => normalizePublicUrl(' https://example.com/'), (error) => error.code === 'ERR_INVALID_URL')
  assert.throws(() => normalizePublicUrl('https://example.com\\@127.0.0.1/'), (error) => error.code === 'ERR_INVALID_URL')
})

test('rejects WHATWG numeric aliases before DNS resolution', async () => {
  const aliases = [
    'http://2130706433/',
    'http://0x7f000001/',
    'http://017700000001/',
    'http://127.1/',
    'http://127.0.1/',
    'http://0177.0.0.1/',
    'http://0x7f.1/'
  ]
  let resolverCalls = 0
  const resolver = async () => { resolverCalls += 1; return [{ address: '8.8.8.8', family: 4 }] }
  for (const alias of aliases) {
    await rejectsCode(validatePublicUrl(alias, resolver), 'ERR_NON_PUBLIC_ADDRESS', (error) => {
      assert.equal(error.details.address, '127.0.0.1')
      assert.equal(error.details.category, 'loopback')
    })
  }
  assert.equal(resolverCalls, 0)
})

test('rejects mapped and compatible IPv6 URL literals in dotted and canonical hex forms', async () => {
  const blocked = [
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:192.168.1.1]/',
    'http://[::ffff:c0a8:101]/',
    'http://[::127.0.0.1]/',
    'http://[::7f00:1]/'
  ]
  for (const url of blocked) {
    await rejectsCode(validatePublicUrl(url), 'ERR_NON_PUBLIC_ADDRESS')
  }
})

test('blocks localhost spelling variants without consulting DNS', async () => {
  const variants = [
    'http://localhost/',
    'http://LOCALHOST./',
    'http://api.localhost/',
    'http://localhost.example.com/',
    'http://localhost.localdomain/',
    'http://localhost6.localdomain6/',
    'http://ip6-localhost.example/',
    'http://printer.local/'
  ]
  let resolverCalls = 0
  const resolver = async () => { resolverCalls += 1; return ['8.8.8.8'] }
  for (const url of variants) await rejectsCode(validatePublicUrl(url, resolver), 'ERR_BLOCKED_HOSTNAME')
  assert.equal(resolverCalls, 0)
  await rejectsCode(validatePublicUrl('http://[::1]/', resolver), 'ERR_NON_PUBLIC_ADDRESS')
  assert.equal(resolverCalls, 0)
})

test('validates every DNS answer and fails closed on mixed public/private results', async () => {
  const mixed = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.7', family: 4 }
  ]
  await rejectsCode(validatePublicUrl('https://mixed.example/data', mixed), 'ERR_NON_PUBLIC_ADDRESS', (error) => {
    assert.equal(error.details.hostname, 'mixed.example')
    assert.equal(error.details.address, '10.0.0.7')
    assert.equal(error.details.category, 'private')
    assert.equal(error.details.index, 1)
  })

  const mixedV6 = async () => ['2606:4700:4700::1111', 'fe80::1']
  await rejectsCode(validatePublicUrl('https://mixed-v6.example/', mixedV6), 'ERR_NON_PUBLIC_ADDRESS')
  await rejectsCode(
    validatePublicUrl('https://mapped.example/', async () => ['::ffff:8.8.8.8']),
    'ERR_NON_PUBLIC_ADDRESS',
    (error) => assert.equal(error.details.kind, 'ipv4-mapped')
  )
})

test('fails closed for missing, failed, empty, and malformed DNS resolution', async () => {
  await rejectsCode(validatePublicUrl('https://public.example/'), 'ERR_DNS_RESOLVER_REQUIRED')
  await rejectsCode(
    validatePublicUrl('https://public.example/', async () => { throw new Error('offline') }),
    'ERR_DNS_LOOKUP_FAILED',
    (error) => assert.equal(error.cause.message, 'offline')
  )
  await rejectsCode(validatePublicUrl('https://public.example/', async () => []), 'ERR_DNS_NO_ADDRESSES')
  await rejectsCode(validatePublicUrl('https://public.example/', async () => null), 'ERR_DNS_INVALID_ANSWER')
  await rejectsCode(validatePublicUrl('https://public.example/', async () => ['not-an-ip']), 'ERR_DNS_INVALID_ANSWER')
  await rejectsCode(
    validatePublicUrl('https://public.example/', async () => [{ address: '8.8.8.8', family: 6 }]),
    'ERR_DNS_INVALID_ANSWER'
  )
})

test('resolves and validates relative, absolute, and network-path redirect inputs', async () => {
  const calls = []
  const resolver = async (hostname, options) => {
    calls.push({ hostname, options })
    return [{ address: '93.184.216.34', family: 4 }]
  }
  const relative = await validateRedirectUrl('../next?q=1', 'https://Public.Example/a/b', resolver)
  assert.equal(relative.url, 'https://public.example/next?q=1')
  assert.deepEqual(relative.addresses, [{ address: '93.184.216.34', family: 4 }])
  assert.deepEqual(calls, [{ hostname: 'public.example', options: { all: true, verbatim: true } }])

  const absolute = await validateRedirectUrl('http://other.example:80/final', relative.url, async () => ['8.8.4.4'])
  assert.equal(absolute.url, 'http://other.example/final')
  await rejectsCode(validateRedirectUrl('//127.0.0.1/admin', relative.url, resolver), 'ERR_NON_PUBLIC_ADDRESS')
  await rejectsCode(validateRedirectUrl('http://2130706433/admin', relative.url, resolver), 'ERR_NON_PUBLIC_ADDRESS')
  await rejectsCode(validateRedirectUrl('//user:pass@public.example/', relative.url, resolver), 'ERR_URL_CREDENTIALS')
  await rejectsCode(validateRedirectUrl('file:///etc/passwd', relative.url, resolver), 'ERR_UNSUPPORTED_PROTOCOL')
  await rejectsCode(validateRedirectUrl('', relative.url, resolver), 'ERR_INVALID_REDIRECT')
})

test('returns normalized URLs and validated public IPv4, IPv6, and domain addresses', async () => {
  let literalResolverCalled = false
  const literalResolver = async () => { literalResolverCalled = true; return [] }
  assert.deepEqual(await validatePublicUrl('http://8.8.8.8:80/a', literalResolver), {
    url: 'http://8.8.8.8/a',
    hostname: '8.8.8.8',
    addresses: [{ address: '8.8.8.8', family: 4 }]
  })
  assert.deepEqual(await validatePublicUrl('https://[2606:4700:4700:0:0:0:0:1111]:443/a', literalResolver), {
    url: 'https://[2606:4700:4700::1111]/a',
    hostname: '2606:4700:4700::1111',
    addresses: [{ address: '2606:4700:4700::1111', family: 6 }]
  })
  assert.equal(literalResolverCalled, false)

  let lookedUp = ''
  const domain = await validatePublicUrl('HTTPS://Public.Example.:443/a b', async (hostname) => {
    lookedUp = hostname
    return [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700:0:0:0:0:1111', family: 6 },
      { address: '93.184.216.34', family: 4 }
    ]
  })
  assert.equal(lookedUp, 'public.example')
  assert.deepEqual(domain, {
    url: 'https://public.example/a%20b',
    hostname: 'public.example',
    addresses: [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 }
    ]
  })
})

test('configured policy helper validates the initial URL and each redirect with one resolver', async () => {
  const calls = []
  const policy = createPublicUrlPolicy({
    resolver: async (hostname, options) => {
      calls.push({ hostname, options })
      return [{ address: '93.184.216.34', family: 'ipv4' }]
    }
  })
  const initial = await policy.validate('https://one.example/start')
  const redirected = await policy.validateRedirect('//two.example/final', initial.url)
  assert.equal(redirected.url, 'https://two.example/final')
  assert.deepEqual(calls, [
    { hostname: 'one.example', options: { all: true, verbatim: true } },
    { hostname: 'two.example', options: { all: true, verbatim: true } }
  ])

  await rejectsCode(
    policy.validateRedirect('http://[::ffff:7f00:1]/admin', redirected.url),
    'ERR_NON_PUBLIC_ADDRESS'
  )
})

test('policy lookup can be cancelled without waiting for an unbounded resolver', async () => {
  const controller = new AbortController()
  const policy = createPublicUrlPolicy({ resolver: () => new Promise(() => {}) })
  const pending = policy.validate('https://slow.example/', { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, (error) => error && error.name === 'AbortError')
})

test('documents that Electron proxy-aware requests are validated but not connection-pinned', () => {
  assert.equal(ELECTRON_NET_DNS_BINDING_LIMITATION.connectionPinned, false)
  assert.match(ELECTRON_NET_DNS_BINDING_LIMITATION.description, /OS proxy\/PAC/)
  assert.match(ELECTRON_NET_DNS_BINDING_LIMITATION.description, /cannot bind/i)
})

test('normalizes only safe workspace-relative download paths', () => {
  assert.equal(normalizeDownloadRelativePath('reports\\2026\\source.pdf'), 'reports/2026/source.pdf')
  assert.equal(normalizeDownloadRelativePath('source.pdf'), 'source.pdf')
  for (const value of [
    '', ' source.pdf', '/source.pdf', '\\server\\share\\source.pdf',
    'C:\\source.pdf', 'reports/../source.pdf', 'reports/./source.pdf',
    'reports//source.pdf', 'reports/source.pdf.', 'reports/source.pdf ',
    'reports/CON.txt', 'reports/file.txt:stream', 'reports/evil\u202Efdp.exe',
    `.knote-download-${'a'.repeat(48)}.part`
  ]) {
    assert.throws(
      () => normalizeDownloadRelativePath(value),
      (error) => error instanceof DownloadPolicyError && error.code === 'INVALID_DOWNLOAD_PATH',
      value
    )
  }
})

test('rejects executable and shortcut names in targets, URLs, and response metadata', () => {
  for (const name of [
    'tool.exe', 'report.PDF.LNK', 'setup.msi', 'run.ps1', 'site.url',
    'invoice.pdf;run.cmd', 'invoice.pdf#run.ps1'
  ]) {
    assert.throws(
      () => assertSafeDownloadName(name),
      (error) => error instanceof DownloadPolicyError && error.code === 'UNSAFE_DOWNLOAD_EXTENSION'
    )
  }
  assert.equal(assertSafeDownloadName('report.pdf'), 'report.pdf')
  assert.throws(() => assertSafeDownloadUrl('https://public.example/files/tool%2Eexe'), /not allowed/)
  assert.throws(() => assertSafeDownloadUrl('https://public.example/files/invoice.pdf%3Brun.cmd'), /not allowed/)
  assert.throws(() => assertSafeDownloadUrl('https://public.example/files/invoice.pdf%23run.ps1'), /not allowed/)
  assert.throws(
    () => assertSafeDownloadUrl('https://user:pass@public.example/report.pdf'),
    (error) => error instanceof PublicUrlPolicyError && error.code === 'ERR_URL_CREDENTIALS'
  )
  assert.throws(
    () => assertSafeDownloadResponseMetadata({ contentType: 'application/x-msdownload' }),
    (error) => error.code === 'UNSAFE_DOWNLOAD_MIME'
  )
  assert.throws(
    () => assertSafeDownloadResponseMetadata({ contentDisposition: 'attachment; filename="safe.pdf.exe"' }),
    (error) => error.code === 'UNSAFE_DOWNLOAD_EXTENSION'
  )
  assert.throws(
    () => assertSafeDownloadResponseMetadata({ contentDisposition: 'attachment; filename="safe.pdf;run.cmd"' }),
    (error) => error.code === 'UNSAFE_DOWNLOAD_EXTENSION'
  )
  assert.deepEqual(
    assertSafeDownloadResponseMetadata({ contentType: 'application/pdf; charset=binary', contentDisposition: 'attachment; filename="safe.pdf"' }),
    { mime: 'application/pdf', filename: 'safe.pdf' }
  )
})

test('rejects overlong and decoded-control download URLs', () => {
  assert.throws(
    () => assertSafeDownloadUrl(`https://public.example/${'a'.repeat(8192)}`),
    (error) => error instanceof DownloadPolicyError && error.code === 'INVALID_DOWNLOAD_URL'
  )
  assert.throws(
    () => assertSafeDownloadUrl('https://public.example/report%00.pdf'),
    (error) => error instanceof DownloadPolicyError && error.code === 'INVALID_DOWNLOAD_URL'
  )
})

test('detects executable and script payload signatures without rejecting normal documents', () => {
  const cases = [
    [Buffer.from('MZfake'), 'pe'],
    [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]), 'elf'],
    [Buffer.from('#!/usr/bin/env node\nconsole.log(1)\n'), 'script-shebang'],
    [Buffer.from('@echo off\r\necho unsafe\r\n'), 'script-header'],
    [Buffer.from('4c0000000114020000000000c000000000000046', 'hex'), 'windows-shortcut']
  ]
  for (const [payload, kind] of cases) {
    assert.equal(detectExecutablePayload(payload), kind)
    assert.throws(
      () => assertSafeDownloadPayload(payload),
      (error) => error instanceof DownloadPolicyError && error.code === 'UNSAFE_DOWNLOAD_PAYLOAD' && error.details.kind === kind
    )
  }
  assert.equal(detectExecutablePayload(Buffer.from('%PDF-1.7\n')), '')
  assert.equal(assertSafeDownloadPayload(Buffer.from('%PDF-1.7\n')), true)
})
