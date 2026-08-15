import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { detectFtype } from '../src/lib/fileReader.js'
import {
  agentResourceScopeKey,
  agentResourceScopeTag,
  agentResourceStorageKey
} from '../src/lib/agentResourceScope.js'
import {
  canonicalAgentWorkspaceId,
  historicalWindowsAgentWorkspaceId
} from '../src/lib/agentWorkspaceKey.js'
import {
  lineRangeWasRead,
  mergeLineRanges,
  minimalDocumentLineHunk,
  textSpanLineRange
} from '../src/lib/documentTarget.js'
import { pendingAsyncKeyLockCount, withAsyncKeyLock } from '../src/lib/asyncKeyLock.js'

const storeSource = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
const appSource = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
const panelSource = fs.readFileSync(new URL('../src/components/AgentPanel.vue', import.meta.url), 'utf8')
const richEditorSource = fs.readFileSync(new URL('../src/components/RichEditor.vue', import.meta.url), 'utf8')
const styleSource = fs.readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
const ledgerSource = fs.readFileSync(new URL('../src/lib/agentExecutionLedger.js', import.meta.url), 'utf8')
const preloadSource = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8')
const mainSource = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8')
const resumeStoreSource = fs.readFileSync(new URL('../electron/agent-download-resume-store.cjs', import.meta.url), 'utf8')
const sandboxSource = fs.readFileSync(new URL('../electron/agent-sandbox-service.cjs', import.meta.url), 'utf8')
const writableFileSource = fs.readFileSync(new URL('../src/lib/agentWorkspaceFile.js', import.meta.url), 'utf8')

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
  assert.match(storeSource, /runContext\.workspaceManifest = files\.map/)
  assert.match(storeSource, /runContext\.workspaceInspected = true/)
  assert.match(storeSource, /WORKSPACE_WRITE_TOOLS\.has\(name\) && !runContext\.workspaceInspected/)
  assert.match(storeSource, /code: 'WORKSPACE_NOT_INSPECTED'/)
  assert.match(storeSource, /case 'list_files': \{\s+const bridgeOptions = workspaceBridgeOptions\(runContext\)\s+let refreshed = null\s+if \(typeof agentBridge\.refreshWorkspace/)
  assert.match(storeSource, /code: 'WORKSPACE_REFRESH_FAILED'/)
  assert.match(storeSource, /if \(!Array\.isArray\(refreshed\)\) throw new Error\('WORKSPACE_REFRESH_FAILED'\)/)
})

test('workspace mutations that bypass staged diffs require program-owned allow-once approval', () => {
  assert.match(storeSource, /DIRECT_MUTATION_PERMISSION_TOOLS = new Set\(\['edit_file', 'batch_process', 'create_file', 'create_folder', 'move_file', 'rename_file', 'run_command', 'run_code', 'download_file'\]\)/)
  assert.match(storeSource, /const permission = await authorizeDirectMutation\(name, input, signal, callMeta, runContext\)/)
  assert.match(storeSource, /deniedPermissionKeys: new Set\(\)/)
  assert.match(storeSource, /code: 'USER_DECLINED'/)
  assert.match(storeSource, /callId: String\(callMeta\?\.callId \|\| ''\)/)
  assert.match(panelSource, /agentPermission\.value\.sessionId === activeSessionId\.value/)
  assert.match(storeSource, /window\.knoteDesktop\?\.agentCommandRun/)
  assert.match(preloadSource, /agentCommandEnabled: false/)
  assert.match(storeSource, /agentCommandEnabled === true/)
  assert.match(storeSource, /当前宿主执行被禁止/)
  assert.match(storeSource, /主进程验证固定 AppContainer runtime/)
})

