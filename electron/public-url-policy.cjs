'use strict'

// This module deliberately performs no I/O. Callers inject the resolver used by
// their network stack and must validate the initial URL plus every redirect.
// Electron's proxy-aware net.request API has no socket-address/lookup override,
// so its policy lookup cannot be atomically pinned to the later connection.
// Replacing the hostname with an IP would also break TLS, PAC routing and HTTP
// proxies. Keep that residual DNS rebinding/remote-proxy-DNS limitation explicit
// rather than claiming the returned addresses bind a connection.

const ELECTRON_NET_DNS_BINDING_LIMITATION = Object.freeze({
  connectionPinned: false,
  description: 'Electron net.request preserves OS proxy/PAC behavior but cannot bind a request to the addresses returned by the policy lookup.'
})

class PublicUrlPolicyError extends Error {
  constructor (code, message, details, cause) {
    super(message)
    this.name = 'PublicUrlPolicyError'
    this.code = code
    if (details !== undefined) this.details = details
    if (cause !== undefined) this.cause = cause
  }
}

class DownloadPolicyError extends Error {
  constructor (code, message, details) {
    super(message)
    this.name = 'DownloadPolicyError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

const policyError = (code, message, details, cause) => new PublicUrlPolicyError(code, message, details, cause)
const downloadPolicyError = (code, message, details) => new DownloadPolicyError(code, message, details)

const parseIPv4 = (input) => {
  if (typeof input !== 'string') return null
  const parts = input.split('.')
  if (parts.length !== 4) return null
  const octets = []
  for (const part of parts) {
    // Leading zeroes are ambiguous to legacy parsers. WHATWG numeric host
    // aliases are canonicalized before reaching this strict address parser.
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return { family: 4, octets, address: octets.join('.') }
}

const canonicalIPv6 = (words) => {
  let bestStart = -1
  let bestLength = 0
  for (let index = 0; index < words.length;) {
    if (words[index] !== 0) {
      index += 1
      continue
    }
    let end = index + 1
    while (end < words.length && words[end] === 0) end += 1
    const length = end - index
    if (length >= 2 && length > bestLength) {
      bestStart = index
      bestLength = length
    }
    index = end
  }

  const hex = words.map((word) => word.toString(16))
  if (bestStart === -1) return hex.join(':')
  const left = hex.slice(0, bestStart).join(':')
  const right = hex.slice(bestStart + bestLength).join(':')
  return `${left}::${right}`
}

const parseIPv6 = (input) => {
  if (typeof input !== 'string' || !input || input.includes('%')) return null
  let value = input.toLowerCase()

  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':')
    if (lastColon === -1) return null
    const ipv4 = parseIPv4(value.slice(lastColon + 1))
    if (!ipv4) return null
    const high = ((ipv4.octets[0] << 8) | ipv4.octets[1]).toString(16)
    const low = ((ipv4.octets[2] << 8) | ipv4.octets[3]).toString(16)
    value = `${value.slice(0, lastColon)}:${high}:${low}`
  }

  const firstCompression = value.indexOf('::')
  if (firstCompression !== -1 && firstCompression !== value.lastIndexOf('::')) return null

  let words
  if (firstCompression !== -1) {
    const leftText = value.slice(0, firstCompression)
    const rightText = value.slice(firstCompression + 2)
    const left = leftText ? leftText.split(':') : []
    const right = rightText ? rightText.split(':') : []
    if (left.some((part) => !part) || right.some((part) => !part)) return null
    if (left.length + right.length >= 8) return null
    words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  } else {
    words = value.split(':')
    if (words.length !== 8 || words.some((part) => !part)) return null
  }

  if (words.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
  const numericWords = words.map((part) => Number.parseInt(part, 16))
  return { family: 6, words: numericWords, address: canonicalIPv6(numericWords) }
}

const parseIpAddress = (input) => {
  if (typeof input !== 'string' || !input || input !== input.trim()) return null
  let value = input
  let bracketed = false
  if (value.startsWith('[') || value.endsWith(']')) {
    if (!(value.startsWith('[') && value.endsWith(']'))) return null
    bracketed = true
    value = value.slice(1, -1)
  }
  const ipv4 = parseIPv4(value)
  if (ipv4) return bracketed ? null : ipv4
  return parseIPv6(value)
}

const normalizeIpAddress = (input) => {
  const parsed = parseIpAddress(input)
  if (!parsed) throw policyError('ERR_INVALID_IP', 'Invalid IP address')
  return parsed.address
}

const ipv4FromWords = (words) => {
  const high = words[6]
  const low = words[7]
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
}

const classifyIPv4 = (parsed) => {
  const [a, b, c, d] = parsed.octets
  let category = 'public'
  if (a === 0 && b === 0 && c === 0 && d === 0) category = 'unspecified'
  else if (a === 0) category = 'reserved'
  else if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) category = 'private'
  else if (a === 100 && b >= 64 && b <= 127) category = 'cgnat'
  else if (a === 127) category = 'loopback'
  else if (a === 169 && b === 254) category = 'link-local'
  else if (
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) category = 'documentation'
  else if (a >= 224 && a <= 239) category = 'multicast'
  else if (
    a >= 240 ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19))
  ) category = 'reserved'

  return {
    address: parsed.address,
    family: 4,
    kind: 'ipv4',
    category,
    public: category === 'public'
  }
}

