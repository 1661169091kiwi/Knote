import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import MarkdownIt from 'markdown-it'
import {
  installKnoteMarkdownWikilinks,
  isWikilinkImageTarget,
  wikilinkImageTarget
} from '../src/lib/markdownWikilinks.js'
import { collectImageResourcePaths, rewriteImageResourcePaths } from '../src/lib/imagePathMapping.js'
import { serializeKnoteImage } from '../src/lib/imageMarkdown.js'

// The app's two markdown-it instances share this shape: entity-friendly HTML,
// hard breaks, linkify on, reference images off, and the fuzzy-link heuristic
// disabled so `[[note.md]]` stays literal instead of becoming http://note.md.
const makeMarkdown = () => {
  const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
  installKnoteMarkdownWikilinks(md)
  md.disable('reference')
  if (md.linkify) md.linkify.set({ fuzzyLink: false })
  return md
}

// ---- ![[file.ext]] embed rule ---------------------------------------------

test('wikilink image embeds render as <img> with the wikilink marker', () => {
  const html = makeMarkdown().render('![[shot.webp]]')
  assert.match(html, /<img src="shot\.webp"/)
  assert.match(html, /data-knote-wikilink="1"/)
  // alt text is the target itself; no stray paragraph text leaks from the rule
  assert.match(html, /alt="shot\.webp"/)
})

test('an obsidian |size suffix is stripped from the rendered target', () => {
  const html = makeMarkdown().render('![[pic.png|300]]')
  assert.match(html, /<img src="pic\.png"/)
  assert.doesNotMatch(html, /\|300/)
})

test('non-image wikilink targets stay literal text', () => {
  const html = makeMarkdown().render('see ![[notes.md]] here')
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /\[\[notes\.md\]\]/)
})

test('bare [[note.md]] never linkifies to http://note.md with fuzzy links off', () => {
  const html = makeMarkdown().render('ref [[note.md]] end')
  assert.doesNotMatch(html, /<a /)
  assert.doesNotMatch(html, /http:\/\/note\.md/)
  assert.match(html, /\[\[note\.md\]\]/)
})

test('full URLs still autolink with fuzzy links off', () => {
  const html = makeMarkdown().render('go https://example.com/x now')
  assert.match(html, /<a href="https:\/\/example\.com\/x"/)
})

test('the rule is idempotent when installed twice', () => {
  const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
  installKnoteMarkdownWikilinks(md)
  installKnoteMarkdownWikilinks(md)
  const html = md.render('![[shot.webp]]')
  assert.equal((html.match(/<img\b/g) || []).length, 1)
})

