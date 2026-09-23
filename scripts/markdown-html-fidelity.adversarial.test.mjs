import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import MarkdownIt from 'markdown-it'
import {
  installKnoteMarkdownRawHtml,
  decodeRawHtml,
  encodeRawHtml,
  RAW_HTML_BLOCK_ATTR,
  RAW_HTML_INLINE_ATTR
} from '../src/lib/markdownRawHtml.js'
import {
  installKnoteMarkdownFrontmatter,
  decodeFrontmatter,
  FRONTMATTER_ATTR
} from '../src/lib/markdownFrontmatter.js'
import { installKnoteMarkdownLinkifyCjk } from '../src/lib/markdownLinkifyCjk.js'
import taskListPlugin from 'markdown-it-task-lists'

const makeMarkdown = ({ frontmatter = false, tasks = false } = {}) => {
  const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
  installKnoteMarkdownRawHtml(md)
  if (frontmatter) installKnoteMarkdownFrontmatter(md)
  if (tasks) md.use(taskListPlugin, { enabled: true, label: true })
  return md
}

// ---- raw HTML ------------------------------------------------------------

test('HTML the document model cannot hold is carried in a placeholder', () => {
  const md = makeMarkdown()
  // a comment and a pasted table are the two forms ProseMirror would drop
  const comment = md.render('<!-- note -->\n')
  assert.match(comment, new RegExp(RAW_HTML_BLOCK_ATTR))
  assert.equal(decodeRawHtml(new RegExp(`${RAW_HTML_BLOCK_ATTR}="([^"]*)"`).exec(comment)[1]), '<!-- note -->\n')

  const table = md.render('<table style="min-width: 150px;">\n<colgroup><col></colgroup>\n</table>\n')
  assert.match(table, new RegExp(RAW_HTML_BLOCK_ATTR))
  const carried = decodeRawHtml(new RegExp(`${RAW_HTML_BLOCK_ATTR}="([^"]*)"`).exec(table)[1])
  assert.match(carried, /<colgroup>/)
})

test('inline raw HTML is carried in an inline placeholder', () => {
  const md = makeMarkdown()
  const html = md.render('文字里夹注释<!-- 行内 -->文字继续')
  assert.match(html, new RegExp(RAW_HTML_INLINE_ATTR))
  const carried = decodeRawHtml(new RegExp(`${RAW_HTML_INLINE_ATTR}="([^"]*)"`).exec(html)[1])
  assert.equal(carried, '<!-- 行内 -->')
})

test('HTML that Knote itself models is never captured', () => {
  const md = makeMarkdown()
  // a sized image and a coloured span are the editor's own output formats; they
  // must keep parsing into their real node/mark
  const sized = md.render('<img src="pixel.png" alt="a" style="width:40%;">\n')
  assert.doesNotMatch(sized, new RegExp(RAW_HTML_BLOCK_ATTR))
  assert.match(sized, /<img src="pixel\.png"/)

  const colored = md.render('<span style="color:#e11d48;">红色</span>\n')
  assert.doesNotMatch(colored, new RegExp(RAW_HTML_INLINE_ATTR))

  // markdown syntax that maps to a mark stays markdown
  const bold = md.render('<b>粗体</b>\n')
  assert.doesNotMatch(bold, new RegExp(RAW_HTML_INLINE_ATTR))
})

test('the task-list plugin keeps its own checkbox markup', () => {
  const md = makeMarkdown({ tasks: true })
  const html = md.render('- [x] 任务\n')
  // the checkbox must stay a real element: the task node reads its checked state
  assert.doesNotMatch(html, new RegExp(RAW_HTML_INLINE_ATTR))
  assert.match(html, /<input class="task-list-item-checkbox"/)
})

test('the raw-HTML rule is installed once', () => {
  const md = new MarkdownIt({ html: true })
  installKnoteMarkdownRawHtml(md)
  installKnoteMarkdownRawHtml(md)
  const html = md.render('<!-- a -->\n')
  assert.equal((html.match(new RegExp(RAW_HTML_BLOCK_ATTR, 'g')) || []).length, 1)
})

test('encode/decode round-trips HTML with quotes and ampersands', () => {
  const source = '<div class="x" data-a="b&c">i</div>\n'
  assert.equal(decodeRawHtml(encodeRawHtml(source)), source)
})

// ---- frontmatter ---------------------------------------------------------