const classifyIPv6 = (parsed) => {
  const words = parsed.words
  const allZero = words.every((word) => word === 0)
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1

  if (allZero) return { address: parsed.address, family: 6, kind: 'ipv6', category: 'unspecified', public: false }
  if (loopback) return { address: parsed.address, family: 6, kind: 'ipv6', category: 'loopback', public: false }

  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  const compatible = words.slice(0, 6).every((word) => word === 0)
  if (mapped || compatible) {
    const embedded = classifyIPv4(parseIPv4(ipv4FromWords(words)))
    const kind = mapped ? 'ipv4-mapped' : 'ipv4-compatible'
    return {
      address: parsed.address,
      family: 6,
      kind,
      category: embedded.public ? kind : embedded.category,
      public: false,
      embeddedAddress: embedded.address,
      embeddedCategory: embedded.category
    }
  }

  let category = 'public'
  if ((words[0] & 0xff00) === 0xff00) category = 'multicast'
  else if ((words[0] & 0xfe00) === 0xfc00) category = 'ula'
  else if ((words[0] & 0xffc0) === 0xfe80) category = 'link-local'
  else if ((words[0] & 0xffc0) === 0xfec0) category = 'site-local'
  else if (
    (words[0] === 0x2001 && words[1] === 0x0db8) ||
    (words[0] === 0x3fff && (words[1] & 0xf000) === 0)
  ) category = 'documentation'
  else if (
    (words[0] & 0xe000) !== 0x2000 ||
    (words[0] === 0x2001 && (words[1] & 0xfe00) === 0) ||
    words[0] === 0x2002
  ) category = 'reserved'

  return {
    address: parsed.address,
    family: 6,
    kind: 'ipv6',
    category,
    public: category === 'public'
  }
}

const classifyIpAddress = (input) => {
  const parsed = parseIpAddress(input)
  if (!parsed) throw policyError('ERR_INVALID_IP', 'Invalid IP address')
  return parsed.family === 4 ? classifyIPv4(parsed) : classifyIPv6(parsed)
}

const validateDomainSyntax = (hostname) => {
  if (!hostname || hostname.length > 253) throw policyError('ERR_INVALID_HOSTNAME', 'Invalid hostname')
  const labels = hostname.split('.')
  if (labels.some((label) => (
    !label ||
    label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))) throw policyError('ERR_INVALID_HOSTNAME', 'Invalid hostname')
  if (/^[0-9]+$/.test(labels[labels.length - 1])) throw policyError('ERR_INVALID_HOSTNAME', 'Invalid hostname')
}

