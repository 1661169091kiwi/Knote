import test from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import { TextSelection, NodeSelection } from '@tiptap/pm/state'
import { CellSelection, TableMap } from '@tiptap/pm/tables'
import { EditorState } from '@tiptap/pm/state'
import { JSDOM } from 'jsdom'
import { tableInteractionPlugin, tableSelectionInfo, tableSelectionText } from '../src/lib/tableEditingInteraction.js'
import { selectionToolbarPosition, tablePickerPosition } from '../src/lib/editorOverlayGeometry.js'
import { selectedTableContext, preventNativeTextDrag } from '../src/lib/editorInteractionPolicy.js'
import { CURSOR_PREFERENCE_KEY, readCustomCursors, persistCustomCursors } from '../src/lib/cursorPreference.js'

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { content: 'text*', group: 'block' }, text: {},
  table: { content: 'tableRow+', group: 'block', tableRole: 'table' },
  tableRow: { content: 'tableCell+', tableRole: 'row' },
  tableCell: { content: 'paragraph+', tableRole: 'cell', attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } } }
} })
const p = text => schema.node('paragraph', null, text ? schema.text(text) : undefined)

test('selection toolbar docks to either viewport edge without changing document scroll', () => {
  const bounds = { left: 8, top: 48, right: 1192, bottom: 792 }
  assert.deepEqual(selectionToolbarPosition({ left: 300, top: 300 }, bounds, 440, 96), { left: 300, top: 192 })
  assert.deepEqual(selectionToolbarPosition({ left: 300, top: -600 }, bounds, 440, 96), { left: 300, top: 48 })
  assert.deepEqual(selectionToolbarPosition({ left: 1400, top: 1800 }, bounds, 440, 96), { left: 752, top: 696 })
})

test('table size picker opens to the right and flips only when viewport space requires it', () => {
  const viewport = { left: 8, top: 8, right: 1192, bottom: 792 }
  assert.deepEqual(tablePickerPosition({ left: 100, right: 340, top: 200 }, viewport, 208, 180), { side: 'right', left: 348, top: 200 })
  assert.deepEqual(tablePickerPosition({ left: 1000, right: 1180, top: 750 }, viewport, 208, 180), { side: 'left', left: 784, top: 612 })
})
const table = prefix => schema.node('table', null, [0, 1].map(row => schema.node('tableRow', null, [0, 1].map(col => schema.node('tableCell', null, p(`${prefix}${row}${col}`))))))
const doc = schema.node('doc', null, [p('before'), table('A'), p('between'), table('B'), p('after')])
const positions = { tables: [], cells: [], text: {} }
doc.descendants((node, pos) => {
  if (node.type.name === 'table') positions.tables.push(pos)
  if (node.type.name === 'tableCell') positions.cells.push(pos)
  if (node.isText) positions.text[node.text] = pos
})

test('table toolbar context follows a caret or text selection in exactly one table', () => {
  assert.equal(selectedTableContext(TextSelection.create(doc, positions.text.A00)).pos, positions.tables[0])
  assert.equal(selectedTableContext(TextSelection.create(doc, positions.text.A00, positions.text.A11 + 1)).pos, positions.tables[0])
  assert.equal(selectedTableContext(TextSelection.create(doc, positions.text.B00)).pos, positions.tables[1])
  assert.equal(selectedTableContext(TextSelection.create(doc, positions.text.before)), null)
})

test('table toolbar context rejects ranges spanning outside the table or two tables', () => {
  assert.equal(selectedTableContext(TextSelection.create(doc, positions.text.before, positions.text.A00)), null)
  assert.equal(selectedTableContext(TextSelection.create(doc, positions.text.A00, positions.text.B00)), null)
  assert.equal(selectedTableContext(null), null)
})

test('table toolbar supports whole-table and rectangular cell selections', () => {
  assert.equal(selectedTableContext(NodeSelection.create(doc, positions.tables[0])).pos, positions.tables[0])
  assert.equal(selectedTableContext(CellSelection.create(doc, positions.cells[0], positions.cells[3])).pos, positions.tables[0])
})

test('table editing clipboard is rectangular TSV, not flattened paragraph text', () => {
  const selection = CellSelection.create(doc, positions.cells[0], positions.cells[3])
  assert.equal(tableSelectionText(selection), 'A00\tA01\nA10\tA11')
  assert.deepEqual(tableSelectionInfo(selection).rect, { left: 0, top: 0, right: 2, bottom: 2 })
  assert.equal(tableSelectionText(CellSelection.create(doc, positions.cells[3], positions.cells[0])), 'A00\tA01\nA10\tA11')
  assert.equal(tableSelectionText(TextSelection.create(doc, positions.text.before)), '')
})

test('table editing highlight is a decoration only and does not change the document', () => {
  const plugin = tableInteractionPlugin()
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, positions.text.A00), plugins: [plugin] })
  const decoration = plugin.props.decorations(state).find()
  assert.equal(decoration.length, 1)
  assert.equal(decoration[0].from, positions.cells[0])
  assert.equal(state.doc, doc)
  assert.equal(plugin.props.decorations(EditorState.create({ doc, selection: TextSelection.create(doc, positions.text.before) })), null)
})

