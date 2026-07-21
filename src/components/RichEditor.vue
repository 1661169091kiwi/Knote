<script setup>
// Feishu-style WYSIWYG editor surface (TipTap / ProseMirror core).
// Markdown in, markdown out — typing markdown syntax auto-converts via input
// rules and the raw symbols never stay on screen.
import { onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import { Extension, markInputRule } from '@tiptap/core'
import { NodeSelection, TextSelection, Plugin, PluginKey, EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { DOMSerializer } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import Bold from '@tiptap/extension-bold'
import Italic from '@tiptap/extension-italic'
import Strike from '@tiptap/extension-strike'
import Code from '@tiptap/extension-code'
import ListItem from '@tiptap/extension-list-item'
import Paragraph from '@tiptap/extension-paragraph'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import TextStyle from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import Image from '@tiptap/extension-image'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'
import Mathematics from '@tiptap/extension-mathematics'
import emojiTable from 'markdown-it-emoji/lib/data/full.mjs'
import 'katex/dist/katex.min.css'
import { Markdown } from 'tiptap-markdown'
import markdownItMark from 'markdown-it-mark'
import markdownItIns from 'markdown-it-ins'
import { toInternal, fromInternal } from '../lib/emptyRows.js'
import { renderMermaid } from '../lib/mermaidRender.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  t: { type: Function, required: true },
  // (title, defaultValue) => Promise<string|null> — the App's in-app input
  // dialog (window.prompt is a no-op in the Electron shell)
  promptText: { type: Function, default: null },
  placeholder: { type: String, default: '' },
  // false while hidden via v-show (split mode): external updates are
  // deferred so each textarea keystroke doesn't re-parse the hidden doc
  active: { type: Boolean, default: true }
})
const emit = defineEmits(['update:modelValue', 'rowchange', 'askagent', 'ctxmenu', 'viewimage'])

const rootRef = ref(null)

// ---- Custom marks/nodes ----

// Parser tweaks for the markdown bridge:
// - disable link "reference definitions": lines like `[^1]: 脚注` would be
//   swallowed as ref definitions and re-serialized as URL-encoded garbage
const MarkdownTweaks = Extension.create({
  name: 'knoteMarkdownTweaks',
  addStorage() {
    return {
      markdown: {
        parse: {
          setup(markdownit) {
            markdownit.disable('reference')
            markdownit.use(markdownItMark) // ==highlight== -> <mark>
            markdownit.use(markdownItIns)  // ++underline++ -> <ins>
            // Math passthrough: $...$/$$...$$ spans become literal text
            // tokens so their LaTeX reaches the doc RAW (no backslash-escape
            // or emphasis processing inside). The Mathematics extension then
            // renders the raw text via KaTeX decorations.
            markdownit.inline.ruler.before('escape', 'knote_math_passthrough', (state, silent) => {
              const src = state.src
              const pos = state.pos
              if (src[pos] !== '$') return false
              const isBlock = src[pos + 1] === '$'
              const delim = isBlock ? '$$' : '$'
              const start = pos + delim.length
              const end = src.indexOf(delim, start)
              if (end === -1) return false
              const content = src.slice(start, end)
              if (!content || content.includes('\n')) return false
              // match markdown-it-katex validation: inline math can't start
              // or end with whitespace (avoids "价格 $5 和 $10" false hits),
              // and a closing $ followed by a digit is a price ("$50-$60")
              if (!isBlock && (/^\s/.test(content) || /\s$/.test(content))) return false
              if (!isBlock && /\d/.test(src[end + 1] || '')) return false
              if (!silent) {
                const token = state.push('text', '', 0)
                token.content = delim + content + delim
              }
              state.pos = end + delim.length
              return true
            })
          }
        }
      }
    }
  }
})

// Formatting input rules must not fire inside a $math$ span — converting
// "*b*" in "$a*b*c$" to italic would split the text node and break both the
// KaTeX decoration and the serialized formula. An odd number of `$` before
// the match means the caret is inside an open math span.
const outsideMath = (regex) => (text) => {
  const m = regex.exec(text)
  if (!m) return null
  const dollars = (text.slice(0, m.index).match(/\$/g) || []).length
  if (dollars % 2 === 1) return null
  // function-style `find` must return an InputRuleMatch, not an exec array:
  // text = full match to replace, replaceWith = the captured inner content
  return { index: m.index, text: m[0], replaceWith: m[1] }
}

// ++underline++ persistence for the Underline mark
const MdUnderline = Underline.extend({
  parseHTML() {
    return [{ tag: 'u' }, { tag: 'ins' }]
  },
  addInputRules() {
    return [markInputRule({ find: outsideMath(/(?<!\+)\+\+([^+]+)\+\+$/), type: this.type })]
  },
  addStorage() {
    return {
      markdown: {
        serialize: { open: '++', close: '++', mixable: true, expelEnclosingWhitespace: true },
        parse: {}
      }
    }
  }
})

// ==highlight== persistence for the Highlight mark
const MdHighlight = Highlight.extend({
  addInputRules() {
    return [markInputRule({ find: outsideMath(/(?<!=)==([^=]+)==$/), type: this.type })]
  },
  addStorage() {
    return {
      markdown: {
        serialize: { open: '==', close: '==', mixable: true, expelEnclosingWhitespace: true },
        parse: {}
      }
    }
  }
})

// CJK-friendly input rules: TipTap's defaults require whitespace before the
// opening marker, which never happens inside Chinese text ("看**加粗**").
// Lookbehind-based regexes drop that requirement safely.
const CjkBold = Bold.extend({
  addInputRules() {
    return [
      markInputRule({ find: outsideMath(/(?<!\*)\*\*([^*]+)\*\*$/), type: this.type }),
      markInputRule({ find: outsideMath(/(?<!_)__([^_]+)__$/), type: this.type })
    ]
  }
})
const CjkItalic = Italic.extend({
  addInputRules() {
    return [
      markInputRule({ find: outsideMath(/(?<!\*)\*([^*\s][^*]*)\*$/), type: this.type }),
      markInputRule({ find: outsideMath(/(?<!_)_([^_\s][^_]*)_$/), type: this.type })
    ]
  }
})
const CjkStrike = Strike.extend({
  addInputRules() {
    return [markInputRule({ find: outsideMath(/(?<!~)~~([^~]+)~~$/), type: this.type })]
  }
})
const CjkCode = Code.extend({
  addInputRules() {
    return [markInputRule({ find: outsideMath(/(?<!`)`([^`]+)`$/), type: this.type })]
  }
})

// Empty paragraphs are real rows in this editor, but standard markdown cannot
// express them (blank lines are mere separators and collapse on parse). They
// are persisted as standalone `&nbsp;` lines — which render as empty-looking
// paragraphs in any markdown viewer — and normalized back to genuinely empty
// rows after parsing.
const KnoteParagraph = Paragraph.extend({
  parseHTML() {
    // <div> also parses as a row: our own clipboard HTML uses div-per-row
    // (see CopyPlainText), and chat-style HTML from other apps does too.
    // A div whose content isn't purely inline simply won't match and falls
    // through to its children, so layout divs from webpages stay harmless.
    return [{ tag: 'p' }, { tag: 'div' }]
  },
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      // Backspace at the START of a top-level paragraph that directly follows
      // a list (Feishu semantics): an empty row is deleted outright; a
      // non-empty row merges its text into the end of the last list item.
      // ProseMirror's default would instead absorb the paragraph into the
      // list as a NEW item (an unwanted "-" appears).
      Backspace: () => {
        const { state, view } = this.editor
        const { $from, empty } = state.selection
        if (!empty) return false
        if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph') return false
        if ($from.parentOffset !== 0) return false
        const index = $from.index(0)
        if (index === 0) return false
        const before = state.doc.child(index - 1)
        if (!['bulletList', 'orderedList', 'taskList'].includes(before.type.name)) return false

        const paraNode = $from.parent
        const paraPos = $from.before(1)
        // Landing point: end of the deepest last textblock inside the list
        const insertPos = TextSelection.near(state.doc.resolve(paraPos - 1), -1).from
        const tr = state.tr
        tr.delete(paraPos, paraPos + paraNode.nodeSize)
        if (paraNode.content.size > 0) {
          tr.insert(insertPos, paraNode.content)
        }
        tr.setSelection(TextSelection.create(tr.doc, insertPos))
        tr.scrollIntoView()
        view.dispatch(tr)
        return true
      }
    }
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node, parent) {
          // Blank = no text and no meaningful inline atoms (a space-only or
          // hardBreak-only paragraph is still a visually empty row)
          const blank = node.textContent.trim() === ''
          if (blank && parent && parent.type.name === 'doc') {
            // Top-level empty row -> internal `&nbsp;` placeholder line
            // (converted to a clean blank line at the component boundary).
            // Nested empty paragraphs (list items, quotes) must NOT get the
            // placeholder — the block prefix would leak "- &nbsp;" etc.
            state.write('&nbsp;')
            state.closeBlock(node)
          } else if (blank) {
            state.closeBlock(node)
          } else if (node.childCount === 1 && node.firstChild.isText && node.firstChild.text === '&nbsp;') {
            // A user-typed literal `&nbsp;` line would be indistinguishable
            // from the placeholder — escape the ampersand
            state.write('\\&nbsp;')
            state.closeBlock(node)
          } else {
            state.renderInline(node)
            state.closeBlock(node)
          }
        },
        parse: {}
      }
    }
  }
})

// Backspace on an EMPTY list item lifts it out of the list (nested items go
// up one level; top-level items become a flush-left paragraph). Without this,
// deleting the marker left the empty row stranded at list indentation.
const liftEmptyItemOnBackspace = (editor, itemName) => {
  const { $from, empty } = editor.state.selection
  if (!empty || $from.parentOffset !== 0) return false
  const item = $from.node(-1)
  if (!item || item.type.name !== itemName) return false
  if ($from.parent.content.size !== 0) return false
  return editor.chain().focus().liftListItem(itemName).run()
}

const KnoteListItem = ListItem.extend({
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Backspace: () => liftEmptyItemOnBackspace(this.editor, this.name)
    }
  }
})

const KnoteTaskItem = TaskItem.extend({
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Backspace: () => liftEmptyItemOnBackspace(this.editor, this.name)
    }
  }
})

// TipTap 2.27 ties a link mark's `inclusive` flag to `autolink`. With
// autolink enabled, typing at the right edge of an existing link therefore
// keeps extending the mark forever. Keep URL recognition, but make the mark
// boundary non-inclusive so following text is ordinary text and can be
// formatted independently.
const KnoteLink = Link.extend({
  inclusive() { return false }
})

// Editable documents must keep a normal click available for placing the
// caret. Ctrl/Cmd + left-click follows the familiar editor convention and
// opens web links in the default browser (Electron's window-open handler
// forwards the URL to shell.openExternal).
const CtrlClickLink = Extension.create({
  name: 'knoteCtrlClickLink',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('knoteCtrlClickLink'),
        props: {
          handleClick: (_view, _pos, event) => {
            if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false
            const target = event.target && event.target.nodeType === Node.ELEMENT_NODE
              ? event.target
              : event.target?.parentElement
            const anchor = target?.closest?.('a[href]')
            if (!anchor) return false
            let url
            try { url = new URL(anchor.getAttribute('href'), window.location.href) } catch { return false }
            if (!/^https?:$/.test(url.protocol)) return false
            event.preventDefault()
            window.open(url.href, '_blank', 'noopener,noreferrer')
            return true
          }
        }
      })
    ]
  }
})

// Some editing commands can leave two same-kind list nodes directly adjacent.
// CSS then exposes their block boundary as a gap-cursor row, but there is no
// paragraph to delete, so the two lists appear impossible to join. In Markdown
// adjacent same-kind lists are one list; normalize that invariant after every
// document-changing transaction.
const LIST_NODE_NAMES = new Set(['bulletList', 'orderedList', 'taskList'])
const JoinAdjacentLists = Extension.create({
  name: 'knoteJoinAdjacentLists',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('knoteJoinAdjacentLists'),
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null
          const tr = newState.tr
          // Replacing both list nodes with a freshly-built node makes the
          // transaction mapper put a text cursor at the end of the replacement.
          // Keep text selections in document coordinates and account for the
          // two list boundary tokens that disappear at every join.
          const preserveTextSelection = newState.selection instanceof TextSelection
          let selectionAnchor = newState.selection.anchor
          let selectionHead = newState.selection.head
          const mapJoinedListPosition = (value, rightStart) => {
            if (value < rightStart) return value
            if (value === rightStart) return value - 1
            return value - 2
          }
          let changed = false
          let index = 0
          let pos = 0
          while (index < tr.doc.childCount - 1) {
            const left = tr.doc.child(index)
            const right = tr.doc.child(index + 1)
            if (left.type === right.type && LIST_NODE_NAMES.has(left.type.name)) {
              const rightStart = pos + left.nodeSize
              const merged = left.type.create(left.attrs, left.content.append(right.content), left.marks)
              tr.replaceWith(pos, pos + left.nodeSize + right.nodeSize, merged)
              if (preserveTextSelection) {
                selectionAnchor = mapJoinedListPosition(selectionAnchor, rightStart)
                selectionHead = mapJoinedListPosition(selectionHead, rightStart)
              }
              changed = true
              // Re-check this position: there may be a third adjacent list.
              continue
            }
            pos += left.nodeSize
            index++
          }
          if (changed && preserveTextSelection) {
            const maxPos = tr.doc.content.size
            const anchor = Math.min(Math.max(0, selectionAnchor), maxPos)
            const head = Math.min(Math.max(0, selectionHead), maxPos)
            tr.setSelection(TextSelection.between(
              tr.doc.resolve(anchor),
              tr.doc.resolve(head),
              anchor <= head ? 1 : -1
            ))
          }
          return changed ? tr : null
        }
      })
    ]
  }
})

// Non-resizable tables render bare (the .tableWrapper only exists when
// resizable) — add the scroll wrapper via a NodeView. A NodeView only shapes
// the EDITOR DOM: renderHTML/toDOM stay untouched, so serialized HTML
// (clipboard, tiptap-markdown's raw-HTML table fallback) never contains the
// wrapper div.
const KnoteTable = Table.extend({
  addNodeView() {
    return () => {
      const dom = document.createElement('div')
      dom.className = 'tableWrapper'
      const table = document.createElement('table')
      const tbody = document.createElement('tbody')
      table.appendChild(tbody)
      dom.appendChild(table)
      return {
        dom,
        contentDOM: tbody,
        update: (node) => node.type.name === 'table'
      }
    }
  }
})

// Code block with a language picker in the top-right corner. The language is
// the fence info string (```python) — GFM keeps it, so it persists in the
// markdown and round-trips through every view.
const CODE_LANGUAGES = [
  'plaintext', 'javascript', 'typescript', 'python', 'java', 'c', 'cpp',
  'csharp', 'go', 'rust', 'html', 'css', 'vue', 'json', 'yaml', 'bash',
  'sql', 'markdown'
]

// Syntax highlighting via lowlight (same highlight.js grammars and token
// classes as the split preview, so both views color identically)
const lowlight = createLowlight(common)