const normalizeHostnameInfo = (input) => {
  if (typeof input !== 'string' || !input || input !== input.trim()) {
    throw policyError('ERR_INVALID_HOSTNAME', 'Invalid hostname')
  }

  const directAddress = parseIpAddress(input)
  if (directAddress) return { hostname: directAddress.address, family: directAddress.family }

  // Use the same WHATWG host parser as the eventual request API. In
  // particular, this canonicalizes legacy numeric forms such as 127.1 and
  // 0x7f000001 before they can be mistaken for DNS names.
  if (/[\/?#@\\]/.test(input) || input.includes(':')) {
    throw policyError('ERR_INVALID_HOSTNAME', 'Invalid hostname')
  }
  let parsed
  try {
    parsed = new URL(`http://${input}/`)
  } catch (cause) {
    throw policyError('ERR_INVALID_HOSTNAME', 'Invalid hostname', undefined, cause)
  }
  let hostname = parsed.hostname.toLowerCase()
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1)
  if (hostname.endsWith('.')) throw policyError('ERR_INVALID_HOSTNAME', 'Invalid hostname')

  const parsedAddress = parseIpAddress(hostname)
  if (parsedAddress) return { hostname: parsedAddress.address, family: parsedAddress.family }
  validateDomainSyntax(hostname)
  return { hostname, family: 0 }
}

const normalizeHostname = (input) => normalizeHostnameInfo(input).hostname

const assertPublicHostname = (hostInfo) => {
  if (hostInfo.family) {
    const classification = classifyIpAddress(hostInfo.hostname)
    if (!classification.public) {
      throw policyError('ERR_NON_PUBLIC_ADDRESS', 'URL resolves to a non-public address', {
        hostname: hostInfo.hostname,
        address: classification.address,
        category: classification.category,
        kind: classification.kind
      })
    }
    return classification
  }

  const labels = hostInfo.hostname.split('.')
  const localhostLabel = /^(?:localhost(?:6)?|ip6-localhost|ip6-loopback)$/
  const localSuffix = labels[labels.length - 1]
  if (
    labels.length < 2 ||
    labels.some((label) => localhostLabel.test(label)) ||
    ['local', 'localdomain', 'internal', 'home', 'lan', 'onion'].includes(localSuffix) ||
    hostInfo.hostname === 'home.arpa' ||
    hostInfo.hostname.endsWith('.home.arpa')
  ) {
    throw policyError('ERR_BLOCKED_HOSTNAME', 'URL uses a non-public hostname', { hostname: hostInfo.hostname })
  }
  return null
}

const urlInputText = (input, errorCode = 'ERR_INVALID_URL') => {
  let value
  if (typeof input === 'string') value = input
  else if (typeof URL !== 'undefined' && input instanceof URL) value = input.href
  else throw policyError(errorCode, 'URL must be a string or URL object')

  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f\\]/.test(value)) {
    throw policyError(errorCode, 'Invalid URL')
  }
  return value
}

const hasExplicitUserInfo = (value) => {
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(value)
  let rest = scheme ? value.slice(scheme[0].length) : value
  if (!rest.startsWith('//')) return false
  rest = rest.slice(2)
  const authority = rest.split(/[/?#]/, 1)[0]
  return authority.includes('@')
}

const parsePublicUrl = (input, baseUrl) => {
  const value = urlInputText(input)
  let base
  if (baseUrl !== undefined && baseUrl !== null) base = parsePublicUrl(baseUrl).url
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw policyError('ERR_INVALID_URL', 'URL must be absolute')

  let parsed
  try {
    parsed = base ? new URL(value, base) : new URL(value)
  } catch (cause) {
    throw policyError('ERR_INVALID_URL', 'Invalid URL', undefined, cause)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw policyError('ERR_UNSUPPORTED_PROTOCOL', 'Only HTTP and HTTPS URLs are allowed', { protocol: parsed.protocol })
  }
  if (parsed.username || parsed.password || hasExplicitUserInfo(value)) {
    throw policyError('ERR_URL_CREDENTIALS', 'URL credentials are not allowed')
  }
  if (!parsed.hostname) throw policyError('ERR_INVALID_HOSTNAME', 'URL hostname is required')

  const hostInfo = normalizeHostnameInfo(parsed.hostname)
  const literalClassification = assertPublicHostname(hostInfo)
  parsed.hostname = hostInfo.family === 6 ? `[${hostInfo.hostname}]` : hostInfo.hostname

  return {
    url: parsed.href,
    hostname: hostInfo.hostname,
    literalClassification
  }
}

const normalizePublicUrl = (input, baseUrl) => parsePublicUrl(input, baseUrl).url

const validationOptions = (options) => {
  if (typeof options === 'function') return { resolver: options }
  if (options === undefined || options === null) return {}
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw policyError('ERR_DNS_RESOLVER_REQUIRED', 'An async DNS resolver is required for hostnames')
  }
  return options
}

const abortReason = (signal) => {
  if (signal && signal.reason instanceof Error) return signal.reason
  const error = new Error('Public URL validation was cancelled')
  error.name = 'AbortError'
  error.code = 'ERR_REQUEST_ABORTED'
  return error
}

const throwIfAborted = (signal) => {
  if (signal && signal.aborted) throw abortReason(signal)
}

const awaitWithSignal = (value, signal) => {
  if (!signal) return Promise.resolve(value)
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, result) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn(result)
    }
    const onAbort = () => finish(reject, abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error)
    )
  })
}

