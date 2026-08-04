import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { detectFtype } from '../src/lib/fileReader.js'
import {
  agentResourceScopeKey,
  agentResourceScopeTag,
  agentResourceStorageKey
} from '../src/lib/agentResourceScope.js'
import { canonicalAgentWorkspaceId } from '../src/lib/agentWorkspaceKey.js'

const storeSource = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
const appSource = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')

test('the Agent is workspace-first instead of conversation-bound to one document', () => {
  assert.match(storeSource, /你是 Knote 当前工作区的 Agent/)
  assert.match(storeSource, /当前打开的文档只是活动焦点，不是会话身份/)
  assert.match(storeSource, /不得因为上一轮讨论过某个文件/)
  assert.match(storeSource, /本轮工作区文件树/)
  assert.match(storeSource, /activeFilePath/)
  assert.match(storeSource, /refreshWorkspace/)
})

test('every folder run gets a fresh manifest and writes require that run credential', () => {
  assert.match(storeSource, /Program-owned workspace preflight/)
  assert.match(storeSource, /activeRunContext\.workspaceManifest = files\.map/)
  assert.match(storeSource, /activeRunContext\.workspaceInspected = true/)
  assert.match(storeSource, /WORKSPACE_WRITE_TOOLS\.has\(name\) && !runContext\.workspaceInspected/)
  assert.match(storeSource, /code: 'WORKSPACE_NOT_INSPECTED'/)
  assert.match(storeSource, /case 'list_files': \{\s+const bridgeOptions = workspaceBridgeOptions\(\)\s+let refreshed = null\s+if \(typeof agentBridge\.refreshWorkspace/)
  assert.match(storeSource, /code: 'WORKSPACE_REFRESH_FAILED'/)
  assert.match(storeSource, /if \(!Array\.isArray\(refreshed\)\) throw new Error\('WORKSPACE_REFRESH_FAILED'\)/)
})

test('a run keeps an immutable workspace binding and document tools stop on navigation', () => {
  assert.match(storeSource, /code: 'WORKSPACE_CHANGED'/)
  assert.match(storeSource, /code: 'DOCUMENT_CHANGED'/)
  assert.match(storeSource, /currentDocumentId !== runContext\.documentId/)
  assert.match(storeSource, /const workspaceBinding = agentBridge\.captureWorkspace/)
  assert.match(storeSource, /workspaceBinding,/)
  assert.match(storeSource, /workspaceBridgeOptions =/)
  assert.match(appSource, /resolveAgentWorkspaceBinding/)
  assert.match(appSource, /refreshAgentWorkspaceBinding/)
  assert.match(appSource, /relativeImages: \{ \.\.\.relImages \}/)
  assert.match(storeSource, /expandImages\(prepared\.text, diskRaw, bridgeOptions\)/)
  assert.match(storeSource, /persistDetachedSession\(runChatKey, runSession\)/)
  assert.match(storeSource, /if \(runChatKey === chatKey\) \{[\s\S]{0,180}persistChat\(\)/)
  assert.match(storeSource, /runContext && runContext\.lastReadFiles/)
  assert.match(storeSource, /lastReadFiles: \{\}/)
  assert.match(storeSource, /function attachRunSessionToLoadedWorkspace\(session\)/)
  assert.match(storeSource, /if \(runningChatKey\.value === chatKey && runWorkSession\)/)
  assert.match(storeSource, /attachRunSessionToLoadedWorkspace\(runSession\)/)
})

test('same-content documents cannot share read freshness or pending edits', () => {
  assert.match(storeSource, /let lastReadDocumentId = null/)
  assert.match(storeSource, /lastReadDocumentId !== documentId/)
  assert.match(storeSource, /let hunksBaseDocumentId = null/)
  assert.match(storeSource, /documentId !== hunksBaseDocumentId/)
  assert.match(storeSource, /currentDocumentId !== hunksBaseDocumentId/)
  assert.match(storeSource, /pendingHunksForCurrentDocument/)
  assert.match(appSource, /const agentDocumentKeyForTab = \(tb\) =>/)
  assert.match(appSource, /::tab:\$\{tb\.id\}/)
  assert.match(appSource, /agentBridge\.getDocumentIdentity = \(\) => agentDocumentKey\(\)/)
  assert.match(appSource, /v-if="pendingHunksForCurrentDocument\.length/)
  assert.match(appSource, /watch\(\(\) => agentDocumentKey\(\)/)
})

test('desktop workspace path aliases canonicalize without folding opaque identities', () => {
  assert.equal(canonicalAgentWorkspaceId('folder:C:\\Users\\Writer\\Notes\\'), 'folder:c:/users/writer/notes')
  assert.equal(canonicalAgentWorkspaceId('folder:c:/USERS/writer/notes'), 'folder:c:/users/writer/notes')
  assert.equal(canonicalAgentWorkspaceId('file://SERVER/Share/Doc.md'), 'file://server/share/doc.md')
  assert.equal(canonicalAgentWorkspaceId('native:Documents:Knote/CaseSensitive.md'), 'native:Documents:Knote/CaseSensitive.md')
  assert.equal(canonicalAgentWorkspaceId('folder:Display Name'), 'folder:Display Name')
})

test('same-id migrated sessions cannot leak running or question state across workspaces', () => {
  assert.match(storeSource, /export const runningChatKey = ref\(null\)/)
  assert.match(storeSource, /export const activeChatKey = ref\('knote-agent-chat'\)/)
  assert.match(storeSource, /runningChatKey\.value === activeChatKey\.value/)
  assert.match(storeSource, /chatKey: runningChatKey\.value/)
  assert.match(storeSource, /agentQuestion\.value\.chatKey !== activeChatKey\.value/)
  assert.match(storeSource, /runningChatKey\.value = chatKey/)
  assert.match(storeSource, /runningChatKey\.value = null/)
})

test('attachment and PDF resource keys are isolated by both workspace and conversation', () => {
  const workspaceA = agentResourceScopeKey('knote-agent-chat:folder:A', 'session-1')
  const workspaceB = agentResourceScopeKey('knote-agent-chat:folder:B', 'session-1')
  const conversationB = agentResourceScopeKey('knote-agent-chat:folder:A', 'session-2')
  assert.notEqual(workspaceA, workspaceB)
  assert.notEqual(workspaceA, conversationB)
  assert.notEqual(agentResourceStorageKey(workspaceA, 'el-1'), agentResourceStorageKey(workspaceB, 'el-1'))
  assert.notEqual(agentResourceStorageKey(workspaceA, 'att-1'), agentResourceStorageKey(conversationB, 'att-1'))
  assert.notEqual(agentResourceScopeTag(workspaceA), agentResourceScopeTag(workspaceB))
  assert.match(storeSource, /attachmentPool\[scopedStorageKey\(scope, id\)\]/)
  assert.match(storeSource, /pdfElements\[scopedStorageKey\(scope, id\)\]/)
  assert.match(storeSource, /nextAttachmentResourceId\(scope\)/)
  assert.match(storeSource, /nextElementResourceId\(scope\)/)
  assert.match(storeSource, /elMapLookup\(id, scope\)/)
  assert.match(storeSource, /state\._scopeKey === uiResourceScope\(\) \? state : null/)
  assert.doesNotMatch(storeSource, /first hit wins[^\n]*acceptable/)
})

test('one Agent run freezes provider identity, credentials, capabilities, search, and persona', () => {
  const captureStart = storeSource.indexOf('const captureProviderConfig =')
  const captureEnd = storeSource.indexOf('// ---------------- tool definitions', captureStart)
  const capture = storeSource.slice(captureStart, captureEnd)
  for (const field of [
    'protocol', 'baseUrl', 'apiKey', 'model', 'reasoning', 'ctxWindow', 'verify',
    'webSearch', 'searchEngine', 'searchRegion', 'jinaKey', 'systemExtra', 'capabilities'
  ]) assert.match(capture, new RegExp(`\\b${field}:`), `${field} is not captured`)
  assert.match(capture, /Object\.freeze\(\{/)
  assert.match(capture, /capabilities:\s*Object\.freeze\(\{/)

  const runStart = storeSource.indexOf('export const sendToAgent = async')
  const runEnd = storeSource.indexOf('\n}', runStart)
  const run = storeSource.slice(runStart, runEnd > runStart ? runEnd + 2 : undefined)
  assert.match(storeSource.slice(runStart), /const runProvider = captureProviderConfig\(\)/)
  assert.match(storeSource.slice(runStart), /provider:\s*runProvider/)
  assert.match(storeSource.slice(runStart), /buildSystemPrompt\(useTools, activeRunContext, runProvider\)/)
  assert.match(storeSource.slice(runStart), /callAnthropic\([^\n]+provider:\s*runProvider/)
  assert.match(storeSource.slice(runStart), /callOpenAI\([^\n]+provider:\s*runProvider/)
  assert.match(storeSource, /runVerifier\([^\n]+provider:\s*runProvider/)
  assert.match(storeSource, /maybeNameSession\(sessionMessages, runSession, runChatKey, runProvider\)/)
  assert.ok(run.length > 0)
})

test('closing the owner tab cannot strand a hidden pending edit batch', () => {
  assert.match(storeSource, /export const pendingHunksBelongToDocument/)
  assert.match(storeSource, /export const discardPendingHunksForDocument/)
  assert.match(appSource, /const snapshotDocKeyForTab = \(tb\) =>/)
  assert.match(appSource, /const closingDocumentId = agentDocumentKeyForTab\(tb\)/)
  assert.match(appSource, /pendingHunksBelongToDocument\(closingDocumentId\)/)
  assert.match(appSource, /discardPendingHunksForDocument\(closingDocumentId\)/)
  assert.match(storeSource, /const deferredHunkReviews = new Map\(\)/)
  assert.match(storeSource, /const hunkOwners = new Map\(\)/)
  assert.match(storeSource, /hunkOwners\.set\(h\.id,/)
  assert.match(storeSource, /deferredHunkReviews\.set\(id, status\)/)
  assert.match(storeSource, /persistDetachedSession\(owner\.chatKey, owner\.session\)/)
  assert.match(storeSource, /applyDeferredHunkReviews\(buildRunReceipt/)
})

test('common source and configuration files are visible as workspace text', () => {
  for (const name of [
    'App.vue', 'agentStore.js', 'types.ts', 'styles.css', 'package.json',
    'config.yaml', 'script.py', 'main.c', 'Cargo.toml', 'Dockerfile', '.gitignore',
    'README', 'LICENSE'
  ]) {
    assert.equal(detectFtype(name), 'code', `${name} should be workspace-readable code/text`)
  }
  assert.equal(detectFtype('notes.md'), 'md')
  assert.equal(detectFtype('archive.zip'), null)
  assert.match(appSource, /depth > 12/)
  assert.match(appSource, /\['\.git', '\.svn', '\.hg'/)
  assert.doesNotMatch(appSource, /name\.startsWith\('\.'\)/)
  assert.match(appSource, /AGENT_TEXT_FILE_RE/)
  assert.match(appSource, /segs\.some\(\(s\) => s === '\.' \|\| s === '\.\.'\)/)
})

test('workspace text editing rejects binary formats and preserves source fidelity', () => {
  assert.match(storeSource, /WORKSPACE_EDITABLE_TEXT_RE/)
  assert.match(storeSource, /code: 'UNSUPPORTED_FILE_TYPE'/)
  assert.match(appSource, /error: 'unsupported_type'/)
  assert.match(appSource, /TextDecoder\('utf-8', \{ fatal: true \}\)/)
  assert.match(storeSource, /const originalEol = diskRaw\.includes\('\\r\\n'\)/)
  assert.match(storeSource, /const matches = \[\.\.\.diskRaw\.matchAll\(matchRe\)\]/)
  assert.match(storeSource, /diskRaw\.slice\(0, hit\.index\)/)
  assert.match(storeSource, /e === 'stale_file'/)
  assert.match(appSource, /error: 'stale_file'/)
})

test('code files preview as text and workspace search includes code', () => {
  assert.match(appSource, /'txt', 'csv', 'rtf', 'code'/)
  assert.match(appSource, /\['md', 'txt', 'csv', 'rtf', 'code'\]\.includes\(n\.ftype\)/)
  assert.match(appSource, /foo\.js → foo\.ts must not become foo\.ts\.js/)
  assert.match(appSource, /Extensionless build\/config filenames are first-class text files/)
})