const KnoteCodeBlock = CodeBlockLowlight.extend({
  parseHTML() {
    // contentElement pins content parsing to the <code> child, so DOM copies
    // of our own NodeView (which puts the picker first) don't leak the
    // picker labels into the code text
    return [{ tag: 'pre', preserveWhitespace: 'full', contentElement: 'code' }]
  },
  addNodeView() {
    // 'plaintext' and no language are the same thing (bare ``` fence)
    const normLang = (l) => (!l || l === 'plaintext' ? '' : l)
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('pre')
      dom.className = 'knote-codeblock'
      let currentLang = normLang(node.attrs.language)

      // Custom dropdown (a native <select> popup can't be styled)
      const wrap = document.createElement('div')
      wrap.className = 'knote-code-lang'
      wrap.contentEditable = 'false'
      const trigger = document.createElement('button')
      trigger.type = 'button'
      trigger.className = 'knote-code-lang-btn'
      const menu = document.createElement('div')
      menu.className = 'knote-code-lang-menu'
      menu.style.display = 'none'
      const items = new Map()
      const renderTrigger = () => {
        trigger.innerHTML = `<span>${currentLang || 'text'}</span>`
          + '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>'
      }
      const renderActive = () => {
        for (const [lang, el] of items) {
          el.classList.toggle('active', normLang(lang) === currentLang)
        }
      }
      const pickLanguage = (lang) => {
        menu.style.display = 'none'
        const value = normLang(lang)
        const pos = getPos()
        if (typeof pos !== 'number') return
        const { state, view } = editor
        const target = state.doc.nodeAt(pos)
        if (!target || target.type.name !== 'codeBlock') return
        view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...target.attrs, language: value || null }))
        // hand focus back so Ctrl+Z / typing land in the editor
        view.focus()
      }
      const addItem = (lang) => {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'knote-code-lang-item'
        item.textContent = lang
        item.addEventListener('click', () => pickLanguage(lang))
        items.set(lang, item)
        menu.appendChild(item)
      }
      const initialLangs = currentLang && !CODE_LANGUAGES.includes(currentLang)
        ? [currentLang, ...CODE_LANGUAGES]
        : CODE_LANGUAGES
      initialLangs.forEach(addItem)
      trigger.addEventListener('click', () => {
        menu.style.display = menu.style.display === 'none' ? 'flex' : 'none'
      })
      const onDocMousedown = (e) => {
        if (!wrap.contains(e.target)) menu.style.display = 'none'
      }
      document.addEventListener('mousedown', onDocMousedown)
      renderTrigger()
      renderActive()
      wrap.appendChild(trigger)
      wrap.appendChild(menu)

      const code = document.createElement('code')
      if (currentLang) code.className = `language-${currentLang}`
      dom.appendChild(wrap)
      dom.appendChild(code)

      // live mermaid diagram below the (still editable) source, when the
      // fence language is `mermaid`. contentEditable=false + ignoreMutation
      // keep ProseMirror from treating the injected SVG as document content.
      const preview = document.createElement('div')
      preview.className = 'knote-mermaid-preview'
      preview.contentEditable = 'false'
      preview.style.display = 'none'
      dom.appendChild(preview)
      let mmdTimer = null
      let lastMmdSrc = null
      const renderPreview = (n) => {
        if (currentLang !== 'mermaid') { preview.style.display = 'none'; lastMmdSrc = null; return }
        const src = n.textContent
        if (src === lastMmdSrc) return
        lastMmdSrc = src
        clearTimeout(mmdTimer)
        mmdTimer = setTimeout(async () => {
          if (currentLang !== 'mermaid') return
          if (!src.trim()) { preview.style.display = 'none'; return }
          const isDark = ((document.querySelector('[data-theme]') || document.documentElement).getAttribute('data-theme') || '').includes('dark')
          const res = await renderMermaid(src, isDark)
          if (currentLang !== 'mermaid' || n.textContent !== src) return
          preview.style.display = 'block'
          preview.className = 'knote-mermaid-preview' + (res.ok ? '' : ' knote-mermaid-error')
          if (res.ok) preview.innerHTML = res.svg
          else preview.textContent = res.error
        }, 400)
      }
      renderPreview(node)
      return {
        dom,
        contentDOM: code,
        stopEvent: (e) => wrap.contains(e.target) || preview.contains(e.target),
        ignoreMutation: (m) => wrap.contains(m.target) || m.target === wrap || preview.contains(m.target) || m.target === preview,
        update: (updated) => {
          if (updated.type.name !== 'codeBlock') return false
          const lang = normLang(updated.attrs.language)
          if (lang !== currentLang) {
            currentLang = lang
            if (lang && !items.has(lang)) addItem(lang)
            renderTrigger()
            renderActive()
          }
          code.className = lang ? `language-${lang}` : ''
          renderPreview(updated)
          return true
        },
        destroy: () => {
          document.removeEventListener('mousedown', onDocMousedown)
          clearTimeout(mmdTimer)
        }
      }
    }
  }
})

// WYSIWYG rendering for :emoji_shortcodes: and [^footnote] references —
// same decoration pattern as the math extension: the raw text stays in the
// doc (and the markdown), a widget shows the pretty form, and moving the
// caret inside the span reveals the source for editing.
const InlineRender = Extension.create({
  name: 'knoteInlineRender',
  addProseMirrorPlugins() {
    const hiddenStyle = 'display: inline-block; height: 0; opacity: 0; overflow: hidden; position: absolute; width: 0;'
    const widget = (tag, className, text) => () => {
      const el = document.createElement(tag)
      el.className = className
      el.textContent = text
      return el
    }
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decos = []
            const { from: selFrom, to: selTo } = state.selection
            state.doc.descendants((node, pos) => {
              if (node.type.name === 'codeBlock') return false
              if (node.isTextblock && /^\[\^[^\]\s]+\]:/.test(node.textContent)) {
                // footnote definition row: styled, content kept editable
                decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'knote-footnote-def' }))
              }
              if (!node.isText || !node.text) return true
              if (node.marks.some((m) => m.type.name === 'code')) return true
              const apply = (re, build) => {
                let m
                while ((m = re.exec(node.text))) {
                  const from = pos + m.index
                  const to = from + m[0].length
                  if (selFrom <= to && selTo >= from) continue // editing: show raw
                  const w = build(m)
                  if (!w) continue
                  decos.push(Decoration.inline(from, to, { class: 'knote-chip-src', style: hiddenStyle }))
                  decos.push(Decoration.widget(from, w, { side: 1 }))
                }
              }
              apply(/:([a-z0-9_+-]+):/g, (m) => {
                const ch = emojiTable[m[1]]
                return ch ? widget('span', 'knote-emoji', ch) : null
              })
              apply(/\[\^([^\]\s]+)\](?!:)/g, (m) => widget('sup', 'knote-footnote-ref', m[1]))
              return true
            })
            return decos.length ? DecorationSet.create(state.doc, decos) : null
          }
        }
      })
    ]
  }
})

// Clipboard tuning — both flavors used to gain blank lines in other apps:
// - text/plain: PM's default joins blocks with a BLANK line; we join rows
//   with a single newline (an empty row is exactly one blank line).
// - text/html: paragraphs were <p>…</p>, and chat-style targets (WeChat/QQ
//   etc.) expand every <p> boundary into a double line break. Rows are
//   serialized as <div> instead (single-line semantics there, still a
//   paragraph in Word); an empty row is <div><br></div>.
const CopyPlainText = Extension.create({
  name: 'knoteCopyPlainText',
  addProseMirrorPlugins() {
    const base = DOMSerializer.fromSchema(this.editor.schema)
    const rowSerializer = new DOMSerializer(
      {
        ...base.nodes,
        paragraph: (node) => (node.childCount === 0 ? ['div', ['br']] : ['div', 0])
      },
      base.marks
    )
    // A SINGLE copied text row must paste INLINE: wrapped in a block element
    // (<div>/<p>) the receiving app appends a line break after it — "copying
    // one line pastes with a trailing blank line". Serialize the lone row's
    // inline content bare; multi-row copies keep div-per-row. (Code blocks
    // stay wrapped: their \n's would be collapsed as bare HTML text.)
    const clipboardSerializer = {
      serializeFragment: (fragment, options, target) => {
        const only = fragment.childCount === 1 ? fragment.firstChild : null
        if (only && only.childCount > 0 && (only.type.name === 'paragraph' || only.type.name === 'heading')) {
          return rowSerializer.serializeFragment(only.content, options, target)
        }
        return rowSerializer.serializeFragment(fragment, options, target)
      },
      serializeNode: (node, options) => rowSerializer.serializeNode(node, options)
    }
    return [
      new Plugin({
        props: {
          clipboardTextSerializer: (slice) =>
            slice.content.textBetween(0, slice.content.size, '\n', (leaf) =>
              leaf.type.name === 'hardBreak' ? '\n' : ''),
          clipboardSerializer
        }
      })
    ]
  }
})

// ---- In-document preview of an agent-proposed change ----
// The affected top-level blocks get a red tint and a green box shows the
// proposed new content in place. Markdown line numbers don't map 1:1 to PM
// nodes, so blocks are located by fuzzy TEXT matching — best-effort; the
// bottom confirmation card is always the authoritative view.
const agentPreviewKey = new PluginKey('knoteAgentPreview')