const normalizeDnsAnswer = (answer, index) => {
  const rawAddress = typeof answer === 'string' ? answer : answer && answer.address
  if (typeof rawAddress !== 'string') {
    throw policyError('ERR_DNS_INVALID_ANSWER', 'DNS resolver returned an invalid address', { index })
  }

  let classification
  try {
    classification = classifyIpAddress(rawAddress)
  } catch (cause) {
    throw policyError('ERR_DNS_INVALID_ANSWER', 'DNS resolver returned an invalid address', { index }, cause)
  }

  if (answer && typeof answer === 'object' && answer.family !== undefined) {
    const familyText = typeof answer.family === 'string' ? answer.family.toLowerCase() : answer.family
    const declaredFamily = familyText === 'ipv4' ? 4 : familyText === 'ipv6' ? 6 : familyText
    if ((declaredFamily !== 4 && declaredFamily !== 6) || declaredFamily !== classification.family) {
      throw policyError('ERR_DNS_INVALID_ANSWER', 'DNS resolver returned inconsistent address metadata', {
        index,
        address: classification.address
      })
    }
  }
  return classification
}

const validatePublicUrl = async (input, options) => {
  const opts = validationOptions(options)
  throwIfAborted(opts.signal)
  const target = parsePublicUrl(input, opts.baseUrl)
  if (target.literalClassification) {
    return {
      url: target.url,
      hostname: target.hostname,
      addresses: [{ address: target.literalClassification.address, family: target.literalClassification.family }]
    }
  }

  if (typeof opts.resolver !== 'function') {
    throw policyError('ERR_DNS_RESOLVER_REQUIRED', 'An async DNS resolver is required for hostnames', {
      hostname: target.hostname
    })
  }

  let answers
  try {
    answers = await awaitWithSignal(
      Promise.resolve().then(() => opts.resolver(target.hostname, { all: true, verbatim: true })),
      opts.signal
    )
  } catch (cause) {
    if (opts.signal && opts.signal.aborted) throw abortReason(opts.signal)
    throw policyError('ERR_DNS_LOOKUP_FAILED', 'DNS lookup failed', { hostname: target.hostname }, cause)
  }
  throwIfAborted(opts.signal)
  if (!Array.isArray(answers)) {
    throw policyError('ERR_DNS_INVALID_ANSWER', 'DNS resolver must return an array of all addresses', {
      hostname: target.hostname
    })
  }
  if (answers.length === 0) {
    throw policyError('ERR_DNS_NO_ADDRESSES', 'DNS lookup returned no addresses', { hostname: target.hostname })
  }

  const validated = []
  const seen = new Set()
  for (let index = 0; index < answers.length; index += 1) {
    const classification = normalizeDnsAnswer(answers[index], index)
    if (!classification.public) {
      throw policyError('ERR_NON_PUBLIC_ADDRESS', 'DNS lookup returned a non-public address', {
        hostname: target.hostname,
        address: classification.address,
        category: classification.category,
        kind: classification.kind,
        index
      })
    }
    const key = `${classification.family}:${classification.address}`
    if (!seen.has(key)) {
      seen.add(key)
      validated.push({ address: classification.address, family: classification.family })
    }
  }

  return { url: target.url, hostname: target.hostname, addresses: validated }
}

const validateRedirectUrl = async (location, baseUrl, options) => {
  if (typeof location !== 'string' || !location) {
    throw policyError('ERR_INVALID_REDIRECT', 'Redirect location must be a non-empty string')
  }
  const opts = validationOptions(options)
  return validatePublicUrl(location, { resolver: opts.resolver, signal: opts.signal, baseUrl })
}

