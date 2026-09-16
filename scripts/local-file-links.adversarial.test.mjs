import test from 'node:test'
import assert from 'node:assert/strict'

import {
  bareMarkdownHostFilename,
  decodeLocalPath,
  isLocalMarkdownHref,
  localFileLinkMarkdown,
  relativePathFrom
} from '../src/lib/local-file-links.js'

test('relativePathFrom builds shareable forward-slash links inside the base and nothing outside', () => {
  assert.equal(relativePathFrom('C:\\docs\\notes', 'C:\\docs\\notes\\assets\\a b.pdf'), 'assets/a b.pdf')
  assert.equal(relativePathFrom('C:\\docs\\notes', 'C:\\docs\\notes\\sub\\deep\\x.zip'), 'sub/deep/x.zip')
  assert.equal(relativePathFrom('C:\\docs\\notes', 'C:\\docs\\notes\\file.md'), 'file.md')
  // case-insensitive base comparison (Windows)
  assert.equal(relativePathFrom('c:\\DOCS\\Notes', 'C:\\docs\\notes\\assets\\a.png'), 'assets/a.png')
  // outside the base → no relative link
  assert.equal(relativePathFrom('C:\\docs\\notes', 'C:\\docs\\other\\x.pdf'), '')
  assert.equal(relativePathFrom('C:\\docs\\notes', 'D:\\elsewhere\\x.pdf'), '')
  assert.equal(relativePathFrom('', 'C:\\x.pdf'), '')
})

test('localFileLinkMarkdown stays relative inside the doc dir, absolute forward-slash outside', () => {
  const docDir = 'C:\\docs\\notes'
  assert.equal(localFileLinkMarkdown('C:\\docs\\notes\\assets\\report.pdf', docDir), '[report.pdf](assets/report.pdf)')
  assert.equal(localFileLinkMarkdown('C:\\docs\\notes\\a b.pdf', docDir), '[a b.pdf](a%20b.pdf)')
  assert.equal(localFileLinkMarkdown('C:\\docs\\notes\\a(b).zip', docDir), '[a(b).zip](a%28b%29.zip)')
  assert.equal(localFileLinkMarkdown('C:\\docs\\other\\x y.zip', docDir), '[x y.zip](C:/docs/other/x%20y.zip)')
  assert.equal(localFileLinkMarkdown('C:\\docs\\other\\a(b).zip', docDir), '[a(b).zip](C:/docs/other/a%28b%29.zip)')
  assert.equal(localFileLinkMarkdown('D:\\elsewhere\\x.pdf', docDir), '[x.pdf](D:/elsewhere/x.pdf)')
  // unknown doc dir → always absolute
  assert.equal(localFileLinkMarkdown('C:\\docs\\notes\\assets\\x.pdf', ''), '[x.pdf](C:/docs/notes/assets/x.pdf)')
  // absolute links must never use a file:// scheme (markdown-it blocks file:)
  assert.equal(/%file%3A/i.test(localFileLinkMarkdown('C:\\x.pdf', '')), false)
  assert.doesNotMatch(localFileLinkMarkdown('C:\\x.pdf', ''), /file%3A/i)
  assert.doesNotMatch(localFileLinkMarkdown('C:\\x.pdf', ''), /:\/\/C:/)
  // '#' would start a fragment and '?' a query in the destination — both (and
  // a literal '%') must be percent-encoded so the link target is not truncated
  assert.equal(localFileLinkMarkdown('C:\\docs\\notes\\a#b.md', docDir), '[a#b.md](a%23b.md)')
  assert.equal(localFileLinkMarkdown('C:\\docs\\notes\\a?b.md', docDir), '[a?b.md](a%3Fb.md)')
  assert.equal(localFileLinkMarkdown('C:\\docs\\notes\\100%.md', docDir), '[100%.md](100%25.md)')
  assert.equal(localFileLinkMarkdown('C:\\docs\\notes\\a b#c?d.md', docDir), '[a b#c?d.md](a%20b%23c%3Fd.md)')
  assert.equal(localFileLinkMarkdown('C:\\docs\\notes\\调研#1.md', docDir), '[调研#1.md](%E8%B0%83%E7%A0%94%231.md)')
  // drive-letter colons stay readable in absolute destinations
  assert.equal(localFileLinkMarkdown('C:\\docs\\other\\a#b.zip', docDir), '[a#b.zip](C:/docs/other/a%23b.zip)')
})

test('decodeLocalPath undoes percent-encoding and survives malformed input', () => {
  assert.equal(decodeLocalPath('C:/docs/a%20b.pdf'), 'C:/docs/a b.pdf')
  assert.equal(decodeLocalPath('C:/docs/%E5%AF%BC%E8%AE%BA.md'), 'C:/docs/导论.md')
  assert.equal(decodeLocalPath('C:/docs/%ZZ.md'), 'C:/docs/%ZZ.md')
  assert.equal(decodeLocalPath(''), '')
})

test('bareMarkdownHostFilename unwraps http(s):// bare .md hosts, keeps real web URLs', () => {
  // agent/pasted links that prefix a bare local filename with http://
  assert.equal(bareMarkdownHostFilename('http://Harness-R1.md'), 'Harness-R1.md')
  assert.equal(bareMarkdownHostFilename('https://调研笔记.md'), '调研笔记.md')
  assert.equal(bareMarkdownHostFilename('http://a%20b.md/'), 'a b.md')
  // renderers punycode-encode non-ASCII hosts — decode back to the filename
  assert.equal(bareMarkdownHostFilename('http://xn--Harness-1r1ls88yba228dr62dtfe.md'), 'harness研究趋势调研.md')
  // real web URLs to .md files (real host + path) stay web links
  assert.equal(bareMarkdownHostFilename('https://example.com/a/b.md'), '')
  assert.equal(bareMarkdownHostFilename('https://raw.githubusercontent.com/u/r/main/x.md'), '')
  assert.equal(bareMarkdownHostFilename('http://localhost:8080/x.md'), '')
  // non-markdown / empty input
  assert.equal(bareMarkdownHostFilename('http://example.com'), '')
  assert.equal(bareMarkdownHostFilename(''), '')
  assert.equal(bareMarkdownHostFilename(null), '')
})

test('isLocalMarkdownHref classifies local markdown hrefs including bare-host wrappers', () => {
  assert.equal(isLocalMarkdownHref('调研笔记.md'), true)
  assert.equal(isLocalMarkdownHref('assets/a.markdown'), true)
  // drive-letter absolutes keep the Ctrl+click local-file convention (unchanged)
  assert.equal(isLocalMarkdownHref('C:/docs/x.md'), false)
  assert.equal(isLocalMarkdownHref('file:///C:/docs/x.md'), true)
  assert.equal(isLocalMarkdownHref('a.md#section'), true)
  assert.equal(isLocalMarkdownHref('http://Harness-R1.md'), true)
  assert.equal(isLocalMarkdownHref('http://xn--Harness-1r1ls88yba228dr62dtfe.md'), true)
  // web links (even to .md files on real hosts), other schemes, non-md files
  assert.equal(isLocalMarkdownHref('https://example.com/x.md'), false)
  assert.equal(isLocalMarkdownHref('https://example.com'), false)
  assert.equal(isLocalMarkdownHref('mailto:a@b.c'), false)
  assert.equal(isLocalMarkdownHref('javascript:alert(1)'), false)
  assert.equal(isLocalMarkdownHref('assets/x.pdf'), false)
  assert.equal(isLocalMarkdownHref('dir.md/file.txt'), false)
  assert.equal(isLocalMarkdownHref(''), false)
})
