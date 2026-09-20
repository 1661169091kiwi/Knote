// Obsidian-style wikilink image embeds: `![[file.ext]]` renders the image named
// `file.ext` from the note's own folder — the same sibling-file resolution the
// relative-path `![alt](file.ext)` form already gets via imagePathMapping.
// Non-image targets (`[[note.md]]` links) intentionally stay literal text:
// note links are out of scope, and their source bytes must round-trip intact.
const INSTALLED = Symbol.for('knote.markdownWikilinks')
const WIKILINK_IMAGE_RE = /^!\[\[([^\]\n]+)\]\]/
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico|apng)$/i

// A target qualifies as an embeddable image when it ENDS with an image
// extension, or when it is already a data-URL produced by Knote's own
// display-boundary swap (`![[pixel.png]]` becomes `![[data:image/…#knote-
// resource=…]]` before parsing — the display form must keep parsing as the
// same wikilink embed, and the save path must classify it so the tagged
// resource can be swapped back to the relative path).
export const isWikilinkImageTarget = (target) => {
  const value = String(target || '')
  return value.startsWith('data:image/') || IMAGE_EXT_RE.test(value)
}

// `![[pic.png|300]]` — an Obsidian size suffix after `|`; the file part wins
export const wikilinkImageTarget = (raw) => {
  const bare = String(raw || '').split('|')[0].trim()
  return bare && isWikilinkImageTarget(bare) ? bare : null
}

export const installKnoteMarkdownWikilinks = (markdownit) => {
  if (!markdownit || markdownit[INSTALLED]) return markdownit
  markdownit.inline.ruler.before('link', 'knote_wikilink_images', (state, silent) => {
    if (state.src[state.pos] !== '!') return false
    const m = WIKILINK_IMAGE_RE.exec(state.src.slice(state.pos))
    if (!m) return false
    const target = wikilinkImageTarget(m[1])
    if (!target) return false
    if (!silent) {
      const token = state.push('image', 'img', 0)
      // markdown-it's image renderer overwrites attrs['alt'] with
      // renderInlineAsText(children) — it needs BOTH an existing 'alt' attr
      // (attrIndex(-1) would crash) and a children array. Build the text
      // token with `new state.Token` so it lands ONLY in children — a
      // state.push would also spill it into the inline stream as literal text.
      // Alt shows the durable path, not the tagged display URL: the swap
      // boundary resolves `![[pixel.png]]` to a data URL before parsing, and
      // a base64 alt would leak into every degraded serialization path.
      const tagged = /#knote-resource=([^&#]+)/.exec(target)
      let altText = target
      if (tagged) {
        try { altText = decodeURIComponent(tagged[1]) } catch { altText = target }
      }
      const alt = new state.Token('text', '', 0)
      alt.content = altText
      token.children = [alt]
      token.content = altText
      token.attrSet('src', target)
      token.attrSet('alt', '')
      token.attrSet('data-knote-wikilink', '1')
      // Obsidian's `![[pic.png|300]]` size suffix has no rendering meaning in
      // Knote, but it must survive the round trip byte-for-byte, so the editor
      // carries it on the node and writes it back.
      const pipe = m[1].indexOf('|')
      if (pipe >= 0) {
        const size = m[1].slice(pipe + 1).trim()
        if (size) token.attrSet('data-knote-wikilink-size', size)
      }
    }
    state.pos += m[0].length
    return true
  })
  Object.defineProperty(markdownit, INSTALLED, { value: true })
  return markdownit
}