// Comparison key for matching markdown SOURCE lines against RENDERED block
// text. All whitespace is REMOVED (not collapsed): stripping inline markers
// (`**`, backticks…) leaves phantom gaps on the source side that don't exist
// in the rendered textContent — with CJK text (no word spaces) those gaps
// broke both equality and containment.
const stripMdLine = (s) => String(s || '')
  .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[*_`~|]|==|\+\+/g, ' ')
  .replace(/\s+/g, '')

// One green box per hunk: slim header (title + ✓/✕) above the proposed
// content. mousedown is swallowed so clicking a button doesn't move the caret.
const buildHunkWidget = (h, payload, t) => {
  const el = document.createElement('div')
  el.className = 'knote-agent-new'
  el.dataset.hunkId = h.id
  const head = document.createElement('div')
  head.className = 'knote-agent-head'
  const title = document.createElement('span')
  title.className = 'knote-agent-title'
  title.textContent = h.title || ''
  head.appendChild(title)
  const mkBtn = (cls, label, svg, handler) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `knote-agent-btn ${cls}`
    b.title = label
    b.innerHTML = svg
    b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); handler() })
    return b
  }
  head.appendChild(mkBtn('knote-agent-btn-accept', t('agent_hunk_accept'),
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" width="13" height="13"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>',
    () => payload.onAccept && payload.onAccept(h.id)))
  head.appendChild(mkBtn('knote-agent-btn-reject', t('agent_hunk_reject'),
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" width="13" height="13"><path stroke-linecap="round" d="m5.5 5.5 9 9m0-9-9 9"/></svg>',
    () => payload.onReject && payload.onReject(h.id)))
  el.appendChild(head)
  const bodyText = (h.newLines || []).join('\n')
  if (bodyText.trim()) {
    const bodyEl = document.createElement('div')
    bodyEl.className = 'knote-agent-new-body'
    bodyEl.textContent = bodyText
    el.appendChild(bodyEl)
  }
  if (h.previewImage) {
    const img = document.createElement('img')
    img.src = h.previewImage
    img.className = 'knote-agent-new-img'
    el.appendChild(img)
  }
  return el
}

const buildAgentPreviewDecos = (doc, payload, t) => {
  const hunks = payload && Array.isArray(payload.hunks) ? payload.hunks : null
  if (!hunks || !hunks.length) return DecorationSet.empty
  const blocks = []
  doc.forEach((node, offset) => blocks.push({ node, pos: offset, text: stripMdLine(node.textContent) }))
  const decos = []
  // exact equality wins over containment (a 2-char paragraph "数据" must not
  // hijack a hunk targeting "数据库设计规范"); containment needs bt >= 2 chars
  const fuzzy = (bt, tg) => !!bt && bt.length >= 2 && !!tg && (bt.includes(tg) || tg.includes(bt))
  const findBlock = (from, tg) => {
    if (!tg) return -1
    for (let k = from; k < blocks.length; k++) { if (blocks[k].text === tg) return k }
    for (let k = from; k < blocks.length; k++) { if (fuzzy(blocks[k].text, tg)) return k }
    return -1
  }
  // hunks arrive sorted by document order; blocks consumed by one hunk are
  // never reused by the next (identical lines in two hunks stay distinct)
  let cursor = 0
  for (const h of hunks) {
    let widgetPos = null
    if (h.kind === 'replace') {
      const targets = (h.oldLines || []).map(stripMdLine).filter((x) => x.length >= 2)
      const i = targets.length ? findBlock(cursor, targets[0]) : -1
      if (i >= 0) {
        const j = Math.max(i, findBlock(i, targets[targets.length - 1]))
        for (let k = i; k <= j; k++) {
          decos.push(Decoration.node(blocks[k].pos, blocks[k].pos + blocks[k].node.nodeSize, { class: 'knote-agent-old' }))
        }
        widgetPos = blocks[j].pos + blocks[j].node.nodeSize
        cursor = j + 1
      } else {
        // the replaced lines are all BLANK (nothing to content-match) — an
        // empty line has no text to locate, so without this it fell to the
        // doc end. Anchor the diff after the preceding non-blank line
        // (agentStore sets anchorText to it), like the insert case.
        const anchor = stripMdLine(h.anchorText)
        if (!anchor) {
          widgetPos = 0
        } else {
          const k = findBlock(cursor, anchor)
          if (k >= 0) { widgetPos = blocks[k].pos + blocks[k].node.nodeSize; cursor = k + 1 }
        }
      }
    } else {
      const anchor = stripMdLine(h.anchorText)
      if (!anchor) {
        widgetPos = 0
      } else {
        const k = findBlock(cursor, anchor)
        if (k >= 0) { widgetPos = blocks[k].pos + blocks[k].node.nodeSize; cursor = k + 1 }
      }
    }
    // fuzzy match failed (e.g. the old lines live inside a code fence):
    // still show the hunk at the end of the doc so it can be reviewed
    if (widgetPos === null) widgetPos = doc.content.size
    decos.push(Decoration.widget(widgetPos, () => buildHunkWidget(h, payload, t), { side: 1, key: `agent-hunk-${h.id}` }))
  }
  return DecorationSet.create(doc, decos)
}

const AgentPreview = Extension.create({
  name: 'knoteAgentPreview',
  addProseMirrorPlugins() {
    const t = this.options.t || ((k) => k)
    return [
      new Plugin({
        key: agentPreviewKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set, _old, newState) {
            const meta = tr.getMeta(agentPreviewKey)
            if (meta === null) return DecorationSet.empty
            if (meta) return buildAgentPreviewDecos(newState.doc, meta, t)
            return set.map(tr.mapping, tr.doc)
          }
        },
        props: {
          decorations(state) { return agentPreviewKey.getState(state) }
        }
      })
    ]
  }
})

// ---- In-document find / replace (Ctrl+F / Ctrl+H) ----
const searchKey = new PluginKey('knoteSearch')

// All match ranges {from,to} for `query` in the doc. Matches are found per
// TEXTBLOCK over its concatenated inline text, with an exact char->docPos map
// so a match that straddles a mark boundary (bold in the middle) still maps
// to correct positions; inline atoms (images) contribute no text and are
// skipped.
const findSearchMatches = (doc, query, opts) => {
  const out = []
  if (!query) return out
  let re
  try {
    let pat = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (opts.wholeWord) pat = `(?<![\\p{L}\\p{N}_])${pat}(?![\\p{L}\\p{N}_])`
    re = new RegExp(pat, opts.caseSensitive ? 'gu' : 'giu')
  } catch { return out }
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const chars = []
    node.forEach((child, offset) => {
      if (child.isText) {
        const base = pos + 1 + offset
        for (let i = 0; i < child.text.length; i++) chars.push(base + i)
      }
    })
    if (!chars.length) return true
    const str = node.textContent
    re.lastIndex = 0
    let m
    while ((m = re.exec(str))) {
      if (m[0].length === 0) { re.lastIndex++; continue }
      const s = m.index
      const e = m.index + m[0].length
      if (chars[s] != null && chars[e - 1] != null) out.push({ from: chars[s], to: chars[e - 1] + 1 })
    }
    return true
  })
  return out
}

const buildSearchDecos = (doc, st) => {
  if (!st || !st.matches.length) return DecorationSet.empty
  const decos = st.matches.map((m, i) =>
    Decoration.inline(m.from, m.to, { class: i === st.activeIndex ? 'knote-search-hit knote-search-hit-active' : 'knote-search-hit' })
  )
  return DecorationSet.create(doc, decos)
}

const SearchHighlight = Extension.create({
  name: 'knoteSearch',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: searchKey,
        state: {
          init: () => ({ query: '', opts: {}, matches: [], activeIndex: -1, deco: DecorationSet.empty }),
          apply(tr, prev, _old, newState) {
            const meta = tr.getMeta(searchKey)
            if (meta) {
              const matches = findSearchMatches(newState.doc, meta.query, meta.opts)
              let activeIndex = matches.length ? Math.min(meta.activeIndex ?? 0, matches.length - 1) : -1
              if (meta.activeIndex === 'keepNear' && prev.matches[prev.activeIndex]) {
                const at = prev.matches[prev.activeIndex].from
                const near = matches.findIndex((m) => m.from >= at)
                activeIndex = near >= 0 ? near : (matches.length ? 0 : -1)
              }
              const stt = { query: meta.query, opts: meta.opts, matches, activeIndex }
              return { ...stt, deco: buildSearchDecos(newState.doc, stt) }
            }
            if (!prev.query) return prev
            if (tr.docChanged) {
              const matches = findSearchMatches(newState.doc, prev.query, prev.opts)
              const activeIndex = matches.length ? Math.min(Math.max(prev.activeIndex, 0), matches.length - 1) : -1
              const stt = { query: prev.query, opts: prev.opts, matches, activeIndex }
              return { ...stt, deco: buildSearchDecos(newState.doc, stt) }
            }
            return prev
          }
        },
        props: { decorations(state) { return searchKey.getState(state).deco } }
      })
    ]
  }
})

// ---- Callout blocks: a blockquote whose first line is `[!type]` renders
// as a colored card (matches the split-preview markdown-it plugin). The
// `[!type]` marker stays in the doc (raw-marker philosophy) but is styled
// as a small badge; the whole blockquote gets a per-type class + icon. ----
const CALLOUT_TYPES = { note: 1, info: 1, tip: 1, success: 1, warning: 1, danger: 1, question: 1, quote: 1 }
const calloutKey = new PluginKey('knoteCallout')
const buildCalloutDecos = (doc) => {
  const decos = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockquote') return
    const firstPara = node.firstChild
    if (!firstPara || !firstPara.isTextblock) return
    const m = /^\[!(\w+)\]/.exec(firstPara.textContent)
    if (!m) return
    const kind = CALLOUT_TYPES[m[1].toLowerCase()] ? m[1].toLowerCase() : 'note'
    decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'knote-callout knote-callout-' + kind }))
    const markerFrom = pos + 2
    decos.push(Decoration.inline(markerFrom, markerFrom + m[0].length, { class: 'knote-cal-marker knote-cal-marker-' + kind }))
    return false
  })
  return DecorationSet.create(doc, decos)
}
const CalloutBlock = Extension.create({
  name: 'knoteCallout',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: calloutKey,
        state: {
          init: (_c, { doc }) => buildCalloutDecos(doc),
          apply(tr, old) { return tr.docChanged ? buildCalloutDecos(tr.doc) : old }
        },
        props: { decorations(state) { return calloutKey.getState(state) } }
      })
    ]
  }
})

// ---- Heading fold: collapse a heading's section (all blocks until the next
// heading of the same-or-higher level). Display-only decorations — the doc
// and its markdown are never touched, so folding is purely visual. A chevron
// appears on hover of a foldable heading; folded headings keep it visible. ----
const foldKey = new PluginKey('knoteFold')
// [start, end) doc range of the blocks hidden under the heading at headingPos
const foldedRange = (doc, headingPos) => {
  const node = doc.nodeAt(headingPos)
  if (!node || node.type.name !== 'heading') return null
  const level = node.attrs.level
  const tops = []
  doc.forEach((n, off) => tops.push({ n, pos: off }))
  const i = tops.findIndex((t) => t.pos === headingPos)
  if (i < 0) return null
  let j = i + 1
  while (j < tops.length && !(tops[j].n.type.name === 'heading' && tops[j].n.attrs.level <= level)) j++
  if (j === i + 1) return null
  return { start: tops[i + 1].pos, end: tops[j - 1].pos + tops[j - 1].n.nodeSize }
}
const makeFoldToggle = (headingPos, isFolded) => (view) => {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'knote-fold-toggle' + (isFolded ? ' is-folded' : '')
  btn.contentEditable = 'false'
  btn.setAttribute('data-fold', '1')
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
  btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation()
    const state = view.state
    const folding = !foldKey.getState(state).folded.has(headingPos)
    let tr = state.tr.setMeta(foldKey, { toggle: headingPos })
    // folding with the caret inside the section would leave it in a hidden
    // block (typing would then edit invisible content) — move it onto the
    // heading first so it stays visible
    if (folding) {
      const r = foldedRange(state.doc, headingPos)
      const sel = state.selection
      if (r && sel.from < r.end && sel.to > r.start) {
        const hn = state.doc.nodeAt(headingPos)
        const headEnd = headingPos + (hn ? hn.nodeSize - 1 : 1)
        tr = tr.setSelection(TextSelection.create(tr.doc, Math.min(headEnd, tr.doc.content.size)))
      }
    }
    view.dispatch(tr)
  })
  return btn
}
const buildFoldDecos = (doc, folded) => {
  const decos = []
  const tops = []
  doc.forEach((node, offset) => tops.push({ node, pos: offset }))
  for (let i = 0; i < tops.length; i++) {
    const { node, pos } = tops[i]
    if (node.type.name !== 'heading') continue
    const level = node.attrs.level
    let j = i + 1
    while (j < tops.length && !(tops[j].node.type.name === 'heading' && tops[j].node.attrs.level <= level)) j++
    if (j === i + 1) continue // nothing under this heading — not foldable
    const isFolded = folded.has(pos)
    decos.push(Decoration.widget(pos + 1, makeFoldToggle(pos, isFolded), { side: -1, key: `fold-${pos}-${isFolded}`, ignoreSelection: true }))
    if (isFolded) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'knote-fold-head' }))
      for (let k = i + 1; k < j; k++) {
        decos.push(Decoration.node(tops[k].pos, tops[k].pos + tops[k].node.nodeSize, { class: 'knote-fold-hidden' }))
      }
    }
  }
  return DecorationSet.create(doc, decos)
}
const HeadingFold = Extension.create({
  name: 'knoteFold',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: foldKey,
        state: {
          init: (_c, { doc }) => ({ folded: new Set(), deco: buildFoldDecos(doc, new Set()) }),
          apply(tr, prev, _old, newState) {
            const meta = tr.getMeta(foldKey)
            if (meta && typeof meta.toggle === 'number') {
              const folded = new Set(prev.folded)
              if (folded.has(meta.toggle)) folded.delete(meta.toggle)
              else folded.add(meta.toggle)
              return { folded, deco: buildFoldDecos(newState.doc, folded) }
            }
            if (meta && meta.unfoldAll) {
              return { folded: new Set(), deco: buildFoldDecos(newState.doc, new Set()) }
            }
            if (meta && Array.isArray(meta.unfold)) {
              const folded = new Set(prev.folded)
              for (const p of meta.unfold) folded.delete(p)
              return { folded, deco: buildFoldDecos(newState.doc, folded) }
            }
            if (tr.docChanged) {
              // remap folded heading positions. Bias +1 so the anchor follows
              // the heading when a block is inserted at its left boundary
              // (Enter-at-heading-start would otherwise strand the fold on the
              // new empty node). Drop any that no longer start a heading.
              const next = new Set()
              for (const p of prev.folded) {
                const mapped = tr.mapping.map(p, 1)
                const node = newState.doc.nodeAt(mapped)
                if (node && node.type.name === 'heading') next.add(mapped)
              }
              return { folded: next, deco: buildFoldDecos(newState.doc, next) }
            }
            return prev
          }
        },
        // auto-unfold any folded section the selection moves INTO (arrow keys,
        // Backspace-merge landing in a hidden block, Ctrl+A before delete) so
        // the caret is never stranded in — and hidden content is never edited
        // or deleted through — a display:none region without the user seeing it
        appendTransaction: (_trs, _oldState, newState) => {
          const st = foldKey.getState(newState)
          if (!st.folded.size) return null
          const { from, to } = newState.selection
          const toUnfold = []
          for (const hp of st.folded) {
            const r = foldedRange(newState.doc, hp)
            if (r && from < r.end && to > r.start) toUnfold.push(hp)
          }
          return toUnfold.length ? newState.tr.setMeta(foldKey, { unfold: toUnfold }) : null
        },
        props: { decorations(state) { return foldKey.getState(state).deco } }
      })
    ]
  }
})

// Tab is unbound in stock TipTap — the browser moves focus OUT of the
// editor, which reads as "Tab 键失灵". Wire the expected behaviors and
// always swallow the key so focus never escapes:
//   list/task item: indent (Shift-Tab outdents)
//   table cell:     defer to the Table extension (next/prev cell)
//   anything else:  insert two spaces (NOT four — four leading spaces would
//                   serialize as an indented code block in markdown)
const TabKey = Extension.create({
  name: 'knoteTab',
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const e = this.editor
        if (e.isActive('table')) return false
        if (e.isActive('taskItem')) return e.chain().focus().sinkListItem('taskItem').run() || true
        if (e.isActive('listItem')) return e.chain().focus().sinkListItem('listItem').run() || true
        // insertContent parses strings as HTML, where whitespace-only input
        // collapses to NOTHING — insert the spaces at transaction level
        return e.chain().focus().command(({ tr }) => { tr.insertText('  '); return true }).run() || true
      },
      'Shift-Tab': () => {
        const e = this.editor
        if (e.isActive('table')) return false
        if (e.isActive('taskItem')) return e.chain().focus().liftListItem('taskItem').run() || true
        if (e.isActive('listItem')) return e.chain().focus().liftListItem('listItem').run() || true
        return true
      }
    }
  }
})

// Green underline on the text row that holds the caret (the "focus line"
// indicator from the previous engine, reborn as a ProseMirror decoration)
const FocusLine = Extension.create({
  name: 'knoteFocusLine',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const { $from } = state.selection
            for (let d = $from.depth; d > 0; d--) {
              const node = $from.node(d)
              if (node.isTextblock) {
                // a code block is one huge text block — an inline decoration
                // would underline every line of it; show no focus line there
                if (node.type.name === 'codeBlock') return null
                const from = $from.before(d)
                if (node.content.size === 0) {
                  // empty row: nothing inline to underline, mark the block
                  return DecorationSet.create(state.doc, [
                    Decoration.node(from, from + node.nodeSize, { class: 'knote-focus-line' })
                  ])
                }
                // inline decoration: a soft-wrapped long row gets the green
                // line under EVERY visual line, not just the block's bottom
                return DecorationSet.create(state.doc, [
                  Decoration.inline(from + 1, from + 1 + node.content.size, { class: 'knote-focus-line-inline' })
                ])
              }
            }
            return null
          }
        }
      })
    ]
  }
})

// Background color as a textStyle attribute (persists as inline HTML spans)
const BackgroundColor = Extension.create({
  name: 'backgroundColor',
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        backgroundColor: {
          default: null,
          parseHTML: (el) => el.style.backgroundColor || null,
          renderHTML: (attrs) => {
            if (!attrs.backgroundColor) return {}
            return { style: `background-color: ${attrs.backgroundColor}` }
          }
        }
      }
    }]
  },
  addCommands() {
    return {
      setBackgroundColor: (color) => ({ chain }) =>
        chain().setMark('textStyle', { backgroundColor: color }).run(),
      unsetBackgroundColor: () => ({ chain }) =>
        chain().setMark('textStyle', { backgroundColor: null }).removeEmptyTextStyle().run()
    }
  }
})

// Image with width (%) and alignment, serialized back to markdown/HTML
const KnoteImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => {
          const w = el.style?.width || el.getAttribute('width') || ''
          return /^\d+%$/.test(w) ? parseInt(w) : (typeof w === 'string' && w.endsWith('%') ? parseInt(w) : null)
        }
      },
      align: {
        default: null,
        parseHTML: (el) => {
          const p = el.parentElement
          const a = (p && p.style && p.style.textAlign) || ''
          return a === 'center' || a === 'right' ? a : null
        }
      }
    }
  },
  renderHTML({ node, HTMLAttributes }) {
    const { width, align } = node.attrs
    let style = ''
    if (width) style += `width:${width}%;`
    if (align === 'center') style += 'display:block;margin-left:auto;margin-right:auto;'
    if (align === 'right') style += 'display:block;margin-left:auto;'
    const attrs = { ...HTMLAttributes }
    delete attrs.width
    delete attrs.align
    if (style) attrs.style = style
    return ['img', attrs]
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const { src, alt, width, align } = node.attrs
          const cleanAlt = (alt || '').replace(/[\[\]]/g, ' ')
          // Alignment: use ::: marker syntax (survives round-trip through
          // tiptap-markdown; raw <p> HTML blocks can fail re-parsing).
          if (align && align !== 'left') {
            state.write(`::: align:${align} ::: `)
          }
          // Width: inline <img> HTML is safe (inline HTML parses fine).
          // No width/align: plain markdown image.
          if (width) {
            state.write(`<img src="${src}" alt="${cleanAlt.replace(/"/g, '&quot;')}" style="width:${width}%;">`)
          } else {
            state.write(`![${cleanAlt}](${src})`)
          }
          state.closeBlock(node)
        },
        parse: {}
      }
    }
  }
})

// ---- Editor ----
let suppressEmit = false
let lastEmitted = null
// debounced markdown mirror (see onUpdate) — emitNow always serializes the
// LIVE editor state, so a late timer can never emit stale content
let emitTimer = null
const emitNow = () => {
  clearTimeout(emitTimer)
  emitTimer = null
  if (suppressEmit || editor.isDestroyed) return
  const md = fromInternal(postprocessMarkdown(editor.storage.markdown.getMarkdown()))
  lastEmitted = md
  emit('update:modelValue', md)
}
const flushEmit = () => { if (emitTimer) emitNow() }

// Undo the serializer's over-eager escaping for syntax we keep as literal
// text (footnote refs/defs, task markers inside plain text)
// Math span shape shared with the parse passthrough and the Mathematics
// regex: $$display$$, or $inline$ that doesn't start/end with whitespace and
// isn't immediately followed by a digit (so "$50-$60" prices stay text)
const MATH_SPAN_RE = /\$\$[^$\n]+\$\$|\$[^\s$](?:[^$\n]*?[^\s$])?\$(?!\d)/g

// Invert the serializer's escaping inside a math span so the document holds
// raw LaTeX: `\\frac` -> `\frac`, and undo tiptap-markdown's HTML entity
// escaping (`<` was written as &lt;). The parse-side passthrough reads the
// span back raw, so the roundtrip is exact.
const unescapeMathSpans = (line) =>
  // `code spans` keep their content verbatim — never rewrite inside them
  line.split(/(`+[^`]*`+)/g).map((seg, i) => {
    if (i % 2 === 1) return seg
    return seg.replace(MATH_SPAN_RE, (span) => span
      .replace(/\\([\\`*~[\]_])/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&'))
  }).join('')