test('the display data-URL form of an embed keeps parsing as the same image', () => {
  // after the display-boundary swap the parser sees `![[data:image/…]]`, not
  // `![[pic.png]]` — the rule must keep firing or the embed renders as text
  const display = '![[data:image/png;base64,AAA#knote-resource=pic.png&knote-token=t]]'
  const html = makeMarkdown().render(display)
  assert.match(html, /<img src="data:image\/png;base64,AAA/)
  assert.match(html, /data-knote-wikilink="1"/)
})

// ---- target classification --------------------------------------------------

test('isWikilinkImageTarget accepts image extensions only', () => {
  for (const ok of ['a.png', 'b.JPG', 'c.webp', 'd.avif', 'e.svg', 'f.jpeg', 'g.gif', 'h.ico', 'i.bmp', 'j.apng']) {
    assert.equal(isWikilinkImageTarget(ok), true, ok)
  }
  for (const no of ['notes.md', 'report.txt', 'index.html', 'archive.tar.gz', '', null, undefined]) {
    assert.equal(isWikilinkImageTarget(no), false, String(no))
  }
})

test('wikilinkImageTarget splits the |size suffix and rejects non-image targets', () => {
  assert.equal(wikilinkImageTarget('pic.png|300'), 'pic.png')
  assert.equal(wikilinkImageTarget('  pic.png '), 'pic.png')
  assert.equal(wikilinkImageTarget('notes.md|300'), null)
  assert.equal(wikilinkImageTarget('|300'), null)
  assert.equal(wikilinkImageTarget('pic.png|extra|300'), 'pic.png')
})

// ---- source path scanner (display-boundary swap) ----------------------------

test('collectImageResourcePaths finds ![[embeds]] but not [[links]] or text', () => {
  const md = 'text ![[shot.webp]] and ![[pic.png|300]] but [[note.md]] plain ![alt](real.png)'
  assert.deepEqual(collectImageResourcePaths(md).sort(), ['pic.png', 'real.png', 'shot.webp'].sort())
})

test('rewriteImageResourcePaths rewrites the file part of ![[embeds]] in place', () => {
  const next = rewriteImageResourcePaths('see ![[shot.webp]] end', [['shot.webp', 'MAPPED']])
  assert.equal(next, 'see ![[MAPPED]] end')
})

test('a |size suffix survives the path rewrite', () => {
  const next = rewriteImageResourcePaths('![[pic.png|300]]', [['pic.png', 'MAPPED']])
  assert.equal(next, '![[MAPPED|300]]')
})

test('non-image wikilinks are never touched by the scanner', () => {
  const next = rewriteImageResourcePaths('[[note.md]] and ![[note.md]]', [['note.md', 'MAPPED']])
  assert.equal(next, '[[note.md]] and ![[note.md]]')
})

test('![[embeds]] inside fences and inline code stay literal', () => {
  const fenced = '```\n![[shot.webp]]\n```'
  assert.equal(rewriteImageResourcePaths(fenced, [['shot.webp', 'MAPPED']]), fenced)
  const inlined = 'code `![[shot.webp]]` end'
  assert.equal(rewriteImageResourcePaths(inlined, [['shot.webp', 'MAPPED']]), inlined)
  assert.deepEqual(collectImageResourcePaths(fenced + '\n' + inlined), [])
})

test('a swapped embed round-trips: relative path → tagged data URL → back', () => {
  // forward: the display swap tags the resolved data URL with its durable path
  const forward = rewriteImageResourcePaths('![[pic.png]]', [['pic.png', 'data:image/png;base64,AAA']])
  assert.match(forward, /^!\[\[data:image\/png;base64,AAA#knote-resource=pic\.png&knote-token=/)
  assert.match(forward, /\]\]$/)
  // and the tagged display form classifies as an image target, so the empty
  // reverse map still restores the durable relative path on save
  assert.equal(isWikilinkImageTarget(forward.slice(3, -2)), true)
  assert.equal(rewriteImageResourcePaths(forward, []), '![[pic.png]]')
})

// ---- serialization keeps the wikilink source form ----------------------------

test('serializeKnoteImage emits ![[target]] for wikilink-sourced images', () => {
  assert.equal(serializeKnoteImage({ src: 'shot.webp', alt: 'shot.webp', wikilink: true }), '![[shot.webp]]')
})

test('sized or aligned wikilink images fall back to the HTML form', () => {
  assert.match(serializeKnoteImage({ src: 'shot.webp', width: 50, wikilink: true }), /^<img\b/)
  assert.match(serializeKnoteImage({ src: 'shot.webp', align: 'center', wikilink: true }), /^<img\b/)
})

test('plain images are unaffected by the wikilink flag default', () => {
  assert.equal(serializeKnoteImage({ src: 'shot.webp', alt: 'x' }), '![x](shot.webp)')
})

// ---- wiring contracts (regression guards for issues #20 / #21) ---------------

test('the stock tiptap-markdown text/hardBreak serializers are replaced in RichEditor', async () => {
  const source = await readFile(new URL('../src/components/RichEditor.vue', import.meta.url), 'utf8')
  // KnoteText: only tag-like `<` is entity-escaped; `>` and `&` stay raw
  assert.match(source, /const KnoteText = Text\.extend\(/)
  assert.match(source, /state\.text\(node\.text\.replace\(\/<\(\?=\[a-zA-Z!\/\?\]\)\/g, '&lt;'\)\)/)
  // KnoteHardBreak: a hard break re-serializes as a bare newline (breaks:true
  // identity), not the stock backslash corruption from issue #20
  assert.match(source, /const KnoteHardBreak = HardBreak\.extend\(/)
  // a hard break writes a bare newline AND the block prefix: tiptap-markdown
  // records an inline mark's byte offset before the next write() inserts the
  // prefix, so inside a blockquote the recorded offset was two characters short
  // and its trimInline() then ate the "> " and duplicated the "**"
  assert.ok(source.includes("state.write(state.inTable ? '<br>' : `\\n${state.delim || ''}`)"))
  // StarterKit no longer registers the stock text/hardBreak nodes
  assert.match(source, /\btext: false\b/)
  assert.match(source, /\bhardBreak: false\b/)
  // both overrides are actually registered after KnoteParagraph
  const paragraph = source.indexOf('    KnoteParagraph,')
  const knoteText = source.indexOf('    KnoteText,')
  const knoteHardBreak = source.indexOf('    KnoteHardBreak,')
  assert.ok(paragraph >= 0 && knoteText > paragraph && knoteHardBreak > knoteText)
  // doubled brackets from a wikilink are unescaped on their way back out
  assert.match(source, /const restoreLiteralSyntax = \(segment\) => segment/)
  assert.match(source, /out\.push\(unescapeMathSpans\(mapOutsideInlineCode\(line, restoreLiteralSyntax\)\)\)/)
  // the embed carries a transient marker attr through the editor
  assert.match(source, /wikilink: \{\s*\r?\n\s*default: false,/)
  assert.match(source, /parseHTML: \(el\) => el\.getAttribute\('data-knote-wikilink'\) === '1'/)
})

test('both markdown-it setups install the wikilink rule and disable fuzzy links', async () => {
  const editor = await readFile(new URL('../src/components/RichEditor.vue', import.meta.url), 'utf8')
  assert.match(editor, /installKnoteMarkdownWikilinks\(markdownit\)/)
  assert.match(editor, /markdownit\.linkify\.set\(\{ fuzzyLink: false \}\)/)
  const app = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.match(app, /installKnoteMarkdownWikilinks\(md\)/)
  assert.match(app, /md\.linkify\.set\(\{ fuzzyLink: false \}\)/)
})
