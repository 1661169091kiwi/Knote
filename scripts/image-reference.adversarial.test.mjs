import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canonicalInternalImageId,
  imageResourceDescriptor,
  replaceInvalidInternalImageReferences,
  validateInternalImageReferences
} from '../src/lib/imageReferenceGuard.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const agentStore = fs.readFileSync(path.join(repoRoot, 'src/lib/agentStore.js'), 'utf8')

test('internal image IDs are exact capabilities and never guessed from filename-like text', () => {
  assert.equal(canonicalInternalImageId('el-15'), 'el-15')
  assert.equal(canonicalInternalImageId('knote-img:el-15'), 'el-15')
  assert.equal(canonicalInternalImageId('el-1.jpg0'), null)
  assert.equal(canonicalInternalImageId('el-15.jpg'), null)
  assert.equal(canonicalInternalImageId('el-15.png'), null)
  assert.equal(canonicalInternalImageId('el-'), null)
})

test('valid refs normalize, while malformed and missing refs are reported separately', () => {
  const source = [
    '![正确](el-15)',
    '![后缀错误](el-1.jpg0)',
    '![已经失效](el-999)',
    '![普通文件](el-diagram.png)',
    '![普通相对图](assets/el-1.jpg0)',
    '![网络图](https://example.com/el-1.jpg0)'
  ].join('\n')
  const result = validateInternalImageReferences(source, {
    hasImage: (id) => id === 'el-15'
  })
  assert.match(result.text, /!\[正确\]\(knote-img:el-15\)/)
  assert.match(result.text, /assets\/el-1\.jpg0/)
  assert.match(result.text, /el-diagram\.png/)
  assert.match(result.text, /https:\/\/example\.com\/el-1\.jpg0/)
  assert.deepEqual(result.valid, ['el-15'])
  assert.deepEqual(result.invalid, [
    { source: 'el-1.jpg0', reason: 'malformed' },
    { source: 'el-999', id: 'el-999', reason: 'not_found' }
  ])
})

test('one invalid ref makes a mixed batch invalid without coercing any ID', () => {
  const available = new Set(['el-10', 'el-13', 'el-15', 'el-17', 'el-19'])
  const source = [
    '![Fig 4](el-10)',
    '![Table 2](el-1.jpg3)',
    '![Table 3](el-15)',
    '![Table 4](el-17)',
    '![Table 5](el-19)'
  ].join('\n')
  const result = validateInternalImageReferences(source, { hasImage: (id) => available.has(id) })
  assert.equal(result.invalid.length, 1)
  assert.equal(result.invalid[0].source, 'el-1.jpg3')
  assert.doesNotMatch(result.text, /knote-img:el-13/)
  assert.match(result.text, /el-1\.jpg3/)
})

test('examples inside code are data, not live image references', () => {
  const source = [
    '```md',
    '![错误示例](el-1.jpg0)',
    '```',
    '`![内联示例](el-99.png)`',
    '![真实图](el-15)'
  ].join('\n')
  const result = validateInternalImageReferences(source, { hasImage: (id) => id === 'el-15' })
  assert.deepEqual(result.invalid, [])
  assert.equal(result.valid.length, 1)
  assert.match(result.text, /!\[真实图\]\(knote-img:el-15\)/)
})

test('old broken refs render a visible diagnostic instead of a blank image', () => {
  const rendered = replaceInvalidInternalImageReferences(
    '前文\n\n![Table 2](el-1.jpg0)\n\n![可用](el-15)\n\n后文',
    { hasImage: (id) => id === 'el-15', label: '图片引用无效' }
  )
  assert.match(rendered, /⚠ 图片引用无效：`el-1\.jpg0`/)
  assert.match(rendered, /!\[可用\]\(knote-img:el-15\)/)
  assert.doesNotMatch(rendered, /!\[Table 2\]/)
})

test('image-producing tools expose copy-safe structured references', () => {
  const descriptor = imageResourceDescriptor({
    id: 'el-15',
    type: 'table',
    page: 7,
    caption: 'Table 2'
  })
  assert.deepEqual(descriptor, {
    image_id: 'el-15',
    element_id: 'el-15',
    type: 'table',
    page: 7,
    caption: 'Table 2',
    markdown_reference: '![Table 2](el-15)',
    insert_image_args: { image_id: 'el-15' }
  })
  assert.match(agentStore, /elements:\s*preparedElements/)
  assert.match(agentStore, /markdown_reference=/)
  assert.match(agentStore, /INVALID_IMAGE_REFERENCE/)
})

test('every model-controlled write path passes the same atomic image guard', () => {
  const calls = agentStore.match(/prepareModelImageRefs\(/g) || []
  // replace_lines + insert_lines + continue_hunk + batch_process +
  // create_file + edit_file
  assert.equal(calls.length, 6)
  const batchGuard = agentStore.indexOf('const prepared = prepareModelImageRefs(out)')
  const batchReject = agentStore.indexOf('if (prepared.error)', batchGuard)
  const batchWrite = agentStore.indexOf('agentBridge.writeFile', batchGuard)
  assert.ok(batchGuard >= 0 && batchReject > batchGuard && batchWrite > batchReject)
  assert.match(agentStore, /case 'create_file'[\s\S]*?prepareModelImageRefs\(input\.content\)[\s\S]*?if \(prepared\.error\) return prepared\.error/)
  assert.match(agentStore, /case 'edit_file'[\s\S]*?prepareModelImageRefs\(newStr/)
})