const postprocessMarkdown = (md) => {
  const lines = md
    .replace(/\\\[\^([^\]]+)\\\]/g, '[^$1]')
    .replace(/\\\[( |x|X)\\\]/g, '[$1]')
    .split('\n')
  // fence-aware: code block content is emitted raw by the serializer and
  // must never be touched (a `$…\…$` shell/awk line is code, not math)
  const out = []
  let fence = null
  for (const line of lines) {
    if (fence) {
      out.push(line)
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null
      continue
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      out.push(line)
      fence = { ch: open[1][0], len: open[1].length }
      continue
    }
    out.push(unescapeMathSpans(line))
  }
  // also drop prosemirror's toggled `)` ordered-list delimiters (see
  // normalizeOrderedMarkers) so the saved markdown never contains `2)` `3)`
  return normalizeOrderedMarkers(out.join('\n'))
}

// Empty-row conversion lives in src/lib/emptyRows.js and is shared with the
// split preview and Word export so all views agree on the row convention.

const editor = new Editor({
  content: '',
  editorProps: {
    // no red squiggles under English terms (the split-mode textarea already
    // sets spellcheck="false")
    attributes: { spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' },
    // Foreign HTML (Word, WPS, Google Docs, webmail, web pages) sprinkles empty
    // spacer paragraphs — <p></p>, <p><br></p>, <div>&nbsp;</div> — between real
    // content to fake paragraph spacing. ProseMirror parses each as an empty
    // paragraph, which our row model renders as a VISIBLE blank line, so pasting
    // looks like it "mysteriously adds blank rows". Drop those pure-spacer
    // blocks. Knote's own clipboard carries data-pm-slice metadata. A single
    // copied row is intentionally serialized without its outer paragraph so
    // other apps don't append a blank line; close that now-inline slice before
    // ProseMirror parses it, otherwise marked text (bold/italic/link/etc.) can
    // split the target paragraph and create two empty rows around the paste.
    transformPastedHTML: (html) => {
      if (!html) return html
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html')
        const BLOCK = new Set(['P', 'DIV', 'UL', 'OL', 'LI', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FIGURE', 'DL', 'DD', 'DT'])
        const sliceCarrier = doc.querySelector('[data-pm-slice]')
        if (sliceCarrier) {
          const sliceMatch = /^(\d+)\s+(\d+)/.exec(sliceCarrier.getAttribute('data-pm-slice') || '')
          const hasTopLevelBlock = Array.from(doc.body.children).some((el) => BLOCK.has(el.tagName))
          if (sliceMatch && !hasTopLevelBlock && (Number(sliceMatch[1]) > 0 || Number(sliceMatch[2]) > 0)) {
            sliceCarrier.setAttribute('data-pm-slice', '0 0 []')
          }
          // Internal multi-block copies keep their exact slice metadata and
          // intentional empty rows; no foreign-HTML cleanup applies to them.
          return doc.body.innerHTML
        }
        // (1) Markdown renderers (GitHub, Typora, ChatGPT/Claude output, most
        // md->html) pretty-print with newlines/indentation BETWEEN block tags:
        // `<p>..</p>\n<ul>`, `<p>A</p>\n\n<p>B</p>`. ProseMirror turns that
        // inter-block whitespace text into a blank paragraph = a stray blank
        // row. Drop whitespace-only text nodes that sit next to a block element
        // (real inline spacing, e.g. `<b>a</b> <b>b</b>`, has inline siblings
        // and is preserved). Never touch text inside <pre>/<code>.
        const isBlock = (n) => n && n.nodeType === 1 && BLOCK.has(n.tagName)
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
        const drop = []
        let tn
        while ((tn = walker.nextNode())) {
          if (tn.nodeValue.trim() !== '') continue
          if (tn.parentElement && tn.parentElement.closest('pre, code')) continue
          // only whitespace ADJACENT to a block element is layout; whitespace
          // between inline elements (e.g. `<b>a</b> <b>b</b>`) is a real space
          if (isBlock(tn.previousSibling) || isBlock(tn.nextSibling)) drop.push(tn)
        }
        drop.forEach((n) => n.remove())
        // (2) Empty spacer blocks (<p></p>, <p><br></p>, <div>&nbsp;</div>) that
        // Word/WPS/Google Docs inject between paragraphs — also blank rows.
        doc.querySelectorAll('p, div').forEach((el) => {
          if (el.textContent.trim() !== '') return // has real text — keep
          if (el.querySelector('img, table, hr, pre, svg, video, iframe')) return // embedded media — keep
          // an empty block INSIDE code is a real blank code line (GitHub / VS Code
          // wrap each line in a <div>), not spacing — never drop it
          if (el.closest('pre, code')) return
          el.remove()
        })
        return doc.body.innerHTML
      } catch {
        return html
      }
    },
    // Bitmap paste (screenshots, copied images): ProseMirror has no default
    // file handling, so without this a bitmap-only clipboard pasted NOTHING.
    // Clipboards that also carry text/html (web images) keep the richer
    // default pipeline — the Image extension parses the <img> from the HTML.
    handlePaste: (view, event) => {
      const cd = event.clipboardData
      if (!cd || Array.from(cd.types || []).includes('text/html')) return false
      const item = Array.from(cd.items || []).find((i) => i.type && i.type.startsWith('image/'))
      const file = item && item.getAsFile()
      if (!file) return false
      event.preventDefault()
      const reader = new FileReader()
      reader.onload = (ev) => {
        editor.chain().focus().setImage({
          src: ev.target.result,
          alt: (file.name || 'Pasted Image').replace(/\.\w+$/, '')
        }).run()
      }
      reader.readAsDataURL(file)
      return true
    }
  },
  extensions: [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      dropcursor: { color: '#84cc16', width: 3 },
      bold: false,
      italic: false,
      strike: false,
      code: false,
      listItem: false,
      paragraph: false,
      codeBlock: false
    }),
    KnoteCodeBlock.configure({ lowlight }),
    InlineRender,
    AgentPreview.configure({ t: props.t }),
    // $inline$ and $$display$$ LaTeX rendered via KaTeX decorations; the raw
    // $ text stays in the doc (and the markdown) and shows while editing
    Mathematics.configure({
      // Same validation as the parse passthrough and the preview plugin:
      // inline math must not start/end with whitespace, and a closing $
      // followed by a digit is a price ("$50-$60"), not math
      regex: /\$\$([^$\n]+)\$\$|\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g,
      katexOptions: { throwOnError: false },
      shouldRender: (state, pos, node) => {
        const $pos = state.doc.resolve(pos)
        if ($pos.parent.type.name === 'codeBlock') return false
        // inline `code` spans show their literal text, never rendered math
        return !(node.marks || []).some((m) => m.type.name === 'code')
      }
    }),
    KnoteParagraph,
    KnoteListItem,
    CjkBold,
    CjkItalic,
    CjkStrike,
    CjkCode,
    MarkdownTweaks,
    MdUnderline,
    KnoteLink.configure({ openOnClick: false, autolink: true }),
    CtrlClickLink,
    TextStyle,
    Color,
    BackgroundColor,
    MdHighlight.configure({ multicolor: false }),
    FocusLine,
    SearchHighlight,
    CalloutBlock,
    HeadingFold,
    TabKey,
    JoinAdjacentLists,
    // allowTableNodeSelection: without it prosemirror-tables rewrites a
    // table NodeSelection into a CellSelection, which breaks the gutter
    // drag handle (the drop copied the table and left an emptied husk)
    KnoteTable.configure({ resizable: false, allowTableNodeSelection: true }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    KnoteTaskItem.configure({ nested: true }),
    KnoteImage.configure({ inline: false, allowBase64: true }),
    Placeholder.configure({ placeholder: () => props.placeholder }),
    Markdown.configure({
      html: true,
      breaks: true,
      linkify: true,
      transformPastedText: true,
      // copied text/plain must NOT be the markdown serialization — it emits
      // &nbsp; placeholders and a blank line between every block (the
      // "copying adds empty rows" complaint); see CopyPlainText below
      transformCopiedText: false
    }),
    CopyPlainText
  ],
  onUpdate: () => {
    if (suppressEmit) return
    // Doc changes shift positions — close the menu (its target may have
    // moved); the gutter itself re-anchors to the caret in updateOverlays
    lineMenuOpen.value = false
    refreshHistoryState()
    scheduleOverlayUpdate()
    // The markdown emission is DEBOUNCED: serializing the whole doc plus
    // the reactive cascade it triggers in App (import, outline re-parse,
    // stats, hidden-preview render) scales with document size — paying it
    // on every keystroke is what made large documents feel laggy. The
    // editor view itself updates instantly; the mirror string follows
    // ~180ms after the last keystroke. flushEmit() forces it wherever
    // App needs the current content synchronously.
    clearTimeout(emitTimer)
    emitTimer = setTimeout(emitNow, 180)
  },
  onSelectionUpdate: () => {
    scheduleOverlayUpdate()
  },
  // leaving the editor (clicking a button, switching windows) must not
  // strand the last keystrokes in the debounce window
  onBlur: () => {
    flushEmit()
  }
})
window.addEventListener('beforeunload', flushEmit)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flushEmit()
})

// Empty-row placeholders parse into paragraphs holding a single nbsp text node
// (or a hardBreak, for legacy <br> lines) — strip the placeholder so the row
// is a genuinely empty paragraph again
const normalizeEmptyRows = () => {
  const { state, view } = editor
  const targets = []
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph' || node.childCount !== 1) return
    const child = node.firstChild
    if (!child) return
    const isNbsp = child.isText && child.text === String.fromCharCode(0x00A0)
    const isBreak = child.type.name === 'hardBreak'
    if (isNbsp || isBreak) {
      targets.push({ from: pos + 1, to: pos + 1 + child.nodeSize })
    }
  })
  if (!targets.length) return
  const tr = state.tr
  targets.reverse().forEach(({ from, to }) => {
    tr.delete(from, to)
  })
  tr.setMeta('addToHistory', false)
  view.dispatch(tr)
}

// Fence-aware `N) ` -> `N. ` for ordered-list markers. Applied on BOTH sides:
// on PARSE (here, before the editor sees the markdown) so an existing `2)`
// document loads as one clean list instead of a scrambled run of merged/split
// lists (which spawns phantom blank rows); and on SERIALIZE (postprocess) so
// the editor never writes `)` in the first place.
const normalizeOrderedMarkers = (md) => {
  const lines = (md || '').split('\n')
  let fence = null
  return lines.map((line) => {
    if (fence) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null
      return line
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { ch: open[1][0], len: open[1].length }
      return line
    }
    const ol = /^(\s*)(\d+)\)(\s)/.exec(line)
    return ol ? `${ol[1]}${ol[2]}.${ol[3]}${line.slice(ol[0].length)}` : line
  }).join('\n')
}

// suppressEmit must NEVER leak: an exception mid-parse would otherwise
// swallow every subsequent onUpdate emission — the editor looks alive but
// the document string silently stops updating
const setFromExternal = (md, withHistory = false) => {
  try {
    doSetFromExternal(md, withHistory)
  } finally {
    suppressEmit = false
  }
}
const doSetFromExternal = (md, withHistory) => {
  // the incoming doc supersedes any pending (debounced) emission
  clearTimeout(emitTimer)
  emitTimer = null
  suppressEmit = true
  // Multi-line $$ blocks (standard display-math format, e.g. written in
  // split mode) have no block-math node in the editor — parsed as paragraphs
  // with hard breaks they get mangled on the next serialization. Normalize
  // them to the single-line $$...$$ form (whitespace is insignificant to
  // KaTeX; explicit row breaks stay as \\). Fence-aware.
  const joinDisplayMath = (src) => {
    const lines = src.split('\n')
    const out = []
    let fence = null
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (fence) {
        out.push(line)
        const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
        if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null
        continue
      }
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
        out.push(line)
        fence = { ch: open[1][0], len: open[1].length }
        continue
      }
      if (line.trim() === '$$') {
        const body = []
        let j = i + 1
        while (j < lines.length && lines[j].trim() !== '$$' && !lines[j].includes('$$') && lines[j].trim() !== '') {
          body.push(lines[j].trim())
          j++
        }
        if (j < lines.length && lines[j].trim() === '$$' && body.length) {
          out.push(`$$${body.join(' ')}$$`)
          i = j
          continue
        }
      }
      out.push(line)
    }
    return out.join('\n')
  }
  const prepared = toInternal(joinDisplayMath(normalizeOrderedMarkers(md)))
  // Chained commands share one transaction: by default the meta keeps this
  // external replacement OUT of the undo history (undoing "into" a mode
  // switch or a file load produced bizarre giant undo steps). Agent-applied
  // edits pass withHistory so Ctrl+Z can revert them as ONE step (the other
  // dispatches below all carry addToHistory:false).
  editor.chain()
    // a wholesale doc replacement invalidates any folded-heading positions —
    // clear the fold state in the same transaction so nothing remaps onto
    // the wrong heading (positions can't be meaningfully carried across a
    // full setContent)
    .command(({ tr }) => { if (!withHistory) tr.setMeta('addToHistory', false); tr.setMeta(foldKey, { unfoldAll: true }); return true })
    .setContent(prepared, false)
    .run()
  // Post-process: strip ::: align:xxx ::: markers and apply alignment to the
  // following image node (survives the round-trip from markdown serialization).
  applyAlignMarkers()
  normalizeEmptyRows()
  // setContent leaves the selection at the doc end; a freshly loaded document
  // should start with the caret (and the caret-following gutter) at the top
  const { state, view } = editor
  view.dispatch(state.tr.setSelection(TextSelection.atStart(state.doc)).setMeta('addToHistory', false))
  // The editor now represents `md`; without this, an external change back to
  // a previously-emitted value (e.g. undo in split mode) would be skipped by
  // the watchers' lastEmitted guard and the editor would show stale content
  lastEmitted = md
  suppressEmit = false
  refreshHistoryState()
  // a wholesale external replacement orphans any agent-diff decorations;
  // clear them — the App repaints surviving hunks on nextTick
  view.dispatch(editor.state.tr.setMeta(agentPreviewKey, null).setMeta('addToHistory', false))
}

// After setContent, scan for ::: align:xxx ::: markers preceding image nodes
// and apply the alignment to the image, removing the marker text. This keeps
// the Tiptap editor's view clean while preserving alignment in the markdown.
const ALIGN_MARKER_RE = /^:::\s*align:(center|right)\s*:::\s*/
const applyAlignMarkers = () => {
  const { state, view } = editor
  const tr = state.tr
  let changed = false
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return
    const text = node.textContent
    const m = text.match(ALIGN_MARKER_RE)
    if (!m) return
    const markerLen = m[0].length
    // Check if this paragraph has only the marker text + an image
    if (node.childCount < 1) return
    // Find the marker text node and the image node
    let markerPos = -1
    let imagePos = -1
    node.forEach((child, offset) => {
      if (child.type.name === 'text' && child.text && child.text.match(ALIGN_MARKER_RE)) {
        markerPos = pos + 1 + offset
      } else if (child.type.name === 'image' && markerPos >= 0) {
        imagePos = pos + 1 + offset
      }
    })
    if (markerPos < 0 || imagePos < 0) return
    // Apply alignment to the image node, then delete the marker text.
    // Positions come from the ORIGINAL doc — map them through the steps
    // already in tr, or the second marker's positions (shifted by the first
    // marker's deletion) would target the wrong node / throw a RangeError.
    tr.setNodeAttribute(tr.mapping.map(imagePos), 'align', m[1])
    const from = tr.mapping.map(markerPos)
    tr.delete(from, from + markerLen)
    changed = true
  })
  if (changed) view.dispatch(tr.setMeta('addToHistory', false))
}