const createPublicUrlPolicy = (options) => {
  const opts = validationOptions(options)
  if (typeof opts.resolver !== 'function') {
    throw policyError('ERR_DNS_RESOLVER_REQUIRED', 'An async DNS resolver is required for hostnames')
  }
  return Object.freeze({
    validate: (input, requestOptions = {}) => validatePublicUrl(input, {
      ...validationOptions(requestOptions),
      resolver: opts.resolver
    }),
    validateRedirect: (location, baseUrl, requestOptions = {}) => validateRedirectUrl(location, baseUrl, {
      ...validationOptions(requestOptions),
      resolver: opts.resolver
    })
  })
}

const DOWNLOAD_PATH_CONTROL_RE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/
const DOWNLOAD_URL_MAX_CHARS = 8192
const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const DOWNLOAD_STAGING_RESERVED_RE = /^\.knote-download-[a-f0-9]{48}\.part$/i
const DANGEROUS_DOWNLOAD_EXTENSIONS = new Set([
  '.app', '.appimage', '.application', '.appref-ms', '.bat', '.bin', '.bash',
  '.cmd', '.command', '.com', '.cpl', '.crt', '.desktop', '.dll', '.drv',
  '.efi', '.exe', '.fish', '.gadget', '.hta', '.inf', '.ins', '.isp', '.jar',
  '.jse', '.js', '.lnk', '.msc', '.msi', '.msp', '.mst', '.ocx', '.pif',
  '.ps1', '.ps1xml', '.ps2', '.ps2xml', '.psc1', '.psc2', '.psd1', '.psm1',
  '.py', '.pyc', '.pyo', '.reg', '.run', '.scf', '.scr', '.search-ms',
  '.settingcontent-ms', '.sh', '.shortcut', '.sys', '.url', '.vb', '.vbe',
  '.vbs', '.website', '.workflow', '.ws', '.wsc', '.wsf', '.wsh', '.zsh'
])

const normalizeDownloadRelativePath = (input) => {
  if (typeof input !== 'string' || !input || input !== input.trim() || DOWNLOAD_PATH_CONTROL_RE.test(input)) {
    throw downloadPolicyError('INVALID_DOWNLOAD_PATH', 'Download path must be a non-empty relative path')
  }
  if (input.length > 1024) throw downloadPolicyError('INVALID_DOWNLOAD_PATH', 'Download path is too long')
  const portable = input.replace(/\\/g, '/')
  if (portable.startsWith('/') || portable.startsWith('//') || /^[a-z]:/i.test(portable)) {
    throw downloadPolicyError('INVALID_DOWNLOAD_PATH', 'Download path must be relative to the workspace')
  }
  const segments = portable.split('/')
  if (!segments.length || segments.some((segment) => (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.length > 255 ||
    /[<>:"|?*]/.test(segment) ||
    /[. ]$/.test(segment) ||
    WINDOWS_RESERVED_NAME_RE.test(segment) ||
    DOWNLOAD_STAGING_RESERVED_RE.test(segment)
  ))) {
    throw downloadPolicyError('INVALID_DOWNLOAD_PATH', 'Download path contains an unsafe component')
  }
  return segments.join('/')
}

const safeDecodedPathname = (url) => {
  let parsed
  try {
    parsed = new URL(parsePublicUrl(url).url)
  } catch (cause) {
    if (cause instanceof PublicUrlPolicyError) throw cause
    throw downloadPolicyError('INVALID_DOWNLOAD_URL', 'Invalid download URL')
  }
  try {
    return decodeURIComponent(parsed.pathname)
  } catch {
    throw downloadPolicyError('INVALID_DOWNLOAD_URL', 'Download URL path has invalid escaping')
  }
}

const dangerousExtension = (name) => {
  // This receives decoded path segments or Content-Disposition filenames,
  // not a raw URL. `#` and `;` are legal filename characters on Windows and
  // must not hide the actual executable suffix.
  const cleaned = String(name || '').replace(/[. ]+$/g, '').toLowerCase()
  const dot = cleaned.lastIndexOf('.')
  return dot >= 0 && DANGEROUS_DOWNLOAD_EXTENSIONS.has(cleaned.slice(dot))
    ? cleaned.slice(dot)
    : ''
}

const assertSafeDownloadName = (name, source = 'filename') => {
  const extension = dangerousExtension(name)
  if (extension) {
    throw downloadPolicyError('UNSAFE_DOWNLOAD_EXTENSION', 'Executable and shortcut downloads are not allowed', {
      source,
      extension
    })
  }
  return String(name || '')
}

const assertSafeDownloadUrl = (url) => {
  if (typeof url !== 'string' || !url || url.length > DOWNLOAD_URL_MAX_CHARS || DOWNLOAD_PATH_CONTROL_RE.test(url)) {
    throw downloadPolicyError('INVALID_DOWNLOAD_URL', 'Download URL is too long or contains unsafe text')
  }
  const pathname = safeDecodedPathname(url)
  if (DOWNLOAD_PATH_CONTROL_RE.test(pathname)) {
    throw downloadPolicyError('INVALID_DOWNLOAD_URL', 'Download URL path contains unsafe text')
  }
  for (const segment of pathname.split('/').filter(Boolean)) assertSafeDownloadName(segment, 'url')
  return url
}

const contentDispositionFilename = (value) => {
  const text = String(value || '')
  let match = /(?:^|;)\s*filename\*\s*=\s*(?:[a-z0-9_-]+'[^']*')?([^;]+)/i.exec(text)
  if (!match) match = /(?:^|;)\s*filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]+)/i.exec(text)
  if (!match) return ''
  let filename = match[1].trim()
  if (filename.startsWith('"') && filename.endsWith('"')) {
    filename = filename.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  try { filename = decodeURIComponent(filename) } catch { /* extension checks still apply to the raw value */ }
  return filename
}