test('the dormant browser task prototype retains exact approval and run-owned lifecycle controls', () => {
  assert.match(storeSource, /const runCodePermissionSummary = async/)
  assert.match(storeSource, /SHA-256: \$\{codeHash\}/)
  assert.match(storeSource, /key: `run_code:\$\{codeHash\}:\$\{normalized\.timeoutMs\}`/)
  assert.match(panelSource, /permission\.tool === 'run_code'/)
  assert.match(appSource, /agent_permission_run_code: '执行隔离 JavaScript'/)
  assert.match(storeSource, /run_code 立即返回 task_id，不代表代码已完成/)
  assert.match(storeSource, /生产环境 fail-closed/)
  assert.match(storeSource, /必须用 task_wait 检查到终态/)
  assert.match(storeSource, /sandboxTaskIds: new Set\(\)/)
  assert.match(storeSource, /abortController\.signal\.addEventListener\('abort', runContext\.cancelSandboxTasksOnAbort/)
  assert.match(storeSource, /if \(!rendererUnloading\) await cancelRunSandboxTasks\(runContext\)/)
  const executor = storeSource.slice(storeSource.indexOf('const execRunCode ='), storeSource.indexOf('const normalizeTaskToolInput ='))
  assert.match(executor, /agentSandboxCapabilities/)
  assert.match(executor, /agentSandboxStart/)
  assert.match(executor, /task\.code_hash !== codeHash/)
  assert.doesNotMatch(executor, /agentCommandRun|showMessageBox|native/i)
})

test('unverified Chromium execution is hidden from the model and rejected by main IPC', () => {
  assert.match(preloadSource, /agentSandboxEnabled: false/)
  assert.match(storeSource, /desktop\?\.agentSandboxEnabled === true/)
  assert.match(sandboxSource, /available: false/)
  assert.match(sandboxSource, /network: 'unverified'/)
  assert.match(sandboxSource, /throw sandboxError\('SANDBOX_UNAVAILABLE'/)
})

test('desktop downloads are exact-call approved, cancellable, verified, and kept out of the renderer lane', () => {
  const rendererDownload = storeSource.slice(
    storeSource.indexOf('const execDownloadFile ='),
    storeSource.indexOf('const execWebSearch =')
  )
  assert.match(storeSource, /context\?\.workspaceBinding\?\.handle/)
  assert.match(storeSource, /typeof context\.workspaceBinding\.handle\._grantId === 'string'/)
  assert.match(storeSource, /typeof window\.knoteDesktop\?\.agentDownload === 'function'/)
  assert.match(storeSource, /if \(t\.name === 'download_file'\) return hasFolder && nativeAgentDownload\(context\)/)
  assert.match(storeSource, /WORKSPACE_WRITE_TOOLS = new Set\([^\n]*'download_file'/)
  assert.match(storeSource, /\.filter\(\(name\) => name !== 'download_file'\)/)
  assert.match(storeSource, /key: `\$\{name\}:\$\{normalized\.path\.toLowerCase\(\)\}`/)
  assert.match(storeSource, /target: normalized\.url,[\s\S]{0,120}destination: normalized\.path,[\s\S]{0,120}maxBytes: normalized\.maxBytes/)
  assert.match(storeSource, /signal\?\.addEventListener\('abort', cancelDownload/)
  assert.match(storeSource, /desktop\.agentDownloadCancel\?\.\(id\)/)
  assert.match(storeSource, /await desktop\.agentDownload\(\{/)
  assert.match(storeSource, /result\.relativePath === normalized\.path/)
  assert.match(storeSource, /\^\[a-f0-9\]\{64\}\$/)
  assert.match(storeSource, /type: 'file_downloaded'/)
  assert.match(storeSource, /source: 'streamed_quarantine_atomic_publish_readback_motw'/)
  assert.match(storeSource, /streamedToPrivateQuarantine: true/)
  assert.match(storeSource, /atomicPublish: true/)
  assert.match(storeSource, /internetZoneMarked:/)
  assert.doesNotMatch(rendererDownload, /downloadOutcomeUncertain|结果未知|重新检查原工作区/)
  assert.match(preloadSource, /invokeTrackedAgentDownload/)
  assert.match(preloadSource, /cancelTrackedAgentDownload/)
  assert.match(preloadSource, /await entry\.done/)
  assert.match(preloadSource, /if \(result\?\.ok === true\) return result/)
  const mainDownload = mainSource.slice(
    mainSource.indexOf('const SAFE_DOWNLOAD_FILESYSTEM_ERRORS ='),
    mainSource.indexOf('const publicWebFailure =')
  )
  assert.match(mainDownload, /AGENT_DOWNLOAD_SNIFF_BYTES/)
  assert.match(mainDownload, /for await \(const rawChunk of res\)/)
  assert.match(mainDownload, /downloadResumeStore\.create\(/)
  assert.match(mainSource, /'agent-download-quarantine', 'v2'/)
  assert.match(resumeStoreSource, /class AgentDownloadResumeStore/)
  assert.match(resumeStoreSource, /\.meta\.\$\{slot\}/)
  assert.match(resumeStoreSource, /await entry\.part\.handle\.sync\(\)/)
  assert.match(mainDownload, /verificationSource: 'streamed_quarantine_atomic_publish_readback_motw'/)
  assert.match(mainDownload, /publication: 'atomic_hard_link_no_replace'/)
  assert.match(mainDownload, /Zone\.Identifier/)
  assert.match(mainDownload, /AGENT_DOWNLOAD_STAGE_MARKER_STREAM/)
  assert.match(mainDownload, /fs\.linkSync\(stagingPath, target\)/)
  assert.match(mainDownload, /Number\(publishedStat\.nlink\) !== 1/)
  assert.match(mainDownload, /DOWNLOAD_DESTINATION_BUSY/)
  assert.match(mainDownload, /AGENT_DOWNLOAD_INACTIVITY_TIMEOUT_MS/)
  assert.match(mainDownload, /AGENT_DOWNLOAD_TOTAL_TIMEOUT_MS/)
  assert.match(mainDownload, /Accept-Encoding', 'identity'/)
  assert.match(mainDownload, /Range: `bytes=\$\{state\.bytes\}-`/)
  assert.match(mainDownload, /'If-Range': entry\.metadata\.validator\.value/)
  assert.match(mainDownload, /DOWNLOAD_RANGE_MISMATCH/)
  assert.match(mainDownload, /DOWNLOAD_PAUSED/)
  assert.match(mainDownload, /ENOSPC[\s\S]*EDQUOT[\s\S]*EFBIG[\s\S]*EACCES[\s\S]*EPERM[\s\S]*EROFS[\s\S]*EIO/)
  assert.doesNotMatch(mainDownload, /Buffer\.concat/)
  assert.ok(mainDownload.indexOf('reserveAgentDownloadDestination(destination, id)') < mainDownload.indexOf('streamAgentDownloadToQuarantine(request.url'))
  assert.match(storeSource, /DOWNLOAD_REDIRECT_APPROVAL_REQUIRED/)
  assert.match(storeSource, /authorizeDirectMutation\('download_file', redirectInput/)
  assert.doesNotMatch(storeSource, /data:\s*\{[^}]*redirect_url/s)
  assert.match(storeSource, /跳转网址及查询凭据不会进入持久 activity\/trace/)
  assert.match(storeSource, /HTTPS 降级到 HTTP 一律拒绝/)
  assert.match(storeSource, /目标父目录必须已经存在；需要新目录时先调用 create_folder/)
  assert.match(storeSource, /目标父目录不存在；请先调用 create_folder/)
  assert.match(storeSource, /'DOWNLOAD_PARENT_MISSING'/)

  const validation = storeSource.slice(
    storeSource.indexOf('const normalizeRendererDownloadInput ='),
    storeSource.indexOf('const finalDownloadUrlLooksPublic =')
  )
  assert.match(validation, /AGENT_DOWNLOAD_UNSAFE_TEXT_RE\.test\(url\)/)
  assert.match(validation, /parsed\.username \|\| parsed\.password/)
  assert.match(validation, /portableWorkspacePathError\(path\)/)
  assert.match(validation, /if \(input\?\.max_bytes !== undefined\)/)
  assert.match(validation, /Number\.isSafeInteger\(input\.max_bytes\)/)
  assert.match(validation, /let maxBytes = null/)
  assert.match(validation, /resume_id/)
  assert.doesNotMatch(validation, /AGENT_DOWNLOAD_(?:DEFAULT|MAX)_BYTES/)

  const executeStart = storeSource.indexOf('const executeTool =')
  const executeEnd = storeSource.indexOf('const ACTIVITY_LABEL', executeStart)
  const execute = storeSource.slice(executeStart, executeEnd)
  const permissionAt = execute.indexOf('await authorizeDirectMutation(name, input, signal, callMeta, runContext)')
  const dispatchAt = execute.indexOf("case 'download_file': return await execDownloadFile")
  assert.ok(permissionAt >= 0 && dispatchAt > permissionAt)
})

test('native web requests forward AbortSignal without a renderer-only abort race', () => {
  assert.match(storeSource, /nd\.webSearch\(q, 8, provider\.searchEngine, provider\.searchRegion, \{ signal \}\)/)
  assert.match(storeSource, /nd\.webFetch\(u, 3_000_000, \{ signal \}\)/)
  assert.doesNotMatch(storeSource, /const abortRace|Promise\.race\(\[nd\.web/)
  assert.match(storeSource, /final_url: finalUrl,[\s\S]{0,160}content_type:[\s\S]{0,160}bytes:[\s\S]{0,160}clipped:/)
})

test('explicit line ranges are complete evidence without requiring the rest of a large file', () => {
  assert.match(storeSource, /const wholeSource = options\.start_line === 1 && options\.end_line === totalLines/)
  assert.match(storeSource, /const coverage = eof \? 'eof' : page\.hasMore \? 'partial' : wholeSource \? 'complete' : 'requested_range'/)
  assert.match(storeSource, /requestedRangeComplete: !page\.hasMore,[\s\S]{0,120}sourceComplete: true,[\s\S]{0,120}projectionComplete: true/)
  assert.match(storeSource, /code: 'DOCUMENT_READ',[\s\S]{0,360}grounding: sourcePage\.contract\.grounding/)
  assert.match(storeSource, /code: 'FILE_READ',[\s\S]{0,360}grounding: sourcePage\.contract\.grounding/)
})

test('renderer mutation lane preserves an active task result while rejecting queued aborted work', () => {
  const start = storeSource.indexOf('const drainRendererMutationLane =')
  const end = storeSource.indexOf('const enqueueRendererMutation =', start)
  const lane = storeSource.slice(start, end)
  assert.match(lane, /if \(job\.signal\?\.aborted\) \{[\s\S]{0,180}job\.reject\(rendererMutationAbortError\(\)\)/)
  assert.match(lane, /\.then\(\(value\) => \{[\s\S]{0,220}job\.resolve\(value\)/)
  assert.doesNotMatch(lane, /\.then\(\(value\) => \{[\s\S]{0,160}job\.signal\?\.aborted/)
  assert.doesNotMatch(lane, /if \(job\.signal\?\.aborted\) throw/)
})

test('partial physical-line bytes never become edit coverage', () => {
  assert.match(storeSource, /const exposeCompleteSourceLines =/)
  assert.match(storeSource, /halfOpenRangeCovered\(ranges, 0, fragment\.totalBytes\)/)
  assert.match(storeSource, /sourcePage\.page\.fragments,[\s\S]{0,180}\(line\) => recordReadRange\(runContext, line, line\)/)
})

test('a run keeps immutable workspace and exact-tab document bindings across navigation', () => {
  assert.match(storeSource, /code: 'WORKSPACE_CHANGED'/)
  assert.match(storeSource, /code: 'DOCUMENT_CHANGED'/)
  assert.match(storeSource, /usesDocument && !hasBoundDocument/)
  assert.match(storeSource, /workspaceBinding = agentBridge\.captureWorkspace/)
  assert.match(storeSource, /workspaceBinding,/)
  assert.match(storeSource, /captureDocumentById\(queuedDocumentId\)/)
  assert.match(storeSource, /documentBinding,/)
  assert.match(storeSource, /releaseRunDocumentBindings\(runContext\)/)
  assert.match(storeSource, /readRunDocument\(runContext\)/)
  assert.match(storeSource, /workspaceBridgeOptions =/)
  assert.match(appSource, /resolveAgentWorkspaceBinding/)
  assert.match(appSource, /refreshAgentWorkspaceBinding/)
  assert.match(appSource, /agentBridge\.captureCurrentDocument/)
  assert.match(appSource, /agentBridge\.captureDocumentById/)
  assert.match(appSource, /agentBridge\.captureDocumentByWorkspacePath/)
  assert.match(appSource, /agentBridge\.readBoundDocument/)
  assert.match(appSource, /agentBridge\.getDocumentBindingStatus/)
  assert.match(appSource, /agentBridge\.releaseDocumentBinding/)
  assert.match(appSource, /TARGET_CLOSED/)
  assert.match(appSource, /TARGET_REPLACED/)
  assert.match(appSource, /TARGET_UNAVAILABLE/)
  assert.match(appSource, /relativeImages: isActive \? \{ \.\.\.relImages \} : \{\}/)
  assert.match(storeSource, /expandImages\(prepared\.text, sourceRaw, bridgeOptions\)/)
  assert.match(storeSource, /persistDetachedSession\(runChatKey, runSession\)/)
  assert.match(storeSource, /if \(runChatKey === chatKey\) \{[\s\S]{0,180}persistChat\(\{ allowDurableFallback: true \}\)/)
  assert.match(storeSource, /const readFiles = runContext\.lastReadFiles/)
  assert.match(storeSource, /lastReadFiles: \{\}/)
  assert.match(storeSource, /function attachRunSessionToLoadedWorkspace\(session\)/)
  assert.match(storeSource, /for \(const context of activeRuns\.values\(\)\) \{\s+if \(context\.chatKey === ownerKey\) attachRunSessionToLoadedWorkspace\(context\.session\)/)
  assert.match(storeSource, /attachRunSessionToLoadedWorkspace\(runSession\)/)
})

test('same-content documents cannot share read freshness or pending edits', () => {
  assert.match(storeSource, /lastReadDocumentId: null/)
  assert.match(storeSource, /runContext\.lastReadDocumentId !== documentId/)
  assert.match(storeSource, /let hunksBaseDocumentId = null/)
  assert.match(storeSource, /documentId !== hunksBaseDocumentId/)
  assert.match(storeSource, /currentDocumentId !== hunksBaseDocumentId/)
  assert.match(storeSource, /pendingHunksForCurrentDocument/)
  assert.match(appSource, /const agentDocumentKeyForTab = \(tb\) =>/)
  assert.match(appSource, /::tab:\$\{tb\.id\}/)
  assert.match(appSource, /::generation:\$\{tb\.documentGeneration \|\| 1\}/)
  assert.match(appSource, /agentBridge\.getDocumentIdentity = \(\) => agentDocumentKey\(\)/)
  assert.match(appSource, /v-if="pendingHunksForCurrentDocument\.length/)
  assert.match(appSource, /watch\(\(\) => agentDocumentKey\(\)/)
})

test('folder navigation keeps one visible Agent surface while document bindings stay exact', () => {
  assert.match(appSource, /const agentSurfaceDocumentKeyForTab = \(tb\) =>/)
  assert.match(appSource, /hasFolderWorkspace \? 'folder-workspace' : agentDocumentKeyForTab\(tb\)/)
  assert.match(appSource, /documentId: agentSurfaceDocumentKeyForTab\(tb\)/)
  assert.match(appSource, /agentBridge\.getDocumentIdentity = \(\) => agentDocumentKey\(\)/)
})

test('pending hunk review is locked by its exact run owner or post-owner automatic reviewer', () => {
  assert.match(storeSource, /activeRunFor\(owner\.chatKey, owner\.sessionId\)/)
  assert.match(storeSource, /context\?\.runId === owner\.runId/)
  assert.match(storeSource, /pendingBatchReviewLocked = \(\) => pendingBatchOwnerRunning\(\) \|\| pendingHunks\.value\.some/)
  assert.match(storeSource, /automaticHunkReviewIds\.has\(String\(hunk\.id\)\)/)
  assert.match(storeSource, /export const pendingHunksReviewLocked = computed\(pendingBatchReviewLocked\)/)

  const preview = storeSource.slice(storeSource.indexOf('const syncPreview ='), storeSource.indexOf('export const resyncAgentPreview'))
  assert.doesNotMatch(preview, /hasActiveRuns|agentStatus/)
  assert.match(preview, /reviewLocked = pendingBatchReviewLocked\(\)/)
  assert.match(preview, /scrollTo: reviewLocked \? null : scrollTo/)

  for (const name of ['acceptHunk', 'rejectHunk', 'acceptAllHunks', 'rejectAllHunks']) {
    const start = storeSource.indexOf(`export const ${name} =`)
    const end = storeSource.indexOf('\nexport const ', start + 1)
    const action = storeSource.slice(start, end < 0 ? undefined : end)
    assert.match(action, /reviewActionBlocked\(\)/, `${name} must use the shared owner lock`)
  }

  const reviewBar = appSource.slice(appSource.indexOf('<!-- Agent review bar'), appSource.indexOf('<!-- Transient agent notice'))
  assert.match(reviewBar, /v-if="pendingHunksForCurrentDocument\.length"/)
  assert.doesNotMatch(reviewBar, /agentStatus/)
  assert.match(reviewBar, /:disabled="pendingHunksReviewLocked"/)
  assert.match(reviewBar, /agent-reject-all/)
  assert.match(reviewBar, /agent-accept-all/)
  assert.match(richEditorSource, /b\.disabled = !!payload\.reviewLocked/)
  assert.match(richEditorSource, /`agent-hunk-\$\{h\.id\}-\$\{lockKey\}`/)
})

test('new Agent surfaces use Knote brand tokens while mature geometry stays unchanged', () => {
  assert.match(panelSource, /:data-agent-theme="agentConfig\.chatTheme === 'aurora' \? 'aurora' : 'white'"/)
  assert.match(panelSource, /data-testid="`agent-theme-\$\{theme\}`"/)
  assert.match(panelSource, /container:agent-chat \/ inline-size/)
  assert.match(panelSource, /font-size:clamp\(30px,12cqi,48px\)/)
  assert.match(panelSource, /knote-agent-title-flow/)
  assert.doesNotMatch(panelSource, /knote-agent-empty-brand::(?:before|after)/)
  assert.doesNotMatch(panelSource, /knote-agent-liquid-field/)
  assert.match(panelSource, /\.knote-agent-panel::before\{[\s\S]{0,500}animation:agentAurora/)
  assert.match(panelSource, /\.knote-agent-panel::after\{[\s\S]{0,420}animation:agentAuroraSecondary/)
  assert.match(panelSource, /data-agent-theme="white"\]\::before,[^\n]*display:none/)
  assert.match(panelSource, /@media\(prefers-reduced-motion:reduce\)/)
  assert.match(panelSource, /data-testid="agent-activity-row"/)
  assert.match(panelSource, /knote-agent-activity-row::before/)
  assert.doesNotMatch(panelSource, /class="rounded-lg border px-2 py-1\.5 transition-colors"/)
  assert.match(styleSource, /--knote-brand:\s*#84cc16/)
  assert.match(styleSource, /--knote-brand-strong:\s*#4d7c0f/)
  assert.match(styleSource, /--knote-theme:\s*#f7bd18/)
  assert.match(styleSource, /--knote-brand-warm:\s*var\(--knote-theme\)/)

  const titleCss = panelSource.slice(panelSource.indexOf('.knote-agent-empty-brand{'), panelSource.indexOf('.knote-agent-empty-state h3{'))
  assert.match(titleCss, /var\(--knote-brand\)/)
  assert.match(titleCss, /var\(--knote-theme\)/)
  assert.match(titleCss, /var\(--color-base-content\)/)
  assert.doesNotMatch(titleCss, /--color-(?:primary|accent|success)|--agent-(?:primary|accent|success)/)
  assert.doesNotMatch(panelSource, /var\(--color-(?:primary|accent)/)

  assert.match(panelSource, /\.knote-agent-session-trigger\{[\s\S]{0,120}border-radius:10px/)
  assert.match(panelSource, /\.knote-agent-session-popover\{[\s\S]{0,180}border-radius:24px/)
  assert.match(panelSource, /\.knote-agent-settings-card\{[\s\S]{0,220}border-radius:19px/)
  assert.match(panelSource, /\.knote-agent-protocol-switch\{[^\n]*border-radius:12px/)
  assert.match(panelSource, /\.knote-agent-suggestions button\{[^\n]*border-radius:12px/)
  assert.match(panelSource, /\.knote-agent-message\{[^\n]*border-radius:16px/)
  assert.match(panelSource, /\.knote-agent-message-assistant\{[^\n]*border-top-left-radius:7px/)
  assert.match(panelSource, /\.knote-agent-message-user\{[\s\S]{0,180}border-top-right-radius:7px/)
  assert.match(panelSource, /--agent-composer-radius:18px/)
  assert.match(panelSource, /\.knote-agent-composer\{[^\n]*border-radius:var\(--agent-composer-radius\)/)
  assert.match(panelSource, /\.knote-agent-icon-control\.is-send\{[^\n]*width:32px[^\n]*border-radius:10px/)
  assert.match(panelSource, /\.knote-agent-question-rail-list\{[\s\S]{0,240}border-radius:20px/)

  const reviewBar = appSource.slice(appSource.indexOf('<!-- Agent review bar'), appSource.indexOf('<!-- Transient agent notice'))
  assert.match(reviewBar, /knote-agent-review-(?:pulse|accept)/)
  assert.doesNotMatch(reviewBar, /(?:bg|btn|text|border)-primary/)
  assert.match(appSource, /\.knote-agent-review-pulse[^}]*var\(--knote-brand\)/)
  const reviewAcceptCss = appSource.slice(appSource.indexOf('.knote-agent-review-accept {'), appSource.indexOf('.knote-dialog-brand-action {'))
  assert.match(reviewAcceptCss, /border-color:\s*var\(--knote-brand\)/)
  assert.match(reviewAcceptCss, /background:\s*var\(--knote-brand\)/)
  assert.match(panelSource, /knote-agent-activity-row\[data-status="running"\]::before\{background:var\(--knote-brand\)\}/)
  assert.match(panelSource, /knote-agent-activity-row\[data-status="done"\]::before\{background:var\(--color-success\)\}/)
  assert.match(panelSource, /knote-agent-activity-row\[data-status="error"\]::before\{background:var\(--color-error\)\}/)
  assert.match(appSource, /\.knote-app-dialog-card[\s\S]{0,420}var\(--color-base-content\)[\s\S]{0,420}var\(--color-base-100\)/)
})

test('desktop workspace separators canonicalize without folding case-sensitive identities', () => {
  assert.equal(canonicalAgentWorkspaceId('folder:C:\\Users\\Writer\\Notes\\'), 'folder:C:/Users/Writer/Notes')
  assert.equal(canonicalAgentWorkspaceId('folder:C:/Users/Writer/Notes'), 'folder:C:/Users/Writer/Notes')
  assert.notEqual(canonicalAgentWorkspaceId('folder:C:/Users/Writer/Notes'), canonicalAgentWorkspaceId('folder:C:/Users/Writer/notes'))
  assert.equal(historicalWindowsAgentWorkspaceId('folder:C:\\Users\\Writer\\Notes\\'), 'folder:c:/users/writer/notes')
  assert.equal(historicalWindowsAgentWorkspaceId('file://SERVER/Share/Doc.md'), 'file://server/share/doc.md')
  assert.equal(historicalWindowsAgentWorkspaceId('native:Documents:Knote/CaseSensitive.md'), '')
  assert.equal(canonicalAgentWorkspaceId('file://SERVER/Share/Doc.md'), 'file://SERVER/Share/Doc.md')
  assert.equal(canonicalAgentWorkspaceId('native:Documents:Knote/CaseSensitive.md'), 'native:Documents:Knote/CaseSensitive.md')
  assert.equal(canonicalAgentWorkspaceId('folder:Display Name'), 'folder:Display Name')
})

test('same-id migrated sessions project only their exact workspace run context', () => {
  assert.match(storeSource, /export const runningChatKey = ref\(null\)/)
  assert.match(storeSource, /export const activeChatKey = ref\('knote-agent-chat'\)/)
  const projectionStart = storeSource.indexOf('const projectActiveRunUi =')
  const projectionEnd = storeSource.indexOf('watch([activeChatKey, activeSessionId]', projectionStart)
  const projection = storeSource.slice(projectionStart, projectionEnd)
  assert.match(projection, /activeRunFor\(activeChatKey\.value, activeSessionId\.value\)/)
  assert.match(projection, /runningChatKey\.value = context\?\.chatKey \|\| null/)
  assert.match(projection, /agentQuestion\.value = context\?\.question \|\| null/)
  assert.match(projection, /agentPermission\.value = context\?\.permission \|\| null/)
  assert.match(panelSource, /agentQuestion\.value\.chatKey === activeChatKey\.value/)
  assert.match(panelSource, /agentQuestion\.value\.sessionId === activeSessionId\.value/)
})

test('document residency leases block cooling and cold capture never activates a tab', () => {
  assert.match(appSource, /agentResidencyLeases: 0/)
  assert.match(appSource, /if \(Number\(tb\?\.agentResidencyLeases \|\| 0\) > 0\) return false/)
  assert.match(appSource, /tb\.agentResidencyLeases = Number\(tb\.agentResidencyLeases \|\| 0\) \+ 1/)
  assert.match(appSource, /await hydrateTab\(tb\)/)
  const captureStart = appSource.indexOf('const captureAgentDocumentTab = async')
  const captureEnd = appSource.indexOf('agentBridge.captureCurrentDocument', captureStart)
  assert.doesNotMatch(appSource.slice(captureStart, captureEnd), /switchTab\(/)
  assert.match(appSource, /state\.tab\.agentResidencyLeases = Math\.max\(0,/)
})

test('opened workspace files are buffer-first and stage the minimal exact-CAS hunk', () => {
  assert.match(storeSource, /captureOpenWorkspaceDocument\(path, runContext\)/)
  assert.match(storeSource, /const source = documentBinding \? 'open_buffer' : 'disk'/)
  assert.match(storeSource, /sourceRaw !== baseline/)
  assert.match(storeSource, /code: 'DOCUMENT_STALE'/)
  assert.match(storeSource, /minimalDocumentLineHunk\(sourceRaw, next\)/)
  assert.match(storeSource, /pending_file_hunk/)
  assert.match(storeSource, /文件和内存正文尚未改变/)
  assert.doesNotMatch(storeSource, /目标文件恰好在标签页中打开时 edit_file 会被拒绝/)

  assert.deepEqual(minimalDocumentLineHunk('a\nb\nc', 'a\nB\nc'), {
    kind: 'replace', start: 2, end: 2, oldLines: ['b'], newLines: ['B'], applyLines: ['B']
  })
  assert.deepEqual(minimalDocumentLineHunk('a\nc', 'a\nb\nc'), {
    kind: 'insert', after: 1, oldLines: [], newLines: ['b'], applyLines: ['b']
  })
  assert.deepEqual(minimalDocumentLineHunk('a\nb\nc\nd', 'a\nB\nC\nd'), {
    kind: 'replace', start: 2, end: 3, oldLines: ['b', 'c'], newLines: ['B', 'C'], applyLines: ['B', 'C']
  })
})

test('pending review widgets retain source coordinates and non-text anchors', () => {
  const previewStart = storeSource.indexOf('const syncPreview =')
  const previewEnd = storeSource.indexOf('// repaint hook for the App', previewStart)
  const projection = storeSource.slice(previewStart, previewEnd)
  assert.match(projection, /baseLineCount: baseLines\.length/)
  assert.match(projection, /targetLine:/)
  assert.match(projection, /beforeText: nearestNonBlank/)
  assert.match(projection, /afterText: nearestNonBlank/)

  const decorationStart = richEditorSource.indexOf('const buildAgentPreviewDecos =')
  const decorationEnd = richEditorSource.indexOf('const AgentPreview =', decorationStart)
  const decoration = richEditorSource.slice(decorationStart, decorationEnd)
  assert.match(decoration, /child\.type\.name === 'image'/)
  assert.match(decoration, /h\.beforeText \|\| h\.anchorText/)
  assert.match(decoration, /h\.afterText/)
  assert.match(decoration, /Math\.round\(hint\)/)
  assert.doesNotMatch(decoration, /if \(!anchor\) \{\s*widgetPos = 0/)
})

test('renderer quit acknowledgement includes the Agent durability barrier and cancellation reset', () => {
  const flushStart = appSource.indexOf('const flushRendererStateForQuit =')
  const flushEnd = appSource.indexOf('const resetRendererQuitAfterCancellation =', flushStart)
  const flush = appSource.slice(flushStart, flushEnd)
  assert.match(flush, /await flushAgentForRendererShutdown\(\)/)
  assert.ok(flush.indexOf('await flushAgentForRendererShutdown()') < flush.indexOf('return { ok, recovered,'))
  assert.match(appSource.slice(flushEnd, appSource.indexOf('onMounted(() =>', flushEnd)), /resumeAgentSchedulingAfterRendererShutdown\(\)/)
  assert.match(storeSource, /await waitForAgentRunFinalization\(contexts, timeoutMs\)/)
  assert.match(storeSource, /flushAgentEvents\(\)/)
  assert.match(storeSource, /flushAgentChatState\(\)/)
})

test('web-search privacy copy discloses configured Jina fallback on desktop', () => {
  assert.match(appSource, /本地搜索失败时可能将搜索词发送给 Jina 作为备用/)
  assert.match(appSource, /a failed local search may send the query to Jina as a fallback/)
  assert.doesNotMatch(appSource, /搜索词不经第三方/)
  assert.doesNotMatch(appSource, /query text never goes through a third party/)
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
  assert.match(storeSource, /pdfProcessingStates\[uiResourceScope\(\)\] \|\| null/)
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

  const runStart = storeSource.indexOf('const executeAgentTurn = async')
  const runEnd = storeSource.indexOf('export const sendToAgent = async', runStart)
  const run = storeSource.slice(runStart, runEnd > runStart ? runEnd : undefined)
  assert.match(run, /runProvider = captureProviderConfig\(\)/)
  assert.match(run, /provider:\s*runProvider/)
  assert.match(run, /buildSystemPrompt\(useTools, runContext, runProvider\)/)
  assert.match(run, /callAnthropic\([^\n]+provider:\s*runProvider/)
  assert.match(run, /callOpenAI\([^\n]+provider:\s*runProvider/)
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
  assert.match(appSource, /depth > report\.depthLimit/)
  assert.match(appSource, /report\.omittedPaths\.push/)
  assert.match(storeSource, /code: 'WORKSPACE_TRAVERSAL_INCOMPLETE'/)
  assert.match(appSource, /\['\.git', '\.svn', '\.hg'/)
  assert.doesNotMatch(appSource, /name\.startsWith\('\.'\)/)
  assert.match(appSource, /isAgentEditableTextFile/)
  assert.match(writableFileSource, /classifyAgentWritableFile/)
  assert.match(writableFileSource, /extension === 'svg'/)
  assert.match(appSource, /segs\.some\(\(s\) => s === '\.' \|\| s === '\.\.'\)/)
})

test('workspace text editing rejects binary formats and preserves source fidelity', () => {
  assert.match(storeSource, /isAgentEditableTextFile/)
  assert.match(storeSource, /code: 'UNSUPPORTED_FILE_TYPE'/)
  assert.match(appSource, /error: 'unsupported_type'/)
  assert.match(appSource, /TextDecoder\('utf-8', \{ fatal: true \}\)/)
  assert.match(storeSource, /const originalEol = sourceRaw\.includes\('\\r\\n'\)/)
  assert.match(storeSource, /const matches = \[\.\.\.sourceRaw\.matchAll\(matchRe\)\]/)
  assert.match(storeSource, /sourceRaw\.slice\(0, hit\.index\)/)
  assert.match(storeSource, /e === 'stale_file'/)
  assert.match(appSource, /error: 'stale_file'/)
  const updateStart = appSource.indexOf('agentBridge.updateFile = async')
  const updateEnd = appSource.indexOf('// ---- workspace file management', updateStart)
  const update = appSource.slice(updateStart, updateEnd)
  assert.match(update, /window\.knoteDesktop\.fsWriteIfUnchanged\(absoluteMutationPath, output, expectedDiskContent\)/)
  assert.match(update, /if \(rootDesk\)[\s\S]*fsWriteIfUnchanged[\s\S]*else \{[\s\S]*fh\.createWritable\(\)/)
})

test('code files preview as text and workspace search includes code', () => {
  assert.match(appSource, /'txt', 'csv', 'rtf', 'code'/)
  assert.match(appSource, /\['md', 'txt', 'csv', 'rtf', 'code'\]\.includes\(n\.ftype\)/)
  assert.match(appSource, /foo\.js → foo\.ts must not become foo\.ts\.js/)
  assert.match(writableFileSource, /const NAMED_TEXT_FILES = new Set/)
})

test('line coverage merges only displayed ranges and maps every raw match conservatively', () => {
  let ranges = mergeLineRanges([], 1, 3)
  ranges = mergeLineRanges(ranges, 7, 8)
  ranges = mergeLineRanges(ranges, 4, 6)
  assert.deepEqual(ranges, [[1, 8]])
  assert.equal(lineRangeWasRead(ranges, 2, 8), true)
  assert.equal(lineRangeWasRead([[1, 2], [4, 5]], 2, 4), false)
  assert.deepEqual(textSpanLineRange('a\r\nb\nc', 3, 3), { start: 2, end: 3 })

  assert.match(storeSource, /ranges = mergeLineRanges\(ranges, line, line\)/)
  assert.match(storeSource, /lineByteRanges = exposeCompleteSourceLines/)
  assert.match(storeSource, /const selectedMatches = input\.replace_all \? matches : matches\.slice\(0, 1\)/)
  assert.match(storeSource, /\.map\(\(match\) => textSpanLineRange\(sourceRaw, match\.index, match\[0\]\.length\)\)/)
  assert.match(storeSource, /code: 'RANGE_NOT_READ'/)
})

test('canonical async file locks serialize peers and recover after rejection', async () => {
  const events = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const first = withAsyncKeyLock('test:file-a', async () => {
    events.push('first:start')
    await gate
    events.push('first:end')
  })
  const second = withAsyncKeyLock('test:file-a', async () => { events.push('second') })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(events, ['first:start'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(events, ['first:start', 'first:end', 'second'])
  await assert.rejects(withAsyncKeyLock('test:file-b', async () => { throw new Error('expected') }), /expected/)
  assert.equal(await withAsyncKeyLock('test:file-b', async () => 42), 42)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(pendingAsyncKeyLockCount(), 0)

  assert.match(appSource, /enqueueDocumentSave\(saveIdentity, \(\) => withAsyncKeyLock\(mutationKey/)
  assert.match(appSource, /return await withAsyncKeyLock\(mutationKey, async \(\) =>/)
  assert.match(appSource, /await resolveFileMutationKey\(binding\.handle, binding\.id, p, initialNode\?\.handle\)/)
})

test('delete confirmation follows review authority while exact target revalidation remains mandatory', () => {
  assert.match(storeSource, /const execDeleteFile = async \(input, signal, context\) =>/)
  assert.match(storeSource, /skipHumanReview = reviewProfile\.policy === AGENT_REVIEW_POLICIES\.ALLOW_ALL && reviewState\.allowAllGranted/)
  assert.match(storeSource, /const bridgeOptions = \{ \.\.\.\(workspaceBridgeOptions\(context\) \|\| \{\}\), signal, \.\.\.\(skipHumanReview \? \{ skipHumanReview: true \} : \{\}\) \}/)
  assert.match(storeSource, /case 'delete_file': return await execDeleteFile\(input, signal, runContext\)/)
  const start = appSource.indexOf('agentBridge.deleteFile = async')
  const end = appSource.indexOf('// Adopt scoped Agent bytes', start)
  const deletion = appSource.slice(start, end)
  assert.match(deletion, /if \(options\?\.skipHumanReview !== true\)/)
  assert.match(deletion, /confirmDialog\([\s\S]*\{ owner: `agent-delete:[\s\S]*signal \}/)
  assert.match(deletion, /withAsyncKeyLock\(mutationKey/)
  assert.match(deletion, /await refreshAgentWorkspaceBinding\(latestBinding\)/)
  assert.match(deletion, /relFileOpenInTab\(clean, latestBinding\.handle\)/)
  assert.match(deletion, /deleteEntryMatches\(initial, latestNode\)/)
  assert.match(deletion, /sameDeleteStatIdentity\(initial\.stat, latest\.stat\)/)
  assert.match(deletion, /if \(signal\?\.aborted\) return \{ ok: false, error: 'aborted' \}/)
})

test('queued prompt promotion atomically transfers one exact document binding', () => {
  const prepareStart = storeSource.indexOf('const prepareQueuedPromptStart = async')
  const prepareEnd = storeSource.indexOf('\nconst updateQueuedRuntime =', prepareStart)
  const prepare = storeSource.slice(prepareStart, prepareEnd)
  assert.match(prepare, /const promptSnapshot = snapshotQueuedPrompt\(item\)/)
  assert.ok(prepare.indexOf('snapshotQueuedPrompt(item)') < prepare.indexOf('await agentBridge.captureDocumentById'))
  assert.match(prepare, /queuedPromptSnapshotIndex\(session, promptSnapshot\) < 0/)
  assert.match(prepare, /if \(binding && !transferred\)/)

  const runStart = storeSource.indexOf('const executeAgentTurn = async')
  const runEnd = storeSource.indexOf('\nlet queueDrainScheduled', runStart)
  const run = storeSource.slice(runStart, runEnd)
  assert.match(run, /let documentBinding = extra\?\.documentBinding \|\| null/)
  assert.match(run, /if \(extra\?\.promptId && queueIndex < 0\) return false/)
  assert.match(run, /extra\?\.promptId\s+\? null\s+: await agentBridge\.captureCurrentDocument/)
  assert.match(run, /documentBindingTransferred = true/)
  assert.match(run, /if \(documentBinding && !documentBindingTransferred\)/)
  assert.doesNotMatch(run, /runSession\.queue\.splice\(-1/)
  assert.match(storeSource, /documentBinding: prepared\.binding,[\s\S]{0,100}promptSnapshot: prepared\.promptSnapshot/)
  assert.match(storeSource, /\.catch\(\(error\) => \{\s+ensureSessionRuntime\(session\)\.lastError = `QUEUE_PROMOTION_FAILED/)
})

test('tab close is an atomic barrier against captures, staging, and residual leases', () => {
  const closeStart = appSource.indexOf('const closeTab = async')
  const closeEnd = appSource.indexOf('// Ctrl+Tab', closeStart)
  const close = appSource.slice(closeStart, closeEnd)
  assert.ok(close.indexOf('tb.agentClosing = true') < close.indexOf('await '))
  assert.match(close, /stopAgentRunsForDocument\(closingDocumentId\)/)
  assert.match(close, /await waitForAgentDocumentLeases\(tb\)/)
  assert.match(close, /pendingHunksBelongToDocument\(closingDocumentId\) \|\| Number\(tb\.agentResidencyLeases/)
  assert.match(appSource, /if \(tb\.agentClosing\) return documentTargetFailure\('TARGET_CLOSED', 'tab_closing'\)/)
  assert.match(storeSource, /const latest = readRunDocument\(context, target\.binding/)
  assert.match(storeSource, /export const stopAgentRunsForDocument/)
})

test('workspace-path binding fails closed when more than one editable tab matches', () => {
  const captureStart = appSource.indexOf('agentBridge.captureDocumentByWorkspacePath = async')
  const captureEnd = appSource.indexOf('agentBridge.readBoundDocument', captureStart)
  const capture = appSource.slice(captureStart, captureEnd)
  assert.match(capture, /const candidates = new Set\(\)/)
  assert.match(capture, /targetNode\.handle\.isSameEntry\(tabFileHandle\)/)
  assert.match(capture, /if \(candidates\.size > 1\) return documentTargetFailure\('TARGET_AMBIGUOUS'/)
  assert.match(storeSource, /TARGET_AMBIGUOUS:/)
})

test('hunk ownership and staged-file durability remain explicit in receipts', () => {
  assert.match(storeSource, /sessionId: String\(context\?\.sessionId/)
  assert.match(storeSource, /runId: String\(context\?\.runId/)
  assert.match(storeSource, /documentId: latest\.documentId/)
  assert.match(storeSource, /code: 'HUNK_NOT_OWNED'/)
  assert.match(storeSource, /durability: type === 'pending_file_hunk' \? 'pending_review_not_saved'/)
  assert.match(ledgerSource, /!String\(e\.mutation\.type \|\| ''\)\.startsWith\('pending_'\)/)
  assert.match(ledgerSource, /pendingFileHunkIds: outcome\.pendingFileIds/)
  assert.match(panelSource, /agent_receipt_file_staged/)
  assert.match(panelSource, /agent_receipt_file_accepted/)
})

test('internal image ids are limited to the exact bound baseline or run scope', () => {
  assert.match(storeSource, /const baselineIds = new Set\(validateInternalImageReferences\(baselineText/)
  assert.match(storeSource, /if \(baselineIds\.has\(id\)\) return true/)
  assert.match(storeSource, /if \(baselineIds\.has\(id\)\) continue/)
  assert.match(storeSource, /prepareModelImageRefs\(newStr\.replace\([^\n]+, sourceRaw\)/)
})