// Clicking the blank area BELOW the document (the deep bottom padding)
// appends an empty row and puts the caret there, ready to type. CAUTION: a
// `click` also fires when a text-selection DRAG ends over the padding (the
// browser targets the common ancestor = this container), which silently
// spawned phantom empty rows. Only a true click counts: pressed AND released
// in the padding zone, with (almost) no mouse travel.
const inBottomZone = (e, container) => {
  const pmEl = editor.view.dom
  if (e.target !== container && e.target !== pmEl) return false
  const last = pmEl.lastElementChild
  return !(last && e.clientY <= last.getBoundingClientRect().bottom)
}

let bottomAreaPress = null
const handleBottomAreaMouseDown = (e) => {
  bottomAreaPress = (e.button === 0 && inBottomZone(e, e.currentTarget))
    ? { x: e.clientX, y: e.clientY }
    : null
}

const handleBottomAreaClick = (e) => {
  const press = bottomAreaPress
  bottomAreaPress = null
  if (!press) return // press began on content (drag-select) — not a padding click
  if (Math.abs(e.clientX - press.x) > 4 || Math.abs(e.clientY - press.y) > 4) return
  if (!inBottomZone(e, e.currentTarget)) return
  const doc = editor.state.doc
  const lastNode = doc.lastChild
  if (lastNode && lastNode.type.name === 'paragraph' && lastNode.content.size === 0) {
    editor.chain().focus('end').run()
  } else {
    editor.chain().insertContentAt(doc.content.size, { type: 'paragraph' }).focus('end').run()
  }
}

// Dismiss the line menu on Escape or any press outside the gutter (the plus
// button itself toggles via its own click handler)
const onWindowKeydown = (e) => {
  if (e.key === 'Escape' && lineMenuOpen.value) lineMenuOpen.value = false
}
const onWindowMousedown = (e) => {
  if (!lineMenuOpen.value) return
  if (e.target.closest && e.target.closest('.knote-gutter')) return
  lineMenuOpen.value = false
}

onMounted(() => {
  setFromExternal(props.modelValue)
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('mousedown', onWindowMousedown)
  window.addEventListener('mousemove', onCropPointerMove)
  window.addEventListener('mouseup', onCropPointerUp)
  scheduleOverlayUpdate() // show the gutter on the initial caret block
})

watch(() => props.modelValue, (v) => {
  if (!props.active) return // deferred: synced by the active watcher below
  if (v === lastEmitted) return
  setFromExternal(v)
  hideAllOverlays()
  scheduleOverlayUpdate() // re-anchor the gutter to the fresh doc's caret
})

watch(() => props.active, (on) => {
  if (!on) return
  if (props.modelValue !== lastEmitted) {
    setFromExternal(props.modelValue)
    hideAllOverlays()
  }
  scheduleOverlayUpdate() // becoming visible: rects were 0 while hidden
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('mousedown', onWindowMousedown)
  window.removeEventListener('mousemove', onCropPointerMove)
  window.removeEventListener('mouseup', onCropPointerUp)
  editor.destroy()
})

// ---- Overlays: bubble toolbar / image toolbar / table toolbar / gutter ----
const bubbleVisible = ref(false)
const bubbleTop = ref(0)
const bubbleLeft = ref(0)
const imageSelected = ref(false)
const imageWidth = ref(100)
const imageAlign = ref('left')
const tableVisible = ref(false)
const tableTop = ref(0)
const tableLeft = ref(0)
const gutterVisible = ref(false)
const gutterTop = ref(0)
const gutterLeft = ref(0)
const lineMenuOpen = ref(false)
let gutterBlockPos = -1
let tableAnchorPos = -1
let tableHoverEl = null

const hideAllOverlays = () => {
  bubbleVisible.value = false
  imageSelected.value = false
  tableVisible.value = false
  gutterVisible.value = false
  lineMenuOpen.value = false
}

const relCoords = (coords) => {
  const rect = rootRef.value.getBoundingClientRect()
  return { top: coords.top - rect.top, left: coords.left - rect.left }
}

// rAF never fires while the window is hidden/occluded (background tab,
// minimized preview) — a queued frame would jam the "scheduled" guard
// forever. Fall back to a timer there; overlays keep tracking the caret.
const nextFrame = (cb) => {
  if (document.hidden) setTimeout(cb, 32)
  else requestAnimationFrame(cb)
}

let overlayScheduled = false
const scheduleOverlayUpdate = () => {
  if (overlayScheduled) return
  overlayScheduled = true
  nextFrame(() => {
    overlayScheduled = false
    updateOverlays()
  })
}

// Gutter (plus + drag handle) follows the block that holds the caret — the
// same row the green focus line marks — not the mouse-hovered block
// Block types whose rows don't use the plus menu (converting a table or
// code block to a heading/list makes no sense) — hide the gutter there
const GUTTERLESS_BLOCKS = new Set(['table', 'codeBlock', 'heading', 'horizontalRule', 'image'])

// The plus menu only makes sense on an EMPTY row ("insert something here");
// non-empty rows show just the drag handle
const gutterIsEmptyRow = ref(false)

let lastCaretBlockPos = -1
const updateGutter = () => {
  const { state, view } = editor
  const $from = state.selection.$from
  const blockPos = $from.depth > 0 ? $from.before(1) : $from.pos
  if (blockPos !== lastCaretBlockPos) {
    lastCaretBlockPos = blockPos
    // the focus row changed — App uses this as an auto-save commit point,
    // so the debounced markdown mirror must be current first
    flushEmit()
    emit('rowchange')
  }
  const blockNode = state.doc.nodeAt(blockPos)
  if (!blockNode || GUTTERLESS_BLOCKS.has(blockNode.type.name)) {
    gutterVisible.value = false
    lineMenuOpen.value = false
    return
  }
  let dom = null
  try { dom = view.nodeDOM(blockPos) } catch { dom = null }
  if (!dom || !dom.getBoundingClientRect) {
    gutterVisible.value = false
    lineMenuOpen.value = false
    return
  }
  const emptyRow = blockNode.type.name === 'paragraph' && blockNode.content.size === 0
  if (gutterIsEmptyRow.value !== emptyRow) {
    gutterIsEmptyRow.value = emptyRow
    if (!emptyRow) lineMenuOpen.value = false // plus button gone -> close its menu
  }
  const r = dom.getBoundingClientRect()
  const rel = relCoords(r)
  gutterBlockPos = blockPos
  gutterTop.value = rel.top + Math.min(r.height / 2, 16) - 14
  // center the buttons in the pl-12 rail; clamp so they never escape the card
  gutterLeft.value = Math.max(2, rel.left - 38)
  gutterVisible.value = true
}

const updateOverlays = () => {
  if (!rootRef.value || editor.isDestroyed) return
  const { state, view } = editor
  const sel = state.selection
  updateGutter()

  // Image node selection -> image toolbar. Horizontally centered on the
  // editor (not the image): a small right-aligned image would push the
  // toolbar off the page
  if (sel instanceof NodeSelection && sel.node.type.name === 'image') {
    imageSelected.value = true
    bubbleVisible.value = false
    imageWidth.value = sel.node.attrs.width || 100
    imageAlign.value = sel.node.attrs.align || 'left'
    const dom = view.nodeDOM(sel.from)
    if (dom && dom.getBoundingClientRect) {
      const r = dom.getBoundingClientRect()
      const rel = relCoords(r)
      const pmRect = view.dom.getBoundingClientRect()
      bubbleTop.value = Math.max(rel.top - 14, 56)
      bubbleLeft.value = relCoords(pmRect).left + pmRect.width / 2
    }
    return
  }
  imageSelected.value = false

  // Text selection -> formatting bubble. Code blocks don't allow any inline
  // formatting, so the bubble would be a row of dead buttons — hide it there
  if (!sel.empty && !(sel instanceof NodeSelection) && !editor.isActive('codeBlock')) {
    const coords = view.coordsAtPos(sel.from)
    const rel = relCoords(coords)
    bubbleTop.value = Math.max(rel.top - 14, 56)
    bubbleLeft.value = rel.left + 10
    bubbleVisible.value = true
  } else {
    bubbleVisible.value = false
  }
}

// Mousemove only drives the table toolbar now — the gutter follows the caret
// block via updateGutter()
const handleRootMouseMove = (e) => {
  if (editor.isDestroyed) return
  const target = e.target
  if (target.closest && (target.closest('.knote-bubble') || target.closest('.knote-gutter'))) return

  // Table hover -> table toolbar. Center on the scroll wrapper (the visible
  // clipped box), not the table itself — wide tables lay out beyond the pane
  // and centering on the full width would put the toolbar off-screen
  const tableEl = target.closest ? target.closest('.knote-rich table') : null
  if (tableEl) {
    const box = tableEl.closest('.tableWrapper') || tableEl
    const r = box.getBoundingClientRect()
    const rel = relCoords(r)
    tableTop.value = Math.max(rel.top - 12, 56)
    tableLeft.value = rel.left + r.width / 2
    tableVisible.value = true
    tableHoverEl = tableEl
    try {
      tableAnchorPos = editor.view.posAtDOM(tableEl, 0)
    } catch { tableAnchorPos = -1 }
  } else if (tableVisible.value && !target.closest?.('.knote-table-toolbar')) {
    // Keep-zone measures the table the toolbar is anchored to, not the
    // document's first table — otherwise the toolbar is unreachable for
    // every table after the first
    const zone = tableHoverEl && tableHoverEl.isConnected ? tableHoverEl : null
    let keep = false
    if (zone) {
      const r = zone.getBoundingClientRect()
      keep = e.clientX >= r.left - 12 && e.clientX <= r.right + 12 && e.clientY >= r.top - 72 && e.clientY <= r.bottom + 12
    }
    if (!keep) tableVisible.value = false
  }
}

const handleRootMouseLeave = () => {
  tableVisible.value = false
}

// The gutter is positioned in root coordinates; scrolling moves the content
// under it, so re-anchor it to the caret block (and drop hover overlays)
const handleContentScroll = () => {
  lineMenuOpen.value = false
  tableVisible.value = false
  scheduleOverlayUpdate()
}

// ---- Formatting actions ----
const run = (fn) => { fn(editor.chain().focus()).run() }

// Safe color/bg reset. TipTap's removeEmptyTextStyle walks every node that
// INTERSECTS the selection — inside a table that includes the table/row/cell
// container nodes, and removeMark over their full ranges strips textStyle
// from the WHOLE table (other cells lose their colors). Touch only the text
// nodes inside the selection instead.
const unsetStyleAttr = (attr) => {
  const { state, view } = editor
  const { from, to } = state.selection
  if (from === to) return
  const type = state.schema.marks.textStyle
  const tr = state.tr
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true
    const mark = node.marks.find((m) => m.type === type)
    if (!mark || !mark.attrs[attr]) return
    const attrs = { ...mark.attrs, [attr]: null }
    const f = Math.max(pos, from)
    const t = Math.min(pos + node.nodeSize, to)
    tr.removeMark(f, t, type)
    if (Object.values(attrs).some((v) => !!v)) tr.addMark(f, t, type.create(attrs))
  })
  view.dispatch(tr)
  editor.commands.focus()
}

const textColorPalette = ['#e53935', '#f57c00', '#c99400', '#43a047', '#1e88e5', '#8e24aa', '#757575']
const bgColorPalette = ['#fde0dd', '#ffe9c7', '#fff8b8', '#dcf5d9', '#dbe7ff', '#eedbff', '#ececec']

// ---- Line menu (plus button) ----
const insertAtGutter = (fn) => {
  lineMenuOpen.value = false
  if (gutterBlockPos < 0) return
  const node = editor.state.doc.nodeAt(gutterBlockPos)
  const end = gutterBlockPos + (node ? node.nodeSize : 0)
  const chain = editor.chain().focus().setTextSelection(Math.min(end, editor.state.doc.content.size))
  fn(chain).run()
}

const gutterHeading = (level) => {
  if (gutterBlockPos < 0) return
  lineMenuOpen.value = false
  editor.chain().focus().setTextSelection(gutterBlockPos + 1).toggleHeading({ level }).run()
}

const gutterCommand = (name) => {
  if (gutterBlockPos < 0) return
  lineMenuOpen.value = false
  const c = editor.chain().focus().setTextSelection(gutterBlockPos + 1)
  if (name === 'ul') c.toggleBulletList().run()
  else if (name === 'ol') c.toggleOrderedList().run()
  else if (name === 'task') c.toggleTaskList().run()
  else if (name === 'quote') c.toggleBlockquote().run()
  else if (name === 'codeblock') c.toggleCodeBlock().run()
  else if (name === 'p') c.setParagraph().run()
}

// Table size picker: an 8x6 grid of squares; hovering cell (r, c) previews
// an r-rows x c-cols table, clicking inserts it (first row is the header)
const GRID_MAX_ROWS = 6
const GRID_MAX_COLS = 8
const tableGridOpen = ref(false)
const gridRows = ref(0)
const gridCols = ref(0)
const gridHover = (idx) => {
  gridRows.value = Math.floor((idx - 1) / GRID_MAX_COLS) + 1
  gridCols.value = ((idx - 1) % GRID_MAX_COLS) + 1
}
const gridCellActive = (idx) => {
  const r = Math.floor((idx - 1) / GRID_MAX_COLS) + 1
  const c = ((idx - 1) % GRID_MAX_COLS) + 1
  return r <= gridRows.value && c <= gridCols.value
}
const insertTableGrid = () => {
  const rows = gridRows.value
  const cols = gridCols.value
  if (!rows || !cols) return
  insertAtGutter((c) => c.insertTable({ rows, cols, withHeaderRow: true }))
}
watch(lineMenuOpen, (open) => {
  if (!open) {
    tableGridOpen.value = false
    gridRows.value = 0
    gridCols.value = 0
  }
})

const insertHr = () => insertAtGutter((c) => c.setHorizontalRule())

// Formula: a $$…$$ display formula on its own row (plus menu), or wrap the
// selected text as $inline$ math (bubble button)
const insertFormula = () => insertAtGutter((c) => c.insertContent('$$E = mc^2$$'))
const wrapSelectionFormula = () => {
  const { from, to } = editor.state.selection
  const text = editor.state.doc.textBetween(from, to, ' ')
  editor.chain().focus().insertContentAt({ from, to }, `$${text || 'E = mc^2'}$`).run()
}

const pickImage = (cb) => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.style.display = 'none'
  input.onchange = (e) => {
    const file = e.target.files?.[0]
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (ev) => cb(ev.target.result, file.name)
      reader.readAsDataURL(file)
    }
    input.remove()
  }
  document.body.appendChild(input)
  input.click()
}

const insertImageLocal = () => {
  lineMenuOpen.value = false
  pickImage((src, name) => {
    insertAtGutter((c) => c.setImage({ src, alt: name }))
  })
}

const insertImageUrl = async () => {
  lineMenuOpen.value = false
  const ask = props.promptText || (async (title, dv) => window.prompt(title, dv))
  const url = await ask(props.t('insert_image_url_prompt'), 'https://')
  if (url && url.trim() && url.trim() !== 'https://') {
    insertAtGutter((c) => c.setImage({ src: url.trim(), alt: 'Image' }))
  }
}