const DANGEROUS_DOWNLOAD_MIME_RE = /^(?:application\/(?:ecmascript|internet-shortcut|java-archive|javascript|x-(?:bat|csh|dosexec|elf|executable|httpd-php|java-archive|lnk|mach-binary|ms-application|ms-dos-executable|ms-installer|ms-shortcut|msdos-program|msdownload|msi|object|perl|pie-executable|powershell|python|ruby|sharedlib|shellscript|sh)|vnd\.microsoft\.portable-executable)|text\/(?:ecmascript|javascript|x-(?:csh|perl|powershell|python|ruby|shellscript|sh)))$/i

const assertSafeDownloadResponseMetadata = ({ contentType = '', contentDisposition = '' } = {}) => {
  const mime = String(contentType || '').split(';', 1)[0].trim().toLowerCase()
  if (mime && DANGEROUS_DOWNLOAD_MIME_RE.test(mime)) {
    throw downloadPolicyError('UNSAFE_DOWNLOAD_MIME', 'Executable or script MIME type is not allowed', { mime })
  }
  const filename = contentDispositionFilename(contentDisposition)
  if (filename) assertSafeDownloadName(filename, 'content-disposition')
  return { mime, filename }
}

const detectExecutablePayload = (input) => {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || [])
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) return 'pe'
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'elf'
  if (buffer.length >= 4) {
    const magic = buffer.subarray(0, 4).toString('hex')
    if (['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(magic)) return 'mach-o'
  }
  if (
    buffer.length >= 20 &&
    buffer.subarray(0, 4).equals(Buffer.from([0x4c, 0x00, 0x00, 0x00])) &&
    buffer.subarray(4, 20).equals(Buffer.from('0114020000000000c000000000000046', 'hex'))
  ) return 'windows-shortcut'

  let text = ''
  const head = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (head[0] === 0xff && head[1] === 0xfe) text = head.subarray(2).toString('utf16le')
  else text = (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? head.subarray(3) : head).toString('utf8')
  if (/^#!/.test(text)) return 'script-shebang'
  if (/^(?:\s*@?echo\s+off\b|\s*#requires\s+-|\s*<\?php\b)/i.test(text)) return 'script-header'
  if (/<(?:hta:application|script\b[^>]*\blanguage\s*=)/i.test(text.slice(0, 2048))) return 'script-container'
  return ''
}

const assertSafeDownloadPayload = (input) => {
  const kind = detectExecutablePayload(input)
  if (kind) {
    throw downloadPolicyError('UNSAFE_DOWNLOAD_PAYLOAD', 'Executable or script payload is not allowed', { kind })
  }
  return true
}

module.exports = Object.freeze({
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
  normalizeHostname,
  normalizeDownloadRelativePath,
  normalizeIpAddress,
  normalizePublicUrl,
  validatePublicUrl,
  validateRedirectUrl
})