test('a leading frontmatter block becomes one opaque placeholder', () => {
  const md = makeMarkdown({ frontmatter: true })
  const html = md.render('---\ntitle: T\ntags: [a, b]\n---\n\n# H\n')
  assert.match(html, new RegExp(FRONTMATTER_ATTR))
  const carried = decodeFrontmatter(new RegExp(`${FRONTMATTER_ATTR}="([^"]*)"`).exec(html)[1])
  assert.equal(carried, '---\ntitle: T\ntags: [a, b]\n---')
  assert.match(html, /<h1>H<\/h1>/)
})

test('frontmatter is only recognised at the very top of the document', () => {
  const md = makeMarkdown({ frontmatter: true })
  const later = md.render('text\n\n---\ntitle: T\n---\n')
  assert.doesNotMatch(later, new RegExp(FRONTMATTER_ATTR))
  // an unterminated block stays ordinary markdown (a rule + text)
  const open = md.render('---\ntitle: T\n')
  assert.doesNotMatch(open, new RegExp(FRONTMATTER_ATTR))
  assert.match(open, /<hr>/)
})

// ---- wiring contracts ----------------------------------------------------

test('the editor registers the atoms and the rules that feed them', async () => {
  const source = await readFile(new URL('../src/components/RichEditor.vue', import.meta.url), 'utf8')
  // raw-HTML + frontmatter atoms must outrank the paragraph node's bare `div`
  // rule, or ProseMirror parses every placeholder as an empty paragraph
  assert.match(source, /tag: `div\[\$\{RAW_HTML_BLOCK_ATTR\}\]`, priority: 90/)
  assert.match(source, /tag: `span\[\$\{RAW_HTML_INLINE_ATTR\}\]`, priority: 90/)
  assert.match(source, /tag: `div\[\$\{FRONTMATTER_ATTR\}\]`, priority: 90/)
  assert.match(source, /installKnoteMarkdownRawHtml\(markdownit\)/)
  assert.match(source, /installKnoteMarkdownFrontmatter\(markdownit\)/)
  assert.match(source, /KnoteRawHtmlBlock,/)
  assert.match(source, /KnoteRawHtmlInline,/)
  assert.match(source, /KnoteFrontmatter,/)
  // images are inline atoms (markdown's own model), so a paragraph containing
  // one must not be written as an empty row
  assert.match(source, /KnoteImage\.configure\(\{ inline: true, allowBase64: true \}\)/)
  assert.match(source, /if \(child\.isAtom && child\.type\.name !== 'hardBreak'\)/)
  // a code span must be able to live inside bold (`**\`x\`**`)
  assert.match(source, /excludes: '',/)
})

test('the frontmatter atom wins its white-space back from TipTap (issue #24)', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8')
  // @tiptap/core injects `.ProseMirror [contenteditable="false"] { white-space:
  // normal }` for atom node views at runtime, in a <style> that lands AFTER this
  // bundle. The frontmatter block is an atom node view, so with only the single
  // class the whole YAML head collapsed into one running paragraph.
  assert.match(css, /\.ProseMirror \.knote-frontmatter\s*\{[^}]*white-space:\s*pre-wrap\s*!important/)
  assert.match(css, /\.knote-frontmatter\s*\{[^}]*white-space:\s*pre-wrap/)
})

// ---- linkify boundaries ---------------------------------------------------

test('a bare URL does not swallow the Chinese text that follows it', () => {
  const md = new MarkdownIt({ linkify: true })
  installKnoteMarkdownLinkifyCjk(md)
  // linkify counts CJK as part of a URL: this used to become ONE link whose
  // href contained the comma and the rest of the sentence
  assert.match(
    md.renderInline('见 http://example.com/x，后面还有字'),
    /<a href="http:\/\/example\.com\/x">http:\/\/example\.com\/x<\/a>，后面还有字/
  )
  // the full-width full stop stays outside too
  assert.match(md.renderInline('见 http://example.com/x。'), /<\/a>。/)
  // English punctuation already behaved correctly
  assert.match(md.renderInline('see http://example.com/x.'), /<\/a>\./)
  // a mailto address keeps its address intact
  assert.match(
    md.renderInline('someone@example.com。'),
    /mailto:someone@example\.com">someone@example\.com<\/a>。/
  )
})

test('the trim also applies on the text-level linkify path', () => {
  const md = new MarkdownIt({ linkify: true })
  installKnoteMarkdownLinkifyCjk(md)
  const matches = md.linkify.match('http://example.com/x，后面')
  assert.equal(matches[0].url, 'http://example.com/x')
  assert.equal(matches[0].lastIndex, 'http://example.com/x'.length)
})