// ---- Drag to reorder ----
const handleDragStart = (e) => {
  if (gutterBlockPos < 0) { e.preventDefault(); return }
  const { state, view } = editor
  try {
    const sel = NodeSelection.create(state.doc, gutterBlockPos)
    view.dispatch(state.tr.setSelection(sel))
    const dom = view.nodeDOM(gutterBlockPos)
    if (dom) e.dataTransfer.setDragImage(dom, 0, 12)
    e.dataTransfer.effectAllowed = 'copyMove'
    view.dragging = { slice: sel.content(), move: true }
  } catch {
    e.preventDefault()
  }
}

// ---- Image toolbar actions ----
const updateImage = (attrs) => {
  editor.chain().focus().updateAttributes('image', attrs).run()
}

// ---- Image crop (modal with a draggable/resizable selection) ----
const cropState = ref(null) // { src } while the modal is open
const cropSel = ref({ x: 0, y: 0, w: 0, h: 0 }) // display-pixel coords
const cropImgRef = ref(null)
let cropDrag = null

const startCrop = () => {
  const sel = editor.state.selection
  if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'image') return
  cropState.value = { src: sel.node.attrs.src }
}
const onCropImgLoad = () => {
  const img = cropImgRef.value
  if (img) cropSel.value = { x: 0, y: 0, w: img.clientWidth, h: img.clientHeight }
}
// 8 resize handles: 4 corners + 4 edge midpoints. `dir` encodes which
// edges the handle moves (n/s/e/w combinations).
const CROP_HANDLES = [
  { dir: 'nw', style: 'left:-7px;top:-7px;cursor:nwse-resize' },
  { dir: 'n', style: 'left:calc(50% - 7px);top:-7px;cursor:ns-resize' },
  { dir: 'ne', style: 'right:-7px;top:-7px;cursor:nesw-resize' },
  { dir: 'e', style: 'right:-7px;top:calc(50% - 7px);cursor:ew-resize' },
  { dir: 'se', style: 'right:-7px;bottom:-7px;cursor:nwse-resize' },
  { dir: 's', style: 'left:calc(50% - 7px);bottom:-7px;cursor:ns-resize' },
  { dir: 'sw', style: 'left:-7px;bottom:-7px;cursor:nesw-resize' },
  { dir: 'w', style: 'left:-7px;top:calc(50% - 7px);cursor:ew-resize' }
]
const CROP_MIN = 16

const cropPointerDown = (e, mode) => {
  cropDrag = { mode, startX: e.clientX, startY: e.clientY, orig: { ...cropSel.value } }
  e.preventDefault()
}
const onCropPointerMove = (e) => {
  if (!cropDrag || !cropImgRef.value) return
  const img = cropImgRef.value
  const maxW = img.clientWidth
  const maxH = img.clientHeight
  const dx = e.clientX - cropDrag.startX
  const dy = e.clientY - cropDrag.startY
  const o = cropDrag.orig
  if (cropDrag.mode === 'move') {
    cropSel.value = {
      ...cropSel.value,
      x: Math.min(Math.max(0, o.x + dx), Math.max(0, maxW - cropSel.value.w)),
      y: Math.min(Math.max(0, o.y + dy), Math.max(0, maxH - cropSel.value.h))
    }
    return
  }
  const dir = cropDrag.mode
  let { x, y, w, h } = o
  if (dir.includes('e')) w = o.w + dx
  if (dir.includes('s')) h = o.h + dy
  if (dir.includes('w')) { x = o.x + dx; w = o.w - dx }
  if (dir.includes('n')) { y = o.y + dy; h = o.h - dy }
  // clamp each moving edge: keep the OPPOSITE edge anchored, respect the
  // image bounds and the minimum selection size
  if (dir.includes('w')) {
    const right = o.x + o.w
    x = Math.max(0, Math.min(x, right - CROP_MIN))
    w = right - x
  } else if (dir.includes('e')) {
    w = Math.min(Math.max(CROP_MIN, w), maxW - x)
  }
  if (dir.includes('n')) {
    const bottom = o.y + o.h
    y = Math.max(0, Math.min(y, bottom - CROP_MIN))
    h = bottom - y
  } else if (dir.includes('s')) {
    h = Math.min(Math.max(CROP_MIN, h), maxH - y)
  }
  cropSel.value = { x, y, w, h }
}
const onCropPointerUp = () => { cropDrag = null }

const applyCrop = () => {
  const img = cropImgRef.value
  if (!img || !img.naturalWidth) return
  try {
    const scaleX = img.naturalWidth / img.clientWidth
    const scaleY = img.naturalHeight / img.clientHeight
    const { x, y, w, h } = cropSel.value
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scaleX))
    canvas.height = Math.max(1, Math.round(h * scaleY))
    canvas.getContext('2d').drawImage(img, x * scaleX, y * scaleY, w * scaleX, h * scaleY, 0, 0, canvas.width, canvas.height)
    const src = canvas.toDataURL('image/png')
    cropState.value = null
    updateImage({ src })
  } catch (err) {
    // cross-origin images taint the canvas and cannot be exported
    cropState.value = null
    window.alert(props.t('crop_failed'))
  }
}
const deleteImage = () => {
  editor.chain().focus().deleteSelection().run()
  imageSelected.value = false
}
const replaceImage = () => {
  pickImage((src, name) => updateImage({ src, alt: name }))
}

// ---- Table toolbar actions ----
const tableCmd = (name) => {
  let chain = editor.chain().focus()
  if (tableAnchorPos >= 0 && !editor.isActive('table')) {
    chain = chain.setTextSelection(tableAnchorPos + 2)
  }
  if (name === 'rowAbove') chain.addRowBefore().run()
  else if (name === 'rowBelow') chain.addRowAfter().run()
  else if (name === 'colLeft') chain.addColumnBefore().run()
  else if (name === 'colRight') chain.addColumnAfter().run()
  else if (name === 'delRow') chain.deleteRow().run()
  else if (name === 'delCol') chain.deleteColumn().run()
  else if (name === 'delTable') { chain.deleteTable().run(); tableVisible.value = false }
}

// ---- Exposed API (navbar undo/redo, outline scroll) ----
// Reactive history availability: the navbar buttons' disabled state can't
// call editor.can() directly (PM state changes don't trigger Vue re-renders)
const canUndoR = ref(false)
const canRedoR = ref(false)
const refreshHistoryState = () => {
  canUndoR.value = editor.can().undo()
  canRedoR.value = editor.can().redo()
}
const undo = () => { editor.chain().focus().undo().run(); refreshHistoryState() }
const redo = () => { editor.chain().focus().redo().run(); refreshHistoryState() }
const canUndo = () => editor.can().undo()
const canRedo = () => editor.can().redo()
// Unfold any folded section that HIDES the given doc position (a folded
// parent heading, or the heading at that position) so navigating to it makes
// it visible. Returns true if anything was unfolded.
const unfoldContaining = (pos) => {
  const st = foldKey.getState(editor.state)
  if (!st || !st.folded.size) return false
  const toUnfold = []
  for (const hp of st.folded) {
    if (hp === pos) { toUnfold.push(hp); continue }
    const r = foldedRange(editor.state.doc, hp)
    if (r && pos >= r.start && pos < r.end) toUnfold.push(hp)
  }
  if (!toUnfold.length) return false
  editor.view.dispatch(editor.state.tr.setMeta(foldKey, { unfold: toUnfold }).setMeta('addToHistory', false))
  return true
}
const scrollToHeading = (index) => {
  const nodes = rootRef.value?.querySelectorAll('.knote-rich h1, .knote-rich h2, .knote-rich h3, .knote-rich h4, .knote-rich h5, .knote-rich h6')
  const el = nodes && nodes[index]
  if (!el) return
  // a sub-heading hidden inside a folded parent must be revealed first
  let unfolded = false
  try { unfolded = unfoldContaining(editor.view.posAtDOM(el, 0)) } catch { /* ignore */ }
  const doScroll = () => el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  if (unfolded) nextFrame(doScroll) // wait for the unfold to render
  else doScroll()
}
const focusEditor = () => editor.commands.focus()

// ---- Context menu (right-click) ----
// Three editor contexts: an image node, a text selection, or the caret row.
// Items are emitted to the App, which renders the shared menu.
const readClipboardText = async () => {
  try {
    if (window.knoteDesktop && window.knoteDesktop.readClipboard) return await window.knoteDesktop.readClipboard()
    return await navigator.clipboard.readText()
  } catch { return '' }
}

// Clipboard bitmap as a data URL — desktop IPC first (the sandboxed
// renderer's async clipboard API can't always see native bitmaps), then
// the browser async clipboard as fallback
const readClipboardImage = async () => {
  try {
    if (window.knoteDesktop && window.knoteDesktop.readClipboardImage) {
      const dataUrl = await window.knoteDesktop.readClipboardImage()
      if (dataUrl) return dataUrl
    }
  } catch { /* fall through */ }
  try {
    if (!navigator.clipboard || !navigator.clipboard.read) return null
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((tp) => tp.startsWith('image/'))
      if (!type) continue
      const blob = await item.getType(type)
      return await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = (ev) => resolve(ev.target.result)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })
    }
  } catch { /* no image / permission denied */ }
  return null
}

const readClipboardHtml = async () => {
  try {
    if (window.knoteDesktop && window.knoteDesktop.readClipboardHtml) {
      return (await window.knoteDesktop.readClipboardHtml()) || ''
    }
  } catch { /* fall through */ }
  try {
    if (!navigator.clipboard || !navigator.clipboard.read) return ''
    for (const item of await navigator.clipboard.read()) {
      if (!item.types.includes('text/html')) continue
      return await (await item.getType('text/html')).text()
    }
  } catch { /* no html / permission denied */ }
  return ''
}

const ctxPaste = async () => {
  // text/html wins when present (formatting, tables — same result as
  // Ctrl+V); bare text next; bitmap-only clipboards insert the image
  const [text, html] = await Promise.all([readClipboardText(), readClipboardHtml()])
  if (text || html) {
    editor.commands.focus()
    // go through PM's real paste pipeline (markdown transform, block splitting)
    const dt = new DataTransfer()
    if (html) dt.setData('text/html', html)
    if (text) dt.setData('text/plain', text)
    editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    return
  }
  const img = await readClipboardImage()
  if (img) editor.chain().focus().setImage({ src: img, alt: 'Pasted Image' }).run()
}

// "Paste as plain text": insert the clipboard's text LITERALLY — no rich
// formatting from text/html, and NO markdown auto-conversion (so `**x**`,
// `# h`, links etc. paste as their raw characters). Multi-line text becomes
// separate paragraphs.
const ctxPastePlain = async () => {
  const text = await readClipboardText()
  if (!text) return
  editor.commands.focus()
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length === 1) {
    // single line: inline literal text (text node, never parsed as HTML/md)
    if (lines[0]) editor.chain().focus().insertContent({ type: 'text', text: lines[0] }).run()
    return
  }
  const nodes = lines.map((line) => ({
    type: 'paragraph',
    content: line ? [{ type: 'text', text: line }] : []
  }))
  editor.chain().focus().insertContent(nodes).run()
}

const ctxClipboard = (cmd) => {
  editor.commands.focus()
  document.execCommand(cmd) // runs OUR clipboardSerializer flavors
}

const caretBlock = () => {
  const { $from } = editor.state.selection
  if ($from.depth < 1) return null
  const pos = $from.before(1)
  const node = editor.state.doc.nodeAt(pos)
  return node ? { pos, node } : null
}

const ctxInsertRow = (below) => {
  const blk = caretBlock()
  if (!blk) return
  const at = below ? blk.pos + blk.node.nodeSize : blk.pos
  editor.chain().insertContentAt(at, { type: 'paragraph' }).setTextSelection(at + 1).focus().run()
}

const ctxCopyRow = async () => {
  const blk = caretBlock()
  if (!blk) return
  const text = editor.state.doc.textBetween(blk.pos, blk.pos + blk.node.nodeSize, '\n')
  try { await navigator.clipboard.writeText(text) } catch { /* denied — ignore */ }
}

const ctxDeleteRow = () => {
  const blk = caretBlock()
  if (!blk) return
  const { state, view } = editor
  view.dispatch(state.tr.delete(blk.pos, blk.pos + blk.node.nodeSize).scrollIntoView())
  editor.commands.focus()
}

const selectImageEl = (imgEl) => {
  let pos = editor.view.posAtDOM(imgEl, 0)
  editor.commands.setNodeSelection(pos)
  let sel = editor.state.selection
  if (!(sel.node && sel.node.type.name === 'image')) {
    pos = Math.max(0, pos - 1)
    editor.commands.setNodeSelection(pos)
    sel = editor.state.selection
  }
  return sel.node && sel.node.type.name === 'image' ? sel.node : null
}

const dataUrlToPngBlob = (src) => new Promise((resolve, reject) => {
  const img = new Image()
  img.onload = () => {
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    c.getContext('2d').drawImage(img, 0, 0)
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  }
  img.onerror = reject
  img.src = src
})

const ctxCopyImage = async (src) => {
  try {
    if (window.knoteDesktop && window.knoteDesktop.writeClipboardImage) {
      await window.knoteDesktop.writeClipboardImage(src)
      return
    }
    const blob = await dataUrlToPngBlob(src)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  } catch { window.alert(props.t('crop_failed')) }
}

const ctxSaveImage = (src, alt) => {
  const a = document.createElement('a')
  a.href = src
  a.download = `${(alt || 'image').replace(/[\\/:*?"<>|]/g, '_')}.png`
  a.click()
}

const onEditorContextMenu = (e) => {
  e.preventDefault()
  const t = props.t
  const items = []
  const imgEl = e.target && e.target.closest && e.target.closest('.ProseMirror img')
  if (imgEl) {
    const node = selectImageEl(imgEl)
    if (node) {
      const src = node.attrs.src
      items.push(
        { label: t('ctx_view_image'), action: () => emit('viewimage', { src, alt: node.attrs.alt || '' }) },
        { label: t('ctx_crop'), action: () => startCrop() },
        { label: t('ctx_copy_image'), action: () => ctxCopyImage(src) },
        { label: t('ctx_save_image'), action: () => ctxSaveImage(src, node.attrs.alt) },
        { divider: true },
        { label: t('ctx_delete_image'), danger: true, action: () => editor.chain().focus().deleteSelection().run() }
      )
    }
  } else {
    const sel = editor.state.selection
    const hasText = !sel.empty && editor.state.doc.textBetween(sel.from, sel.to, ' ').trim()
    if (hasText) {
      items.push(
        { label: t('ctx_cut'), action: () => ctxClipboard('cut') },
        { label: t('ctx_copy'), action: () => ctxClipboard('copy') },
        { label: t('ctx_paste'), action: () => ctxPaste() },
        { label: t('ctx_paste_plain'), action: () => ctxPastePlain() },
        { divider: true },
        { label: t('ai_ask'), action: () => askAgent('ask') },
        { label: t('ai_polish'), action: () => askAgent('polish') },
        { label: t('ai_translate'), action: () => askAgent('translate') },
        { label: t('ai_expand'), action: () => askAgent('expand') },
        { label: t('ai_condense'), action: () => askAgent('condense') },
        { divider: true },
        { label: t('ctx_clear_format'), action: () => editor.chain().focus().unsetAllMarks().run() }
      )
    } else {
      // move the caret to the clicked row so the row ops hit the right block
      const hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (hit) editor.commands.setTextSelection(hit.pos)
      const blk = caretBlock()
      const inCode = blk && blk.node.type.name === 'codeBlock'
      items.push(
        { label: t('ctx_paste'), action: () => ctxPaste() },
        { label: t('ctx_paste_plain'), action: () => ctxPastePlain() },
        { divider: true },
        { label: t('ctx_insert_above'), action: () => ctxInsertRow(false) },
        { label: t('ctx_insert_below'), action: () => ctxInsertRow(true) },
        { label: t('ctx_copy_row'), action: () => ctxCopyRow() },
        { label: t('ctx_delete_row'), danger: true, action: () => ctxDeleteRow() }
      )
      if (blk && !inCode && blk.node.type.name !== 'table') {
        items.push(
          { divider: true },
          { label: t('ctx_to_h1'), action: () => editor.chain().focus().setHeading({ level: 1 }).run() },
          { label: t('ctx_to_h2'), action: () => editor.chain().focus().setHeading({ level: 2 }).run() },
          { label: t('ctx_to_h3'), action: () => editor.chain().focus().setHeading({ level: 3 }).run() },
          { label: t('ctx_to_text'), action: () => editor.chain().focus().setParagraph().run() },
          { label: t('ctx_to_ul'), action: () => editor.chain().focus().toggleBulletList().run() },
          { label: t('ctx_to_ol'), action: () => editor.chain().focus().toggleOrderedList().run() },
          { label: t('ctx_to_quote'), action: () => editor.chain().focus().toggleBlockquote().run() }
        )
      }
    }
  }
  if (items.length) emit('ctxmenu', { x: e.clientX, y: e.clientY, items })
}