test('table editing caret highlight never builds a whole-table grid', () => {
  const plugin = tableInteractionPlugin()
  const original = TableMap.get
  let calls = 0
  TableMap.get = (...args) => { calls++; return original(...args) }
  try {
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, positions.text.A00), plugins: [plugin] })
    plugin.props.decorations(state)
    assert.equal(calls, 0, 'typing or moving a text caret must not scan every cell')
  } finally { TableMap.get = original }
})

test('table editing Delete clears even an entire selected table without deleting its structure', () => {
  const plugin = tableInteractionPlugin()
  let state = EditorState.create({ doc, selection: CellSelection.create(doc, positions.cells[0], positions.cells[3]), plugins: [plugin] })
  const view = { get state() { return state }, dispatch(tr) { state = state.apply(tr) } }
  const event = { key: 'Delete', prevented: false, preventDefault() { this.prevented = true } }
  assert.equal(plugin.props.handleKeyDown(view, event), true)
  assert.equal(event.prevented, true)
  const table = state.doc.nodeAt(positions.tables[0])
  assert.equal(table.type.name, 'table')
  assert.equal(table.childCount, 2)
  assert.equal(table.firstChild.childCount, 2)
  assert.equal(table.textContent, '')
  assert.match(state.doc.textContent, /B00B01B10B11/)
})

test('clicking a cleared cell paragraph anchors the caret in that cell, not its previous neighbour', () => {
  const dom = new JSDOM('<div class="editor"><table><tbody><tr><td><p><br></p></td><td><p>Neighbour</p></td></tr></tbody></table></div>')
  const plugin = tableInteractionPlugin()
  const cleared = schema.node('doc', null, schema.node('table', null, schema.node('tableRow', null, [
    schema.node('tableCell', null, p()), schema.node('tableCell', null, p('Neighbour'))
  ])))
  const firstCellPos = 2, neighbourTextPos = 8
  let state = EditorState.create({ doc: cleared, selection: TextSelection.create(cleared, neighbourTextPos), plugins: [plugin] })
  const editor = dom.window.document.querySelector('.editor')
  const cell = editor.querySelector('td')
  let focused = false
  const view = {
    dom: editor, editable: true, isDestroyed: false,
    get state() { return state },
    dispatch(tr) { state = state.apply(tr) },
    posAtDOM() { return firstCellPos + 1 },
    posAtCoords() { return { pos: neighbourTextPos } },
    focus() { focused = true }
  }
  const lifecycle = plugin.spec.view(view)
  try {
    const event = { target: cell.firstChild, button: 0, clientX: 50, clientY: 10, prevented: false, preventDefault() { this.prevented = true } }
    assert.equal(plugin.props.handleDOMEvents.mousedown(view, event), true)
    assert.equal(event.prevented, true)
    assert.equal(tableSelectionInfo(state.selection).head.pos, firstCellPos)
    assert.equal(state.selection.$head.parent.content.size, 0)
    assert.equal(focused, true)
  } finally {
    lifecycle.destroy()
    dom.window.close()
  }
})

const dragEvent = ({ skip = false, input, editable = true } = {}) => {
  const event = { prevented: false, preventDefault() { this.prevented = true } }
  event.target = { closest(selector) {
    if (selector.includes('.knote-gutter')) return skip ? {} : null
    if (selector === 'textarea, input') return input || null
    return editable ? this : null
  } }
  return event
}
const selected = { isCollapsed: false, rangeCount: 1, containsNode: () => true, toString: () => 'selected text' }
test('native selected text dragging is cancelled without changing its selection', () => {
  const event = dragEvent()
  const before = { ...selected }
  assert.equal(preventNativeTextDrag(event, selected), true)
  assert.equal(event.prevented, true)
  assert.deepEqual(selected, before)
})
test('native textarea and input text dragging is cancelled only for nonempty selections', () => {
  const event = dragEvent({ input: { selectionStart: 2, selectionEnd: 7 } })
  assert.equal(preventNativeTextDrag(event), true)
  assert.equal(preventNativeTextDrag(dragEvent({ input: { selectionStart: 2, selectionEnd: 2 } })), false)
})
test('block handles, images, collapsed selections and unrelated files keep their drag behaviour', () => {
  assert.equal(preventNativeTextDrag(dragEvent({ skip: true }), selected), false)
  assert.equal(preventNativeTextDrag(dragEvent({ editable: false }), selected), false)
  assert.equal(preventNativeTextDrag(dragEvent(), { ...selected, isCollapsed: true }), false)
  assert.equal(preventNativeTextDrag(dragEvent(), { ...selected, containsNode: () => false }), false)
  assert.equal(preventNativeTextDrag(dragEvent(), { ...selected, toString: () => '' }), false)
})
test('cursor preference defaults on, persists off/on, and safely reads unavailable storage', () => {
  const map = new Map()
  const storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) }
  assert.equal(readCustomCursors(storage), true)
  assert.equal(persistCustomCursors(false, storage), true)
  assert.equal(map.get(CURSOR_PREFERENCE_KEY), '0')
  assert.equal(readCustomCursors(storage), false)
  assert.equal(persistCustomCursors(true, storage), true)
  assert.equal(readCustomCursors(storage), true)
  const unavailable = { getItem() { throw Error('unavailable') }, setItem() { throw Error('unavailable') } }
  assert.equal(readCustomCursors(unavailable), true)
  assert.equal(persistCustomCursors(false, unavailable), false)
})