// AI actions on the current selection (bubble second row) — the App routes
// them into the agent chat with the selected text as context
const askAgent = (action) => {
  const { from, to } = editor.state.selection
  const text = editor.state.doc.textBetween(from, to, '\n')
  if (!text.trim()) return
  bubbleVisible.value = false
  emit('askagent', { action, text })
}

// In-document agent diff (red tint on old blocks + green proposal boxes).
// Auto-scroll only when a NEW hunk was staged (payload.scrollTo carries its
// id) — repaints after an accept or reject must not yank the viewport around.
const setAgentPreview = (payload) => {
  const { state, view } = editor
  view.dispatch(state.tr.setMeta(agentPreviewKey, payload).setMeta('addToHistory', false))
  if (!payload || !payload.scrollTo) return
  nextFrame(() => {
    if (!rootRef.value) return
    const el = rootRef.value.querySelector(`.knote-agent-new[data-hunk-id="${payload.scrollTo}"]`)
      || rootRef.value.querySelector('.knote-agent-new, .knote-agent-old')
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}
const clearAgentPreview = () => {
  if (editor.isDestroyed) return
  const { state, view } = editor
  view.dispatch(state.tr.setMeta(agentPreviewKey, null).setMeta('addToHistory', false))
}

// Agent-applied markdown: recorded in the undo history (unlike watcher-driven
// syncs) and pre-marks lastEmitted so the modelValue watcher skips its own
// history-less setFromExternal for the same value
const applyExternal = (md) => {
  setFromExternal(md, true)
  hideAllOverlays()
  scheduleOverlayUpdate()
}

// ---- Tab support: whole-EditorState snapshot & restore ----
// A tab switch swaps the entire editor state (doc + selection + per-plugin
// state, INCLUDING undo history) in one cheap view.updateState — each tab
// keeps its own history and caret. `md` is the markdown the state represents;
// pre-marking lastEmitted lets the modelValue watcher skip re-parsing it.
const snapshotState = () => {
  // tab capture reads App's content string right after — sync it first
  flushEmit()
  return editor.isDestroyed ? null : editor.view.state
}
// @tiptap/vue-3 caches the state on the instance (editor.state reads
// reactiveState, refreshed only in dispatchTransaction) — a direct
// view.updateState MUST sync the cache or every subsequent command
// operates on the stale pre-restore doc
const syncStateCache = (state) => {
  if (editor.reactiveState && typeof editor.reactiveState === 'object' && 'value' in editor.reactiveState) {
    editor.reactiveState.value = state
  }
}
const restoreState = (state, md) => {
  if (editor.isDestroyed || !state) return false
  // Defense-in-depth: never let a Vue reactive proxy reach ProseMirror.
  // A proxied EditorState desyncs every identity comparison (schema, node
  // types, plugin list) and silently corrupts all later setContent calls.
  state = toRaw(state)
  if (state.schema !== editor.view.state.schema) return false
  suppressEmit = true
  try {
    editor.view.updateState(state)
    syncStateCache(state)
    lastEmitted = md
  } finally {
    suppressEmit = false
  }
  refreshHistoryState()
  hideAllOverlays()
  scheduleOverlayUpdate()
  return true
}
// Tab restore without a usable snapshot: make the editor match `md` NO
// MATTER WHAT. The modelValue watcher normally handles the sync, but it
// can't fire when the content string didn't change and it trusts
// lastEmitted — a poisoned/blank doc would stay blank. Re-parse on any
// mismatch, then start the tab with a clean history.
const forceSync = (md) => {
  if (editor.isDestroyed) return
  const docEmpty = editor.view.state.doc.content.size <= 2
  const mdEmpty = String(md || '').trim() === ''
  if (md !== lastEmitted || (docEmpty && !mdEmpty)) {
    setFromExternal(md)
    hideAllOverlays()
    scheduleOverlayUpdate()
  }
  resetHistory()
}
// Fresh-parsed tabs (no snapshot yet) start with a CLEAN undo history —
// re-initializing all plugin states prevents Ctrl+Z from bleeding the
// previous tab's edits into this one. Doc and selection carry over.
const resetHistory = () => {
  if (editor.isDestroyed) return
  const { view } = editor
  const state = view.state
  const fresh = EditorState.create({
    schema: state.schema,
    doc: state.doc,
    selection: state.selection,
    plugins: state.plugins
  })
  view.updateState(fresh)
  syncStateCache(fresh)
  refreshHistoryState()
}

// ---- find/replace API (driven by the App's search bar) ----
const searchState = () => searchKey.getState(editor.state)
const searchStatus = () => {
  const s = searchState()
  return { count: s.matches.length, active: s.activeIndex, query: s.query }
}
const searchScrollToActive = () => {
  const s = searchState()
  const m = s.matches[s.activeIndex]
  if (!m) return
  // reveal the match if it sits inside a folded section
  const unfolded = unfoldContaining(m.from)
  const doScroll = () => {
    const dom = editor.view.domAtPos(m.from)
    const node = dom.node.nodeType === 3 ? dom.node.parentElement : dom.node
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  if (unfolded) nextFrame(doScroll)
  else doScroll()
}
const searchSet = (query, opts = {}, activeIndex = 0) => {
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query, opts, activeIndex }).setMeta('addToHistory', false))
  const st = searchStatus()
  if (st.count) searchScrollToActive()
  return st
}
const searchStep = (dir) => {
  const s = searchState()
  if (!s.matches.length) return searchStatus()
  const next = (s.activeIndex + dir + s.matches.length) % s.matches.length
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query: s.query, opts: s.opts, activeIndex: next }).setMeta('addToHistory', false))
  searchScrollToActive()
  return searchStatus()
}
const searchClear = () => {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query: '', opts: {}, activeIndex: -1 }).setMeta('addToHistory', false))
}
const searchReplaceActive = (replacement) => {
  const s = searchState()
  const m = s.matches[s.activeIndex]
  if (!m) return searchStatus()
  // replacement is literal text (no markdown parsing); recompute afterwards
  // and land the active match near where the old one was
  editor.view.dispatch(
    editor.state.tr.insertText(replacement, m.from, m.to)
      .setMeta('addToHistory', true)
  )
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query: s.query, opts: s.opts, activeIndex: 'keepNear' }).setMeta('addToHistory', false))
  const st = searchStatus()
  if (st.count) searchScrollToActive()
  return st
}
const searchReplaceAll = (replacement) => {
  const s = searchState()
  if (!s.matches.length) return { count: 0, replaced: 0 }
  let tr = editor.state.tr
  // bottom-up so earlier edits don't shift later ranges
  for (let i = s.matches.length - 1; i >= 0; i--) {
    tr = tr.insertText(replacement, s.matches[i].from, s.matches[i].to)
  }
  const replaced = s.matches.length
  editor.view.dispatch(tr.setMeta('addToHistory', true))
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query: s.query, opts: s.opts, activeIndex: 0 }).setMeta('addToHistory', false))
  return { count: 0, replaced }
}

defineExpose({ undo, redo, canUndo, canRedo, canUndoR, canRedoR, scrollToHeading, focusEditor, setAgentPreview, clearAgentPreview, applyExternal, snapshotState, restoreState, resetHistory, forceSync, flushEmit, searchSet, searchStep, searchClear, searchReplaceActive, searchReplaceAll, searchStatus, editor })
</script>

<template>
  <div
    ref="rootRef"
    class="relative h-full"
    @mousemove="handleRootMouseMove"
    @mouseleave="handleRootMouseLeave"
    @contextmenu="onEditorContextMenu"
  >
    <!-- pl-12 reserves an in-card rail for the gutter buttons so they never
         paint outside the editor card (over the sidebar); the deep bottom
         padding keeps the writing line away from the card edge — clicking
         into it appends a fresh empty row (Feishu/Notion behavior) -->
    <div class="knote-doc-scroll h-full overflow-auto pt-6 pb-[35vh] pr-6 pl-12 cursor-text" @scroll.passive="handleContentScroll" @mousedown="handleBottomAreaMouseDown" @click="handleBottomAreaClick">
      <editor-content
        :editor="editor"
        class="knote-rich prose prose-sm md:prose-base dark:prose-invert max-w-none w-full outline-none text-left"
      />
    </div>

    <!-- Gutter: plus + drag handle -->
    <div
      v-if="gutterVisible"
      class="knote-gutter absolute z-40 flex items-center gap-0.5"
      :style="{ top: `${gutterTop}px`, left: `${gutterLeft}px` }"
    >
      <button
        v-if="!gutterIsEmptyRow"
        class="w-4 h-7 flex items-center justify-center text-base-content/30 hover:text-base-content/70 cursor-grab active:cursor-grabbing select-none"
        draggable="true"
        :title="t('drag_move')"
        @dragstart="handleDragStart"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
          <circle cx="2.5" cy="2.5" r="1.4"/><circle cx="7.5" cy="2.5" r="1.4"/>
          <circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/>
          <circle cx="2.5" cy="13.5" r="1.4"/><circle cx="7.5" cy="13.5" r="1.4"/>
        </svg>
      </button>
      <button
        v-if="gutterIsEmptyRow"
        class="w-7 h-7 flex items-center justify-center bg-white border border-base-300 rounded-md shadow-md transition-all duration-200 hover:scale-110 hover:shadow-lg cursor-pointer"
        :title="t('block_actions')"
        @mousedown.prevent
        @click="lineMenuOpen = !lineMenuOpen"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5 text-[#84cc16] plus-icon-glow">
          <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
        </svg>
      </button>

      <!-- Line menu -->
      <div
        v-if="lineMenuOpen"
        class="absolute top-8 left-5 z-50 w-60 max-h-[70vh] overflow-y-auto shadow-2xl bg-base-100 border border-base-200 rounded-xl p-1.5"
        @mousedown.stop
      >
        <div class="text-[10px] font-bold opacity-40 uppercase tracking-wider px-2.5 pt-1.5 pb-1">{{ t('headings') }}</div>
        <div class="grid grid-cols-4 gap-1 px-1">
          <button class="h-9 rounded-lg hover:bg-base-200 transition-colors font-black text-base" @mousedown.prevent @click="gutterHeading(1)">H1</button>
          <button class="h-9 rounded-lg hover:bg-base-200 transition-colors font-bold text-[15px]" @mousedown.prevent @click="gutterHeading(2)">H2</button>
          <button class="h-9 rounded-lg hover:bg-base-200 transition-colors font-semibold text-sm" @mousedown.prevent @click="gutterHeading(3)">H3</button>
          <button class="h-9 rounded-lg hover:bg-base-200 transition-colors flex items-center justify-center opacity-80" :title="t('paragraph')" @mousedown.prevent @click="gutterCommand('p')">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V7M9.5 20h5M12 4v16"/></svg>
          </button>
        </div>
        <div class="text-[10px] font-bold opacity-40 uppercase tracking-wider px-2.5 pt-2.5 pb-1">{{ t('lists_quote') }}</div>
        <button class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-base-200 text-sm text-left transition-colors" @mousedown.prevent @click="gutterCommand('ul')">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 opacity-70"><path stroke-linecap="round" d="M9.5 6h11M9.5 12h11M9.5 18h11"/><circle cx="4.5" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.3" fill="currentColor" stroke="none"/></svg>
          <span>{{ t('bullet_list') }}</span>
        </button>
        <button class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-base-200 text-sm text-left transition-colors" @mousedown.prevent @click="gutterCommand('ol')">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 opacity-70"><path stroke-linecap="round" d="M10.5 6h10M10.5 12h10M10.5 18h10"/><text x="2.5" y="8.3" font-size="7" fill="currentColor" stroke="none" font-family="ui-monospace, monospace">1</text><text x="2.5" y="14.3" font-size="7" fill="currentColor" stroke="none" font-family="ui-monospace, monospace">2</text><text x="2.5" y="20.3" font-size="7" fill="currentColor" stroke="none" font-family="ui-monospace, monospace">3</text></svg>
          <span>{{ t('ordered_list') }}</span>
        </button>
        <button class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-base-200 text-sm text-left transition-colors" @mousedown.prevent @click="gutterCommand('task')">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 opacity-70"><rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path stroke-linecap="round" stroke-linejoin="round" d="m8.3 12.3 2.7 2.8 5-5.5"/></svg>
          <span>{{ t('task_list') }}</span>
        </button>
        <button class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-base-200 text-sm text-left transition-colors" @mousedown.prevent @click="gutterCommand('quote')">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 opacity-70"><path stroke-linecap="round" d="M5 5v14"/><path stroke-linecap="round" d="M10 7.5h9M10 12h9M10 16.5h6"/></svg>
          <span>{{ t('quote') }}</span>
        </button>
        <div class="text-[10px] font-bold opacity-40 uppercase tracking-wider px-2.5 pt-2.5 pb-1">{{ t('insert') }}</div>
        <button class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-base-200 text-sm text-left transition-colors" @mousedown.prevent @click="insertImageLocal">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 opacity-70"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.7"/><path stroke-linecap="round" stroke-linejoin="round" d="m5 18.5 4.8-5.3 3.2 3.5 2.4-2.6 3.6 4"/></svg>
          <span>{{ t('insert_image_local') }}</span>
        </button>
        <button class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-base-200 text-sm text-left transition-colors" @mousedown.prevent @click="insertImageUrl">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 opacity-70"><path stroke-linecap="round" stroke-linejoin="round" d="M13.2 10.8a4.2 4.2 0 0 0-5.94 0l-3.02 3.02a4.2 4.2 0 1 0 5.94 5.94l1.51-1.51"/><path stroke-linecap="round" stroke-linejoin="round" d="M10.8 13.2a4.2 4.2 0 0 0 5.94 0l3.02-3.02a4.2 4.2 0 1 0-5.94-5.94l-1.51 1.51"/></svg>
          <span>{{ t('insert_image_url') }}</span>
        </button>
        <button class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-base-200 text-sm text-left transition-colors" @mousedown.prevent @click="tableGridOpen = !tableGridOpen">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 opacity-70"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M9.5 4.5v15M15.5 4.5v15"/></svg>
          <span>{{ t('table') }}</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="ml-auto shrink-0 opacity-50 transition-transform" :class="{ 'rotate-90': tableGridOpen }"><path stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
        </button>
        <!-- Table size picker -->
        <div v-if="tableGridOpen" class="px-2.5 pb-2 pt-1">
          <div
            class="grid gap-[3px] w-max mx-auto"
            :style="{ gridTemplateColumns: `repeat(${GRID_MAX_COLS}, 16px)` }"
            @mouseleave="gridRows = 0; gridCols = 0"
          >
            <button
              v-for="idx in GRID_MAX_ROWS * GRID_MAX_COLS"
              :key="idx"
              class="w-4 h-4 rounded-[3px] border transition-colors duration-75"
              :class="gridCellActive(idx) ? 'bg-[#84cc16]/70 border-[#84cc16]' : 'bg-base-200/60 border-base-300'"
              @mouseenter="gridHover(idx)"
              @mousedown.prevent
              @click="insertTableGrid"
            ></button>
          </div>
          <div class="text-xs text-center opacity-60 mt-1.5 font-mono">{{ gridRows && gridCols ? `${gridRows} × ${gridCols}` : '– × –' }}</div>
        </div>
        <button class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-base-200 text-sm text-left transition-colors" @mousedown.prevent @click="gutterCommand('codeblock')">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 opacity-70"><path stroke-linecap="round" stroke-linejoin="round" d="m8.5 7.5-5 4.5 5 4.5m7-9 5 4.5-5 4.5"/></svg>
          <span>{{ t('code_block') }}</span>
        </button>
        <button class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-base-200 text-sm text-left transition-colors" @mousedown.prevent @click="insertFormula">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 opacity-70"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.5h2.2l2.3 5L12.6 4H21"/></svg>
          <span>{{ t('formula_block') }}</span>
        </button>
        <button class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-base-200 text-sm text-left transition-colors" @mousedown.prevent @click="insertHr">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 opacity-70"><path stroke-linecap="round" d="M3.5 12h17"/><path stroke-linecap="round" d="M8 6.5h8M8 17.5h8" opacity="0.35"/></svg>
          <span>{{ t('divider') }}</span>
        </button>
      </div>
    </div>

    <!-- Formatting bubble (row 1: formatting; row 2: AI actions) -->
    <div
      v-if="bubbleVisible"
      class="knote-bubble absolute z-[999] flex flex-col shadow-xl transform -translate-y-full rounded-2xl toolbar-glow isolate whitespace-nowrap selection-toolbar"
      :style="{ top: `${bubbleTop}px`, left: `${bubbleLeft}px` }"
    >
    <div class="flex items-stretch h-12">
      <button class="btn btn-ghost rounded-none rounded-tl-2xl h-full px-3" :class="{'text-[#84cc16]': editor.isActive('bold')}" @mousedown.prevent @click="run(c => c.toggleBold())"><b>B</b></button>
      <button class="btn btn-ghost h-full px-3" :class="{'text-[#84cc16]': editor.isActive('italic')}" @mousedown.prevent @click="run(c => c.toggleItalic())"><i>I</i></button>
      <button class="btn btn-ghost h-full px-3" :class="{'text-[#84cc16]': editor.isActive('underline')}" @mousedown.prevent @click="run(c => c.toggleUnderline())"><u>U</u></button>
      <button class="btn btn-ghost h-full px-3" :class="{'text-[#84cc16]': editor.isActive('strike')}" @mousedown.prevent @click="run(c => c.toggleStrike())"><span class="line-through">S</span></button>
      <button class="btn btn-ghost h-full px-3 font-mono text-sm" :class="{'text-[#84cc16]': editor.isActive('code')}" @mousedown.prevent @click="run(c => c.toggleCode())">`c`</button>
      <button class="btn btn-ghost h-full px-3" :title="t('formula')" @mousedown.prevent @click="wrapSelectionFormula">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13.5h2.2l2.3 5L12.6 4H21"/></svg>
      </button>

      <!-- Heading dropdown -->
      <div class="dropdown dropdown-hover h-full flex items-center">
        <div tabindex="0" role="button" class="btn btn-ghost h-full px-3" :class="{'text-[#84cc16]': editor.isActive('heading')}"><b>H</b><span class="text-[9px] opacity-70 ml-0.5">▼</span></div>
        <ul tabindex="0" class="dropdown-content z-[1] menu p-1 shadow bg-base-100 rounded-box w-28 border border-base-200 top-full">
          <li v-for="lv in [1,2,3,4,5,6]" :key="lv">
            <a class="py-1 px-2 text-xs" :class="{active: editor.isActive('heading', {level: lv})}" @mousedown.prevent @click="run(c => c.toggleHeading({level: lv}))">H{{ lv }}</a>
          </li>
          <li><a class="py-1 px-2 text-xs text-base-content/60" @mousedown.prevent @click="run(c => c.setParagraph())">{{ t('paragraph') }}</a></li>
        </ul>
      </div>

      <!-- Color palette -->
      <div class="dropdown dropdown-hover dropdown-end h-full flex items-center">
        <div tabindex="0" role="button" class="btn btn-ghost rounded-none rounded-tr-2xl h-full px-3 relative" :title="t('text_color')">
          <span class="font-bold leading-none">A</span>
          <span class="absolute bottom-1.5 left-1/2 -translate-x-1/2 w-4 h-1 rounded-full" style="background: linear-gradient(90deg, #e53935, #f57c00, #43a047, #1e88e5, #8e24aa)"></span>
        </div>
        <div tabindex="0" class="dropdown-content z-[1] p-3 shadow-xl bg-base-100 rounded-box border border-base-200 top-full w-56">
          <div class="text-[10px] font-bold opacity-50 mb-1.5 uppercase tracking-wider">{{ t('text_color') }}</div>
          <div class="flex gap-1.5 items-center">
            <button class="w-6 h-6 rounded-md border border-base-300 text-xs font-bold hover:scale-110 transition-transform" :title="t('default_color')" @mousedown.prevent @click="unsetStyleAttr('color')">A</button>
            <button v-for="c in textColorPalette" :key="'t'+c" class="w-6 h-6 rounded-md border border-base-300 text-xs font-bold text-white hover:scale-110 transition-transform" :style="{backgroundColor: c}" @mousedown.prevent @click="run(ch => ch.setColor(c))">A</button>
          </div>
          <div class="text-[10px] font-bold opacity-50 mt-3 mb-1.5 uppercase tracking-wider">{{ t('bg_color') }}</div>
          <div class="flex gap-1.5 items-center">
            <button class="w-6 h-6 rounded-md border border-base-300 flex items-center justify-center hover:scale-110 transition-transform" :title="t('default_color')" @mousedown.prevent @click="unsetStyleAttr('backgroundColor')">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
            <button v-for="c in bgColorPalette" :key="'b'+c" class="w-6 h-6 rounded-md border border-base-300 hover:scale-110 transition-transform" :style="{backgroundColor: c}" @mousedown.prevent @click="run(ch => ch.setBackgroundColor(c))"></button>
          </div>
        </div>
      </div>
    </div>

    <!-- AI actions on the selection (flex-1: fill the toolbar's full width,
         which is set by the wider formatting row above) -->
    <div class="flex items-stretch h-9 border-t border-base-200/70">
      <button class="btn btn-ghost btn-sm flex-1 rounded-none rounded-bl-2xl h-full px-2 text-xs gap-1 text-[#84cc16] font-bold" @mousedown.prevent @click="askAgent('ask')">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z"/></svg>
        {{ t('ai_ask') }}
      </button>
      <button class="btn btn-ghost btn-sm flex-1 rounded-none h-full px-2 text-xs" @mousedown.prevent @click="askAgent('polish')">{{ t('ai_polish') }}</button>
      <button class="btn btn-ghost btn-sm flex-1 rounded-none h-full px-2 text-xs" @mousedown.prevent @click="askAgent('translate')">{{ t('ai_translate') }}</button>
      <button class="btn btn-ghost btn-sm flex-1 rounded-none h-full px-2 text-xs" @mousedown.prevent @click="askAgent('expand')">{{ t('ai_expand') }}</button>
      <button class="btn btn-ghost btn-sm flex-1 rounded-none rounded-br-2xl h-full px-2 text-xs" @mousedown.prevent @click="askAgent('condense')">{{ t('ai_condense') }}</button>
    </div>
    </div>

    <!-- Image toolbar -->
    <div
      v-if="imageSelected"
      class="knote-bubble absolute z-[999] inline-flex items-stretch shadow-xl transform -translate-x-1/2 -translate-y-full rounded-2xl toolbar-glow isolate whitespace-nowrap h-12 selection-toolbar"
      :style="{ top: `${bubbleTop}px`, left: `${bubbleLeft}px` }"
    >
      <button class="btn btn-ghost rounded-l-2xl h-full px-3" :title="t('image_zoom_out')" @mousedown.prevent @click="updateImage({width: Math.max(10, (imageWidth||100) - 10)})">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M19.5 12h-15"/></svg>
      </button>
      <div class="flex items-center px-2 gap-1 min-w-[140px]">
        <input type="range" min="10" max="100" step="5" :value="imageWidth || 100" class="range range-xs range-success w-full"
          @input="updateImage({width: Number($event.target.value)})" />
        <span class="text-xs font-mono opacity-70 w-10 text-center">{{ imageWidth || 100 }}%</span>
      </div>
      <button class="btn btn-ghost h-full px-3" :title="t('image_zoom_in')" @mousedown.prevent @click="updateImage({width: Math.min(100, (imageWidth||100) + 10)})">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
      </button>
      <div class="w-px bg-base-300 my-2"></div>
      <button class="btn btn-ghost h-full px-3" :class="{'bg-base-300/50': imageAlign === 'left' || !imageAlign}" :title="t('align_left')" @mousedown.prevent @click="updateImage({align: null})">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"/></svg>
      </button>
      <button class="btn btn-ghost h-full px-3" :class="{'bg-base-300/50': imageAlign === 'center'}" :title="t('align_center')" @mousedown.prevent @click="updateImage({align: 'center'})">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M3.75 6.75h16.5M6 12h12M3.75 17.25h16.5"/></svg>
      </button>
      <button class="btn btn-ghost h-full px-3" :class="{'bg-base-300/50': imageAlign === 'right'}" :title="t('align_right')" @mousedown.prevent @click="updateImage({align: 'right'})">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M3.75 6.75h16.5M3.75 12h16.5m-7.5 5.25h7.5"/></svg>
      </button>
      <div class="w-px bg-base-300 my-2"></div>
      <button class="btn btn-ghost h-full px-3 text-xs font-mono" :title="t('image_original')" @mousedown.prevent @click="updateImage({width: null})">1:1</button>
      <button class="btn btn-ghost h-full px-3" :title="t('crop')" @mousedown.prevent @click="startCrop">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2"/></svg>
      </button>
      <button class="btn btn-ghost h-full px-3" :title="t('image_replace')" @mousedown.prevent @click="replaceImage">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.015 4.356v4.992"/></svg>
      </button>
      <button class="btn btn-ghost rounded-r-2xl h-full px-3 text-error" :title="t('image_delete')" @mousedown.prevent @click="deleteImage">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
      </button>
    </div>

    <!-- Table toolbar -->
    <div
      v-if="tableVisible"
      class="knote-table-toolbar knote-bubble absolute z-[998] inline-flex items-stretch shadow-xl transform -translate-x-1/2 -translate-y-full rounded-2xl toolbar-glow isolate whitespace-nowrap h-12 selection-toolbar"
      :style="{ top: `${tableTop}px`, left: `${tableLeft}px` }"
    >
      <button class="btn btn-ghost rounded-l-2xl h-full px-3" :title="t('table_insert_row_above')" @mousedown.prevent @click="tableCmd('rowAbove')">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10h18M3 17h18M12 7V3"/><path stroke-linecap="round" stroke-linejoin="round" d="M9 5.5 12 2.5l3 3"/></svg>
      </button>
      <button class="btn btn-ghost h-full px-3" :title="t('table_insert_row_below')" @mousedown.prevent @click="tableCmd('rowBelow')">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7h18M3 14h18M12 17v4"/><path stroke-linecap="round" stroke-linejoin="round" d="m9 18.5 3 3 3-3"/></svg>
      </button>
      <div class="w-px bg-base-300 my-2"></div>
      <button class="btn btn-ghost h-full px-3" :title="t('table_insert_col_left')" @mousedown.prevent @click="tableCmd('colLeft')">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 3v18M17 3v18M7 12H3"/><path stroke-linecap="round" stroke-linejoin="round" d="M5.5 9 2.5 12l3 3"/></svg>
      </button>
      <button class="btn btn-ghost h-full px-3" :title="t('table_insert_col_right')" @mousedown.prevent @click="tableCmd('colRight')">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M7 3v18M14 3v18M17 12h4"/><path stroke-linecap="round" stroke-linejoin="round" d="m18.5 9 3 3-3 3"/></svg>
      </button>
      <div class="w-px bg-base-300 my-2"></div>
      <button class="btn btn-ghost h-full px-3" :title="t('table_delete_row')" @mousedown.prevent @click="tableCmd('delRow')">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7h18M3 17h18"/><path stroke-linecap="round" stroke-linejoin="round" class="text-error" stroke="#ef4444" d="M8 12h8"/></svg>
      </button>
      <button class="btn btn-ghost h-full px-3" :title="t('table_delete_col')" @mousedown.prevent @click="tableCmd('delCol')">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M7 3v18M17 3v18"/><path stroke-linecap="round" stroke-linejoin="round" stroke="#ef4444" d="M12 8v8"/></svg>
      </button>
      <div class="w-px bg-base-300 my-2"></div>
      <button class="btn btn-ghost rounded-r-2xl h-full px-3 text-error" :title="t('table_delete')" @mousedown.prevent @click="tableCmd('delTable')">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7h18M7 7v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V7"/><path stroke-linecap="round" stroke-linejoin="round" d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button>
    </div>

    <!-- Image crop modal -->
    <div
      v-if="cropState"
      class="fixed inset-0 z-[1200] flex items-center justify-center bg-black/60"
      @mousedown.self="cropState = null"
    >
      <div class="bg-base-100 rounded-2xl shadow-2xl p-4 flex flex-col gap-3 max-w-[85vw]">
        <div class="text-sm font-bold">{{ t('crop') }}</div>
        <div class="relative select-none overflow-hidden rounded-lg" style="max-width: 75vw; max-height: 65vh;">
          <img
            ref="cropImgRef"
            :src="cropState.src"
            class="block max-w-[75vw] max-h-[65vh]"
            draggable="false"
            @load="onCropImgLoad"
          />
          <div
            class="absolute border-2 border-[#84cc16] cursor-move"
            :style="{ left: cropSel.x + 'px', top: cropSel.y + 'px', width: cropSel.w + 'px', height: cropSel.h + 'px', boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)' }"
            @mousedown="cropPointerDown($event, 'move')"
          >
            <div
              v-for="handle in CROP_HANDLES"
              :key="handle.dir"
              class="absolute w-3.5 h-3.5 bg-[#84cc16] border border-white/70 rounded-sm shadow"
              :style="handle.style"
              @mousedown.stop="cropPointerDown($event, handle.dir)"
            ></div>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button class="btn btn-sm btn-ghost" @click="cropState = null">{{ t('crop_cancel') }}</button>
          <button class="btn btn-sm text-white border-none" style="background:#84cc16" @click="applyCrop">{{ t('crop_apply') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
