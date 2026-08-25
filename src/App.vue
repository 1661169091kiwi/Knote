<script setup>
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch, watchEffect } from 'vue'
import MarkdownIt from 'markdown-it'
import { full as emoji } from 'markdown-it-emoji'
import taskLists from 'markdown-it-task-lists'
import KnoteIcon from './icon/KnoteIcon.png'
import KnoteIconPixel from './icon/KnoteIcon-pixel.png'
import footnote from 'markdown-it-footnote'
import sub from 'markdown-it-sub'
import sup from 'markdown-it-sup'
import abbr from 'markdown-it-abbr'
import markdownItCjkFriendly from 'markdown-it-cjk-friendly'
import deflist from 'markdown-it-deflist'
import ins from 'markdown-it-ins'
import mark from 'markdown-it-mark'
import hljs from 'highlight.js'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import DOMPurify from 'dompurify'
import RichEditor from './components/RichEditor.vue'
import AgentPanel from './components/AgentPanel.vue'
import KiwiMascot from './components/KiwiMascot.vue'
import OnboardingTour from './components/OnboardingTour.vue'
import { agentBridge, agentOpen, agentWorkspaceOpen, pendingHunks, pendingHunksForCurrentDocument, pendingHunksReviewLocked, pendingHunksReviewReason, pendingHunksBelongToDocument, discardPendingHunksForDocument, acceptAllHunks, rejectAllHunks, resyncAgentPreview, agentNotice, sendToAgent, selectionContext, setChatWorkspace, loadPersisted as loadAgentPersisted, agentStatus, agentActivity, agentError, resolveAgentImageResource, renderPdfPageImage, setAgentUiLang, flushAgentForRendererShutdown, resumeAgentSchedulingAfterRendererShutdown, stopAgentRunsForDocument } from './lib/agentStore.js'
import PdfViewerHost from './components/PdfViewerHost.vue'
import { isNativeApp, openNativeWorkspace, nativeExportText } from './lib/nativeFs.js'
import { createSafDocument, isSafAndroidApp, pickSafDocument, pickSafTree, releaseSafGrant, restoreSafGrant } from './lib/safFs.js'
import { App as CapacitorApp } from '@capacitor/app'
import { mkDesktopDirHandle, mkDesktopFileHandle, readDesktopTextFile } from './lib/desktopFs.js'
import { addSnapshot, copySnapshots, listSnapshots, getSnapshot } from './lib/snapshots.js'
import { enqueueDocumentSave, waitForAllDocumentSaves, waitForDocumentSaves } from './lib/documentSaveQueue.js'
import { withAsyncKeyLock } from './lib/asyncKeyLock.js'
import { createAppDialogQueue } from './lib/appDialogQueue.js'
import { AGENT_CAPABILITY_KEYS, classifyAgentCapabilities } from './lib/agentCapabilitySummary.js'
import { collectImageResourcePaths, decodeRelativeResourcePath, rewriteImageResourcePaths } from './lib/imagePathMapping.js'
import { analyzeDocumentChunked, filterOutlineItemsForSidebar } from './lib/documentMetrics.js'
import { applyLargeSourcePageDraft, applyZeroWidthDeletion, buildLargeSourceOffsets, estimateLargeSourceDraftCaret, findLargeSourcePageByOffset, readLargeSourcePage, rebalanceLargeSourceView } from './lib/largeSourceDraft.js'
import { computeBackspaceUnwrap, computeEnterContinuation, computeSelectionSurround } from './lib/sourceEditing.js'
import { shouldUsePagedSource, LARGE_SOURCE_CHUNK_SIZE } from './lib/largeDocumentPolicy.js'
import { selectTabsToOffload } from './lib/tabResidencyPolicy.js'
import { renderMermaidIn } from './lib/mermaidRender.js'
import { toInternal, toInternalMapped } from './lib/emptyRows.js'
import { replaceInvalidInternalImageReferences } from './lib/imageReferenceGuard.js'
import { resolveBrowserFileIdentity, resolveBrowserWorkspaceIdentity } from './lib/browserWorkspaceIdentity.js'
import { bareMarkdownHostFilename, decodeLocalPath, isLocalMarkdownHref, localFileLinkMarkdown } from './lib/local-file-links.js'
import { installKnoteMarkdownImagePolicy } from './lib/markdownImagePolicy.js'
import * as mdKatex from '@vscode/markdown-it-katex'
import 'katex/dist/katex.min.css'

import KpdfIcon from './icon/Kpdf.png'
import KdocIcon from './icon/Kdoc.png'
import { detectFtype, readDocumentFile } from './lib/fileReader.js'
import { createAgentWorkspaceFile, isAgentCreatableFile, isAgentEditableTextFile } from './lib/agentWorkspaceFile.js'

const sampleZh = `# Knote Markdown 编辑器

欢迎使用 **Knote**。下面每一节都是一个小教程：先给出 Markdown 语法，紧跟着就是它的实际效果，照着输入即可学会。

## 标题

语法：行首输入 \`#\` + 空格是一级标题，\`##\` 是二级，依此类推（最多六级）。

### 这是一个三级标题

## 文字样式

语法：\`**粗体**\`、\`*斜体*\`、\`~~删除线~~\`、\`==高亮==\`、\`++下划线++\`、反引号包裹\`行内代码\`。

效果：**粗体**、*斜体*、~~删除线~~、==高亮==、++下划线++、\`行内代码\`，还有 :sparkles: Emoji（输入 \`:sparkles:\`）。

## 列表与任务

语法：\`- \` 开头是无序列表，\`1. \` 开头是有序列表，\`- [ ] \` 是任务清单。

- 无序列表项
- 另一项

1. 有序列表第一项
2. 有序列表第二项

- [ ] 待办任务
- [x] 已完成任务

## 引用

语法：行首输入 \`> \` + 空格。

> 引用内容也支持 **强调** 和 \`行内代码\`。

## 代码块

语法：行首连续输入 3 个反引号和语言名（例如 js、python、cpp），再按空格即可创建代码块；右上角可随时切换语言。

\`\`\`js
const greet = (name) => {
  return \`Hello, \${name}\`
}
console.log(greet('Knote'))
\`\`\`

## 表格

语法：用 \`|\` 分隔单元格，第二行用 \`---\` 分隔表头；也可以用左侧 + 号菜单里的表格网格快速插入。

| 模块 | 说明 | 状态 |
| --- | --- | --- |
| 编辑 | 快捷输入 | ✅ |
| 预览 | 实时渲染 | ✅ |
| 导出 | 下载 Markdown | ✅ |

## 公式

语法：\`$行内公式$\`，\`$$独立公式$$\`（KaTeX 语法）。

质能方程 $E = mc^2$ 可以写在行内，也可以独占一行：

$$\\frac{a}{b} + \\sqrt{x^2 + y^2}$$

## 提示块 Callout

语法：引用块首行写 \`> [!类型]\`，类型可选 note / info / tip / success / warning / danger / question / quote。

> [!tip] 小提示
> 用彩色卡片突出重点，比普通引用更醒目。

> [!warning] 注意
> 删除、清空等操作请先看清提示再确认。

## 流程图 Mermaid

语法：新建代码块并把语言切换为 \`mermaid\`，用 Mermaid 语法描述图形；单栏下方与分栏预览都会实时渲染。

\`\`\`mermaid
graph LR
  A[写作] --> B[保存]
  B --> C{满意?}
  C -->|是| D[发布]
  C -->|否| A
\`\`\`

## 高效功能速览

以下不是 Markdown 语法，而是 Knote 的快捷能力：

- **查找 / 替换**：\`Ctrl+F\` 查找、\`Ctrl+H\` 替换，支持区分大小写 / 全字匹配、逐个或全部替换。
- **快速打开**：\`Ctrl+P\` 按文件名模糊搜索并秒开文件（需先打开文件夹）。
- **多标签页（桌面版）**：像浏览器一样同时打开多个文档 / 文件夹，标题栏里可拖拽排序；下次启动自动恢复上次的工作区。
- **文件夹工作区**：左侧「打开文件夹」浏览整个目录，可新建文档、新建文件夹、重命名、删除（桌面版删除进回收站），还能在搜索框里跨文件全文检索。
- **版本历史**：右上角 ⋮ 菜单「版本历史」查看旧版本并一键回滚（也可随时 \`Ctrl+Z\`）。
- **图片查看器**：双击任意图片放大，滚轮缩放、拖拽平移，\`Esc\` 关闭。
- **界面缩放（桌面版）**：\`Ctrl+滚轮\` 或 \`Ctrl+ +/-\` 缩放界面，\`Ctrl+0\` 复位。
- **快捷键速览**：右上角 ⋮ 菜单「快捷键」可查看完整列表。

## 配置 AI 助手

Knote 内置一个能读写文档的 AI 助手（右下角绿色圆球，点开即用）。它不含任何内置额度，需要你填入自己的大模型 API，全部配置**只保存在本机浏览器**，不会上传。

配置步骤：

1. 点右下角**绿色圆球**打开助手；首次使用会直接进入设置界面（之后点助手面板里的**齿轮**图标可再次打开）。
2. 选择协议：多数服务（DeepSeek、硅基流动、OpenAI、Kimi、通义等）选 **OpenAI 兼容**；用 Claude 官方接口则选 **Anthropic**。
3. 填三项：
   - **API 地址**：服务商的接口地址，如 \`https://api.deepseek.com\`。
   - **API Key**：你在服务商后台申请的密钥（\`sk-\` 开头）。
   - **模型名称**：要调用的模型，如 \`deepseek-chat\`、\`deepseek-reasoner\`。
4. 点**检测**按钮：Knote 会自动探测这个模型支持哪些能力，并亮起徽章——**对话 / 工具 / 图片 / PDF 直读**。看到「对话」亮起就能开始聊天了。

> [!tip] 选填项
> **自定义人设**可固定助手的语气或角色（如"始终用简洁中文回答"）；填了 **Jina Key** 后助手就能联网搜索、读取网页内容。

> [!warning] 关于密钥安全
> API Key 只写入本机浏览器的本地存储，Knote 不设服务器、不会外发。但请勿在公共电脑上保存，也不要把密钥填进会分享出去的文档里。

配好之后你可以：直接对话让它总结/改写；选中文字点浮层的**问助手 / 润色 / 翻译**；让它直接修改文档——改动会以**红绿 diff** 呈现，你可以逐块或一键接受，全部可 \`Ctrl+Z\` 撤销。

## 分割线与脚注

语法：单独一行输入 \`---\` 是分割线；\`[^1]\` 是脚注引用，行首 \`[^1]: 说明\` 是脚注定义。

---

Knote 让写作更轻松[^1]

[^1]: 脚注支持拓展语法。`

const sampleEn = `# Knote Markdown Editor

Welcome to **Knote**. Each section below is a short tutorial that explains a Markdown feature and then shows its result.

## Headings

Start a line with # and a space for a level-one heading, ## for level two, and so on up to level six.

### This is a level-three heading

## Text Styles

Markdown supports **bold**, *italic*, ~~strikethrough~~, ==highlight==, ++underline++, <code>inline code</code>, and :sparkles: emoji.

## Lists and Tasks

- A bullet-list item
- Another item

1. First numbered item
2. Second numbered item

- [ ] A task to do
- [x] A completed task

## Quotes

> Quotes also support **emphasis** and <code>inline code</code>.

## Code Blocks

Use a fenced block and add a language name such as js, python, or cpp. The control in the top-right corner can change the language later.

~~~js
const greet = (name) => {
  return 'Hello, ' + name
}
console.log(greet('Knote'))
~~~

## Tables

Separate cells with vertical bars and use dashes in the second row to define the header. You can also use the table grid in the left-side + menu.

| Module | Description | Status |
| --- | --- | --- |
| Editing | Fast input | ✅ |
| Preview | Live rendering | ✅ |
| Export | Download Markdown | ✅ |

## Math

The equation $E = mc^2$ can appear inline or on its own line with KaTeX syntax:

$$\\frac{a}{b} + \\sqrt{x^2 + y^2}$$

## Callouts

Start a quote with [!type]. Available types include note, info, tip, success, warning, danger, question, and quote.

> [!tip] Quick tip
> Use a colored card to make important information stand out.

> [!warning] Caution
> Read the confirmation carefully before deleting or clearing content.

## Mermaid Diagrams

Create a code block with the mermaid language. It renders live below a single-column editor and in the split preview.

~~~mermaid
graph LR
  A[Write] --> B[Save]
  B --> C{Satisfied?}
  C -->|Yes| D[Publish]
  C -->|No| A
~~~

## Productivity Features

These are Knote features rather than Markdown syntax:

- **Find / Replace**: Ctrl+F finds text and Ctrl+H replaces it, with case-sensitive, whole-word, replace-one, and replace-all options.
- **Quick Open**: Ctrl+P searches file names after you open a folder.
- **Tabs (desktop)**: Open several documents or folders, drag tabs to reorder them, and restore the workspace next time Knote starts.
- **Folder workspace**: Browse, create, rename, delete, and search files from the left sidebar. Desktop deletions go to the Recycle Bin.
- **Version history**: Open Version History from the top-right menu to inspect or restore an earlier version. Ctrl+Z remains available too.
- **Image viewer**: Double-click an image, use the wheel to zoom, drag to pan, and press Esc to close.
- **Interface zoom (desktop)**: Use Ctrl+Wheel or Ctrl+ +/- to zoom and Ctrl+0 to reset.
- **Shortcut guide**: Open Shortcuts from the top-right menu for the complete list.

## Configure the AI Assistant

Knote includes an AI assistant that can read and edit documents. Open it from the green orb in the lower-right corner. Knote includes no model quota, so connect your own model API. Configuration is stored **only in local browser storage** and is not uploaded by Knote.

Setup steps:

1. Click the **green orb**. First use opens Settings directly; later use the **gear** icon in the assistant panel.
2. Choose **OpenAI Compatible** for most providers or **Anthropic** for Claude's official API.
3. Enter the provider **Base URL**, your **API Key**, and the **Model** name.
4. Click **Check**. Knote probes support for **Chat / Tools / Images / Native PDF**. You can start once Chat is available.

> [!tip] Optional settings
> A **custom persona** keeps the assistant in a chosen voice or role. A **Jina Key** lets it search and read web pages when needed.

> [!warning] Protect your key
> The API key stays in local browser storage. Do not save it on a shared computer or put it in a document you plan to share.

Once configured, ask for summaries or rewrites, select text and choose **Ask AI / Polish / Translate**, or let the assistant edit directly. Edits appear as a **red/green diff** that you can accept individually or all at once, and Ctrl+Z can undo them.

## Dividers and Footnotes

Put three dashes on their own line for a divider. Use [^1] for a footnote reference and begin another line with [^1]: for its definition.

---

Knote makes writing easier[^1]

[^1]: Footnotes are available through extended Markdown syntax.`

const content = ref(sampleZh)
const theme = ref('light')
const viewMode = ref('single')
const isAndroidNative = isSafAndroidApp()
const androidLayoutOverride = ref(false)
const androidTabletWidthMedia = typeof window !== 'undefined' ? window.matchMedia('(min-width: 600px)') : null
const androidTabletHeightMedia = typeof window !== 'undefined' ? window.matchMedia('(min-height: 600px)') : null
const androidTabletWidth = ref(androidTabletWidthMedia?.matches === true)
const androidTabletHeight = ref(androidTabletHeightMedia?.matches === true)
const syncAndroidLayoutMedia = () => {
  androidTabletWidth.value = androidTabletWidthMedia?.matches === true
  androidTabletHeight.value = androidTabletHeightMedia?.matches === true
}
const androidLayoutActive = computed(() => isAndroidNative || androidLayoutOverride.value)
const isAndroidTablet = computed(() => androidLayoutActive.value && androidTabletWidth.value && androidTabletHeight.value)
const isAndroidCompact = computed(() => androidLayoutActive.value && !isAndroidTablet.value)
let androidLayoutMediaListening = false
const listenAndroidLayoutMedia = () => {
  if (androidLayoutMediaListening) return
  androidLayoutMediaListening = true
  for (const media of [androidTabletWidthMedia, androidTabletHeightMedia]) {
    if (media?.addEventListener) media.addEventListener('change', syncAndroidLayoutMedia)
    else media?.addListener?.(syncAndroidLayoutMedia)
  }
  syncAndroidLayoutMedia()
}
const unlistenAndroidLayoutMedia = () => {
  if (!androidLayoutMediaListening) return
  androidLayoutMediaListening = false
  for (const media of [androidTabletWidthMedia, androidTabletHeightMedia]) {
    if (media?.removeEventListener) media.removeEventListener('change', syncAndroidLayoutMedia)
    else media?.removeListener?.(syncAndroidLayoutMedia)
  }
}
const EDITOR_CENTERED_KEY = 'knote-editor-centered-v1'
// Centered mode defaults ON (Req 1): only an explicit "off" ('0') keeps it off,
// so first-run/never-touched users land in the centered layout. Android forces off.
const editorCentered = ref((() => {
  if (isAndroidNative) return false
  try { return localStorage.getItem(EDITOR_CENTERED_KEY) !== '0' } catch { return true }
})())
// Split view (issue #16, redesigned): the two panes scroll FREELY and
// independently — no live scroll-sync and no selection auto-follow (that constant
// re-alignment is what made both panes twitch and never quite line up). Alignment
// is now EXPLICIT: hover a line to reveal a single "locate" button (or select text
// for the bubble) and the OTHER pane jumps so that line tops its viewport, mapped
// exactly through the line-number -> pixel anchors (buildSplitAnchors/splitLineGeom).
const viewModeSelectionSnapshot = ref(null)
const lastSelectionSnapshot = ref(null)
const selectedImage = ref(null)
const lang = ref('zh') // i18n state: 'zh' or 'en'
// The agent store's live status strings (activity line, workspace stack)
// follow the UI language; initialize immediately and re-sync on switch.
watch(lang, (l) => setAgentUiLang(l), { immediate: true })
// Undo/Redo system
const undoStack = ref([])
const redoStack = ref([])
const MAX_UNDO = 50
const MAX_UNDO_BYTES = 16 * 1024 * 1024
const MAX_LARGE_UNDO = 2
const snapshotStorageBytes = (entry) => String(entry?.content || '').length * 2
let undoTimer = null
let isUndoRedoAction = false
let lastSavedSnapshot = { content: sampleZh, selection: null }

// File management
const currentFileHandle = shallowRef(null)
const isLocalFile = ref(false)
const currentFileName = ref('')
const workspaceIdentityRevision = ref(0)
const touchWorkspaceIdentity = () => { workspaceIdentityRevision.value += 1 }
const setTabFileWorkspaceIdentity = (tab, id = '', durable = false) => {
  if (tab) {
    tab.fileWorkspaceId = String(id || '')
    tab.fileWorkspaceIdentityDurable = !!durable
  }
  touchWorkspaceIdentity()
}
let autoSaveTimer = null
const isSaving = ref(false)
let savingOperationCount = 0

const translations = {
  zh: {
    editor: '编辑器',
    preview: '预览',
    modern_editor: '由KV制作',
    pdf_readonly: '只读',
    pdf_pages: '页',
    pdf_page: '第',
    pdf_zoom_in: '放大',
    pdf_zoom_out: '缩小',
    pdf_close: '关闭 PDF',
    pdf_rendering: '正在渲染页面…',
    pdf_empty: '这个 PDF 没有可显示的页面。',
    words: '字数',
    chars: '字符',
    lines: '行数',
    single: '单栏',
    split: '分栏',
    theme: '主题',
    light: '明亮',
    dark: '暗黑',
    retro: '复古',
    load_sample_zh: '加载中文示例',
    load_sample_en: '加载英文示例',
    copy_markdown: '复制 Markdown',
    download_file: '下载文件',
    clear_all: '清除全部',
    block_actions: '块操作',
    bold_line: '整行加粗',
    insert_image_below: '插入图片',
    insert_image_local: '从本地选择图片',
    insert_image_url: '输入图片 URL',
    insert_image_url_prompt: '请输入图片 URL:',
    insert_local_file: '插入附件（复制到文件夹）',
    insert_link_in_place: '插入文件链接（保持原位置）',
    insert_local_file_no_dir: '请先打开或保存一个本地文件，再插入附件',
    attach_insert_title: '插入附件',
    attach_target_folder: '目标文件夹',
    attach_source_file: '选择要插入的文件',
    attach_pick_file: '选择文件…',
    attach_confirm: '插入附件',
    attach_folder_note: '选择的文件夹会被记住，下次插入时默认使用',
    attach_doc_root: '文档根目录',
    attach_load_error: '无法读取可插入的文件夹列表',
    attach_new_folder: '新建文件夹',
    attach_rename_folder: '重命名文件夹',
    attach_new_folder_prompt: '新建文件夹名称：',
    attach_rename_folder_prompt: '重命名为：',
    attach_folder_op_failed: '文件夹操作失败',
    link_tooltip_open: 'Ctrl/Cmd + 左键 打开',
    file_double_click_open: '双击打开',
    open_local_file_failed: '无法使用系统应用打开文件',
    invalid_image_reference: '图片引用无效',
    image_paste_success: '已粘贴图片',
    clear_formatting: '清除格式',
    paragraph: '正文',
    headings: '标题',
    lists_quote: '列表与引用',
    bullet_list: '无序列表',
    ordered_list: '有序列表',
    task_list: '任务列表',
    quote: '引用',
    insert: '插入',
    image: '图片',
    table: '表格',
    code_block: '代码块',
    divider: '分隔线',
    type_placeholder: '在此输入 Markdown...',
    bold: '加粗',
    underline: '下划线',
    italic: '斜体',
    strike: '删除线',
    code: '行内代码',
    link: '链接',
    enter_h1: '请输入一级标题',
    enter_h2: '请输入二级标题',
    enter_h3: '请输入三级标题',
    enter_h4: '请输入四级标题',
    enter_h5: '请输入五级标题',
    enter_h6: '请输入六级标题',
    prompt_img_url: '请输入图片 URL:',
    undo: '撤销',
    redo: '恢复',
    save: '保存',
    open_file: '打开文件',
    open_legacy_workspace: '打开 Knote 工作区',
    export_pdf: '导出 PDF',
    local_file_editing: '本地文件编辑中',
    temp_file_warning: '目前文件为暂存文件，请及时保存',
    image_zoom: '缩放',
    image_replace: '更换图片',
    image_delete: '删除图片',
    image_zoom_in: '放大',
    image_zoom_out: '缩小',
    image_original: '原始大小',
    table_insert_row_above: '上方插入行',
    table_insert_row_below: '下方插入行',
    table_insert_col_left: '左侧插入列',
    table_insert_col_right: '右侧插入列',
    table_delete_row: '删除行',
    table_delete_col: '删除列',
    table_delete: '删除表格',
    table_prompt: '请输入表格行列数 (行x列，例如 3x3):',
    custom_dimensions: '自定义行列...',
    export_word: '导出 Word',
    export_md: '导出 Markdown',
    formula: '公式',
    formula_block: '公式块',
    crop: '裁剪图片',
    crop_apply: '确认裁剪',
    crop_cancel: '取消',
    crop_failed: '无法裁剪该图片（可能是跨域图片）',
    open: '打开',
    open_folder: '打开文件夹',
    agent: '助手',
    agent_settings: '助手设置',
    agent_settings_desc: '连接模型、调整工作方式与本地文档能力。',
    agent_settings_ready: '已就绪',
    agent_settings_pending: '待配置',
    agent_sessions: '最近对话',
    agent_quick_nav: '快速选择',
    agent_clear: '清空对话',
    agent_base_url: 'API 地址',
    agent_api_key: 'API Key',
    agent_model: '模型名称',
    agent_jina_key: '联网搜索 Jina Key（选填）',
    agent_pdf_page_hint: '该模型不支持 PDF 直读；Knote 会发送完整文本层，仅在 Agent 明确选择页码后渲染图片。',
    agent_pdf_sending: '正在发送 PDF…',
    agent_pdf_to_images: '正在将 PDF 转为页面图像…',
    agent_pdf_to_text: '正在将 PDF 转为可读文档…',
    agent_pdf_processing: '正在处理 PDF…',
    agent_setup_title: '配置 AI 助手',
    agent_setup_desc: '接入任意 OpenAI 兼容或 Anthropic 接口的大模型；配置与密钥只保存在本机浏览器。',
    agent_clear_title: '清空当前对话？',
    agent_clear_desc: '将删除该对话中的所有消息，此操作无法撤销。',
    agent_cancel: '取消',
    agent_clear_do: '清空',
    dlg_ok: '确定',
    dlg_cancel: '取消',
    ctx_cut: '剪切',
    ctx_copy: '复制',
    ctx_paste: '粘贴',
    ctx_paste_plain: '仅粘贴文本',
    ctx_clear_format: '清除格式',
    ctx_insert_above: '在上方插入空行',
    ctx_insert_below: '在下方插入空行',
    ctx_copy_row: '复制本行',
    ctx_delete_row: '删除本行',
    ctx_to_h1: '转为标题 1',
    ctx_to_h2: '转为标题 2',
    ctx_to_h3: '转为标题 3',
    ctx_to_text: '转为正文',
    ctx_to_ul: '转为无序列表',
    ctx_to_ol: '转为有序列表',
    ctx_to_quote: '转为引用',
    ctx_crop: '裁剪图片',
    ctx_copy_image: '复制图片',
    ctx_save_image: '图片另存为',
    ctx_delete_image: '删除图片',
    ctx_open: '打开',
    ctx_open_new_tab: '在新标签页打开',
    ctx_copy_name: '复制文件名',
    ctx_delete: '删除',
    ctx_expand: '展开',
    ctx_collapse: '收起',
    agent_sugg_1: '总结这篇文档的要点',
    agent_sugg_2: '检查全文错别字并修正',
    agent_sugg_3: '优化标题层级和排版',
    ai_ask: '问助手',
    ai_polish: '润色',
    ai_translate: '翻译',
    ai_expand: '扩写',
    ai_condense: '精简',
    locate: '定位',
    agent_persona: '助手人设 / 风格要求（选填）',
    agent_persona_ph: '例如：始终使用学术语气；回复尽量简短',
    agent_sel_ref: '已引用选中内容',
    agent_tok_in: '输入',
    agent_tok_out: '输出',
    agent_web_search: '联网搜索',
    agent_web_search_hint: '桌面版和 Android 通过你的网络查询所选引擎；“全部”会并行查询并融合结果。配置 Jina Key 后，只有 DuckDuckGo 失败时可能把搜索词发送给 Jina 兜底。关闭后通用与学术联网检索均不可用。',
    agent_search_engines: '启用的搜索引擎',
    agent_search_engines_hint: '可多选。助手只能使用这里启用且当前环境可执行的引擎；取消最后一个会同时关闭联网搜索。',
    agent_search_region: '搜索区域',
    agent_search_region_auto: '自动（由 IP 决定）',
    agent_search_region_hint: '强制搜索引擎返回特定语言/区域的结果。"自动"让引擎根据你的 IP 判断；挂 VPN 到海外建议选"英文/国际"，国内直连选"中文"。',
    agent_jina_hint: '（仅 DuckDuckGo 的网页版通道 / 原生兜底）使用时搜索词会发送给 r.jina.ai；不会为 Bing 或 Mojeek 静默换引擎。免费 Key 在 jina.ai 获取。',
    agent_verify: '额外模型自查',
    agent_verify_hint: '可选的最终回复复核，默认关闭。开启后模型会按执行账本再检查一次，未通过最多补做 2 轮。操作审查不受此开关影响。',
    agent_copy_message: '复制整条回复',
    agent_copy_code: '复制代码',
    agent_copy_table: '复制表格',
    agent_copied: '已复制',
    agent_streaming_draft: '生成中',
    agent_testing: '测试中',
    agent_receipt_success: '系统已验证本轮操作',
    agent_receipt_partial: '系统确认部分操作完成',
    agent_receipt_failed: '本轮未产生已验证的修改',
    agent_receipt_blocked: '已拦截无依据的完成声明',
    agent_receipt_staged: '{n} 处待审核改动',
    agent_receipt_accepted: '已通过 {n} 处改动',
    agent_receipt_rejected: '已拒绝 {n} 处改动',
    agent_receipt_file_staged: '{n} 处文件改动待审核（尚未写盘）',
    agent_receipt_file_accepted: '{n} 处已应用到文档缓冲区（写盘状态未核验）',
    agent_receipt_file_rejected: '已拒绝 {n} 处文件改动',
    agent_receipt_direct: '{n} 项直接操作',
    agent_receipt_failures: '{n} 项未解决失败',
    agent_protocol_openai: 'OpenAI 兼容',
    agent_capabilities: '模型能力',
    agent_cap_chat: '对话',
    agent_cap_tools: '工具',
    agent_cap_image: '图片',
    agent_cap_pdf: 'PDF 直读',
    agent_supported: '支持',
    agent_unsupported: '不支持',
    agent_cap_rejected: '{capability}：接口拒绝（{detail}）',
    agent_cap_probe_incomplete: '{capability}检测未完成（{detail}），可稍后重新检测',
    agent_cap_result_success_title: '能力检测完成',
    agent_cap_result_partial_title: '部分能力可用',
    agent_cap_result_failure_title: '连接检测失败',
    agent_cap_result_success: '模型连接正常，全部能力检测通过：{supported}。',
    agent_cap_result_partial: '模型连接正常。\n已支持：{supported}\n未通过：{unsupported}',
    agent_cap_result_failure: '基础对话连接未通过。请检查 API 地址、密钥与模型名称。',
    agent_cap_result_detail: '详情：{detail}',
    agent_cap_result_none: '无',
    agent_cap_ctx_detected: '已自动检测到上下文窗口：{n} tokens',
    agent_search_region_en: 'English / 国际',
    agent_search_region_zh: '中文',
    agent_step_n: '（第 {n} 步）',
    agent_page_progress: '第 {page} / {total} 页',
    agent_target_page_progress: '目标 {index} / {total} · PDF 第 {page} 页',
    agent_pages_short: '{n}页',
    agent_parsing: '解析',
    agent_pdf_parse_failed: '版面解析失败：{error}（将以指针模式发送，助手仍可用工具读取）',
    agent_remove_selection: '移除引用的选中内容',
    agent_remove_attachment: '移除附件 {name}',
    agent_workspace_aria: '助手工作区',
    batch_title: '多 Agent 批量处理',
    agent_pdf_layout: 'PDF 版面分析（PaddleOCR）',
    agent_pdf_layout_hint: '让助手用本地 PaddleOCR / PP-Structure 精准识别 PDF 里的标题/图/表并插入。点下方一键下载配置（装进独立环境，需本机有 Python，建议 3.10/3.11）。未配置时会自动改用视觉定位裁剪。',
    agent_pdf_env_ready: '已就绪',
    agent_pdf_env_install: '一键下载并配置',
    agent_pdf_env_reinstall: '重新下载',
    agent_pdf_env_uninstall: '卸载',
    agent_pdf_env_installing: '正在下载配置（较大，可能数分钟，请勿关闭）…',
    agent_pdf_env_uninstall_confirm: '确定卸载 PDF 版面分析环境吗？将删除已下载的依赖（约数百 MB）。',
    agent_pdf_env_advanced: '高级：自定义环境',
    agent_pdf_env_dir_label: '环境目录（留空 = 默认）',
    agent_pdf_env_py_label: 'Python 解释器（留空 = 自动检测）',
    agent_pdf_env_cfg_save: '保存配置',
    agent_pdf_env_cfg_hint: '更改目录后需重新安装；旧目录不会被自动删除。',
    agent_pdf_env_cfg_inuse: '当前环境目录',
    agent_pdf_env_manual: '手动安装指引',
    agent_pdf_env_manual_step1: '安装 Python 3（3.10 / 3.11 兼容性最好）。',
    agent_pdf_env_manual_step2: '在仓库 sidecar 目录执行：',
    agent_pdf_env_manual_step3: '回到此处点「一键下载并配置」或「检测服务」确认就绪。',
    agent_check: '保存并检测能力',
    agent_key_local_hint: '密钥仅保存在本机浏览器',
    agent_no_tools_hint: '该模型不支持工具调用，助手将无法读取/修改工作区，仅能对话',
    agent_empty_hint: '我是工作区助手，会先查看文件结构，再按需阅读、修改、运行测试或整理工作区，也能联网搜索和处理 PDF。操作是否需要确认由顶部审核模式决定。',
    agent_empty_title: '今天想从哪里开始？',
    agent_input_placeholder: '问点什么，或让我处理工作区…（Enter 发送）',
    agent_configure_first: '请先在 ⚙ 设置里配置模型',
    agent_attach: '添加图片 / PDF 附件',
    agent_drop_hint: '松开以添加图片 / PDF',
    agent_drop_unsupported: '仅支持图片和 PDF 文件',
    agent_drop_need_config: '当前模型不支持图片/PDF，或尚未配置',
    agent_send: '发送',
    agent_stop: '停止',
    agent_question_title: '助手需要确认',
    agent_question_answered: '已回答',
    agent_question_placeholder: '输入你的回答…（Enter 发送）',
    agent_question_skip: '暂不回答',
    agent_answer: '回答',
    agent_review_mode: '审核模式',
    agent_review_policy_label: '审核方式',
    agent_review_policy_manual: '人工',
    agent_review_policy_manual_desc: '受控操作将等待你的确认。',
    agent_review_policy_review: '审查',
    agent_review_policy_review_desc: 'Agent 的改写操作将被自动审查。',
    agent_review_policy_allow_all: '全部通过',
    agent_review_policy_allow_all_desc: '当前会话和标签页内的 Agent 操作直接执行。',
    agent_review_document_label: '编辑文档时人工审核',
    agent_review_document_tab_manual: '开启',
    agent_review_document_tab_manual_desc: '开启时，仅可见 Markdown diff 改动等待人工审核。',
    agent_review_document_all_auto: '关闭',
    agent_review_document_all_auto_desc: '关闭时，Markdown diff 在 exact CAS 通过后自动应用。',
    agent_review_safety_boundary: '参数校验、工作区边界、不覆盖、隔离和 CAS 仍强制执行。',
    agent_review_allow_all_confirm_title: '为当前 Agent 会话与标签页开启“全部通过”？',
    agent_review_allow_all_confirm_message: '此临时授权只对当前 Agent 会话的当前标签页生效，可随时关闭。开启后，创建、修改、移动、重命名、下载、删除，以及当前环境实际提供的受控命令或隔离代码操作都不会再次请求人工确认。“编辑文档时人工审核”开关只控制可见 Markdown diff 是否等待你审核。参数校验、工作区边界、不覆盖、隔离、回读和 exact CAS 仍会强制执行；技术校验失败会直接报告失败。应用重启、清空或删除会话、切换会话或切换标签页不会向其它上下文授予权限。',
    agent_review_auto_pass: '已自动通过 {n} 项审核：{tool}',
    agent_review_allow_all_pass: '已按“全部通过”处理 {n} 项：{tool}',
    agent_review_manual_fallback: '已退回人工审核：{reason}',
    agent_permission_review_fallback: '自动放行未获通过：{reason}',
    agent_permission_title: '需要你的许可',
    agent_permission_create_file: '创建文件',
    agent_permission_create_folder: '创建文件夹',
    agent_permission_edit_file: '修改文件',
    agent_permission_batch_process: '批量生成文件',
    agent_permission_move_file: '移动文件',
    agent_permission_rename_file: '重命名文件',
    agent_permission_run_command: '运行受控命令',
    agent_permission_run_code: '执行隔离 JavaScript',
    agent_permission_download_file: '下载文件',
    agent_permission_chars: '{n} 个字符',
    agent_permission_replace_one: '替换一个匹配项',
    agent_permission_replace_all: '替换所有匹配项',
    agent_permission_batch_detail: '{n} 个文件 · 输出后缀 {suffix}',
    agent_permission_command_detail: '最长运行 {n} 秒；允许后还会显示一次原生命令确认',
    agent_permission_code_detail: '最长运行 {n} 毫秒；在独立 Chromium OS sandbox 中执行，不会请求原生命令确认',
    agent_permission_download_detail: '精确上限 {size}；流式写入磁盘；不会覆盖已有文件',
    agent_permission_download_no_limit: '无固定单文件限制；流式写入磁盘；受可用磁盘空间和资源策略约束；不会覆盖已有文件',
    agent_permission_destination: '目标：{target}',
    agent_permission_once: '仅授权当前显示的这一次调用。拒绝后，本轮不会再次询问同一目标。',
    agent_permission_allow: '允许一次',
    agent_permission_deny: '拒绝',
    agent_permission_stop: '停止任务',
    agent_steer: '追加指令',
    agent_steer_hint: '加入当前任务，在下一个安全边界处理',
    agent_queue_next: '下一条',
    agent_queue_next_hint: '排到当前任务之后执行',
    agent_queue_title: '消息队列',
    agent_queued: '排队中',
    agent_queue_cancel: '取消排队消息',
    agent_queue_paused: '任务停止后已暂停',
    agent_queue_context_changed: '文档上下文已改变，需要确认后运行',
    agent_queue_context_limit: '当前模型上下文不足，追加指令已暂停',
    agent_queue_not_configured: 'Agent 配置已失效，消息已暂停',
    agent_queue_attachments_missing: '附件在刷新后已失效，请取消并重新发送',
    agent_queue_run_here: '在此运行',
    agent_queue_attachments_blocked: '带附件的消息暂不能排队，请等待当前任务结束后发送。',
    agent_queue_full: '该对话的消息队列已满（上限 32 条）。',
    agent_queue_storage_failed: '消息未能持久化，输入内容已保留。',
    agent_queue_prompt_too_long: '消息超过 32,000 字符，未加入队列。',
    agent_queue_failed: '消息未能加入队列，输入内容已保留。',
    agent_hunks_pending: '处改动待审核',
    agent_document_changes: '文档改动',
    agent_accept_all: '全部接受',
    agent_reject_all: '全部拒绝',
    agent_hunk_accept: '接受此改动',
    agent_review_locked: '生成任务或独立审核器仍在处理这批改动，完成后即可审核',
    agent_hunk_reject: '拒绝此改动',
    agent_new_chat: '新对话',
    agent_hide: '收起助手',
    agent_workspace: '工作区',
    agent_workspace_running: '进行中',
    agent_workspace_hide: '收起工作区',
    agent_workspace_empty: '助手开始工作后，这里会实时显示它的计划、调用的工具、搜索/抓取的网址、读取的文件。',
    agent_plan: '计划',
    agent_subagents: '子智能体',
    agent_workspace_activity: '动态',
    agent_reset_size: '恢复默认大小',
    agent_recall: '召回助手',
    agent_open: '打开助手',
    agent_to_sidebar: '转为助手边栏',
    agent_to_float: '转为悬浮助手',
    assistant_drop_hint: '将助手拖拽至此处开启助手边栏',
    product_tour: '产品教程',
    agent_running_badge: '生成中',
    agent_running_elsewhere: '另一个对话正在生成回复…',
    folder_hint: '你可以编辑该文件夹下的.md文件',
    folder_unsupported: '当前浏览器不支持文件夹访问（需要 Chrome/Edge）',
    folder_empty: '未找到 .md 文件',
    relimg_banner: '此文档引用了本地图片，但浏览器无法访问它所在的文件夹。',
    relimg_grant: '授权图片文件夹',
    relimg_dismiss: '忽略',
    browsing_now: '正在浏览',
    folder_pick_prompt: '请选择一个 md 文件打开，或创建一个新文件',
    folder_pick_hint: '左侧文件树中点击文件，或点击下方按钮新建',
    mascot_mute: '本次不再提示',
    mascot_busy: '助手工作中 · 点开',
    mascot_close_once: '关闭本次',
    ctx_move: '移动到…',
    ctx_open_as_folder: '在文件资源管理器中打开',
    move_title: '移动',
    create_target_title_file: '选择新文件位置',
    create_target_title_folder: '选择新文件夹位置',
    create_target_hint: '选择工作区内的目标文件夹',
    create_target_confirm: '继续',
    move_exists: '目标文件夹里已有同名项，请先重命名。',
    move_active_blocked: '该文档（或其中的文档）正在编辑或已在其他标签页打开，请先关闭对应标签页/切换到其他文档再移动。',
    move_none: '没有可选的目标文件夹',
    agent_reasoning: '思考深度',
    agent_reasoning_hint: '让支持推理的模型思考更久再回答（更准但更慢更贵）。不支持该参数的模型会自动忽略/降级。',
    agent_reasoning_default: '默认',
    agent_reasoning_low: '低',
    agent_reasoning_medium: '中',
    agent_reasoning_high: '高',
    agent_rollback: '回溯',
    agent_rollback_hint: '回溯到这条消息：之后的对话移除（原对话保存为分支），消息放回输入框',
    agent_rollback_done: '已回溯。原对话已保存为「分支」会话，消息已放回输入框。',
    agent_ctx_window: '上下文窗口（tokens，可选）',
    agent_ctx_window_hint: '填 0 = 不显示。「检测能力」时会尝试自动获取；获取不到可手动填写（如 128000），填写后聊天框显示上下文用量圆环。',
    agent_sec_conn: '连接与模型',
    agent_sec_conn_desc: '选择兼容协议并连接你的模型服务。',
    agent_sec_extra: '增强',
    agent_sec_extra_desc: '按需开启搜索、验证与个性化能力。',
    agent_chat_theme: '聊天外观',
    agent_chat_theme_desc: '选择助手聊天的背景风格。',
    agent_chat_theme_white: '简约',
    agent_chat_theme_aurora: '光晕',
    agent_ctx_used: '上下文已用',
    missing_img_banner: '本文档有 {n} 张图片无法显示：图片数据没有随文档保存下来（多见于文档在 Knote 之外被复制或生成）。若有原图，请重新插入后保存。',
    missing_img_dismiss: '忽略',
    files: '文件',
    file_new: '新建文档',
    center_editor: '居中编辑区',
    file_new_prompt: '新文件名：',
    file_rename: '重命名',
    file_rename_prompt: '重命名为：',
    file_refresh: '刷新',
    file_exists: '同名文件或文件夹已存在',
    file_bad_name: '名称包含非法字符',
    folder_new: '新建文件夹',
    folder_new_prompt: '文件夹名：',
    file_new_here: '在此新建文档',
    folder_new_here: '在此新建文件夹',
    tab_new: '新建标签页',
    tab_close: '关闭标签页',
    tab_untitled: '未命名',
    tab_close_confirm: '关闭该标签页？未保存的内容将丢失。',
    ctx_view_image: '查看图片',
    viewer_zoom_in: '放大',
    viewer_zoom_out: '缩小',
    viewer_reset: '恢复原始大小',
    viewer_close: '关闭（Esc）',
    find_placeholder: '查找',
    replace_placeholder: '替换为',
    find_prev: '上一个（Shift+Enter）',
    find_next: '下一个（Enter）',
    find_case: '区分大小写',
    find_word: '全字匹配',
    find_toggle_replace: '替换',
    find_replace_one: '替换',
    find_replace_all: '全部替换',
    find_close: '关闭（Esc）',
    find_none: '无结果',
    find_replaced_n: '已替换 {n} 处',
    quick_open_placeholder: '按文件名快速打开…',
    quick_open_need_folder: '请先打开一个文件夹工作区',
    quick_open_empty: '无匹配文件',
    recent_open: '最近打开',
    recent_clear: '清空最近记录',
    recent_remove: '从最近列表移除',
    fold_section: '折叠 / 展开',
    folder_search_placeholder: '搜索文件夹内全文…',
    folder_search_none: '未找到匹配',
    folder_search_count: '{f} 个文件，{n} 处匹配',
    searching: '搜索中…',
    history: '版本历史',
    history_empty: '暂无历史版本',
    history_restore: '恢复此版本',
    history_restored: '已恢复到该版本（可 Ctrl+Z 撤回）',
    external_reload: '检测到您更新了文档，Knote 将为您重新加载',
    history_current: '当前',
    history_preview_hint: '点击版本预览内容',
    history_close: '关闭',
    export_html: '导出 HTML',
    shortcuts: '快捷键',
    hw_accel: '硬件加速',
    hw_accel_hint: '关闭可排查显卡相关的崩溃，重启后生效',
    hw_accel_restart: '硬件加速设置将在重启后生效。现在重启应用吗？',
    hw_accel_failed: '设置保存失败，请重试',
    source_smart_edit: '源码智能编辑',
    source_smart_edit_hint: '源码模式下自动续列表/引用、选中包裹（默认关闭）',
    split_scroll_sync: '分栏滚动同步',
    split_scroll_sync_hint: '两侧按滚动比例联动，保持浏览同一位置',
    split_selection_follow: '选区联动预览',
    split_selection_follow_hint: '在源码中选中文本后，预览自动滚动到对应内容',
    shortcuts_title: '快捷键速查',
    align_left: '居左',
    align_center: '居中',
    align_right: '居右',
    outline: '大纲',
    outline_empty: '暂无标题',
    sidebar_hide: '隐藏左侧工具栏',
    sidebar_show: '显示左侧工具栏',
    text_color: '字体颜色',
    bg_color: '背景颜色',
    default_color: '默认',
    drag_move: '拖拽移动此块',
    stats_tooltip: '字符跳变可能与markdown格式转变有关，编辑器会自动清除行尾和文章末尾多余的空格与回车，若出现影响使用的情况请联系作者修复'
  },
  en: {
    editor: 'Editor',
    preview: 'Preview',
    modern_editor: 'Made by KV',
    pdf_readonly: 'Read-only',
    pdf_pages: 'pages',
    pdf_page: 'page',
    pdf_zoom_in: 'Zoom in',
    pdf_zoom_out: 'Zoom out',
    pdf_close: 'Close PDF',
    pdf_rendering: 'Rendering pages…',
    pdf_empty: 'This PDF has no displayable pages.',
    words: 'Words',
    chars: 'Chars',
    lines: 'Lines',
    single: 'Single',
    split: 'Split',
    theme: 'Theme',
    light: 'Light',
    dark: 'Dark',
    retro: 'Retro',
    load_sample_zh: 'Load Chinese Sample',
    load_sample_en: 'Load English Sample',
    copy_markdown: 'Copy Markdown',
    download_file: 'Download File',
    clear_all: 'Clear All',
    block_actions: 'Block Actions',
    bold_line: 'Bold Whole Line',
    insert_image_below: 'Insert Image',
    insert_image_local: 'Choose Local Image',
    insert_image_url: 'Enter Image URL',
    insert_image_url_prompt: 'Enter image URL:',
    insert_local_file: 'Insert Attachment (Copy to Folder)',
    insert_link_in_place: 'Insert File Link (Keep Original)',
    insert_local_file_no_dir: 'Open or save a local document first, then attach a file',
    attach_insert_title: 'Insert Attachment',
    attach_target_folder: 'Target folder',
    attach_source_file: 'File to insert',
    attach_pick_file: 'Choose file…',
    attach_confirm: 'Insert Attachment',
    attach_folder_note: 'The chosen folder is remembered and used by default next time',
    attach_doc_root: 'Document root',
    attach_load_error: 'Could not load the insertable folder list',
    attach_new_folder: 'New Folder',
    attach_rename_folder: 'Rename Folder',
    attach_new_folder_prompt: 'New folder name:',
    attach_rename_folder_prompt: 'Rename to:',
    attach_folder_op_failed: 'Folder operation failed',
    link_tooltip_open: 'Ctrl/Cmd + Left-click to open',
    file_double_click_open: 'Double-click to open',
    open_local_file_failed: 'Could not open the file with the system app',
    invalid_image_reference: 'Invalid image reference',
    image_paste_success: 'Image pasted',
    clear_formatting: 'Clear Formatting',
    paragraph: 'Paragraph',
    headings: 'Headings',
    lists_quote: 'Lists & Quote',
    bullet_list: 'Bullet List',
    ordered_list: 'Ordered List',
    task_list: 'Task List',
    quote: 'Quote',
    insert: 'Insert',
    image: 'Image',
    table: 'Table',
    code_block: 'Code Block',
    divider: 'Divider',
    type_placeholder: 'Type markdown here...',
    bold: 'Bold',
    underline: 'Underline',
    italic: 'Italic',
    strike: 'Strike',
    code: 'Inline Code',
    link: 'Link',
    enter_h1: 'Enter Heading 1',
    enter_h2: 'Enter Heading 2',
    enter_h3: 'Enter Heading 3',
    enter_h4: 'Enter Heading 4',
    enter_h5: 'Enter Heading 5',
    enter_h6: 'Enter Heading 6',
    prompt_img_url: 'Please enter image URL:',
    undo: 'Undo',
    redo: 'Redo',
    save: 'Save',
    open_file: 'Open File',
    open_legacy_workspace: 'Open Knote workspace',
    export_pdf: 'Export PDF',
    local_file_editing: 'Editing local file',
    temp_file_warning: 'Temp file, please save',
    image_zoom: 'Zoom',
    image_replace: 'Replace Image',
    image_delete: 'Delete Image',
    image_zoom_in: 'Zoom In',
    image_zoom_out: 'Zoom Out',
    image_original: 'Original Size',
    table_insert_row_above: 'Insert Row Above',
    table_insert_row_below: 'Insert Row Below',
    table_insert_col_left: 'Insert Column Left',
    table_insert_col_right: 'Insert Column Right',
    table_delete_row: 'Delete Row',
    table_delete_col: 'Delete Column',
    table_delete: 'Delete Table',
    table_prompt: 'Enter table dimensions (Rows x Cols, e.g. 3x3):',
    custom_dimensions: 'Custom Dimensions...',
    export_word: 'Export Word',
    export_md: 'Export Markdown',
    formula: 'Formula',
    formula_block: 'Formula Block',
    crop: 'Crop Image',
    crop_apply: 'Apply',
    crop_cancel: 'Cancel',
    crop_failed: 'Cannot crop this image (possibly cross-origin)',
    open: 'Open',
    open_folder: 'Open Folder',
    agent: 'Agent',
    agent_settings: 'Agent Settings',
    agent_settings_desc: 'Connect a model and shape how the assistant works with your documents.',
    agent_settings_ready: 'Ready',
    agent_settings_pending: 'Set up',
    agent_sessions: 'Recent chats',
    agent_quick_nav: 'Quick selection',
    agent_clear: 'Clear chat',
    agent_base_url: 'API base URL',
    agent_api_key: 'API Key',
    agent_model: 'Model name',
    agent_jina_key: 'Jina key for web search (optional)',
    agent_pdf_page_hint: 'No native PDF reading: Knote sends the complete text layer and renders images only for pages explicitly selected by the Agent.',
    agent_pdf_sending: 'Sending PDF…',
    agent_pdf_to_images: 'Converting PDF to page images…',
    agent_pdf_to_text: 'Converting PDF to a readable document…',
    agent_pdf_processing: 'Processing PDF…',
    agent_setup_title: 'Set up the AI assistant',
    agent_setup_desc: 'Connect any OpenAI-compatible or Anthropic endpoint; config and keys stay in this browser.',
    agent_clear_title: 'Clear this conversation?',
    agent_clear_desc: 'All messages in this chat will be deleted. This cannot be undone.',
    agent_cancel: 'Cancel',
    agent_clear_do: 'Clear',
    dlg_ok: 'OK',
    dlg_cancel: 'Cancel',
    ctx_cut: 'Cut',
    ctx_copy: 'Copy',
    ctx_paste: 'Paste',
    ctx_paste_plain: 'Paste as plain text',
    ctx_clear_format: 'Clear formatting',
    ctx_insert_above: 'Insert row above',
    ctx_insert_below: 'Insert row below',
    ctx_copy_row: 'Copy row',
    ctx_delete_row: 'Delete row',
    ctx_to_h1: 'Turn into Heading 1',
    ctx_to_h2: 'Turn into Heading 2',
    ctx_to_h3: 'Turn into Heading 3',
    ctx_to_text: 'Turn into text',
    ctx_to_ul: 'Turn into bullet list',
    ctx_to_ol: 'Turn into numbered list',
    ctx_to_quote: 'Turn into quote',
    ctx_crop: 'Crop image',
    ctx_copy_image: 'Copy image',
    ctx_save_image: 'Save image as',
    ctx_delete_image: 'Delete image',
    ctx_open: 'Open',
    ctx_open_new_tab: 'Open in new tab',
    ctx_copy_name: 'Copy name',
    ctx_delete: 'Delete',
    ctx_expand: 'Expand',
    ctx_collapse: 'Collapse',
    agent_sugg_1: 'Summarize this document',
    agent_sugg_2: 'Fix typos across the document',
    agent_sugg_3: 'Improve headings and layout',
    ai_ask: 'Ask AI',
    ai_polish: 'Polish',
    ai_translate: 'Translate',
    ai_expand: 'Expand',
    ai_condense: 'Condense',
    locate: 'Locate',
    agent_persona: 'Persona / style (optional)',
    agent_persona_ph: 'e.g. always academic tone; keep replies short',
    agent_sel_ref: 'Quoting selection',
    agent_tok_in: 'in',
    agent_tok_out: 'out',
    agent_web_search: 'Web search',
    agent_web_search_hint: 'Desktop and Android query the selected engines over your network; All queries them in parallel and fuses results. With a Jina key, only a failed DuckDuckGo search may send the query to Jina. Turning this off disables general and academic network search.',
    agent_search_engines: 'Enabled search engines',
    agent_search_engines_hint: 'Select one or more. The assistant can use only enabled engines executable in this runtime; clearing the last one also turns web search off.',
    agent_search_region: 'Search region',
    agent_search_region_auto: 'Auto (IP-based)',
    agent_search_region_hint: 'Force search results to a language/region. "Auto" lets the engine decide from your IP; choose "English" when on a VPN or if Chinese results are overwhelming.',
    agent_jina_hint: '(DuckDuckGo web channel / native fallback only) Queries are sent to r.jina.ai when used; Bing and Mojeek are never silently substituted. Free key at jina.ai.',
    agent_verify: 'Extra model review',
    agent_verify_hint: 'Optional final-answer review, off by default. When enabled, the model checks the execution ledger and may retry up to 2 passes. Operation review is separate.',
    agent_copy_message: 'Copy full reply',
    agent_copy_code: 'Copy code',
    agent_copy_table: 'Copy table',
    agent_copied: 'Copied',
    agent_streaming_draft: 'Generating',
    agent_testing: 'Testing',
    agent_receipt_success: 'System verified this run',
    agent_receipt_partial: 'System verified part of this run',
    agent_receipt_failed: 'No verified mutation in this run',
    agent_receipt_blocked: 'Unsupported completion claim blocked',
    agent_receipt_staged: '{n} pending change(s)',
    agent_receipt_accepted: '{n} change(s) approved',
    agent_receipt_rejected: '{n} change(s) rejected',
    agent_receipt_file_staged: '{n} file change(s) pending review (not saved)',
    agent_receipt_file_accepted: '{n} applied to the document buffer (disk save unverified)',
    agent_receipt_file_rejected: '{n} file change(s) rejected',
    agent_receipt_direct: '{n} direct operation(s)',
    agent_receipt_failures: '{n} unresolved failure(s)',
    agent_protocol_openai: 'OpenAI-compatible',
    agent_capabilities: 'Model capabilities',
    agent_cap_chat: 'Chat',
    agent_cap_tools: 'Tools',
    agent_cap_image: 'Images',
    agent_cap_pdf: 'Native PDF',
    agent_supported: 'Supported',
    agent_unsupported: 'Unsupported',
    agent_cap_rejected: '{capability}: endpoint rejected the probe ({detail})',
    agent_cap_probe_incomplete: '{capability} probe did not finish ({detail}); try again later',
    agent_cap_result_success_title: 'Capability check complete',
    agent_cap_result_partial_title: 'Some capabilities are available',
    agent_cap_result_failure_title: 'Connection check failed',
    agent_cap_result_success: 'The model is connected and every capability passed: {supported}.',
    agent_cap_result_partial: 'The model is connected.\nAvailable: {supported}\nUnavailable: {unsupported}',
    agent_cap_result_failure: 'Basic chat did not connect. Check the API URL, key, and model name.',
    agent_cap_result_detail: 'Details: {detail}',
    agent_cap_result_none: 'None',
    agent_cap_ctx_detected: 'Context window detected automatically: {n} tokens',
    agent_search_region_en: 'English / International',
    agent_search_region_zh: 'Chinese',
    agent_step_n: '(step {n})',
    agent_page_progress: 'Page {page} / {total}',
    agent_target_page_progress: 'Target {index} / {total} · PDF page {page}',
    agent_pages_short: '{n} pages',
    agent_parsing: 'Parsing',
    agent_pdf_parse_failed: 'Layout parsing failed: {error} (the PDF will be sent by reference and remains readable through tools)',
    agent_remove_selection: 'Remove quoted selection',
    agent_remove_attachment: 'Remove attachment {name}',
    agent_workspace_aria: 'Agent workspace',
    batch_title: 'Multi-agent batch',
    agent_pdf_layout: 'PDF layout analysis (PaddleOCR)',
    agent_pdf_layout_hint: 'Let the assistant use local PaddleOCR / PP-Structure to precisely detect titles/figures/tables in a PDF and insert them. Click below to download & set up (into an isolated env; needs Python, 3.10/3.11 recommended). Falls back to vision-based cropping when not set up.',
    agent_pdf_env_ready: 'Ready',
    agent_pdf_env_install: 'Download & set up',
    agent_pdf_env_reinstall: 'Reinstall',
    agent_pdf_env_uninstall: 'Uninstall',
    agent_pdf_env_installing: 'Downloading & setting up (large, may take minutes — keep open)…',
    agent_pdf_env_uninstall_confirm: 'Uninstall the PDF layout environment? This deletes the downloaded dependencies (several hundred MB).',
    agent_pdf_env_advanced: 'Advanced: custom environment',
    agent_pdf_env_dir_label: 'Env directory (empty = default)',
    agent_pdf_env_py_label: 'Python interpreter (empty = auto-detect)',
    agent_pdf_env_cfg_save: 'Save',
    agent_pdf_env_cfg_hint: 'Changing the directory requires reinstalling; the old folder is left untouched.',
    agent_pdf_env_cfg_inuse: 'Active env directory',
    agent_pdf_env_manual: 'Manual setup guide',
    agent_pdf_env_manual_step1: 'Install Python 3 (3.10 / 3.11 recommended).',
    agent_pdf_env_manual_step2: 'In the repo sidecar directory, run:',
    agent_pdf_env_manual_step3: 'Come back here and use the one-click setup or re-check the service.',
    agent_check: 'Save & detect capabilities',
    agent_key_local_hint: 'The key is stored only in this browser',
    agent_no_tools_hint: 'This model does not support tool calling; the agent can chat but cannot read or edit the workspace',
    agent_empty_hint: 'I inspect the workspace first, then read, edit, run tests, or organize it; I can also search the web and process PDFs. The selected review mode determines whether an operation asks for confirmation.',
    agent_empty_title: 'Where should we begin?',
    agent_input_placeholder: 'Ask something or give me a workspace task… (Enter to send)',
    agent_configure_first: 'Configure the model in ⚙ settings first',
    agent_attach: 'Attach image / PDF',
    agent_drop_hint: 'Drop to attach image / PDF',
    agent_drop_unsupported: 'Only images and PDF files are supported',
    agent_drop_need_config: 'This model does not support images/PDF, or is not configured',
    agent_send: 'Send',
    agent_stop: 'Stop',
    agent_question_title: 'Agent needs clarification',
    agent_question_answered: 'Answered',
    agent_question_placeholder: 'Type your answer… (Enter to send)',
    agent_question_skip: 'Not now',
    agent_answer: 'Answer',
    agent_review_mode: 'Review mode',
    agent_review_policy_label: 'Approval policy',
    agent_review_policy_manual: 'Manual',
    agent_review_policy_manual_desc: 'Controlled operations wait for your confirmation.',
    agent_review_policy_review: 'Review',
    agent_review_policy_review_desc: 'Agent rewrite operations are reviewed automatically.',
    agent_review_policy_allow_all: 'Allow all',
    agent_review_policy_allow_all_desc: 'Agent operations in this session and tab run directly.',
    agent_review_document_label: 'Review document edits manually',
    agent_review_document_tab_manual: 'On',
    agent_review_document_tab_manual_desc: 'When on, only visible Markdown diffs wait for manual review.',
    agent_review_document_all_auto: 'Off',
    agent_review_document_all_auto_desc: 'When off, Markdown diffs auto-apply after exact CAS succeeds.',
    agent_review_safety_boundary: 'Validation, workspace boundaries, no-overwrite, isolation, and CAS remain mandatory.',
    agent_review_allow_all_confirm_title: 'Enable Allow all for this Agent session and tab?',
    agent_review_allow_all_confirm_message: 'This temporary grant applies only to the current tab in the current Agent session and can be disabled at any time. Once enabled, create, edit, move, rename, download, delete, and any controlled command or isolated-code operations actually available in this environment will not ask for another human confirmation. The Review document edits manually switch controls only whether visible Markdown diffs wait for you. Validation, workspace boundaries, no-overwrite, isolation, readback, and exact CAS remain mandatory; a failed technical check is reported as a failure. App restart, chat clear or deletion, session switch, and tab switch grant no authority elsewhere.',
    agent_review_auto_pass: '{n} review item(s) passed automatically: {tool}',
    agent_review_allow_all_pass: '{n} item(s) handled under Allow all: {tool}',
    agent_review_manual_fallback: 'Returned to manual review: {reason}',
    agent_permission_review_fallback: 'Automatic approval did not pass: {reason}',
    agent_permission_title: 'Permission required',
    agent_permission_create_file: 'Create file',
    agent_permission_create_folder: 'Create folder',
    agent_permission_edit_file: 'Edit file',
    agent_permission_batch_process: 'Generate files in batch',
    agent_permission_move_file: 'Move file',
    agent_permission_rename_file: 'Rename file',
    agent_permission_run_command: 'Run restricted command',
    agent_permission_run_code: 'Run isolated JavaScript',
    agent_permission_download_file: 'Download file',
    agent_permission_chars: '{n} characters',
    agent_permission_replace_one: 'Replace one match',
    agent_permission_replace_all: 'Replace all matches',
    agent_permission_batch_detail: '{n} files · output suffix {suffix}',
    agent_permission_command_detail: 'Runs for at most {n}s; a native command confirmation follows',
    agent_permission_code_detail: 'Runs for at most {n}ms in a dedicated Chromium OS sandbox; no native command confirmation',
    agent_permission_download_detail: 'Exact limit {size}; streamed to disk; existing files are never overwritten',
    agent_permission_download_no_limit: 'No fixed per-file limit; streamed to disk; constrained by available disk space and resource policy; existing files are never overwritten',
    agent_permission_destination: 'Destination: {target}',
    agent_permission_once: 'Allows only the exact call shown. If denied, the same target will not be requested again during this run.',
    agent_permission_allow: 'Allow once',
    agent_permission_deny: 'Deny',
    agent_permission_stop: 'Stop task',
    agent_steer: 'Steer',
    agent_steer_hint: 'Add to the current task at its next safe boundary',
    agent_queue_next: 'Next',
    agent_queue_next_hint: 'Run after the current task',
    agent_queue_title: 'Message queue',
    agent_queued: 'Queued',
    agent_queue_cancel: 'Cancel queued message',
    agent_queue_paused: 'Paused after the task stopped',
    agent_queue_context_changed: 'Document context changed; confirm before running',
    agent_queue_context_limit: 'The model context is full; this steering message was paused',
    agent_queue_not_configured: 'The Agent configuration is unavailable; this message was paused',
    agent_queue_attachments_missing: 'Attachments expired after reload; cancel and send again',
    agent_queue_run_here: 'Run here',
    agent_queue_attachments_blocked: 'Messages with attachments cannot wait in the queue yet. Send after the current task finishes.',
    agent_queue_full: 'This conversation queue is full (32 messages).',
    agent_queue_storage_failed: 'The message could not be persisted; your draft was kept.',
    agent_queue_prompt_too_long: 'The message exceeds 32,000 characters and was not queued.',
    agent_queue_failed: 'The message could not be queued; your draft was kept.',
    agent_hunks_pending: 'pending changes',
    agent_document_changes: 'document changes',
    agent_accept_all: 'Accept all',
    agent_reject_all: 'Reject all',
    agent_hunk_accept: 'Accept this change',
    agent_review_locked: 'The owner run or independent reviewer is still processing these changes. Review will unlock when it finishes.',
    agent_hunk_reject: 'Reject this change',
    agent_new_chat: 'New chat',
    agent_hide: 'Hide agent',
    agent_workspace: 'Workspace',
    agent_workspace_running: 'Working',
    agent_workspace_hide: 'Hide workspace',
    agent_workspace_empty: 'Once the agent starts working, its plan, tool calls, searched/fetched URLs, and files read appear here in real time.',
    agent_plan: 'Plan',
    agent_subagents: 'Sub-agents',
    agent_workspace_activity: 'Activity',
    agent_reset_size: 'Reset size',
    agent_recall: 'Recall assistant',
    agent_open: 'Open assistant',
    agent_to_sidebar: 'Switch to assistant sidebar',
    agent_to_float: 'Switch to floating assistant',
    assistant_drop_hint: 'Drag the assistant here to open the sidebar',
    product_tour: 'Product tour',
    agent_running_badge: 'Running',
    agent_running_elsewhere: 'Another chat is generating a reply…',
    folder_hint: 'Only .md files in the folder will be read',
    folder_unsupported: 'Folder access is not supported in this browser (Chrome/Edge required)',
    folder_empty: 'No .md files found',
    relimg_banner: 'This document references local images, but the browser can’t access their folder.',
    relimg_grant: 'Grant image folder',
    relimg_dismiss: 'Dismiss',
    browsing_now: 'Browsing',
    folder_pick_prompt: 'Select a markdown file to open, or create a new one',
    folder_pick_hint: 'Click a file in the tree on the left, or use the button below',
    mascot_mute: 'Mute for this session',
    mascot_busy: 'Assistant working · open',
    mascot_close_once: 'Dismiss',
    ctx_move: 'Move to…',
    ctx_open_as_folder: 'Show in Explorer',
    move_title: 'Move',
    create_target_title_file: 'Choose new file location',
    create_target_title_folder: 'Choose new folder location',
    create_target_hint: 'Choose a destination inside this workspace',
    create_target_confirm: 'Continue',
    move_exists: 'The destination already has an item with this name.',
    move_active_blocked: 'This document (or one inside it) is being edited or open in another tab — close that tab / switch away first.',
    move_none: 'No destination folders available',
    agent_reasoning: 'Thinking depth',
    agent_reasoning_hint: 'Let reasoning-capable models think longer before answering (more accurate, slower, pricier). Models without the parameter ignore it / degrade gracefully.',
    agent_reasoning_default: 'Default',
    agent_reasoning_low: 'Low',
    agent_reasoning_medium: 'Medium',
    agent_reasoning_high: 'High',
    agent_rollback: 'Rewind',
    agent_rollback_hint: 'Rewind to this message: later messages are removed (the original is kept as a branch) and the text returns to the input',
    agent_rollback_done: 'Rewound. The original conversation was saved as a branch; the message is back in the input.',
    agent_ctx_window: 'Context window (tokens, optional)',
    agent_ctx_window_hint: '0 = hidden. Capability check tries to auto-detect; enter manually (e.g. 128000) if not found — a usage ring then appears in the chat box.',
    agent_sec_conn: 'Connection & model',
    agent_sec_conn_desc: 'Choose a compatible protocol and connect your model endpoint.',
    agent_sec_extra: 'Enhancements',
    agent_sec_extra_desc: 'Tune search, verification, and personal working preferences.',
    agent_chat_theme: 'Chat appearance',
    agent_chat_theme_desc: 'Choose the chat panel background style.',
    agent_chat_theme_white: 'Clean white',
    agent_chat_theme_aurora: 'Kiwi glow',
    agent_ctx_used: 'Context used',
    missing_img_banner: '{n} image(s) in this document can’t be shown: their data was not saved with the document (usually from copying or generating it outside Knote). If you have the originals, re-insert and save.',
    missing_img_dismiss: 'Dismiss',
    files: 'Files',
    file_new: 'New file',
    center_editor: 'Center editor',
    file_new_prompt: 'File name:',
    file_rename: 'Rename',
    file_rename_prompt: 'Rename to:',
    file_refresh: 'Refresh',
    file_exists: 'A file or folder with that name already exists',
    file_bad_name: 'Name contains invalid characters',
    folder_new: 'New folder',
    folder_new_prompt: 'Folder name:',
    file_new_here: 'New file here',
    folder_new_here: 'New folder here',
    tab_new: 'New tab',
    tab_close: 'Close tab',
    tab_untitled: 'Untitled',
    tab_close_confirm: 'Close this tab? Unsaved content will be lost.',
    ctx_view_image: 'View image',
    viewer_zoom_in: 'Zoom in',
    viewer_zoom_out: 'Zoom out',
    viewer_reset: 'Reset zoom',
    viewer_close: 'Close (Esc)',
    find_placeholder: 'Find',
    replace_placeholder: 'Replace with',
    find_prev: 'Previous (Shift+Enter)',
    find_next: 'Next (Enter)',
    find_case: 'Match case',
    find_word: 'Whole word',
    find_toggle_replace: 'Replace',
    find_replace_one: 'Replace',
    find_replace_all: 'Replace all',
    find_close: 'Close (Esc)',
    find_none: 'No results',
    find_replaced_n: 'Replaced {n}',
    quick_open_placeholder: 'Quick open by file name…',
    quick_open_need_folder: 'Open a folder workspace first',
    quick_open_empty: 'No matching files',
    recent_open: 'Recent',
    recent_clear: 'Clear recent',
    recent_remove: 'Remove from recents',
    fold_section: 'Fold / unfold',
    folder_search_placeholder: 'Search across folder…',
    folder_search_none: 'No matches found',
    folder_search_count: '{f} files, {n} matches',
    searching: 'Searching…',
    history: 'Version history',
    history_empty: 'No previous versions yet',
    history_restore: 'Restore this version',
    history_restored: 'Restored (Ctrl+Z to undo)',
    external_reload: 'File changed on disk — reloading the latest version',
    history_current: 'Current',
    history_preview_hint: 'Click a version to preview',
    history_close: 'Close',
    export_html: 'Export HTML',
    shortcuts: 'Shortcuts',
    hw_accel: 'Hardware acceleration',
    hw_accel_hint: 'Disable to triage GPU-related crashes; applies after restart',
    hw_accel_restart: 'The hardware acceleration setting applies after a restart. Restart now?',
    hw_accel_failed: 'Could not save the setting, please retry',
    source_smart_edit: 'Source smart editing',
    source_smart_edit_hint: 'Auto-continue lists/quotes and surround selections in source mode (off by default)',
    split_scroll_sync: 'Sync split scrolling',
    split_scroll_sync_hint: 'Keep both panes at the same scroll position',
    split_selection_follow: 'Preview follows selection',
    split_selection_follow_hint: 'Selecting text in the source scrolls the preview to match',
    shortcuts_title: 'Keyboard shortcuts',
    align_left: 'Align Left',
    align_center: 'Align Center',
    align_right: 'Align Right',
    outline: 'Outline',
    outline_empty: 'No headings yet',
    sidebar_hide: 'Hide left sidebar',
    sidebar_show: 'Show left sidebar',
    text_color: 'Text Color',
    bg_color: 'Background',
    default_color: 'Default',
    drag_move: 'Drag to move this block',
    stats_tooltip: 'Count fluctuations may differ due to Markdown consistency. The editor automatically trims trailing whitespace and file-end newlines. Contact author if this affects use.'
  }
}

const t = (key) => translations[lang.value][key] || key
const tf = (key, vars = {}) => {
  let value = String(t(key))
  for (const [name, replacement] of Object.entries(vars)) value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}

const textareaRef = ref(null)
const editorAreaRef = ref(null)
const previewAreaRef = ref(null)
const previewRef = ref(null)
const codeBlockTemplate = '```js\n{content}\n```'
const codeSample = "console.log('Hello')"
const tableTemplate = '| Title | Content |\n| --- | --- |\n| Left | Right |'
const hrTemplate = '\n---\n'
const toolbarVisible = ref(false)
const toolbarMode = ref('selection')
const toolbarTop = ref(0)
const toolbarLeft = ref(0)
const selectionToolbarRef = ref(null)
const isToolbarInteracting = ref(false)
const lineToolbarRef = ref(null)
const tableToolbarRef = ref(null)
const lineButtonVisible = ref(false)
const lineButtonTop = ref(0)
const lineButtonLeft = ref(-12)
const isTableSelectorOpen = ref(false)
const tableHoverRows = ref(0)
const tableHoverCols = ref(0)
const savedSelection = ref(null)
const customRows = ref(3)
const customCols = ref(3)
const tableToolbarVisible = ref(false)
const tableToolbarTop = ref(0)
const tableToolbarLeft = ref(0)
const focusedTable = ref(null)
const selectedTableCells = ref(new Set())
const hoveredTable = ref(null)
const tableMouseDownFromTable = ref(false)
const tableFocusReady = ref(false)
const lineStartIndex = ref(0)
const lineHeight = ref(24)
const paddingTop = ref(16)
const paddingLeft = ref(16)
const lastHoverY = ref(0)

const md = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true,
  // typographer must stay OFF: it rewrites quotes/dashes at render time, which would
  // leak back into the markdown source on every block commit (lossy roundtrip)
  typographer: false,
  highlight: (code, lang) => {
    // Store raw code in data-code for perfect round-trip
    const encoded = encodeURIComponent(code)
    // mermaid isn't a hljs language — keep the class so the diagram renderer
    // (renderMermaidIn) can find and replace it after the HTML mounts
    if (lang === 'mermaid') {
      return `<pre class="hljs"><code class="language-mermaid" data-code="${encoded}">${md.utils.escapeHtml(code)}</code></pre>`
    }
    // Preview-side language tag on fenced code blocks, matching the editor's
    // corner label (Issue #12b). The label lives INSIDE the <pre> (after the
    // <code>): markdown-it wraps any highlight output not starting with <pre
    // in its own pre/code shell, and turndown's copy rule reads firstChild.
    const label = lang ? `<span class="knote-md-code-lang" aria-hidden="true">${md.utils.escapeHtml(lang)}</span>` : ''
    if (lang && hljs.getLanguage(lang)) {
      return `<pre class="hljs"><code class="language-${lang}" data-code="${encoded}">${hljs.highlight(code, { language: lang }).value}</code>${label}</pre>`
    }
    return `<pre class="hljs"><code class="language-plaintext" data-code="${encoded}">${md.utils.escapeHtml(code)}</code>${label}</pre>`
  }
})
  .use(markdownItCjkFriendly)
  .use(emoji)
  .use(taskLists, { enabled: true, label: true, labelAfter: true })
  .use(footnote)
  .use(sub)
  .use(sup)
  .use(abbr)
  .use(deflist)
  .use(ins)
  .use(mark)
  .use(mdKatex.default || mdKatex, { throwOnError: false })

installKnoteMarkdownImagePolicy(md)

// Custom Emoji Renderer to preserve syntax
md.renderer.rules.emoji = function(token, idx) {
  // We prepend and append ":" to the markup (e.g. "sparkles" -> ":sparkles:")
  return `<span data-knote-emoji=":${token[idx].markup}:">${token[idx].content}</span>`
}

// Callout / admonition blocks: a blockquote whose first line is `[!type]`
// (Obsidian / GitHub syntax) renders as a colored card. The marker is
// stripped from the visible content and the type drives the styling +
// icon (via CSS on .knote-callout-<type>).
const CALLOUT_TYPES = { note: 1, info: 1, tip: 1, success: 1, warning: 1, danger: 1, question: 1, quote: 1 }
md.core.ruler.after('block', 'knote_callouts', (state) => {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokens[i].type !== 'blockquote_open') continue
    if (tokens[i + 1].type !== 'paragraph_open' || tokens[i + 2].type !== 'inline') continue
    const inline = tokens[i + 2]
    const m = /^\[!(\w+)\]\s*(.*)$/s.exec(inline.content)
    if (!m) continue
    const type = m[1].toLowerCase()
    const kind = CALLOUT_TYPES[type] ? type : 'note'
    tokens[i].attrJoin('class', 'knote-callout knote-callout-' + kind)
    // strip the `[!type]` marker from the rendered content
    inline.content = m[2]
    if (inline.children && inline.children[0] && inline.children[0].type === 'text') {
      inline.children[0].content = inline.children[0].content.replace(/^\[!\w+\]\s*/, '')
    }
    // a title token becomes the callout header line
    tokens[i].attrSet('data-callout', kind)
  }
})

const sanitizeHtml = (html) =>
  DOMPurify.sanitize(html, {
    ADD_TAGS: ['input', 'br', 'mark', 'ins', 'sub', 'sup', 'span'],
    ADD_ATTR: ['checked', 'type', 'disabled', 'style', 'data-knote-emoji', 'class', 'data-code', 'data-agent-copy', 'data-copy-key', 'data-testid', 'data-sline', 'data-eline'],
    // local-file links: relative destinations (assets/...) already pass, but
    // absolute drive-letter (C:/...) and file:// hrefs need an explicit rule.
    // These hrefs are never auto-opened — clicks go through knote:open-path,
    // which authorizes against the registered workspace roots.
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|file):|[a-zA-Z]:[\\/]|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  })

// Image Store: maps short IDs to base64 data URLs
// This keeps the markdown editor clean instead of showing huge base64 strings
const imageStore = reactive({})
let imageIdCounter = 0

// ---- Relative-path images ----
// Markdown from other tools (Typora / Obsidian / VS Code) references local
// images by RELATIVE PATH, e.g. ![](assets/week13/x.png). The sandboxed
// renderer can't load those by src (it has no base directory). We resolve each
// to a data URL for DISPLAY ONLY — swapped in at the preview and editor
// boundaries — while `content` and every save keep the relative path untouched
// (single-source-of-truth stays intact; the file is never rewritten to inline
// the image).
const relImages = reactive({}) // exact-path-text -> resolved data URL
let assetsFlushTimer = null
let assetsFlushGeneration = 0
// generation token: resolves are async (IPC / FileReader) and every doc open
// clears + refills the map — a stale in-flight resolve from the PREVIOUS doc
// must not land in the next doc's freshly cleared map (it could shadow a
// same-named path with the wrong image, or corrupt the set-swap)
let relImgGen = 0
const clearRelImages = () => {
  relImgGen++
  assetsFlushGeneration++
  clearTimeout(assetsFlushTimer)
  for (const k in relImages) delete relImages[k]
}
// display-boundary swaps (both `](path)` and `](path "title")` forms)
const relPathsToDataUrls = (mdText) => {
  const mappings = Object.entries(relImages)
  return mappings.length ? rewriteImageResourcePaths(mdText, mappings) : mdText
}
const dataUrlsToRelPaths = (mdText) => {
  const mappings = Object.entries(relImages)
  return rewriteImageResourcePaths(mdText, mappings.map(([path, url]) => [url, path]))
}
const relImgFileToDataUrl = (fileHandle) => fileHandle.getFile().then((file) => new Promise((res, rej) => {
  const r = new FileReader()
  r.onload = () => res(r.result)
  r.onerror = rej
  r.readAsDataURL(file)
}))
const resolveRelImagePath = async (dirHandle, relPath) => {
  const segs = decodeRelativeResourcePath(relPath)
  if (!segs?.length) return null
  // desktop: desktopFs.getFile() reads utf8 (would corrupt binary) — read the
  // image as raw bytes -> data URL via IPC, joined onto the folder's real path
  if (dirHandle && dirHandle._deskPath && window.knoteDesktop && window.knoteDesktop.readImageFile) {
    const sep = dirHandle._deskPath.includes('\\') ? '\\' : '/'
    const abs = dirHandle._deskPath.replace(/[\\/]$/, '') + sep + segs.join(sep)
    return await window.knoteDesktop.readImageFile(abs)
  }
  // browser File System Access: getFile() returns a real File (binary-safe)
  const fname = segs.pop()
  let dir = dirHandle
  for (const s of segs) dir = await dir.getDirectoryHandle(s)
  const fh = await dir.getFileHandle(fname)
  return await relImgFileToDataUrl(fh)
}
// scan the current document for relative image refs and resolve each against
// `dirHandle` (the document's own directory). Reactive: filling relImages
// re-runs renderedHtml / richMarkdown so the images appear as they load.
const loadRelativeImages = async (dirHandle) => {
  if (!dirHandle) return
  const gen = relImgGen // superseded the moment another doc clears the map
  const source = content.value
  // The code-aware image collector tokenizes by line. Almost every Markdown
  // document contains no image syntax; reject that overwhelmingly common case
  // with two native substring scans instead of allocating hundreds of
  // thousands of line fragments for a multi-megabyte file.
  if (!source.includes('![') && !/<img\b/i.test(source)) return
  const paths = collectImageResourcePaths(source)
    .filter((p) => !/^(data:|https?:|knote-img:|blob:|file:|#|\/)/i.test(p))
  for (const p of paths) {
    if (gen !== relImgGen) return // a newer doc took over — stop, don't poison
    if (relImages[p]) continue
    try {
      const url = await resolveRelImagePath(dirHandle, p)
      if (gen === relImgGen && url) relImages[p] = url
    } catch { /* missing / unreadable — leave the ref broken, don't crash */ }
  }
}

// ---- Persist embedded images as files in the doc's assets/ folder ----
// Inline base64 / session-local knote-img images are fragile: they bloat the
// .md and vanish if the doc leaves Knote without being inlined. When the doc
// has a writable directory, we write each image's bytes to <docdir>/assets/ and
// rewrite the reference to a durable RELATIVE PATH (resolved back for display
// via relImages). Falls back to the inline knote-img form when there's no dir
// (untitled doc, or a single file opened via the browser picker).
const docDir = ref(null) // the current document's own directory handle, or null
const mimeToExt = (dataUrl) => {
  const m = /^data:image\/([a-zA-Z0-9.+-]+)/.exec(dataUrl || '')
  const t = (m ? m[1] : 'png').toLowerCase()
  return ({ jpeg: 'jpg', 'svg+xml': 'svg' })[t] || t.replace(/[^a-z0-9]/g, '') || 'png'
}
const b64ToBytes = (b64) => {
  const bin = atob(b64 || '')
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}
// Binary-safe write of an image into <dir>/assets/<name> on either platform.
const writeAssetFile = async (dir, name, dataUrl) => {
  const base64 = dataUrl.split(',')[1] || ''
  if (dir._deskPath && window.knoteDesktop && window.knoteDesktop.writeImageFile) {
    const sep = dir._deskPath.includes('\\') ? '\\' : '/'
    const abs = dir._deskPath.replace(/[\\/]$/, '') + sep + 'assets' + sep + name
    await window.knoteDesktop.writeImageFile(abs, base64)
    return
  }
  // browser File System Access: assets/ subfolder, raw bytes (not utf8)
  const assets = await dir.getDirectoryHandle('assets', { create: true })
  const fh = await assets.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(b64ToBytes(base64))
  await w.close()
}
const persistImageToAssets = async (id, dataUrl, targetDir, knownPaths, stillCurrent) => {
  if (!targetDir || !dataUrl || !dataUrl.startsWith('data:image/')) return null
  const relPath = `assets/knote-${id}.${mimeToExt(dataUrl)}`
  if (knownPaths.has(relPath)) return relPath // already written for this document session
  try {
    await writeAssetFile(targetDir, `knote-${id}.${mimeToExt(dataUrl)}`, dataUrl)
    if (!stillCurrent()) return null
    knownPaths.add(relPath)
    return relPath
  } catch (err) {
    console.error('Persist image to assets failed:', err)
    return null
  }
}
// Debounced sweep: move any in-store (knote-img) images to assets/ files and
// swap the content refs to relative paths. The editor is unaffected — both
// forms resolve to the SAME data URL at the display boundary, so richMarkdown
// is byte-identical before/after and the editor never re-parses.
const flushImagesToAssets = async (generation = assetsFlushGeneration) => {
  if (generation !== assetsFlushGeneration || !docDir.value || pendingHunks.value.length) return
  // The bounded rich chunk is the newest source of truth until its idle
  // commit. Converting refs in the older whole-document string would overwrite
  // that draft when the page state is rebuilt.
  if (largeDocumentPlainMode.value && largeSourceDraftDirty) return
  const targetTab = activeTab()
  const targetTabId = activeTabId.value
  const targetKey = snapshotDocKey()
  const targetDir = docDir.value
  const targetRelImgGen = relImgGen
  const targetEditRevision = documentEditRevision(targetKey)
  const sourceContent = content.value
  if (!sourceContent.includes('knote-img:')) return
  const stillCurrent = () => generation === assetsFlushGeneration &&
    activeTab() === targetTab && activeTabId.value === targetTabId && snapshotDocKey() === targetKey &&
    docDir.value === targetDir && relImgGen === targetRelImgGen &&
    documentEditRevision(targetKey) === targetEditRevision && content.value === sourceContent &&
    pendingHunks.value.length === 0
  const re = /knote-img:([^\s)"'\]]+)/g
  const ids = new Set()
  let m
  while ((m = re.exec(sourceContent))) { if (imageStore[m[1]]) ids.add(m[1]) }
  if (!ids.size) return
  const conv = []
  const knownPaths = new Set(Object.keys(relImages))
  for (const id of ids) {
    if (!stillCurrent()) return
    const rel = await persistImageToAssets(id, imageStore[id], targetDir, knownPaths, stillCurrent)
    if (!stillCurrent()) return
    if (rel) conv.push([id, rel])
  }
  if (!conv.length || !stillCurrent()) return
  let out = sourceContent
  for (const [id, rel] of conv) {
    out = out.split(`knote-img:${id}`).join(rel)
    relImages[rel] = imageStore[id]
  }
  if (out !== sourceContent) replaceWholeDocumentContent(out)
}
const scheduleAssetsFlush = () => {
  const generation = ++assetsFlushGeneration
  clearTimeout(assetsFlushTimer)
  if (!docDir.value) return
  assetsFlushTimer = setTimeout(() => flushImagesToAssets(generation), 500)
}
// The conversion commit schedules one cheap follow-up scan; it contains no
// knote-img ids and exits immediately. Avoiding a cross-document boolean lock
// is more important than suppressing that single no-op timer.
watch(content, scheduleAssetsFlush)

// true while the document references local relative-path images that haven't
// been resolved (a single file opened via the browser picker has no directory
// handle — the user can grant its folder to load them)
const relImagesNeedGrant = ref(false)
const hasUnresolvedRelImages = () => {
  const source = content.value
  if (!source.includes('![') && !/<img\b/i.test(source)) return false
  for (const p of collectImageResourcePaths(source)) {
    if (/^(data:|https?:|knote-img:|blob:|file:|#|\/)/i.test(p)) continue
    if (!relImages[p]) return true
  }
  return false
}
// user grants the document's own folder (only way the browser exposes a
// directory) so ![](relative/x.png) images can be read
const grantImageFolder = async () => {
  if (!isAndroidNative && !globalThis.showDirectoryPicker) { globalThis.alert(t('folder_unsupported')); return }
  const targetTab = activeTab()
  const targetTabId = activeTabId.value
  const targetKey = snapshotDocKey()
  const targetRelImgGen = relImgGen
  const targetLoadGeneration = documentLoadGeneration
  const stillCurrent = () => activeTab() === targetTab && activeTabId.value === targetTabId &&
    snapshotDocKey() === targetKey && relImgGen === targetRelImgGen &&
    documentLoadGeneration === targetLoadGeneration
  let temporaryGrantId = ''
  try {
    const dir = isAndroidNative
      ? await pickSafTree({ writable: false })
      : await globalThis.showDirectoryPicker({ mode: 'read' })
    temporaryGrantId = String(dir?._knoteSafGrantId || '')
    if (!stillCurrent()) return
    await loadRelativeImages(dir)
    if (!stillCurrent()) return
    relImagesNeedGrant.value = hasUnresolvedRelImages()
    notify(relImagesNeedGrant.value
      ? (lang.value === 'zh' ? '部分图片仍未找到，请确认选的是该文档所在文件夹' : 'Some images still missing — pick the document’s own folder')
      : (lang.value === 'zh' ? '图片已加载' : 'Images loaded'))
  } catch (err) {
    if (err && err.name !== 'AbortError') console.error('Grant image folder error:', err)
  } finally {
    if (temporaryGrantId) await releaseSafGrant(temporaryGrantId).catch(() => {})
  }
}

// A `knote-img:<id>` reference is a SESSION-LOCAL pointer into imageStore. Knote's
// own save/export always inlines it to a real data URL (imageStore is never
// cleared, so the data is always there). But if a document is written out through
// the COMPACT form — e.g. an agent reads the doc and saves it to a file directly,
// bypassing Knote's inlining export — the image bytes never travel with it. On
// open those refs are dangling and their images can't be shown. Surface that
// (a count of refs with no data) instead of leaving silent blank images.
// Filled by the shared cancellable document-analysis pass below. Keeping this
// as a ref avoids a synchronous full-document regex scan during Vue render.
const missingImageCount = ref(0)
const missingImgDismissed = ref(false)
// re-show the warning whenever the set of missing images changes (a new doc, or
// images added/removed) — but stay dismissed while merely typing (count stable)
watch(missingImageCount, () => { missingImgDismissed.value = false })

const generateImageId = () => {
  imageIdCounter++
  return `img-${Date.now()}-${imageIdCounter}`
}

// Render markdown to HTML with every block-level element tagged by the DOCUMENT
// line it came from (data-sline / data-eline). This is the alignment backbone of
// split scroll sync: the preview renders from toInternal() text (blank rows
// expanded to &nbsp; lines), so markdown-it's token.map counts INTERNAL lines —
// we translate each block's start line back to a real document line through
// internalToDoc. Zero new dependencies: token.map is markdown-it's own. Only the
// split preview uses this path; the single-mode editor maps blocks to source by
// serialization, not line numbers, so its rendering is untouched.
const renderMarkdownLineMapped = (processedContent) => {
  const { internal, internalToDoc } = toInternalMapped(processedContent)
  const tokens = md.parse(internal, {})
  const docLine = (internalLine) => {
    const d = internalToDoc[internalLine]
    return d == null ? internalLine : d
  }
  for (const t of tokens) {
    // Tag block openers (nesting 1) and self-contained blocks (nesting 0) that
    // carry a line span. Closing tokens (nesting -1) render no opening tag; the
    // inline token's renderer emits its children, ignoring attrs, so skip both.
    if (!t.map || t.nesting === -1 || t.type === 'inline') continue
    t.attrSet('data-sline', String(docLine(t.map[0])))
    t.attrSet('data-eline', String(docLine(Math.max(t.map[0], t.map[1] - 1))))
  }
  // Fenced code blocks (incl. mermaid) are the tall non-uniform blocks that cause
  // desync, but their highlight() returns a complete `<pre>` string, which makes
  // markdown-it DROP the token's attributes — so the attrSet above never reaches
  // them. Wrap the fence rule for THIS render only to inject the line span into
  // the emitted <pre>. (renderMermaidIn later swaps that <pre> for a .knote-mermaid
  // container, which copies data-sline across — see mermaidRender.js.)
  const prevFence = md.renderer.rules.fence
  md.renderer.rules.fence = (tkns, idx, options) => {
    const token = tkns[idx]
    const info = token.info ? md.utils.unescapeAll(token.info).trim() : ''
    const arr = info ? info.split(/(\s+)/g) : []
    const highlighted = options.highlight
      ? (options.highlight(token.content, arr[0] || '', arr.slice(2).join('')) || md.utils.escapeHtml(token.content))
      : md.utils.escapeHtml(token.content)
    let out = highlighted.indexOf('<pre') === 0 ? highlighted : `<pre class="hljs"><code>${highlighted}</code></pre>`
    if (token.map) {
      const s = docLine(token.map[0])
      const e = docLine(Math.max(token.map[0], token.map[1] - 1))
      out = out.replace('<pre', `<pre data-sline="${s}" data-eline="${e}"`)
    }
    return out + '\n'
  }
  try {
    return md.renderer.render(tokens, md.options, {})
  } finally {
    md.renderer.rules.fence = prevFence
  }
}

const renderMarkdownHtml = (source, withLines = false) => {
  // Empty rows: reuse the editor's exact conversion (fence-aware, correct
  // leading/trailing handling) — each empty row becomes a `&nbsp;` line,
  // which markdown-it renders as an empty-looking paragraph. This keeps the
  // split preview's row count identical to the single-mode editor.
  // Swap knote-img: references back to real data URLs for rendering
  let processedContent = replaceInvalidInternalImageReferences(source, {
    hasImage: (id) => !!imageStore[id],
    label: t('invalid_image_reference')
  })
  for (const [id, url] of Object.entries(imageStore)) {
    processedContent = processedContent.split(`knote-img:${id}`).join(url)
  }
  // resolve relative-path images to their data URLs for display (content stays
  // untouched — this is a derived value)
  processedContent = relPathsToDataUrls(processedContent)

  let html = withLines
    ? renderMarkdownLineMapped(processedContent)
    : md.render(toInternal(processedContent))
  // Wrap tables in a scroll container so the adaptive column sizing (min-width:100%
  // + 7em cell floors, mirroring the WYSIWYG editor) can let a wide table grow and
  // scroll here instead of squeezing columns; a narrow one fills the width. The
  // data-sline anchors stay on the <table> itself, so line mapping is unaffected.
  html = html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/g, (m) => '<div class="knote-md-tw">' + m + '</div>')
  
  html = html.replace(/<p>\s*:::\s*align:(\w+)\s*:::\s*<\/p>\s*<p>/g, (match, align) => {
      return `<p style="text-align: ${align}">`
  })
  html = html.replace(/<p>\s*:::\s*align:(\w+)\s*:::\s*/g, (match, align) => {
      return `<p style="text-align: ${align}">`
  })
  html = html.replace(/<p>\s*:::\s*align:\w+\s*:::\s*<\/p>/g, '')
  
  return sanitizeHtml(html)
}
// The split preview is line-anchored to the source (data-sline), so it renders
// through the line-mapped path. This computed only stays hot in split mode (the
// watch below gates subscription), so the extra line-map pass costs nothing in
// single/source-only editing.
const renderedHtml = computed(() => renderMarkdownHtml(content.value, true))

// Render mermaid diagrams in the split preview after each HTML update AND
// when entering split mode (switching in doesn't change renderedHtml)
const renderPreviewMermaid = () => {
  if (viewMode.value !== 'split') return
  nextTick(() => {
    const isDark = ((document.querySelector('[data-theme]') || document.documentElement).getAttribute('data-theme') || '').includes('dark')
    for (const root of document.querySelectorAll('.knote-md-render')) renderMermaidIn(root, isDark)
  })
}
// Do not subscribe to the expensive full-document preview while single mode is
// active. `v-if` removes the DOM, but a direct watch(renderedHtml) used to keep
// markdown-it + DOMPurify hot in the background on every keystroke.
watch(() => viewMode.value === 'split' && !largeDocumentPlainMode.value ? renderedHtml.value : null, (html) => {
  if (html != null) renderPreviewMermaid()
}, { flush: 'post' })

// ------ BLOCK SPLITTER ENGINE ------

// Per-block HTML render with content-addressed caching: on every keystroke
// commit the whole document re-parses, but only blocks whose raw text changed
// need to go through markdown-it again. The imageStore watcher clears the
// cache because rendered HTML embeds resolved data URLs.
const blockHtmlCache = new Map()
watch(imageStore, () => blockHtmlCache.clear())

const renderBlockHtml = (rawContent) => {
  const cacheKey = `${lang.value}\u0000${rawContent}`
  const cached = blockHtmlCache.get(cacheKey)
  if (cached !== undefined) return cached

  const guardedContent = replaceInvalidInternalImageReferences(rawContent, {
    hasImage: (id) => !!imageStore[id],
    label: t('invalid_image_reference')
  })
  let html = md.render(guardedContent)
  for (const [id, url] of Object.entries(imageStore)) {
    html = html.split(`knote-img:${id}`).join(url)
  }
  // Apply alignment markers (::: align:x :::) the same way renderedHtml does,
  // so aligned paragraphs display correctly in single mode too
  html = html.replace(/<p>\s*:::\s*align:(\w+)\s*:::\s*<\/p>\s*<p>/g, (m, align) => `<p style="text-align: ${align}">`)
  html = html.replace(/<p>\s*:::\s*align:(\w+)\s*:::\s*/g, (m, align) => `<p style="text-align: ${align}">`)
  html = html.replace(/<p>\s*:::\s*align:\w+\s*:::\s*<\/p>/g, '')

  if (blockHtmlCache.size > 1000) blockHtmlCache.clear()
  blockHtmlCache.set(cacheKey, html)
  return html
}

const parsedBlocks = computed(() => {
  const text = content.value
  const lines = text.split('\n')
  const blocks = []

  // Disable html parsing temporarily to prevent raw html from breaking map logic, though md-it should handle it
  const tokens = md.parse(text, {})

  let lastLine = 0
  let blockIdCounter = 0

  // Each blank line becomes its OWN single-line gap block, so every empty row
  // has a uniform height and can be edited/deleted independently. (A single
  // multi-line gap block rendered as stacked <br>s had inconsistent height and
  // collapsed on commit.)
  const pushGapBlocks = (fromLine, toLine) => {
    for (let gl = fromLine; gl < toLine; gl++) {
      const gapContent = lines[gl] || ''
      blocks.push({
        id: `block-${blockIdCounter++}`,
        type: 'gap',
        nodeName: 'P',
        raw: gapContent,
        html: gapContent ? md.utils.escapeHtml(gapContent) : '',
        startLine: gl,
        endLine: gl + 1
      })
    }
  }

  tokens.forEach((t, ti) => {
    // Only process top-level blocks that have source map information
    if (t.level === 0 && t.map) {
      const [start, end] = t.map

      // 1. GAP BLOCKS: Preserve explicit empty lines between structural blocks
      if (start > lastLine) {
        pushGapBlocks(lastLine, start)
      }

      // 1.5 LISTS: one block PER top-level list item, so each row is hovered,
      // selected and edited independently (Feishu-like) instead of the whole
      // list acting as a monolith. Ordered items keep their number via the
      // <ol start> attribute markdown-it emits.
      if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
        let itemLast = start
        for (let j = ti + 1; j < tokens.length; j++) {
          const it = tokens[j]
          if (it.level === 0 && (it.type === 'bullet_list_close' || it.type === 'ordered_list_close')) break
          if (it.level === 1 && it.type === 'list_item_open' && it.map) {
            const is = it.map[0]
            let ie = it.map[1]
            // Loose-list semantics absorb trailing blank lines into the item's
            // map. Peel them off so blanks are ALWAYS independent gap rows —
            // otherwise they hide inside the item block (invisible normally,
            // popping up inside the source editor when the item is activated).
            while (ie > is + 1 && (lines[ie - 1] || '').trim() === '') ie--
            if (is > itemLast) pushGapBlocks(itemLast, is)
            const rawItem = lines.slice(is, ie).join('\n')
            blocks.push({
              id: `block-${blockIdCounter++}`,
              type: 'list_item',
              nodeName: 'LI',
              raw: rawItem,
              html: renderBlockHtml(rawItem),
              startLine: is,
              endLine: ie
            })
            itemLast = ie
          }
        }
        if (itemLast < end) pushGapBlocks(itemLast, end)
        lastLine = end
        return
      }
      
      // 2. CONTENT BLOCKS: Actual markdown structures (paragraphs, headings, tables, code...)
      const rawContent = lines.slice(start, end).join('\n')

      // fence tokens carry tag 'code' but render as <pre> — normalize so the
      // template/highlight logic treats code blocks as complex PRE blocks
      const nodeName = t.type === 'fence' ? 'PRE' : (t.tag || 'DIV').toUpperCase()

      blocks.push({
        id: `block-${blockIdCounter++}`,
        type: t.type,
        nodeName,
        raw: rawContent,
        html: renderBlockHtml(rawContent),
        startLine: start,
        endLine: end
      })
      lastLine = end
    }
  })
  
  // 3. TRAILING GAP: Any remaining blank lines at the end of the document
  if (lastLine < lines.length) {
    pushGapBlocks(lastLine, lines.length)
  }

  return blocks
})

// Active Block Editing State
const activeBlockId = ref(null)
// Tracks whether the user actually modified the active block's DOM.
// Without this, every click+blur would run a lossy HTML->MD roundtrip
// and silently rewrite untouched markdown (quotes, escapes, list spacing...).
const activeBlockDirty = ref(false)

const markActiveBlockDirty = () => {
  activeBlockDirty.value = true
}

// ---- Core helpers: block element <-> markdown line range ----

// Walk up from any node to the block-content-* container div
const getBlockElFromNode = (node) => {
  let el = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
  while (el && !(el.id && el.id.startsWith('block-content-'))) {
    el = el.parentElement
  }
  return el || null
}

const getBlockLineRange = (blockEl) => {
  if (!blockEl) return null
  const start = parseInt(blockEl.dataset.startLine)
  const end = parseInt(blockEl.dataset.endLine)
  if (isNaN(start) || isNaN(end)) return null
  return { start, end }
}

// Replace the given line range of content.value with newMd.
// Preserves the trailing blank lines of the original range: markdown-it block
// maps include the blank separator line after lists/paragraphs, but turndown
// output never has it — dropping it would merge the following block.
const spliceLines = (startLine, endLine, newMd, preserveTrailingBlanks = true) => {
  const lines = content.value.split('\n')
  const removed = lines.slice(startLine, endLine)
  let newLines = newMd === '' ? [] : newMd.split('\n')
  if (preserveTrailingBlanks && removed.length > 0) {
    let trailing = 0
    for (let i = removed.length - 1; i >= 0 && removed[i].trim() === ''; i--) trailing++
    let newTrailing = 0
    for (let i = newLines.length - 1; i >= 0 && newLines[i].trim() === ''; i--) newTrailing++
    for (let i = newTrailing; i < trailing; i++) newLines.push('')
  }
  lines.splice(startLine, endLine - startLine, ...newLines)
  content.value = lines.join('\n')
}

// Insert raw markdown lines AFTER the given line index (with blank separators)
const insertMarkdownAfterLine = (lineIndex, mdText) => {
  const lines = content.value.split('\n')
  const insertAt = Math.min(Math.max(lineIndex, 0), lines.length)
  const newLines = ['', ...mdText.split('\n'), '']
  lines.splice(insertAt, 0, ...newLines)
  content.value = lines.join('\n')
}

// Serialize a table DOM element to GFM markdown directly.
// Turndown's table handling has too many edge cases (empty cells with <br>
// become hard breaks that shatter rows), so we control serialization fully.
const inlineTurndown = (html) => {
  return turndownService.turndown(html).replace(/\n+/g, ' ').trim()
}

const tableToMarkdown = (table) => {
  const rows = Array.from(table.querySelectorAll('tr'))
  if (rows.length === 0) return ''
  const serializeCell = (cell) => {
    if (!cell) return ''
    const text = inlineTurndown(cell.innerHTML)
    return text.replace(/\|/g, '\\|').replace(/\u200B/g, '')
  }
  const colCount = Math.max(...rows.map((r) => r.children.length))
  const out = []
  rows.forEach((row, i) => {
    const cells = []
    for (let c = 0; c < colCount; c++) {
      cells.push(serializeCell(row.children[c]))
    }
    out.push('| ' + cells.join(' | ') + ' |')
    if (i === 0) {
      out.push('| ' + Array(colCount).fill('---').join(' | ') + ' |')
    }
  })
  return out.join('\n')
}

// Extract raw code text from a rendered code block element.
// data-code holds the ORIGINAL code baked in at render time — after the user
// edits the contenteditable we must read the live DOM instead. Browsers insert
// <br> (and sometimes <div>) for newlines in contenteditable, which plain
// textContent would silently drop.
const domToPlainText = (root) => {
  let out = ''
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'BR') {
          out += '\n'
        } else {
          const isBlock = ['DIV', 'P'].includes(child.tagName)
          if (isBlock && out !== '' && !out.endsWith('\n')) out += '\n'
          walk(child)
          if (isBlock && !out.endsWith('\n')) out += '\n'
        }
      }
    }
  }
  walk(root)
  return out
}

const codeBlockToMarkdown = (blockEl) => {
  const codeEl = blockEl.querySelector('pre code') || blockEl.querySelector('code')
  if (!codeEl) return null
  const className = codeEl.getAttribute('class') || ''
  const langMatch = className.match(/language-(\S+)/)
  const lang = langMatch && langMatch[1] !== 'plaintext' ? langMatch[1] : ''
  let code = domToPlainText(codeEl)
  code = code.replace(/\u200B/g, '').replace(/\n$/, '')
  return '```' + lang + '\n' + code + '\n```'
}

// Type-aware serialization of a block-content element back to markdown
const serializeBlockEl = (blockEl) => {
  const blockType = blockEl.dataset.blockType || ''
  const nodeName = (blockEl.dataset.nodeName || '').toUpperCase()

  if (blockType === 'fence' || nodeName === 'PRE') {
    const md = codeBlockToMarkdown(blockEl)
    if (md !== null) return md
  }
  if (blockType === 'table_open' || nodeName === 'TABLE') {
    const table = blockEl.querySelector('table')
    if (table) return tableToMarkdown(table)
  }
  if (blockType === 'gap') {
    const parts = []
    blockEl.childNodes.forEach((child) => {
      if (child.nodeType === Node.COMMENT_NODE) return
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'SPAN' && child.textContent === '¶') return
      if (child.nodeType === Node.ELEMENT_NODE) {
        parts.push(child.innerHTML)
      } else if (child.nodeType === Node.TEXT_NODE) {
        parts.push(child.textContent)
      }
    })
    let html = parts.join('').trim()
    if (html === '' && blockEl.innerText.trim() !== '') {
      html = blockEl.innerText.trim()
    }
    let mdText = html ? turndownService.turndown(html) : ''
    mdText = mdText.replace(/\u200B/g, '')
    mdText = mdText.trim()
    // Bare text — the caller (commitBlockEdit) adds blank-line separators
    // contextually so consecutive edits never inflate the blank-line count
    return mdText === '' ? null : mdText
  }

  const vhtmlDiv = blockEl.querySelector(':scope > div')
  const html = vhtmlDiv ? vhtmlDiv.innerHTML : blockEl.innerHTML
  let mdText = turndownService.turndown(html)
  mdText = mdText.replace(/\u200B/g, '')
  // Empty paragraphs serialize as a literal <br> line — normalize to real blanks
  mdText = mdText.replace(/\n?\n?<br>\n?\n?/g, '\n\n').replace(/\n{3,}/g, '\n\n')
  // Task checkboxes pick up the label's leading space -> collapse "[ ]  x"
  mdText = mdText.replace(/\[([ x])\] {2,}/g, '[$1] ')
  return mdText
}

// Commit any block-content element's current DOM state into content.value.
// This is the ONLY sanctioned DOM->markdown write path (replaces the old
// wholesale syncPreviewToMarkdown which corrupted the document).
const commitBlockElement = (blockEl) => {
  const range = getBlockLineRange(blockEl)
  if (!range) return false
  const newMd = serializeBlockEl(blockEl)
  if (newMd === null) return false
  spliceLines(range.start, range.end, newMd)
  return true
}

// Dev-only introspection hooks for automated testing
if (typeof window !== 'undefined' && (import.meta.env.DEV || window.knoteDesktop?.isE2E)) {
  window.__knoteDebug = {
    getContent: () => content.value,
    getEditor: () => richEditorRef.value ? richEditorRef.value.editor : null,
    outlineDebug: () => ({
      items: outlineItems.value.length,
      sample: outlineItems.value.slice(0, 3),
      cacheSourceLen: documentAnalysisCache.source ? documentAnalysisCache.source.length : -1,
      cacheOutline: documentAnalysisCache.outline ? documentAnalysisCache.outline.length : -1,
      largeMode: largeDocumentPlainMode.value,
      viewMode: viewMode.value,
      outlineVisible: outlineVisible.value,
      contentLen: content.value.length
    }),
    documentPersistence: () => {
      const identity = snapshotDocKey()
      return {
        identity,
        editRevision: documentEditRevision(identity),
        savedRevision: documentSavedRevisions.get(identity) || 0,
        ahead: documentIsAheadOfDisk(identity),
        autoSaveDirty,
        saving: isSaving.value
      }
    },
    ...(window.knoteDesktop?.isE2E
      ? {
          layout: {
            setAndroidActive: (active) => {
              androidLayoutOverride.value = active === true
              syncAndroidLayoutMedia()
              return {
                active: androidLayoutActive.value,
                tablet: isAndroidTablet.value,
                compact: isAndroidCompact.value
              }
            },
            state: () => ({
              active: androidLayoutActive.value,
              tablet: isAndroidTablet.value,
              compact: isAndroidCompact.value,
              width: window.innerWidth,
              height: window.innerHeight
            })
          },
          // Live assistant display-mode switcher: flips float ⇄ sidebar reactively
          // (the computeds re-render), so e2e doesn't need a localStorage + reload.
          // Referenced lazily inside the method bodies, so the later-declared refs
          // (agentDisplayMode/showAgentSidebar/...) are initialized by call time.
          agentDisplay: {
            set: (m) => {
              setAgentDisplayMode(m)
              return { mode: agentDisplayMode.value, sidebar: showAgentSidebar.value, dock: showAgentFloatDock.value }
            },
            state: () => ({
              mode: agentDisplayMode.value,
              available: agentSidebarAvailable.value,
              sidebar: showAgentSidebar.value,
              dock: showAgentFloatDock.value,
              open: agentOpen.value
            })
          },
          // The mascot (float ball) hides in sidebar mode, but its data-agent-state
          // is mode-independent (derived from the agent store). Expose the same
          // computed so e2e can read agent state without needing the float dock.
          mascotState: () => mascotState.value
        }
      : {}),
    // the LIVE agent store instance (a bare dynamic import may resolve to a
    // different HMR-versioned module and mutate the wrong instance)
    agent: () => import('./lib/agentStore.js'),
    // folder-tree test hook: inject any FileSystemDirectoryHandle (e.g. OPFS)
    folder: {
      setHandle: async (h, name) => {
        const resolved = !h?._deskPath && !h?._knoteIdentity && typeof h?.isSameEntry === 'function'
          ? await resolveBrowserWorkspaceIdentity(h)
          : { id: '', durable: !!(h?._deskPath || h?._knoteIdentity) }
        folderName.value = name || h.name || 'test'
        folderWorkspaceId.value = resolved.id
        folderWorkspaceIdentityDurable.value = resolved.durable
        folderHandle.value = h
        folderTree.value = await buildFolderTree(h)
      },
      tree: () => folderTree.value,
      create: () => createMdFile(),
      rename: (node) => renameTreeFile(node),
      refresh: () => refreshFolder(),
      open: (node) => openTreeFile(node),
      openInNewTab: (node) => openTreeFileInNewTab(node)
    },
    // tab test hooks
    tabs: {
      list: () => tabs.value.map((tb) => ({
        id: tb.id,
        kind: tabKindOf(tb),
        label: tabLabelOf(tb),
        active: tb.id === activeTabId.value,
        resident: tb.resident,
        buffered: !!tb.bufferRef,
        generation: tb.documentGeneration,
        agentResidencyLeases: tb.agentResidencyLeases,
        documentId: agentDocumentKeyForTab(tb),
        workspaceId: agentWorkspaceIdentityForTab(tb),
        fileWorkspaceId: tb.fileWorkspaceId,
        fileWorkspaceIdentityDurable: tb.fileWorkspaceIdentityDurable,
        treePath: tb.id === activeTabId.value ? activeTreePath.value : tb.treePath,
        signedBuffer: typeof tb.bufferRef?.sig === 'string' && /^[a-f0-9]{64}$/.test(tb.bufferRef.sig),
        contentLength: typeof tb.content === 'string' ? tb.content.length : null
      })),
      switch: (id) => switchTab(id),
      close: (id) => closeTab(id),
      create: () => newTab(),
      duplicateActive: () => {
        captureActiveTab()
        const source = activeTab()
        if (!source) return 0
        const duplicate = mkTab({
          kind: source.kind,
          title: source.title,
          deskKey: source.deskKey,
          content: source.content,
          exportedMd: source.exportedMd,
          fileHandle: source.fileHandle,
          isLocal: source.isLocal,
          fileName: source.fileName,
          fileWorkspaceId: source.fileWorkspaceId,
          fileWorkspaceIdentityDurable: source.fileWorkspaceIdentityDurable,
          treePath: source.treePath,
          folderHandle: source.folderHandle,
          folderName: source.folderName,
          folderWorkspaceId: source.folderWorkspaceId,
          folderWorkspaceIdentityDurable: source.folderWorkspaceIdentityDurable,
          folderTree: source.folderTree,
          expandedDirs: new Set(source.expandedDirs || []),
          baseContent: source.baseContent,
          resident: true
        })
        tabs.value.push(duplicate)
        return duplicate.id
      },
      holdNextAgentCapture: () => holdNextAgentDocumentCapture(),
      agentCaptureWaiting: () => !!e2eAgentDocumentCaptureGate?.waiting,
      releaseAgentCapture: () => releaseHeldAgentDocumentCapture(),
      holdNextStandaloneOpen: () => holdNextStandaloneOpen(),
      standaloneOpenWaiting: () => !!e2eStandaloneOpenGate?.waiting,
      releaseStandaloneOpen: () => releaseStandaloneOpen(),
      openFolderHandle: (h, name) => adoptFolderHandle(h, name),
      openFileHandle: (h) => openFileFromHandle(h),
      openFileHandleReadOnly: (h) => openFileFromHandle(h, { writable: false }),
      openFallbackFile: (name, text) => openFallbackFile(name, () => Promise.resolve(String(text || '')))
    },
    dialogs: {
      lastResult: null,
      queueConfirmPair: () => {
        const debug = window.__knoteDebug.dialogs
        debug.lastResult = null
        void Promise.all([
          confirmDialog('E2E confirm first', { owner: 'e2e-confirm-first' }),
          confirmDialog('E2E confirm second', { owner: 'e2e-confirm-second' })
        ]).then((result) => { debug.lastResult = result })
        return true
      },
      pending: () => appDialogQueue.size()
    },
    // local-file link test hooks (lazy wrappers: the insert flows close their
    // own pickers, so calling them directly is equivalent to the toolbar)
    link: {
      insertLinkBelow: () => insertLinkBelow(),
      insertAttachmentBelow: () => insertAttachmentBelow()
    }
  }
}

// ============================================================
// ACTIVE-BLOCK SOURCE EDITING
// Text blocks are edited as RAW MARKDOWN in a per-block textarea (Typora-like
// per-block source mode). Commit = textarea value spliced back into the
// document by line range: zero HTML->markdown conversion, zero loss, native
// caret. Tables keep their dedicated contenteditable + deterministic
// serializer; images keep select-and-toolbar.
// ============================================================

const editingText = ref('')

const isTableBlockData = (block) => block && (block.type === 'table_open' || block.nodeName === 'TABLE')

const getEditorEl = () => (
  activeBlockId.value ? document.getElementById(`block-editor-${activeBlockId.value}`) : null
)

const autoResizeEditor = () => {
  const el = getEditorEl()
  if (!el) return
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}

const handleEditorInput = () => {
  activeBlockDirty.value = true
  autoResizeEditor()
}

// Source styling for the editor textarea so headings/code keep their scale
const editorClassFor = (block) => {
  if (!block) return ''
  if (block.type === 'fence') return 'ed-code'
  const m = (block.raw || '').match(/^(#{1,6})\s/)
  if (m) return `ed-h${m[1].length}`
  return ''
}

// --- Split-source heading highlight (issue #16, 需求一) ---
// The split-mode source <textarea> keeps its own (transparent) text so caret /
// selection / IME behave exactly as before; a synced <pre> behind it paints the
// colored source. The layer may ONLY recolor text — changing font-size, weight
// or letter-spacing would push lines out of phase with the transparent textarea
// above it, so every box/text metric mirrors the textarea (see the CSS class).
const sourceHighlightRef = ref(null)
const splitPreviewRef = ref(null)
// Split locate flash: which line to pulse in which pane right after an explicit
// locate (null = none). { pane, line, id } — id makes each flash a fresh object so
// re-locating the same line restarts the 2s highlight.
const splitLocateFlash = ref(null)
let splitLocateFlashTimer = null
let splitLocateFlashId = 0
let splitFlashEl = null // preview block currently carrying .knote-locate-flash
const escapeSourceHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const sourceHighlightHtml = computed(() => {
  // Only the split-mode source view renders the highlight layer. Skip the
  // O(document) split/map entirely in single / large-doc / pdf modes so typing
  // there never pays for a layer that isn't on screen.
  if (viewMode.value !== 'split' || largeDocumentPlainMode.value || pdfView.value) return ''
  const lines = escapeSourceHtml(content.value).split('\n')
  const flash = splitLocateFlash.value
  const flashLine = flash && flash.pane === 'source' ? flash.line : -1
  let html = lines
    .map((line, i) => {
      const m = line.match(/^(#{1,6})\s/)
      const inner = m ? `<span class="knote-sh-h${m[1].length}">${line}</span>` : line
      // The located line pulses via a background-ONLY inline span (no font/box
      // change, so it never pushes this layer out of phase with the textarea).
      return i === flashLine ? `<span class="knote-locate-flash" data-flash="${flash.id}">${inner}</span>` : inner
    })
    .join('\n')
  // A <pre> swallows one trailing newline; the textarea still reserves that last
  // empty line for the caret. Compensate so the two never drift by a line.
  if (content.value.endsWith('\n')) html += '\n'
  return html
})
// --- Split view: line-anchored locate map ---
// The source pane (.knote-source-scroll) and the preview pane are two independent
// scrollers that NO LONGER sync automatically — alignment is explicit (the hover /
// selection "locate" button). The line map below is that locate engine: we anchor on
// the one unambiguous primary key both panes share, the MARKDOWN LINE. The source
// highlight is line-uniform (headings are color-only), so line N sits at a linear
// pixel Y; the preview tags every rendered block with data-sline (the doc line it
// came from — see renderMarkdownLineMapped). Matching by line gives a piecewise map
// where every mermaid diagram / callout / list is its own anchor segment, so a tall
// block only distorts its own few lines — which is exactly why locate lands precisely.
// Line-anchored map: [{ line, preY }] in each pane's content space, sorted by line.
// `srcGeom` caches the WRAP-AWARE per-line source geometry ({ ys, taOffset, lh,
// lineCount }) so line -> source-Y is exact even when long lines soft-wrap.
let splitLineMap = null
let srcGeom = null
const splitScrollMax = (el) => Math.max(0, el.scrollHeight - el.clientHeight)
// First character offset of doc line `line` (0-based) in `text`.
const splitLineStartOffset = (text, line) => {
  if (line <= 0) return 0
  let idx = 0
  for (let k = 0; k < line; k++) {
    const nl = text.indexOf('\n', idx)
    if (nl < 0) return text.length
    idx = nl + 1
  }
  return idx
}
// Measure the content-space Y of EVERY doc line's first visual row in ONE mirror pass.
// A plain `line * lineHeight` estimate breaks the moment a long line soft-wraps (each
// wrapped doc line occupies several visual rows), which was the source of the hovering
// locate button landing on the wrong section. Here each line's first character is wrapped
// in a zero-cost inline marker span (no characters added/removed, so wrapping matches the
// textarea exactly); the marker's top gives that line's row top. Empty lines get a
// zero-width-space marker so they still occupy their row. Returns ys[line] = row top
// relative to the textarea border-box (same space as getCaretCoordinates().top).
const measureSourceLineYs = (ta, text) => {
  const style = getComputedStyle(ta)
  const div = document.createElement('div')
  const props = [
    'boxSizing','width','height','overflowX','overflowY',
    'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth',
    'paddingTop','paddingRight','paddingBottom','paddingLeft',
    'fontStyle','fontVariant','fontWeight','fontStretch','fontSize','lineHeight',
    'fontFamily','textTransform','textAlign','letterSpacing','wordSpacing','textIndent','whiteSpace'
  ]
  props.forEach((p) => { div.style[p] = style[p] })
  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.whiteSpace = 'pre-wrap'
  div.style.wordWrap = 'break-word'
  div.style.top = '0'
  div.style.left = '0'
  div.style.zIndex = '-1'
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) div.appendChild(document.createTextNode('\n'))
    const lt = lines[i]
    const m = document.createElement('span')
    m.setAttribute('data-lm', String(i))
    if (lt.length > 0) { m.textContent = lt[0]; div.appendChild(m); div.appendChild(document.createTextNode(lt.slice(1))) }
    else { m.textContent = '​'; div.appendChild(m) }
  }
  document.body.appendChild(div)
  const divTop = div.getBoundingClientRect().top
  const lh = parseFloat(style.lineHeight) || 24
  const fs = parseFloat(style.fontSize) || 16
  const halfLeading = Math.max(0, (lh - fs) / 2)
  const ys = []
  div.querySelectorAll('[data-lm]').forEach((m) => {
    // marker top is the first glyph's top; step back by the half-leading to the row top
    ys[+m.getAttribute('data-lm')] = (m.getBoundingClientRect().top - divTop) - halfLeading
  })
  document.body.removeChild(div)
  return ys
}
// Rebuild the line-anchored map. Source geometry is calibrated from real caret
// coordinates (never parsing CSS line-height/padding); preview anchors come from
// each [data-sline] block's measured content-space Y. Cheap; call after the panes
// lay out and whenever content / rendered height may have changed.
const buildSplitAnchors = () => {
  splitLineMap = null
  srcGeom = null
  const s = editorAreaRef.value
  const p = splitPreviewRef.value
  const ta = textareaRef.value
  if (!s || !p || !ta) return
  const root = p.querySelector('.knote-md-render')
  if (!root) return
  const text = content.value || ''
  const lineCount = text === '' ? 1 : text.split('\n').length
  // --- source geometry: wrap-aware per-line row tops from a single mirror pass
  const sRect = s.getBoundingClientRect()
  try {
    const ys = measureSourceLineYs(ta, text)
    if (!ys.length) return   // layout not settled (empty doc / mid-render); stay unbuilt
    const lh = ys.length > 1 ? Math.max(1, ys[1] - ys[0]) : (parseFloat(getComputedStyle(ta).lineHeight) || 24)
    // taOffset anchors the textarea's border-box top to the scroll container's content
    // space, so a line's container content-space Y = taOffset + ys[line] (scroll-independent).
    const taOffset = ta.getBoundingClientRect().top - sRect.top + s.scrollTop
    srcGeom = { ys, taOffset, lh, lineCount }
  } catch { return }
  // --- preview anchors: doc line -> content-space Y (nested blocks keep topmost Y)
  const pRect = p.getBoundingClientRect()
  const byLine = new Map()
  for (const el of root.querySelectorAll('[data-sline]')) {
    const line = +el.getAttribute('data-sline')
    if (!Number.isFinite(line)) continue
    const y = el.getBoundingClientRect().top - pRect.top + p.scrollTop
    const prev = byLine.get(line)
    if (prev === undefined || y < prev) byLine.set(line, y)
  }
  if (!byLine.size) return
  splitLineMap = Array.from(byLine.entries())
    .map(([line, preY]) => ({ line, preY }))
    .sort((a, b) => a.line - b.line)
}
// Global preview-pixels-per-source-line, used only to extrapolate past the last anchor.
const splitSyncGlobalPrePerLine = () => {
  const p = splitPreviewRef.value
  if (!p || !srcGeom || srcGeom.lh <= 0) return srcGeom ? srcGeom.lh : 20
  const lineCount = (content.value || '') === '' ? 1 : content.value.split('\n').length
  return lineCount > 0 ? p.scrollHeight / lineCount : srcGeom.lh
}
// Exact wrap-aware source content-space Y for any doc line (clamped to the doc).
const srcContentY = (line) => {
  if (!srcGeom || !srcGeom.ys || !srcGeom.ys.length) return null
  const i = Math.max(0, Math.min(srcGeom.ys.length - 1, line))
  return srcGeom.taOffset + srcGeom.ys[i]
}
// Interpolated { srcY, preY } for any doc line, clamped to the anchor range. The source
// side is EXACT (wrap-aware per-line row tops). The preview side interpolates linearly by
// line between measured [data-sline] anchors, so a tall block (mermaid etc.) only stretches
// its own few lines.
const splitLineGeom = (line) => {
  const pts = splitLineMap
  if (!pts || !pts.length || !srcGeom || !srcGeom.ys) return null
  const srcY = srcContentY(line)
  let preY
  if (line <= pts[0].line) {
    preY = pts[0].preY
  } else {
    for (let i = 1; i < pts.length; i++) {
      if (line <= pts[i].line) {
        const a = pts[i - 1], b = pts[i], dl = b.line - a.line
        preY = dl <= 0 ? b.preY : a.preY + ((line - a.line) / dl) * (b.preY - a.preY)
        break
      }
    }
    if (preY === undefined) {
      const last = pts[pts.length - 1]
      // Past the last tagged block grow the preview at the global per-line ratio.
      preY = last.preY + (line - last.line) * splitSyncGlobalPrePerLine()
    }
  }
  return { srcY, preY }
}
// --- Hover "locate" button + selection bubble (viewport-FIXED overlays) ---
// splitHoverBtn tracks the line under the cursor; splitSelBubble appears on a real
// selection. Neither pane ever scrolls the other on its own — alignment happens
// only when the user clicks locate, so there is no twitch.
const splitHoverBtn = ref(null)    // { pane:'source'|'preview', line, top, left } (viewport px)
const splitSelBubble = ref(null)   // { pane, top, left, text, line, below } (viewport px)
const splitHoverRef = ref(null)    // hover locate button element (for the mousedown guard)
const splitBubbleRef = ref(null)   // selection bubble element (for the mousedown guard)
// Estimated bubble widths, used ONLY to clamp the FIXED overlays inside their pane.
// Deliberately overestimated: a too-large guess just nudges the bubble further left,
// it can never let the bubble overflow the editing area's right edge.
const SPLIT_SOURCE_BUBBLE_W = 380
const SPLIT_PREVIEW_BUBBLE_W = 216
const SPLIT_BUBBLE_H = 92          // flip-below threshold (source bubble is the 2-row one)
let splitHoverHideTimer = null
const hideSplitOverlays = () => { splitHoverBtn.value = null; splitSelBubble.value = null }
const keepSplitHover = () => clearTimeout(splitHoverHideTimer)
const scheduleSplitHoverHide = () => {
  clearTimeout(splitHoverHideTimer)
  splitHoverHideTimer = setTimeout(() => { splitHoverBtn.value = null }, 200)
}

// Explicit locate: scroll the OTHER pane so the same line lands LEVEL with where it
// sits in the pane you clicked (see locateOtherPane). The line-number -> pixel mapping
// comes from splitLineGeom (each line's content-space Y in both panes).
// Clear any in-progress locate flash. Source clears reactively (state -> null
// re-renders without the span); preview pulls the class off the flashed block.
const clearSplitLocateFlash = () => {
  splitLocateFlash.value = null
  if (splitFlashEl) { splitFlashEl.classList.remove('knote-locate-flash'); splitFlashEl = null }
}
// Pulse the located line for ~2s in the pane we just scrolled, then fade back.
const flashSplitLocatedLine = (pane, line) => {
  clearTimeout(splitLocateFlashTimer)
  clearSplitLocateFlash()
  splitLocateFlashId += 1
  splitLocateFlash.value = { pane, line, id: splitLocateFlashId } // source reacts via sourceHighlightHtml
  if (pane === 'preview') {
    nextTick(() => {
      if (!splitLocateFlash.value || splitLocateFlash.value.pane !== 'preview') return
      const root = splitPreviewRef.value && splitPreviewRef.value.querySelector('.knote-md-render')
      if (!root) return
      // Outermost block starting at the line, else the block whose span contains it.
      let target = null
      for (const el of root.querySelectorAll('[data-sline]')) {
        const s0 = +el.getAttribute('data-sline')
        if (!Number.isFinite(s0)) continue
        const e0 = el.hasAttribute('data-eline') ? +el.getAttribute('data-eline') : s0
        if (s0 === line) { target = el; break }
        if (s0 < line && line <= e0) target = el
      }
      if (!target) return
      target.classList.remove('knote-locate-flash') // force-restart on a mid-flash re-locate
      void target.offsetWidth
      target.classList.add('knote-locate-flash')
      splitFlashEl = target
    })
  }
  splitLocateFlashTimer = setTimeout(clearSplitLocateFlash, 2400) // matches the 2.4s double-flash
}

// Scroll ONLY the other pane so its copy of `line` lands at the same on-screen height
// the line already occupies in the pane you clicked — the two panes end up horizontally
// aligned, so the eye tracks straight across instead of the line snapping to the top of
// the other viewport. A pane renders content-space Y at rect.top + (contentY - scrollTop),
// so solve target.scrollTop = targetContentY - (fromScreenY - targetRect.top). Clamp to
// the target's scroll range: near the doc start/end the line just settles at the edge.
const locateOtherPane = (fromPane, line) => {
  buildSplitAnchors()
  const g = splitLineGeom(line)
  const s = editorAreaRef.value
  const p = splitPreviewRef.value
  if (!g || !s || !p) return
  const targetPane = fromPane === 'source' ? 'preview' : 'source'
  const fromEl = fromPane === 'source' ? s : p
  const targetEl = fromPane === 'source' ? p : s
  const fromContentY = fromPane === 'source' ? g.srcY : g.preY
  const targetContentY = fromPane === 'source' ? g.preY : g.srcY
  const fromScreenY = fromEl.getBoundingClientRect().top + (fromContentY - fromEl.scrollTop)
  const desired = targetContentY - (fromScreenY - targetEl.getBoundingClientRect().top)
  targetEl.scrollTop = Math.min(Math.max(desired, 0), splitScrollMax(targetEl))
  hideSplitOverlays()
  flashSplitLocatedLine(targetPane, line)
}

// The panes scroll independently now. A scroll only hides the stale overlays (they
// were positioned against the pre-scroll layout); it never touches the other pane.
const handleSourceSplitScroll = () => { hideSplitOverlays() }
const handleSplitPreviewScroll = () => { if (viewMode.value === 'split') hideSplitOverlays() }

// --- Hover "locate" button positioning ---
// Source: the hovered line comes from the same uniform-line-height estimate as the
// line-toolbar. The button hugs the END of that line's text, clamped to the pane's
// right edge so it can never overflow the editing area.
const updateSplitSourceHover = () => {
  if (viewMode.value !== 'split') return
  const ta = textareaRef.value
  const pane = editorAreaRef.value
  if (!ta || !pane) return
  ensureSplitAnchors()           // rebuild the wrap-aware line map if content/height changed
  const ys = srcGeom && srcGeom.ys
  if (!ys || !ys.length) { splitHoverBtn.value = null; return }
  const taRect = ta.getBoundingClientRect()
  const paneRect = pane.getBoundingClientRect()
  // Cursor Y in the textarea's content space (border-box relative; the textarea's own
  // scrollTop is 0 because the container scrolls). Binary-search the wrap-aware row tops
  // for the doc line whose row range contains the cursor.
  const cursorY = lastHoverY.value - taRect.top
  let lo = 0, hi = ys.length - 1, lineIndex = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (ys[mid] <= cursorY) { lineIndex = mid; lo = mid + 1 } else hi = mid - 1
  }
  // Pin the button to the LOGICAL line, not the cursor's visual row: ys[lineIndex] is
  // the line's first visual-row top and ys[lineIndex+1] the next line's, so the button
  // centers on the line's full height. A soft-wrapped line (one md line spanning several
  // visual rows) then gets ONE stable button at its right, instead of one that jumps
  // between the wrapped rows as the cursor moves up/down within the same logical line.
  const lineTopY = ys[lineIndex]
  const lineBottomY = lineIndex + 1 < ys.length ? ys[lineIndex + 1] : lineTopY + lineHeight.value
  const top = Math.min(
    Math.max(taRect.top + (lineTopY + lineBottomY) / 2 - 14, paneRect.top + 4),
    paneRect.bottom - 32
  )
  splitHoverBtn.value = { pane: 'source', line: lineIndex, top, left: paneRect.right - 40 }
}
// Preview: the hovered block carries its doc line in data-sline. The button rides
// the pointer Y, clamped into the block's vertical span and the pane, pinned to the
// pane's right edge.
const handleSplitPreviewMouseMove = (event) => {
  if (viewMode.value !== 'split') return
  const pane = splitPreviewRef.value
  if (!pane) return
  const el = event.target && event.target.closest ? event.target.closest('[data-sline]') : null
  if (!el || !pane.contains(el)) { scheduleSplitHoverHide(); return }
  keepSplitHover()
  const line = +el.getAttribute('data-sline')
  if (!Number.isFinite(line)) { scheduleSplitHoverHide(); return }
  const blockRect = el.getBoundingClientRect()
  const paneRect = pane.getBoundingClientRect()
  const top = Math.min(
    Math.max(event.clientY - 14, Math.max(blockRect.top, paneRect.top)),
    Math.min(blockRect.bottom, paneRect.bottom) - 28
  )
  splitHoverBtn.value = { pane: 'preview', line, top, left: paneRect.right - 40 }
}

// --- Selection bubble positioning ---
// Source (editable): the textarea keeps focus through the bubble's @mousedown.prevent,
// so its selection is intact here. Anchored just above the selection start, flipped
// below when there isn't room above.
const updateSplitSourceSelection = () => {
  const ta = textareaRef.value
  const pane = editorAreaRef.value
  if (!ta || !pane) return
  const clear = () => { if (splitSelBubble.value && splitSelBubble.value.pane === 'source') splitSelBubble.value = null }
  const s = ta.selectionStart
  const e = ta.selectionEnd
  if (s === e) return clear()
  const text = (content.value || '').slice(s, e)
  if (!text.trim()) return clear()
  const line = (content.value || '').slice(0, s).split('\n').length - 1
  const taRect = ta.getBoundingClientRect()
  const paneRect = pane.getBoundingClientRect()
  let coords
  try { coords = getCaretCoordinates(ta, s) } catch { return clear() }
  const caretX = taRect.left + coords.left
  const caretTopVp = taRect.top + coords.top
  const left = Math.min(Math.max(caretX - 24, paneRect.left + 8), paneRect.right - SPLIT_SOURCE_BUBBLE_W - 8)
  const below = (caretTopVp - 8 - SPLIT_BUBBLE_H) < paneRect.top
  splitSelBubble.value = {
    pane: 'source',
    top: below ? caretTopVp + lineHeight.value + 8 : caretTopVp - 8,
    left, text, line, below
  }
}
// Preview (read-only): a normal DOM range inside .knote-md-render. No editing buttons —
// just agent + locate (the agent edits the source Markdown via tools, so the read-only
// pane is still actionable).
const updateSplitPreviewSelection = () => {
  const pane = splitPreviewRef.value
  const clear = () => { if (splitSelBubble.value && splitSelBubble.value.pane === 'preview') splitSelBubble.value = null }
  if (!pane) return
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || sel.isCollapsed) return clear()
  const root = pane.querySelector('.knote-md-render')
  if (!root) return clear()
  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return clear()
  const text = sel.toString()
  if (!text.trim()) return clear()
  const startNode = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
  const block = startNode && startNode.closest ? startNode.closest('[data-sline]') : null
  const line = block ? +block.getAttribute('data-sline') : 0
  const rect = range.getBoundingClientRect()
  const paneRect = pane.getBoundingClientRect()
  const left = Math.min(Math.max(rect.left + rect.width / 2 - SPLIT_PREVIEW_BUBBLE_W / 2, paneRect.left + 8), paneRect.right - SPLIT_PREVIEW_BUBBLE_W - 8)
  const below = (rect.top - 8 - SPLIT_BUBBLE_H) < paneRect.top
  splitSelBubble.value = {
    pane: 'preview',
    top: below ? rect.bottom + 8 : rect.top - 8,
    left, text, line: Number.isFinite(line) ? line : 0, below
  }
}

// --- Source -> preview selection linkage (issue #16, 需求二) -------------------
// Paint-ONLY: the matching preview text is highlighted via the CSS Custom
// Highlight API (see ::highlight(knote-source-selection) in style.css), which
// draws over the render without touching the DOM and NEVER scrolls either pane —
// so it cannot twitch (that was the old auto-scroll linkage's failure). The
// mapping is line-anchored: a source selection maps to the preview blocks whose
// [data-sline,data-eline] span intersects the selected doc lines. Within a
// single-line block we map by VISIBLE characters (Markdown syntax never renders),
// mirroring the skip rules in visibleOffsetToRawOffset; multi-line blocks (code
// fences, tables) fall back to a whole-block highlight so they never break.
const SOURCE_SEL_HIGHLIGHT = 'knote-source-selection'
const clearSourceSelectionHighlight = () => {
  if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete(SOURCE_SEL_HIGHLIGHT)
}
// Visible-character length of a raw Markdown fragment (block prefixes and inline
// marks stripped, exactly as the renderer drops them). Inverse of
// visibleOffsetToRawOffset — used to find where a source selection lands in the
// rendered text.
const rawToVisibleLen = (raw) => {
  let vis = 0
  let i = 0
  const n = raw.length
  const skipRun = (re) => {
    const m = raw.slice(i).match(re)
    if (m) { i += m[0].length; return true }
    return false
  }
  let atLineStart = true
  while (i < n) {
    if (atLineStart) {
      skipRun(/^(\s*(?:#{1,6}\s+|>\s?|(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?))/)
      atLineStart = false
      continue
    }
    if (skipRun(/^(\*\*|__|~~|\+\+|==|\*|_|`|\^)/)) continue
    if (raw[i] === '<' && skipRun(/^<[^>]*>/)) continue
    if (raw[i] === '!' && raw[i + 1] === '[') { i += 1; continue }
    if (raw[i] === '[') { i += 1; continue }
    if (raw[i] === ']' && raw[i + 1] === '(') { if (skipRun(/^\]\([^)]*\)/)) continue }
    if (raw[i] === '\n') { i += 1; vis += 1; atLineStart = true; continue }
    i += 1
    vis += 1
  }
  return vis
}
// Map a visible-character offset to a DOM text position inside `root`. Offsets
// that overshoot (e.g. a trailing newline the render dropped) clamp to the end.
const visibleOffsetToDomPos = (root, target) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let acc = 0
  let node = null
  let last = null
  while ((node = walker.nextNode())) {
    const len = node.textContent.length
    if (target <= acc + len) return { node, offset: Math.max(0, target - acc) }
    acc += len
    last = node
  }
  return last ? { node: last, offset: last.textContent.length } : null
}
const updateSourceSelectionHighlight = () => {
  clearSourceSelectionHighlight()
  if (viewMode.value !== 'split' || largeDocumentPlainMode.value || pdfView.value) return
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined' || typeof NodeFilter === 'undefined') return
  const ta = textareaRef.value
  const root = splitPreviewRef.value && splitPreviewRef.value.querySelector('.knote-md-render')
  if (!ta || !root) return
  const s = ta.selectionStart
  const e = ta.selectionEnd
  if (s == null || e == null || s === e) return
  const doc = content.value || ''
  const a = Math.min(s, e)
  const b = Math.max(s, e)
  if (!doc.slice(a, b).trim()) return
  const lineOf = (off) => doc.slice(0, off).split('\n').length - 1
  const lineA = lineOf(a)
  const lineB = lineOf(b)
  const ranges = []
  for (const el of root.querySelectorAll('[data-sline]')) {
    const bs = +el.getAttribute('data-sline')
    if (!Number.isFinite(bs)) continue
    const be = el.hasAttribute('data-eline') ? +el.getAttribute('data-eline') : bs
    if (be < lineA || bs > lineB) continue
    let visA = 0
    let visB = 0
    if (bs !== be) {
      // Multi-line block (code fence / table): highlight it whole — per-line
      // visible mapping across a tall block is unreliable and not worth it.
      visB = el.textContent.length
    } else {
      const lineStartOff = splitLineStartOffset(doc, bs)
      const nextLineOff = splitLineStartOffset(doc, bs + 1)
      const selA = Math.max(a, lineStartOff)
      const selB = Math.min(b, nextLineOff)
      if (selA >= selB) continue
      visA = rawToVisibleLen(doc.slice(lineStartOff, selA))
      visB = visA + rawToVisibleLen(doc.slice(selA, selB))
    }
    const pA = visibleOffsetToDomPos(el, visA)
    const pB = visibleOffsetToDomPos(el, visB)
    if (!pA || !pB) continue
    try {
      const r = document.createRange()
      r.setStart(pA.node, pA.offset)
      r.setEnd(pB.node, pB.offset)
      if (!r.collapsed) ranges.push(r)
    } catch { /* detached / out-of-range node — skip this block */ }
  }
  if (ranges.length) CSS.highlights.set(SOURCE_SEL_HIGHLIGHT, new Highlight(...ranges))
}
// The highlight holds live Ranges into the preview DOM; a content edit re-renders
// that DOM (v-html), orphaning them. Drop the highlight on any content change —
// the next selection recomputes it fresh.
watch(content, clearSourceSelectionHighlight)

// Bubble action: run an AI action on the selected text (shared by both panes).
const splitBubbleAgent = (action) => {
  const b = splitSelBubble.value
  if (!b) return
  onAskAgent({ action, text: b.text })
  hideSplitOverlays()
}
// Rebuild the line-anchored map once the split panes have laid out. Called from the
// viewMode watcher. (Absolute sync has no scroll baselines to seed — the map IS the
// alignment state.)
const reanchorSplitScroll = () => {
  buildSplitAnchors()
}
// Line anchors go stale as content renders (typing, images, mermaid, fonts).
// Rather than rebuild on every keystroke, mark dirty and rebuild lazily on the
// next scroll; a ResizeObserver on the preview catches async height changes.
let splitAnchorsDirty = true
const ensureSplitAnchors = () => {
  if (!splitAnchorsDirty) return
  splitAnchorsDirty = false
  buildSplitAnchors()
}
let splitAnchorObserver = null
const setupSplitAnchorObserver = () => {
  if (splitAnchorObserver) { splitAnchorObserver.disconnect(); splitAnchorObserver = null }
  const p = splitPreviewRef.value
  if (!p || typeof ResizeObserver === 'undefined') return
  const target = p.querySelector('.knote-md-render') || p
  let t = null
  splitAnchorObserver = new ResizeObserver(() => {
    splitAnchorsDirty = true
    clearTimeout(t)
    t = setTimeout(() => { if (viewMode.value === 'split') { splitAnchorsDirty = false; buildSplitAnchors() } }, 200)
  })
  splitAnchorObserver.observe(target)
}
const teardownSplitAnchorObserver = () => {
  if (splitAnchorObserver) { splitAnchorObserver.disconnect(); splitAnchorObserver = null }
}

// Map a click position inside the RENDERED block to an offset in the RAW
// markdown: count visible characters up to the click point, then walk the raw
// source skipping syntax. Heuristic but close; worst case the caret lands a
// few characters off.
const computeVisibleOffsetAtPoint = (container, event) => {
  let range = null
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(event.clientX, event.clientY)
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(event.clientX, event.clientY)
    if (pos) {
      range = document.createRange()
      range.setStart(pos.offsetNode, pos.offset)
      range.collapse(true)
    }
  }
  if (!range || !container.contains(range.startContainer)) return null
  let count = 0
  let done = false
  const walk = (n) => {
    if (done) return
    if (n === range.startContainer) {
      count += n.nodeType === Node.TEXT_NODE ? range.startOffset : 0
      done = true
      return
    }
    if (n.nodeType === Node.TEXT_NODE) {
      count += n.textContent.length
    } else {
      for (const c of n.childNodes) {
        walk(c)
        if (done) return
      }
    }
  }
  walk(container)
  return done ? count : null
}

const visibleOffsetToRawOffset = (raw, visTarget) => {
  if (visTarget == null) return raw.length
  let vis = 0
  let i = 0
  const n = raw.length
  const skipRun = (re) => {
    const m = raw.slice(i).match(re)
    if (m) { i += m[0].length; return true }
    return false
  }
  let atLineStart = true
  while (i < n && vis < visTarget) {
    if (atLineStart) {
      // block prefixes are invisible in the rendered output
      skipRun(/^(\s*(?:#{1,6}\s+|>\s?|(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?))/)
      atLineStart = false
      continue
    }
    // inline syntax runs
    if (skipRun(/^(\*\*|__|~~|\+\+|==|\*|_|`|\^)/)) continue
    // html tags
    if (raw[i] === '<' && skipRun(/^<[^>]*>/)) continue
    // link/image: [text](url) — the url part is invisible
    if (raw[i] === '!' && raw[i + 1] === '[') { i += 1; continue }
    if (raw[i] === '[') { i += 1; continue }
    if (raw[i] === ']' && raw[i + 1] === '(') {
      if (skipRun(/^\]\([^)]*\)/)) continue
    }
    if (raw[i] === '\n') {
      i += 1
      vis += 1
      atLineStart = true
      continue
    }
    i += 1
    vis += 1
  }
  return Math.min(i, n)
}

// Activate a block for editing. caretPos: number | 'start' | 'end'
const activateBlock = (blockId, caretPos = 'end') => {
  const block = parsedBlocks.value.find(b => b.id === blockId)
  if (!block) return

  if (isTableBlockData(block)) {
    activeBlockId.value = blockId
    activeBlockDirty.value = false
    selectedUiId.value = blockId
    selectedUiKind.value = 'complex'
    nextTick(() => {
      const el = document.getElementById(`block-content-${blockId}`)
      if (el) el.focus()
    })
    return
  }

  editingText.value = block.raw
  activeBlockId.value = blockId
  activeBlockDirty.value = false
  selectedUiId.value = blockId
  selectedUiKind.value = 'simple'
  nextTick(() => {
    const el = getEditorEl()
    if (!el) return
    autoResizeEditor()
    el.focus()
    const pos = caretPos === 'end' ? el.value.length
      : caretPos === 'start' ? 0
      : Math.max(0, Math.min(caretPos, el.value.length))
    el.setSelectionRange(pos, pos)
    const container = document.getElementById(`block-content-${blockId}`)
    if (container) updateLineButtonToBlock(container)
  })
}

// Activate whichever block contains the given source line (after re-render).
// caretPos is relative to that LINE; converted to an offset in the block raw.
const activateLineForEditing = (line, caretPos = 'end') => {
  nextTick(() => {
    const target = parsedBlocks.value.find(b => b.startLine <= line && line < b.endLine && b.type !== 'gap')
      || parsedBlocks.value.find(b => b.startLine <= line && line < b.endLine)
    if (!target) return
    let pos = caretPos
    if (typeof caretPos === 'number' && line > target.startLine) {
      const rawLines = target.raw.split('\n')
      let off = 0
      for (let l = 0; l < line - target.startLine && l < rawLines.length; l++) {
        off += rawLines[l].length + 1
      }
      pos = off + caretPos
    }
    activateBlock(target.id, pos)
  })
}

const handleBlockClick = (block, event) => {
  // Images are selected (toolbar), not source-edited
  if (event && event.target && event.target.closest && event.target.closest('img')) return
  const container = document.getElementById(`block-content-${block.id}`)
  if (container) {
    const inner = container.querySelector(':scope > div')
    const img = inner ? inner.querySelector('img') : null
    if (img && isImageOnlyBlock(inner.firstElementChild || inner, img)) return
  }

  if (activeBlockId.value === block.id) return

  // Commit the previous block before moving on
  let prevCommitted = false
  if (activeBlockId.value) {
    const prevBlock = parsedBlocks.value.find(b => b.id === activeBlockId.value)
    if (prevBlock) prevCommitted = commitBlockEdit(prevBlock)
  }

  // Block ids are positional: committing may have shifted them. Re-resolve
  // the click target from coordinates when the commit changed the document.
  nextTick(() => {
    let targetId = block.id
    if (prevCommitted && event) {
      const hit = document.elementFromPoint(event.clientX, event.clientY)
      const freshEl = getBlockElFromNode(hit)
      if (freshEl) {
        const m = freshEl.id.match(/^block-content-(block-\d+)$/)
        if (m) targetId = m[1]
      }
    }
    const target = parsedBlocks.value.find(b => b.id === targetId)
    if (!target) return

    let caretPos = 'end'
    if (event && !isTableBlockData(target)) {
      const freshContainer = document.getElementById(`block-content-${targetId}`)
      if (freshContainer) {
        const vis = computeVisibleOffsetAtPoint(freshContainer, event)
        if (vis != null) caretPos = visibleOffsetToRawOffset(target.raw, vis)
      }
    }
    activateBlock(targetId, caretPos)
  })
}

// Set to track blocks currently being committed to prevent re-entry/double-commit issues
const committingIds = new Set()
// Returns true if the commit actually changed content.value
const commitBlockEdit = (block) => {
  if (committingIds.has(block.id)) {
    return false
  }
  committingIds.add(block.id)
  let changed = false

  try {
    const latest = parsedBlocks.value.find(b => b.id === block.id)
    if (!latest) return false
    if (activeBlockId.value !== block.id) return false

    if (isTableBlockData(latest)) {
      // Table: serialize the contenteditable DOM deterministically
      const el = document.getElementById(`block-content-${block.id}`)
      if (el && activeBlockDirty.value) {
        const newMd = serializeBlockEl(el)
        if (newMd !== null && newMd !== latest.raw) {
          spliceLines(latest.startLine, latest.endLine, newMd)
          changed = true
        }
      }
    } else if (activeBlockDirty.value) {
      // Strip zero-width placeholders (used to keep empty rows addressable)
      let newMd = editingText.value.replace(/\r/g, '').replace(/\u200B/g, '')
      if (latest.type === 'gap') {
        // Gap rows: add blank separators only on sides that aren't already
        // blank, so repeated edits never inflate the blank-line count
        newMd = newMd.trim() === '' ? '' : newMd
        if (newMd !== '') {
          const docLines = content.value.split('\n')
          const above = latest.startLine > 0 ? docLines[latest.startLine - 1] : null
          const below = latest.endLine < docLines.length ? docLines[latest.endLine] : null
          if (above !== null && above.trim() !== '') newMd = '\n' + newMd
          if (below !== null && below.trim() !== '') newMd = newMd + '\n'
        }
      }
      if (newMd !== latest.raw) {
        spliceLines(latest.startLine, latest.endLine, newMd)
        changed = true
      }
    }

    activeBlockId.value = null
    activeBlockDirty.value = false
  } catch (err) {
    console.error('Error committing block:', block.id, err)
  } finally {
    clearSelectionUi()
    setTimeout(() => {
      committingIds.delete(block.id)
    }, 50)
  }
  return changed
}

// ---- Editor (textarea) key behaviors — all deterministic string ops ----

const listMarkerInfo = (value) => {
  const m = value.split('\n')[0].match(/^(\s*)([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/)
  if (!m) return { indent: '', marker: '- ', full: '- ', isTask: false }
  let marker = /^\d+\./.test(m[2]) ? `${parseInt(m[2]) + 1}. ` : `${m[2]} `
  if (m[3]) marker += '[ ] '
  return { indent: m[1], marker, full: m[0], isTask: !!m[3] }
}

// Delete an empty block; caret moves to the block directly above
const deleteEmptyBlockText = (block) => {
  const latest = parsedBlocks.value.find(b => b.id === block.id)
  if (!latest) return
  const idx = parsedBlocks.value.findIndex(b => b.id === block.id)
  activeBlockId.value = null
  activeBlockDirty.value = false
  spliceLines(latest.startLine, latest.endLine, '', false)
  nextTick(() => {
    const blocks = parsedBlocks.value
    const target = blocks[Math.min(idx, blocks.length) - 1] || blocks[0]
    if (target) activateBlock(target.id, 'end')
  })
}

// Turn an empty list item back into a plain blank row ("exit the list").
// One line in, one line out \u2014 the row keeps its place, only the marker goes.
// (Blanks between items render as independent gap rows since item ranges are
// trimmed of trailing blanks, so no placeholder tricks are needed; typing on
// the row later becomes a paragraph that properly splits the list.)
const exitListItemText = (block) => {
  const latest = parsedBlocks.value.find(b => b.id === block.id)
  if (!latest) return
  activeBlockId.value = null
  activeBlockDirty.value = false
  const lines = content.value.split('\n')
  lines.splice(latest.startLine, latest.endLine - latest.startLine, '')
  content.value = lines.join('\n')
  activateLineForEditing(latest.startLine, 'end')
}

const editorEnter = (block, el) => {
  const latest = parsedBlocks.value.find(b => b.id === block.id)
  if (!latest) return
  const val = el.value.replace(/\r/g, '')
  const head = val.slice(0, el.selectionStart)
  const tail = val.slice(el.selectionEnd)

  if (latest.type === 'list_item') {
    const info = listMarkerInfo(val)
    const body = val.replace(/^(\s*)([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, '')
    if (body.trim() === '') {
      // Empty item: exit the list
      exitListItemText(block)
      return
    }
    const newMd = head + '\n' + info.indent + info.marker + tail
    activeBlockId.value = null
    activeBlockDirty.value = false
    spliceLines(latest.startLine, latest.endLine, newMd)
    activateLineForEditing(latest.startLine + head.split('\n').length, (info.indent + info.marker).length)
    return
  }

  const headTrim = head.replace(/\n+$/, '')
  let newMd
  let focusLine
  if (tail.trim() === '') {
    // Enter at end: exactly one new empty row below, caret lands on it
    newMd = (headTrim === '' ? '' : headTrim) + '\n'
    focusLine = latest.startLine + newMd.split('\n').length - 1
  } else if (headTrim === '') {
    // Enter at start: blank row above, content moves down
    newMd = '\n' + tail
    focusLine = latest.startLine + 1
  } else {
    newMd = headTrim + '\n\n' + tail
    focusLine = latest.startLine + headTrim.split('\n').length + 1
  }
  activeBlockId.value = null
  activeBlockDirty.value = false
  spliceLines(latest.startLine, latest.endLine, newMd)
  activateLineForEditing(focusLine, 0)
}

// Tab / Shift+Tab on the caret's line of a list item (indent one level)
const editorIndentLine = (block, el, outdent) => {
  const latest = parsedBlocks.value.find(b => b.id === block.id)
  const val = el.value
  const caret = el.selectionStart
  const lineStart = val.lastIndexOf('\n', caret - 1) + 1

  if (outdent) {
    const m = val.slice(lineStart).match(/^ {1,4}/)
    if (!m) return
    editingText.value = val.slice(0, lineStart) + val.slice(lineStart + m[0].length)
    activeBlockDirty.value = true
    nextTick(() => {
      el.setSelectionRange(Math.max(lineStart, caret - m[0].length), Math.max(lineStart, caret - m[0].length))
      autoResizeEditor()
    })
    return
  }

  // Indent: the first line needs a list line ABOVE it in the document
  if (lineStart === 0) {
    if (!latest) return
    const docLines = content.value.split('\n')
    const prev = latest.startLine > 0 ? docLines[latest.startLine - 1] : ''
    if (!/^\s*([-*+]|\d+\.)\s/.test(prev)) return
  }
  editingText.value = val.slice(0, lineStart) + '    ' + val.slice(lineStart)
  activeBlockDirty.value = true
  nextTick(() => {
    el.setSelectionRange(caret + 4, caret + 4)
    autoResizeEditor()
  })
}

// Move editing focus to the neighboring block
const navigateFromBlock = (block, dir) => {
  const latest = parsedBlocks.value.find(b => b.id === block.id)
  if (!latest) return
  const startLine = latest.startLine
  const newLineCount = (activeBlockDirty.value ? editingText.value.split('\n').length : latest.endLine - latest.startLine)
  commitBlockEdit(block)
  const line = dir < 0 ? startLine - 1 : startLine + newLineCount
  nextTick(() => {
    const total = content.value.split('\n').length
    if (line < 0 || line >= total) return
    activateLineForEditing(line, dir < 0 ? 'end' : 'start')
  })
}

const handleEditorKeydown = (block, e) => {
  const el = e.target
  if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) {
    e.preventDefault()
    commitBlockEdit(block)
    return
  }
  if (e.isComposing) return

  const latest = parsedBlocks.value.find(b => b.id === block.id)
  const isFence = latest && latest.type === 'fence'
  const isItem = latest && latest.type === 'list_item'

  if (e.key === 'Enter' && !e.shiftKey && !isFence) {
    e.preventDefault()
    editorEnter(block, el)
    return
  }

  if (e.key === 'Tab') {
    e.preventDefault()
    if (isItem) {
      editorIndentLine(block, el, e.shiftKey)
    } else {
      // plain two-space tab (code blocks etc.)
      const s = el.selectionStart
      editingText.value = el.value.slice(0, s) + '  ' + el.value.slice(el.selectionEnd)
      activeBlockDirty.value = true
      nextTick(() => { el.setSelectionRange(s + 2, s + 2); autoResizeEditor() })
    }
    return
  }

  if (e.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0) {
    if (el.value === '') {
      e.preventDefault()
      deleteEmptyBlockText(block)
      return
    }
    if (isItem) {
      const body = el.value.replace(/^(\s*)([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, '')
      if (body.trim() === '') {
        e.preventDefault()
        exitListItemText(block)
        return
      }
    }
  }

  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const pos = el.selectionStart
    if (e.key === 'ArrowUp' && !el.value.slice(0, pos).includes('\n')) {
      e.preventDefault()
      navigateFromBlock(block, -1)
      return
    }
    if (e.key === 'ArrowDown' && !el.value.slice(pos).includes('\n')) {
      e.preventDefault()
      navigateFromBlock(block, 1)
      return
    }
  }

  if (e.key === 'ArrowLeft' && el.selectionStart === 0 && el.selectionEnd === 0) {
    e.preventDefault()
    navigateFromBlock(block, -1)
    return
  }
  if (e.key === 'ArrowRight' && el.selectionStart === el.value.length && el.selectionEnd === el.value.length) {
    e.preventDefault()
    navigateFromBlock(block, 1)
    return
  }
}

// Paste in the editor: images become image blocks; text uses the textarea's
// native plain-text paste (raw markdown pastes exactly as typed)
const handleEditorPaste = (e) => {
  // mixed clipboards (Word/web: html + a bitmap render of the text) must
  // paste the TEXT — only bitmap-only clipboards become image blocks
  if (Array.from(e.clipboardData?.types || []).includes('text/html')) return
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault()
      const file = item.getAsFile()
      if (file) {
        const reader = new FileReader()
        reader.onload = (ev) => insertImageAtAnchor(ev.target.result, file.name || 'Pasted Image')
        reader.readAsDataURL(file)
      }
      return
    }
  }
}

// ---- Floating toolbar over the editor's selection ----
const showEditorToolbar = () => {
  const el = getEditorEl()
  const area = previewAreaRef.value
  if (!el || !area) return
  if (el.selectionStart === el.selectionEnd) {
    if (toolbarMode.value === 'selection') toolbarVisible.value = false
    return
  }
  const coords = getCaretCoordinates(el, el.selectionStart)
  const rect = el.getBoundingClientRect()
  const areaRect = area.getBoundingClientRect()
  toolbarTop.value = Math.max(rect.top - areaRect.top + coords.top - 10, 64)
  toolbarLeft.value = rect.left - areaRect.left + coords.left + 20
  // Source editing has no computed active/mixed formatting states — show all
  toolbarState.value = {
    bold: 'inactive', italic: 'inactive', strike: 'inactive', code: 'inactive',
    heading: false, showHeadings: true, quote: 'inactive', ul: 'inactive',
    ol: 'inactive', task: false, link: 'inactive', image: 'inactive', table: 'inactive'
  }
  toolbarMode.value = 'selection'
  toolbarVisible.value = true
}

// Wrap the editor selection in markdown/HTML syntax
const insertAroundEditor = (before, after, placeholder) => {
  const el = getEditorEl()
  if (!el) return false
  const s = el.selectionStart
  const eIdx = el.selectionEnd
  const sel = el.value.slice(s, eIdx) || placeholder
  editingText.value = el.value.slice(0, s) + before + sel + after + el.value.slice(eIdx)
  activeBlockDirty.value = true
  nextTick(() => {
    el.focus()
    el.setSelectionRange(s + before.length, s + before.length + sel.length)
    autoResizeEditor()
  })
  return true
}

// ---- Table-only keydown (contenteditable path) ----
const handleBlockKeydown = (block, e) => {
  if (e.target && e.target.tagName === 'TEXTAREA') return
  const latest = parsedBlocks.value.find(b => b.id === block.id)
  if (!latest || !isTableBlockData(latest)) return

  if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) {
    e.preventDefault()
    commitBlockEdit(block)
    return
  }
  const activeEl = document.getElementById(`block-content-${block.id}`)
  if (!activeEl) return
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    handleTableEnter(activeEl)
    return
  }
  if (e.key === 'Tab' && !e.isComposing) {
    e.preventDefault()
    handleTableTab(activeEl, e.shiftKey)
    return
  }
}

// Enter inside a table: move the caret to the same column in the next row,
// appending a new row when on the last one.
const handleTableEnter = (activeEl) => {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const cell = getClosestCell(sel.getRangeAt(0).startContainer)
  if (!cell) return false
  const table = getClosestTable(cell)
  if (!table || !activeEl.contains(table)) return false

  const row = cell.parentElement
  const colIdx = Array.from(row.children).indexOf(cell)
  const rows = Array.from(table.querySelectorAll('tr'))
  const rowIdx = rows.indexOf(row)

  let targetRow = rows[rowIdx + 1]
  if (!targetRow) {
    const colCount = row.children.length || 1
    targetRow = document.createElement('tr')
    for (let i = 0; i < colCount; i++) {
      targetRow.appendChild(createTableCell('TD'))
    }
    ;(table.tBodies[0] || table).appendChild(targetRow)
    markActiveBlockDirty()
  }

  const targetCell = targetRow.children[Math.min(colIdx, targetRow.children.length - 1)]
  if (!targetCell) return false
  const r = document.createRange()
  r.selectNodeContents(targetCell)
  r.collapse(true)
  sel.removeAllRanges()
  sel.addRange(r)
  return true
}

// Tab / Shift+Tab in a table: hop to the next / previous cell
const handleTableTab = (activeEl, backwards) => {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const cell = getClosestCell(sel.getRangeAt(0).startContainer)
  if (!cell) return false
  const table = getClosestTable(cell)
  if (!table || !activeEl.contains(table)) return false

  const cells = Array.from(table.querySelectorAll('th, td'))
  const idx = cells.indexOf(cell)
  let target = cells[idx + (backwards ? -1 : 1)]
  if (!target && !backwards) {
    const row = cell.parentElement
    const colCount = row.children.length || 1
    const newRow = document.createElement('tr')
    for (let i = 0; i < colCount; i++) {
      newRow.appendChild(createTableCell('TD'))
    }
    ;(table.tBodies[0] || table).appendChild(newRow)
    markActiveBlockDirty()
    target = newRow.children[0]
  }
  if (!target) return false
  const r = document.createRange()
  r.selectNodeContents(target)
  sel.removeAllRanges()
  sel.addRange(r)
  return true
}

// ------ END BLOCK SPLITTER ------
// Header statistics must not block an editor transaction. Large documents are
// counted in cancellable chunks; a newer keystroke invalidates the old scan at
// its next yield instead of letting stale O(n) work monopolize the UI thread.
const stats = ref({ chars: 0, lines: 0, words: 0 })


const turndownService = new TurndownService({
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  headingStyle: 'atx',
  bulletListMarker: '-'
})

// GFM must be registered BEFORE the custom rules: turndown gives precedence to
// the most recently added rule, so registering gfm first lets every custom rule
// below override its counterpart (e.g. our '~~' strikethrough beats gfm's
// single-tilde '~', which markdown-it-sub would re-parse as subscript).
turndownService.use(gfm)

// the preview's code-block language tag is a UI affordance, not content
turndownService.remove((node) => node.nodeType === 1 && node.classList && node.classList.contains('knote-md-code-lang'))

// Override escape to preserve [ ] and [x]
const defaultEscape = turndownService.escape
turndownService.escape = function (string) {
  // Let standard escape happen first
  // It escapes [ ] to \[ \]
  let escaped = defaultEscape.call(turndownService, string)

  // Unescape task lists: \[ \] -> [ ], \[x\] -> [x]
  // We handle both space and no space for empty box just in case
  escaped = escaped.replace(/\\\[\s*\\\]/g, '[ ]')
  escaped = escaped.replace(/\\\[x\\\]/g, '[x]')

  // Unescape footnote refs: \[^1\] -> [^1] (footnote refs render per-block as
  // literal text, so committing such a block must not corrupt them)
  escaped = escaped.replace(/\\\[\^([^\]]+)\\\]/g, '[^$1]')

  return escaped
}

turndownService.addRule('strikethrough', {
  filter: ['del', 's', 'strike'],
  replacement(content) {
    return content ? `~~${content}~~` : ''
  }
})

// Underline (<u> from Ctrl+U / execCommand) persists as ++ins++ markdown
turndownService.addRule('underlineAsIns', {
  filter: 'u',
  replacement(content) {
    return content ? `++${content}++` : ''
  }
})

// Colored text / background highlight persists as inline HTML spans
// (markdown has no color syntax; html:true re-renders them faithfully)
turndownService.addRule('coloredSpan', {
  filter: function (node) {
    if (node.nodeName === 'FONT' && node.getAttribute('color')) return true
    if (node.nodeName !== 'SPAN') return false
    if (node.hasAttribute('data-knote-emoji')) return false
    return !!(node.style && (node.style.color || node.style.backgroundColor))
  },
  replacement: function (content, node) {
    if (!content.trim()) return content
    const color = (node.style && node.style.color) || node.getAttribute('color') || ''
    const bg = (node.style && node.style.backgroundColor) || ''
    let style = ''
    if (color) style += `color:${color};`
    if (bg) style += `background-color:${bg};`
    return style ? `<span style="${style}">${content}</span>` : content
  }
})

// Rule to preserve text-align styles (for image alignment)
turndownService.addRule('alignedBlock', {
  filter: function (node) {
    return (
      (node.nodeName === 'DIV' || node.nodeName === 'P') &&
      (node.style.textAlign === 'center' || node.style.textAlign === 'right' || node.style.textAlign === 'left')
    )
  },
  replacement: function (content, node) {
    const align = node.style.textAlign
    const tag = node.nodeName.toLowerCase()
    return `\n\n<${tag} style="text-align: ${align}">\n${content}\n</${tag}>\n\n`
  }
})

// Standard Paragraph Rule is fine, we don't need ZWS hacks anymore
// because we handle empty blocks explicitly in syncPreviewToMarkdown via markers.
// Standard Paragraph Rule is fine, we don't need ZWS hacks anymore
// because we handle empty blocks explicitly in syncPreviewToMarkdown via markers.
// Overwrite standard paragraph rule to handle alignment and DIVs
turndownService.addRule('paragraph', {
  filter: function (node) {
    const isBlock = node.nodeName === 'DIV' || node.nodeName === 'P'
    if (!isBlock) return false
    const parent = node.parentNode
    if (parent && (parent.nodeName === 'LI' || parent.nodeName === 'BLOCKQUOTE')) {
      return false
    }
    return true
  },
  replacement: function (content, node) {
    // [FIX] Handle empty paragraphs explicitly to preserve "fake empty lines"
    // If content is effectively empty (whitespace/newlines only), treat it as a deliberate empty line.
    // We return <br> wrapped in newlines, which we then compact in syncPreviewToMarkdown.
    if (!content.trim()) {
      return '\n\n<br>\n\n'
    }

    if (node.style.textAlign) {
      const align = node.style.textAlign
      const rawText = (node.textContent || '').replace(/:::\s*align:\w+\s*:::/g, '').replace(/\u200B/g, '').trim()
      if (node.querySelector('img') && rawText.length === 0) {
        const tag = node.nodeName.toLowerCase()
        return `\n\n<${tag} style="text-align: ${align}">\n${content}\n</${tag}>\n\n`
      }
      return `\n\n::: align:${align} ::: ${content}\n\n`
    }
    return '\n\n' + content + '\n\n'
  }
})

// Enforce strict list items
turndownService.addRule('listItem', {
  filter: function (node) {
    return node.nodeName === 'LI' && !node.classList.contains('footnote-item') && !node.parentElement.classList.contains('footnotes-list')
  },
  replacement: function (content, node, options) {
    content = content
      .replace(/^\n+/, '') // remove leading newlines
      .replace(/\n+$/, '\n') // replace trailing newlines with just one
      .replace(/\n/gm, '\n    ') // indent
    
    // Trim content to avoid extra spaces after marker
    content = content.trim()
      
    let prefix = options.bulletListMarker + ' '
    const parent = node.parentNode
    if (parent.nodeName === 'OL') {
      const start = parent.getAttribute('start')
      const index = Array.prototype.indexOf.call(parent.children, node)
      prefix = (start ? Number(start) + index : index + 1) + '. '
    }
    return (
      prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '')
    )
  }
})

// Explicit Header Rule to guarantee proper spacing (ATX format)
turndownService.addRule('heading', {
  filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  replacement: function (content, node, options) {
    const hLevel = Number(node.nodeName.charAt(1))
    const hashes = '#'.repeat(hLevel)
    return '\n\n' + hashes + ' ' + content + '\n\n'
  }
})

// Clean up blank replacement
turndownService.blankReplacement = function (content, node) {
  return node.isBlock ? '\n\n' : ''
}

// Overwrite standard Image rule to handle data URLs (knote-img mapping)
turndownService.addRule('image', {
  filter: 'img',
  replacement: function (content, node) {
    const src = node.getAttribute('src') || ''
    const alt = node.getAttribute('alt') || 'image'
    
    // Custom logic for data URLs (restore knote-img reference)
    let finalSrc = src
    if (src.startsWith('data:')) {
        let existingId = null
        for (const [id, url] of Object.entries(imageStore)) {
            if (url === src) {
                existingId = id
                break
            }
        }
        
        // Use existing ID or generate new one
        const id = existingId || generateImageId()
        if (!existingId) {
            imageStore[id] = src
        }
        finalSrc = `knote-img:${id}`
    }
    
    // [FIX] Preserve style/dimensions by returning HTML if style exists
    const style = node.getAttribute('style') || ''
    if (style) {
        return `<img src="${finalSrc}" alt="${alt}" style="${style}">`
    }

    return `![${alt}](${finalSrc})`
  }
})

// === CUSTOM EXTENSION RULES ===

// 1. Highlight (==)
turndownService.addRule('mark', {
  filter: 'mark',
  replacement: function (content) {
    return '==' + content + '=='
  }
})

// 2. Insert (++)
turndownService.addRule('ins', {
  filter: 'ins',
  replacement: function (content) {
    return '++' + content + '++'
  }
})

// 3. Subscript (~)
turndownService.addRule('sub', {
  filter: 'sub',
  replacement: function (content) {
    return '~' + content + '~'
  }
})

// 4. Superscript (^) - Handle simple sup vs footnote ref
turndownService.addRule('sup', {
  filter: function (node) {
    return node.nodeName === 'SUP' && !node.classList.contains('footnote-ref')
  },
  replacement: function (content) {
    return '^' + content + '^'
  }
})

// 4.5 Emoji (Custom span)
turndownService.addRule('emoji', {
  filter: function (node) {
    return node.nodeName === 'SPAN' && node.hasAttribute('data-knote-emoji')
  },
  replacement: function (content, node) {
    return node.getAttribute('data-knote-emoji')
  }
})

// 5. Code Blocks - Preserve whitespace carefully
turndownService.addRule('fencedCodeBlock', {
  filter: function (node, options) {
    return (
      options.codeBlockStyle === 'fenced' &&
      node.nodeName === 'PRE' &&
      node.firstChild &&
      node.firstChild.nodeName === 'CODE'
    )
  },
  replacement: function (content, node, options) {
    const codeEl = node.firstChild
    const className = codeEl.getAttribute('class') || ''
    const language = (className.match(/language-(\S+)/) || [null, ''])[1]
    
    // Priority: use data-code if available (perfect fidelity)
    // Fallback: use textContent
    let code = ''
    if (codeEl.hasAttribute('data-code')) {
      try {
        code = decodeURIComponent(codeEl.getAttribute('data-code'))
      } catch (e) {
        code = codeEl.textContent
      }
    } else {
      code = codeEl.textContent
    }
    
    const fence = '```'
    const lang = language || ''
    
    return '\n\n' + fence + lang + '\n' +
      code.replace(/\n$/, '') +
      '\n' + fence + '\n\n'
  }
})

// 6. Explicit Breaks (preserve empty lines)
turndownService.addRule('softBreak', {
  filter: 'br',
  replacement: function (content, node, options) {
    // If it's the last child of a block, it might be a phantom BR from contenteditable
    if (node.parentNode && node === node.parentNode.lastChild && node.parentNode.childNodes.length > 1) {
       return '\n'
    }
    return '  \n' // Markdown hard break (two spaces + newline)
  }
})

// 7. Task List Items - Relaxed Filter (Matches input checkbox)

// 6. Task List Items - Relaxed Filter (Matches input checkbox)
turndownService.addRule('taskCheckbox', {
  filter: function (node) {
    return node.nodeName === 'INPUT' && node.type === 'checkbox'
  },
  replacement: function (_, node) {
    return node.checked ? '[x] ' : '[ ] '
  }
})

// 7. Footnotes
// 7. Footnotes

// Remove HR separator
turndownService.addRule('footnoteSeparator', {
  filter: function (node) {
    return node.nodeName === 'HR' && node.classList.contains('footnotes-sep')
  },
  replacement: function () {
    return ''
  }
})

turndownService.addRule('footnoteRef', {
  filter: function (node) {
    return node.nodeName === 'SUP' && node.classList.contains('footnote-ref')
  },
  replacement: function (content, node) {
    // Rely on ID instead of content parsing if possible
    // <sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>
    const child = node.firstChild
    if (child && child.nodeName === 'A') {
        const href = child.getAttribute('href') || '' // #fn1
        const id = href.replace(/^#fn/, '')
        if (id) return `[^${id}]`
    }
    // Fallback: extract from content [1]
    const match = content.match(/\[(\d+)\]/)
    const id = match ? match[1] : content.replace(/[\[\]]/g, '')
    return `[^${id}]`
  }
})

turndownService.addRule('footnoteSection', {
  filter: function (node) {
    return (node.nodeName === 'SECTION' || node.nodeName === 'DIV') && node.classList.contains('footnotes')
  },
  replacement: function (content) {
    return '\n\n' + content + '\n\n'
  }
})

turndownService.addRule('footnoteList', {
  filter: function (node) {
    return node.nodeName === 'OL' && node.classList.contains('footnotes-list')
  },
  replacement: function (content) {
    return content
  }
})

turndownService.addRule('footnoteDef', {
  filter: function (node) {
    return node.nodeName === 'LI' && (node.classList.contains('footnote-item') || (node.parentElement && node.parentElement.classList.contains('footnotes-list')))
  },
  replacement: function (content, node) {
    const id = node.getAttribute('id') ? node.getAttribute('id').replace(/^fn/, '') : '1'
    // Remove backref link [↩︎] if present
    const cleanContent = content.replace(/\s*↩︎\s*$/, '').trim()
    return `[^${id}]: ${cleanContent}\n`
  }
})

turndownService.addRule('footnoteBackref', {
  filter: function (node) {
    return node.nodeName === 'A' && node.classList.contains('footnote-backref')
  },
  replacement: function () {
    return ''
  }
})

const insertAround = async (before, after, placeholder) => {
  const el = textareaRef.value
  if (!el) return
  const start = el.selectionStart
  const end = el.selectionEnd
  // Toggle: if the selection is already wrapped in exactly this pair, unwrap
  // it instead (Obsidian-style; applies to every formatting shortcut and
  // toolbar action). The bounds guard keeps slice() from wrapping around at
  // negative offsets.
  const wrapped = start >= before.length &&
    content.value.slice(start - before.length, start) === before &&
    content.value.slice(end, end + after.length) === after
  if (wrapped) {
    const selectedLength = end - start
    const next = content.value.slice(0, start - before.length) +
      content.value.slice(start, end) +
      content.value.slice(end + after.length)
    content.value = next
    await nextTick()
    el.focus()
    el.selectionStart = start - before.length
    el.selectionEnd = start - before.length + selectedLength
    return
  }
  const selected = content.value.slice(start, end) || placeholder
  const next = content.value.slice(0, start) + before + selected + after + content.value.slice(end)
  content.value = next
  await nextTick()
  el.focus()
  el.selectionStart = start + before.length
  el.selectionEnd = start + before.length + selected.length
}

const insertLinePrefix = async (prefix, placeholder) => {
  const el = textareaRef.value
  if (!el) return
  const start = el.selectionStart
  const end = el.selectionEnd
  const selected = content.value.slice(start, end) || placeholder
  const nextBlock = selected
    .split('\n')
    .map((line) => `${prefix}${line || ''}`)
    .join('\n')
  content.value = content.value.slice(0, start) + nextBlock + content.value.slice(end)
  await nextTick()
  el.focus()
  el.selectionStart = start
  el.selectionEnd = start + nextBlock.length
}

const insertBlock = async (block, placeholder) => {
  const el = textareaRef.value
  if (!el) return
  const start = el.selectionStart
  const end = el.selectionEnd
  const selected = content.value.slice(start, end) || placeholder
  const next = content.value.slice(0, start) + block.replace('{content}', selected) + content.value.slice(end)
  content.value = next
  await nextTick()
  el.focus()
  el.selectionStart = start
  el.selectionEnd = start + block.replace('{content}', selected).length
}

const insertLinePrefixAt = async (prefix, index) => {
  const el = textareaRef.value
  if (!el) return
  const target = typeof index === 'number' ? index : el.selectionStart
  content.value = content.value.slice(0, target) + prefix + content.value.slice(target)
  await nextTick()
  el.focus()
  el.selectionStart = target + prefix.length
  el.selectionEnd = target + prefix.length
}

const insertBlockAt = async (block, placeholder, index) => {
  const el = textareaRef.value
  if (!el) return
  const target = typeof index === 'number' ? index : el.selectionStart
  const nextBlock = block.replace('{content}', placeholder)
  content.value = content.value.slice(0, target) + nextBlock + content.value.slice(target)
  await nextTick()
  el.focus()
  el.selectionStart = target
  el.selectionEnd = target + nextBlock.length
}

// Serialize the document for export/saving: knote-img:<id> references are
// session-local, so they must be expanded to real data URLs or the images
// would be permanently lost on reload.
const exportableMarkdown = (source) => {
  if (source === undefined) {
    if (largeRichEditorRef.value?.flushEmit) largeRichEditorRef.value.flushEmit()
    commitLargeSourceDraft('export')
    source = content.value
  }
  // The common path has no session-local images and can return the immutable
  // source string without enumerating the global image cache. When markers do
  // exist, one bounded pass is substantially cheaper than one full split/join
  // of a multi-megabyte document for every image ever seen in the session.
  if (!source.includes('knote-img:')) return source
  return source.replace(/knote-img:([^\s)"'\]]+)/g, (whole, id) => imageStore[id] || whole)
}

// Inverse on import: register embedded data URLs into the image store and
// replace them with short references so the source stays readable.
const importMarkdown = (text) => {
  // Normalize CRLF/CR: the empty-row conventions and the preview's newline
  // handling all assume \n line endings
  let next = typeof text === 'string' ? text : String(text || '')
  if (next.includes('\r')) next = next.replace(/\r\n?/g, '\n')
  if (!next.includes('data:image/')) return next
  const dataUrlRegex = /data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+/g
  const seen = new Map()
  next = next.replace(dataUrlRegex, (m) => {
    if (!seen.has(m)) {
      const id = ensureImageId(m)
      seen.set(m, id ? `knote-img:${id}` : m)
    }
    return seen.get(m)
  })
  return next
}

const copyMarkdown = async () => {
  await navigator.clipboard.writeText(exportableMarkdown())
}

// LOCAL date stamp for filenames (toISOString is UTC: exporting before 8am
// in UTC+8 would be stamped with yesterday's date)
const localDateStamp = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Android: the WebView ignores blob-anchor downloads — exports are written
// into the Knote workspace folder instead, with a toast naming the location
const notifyNativeExport = (loc) => {
  agentNotice.value = loc
    ? (lang.value === 'zh' ? `已保存到 ${loc}` : `Saved to ${loc}`)
    : (lang.value === 'zh' ? '保存失败：没有可写的存储位置' : 'Save failed: no writable storage')
  setTimeout(() => { agentNotice.value = '' }, 5000)
}

const downloadMarkdown = () => {
  if (isNativeApp()) {
    nativeExportText(`knote-${localDateStamp()}.md`, exportableMarkdown()).then(notifyNativeExport)
    return
  }
  const blob = new Blob([exportableMarkdown()], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `knote-${localDateStamp()}.md`
  link.click()
  URL.revokeObjectURL(url)
}

// Any content replacement from OUTSIDE the editing flow (load/clear/open/undo)
// must drop the active editing state — a live editor bound to positional block
// ids would otherwise re-attach to an unrelated block after the re-render.
const resetEditingState = () => {
  activeBlockId.value = null
  activeBlockDirty.value = false
  editingText.value = ''
  clearSelectionUi()
  toolbarVisible.value = false
  lineButtonVisible.value = false
}

const clearAll = async () => {
  const msg = lang.value === 'zh'
    ? '确定要清除全部内容吗？此操作会同步到已打开的本地文件。'
    : 'Clear the entire document? This also updates the opened local file.'
  if (!await confirmDialog(msg, { owner: 'clear-document' })) return
  resetEditingState()
  if (largeRichEditorRef.value?.flushEmit) largeRichEditorRef.value.flushEmit()
  commitLargeSourceDraft('clear-all')
  replaceWholeDocumentContent('')
}

const loadSample = async (sampleLanguage = 'zh') => {
  const nextSample = sampleLanguage === 'en' ? sampleEn : sampleZh
  // Never silently destroy work: confirm when the doc has content, DETACH
  // any opened file first (auto-save must not write the sample into it),
  // and record the swap in the editor history so Ctrl+Z restores the doc.
  if (content.value.trim()) {
    const msg = lang.value === 'zh'
      ? '加载示例会替换当前文档的显示内容（可用 Ctrl+Z 撤回）。已打开的本地文件会先断开连接，文件本身不会被写入示例。是否继续？'
      : 'Loading the sample replaces the current document view (Ctrl+Z restores it). Any opened local file is detached first and will NOT be overwritten. Continue?'
    if (!await confirmDialog(msg, { owner: 'load-sample' })) return
  }
  resetEditingState()
  cancelAutoSave()
  bumpAgentDocumentGeneration(activeTab && activeTab())
  setTabFileWorkspaceIdentity(activeTab && activeTab())
  currentFileHandle.value = null
  isLocalFile.value = false
  currentFileName.value = ''
  activeTreePath.value = ''
  folderHandle.value = null
  folderName.value = ''
  folderWorkspaceId.value = ''
  folderWorkspaceIdentityDurable.value = false
  folderTree.value = []
  expandedDirs.value = new Set()
  docDir.value = null
  clearRelImages()
  const tb = activeTab()
  if (tb) {
    tb.folderHandle = null
    tb.folderName = ''
    tb.folderWorkspaceId = ''
    tb.folderWorkspaceIdentityDurable = false
    tb.folderTree = []
    tb.expandedDirs = new Set()
  }
  replaceWholeDocumentContent(nextSample)
  if (viewMode.value === 'single' && richEditorRef.value) {
    richEditorRef.value.applyExternal(richMarkdown.value)
  }
}

// ========== Undo/Redo System ==========

// ========== Selection Persistence Helpers ==========
const getSelectionSnapshot = () => {
    if (largeDocumentPlainMode.value) {
        return { type: 'large-rich', page: largeSourcePage.value }
    }
    if (viewMode.value === 'split') {
        const el = textareaRef.value
        return { 
            type: 'split',
            start: el ? el.selectionStart : 0, 
            end: el ? el.selectionEnd : 0,
            scrollTop: el ? el.scrollTop : 0
        }
    } else {
        const selection = window.getSelection()
        if (!selection.rangeCount) return { type: 'single', blockIndex: -1, offset: 0 }
        
        const range = selection.getRangeAt(0)
        const root = previewRef.value
        if (!root) return { type: 'single', blockIndex: -1, offset: 0 }
        
        // Find top-level block index
        let node = range.startContainer
        let offset = range.startOffset
        
        // Calculate text offset relative to the block
        // This is simplified: assumes strictly text mostly. For complex HTML it's approx.
        // We traverse backwards from current node to block start to sum up offsets.
        
        // First find the direct child of root
        let block = node
        while (block && block.parentElement !== root) {
            block = block.parentElement
        }
        if (!block) return { type: 'single', blockIndex: -1, offset: 0 }

        if (block.getAttribute && block.getAttribute('data-image-spacer') === 'true') {
            const prev = block.previousElementSibling
            if (prev) {
                block = prev
            }
        }
        
        const blockIndex = Array.prototype.indexOf.call(root.children, block)
        
        // Calculate abstract text offset within block
        // (DFS traversal to count text length before current range)
        let set = false
        let currentOffset = 0
        
        const traverse = (n) => {
            if (set) return
            if (n === range.startContainer) {
                currentOffset += range.startOffset
                set = true
                return
            }
            if (n.nodeType === Node.TEXT_NODE) {
                currentOffset += n.textContent.length
            } else {
                for (const child of n.childNodes) {
                    traverse(child)
                    if (set) return
                }
            }
        }
        traverse(block)
        const imageSelected = block && isImageBlock(block)
        const tableSelected = block && block.nodeName === 'TABLE' && !range.collapsed
        return { type: 'single', blockIndex, offset: currentOffset, imageSelected, tableSelected }
    }
}

const restoreSelectionSnapshot = (snapshot) => {
    if (!snapshot || (snapshot.type === 'single' && snapshot.blockIndex === -1)) {
        // [FIX] Explicitly clear selection and hide highlight/toolbars when no selection snapshot
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selectedBlock.value = null
        clearSelectionUi()
        toolbarVisible.value = false
        lineButtonVisible.value = false
        return
    }
    
    if (largeDocumentPlainMode.value && snapshot.type === 'large-rich') {
        openLargeSourcePage(snapshot.page || 0)
    } else if (viewMode.value === 'split' && snapshot.type === 'split') {
        const el = textareaRef.value
        if (el) {
            el.focus()
            el.setSelectionRange(snapshot.start, snapshot.end)
            el.scrollTop = snapshot.scrollTop
        }
    } else if (viewMode.value === 'single' && snapshot.type === 'single') {
        const root = previewRef.value
        if (!root || !root.children[snapshot.blockIndex]) return
        
        let block = root.children[snapshot.blockIndex]
        if (block && block.getAttribute && block.getAttribute('data-image-spacer') === 'true') {
            const prev = block.previousElementSibling
            if (prev) {
                block = prev
            }
        }
        
        // Restore caret
        let targetNode = null
        let targetOffset = snapshot.offset
        
        // DFS to find correct text node
        const traverse = (n) => {
            if (targetNode) return
            if (n.nodeType === Node.TEXT_NODE) {
                const len = n.textContent.length
                if (targetOffset <= len) {
                    targetNode = n
                    return
                }
                targetOffset -= len
            } else {
                for (const child of n.childNodes) {
                    traverse(child)
                    if (targetNode) return
                }
            }
        }
        traverse(block)
        
        const selection = window.getSelection()
        const range = document.createRange()
        
        if (snapshot.imageSelected) {
            const img = getImageFromBlock(block)
            if (img) {
                range.selectNode(img)
            } else {
                range.setStart(block, 0)
                range.collapse(true)
            }
        } else if (snapshot.tableSelected) {
            range.selectNode(block)
        } else if (targetNode) {
            range.setStart(targetNode, targetOffset)
            range.collapse(true)
        } else {
            range.setStart(block, 0)
            range.collapse(true)
        }
        
        selection.removeAllRanges()
        selection.addRange(range)
        
        // Scroll & UI
        block.scrollIntoView({ block: 'nearest' })
        let resolvedBlock = resolveImageBlockFromBlock(block) || block

        // Re-resolve from image if possible
        const potentialImg = getImageFromBlock(resolvedBlock)
        if (potentialImg) {
             const freshBlock = resolveImageBlockFromImage(potentialImg)
             if (freshBlock) resolvedBlock = freshBlock
        }

        if (snapshot.imageSelected || isImageBlock(resolvedBlock)) {
          const img = getImageFromBlock(resolvedBlock)
          if (img) {
            selectImageBlock(img, resolvedBlock)
            lastSelectionSnapshot.value = snapshot
            return
          }
        }
        updateSelectedBlock()
        // [FIX] Explicitly sync highlight after a short delay to ensure image/layout is ready
        lastSelectionSnapshot.value = snapshot
    }
}

// Single<->split scroll hand-off (滚动位置继承). The two views scroll different boxes —
// single mode scrolls the page-level document owner (.knote-root on desktop), split
// scrolls each pane internally — and the split panes are v-if'd, so they remount at
// scrollTop 0 every time. Capture the outgoing view's scroll as a FRACTION of its
// scrollable range, then re-apply that fraction to the new view once it has laid out,
// so toggling keeps your place instead of jumping back to the top.
let pendingViewScrollFraction = null
const scrollFractionOf = (el) => {
    if (!el) return null
    const max = el.scrollHeight - el.clientHeight
    return max > 2 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0
}
const applyInheritedViewScroll = (mode) => {
    if (pendingViewScrollFraction == null) return
    const f = pendingViewScrollFraction
    pendingViewScrollFraction = null
    // Wait for the new view to mount AND lay out. Two frames, not one: mounting the
    // split source textarea pushes its caret to the end of the document, and the
    // browser scroll-reveals that caret (to the bottom) on the FIRST frame — an apply
    // on frame one gets overridden. Frame two lands after the reveal settles, so the
    // inherited fraction sticks. (Verified: 1 RAF -> bottom, 2 RAFs -> holds.)
    nextTick(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        if (mode === 'split') {
            const s = editorAreaRef.value
            const p = splitPreviewRef.value
            if (s) s.scrollTop = f * (s.scrollHeight - s.clientHeight)
            if (p) p.scrollTop = f * (p.scrollHeight - p.clientHeight)
        } else {
            const owner = documentScrollOwner()
            if (owner) owner.scrollTop = f * (owner.scrollHeight - owner.clientHeight)
        }
    })))
}

const setViewMode = (mode) => {
    if (mode === 'split' && pdfView.value) return
    if (viewMode.value === mode) return
    commitLargeSourceDraft('view-mode')
    // Capture the outgoing view's scroll fraction before the flip so the new view can
    // inherit it (single<->split keep your place).
    pendingViewScrollFraction = viewMode.value === 'single'
        ? scrollFractionOf(documentScrollOwner())
        : scrollFractionOf(editorAreaRef.value)
    if (viewMode.value === 'single') {
        // Leaving single mode with a block still in edit state would leave a
        // stale activeBlockId behind (breaking e.g. the Ctrl+Z routing) —
        // commit it first
        commitActiveBlockIfAny()
        activeBlockId.value = null
        activeBlockDirty.value = false
        const currentSnapshot = getSelectionSnapshot()
        if (currentSnapshot.type === 'single' && currentSnapshot.blockIndex === -1 && lastSelectionSnapshot.value) {
            viewModeSelectionSnapshot.value = lastSelectionSnapshot.value
        } else {
            viewModeSelectionSnapshot.value = currentSnapshot
        }
    }
    viewMode.value = mode
    applyInheritedViewScroll(mode)
}

const pushUndo = () => {
  if (isUndoRedoAction) return
  const large = content.value.length >= 1_000_000
  const previousBytes = snapshotStorageBytes(lastSavedSnapshot)
  // A single oversized full-document snapshot defeats the memory budget. For
  // those files the bounded source editor remains responsive and disk history
  // remains available, but in-memory whole-document undo is intentionally off.
  if (!large || previousBytes <= MAX_UNDO_BYTES) undoStack.value.push(lastSavedSnapshot)
  const entryLimit = large ? MAX_LARGE_UNDO : MAX_UNDO
  while (undoStack.value.length > entryLimit) undoStack.value.shift()
  let retainedBytes = undoStack.value.reduce((sum, entry) => sum + snapshotStorageBytes(entry), 0)
  while (undoStack.value.length && retainedBytes > MAX_UNDO_BYTES) {
    const removed = undoStack.value.shift()
    retainedBytes -= snapshotStorageBytes(removed)
  }
  redoStack.value = []
  // Capture current state as the new "Snapshot"
  lastSavedSnapshot = { 
    content: content.value, 
    selection: getSelectionSnapshot() 
  }
}

const scheduleUndoSnapshot = () => {
  if (isUndoRedoAction) return
  clearTimeout(undoTimer)
  undoTimer = setTimeout(() => {
    if (content.value !== lastSavedSnapshot.content) {
      pushUndo()
    }
  }, 500)
}

const undo = () => {
  // Single mode: ProseMirror owns the history (fine-grained, selection-aware)
  if (viewMode.value === 'single' && largeDocumentPlainMode.value && largeRichEditorRef.value) {
    largeRichEditorRef.value.undo()
    return
  }
  if (viewMode.value === 'single' && richEditorRef.value) {
    richEditorRef.value.undo()
    return
  }
  commitLargeSourceDraft('undo')
  // Flush the pending debounced snapshot first — otherwise Ctrl+Z right after
  // typing would skip the freshest state (or do nothing at all)
  clearTimeout(undoTimer)
  if (!isUndoRedoAction && content.value !== lastSavedSnapshot.content) {
    pushUndo()
  }
  if (undoStack.value.length === 0) return
  isUndoRedoAction = true

  // [FIX] Immediately hide highlight to prevent ghosting during undo transition
  clearSelectionUi()
  toolbarVisible.value = false
  lineButtonVisible.value = false

  // Save current state to redo stack so redo restores where we were
  const currentSnapshot = {
     content: content.value,
     selection: getSelectionSnapshot()
  }
  redoStack.value.push(currentSnapshot)
  
  resetEditingState()
  const prev = undoStack.value.pop()
  content.value = prev.content
  if (largeDocumentPlainMode.value) prepareLargeSourceDocument(content.value, largeSourcePage.value)
  lastSavedSnapshot = prev
  
  // Block engine reactively re-renders when content.value changes - no manual preview needed
  
  nextTick(() => {
      restoreSelectionSnapshot(prev.selection)
      isUndoRedoAction = false
  })
}

const redo = () => {
  if (viewMode.value === 'single' && largeDocumentPlainMode.value && largeRichEditorRef.value) {
    largeRichEditorRef.value.redo()
    return
  }
  if (viewMode.value === 'single' && richEditorRef.value) {
    richEditorRef.value.redo()
    return
  }
  commitLargeSourceDraft('redo')
  if (redoStack.value.length === 0) return
  isUndoRedoAction = true

  // [FIX] Immediately hide highlight to prevent ghosting during redo transition
  clearSelectionUi()
  toolbarVisible.value = false
  lineButtonVisible.value = false
  
  const currentSnapshot = {
     content: content.value,
     selection: getSelectionSnapshot()
  }
  undoStack.value.push(currentSnapshot)
  
  resetEditingState()
  const next = redoStack.value.pop()
  content.value = next.content
  if (largeDocumentPlainMode.value) prepareLargeSourceDocument(content.value, largeSourcePage.value)
  lastSavedSnapshot = next
  
  // Block engine reactively re-renders when content.value changes - no manual preview needed
  
  nextTick(() => {
      restoreSelectionSnapshot(next.selection)
      isUndoRedoAction = false
  })
}


// ========== File Management ==========
const ANDROID_STORAGE_KEY = 'knote-android-storage-v1'
let androidStorageIntentGeneration = 0
const androidGrantIsReferenced = (grantId) => {
  const matches = (handle) => String(handle?._knoteSafGrantId || '') === grantId
  if (matches(currentFileHandle.value) || matches(folderHandle.value) || matches(docDir.value)) return true
  return tabs.value.some((tb) => tb.id !== activeTabId.value && (
    matches(tb.fileHandle) || matches(tb.folderHandle) || matches(tb.docDir)
  ))
}
const rememberAndroidStorage = async (source, handle = null) => {
  if (!isAndroidNative) return
  const grantId = String(handle?._knoteSafGrantId || '')
  const kind = String(handle?._knoteSafGrantKind || '')
  if (source === 'saf' && (!grantId || !['tree', 'document'].includes(kind))) return
  let previous = null
  let stored = false
  try {
    previous = JSON.parse(localStorage.getItem(ANDROID_STORAGE_KEY) || 'null')
    localStorage.setItem(ANDROID_STORAGE_KEY, JSON.stringify(source === 'saf'
      ? { source, grantId, kind }
      : { source: 'legacy' }))
    stored = true
  } catch { /* storage unavailable */ }
  if (stored && previous?.source === 'saf' && previous.grantId && previous.grantId !== grantId) {
    await waitForAllDocumentSaves()
    if (!androidGrantIsReferenced(previous.grantId) && agentStatus.value !== 'running') {
      await releaseSafGrant(previous.grantId).catch(() => {})
    }
  }
}
const clearRememberedAndroidStorage = () => {
  try { localStorage.removeItem(ANDROID_STORAGE_KEY) } catch { /* storage unavailable */ }
}
const beginAndroidStorageIntent = () => ++androidStorageIntentGeneration
const prepareAndroidStorageReplacement = async () => {
  commitActiveBlockIfAny()
  assetsFlushGeneration += 1
  clearTimeout(assetsFlushTimer)
  const targetTab = activeTab()
  stopAgentRunsForDocument(agentDocumentKey())
  if (targetTab && !await waitForAgentDocumentLeases(targetTab)) {
    notify(lang.value === 'zh'
      ? '助手仍在使用当前存储位置，已取消打开操作'
      : 'The Agent is still using the current storage location, so opening was cancelled.')
    return false
  }
  const saveIdentity = snapshotDocKey()
  const flushed = await flushAutoSave()
  if (flushed === false) return false
  await waitForDocumentSaves(saveIdentity)
  if (documentIsAheadOfDisk(saveIdentity) && currentFileHandle.value) {
    notify(lang.value === 'zh'
      ? '当前文件尚未安全写入，已取消打开操作'
      : 'The current file is not safely persisted, so opening was cancelled.')
    return false
  }
  if (isPristineTab() || (!currentFileName.value && !content.value.trim())) return true
  const key = snapshotDocKey()
  if (isLocalFile.value && currentFileHandle.value && !documentIsAheadOfDisk(key)) return true
  const protectedDraft = await takeSnapshot('before Android open', key, content.value)
  if (protectedDraft == null) {
    notify(lang.value === 'zh'
      ? '当前内容未能写入历史，已取消打开操作'
      : 'The current draft could not be protected, so opening was cancelled.')
    return false
  }
  return confirmDialog(lang.value === 'zh'
    ? '当前内容尚未保存到文件。继续打开会替换当前编辑内容，是否继续？'
    : 'The current content is not saved to a file. Continue and replace it?')
}
const parentPathOf = (filePath) => String(filePath || '').replace(/[\\/][^\\/]*$/, '')
const mkDesktopHandle = (filePath, name) => mkDesktopFileHandle(filePath, name, parentPathOf(filePath))
const desktopOpenCapabilities = new Map()
const desktopOpenCapabilityKey = (type, target) => `${type}:${target}`
let e2eStandaloneOpenGate = null
const holdNextStandaloneOpen = () => {
  if (!window.knoteDesktop?.isE2E || e2eStandaloneOpenGate) return false
  let release
  const promise = new Promise((resolve) => { release = resolve })
  e2eStandaloneOpenGate = { promise, release, waiting: false }
  return true
}
const releaseStandaloneOpen = () => {
  if (!e2eStandaloneOpenGate) return false
  e2eStandaloneOpenGate.release()
  return true
}
const waitForStandaloneOpenGate = async () => {
  if (!window.knoteDesktop?.isE2E || !e2eStandaloneOpenGate) return
  const gate = e2eStandaloneOpenGate
  gate.waiting = true
  await gate.promise
  if (e2eStandaloneOpenGate === gate) e2eStandaloneOpenGate = null
}

// The on-disk directory that owns the current document (where its assets/
// folder lives): the doc's own folder for single-file opens, the parent of the
// active tree file for folder workspaces. Empty string when there is nowhere
// on disk to attach files to (untitled doc in the web build).
const currentDocDirPath = () => {
  const doc = docDir.value && docDir.value._deskPath
  if (doc) return doc.replace(/[\\/]$/, '')
  const file = currentFileHandle.value && currentFileHandle.value._deskPath
  if (file) return parentPathOf(file)
  const root = folderHandle.value && folderHandle.value._deskPath
  return root ? root.replace(/[\\/]$/, '') : ''
}

const installOpenedMarkdown = async ({ handle = null, fileName = '', text = '', writable = false, workspaceIdentity = '', workspaceIdentityDurable = false, savePrepared = false }) => {
  if (!savePrepared) {
    commitActiveBlockIfAny()
    const flushed = await flushAutoSave()
    if (flushed === false) return false
  }
  const targetTab = openInNewTab()
  bumpAgentDocumentGeneration(activeTab && activeTab())
  setTabFileWorkspaceIdentity(targetTab, workspaceIdentity, workspaceIdentityDurable)
  const navigationOwner = beginNavigationInstall()
  const nextContent = importMarkdown(text)
  try {
    cancelAutoSave()
    resetEditingState()
    clearRelImages()
    // Browser builds replace the current tab in place. A standalone file must
    // detach the previous folder workspace or that folder would keep winning
    // Agent identity even though the pathless/read-only file is now visible.
    folderHandle.value = null
    folderName.value = ''
    folderWorkspaceId.value = ''
    folderWorkspaceIdentityDurable.value = false
    folderTree.value = []
    expandedDirs.value = new Set()
    if (targetTab) {
      targetTab.folderHandle = null
      targetTab.folderName = ''
      targetTab.folderWorkspaceId = ''
      targetTab.folderWorkspaceIdentityDurable = false
      targetTab.folderTree = []
      targetTab.expandedDirs = new Set()
      if (String(targetTab.deskKey || '').startsWith('folder:')) targetTab.deskKey = ''
    }
    // Install ownership before content. The content watcher is synchronous;
    // doing this afterwards can freeze the new Markdown with the old handle.
    currentFileHandle.value = writable ? handle : null
    currentFileName.value = fileName
    isLocalFile.value = !!(writable && handle)
    activeTreePath.value = ''
    docDir.value = null
    const editorLoad = stageLargeEditorLoad(nextContent)
    content.value = nextContent
    void releaseLargeEditorLoad(editorLoad)
    undoStack.value = []
    redoStack.value = []
    lastSavedSnapshot = { content: nextContent, selection: null }
    relImagesNeedGrant.value = hasUnresolvedRelImages()
    markDocumentDiskBaseline(snapshotDocKey())
    blockedDocumentSaveIdentities.delete(snapshotDocKey())
  } finally {
    finishNavigationInstall(navigationOwner)
  }
  await takeSnapshot('opened', snapshotDocKey(), nextContent)
  return true
}

// Load a .md FILE HANDLE (picker / drag-drop) into a NEW doc tab (a pristine
// current tab is reused instead — see openInNewTab)
const openFileFromHandle = async (handle, options = {}) => {
  const stillCurrent = typeof options.stillCurrent === 'function' ? options.stillCurrent : () => true
  if (!stillCurrent()) return false
  // Ask for WRITE access now, inside the user gesture — the open picker
  // only grants read, and a permission prompt can't be shown later from
  // the auto-save timer. Granted => live-save (green indicator).
  let writable = typeof options.writable === 'boolean' ? options.writable : true
  if (typeof options.writable !== 'boolean' && handle.requestPermission) {
    writable = (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
    if (!stillCurrent()) return false
  }
  let workspaceIdentity = ''
  let workspaceIdentityDurable = false
  if (handle?._knoteIdentity) {
    workspaceIdentity = handle._knoteIdentity
    workspaceIdentityDurable = true
  } else if (!handle?._deskPath && handle?.kind === 'file' && typeof handle.isSameEntry === 'function') {
    const resolved = await resolveBrowserFileIdentity(handle)
    if (!stillCurrent()) return false
    workspaceIdentity = resolved.id
    workspaceIdentityDurable = resolved.durable
  }
  commitActiveBlockIfAny()
  const flushed = await flushAutoSave()
  if (flushed === false || !stillCurrent()) return false
  const mutationKey = await resolveFileMutationKey(null, workspaceIdentity, '', handle)
  if (!stillCurrent()) return false
  return await withAsyncKeyLock(mutationKey, async () => {
    if (!stillCurrent()) return false
    const file = await handle.getFile()
    if (!stillCurrent()) return false
    const text = await file.text()
    if (!stillCurrent()) return false
    return await installOpenedMarkdown({ handle, fileName: file.name, text, writable, workspaceIdentity, workspaceIdentityDurable, savePrepared: true })
  })
}

const openFallbackFile = async (fileName, readText) => {
  const workspaceIdentity = createPathlessFileSessionIdentity()
  commitActiveBlockIfAny()
  const flushed = await flushAutoSave()
  if (flushed === false) return false
  const mutationKey = await resolveFileMutationKey(null, workspaceIdentity, '', null)
  return await withAsyncKeyLock(mutationKey, async () => installOpenedMarkdown({
    fileName: String(fileName || 'note.md'),
    text: await readText(),
    writable: false,
    workspaceIdentity,
    savePrepared: true
  }))
}

const openLocalFile = async () => {
  cancelSessionRestoreForForegroundIntent()
  const androidIntent = isAndroidNative ? beginAndroidStorageIntent() : 0
  const androidIntentIsCurrent = () => !isAndroidNative || androidIntent === androidStorageIntentGeneration
  if (isAndroidNative) {
    if (!await prepareAndroidStorageReplacement() || !androidIntentIsCurrent()) return
  }
  let pendingAndroidGrantId = ''
  try {
    // desktop: native dialog feeding the same open pipeline as double-click
    // opens — path-backed handle, auto-save roots and the recents list all
    // come for free (the FS-Access picker below returns PATHLESS handles,
    // which is why in-app opens never showed up under 最近打开)
    if (isDesktopShell && window.knoteDesktop.pickOpen) {
      await window.knoteDesktop.pickOpen('file')
      return
    }
    if (isAndroidNative) {
      const handle = await pickSafDocument({
        mimeTypes: ['text/markdown', 'text/plain', 'application/octet-stream'],
        writable: true
      })
      pendingAndroidGrantId = handle._knoteSafGrantId
      if (!androidIntentIsCurrent()) return
      if (!/\.(?:md|markdown)$/i.test(handle.name || '')) {
        await releaseSafGrant(handle._knoteSafGrantId).catch(() => {})
        pendingAndroidGrantId = ''
        notify(lang.value === 'zh' ? '请选择 Markdown 文件（.md 或 .markdown）' : 'Choose a Markdown file (.md or .markdown)')
        return
      }
      if (await openFileFromHandle(handle, { stillCurrent: androidIntentIsCurrent })) {
        if (!androidIntentIsCurrent()) return
        await rememberAndroidStorage('saf', handle)
        pendingAndroidGrantId = ''
        mobileFilesOpen.value = false
      } else {
        await releaseSafGrant(handle._knoteSafGrantId).catch(() => {})
        pendingAndroidGrantId = ''
      }
      return
    }
    if (globalThis.showOpenFilePicker) {
      const [handle] = await globalThis.showOpenFilePicker({
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
        multiple: false
      })
      await openFileFromHandle(handle)
    } else {
      // Fallback for browsers without File System Access API
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.md,text/markdown'
      input.onchange = async (e) => {
        const file = e.target.files[0]
        if (!file) return
        await openFallbackFile(file.name, () => file.text())
      }
      input.click()
    }
  } catch (err) {
    if (err.name !== 'AbortError') console.error('Open file error:', err)
  } finally {
    if (pendingAndroidGrantId) await releaseSafGrant(pendingAndroidGrantId).catch(() => {})
  }
}

// A tiny per-document revision clock records whether editor memory is ahead
// of the last successful disk write.  It stores numbers, not another copy of
// the document, so long files do not double their memory footprint.  This is
// also the guard used by history restores and file-association reopens.
let documentEditRevisionSequence = 0
const documentEditRevisions = new Map()
const documentSavedRevisions = new Map()
const blockedDocumentSaveIdentities = new Set()
const uncertainSaveHandles = new WeakSet()
const staleSafFileHandles = new WeakSet()
const markDocumentDiskBaseline = (identity) => {
  const key = String(identity || '')
  if (!key) return 0
  const revision = ++documentEditRevisionSequence
  documentEditRevisions.set(key, revision)
  documentSavedRevisions.set(key, revision)
  return revision
}
const markDocumentEdited = (identity) => {
  const key = String(identity || '')
  if (!key) return 0
  const revision = ++documentEditRevisionSequence
  documentEditRevisions.set(key, revision)
  return revision
}
const documentRevisionForSave = (identity) => {
  const key = String(identity || '')
  if (!key) return 0
  if (documentEditRevisions.has(key)) return documentEditRevisions.get(key)
  return markDocumentEdited(key)
}
const markDocumentSaveSucceeded = (identity, revision) => {
  const key = String(identity || '')
  const next = Number(revision) || 0
  if (!key || !next) return
  documentSavedRevisions.set(key, Math.max(documentSavedRevisions.get(key) || 0, next))
}
const documentIsAheadOfDisk = (identity) => {
  const key = String(identity || '')
  if (!key) return false
  return (documentEditRevisions.get(key) || 0) > (documentSavedRevisions.get(key) || 0)
}
const documentEditRevision = (identity) => documentEditRevisions.get(String(identity || '')) || 0

const canonicalFileMutationKey = (filePath, fallbackIdentity = '') => {
  const raw = String(filePath || '')
  if (raw) {
    const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '')
    const windowsPath = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    return `path:${windowsPath ? normalized.toLowerCase() : normalized}`
  }
  return `identity:${String(fallbackIdentity || '')}`
}

const saveToFileHandle = async (handle, payload = null) => {
  // Capture every piece of document-specific state BEFORE the first await.
  // A file/tab switch can happen while permission or disk I/O is pending; a
  // save that reads the live refs afterwards can write the next document into
  // the previous file (or vice versa) and store its history under the wrong key.
  const defaultSnapshotKey = snapshotDocKey()
  const save = payload || {
    markdown: exportableMarkdown(content.value),
    snapshotContent: content.value,
    snapshotKey: defaultSnapshotKey,
    revision: documentRevisionForSave(defaultSnapshotKey)
  }
  const saveIdentity = save.snapshotKey || (handle && handle._deskPath ? `file:${handle._deskPath}` : '')
  const mutationKey = canonicalFileMutationKey(handle?._deskPath, saveIdentity)
  if (blockedDocumentSaveIdentities.has(String(saveIdentity))) return false
  if (!save.revision) save.revision = documentRevisionForSave(saveIdentity)
  return enqueueDocumentSave(saveIdentity, () => withAsyncKeyLock(mutationKey, async () => {
    if (blockedDocumentSaveIdentities.has(String(saveIdentity))) return false
  const protectedByMain = !!(window.knoteDesktop && handle && handle._deskPath)
  try {
    savingOperationCount++
    isSaving.value = true
    // Permission can lapse (e.g. after a reload); without this check every
    // debounced auto-save spams NotAllowedError into the console
    if (handle.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if (!handle.requestPermission || (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        if (handle === currentFileHandle.value) isLocalFile.value = false
        return false
      }
    }
    // Protect both sides of the replacement before opening a writer. This is
    // required for browser/native handles too, where the Electron main-process
    // safety layer is not present.
    if (!protectedByMain) {
      const previousFile = await handle.getFile()
      const previousText = String(await previousFile.text())
      const protectedOld = await takeSnapshot('before-save', save.snapshotKey, previousText)
      if (protectedOld == null) throw new Error('history_write_failed')
      const protectedNew = await takeSnapshot('pending-save', save.snapshotKey, save.snapshotContent)
      if (protectedNew == null) throw new Error('history_write_failed')
    }
    const writable = await handle.createWritable(handle._knoteIdentity
      ? { knoteHistoryProtected: true }
      : undefined)
    await writable.write(save.markdown)
    await writable.close()
    // each successful disk save is a natural version checkpoint
    if (!protectedByMain) await takeSnapshot('', save.snapshotKey, save.snapshotContent)
    markDocumentSaveSucceeded(saveIdentity, save.revision)
    uncertainSaveHandles.delete(handle)
    blockedDocumentSaveIdentities.delete(String(saveIdentity))
    return true
  } catch (err) {
    if (err?.code === 'WRITE_COMMIT_UNCERTAIN') {
      try {
        const actual = await handle.getFile()
        if (String(await actual.text()) === save.markdown) {
          if (!protectedByMain) await takeSnapshot('', save.snapshotKey, save.snapshotContent)
          markDocumentSaveSucceeded(saveIdentity, save.revision)
          notify(lang.value === 'zh'
            ? '文件已回读确认保存成功'
            : 'The file was saved and confirmed by re-reading it')
          return true
        }
      } catch { /* preserve the uncertain result */ }
      notify(lang.value === 'zh'
        ? '保存结果不确定，请重新打开文件确认后再继续编辑'
        : 'The save result is uncertain. Reopen the file to verify it before continuing.')
      uncertainSaveHandles.add(handle)
      staleSafFileHandles.add(handle)
      blockedDocumentSaveIdentities.add(String(saveIdentity))
      if (handle === currentFileHandle.value) isLocalFile.value = false
      if (folderHandle.value && handle?._knoteSafGrantId) {
        try { await refreshFolder() } catch { /* retain the stale tree for manual recovery */ }
      }
      return false
    }
    if (err?.code === 'ENTRY_CHANGED') {
      staleSafFileHandles.add(handle)
      if (handle === currentFileHandle.value) isLocalFile.value = false
      if (folderHandle.value && handle?._knoteSafGrantId) {
        try { await refreshFolder() } catch { /* retain the stale tree for manual recovery */ }
      }
      notify(lang.value === 'zh'
        ? '文件条目已被外部替换，已停止自动保存；请重新打开文件'
        : 'The file entry was externally replaced. Auto-save was stopped; reopen the file.')
    } else if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      if (handle === currentFileHandle.value) isLocalFile.value = false
    } else {
      console.error('Save error:', err)
    }
    if (err?.code !== 'ENTRY_CHANGED') {
      notify(lang.value === 'zh' ? '保存失败，请检查目标文件和存储权限' : 'Save failed. Check the target file and storage permission.')
    }
    return false
  } finally {
    savingOperationCount = Math.max(0, savingOperationCount - 1)
    isSaving.value = savingOperationCount > 0
  }
  }))
}

// ---- Version snapshots (local history + rollback) ----
// A stable PER-DOCUMENT key. A folder tab's deskKey identifies the workspace,
// not the open file, so it must be combined with activeTreePath; otherwise all
// documents in one folder silently share the same history list.
const opaqueHandleIds = new WeakMap()
let nextOpaqueHandleId = 0
const opaqueHandleIdentity = (handle) => {
  if (!handle || (typeof handle !== 'object' && typeof handle !== 'function')) return 'none'
  let id = opaqueHandleIds.get(handle)
  if (!id) {
    id = globalThis.crypto && globalThis.crypto.randomUUID
      ? globalThis.crypto.randomUUID()
      : `session-${Date.now()}-${++nextOpaqueHandleId}`
    opaqueHandleIds.set(handle, id)
  }
  return id
}
let pathlessFileSessionSequence = 0
const createPathlessFileSessionIdentity = () => {
  const token = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().toLowerCase()
    : `${Date.now().toString(36)}-${++pathlessFileSessionSequence}`
  return `file:session/${token}`
}
const folderSnapshotIdentity = (handle, workspaceId, deskKey = '') => (
  (deskKey && deskKey.startsWith('folder:') && deskKey) ||
  (handle?._deskPath && 'folder:' + handle._deskPath) ||
  handle?._knoteIdentity ||
  workspaceId ||
  'folder-handle:' + opaqueHandleIdentity(handle)
)
const treeSnapshotIdentity = (folderKey, treePath) => {
  if (!folderKey || !treePath) return ''
  const normalized = '/' + String(treePath).replace(/\\/g, '/').replace(/^\/+/, '')
  return `tree:${folderKey}:${normalized}`
}
const workspaceFileAbsolutePath = (workspaceHandle, relativePath) => {
  const root = String(workspaceHandle?._deskPath || '').replace(/[\\/]$/, '')
  if (!root) return ''
  const separator = root.includes('\\') ? '\\' : '/'
  return root + separator + String(relativePath || '').replace(/^[/\\]+/, '').split(/[\\/]/).filter(Boolean).join(separator)
}
const resolveFileMutationKey = async (workspaceHandle, workspaceId, relativePath, fileHandle = null) => {
  const physicalPath = fileHandle?._deskPath || workspaceFileAbsolutePath(workspaceHandle, relativePath)
  if (physicalPath) return canonicalFileMutationKey(physicalPath)
  if (fileHandle?._knoteIdentity) return canonicalFileMutationKey('', fileHandle._knoteIdentity)
  if (fileHandle?.kind === 'file' && typeof fileHandle.isSameEntry === 'function') {
    try {
      const resolved = await resolveBrowserFileIdentity(fileHandle)
      if (resolved?.id) return canonicalFileMutationKey('', resolved.id)
    } catch { /* fall back to the immutable workspace/path identity */ }
  }
  const fallbackIdentity = relativePath ? treeSnapshotIdentity(workspaceId, relativePath) : workspaceId
  return canonicalFileMutationKey('', fallbackIdentity)
}
const snapshotDocKeyForTab = (tb) => {
  if (!tb) return ''
  const isActive = tb.id === activeTabId.value
  const fileHandle = isActive ? currentFileHandle.value : tb.fileHandle
  const treePath = isActive ? activeTreePath.value : tb.treePath
  const tabFolderHandle = isActive ? folderHandle.value : tb.folderHandle
  const tabFolderWorkspaceId = isActive ? folderWorkspaceId.value : tb.folderWorkspaceId
  const fileName = isActive ? currentFileName.value : tb.fileName
  if (fileHandle && fileHandle._deskPath) return 'file:' + fileHandle._deskPath
  if (fileHandle && fileHandle._knoteIdentity) return fileHandle._knoteIdentity
  if (treePath) {
    return treeSnapshotIdentity(
      folderSnapshotIdentity(tabFolderHandle, tabFolderWorkspaceId, tb?.deskKey || ''),
      treePath
    )
  }
  if (tb.fileWorkspaceId) return tb.fileWorkspaceId
  if (fileHandle) return 'file-handle:' + opaqueHandleIdentity(fileHandle)
  if (tb && tb.deskKey && tb.deskKey.startsWith('file:')) return tb.deskKey
  if (fileName) return 'name:' + fileName
  return 'scratch:' + tb.id
}
const snapshotDocKey = () => snapshotDocKeyForTab(activeTab && activeTab())
// Agent edits belong to one concrete editor buffer, not merely to the file on
// disk. The same physical file can be opened in two tabs whose in-memory
// contents have diverged; including the tab id prevents a run or pending diff
// started in one buffer from silently landing in the other.
const agentDocumentKeyForTab = (tb) => {
  if (!tb) return ''
  return `${snapshotDocKeyForTab(tb)}::tab:${tb.id}::generation:${tb.documentGeneration || 1}`
}
const bumpAgentDocumentGeneration = (tb) => {
  if (!tb) return 0
  const previousDocumentId = agentDocumentKeyForTab(tb)
  if (pendingHunksBelongToDocument(previousDocumentId)) discardPendingHunksForDocument(previousDocumentId)
  tb.documentGeneration = Math.max(1, Number(tb.documentGeneration) || 1) + 1
  return tb.documentGeneration
}
const agentDocumentKey = () => agentDocumentKeyForTab(activeTab && activeTab())
// A folder Agent belongs to the workspace tab, even while the user navigates
// between files in that tab. Runs still freeze agentDocumentKey() separately
// for edits; this key only keeps the visible Agent surface from disappearing
// when create/delete/rename changes the active document generation.
const agentSurfaceDocumentKeyForTab = (tb) => {
  if (!tb) return ''
  const hasFolderWorkspace = tb.id === activeTabId.value ? !!folderHandle.value : !!tb.folderHandle
  return hasFolderWorkspace ? 'folder-workspace' : agentDocumentKeyForTab(tb)
}
// Stable Agent workspace identity. Folder conversations belong to the whole
// folder; the active document is only a focus inside it. Desktop tabs already
// carry path-backed deskKeys, which also prevent same-named folders/files in
// different locations from sharing one chat store.
const agentWorkspaceIdentityForTab = (tb) => {
  const isActive = !!tb && tb.id === activeTabId.value
  const tabFolderHandle = isActive ? folderHandle.value : tb?.folderHandle
  const tabFolderWorkspaceId = isActive ? folderWorkspaceId.value : tb?.folderWorkspaceId
  const tabFileHandle = isActive ? currentFileHandle.value : tb?.fileHandle
  const tabFileName = isActive ? currentFileName.value : tb?.fileName
  if (tabFolderHandle) {
    if (tb && tb.deskKey && tb.deskKey.startsWith('folder:')) return tb.deskKey
    if (tabFolderHandle._deskPath) return 'folder:' + tabFolderHandle._deskPath
    if (tabFolderHandle._knoteIdentity) return tabFolderHandle._knoteIdentity
    if (tabFolderWorkspaceId) return tabFolderWorkspaceId
    return `folder:session/${opaqueHandleIdentity(tabFolderHandle)}`
  }
  if (tb?.fileWorkspaceId) return tb.fileWorkspaceId
  if (tabFileHandle) {
    if (tabFileHandle._deskPath) return 'file:' + tabFileHandle._deskPath
    if (tabFileHandle._knoteIdentity) return tabFileHandle._knoteIdentity
    if (tb && tb.deskKey && tb.deskKey.startsWith('file:')) return tb.deskKey
    return `file:session/${opaqueHandleIdentity(tabFileHandle)}`
  }
  // Keep the long-standing default scratch chat. Scratch tabs have no stable
  // on-disk workspace identity, and keying them by an ephemeral tab id would
  // strand the user's existing default conversations after an upgrade.
  return ''
}
const agentWorkspaceIdentity = () => {
  const tb = activeTab && activeTab()
  if (folderHandle.value && !tb?.deskKey && !folderHandle.value._deskPath &&
      !folderHandle.value._knoteIdentity && !folderWorkspaceId.value) {
    return `folder:session/${opaqueHandleIdentity(folderHandle.value)}`
  }
  return agentWorkspaceIdentityForTab(tb)
}
const agentLegacyWorkspaceIds = () => {
  if (folderHandle.value && folderName.value && folderWorkspaceIdentityDurable.value) return [`folder:${folderName.value}`]
  const tb = activeTab && activeTab()
  if (tb?.fileWorkspaceIdentityDurable && currentFileName.value) return [`file:${currentFileName.value}`]
  if (currentFileHandle.value && (currentFileHandle.value._deskPath || currentFileHandle.value._knoteIdentity) && currentFileHandle.value.name) return [`file:${currentFileHandle.value.name}`]
  return []
}
const takeSnapshot = async (label = '', key = snapshotDocKey(), snapshotContent = content.value) => {
  try { return await addSnapshot(key, snapshotContent, Date.now(), label) } catch (err) {
    console.error('History write error:', err)
    return null
  }
}
const historyPanel = ref({ open: false, items: [], previewIndex: -1, previewContent: '', loadToken: 0 })
let historyRequestGeneration = 0
const openHistory = async () => {
  cancelSessionRestoreForForegroundIntent()
  commitActiveBlockIfAny()
  const request = ++historyRequestGeneration
  const targetTab = activeTab()
  const targetTabId = activeTabId.value
  const key = snapshotDocKey()
  const targetEditRevision = documentEditRevision(key)
  const targetSwitchGeneration = tabSwitchGeneration
  const targetLoadGeneration = documentLoadGeneration
  const stillCurrent = () => request === historyRequestGeneration &&
    activeTab() === targetTab && activeTabId.value === targetTabId &&
    snapshotDocKey() === key && documentEditRevision(key) === targetEditRevision &&
    tabSwitchGeneration === targetSwitchGeneration && documentLoadGeneration === targetLoadGeneration
  try {
    await takeSnapshot('current', key, content.value) // capture the live state so it's in the list
    if (!stillCurrent()) return
    const items = await listSnapshots(key)
    if (!stillCurrent()) return
    historyPanel.value = { open: true, items, previewIndex: -1, previewContent: '', key, loadToken: 0 }
  } catch (error) {
    console.error('History list error:', error)
    if (stillCurrent()) notify(lang.value === 'zh' ? '历史记录暂时不可用，请关闭其他 Knote 窗口后重试' : 'History is unavailable; close other Knote windows and retry')
  }
}
const closeHistory = () => {
  historyRequestGeneration += 1
  historyPanel.value.open = false
}
const historyPreview = computed(() => {
  const h = historyPanel.value
  return h.open && h.previewIndex >= 0 ? h.previewContent : ''
})
const selectHistorySnapshot = async (index) => {
  const h = historyPanel.value
  const item = h.items[index]
  if (!item) return
  const targetTab = activeTab()
  const targetTabId = activeTabId.value
  const targetKey = h.key
  const targetEditRevision = documentEditRevision(targetKey)
  const targetSwitchGeneration = tabSwitchGeneration
  const targetLoadGeneration = documentLoadGeneration
  const token = (h.loadToken || 0) + 1
  h.loadToken = token
  h.previewIndex = index
  h.previewContent = ''
  let md = null
  try { md = await getSnapshot(h.key, item.id) } catch (error) { console.error('History preview error:', error) }
  if (
    historyPanel.value === h && h.open && h.loadToken === token && h.key === targetKey &&
    activeTab() === targetTab && activeTabId.value === targetTabId && snapshotDocKey() === targetKey &&
    documentEditRevision(targetKey) === targetEditRevision &&
    tabSwitchGeneration === targetSwitchGeneration && documentLoadGeneration === targetLoadGeneration
  ) h.previewContent = md || ''
}
const restoreSnapshot = async (item) => {
  cancelSessionRestoreForForegroundIntent()
  const panel = historyPanel.value
  if (!panel.open || !item) return
  const request = ++historyRequestGeneration
  const targetTab = activeTab()
  const targetTabId = activeTabId.value
  const targetKey = panel.key
  const targetEditRevision = documentEditRevision(targetKey)
  const targetSwitchGeneration = tabSwitchGeneration
  const targetLoadGeneration = documentLoadGeneration
  const stillCurrent = () => request === historyRequestGeneration &&
    historyPanel.value === panel && panel.open && panel.key === targetKey &&
    activeTab() === targetTab && activeTabId.value === targetTabId && snapshotDocKey() === targetKey &&
    documentEditRevision(targetKey) === targetEditRevision &&
    tabSwitchGeneration === targetSwitchGeneration && documentLoadGeneration === targetLoadGeneration
  let md = null
  try { md = await getSnapshot(targetKey, item.id) } catch (error) {
    console.error('History restore read error:', error)
    if (stillCurrent()) notify(lang.value === 'zh' ? '无法读取该历史版本' : 'Could not read that history version')
    return
  }
  if (md == null || !stillCurrent()) return
  const protectedCurrent = await takeSnapshot('before history restore', targetKey, content.value)
  if (protectedCurrent == null || !stillCurrent()) {
    if (protectedCurrent == null && stillCurrent()) {
      notify(lang.value === 'zh' ? '当前版本未能安全写入历史，已取消恢复' : 'The current version could not be protected; restore was cancelled')
    }
    return
  }
  // Cancel only the not-yet-started save of the pre-restore text. An already
  // running save remains serialized ahead of the new restored-content save.
  cancelAutoSave()
  resetEditingState()
  const nextContent = importMarkdown(md)
  const editorLoad = stageLargeEditorLoad(nextContent)
  content.value = nextContent
  if (!editorLoad.plain && !editorLoad.staged && viewMode.value === 'single' && richEditorRef.value) {
    richEditorRef.value.applyExternal(richMarkdown.value)
  }
  void releaseLargeEditorLoad(editorLoad)
  closeHistory()
  notify(t('history_restored'))
}
const fmtSnapTime = (t2) => {
  try {
    const d = new Date(t2)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    const hm = d.toLocaleTimeString(lang.value === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })
    return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
  } catch { return '' }
}

// Commit any in-progress block edit so saves never miss the latest keystrokes
const commitActiveBlockIfAny = () => {
  // the rich editor's markdown mirror is debounced — force it current
  if (richEditorRef.value && richEditorRef.value.flushEmit) richEditorRef.value.flushEmit()
  if (largeRichEditorRef.value && largeRichEditorRef.value.flushEmit) largeRichEditorRef.value.flushEmit()
  commitLargeSourceDraft('editor-boundary')
  if (viewMode.value === 'single' && activeBlockId.value) {
    const block = parsedBlocks.value.find(b => b.id === activeBlockId.value)
    if (block) commitBlockEdit(block)
  }
}

const saveEditsMadeDuringFirstSave = async (handle, initiallySavedContent, targetTab = activeTab()) => {
  if (activeTab() !== targetTab || currentFileHandle.value !== handle) return false
  commitActiveBlockIfAny()
  if (activeTab() !== targetTab || currentFileHandle.value !== handle) return false
  if (content.value === initiallySavedContent) return true
  const key = snapshotDocKey()
  const revision = markDocumentEdited(key)
  return await saveToFileHandle(handle, {
    markdown: exportableMarkdown(content.value),
    snapshotContent: content.value,
    snapshotKey: key,
    revision
  })
}

const saveFile = async () => {
  commitActiveBlockIfAny()
  if (isLocalFile.value && currentFileHandle.value) {
    // Direct save to local file
    await saveToFileHandle(currentFileHandle.value)
  } else {
    // First save: prompt user to pick location
    const targetTab = activeTab()
    const sourceIdentity = snapshotDocKey()
    const androidIntent = isAndroidNative ? beginAndroidStorageIntent() : 0
    const stillCurrent = () => activeTab() === targetTab && snapshotDocKey() === sourceIdentity &&
      (!isAndroidNative || androidIntent === androidStorageIntentGeneration)
    try {
      if (window.knoteDesktop && window.knoteDesktop.pickSave) {
        const picked = await window.knoteDesktop.pickSave(`knote-${localDateStamp()}.md`)
        if (!picked || !picked.ok || !stillCurrent()) return
        const handle = mkDesktopHandle(picked.path, picked.name)
        const payload = {
          markdown: exportableMarkdown(content.value),
          snapshotContent: content.value,
          snapshotKey: `file:${picked.path}`
        }
        if (!await saveToFileHandle(handle, payload)) return
        if (!stillCurrent()) return
        bumpAgentDocumentGeneration(activeTab && activeTab())
        currentFileHandle.value = handle
        currentFileName.value = picked.name
        isLocalFile.value = true
        const tb = activeTab()
        if (tb) {
          tb.deskKey = `file:${picked.path}`
          setTabFileWorkspaceIdentity(tb)
        }
        await saveEditsMadeDuringFirstSave(handle, payload.snapshotContent)
      } else if (isAndroidNative) {
        const handle = await createSafDocument(`knote-${localDateStamp()}.md`, 'text/markdown')
        if (!stillCurrent()) {
          await releaseSafGrant(handle._knoteSafGrantId).catch(() => {})
          return
        }
        const payload = {
          markdown: exportableMarkdown(content.value),
          snapshotContent: content.value,
          snapshotKey: handle._knoteIdentity,
          revision: documentRevisionForSave(handle._knoteIdentity)
        }
        if (!await saveToFileHandle(handle, payload)) {
          if (!uncertainSaveHandles.has(handle)) await releaseSafGrant(handle._knoteSafGrantId).catch(() => {})
          return
        }
        if (!stillCurrent()) {
          await releaseSafGrant(handle._knoteSafGrantId).catch(() => {})
          return
        }
        bumpAgentDocumentGeneration(activeTab && activeTab())
        currentFileHandle.value = handle
        currentFileName.value = handle.name
        isLocalFile.value = true
        const tb = activeTab()
        setTabFileWorkspaceIdentity(tb, handle._knoteIdentity, true)
        await rememberAndroidStorage('saf', handle)
        await saveEditsMadeDuringFirstSave(handle, payload.snapshotContent)
      } else if (globalThis.showSaveFilePicker) {
        const handle = await globalThis.showSaveFilePicker({
          suggestedName: `knote-${localDateStamp()}.md`,
          types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }]
        })
        if (!stillCurrent()) return
        const resolved = !handle?._deskPath && !handle?._knoteIdentity && typeof handle?.isSameEntry === 'function'
          ? await resolveBrowserFileIdentity(handle)
          : { id: '', durable: false }
        if (!stillCurrent()) return
        const payload = {
          markdown: exportableMarkdown(content.value),
          snapshotContent: content.value,
          snapshotKey: resolved.id || `file-handle:${opaqueHandleIdentity(handle)}`
        }
        if (!await saveToFileHandle(handle, payload) || !stillCurrent()) return
        bumpAgentDocumentGeneration(activeTab && activeTab())
        currentFileHandle.value = handle
        const file = await handle.getFile()
        currentFileName.value = file.name
        isLocalFile.value = true
        const tb = activeTab()
        setTabFileWorkspaceIdentity(tb, resolved.id, resolved.durable)
        await saveEditsMadeDuringFirstSave(handle, payload.snapshotContent)
      } else {
        // Fallback: blob download
        downloadMarkdown()
      }
    } catch (err) {
      if (err.name !== 'AbortError') console.error('Save file error:', err)
    }
  }
}

// Auto-save watcher: debounce writes to local file
let autoSaveDirty = false
let autoSaveJob = null
// tab switches swap `content` wholesale — that's navigation, not an edit:
// no undo snapshot, no autosave marking
// A monotonic owner token makes the navigation-install guard race-safe. A
// stale nextTick may neither clear a newer install nor leave the guard stuck
// forever merely because its original navigation intent was invalidated.
let navigationInstallSequence = 0
let navigationInstallOwner = 0
const beginNavigationInstall = () => {
  const owner = ++navigationInstallSequence
  navigationInstallOwner = owner
  return owner
}
const finishNavigationInstall = (owner) => {
  if (navigationInstallOwner === owner) navigationInstallOwner = 0
}
watch(() => content.value, () => {
  if (navigationInstallOwner) return
  const editIdentity = snapshotDocKey()
  const editRevision = markDocumentEdited(editIdentity)
  // Track undo (skipped during undo/redo transitions)
  // ProseMirror already owns single-mode history. Mirroring another 50 full
  // Markdown snapshots here multiplied long-document memory for no benefit.
  if (viewMode.value !== 'single' || largeDocumentPlainMode.value) scheduleUndoSnapshot()

  // Auto-save to local file. Undo/redo results must also reach the disk —
  // otherwise the file keeps the undone content forever.
  if (isLocalFile.value && currentFileHandle.value) {
    // Freeze the handle, markdown and history key together. The timeout must
    // never consult live refs because navigation may replace them first.
    const job = {
      handle: currentFileHandle.value,
      payload: {
        markdown: exportableMarkdown(content.value),
        snapshotContent: content.value,
        snapshotKey: editIdentity,
        revision: editRevision
      }
    }
    autoSaveJob = job
    autoSaveDirty = true
    clearTimeout(autoSaveTimer)
    autoSaveTimer = setTimeout(() => {
      if (autoSaveJob !== job) return
      autoSaveDirty = false
      autoSaveJob = null
      saveToFileHandle(job.handle, job.payload)
    }, 1000)
  }
}, { flush: 'sync' })

// Moving the caret to another row is a natural commit point: flush the
// pending auto-save immediately instead of waiting out the debounce
const flushAutoSave = () => {
  const job = autoSaveJob
  if (!autoSaveDirty || !job) return Promise.resolve()
  clearTimeout(autoSaveTimer)
  autoSaveDirty = false
  autoSaveJob = null
  return saveToFileHandle(job.handle, job.payload)
}

const cancelAutoSave = () => {
  clearTimeout(autoSaveTimer)
  autoSaveDirty = false
  autoSaveJob = null
}

// ========== External-change watcher ==========
// Another program (editor, sync client, script) may rewrite the currently
// open md while Knote displays it. Poll the backing file: when the on-disk
// text stops matching the editor's markdown, reload it and tell the user.
// Comparison runs in importMarkdown-normalized space, so Knote's own saves
// (exportable → disk → import roundtrips to the same string) never trigger
// a reload; mtime gates the read so unchanged polls cost one stat.
let diskWatchMtime = 0
let diskWatchRaw = null // raw disk text at last reconcile — skips re-parsing mtime-only touches
let diskWatchGen = 0 // bumped on file switch — invalidates in-flight polls
let safDiskWatchAt = 0
watch(currentFileHandle, () => { diskWatchGen++; diskWatchMtime = 0; diskWatchRaw = null; safDiskWatchAt = 0 })
const readCurrentDiskText = async (handle) => {
  const p = handle._deskPath
  const nd = window.knoteDesktop
  if (p && nd && nd.fsStat) {
    const st = await nd.fsStat(p)
    if (!st || !st.ok) return null // deleted / no access — nothing to compare
    if (diskWatchMtime && st.mtimeMs === diskWatchMtime) return { unchanged: true }
    return { raw: String(await nd.fsRead(p)), mtimeMs: st.mtimeMs }
  }
  // browser FSA handle: File.lastModified is cheap metadata; read the text
  // only when it moved (0 = engine didn't provide it → always compare)
  const f = await handle.getFile()
  const lm = f.lastModified || 0
  if (diskWatchMtime && lm && lm === diskWatchMtime) return { unchanged: true }
  return { raw: String(await f.text()), mtimeMs: lm }
}
let diskWatchTimer = setInterval(async () => {
  if (document.hidden) return // minimized/backgrounded: catch up on next visible poll
  if (!isLocalFile.value || !currentFileHandle.value) return
  if (String(currentFileHandle.value._knoteIdentity || '').startsWith('android-saf:')) {
    const now = Date.now()
    if (now - safDiskWatchAt < 30_000) return
    safDiskWatchAt = now
  }
  const watchedIdentity = snapshotDocKey()
  if (autoSaveDirty || isSaving.value || documentIsAheadOfDisk(watchedIdentity)) return // Knote is ahead of / writing the disk
  const gen = diskWatchGen
  const handle = currentFileHandle.value
  let st = null
  try {
    st = await readCurrentDiskText(handle)
  } catch (error) {
    if (error?.code === 'ENTRY_CHANGED' && String(handle?._knoteIdentity || '').startsWith('android-saf:')) {
      staleSafFileHandles.add(handle)
      const protectedDraft = await takeSnapshot('before external replacement', watchedIdentity, content.value)
      if (gen !== diskWatchGen || handle !== currentFileHandle.value) return
      isLocalFile.value = false
      try { await refreshFolder() } catch { /* retain the editor buffer and stale tree */ }
      notify(protectedDraft == null
        ? (lang.value === 'zh'
            ? '文件条目已被外部替换，当前内容无法写入历史；已停止自动保存'
            : 'The file entry was externally replaced and recovery history failed; auto-save was stopped.')
        : (lang.value === 'zh'
            ? '文件条目已被外部替换，已停止自动保存；请在文件树中重新打开'
            : 'The file entry was externally replaced. Auto-save was stopped; reopen it from the file tree.'))
    }
    return
  }
  if (!st || st.unchanged) return
  if (gen !== diskWatchGen || handle !== currentFileHandle.value) return // switched mid-read
  diskWatchMtime = st.mtimeMs
  if (autoSaveDirty || isSaving.value || documentIsAheadOfDisk(watchedIdentity)) return // user started typing during the read
  if (st.raw === diskWatchRaw) return // mtime-only touch (sync clients love these)
  diskWatchRaw = st.raw
  const fresh = importMarkdown(st.raw)
  if (fresh === content.value) return // our own save landing (or a no-op rewrite)
  // External update wins (same policy as the file-association reconcile):
  // replace the document wholesale and drop undo history. restoringTab
  // suppresses the content watcher — the disk IS the source here, so no
  // undo snapshot and, crucially, no echo auto-save rewriting the file the
  // user just saved elsewhere. try/finally: an editor-sync throw must never
  // leave restoringTab stuck true (that would disable auto-save for good).
  const historyKey = snapshotDocKey()
  const previousContent = content.value
  const protectedPrevious = await takeSnapshot('before external update', historyKey, previousContent)
  if (protectedPrevious == null) {
    // The external bytes remain on disk, but editor memory is the only copy of
    // the previous version. Retry the comparison next poll instead of losing it.
    if (gen === diskWatchGen && handle === currentFileHandle.value) {
      diskWatchMtime = 0
      diskWatchRaw = null
      notify(lang.value === 'zh'
        ? '当前内容未能写入历史，已暂缓载入外部修改'
        : 'The current version could not be protected; the external update was deferred')
    }
    return
  }
  if (gen !== diskWatchGen || handle !== currentFileHandle.value) return
  const navigationOwner = beginNavigationInstall()
  try {
    resetEditingState()
    cancelAutoSave()
    const editorLoad = stageLargeEditorLoad(fresh)
    content.value = fresh
    void takeSnapshot('external update', historyKey, fresh)
    undoStack.value = []
    redoStack.value = []
    lastSavedSnapshot = { content: fresh, selection: null }
    markDocumentDiskBaseline(historyKey)
    if (!editorLoad.plain && !editorLoad.staged && viewMode.value === 'single' && richEditorRef.value) {
      richEditorRef.value.applyExternal(richMarkdown.value)
    }
    void releaseLargeEditorLoad(editorLoad)
    // the new text may reference on-disk images that were never in the doc
    const dir = docDir.value || folderHandle.value
    if (dir) loadRelativeImages(dir)
  } catch (err) {
    console.error('External reload error:', err)
  } finally {
    nextTick(() => { finishNavigationInstall(navigationOwner) })
  }
  notify(t('external_reload'))
}, 2000)

// ========== Folder tree (File System Access API) ==========
const folderHandle = shallowRef(null)
const folderName = ref('')
const folderWorkspaceId = ref('')
const folderWorkspaceIdentityDurable = ref(false)
const folderTree = ref([])
const expandedDirs = ref(new Set())
const activeTreePath = ref('')
let documentLoadGeneration = 0
let e2eInvalidateNextTreeInstall = false
if (window.knoteDesktop?.isE2E && window.__knoteDebug?.folder) {
  // Deterministically invalidates an intent after its document has been
  // installed but before its nextTick cleanup. This exercises the exact race
  // that used to leave the global boolean guard stuck and disable auto-save.
  window.__knoteDebug.folder.armNavigationInstallRace = () => {
    e2eInvalidateNextTreeInstall = true
  }
}

const buildFolderTree = async (dirHandle, path = '', depth = 0, traversal = null) => {
  const report = traversal || {
    complete: true,
    depthLimit: 12,
    omittedPaths: [],
    remaining: 10_000,
    deadline: Date.now() + 12_000,
    stillCurrent: () => true
  }
  if (!report.stillCurrent()) {
    const error = new Error('Folder traversal was superseded')
    error.name = 'AbortError'
    throw error
  }
  if (depth > report.depthLimit) {
    report.complete = false
    report.omittedPaths.push(path.replace(/^\//, '') || '.')
    return []
  }
  const dirs = []
  const files = []
  for await (const [name, handle] of dirHandle.entries()) {
    if (!report.stillCurrent()) {
      const error = new Error('Folder traversal was superseded')
      error.name = 'AbortError'
      throw error
    }
    if (report.remaining-- <= 0 || Date.now() > report.deadline) {
      report.complete = false
      report.omittedPaths.push(path.replace(/^\//, '') || '.')
      break
    }
    if (handle.kind === 'directory') {
      // Generated/vendor trees drown the useful workspace manifest and can
      // contain tens of thousands of files; source folders (including our
      // installer's `build/`) remain visible.
      if (['.git', '.svn', '.hg', '.cache', '.next', '.nuxt', 'node_modules', 'dist', 'release', 'coverage'].includes(name)) continue
      const children = await buildFolderTree(handle, `${path}/${name}`, depth + 1, report)
      // show ALL directories (incl. empty ones) so the folder structure is
      // browsable and user-created folders appear immediately. The handle +
      // parent enable new-file/new-folder/rename/delete on the node.
      dirs.push({ name, kind: 'dir', handle, parent: dirHandle, path: `${path}/${name}`, children })
    } else {
      // markdown is editable; docx/pptx/xlsx/txt/csv... are read-only previewable
      // assets the agent can read via read_file / read_workspace_doc
      const ft = /\.(md|markdown)$/i.test(name) ? 'md'
        : /\.pdf$/i.test(name) ? 'pdf'
          : /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(name) ? 'image'
            : /\.docx$/i.test(name) ? 'docx'
              : /\.pptx$/i.test(name) ? 'pptx'
                : /\.xlsx$/i.test(name) ? 'xlsx'
                  : /\.odt$/i.test(name) ? 'odt'
                    : /\.ods$/i.test(name) ? 'ods'
                      : /\.odp$/i.test(name) ? 'odp'
                        : /\.txt$/i.test(name) ? 'txt'
                          : /\.csv$/i.test(name) ? 'csv'
                            : /\.rtf$/i.test(name) ? 'rtf'
                              : detectFtype(name) === 'code' ? 'code'
                                : null
      // parent handle enables rename (move/copy+delete) later
      if (ft) files.push({ name, kind: 'file', ftype: ft, handle, parent: dirHandle, path: `${path}/${name}` })
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name)
  const tree = [...dirs.sort(byName), ...files.sort(byName)]
  if (depth === 0) Object.defineProperty(tree, '_agentTraversal', { value: Object.freeze({
    complete: report.complete,
    depthLimit: report.depthLimit,
    omittedPaths: Object.freeze([...report.omittedPaths])
  }), enumerable: false })
  return tree
}

// Adopt a folder handle (picker / native adapter / desktop icon-drop /
// window drag-drop) as the workspace of a NEW folder tab. `deskKey`
// identifies desktop-path folders so re-opening one activates its existing
// tab instead of duplicating it.
// Desktop dedup keys are `file:`/`folder:` + an OS path. Windows hands us the
// same path with inconsistent casing / slash direction (file association vs
// drag-drop vs argv), so a raw === would miss the already-open tab and reopen
// the file into the current tab instead of switching to it. Compare normalized.
const sameDeskKey = (a, b) => !!a && !!b &&
  String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase()

const adoptFolderHandle = async (handle, name, deskKey = '', stillCurrent = () => true) => {
  if (!stillCurrent()) return false
  if (deskKey) {
    const existing = tabs.value.find((tb) => sameDeskKey(tb.deskKey, deskKey))
    if (existing) {
      if (existing.id !== activeTabId.value && !await switchTab(existing.id)) return false
      return stillCurrent()
    }
  }
  let workspaceIdentity = ''
  let workspaceIdentityDurable = false
  if (!deskKey && !handle?._deskPath && !handle?._knoteIdentity && typeof handle?.isSameEntry === 'function') {
    const resolved = await resolveBrowserWorkspaceIdentity(handle)
    if (!stillCurrent()) return false
    workspaceIdentity = resolved.id
    workspaceIdentityDurable = resolved.durable
    const existing = tabs.value.find((tb) => (
      tb.id === activeTabId.value ? folderWorkspaceId.value === workspaceIdentity : tb.folderWorkspaceId === workspaceIdentity
    ))
    if (existing) {
      if (existing.id !== activeTabId.value && !await switchTab(existing.id)) return false
      return stillCurrent()
    }
  }
  const tree = await buildFolderTree(handle, '', 0, {
    complete: true,
    depthLimit: 12,
    omittedPaths: [],
    remaining: 10_000,
    deadline: Date.now() + 12_000,
    stillCurrent
  })
  // Folder enumeration yields many times. A newer file/folder open may have
  // become authoritative while it was running; never publish this stale tree.
  if (!stillCurrent()) return false
  documentLoadGeneration += 1
  openInNewTab()
  bumpAgentDocumentGeneration(activeTab && activeTab())
  // Desktop opens the folder in a fresh tab (restoreTab resets per-file state).
  // The browser has no tab strip, so openInNewTab() is a no-op and the folder
  // opens IN PLACE — clear the previous file's live state first, or its content
  // + writable handle would leak into the new workspace (auto-save could even
  // write it back) and the "pick a file" placeholder would never show.
  resetEditingState()
  clearRelImages()
  currentFileHandle.value = null
  isLocalFile.value = false
  currentFileName.value = ''
  replaceWholeDocumentContent('')
  undoStack.value = []
  redoStack.value = []
  lastSavedSnapshot = { content: '', selection: null }
  relImagesNeedGrant.value = false
  docDir.value = null // no file open yet; set when a tree file is opened
  folderName.value = name || handle.name
  folderWorkspaceId.value = workspaceIdentity
  folderWorkspaceIdentityDurable.value = !!(deskKey || handle?._deskPath || handle?._knoteIdentity || workspaceIdentityDurable)
  folderHandle.value = handle
  folderTree.value = tree
  expandedDirs.value = new Set()
  activeTreePath.value = ''
  activeDirPath.value = ''
  outlineVisible.value = true
  const tb = activeTab()
  if (tb) {
    if (deskKey) tb.deskKey = deskKey
    setTabFileWorkspaceIdentity(tb)
    tb.folderWorkspaceId = workspaceIdentity
    tb.folderWorkspaceIdentityDurable = folderWorkspaceIdentityDurable.value
  }
  return true
}

const openFolder = async () => {
  cancelSessionRestoreForForegroundIntent()
  const androidIntent = isAndroidNative ? beginAndroidStorageIntent() : 0
  const androidIntentIsCurrent = () => !isAndroidNative || androidIntent === androidStorageIntentGeneration
  if (isAndroidNative) {
    if (!await prepareAndroidStorageReplacement() || !androidIntentIsCurrent()) return
  }
  let pendingAndroidGrantId = ''
  try {
    // desktop: same native-dialog route as openLocalFile (recents included)
    if (isDesktopShell && window.knoteDesktop.pickOpen) {
      await window.knoteDesktop.pickOpen('folder')
      return
    }
    if (isAndroidNative) {
      const handle = await pickSafTree()
      pendingAndroidGrantId = handle._knoteSafGrantId
      if (!androidIntentIsCurrent()) return
      if (await adoptFolderHandle(handle, handle.name, '', androidIntentIsCurrent)) {
        if (!androidIntentIsCurrent()) return
        await rememberAndroidStorage('saf', handle)
        pendingAndroidGrantId = ''
        mobileFilesOpen.value = false
      } else {
        await releaseSafGrant(handle._knoteSafGrantId).catch(() => {})
        pendingAndroidGrantId = ''
      }
      return
    }
    if (!globalThis.showDirectoryPicker) {
      globalThis.alert(t('folder_unsupported'))
      return
    }
    // readwrite so files opened from the tree can be auto-saved back
    const handle = await globalThis.showDirectoryPicker({ mode: 'readwrite' })
    await adoptFolderHandle(handle, handle.name)
  } catch (err) {
    if (err.name !== 'AbortError') console.error('Open folder error:', err)
  } finally {
    if (pendingAndroidGrantId) await releaseSafGrant(pendingAndroidGrantId).catch(() => {})
  }
}

// The directory new files/folders are created into by the HEADER buttons:
// the last dir the user clicked, or the parent dir of the file they opened.
// '' = workspace root. Resolved to a live node at create time (the dir may
// have been deleted/moved since).
const activeDirPath = ref('')
const resolveDirNode = (path) => {
  if (!path) return null
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.kind !== 'dir') continue
      if (n.path === path) return n
      const hit = walk(n.children || [])
      if (hit) return hit
    }
    return null
  }
  return walk(folderTree.value)
}
const activeDirNode = () => resolveDirNode(activeDirPath.value)
const createState = ref(null) // { kind, targetPath } for header create actions
const createDialogRef = ref(null)
let createOpener = null
const createDestinations = computed(() => {
  const out = [{ label: `${folderName.value}/`, path: '', depth: 0 }]
  const walk = (nodes, depth) => {
    for (const node of nodes || []) {
      if (node.kind !== 'dir') continue
      out.push({ label: node.path.replace(/^\//, '') + '/', path: node.path, depth })
      walk(node.children, depth + 1)
    }
  }
  walk(folderTree.value, 1)
  return out
})
const openCreateTarget = (kind, event) => {
  if (!folderHandle.value) return
  createOpener = event?.currentTarget || null
  createState.value = { kind, targetPath: resolveDirNode(activeDirPath.value) ? activeDirPath.value : '' }
  nextTick(() => {
    createDialogRef.value?.querySelector('[aria-checked="true"]')?.focus() || createDialogRef.value?.focus()
  })
}
const closeCreateTarget = () => {
  createState.value = null
  nextTick(() => createOpener?.focus())
  createOpener = null
}
const confirmCreateTarget = async () => {
  const state = createState.value
  if (!state) return
  const target = state.targetPath ? resolveDirNode(state.targetPath) : null
  if (state.targetPath && !target) {
    closeCreateTarget()
    globalThis.alert(lang.value === 'zh' ? '目标文件夹已不存在，请重新选择。' : 'The destination folder no longer exists. Choose again.')
    return
  }
  createState.value = null
  createOpener = null
  if (state.kind === 'folder') await createFolder(target)
  else await createMdFile(target)
}

const toggleDir = (path) => {
  const s = new Set(expandedDirs.value)
  if (s.has(path)) s.delete(path)
  else s.add(path)
  expandedDirs.value = s
  // clicking a folder makes it the target for "new file/folder" (header
  // buttons); collapsing it steps the target back to its parent
  activeDirPath.value = s.has(path) ? path : path.replace(/\/[^/]*$/, '')
}

// Flatten the tree respecting expanded state (recursive templates avoided)
const flatFolderTree = computed(() => {
  const rows = []
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      rows.push({ node: n, depth })
      if (n.kind === 'dir' && expandedDirs.value.has(n.path)) walk(n.children, depth + 1)
    }
  }
  walk(folderTree.value, 0)
  return rows
})

const refreshFolder = async () => {
  const handle = folderHandle.value
  if (!handle) return
  try {
    const tree = await buildFolderTree(handle)
    // A scan can outlive a tab switch. Never let workspace A's late result
    // overwrite workspace B's visible manifest.
    if (folderHandle.value === handle) folderTree.value = tree
  } catch (err) {
    console.error('Refresh folder error:', err)
  }
}

// ---- Folder-wide full-text search ----
const folderSearchQuery = ref('')
const folderSearchResults = ref([])
const folderSearching = ref(false)
let folderSearchTimer = null
let folderSearchToken = 0
const runFolderSearch = async () => {
  const q = folderSearchQuery.value.trim()
  const token = ++folderSearchToken
  folderSearchResults.value = []
  if (!q || !folderHandle.value) { folderSearching.value = false; return }
  folderSearching.value = true
  const files = walkTreeFiles(folderTree.value, [])
  const lower = q.toLowerCase()
  const results = []
  let total = 0
  for (const n of files) {
    if (token !== folderSearchToken) return // superseded by a newer query
    if (total > 300) break
    if (n.ftype && n.ftype !== 'md') continue // never grep binary pdf/image bytes
    let text
    try { text = await (await n.handle.getFile()).text() } catch { continue }
    const lines = text.split('\n')
    const hits = []
    for (let i = 0; i < lines.length && hits.length < 25; i++) {
      const idx = lines[i].toLowerCase().indexOf(lower)
      if (idx >= 0) {
        const raw = lines[i].trim()
        hits.push({ line: i + 1, text: raw.length > 140 ? raw.slice(0, 140) + '…' : raw })
        total++
      }
    }
    if (hits.length) results.push({ node: n, name: n.name, path: n.path.replace(/^\//, ''), hits })
  }
  if (token !== folderSearchToken) return
  folderSearchResults.value = results
  folderSearching.value = false
}
watch(folderSearchQuery, () => {
  clearTimeout(folderSearchTimer)
  folderSearchTimer = setTimeout(runFolderSearch, 260)
})
const folderSearchHitCount = computed(() => folderSearchResults.value.reduce((s, r) => s + r.hits.length, 0))
const openSearchResult = async (node, line) => {
  const opened = await openTreeFile(node)
  if (!opened) return
  if (isAndroidCompact.value) mobileFilesOpen.value = false
  const openedGeneration = documentLoadGeneration
  // let the doc render, then jump to the line (proportional scroll)
  nextTick(() => setTimeout(() => {
    if (openedGeneration === documentLoadGeneration && agentBridge.scrollToLine) {
      agentBridge.scrollToLine(line)
    }
  }, 320))
}

// In-app text prompt (window.prompt is unsupported in the Electron shell —
// it returns null there, which broke new-file / rename). Returns the trimmed
// input, or null if cancelled.
const promptState = ref(null) // active queued request, or null
const promptInputRef = ref(null)
const promptAcceptRef = ref(null)
const focusPromptRequest = (request) => {
  if (!request) return
  nextTick(() => {
    if (request.mode !== 'prompt') {
      promptAcceptRef.value?.focus()
      return
    }
    if (promptInputRef.value) {
      promptInputRef.value.focus()
      promptInputRef.value.select()
    }
  })
}
const appDialogQueue = createAppDialogQueue({
  onActivate: (request) => {
    promptState.value = request
    focusPromptRequest(request)
  }
})
const promptInput = (title, defaultValue = '', options = {}) => appDialogQueue.request({
  title,
  value: defaultValue,
  mode: 'prompt',
  owner: options.owner,
  signal: options.signal
})
const resolvePrompt = (accepted) => {
  const p = promptState.value
  if (!p) return
  if (p.mode === 'confirm') {
    appDialogQueue.settle(p.id, accepted === true)
    return
  }
  if (p.mode === 'alert') {
    appDialogQueue.settle(p.id, accepted !== false)
    return
  }
  const val = accepted ? String(p.value || '').trim() : null
  appDialogQueue.settle(p.id, val || null)
}

// yes/no variant of the same dialog (no input row)
const confirmDialog = (title, options = {}) => appDialogQueue.request({
  title,
  mode: 'confirm',
  owner: options.owner,
  signal: options.signal
}).then((value) => value === true)
const requestAgentAppDialog = (options = {}) => appDialogQueue.request({
  mode: options.mode === 'alert' ? 'alert' : 'confirm',
  owner: options.owner,
  title: options.title,
  message: options.message,
  tone: options.tone,
  signal: options.signal
}).then((value) => value === true)
const capabilityErrorDetail = (error) => {
  if (!error) return ''
  if (typeof error === 'object') return String(error.detail || error.message || error.type || '')
  return String(error)
}
const showAgentCapabilityDialog = (result = {}) => {
  const tone = classifyAgentCapabilities(result)
  const capabilityLabels = {
    chat: t('agent_cap_chat'),
    tools: t('agent_cap_tools'),
    vision: t('agent_cap_image'),
    pdf: t('agent_cap_pdf')
  }
  const list = (supported) => AGENT_CAPABILITY_KEYS
    .filter((key) => (result[key] === true) === supported)
    .map((key) => capabilityLabels[key])
    .join(lang.value === 'zh' ? '、' : ', ') || t('agent_cap_result_none')
  const title = t(`agent_cap_result_${tone}_title`)
  let message = tone === 'success'
    ? tf('agent_cap_result_success', { supported: list(true) })
    : tone === 'partial'
      ? tf('agent_cap_result_partial', { supported: list(true), unsupported: list(false) })
      : t('agent_cap_result_failure')
  const detail = capabilityErrorDetail(result.error)
  if (detail) message += `\n${tf('agent_cap_result_detail', { detail })}`
  return appDialogQueue.request({
    mode: 'alert',
    owner: 'agent-capability-result',
    tone,
    title,
    message
  })
}
const cancelAllDialogs = () => appDialogQueue.cancelAll()

// ---- Shared context menu (right-click) ----
// One renderer for every zone: the editor emits its items, the file tree
// builds its own. Items: { label, action, danger?, disabled? } | { divider }
const ctxMenu = ref(null) // { x, y, items, target }
const openCtxMenu = (x, y, items, target = '') => {
  const rows = items.filter((i) => !i.divider).length
  const dividers = items.length - rows
  const estH = rows * 32 + dividers * 9 + 12
  const estW = 208
  ctxMenu.value = {
    x: Math.min(x, window.innerWidth - estW - 8),
    y: Math.min(y, window.innerHeight - estH - 8),
    items,
    target: String(target || '')
  }
}
const closeCtxMenu = () => { ctxMenu.value = null }
const runCtxItem = (item) => {
  closeCtxMenu()
  try { item.action && item.action() } catch (err) { console.error('ctx action error:', err) }
}
window.addEventListener('mousedown', (e) => {
  if (ctxMenu.value && !(e.target.closest && e.target.closest('.knote-ctxmenu'))) closeCtxMenu()
})
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu() })
window.addEventListener('blur', closeCtxMenu)
document.addEventListener('scroll', closeCtxMenu, true)

// file-tree right-click
// "用文件夹打开" = open the node in the OS file manager (Windows Explorer):
// a file is revealed+selected in its folder, a directory opens directly.
// Only possible for path-backed nodes (desktop icon-drop / file association /
// session restore) — a browser FSA handle has no OS path, so the menu entry
// is hidden there.
// the node's own handle carries a path for desktop-adapter trees; when it
// doesn't (edge cases), derive one from the workspace ROOT's path + the
// node's workspace-relative path
const nodeDeskPath = (node) => {
  if (node.handle && node.handle._deskPath) return node.handle._deskPath
  const root = folderHandle.value && folderHandle.value._deskPath
  if (root && node.path) {
    const sep = root.includes('\\') ? '\\' : '/'
    // node.path is '/'-prefixed — strip it or the join doubles the separator
    return root.replace(/[\\/]$/, '') + sep + node.path.replace(/^\/+/, '').split('/').join(sep)
  }
  return null
}
const canRevealNode = (node) => !!(window.knoteDesktop && window.knoteDesktop.reveal && nodeDeskPath(node))
const revealNodeInExplorer = async (node) => {
  try {
    await window.knoteDesktop.reveal(nodeDeskPath(node))
  } catch (err) {
    console.error('Reveal error:', err)
    globalThis.alert(`${t('ctx_open_as_folder')} 失败：${String(err.message || err)}`)
  }
}

// tab right-click: a single-file tab has no tree node, so reveal-in-Explorer
// and copy-name live on the tab pill itself. Path derived from deskKey
// ('file:<abs>' / 'folder:<abs>') or the workspace root + treePath.
const tabDeskPath = (tb) => {
  const k = typeof tb.deskKey === 'string' ? tb.deskKey : ''
  if (k.startsWith('file:')) return k.slice(5)
  const root = k.startsWith('folder:') ? k.slice(7)
    : (tb.folderHandle && tb.folderHandle._deskPath) || null
  if (!root) return null
  if (!tb.treePath) return root
  const sep = root.includes('\\') ? '\\' : '/'
  return root.replace(/[\\/]$/, '') + sep + tb.treePath.replace(/^\/+/, '').split('/').join(sep)
}
const openTabCtxMenu = (tb, e) => {
  if (!tb || !e) return
  e.preventDefault()
  e.stopPropagation()
  const p = tabDeskPath(tb)
  const items = [
    ...(window.knoteDesktop && window.knoteDesktop.reveal && p
      ? [{ label: t('ctx_open_as_folder'), action: () => window.knoteDesktop.reveal(p).catch((err) => globalThis.alert(`${t('ctx_open_as_folder')} 失败：${String((err && err.message) || err)}`)) }]
      : []),
    { label: t('ctx_copy_name'), action: () => navigator.clipboard.writeText(tabLabelOf(tb)).catch(() => {}) },
    { divider: true },
    { label: t('tab_close'), danger: true, action: () => closeTab(tb.id) }
  ]
  openCtxMenu(e.clientX, e.clientY, items, p || tb.treePath || tb.id)
}
// recents right-click: reveal + remove-single-entry
const removeRecent = (r) => {
  recentItems.value = recentItems.value.filter((x) => !(x.type === r.type && x.path === r.path))
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(recentItems.value)) } catch { /* quota */ }
}
const openRecentCtxMenu = (r, e) => {
  const items = [
    ...(window.knoteDesktop && window.knoteDesktop.reveal
      ? [{ label: t('ctx_open_as_folder'), action: () => window.knoteDesktop.reveal(r.path).catch(() => {}) }]
      : []),
    { label: t('ctx_copy_name'), action: () => navigator.clipboard.writeText(r.name).catch(() => {}) },
    { divider: true },
    { label: t('recent_remove'), danger: true, action: () => removeRecent(r) }
  ]
  openCtxMenu(e.clientX, e.clientY, items, r.path)
}

const openTreeCtxMenu = (node, e) => {
  if (!node || !e) return
  resetTreeDoubleTap()
  // Do not let a right-button pointer sequence reach the workspace/editor or
  // a parent drag/select handler before the Teleported menu is installed.
  e.preventDefault()
  e.stopPropagation()
  const items = node.kind === 'dir'
    ? [
        { label: expandedDirs.value.has(node.path) ? t('ctx_collapse') : t('ctx_expand'), action: () => toggleDir(node.path) },
        ...(canRevealNode(node) ? [{ label: t('ctx_open_as_folder'), action: () => revealNodeInExplorer(node) }] : []),
        { divider: true },
        { label: t('file_new_here'), action: () => createMdFile(node) },
        { label: t('folder_new_here'), action: () => createFolder(node) },
        { label: t('ctx_move'), action: () => { moveState.value = { node } } },
        { label: t('ctx_copy_name'), action: () => navigator.clipboard.writeText(node.name).catch(() => {}) },
        { divider: true },
        { label: t('ctx_delete'), danger: true, action: () => deleteTreeFile(node) }
      ]
    : [
        { label: t('ctx_open'), action: () => openTreeFile(node) },
        ...(supportsDocumentTabs.value && folderHandle.value && node.ftype === 'md'
          ? [{ label: t('ctx_open_new_tab'), action: () => openTreeFileInNewTab(node) }]
          : []),
        ...(canRevealNode(node) ? [{ label: t('ctx_open_as_folder'), action: () => revealNodeInExplorer(node) }] : []),
        { label: t('file_rename'), action: () => renameTreeFile(node) },
        { label: t('ctx_move'), action: () => { moveState.value = { node } } },
        { label: t('ctx_copy_name'), action: () => navigator.clipboard.writeText(node.name).catch(() => {}) },
        { divider: true },
        { label: t('ctx_delete'), danger: true, action: () => deleteTreeFile(node) }
      ]
  openCtxMenu(e.clientX, e.clientY, items, node.path)
}

const treePathAffectedByNode = (treePath, node) => {
  const value = String(treePath || '')
  return value === node.path || (node.kind === 'dir' && value.startsWith(node.path + '/'))
}
const browserTreeSnapshotKey = (treePath, binding = null) => {
  const handle = binding?.handle || folderHandle.value
  if (!handle || handle._deskPath || handle._knoteIdentity) return ''
  const currentTab = activeTab && activeTab()
  const folderKey = binding?.id || folderSnapshotIdentity(
    handle,
    folderWorkspaceId.value,
    currentTab?.deskKey || ''
  )
  return treeSnapshotIdentity(folderKey, treePath)
}

const isSafeWorkspaceLeafName = (value) => {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/:*?"<>|#\0\r\n]/.test(value) || /[. ]$/.test(value)) return false
  let probe = value
  for (let depth = 0; depth < 3 && probe.includes('%'); depth++) {
    let decoded
    try { decoded = decodeURIComponent(probe) } catch { break }
    if (decoded === probe) break
    probe = decoded
    if (!probe || probe === '.' || probe === '..' || /[\\/\0\r\n]/.test(probe) || /^(?:[a-z][a-z0-9+.-]*:|[a-z]:|#)/i.test(probe)) return false
  }
  return true
}

const affectedTreeTabs = (node) => {
  const current = activeTab()
  const workspaceKey = current?.deskKey
  const workspaceHandle = folderHandle.value
  const normalizeDiskPath = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const targetDiskPath = normalizeDiskPath(node.handle?._deskPath)
  return tabs.value.filter((tb) => {
    const isActive = tb.id === activeTabId.value
    const fileHandle = isActive ? currentFileHandle.value : tb.fileHandle
    const fileDiskPath = normalizeDiskPath(fileHandle?._deskPath)
    const samePhysicalPath = !!targetDiskPath && !!fileDiskPath && (
      fileDiskPath === targetDiskPath ||
      (node.kind === 'dir' && fileDiskPath.startsWith(targetDiskPath + '/'))
    )
    if (samePhysicalPath) return true
    const sameWorkspace = workspaceKey
      ? sameDeskKey(tb.deskKey, workspaceKey)
      : !!workspaceHandle && tb.folderHandle === workspaceHandle
    const treePath = isActive ? activeTreePath.value : tb.treePath
    return sameWorkspace && treePathAffectedByNode(treePath, node)
  })
}

// A tree mutation is not allowed to race a delayed save. Capture the live
// editor, drain the old immutable identity and write a recovery snapshot before
// rename/delete can invalidate the path.
const releaseTreeMutationSaveLocks = (records) => {
  for (const record of records || []) {
    if (record.editable) blockedDocumentSaveIdentities.delete(String(record.key || ''))
  }
}

const treeMutationSaveBarrier = async (node, label) => {
  try {
    const affected = affectedTreeTabs(node)
    const activeAffected = affected.some((tb) => tb.id === activeTabId.value)
    if (activeAffected) {
      try {
        const focused = document.activeElement
        if (focused && typeof focused.blur === 'function') focused.blur()
      } catch { /* ignore a detaching focus target */ }
      await nextTick()
      commitActiveBlockIfAny()
      await nextTick()
      const flushed = await flushAutoSave()
      if (flushed === false) {
        if (isLocalFile.value && !blockedDocumentSaveIdentities.has(snapshotDocKey())) {
          notify(lang.value === 'zh'
            ? '\u4fdd\u5b58\u5931\u8d25\uff0c\u5df2\u53d6\u6d88\u6587\u4ef6\u64cd\u4f5c'
            : 'Save failed; file operation cancelled')
        }
        return null
      }
    }

    const records = []
    for (const tb of affected) {
      const isActive = tb.id === activeTabId.value
      const fileHandle = isActive ? currentFileHandle.value : tb.fileHandle
      const fileName = isActive ? currentFileName.value : tb.fileName
      const editable = !!fileHandle && /\.(?:md|markdown)$/i.test(String(fileName || '')) &&
        (node.kind === 'dir' || node.ftype === 'md')
      const key = snapshotDocKeyForTab(tb)
      if (editable) await waitForDocumentSaves(key)
      if (editable && documentIsAheadOfDisk(key)) {
        notify(lang.value === 'zh'
          ? '\u4fdd\u5b58\u5c1a\u672a\u5b8c\u6210\uff0c\u5df2\u53d6\u6d88\u6587\u4ef6\u64cd\u4f5c'
          : 'Save did not finish; file operation cancelled')
        return null
      }
      let text = editable && isActive
        ? content.value
        : (editable && typeof tb.content === 'string' ? tb.content : null)
      if (editable && text == null && tabBufferApi && tb.bufferRef) {
        const buffered = await tabBufferApi.tabBufferGet(tb.bufferRef)
        if (typeof buffered !== 'string') throw new Error('tab buffer is unavailable')
        text = importMarkdown(buffered)
      }
      if (editable && text != null && await takeSnapshot(label, key, text) == null) {
        notify(lang.value === 'zh'
          ? '\u5386\u53f2\u7248\u672c\u5199\u5165\u5931\u8d25\uff0c\u5df2\u53d6\u6d88\u6587\u4ef6\u64cd\u4f5c'
          : 'History write failed; file operation cancelled')
        return null
      }
      records.push({ tab: tb, key, text, editable, revision: editable ? documentEditRevision(key) : 0 })
    }

    for (const record of records) {
      if (record.editable && (documentEditRevision(record.key) !== record.revision || documentIsAheadOfDisk(record.key))) {
        notify(lang.value === 'zh'
          ? '\u6587\u4ef6\u5728\u64cd\u4f5c\u671f\u95f4\u53c8\u88ab\u4fee\u6539\uff0c\u5df2\u53d6\u6d88\u6587\u4ef6\u64cd\u4f5c'
          : 'The file changed during this operation; operation cancelled')
        return null
      }
    }
    for (const record of records) {
      if (record.editable) blockedDocumentSaveIdentities.add(String(record.key || ''))
    }
    return records
  } catch (error) {
    console.error('Tree mutation save barrier failed:', error)
    notify(lang.value === 'zh'
      ? '\u65e0\u6cd5\u5b89\u5168\u51c6\u5907\u6587\u4ef6\u64cd\u4f5c\uff0c\u5df2\u53d6\u6d88'
      : 'Could not safely prepare the file operation; it was cancelled')
    return null
  }
}

const deleteTreeFile = async (node) => {
  // desktop path-backed items go to the RECYCLE BIN (recoverable) — the
  // confirm wording reflects that; browser FSA has no trash, stays permanent
  const canTrash = !!(window.knoteDesktop && window.knoteDesktop.trash && node.handle && node.handle._deskPath)
  const isDir = node.kind === 'dir'
  const zh = lang.value === 'zh'
  const noun = isDir ? (zh ? '文件夹' : 'folder') : (zh ? '文档' : 'file')
  const folderWarn = isDir ? (zh ? '（含其中所有内容）' : ' and everything inside') : ''
  const ok = await confirmDialog(
    canTrash
      ? (zh ? `将${noun}「${node.name}」${folderWarn}移到回收站？` : `Move ${noun} "${node.name}"${folderWarn} to the Recycle Bin?`)
      : (zh ? `删除${noun}「${node.name}」${folderWarn}？此操作不可恢复。` : `Delete ${noun} "${node.name}"${folderWarn}? This cannot be undone.`),
    { owner: `tree-delete:${node.path}` }
  )
  if (!ok) return
  const affected = await treeMutationSaveBarrier(node, 'before-delete-live')
  if (!affected) return
  const activeAffected = affected.some((record) => record.tab.id === activeTabId.value)
  const activeEditable = affected.some((record) => record.editable && record.tab.id === activeTabId.value)
  if (activeAffected) {
    cancelAutoSave()
    assetsFlushGeneration += 1
    clearTimeout(assetsFlushTimer)
  }
  try {
    if (canTrash) await window.knoteDesktop.trash(node.handle._deskPath)
    else await node.parent.removeEntry(node.name, { recursive: isDir })
    if (activeAffected) {
      cancelAutoSave()
      commitActiveBlockIfAny()
      await nextTick()
    }
    // Editing is allowed while the native confirmation/IPC is in flight. The
    // old identity is locked, so preserve any such late text in immutable
    // history before detaching its vanished backing path.
    for (const record of affected) {
      if (!record.editable) continue
      const latestText = record.tab.id === activeTabId.value
        ? content.value
        : (typeof record.tab.content === 'string' ? record.tab.content : record.text)
      if (latestText != null && latestText !== record.text) {
        const recovered = await takeSnapshot('after-delete-recovery', record.key, latestText)
        if (recovered == null) {
          notify(lang.value === 'zh'
            ? '\u6587\u4ef6\u5df2\u5220\u9664\uff0c\u4f46\u64cd\u4f5c\u671f\u95f4\u7684\u6700\u65b0\u7f16\u8f91\u672a\u80fd\u5199\u5165\u5386\u53f2'
            : 'Deleted, but the latest in-flight edit could not be added to history')
        }
      }
    }
    releaseTreeMutationSaveLocks(affected)
    // Detach every open buffer whose backing path disappeared. Keeping the
    // in-memory text lets the user Save As, while no later tab switch can
    // resurrect the deleted path through a stale handle.
    for (const { tab } of affected) {
      bumpAgentDocumentGeneration(tab)
      setTabFileWorkspaceIdentity(tab)
      tab.fileHandle = null
      tab.isLocal = false
      tab.fileName = ''
      tab.treePath = ''
      if (String(tab.deskKey || '').startsWith('file:')) tab.deskKey = ''
      if (tab.id === activeTabId.value) {
        currentFileHandle.value = null
        isLocalFile.value = false
        currentFileName.value = ''
        activeTreePath.value = ''
        diskWatchGen += 1
        diskWatchMtime = 0
        diskWatchRaw = null
      }
    }
    persistSession()
    await refreshFolder()
    notify(canTrash ? (zh ? '已移到回收站' : 'Moved to Recycle Bin') : (zh ? '已删除' : 'Deleted'))
  } catch (err) {
    releaseTreeMutationSaveLocks(affected)
    if (err?.code === 'MUTATION_COMMIT_UNCERTAIN') {
      for (const { tab } of affected) {
        bumpAgentDocumentGeneration(tab)
        setTabFileWorkspaceIdentity(tab)
        tab.fileHandle = null
        tab.isLocal = false
        tab.treePath = ''
        tab.docDir = null
        if (tab.id === activeTabId.value) {
          currentFileHandle.value = null
          isLocalFile.value = false
          activeTreePath.value = ''
          docDir.value = null
        }
      }
      try { await refreshFolder() } catch { /* user can retry refresh */ }
      notify(lang.value === 'zh'
        ? '删除结果不确定，已停止自动保存；请在文件树确认后重新打开'
        : 'The delete result is uncertain. Auto-save was stopped; verify the tree and reopen the file.')
      return
    }
    if (activeEditable && currentFileHandle.value) {
      commitActiveBlockIfAny()
      await nextTick()
      cancelAutoSave()
      const key = snapshotDocKey()
      await saveToFileHandle(currentFileHandle.value, {
        markdown: exportableMarkdown(),
        snapshotContent: content.value,
        snapshotKey: key,
        revision: documentEditRevision(key)
      })
    }
    globalThis.alert(`${t('ctx_delete')} 失败：${String(err.message || err)}`)
  }
}

// Create a new .md file. Without a `parentNode` it lands at the folder root;
// with one, inside that subfolder (right-click "new file here").
// The prompt title shows WHERE it will be created, so the header-button path
// (which targets the last-clicked folder) is never a surprise.
const createTargetLabel = (base) => `${base || ''}/`
const createMdFile = async (parentNode) => {
  const dir = parentNode ? parentNode.handle : folderHandle.value
  if (!dir) return
  const base = parentNode ? parentNode.path : ''
  // loop until the user gives a valid name or cancels
  while (true) {
    let name = await promptInput(`${t('file_new_prompt')}（→ ${folderName.value}${createTargetLabel(base)}）`, '未命名.md')
    if (!name) return
    name = name.trim()
    if (!name) continue
    if (/[\\/:*?"<>|]/.test(name)) {
      // Re-open the prompt so the user can fix the name instead of
      // showing a native alert() that breaks focus state
      globalThis.alert(t('file_bad_name'))
      continue
    }
    if (!/\.(md|markdown)$/i.test(name)) name += '.md'
    try {
      await dir.getFileHandle(name)
      globalThis.alert(t('file_exists'))
      continue
    } catch (error) {
      if (error?.name === 'TypeMismatchError') {
        globalThis.alert(t('file_exists'))
        continue
      }
      if (error?.name !== 'NotFoundError') {
        globalThis.alert(`${t('file_new')} 失败：${String(error?.message || error)}`)
        return
      }
    }
    try {
      const fh = await dir.getFileHandle(name, { create: true })
      const w = await fh.createWritable()
      await w.write(`# ${name.replace(/\.(md|markdown)$/i, '')}\n`)
      await w.close()
      await refreshFolder()
      if (parentNode) expandedDirs.value = new Set([...expandedDirs.value, parentNode.path])
      await openTreeFile({ name, kind: 'file', handle: fh, parent: dir, path: `${base}/${name}` })
      return
    } catch (err) {
      console.error('Create file error:', err)
      if (err?.code === 'MUTATION_COMMIT_UNCERTAIN' || dir?._knoteSafGrantId) {
        try { await refreshFolder() } catch { /* retain current tree on refresh failure */ }
      }
      if (err?.code === 'MUTATION_COMMIT_UNCERTAIN') {
        notify(lang.value === 'zh'
          ? '新建文件结果不确定，请先在文件树确认后再操作'
          : 'File creation is uncertain. Verify the file tree before continuing.')
        return
      }
      globalThis.alert(`${t('file_new')} 失败：${String(err.message || err)}`)
      return
    }
  }
}

// Create a new subfolder (at the root, or inside `parentNode`)
const createFolder = async (parentNode) => {
  const dir = parentNode ? parentNode.handle : folderHandle.value
  if (!dir) return
  let name = await promptInput(`${t('folder_new_prompt')}（→ ${folderName.value}${createTargetLabel(parentNode ? parentNode.path : '')}）`, lang.value === 'zh' ? '新建文件夹' : 'New Folder')
  if (!name) return
  name = name.trim()
  if (!name) return
  if (/[\\/:*?"<>|]/.test(name)) { globalThis.alert(t('file_bad_name')); return }
  try {
    await dir.getDirectoryHandle(name)
    globalThis.alert(t('file_exists'))
    return
  } catch (err) {
    // NotFoundError = free to create; anything else is a real failure
    if (err && err.name && err.name !== 'NotFoundError') {
      globalThis.alert(`${t('folder_new')} 失败：${String(err.message || err)}`)
      return
    }
  }
  try {
    await dir.getDirectoryHandle(name, { create: true })
    await refreshFolder()
    // reveal the new folder (expand its parent if nested)
    const newPath = parentNode ? `${parentNode.path}/${name}` : `/${name}`
    const toExpand = [newPath]
    if (parentNode) toExpand.push(parentNode.path)
    expandedDirs.value = new Set([...expandedDirs.value, ...toExpand])
    notify(lang.value === 'zh' ? '已新建文件夹' : 'Folder created')
  } catch (err) {
    console.error('Create folder error:', err)
    if (err?.code === 'MUTATION_COMMIT_UNCERTAIN' || dir?._knoteSafGrantId) {
      try { await refreshFolder() } catch { /* retain current tree on refresh failure */ }
    }
    if (err?.code === 'MUTATION_COMMIT_UNCERTAIN') {
      notify(lang.value === 'zh'
        ? '新建文件夹结果不确定，请先在文件树确认后再操作'
        : 'Folder creation is uncertain. Verify the file tree before continuing.')
      return
    }
    globalThis.alert(`${t('folder_new')} 失败：${String(err.message || err)}`)
  }
}

const renameTreeFile = async (node, e) => {
  if (e) e.stopPropagation()
  let name = await promptInput(t('file_rename_prompt'), node.name)
  if (!name) return
  name = name.trim()
  if (!name || name === node.name) return
  if (!isSafeWorkspaceLeafName(name)) { globalThis.alert(t('file_bad_name')); return }
  if (node.ftype === 'pdf' || node.ftype === 'image' || node.ftype === 'docx' || node.ftype === 'pptx' || node.ftype === 'xlsx' || node.ftype === 'odt' || node.ftype === 'ods' || node.ftype === 'odp' || node.ftype === 'txt' || node.ftype === 'csv' || node.ftype === 'rtf') {
    // never .md a known asset; keep a recognized asset extension, else re-append the
    // original one (a dotted non-extension like "report.v2" must not lose .pdf,
    // which would drop the file from the tree entirely)
    if (!/\.(pdf|png|jpe?g|gif|webp|bmp|avif|svg|docx|pptx|xlsx|odt|ods|odp|txt|csv|rtf)$/i.test(name)) { const ext = node.name.match(/\.[^.]+$/); if (ext) name += ext[0] }
  } else if (!/\.(md|markdown)$/i.test(name)) {
    name += '.md'
  }
  if (!isSafeWorkspaceLeafName(name)) { globalThis.alert(t('file_bad_name')); return }
  try {
    await node.parent.getFileHandle(name)
    globalThis.alert(t('file_exists'))
    return
  } catch (error) {
    if (error?.name !== 'NotFoundError') {
      globalThis.alert(`${t('file_rename')} 失败：${String(error?.message || error)}`)
      return
    }
  }
  const intendedTreePath = node.path.replace(/[^/]+$/, name)
  const browserHistoryPair = node.ftype === 'md' && !node.handle?._deskPath && !node.handle?._knoteIdentity
    ? [browserTreeSnapshotKey(node.path), browserTreeSnapshotKey(intendedTreePath)]
    : null
  const affected = await treeMutationSaveBarrier(node, 'before-rename-live')
  if (!affected) return
  const activeAffected = affected.some((record) => record.tab.id === activeTabId.value)
  const activeEditable = affected.some((record) => record.editable && record.tab.id === activeTabId.value)
  if (activeAffected) cancelAutoSave()
  let renameCompleted = false
  try {
    if (browserHistoryPair?.[0] && browserHistoryPair[1]) {
      await copySnapshots(browserHistoryPair[0], browserHistoryPair[1])
    }
    let newHandle = node.handle
    if (typeof node.handle.move === 'function') {
      // Chromium supports in-place rename; the handle then points at the new name
      await node.handle.move(name)
    } else {
      // fallback: copy + delete
      const file = await node.handle.getFile()
      newHandle = await node.parent.getFileHandle(name, { create: true })
      const w = await newHandle.createWritable()
      await w.write(await file.arrayBuffer())
      await w.close()
      await node.parent.removeEntry(node.name)
    }
    renameCompleted = true
    if (activeAffected) cancelAutoSave()

    const newTreePath = intendedTreePath
    for (const record of affected) {
      const tb = record.tab
      const previousTreePath = tb.id === activeTabId.value ? activeTreePath.value : tb.treePath
      const remappedTreePath = treePathAffectedByNode(previousTreePath, node)
        ? (node.kind === 'dir' ? newTreePath + previousTreePath.slice(node.path.length) : newTreePath)
        : previousTreePath
      if (record.editable) {
        bumpAgentDocumentGeneration(tb)
        tb.fileName = name
        tb.fileHandle = newHandle
        tb.treePath = remappedTreePath
        if (tb.deskKey && tb.deskKey.startsWith('file:') && newHandle?._deskPath) {
          tb.deskKey = `file:${newHandle._deskPath}`
        }
      }
      if (tb.id === activeTabId.value) {
        if (record.editable) {
          currentFileName.value = name
          currentFileHandle.value = newHandle
        }
        activeTreePath.value = remappedTreePath
        if (pdfView.value?.path === previousTreePath) {
          pdfView.value = { ...pdfView.value, name, path: remappedTreePath }
        }
        diskWatchGen += 1
        diskWatchMtime = 0
        diskWatchRaw = null
      }

      const newKey = record.editable ? snapshotDocKeyForTab(tb) : ''
      const latestEditRevision = documentEditRevision(record.key) || record.revision
      const latestSavedRevision = documentSavedRevisions.get(record.key) || latestEditRevision
      if (newKey && newKey !== record.key) {
        documentEditRevisions.set(newKey, latestEditRevision)
        documentSavedRevisions.set(newKey, latestSavedRevision)
      }
      record.newKey = newKey
    }
    // Every handle/identity is migrated synchronously before the old lock is
    // released. No await above this point can reopen a window for an old-path
    // autosave to be queued after a successful rename.
    releaseTreeMutationSaveLocks(affected)
    const copiedHistoryPairs = new Set()
    for (const record of affected) {
      const tb = record.tab
      const newKey = record.newKey || snapshotDocKeyForTab(tb)
      const liveText = tb.id === activeTabId.value ? content.value : record.text
      if (!record.editable) continue
      const copyPair = `${record.key}\0${newKey}`
      if (record.key && newKey && record.key !== newKey && !copiedHistoryPairs.has(copyPair)) {
        copiedHistoryPairs.add(copyPair)
        try {
          await copySnapshots(record.key, newKey)
        } catch (error) {
          console.error('Rename history copy failed:', error)
          notify(lang.value === 'zh' ? '重命名成功，旧版本历史仍保留在原名称下' : 'Renamed; older history remains under the previous name')
        }
      }
      if (tb.id === activeTabId.value && liveText != null) {
        commitActiveBlockIfAny()
        await nextTick()
        cancelAutoSave()
        const saved = await saveToFileHandle(newHandle, {
          markdown: exportableMarkdown(),
          snapshotContent: content.value,
          snapshotKey: newKey,
          revision: documentEditRevision(newKey)
        })
        if (saved === false) notify(lang.value === 'zh' ? '\u91cd\u547d\u540d\u6210\u529f\uff0c\u4f46\u6700\u65b0\u5185\u5bb9\u5c1a\u672a\u5199\u76d8' : 'Renamed, but the latest content is not on disk yet')
      }
      if (liveText != null) await takeSnapshot('renamed', newKey, liveText)
    }
    persistSession()
    await refreshFolder()
  } catch (err) {
    releaseTreeMutationSaveLocks(affected)
    if (err?.code === 'MUTATION_COMMIT_UNCERTAIN') {
      for (const { tab } of affected) {
        bumpAgentDocumentGeneration(tab)
        setTabFileWorkspaceIdentity(tab)
        tab.fileHandle = null
        tab.isLocal = false
        tab.treePath = ''
        tab.docDir = null
        if (tab.id === activeTabId.value) {
          currentFileHandle.value = null
          isLocalFile.value = false
          activeTreePath.value = ''
          docDir.value = null
        }
      }
      try { await refreshFolder() } catch { /* user can retry refresh */ }
      notify(lang.value === 'zh'
        ? '重命名结果不确定，已停止自动保存；请在文件树确认后重新打开'
        : 'The rename result is uncertain. Auto-save was stopped; verify the tree and reopen the file.')
      return
    }
    if (!renameCompleted && activeEditable && currentFileHandle.value) {
      commitActiveBlockIfAny()
      await nextTick()
      cancelAutoSave()
      const key = snapshotDocKey()
      await saveToFileHandle(currentFileHandle.value, {
        markdown: exportableMarkdown(),
        snapshotContent: content.value,
        snapshotKey: key,
        revision: documentEditRevision(key)
      })
    }
    console.error('Rename error:', err)
    globalThis.alert(`${t('file_rename')} 失败：${String(err.message || err)}`)
  }
}

// ---- Move file/folder to another directory (context menu「移动到…」) ----
const moveState = ref(null) // { node } while the destination picker is open
// destination list: workspace root + every dir EXCEPT the source itself, its
// descendants (a dir can't move into itself) and its current parent (no-op)
const moveDestinations = computed(() => {
  if (!moveState.value) return []
  const src = moveState.value.node
  const srcParentPath = src.path.replace(/\/[^/]*$/, '')
  const out = []
  if (srcParentPath !== '') out.push({ label: `${folderName.value}/`, path: '', depth: 0 })
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      if (n.kind !== 'dir') continue
      const isSelfOrDesc = n.path === src.path || n.path.startsWith(src.path + '/')
      if (!isSelfOrDesc && n.path !== srcParentPath) out.push({ label: n.path.replace(/^\//, '') + '/', path: n.path, depth })
      if (!isSelfOrDesc) walk(n.children || [], depth + 1)
    }
  }
  walk(folderTree.value, srcParentPath === '' ? 0 : 1)
  return out
})
// recursive copy for the FSA fallback (directories, or files whose handle
// lacks .move). Copies bytes (arrayBuffer) so images survive intact.
const copyEntryInto = async (srcHandle, destDir, name) => {
  if (srcHandle.kind === 'directory') {
    const sub = await destDir.getDirectoryHandle(name, { create: true })
    for await (const [n, h] of srcHandle.entries()) await copyEntryInto(h, sub, n)
  } else {
    const data = await (await srcHandle.getFile()).arrayBuffer()
    const fh = await destDir.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    await w.write(data)
    await w.close()
  }
}
// Copy history for every .md under a moved folder (browser-FSA keys derive
// from the full path, so a subtree move orphans every contained file's key).
const copyDirSnapshots = async (treeNode, binding, toRoot) => {
  for (const child of treeNode.children || []) {
    if (child.kind === 'dir') {
      await copyDirSnapshots(child, binding, toRoot + '/' + child.name)
      continue
    }
    if (child.ftype === 'md') {
      const fromKey = browserTreeSnapshotKey(child.path, binding)
      const toKey = browserTreeSnapshotKey(toRoot + '/' + child.name, binding)
      if (fromKey && toKey) await copySnapshots(fromKey, toKey)
    }
  }
}
const performMove = async (dest) => {
  const node = moveState.value && moveState.value.node
  moveState.value = null
  if (!node) return
  const zh = lang.value === 'zh'
  // moving an OPEN document (or a folder containing one) would strand its
  // write handle on the old location — later auto-saves would silently
  // recreate the file at the pre-move path (a data fork). Check the active
  // doc AND every background tab.
  if (activeTreePath.value === node.path || (node.kind === 'dir' && activeTreePath.value.startsWith(node.path + '/'))) {
    globalThis.alert(t('move_active_blocked'))
    return
  }
  const srcDesk = node.handle._deskPath
  const normP = (s) => String(s).replace(/\\/g, '/').toLowerCase()
  const tabBlocked = tabs.value.some((tb) => {
    if (tb.id === activeTabId.value) return false // active doc handled above
    // a tree file of THIS workspace open in another tab
    if (tb.folderHandle === folderHandle.value && tb.treePath &&
        (tb.treePath === node.path || (node.kind === 'dir' && tb.treePath.startsWith(node.path + '/')))) return true
    // desktop: any tab whose backing file path sits at/under the moved path
    if (srcDesk) {
      const tbPath = (tb.fileHandle && tb.fileHandle._deskPath) ||
        (tb.deskKey && tb.deskKey.startsWith('file:') ? tb.deskKey.slice(5) : '')
      if (tbPath) {
        const a = normP(tbPath); const b = normP(srcDesk)
        if (a === b || a.startsWith(b + '/')) return true
      }
    }
    return false
  })
  if (tabBlocked) {
    globalThis.alert(t('move_active_blocked'))
    return
  }
  try {
    const destNode = dest.path ? resolveDirNode(dest.path) : null
    const destHandle = destNode ? destNode.handle : folderHandle.value
    if (!destHandle) throw new Error('目标文件夹不存在')
    // name collision at the destination?
    let taken = false
    try { await (node.kind === 'dir' ? destHandle.getDirectoryHandle(node.name) : destHandle.getFileHandle(node.name)); taken = true } catch { taken = false }
    if (taken) { globalThis.alert(t('move_exists')) ; return }
    const destinationPath = `${String(dest.path || '').replace(/\/$/, '')}/${node.name}`
    if (node.ftype === 'md' && !node.handle?._deskPath && !node.handle?._knoteIdentity) {
      const fromKey = browserTreeSnapshotKey(node.path)
      const toKey = browserTreeSnapshotKey(destinationPath)
      if (fromKey && toKey) await copySnapshots(fromKey, toKey)
    }
    if (node.kind === 'dir' && !node.handle?._deskPath && !node.handle?._knoteIdentity) {
      await copyDirSnapshots(node, null, destinationPath)
    }
    const srcDesk = node.handle._deskPath
    const destDesk = destHandle._deskPath
    if (srcDesk && destDesk && window.knoteDesktop && window.knoteDesktop.fsRename) {
      // desktop: one atomic rename (works for files AND directories)
      const sep = destDesk.includes('\\') ? '\\' : '/'
      await window.knoteDesktop.fsRename(srcDesk, destDesk.replace(/[\\/]$/, '') + sep + node.name)
    } else if (typeof node.handle.move === 'function') {
      // Native SAF moves files and directories without enumerating only the
      // subset of provider children that the UI understands.
      try { await node.handle.move(destHandle, node.name) } catch (error) {
        if (node.handle?._knoteIdentity) throw error
        await copyEntryInto(node.handle, destHandle, node.name)
        await node.parent.removeEntry(node.name)
      }
    } else {
      // FSA directory (or handle without .move): recursive copy + delete
      await copyEntryInto(node.handle, destHandle, node.name)
      await node.parent.removeEntry(node.name, { recursive: node.kind === 'dir' })
    }
    // keep the create-target sane if it pointed into the moved subtree
    if (activeDirPath.value === node.path || activeDirPath.value.startsWith(node.path + '/')) activeDirPath.value = dest.path
    if (dest.path) expandedDirs.value = new Set([...expandedDirs.value, dest.path])
    await refreshFolder()
    notify(zh ? '已移动' : 'Moved')
  } catch (err) {
    console.error('Move error:', err)
    if (err?.code === 'MUTATION_COMMIT_UNCERTAIN') {
      try { await refreshFolder() } catch { /* user can retry refresh */ }
      notify(zh
        ? '移动结果不确定，请在文件树确认源位置和目标位置后再操作'
        : 'The move result is uncertain. Verify both source and destination before continuing.')
      return
    }
    globalThis.alert(`${t('ctx_move')} 失败：${String(err.message || err)}`)
  }
}

const findOpenTreeDocumentTab = (node) => {
  const currentTab = activeTab()
  const workspaceKey = currentTab?.deskKey
  const workspaceHandle = folderHandle.value
  const targetPath = String(node?.path || '')
  if (!targetPath) return null
  return tabs.value.find((tb) => {
    const sameWorkspace = workspaceKey
      ? sameDeskKey(tb.deskKey, workspaceKey)
      : !!workspaceHandle && tb.folderHandle === workspaceHandle
    const openHandle = tb.id === activeTabId.value ? currentFileHandle.value : tb.fileHandle
    const sameCapability = !staleSafFileHandles.has(openHandle) && (
      !node.handle?._knoteSafGrantId || !openHandle?._knoteSafGrantId ||
      (node.handle._knoteSafGrantId === openHandle._knoteSafGrantId && node.handle._entryId === openHandle._entryId)
    )
    return sameWorkspace && sameCapability &&
      String(tb.id === activeTabId.value ? activeTreePath.value : tb.treePath || '') === targetPath
  }) || null
}

const treeFileNeedsConfirmation = (node) => node?.kind === 'file' && node.ftype !== 'md' && node.ftype !== 'pdf'
const treeRowAnnotation = (node) => treeFileNeedsConfirmation(node) ? t('file_double_click_open') : node?.name
const ANDROID_TREE_DOUBLE_TAP_MS = 500
const ANDROID_TREE_DOUBLE_TAP_DISTANCE = 24
let androidTreeTap = null
const resetTreeDoubleTap = () => { androidTreeTap = null }

const openTreeFile = async (node) => {
  cancelSessionRestoreForForegroundIntent()
  // Every click is an intent, including clicking the already-active file.
  // Increment before dedupe so that A -> slow B -> A cancels B even though
  // the final A click performs no disk read of its own.
  const loadGeneration = ++documentLoadGeneration
  const docTypes = ['pdf', 'image', 'docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp', 'txt', 'csv', 'rtf', 'code']
  if (!docTypes.includes(node.ftype)) {
    const alreadyOpen = findOpenTreeDocumentTab(node)
    if (alreadyOpen) {
      if (alreadyOpen.id !== activeTabId.value) return await switchTab(alreadyOpen.id)
      return true
    }
  }
  const targetTabId = activeTabId.value
  const targetFolderHandle = folderHandle.value
  const targetWorkspaceId = agentWorkspaceIdentity()
  const mutationKey = await resolveFileMutationKey(targetFolderHandle, targetWorkspaceId, node.path, node.handle)
  let targetIdentity = ''
  let targetEditRevision = 0
  let targetContent = ''
  const stillCurrent = () => loadGeneration === documentLoadGeneration &&
    activeTabId.value === targetTabId && folderHandle.value === targetFolderHandle &&
    (!targetIdentity || (
      snapshotDocKey() === targetIdentity &&
      documentEditRevision(targetIdentity) === targetEditRevision &&
      content.value === targetContent
    ))
  // Finish/capture the old document before any permission prompt or file read.
  // In particular, this freezes a pending auto-save to the OLD handle instead
  // of letting its timer observe the newly selected file later.
  commitActiveBlockIfAny()
  targetIdentity = snapshotDocKey()
  targetEditRevision = documentEditRevision(targetIdentity)
  targetContent = content.value
  const flushed = await flushAutoSave()
  if (flushed === false || !stillCurrent()) return false
  // pdf/image/txt/csv/rtf are read-only — preview them, never load as markdown.
  // Office docs and HTML/HTM open with the OS default app on desktop (see
  // previewTreeAsset); their existing tree classifications remain unchanged.
  if (docTypes.includes(node.ftype)) {
    // PDF previews must NOT be cancelled by the GLOBAL load generation:
    // delayed open intents (argv/session replay) bump documentLoadGeneration
    // in the background, which used to kill a perfectly good preview right
    // after it rendered — the "PDF won't open" bug. Cancellation is driven by
    // pdfViewGen (a newer open/close bumps it). Text/office previews keep the
    // strict check: a slow extraction must never overwrite a NEWER markdown
    // selection.
    if (node.ftype === 'pdf') {
      const previewCurrent = () =>
        activeTabId.value === targetTabId && folderHandle.value === targetFolderHandle
      return await previewTreeAsset(node, previewCurrent)
    }
    if (isAgentEditableTextFile(node.name)) {
      return await withAsyncKeyLock(mutationKey, async () => {
        if (!stillCurrent()) return false
        return await previewTreeAsset(node, stillCurrent)
      })
    }
    return await previewTreeAsset(node, stillCurrent)
  }
  return await withAsyncKeyLock(mutationKey, async () => {
    if (!stillCurrent()) return false
    closePdfView()    // opening an MD dismisses any PDF viewer overlay
    closeDocPreview() // and any document preview
    try {
    // Confirm WRITE access now, inside the click gesture — the directory
    // grant doesn't always cover per-file readwrite, and the auto-save timer
    // can't show a permission prompt later. Granted => live-save (green).
    let writable = true
    if (node.handle.queryPermission && (await node.handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if (!stillCurrent()) return
      writable = node.handle.requestPermission
        ? (await node.handle.requestPermission({ mode: 'readwrite' })) === 'granted'
        : false
      if (!stillCurrent()) return
    }
    const file = await node.handle.getFile()
    if (!stillCurrent()) return
    const fileText = await file.text()
    if (!stillCurrent()) return
    const nextContent = importMarkdown(fileText)
    const editorLoad = stageLargeEditorLoad(nextContent)
    bumpAgentDocumentGeneration(activeTab && activeTab())
    const navigationOwner = beginNavigationInstall() // a file load is navigation, never an edit/autosave
    try {
      cancelAutoSave()
      resetEditingState()
      clearRelImages()
      // Install the new document identity before its content. Even a sync
      // watcher now sees one coherent file/content pair.
      currentFileHandle.value = writable ? node.handle : null
      currentFileName.value = file.name
      isLocalFile.value = writable
      activeTreePath.value = node.path
      content.value = nextContent
      if (e2eInvalidateNextTreeInstall) {
        e2eInvalidateNextTreeInstall = false
        documentLoadGeneration += 1
      }
      void releaseLargeEditorLoad(editorLoad)
      undoStack.value = []
      redoStack.value = []
      lastSavedSnapshot = { content: nextContent, selection: null }
      const installedIdentity = snapshotDocKey()
      markDocumentDiskBaseline(installedIdentity)
      blockedDocumentSaveIdentities.delete(installedIdentity)
      // Future freshness checks now belong to the document just installed,
      // not the document that was active while its disk read was pending.
      targetIdentity = installedIdentity
      targetEditRevision = documentEditRevision(installedIdentity)
      targetContent = content.value
      // the opened file's own folder becomes the new-file/new-folder target
      activeDirPath.value = node.path.replace(/\/[^/]*$/, '')
      // resolve ![](relative/path) images against the file's own folder — a
      // folder workspace always has the directory handle, so no grant needed
      relImagesNeedGrant.value = false
      docDir.value = node.parent // new images persist into <this folder>/assets/
      loadRelativeImages(node.parent)
    } finally {
      nextTick(() => { finishNavigationInstall(navigationOwner) })
    }
    await takeSnapshot('opened', snapshotDocKey(), nextContent)
    return stillCurrent()
    } catch (err) {
      console.error('Open tree file error:', err)
      return false
    }
  })
}

const openTreeFileFromSidebar = async (node) => {
  const opened = await openTreeFile(node)
  if (opened && isAndroidCompact.value) mobileFilesOpen.value = false
  return opened
}

const onTreeRowClick = (node, event) => {
  if (node.kind === 'dir') {
    resetTreeDoubleTap()
    toggleDir(node.path)
    return
  }
  if (!treeFileNeedsConfirmation(node)) {
    resetTreeDoubleTap()
    return openTreeFileFromSidebar(node)
  }
  if (!androidLayoutActive.value) return false

  const tap = {
    path: String(node.path || ''),
    at: Number(event?.timeStamp) || performance.now(),
    x: Number(event?.clientX) || 0,
    y: Number(event?.clientY) || 0
  }
  const previous = androidTreeTap
  const isDoubleTap = !!previous && previous.path === tap.path &&
    tap.at - previous.at >= 0 && tap.at - previous.at <= ANDROID_TREE_DOUBLE_TAP_MS &&
    Math.hypot(tap.x - previous.x, tap.y - previous.y) <= ANDROID_TREE_DOUBLE_TAP_DISTANCE
  androidTreeTap = isDoubleTap ? null : tap
  if (!isDoubleTap) return false
  return openTreeFileFromSidebar(node)
}

const onTreeRowDoubleClick = (node, event) => {
  if (!treeFileNeedsConfirmation(node)) return false
  event?.preventDefault()
  if (androidLayoutActive.value) {
    event?.stopPropagation()
    return false
  }
  return openTreeFileFromSidebar(node)
}

// ========== PDF Export ==========
const exportPDF = async () => {
  commitActiveBlockIfAny()
  // Desktop shell: the system print dialog has no preview in the frameless
  // window and rasterized oddly. Render straight to a PDF file via Electron's
  // printToPDF (same print CSS) and save it where the user picks.
  if (window.knoteDesktop && window.knoteDesktop.exportPdf) {
    await nextTick()
    const res = await window.knoteDesktop.exportPdf(`knote-${localDateStamp()}`)
    if (res && res.ok) notifyNativeExport(res.path)
    else if (res && res.error) notifyNativeExport(null)
    return
  }
  globalThis.print()
}

// ========== Word Export ==========
// Generates a Word-compatible HTML document (.doc). Word opens HTML natively,
// so this works offline with no extra dependencies; images are inlined as
// data URLs via exportableMarkdown().
const exportWord = () => {
  commitActiveBlockIfAny()
  // toInternal keeps the document's empty rows visible in the exported .doc
  const bodyHtml = sanitizeHtml(md.render(toInternal(exportableMarkdown())))
  const docHtml = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>Knote Document</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
  body { font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; line-height: 1.6; font-size: 12pt; }
  h1 { font-size: 22pt; } h2 { font-size: 17pt; } h3 { font-size: 14pt; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1pt solid #999999; padding: 6pt; }
  th { background: #f0f0f0; }
  pre { background: #f5f5f5; padding: 10pt; font-family: Consolas, monospace; font-size: 10pt; white-space: pre-wrap; }
  code { font-family: Consolas, monospace; background: #f5f5f5; }
  blockquote { border-left: 3pt solid #84cc16; margin-left: 0; padding-left: 12pt; color: #555555; }
  img { max-width: 100%; }
  mark { background: #fff3a3; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`
  if (isNativeApp()) {
    nativeExportText(`knote-${localDateStamp()}.doc`, '﻿' + docHtml).then(notifyNativeExport)
    return
  }
  const blob = new Blob(['﻿', docHtml], { type: 'application/msword;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `knote-${localDateStamp()}.doc`
  link.click()
  URL.revokeObjectURL(url)
}

// ========== HTML Export ==========
// Standalone, self-contained .html: the rendered document plus a compact
// stylesheet so it opens and reads well in any browser, offline.
const exportHtml = async () => {
  commitActiveBlockIfAny()
  let bodyHtml = sanitizeHtml(md.render(toInternal(exportableMarkdown())))
  // inline any mermaid diagrams as SVG so the file is self-contained
  if (/language-mermaid/.test(bodyHtml)) {
    const tmp = document.createElement('div')
    tmp.style.cssText = 'position:fixed;left:-99999px;top:0'
    tmp.innerHTML = bodyHtml
    document.body.appendChild(tmp)
    try {
      const isDark = ((document.querySelector('[data-theme]') || document.documentElement).getAttribute('data-theme') || '').includes('dark')
      await renderMermaidIn(tmp, isDark)
      bodyHtml = tmp.innerHTML
    } finally { tmp.remove() }
  }
  const title = (currentFileName.value || 'Knote').replace(/\.(md|markdown)$/i, '')
  const docHtml = `<!DOCTYPE html>
<html lang="${lang.value}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<>&]/g, '')}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 820px; margin: 40px auto; padding: 0 20px; font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif; line-height: 1.7; color: #24292f; }
  @media (prefers-color-scheme: dark) { body { background: #0d1117; color: #c9d1d9; } code, pre { background: #161b22 !important; } th { background: #161b22 !important; } }
  h1,h2,h3,h4,h5,h6 { line-height: 1.3; margin: 1.4em 0 0.6em; font-weight: 700; }
  h1 { font-size: 2em; border-bottom: 2px solid rgba(132,204,22,.4); padding-bottom: .3em; }
  h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
  a { color: #2563eb; } img { max-width: 100%; border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  td, th { border: 1px solid #d0d7de; padding: 7px 12px; }
  th { background: #f6f8fa; }
  pre { background: #f6f8fa; padding: 14px; border-radius: 8px; overflow-x: auto; }
  code { font-family: 'SFMono-Regular', Consolas, monospace; font-size: .9em; }
  :not(pre) > code { background: rgba(132,204,22,.14); padding: 2px 5px; border-radius: 4px; }
  blockquote { border-left: 4px solid #84cc16; margin: 1em 0; padding: 4px 16px; color: #57606a; background: rgba(132,204,22,.06); }
  ul,ol { padding-left: 1.6em; } mark { background: #fff3a3; padding: 0 2px; }
  hr { border: none; border-top: 1px solid #d0d7de; margin: 2em 0; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`
  if (isNativeApp()) {
    nativeExportText(`${title}.html`, docHtml).then(notifyNativeExport)
    return
  }
  const blob = new Blob([docHtml], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${title}.html`
  link.click()
  URL.revokeObjectURL(url)
  notify(t('export_html'))
}

// ========== Shortcuts cheatsheet ==========
const shortcutsOpen = ref(false)
const openShortcuts = () => { shortcutsOpen.value = true }
const shortcutRows = computed(() => ([
  { k: 'Ctrl + F', d: lang.value === 'zh' ? '查找' : 'Find' },
  { k: 'Ctrl + H', d: lang.value === 'zh' ? '查找替换' : 'Find & replace' },
  { k: 'Ctrl + P', d: lang.value === 'zh' ? '快速打开文件' : 'Quick open file' },
  { k: 'Ctrl + S', d: lang.value === 'zh' ? '保存' : 'Save' },
  { k: 'Ctrl + /', d: lang.value === 'zh' ? '切换单栏 / 分栏' : 'Toggle single / split view' },
  { k: 'Ctrl + Z / Y', d: lang.value === 'zh' ? '撤销 / 重做' : 'Undo / Redo' },
  { k: 'Ctrl + B / I / U', d: lang.value === 'zh' ? '加粗 / 斜体 / 下划线' : 'Bold / Italic / Underline' },
  { k: 'Ctrl + Shift + X', d: lang.value === 'zh' ? '删除线' : 'Strikethrough' },
  { k: 'Ctrl + Tab', d: lang.value === 'zh' ? '切换标签页' : 'Switch tab' },
  { k: 'Ctrl + ' + (lang.value === 'zh' ? '滚轮' : 'Wheel'), d: lang.value === 'zh' ? '缩放界面' : 'Zoom UI' },
  { k: 'Ctrl + 0', d: lang.value === 'zh' ? '重置缩放' : 'Reset zoom' },
  { k: lang.value === 'zh' ? '双击图片' : 'Double-click image', d: lang.value === 'zh' ? '放大查看' : 'Open viewer' },
  { k: 'Esc', d: lang.value === 'zh' ? '关闭弹层' : 'Close overlay' }
]))

// ========== Rich editor (single mode, TipTap) ==========
const richEditorRef = ref(null)
const largeRichEditorRef = ref(null)

// The editor works with real data URLs; the document model keeps compact
// knote-img references. Convert at this boundary in both directions.
const richMarkdown = computed({
  // editor DISPLAYS relative-path images as data URLs; on the way back in,
  // swap them to relative paths again so `content` never inlines them
  get: () => relPathsToDataUrls(exportableMarkdown()),
  set: (v) => {
    content.value = importMarkdown(dataUrlsToRelPaths(v || ''))
  }
})

// TipTap cannot incrementally build one ProseMirror tree for an entire huge
// document. Structurally expensive files therefore keep one bounded rich-text
// chunk mounted at a time while `content` remains the complete Markdown source.
const LARGE_EDITOR_PROGRESSIVE_THRESHOLD = 750_000
const richEditorHold = ref(null)
const largeDocumentLoading = ref(false)
const largeDocumentPlainMode = ref(false)
const largeSourceOffsets = ref([0, 0])
const largeSourcePage = ref(0)
const largeSourceDraft = ref('')
const largeSourcePageCount = computed(() => Math.max(1, largeSourceOffsets.value.length - 1))
let largeEditorLoadGeneration = 0

const LARGE_SOURCE_DRAFT_IDLE_MS = 900
let largeSourceCommittedDraft = ''
let largeSourceDraftDirty = false
let largeSourceDraftCommitTimer = null
let largeSourceDraftSelection = 0
const largeSourceEditorVersion = ref(0)

const cancelLargeSourceDraftCommit = () => {
  if (largeSourceDraftCommitTimer != null) clearTimeout(largeSourceDraftCommitTimer)
  largeSourceDraftCommitTimer = null
}

const prepareLargeSourceDocument = (sourceValue, requestedPage = 0) => {
  cancelLargeSourceDraftCommit()
  const source = String(sourceValue || '')
  const offsets = buildLargeSourceOffsets(source, LARGE_SOURCE_CHUNK_SIZE)
  const pageState = readLargeSourcePage(source, offsets, requestedPage)
  largeSourceOffsets.value = offsets
  largeSourcePage.value = pageState.page
  largeSourceDraft.value = pageState.draft
  largeSourceCommittedDraft = pageState.draft
  largeSourceDraftSelection = 0
  largeSourceDraftDirty = false
  largeSourceEditorVersion.value++
}

// The only bridge from the bounded rich chunk back into the immutable full
// document. Keystrokes never touch content.value; natural idle and every
// navigation/save/quit boundary call this once for the whole edit burst.
const commitLargeSourceDraft = (_reason = 'boundary') => {
  cancelLargeSourceDraftCommit()
  if (!largeDocumentPlainMode.value || !largeSourceDraftDirty) return false
  const applied = applyLargeSourcePageDraft(
    content.value,
    largeSourceOffsets.value,
    largeSourcePage.value,
    largeSourceDraft.value
  )
  largeSourceDraftDirty = false
  if (!applied.changed) {
    largeSourceCommittedDraft = largeSourceDraft.value
    return false
  }
  const rebalanced = rebalanceLargeSourceView(
    applied.source,
    applied.offsets,
    applied.page,
    largeSourceDraftSelection,
    LARGE_SOURCE_CHUNK_SIZE,
    applied.requiresOffsetRebuild
  )
  if (rebalanced) {
    largeSourceOffsets.value = rebalanced.offsets
    largeSourcePage.value = rebalanced.page
    largeSourceDraft.value = rebalanced.draft
    largeSourceCommittedDraft = rebalanced.draft
    largeSourceDraftSelection = rebalanced.caret
    largeSourceEditorVersion.value++
  } else {
    largeSourceOffsets.value = applied.offsets
    largeSourceCommittedDraft = largeSourceDraft.value
  }
  content.value = applied.source
  return true
}

const scheduleLargeSourceDraftCommit = () => {
  cancelLargeSourceDraftCommit()
  if (!largeSourceDraftDirty) return
  largeSourceDraftCommitTimer = setTimeout(() => {
    largeSourceDraftCommitTimer = null
    commitLargeSourceDraft('idle')
  }, LARGE_SOURCE_DRAFT_IDLE_MS)
}

const openLargeSourcePage = (page) => {
  if (largeRichEditorRef.value?.flushEmit) largeRichEditorRef.value.flushEmit()
  commitLargeSourceDraft('page-change')
  const pageState = readLargeSourcePage(content.value, largeSourceOffsets.value, page)
  largeSourcePage.value = pageState.page
  largeSourceDraft.value = pageState.draft
  largeSourceCommittedDraft = pageState.draft
  largeSourceDraftDirty = false
  largeSourceDraftSelection = 0
  largeSourceEditorVersion.value++
  nextTick(() => {
    largeRichEditorRef.value?.focusEditor?.()
  })
}
const largeRichMarkdown = computed({
  get: () => relPathsToDataUrls(exportableMarkdown(largeSourceDraft.value)),
  set: (value) => {
    cancelSessionRestoreForForegroundIntent()
    const nextDraft = importMarkdown(dataUrlsToRelPaths(value || ''))
    largeSourceDraftSelection = estimateLargeSourceDraftCaret(largeSourceDraft.value, nextDraft)
    largeSourceDraft.value = nextDraft
    largeSourceDraftDirty = nextDraft !== largeSourceCommittedDraft
    if (nextDraft.length > LARGE_SOURCE_CHUNK_SIZE * 2) {
      commitLargeSourceDraft('oversized-rich-input')
      return
    }
scheduleLargeSourceDraftCommit()
  }
})
const largeRenderedHtml = computed(() => renderMarkdownHtml(largeSourceDraft.value))
watch(() => viewMode.value === 'split' && largeDocumentPlainMode.value ? largeRenderedHtml.value : null, (html) => {
  if (html != null) renderPreviewMermaid()
}, { flush: 'post' })
const richEditorModel = computed({
  get: () => richEditorHold.value == null ? richMarkdown.value : richEditorHold.value,
  set: (value) => {
    // A stale emission from the editor that belongs to the previous tab must
    // not overwrite the newly installed document while the loading veil is up.
    if (richEditorHold.value != null) return
    richMarkdown.value = value
  }
})
const nextAnimationFrame = () => new Promise((resolve) => {
  if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(resolve)
  else setTimeout(resolve, 16)
})
const stageLargeEditorLoad = (nextContent, options = {}) => {
  const generation = ++largeEditorLoadGeneration
  const length = String(nextContent || '').length
  const plain = shouldUsePagedSource(nextContent)
  if (plain) {
    // Vue unmounts the whole-document editor before content changes, then the
    // bounded rich editor parses only the selected chunk. Offset generation is
    // deferred to its own frame so a dense multi-megabyte line scan cannot
    // merge with file installation and editor mounting into one long task.
    richEditorHold.value = null
    largeDocumentPlainMode.value = true
    largeDocumentLoading.value = true
    viewMode.value = 'single'
    cancelLargeSourceDraftCommit()
    largeSourceOffsets.value = [0, 0]
    largeSourcePage.value = 0
    largeSourceDraft.value = ''
    largeSourceCommittedDraft = ''
    largeSourceDraftDirty = false
    const plainPreparation = nextAnimationFrame().then(() => {
      if (generation !== largeEditorLoadGeneration) return false
      prepareLargeSourceDocument(nextContent, options.sourcePage)
      return true
    })
    return { generation, staged: false, plain: true, plainPreparation }
  }
  largeDocumentPlainMode.value = false
  const staged = viewMode.value === 'single' &&
    length >= LARGE_EDITOR_PROGRESSIVE_THRESHOLD &&
    options.restoreState !== true
  if (!staged) {
    richEditorHold.value = null
    largeDocumentLoading.value = false
    return { generation, staged: false, plain: false }
  }
  // Read the current computed model before the document ref changes. Vue keeps
  // the same immutable string; this does not clone its bytes.
  richEditorHold.value = richMarkdown.value
  largeDocumentLoading.value = true
  return { generation, staged: true, plain: false }
}
const releaseLargeEditorLoad = async (load) => {
  if (load?.plainPreparation) {
    const prepared = await load.plainPreparation
    if (!prepared || load.generation !== largeEditorLoadGeneration) return
    await nextTick()
    await nextAnimationFrame()
    if (load.generation === largeEditorLoadGeneration) largeDocumentLoading.value = false
    return
  }
  if (!load?.staged) return
  await nextTick()
  await nextAnimationFrame()
  await nextAnimationFrame()
  if (load.generation !== largeEditorLoadGeneration) return
  // The v-model watcher performs the one required parse when this changes.
  // Do not call forceSync as well.
  richEditorHold.value = null
  await nextTick()
  await nextAnimationFrame()
  if (load.generation === largeEditorLoadGeneration) largeDocumentLoading.value = false
}

// Whole-document mutations must update the full source and its bounded editor
// state as one operation. Directly assigning `content` while paged mode is
// active leaves offsets pointing into the previous string; the next chunk
// commit can then splice an edit into unrelated text.
const replaceWholeDocumentContent = (value, options = {}) => {
  const nextContent = String(value || '')
  const editorLoad = stageLargeEditorLoad(nextContent, {
    sourcePage: options.sourcePage ?? largeSourcePage.value
  })
  content.value = nextContent
  void releaseLargeEditorLoad(editorLoad)
  return nextContent
}

// Android tablets transfer document scrolling from the app root to the rich
// editor viewport. Keep every navigation/capture path on that same owner.
const androidTabletDocumentScroller = () => {
  if (!isAndroidTablet.value || viewMode.value !== 'single') return null
  return document.querySelector('.knote-workbench[data-view-mode="single"] > section .knote-doc-scroll')
}
const documentScrollOwner = () => (
  androidTabletDocumentScroller() || document.querySelector('.knote-root')
)
const restoreDocumentScrollTop = (scrollTop = 0) => {
  const owner = documentScrollOwner()
  if (owner) owner.scrollTop = Math.max(0, Number(scrollTop) || 0)
}
// ========== Agent (AI assistant) ==========
// Document bridge: the agent reads the compact model (knote-img refs) and
// writes back through importMarkdown so inserted data-URL images register
// in the imageStore automatically.
agentBridge.getMarkdown = () => {
  // the agent must read the CURRENT document, not the debounced mirror
  if (richEditorRef.value && richEditorRef.value.flushEmit) richEditorRef.value.flushEmit()
  if (largeRichEditorRef.value && largeRichEditorRef.value.flushEmit) largeRichEditorRef.value.flushEmit()
  commitLargeSourceDraft('agent-read')
  return content.value
}
// Stable target identity for the Agent execution ledger. A successful tool
// call can only be credited to the exact document it was issued against.
agentBridge.getDocumentIdentity = () => agentDocumentKey()
agentBridge.getWorkspaceIdentity = () => agentWorkspaceIdentity()
agentBridge.getActiveFilePath = () => {
  if (activeTreePath.value) return String(activeTreePath.value).replace(/^\/+/, '')
  if (currentFileHandle.value && currentFileHandle.value._deskPath) return currentFileHandle.value._deskPath
  return currentFileName.value || ''
}
agentBridge.isCurrentDocumentEditable = () => {
  if (activeTreePath.value) {
    const node = walkTreeFiles(folderTree.value, []).find((item) => item.path === activeTreePath.value)
    return !!node && node.ftype === 'md'
  }
  if (folderHandle.value && !currentFileName.value) return false
  return !docPreviewHtml.value && !pdfView.value
}
agentBridge.applyMarkdown = (md) => {
  resetEditingState()
  const nextContent = importMarkdown(md || '')
  const editorLoad = stageLargeEditorLoad(nextContent)
  content.value = nextContent
  // push the change into the editor's undo history so Ctrl+Z reverts an
  // accepted agent edit; the direct call sets lastEmitted, so the modelValue
  // watcher skips its own history-less sync of the same value
  if (!editorLoad.plain && !editorLoad.staged && viewMode.value === 'single' && richEditorRef.value) {
    richEditorRef.value.applyExternal(richMarkdown.value)
  }
  void releaseLargeEditorLoad(editorLoad)
  // accepted agent edits may reference on-disk images that were never in the
  // doc before (relImages is only scanned at open time) — rescan so fresh
  // `assets/…` refs resolve instead of staying broken
  const dir = docDir.value || folderHandle.value
  if (dir) loadRelativeImages(dir)
}
agentBridge.scrollToLine = (line) => {
  const total = Math.max(1, content.value.split('\n').length)
  // desktop shell: the app root is the scroll container (the document
  // doesn't scroll there — the title bar strip must stay clear)
  const root = document.querySelector('.knote-root')
  const local = androidTabletDocumentScroller()
  const el = local || ((root && root.scrollHeight > root.clientHeight + 1) ? root : document.scrollingElement)
  if (el) el.scrollTo({ top: (el.scrollHeight - el.clientHeight) * Math.min(1, line / total), behavior: 'smooth' })
}
// In-document diff of the staged hunks (red tint on old blocks + green boxes
// with per-hunk ✓/✕). Every deferred paint owns an exact document + monotonic
// epoch so a tab restore or an already-accepted hunk cannot repaint stale DOM.
let agentPreviewEpoch = 0
const scheduleAgentPreviewResync = ({ clear = false } = {}) => {
  const epoch = ++agentPreviewEpoch
  const documentKey = agentDocumentKey()
  if (clear) richEditorRef.value?.clearAgentPreview?.()
  nextTick(() => {
    if (epoch !== agentPreviewEpoch || documentKey !== agentDocumentKey()) return
    resyncAgentPreview()
  })
}
agentBridge.previewChange = (payload) => {
  const epoch = ++agentPreviewEpoch
  const documentKey = agentDocumentKey()
  nextTick(() => {
    if (epoch !== agentPreviewEpoch || documentKey !== agentDocumentKey()) return
    if (viewMode.value === 'single' && richEditorRef.value) {
      richEditorRef.value.setAgentPreview({ ...payload, renderRevision: epoch })
    }
  })
}
agentBridge.clearPreview = () => {
  ++agentPreviewEpoch
  richEditorRef.value?.clearAgentPreview?.()
}

// Folder workspace: read-only visibility into the opened folder's .md files
const walkTreeFiles = (nodes, out) => {
  for (const n of nodes) {
    if (n.kind === 'dir') walkTreeFiles(n.children, out)
    else out.push(n)
  }
  return out
}
// Read a tree file node as raw bytes. Desktop reads via IPC — the native
// adapter's getFile() decodes utf8 and would corrupt binary (see
// resolveRelImagePath). Returns { bytes, mime, dataUrl } | null.
const readNodeBytes = async (node, workspaceRoot = folderHandle.value) => {
  if (!node || node.kind !== 'file') return null
  const deskRoot = workspaceRoot && workspaceRoot._deskPath
  if (deskRoot && window.knoteDesktop && window.knoteDesktop.readFileBytes) {
    const sep = deskRoot.includes('\\') ? '\\' : '/'
    const rel = String(node.path).replace(/^\//, '').split('/').join(sep)
    const abs = deskRoot.replace(/[\\/]$/, '') + sep + rel
    const r = await window.knoteDesktop.readFileBytes(abs)
    if (!r || !r.base64) return null
    const bin = atob(r.base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { bytes, mime: r.mime, dataUrl: `data:${r.mime};base64,${r.base64}` }
  }
  // browser File System Access: getFile() returns a real (binary-safe) File
  const f = await node.handle.getFile()
  const bytes = new Uint8Array(await f.arrayBuffer())
  const dataUrl = await new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = rej; rd.readAsDataURL(f) })
  return { bytes, mime: f.type || '', dataUrl }
}
// ---- in-editor read-only PDF viewer ----
// pdfView overlays the editor/preview area with the whole PDF (all pages),
// scrollable + zoomable but not editable. pdfViewGen aborts an in-flight render
// when the user closes the viewer or opens another file mid-render.
const pdfView = ref(null) // { name, path, returnPath, returnScrollTop, returnTabId, loading } | null
const pdfPageNum = ref(1)
const pdfNumPages = ref(0)
const pdfScalePct = ref(0)
const pdfHostRef = ref(null)
let pdfViewGen = 0
let pendingPdfScrollRestore = null
const closePdfView = () => {
  pdfViewGen++
  const closing = pdfView.value
  if (closing && activeTreePath.value === closing.path && closing.returnPath != null) {
    activeTreePath.value = closing.returnPath
  }
  if (pdfHostRef.value) pdfHostRef.value.closePdf()
  pdfView.value = null
  if (closing) {
    setViewMode('single')
    const pending = {
      tabId: closing.returnTabId ?? activeTabId.value,
      treePath: closing.returnPath ?? '',
      scrollTop: Math.max(0, Number(closing.returnScrollTop) || 0)
    }
    pendingPdfScrollRestore = pending
    nextTick(() => {
      if (pendingPdfScrollRestore !== pending) return
      pendingPdfScrollRestore = null
      if (pdfView.value || activeTabId.value !== pending.tabId || activeTreePath.value !== pending.treePath) return
      const local = androidTabletDocumentScroller()
      if (local) local.scrollTop = pending.scrollTop
      else {
        const root = document.querySelector('.knote-root')
        if (root) root.scrollTop = pending.scrollTop
      }
    })
  }
}
const openPdfInEditor = async (node, stillCurrent = () => true) => {
  const gen = ++pdfViewGen
  const returnPath = pdfView.value?.returnPath ?? activeTreePath.value
  const scrollOwner = documentScrollOwner()
  const pendingReturn = pendingPdfScrollRestore?.tabId === activeTabId.value
    ? pendingPdfScrollRestore
    : null
  const returnScrollTop = pdfView.value?.returnScrollTop ?? pendingReturn?.scrollTop ?? scrollOwner?.scrollTop ?? 0
  const returnTabId = pdfView.value?.returnTabId ?? activeTabId.value
  const abandonIfOwned = () => {
    if (gen === pdfViewGen) closePdfView()
    return false
  }
  let r
  try { r = await readNodeBytes(node) } catch { r = null }
  if (gen !== pdfViewGen) return false
  if (!stillCurrent()) return abandonIfOwned() // superseded while reading bytes
  if (!r || !r.bytes) {
    notify(lang.value === 'zh' ? '读不到该 PDF' : 'Could not read the PDF')
    return abandonIfOwned()
  }
  setViewMode('single')
  pdfView.value = { name: node.name, path: node.path, returnPath, returnScrollTop, returnTabId, loading: true }
  pdfPageNum.value = 1
  pdfNumPages.value = 0
  pdfScalePct.value = 0
  activeTreePath.value = node.path
  await nextTick()
  if (gen !== pdfViewGen || !pdfView.value) return false
  if (!stillCurrent()) return abandonIfOwned()
  try {
    await pdfHostRef.value.openPdf(r.bytes)
  } catch (err) {
    console.error('open pdf error:', err)
    if (gen === pdfViewGen && stillCurrent()) {
      notify(`${lang.value === 'zh' ? 'PDF 渲染失败' : 'PDF render failed'}：${String((err && err.message) || err)}`)
    }
  } finally {
    if (gen === pdfViewGen && !stillCurrent()) abandonIfOwned()
    else if (gen === pdfViewGen && pdfView.value) pdfView.value.loading = false
  }
  return gen === pdfViewGen && stillCurrent()
}
const onPdfReady = ({ numPages }) => {
  pdfNumPages.value = numPages || 0
  if (pdfView.value) pdfView.value.loading = false
  const host = pdfHostRef.value
  if (host) pdfScalePct.value = Math.round(host.currentScale() * 100)
}
const onPdfPageChange = (pageNumber) => { pdfPageNum.value = pageNumber }
const onPdfScaleChange = (scale) => { pdfScalePct.value = Math.round((Number(scale) || 1) * 100) }
const onPdfError = (err) => {
  console.error('pdf viewer error:', err)
  if (pdfView.value) notify(`${lang.value === 'zh' ? 'PDF 渲染失败' : 'PDF render failed'}：${String((err && err.message) || err)}`)
}
const pdfZoom = (dir) => {
  const host = pdfHostRef.value
  if (!host || !pdfView.value) return
  if (dir > 0) host.zoomIn(); else host.zoomOut()
  pdfScalePct.value = Math.round(host.currentScale() * 100)
}
// Office and HTML documents never preview in-app on desktop: hand them to the
// OS default application. The web build has no such escape hatch, so it falls
// back to the existing read-only extraction path.
const OFFICE_FTYPES = ['docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp']
const treeFileOpensWithSystemApp = (node) => OFFICE_FTYPES.includes(node?.ftype) || /\.html?$/i.test(node?.name || '')
const openNodeWithSystemApp = async (node) => {
  const p = nodeDeskPath(node)
  if (!p || !window.knoteDesktop || !window.knoteDesktop.openPath) return false
  try {
    const r = await window.knoteDesktop.openPath(p)
    if (r && r.ok === false) throw new Error(r.error || 'open failed')
  } catch (err) {
    console.error('Open with system app error:', err)
    globalThis.alert(`${t('ctx_open')} 失败：${String(err.message || err)}`)
  }
  return true // handled (even on failure — never fall back to an in-app preview)
}
// Preview a pdf/image/doc tree node.
const previewTreeAsset = async (node, stillCurrent = () => true) => {
  if (!stillCurrent()) return false
  if (node.ftype === 'pdf') {
    closeDocPreview()
    return await openPdfInEditor(node, stillCurrent)
  }
  // Office and HTML/HTM: open with the system default app (desktop).
  if (treeFileOpensWithSystemApp(node) && await openNodeWithSystemApp(node)) return false
  // txt/csv/rtf (and office docs in the web build): extract text, show as read-only
  if (detectFtype(node.name)) {
    closePdfView()
    try {
      const r = await readNodeBytes(node)
      if (!stillCurrent()) return false
      if (!r || !r.bytes) {
        return openDocPreview(node.name, '<p>（读取失败 — 无法读取文件字节）</p>', node.path, stillCurrent)
      }
      // Create a Blob from bytes so readDocumentFile gets a proper File-like object
      const blob = new Blob([r.bytes], { type: r.mime || '' })
      const file = new File([blob], node.name, { type: r.mime || '' })
      const result = await readDocumentFile(file)
      if (!stillCurrent()) return false
      const html = (result && result.html) ? result.html : `<p>（未能提取内容 — ${detectFtype(node.name)?.toUpperCase() || '?'}）</p>`
      return openDocPreview(node.name, html, node.path, stillCurrent)
    } catch (err) {
      console.error('preview doc error:', err)
      if (!stillCurrent()) return false
      return openDocPreview(node.name, `（读取失败：${err.message || err}）`, node.path, stillCurrent)
    }
  }
  try {
    const r = await readNodeBytes(node)
    if (!stillCurrent()) return false
    if (r && r.dataUrl && node.ftype === 'image') {
      openImageViewer({ src: r.dataUrl, alt: node.name })
      return true
    }
  } catch (err) { console.error('preview asset error:', err) }
  return false
}

// Show extracted document as a read-only HTML preview in the editor area.
// Unlike PDF (which renders pages as images), docx/pptx/xlsx use mammoth/JSZip
// to produce styled HTML that renders directly in the preview section.
const docPreviewHtml = ref('')
const closeDocPreview = () => { docPreviewHtml.value = '' }

const openDocPreview = (name, html, treePath = null, stillCurrent = () => true) => {
  if (!stillCurrent()) return false
  closePdfView()
  // Office/OpenDocument files are untrusted input. Both mammoth and the ZIP
  // readers intentionally preserve document HTML/text, so sanitize at the
  // single v-html sink before rendering it in the application.
  docPreviewHtml.value = html
    ? sanitizeHtml(html)
    : `<p class="text-base-content/40 italic">（未能提取内容）</p>`
  // still set content so the current file name / read-only state is visible
  const navigationOwner = beginNavigationInstall()
  try {
    bumpAgentDocumentGeneration(activeTab && activeTab())
    cancelAutoSave()
    resetEditingState()
    clearRelImages()
    currentFileHandle.value = null
    currentFileName.value = name
    isLocalFile.value = false
    activeTreePath.value = treePath
    replaceWholeDocumentContent('')
    undoStack.value = []
    redoStack.value = []
    lastSavedSnapshot = { content: '', selection: null }
    docDir.value = null
  } finally {
    nextTick(() => { finishNavigationInstall(navigationOwner) })
  }
  return true
}
// Agent file operations receive an immutable run binding. A long tool call may
// outlive a tab/workspace switch; using the live refs after an await could then
// read or mutate the newly visible workspace. The binding keeps every operation
// on the folder handle captured when the run started.
const currentAgentWorkspaceBinding = (tb = activeTab && activeTab()) => {
  const isActive = !!tb && tb.id === activeTabId.value
  const handle = isActive ? folderHandle.value : tb?.folderHandle
  if (!handle) return null
  return {
    id: agentWorkspaceIdentityForTab(tb),
    handle,
    name: isActive ? folderName.value : tb.folderName,
    activePath: isActive ? activeTreePath.value : tb.treePath,
    tree: isActive ? folderTree.value : tb.folderTree,
    // Relative image resolution belongs to the active document at run start.
    // Never consult another tab's live image map after a workspace switch.
    relativeImages: isActive ? { ...relImages } : {}
  }
}

const openLegacyNativeWorkspace = async () => {
  if (!isAndroidNative) return
  cancelSessionRestoreForForegroundIntent()
  const androidIntent = beginAndroidStorageIntent()
  const stillCurrent = () => androidIntent === androidStorageIntentGeneration
  if (!await prepareAndroidStorageReplacement() || !stillCurrent()) return
  try {
    const handle = await openNativeWorkspace()
    if (!stillCurrent()) return
    if (!handle) {
      globalThis.alert(t('folder_unsupported'))
      return
    }
    if (await adoptFolderHandle(handle, handle.name, '', stillCurrent)) {
      if (!stillCurrent()) return
      await rememberAndroidStorage('legacy')
      mobileFilesOpen.value = false
    }
  } catch (error) {
    console.error('Open legacy workspace error:', error)
    globalThis.alert(t('folder_unsupported'))
  }
}
const resolveAgentWorkspaceBinding = (options = {}) => {
  const expected = String(options && options.workspaceId || '')
  const supplied = options && options.workspaceBinding
  if (supplied && supplied.handle && (!expected || sameDeskKey(supplied.id, expected))) return supplied
  const current = currentAgentWorkspaceBinding()
  if (!current || (expected && !sameDeskKey(current.id, expected))) return null
  return current
}
const refreshAgentWorkspaceBinding = async (binding) => {
  if (!binding || !binding.handle) return null
  const tree = await buildFolderTree(binding.handle)
  binding.tree = tree
  if (folderHandle.value === binding.handle) folderTree.value = tree
  // Keep every background tab for this physical workspace coherent without
  // ever installing its tree into an unrelated active tab.
  for (const tb of tabs.value) {
    if (tb.folderHandle === binding.handle) tb.folderTree = tree
  }
  return tree
}
const treeNodeInBinding = (binding, relPath) => {
  if (!binding) return null
  const norm = '/' + String(relPath).replace(/\\/g, '/').replace(/^\/+/, '')
  return walkTreeFiles(binding.tree || [], []).find((n) => n.path === norm) || null
}
agentBridge.captureWorkspace = (documentBinding = null) => currentAgentWorkspaceBinding(documentBinding?.tab || (activeTab && activeTab()))
agentBridge.hasFolder = (options) => !!resolveAgentWorkspaceBinding(options)
agentBridge.folderName = (options) => {
  const binding = resolveAgentWorkspaceBinding(options)
  return binding ? binding.name : ''
}
agentBridge.refreshWorkspace = async (options) => {
  const binding = resolveAgentWorkspaceBinding(options)
  if (!binding) return null
  return await refreshAgentWorkspaceBinding(binding)
}
agentBridge.listFiles = (options) => {
  const binding = resolveAgentWorkspaceBinding(options)
  if (!binding) return null
  const activePath = binding.activePath || ''
  return walkTreeFiles(binding.tree || [], []).map((n) => ({
    path: n.path.replace(/^\//, ''),
    kind: n.ftype || 'md',
    active: n.path === activePath
  }))
}
agentBridge.readFile = async (path, options) => {
  const binding = resolveAgentWorkspaceBinding(options)
  if (!binding) return null
  const node = treeNodeInBinding(binding, path)
  if (!node) return null
  try {
    // Office docs: extract text via fileReader. That needs REAL bytes — the
    // desktop tree handle's getFile() has no arrayBuffer() — so read through
    // readNodeBytes (binary-safe on desktop and web) like previewTreeAsset.
    // Everything else (md/txt/csv/rtf) is returned as plain text: routing md
    // through readDocumentFile would hit its no-md fallback and come back ''.
    if (OFFICE_FTYPES.includes(detectFtype(node.name))) {
      const r = await readNodeBytes(node, binding.handle)
      if (!r || !r.bytes) return null
      const file = new File([new Blob([r.bytes])], node.name, { type: r.mime || '' })
      const result = await readDocumentFile(file)
      return result ? result.text : ''
    }
    const r = await readNodeBytes(node, binding.handle)
    if (!r || !r.bytes) return null
    // Text edits are UTF-8 only. Fatal decoding prevents a GBK/UTF-16 source
    // file from being silently decoded with replacement characters and then
    // overwritten as corrupt UTF-8.
    return new TextDecoder('utf-8', { fatal: true }).decode(r.bytes)
  } catch { return null }
}
// read a workspace pdf/image node as bytes — binary-safe on both desktop and
// browser (see readNodeBytes). Returns { bytes, mime, dataUrl, name, ftype } | null.
agentBridge.readFileBinary = async (path, options) => {
  const binding = resolveAgentWorkspaceBinding(options)
  if (!binding) return null
  const node = treeNodeInBinding(binding, path)
  if (!node) return null
  try {
    const r = await readNodeBytes(node, binding.handle)
    return r ? { ...r, name: node.name, ftype: node.ftype } : null
  } catch { return null }
}
// Create a NEW UTF-8 workspace file. Extensionless build/config filenames are
// first-class text files; other extensionless paths keep the .md default.
// The shared writer validates the file type, requires an existing parent,
// reserves collision candidates, and never overwrites an existing file.
agentBridge.writeFile = async (relPath, content, options) => {
  const binding = resolveAgentWorkspaceBinding(options)
  if (!binding) return { ok: false, code: 'WORKSPACE_CHANGED', reason: 'workspace_binding_unavailable' }
  const result = await createAgentWorkspaceFile(binding.handle, relPath, content, {
    reservationScope: binding.id,
    exactName: options?.exactCreatePath === true
  })
  if (result.ok) {
    try { await refreshAgentWorkspaceBinding(binding) } catch { /* tree refresh best-effort */ }
  }
  return result
}
agentBridge.workspaceTraversal = (options) => {
  const binding = resolveAgentWorkspaceBinding(options)
  const report = binding?.tree?._agentTraversal
  return report || { complete: true, depthLimit: 12, omittedPaths: [] }
}
// Overwrite an EXISTING workspace file (agent edit_file). The heavy guard
// rails (read-first freshness gate, exact-match splice) live in the store;
// here we only refuse paths that are open in a tab — a disk write would
// silently desync the in-memory copy, and the tab's next auto-save would
// clobber the agent's edit.
agentBridge.updateFile = async (relPath, newContent, options) => {
  const binding = resolveAgentWorkspaceBinding(options)
  if (!binding) return { ok: false, error: 'workspace_changed' }
  // Generic document providers do not expose an atomic compare-and-swap
  // primitive. Keep direct Agent edits fail-closed; edits to the active
  // document still flow through the reviewed editor/save pipeline.
  if (String(binding.handle?._knoteIdentity || '').startsWith('android-saf:')) {
    return { ok: false, error: 'unsupported' }
  }
  try {
    const segs = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean)
    if (!segs.length) return { ok: false, error: 'bad_path' }
    const p = segs.join('/')
    const rootDesk = binding.handle && binding.handle._deskPath
    const initialNode = treeNodeInBinding(binding, p)
    const absoluteMutationPath = workspaceFileAbsolutePath(binding.handle, p)
    const mutationKey = await resolveFileMutationKey(binding.handle, binding.id, p, initialNode?.handle)
    return await withAsyncKeyLock(mutationKey, async () => {
    // tree paths carry a LEADING slash ('/notes/a.md') — compare in that
    // domain or the guard silently never fires
    const tp = '/' + p
    const normP = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    // desktop absolute path of the target, for tabs holding the SAME physical
    // file opened as a single file (file association / native dialog): those
    // tabs have no treePath, only a deskKey ('file:<abs>')
    const absTarget = rootDesk ? normP(rootDesk) + '/' + p.toLowerCase() : null
    const targetOpenInTab = () => (folderHandle.value === binding.handle && activeTreePath.value === tp && !!currentFileHandle.value) ||
      tabs.value.some((tb) =>
        (tb.folderHandle === binding.handle && tb.treePath === tp && !!tb.fileHandle) ||
        (absTarget && typeof tb.deskKey === 'string' && tb.deskKey.startsWith('file:') && normP(tb.deskKey.slice(5)) === absTarget))
    if (targetOpenInTab()) return { ok: false, error: 'open_in_tab' }
    const fname = segs.pop()
    if (!isAgentEditableTextFile(fname)) return { ok: false, error: 'unsupported_type' }
    let dir = binding.handle
    for (const s of segs) dir = await dir.getDirectoryHandle(s) // no create — must exist
    const fh = await dir.getFileHandle(fname)
    // Refuse non-UTF-8 source/config files rather than transcoding them.
    const existingNode = treeNodeInBinding(binding, p)
    if (!existingNode) return { ok: false, error: 'not_found' }
    const existing = await readNodeBytes(existingNode, binding.handle)
    if (!existing || !existing.bytes) return { ok: false, error: 'read_failed' }
    let existingText
    try { existingText = new TextDecoder('utf-8', { fatal: true }).decode(existing.bytes) } catch {
      return { ok: false, error: 'unsupported_encoding' }
    }
    if (options && Object.prototype.hasOwnProperty.call(options, 'expectedContent') &&
        existingText !== String(options.expectedContent)) {
      return { ok: false, error: 'stale_file' }
    }
    const hadUtf8Bom = existing.bytes.length >= 3 &&
      existing.bytes[0] === 0xef && existing.bytes[1] === 0xbb && existing.bytes[2] === 0xbf
    const output = hadUtf8Bom && !String(newContent ?? '').startsWith('\uFEFF')
      ? '\uFEFF' + String(newContent ?? '')
      : String(newContent ?? '')
    if (rootDesk) {
      if (typeof window.knoteDesktop?.fsWriteIfUnchanged !== 'function') return { ok: false, error: 'unsupported' }
      if (targetOpenInTab()) return { ok: false, error: 'open_in_tab' }
      const expectedDiskContent = hadUtf8Bom ? '\uFEFF' + existingText : existingText
      const result = await window.knoteDesktop.fsWriteIfUnchanged(absoluteMutationPath, output, expectedDiskContent)
      if (!result?.ok) return {
        ok: false,
        error: result?.stale ? 'stale_file' : String(result?.error || 'write_failed')
      }
    } else {
      // Browser FSA keeps its writable lock plus repeated exact checks because
      // there is no trusted main-process mutation lane in that environment.
      const w = await fh.createWritable()
      const abortWrite = async () => {
        try { if (typeof w.abort === 'function') await w.abort() } catch { /* best-effort */ }
      }
      if (targetOpenInTab()) { await abortWrite(); return { ok: false, error: 'open_in_tab' } }
      const latest = await readNodeBytes(existingNode, binding.handle)
      let latestText
      try { latestText = latest && latest.bytes ? new TextDecoder('utf-8', { fatal: true }).decode(latest.bytes) : null } catch {
        await abortWrite()
        return { ok: false, error: 'unsupported_encoding' }
      }
      if (latestText !== existingText) { await abortWrite(); return { ok: false, error: 'stale_file' } }
      await w.write(output)
      if (targetOpenInTab()) { await abortWrite(); return { ok: false, error: 'open_in_tab' } }
      const beforeCommit = await readNodeBytes(existingNode, binding.handle)
      let beforeCommitText
      try { beforeCommitText = beforeCommit && beforeCommit.bytes ? new TextDecoder('utf-8', { fatal: true }).decode(beforeCommit.bytes) : null } catch {
        await abortWrite()
        return { ok: false, error: 'unsupported_encoding' }
      }
      if (beforeCommitText !== existingText) { await abortWrite(); return { ok: false, error: 'stale_file' } }
      await w.close()
    }
    try { await refreshAgentWorkspaceBinding(binding) } catch { /* tree refresh best-effort */ }
    // A code/config/text file can be open in Knote's read-only preview. It has
    // no editor buffer or autosave to conflict with, so direct Agent edits are
    // safe; refresh that preview immediately instead of leaving stale text.
    if (folderHandle.value === binding.handle && activeTreePath.value === tp && !currentFileHandle.value) {
      const node = treeNodeInBinding(binding, p)
      if (node) await previewTreeAsset(node)
    }
    return { ok: true }
    })
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 120) }
  }
}
// ---- workspace file management (agent find_in_files / move / rename / delete) ----
const treeNodeByPath = (relPath, tree = folderTree.value) => {
  const norm = '/' + String(relPath).replace(/\\/g, '/').replace(/^\/+/, '')
  return walkTreeFiles(tree || [], []).find((n) => n.path === norm) || null
}
// same open-in-tab guard as updateFile — a disk-level move/rename/delete of a
// file open in a tab would desync the in-memory copy
const relFileOpenInTab = (relPath, workspaceRoot = folderHandle.value) => {
  const p = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '')
  const tp = '/' + p
  const normP = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const rootDesk = workspaceRoot && workspaceRoot._deskPath
  const absTarget = rootDesk ? normP(rootDesk) + '/' + p.toLowerCase() : null
  return (folderHandle.value === workspaceRoot && activeTreePath.value === tp) ||
    tabs.value.some((tb) =>
      (tb.folderHandle === workspaceRoot && tb.treePath === tp) ||
      (absTarget && typeof tb.deskKey === 'string' && tb.deskKey.startsWith('file:') && normP(tb.deskKey.slice(5)) === absTarget))
}
const deskAbsPath = (relPath, workspaceRoot = folderHandle.value) => {
  const root = workspaceRoot && workspaceRoot._deskPath
  if (!root) return null
  const sep = root.includes('\\') ? '\\' : '/'
  const rel = String(relPath).replace(/^\/+/, '').split('/').filter(Boolean).join(sep)
  return root.replace(/[\\/]$/, '') + sep + rel
}
agentBridge.searchFiles = async (query, opts = {}, options) => {
  const binding = resolveAgentWorkspaceBinding(options)
  if (!binding) return { error: 'workspace_changed' }
  const q = String(query || '')
  let re = null
  if (opts.regex) {
    // a model-supplied regex is run per line on the main thread — reject the
    // classic catastrophic-backtracking shape (a quantifier on a group that
    // itself contains a quantifier, e.g. (a+)+ / (.*)* ) so it can't hang the UI
    if (/\([^()]*[*+{][^()]*\)\s*[*+{]/.test(q)) return { error: '这个正则含嵌套量词，可能导致灾难性回溯（卡死），请改用更简单的模式或纯文本检索。' }
    try { re = new RegExp(q, 'i') } catch (e) { return { error: '正则表达式无效：' + String((e && e.message) || e) } }
  }
  const lower = q.toLowerCase()
  const max = Math.min(Number(opts.max) || 200, 500)
  const LINE_CAP = 2000 // bound per-line match work (input size for backtracking)
  const TIME_BUDGET = 3000 // ms — overall wall-clock cap, backstop for slow scans
  const start = Date.now()
  const results = []
  let total = 0
  let timedOut = false
  let skippedRegexLines = 0
  let failedFiles = 0
  for (const n of walkTreeFiles(binding.tree || [], [])) {
    if (total >= max) break
    if (Date.now() - start > TIME_BUDGET) { timedOut = true; break }
    if (!['md', 'txt', 'csv', 'rtf', 'code'].includes(n.ftype)) continue
    let text
    try {
      const source = await readNodeBytes(n, binding.handle)
      if (!source?.bytes) throw new Error('read_failed')
      text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)
    } catch {
      failedFiles++
      continue
    }
    const lines = text.split('\n')
    const hits = []
    for (let i = 0; i < lines.length && total < max; i++) {
      if (Date.now() - start > TIME_BUDGET) { timedOut = true; break }
      const line = lines[i]
      if (re && new TextEncoder().encode(line).byteLength > LINE_CAP) {
        skippedRegexLines++
        continue
      }
      const ok = re ? re.test(line) : line.toLowerCase().includes(lower)
      if (ok) {
        const raw = lines[i].trim()
        hits.push({ line: i + 1, text: raw.length > 160 ? raw.slice(0, 160) + '…' : raw, snippet_truncated: raw.length > 160 })
        total++
      }
    }
    if (hits.length) results.push({ path: n.path.replace(/^\//, ''), hits })
    if (timedOut) break
  }
  const hitCap = total >= max
  return {
    results,
    timedOut,
    hitCap,
    skippedRegexLines,
    failedFiles,
    sourceComplete: !timedOut && !hitCap && skippedRegexLines === 0 && failedFiles === 0
  }
}
agentBridge.renameFile = async (relPath, newName, options) => {
  const binding = resolveAgentWorkspaceBinding(options)
  if (!binding) return { ok: false, error: 'workspace_changed' }
  const node = treeNodeByPath(relPath, binding.tree)
  if (!node) return { ok: false, error: 'not_found' }
  if (relFileOpenInTab(relPath, binding.handle)) return { ok: false, error: 'open_in_tab' }
  let name = String(newName || '').trim()
  if (!isSafeWorkspaceLeafName(name)) return { ok: false, error: 'bad_name' }
  // Preserve the old extension only when the requested name has none. A
  // deliberate code rename such as foo.js → foo.ts must not become foo.ts.js.
  if (!/\.[^./]+$/.test(name)) {
    const ext = node.name.match(/\.[^.]+$/)
    if (ext) name += ext[0]
    else if (node.ftype === 'md') name += '.md'
  }
  if (!isSafeWorkspaceLeafName(name)) return { ok: false, error: 'bad_name' }
  const parentPath = String(relPath).replace(/^\/+/, '').replace(/[^/]*$/, '')
  try {
    try {
      await node.parent.getFileHandle(name)
      return { ok: false, error: 'exists' }
    } catch (error) {
      if (error?.name !== 'NotFoundError') return { ok: false, error: String(error?.message || error).slice(0, 120) }
    }
    if (node.ftype === 'md' && !node.handle?._deskPath && !node.handle?._knoteIdentity) {
      const fromKey = browserTreeSnapshotKey(node.path, binding)
      const toKey = browserTreeSnapshotKey('/' + parentPath + name, binding)
      if (fromKey && toKey) await copySnapshots(fromKey, toKey)
    }
    const absFrom = deskAbsPath(relPath, binding.handle)
    if (absFrom && window.knoteDesktop && window.knoteDesktop.fsRename) {
      const sep = binding.handle._deskPath.includes('\\') ? '\\' : '/'
      const dirAbs = absFrom.slice(0, absFrom.lastIndexOf(sep))
      await window.knoteDesktop.fsRename(absFrom, dirAbs + sep + name)
    } else if (typeof node.handle.move === 'function') {
      await node.handle.move(name)
    } else {
      const buf = await (await node.handle.getFile()).arrayBuffer()
      const fh = await node.parent.getFileHandle(name, { create: true })
      const w = await fh.createWritable(); await w.write(buf); await w.close()
      await node.parent.removeEntry(node.name)
    }
    try { await refreshAgentWorkspaceBinding(binding) } catch { /* tree refresh is best-effort; the rename already succeeded */ }
    return { ok: true, path: parentPath + name }
  } catch (err) { return { ok: false, error: String((err && err.message) || err).slice(0, 120) } }
}
agentBridge.moveFile = async (relPath, toDir, options) => {
  const binding = resolveAgentWorkspaceBinding(options)
  if (!binding) return { ok: false, error: 'workspace_changed' }
  const node = treeNodeByPath(relPath, binding.tree)
  if (!node) return { ok: false, error: 'not_found' }
  if (relFileOpenInTab(relPath, binding.handle)) return { ok: false, error: 'open_in_tab' }
  const name = node.name
  const destSegs = String(toDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  // defense-in-depth: refuse traversal segments outright (main-process insideRoot
  // would also block them, but never build an escaping path in the first place)
  if (destSegs.some((s) => s === '..' || s === '.')) return { ok: false, error: 'bad_path' }
  const newRel = (destSegs.length ? destSegs.join('/') + '/' : '') + name
  if ('/' + newRel === node.path) return { ok: false, error: 'same_dir' }
  try {
    if (node.ftype === 'md' && !node.handle?._deskPath && !node.handle?._knoteIdentity) {
      const fromKey = browserTreeSnapshotKey(node.path, binding)
      const toKey = browserTreeSnapshotKey('/' + newRel, binding)
      if (fromKey && toKey) await copySnapshots(fromKey, toKey)
    }
    if (node.kind === 'dir' && !node.handle?._deskPath && !node.handle?._knoteIdentity) {
      await copyDirSnapshots(node, binding, '/' + newRel)
    }
    const rootDesk = binding.handle._deskPath
    if (rootDesk && window.knoteDesktop && window.knoteDesktop.fsRename) {
      const sep = rootDesk.includes('\\') ? '\\' : '/'
      const destDirAbs = rootDesk.replace(/[\\/]$/, '') + (destSegs.length ? sep + destSegs.join(sep) : '')
      if (window.knoteDesktop.fsMkdir) await window.knoteDesktop.fsMkdir(destDirAbs)
      const toAbs = destDirAbs + sep + name
      if (window.knoteDesktop.fsExists && await window.knoteDesktop.fsExists(toAbs)) return { ok: false, error: 'exists' }
      await window.knoteDesktop.fsRename(deskAbsPath(relPath, binding.handle), toAbs)
    } else {
      let destDir = binding.handle
      for (const s of destSegs) destDir = await destDir.getDirectoryHandle(s, { create: true })
      try { await destDir.getFileHandle(name); return { ok: false, error: 'exists' } } catch { /* free */ }
      if (typeof node.handle.move === 'function') { await node.handle.move(destDir, name) } else {
        const buf = await (await node.handle.getFile()).arrayBuffer()
        const fh = await destDir.getFileHandle(name, { create: true })
        const w = await fh.createWritable(); await w.write(buf); await w.close()
        await node.parent.removeEntry(node.name)
      }
    }
    try { await refreshAgentWorkspaceBinding(binding) } catch { /* best-effort; the move already succeeded */ }
    return { ok: true, path: newRel }
  } catch (err) { return { ok: false, error: String((err && err.message) || err).slice(0, 120) } }
}
const AGENT_DELETE_CONTENT_LIMIT = 4 * 1024 * 1024
const deleteStatIdentity = (source) => {
  if (!source || typeof source !== 'object') return null
  if (source.statIdentity && typeof source.statIdentity === 'object') return { ...source.statIdentity }
  const identity = {}
  if (source.size != null) identity.size = String(source.size)
  if (source.mtimeNs != null) identity.mtimeNs = String(source.mtimeNs)
  else if (source.mtimeMs != null) identity.mtimeNs = String(Math.trunc(Number(source.mtimeMs) * 1e6))
  return Object.keys(identity).length ? identity : null
}
const sameDeleteStatIdentity = (expected, current) => {
  if (!expected || !current) return false
  return Object.entries(expected).every(([field, value]) => String(current[field]) === String(value))
}
const deleteEntryMatches = async (initial, latest) => {
  if (!initial?.handle || !latest?.handle) return false
  if (initial.handle._deskPath || latest.handle._deskPath) {
    return sameDeskKey(`file:${initial.handle._deskPath || ''}`, `file:${latest.handle._deskPath || ''}`)
  }
  if (initial.handle._knoteIdentity || latest.handle._knoteIdentity) {
    return !!initial.handle._knoteIdentity && initial.handle._knoteIdentity === latest.handle._knoteIdentity
  }
  if (typeof initial.handle.isSameEntry === 'function') {
    try { return await initial.handle.isSameEntry(latest.handle) } catch { return false }
  }
  return initial.handle === latest.handle
}
const captureDeleteCondition = async (node, binding, relativePath) => {
  const abs = deskAbsPath(relativePath, binding.handle)
  let stat
  let size = 0
  if (abs && typeof window.knoteDesktop?.fsStat === 'function') {
    const current = await window.knoteDesktop.fsStat(abs)
    if (!current?.ok) return null
    stat = deleteStatIdentity(current)
    size = Number(current.size) || 0
  } else {
    const file = await node.handle.getFile()
    size = Number(file.size) || 0
    stat = deleteStatIdentity({ size, mtimeMs: file.lastModified })
  }
  let content = null
  if (isAgentCreatableFile(node.name) && size <= AGENT_DELETE_CONTENT_LIMIT) {
    try {
      content = abs
        ? String(await window.knoteDesktop.fsRead(abs))
        : String(await (await node.handle.getFile()).text())
    } catch { content = null }
  }
  return { abs, stat, content, handle: node.handle }
}

agentBridge.deleteFile = async (relPath, options = {}) => {
  const signal = options?.signal || null
  const binding = resolveAgentWorkspaceBinding(options)
  if (!binding) return { ok: false, error: 'workspace_changed' }
  const clean = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '')
  const node = treeNodeByPath(clean, binding.tree)
  if (!node) return { ok: false, error: 'not_found' }
  const mutationKey = await resolveFileMutationKey(binding.handle, binding.id, clean, node.handle)
  let initial
  try {
    initial = await withAsyncKeyLock(mutationKey, async () => {
      if (signal?.aborted) return null
      if (relFileOpenInTab(clean, binding.handle)) return { error: 'open_in_tab' }
      const condition = await captureDeleteCondition(node, binding, clean)
      return condition || { error: 'stale_file' }
    })
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 120) }
  }
  if (signal?.aborted) return { ok: false, error: 'aborted' }
  if (!initial || initial.error) return { ok: false, error: initial?.error || 'aborted' }

  const willTrash = !!(initial.abs && window.knoteDesktop?.trash)
  if (options?.skipHumanReview !== true) {
    const approved = await confirmDialog(lang.value === 'zh'
      ? `助手请求删除文件「${clean}」（${willTrash ? '将移入系统回收站' : '当前环境会永久删除'}）。是否允许？`
      : `The assistant wants to delete "${clean}" (${willTrash ? 'moved to the Recycle Bin' : 'permanently deleted in this environment'}). Allow?`,
    { owner: `agent-delete:${binding.id}:${clean}`, signal })
    if (!approved) return { ok: false, error: signal?.aborted ? 'aborted' : 'declined' }
  }

  try {
    return await withAsyncKeyLock(mutationKey, async () => {
      if (signal?.aborted) return { ok: false, error: 'aborted' }
      const latestBinding = resolveAgentWorkspaceBinding(options)
      if (!latestBinding || latestBinding.handle !== binding.handle || !sameDeskKey(latestBinding.id, binding.id)) {
        return { ok: false, error: 'workspace_changed' }
      }
      try { await refreshAgentWorkspaceBinding(latestBinding) } catch { return { ok: false, error: 'workspace_changed' } }
      if (signal?.aborted) return { ok: false, error: 'aborted' }
      const latestNode = treeNodeByPath(clean, latestBinding.tree)
      if (!latestNode) return { ok: false, error: 'stale_file' }
      if (relFileOpenInTab(clean, latestBinding.handle)) return { ok: false, error: 'open_in_tab' }
      if (!await deleteEntryMatches(initial, latestNode)) return { ok: false, error: 'stale_file' }
      const latest = await captureDeleteCondition(latestNode, latestBinding, clean)
      if (!latest || !sameDeleteStatIdentity(initial.stat, latest.stat) ||
          (initial.content != null && latest.content !== initial.content)) {
        return { ok: false, error: 'stale_file' }
      }
      if (signal?.aborted) return { ok: false, error: 'aborted' }

      let trashed = false
      if (initial.abs && window.knoteDesktop?.trash) {
        const result = await window.knoteDesktop.trash(initial.abs, {
          stat: initial.stat,
          content: initial.content
        })
        if (result?.stale || result?.error === 'stale_file') return { ok: false, error: 'stale_file' }
        if (result !== true && !result?.ok) return { ok: false, error: 'trash_failed' }
        trashed = true
      } else {
        await latestNode.parent.removeEntry(latestNode.name)
      }
      try { await refreshAgentWorkspaceBinding(latestBinding) } catch { /* best-effort; the delete already succeeded */ }
      return { ok: true, trashed }
    })
  } catch (err) {
    return { ok: false, error: signal?.aborted ? 'aborted' : String((err && err.message) || err).slice(0, 120) }
  }
}
// Adopt scoped Agent bytes into the document image store. Returning a fresh
// img-* capability prevents an att-*/el-* session handle from escaping into
// the global document cache.
agentBridge.registerImage = (_id, dataUrl) => ensureImageId(dataUrl)
// Expand knote-img refs in ARBITRARY text to data URLs (create_file writes
// straight to disk, bypassing exportableMarkdown — without this, compact refs
// in generated files would be dangling forever)
agentBridge.expandImages = (text, targetText, options) => {
  let out = String(text ?? '')
  for (const [id, url] of Object.entries(imageStore)) {
    out = out.split(`knote-img:${id}`).join(url)
  }
  // workspace-relative refs (assets/foo.png …) are only valid relative to
  // the OPEN document's folder — a file created/edited elsewhere would carry
  // a permanently broken path. Inline the already-resolved bytes instead so
  // the target file is self-contained wherever it lives. EXCEPT refs that
  // already exist in the target file (targetText): those are target-relative
  // by definition and must be preserved verbatim, not swapped for the open
  // doc's bytes.
  const binding = resolveAgentWorkspaceBinding(options)
  const relativeImages = binding ? (binding.relativeImages || {}) : relImages
  for (const [p, url] of Object.entries(relativeImages)) {
    if (targetText && targetText.includes(`](${p}`)) continue
    out = out.split(`](${p})`).join(`](${url})`).split(`](${p} `).join(`](${url} `)
  }
  return out
}
// create a folder (multi-level) inside the workspace; idempotent
agentBridge.createFolder = async (relPath, options) => {
  const binding = resolveAgentWorkspaceBinding(options)
  if (!binding) return null
  try {
    const segs = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean)
    if (!segs.length || segs.some((s) => s === '.' || s === '..')) return null
    let dir = binding.handle
    for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: true })
    try { await refreshAgentWorkspaceBinding(binding) } catch { /* tree refresh best-effort */ }
    return segs.join('/')
  } catch (err) {
    console.error('agentBridge.createFolder failed:', err)
    return null
  }
}

// Desktop (Electron): .md files opened via file association arrive from the
// main process; a handle-shaped wrapper routes auto-save back through IPC,
// so associated files get the same live-save as picker-opened ones.
// (?titlebar previews the tabbed title bar in a plain browser for testing)
const isDesktopShell = !!window.knoteDesktop
  || (typeof location !== 'undefined' && /[?&]titlebar\b/.test(location.search))

// Hardware-acceleration kill switch (issue #13 crash triage): the flag is
// persisted by the main process and read before the GPU process starts, so
// toggling only takes effect on relaunch. Desktop only.
const hwAccelDisabled = ref(false)
if (isDesktopShell) {
  window.knoteDesktop.hwAccelGet?.().then((r) => { hwAccelDisabled.value = !!(r && r.disabled) }).catch(() => {})
}
const toggleHwAccel = async () => {
  if (!isDesktopShell) return
  const next = !hwAccelDisabled.value
  const r = await window.knoteDesktop.hwAccelSet(next)
  if (!r || r.ok !== true) { notify(t('hw_accel_failed')); return }
  hwAccelDisabled.value = next
  const restart = await confirmDialog(t('hw_accel_restart'), { owner: 'hw-accel-restart' })
  if (restart) await window.knoteDesktop.relaunchApp()
}
// Source-mode smart editing (default OFF): the split-view source textarea
// stays a plain text area unless the user opts in — Enter continues
// list/quote prefixes and wrap chars surround the selection, mirroring the
// rich editor. Persisted per app, not per document.
const SOURCE_SMART_EDIT_KEY = 'knote-source-smart-edit-v1'
const sourceSmartEdit = ref((() => {
  try { return localStorage.getItem(SOURCE_SMART_EDIT_KEY) === '1' } catch { return false }
})())
const toggleSourceSmartEdit = () => {
  sourceSmartEdit.value = !sourceSmartEdit.value
  try { localStorage.setItem(SOURCE_SMART_EDIT_KEY, sourceSmartEdit.value ? '1' : '0') } catch { /* best-effort */ }
}
const supportsDocumentTabs = computed(() => isDesktopShell || isAndroidTablet.value)
if (isDesktopShell && window.knoteDesktop?.platform !== 'linux') document.documentElement.classList.add('knote-wco') // frosted title bar CSS
let stopWindowState = null
// Startup session replay must never win over a file/folder the user explicitly
// opened. Session requests carry a renderer-generated ID through main/preload;
// every untagged open is foreground intent and cancels the replay.
let sessionRestoring = false
let foregroundOpenGeneration = 0
let latestForegroundOpenSequence = 0
let sessionRestoreEpoch = 0
const pendingSessionOpens = new Map()
const pendingSessionOpenCompletions = new Map()
let sessionOpenSequence = 0
const cancelSessionRestoreForForegroundIntent = () => {
  if (!sessionRestoring && pendingSessionOpens.size === 0) return
  foregroundOpenGeneration += 1
}
const finishSessionOpen = (requestId, applied) => {
  const id = String(requestId || '')
  const pending = pendingSessionOpenCompletions.get(id)
  if (!pending) return
  pendingSessionOpenCompletions.delete(id)
  pending.resolve(applied === true)
}
const classifyDesktopOpen = (requestId, openSequence) => {
  const id = String(requestId || '')
  const token = id ? pendingSessionOpens.get(id) : null
  if (token) {
    pendingSessionOpens.delete(id)
    const current = token.foregroundGeneration === foregroundOpenGeneration &&
      token.restoreEpoch === sessionRestoreEpoch
    return {
      kind: current ? 'session' : 'stale-session',
      requestId: id,
      isCurrent: () => current &&
        token.foregroundGeneration === foregroundOpenGeneration &&
      token.restoreEpoch === sessionRestoreEpoch
    }
  }
  const sequence = Number(openSequence)
  if (Number.isSafeInteger(sequence) && sequence > 0) {
    if (sequence < latestForegroundOpenSequence) {
      return { kind: 'stale-foreground', requestId: '', isCurrent: () => false }
    }
    latestForegroundOpenSequence = sequence
  }
  foregroundOpenGeneration += 1
  const generation = foregroundOpenGeneration
  return {
    kind: 'foreground',
    requestId: '',
    isCurrent: () => generation === foregroundOpenGeneration &&
      (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence === latestForegroundOpenSequence)
  }
}
const applyWindowState = (state = {}) => {
  if (!isDesktopShell) return
  const maximized = !!(state.maximized || state.fullscreen)
  document.documentElement.classList.toggle('knote-maximized', maximized)
  document.documentElement.classList.toggle('knote-windowed', !maximized)
}
if (isDesktopShell) {
  applyWindowState({ maximized: false })
  if (window.knoteDesktop?.getWindowState) {
    window.knoteDesktop.getWindowState().then(applyWindowState).catch(() => {})
    stopWindowState = window.knoteDesktop.onWindowState?.(applyWindowState) || null
  }
}
if (window.knoteDesktop) {
  // a path-backed dir handle for the file's OWN folder, so ![](relative/x.png)
  // images sitting next to a file-associated .md can be resolved (main
  // registers the folder as an image-read root when it sends the open)
  const dirHandleForFile = (p) => {
    const d = String(p).replace(/[\\/][^\\/]*$/, '')
    return mkDesktopDirHandle(d, d.replace(/.*[\\/]/, '') || d)
  }
  window.knoteDesktop.onOpenFile(async ({ path: p, name, capability, requestId, openSequence }) => {
    if (capability) desktopOpenCapabilities.set(desktopOpenCapabilityKey('file', p), capability)
    const openRequest = classifyDesktopOpen(requestId, openSequence)
    if (openRequest.kind === 'stale-session' || openRequest.kind === 'stale-foreground') {
      finishSessionOpen(requestId, false)
      return
    }
    documentLoadGeneration += 1
    const mutationKey = canonicalFileMutationKey(p, `file:${p}`)
    await waitForStandaloneOpenGate()
    return await withAsyncKeyLock(mutationKey, async () => {
      let applied = false
      try {
    // an already-open file (same disk path) activates its tab instead of
    // duplicating
    const key = `file:${p}`
    const existing = tabs.value.find((tb) => {
      if (sameDeskKey(tb.deskKey, key)) return true
      const physicalPath = tb.id === activeTabId.value
        ? currentFileHandle.value?._deskPath
        : tb.fileHandle?._deskPath
      return physicalPath ? sameDeskKey(`file:${physicalPath}`, key) : false
    })
    if (existing) {
      if (existing.id !== activeTabId.value && !await switchTab(existing.id)) return
      if (!openRequest.isCurrent()) return
      if (existing.id !== activeTabId.value) return
      // reconcile with the fresh disk read — external edits (or a past
      // failed load) must win over the tab's stale snapshot. Skip only if
      // this tab has its own unflushed edits (it's ahead of the disk).
      const reconcileHandle = mkDesktopHandle(p, name)
      currentFileHandle.value = reconcileHandle
      isLocalFile.value = true
      // The main-process payload can be older than a save which was already
      // in flight when Explorer asked to reopen this tab. Drain that file's
      // queue, then verify the disk again. A failed save leaves the edit
      // revision ahead, so the in-memory document is preserved.
      await waitForDocumentSaves(key)
      if (!openRequest.isCurrent() || existing.id !== activeTabId.value || currentFileHandle.value !== reconcileHandle) return
      let latestRaw = null
      const reconcileEditRevision = documentEditRevision(key)
      const reconcileContent = content.value
      if (!documentIsAheadOfDisk(key)) {
        try {
          const latestFile = await reconcileHandle.getFile()
          latestRaw = String(await latestFile.text())
        } catch { /* a failed verification must never replace editor memory */ }
      }
      if (!openRequest.isCurrent() || existing.id !== activeTabId.value || currentFileHandle.value !== reconcileHandle) return
      // The read may have captured disk bytes before an edit that subsequently
      // autosaved. A clean disk baseline alone cannot prove those bytes are new.
      const documentUnchangedDuringRead = documentEditRevision(key) === reconcileEditRevision &&
        content.value === reconcileContent
      if (latestRaw != null && documentUnchangedDuringRead && !documentIsAheadOfDisk(key)) {
        const fresh = importMarkdown(latestRaw)
        if (content.value !== fresh) {
          const editorLoad = stageLargeEditorLoad(fresh)
          const navigationOwner = beginNavigationInstall()
          try {
            resetEditingState()
            clearRelImages()
            content.value = fresh
            void releaseLargeEditorLoad(editorLoad)
            undoStack.value = []
            redoStack.value = []
            lastSavedSnapshot = { content: fresh, selection: null }
            relImagesNeedGrant.value = false // desktop resolves rel images via IPC
            docDir.value = dirHandleForFile(p)
            loadRelativeImages(dirHandleForFile(p))
          } finally {
            finishNavigationInstall(navigationOwner)
          }
        }
        markDocumentDiskBaseline(key)
        void takeSnapshot('opened', key, fresh)
      }
      applied = true
      return
    }
    const targetTab = openInNewTab() || activeTab()
    if (!targetTab) return
    const targetToken = Symbol('desktop-open')
    targetTab.openToken = targetToken
    const targetDocumentKey = snapshotDocKeyForTab(targetTab)
    const targetEditRevision = documentEditRevision(targetDocumentKey)
    const targetInitialContent = activeTab() === targetTab ? content.value : targetTab.content
    const targetUntouched = () => {
      if (!tabs.value.includes(targetTab) || targetTab.openToken !== targetToken) return false
      const currentText = activeTab() === targetTab ? content.value : targetTab.content
      return snapshotDocKeyForTab(targetTab) === targetDocumentKey &&
        documentEditRevision(targetDocumentKey) === targetEditRevision &&
        currentText === targetInitialContent
    }
    resetEditingState()
    clearRelImages()
    // Main's event payload is only an open intent. It may have been read before
    // an Agent conditional commit; always re-read under the shared path lock.
    const openedText = await readDesktopTextFile(p)
    if (!openRequest.isCurrent() || !targetUntouched()) {
      if (targetTab.openToken === targetToken) targetTab.openToken = null
      return
    }
    const nextContent = importMarkdown(openedText)
    const handle = mkDesktopHandle(p, name)
    const ownDir = dirHandleForFile(p)
    bumpAgentDocumentGeneration(targetTab)
    setTabFileWorkspaceIdentity(targetTab)
    if (activeTab() === targetTab) {
      const navigationOwner = beginNavigationInstall()
      try {
        currentFileHandle.value = handle
        currentFileName.value = name
        isLocalFile.value = true
        activeTreePath.value = ''
        docDir.value = ownDir
        const editorLoad = stageLargeEditorLoad(nextContent)
        content.value = nextContent
        void releaseLargeEditorLoad(editorLoad)
        undoStack.value = []
        redoStack.value = []
        lastSavedSnapshot = { content: nextContent, selection: null }
        relImagesNeedGrant.value = false
        targetTab.deskKey = key
      } finally {
        finishNavigationInstall(navigationOwner)
      }
      loadRelativeImages(ownDir)
    } else {
      // The user switched away while a chunked read was in flight. Populate
      // only the tab that initiated the open; never install into the new tab.
      targetTab.kind = 'doc'
      targetTab.title = name
      targetTab.deskKey = key
      targetTab.content = nextContent
      targetTab.exportedMd = exportableMarkdown(nextContent)
      targetTab.editorState = null
      targetTab.fileHandle = handle
      targetTab.isLocal = true
      targetTab.fileName = name
      targetTab.treePath = ''
      targetTab.undo = []
      targetTab.redo = []
      targetTab.lastSaved = { content: nextContent, selection: null }
      targetTab.relImagesNeedGrant = false
      targetTab.docDir = ownDir
      targetTab.largeSourcePage = 0
      targetTab.resident = true
    }
    targetTab.openToken = null
    markDocumentDiskBaseline(key)
    persistSession()
    addRecent('file', p, name, { sessionReplay: openRequest.kind === 'session' })
    void takeSnapshot('opened', key, nextContent)
    applied = true
      } finally {
        if (openRequest.kind === 'session') finishSessionOpen(openRequest.requestId, applied)
      }
    })
  })
  // folders dropped onto the Knote icon / opened via argv: a path-backed
  // handle adapter (IPC fs) makes them a normal folder-tab workspace
  if (window.knoteDesktop.onOpenFolder) {
    window.knoteDesktop.onOpenFolder(async ({ path: p, name, grantId, capability, requestId, openSequence }) => {
      if (capability) desktopOpenCapabilities.set(desktopOpenCapabilityKey('folder', p), capability)
      const openRequest = classifyDesktopOpen(requestId, openSequence)
      if (openRequest.kind === 'stale-session' || openRequest.kind === 'stale-foreground') {
        finishSessionOpen(requestId, false)
        return
      }
      let applied = false
      try {
        const adopted = await adoptFolderHandle(
          mkDesktopDirHandle(p, name, grantId),
          name,
          `folder:${p}`,
          openRequest.isCurrent
        )
        if (!adopted || !openRequest.isCurrent()) return
        persistSession()
        addRecent('folder', p, name, { sessionReplay: openRequest.kind === 'session' })
        applied = true
      } catch (err) {
        console.error('Open folder (desktop) error:', err)
      } finally {
        if (openRequest.kind === 'session') finishSessionOpen(openRequest.requestId, applied)
      }
    })
  }
  // restore last session's tabs after the bridge is live; a slight delay
  // lets any argv-opened file (double-click launch) land first so the
  // deskKey dedupe folds it into the restored set instead of duplicating.
  // Arrow-wrapped: restoreSession is declared later in setup, so referencing
  // it lazily (at fire time) avoids a temporal-dead-zone error here.
  setTimeout(() => restoreSession(), 300)
}

loadAgentPersisted()

// First-run product tour. Closing or finishing records completion; the tour
// remains available from the three-dot menu without erasing that preference.
const ONBOARDING_KEY = 'knote-onboarding-complete-v1'
const onboardingOpen = ref(false)
let onboardingTimer = null
const openOnboarding = () => { onboardingOpen.value = true }
const completeOnboarding = () => {
  onboardingOpen.value = false
  try { localStorage.setItem(ONBOARDING_KEY, '1') } catch { /* storage unavailable */ }
}

// Chat bubbles render the assistant's markdown through the same pipeline as
// the preview (markdown-it + KaTeX + hljs), sanitized before injection.
// "第 N 行" references become clickable jump links. Generated links and copy
// controls are sanitized together with provider HTML before delegated clicks.
const linkifyLineRefs = (html) => html.replace(
  /第\s*(\d+)(?:\s*[-–~—至]\s*\d+)?\s*行/g,
  (m, a) => `<a class="knote-line-ref" data-line="${a}">${m}</a>`
)
const decorateAgentCopyControls = (html) => {
  if (typeof document === 'undefined') return html
  const template = document.createElement('template')
  template.innerHTML = html
  const counters = { code: 0, table: 0 }
  const copyButton = (kind, label) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'knote-agent-block-copy'
    button.dataset.testid = kind === 'code' ? 'agent-code-copy' : 'agent-table-copy'
    button.dataset.agentCopy = kind
    button.dataset.copyKey = `${kind}-${++counters[kind]}`
    button.setAttribute('aria-label', label)
    button.title = label
    button.classList.add('is-icon')
    button.innerHTML = '<svg class="knote-agent-copy-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.5 3A2.5 2.5 0 0 0 5 5.5v9A2.5 2.5 0 0 0 7.5 17H8v-2h-.5a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5V6h2v-.5A2.5 2.5 0 0 0 14.5 3h-7Z"/><path d="M11.5 7A2.5 2.5 0 0 0 9 9.5v9a2.5 2.5 0 0 0 2.5 2.5h7a2.5 2.5 0 0 0 2.5-2.5v-9A2.5 2.5 0 0 0 18.5 7h-7Z"/></svg><svg class="knote-agent-copy-check" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M20.03 5.97a.75.75 0 0 1 0 1.06l-9.5 9.5a.75.75 0 0 1-1.06 0l-4.5-4.5a.75.75 0 0 1 1.06-1.06L10 14.94l8.97-8.97a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd"/></svg>'
    return button
  }
  for (const pre of template.content.querySelectorAll('pre')) {
    if (!pre.querySelector('code')) continue
    const wrapper = document.createElement('div')
    wrapper.className = 'knote-agent-copy-block is-code'
    pre.replaceWith(wrapper)
    wrapper.append(pre, copyButton('code', t('agent_copy_code')))
  }
  for (const table of template.content.querySelectorAll('table')) {
    if (table.closest('.knote-agent-copy-block')) continue
    const wrapper = document.createElement('div')
    wrapper.className = 'knote-agent-copy-block is-table'
    table.replaceWith(wrapper)
    wrapper.append(table, copyButton('table', t('agent_copy_table')))
  }
  return template.innerHTML
}
// The assistant likes writing ![图注](att-x / el-x / knote-img:…) in CHAT
// replies too — resolve those ids to their data URLs BEFORE render/sanitize
// (DOMPurify strips the unknown knote-img: scheme, and bare ids aren't URLs).
// Display size is capped in CSS (.knote-agent-md img); the existing dblclick
// lightbox opens the full image. Dead ids (new session, restart) degrade to a
// visible text placeholder instead of a broken image icon.
const resolveAgentChatImages = (mdText) => String(mdText || '')
  // code fences / inline code are quoted VERBATIM by design — image-ref
  // substitution inside them would dump megabytes of base64 into the bubble
  .split(/(```[\s\S]*?```|`[^`\n]*`)/)
  .map((seg, i) => (i % 2 === 1 ? seg : seg
    .replace(
      /!\[([^\]]*)\]\(\s*(?:knote-img:)?((?:att|el|img)-[\w-]+)\s*\)/g,
      (m, alt, id) => {
        const rec = resolveAgentImageResource(id)
        const url = (rec && rec.dataUrl) || (id.startsWith('img-') ? imageStore[id] : null)
        return url ? `![${alt}](${url})` : `【图片 ${id} 已失效】`
      }
    )
    // document-relative refs (assets/foo.png …) quoted in chat resolve
    // through the same cache the editor uses
    .replace(
      /!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g,
      (m, alt, src) => (relImages[src] ? `![${alt}](${relImages[src]})` : m)
    )))
  .join('')
const renderAgentMd = (text, { copyControls = true } = {}) => {
  const rendered = linkifyLineRefs(md.render(resolveAgentChatImages(text)))
  return sanitizeHtml(copyControls ? decorateAgentCopyControls(rendered) : rendered)
}

// ---- selection → agent ("问助手" + quick rewrite actions) ----
// Best-effort line hint: find the first selected line in the markdown source
// (markers stripped on both sides); the model still verifies via read_document
const selectionLineHint = (selText) => {
  const norm = (s) => String(s || '').replace(/[*_`~$#>+\-[\]()!|]/g, '').replace(/\s+/g, '')
  const first = (selText.split('\n').find((l) => l.trim()) || '').trim()
  const nf = norm(first)
  if (nf.length < 2) return ''
  const lines = content.value.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const nl = norm(lines[i])
    if (!nl) continue
    if (nl.includes(nf) || (nf.length > 6 && nl.length > 4 && nf.includes(nl))) return `第 ${i + 1} 行附近`
  }
  return ''
}

const AI_ACTION_PROMPTS = {
  polish: '请润色我选中的这段内容：保持原意、原语言和 Markdown 格式，提升表达的流畅与准确。先 read_document 定位这段内容的准确行号，再用 replace_lines 提交修改。',
  translate: '请翻译我选中的这段内容：中文译为英文、英文译为中文，保持 Markdown 格式与语气。直接在回复中给出译文即可，不要调用工具、不要修改文档。',
  expand: '请扩写我选中的这段内容：补充细节与论述使其更充实，风格与上下文保持一致。先 read_document 定位行号，再用 replace_lines 提交修改。',
  condense: '请精简我选中的这段内容：保留关键信息、删除冗余，长度明显缩短。先 read_document 定位行号，再用 replace_lines 提交修改。'
}

const onAskAgent = ({ action, text }) => {
  const sel = { text: String(text), lineHint: selectionLineHint(text) }
  // make a chat surface visible: the right sidebar if it's already on screen,
  // otherwise pop the floating window
  if (isAndroidCompact.value) openMobileAgent()
  else if (!showAgentSidebar.value) agentOpen.value = true
  if (action === 'ask') {
    selectionContext.value = sel // staged as a chip; the user types the question
  } else if (AI_ACTION_PROMPTS[action]) {
    sendToAgent(AI_ACTION_PROMPTS[action], [], { selection: sel })
  }
}

// Copies from markdown-RENDERED areas (split preview `.knote-md-render`,
// agent chat bubbles `.knote-agent-md`): the browser serializes <p> gaps as
// DOUBLE newlines in text/plain and paste targets double-space the <p> HTML
// — rebuild both flavors with one line per block (the editor's own copy
// already does this via its ProseMirror serializer).
const COPY_BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'BLOCKQUOTE', 'TR'])
document.addEventListener('copy', (e) => {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return
  const node = sel.anchorNode
  const el = node && (node.nodeType === 1 ? node : node.parentElement)
  if (!el || !el.closest) return
  if (el.closest('.ProseMirror')) return // the editor has its own serializer
  if (!el.closest('.knote-agent-md, .knote-md-render')) return
  const frag = sel.getRangeAt(0).cloneContents()
  // text/plain: one \n per block row, tabs between table cells, formulas as
  // their TeX source (the KaTeX DOM otherwise dumps the symbols 2-3 times)
  const texOf = (root) => {
    const ann = root.querySelector('annotation') // full KaTeX DOM
    if (ann) return ann.textContent.trim()
    // sanitized chat DOM: <annotation> is stripped but its raw TeX text
    // survives as the trailing text node inside <math>
    const math = root.querySelector('math')
    if (math && math.lastChild && math.lastChild.nodeType === 3) return math.lastChild.textContent.trim()
    const vis = root.querySelector('.katex-html')
    return vis ? vis.textContent : root.textContent
  }
  let out = ''
  const walk = (n) => {
    if (n.nodeType === 3) {
      // whitespace BETWEEN block tags (markdown-it pretty-prints its HTML)
      // must not add to the output — it doubled the newlines
      if (!n.textContent.trim() && (!out || out.endsWith('\n'))) return
      out += n.textContent
      return
    }
    if (n.nodeType !== 1) return
    if (n.hasAttribute('data-agent-copy')) return
    const tag = n.tagName
    if (tag === 'BR') { out += '\n'; return }
    if (n.classList.contains('katex-display')) { out += `$$${texOf(n)}$$`; return }
    if (n.classList.contains('katex')) { out += `$${texOf(n)}$`; return }
    for (const c of n.childNodes) walk(c)
    if (tag === 'TD' || tag === 'TH') out += '\t'
    else if (COPY_BLOCK_TAGS.has(tag) && !out.endsWith('\n')) out += '\n'
  }
  for (const c of frag.childNodes) walk(c)
  const plain = out.replace(/\t+\n/g, '\n').replace(/\n+$/, '')
  // text/html: <p> → <div>, so chat apps don't render blank paragraph gaps
  const box = document.createElement('div')
  box.appendChild(frag)
  box.querySelectorAll('p').forEach((p) => {
    const d = document.createElement('div')
    while (p.firstChild) d.appendChild(p.firstChild)
    for (const a of p.attributes) d.setAttribute(a.name, a.value)
    p.replaceWith(d)
  })
  // a single copied row pastes INLINE — a lone block element would make the
  // receiver append a line break after it (trailing "blank line")
  if (box.childNodes.length === 1 && box.firstElementChild && box.firstElementChild.tagName === 'DIV') {
    box.innerHTML = box.firstElementChild.innerHTML
  }
  e.clipboardData.setData('text/plain', plain)
  e.clipboardData.setData('text/html', box.innerHTML)
  e.preventDefault()
}, true)

// Sidebar/agent/split-pane scrollbars show only WHILE scrolling (green glow bar, see
// style.css). Scroll events don't bubble, so listen in the capture phase.
const scrollFadeTimers = new WeakMap()
document.addEventListener('scroll', (e) => {
  const el = e.target
  if (!(el instanceof Element)) return
  if (el.closest('[data-knote-local-scrollbar]')) return
  if (!el.closest('aside') && !el.closest('.knote-agent-dock') && !el.classList.contains('knote-agent-input') && !el.classList.contains('knote-root') && !el.classList.contains('knote-doc-scroll') && !el.classList.contains('knote-source-scroll') && !el.classList.contains('knote-split-preview')) return
  el.classList.add('knote-scrolling')
  clearTimeout(scrollFadeTimers.get(el))
  scrollFadeTimers.set(el, setTimeout(() => el.classList.remove('knote-scrolling'), 900))
}, true)

// Floating agent dock: DRAG THE GREEN BALL to move the whole dock (ball +
// window). The dock anchors to the BALL's bottom-right corner so the chat
// window always opens upward from the ball. Mouse and touch keep separate drag
// thresholds so a slightly wandering finger still counts as one tap.
const agentDockPos = ref(null) // null = default bottom-right; {right,bottom} once dragged
// Drop-zone state for float→sidebar conversion: while the ball is dragged toward
// the right-center edge a frosted indicator fades in (visible); once the pointer is
// over the painted strip it turns "hot" (active) and releasing there converts. The
// painted box IS the release band — identical width/height/centre — so the effective
// zone never ends up smaller than what's shown. The strip is kept deliberately slim/
// short so casual ball drags around the right side don't fall into it: you have to
// aim for the edge. AGENT_DROP_W/H drive both the release test below and the inline
// box size in the template (single source of truth).
const agentDropZoneVisible = ref(false)
const agentDropZoneActive = ref(false)
const AGENT_DROP_W = 140  // px — slim right-edge strip (visual box == release band)
const AGENT_DROP_H = 160  // px — short vertical band, centred on the viewport
const AGENT_DROP_PROX = 210 // px from the right edge where the indicator starts fading in
// Inline geometry for the indicator box, computed from the SAME clientWidth/clientHeight
// basis as the release test in onAgentBallMove. Positioning with explicit left/top (not
// `right:0`/`top:50%`) keeps the painted box pixel-identical to the release rectangle even
// when a scrollbar offsets clientWidth from the fixed-position viewport edge. Recomputes
// whenever the zone toggles (the viewport is static mid-drag).
const agentDropZoneStyle = computed(() => {
  void agentDropZoneVisible.value
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  return {
    left: `${vw - AGENT_DROP_W}px`,
    top: `${vh / 2 - AGENT_DROP_H / 2}px`,
    width: `${AGENT_DROP_W}px`,
    height: `${AGENT_DROP_H}px`
  }
})
// chat window opens ABOVE the mascot normally; when the mascot is dragged
// into the TOP half of the viewport, open it BELOW instead (it would clip
// off the top edge otherwise)
const viewportH = ref(typeof window !== 'undefined' ? window.innerHeight : 800)
window.addEventListener('resize', () => { viewportH.value = window.innerHeight })
const dockPanelBelow = computed(() => {
  if (!agentDockPos.value) return false // default corner = bottom half
  const mascotCenter = viewportH.value - agentDockPos.value.bottom - 42 // ~half mascot height
  return mascotCenter < viewportH.value / 2
})
// The MASCOT is the anchor — it must not move when the chat opens. Anchored
// by `bottom`, the dock grows UPWARD (fine when the panel sits above). With
// the panel BELOW (mascot in the top half), growth must go DOWNWARD, so the
// dock switches to a `top` anchor at the mascot's current top edge.
const dockStyle = computed(() => {
  if (!agentDockPos.value) return {}
  const base = { right: `${agentDockPos.value.right}px`, left: 'auto' }
  if (dockPanelBelow.value) {
    const mascotTop = viewportH.value - agentDockPos.value.bottom - 84 // mascot ≈84px tall
    return { ...base, top: `${Math.max(4, mascotTop)}px`, bottom: 'auto' }
  }
  return { ...base, bottom: `${agentDockPos.value.bottom}px`, top: 'auto' }
})
let agentBallDrag = null
const releasePointerCapture = (target, pointerId) => {
  try {
    if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId)
  } catch { /* synthetic or already-cancelled pointer */ }
}
const cleanupAgentBallDrag = (event = null, toggle = false) => {
  const drag = agentBallDrag
  if (!drag || (event && event.pointerId !== drag.pointerId)) return false
  window.removeEventListener('pointermove', onAgentBallMove)
  window.removeEventListener('pointerup', onAgentBallUp)
  window.removeEventListener('pointercancel', onAgentBallCancel)
  releasePointerCapture(drag.captureTarget, drag.pointerId)
  agentBallDrag = null
  // released inside the right-edge release band → convert the float dock to a sidebar
  const droppedInZone = toggle && drag.moved && agentDropZoneActive.value && agentSidebarAvailable.value
  agentDropZoneVisible.value = false
  agentDropZoneActive.value = false
  if (droppedInZone) { setAgentDisplayMode('sidebar'); agentOpen.value = false; return true }
  // a drag that never crossed the threshold is just a click on the ball → toggle window.
  if (toggle && !drag.moved) agentOpen.value = !agentOpen.value
  return true
}
const onAgentBallDown = (e) => {
  if (e.isPrimary === false || e.button !== 0) return
  cleanupAgentBallDrag()
  const r = e.currentTarget.getBoundingClientRect()
  // fixed positioning is relative to the viewport WITHOUT the scrollbar —
  // use clientWidth/Height, not innerWidth/Height (15px scrollbar skew)
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  agentBallDrag = {
    startX: e.clientX,
    startY: e.clientY,
    originRight: vw - r.right,
    originBottom: vh - r.bottom,
    ballW: r.width,
    ballH: r.height,
    pointerId: e.pointerId,
    captureTarget: e.currentTarget,
    threshold: e.pointerType === 'mouse' ? 5 : 10,
    moved: false
  }
  try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* synthetic pointer */ }
  window.addEventListener('pointermove', onAgentBallMove)
  window.addEventListener('pointerup', onAgentBallUp)
  window.addEventListener('pointercancel', onAgentBallCancel)
  e.preventDefault()
}
const onAgentBallMove = (e) => {
  if (!agentBallDrag || e.pointerId !== agentBallDrag.pointerId) return
  const dx = e.clientX - agentBallDrag.startX
  const dy = e.clientY - agentBallDrag.startY
  if (!agentBallDrag.moved && Math.hypot(dx, dy) < agentBallDrag.threshold) return
  if (!agentBallDrag.moved) {
    agentBallDrag.moved = true
    hideHoverAnnotation()
  }
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  agentDockPos.value = {
    right: Math.min(Math.max(0, agentBallDrag.originRight - dx), Math.max(0, vw - agentBallDrag.ballW)),
    bottom: Math.min(Math.max(0, agentBallDrag.originBottom - dy), Math.max(0, vh - agentBallDrag.ballH))
  }
  // float → sidebar: dragging the ball near the right-center edge fades the indicator
  // in; once the pointer is over the painted strip it's "hot" and a release converts.
  // The hot test uses the exact same W/H/centre as the painted box, so they never drift.
  if (agentSidebarAvailable.value) {
    agentDropZoneVisible.value = e.clientX >= vw - AGENT_DROP_PROX
    agentDropZoneActive.value = e.clientX >= vw - AGENT_DROP_W && Math.abs(e.clientY - vh / 2) <= AGENT_DROP_H / 2
  }
  if (e.cancelable) e.preventDefault()
}
const onAgentBallUp = (e) => { cleanupAgentBallDrag(e, true) }
const onAgentBallCancel = (e) => { cleanupAgentBallDrag(e, false) }

// ---- Resizable agent window ----
// The panel is anchored bottom-right (at the mascot), so it grows toward the
// top-left; the left/top handles change size with the anchor fixed, while the
// right handle grows rightward by also shifting the dock left. Size persists.
const AGENT_SIZE_KEY = 'knote-agent-size'
const agentSize = ref((() => { try { const v = JSON.parse(localStorage.getItem(AGENT_SIZE_KEY) || 'null'); return (v && v.w > 0 && v.h > 0) ? v : null } catch { return null } })())
const agentDefaultW = computed(() => (agentWorkspaceOpen.value ? 640 : 416)) // 40rem / 26rem
const AGENT_DEFAULT_H = 576 // 36rem
const agentResized = computed(() => !!agentSize.value)
// only override the class-based default size once the user has resized
const agentPanelStyle = computed(() => {
  if (!agentSize.value) return {}
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  return { width: Math.min(agentSize.value.w, vw - 24) + 'px', height: Math.min(agentSize.value.h, vh - 24) + 'px' }
})
const resetAgentSize = () => { agentSize.value = null; try { localStorage.removeItem(AGENT_SIZE_KEY) } catch { /* ignore */ } }
const recallAgent = () => {
  // In sidebar mode "换回助手" is meaningless — the assistant is already pinned
  // on screen — so the recall entries are disabled and this is a no-op.
  if (showAgentSidebar.value) return
  agentDockPos.value = null
  agentOpen.value = true
}
let agentResizeDrag = null
const onAgentResizeDown = (dir, e) => {
  if (e.isPrimary === false || e.button !== 0) return
  cleanupAgentResize()
  agentResizeDrag = {
    dir,
    startX: e.clientX,
    startY: e.clientY,
    startW: agentSize.value ? agentSize.value.w : agentDefaultW.value,
    startH: agentSize.value ? agentSize.value.h : AGENT_DEFAULT_H,
    startRight: agentDockPos.value ? agentDockPos.value.right : 24,
    startBottom: agentDockPos.value ? agentDockPos.value.bottom : 24,
    pointerId: e.pointerId,
    captureTarget: e.currentTarget
  }
  try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* synthetic pointer */ }
  window.addEventListener('pointermove', onAgentResizeMove)
  window.addEventListener('pointerup', onAgentResizeUp)
  window.addEventListener('pointercancel', onAgentResizeCancel)
  e.preventDefault()
  e.stopPropagation()
}
const onAgentResizeMove = (e) => {
  const d = agentResizeDrag
  if (!d || e.pointerId !== d.pointerId) return
  const dx = e.clientX - d.startX
  const dy = e.clientY - d.startY
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  let w = d.startW
  let h = d.startH
  let right = d.startRight
  let bottom = d.startBottom
  // each corner keeps its OPPOSITE corner fixed; left/top change size in place,
  // right/bottom grow by shifting the dock (which the mascot rides on) outward
  if (d.dir.includes('w')) w = d.startW - dx
  if (d.dir.includes('e')) { w = d.startW + dx; right = d.startRight - dx }
  if (d.dir.includes('n')) h = d.startH - dy
  if (d.dir.includes('s')) { h = d.startH + dy; bottom = d.startBottom - dy }
  w = Math.max(320, Math.min(w, vw - 24))
  h = Math.max(360, Math.min(h, vh - 24))
  agentSize.value = { w, h }
  if (d.dir.includes('e') || d.dir.includes('s')) {
    agentDockPos.value = { right: Math.max(0, Math.min(right, vw - 120)), bottom: Math.max(0, Math.min(bottom, vh - 120)) }
  }
  if (e.cancelable) e.preventDefault()
}
const cleanupAgentResize = (event = null, persist = false) => {
  const drag = agentResizeDrag
  if (!drag || (event && event.pointerId !== drag.pointerId)) return false
  window.removeEventListener('pointermove', onAgentResizeMove)
  window.removeEventListener('pointerup', onAgentResizeUp)
  window.removeEventListener('pointercancel', onAgentResizeCancel)
  releasePointerCapture(drag.captureTarget, drag.pointerId)
  agentResizeDrag = null
  if (persist && agentSize.value) { try { localStorage.setItem(AGENT_SIZE_KEY, JSON.stringify(agentSize.value)) } catch { /* quota */ } }
  return true
}
const onAgentResizeUp = (e) => { cleanupAgentResize(e, true) }
const onAgentResizeCancel = (e) => { cleanupAgentResize(e, false) }
const cancelAgentPointerGestures = () => {
  cleanupAgentBallDrag()
  cleanupAgentResize()
}

// ---- Kiwi mascot: map real agent state -> the mascot's animation states ----
const mascotOverride = ref('hello') // transient one-shots: hello (load), done/error (run end)
const mascotState = computed(() => {
  // a LIVE run always wins, so a lingering done/hello/error one-shot can't mask it
  if (agentStatus.value === 'running') return 'working'
  if (pendingHunksForCurrentDocument.value.length) return 'waiting'
  if (mascotOverride.value) return mascotOverride.value
  return 'idle'
})
const mascotMessage = computed(() => {
  // the open chat window already shows live activity — the bubble would be
  // redundant noise floating over it. It comes back when the chat closes
  // (unless the user muted it for this session).
  if (agentOpen.value) return ''
  const s = mascotState.value
  if (s === 'working') return agentActivity.value || (lang.value === 'zh' ? '正在思考…' : 'Thinking…')
  if (s === 'waiting') return lang.value === 'zh' ? `请审核我的修改（${pendingHunksForCurrentDocument.value.length} 处）` : `Please review my ${pendingHunksForCurrentDocument.value.length} change(s)`
  if (s === 'error') return lang.value === 'zh' ? '出错了，点开查看' : 'Something went wrong — open to see'
  return ''
})
const flashMascot = (state, ms) => {
  mascotOverride.value = state
  setTimeout(() => { if (mascotOverride.value === state) mascotOverride.value = '' }, ms)
}
// greet once on load, then hand control back to the live state
setTimeout(() => { if (mascotOverride.value === 'hello') mascotOverride.value = '' }, 1900)
// when a run ends: show 'error' if it failed, else celebrate 'done' (only when
// there's nothing left to review — a pending review drives 'waiting' instead)
watch(agentStatus, (now, prev) => {
  if (prev === 'running' && now !== 'running') {
    if (agentError.value) flashMascot('error', 2600)
    else if (!pendingHunksForCurrentDocument.value.length) flashMascot('done', 2100)
    // Split view can't paint the in-document diff (agentBridge.previewChange is
    // single-mode only), so when a run leaves staged changes pending review while
    // in split, drop back to single to show them — the viewMode watcher repaints the
    // staged hunks via scheduleAgentPreviewResync. Returning to split stays manual.
    if (viewMode.value === 'split' && pendingHunksForCurrentDocument.value.length) setViewMode('single')
  }
})

// ---- Assistant display mode: floating dock ⇄ right sidebar ----
// One persisted enum picks which single assistant surface is live; everything
// else (split/single, centered, resize) is derived from computeds, not watchers.
const AGENT_DISPLAY_KEY = 'knote-agent-display-v1'
const agentDisplayMode = ref((() => {
  try { return localStorage.getItem(AGENT_DISPLAY_KEY) === 'sidebar' ? 'sidebar' : 'float' } catch { return 'float' }
})())
const setAgentDisplayMode = (m) => {
  agentDisplayMode.value = m === 'sidebar' ? 'sidebar' : 'float'
  try { localStorage.setItem(AGENT_DISPLAY_KEY, agentDisplayMode.value) } catch { /* quota */ }
}
// Wide-enough flag so a narrow window never hides BOTH the float and the sidebar.
const agentSidebarMedia = typeof window !== 'undefined' ? window.matchMedia('(min-width: 64rem)') : null
const agentSidebarWide = ref(agentSidebarMedia?.matches === true)
const syncAgentSidebarMedia = () => { agentSidebarWide.value = agentSidebarMedia?.matches === true }
let agentSidebarMediaListening = false
const listenAgentSidebarMedia = () => {
  if (agentSidebarMediaListening) return
  agentSidebarMediaListening = true
  if (agentSidebarMedia?.addEventListener) agentSidebarMedia.addEventListener('change', syncAgentSidebarMedia)
  else agentSidebarMedia?.addListener?.(syncAgentSidebarMedia)
  syncAgentSidebarMedia()
}
const unlistenAgentSidebarMedia = () => {
  if (!agentSidebarMediaListening) return
  agentSidebarMediaListening = false
  if (agentSidebarMedia?.removeEventListener) agentSidebarMedia.removeEventListener('change', syncAgentSidebarMedia)
  else agentSidebarMedia?.removeListener?.(syncAgentSidebarMedia)
}
// The right sidebar only exists in single+centered mode on a wide desktop; split,
// PDF/preview and Android fall back to the floating dock. Large documents keep the
// sidebar — the assistant stays usable on them (it reads/edits the large doc), matching
// the pre-sidebar behaviour where the panel was never gated on document size.
const agentSidebarAvailable = computed(() =>
  viewMode.value === 'single' && editorCentered.value &&
  !pdfView.value && !docPreviewHtml.value &&
  !androidLayoutActive.value && agentSidebarWide.value)
const showAgentSidebar = computed(() => agentDisplayMode.value === 'sidebar' && agentSidebarAvailable.value)
const showAgentFloatDock = computed(() => !showAgentSidebar.value)
// sidebar → float (Req 4): a plain click on the sidebar header's kiwi button
// converts back to the floating dock (the sidebar disappears). Dragging the icon
// was dropped — the button is the only trigger now. The chat window stays CLOSED
// on conversion (NewReq-6): only the kiwi ball appears; clicking it opens the chat.
const onAgentSidebarToFloat = () => { setAgentDisplayMode('float'); agentOpen.value = false }
// Top-navbar assistant button (Req 4 click entry): when the sidebar is available it
// toggles float ⇄ sidebar; otherwise it opens/closes the floating window in place.
// Converting sidebar → float also keeps the chat closed (only the ball shows).
const onNavbarAgent = () => {
  if (agentSidebarAvailable.value) {
    if (showAgentSidebar.value) { setAgentDisplayMode('float'); agentOpen.value = false }
    else { setAgentDisplayMode('sidebar'); agentOpen.value = false }
  } else if (agentOpen.value) agentOpen.value = false
  else recallAgent()
  blurActiveElement()
}
// split / narrow-window / pdf → the sidebar is unavailable and disappears, and the
// floating dock takes over. Per NewReq-7 the chat window stays CLOSED here too —
// only the kiwi ball appears; clicking it opens the chat. displayMode stays
// 'sidebar', so returning to single+centered restores the sidebar automatically.
const mobileFilesOpen = ref(false)
const closeMobilePanels = () => {
  mobileFilesOpen.value = false
  agentOpen.value = false
}
const openMobileFiles = () => {
  agentOpen.value = false
  mobileFilesOpen.value = true
}
const openMobileEditor = () => closeMobilePanels()
const openMobileAgent = () => {
  mobileFilesOpen.value = false
  agentWorkspaceOpen.value = false
  recallAgent()
}

// ========== Floating split-mode sidebar ==========
// Split view hides the left sidebar to keep both columns wide. Hovering the
// right edge slides the outline + file tree in as an overlay (it never
// reflows the two columns); leaving the panel/edge slides it back out.
const floatingSidebarOpen = ref(false)
let floatingSidebarHideTimer = null
const floatingSidebarShow = () => {
  if (floatingSidebarHideTimer) {
    clearTimeout(floatingSidebarHideTimer)
    floatingSidebarHideTimer = null
  }
  floatingSidebarOpen.value = true
}
const floatingSidebarCancelHide = () => {
  if (floatingSidebarHideTimer) {
    clearTimeout(floatingSidebarHideTimer)
    floatingSidebarHideTimer = null
  }
}
const floatingSidebarHide = () => {
  if (floatingSidebarHideTimer) return
  // While a popup menu is open (rendered at body level, outside the panel),
  // moving the pointer onto it must not collapse the panel.
  if (floatingMenu.value) return
  // Grace window: the pointer travels from the edge zone onto the panel, so
  // only hide once it has left both for a beat (no flicker mid-transition).
  floatingSidebarHideTimer = setTimeout(() => {
    floatingSidebarHideTimer = null
    floatingSidebarOpen.value = false
    floatingMenu.value = null
  }, 250)
}

// Fixed-position popups for the floating/sidebar actions card: the panel's
// scroll container would clip daisyUI's absolute dropdowns, so these render
// at body level, anchored to the trigger button (same UX as the navbar).
const floatingMenu = ref(null) // 'open' | 'theme' | 'menu' | null
const floatingMenuAnchor = ref({ top: 0, left: 0 })
const FLOATING_MENU_WIDTH = 200
const openFloatingMenu = (kind, event) => {
  const rect = event.currentTarget.getBoundingClientRect()
  // Right-align to the trigger (dropdown-end semantics) and clamp into the
  // viewport: in split view the trigger sits against the right screen edge,
  // where a left-aligned menu would overflow past it.
  const left = Math.max(8, rect.right - FLOATING_MENU_WIDTH)
  floatingMenuAnchor.value = { top: rect.bottom + 6, left }
  floatingMenu.value = floatingMenu.value === kind ? null : kind
}
const closeFloatingMenu = () => { floatingMenu.value = null }

// ========== Outline (document structure panel) ==========
const outlineVisible = ref(true)
const sidebarRailRef = ref(null)
// The blank gutter always drives the whole rail. Inside a card, the wheel stays
// local while that card can still scroll; once it reaches either boundary, the
// same gesture is handed to the whole rail.
const onSidebarWheel = (event) => {
  if (event.ctrlKey || !event.deltaY) return
  const rail = sidebarRailRef.value
  if (!(rail instanceof HTMLElement)) return
  const unit = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? rail.clientHeight : 1
  const delta = event.deltaY * unit

  const target = event.target
  const cardScroller = target instanceof Element
    ? target.closest('.knote-sidebar-card-scroll, .knote-agent-input')
    : null
  if (cardScroller instanceof HTMLElement && rail.contains(cardScroller)) {
    const cardMax = Math.max(0, cardScroller.scrollHeight - cardScroller.clientHeight)
    const canKeepScrollingCard = delta < 0
      ? cardScroller.scrollTop > 1
      : cardScroller.scrollTop < cardMax - 1
    if (canKeepScrollingCard) return
  }

  const max = Math.max(0, rail.scrollHeight - rail.clientHeight)
  const next = Math.max(0, Math.min(max, rail.scrollTop + delta))

  event.preventDefault()
  event.stopPropagation()
  if (Math.abs(next - rail.scrollTop) > 0.5) {
    rail.scrollTop = next
    return
  }

  // At the rail boundary the gesture stops here instead of unexpectedly moving
  // the editor page behind the fixed sidebar.
}
const outlineItems = ref([])
const outlineTruncated = ref(false)
let documentAnalysisTimer = null
let documentAnalysisGeneration = 0
let documentAnalysisCache = {
  source: null,
  imageVersion: -1,
  stats: null,
  missingImageCount: null,
  outline: null,
  outlineTruncated: false
}
// Collapsible outline: rows under a collapsed heading are hidden and the first
// `outlineRenderLimit` rows are mounted (progressive reveal keeps a 4000-row
// outline cheap). Both are pure view-model concerns over the cached outline.
const collapsedOutlineIds = ref(new Set())
const OUTLINE_RENDER_INITIAL = 240
const outlineRenderLimit = ref(OUTLINE_RENDER_INITIAL)
const outlineSentinelEl = ref(null)
let outlineSentinelObserver = null
const OUTLINE_COLLAPSE_KEY = (docKey) => `knote-outline-collapsed:${docKey}`
const loadOutlineCollapsedState = () => {
  const docKey = snapshotDocKey()
  if (!docKey) {
    collapsedOutlineIds.value = new Set()
    return
  }
  let saved = null
  try { saved = JSON.parse(localStorage.getItem(OUTLINE_COLLAPSE_KEY(docKey)) || 'null') } catch { saved = null }
  collapsedOutlineIds.value = new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [])
}
const persistOutlineCollapsedState = () => {
  const docKey = snapshotDocKey()
  if (!docKey) return
  try { localStorage.setItem(OUTLINE_COLLAPSE_KEY(docKey), JSON.stringify([...collapsedOutlineIds.value])) } catch { /* quota */ }
}
const toggleOutlineCollapsed = (id) => {
  const next = new Set(collapsedOutlineIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsedOutlineIds.value = next
  persistOutlineCollapsedState()
}
const outlineSidebarView = computed(() =>
  filterOutlineItemsForSidebar(outlineItems.value, collapsedOutlineIds.value, outlineRenderLimit.value))
const visibleOutlineItems = computed(() => outlineSidebarView.value.visible)
const outlineNodeHasChildren = computed(() => outlineSidebarView.value.hasChildren)
const outlineHasMore = computed(() => visibleOutlineItems.value.length < outlineItems.value.length)
watch(() => snapshotDocKey(), () => {
  outlineRenderLimit.value = OUTLINE_RENDER_INITIAL
  loadOutlineCollapsedState()
  // A NEW document must recompute its outline even in chunked mode: the
  // previous document's cached outline (possibly an empty one from the
  // welcome/blank screen) must never stick. Invalidate source+outline so the
  // next analysis pass treats it as fresh.
  documentAnalysisCache = {
    ...documentAnalysisCache,
    source: null,
    outline: null,
    outlineTruncated: false
  }
})
if (typeof IntersectionObserver === 'function') {
  outlineSentinelObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      outlineRenderLimit.value = Math.min(outlineItems.value.length, outlineRenderLimit.value + 240)
    }
  }, { rootMargin: '160px 0px' })
}
watch(outlineSentinelEl, (element, previous) => {
  if (outlineSentinelObserver) {
    if (previous) outlineSentinelObserver.unobserve(previous)
    if (element) outlineSentinelObserver.observe(element)
  }
})

// Statistics, missing-image validation and the visible outline share one
// chunked pass. This removes two synchronous/full scans from every large-file
// navigation. A hidden outline remains cold and, when later opened, only the
// heading part is computed; cached statistics are not counted again.
watch(
  [content, outlineVisible, viewMode, floatingSidebarOpen, () => Object.keys(imageStore).length],
  ([source, visible, mode, floatingOpen, imageVersion]) => {
    const generation = ++documentAnalysisGeneration
    clearTimeout(documentAnalysisTimer)
    // Outline analysis only ran for single mode; the floating split-mode
    // sidebar needs a live outline too, so also analyse while it is open.
    const wantOutline = visible && (mode === 'single' || (mode === 'split' && floatingOpen))
    const sameSource = documentAnalysisCache.source === source
    const sameImages = documentAnalysisCache.imageVersion === imageVersion

    // Opening the sidebar must never wait on a rescan: paint the last known
    // outline immediately (its offsets are re-verified on click navigation)
    // and let the fresh pass below refresh it in the background.
    if (wantOutline && documentAnalysisCache.outline) {
      outlineItems.value = documentAnalysisCache.outline
      outlineTruncated.value = documentAnalysisCache.outlineTruncated
    }

    if (sameSource && sameImages && documentAnalysisCache.stats) {
      stats.value = documentAnalysisCache.stats
      missingImageCount.value = documentAnalysisCache.missingImageCount || 0
      if (!wantOutline || documentAnalysisCache.outline) {
        if (wantOutline) {
          outlineItems.value = documentAnalysisCache.outline
          outlineTruncated.value = documentAnalysisCache.outlineTruncated
        }
        return
      }
    }

    const includeStats = !sameSource || !documentAnalysisCache.stats
    const includeMissingImages = !sameSource || !sameImages || documentAnalysisCache.missingImageCount == null
    // The outline is only reusable when the cached source IS the current
    // source. A new document (or an in-between blank tab state) must always
    // recompute: a stale empty outline cached from an intermediate state used
    // to stick forever in chunked mode. Editing cost is bounded by the
    // debounce above (large documents wait 500ms after a typing pause).
    const includeOutline = wantOutline && (!sameSource || !documentAnalysisCache.outline)
    if (!includeStats && !includeMissingImages && !includeOutline) return

    // Let navigation/paint win before starting background analysis. Each pass
    // remains cancellable at a bounded chunk if the user types or switches.
    // Large documents wait much longer: the full-document scan runs only after
    // a typing pause, otherwise every keystroke on a multi-megabyte file would
    // keep re-scanning stats + outline while the sidebar is open.
    const delay = source.length > 200_000 ? 500 : 35
    documentAnalysisTimer = setTimeout(() => {
      void analyzeDocumentChunked(source, {
        includeStats,
        includeMissingImages,
        includeOutline,
        maxOutlineItems: 4_000,
        hasImage: (id) => !!imageStore[id],
        shouldCancel: () => generation !== documentAnalysisGeneration
      }).then((result) => {
        if (!result || generation !== documentAnalysisGeneration) return
        const cache = sameSource
          ? { ...documentAnalysisCache }
          : {
              source,
              imageVersion,
              stats: null,
              missingImageCount: null,
              outline: null,
              outlineTruncated: false
            }
        cache.source = source
        cache.imageVersion = imageVersion
        if (result.stats) cache.stats = result.stats
        if (result.missingImageCount != null) cache.missingImageCount = result.missingImageCount
        if (result.outline) {
          cache.outline = result.outline
          cache.outlineTruncated = result.outlineTruncated
        }
        documentAnalysisCache = cache
        if (cache.stats) stats.value = cache.stats
        missingImageCount.value = cache.missingImageCount || 0
        if (wantOutline && cache.outline) {
          outlineItems.value = cache.outline
          outlineTruncated.value = cache.outlineTruncated
        }
      })
    }, delay)
  },
  { immediate: true }
)

const activeOutlineId = ref('')
let outlineNavigationGeneration = 0
const scrollToBlock = async (id) => {
  const generation = ++outlineNavigationGeneration
  let item = outlineItems.value.find((o) => o.id === id)
  if (viewMode.value === 'single') {
    if (!item) return
    activeOutlineId.value = item.id
    if (largeDocumentPlainMode.value) {
      largeRichEditorRef.value?.flushEmit?.()
      commitLargeSourceDraft('outline-navigation')

      // A heading click is infrequent and correctness matters more than using
      // potentially stale offsets after edits in an earlier chunk. Refresh the
      // outline against the committed source before selecting the target page.
      if (documentAnalysisCache.source !== content.value) {
        const result = await analyzeDocumentChunked(content.value, {
          includeStats: false,
          includeMissingImages: false,
          includeOutline: true,
          maxOutlineItems: 4_000,
          shouldCancel: () => generation !== outlineNavigationGeneration
        })
        if (!result || generation !== outlineNavigationGeneration) return
        const candidates = result.outline.filter((candidate) =>
          candidate.level === item.level && candidate.text === item.text)
        const refreshed = candidates.sort((a, b) =>
          Math.abs(a.offset - item.offset) - Math.abs(b.offset - item.offset))[0]
          || result.outline[item.index]
        outlineItems.value = result.outline
        outlineTruncated.value = result.outlineTruncated
        if (refreshed) item = refreshed
      }

      const offsets = buildLargeSourceOffsets(content.value, LARGE_SOURCE_CHUNK_SIZE)
      largeSourceOffsets.value = offsets
      const page = findLargeSourcePageByOffset(offsets, item.offset)
      openLargeSourcePage(page, { focus: false })
      const pageState = readLargeSourcePage(content.value, offsets, page)
      const localHeadings = outlineItems.value.filter((heading) =>
        heading.offset >= pageState.start && heading.offset < pageState.end)
      const localIndex = Math.max(0, localHeadings.findIndex((heading) => heading.offset === item.offset))
      const matchingBefore = localHeadings.slice(0, localIndex).filter((heading) =>
        heading.level === item.level && heading.text === item.text).length
      await nextTick()
      await nextAnimationFrame()
      if (generation !== outlineNavigationGeneration) return
      largeRichEditorRef.value?.focusHeading?.({
        level: item.level,
        text: item.text,
        occurrence: matchingBefore,
        localIndex
      })
    } else if (richEditorRef.value) {
      richEditorRef.value.focusHeading({
        level: item.level,
        text: item.text,
        localIndex: item.index,
        occurrence: outlineItems.value.slice(0, item.index).filter((heading) =>
          heading.level === item.level && heading.text === item.text).length
      })
    }
    return
  }
  const headings = document.querySelectorAll('.knote-md-render h1, .knote-md-render h2, .knote-md-render h3, .knote-md-render h4, .knote-md-render h5, .knote-md-render h6')
  const el = item ? headings[item.index] : null
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

// ========== Tabs (browser-style, hosted in the desktop title bar) ==========
// Each tab is a full workspace snapshot. Two kinds: DOC tabs hold one
// markdown document; FOLDER tabs hold an opened folder workspace (tree +
// whichever file was opened from it — tree opens stay inside their folder
// tab, they never spawn tabs). The markdown string remains the single
// source of truth per tab; the editor's EditorState snapshot additionally
// preserves each tab's own undo history and caret across switches.
let tabSeq = 0
const TAB_BUFFER_THRESHOLD = 300_000
const TAB_BUFFER_HUGE_THRESHOLD = 1_500_000
const MAX_HOT_BACKGROUND_TABS = 1
const MAX_HOT_BACKGROUND_BYTES = 1_200_000
const MAX_HOT_HUGE_BACKGROUND_TABS = 0
const TAB_BUFFER_SESSION_ID = (() => {
  try { return globalThis.crypto.randomUUID() } catch { return `session-${Date.now()}-${Math.random().toString(36).slice(2)}` }
})()
const tabBufferApi = window.knoteDesktop &&
  window.knoteDesktop.tabBufferPut &&
  window.knoteDesktop.tabBufferGet &&
  window.knoteDesktop.tabBufferDrop
  ? window.knoteDesktop
  : null
let tabSwitchGeneration = 0
let tabRestoreGeneration = 0
let residencySweepScheduled = false
let residencySweepHandle = null
let residencySweepChain = Promise.resolve()
let rendererQuitFlushing = false
let rendererQuitFlushPromise = null
let rendererQuitFlushToken = ''
let rendererQuitWorkChain = Promise.resolve()
let rendererQuitGeneration = 0
let stopPrepareQuit = null
let stopQuitCancelled = null

// markRaw is LOAD-BEARING: tab objects hold a ProseMirror EditorState and
// FileSystemHandles. Inside a deep-reactive array Vue would hand back
// reactive PROXIES of them on read — a proxied EditorState fed into
// view.updateState poisons ProseMirror's identity comparisons (raw
// editor.schema vs proxied state.schema) and every later setContent
// silently filters ALL nodes as invalid → permanently blank editor.
// The tabs ARRAY stays reactive (push/splice drive the strip UI); label/
// kind re-render is triggered by the activeTabId ref changing on switch.
const mkTab = (over = {}) => markRaw({
  id: ++tabSeq,
  kind: 'doc',
  title: '',
  deskKey: '', // desktop identity (`file:`/`folder:` + path) for dedupe
  content: '',
  exportedMd: '',
  editorState: null,
  scrollTop: 0,
  editorScrollTop: 0,
  fileHandle: null,
  fileWorkspaceId: '',
  fileWorkspaceIdentityDurable: false,
  isLocal: false,
  fileName: '',
  treePath: '',
  folderHandle: null,
  folderName: '',
  folderWorkspaceId: '',
  folderWorkspaceIdentityDurable: false,
  folderTree: [],
  expandedDirs: new Set(),
  outline: true,
  undo: [],
  redo: [],
  lastSaved: null,
  resident: true,
  bufferRef: null,
  bufferGeneration: 0,
  buffering: false,
  documentGeneration: 1,
  agentResidencyLeases: 0,
  agentLeaseWaiters: new Set(),
  agentClosing: false,
  lastAccessAt: Date.now(),
  baseContent: '', // creation-time content: unchanged + no handles = pristine
  relImagesNeedGrant: false, // browser single-file: rel images need a folder grant
  docDir: null, // the doc's own directory handle (for writing assets/ images)
  activeDirPath: '', // header "new file/folder" target dir within the workspace
  largeSourcePage: 0,
  openToken: null,
  ...over
})
const tabs = ref([])
const activeTabId = ref(0)
const activeTab = () => tabs.value.find((tb) => tb.id === activeTabId.value)

// RichEditor clears decorations while loading another file. Reconcile the
// staged diff after every document-identity change: the owning document gets
// its red/green preview back; every other document stays clean. This watcher
// must be registered only after activeTab exists: Vue evaluates a watch getter
// immediately to collect dependencies, so registering it earlier throws a
// temporal-dead-zone ReferenceError during application startup.
watch(() => agentDocumentKey(), () => {
  scheduleAgentPreviewResync({ clear: true })
}, { flush: 'sync' })
{
  const first = mkTab({ content: sampleZh, baseContent: sampleZh })
  tabs.value.push(first)
  activeTabId.value = first.id
}

// Tabs are markRaw, so pathless/read-only file identity changes need an
// explicit reactive revision. Active-tab changes and every identity install,
// clear, or restore all republish the exact workspace before Agent UI work.
watch([folderHandle, currentFileHandle, folderWorkspaceId, activeTabId, workspaceIdentityRevision], () => {
  const tb = activeTab()
  setChatWorkspace({
    id: agentWorkspaceIdentity(),
    legacyIds: agentLegacyWorkspaceIds(),
    surface: {
      workspaceId: agentWorkspaceIdentity(),
      documentId: agentSurfaceDocumentKeyForTab(tb),
      tabId: tb?.id || 0
    }
  })
}, { immediate: true })

const dropTabBufferRef = async (ref) => {
  if (!tabBufferApi || !ref) return false
  try { return await tabBufferApi.tabBufferDrop(ref) } catch { return false }
}

// ProseMirror history cannot be safely reconstructed from Markdown alone.
// Tabs with a real undo/redo branch therefore stay resident; untouched/clean
// large tabs are the ones eligible for disk cooling. Source-mode history uses
// the parallel Markdown stacks and follows the same invariant.
const editorStateHasUndoHistory = (state) => {
  if (!state || !Array.isArray(state.plugins)) return false
  return state.plugins.some((plugin) => {
    try {
      const history = plugin && typeof plugin.getState === 'function' ? plugin.getState(state) : null
      return Number(history?.done?.eventCount || 0) > 0 || Number(history?.undone?.eventCount || 0) > 0
    } catch {
      return false
    }
  })
}
const tabCanOffload = (tb) => {
  if (tb?.agentClosing) return false
  if (Number(tb?.agentResidencyLeases || 0) > 0) return false
  const bytes = Math.max(
    typeof tb?.content === 'string' ? tb.content.length : 0,
    typeof tb?.exportedMd === 'string' ? tb.exportedMd.length : 0
  )
  if (documentIsAheadOfDisk(snapshotDocKeyForTab(tb))) return false
  // For large documents, verified disk buffering takes priority over keeping
  // megabytes of undo/editor state alive in a background tab. Small documents
  // retain their complete in-memory undo history.
  if (bytes >= TAB_BUFFER_THRESHOLD) return true
  return !((Array.isArray(tb?.undo) && tb.undo.length) ||
    (Array.isArray(tb?.redo) && tb.redo.length) ||
    editorStateHasUndoHistory(tb?.editorState))
}

// Write a background snapshot, read it back through the signed IPC, and only
// then release the large renderer objects. Every state comparison below is
// intentional: a slow write must never evict a tab that was activated, edited,
// closed, or superseded while the main process was doing disk I/O.
const offloadTab = async (tb) => {
  if (!tabBufferApi || !tb || tb.agentClosing || !tb.resident || tb.buffering || tb.id === activeTabId.value) return false
  if (Number(tb.agentResidencyLeases || 0) > 0) return false
  if (pendingHunksBelongToDocument(agentDocumentKeyForTab(tb))) return false
  if (!tabCanOffload(tb)) return false
  if (typeof tb.content !== 'string') return false
  const sourceContent = tb.content
  const sourceExportedState = tb.exportedMd
  // captureActiveTab always materializes this before a tab becomes a
  // background candidate. Refuse an unexpected legacy shape instead of doing
  // a surprise multi-megabyte export on the first idle callback.
  if (typeof sourceExportedState !== 'string') return false
  const serialized = sourceExportedState
  const sourceEditorState = tb.editorState
  const sourceUndo = tb.undo
  const sourceRedo = tb.redo
  const sourceLastSaved = tb.lastSaved
  const previousRef = tb.bufferRef
  const generation = ++tb.bufferGeneration
  tb.buffering = true
  let ref = null
  try {
    ref = await tabBufferApi.tabBufferPut(TAB_BUFFER_SESSION_ID, String(tb.id), serialized)
    if (!ref || ref.kind !== 'knote-tab-buffer') throw new Error('tab buffer put was not verified')
    const unchanged = tabs.value.includes(tb) &&
      tb.id !== activeTabId.value &&
      tb.resident &&
      tb.bufferGeneration === generation &&
      tb.content === sourceContent &&
      tb.exportedMd === sourceExportedState &&
      tb.editorState === sourceEditorState &&
      tb.undo === sourceUndo &&
      tb.redo === sourceRedo &&
      tb.lastSaved === sourceLastSaved &&
      Number(tb.agentResidencyLeases || 0) === 0
    if (!unchanged) {
      await dropTabBufferRef(ref)
      return false
    }
    tb.bufferRef = ref
    tb.resident = false
    tb.content = null
    tb.exportedMd = null
    tb.editorState = null
    tb.undo = []
    tb.redo = []
    tb.lastSaved = null
    if (previousRef && previousRef !== ref) void dropTabBufferRef(previousRef)
    return true
  } catch (error) {
    // Safety invariant: no field above is cleared before verification. If a
    // later guard fails, clean only the untrusted/new disk object.
    if (ref && tb.bufferRef !== ref) await dropTabBufferRef(ref)
    console.warn('Tab buffer write kept in memory:', error)
    return false
  } finally {
    if (tb.bufferGeneration === generation) tb.buffering = false
  }
}

const hydrateTab = async (tb) => {
  if (!tb) return false
  if (tb.resident) return true
  if (!tabBufferApi || !tb.bufferRef) return false
  const ref = tb.bufferRef
  const generation = ++tb.bufferGeneration
  try {
    const exported = await tabBufferApi.tabBufferGet(ref)
    if (typeof exported !== 'string') throw new Error('tab buffer is unavailable')
    if (!tabs.value.includes(tb) || tb.bufferRef !== ref || tb.bufferGeneration !== generation) return false
    const compact = importMarkdown(exported)
    tb.content = compact
    tb.exportedMd = exported
    tb.editorState = null
    tb.undo = []
    tb.redo = []
    // This is the source/split-mode undo checkpoint, not the file-save dirty
    // flag (autoSaveDirty owns that). Cold tabs intentionally discard undo
    // history, so the hydrated text becomes the new baseline without marking
    // a genuinely unsaved document as saved.
    tb.lastSaved = { content: compact, selection: null }
    tb.resident = true
    return true
  } catch (error) {
    console.error('Tab buffer hydration failed:', error)
    return false
  }
}

// Agent document targets are capabilities, not lookups. A binding keeps the
// exact raw tab object, tab id, document key, and replacement generation. Its
// lease prevents cooling while a run owns it; reads never activate the tab.
let agentDocumentBindingSequence = 0
const agentDocumentBindingStates = new WeakMap()
let e2eAgentDocumentCaptureGate = null
const holdNextAgentDocumentCapture = () => {
  if (!window.knoteDesktop?.isE2E || e2eAgentDocumentCaptureGate) return false
  let release
  const promise = new Promise((resolve) => { release = resolve })
  e2eAgentDocumentCaptureGate = { promise, release, waiting: false }
  return true
}
const releaseHeldAgentDocumentCapture = () => {
  if (!e2eAgentDocumentCaptureGate) return false
  e2eAgentDocumentCaptureGate.release()
  return true
}
const documentTargetFailure = (code, reason = '') => ({ ok: false, code, reason })
const agentDocumentRelativePathForTab = (tb) => {
  if (!tb) return ''
  const value = tb.id === activeTabId.value ? activeTreePath.value : tb.treePath
  return String(value || '').replace(/^\/+/, '')
}
const agentDocumentEditableForTab = (tb) => {
  if (!tb) return false
  if (tb.id === activeTabId.value) return !!agentBridge.isCurrentDocumentEditable()
  if (tb.treePath) {
    const node = walkTreeFiles(tb.folderTree || [], []).find((item) => item.path === tb.treePath)
    return !!node && node.ftype === 'md'
  }
  return tb.kind === 'doc' || (tb.kind === 'folder' && !tb.treePath)
}
const getAgentDocumentBindingStatus = (binding) => {
  const state = binding && agentDocumentBindingStates.get(binding)
  if (!state || state.released) return documentTargetFailure('TARGET_UNAVAILABLE', state?.released ? 'released' : 'invalid_binding')
  const tb = state.tab
  if (!tabs.value.includes(tb)) return documentTargetFailure('TARGET_CLOSED', 'tab_closed')
  if (tb.agentClosing) return documentTargetFailure('TARGET_CLOSED', 'tab_closing')
  if (tb !== binding.tab || tb.id !== binding.tabId ||
      Number(tb.documentGeneration || 1) !== binding.generation ||
      snapshotDocKeyForTab(tb) !== binding.identity ||
      agentDocumentKeyForTab(tb) !== binding.documentId) {
    return documentTargetFailure('TARGET_REPLACED', 'tab_document_replaced')
  }
  if (!tb.resident || typeof (tb.id === activeTabId.value ? content.value : tb.content) !== 'string') {
    return documentTargetFailure('TARGET_UNAVAILABLE', 'tab_buffer_unavailable')
  }
  return {
    ok: true,
    code: 'TARGET_READY',
    documentId: binding.documentId,
    tabId: binding.tabId,
    generation: binding.generation,
    revision: documentEditRevision(binding.identity),
    active: tb.id === activeTabId.value,
    editable: binding.editable,
    relativePath: binding.relativePath
  }
}
const releaseAgentDocumentBinding = (binding) => {
  const state = binding && agentDocumentBindingStates.get(binding)
  if (!state || state.released) return false
  state.released = true
  state.tab.agentResidencyLeases = Math.max(0, Number(state.tab.agentResidencyLeases || 0) - 1)
  if (state.tab.agentResidencyLeases === 0 && state.tab.agentLeaseWaiters instanceof Set) {
    for (const notifyReleased of [...state.tab.agentLeaseWaiters]) notifyReleased()
  }
  scheduleTabResidencySweep()
  return true
}
const waitForAgentDocumentLeases = (tb, timeoutMs = 5_000) => {
  if (!tb || Number(tb.agentResidencyLeases || 0) === 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (released) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      tb.agentLeaseWaiters.delete(onReleased)
      resolve(released)
    }
    const onReleased = () => {
      if (Number(tb.agentResidencyLeases || 0) === 0) finish(true)
    }
    tb.agentLeaseWaiters.add(onReleased)
    timer = setTimeout(() => finish(false), timeoutMs)
  })
}
const captureAgentDocumentTab = async (tb, { relativePath = '', requireEditable = false } = {}) => {
  if (!tb) return documentTargetFailure('TARGET_CLOSED', 'tab_not_found')
  if (tb.agentClosing) return documentTargetFailure('TARGET_CLOSED', 'tab_closing')
  const editable = agentDocumentEditableForTab(tb)
  if (requireEditable && !editable) return documentTargetFailure('TARGET_UNAVAILABLE', 'tab_not_editable')
  const binding = Object.freeze({
    id: `document-binding-${++agentDocumentBindingSequence}`,
    tab: tb,
    tabId: tb.id,
    documentId: agentDocumentKeyForTab(tb),
    agentDocumentKey: agentDocumentKeyForTab(tb),
    identity: snapshotDocKeyForTab(tb),
    generation: Number(tb.documentGeneration || 1),
    workspaceId: agentWorkspaceIdentityForTab(tb),
    relativePath: String(relativePath || agentDocumentRelativePathForTab(tb)),
    editable
  })
  const state = { tab: tb, released: false }
  agentDocumentBindingStates.set(binding, state)
  tb.agentResidencyLeases = Number(tb.agentResidencyLeases || 0) + 1

  let retained = false
  try {
    if (window.knoteDesktop?.isE2E && e2eAgentDocumentCaptureGate) {
      const gate = e2eAgentDocumentCaptureGate
      gate.waiting = true
      await gate.promise
      if (e2eAgentDocumentCaptureGate === gate) e2eAgentDocumentCaptureGate = null
    }
    if (!tb.resident) {
      const hydrated = await hydrateTab(tb)
      if (!hydrated) return documentTargetFailure('TARGET_UNAVAILABLE', 'tab_hydration_failed')
    }
    const status = getAgentDocumentBindingStatus(binding)
    if (!status.ok) return status
    retained = true
    return { ...status, code: 'TARGET_CAPTURED', binding }
  } catch {
    return documentTargetFailure('TARGET_UNAVAILABLE', 'tab_capture_failed')
  } finally {
    if (!retained) releaseAgentDocumentBinding(binding)
  }
}
const tabIdFromAgentDocumentKey = (documentId) => {
  const match = /::tab:(\d+)(?:::generation:\d+)?$/.exec(String(documentId || ''))
  return match ? Number(match[1]) : 0
}
agentBridge.captureCurrentDocument = async () => captureAgentDocumentTab(activeTab())
agentBridge.captureDocumentById = async (documentId) => {
  const wanted = String(documentId || '')
  const exact = tabs.value.find((tb) => agentDocumentKeyForTab(tb) === wanted)
  if (exact) return captureAgentDocumentTab(exact)
  const priorTabId = tabIdFromAgentDocumentKey(wanted)
  if (priorTabId && tabs.value.some((tb) => tb.id === priorTabId)) {
    return documentTargetFailure('TARGET_REPLACED', 'tab_document_replaced')
  }
  return documentTargetFailure('TARGET_CLOSED', 'tab_not_found')
}
agentBridge.captureDocumentByWorkspacePath = async (relativePath, options = {}) => {
  const workspace = resolveAgentWorkspaceBinding(options)
  if (!workspace) return documentTargetFailure('TARGET_UNAVAILABLE', 'workspace_unavailable')
  const path = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!path) return documentTargetFailure('TARGET_NOT_OPEN', 'empty_path')
  const treePath = '/' + path
  const rootDesk = workspace.handle?._deskPath
  const absoluteTarget = rootDesk
    ? rootDesk.replace(/[\\/]$/, '') + (rootDesk.includes('\\') ? '\\' : '/') + path.split('/').join(rootDesk.includes('\\') ? '\\' : '/')
    : ''
  const targetNode = treeNodeInBinding(workspace, path)
  const snapshots = tabs.value.map((tb) => {
    const active = tb.id === activeTabId.value
    return {
      tb,
      documentId: agentDocumentKeyForTab(tb),
      tabFolderHandle: active ? folderHandle.value : tb.folderHandle,
      tabTreePath: active ? activeTreePath.value : tb.treePath,
      tabFileHandle: active ? currentFileHandle.value : tb.fileHandle
    }
  })
  const candidates = new Set()
  for (const snapshot of snapshots) {
    const { tb, tabFolderHandle, tabTreePath, tabFileHandle } = snapshot
    let matches = tabFolderHandle === workspace.handle && tabTreePath === treePath
    const physicalPath = tabFileHandle?._deskPath || (String(tb.deskKey || '').startsWith('file:') ? String(tb.deskKey).slice(5) : '')
    if (!matches && absoluteTarget && physicalPath) matches = sameDeskKey(`file:${physicalPath}`, `file:${absoluteTarget}`)
    if (!matches && targetNode?.handle && tabFileHandle && typeof targetNode.handle.isSameEntry === 'function') {
      try { matches = await targetNode.handle.isSameEntry(tabFileHandle) } catch { matches = false }
    }
    if (!matches || !tabs.value.includes(tb) || tb.agentClosing || snapshot.documentId !== agentDocumentKeyForTab(tb)) continue
    if (agentDocumentEditableForTab(tb)) candidates.add(tb)
  }
  if (candidates.size > 1) return documentTargetFailure('TARGET_AMBIGUOUS', 'multiple_open_targets')
  const [target] = candidates
  if (!target) return documentTargetFailure('TARGET_NOT_OPEN', 'path_not_open_editable')
  return captureAgentDocumentTab(target, { relativePath: path, requireEditable: true })
}
agentBridge.readBoundDocument = (binding) => {
  let status = getAgentDocumentBindingStatus(binding)
  if (!status.ok) return status
  const tb = binding.tab
  if (tb.id === activeTabId.value) {
    richEditorRef.value?.flushEmit?.()
    largeRichEditorRef.value?.flushEmit?.()
    commitLargeSourceDraft('agent-bound-read')
    status = getAgentDocumentBindingStatus(binding)
    if (!status.ok) return status
  }
  const markdown = tb.id === activeTabId.value ? content.value : tb.content
  if (typeof markdown !== 'string') return documentTargetFailure('TARGET_UNAVAILABLE', 'tab_buffer_unavailable')
  return { ...status, markdown }
}
agentBridge.applyBoundDocument = (binding, request = {}) => {
  const current = agentBridge.readBoundDocument(binding)
  if (!current?.ok) return current
  if (String(request.documentId || '') !== String(current.documentId || '') ||
      Number(request.generation) !== Number(current.generation) ||
      String(request.revision ?? '') !== String(current.revision ?? '') ||
      String(request.expectedMarkdown ?? '') !== String(current.markdown ?? '')) {
    return documentTargetFailure('TARGET_UNAVAILABLE', 'document_revision_changed')
  }

  const nextContent = importMarkdown(String(request.markdown ?? ''))
  const tb = binding.tab
  if (tb.id === activeTabId.value) {
    agentBridge.applyMarkdown(request.markdown)
  } else {
    // Keep the exact background buffer resident without activating its tab.
    // Clearing EditorState forces a fresh parse when the user next visits it;
    // the edit revision makes close/save recovery treat the buffer as dirty.
    tb.content = nextContent
    tb.exportedMd = exportableMarkdown(nextContent)
    tb.editorState = null
    tb.lastAccessAt = Date.now()
    markDocumentEdited(binding.identity)
  }
  const after = agentBridge.readBoundDocument(binding)
  if (!after?.ok || after.markdown !== nextContent) {
    return documentTargetFailure('TARGET_UNAVAILABLE', 'document_apply_postcondition_failed')
  }
  return { ...after, code: 'DOCUMENT_APPLIED' }
}
agentBridge.getDocumentBindingStatus = getAgentDocumentBindingStatus
agentBridge.releaseDocumentBinding = releaseAgentDocumentBinding

const enforceTabResidency = async () => {
  if (!tabBufferApi) return
  // Keep the active document plus the two most recently used LARGE background
  // documents hot. This avoids an A/B switch loop that would otherwise hydrate
  // and reparse on every click. Small tabs are cheap and never enter swap I/O.
  const candidates = selectTabsToOffload(tabs.value, activeTabId.value, {
    threshold: TAB_BUFFER_THRESHOLD,
    hugeThreshold: TAB_BUFFER_HUGE_THRESHOLD,
    maxHotBackground: MAX_HOT_BACKGROUND_TABS,
    maxHotBytes: MAX_HOT_BACKGROUND_BYTES,
    maxHotHuge: MAX_HOT_HUGE_BACKGROUND_TABS,
    canOffload: tabCanOffload
  })
  for (const tb of candidates) {
    await offloadTab(tb)
  }
}

const scheduleTabResidencySweep = () => {
  if (!tabBufferApi || residencySweepScheduled || rendererQuitFlushing) return
  residencySweepScheduled = true
  const run = () => {
    residencySweepScheduled = false
    residencySweepHandle = null
    residencySweepChain = residencySweepChain
      .catch(() => {})
      .then(enforceTabResidency)
  }
  // Never compete with the navigation/TipTap parse that just made the active
  // tab visible. Chromium's idle callback gets a bounded fallback so a busy
  // session still eventually releases cold tabs.
  if (typeof globalThis.requestIdleCallback === 'function') {
    residencySweepHandle = globalThis.requestIdleCallback(run, { timeout: 1_500 })
  } else {
    residencySweepHandle = setTimeout(run, 700)
  }
}

// Active tab renders LIVE state (its refs are the working set); background
// tabs render their captured snapshot
const tabKindOf = (tb) => (tb.id === activeTabId.value
  ? (folderHandle.value ? 'folder' : 'doc')
  : tb.kind)
const tabLabelOf = (tb) => {
  const label = tb.id === activeTabId.value
    ? (folderHandle.value ? folderName.value : currentFileName.value)
    : tb.title
  return label || t('tab_untitled')
}

const captureActiveTab = () => {
  const tb = activeTab()
  if (!tb) return
  largeRichEditorRef.value?.flushEmit?.()
  commitLargeSourceDraft('tab-capture')
  if (largeDocumentPlainMode.value && !isUndoRedoAction) {
    clearTimeout(undoTimer)
    if (content.value !== lastSavedSnapshot.content) pushUndo()
  }
  // snapshotState flushes the editor's last debounced emission. It must run
  // before copying content/export or the tab could pair a new EditorState with
  // stale Markdown during a fast switch.
  const snap = viewMode.value === 'single' && !largeDocumentPlainMode.value && richEditorRef.value
    ? richEditorRef.value.snapshotState()
    : null
  const sourceContent = content.value
  tb.resident = true
  tb.lastAccessAt = Date.now()
  tb.kind = folderHandle.value ? 'folder' : 'doc'
  tb.title = folderHandle.value ? folderName.value : currentFileName.value
  tb.content = sourceContent
  tb.exportedMd = exportableMarkdown(sourceContent)
  // a BLANK snapshot of a non-blank document is poison — restoring it would
  // show blank and re-capture blank (self-propagating). Drop it; the fresh
  // parse path rebuilds the doc from the markdown instead.
  tb.editorState = snap && snap.doc.content.size <= 2 && sourceContent.length > 0
    ? null
    : snap
  const scrollOwner = documentScrollOwner()
  const returningFromPdf = pendingPdfScrollRestore?.tabId === tb.id
    ? pendingPdfScrollRestore.scrollTop
    : null
  tb.scrollTop = returningFromPdf ?? (scrollOwner ? scrollOwner.scrollTop : 0)
  if (viewMode.value === 'single' && largeDocumentPlainMode.value) {
    if (largeRichEditorRef.value?.contentScrollTop) tb.editorScrollTop = largeRichEditorRef.value.contentScrollTop()
  }
  tb.fileHandle = currentFileHandle.value
  tb.isLocal = isLocalFile.value
  tb.fileName = currentFileName.value
  tb.treePath = activeTreePath.value
  tb.folderHandle = folderHandle.value
  tb.folderName = folderName.value
  tb.folderWorkspaceId = folderWorkspaceId.value
  tb.folderWorkspaceIdentityDurable = folderWorkspaceIdentityDurable.value
  tb.folderTree = folderTree.value
  tb.expandedDirs = expandedDirs.value
  tb.outline = outlineVisible.value
  tb.undo = undoStack.value
  tb.redo = redoStack.value
  tb.lastSaved = lastSavedSnapshot
  tb.relImagesNeedGrant = relImagesNeedGrant.value
  tb.docDir = docDir.value
  tb.activeDirPath = activeDirPath.value
  tb.largeSourcePage = largeDocumentPlainMode.value ? largeSourcePage.value : 0
}

const restoreTab = (tb) => {
  if (!tb || !tb.resident || typeof tb.content !== 'string') {
    throw new Error('cannot restore a cold tab before hydration')
  }
  const restoreGeneration = ++tabRestoreGeneration
  documentLoadGeneration += 1
  const switchGeneration = tabSwitchGeneration
  const restoreTabId = tb.id
  const navigationOwner = beginNavigationInstall()
  try {
  resetEditingState()
  cancelAutoSave()
  currentFileHandle.value = tb.fileHandle
  isLocalFile.value = tb.isLocal
  currentFileName.value = tb.fileName
  activeTreePath.value = tb.treePath
  folderName.value = tb.folderName
  folderWorkspaceId.value = tb.folderWorkspaceId || ''
  folderWorkspaceIdentityDurable.value = !!tb.folderWorkspaceIdentityDurable
  folderHandle.value = tb.folderHandle
  folderTree.value = tb.folderTree
  expandedDirs.value = tb.expandedDirs
  outlineVisible.value = tb.outline
  undoStack.value = tb.undo
  redoStack.value = tb.redo
  lastSavedSnapshot = tb.lastSaved || { content: tb.content, selection: null }
  relImagesNeedGrant.value = tb.relImagesNeedGrant || false
  docDir.value = tb.docDir || null
  activeDirPath.value = tb.activeDirPath || ''
  const editorLoad = stageLargeEditorLoad(tb.content, {
    restoreState: !!tb.editorState,
    sourcePage: tb.largeSourcePage || 0
  })
  const canRestoreEditorState = !editorLoad.plain && viewMode.value === 'single' && richEditorRef.value && tb.editorState
  // with a snapshot the whole EditorState (incl. undo history) swaps in one
  // updateState and the modelValue watcher skips (lastEmitted pre-marked)
  const restored = canRestoreEditorState
    ? richEditorRef.value.restoreState(tb.editorState, tb.exportedMd)
    : false
  content.value = tb.content
  if (restored) scheduleAgentPreviewResync()
  touchWorkspaceIdentity()
  // A fresh parse and its empty undo history are part of activating the tab,
  // not next-frame cleanup. Performing this synchronously means the editor is
  // never interactive with the previous tab's history and leaves no delayed
  // setContent that could overwrite an immediate paste.
  if (!restored && !editorLoad.plain && !editorLoad.staged && viewMode.value === 'single' && richEditorRef.value) {
    richEditorRef.value.forceSync(richMarkdown.value)
  }
  void releaseLargeEditorLoad(editorLoad)
  // Re-resolve THIS document's ![](relative/path) images (AFTER the content
  // swap — the loader scans content.value). relImages is a global cache and
  // the most recently opened file cleared+refilled it for ITSELF — without a
  // reload here a restored tab renders its assets/ refs as broken images
  // (fresh parse), and worse: an edit would emit the snapshot's baked data
  // URLs with no mapping to swap them back, silently rewriting assets/x.png
  // refs into duplicate knote-img entries.
  clearRelImages()
  if (tb.docDir) loadRelativeImages(tb.docDir)
  nextTick(() => {
    if (restoreGeneration !== tabRestoreGeneration) return
    try {
    // A restore callback may run after another tab/file has already won, or
    // after the user has typed/pasted into this editor. In either case it is
    // stale and must never call forceSync/resetHistory over the newer state.
    // The restore epoch also lets an invalidated callback clear the loading
    // flag only when no newer restore owns it.
    if (
      switchGeneration !== tabSwitchGeneration ||
      activeTabId.value !== restoreTabId ||
      activeTab() !== tb
    ) {
      return
    }
    // Switching from a plain-mode tab means RichEditor did not exist at the
    // synchronous point above. If this target owns a saved EditorState, install
    // it immediately after mount so its undo branch/caret is not lost.
    if (!restored && !editorLoad.plain && tb.editorState && richEditorRef.value) {
      if (richEditorRef.value.restoreState(tb.editorState, tb.exportedMd)) scheduleAgentPreviewResync()
    }
    restoreDocumentScrollTop(tb.scrollTop || 0)
    if (viewMode.value === 'single' && editorLoad.plain) {
      largeRichEditorRef.value?.restoreContentScroll?.(tb.editorScrollTop || 0)
    }
    } finally {
      finishNavigationInstall(navigationOwner)
    }
  })
  } catch (error) {
    finishNavigationInstall(navigationOwner)
    throw error
  }
}

const switchTab = async (id) => {
  if (id === activeTabId.value) return true
  const next = tabs.value.find((tb) => tb.id === id)
  if (!next || next.agentClosing) return false
  const generation = ++tabSwitchGeneration
  if (!next.resident) {
    const hydrated = await hydrateTab(next)
    // A later click/new-tab/close wins. Hydration only warmed this tab object;
    // it never wrote into the live document refs, so abandoning it is safe.
    if (!hydrated || generation !== tabSwitchGeneration || !tabs.value.includes(next)) {
      if (!hydrated && generation === tabSwitchGeneration) {
        notify(lang.value === 'zh' ? '标签页从磁盘恢复失败，已保留当前文档' : 'Could not restore that tab; the current document was kept')
      }
      return false
    }
  }
  if (generation !== tabSwitchGeneration || next.id === activeTabId.value) return false
  closePdfView() // leaving for another tab dismisses the PDF viewer overlay
  commitActiveBlockIfAny()
  flushAutoSave()
  captureActiveTab()
  activeTabId.value = id
  next.lastAccessAt = Date.now()
  restoreTab(next)
  const restoredRef = next.bufferRef
  next.bufferRef = null
  if (restoredRef) void dropTabBufferRef(restoredRef)
  scheduleTabResidencySweep()
  return true
}

// A pristine tab (nothing typed, no file/folder attached) is REUSED by the
// next open instead of spawning another tab — like a browser's new-tab page
const isPristineTab = () => {
  if (currentFileHandle.value || folderHandle.value) return false
  const tb = activeTab()
  return !content.value.trim() || (tb ? content.value === tb.baseContent : false)
}

const restoreRememberedAndroidStorage = async () => {
  if (!isAndroidNative) return false
  let saved
  try { saved = JSON.parse(localStorage.getItem(ANDROID_STORAGE_KEY) || 'null') } catch { saved = null }
  if (!saved || saved.source !== 'saf' || typeof saved.grantId !== 'string') return false
  const generation = androidStorageIntentGeneration
  const targetTab = activeTab()
  const stillCurrent = () => generation === androidStorageIntentGeneration && activeTab() === targetTab && isPristineTab()
  try {
    const handle = await restoreSafGrant(saved.grantId)
    if (!stillCurrent()) return false
    if (handle._knoteSafGrantKind !== saved.kind) {
      clearRememberedAndroidStorage()
      await releaseSafGrant(saved.grantId).catch(() => {})
      return false
    }
    if (saved.kind === 'document' && !/\.(?:md|markdown)$/i.test(handle.name || '')) {
      clearRememberedAndroidStorage()
      await releaseSafGrant(saved.grantId).catch(() => {})
      return false
    }
    const restored = saved.kind === 'tree'
      ? await adoptFolderHandle(handle, handle.name, '', stillCurrent)
      : await openFileFromHandle(handle, { stillCurrent })
    if (restored) await rememberAndroidStorage('saf', handle)
    return restored === true
  } catch (error) {
    if (stillCurrent() && ['BAD_GRANT', 'GRANT_REVOKED', 'NOT_FOUND', 'TYPE_MISMATCH'].includes(String(error?.code || ''))) {
      clearRememberedAndroidStorage()
    }
    console.warn('Android SAF restore skipped:', error)
    return false
  }
}

// Enter a fresh tab context; the caller loads its document/folder into the
// live refs right after (captured into the tab on the next switch/close)
const openInNewTab = () => {
  // no tab strip in the plain browser (no title bar) — opening there
  // replaces in place like before instead of stacking invisible tabs
  if (!supportsDocumentTabs.value) return activeTab()
  ++tabSwitchGeneration
  if (isPristineTab()) return activeTab()
  closePdfView()
  commitActiveBlockIfAny()
  flushAutoSave()
  captureActiveTab()
  const tb = mkTab({ outline: outlineVisible.value })
  tabs.value.push(tb)
  activeTabId.value = tb.id
  restoreTab(tb)
  scheduleTabResidencySweep()
  return tb
}

const newTab = () => {
  cancelSessionRestoreForForegroundIntent()
  ++tabSwitchGeneration
  closePdfView()
  commitActiveBlockIfAny()
  flushAutoSave()
  captureActiveTab()
  const tb = mkTab({ outline: outlineVisible.value })
  tabs.value.push(tb)
  activeTabId.value = tb.id
  restoreTab(tb)
  scheduleTabResidencySweep()
}

// Open a tree file in a NEW tab that INHERITS the current folder workspace —
// the file tree stays put and the agent context (keyed by folder) carries over.
const openTreeFileInNewTab = async (node) => {
  // pdf/image use their own viewers (not doc tabs); office docs launch the OS
  // default app (no tab to create); no workspace or no tab strip (plain
  // browser) → just open in place
  if (node.ftype === 'pdf' || node.ftype === 'image' || treeFileOpensWithSystemApp(node) || !folderHandle.value || !supportsDocumentTabs.value) { await openTreeFile(node); return }
  const alreadyOpen = findOpenTreeDocumentTab(node)
  if (alreadyOpen) {
    // Route through the normal intent path so an A -> slow B -> A action also
    // invalidates B when the final A was requested via the context menu.
    await openTreeFile(node)
    return
  }
  ++tabSwitchGeneration
  closePdfView()
  commitActiveBlockIfAny()
  flushAutoSave()
  captureActiveTab()
  const src = activeTab()
  const tb = mkTab({
    outline: outlineVisible.value,
    deskKey: src ? src.deskKey : '', // same folder identity → same agent workspace
    folderHandle: folderHandle.value,
    folderName: folderName.value,
    folderWorkspaceId: folderWorkspaceId.value,
    folderWorkspaceIdentityDurable: folderWorkspaceIdentityDurable.value,
    folderTree: folderTree.value,
    expandedDirs: new Set(expandedDirs.value)
  })
  tabs.value.push(tb)
  activeTabId.value = tb.id
  restoreTab(tb) // activate the inherited (blank-doc) folder workspace
  await openTreeFile(node) // then load the clicked file into it — folder unchanged
  scheduleTabResidencySweep()
}

const closeTab = async (id) => {
  const tb = tabs.value.find((t) => t.id === id)
  if (!tb || tb.agentClosing) return
  if (id === activeTabId.value) closePdfView()
  tb.agentClosing = true
  const closingDocumentId = agentDocumentKeyForTab(tb)
  stopAgentRunsForDocument(closingDocumentId)
  try {
  if (pendingHunksBelongToDocument(closingDocumentId)) {
    const ok = await confirmDialog(lang.value === 'zh'
      ? '该标签页还有待审核改动。关闭会放弃这些改动，是否继续？'
      : 'This tab still has pending edits. Closing it will discard those edits. Continue?',
    { owner: `tab-close:${id}` })
    if (!ok) return
    discardPendingHunksForDocument(closingDocumentId)
  }
  const initiallyBacked = id === activeTabId.value
    ? !!(currentFileHandle.value || folderHandle.value)
    : !!(tb.fileHandle || tb.folderHandle)
  // Every cold tab must be verified before its sole buffer ref can be dropped,
  // including file-backed tabs whose latest save may have failed.
  if (!tb.resident && !await hydrateTab(tb)) {
    notify(lang.value === 'zh' ? '无法验证该标签页的写盘内容，已取消关闭' : 'Could not verify the disk-backed tab, so it was not closed')
    return
  }
  if (id === activeTabId.value) {
    commitActiveBlockIfAny()
    await nextTick()
  }
  const closingKey = snapshotDocKeyForTab(tb)
  if (initiallyBacked && documentIsAheadOfDisk(closingKey)) {
    const active = id === activeTabId.value
    const snapshotText = active ? content.value : (typeof tb.content === 'string' ? tb.content : null)
    const markdown = active ? exportableMarkdown() : (typeof tb.exportedMd === 'string' ? tb.exportedMd : null)
    const handle = active ? currentFileHandle.value : tb.fileHandle
    const revision = documentEditRevision(closingKey)
    if (active) await flushAutoSave()
    else if (handle && markdown != null && snapshotText != null) {
      await saveToFileHandle(handle, {
        markdown,
        snapshotContent: snapshotText,
        snapshotKey: closingKey,
        revision
      })
    }
    await waitForDocumentSaves(closingKey)
    if (documentIsAheadOfDisk(closingKey)) {
      if (snapshotText == null || await takeSnapshot('close-recovery', closingKey, snapshotText) == null || documentEditRevision(closingKey) !== revision) {
        notify(lang.value === 'zh' ? '无法安全保存或恢复该标签页，已取消关闭' : 'Could not safely save or recover this tab, so it was not closed')
        return
      }
    }
  }
  {
    // scratch content with no backing file: confirm before dropping it
    const active = id === activeTabId.value
    const text = active ? content.value : (typeof tb.content === 'string' ? tb.content : '')
    const backed = active
      ? !!(currentFileHandle.value || folderHandle.value)
      : !!(tb.fileHandle || tb.folderHandle)
    if (!backed && text.trim() && text !== tb.baseContent) {
      const ok = await confirmDialog(t('tab_close_confirm'), { owner: `tab-close:${id}` })
      if (!ok) return
    }
  }
  if (!await waitForAgentDocumentLeases(tb)) {
    notify(lang.value === 'zh' ? '助手仍在释放该标签页，已取消关闭，请稍后重试' : 'The Agent is still releasing this tab. Close was cancelled; try again shortly.')
    return
  }
  const closeIntentKey = snapshotDocKeyForTab(tb)
  const closeIntentRevision = documentEditRevision(closeIntentKey)
  const closeIntentText = id === activeTabId.value
    ? content.value
    : (typeof tb.content === 'string' ? tb.content : null)
  // (re)derive AFTER the modal — tabs and the active id may have changed
  // while it was open (e.g. a file association just opened a new tab)
  let idx = tabs.value.findIndex((t) => t.id === id)
  if (idx < 0) return
  let isActive = id === activeTabId.value
  const closeGeneration = ++tabSwitchGeneration
  let next = null
  if (isActive && tabs.value.length > 1) {
    next = tabs.value[idx + 1] || tabs.value[idx - 1]
    if (next && !next.resident) {
      if (!await hydrateTab(next)) {
        notify(lang.value === 'zh' ? '无法从磁盘恢复相邻标签页，已取消关闭' : 'Could not restore the neighboring tab, so close was cancelled')
        return
      }
      if (closeGeneration !== tabSwitchGeneration || !tabs.value.includes(tb) || activeTabId.value !== id) return
      idx = tabs.value.findIndex((item) => item === tb)
      isActive = id === activeTabId.value
      if (idx < 0 || !isActive) return
    }
  }
  if (isActive) {
    commitActiveBlockIfAny()
    await nextTick()
  }
  const currentCloseText = isActive ? content.value : (typeof tb.content === 'string' ? tb.content : null)
  if (snapshotDocKeyForTab(tb) !== closeIntentKey ||
      documentEditRevision(closeIntentKey) !== closeIntentRevision ||
      currentCloseText !== closeIntentText) {
    notify(lang.value === 'zh' ? '标签页在关闭期间发生了修改，请再次关闭' : 'The tab changed while closing; close it again')
    return
  }
  if (pendingHunksBelongToDocument(closingDocumentId) || Number(tb.agentResidencyLeases || 0) > 0) {
    notify(lang.value === 'zh' ? '标签页在关闭期间收到新的助手操作，请再次关闭' : 'The tab received a new Agent operation while closing; close it again.')
    return
  }
  const closingRef = tb.bufferRef
  tb.bufferRef = null
  ++tb.bufferGeneration
  bumpAgentDocumentGeneration(tb)
  tabs.value.splice(idx, 1)
  if (closingRef) void dropTabBufferRef(closingRef)
  if (!tabs.value.length) {
    const fresh = mkTab({ outline: outlineVisible.value })
    tabs.value.push(fresh)
    activeTabId.value = fresh.id
    restoreTab(fresh)
    scheduleTabResidencySweep()
    return
  }
  if (isActive) {
    // activate the right neighbor (browser behavior), clamped at the end
    const activationTarget = next && tabs.value.includes(next)
      ? next
      : tabs.value[Math.min(idx, tabs.value.length - 1)]
    activeTabId.value = activationTarget.id
    activationTarget.lastAccessAt = Date.now()
    restoreTab(activationTarget)
    const restoredRef = activationTarget.bufferRef
    activationTarget.bufferRef = null
    if (restoredRef) void dropTabBufferRef(restoredRef)
  }
  scheduleTabResidencySweep()
  } finally {
    if (tabs.value.includes(tb)) tb.agentClosing = false
  }
}

// Ctrl+Tab / Ctrl+Shift+Tab cycle tabs (browser muscle memory)
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !e.ctrlKey || tabs.value.length < 2) return
  e.preventDefault()
  cancelSessionRestoreForForegroundIntent()
  const idx = tabs.value.findIndex((tb) => tb.id === activeTabId.value)
  const next = tabs.value[(idx + (e.shiftKey ? -1 : 1) + tabs.value.length) % tabs.value.length]
  void switchTab(next.id)
})

// ---- Tab drag-to-reorder (Chrome-style, pointer-driven) ----
// Native HTML5 drag-and-drop was replaced: it painted a no-drop (⊘) cursor
// over any non-droppable area and only fired dragover on tabs that had a
// handler, so the drag "stuck" the moment the pointer left a tab or the strip.
// A document-level mouse drag has none of those limits — the grabbed tab
// follows the cursor and the others slide out of its way, exactly like Chrome.
const draggingTabId = ref(null) // reactive: lifts the grabbed tab + strip cursor
let tabDrag = null // { id, el, startX, lastX, pointerOffset, width, moved }
// Position the grabbed tab under the cursor. Geometry uses offsetLeft/offsetWidth
// (the UNTRANSFORMED layout box) so it's immune to the inline transform Vue's
// TransitionGroup FLIP writes/clears on the moved element during a reorder —
// mixing our translate with Vue's would make the tab jump off the cursor.
// (.knote-tabs is position:relative so offsetLeft is measured from the strip.)
const positionDraggedTab = () => {
  if (!tabDrag || !tabDrag.moved) return
  const el = tabDrag.el
  const strip = el.parentElement
  if (!strip) return
  const stripRect = strip.getBoundingClientRect()
  // clamp the VISUAL position inside the strip so the tab can't be flung into
  // the brand text or window buttons
  let desiredLeft = tabDrag.lastX - tabDrag.pointerOffset
  desiredLeft = Math.max(stripRect.left, Math.min(stripRect.right - tabDrag.width, desiredLeft))
  const naturalLeft = stripRect.left + el.offsetLeft
  el.style.transform = `translateX(${desiredLeft - naturalLeft}px)`
}
const onTabPointerMove = (e) => {
  if (!tabDrag) return
  // the button was released outside the window (no mouseup reached us) — bail
  if (e.buttons === 0) { onTabPointerUp(); return }
  tabDrag.lastX = e.clientX
  if (!tabDrag.moved) {
    if (Math.abs(e.clientX - tabDrag.startX) < 4) return // still a click, not a drag
    tabDrag.moved = true
    draggingTabId.value = tabDrag.id
  }
  positionDraggedTab()
  // Reorder by the UNCLAMPED cursor-driven center vs each sibling's natural
  // (untransformed) center — unclamped so a wide tab can still reach the last
  // slot at the packed right edge; natural centers so a sibling mid-slide
  // (.ktab-move) can't flip the comparison.
  const el = tabDrag.el
  const strip = el.parentElement
  if (!strip) return
  const stripRect = strip.getBoundingClientRect()
  const logicalCenter = (e.clientX - tabDrag.pointerOffset) + tabDrag.width / 2
  const curIndex = tabs.value.findIndex((t2) => t2.id === tabDrag.id)
  let target = 0
  for (const other of strip.querySelectorAll('.knote-tab')) {
    if (other === el) continue
    if (logicalCenter > stripRect.left + other.offsetLeft + other.offsetWidth / 2) target++
  }
  if (target !== curIndex && curIndex >= 0) {
    const [moved] = tabs.value.splice(curIndex, 1)
    tabs.value.splice(target, 0, moved)
    // Vue's FLIP clears our inline transform when the element changes slot;
    // re-assert it after the flush so the tab stays under the cursor (and
    // doesn't flash to its slot) even if the pointer then holds still
    nextTick(positionDraggedTab)
  }
}
// Tear down a drag (finalize or abort). settle=true eases the tab back into its
// slot; otherwise it snaps. Shared by mouseup, the buttons===0 guard, window
// blur, and a fresh mousedown that finds a stranded drag.
const cleanupTabDrag = (settle) => {
  window.removeEventListener('mousemove', onTabPointerMove)
  window.removeEventListener('mouseup', onTabPointerUp)
  if (!tabDrag) return false
  const { el, moved } = tabDrag
  tabDrag = null
  draggingTabId.value = null
  if (el) {
    if (settle && moved) {
      el.style.transition = 'transform 0.18s ease'
      el.style.transform = ''
      setTimeout(() => { if (el) { el.style.transition = ''; el.style.transform = '' } }, 200)
    } else {
      el.style.transition = ''
      el.style.transform = ''
    }
  }
  if (moved) persistSession()
  return moved
}
const onTabPointerUp = () => {
  if (!tabDrag) { cleanupTabDrag(false); return }
  const { id, moved } = tabDrag
  cleanupTabDrag(true)
  if (!moved) void switchTab(id) // no movement => it was a plain click
}
const onTabPointerDown = (id, e) => {
  if (e.button !== 0) return // left button only; middle-click closes (auxclick)
  if (e.target.closest('.knote-tab-x')) return // the × button handles itself
  cancelSessionRestoreForForegroundIntent()
  if (tabDrag) cleanupTabDrag(false) // clean up any stranded prior drag first
  // activate immediately (Chrome shows the grabbed tab active as you press)
  if (id !== activeTabId.value) {
    const target = tabs.value.find((tb) => tb.id === id)
    if (target && !target.resident) {
      // A cold tab cannot become draggable until its verified snapshot is
      // hydrated; otherwise mouseup could reorder/activate the old document.
      void switchTab(id)
      return
    }
    void switchTab(id)
  }
  const rect = e.currentTarget.getBoundingClientRect()
  tabDrag = {
    id,
    el: e.currentTarget,
    startX: e.clientX,
    lastX: e.clientX,
    pointerOffset: e.clientX - rect.left,
    width: rect.width,
    moved: false
  }
  window.addEventListener('mousemove', onTabPointerMove)
  window.addEventListener('mouseup', onTabPointerUp)
}
// a drag interrupted by focus loss (alt-tab, OS dialog) never gets its mouseup
// — abort so the tab doesn't stay lifted/offset and self-reordering
window.addEventListener('blur', () => { if (tabDrag) cleanupTabDrag(false) })

// ---- Recently opened files / folders (desktop; reopened by path) ----
const RECENTS_KEY = 'knote-recents'
const recentItems = ref([])
try { recentItems.value = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]') } catch { recentItems.value = [] }
const addRecent = (type, path, name, { sessionReplay = false } = {}) => {
  if (!isDesktopShell || !path || sessionReplay) return
  const key = `${type}:${path}`
  const list = recentItems.value.filter((r) => `${r.type}:${r.path}` !== key)
  list.unshift({
    type,
    path,
    capability: desktopOpenCapabilities.get(desktopOpenCapabilityKey(type, path)) || '',
    name: name || String(path).split(/[\\/]/).pop()
  })
  recentItems.value = list.slice(0, 12)
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(recentItems.value)) } catch { /* quota */ }
}
const openRecent = (r) => {
  blurActiveElement()
  if (window.knoteDesktop && window.knoteDesktop.reopen) {
    const capability = r.capability || (window.knoteDesktop.isE2E ? r.path : '')
    if (!capability) {
      recentItems.value = recentItems.value.filter((x) => !(x.type === r.type && x.path === r.path))
      try { localStorage.setItem(RECENTS_KEY, JSON.stringify(recentItems.value)) } catch { /* quota */ }
      notify(lang.value === 'zh' ? '最近项目需要重新授权，已从列表移除' : 'This recent item needs to be opened again and was removed')
      return
    }
    window.knoteDesktop.reopen(r.type, capability).then((ok) => {
      // path gone (moved/deleted): drop it from the list
      if (!ok) {
        recentItems.value = recentItems.value.filter((x) => !(x.type === r.type && x.path === r.path))
        try { localStorage.setItem(RECENTS_KEY, JSON.stringify(recentItems.value)) } catch { /* quota */ }
        notify(lang.value === 'zh' ? '文件不存在，已从列表移除' : 'File no longer exists — removed')
      }
    })
  }
}
const clearRecents = () => {
  recentItems.value = []
  try { localStorage.removeItem(RECENTS_KEY) } catch { /* ignore */ }
}

// ---- Session persistence (desktop): remember which files/folders were
// open so a restart restores the workspace. Only path-backed (deskKey) tabs
// survive; scratch tabs can't be re-read from disk. ----
const SESSION_KEY = 'knote-session'
const persistSession = () => {
  if (!isDesktopShell || sessionRestoring) return
  try {
    const open = tabs.value
      .map((tb) => tb.deskKey)
      .filter((k) => k && (k.startsWith('file:') || k.startsWith('folder:')))
      .map((k) => {
        const type = k.slice(0, k.indexOf(':'))
        const path = k.slice(k.indexOf(':') + 1)
        return { type, path, capability: desktopOpenCapabilities.get(desktopOpenCapabilityKey(type, path)) || '' }
      })
    const active = (activeTab() || {}).deskKey || ''
    localStorage.setItem(SESSION_KEY, JSON.stringify({ open, active }))
  } catch { /* quota */ }
}
const restoreSession = async () => {
  if (!isDesktopShell || !window.knoteDesktop || !window.knoteDesktop.reopen) return
  // An argv/file-association/recent/test open that landed before the delayed
  // replay is authoritative. Replaying last session on top of it used to
  // clear a paste made immediately after the file row appeared.
  if (foregroundOpenGeneration > 0) return
  let saved
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { saved = null }
  if (!saved || !Array.isArray(saved.open) || !saved.open.length) return
  const restoreForegroundGeneration = foregroundOpenGeneration
  const restoreEpoch = ++sessionRestoreEpoch
  sessionRestoring = true
  try {
  // reopen sequentially — each reopen makes main emit open-file/open-folder,
  // handled by our bridge listeners (which create/dedupe tabs)
  for (const it of saved.open) {
    if (foregroundOpenGeneration !== restoreForegroundGeneration || restoreEpoch !== sessionRestoreEpoch) break
    const requestId = `session:${Date.now().toString(36)}:${++sessionOpenSequence}`
      pendingSessionOpens.set(requestId, {
        foregroundGeneration: restoreForegroundGeneration,
        restoreEpoch
      })
      let resolveCompletion
      const completion = new Promise((resolve) => { resolveCompletion = resolve })
      pendingSessionOpenCompletions.set(requestId, { resolve: resolveCompletion })
      try {
        let reopenTimeoutId
        const reopenResult = await Promise.race([
          window.knoteDesktop.reopen(it.type, it.capability || (window.knoteDesktop.isE2E ? it.path : ''), requestId).then(
            (ok) => ({ completed: true, ok: ok === true }),
            () => ({ completed: true, ok: false })
          ),
          new Promise((resolve) => {
            reopenTimeoutId = setTimeout(() => resolve({ completed: false, ok: false }), 15_000)
          })
        ])
        clearTimeout(reopenTimeoutId)
        if (!reopenResult.completed) {
          pendingSessionOpenCompletions.delete(requestId)
          foregroundOpenGeneration += 1
          continue
        }
        const ok = reopenResult.ok
        if (!ok) {
          pendingSessionOpens.delete(requestId)
          finishSessionOpen(requestId, false)
          continue
        }
        let timeoutId
        const result = await Promise.race([
          completion.then((applied) => ({ completed: true, applied })),
          new Promise((resolve) => {
            timeoutId = setTimeout(() => resolve({ completed: false, applied: false }), 15_000)
          })
        ])
        clearTimeout(timeoutId)
        if (!result.completed) {
          // The main process said it emitted the open event, but the renderer
          // never finished applying it. Invalidate its token so a very late
          // event cannot take over after the replay has moved on.
          pendingSessionOpenCompletions.delete(requestId)
          foregroundOpenGeneration += 1
        }
      } catch {
        pendingSessionOpens.delete(requestId)
        finishSessionOpen(requestId, false)
        // gone / unreadable — skip
      }
  }
  const cancelled = foregroundOpenGeneration !== restoreForegroundGeneration || restoreEpoch !== sessionRestoreEpoch
  if (!cancelled && saved.active) {
    const tb = tabs.value.find((t) => t.deskKey === saved.active)
    if (tb && tb.id !== activeTabId.value) await switchTab(tb.id)
  }
  } finally {
    if (restoreEpoch === sessionRestoreEpoch) sessionRestoring = false
    persistSession()
  }
}
// re-persist whenever the tab set or active tab changes (deskKeys are set
// right after a tab is pushed, so a microtask-later flush catches them)
watch([() => tabs.value.length, activeTabId], () => nextTick(persistSession))

// Dropping .md files / folders onto the window opens them as tabs. The
// editor keeps its own drop handling (images, text) — only drops OUTSIDE it
// are claimed here.
const tabDropGuard = (e) => !!(e.target && e.target.closest && e.target.closest('.ProseMirror, textarea'))
window.addEventListener('dragover', (e) => {
  if (tabDropGuard(e)) return
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
})
window.addEventListener('drop', (e) => {
  if (e.defaultPrevented || tabDropGuard(e)) return
  const items = Array.from((e.dataTransfer && e.dataTransfer.items) || []).filter((i) => i.kind === 'file')
  if (!items.length) return
  e.preventDefault()
  // handles must be requested synchronously — dataTransfer dies with the event
  const picks = items
    .map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle() : null))
    .filter(Boolean)
  ;(async () => {
    for (const pick of picks) {
      try {
        const h = await pick
        if (!h) continue
        if (h.kind === 'directory') {
          await adoptFolderHandle(h, h.name)
          break
        }
        if (/\.(md|markdown)$/i.test(h.name || '')) await openFileFromHandle(h)
      } catch (err) {
        console.error('Drop open error:', err)
      }
    }
  })()
})

// ========== Image viewer (lightbox: drag to pan, wheel to zoom) ==========
const imageViewer = ref(null) // { src, alt, scale, tx, ty }
const viewerDragging = ref(false)
const openImageViewer = ({ src, alt }) => {
  if (!src) return
  // MODAL: blur the editor. The double-click that opened the viewer left a
  // NodeSelection on the image — with focus intact, a stray Backspace or
  // any typed character would silently edit/delete behind the overlay.
  const ae = document.activeElement
  if (ae && typeof ae.blur === 'function') ae.blur()
  imageViewer.value = { src, alt: alt || '', scale: 1, tx: 0, ty: 0 }
}
const closeImageViewer = () => {
  imageViewer.value = null
  viewerDrag = null
  viewerDragging.value = false
}
// zoom keeping the point under (mx,my) fixed; coords relative to viewport center
const viewerZoomAt = (mx, my, ns) => {
  const v = imageViewer.value
  if (!v) return
  ns = Math.min(8, Math.max(0.1, ns))
  v.tx = mx - (mx - v.tx) * (ns / v.scale)
  v.ty = my - (my - v.ty) * (ns / v.scale)
  v.scale = ns
}
const onViewerWheel = (e) => {
  const v = imageViewer.value
  if (!v) return
  viewerZoomAt(
    e.clientX - window.innerWidth / 2,
    e.clientY - window.innerHeight / 2,
    v.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2)
  )
}
const viewerStep = (dir) => {
  const v = imageViewer.value
  if (v) viewerZoomAt(0, 0, v.scale * (dir > 0 ? 1.25 : 0.8))
}
const viewerReset = () => {
  const v = imageViewer.value
  if (v) { v.scale = 1; v.tx = 0; v.ty = 0 }
}
// double-click the image: zoom to 2x at the cursor, or back to fit
const viewerToggle = (e) => {
  const v = imageViewer.value
  if (!v) return
  if (v.scale > 1.01 || Math.abs(v.tx) > 1 || Math.abs(v.ty) > 1) viewerReset()
  else viewerZoomAt(e.clientX - window.innerWidth / 2, e.clientY - window.innerHeight / 2, 2)
}
let viewerDrag = null
const onViewerDragStart = (e) => {
  const v = imageViewer.value
  if (!v || e.button !== 0) return
  viewerDrag = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty }
  viewerDragging.value = true
}
window.addEventListener('mousemove', (e) => {
  const v = imageViewer.value
  if (!v || !viewerDrag) return
  // mouseup can be lost to Alt+Tab / a dialog stealing focus — a move with
  // no button held means the drag already ended elsewhere
  if (!(e.buttons & 1)) {
    viewerDrag = null
    viewerDragging.value = false
    return
  }
  v.tx = viewerDrag.tx + (e.clientX - viewerDrag.x)
  v.ty = viewerDrag.ty + (e.clientY - viewerDrag.y)
})
window.addEventListener('mouseup', () => {
  viewerDrag = null
  viewerDragging.value = false
})
window.addEventListener('blur', () => {
  viewerDrag = null
  viewerDragging.value = false
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && imageViewer.value) closeImageViewer()
})
// double-click any rendered image (editor, split preview, agent chat) opens it
window.addEventListener('dblclick', (e) => {
  if (imageViewer.value) return
  const img = e.target && e.target.closest &&
    e.target.closest('.ProseMirror img, .knote-md-render img, .knote-agent-md img')
  if (img && img.getAttribute('src')) {
    openImageViewer({ src: img.getAttribute('src'), alt: img.getAttribute('alt') || '' })
  }
})

// ========== UI zoom (Ctrl+wheel / Ctrl+0 / Ctrl+±, desktop only) ==========
// DESKTOP ONLY, deliberately: Chromium-native zoom (via main-process IPC)
// keeps every coordinate system consistent — pointer math, fixed overlays,
// the WCO buttons strip (resized in main to match). A CSS-zoom fallback in
// the plain browser would skew every clientX-driven overlay by the zoom
// factor (context menu, gutter, viewer pan), so the browser keeps its own
// native Ctrl+wheel zoom instead of us hijacking it.
// general-purpose transient toast (bottom-center)
const toastMsg = ref('')
let toastTimer = null
const notify = (msg) => {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg.value = '' }, 2200)
}

const canUiZoom = !!(window.knoteDesktop && window.knoteDesktop.setZoom)
const uiZoom = ref(1)
const zoomToast = ref(false)
let zoomToastTimer = null
const applyUiZoom = (z, silent = false) => {
  if (!canUiZoom) return
  uiZoom.value = Math.min(2.5, Math.max(0.5, Math.round(z * 20) / 20)) // 5% detents
  window.knoteDesktop.setZoom(uiZoom.value)
  try { localStorage.setItem('knote-zoom', String(uiZoom.value)) } catch { /* quota */ }
  if (!silent) {
    zoomToast.value = true
    clearTimeout(zoomToastTimer)
    zoomToastTimer = setTimeout(() => { zoomToast.value = false }, 900)
  }
}
if (canUiZoom) {
  window.addEventListener('wheel', (e) => {
    const insidePdf = e.composedPath().some((node) => node?.classList?.contains('knote-pdf-host'))
    if (!e.ctrlKey || imageViewer.value || insidePdf) return // viewers have their own wheel zoom
    e.preventDefault()
    applyUiZoom(uiZoom.value + (e.deltaY < 0 ? 0.1 : -0.1))
  }, { passive: false })
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
    // e.key (not e.code): NumLock-off numpad 0 reports key='Insert' —
    // Ctrl+Insert is COPY on Windows and must not reset the zoom
    if (e.key === '0') { e.preventDefault(); applyUiZoom(1) }
    else if (e.key === '=' || e.key === '+') { e.preventDefault(); applyUiZoom(uiZoom.value + 0.1) }
    else if (e.key === '-') { e.preventDefault(); applyUiZoom(uiZoom.value - 0.1) }
  })
  const saved = parseFloat(localStorage.getItem('knote-zoom') || '1')
  if (saved && Math.abs(saved - 1) > 0.001) applyUiZoom(saved, true)
}

// ========== Find / Replace (Ctrl+F / Ctrl+H) ==========
const findState = ref({
  open: false, replace: false, query: '', replacement: '',
  caseSensitive: false, wholeWord: false, count: 0, active: -1
})
const findInputRef = ref(null)
// split-mode (textarea) search runs over the content string
let splitMatches = []
const splitFindMatches = (query, o) => {
  splitMatches = []
  if (!query) return
  try {
    let pat = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (o.wholeWord) pat = `(?<![\\p{L}\\p{N}_])${pat}(?![\\p{L}\\p{N}_])`
    const re = new RegExp(pat, o.caseSensitive ? 'gu' : 'giu')
    let m
    while ((m = re.exec(content.value))) {
      if (m[0].length === 0) { re.lastIndex++; continue }
      splitMatches.push({ from: m.index, to: m.index + m[0].length })
    }
  } catch { /* invalid regex escape — no matches */ }
}
const splitSelectActive = () => {
  const el = textareaRef.value
  const m = splitMatches[findState.value.active]
  if (!el || !m) return
  el.focus()
  el.setSelectionRange(m.from, m.to)
  // scroll the selection into view
  const before = content.value.slice(0, m.from)
  const line = before.split('\n').length - 1
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 22
  el.scrollTop = Math.max(0, line * lh - el.clientHeight / 2)
}
const runFind = (resetActive = true) => {
  const s = findState.value
  const opts = { caseSensitive: s.caseSensitive, wholeWord: s.wholeWord }
  if (viewMode.value === 'single' && richEditorRef.value) {
    const st = richEditorRef.value.searchSet(s.query, opts, resetActive ? 0 : Math.max(0, s.active))
    s.count = st.count
    s.active = st.active
  } else {
    splitFindMatches(s.query, opts)
    s.count = splitMatches.length
    s.active = s.count ? (resetActive ? 0 : Math.min(Math.max(0, s.active), s.count - 1)) : -1
    if (s.count) splitSelectActive()
  }
}
const findStep = (dir) => {
  const s = findState.value
  if (viewMode.value === 'single' && richEditorRef.value) {
    const st = richEditorRef.value.searchStep(dir)
    s.count = st.count; s.active = st.active
  } else {
    if (!s.count) return
    s.active = (s.active + dir + s.count) % s.count
    splitSelectActive()
  }
}
const replaceOne = () => {
  const s = findState.value
  if (!s.query || s.count === 0) return
  if (viewMode.value === 'single' && richEditorRef.value) {
    const st = richEditorRef.value.searchReplaceActive(s.replacement)
    s.count = st.count; s.active = st.active
  } else {
    if (largeRichEditorRef.value?.flushEmit) largeRichEditorRef.value.flushEmit()
    if (commitLargeSourceDraft('replace-one')) {
      splitFindMatches(s.query, { caseSensitive: s.caseSensitive, wholeWord: s.wholeWord })
      s.count = splitMatches.length
      s.active = s.count ? Math.min(Math.max(0, s.active), s.count - 1) : -1
    }
    const m = splitMatches[s.active]
    if (!m) return
    replaceWholeDocumentContent(
      content.value.slice(0, m.from) + s.replacement + content.value.slice(m.to)
    )
    nextTick(() => runFind(false))
  }
}
const replaceAll = () => {
  const s = findState.value
  if (!s.query) return
  if (viewMode.value === 'single' && richEditorRef.value) {
    const r = richEditorRef.value.searchReplaceAll(s.replacement)
    s.count = 0; s.active = -1
    if (r.replaced) notify(t('find_replaced_n').replace('{n}', r.replaced))
  } else {
    if (largeRichEditorRef.value?.flushEmit) largeRichEditorRef.value.flushEmit()
    commitLargeSourceDraft('replace-all')
    splitFindMatches(s.query, { caseSensitive: s.caseSensitive, wholeWord: s.wholeWord })
    if (!splitMatches.length) return
    let out = ''
    let last = 0
    for (const m of splitMatches) { out += content.value.slice(last, m.from) + s.replacement; last = m.to }
    out += content.value.slice(last)
    const n = splitMatches.length
    replaceWholeDocumentContent(out)
    s.count = 0; s.active = -1
    notify(t('find_replaced_n').replace('{n}', n))
  }
}
const openFind = (replace) => {
  const s = findState.value
  s.open = true
  s.replace = replace || s.replace
  // seed with the current selection
  const sel = viewMode.value === 'split'
    ? (textareaRef.value ? content.value.slice(textareaRef.value.selectionStart, textareaRef.value.selectionEnd) : '')
    : (window.getSelection ? String(window.getSelection()) : '')
  if (sel && sel.length && sel.length < 80 && !sel.includes('\n')) s.query = sel
  nextTick(() => {
    if (findInputRef.value) { findInputRef.value.focus(); findInputRef.value.select() }
    if (s.query) runFind(true)
  })
}
const closeFind = () => {
  findState.value.open = false
  if (richEditorRef.value && richEditorRef.value.searchClear) richEditorRef.value.searchClear()
  if (viewMode.value === 'single' && richEditorRef.value) richEditorRef.value.focusEditor()
}
const onFindKeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    findStep(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeFind()
  }
}
// re-run search when the query/options change while the bar is open
watch(() => [findState.value.query, findState.value.caseSensitive, findState.value.wholeWord], () => {
  if (findState.value.open) runFind(true)
})
// switching view mode moves the search to the other engine
watch(() => viewMode.value, () => {
  if (findState.value.open && findState.value.query) nextTick(() => runFind(false))
})

// ========== Quick open (Ctrl+P) ==========
const quickOpen = ref({ open: false, query: '', index: 0 })
const openQuickOpen = () => {
  if (!folderHandle.value) { notify(t('quick_open_need_folder')); return }
  quickOpen.value = { open: true, query: '', index: 0 }
  nextTick(() => { const el = document.querySelector('.knote-quickopen input'); if (el) el.focus() })
}
const closeQuickOpen = () => { quickOpen.value.open = false }
const quickOpenResults = computed(() => {
  if (!quickOpen.value.open) return []
  const files = walkTreeFiles(folderTree.value, [])
  const q = quickOpen.value.query.trim().toLowerCase()
  const scored = files.map((n) => {
    const name = n.name.toLowerCase()
    const path = n.path.toLowerCase()
    if (!q) return { n, score: 0 }
    // subsequence fuzzy match on the path; tighter = better
    let qi = 0
    for (let i = 0; i < path.length && qi < q.length; i++) if (path[i] === q[qi]) qi++
    if (qi < q.length) return null
    const score = (name.includes(q) ? 0 : 100) + path.indexOf(q[0])
    return { n, score }
  }).filter(Boolean)
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, 20).map((x) => x.n)
})
const runQuickOpen = (node) => {
  const target = node || quickOpenResults.value[quickOpen.value.index]
  closeQuickOpen()
  if (target) openTreeFile(target)
}
const onQuickOpenKeydown = (e) => {
  const results = quickOpenResults.value
  if (e.key === 'ArrowDown') { e.preventDefault(); quickOpen.value.index = Math.min(quickOpen.value.index + 1, results.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); quickOpen.value.index = Math.max(quickOpen.value.index - 1, 0) }
  else if (e.key === 'Enter') { e.preventDefault(); runQuickOpen() }
  else if (e.key === 'Escape') { e.preventDefault(); closeQuickOpen() }
}
watch(() => quickOpen.value.query, () => { quickOpen.value.index = 0 })

// Esc closes the history / shortcuts modals
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (historyPanel.value.open) closeHistory()
  else if (shortcutsOpen.value) shortcutsOpen.value = false
})
// periodic snapshot of the active doc (every 3 min, only if changed) so even
// never-saved scratch work builds a small safety history
let snapTimer = null
const startSnapshotTimer = () => {
  clearInterval(snapTimer)
  snapTimer = setInterval(() => { if (content.value.trim()) void takeSnapshot() }, 180000)
}

// Close daisyUI focus-based dropdowns after picking an item
const blurActiveElement = () => {
  const el = document.activeElement
  if (el && typeof el.blur === 'function') el.blur()
}

const toggleEditorCentered = () => {
  if (isAndroidNative) return
  editorCentered.value = !editorCentered.value
  try { localStorage.setItem(EDITOR_CENTERED_KEY, editorCentered.value ? '1' : '0') } catch { /* preference is best-effort */ }
  blurActiveElement()
}

// ========== Keyboard Shortcuts ==========
const handleGlobalKeydown = (e) => {
  // image viewer is modal: no global shortcut (undo, image delete, …) may
  // act on the document behind the overlay; Esc has its own listener
  if (imageViewer.value) return
  const eventPath = typeof e.composedPath === 'function' ? e.composedPath() : [e.target]
  const editableTarget = eventPath.find((node) => node && node.nodeType === 1 && node.matches &&
    node.matches('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]'))
  const documentSourceEditor = !!editableTarget && textareaRef.value === editableTarget
  const documentRichEditor = eventPath.some((node) => node && node.classList && node.classList.contains('knote-rich'))
  const foreignEditable = !!editableTarget && !documentSourceEditor && !documentRichEditor
  const shortcutKey = String(e.key || '').toLowerCase()
  // Native editing history and deletion belong to the focused Agent/settings
  // control. Capture-phase document shortcuts must never mutate the editor
  // behind it. File-level shortcuts such as Ctrl+S/F/P remain available.
  if (foreignEditable && (!(e.ctrlKey || e.metaKey) || ['z', 'y', 'b', 'i', 'u', 'e', 'k'].includes(shortcutKey))) return
  if (!(e.ctrlKey || e.metaKey)) {
    // Backspace/Delete on a selected (non-editing) image block deletes it
    if ((e.key === 'Backspace' || e.key === 'Delete') &&
        viewMode.value === 'single' && !activeBlockId.value &&
        selectedBlock.value && isImageBlock(selectedBlock.value)) {
      e.preventDefault()
      deleteImageBlock()
    }
    return
  }

  const key = shortcutKey

  // Single mode: ProseMirror handles its own shortcuts while focused
  const editorFocused = viewMode.value === 'single' &&
    document.activeElement && document.activeElement.closest &&
    document.activeElement.closest('.knote-rich')

  if (key === 'f') {
    e.preventDefault()
    openFind(false)
    return
  } else if (key === 'h') {
    e.preventDefault()
    openFind(true)
    return
  } else if (key === 'p' && !e.shiftKey) {
    e.preventDefault()
    openQuickOpen()
    return
  }

  if (!e.altKey && !e.shiftKey && (key === '/' || e.code === 'Slash' || e.code === 'NumpadDivide')) {
    e.preventDefault()
    setViewMode(viewMode.value === 'single' ? 'split' : 'single')
    return
  }

  if (key === 'z') {
    if (editorFocused) return
    e.preventDefault()
    if (e.shiftKey) {
      redo()
    } else {
      undo()
    }
  } else if (key === 'y') {
    if (editorFocused) return
    e.preventDefault()
    redo()
  } else if (key === 's') {
    e.preventDefault()
    saveFile()
  } else if (key === 'b' || key === 'i' || key === 'u' || key === 'e' || key === 'k') {
    // Formatting shortcuts: wrap the selection in markdown syntax
    const typeMap = { b: 'bold', i: 'italic', u: 'underline', e: 'code', k: 'link' }
    if (viewMode.value === 'split') {
      const el = textareaRef.value
      if (el && document.activeElement === el) {
        e.preventDefault()
        if (key === 'b') insertAround('**', '**', lang.value === 'zh' ? '加粗文本' : 'bold text')
        else if (key === 'i') insertAround('*', '*', lang.value === 'zh' ? '强调文本' : 'italic text')
        else if (key === 'u') insertAround('++', '++', lang.value === 'zh' ? '下划线文本' : 'underlined text')
        else if (key === 'e') insertAround('`', '`', lang.value === 'zh' ? '行内代码' : 'inline code')
        else insertAround('[', '](https://)', lang.value === 'zh' ? '链接文本' : 'link text')
      }
    }
    // Single mode: TipTap's own keymap covers Ctrl+B/I/U/E when focused
    void typeMap
  } else if (key === 'x' && e.shiftKey) {
    // Strikethrough in the split source editor: Ctrl+Shift+X wraps the
    // selection in ~~ (markdown strike), symmetric with Ctrl+B/I/U/E/K.
    if (viewMode.value === 'split') {
      const el = textareaRef.value
      if (el && document.activeElement === el) {
        e.preventDefault()
        insertAround('~~', '~~', lang.value === 'zh' ? '删除线文本' : 'deleted text')
      }
    }
  }
}

// Register keyboard shortcuts removed from here - moved to consolidated onMounted at bottom

const updateEditorMetrics = () => {
  const el = textareaRef.value
  if (!el) return
  const style = getComputedStyle(el)
  lineHeight.value = parseFloat(style.lineHeight) || 24
  paddingTop.value = parseFloat(style.paddingTop) || 16
  paddingLeft.value = parseFloat(style.paddingLeft) || 16
}

const getCaretCoordinates = (el, index) => {
  const style = getComputedStyle(el)
  const div = document.createElement('div')
  const props = [
    'boxSizing',
    'width',
    'height',
    'overflowX',
    'overflowY',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontStyle',
    'fontVariant',
    'fontWeight',
    'fontStretch',
    'fontSize',
    'lineHeight',
    'fontFamily',
    'textTransform',
    'textAlign',
    'letterSpacing',
    'wordSpacing',
    'textIndent',
    'whiteSpace'
  ]
  props.forEach((prop) => {
    div.style[prop] = style[prop]
  })
  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.whiteSpace = 'pre-wrap'
  div.style.wordWrap = 'break-word'
  div.style.top = '0'
  div.style.left = '0'
  div.style.zIndex = '-1'
  div.textContent = el.value.slice(0, index)
  const span = document.createElement('span')
  span.textContent = el.value.slice(index, index + 1) || '.'
  div.appendChild(span)
  document.body.appendChild(div)
  div.scrollTop = el.scrollTop
  div.scrollLeft = el.scrollLeft
  const spanRect = span.getBoundingClientRect()
  const divRect = div.getBoundingClientRect()
  document.body.removeChild(div)
  return {
    top: spanRect.top - divRect.top - el.scrollTop,
    left: spanRect.left - divRect.left - el.scrollLeft
  }
}

const toolbarState = ref({
  bold: false,
  italic: false,
  strike: false,
  code: false,
  heading: false,
  quote: false,
  ul: false,
  ol: false,
  task: false,
  link: false,
  image: false,
  table: false
})

const checkToolbarState = () => {
  if (viewMode.value !== 'single') return
  
  // 0. Reset to inactive before checking
  const resetState = {
    bold: 'inactive',
    italic: 'inactive',
    strike: 'inactive',
    code: 'inactive',
    heading: false,
    showHeadings: false,
    quote: 'inactive',
    ul: 'inactive',
    ol: 'inactive',
    task: false,
    link: 'inactive',
    image: 'inactive',
    table: 'inactive'
  }

  const range = getPreviewRange()
  if (!range || range.collapsed) {
    toolbarState.value = resetState
    return
  }

  // Tag-based state detection. document.queryCommandState is unreliable here:
  // it always reports false when the selection is outside a contenteditable,
  // and under the block engine only the active block is editable.
  const getState = (tagNames, selector) => {
    for (const tagName of tagNames) {
      if (findClosestTag(range.commonAncestorContainer, tagName)) return 'active'
    }
    const fragment = range.cloneContents()
    if (selector && fragment.querySelector(selector)) {
      // Fully wrapped selections resolve via ancestor check above; a match
      // only inside the fragment means partial coverage
      return 'mixed'
    }
    return 'inactive'
  }

  const bold = getState(['STRONG', 'B'], 'strong, b')
  const italic = getState(['EM', 'I'], 'em, i')
  const strike = getState(['DEL', 'S', 'STRIKE'], 'del, s, strike')
  const code = getState(['CODE'], 'code')
  const link = getState(['A'], 'a')

  // Heading Logic: Only show if Whole Block is Selected
  const isWholeBlock = checkWholeBlockSelected(range)
  const heading = isWholeBlock ? ['H1','H2','H3','H4','H5','H6'].includes(findClosestBlock(range.commonAncestorContainer)?.nodeName) : false
  const showHeadings = isWholeBlock // Control visibility based on selection

    toolbarState.value = {
      bold: bold,
      italic: italic,
      strike: strike,
      code: code,
      heading: heading,
      showHeadings: showHeadings, // New state for visibility
      quote: findClosestTag(range.commonAncestorContainer, 'BLOCKQUOTE') ? 'active' : 'inactive',
      ul: findClosestTag(range.commonAncestorContainer, 'UL') ? 'active' : 'inactive',
      ol: findClosestTag(range.commonAncestorContainer, 'OL') ? 'active' : 'inactive',
      task: false,
      link: link,
      image: 'inactive',
      table: 'inactive'
    }
}

const checkWholeBlockSelected = (range) => {
  if (!range) return false
  const block = findClosestBlock(range.startContainer)
  if (!block) return false
  
  // Compare text content of selection with block text content
  // Note: range.toString() gives selected text. block.textContent gives full text.
  // We need to trim potential whitespace for loose comparison
  const selectedText = range.toString().trim()
  const blockText = block.textContent.trim()
  
  return selectedText.length > 0 && selectedText === blockText
}

const showToolbarAtSelection = async () => {
  // Disable floating toolbar in split view (User request #2)
  if (viewMode.value === 'split') {
    toolbarVisible.value = false
    return
  }
  
  const el = textareaRef.value
  const area = editorAreaRef.value
  if (!el || !area) return
  const { selectionStart, selectionEnd } = el
  if (selectionStart === selectionEnd) {
    if (toolbarMode.value === 'selection') {
      toolbarVisible.value = false
    }
    return
  }
  const coords = getCaretCoordinates(el, selectionEnd)
  const rect = el.getBoundingClientRect()
  const areaRect = area.getBoundingClientRect()
  toolbarTop.value = rect.top - areaRect.top + coords.top
  toolbarLeft.value = rect.left - areaRect.left + coords.left
  
  // Update state based on new selection
  checkToolbarState()
  
  toolbarMode.value = 'selection'
  toolbarVisible.value = true
}

// ... existing code ...

const showPreviewToolbarAtSelection = () => {
  if (viewMode.value !== 'single') return
  const range = getPreviewRange()
  const area = previewAreaRef.value
  if (!range || !area) {
    if (toolbarMode.value === 'selection') {
      toolbarVisible.value = false
    }
    return
  }
  
  // Clamp so the (48px, -translate-y-full) toolbar never leaves the area top
  const clampTop = (v) => Math.max(v, 64)

  // For image blocks, show toolbar even with collapsed selection
  if (range.collapsed) {
    const resolved = resolveImageFromRange(range)
    let block = resolved?.block || findClosestBlock(range.startContainer)
    block = resolveImageBlockFromBlock(block) || block
    if (block && isImageBlock(block)) {
      const blockRect = block.getBoundingClientRect()
      const areaRect = area.getBoundingClientRect()
      toolbarTop.value = clampTop(blockRect.top - areaRect.top - 16)
      toolbarLeft.value = blockRect.left - areaRect.left + (blockRect.width / 2)
      toolbarMode.value = 'selection'
      toolbarVisible.value = true
      updateImageScale()
      return
    }
    if (toolbarMode.value === 'selection') {
      toolbarVisible.value = false
    }
    return
  }

  // Check if selection is an image block (even if not collapsed)
  // This ensures fixed centering on the block line instead of floating with the image
  const resolved = resolveImageFromRange(range)
  let block = resolved?.block || findClosestBlock(range.commonAncestorContainer)
  block = resolveImageBlockFromBlock(block) || block
  if (block && isImageBlock(block)) {
    const blockRect = block.getBoundingClientRect()
    const areaRect = area.getBoundingClientRect()
    toolbarTop.value = clampTop(blockRect.top - areaRect.top - 16)
    toolbarLeft.value = blockRect.left - areaRect.left + (blockRect.width / 2)
    toolbarMode.value = 'selection'
    toolbarVisible.value = true
    updateImageScale()
    updateImageAlign()
    return
  }

  // Text-format toolbar only makes sense where formatting can be applied:
  // inside the ACTIVE (contenteditable) block
  const blockEl = getBlockElFromNode(range.commonAncestorContainer)
  const isActive = blockEl && activeBlockId.value && blockEl.id === `block-content-${activeBlockId.value}`
  if (!isActive) {
    if (toolbarMode.value === 'selection') {
      toolbarVisible.value = false
    }
    return
  }

  const rect = range.getBoundingClientRect()
  const areaRect = area.getBoundingClientRect()

  toolbarTop.value = clampTop(rect.top - areaRect.top - 16)
  toolbarLeft.value = rect.left - areaRect.left + (rect.width / 2)

  toolbarMode.value = 'selection'
  toolbarVisible.value = true
}


// ... existing code ...

watchEffect(() => {
  document.documentElement.setAttribute('data-theme', theme.value)
  window.knoteDesktop?.setTitlebarTheme?.(theme.value === 'dark')
})


// LEGACY: renderSinglePreview is DISABLED.
// The block engine (parsedBlocks v-for loop) now handles all single-mode rendering.
// This function previously injected renderedHtml directly into previewRef.innerHTML,
// completely destroying the Vue-managed block DOM.
// const renderSinglePreview = () => { ... }

// LEGACY WATCHER DISABLED — block engine handles rendering reactively.
// watch([() => viewMode.value, previewRef], ...)
// watch(content, ...)

// UI State watcher
watch(viewMode, async (val) => {
  if (val === 'split') {
    toolbarVisible.value = false
    // Re-anchor the scroll-sync baselines once the two panes have laid out, so
    // the first scroll doesn't measure a delta against a stale single-view top.
    await nextTick()
    await nextTick()
    reanchorSplitScroll()
    setupSplitAnchorObserver()
  } else {
    teardownSplitAnchorObserver()
  }
  lineButtonVisible.value = false
  if (val === 'single') {
    await nextTick()
    await nextTick()
    if (viewModeSelectionSnapshot.value && viewModeSelectionSnapshot.value.type === 'single') {
      restoreSelectionSnapshot(viewModeSelectionSnapshot.value)
      updateSelectedBlock()
    }
    // hunks staged while in split mode were never painted (previewChange is
    // gated on single mode) — repaint them on the freshly synced editor
    if (pendingHunks.value.length) scheduleAgentPreviewResync()
  }
})

// Any content edit can move heading positions; mark the split-sync anchors stale
// (rebuilt lazily on the next scroll, and by the preview ResizeObserver).
watch(content, () => { splitAnchorsDirty = true })

const getPreviewRange = () => {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const root = previewRef.value
  if (!root) return null
  const container = range.commonAncestorContainer
  if (container && !root.contains(container)) return null
  return range
}

const getClosestElement = (node) => {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
}

const getClosestTable = (node) => {
  let el = getClosestElement(node)
  const root = previewRef.value
  while (el && el !== root) {
    if (el.nodeName === 'TABLE') return el
    el = el.parentElement
  }
  return null
}

const getClosestCell = (node) => {
  let el = getClosestElement(node)
  const root = previewRef.value
  while (el && el !== root) {
    if (el.nodeName === 'TD' || el.nodeName === 'TH') return el
    el = el.parentElement
  }
  return null
}

const findClosestTag = (node, tagName) => {
  let el = getClosestElement(node)
  const root = previewRef.value
  while (el && el !== root) {
    if (el.nodeName === tagName) return el
    el = el.parentElement
  }
  return null
}

const findClosestBlock = (node) => {
  let el = getClosestElement(node)
  const root = previewRef.value
  const blockTags = [
    'P',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'LI',
    'BLOCKQUOTE',
    'PRE',
    'TABLE',
    'DIV'
  ]
  while (el && el !== root) {
    if (blockTags.includes(el.nodeName)) return el
    el = el.parentElement
  }
  return null
}

const clearTableCellSelection = () => {
  const cells = Array.from(selectedTableCells.value)
  cells.forEach((cell) => cell.classList.remove('table-cell-selected'))
  selectedTableCells.value = new Set()
}

// The table the toolbar is currently anchored to. Ops resolve their target
// from THIS ref — the volatile hovered/focused refs get cleared by unrelated
// selection changes, which used to make the toolbar buttons dead.
const tableToolbarTarget = ref(null)

const updateTableToolbarPosition = (table) => {
  if (!table || !previewAreaRef.value) return
  const rect = table.getBoundingClientRect()
  const areaRect = previewAreaRef.value.getBoundingClientRect()
  tableToolbarTarget.value = table
  tableToolbarTop.value = Math.max(rect.top - areaRect.top - 12, 64)
  tableToolbarLeft.value = rect.left - areaRect.left + (rect.width / 2)
  tableToolbarVisible.value = true
}

const getCellPosition = (table, cell) => {
  const row = cell.parentElement
  const rows = Array.from(table.querySelectorAll('tr'))
  const rowIndex = rows.indexOf(row)
  const colIndex = Array.from(row.children).indexOf(cell)
  return { rowIndex, colIndex }
}

const getActiveTable = () => {
  const anchored = tableToolbarTarget.value
  if (anchored && anchored.isConnected) return anchored
  return focusedTable.value || hoveredTable.value
}

const getActiveCell = () => {
  if (selectedTableCells.value.size > 0) {
    return Array.from(selectedTableCells.value)[0]
  }
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  return getClosestCell(selection.getRangeAt(0).startContainer)
}

const createTableCell = (tagName = 'TD') => {
  const cell = document.createElement(tagName)
  cell.innerHTML = '<br>'
  return cell
}

// Commit a mutated table back to markdown by re-serializing ONLY its own block
// (never the whole preview DOM), then re-anchor the toolbar on the fresh DOM.
const syncTableChange = (table) => {
  if (!table) return
  const blockEl = getBlockElFromNode(table)
  if (!blockEl) return
  const blockElId = blockEl.id
  commitBlockElement(blockEl)
  nextTick(() => {
    const freshBlock = document.getElementById(blockElId)
    const freshTable = freshBlock ? freshBlock.querySelector('table') : null
    if (freshTable) {
      focusedTable.value = freshTable
      updateTableToolbarPosition(freshTable)
    } else {
      focusedTable.value = null
      tableToolbarVisible.value = false
    }
  })
}

const deleteTableBlock = (tableOverride = null) => {
  const table = tableOverride || getActiveTable()
  if (!table) return
  const blockEl = getBlockElFromNode(table)
  toolbarVisible.value = false
  tableToolbarVisible.value = false
  lineButtonVisible.value = false
  clearSelectionUi()
  selectedBlock.value = null
  focusedTable.value = null
  hoveredTable.value = null
  clearTableCellSelection()
  const range = getBlockLineRange(blockEl)
  if (range) {
    spliceLines(range.start, range.end, '', false)
  }
  nextTick(() => {
    updateEditorMetrics()
  })
}

const insertTableRow = (position = 'below') => {
  const table = getActiveTable()
  if (!table) return
  const rows = Array.from(table.querySelectorAll('tr'))
  if (rows.length === 0) return
  const cell = getActiveCell()
  const rowIndex = cell ? rows.indexOf(cell.parentElement) : rows.length - 1
  const refRow = rows[Math.max(0, rowIndex)]
  const refCell = refRow.children[0]
  const tagName = refCell && refCell.nodeName === 'TH' ? 'TD' : (refCell?.nodeName || 'TD')
  const newRow = document.createElement('tr')
  const colCount = refRow.children.length || 1
  for (let i = 0; i < colCount; i += 1) {
    newRow.appendChild(createTableCell(tagName))
  }
  const parentSection = refRow.parentElement || table
  if (position === 'above') {
    parentSection.insertBefore(newRow, refRow)
  } else {
    if (parentSection.nodeName === 'THEAD' && table.tBodies[0]) {
      table.tBodies[0].insertBefore(newRow, table.tBodies[0].firstChild)
    } else {
      parentSection.insertBefore(newRow, refRow.nextSibling)
    }
  }
  focusedTable.value = table
  syncTableChange(table)
}

const insertTableColumn = (position = 'right') => {
  const table = getActiveTable()
  if (!table) return
  const rows = Array.from(table.querySelectorAll('tr'))
  if (rows.length === 0) return
  const cell = getActiveCell()
  let colIndex = 0
  if (cell) {
    const pos = getCellPosition(table, cell)
    if (pos.colIndex >= 0) colIndex = pos.colIndex
  }
  rows.forEach((row) => {
    const refCell = row.children[colIndex]
    const tagName = row.children[0]?.nodeName || 'TD'
    const newCell = createTableCell(tagName)
    if (position === 'left') {
      row.insertBefore(newCell, refCell || null)
    } else if (refCell) {
      row.insertBefore(newCell, refCell.nextSibling)
    } else {
      row.appendChild(newCell)
    }
  })
  focusedTable.value = table
  syncTableChange(table)
}

const deleteTableRow = () => {
  const table = getActiveTable()
  if (!table) return
  const rows = Array.from(table.querySelectorAll('tr'))
  if (rows.length === 0) return
  const cell = getActiveCell()
  const targetRow = cell ? cell.parentElement : rows[rows.length - 1]
  if (!targetRow) return
  targetRow.remove()
  if (table.querySelectorAll('tr').length === 0) {
    deleteTableBlock(table)
    return
  }
  focusedTable.value = table
  syncTableChange(table)
}

const deleteTableColumn = () => {
  const table = getActiveTable()
  if (!table) return
  const rows = Array.from(table.querySelectorAll('tr'))
  if (rows.length === 0) return
  const cell = getActiveCell()
  let colIndex = 0
  if (cell) {
    const pos = getCellPosition(table, cell)
    if (pos.colIndex >= 0) colIndex = pos.colIndex
  }
  rows.forEach((row) => {
    const target = row.children[colIndex]
    if (target) target.remove()
  })
  const remaining = Array.from(table.querySelectorAll('tr')).every((row) => row.children.length === 0)
  if (remaining) {
    deleteTableBlock(table)
    return
  }
  focusedTable.value = table
  syncTableChange(table)
}

// Check if a block element is primarily an image container
const isImageBlock = (block) => {
  if (!block) return false
  const resolved = resolveImageBlockFromBlock(block) || block
  if (resolved.getAttribute && resolved.getAttribute('data-image-block') === 'true') return true
  if (resolved.nodeName === 'IMG') return true
  if (resolved.nodeName === 'P' || resolved.nodeName === 'DIV') {
    const imgs = resolved.querySelectorAll('img')
    if (imgs.length >= 1) {
      return isImageOnlyBlock(resolved)
    }
  }
  return false
}


const getInsertionAnchorLine = () => {
  let blockEl = null
  if (activeBlockId.value) {
    blockEl = document.getElementById(`block-content-${activeBlockId.value}`)
  }
  if (!blockEl) {
    const range = getPreviewRange() || savedSelection.value
    if (range) blockEl = getBlockElFromNode(range.startContainer)
  }
  if (!blockEl && selectedBlock.value) {
    blockEl = getBlockElFromNode(selectedBlock.value)
  }
  if (blockEl) {
    const r = getBlockLineRange(blockEl)
    // Insert at the block's FIRST line: the new content takes the CURRENT
    // line's position instead of landing on the line below the block.
    if (r) return r.start
  }
  return content.value.split('\n').length
}

const insertPreviewTable = (rows = 3, cols = 3) => {
  // Validate dimensions
  if (isNaN(rows) || isNaN(cols) || rows < 1 || cols < 1) {
    rows = 3
    cols = 3
  }
  rows = Math.min(rows, 100)
  cols = Math.min(cols, 20)

  // Commit any active edit first so the anchor line indices are accurate
  if (activeBlockId.value) {
    const prev = parsedBlocks.value.find(b => b.id === activeBlockId.value)
    if (prev) commitBlockEdit(prev)
  }

  const mdRows = []
  for (let i = 0; i < rows; i++) {
    mdRows.push('| ' + Array(cols).fill('   ').join(' | ') + ' |')
    if (i === 0) {
      mdRows.push('| ' + Array(cols).fill('---').join(' | ') + ' |')
    }
  }
  insertMarkdownAfterLine(getInsertionAnchorLine(), mdRows.join('\n'))
  savedSelection.value = null
}


const insertPreviewImage = () => {
  insertImageBelow()
}

const insertPreviewHr = () => {
  if (activeBlockId.value) {
    const prev = parsedBlocks.value.find(b => b.id === activeBlockId.value)
    if (prev) commitBlockEdit(prev)
  }
  insertMarkdownAfterLine(getInsertionAnchorLine(), '---')
}

// NOTE: the old syncPreviewToMarkdown (wholesale turndown of the entire preview
// DOM) has been removed. It predated the block engine and corrupted the source
// (pilcrow placeholders, block wrappers, broken tables). All DOM->markdown
// writes now go through commitBlockEdit / commitBlockElement, which serialize
// a single block and splice its exact line range.




const getLineStartFromIndex = (lineIndex) => {
  const lines = content.value.split('\n')
  const safeIndex = Math.min(Math.max(lineIndex, 0), lines.length - 1)
  let start = 0
  for (let i = 0; i < safeIndex; i += 1) {
    start += lines[i].length + 1
  }
  return start
}

const updateLineButton = () => {
  if (viewMode.value !== 'split') return
  const el = textareaRef.value
  if (!el) return
  // The textarea no longer scrolls itself (the pane's scroll container does), so
  // its bounding rect already moves with the scroll. Mouse-Y minus the textarea
  // top is therefore directly the content offset, and the button position is
  // content-space (no scrollTop terms needed).
  const rect = el.getBoundingClientRect()
  const y = lastHoverY.value - rect.top - paddingTop.value
  const lineIndex = Math.max(0, Math.floor(y / lineHeight.value))
  const top = lineIndex * lineHeight.value + paddingTop.value
  lineButtonTop.value = top
  lineStartIndex.value = getLineStartFromIndex(lineIndex)
  lineButtonLeft.value = -12
}

const handleSelectionChange = () => {
  if (viewMode.value !== 'split') {
    // Selections INSIDE the block editor textarea are handled by its own
    // select/keyup handlers — the document-level handler must not interfere
    const ae = document.activeElement
    if (ae && ae.id && ae.id.startsWith('block-editor-')) return
    // For single view, update everything via shared handler
    handlePreviewSelection()
    return
  }
  const el = textareaRef.value
  // Route by where the live selection actually is: a DOM range inside the read-only
  // preview, or the source textarea's own selection (which is not a document range).
  const sel = window.getSelection()
  const pv = splitPreviewRef.value
  if (pv && sel && sel.rangeCount && pv.contains(sel.anchorNode)) {
    clearSourceSelectionHighlight()
    updateSplitPreviewSelection()
    return
  }
  if (!el) return
  lineButtonVisible.value = el.selectionStart === el.selectionEnd
  ensureSourceCaretVisible()
  updateSplitSourceSelection()
  updateSourceSelectionHighlight()
}

// Clicking the empty area below a short document drops the caret at the end of
// the source, like a normal editor — the auto-grown textarea (field-sizing) no
// longer fills the pane by itself, so the shared stack catches those clicks.
// Clicks that land directly on the textarea keep native caret placement.
const onSourceStackMousedown = (e) => {
  const ta = textareaRef.value
  if (!ta || e.target === ta) return
  e.preventDefault()
  ta.focus()
  const len = ta.value.length
  ta.selectionStart = ta.selectionEnd = len
}

// Keep the caret visible while typing / navigating. The textarea no longer
// scrolls itself (the pane's scroll container does), and with overflow:hidden
// the browser does NOT auto-scroll that ancestor on caret moves — so we do it
// explicitly, using the same mirror-div measurement as the floating toolbar.
const ensureSourceCaretVisible = () => {
  if (viewMode.value !== 'split') return
  const ta = textareaRef.value
  const sc = editorAreaRef.value
  if (!ta || !sc) return
  const { top } = getCaretCoordinates(ta, ta.selectionStart)
  const caretTop = top
  const caretBottom = top + lineHeight.value
  const viewTop = sc.scrollTop
  const viewBottom = sc.scrollTop + sc.clientHeight
  if (caretTop < viewTop + paddingTop.value) {
    sc.scrollTop = Math.max(0, caretTop - paddingTop.value)
  } else if (caretBottom > viewBottom - paddingTop.value) {
    sc.scrollTop = caretBottom - sc.clientHeight + paddingTop.value
  }
}

const selectedBlock = ref(null)
const getActiveImageSelection = () => {
  const range = getPreviewRange()
  if (range) {
    const resolved = resolveImageFromRange(range)
    if (resolved) return resolved
  }
  if (selectedBlock.value && isImageBlock(selectedBlock.value)) {
    const img = getImageFromBlock(selectedBlock.value)
    if (img) return { img, block: selectedBlock.value }
  }
  return null
}
const activeImageSelection = computed(() => {
  if (viewMode.value !== 'single') return null
  return getActiveImageSelection()
})
watch(activeImageSelection, (val) => {
  if (val) {
    selectedImage.value = val.img
    selectedBlock.value = val.block
  }
})

// Stable Highlight Logic
// We track the style separately to prevent it from jumping to (0,0) when selectedBlock changes
// or momentarily becomes null during DOM updates (e.g. deletion).
// ---- Selection UI (CSS-class driven) ----
// The old system measured getBoundingClientRect into absolutely positioned
// overlay divs; it drifted on scroll, margins and image loads. Instead we tag
// the selected block's container with a class and let CSS draw the indicator
// exactly on the block's own box.
const selectedUiId = ref(null)     // parsedBlocks id, e.g. 'block-3'
const selectedUiKind = ref('simple') // 'simple' | 'complex' | 'image'

const clearSelectionUi = () => {
  selectedBlock.value = null
  selectedImage.value = null
  selectedUiId.value = null
}

// ---- Block drag & drop reordering (Feishu-style handle) ----
const dragSourceId = ref(null)
const dropIndicator = ref(null) // { id: 'block-N', before: boolean }
// Captured on the handle's mousedown, BEFORE the blur-commit cascade clears
// the selection state. Lines are stable across a commit of the same block.
let pendingDragLine = -1

const handleDragHandleMouseDown = () => {
  const el = selectedBlock.value
    ? getBlockElFromNode(selectedBlock.value)
    : (selectedUiId.value ? document.getElementById(`block-content-${selectedUiId.value}`) : null)
  const range = el ? getBlockLineRange(el) : null
  pendingDragLine = range ? range.start : -1
}

const handleDragHandleStart = (e) => {
  const line = pendingDragLine
  const block = line >= 0
    ? parsedBlocks.value.find(b => b.startLine <= line && line < b.endLine && b.type !== 'gap')
      || parsedBlocks.value.find(b => b.startLine <= line && line < b.endLine)
    : null
  if (!block) {
    e.preventDefault()
    return
  }
  dragSourceId.value = block.id
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', block.id)
  const el = document.getElementById(`block-content-${block.id}`)
  if (el) e.dataTransfer.setDragImage(el, 0, 12)
}

const handlePreviewDragOver = (e) => {
  if (!dragSourceId.value) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  const hit = document.elementFromPoint(e.clientX, e.clientY)
  const blockEl = getBlockElFromNode(hit)
  if (!blockEl) {
    dropIndicator.value = null
    return
  }
  const m = blockEl.id.match(/^block-content-(block-\d+)$/)
  if (!m || m[1] === dragSourceId.value) {
    dropIndicator.value = null
    return
  }
  const rect = blockEl.getBoundingClientRect()
  dropIndicator.value = { id: m[1], before: e.clientY < rect.top + rect.height / 2 }
}

const handlePreviewDrop = (e) => {
  const src = dragSourceId.value
  const ind = dropIndicator.value
  dragSourceId.value = null
  dropIndicator.value = null
  if (!src || !ind) return
  e.preventDefault()
  moveBlock(src, ind.id, ind.before)
}

const handleDragEnd = () => {
  dragSourceId.value = null
  dropIndicator.value = null
}

// Move a block's source lines before/after another block, keeping exactly one
// blank separator at every seam.
const moveBlock = (sourceId, targetId, before) => {
  const blocks = parsedBlocks.value
  const src = blocks.find(b => b.id === sourceId)
  const tgt = blocks.find(b => b.id === targetId)
  if (!src || !tgt || src.id === tgt.id) return

  const lines = content.value.split('\n')
  let seg = lines.slice(src.startLine, src.endLine)
  while (seg.length && seg[seg.length - 1].trim() === '') seg.pop()
  while (seg.length && seg[0].trim() === '') seg.shift()
  if (!seg.length) return

  let insertAt = before ? tgt.startLine : tgt.endLine
  const srcLen = src.endLine - src.startLine

  // Remove the source lines
  lines.splice(src.startLine, srcLen)
  if (insertAt >= src.endLine) insertAt -= srcLen

  // Collapse a doubled blank at the removal seam
  const seam = src.startLine
  if (seam > 0 && seam < lines.length && lines[seam - 1].trim() === '' && lines[seam].trim() === '') {
    lines.splice(seam, 1)
    if (insertAt > seam) insertAt -= 1
  } else if (seam === 0 && lines.length && lines[0].trim() === '') {
    // Moving away the first block leaves its old separator stranded at the top
    lines.splice(0, 1)
    if (insertAt > 0) insertAt -= 1
  }

  insertAt = Math.max(0, Math.min(insertAt, lines.length))
  lines.splice(insertAt, 0, '', ...seg, '')

  // Collapse doubled blanks at the insertion seams (trailing first — its
  // index is higher and unaffected by the leading collapse)
  const tail = insertAt + seg.length + 2
  if (tail < lines.length && lines[tail - 1].trim() === '' && lines[tail].trim() === '') {
    lines.splice(tail, 1)
  }
  if (insertAt === 0) {
    // No separator needed at the very start of the document
    if (lines[0].trim() === '') lines.splice(0, 1)
  } else if (lines[insertAt - 1].trim() === '' && lines[insertAt].trim() === '') {
    lines.splice(insertAt, 1)
  }

  clearSelectionUi()
  content.value = lines.join('\n')
}

// Derive the UI indicator target/kind from a DOM node inside a block
const setSelectionUiFromBlock = (block) => {
  const blockEl = getBlockElFromNode(block)
  if (!blockEl) {
    selectedUiId.value = null
    return
  }
  const m = blockEl.id.match(/^block-content-(block-\d+)$/)
  selectedUiId.value = m ? m[1] : null

  if (isImageBlock(block)) {
    selectedUiKind.value = 'image'
    return
  }
  const nodeName = (blockEl.dataset.nodeName || '').toUpperCase()
  const isGap = (blockEl.dataset.blockType || '') === 'gap'
  selectedUiKind.value = (!isGap && ['PRE', 'TABLE', 'BLOCKQUOTE', 'UL', 'OL', 'DIV'].includes(nodeName))
    ? 'complex'
    : 'simple'
}

const updateSelectedBlock = () => {
  if (viewMode.value !== 'single') return
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return

  const range = selection.getRangeAt(0)
  const resolved = resolveImageFromRange(range)
  if (resolved) {
    selectImageBlock(resolved.img, resolved.block)
    return
  }
  let node = range.startContainer
  let block = findClosestBlock(node)
  block = resolveImageBlockFromBlock(block) || block

  if (block && previewRef.value && previewRef.value.contains(block)) {
    if (isImageBlock(block)) {
      const img = getImageFromBlock(block)
      if (img) {
        selectImageBlock(img, block)
        return
      }
    }
    selectedBlock.value = block
    setSelectionUiFromBlock(block)
    // Update line button position to selected block by default
    updateLineButtonToBlock(block)
  } else if (previewRef.value && previewRef.value.contains(node)) {
    // No block found (e.g. empty document) — show plus button at top of editor
    const areaRect = previewAreaRef.value?.getBoundingClientRect()
    const previewRect = previewRef.value.getBoundingClientRect()
    if (areaRect) {
      lineButtonTop.value = previewRect.top - areaRect.top + 4
      lineButtonLeft.value = previewRect.left - areaRect.left - 36
      lineButtonVisible.value = true
    }
  }
}

const updateLineButtonToBlock = (block) => {
  if (!block || !previewAreaRef.value) return
  const blockEl = getBlockElFromNode(block) || block
  const rect = blockEl.getBoundingClientRect()
  const areaRect = previewAreaRef.value.getBoundingClientRect()

  lineButtonTop.value = rect.top - areaRect.top + (rect.height / 2) - 12
  lineButtonLeft.value = (rect.left - areaRect.left) - 36
  lineButtonVisible.value = true
}

const handleMouseMove = (event) => {
  lastHoverY.value = event.clientY
  if (viewMode.value === 'split') {
     updateLineButton()
     updateSplitSourceHover()
  } else if (viewMode.value === 'single') {
     updatePreviewHover(event)
  }
}

// Block hover styling is pure CSS now — this handler only manages the table
// hover toolbar, with a tolerance zone so the mouse can travel from the table
// up to the toolbar without it vanishing.
const updatePreviewHover = (event) => {
  const el = document.elementFromPoint(event.clientX, event.clientY)

  const isOverToolbar = (n) => {
    if (!n) return false
    return n.closest('.selection-toolbar') ||
           n.closest('.line-toolbar') ||
           n.closest('.dropdown-content') ||
           n.closest('.line-button-bridge') ||
           n.closest('.toolbar-glow') ||
           n.closest('.table-toolbar')
  }

  if (isOverToolbar(el)) return

  const table = getClosestTable(el)
  if (table && previewRef.value && previewRef.value.contains(table)) {
    hoveredTable.value = table
    updateTableToolbarPosition(table)
    return
  }

  hoveredTable.value = null
  // Grace zone: keep the toolbar while the pointer is within the toolbar
  // corridor above/around its target table
  const target = tableToolbarTarget.value
  if (tableToolbarVisible.value && target && target.isConnected) {
    const r = target.getBoundingClientRect()
    const inZone = event.clientX >= r.left - 12 && event.clientX <= r.right + 12 &&
                   event.clientY >= r.top - 80 && event.clientY <= r.bottom + 12
    if (inZone) return
  }
  if (!focusedTable.value) {
    tableToolbarVisible.value = false
  }
}

const handleScroll = () => {
  if (viewMode.value === 'split') {
    updateLineButton()
    handleSourceSplitScroll()
  }
  showToolbarAtSelection()
  if (tableToolbarVisible.value) {
    const table = getActiveTable()
    if (table && table.isConnected) updateTableToolbarPosition(table)
  }
}
const hideLineButton = () => {
  // Only hide if we aren't hovering the button itself (handled by css bridge mostly, but logic helps)
  // lineButtonVisible.value = false 
  // actually relying on mouseleave of container might be flaky if we have a bridge. 
  // Let's keep it simple: if mouse leaves editor area.
  // For Single view, we rely on elementFromPoint in handleMouseMove, so if we leave, it naturally clears.
}

const openLineToolbar = () => {
  if (viewMode.value === 'single') {
    if (!previewAreaRef.value) return
    toolbarTop.value = lineButtonTop.value - 4
    toolbarLeft.value = lineButtonLeft.value + 16
    toolbarMode.value = 'line'
    toolbarVisible.value = true
    return
  }
  const el = textareaRef.value
  const area = editorAreaRef.value
  if (!el || !area) return
  const rect = el.getBoundingClientRect()
  const areaRect = area.getBoundingClientRect()
  // The line toolbar is an absolutely-positioned child of the scroll container,
  // so it scrolls WITH the content: position it in content space. lineButtonTop
  // is already the line's content offset (updateLineButton no longer subtracts a
  // textarea scrollTop). Horizontally nothing scrolls, so the left term stands.
  toolbarTop.value = lineButtonTop.value + lineHeight.value * 0.6
  toolbarLeft.value = rect.left - areaRect.left + paddingLeft.value
  toolbarMode.value = 'line'
  toolbarVisible.value = true
  el.focus()
  el.selectionStart = lineStartIndex.value
  el.selectionEnd = lineStartIndex.value
}

const applySplitAction = async (type) => {
  if (toolbarMode.value === 'line') {
    const index = lineStartIndex.value
    if (type === 'bold') return insertAround('**', '**', '加粗文本')
    if (type === 'italic') return insertAround('*', '*', '强调文本')
    if (type === 'strike') return insertAround('~~', '~~', '删除文本')
    if (type === 'code') return insertAround('`', '`', '行内代码')
    if (type === 'heading') return insertLinePrefixAt('# ', index)
    if (type === 'quote') return insertLinePrefixAt('> ', index)
    if (type === 'ul') return insertLinePrefixAt('- ', index)
    if (type === 'ol') return insertLinePrefixAt('1. ', index)
    if (type === 'task') return insertLinePrefixAt('- [ ] ', index)
    if (type === 'codeblock') return insertBlockAt(codeBlockTemplate, codeSample, index)
    if (type === 'table') return insertBlockAt(tableTemplate, tableTemplate, index)
    if (type === 'link') return insertAround('[', '](https://)', '链接文本')
    if (type === 'image') return insertAround('![', '](https://)', '图片描述')
    if (type === 'hr') return insertBlockAt(hrTemplate, hrTemplate, index)
  }
  if (type === 'bold') return insertAround('**', '**', '加粗文本')
  if (type === 'italic') return insertAround('*', '*', '强调文本')
  if (type === 'strike') return insertAround('~~', '~~', '删除文本')
  if (type === 'code') return insertAround('`', '`', '行内代码')
  if (type === 'heading') return insertLinePrefix('# ', '标题')
  if (type === 'quote') return insertLinePrefix('> ', '引用')
  if (type === 'ul') return insertLinePrefix('- ', '列表项')
  if (type === 'ol') return insertLinePrefix('1. ', '列表项')
  if (type === 'task') return insertLinePrefix('- [ ] ', '任务')
  if (type === 'codeblock') return insertBlock(codeBlockTemplate, codeSample)
  if (type === 'table') return insertBlock(tableTemplate, '表格')
  if (type === 'link') return insertAround('[', '](https://)', '链接文本')
  if (type === 'image') return insertAround('![', '](https://)', '图片描述')
  if (type === 'hr') return insertBlock(hrTemplate, '')
}

// ------ SINGLE-MODE (WYSIWYG) ACTIONS ------
// All actions operate either on the active block's contenteditable DOM
// (marking it dirty so the blur commit persists the change), or directly on
// the markdown source at the selected block's line range.

// Inline formatting inside the ACTIVE contenteditable block
// ------ SINGLE-MODE (SOURCE) ACTIONS ------
// Inline formatting wraps the active editor's selection in markdown/HTML
// syntax — deterministic string ops, no execCommand, no DOM surgery.

const applyEditorInlineAction = (type) => {
  if (type === 'bold') return insertAroundEditor('**', '**', '加粗文本')
  if (type === 'italic') return insertAroundEditor('*', '*', '强调文本')
  if (type === 'strike') return insertAroundEditor('~~', '~~', '删除文本')
  if (type === 'underline') return insertAroundEditor('++', '++', '下划线文本')
  if (type === 'code') return insertAroundEditor('`', '`', '行内代码')
  if (type === 'link') return insertAroundEditor('[', '](https://)', '链接文本')
  return false
}

// ---- Text color / background highlight (Feishu-style palette) ----
const textColorPalette = ['#e53935', '#f57c00', '#c99400', '#43a047', '#1e88e5', '#8e24aa', '#757575']
const bgColorPalette = ['#fde0dd', '#ffe9c7', '#fff8b8', '#dcf5d9', '#dbe7ff', '#eedbff', '#ececec']

// Remove <span style=...> wrappers overlapping the editor selection whose
// style contains the given property (cleans both halves of the pair)
const clearEditorColor = (prop) => {
  const el = getEditorEl()
  if (!el) return
  const s = el.selectionStart
  const eIdx = el.selectionEnd
  const val = el.value
  const propRe = prop === 'color' ? /color\s*:/i : /background-color\s*:/i

  // Expand to the enclosing span pair if the selection sits inside one
  let from = s
  let to = eIdx
  const openIdx = val.lastIndexOf('<span', s)
  if (openIdx !== -1) {
    const openEnd = val.indexOf('>', openIdx)
    const closeIdx = val.indexOf('</span>', openEnd)
    if (openEnd !== -1 && closeIdx !== -1 && openEnd < s && closeIdx >= eIdx - 1) {
      const openTag = val.slice(openIdx, openEnd + 1)
      if (propRe.test(openTag)) {
        from = openIdx
        to = closeIdx + '</span>'.length
      }
    }
  }

  let segment = val.slice(from, to)
  segment = segment.replace(/<span[^>]*>/gi, (tag) => (propRe.test(tag) ? '' : tag))
  // Drop orphaned closers only if we removed an opener
  if (segment.length !== (to - from)) {
    segment = segment.replace(/<\/span>/gi, '')
  }
  editingText.value = val.slice(0, from) + segment + val.slice(to)
  activeBlockDirty.value = true
  nextTick(() => {
    el.focus()
    el.setSelectionRange(from, from + segment.length)
    autoResizeEditor()
  })
}

// color === null clears back to the default
const applyTextColor = (color) => {
  if (color === null) return clearEditorColor('color')
  insertAroundEditor(`<span style="color:${color};">`, '</span>', '彩色文本')
}

const applyBgColor = (color) => {
  if (color === null) return clearEditorColor('backgroundColor')
  insertAroundEditor(`<span style="background-color:${color};">`, '</span>', '高亮文本')
}

// Block-type transforms are always applied at the markdown level
const blockTransformTypes = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'heading', 'ul', 'ol', 'task', 'quote', 'codeblock']
const applyBlockTransformAction = (type) => {
  let targetElId = null
  if (activeBlockId.value) {
    targetElId = `block-content-${activeBlockId.value}`
    const prev = parsedBlocks.value.find(b => b.id === activeBlockId.value)
    if (prev) commitBlockEdit(prev)
  } else {
    const range = getPreviewRange()
    let el = range ? getBlockElFromNode(range.startContainer) : null
    if (!el && selectedBlock.value) el = getBlockElFromNode(selectedBlock.value)
    targetElId = el ? el.id : null
  }
  if (!targetElId) return
  // Re-query after the potential commit re-render; positional ids are stable
  // when the committed block keeps its line count
  nextTick(() => {
    const freshEl = document.getElementById(targetElId)
    if (freshEl) transformBlockMarkdown(freshEl, type === 'heading' ? 'h1' : type)
  })
}

// Markdown-level line-prefix transform for a NON-active selected block
// (used by the plus-button line menu)
const transformBlockMarkdown = (blockContainerOrEl, type) => {
  const blockEl = getBlockElFromNode(blockContainerOrEl) ||
    (blockContainerOrEl && blockContainerOrEl.id && blockContainerOrEl.id.startsWith('block-content-') ? blockContainerOrEl : null)
  if (!blockEl) return false
  const range = getBlockLineRange(blockEl)
  if (!range) return false

  const lines = content.value.split('\n')
  const blockLines = lines.slice(range.start, range.end)
  // Drop trailing blank lines from the working set (kept via preserveTrailingBlanks)
  while (blockLines.length > 1 && blockLines[blockLines.length - 1].trim() === '') blockLines.pop()

  const stripPrefix = (l) => l.replace(/^(#{1,6}\s+|>\s+|- \[[ x]\]\s+|[-*+]\s+|\d+\.\s+)/, '')
  const first = blockLines[0] || ''
  let newLines

  const headingMap = { h1: '# ', h2: '## ', h3: '### ', h4: '#### ', h5: '##### ', h6: '###### ', heading: '# ' }
  if (type in headingMap) {
    const prefix = headingMap[type]
    const already = first.startsWith(prefix.trim() + ' ')
    newLines = [already ? stripPrefix(first) : prefix + stripPrefix(first), ...blockLines.slice(1)]
  } else if (type === 'p') {
    newLines = blockLines.map(stripPrefix)
  } else if (type === 'quote') {
    const already = blockLines.every((l) => l.startsWith('> '))
    newLines = already ? blockLines.map((l) => l.replace(/^>\s?/, '')) : blockLines.map((l) => '> ' + l)
  } else if (type === 'ul') {
    newLines = blockLines.map((l) => (l.trim() === '' ? l : '- ' + stripPrefix(l)))
  } else if (type === 'ol') {
    let n = 0
    newLines = blockLines.map((l) => (l.trim() === '' ? l : `${++n}. ` + stripPrefix(l)))
  } else if (type === 'task') {
    newLines = blockLines.map((l) => (l.trim() === '' ? l : '- [ ] ' + stripPrefix(l)))
  } else if (type === 'codeblock') {
    newLines = ['```', ...blockLines.map(stripPrefix), '```']
  } else {
    return false
  }

  spliceLines(range.start, range.end, newLines.join('\n'))
  return true
}

const applyPreviewAction = (type) => {
  // Insertions work regardless of active state (they commit the active
  // block first and splice at the anchor line)
  if (type === 'image') return insertPreviewImage()
  if (type === 'hr') return insertPreviewHr()

  if (blockTransformTypes.includes(type)) {
    return applyBlockTransformAction(type)
  }

  if (activeBlockId.value && ['bold', 'italic', 'strike', 'underline', 'code', 'link'].includes(type)) {
    return applyEditorInlineAction(type)
  }
}

const applyAction = async (type) => {
  if (type === 'table') {
    const isOpen = !isTableSelectorOpen.value
    isTableSelectorOpen.value = isOpen
    if (isOpen) {
      // Save range when opening
      savedSelection.value = getPreviewRange()
    } else {
      savedSelection.value = null
    }
    return
  }

  if (viewMode.value === 'single') {
    await applyPreviewAction(type)

    // CRITICAL: After action, re-verify selection and position toolbar
    // This fixes the "drift" bug where toolbar goes to 0,0 because selection is lost
    await nextTick()
    showPreviewToolbarAtSelection()
    return
  }
  return applySplitAction(type)
}

const hideToolbar = (event) => {
  const target = event.target
  const isSelectionToolbar = selectionToolbarRef.value && selectionToolbarRef.value.contains(target)
  const isLineToolbar = lineToolbarRef.value && lineToolbarRef.value.contains(target)
  const isTableToolbar = tableToolbarRef.value && tableToolbarRef.value.contains(target)
  const isSplitOverlay = (splitHoverRef.value && splitHoverRef.value.contains(target)) ||
                         (splitBubbleRef.value && splitBubbleRef.value.contains(target))
  const isPlusButton = target.closest('.line-button-bridge')
  const isInsideTable = target.closest('table')

  if (isSelectionToolbar || isLineToolbar || isTableToolbar || isSplitOverlay || isPlusButton) return

  // A press anywhere else dismisses the split overlays (the source bubble re-appears
  // on the next selectionchange if the press itself starts a new selection).
  hideSplitOverlays()
  
  if (!isInsideTable) {
    tableToolbarVisible.value = false
    focusedTable.value = null
    hoveredTable.value = null
    clearTableCellSelection()
  }
  
  if (toolbarVisible.value) {
    toolbarVisible.value = false
    isTableSelectorOpen.value = false
  }
}

// Handle keydown in split-view textarea: skip over ZWS (\u200B) on Backspace/Delete,
// then (opt-in source smart editing) continue list/quote prefixes on Enter,
// unwrap empty list items on Backspace, and surround the selection on wrap chars.
const handleTextareaKeydown = (e) => {
  const el = e.target
  const pos = el.selectionStart
  const end = el.selectionEnd
  const val = el.value
  const result = applyZeroWidthDeletion(val, pos, end, e.key)
  if (result) {
    e.preventDefault()
    content.value = result.value
    nextTick(() => { el.selectionStart = el.selectionEnd = result.caret })
    return
  }
  if (!sourceSmartEdit.value || e.isComposing || e.keyCode === 229) return
  let edit = null
  if (e.key === 'Enter') {
    edit = computeEnterContinuation(val, pos)
  } else if (e.key === 'Backspace') {
    edit = computeBackspaceUnwrap(val, pos)
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    edit = computeSelectionSurround(val, pos, end, e.key)
  }
  if (!edit) return
  e.preventDefault()
  content.value = edit.value
  nextTick(() => {
    el.selectionStart = edit.selectionStart
    el.selectionEnd = edit.selectionEnd
  })
}

const handlePreviewMouseDown = (event) => {
  if (viewMode.value !== 'single') return
  const imgTarget = event?.target?.closest?.('img')
  if (imgTarget && previewRef.value && previewRef.value.contains(imgTarget)) {
    const block = resolveImageBlockFromImage(imgTarget)
    if (selectImageBlock(imgTarget, block)) {
      event.preventDefault()
      return
    }
  }
  const table = getClosestTable(event.target)
  if (table) {
    focusedTable.value = table
    updateTableToolbarPosition(table)
    tableToolbarVisible.value = true
    return
  }
  focusedTable.value = null
  if (!hoveredTable.value) {
    tableToolbarVisible.value = false
  }
}

const selectImageBlock = (img, block) => {
  if (!img || !previewRef.value) return false

  let resolvedBlock = block
  const betterBlock = resolveImageBlockFromImage(img)
  if (betterBlock && isImageBlock(betterBlock)) {
      resolvedBlock = betterBlock
  } else if (!resolvedBlock) {
      resolvedBlock = img
  }

  if (!previewRef.value.contains(resolvedBlock)) return false

  selectedImage.value = img
  selectedBlock.value = resolvedBlock
  setSelectionUiFromBlock(resolvedBlock)
  selectedUiKind.value = 'image'
  updateLineButtonToBlock(resolvedBlock)
  updateImageScale()
  const area = previewAreaRef.value
  if (area) {
    const areaRect = area.getBoundingClientRect()
    const blockRect = resolvedBlock.getBoundingClientRect()
    toolbarTop.value = Math.max(blockRect.top - areaRect.top - 16, 64)
    toolbarLeft.value = blockRect.left - areaRect.left + (blockRect.width / 2)
    toolbarMode.value = 'selection'
    toolbarVisible.value = true
    updateImageScale()
    updateImageAlign()
  }

  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNode(img)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

const handlePreviewSelection = (event) => {
  if (viewMode.value !== 'single') return

  const imgTarget = event?.target?.closest?.('img')
  if (imgTarget) {
    const block = resolveImageBlockFromImage(imgTarget)
    if (selectImageBlock(imgTarget, block)) return
  }

  const selection = window.getSelection()
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0)
    const resolved = resolveImageFromRange(range)
    if (resolved) {
      if (selectImageBlock(resolved.img, resolved.block)) return
    }

    // Table awareness: show the table toolbar when the caret is inside a
    // table, but never hijack the user's selection (cell editing must work).
    // Hiding is intentionally NOT done here — selection changes fire for many
    // unrelated reasons (commits, re-renders); the pointer/mousedown handlers
    // own the hiding.
    const startTable = getClosestTable(range.startContainer)
    if (startTable) {
      focusedTable.value = startTable
      updateTableToolbarPosition(startTable)
      tableToolbarVisible.value = true
    } else if (!event || !event.target || !event.target.closest?.('table')) {
      focusedTable.value = null
    }
  }

  checkToolbarState() // ALWAYS update state first
  showPreviewToolbarAtSelection()
  updateSelectedBlock()
  lastSelectionSnapshot.value = getSelectionSnapshot()
}


// ========== Markdown Input Rules & Paste ==========


// ---- Line-menu block context (markdown-level, driven by parsed data) ----
const selectedBlockData = computed(() => (
  selectedUiId.value ? parsedBlocks.value.find(b => b.id === selectedUiId.value) : null
))

const blockLinePrefixRe = /^(\s*(?:#{1,6}\s+|>\s?|(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?)?)([\s\S]*)$/

const headingLevelOf = (blockData) => {
  const m = blockData && blockData.raw ? blockData.raw.match(/^(#{1,6})\s/) : null
  return m ? m[1].length : 0
}

// 'full' | 'mixed' | 'none' for whole-line bold, judged from the raw source
const getBlockBoldState = (blockData) => {
  if (!blockData) return 'none'
  const firstLine = (blockData.raw || '').split('\n')[0]
  const body = firstLine.replace(blockLinePrefixRe, '$2').trim()
  if (/^\*\*[\s\S]+\*\*$/.test(body)) return 'full'
  if (body.includes('**')) return 'mixed'
  return 'none'
}

const toggleBlockBold = (blockData) => {
  if (!blockData) return
  const lines = content.value.split('\n')
  const first = lines[blockData.startLine] ?? ''
  const m = first.match(blockLinePrefixRe)
  const prefix = m[1] || ''
  const body = (m[2] || '').trim()
  if (!body) return
  const isBold = /^\*\*[\s\S]+\*\*$/.test(body)
  lines[blockData.startLine] = prefix + (isBold ? body.slice(2, -2) : `**${body}**`)
  content.value = lines.join('\n')
  toolbarVisible.value = false
}

// Strip all inline formatting: the rendered plain text IS the unformatted source
const clearBlockFormatting = (blockData) => {
  if (!blockData) return
  const tmp = document.createElement('div')
  tmp.innerHTML = renderBlockHtml(blockData.raw)
  const plain = (tmp.textContent || '').replace(/\u200B/g, '').replace(/\n+/g, ' ').trim()
  spliceLines(blockData.startLine, blockData.endLine, plain)
  toolbarVisible.value = false
}
const stripAlignMarkers = (text) => {
  return text.replace(/:::\s*align:\w+\s*:::/g, '').replace(/[\u200B\u00A0]/g, '').trim()
}

const escapeHtmlAttr = (value) => {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

const resolveImageBlockFromImage = (img) => {
  if (!img) return null
  let block = img.closest('[data-image-block]') || img.closest('p') || img.closest('div') || findClosestBlock(img) || img
  if (block && block.nodeName === 'DIV') {
    const directImg = block.querySelector('img')
    if (directImg === img) {
      return block
    }
  }
  return block
}

const isImageOnlyBlock = (block, img) => {
  if (!block) return false
  if (block.nodeName === 'IMG') return true
  const images = block.querySelectorAll('img')
  if (images.length === 0) return false
  if (img && !Array.from(images).includes(img)) return false
  const textContent = stripAlignMarkers(block.textContent || '')
  if (textContent.length > 0) return false
  return true
}

const resolveImageBlockFromBlock = (block) => {
  return block || null
}

const getImageIdFromSrc = (src) => {
  if (!src) return null
  if (src.startsWith('knote-img:')) return src.replace('knote-img:', '')
  for (const [id, url] of Object.entries(imageStore)) {
    if (url === src) return id
  }
  return null
}

const ensureImageId = (src) => {
  const existing = getImageIdFromSrc(src)
  if (existing) return existing
  if (src && src.startsWith('data:')) {
    const id = generateImageId()
    imageStore[id] = src
    return id
  }
  return null
}

// Markdown reference for an image src: data URLs go through the image store,
// remote URLs stay as-is
const imageSrcToRef = (src) => {
  const id = ensureImageId(src)
  return id ? `knote-img:${id}` : src
}

// Canonical single-line markdown for an image block. Kept on ONE line so the
// block's line count never changes and positional block ids stay stable.
const buildImageBlockMarkdown = (img, align) => {
  const src = img.getAttribute('src') || img.src || ''
  const ref = imageSrcToRef(src)
  const alt = (img.getAttribute('alt') || 'image').replace(/[\[\]\n]/g, ' ')
  const width = img.style?.width || ''
  const effAlign = align && align !== 'left' ? align : ''
  if (!width && !effAlign) {
    return `![${alt}](${ref})`
  }
  const style = width ? ` style="width:${escapeHtmlAttr(width)};"` : ''
  const pStyle = effAlign ? ` style="text-align: ${effAlign}"` : ''
  return `<p${pStyle}><img src="${escapeHtmlAttr(ref)}" alt="${escapeHtmlAttr(alt)}"${style}></p>`
}

// Persist the current DOM state (size/align/src) of an image into the source,
// then re-select the image in the freshly rendered DOM.
const commitImageState = (img, align = null) => {
  if (!img) return
  const blockEl = getBlockElFromNode(img)
  const range = getBlockLineRange(blockEl)
  if (!range) return
  const effectiveAlign = align !== null ? align : (resolveImageBlockFromImage(img)?.style?.textAlign || '')
  const newMd = buildImageBlockMarkdown(img, effectiveAlign)
  const blockElId = blockEl.id
  spliceLines(range.start, range.end, newMd)
  nextTick(() => {
    const freshBlock = document.getElementById(blockElId)
    const freshImg = freshBlock ? freshBlock.querySelector('img') : null
    if (freshImg) {
      selectImageBlock(freshImg, resolveImageBlockFromImage(freshImg))
    }
  })
}

// Insert an image (data URL or remote URL) as a new block after the anchor
const insertImageAtAnchor = (src, alt = 'Image') => {
  if (activeBlockId.value) {
    const prev = parsedBlocks.value.find(b => b.id === activeBlockId.value)
    if (prev) commitBlockEdit(prev)
  }
  const ref = imageSrcToRef(src)
  const cleanAlt = (alt || 'Image').replace(/[\[\]\n]/g, ' ')
  const anchor = getInsertionAnchorLine()
  insertMarkdownAfterLine(anchor, `![${cleanAlt}](${ref})`)
  toolbarVisible.value = false
  // Select the new image once rendered
  nextTick(() => {
    const root = previewRef.value
    if (!root) return
    const target = ref.startsWith('knote-img:') ? imageStore[ref.replace('knote-img:', '')] : ref
    const imgs = Array.from(root.querySelectorAll('img'))
    const domImg = imgs.find((n) => n.getAttribute('src') === target)
    if (domImg) selectImageBlock(domImg, resolveImageBlockFromImage(domImg))
  })
}

// Hidden file input ref
const imageFileInput = ref(null)

const handleImageFileSelected = (event) => {
  const file = event.target.files?.[0]
  if (!file || !file.type.startsWith('image/')) return

  const reader = new FileReader()
  reader.onload = (e) => {
    insertImageAtAnchor(e.target.result, file.name)
  }
  reader.readAsDataURL(file)
  // Reset input so same file can be selected again
  event.target.value = ''
}

const insertImageBelow = () => {
  // Open file picker — use ref if available, otherwise create temporary input
  if (imageFileInput.value) {
    imageFileInput.value.click()
  } else {
    const tempInput = document.createElement('input')
    tempInput.type = 'file'
    tempInput.accept = 'image/*'
    tempInput.style.display = 'none'
    tempInput.onchange = (e) => {
      handleImageFileSelected(e)
      tempInput.remove()
    }
    document.body.appendChild(tempInput)
    tempInput.click()
  }
}

const insertImageByUrl = async () => {
  const url = await promptInput(t('insert_image_url_prompt'), 'https://')
  if (url && url.trim() && url.trim() !== 'https://') {
    insertImageAtAnchor(url.trim(), 'Image')
  }
}

// ---- Local file links (attachments, email-attachment style) ----
// A relative markdown link ([name](assets/report.pdf)) resolves against the
// current document directory; file:// URLs and absolute drive paths resolve
// as-is. Clicking opens the file with the OS default application via main's
// knote:open-path. Never rendered or previewed in-app.
const resolveLocalLinkPath = (href) => {
  if (!href) return null
  const bare = bareMarkdownHostFilename(href)
  let raw = (bare || String(href)).split('#', 1)[0]
  if (!raw) return null
  if (/^file:/i.test(raw)) raw = raw.replace(/^file:\/\/+/i, '')
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/')) return decodeLocalPath(raw)
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) return null
  const dir = currentDocDirPath()
  if (!dir) return null
  const decoded = decodeLocalPath(raw)
  const sep = dir.includes('\\') ? '\\' : '/'
  const dirParts = dir.split(/[\\/]/)
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (dirParts.length > 1) dirParts.pop(); continue }
    dirParts.push(part)
  }
  return dirParts.join(sep)
}

const openLocalFileLink = async (href) => {
  const abs = resolveLocalLinkPath(href)
  if (!abs || !window.knoteDesktop || !window.knoteDesktop.openPath) return
  if (/\.(?:md|markdown)$/i.test(abs) && folderHandle.value) {
    const root = folderHandle.value._deskPath
    if (root) {
      const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '')
      const normalizedTarget = abs.replace(/\\/g, '/')
      if (normalizedTarget.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
        const node = treeNodeByPath(normalizedTarget.slice(normalizedRoot.length + 1))
        if (node?.ftype === 'md') {
          await openTreeFileInNewTab(node)
          return
        }
      }
    }
  }
  try {
    const r = await window.knoteDesktop.openPath(abs)
    if (r && r.ok === false) {
      globalThis.alert(`${t('open_local_file_failed')}：${r.error || abs}`)
    }
  } catch (err) {
    console.error('Open local file link error:', err)
    globalThis.alert(`${t('open_local_file_failed')}：${String(err.message || err)}`)
  }
}

// Local Markdown links open in a Knote tab on any click, in any view. This
// capture-phase delegate runs before editor/preview handlers so a plain click
// never reaches the browser's default navigation (which used to hand .md
// links to the system browser via target=_blank new-window handling).
const onDocumentClickForMarkdownLinks = (event) => {
  const raw = event.target
  const target = raw && raw.nodeType === Node.ELEMENT_NODE ? raw : (raw && raw.parentElement)
  const anchor = target && target.closest && target.closest('a[href]')
  if (!anchor) return
  const href = anchor.getAttribute('href') || ''
  const localMarkdownLink = isLocalMarkdownHref(href)
  if (!localMarkdownLink) return
  event.preventDefault()
  event.stopPropagation()
  void openLocalFileLink(href)
}

// RichEditor (TipTap, single mode) reports clicks on a local-file link through
// this window event so the app can resolve + open it.
const handleOpenLocalLinkEvent = (event) => {
  const href = event && event.detail && event.detail.href
  if (href) void openLocalFileLink(href)
}

// Split-preview clicks: the interaction is unified with the rich editor —
// ALL links need Ctrl/Cmd + left-click. Web links are then forwarded to the
// OS browser by main's window-open handler; relative local-file links, file://
// URLs and absolute drive paths are intercepted so the window never navigates
// away from the app. A plain click on the preview never follows a link.
const onPreviewLinkClick = (event) => {
  const raw = event.target
  const target = raw && raw.nodeType === Node.ELEMENT_NODE ? raw : (raw && raw.parentElement)
  const anchor = target && target.closest && target.closest('a[href]')
  if (!anchor) return
  const href = anchor.getAttribute('href') || ''
  // Local Markdown links open in a Knote tab on ANY click; web and other
  // local-file links keep the Ctrl/Cmd + click convention.
  const localMarkdownLink = isLocalMarkdownHref(href)
  if (!event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    event.stopPropagation()
    if (localMarkdownLink) void openLocalFileLink(href)
    return
  }
  if (href.startsWith('#')) return
  if (/^https?:/i.test(href)) return
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[a-zA-Z]:[\\/]/.test(href)) return // mailto/tel/... — leave to the browser
  event.preventDefault()
  event.stopPropagation()
  void openLocalFileLink(href)
}

// ---- Insert-attachment floating window (folder + file, shown together) ----
// Mirrors the rename dialog style. The destination folder list comes from
// main (knote:attachment-dirs) and is RESTRICTED to the current document's
// file tree — every entry is re-authorized against the writable roots, so the
// picker can never leave the document's folders. The last chosen folder is
// persisted to disk and becomes the default on the next insert.
const attachState = ref(null) // { dir, folders, folder, source, sourceName } — source is an opaque main-process token
let attachResolve = null // pending Promise resolve: ({ relative, name } | null)

const openAttachmentInsertDialog = (dir) => new Promise((resolve) => {
  if (attachState.value) {
    resolve(null)
    return
  }
  if (!dir || !window.knoteDesktop || !window.knoteDesktop.attachmentDirs || !window.knoteDesktop.importAttachment) {
    globalThis.alert(t('insert_local_file_no_dir'))
    resolve(null)
    return
  }
  attachResolve = resolve
  const open = async () => {
    let folders = []
    try {
      const r = await window.knoteDesktop.attachmentDirs(dir)
      folders = (r && r.dirs) || []
    } catch (err) {
      console.error('Attachment dirs error:', err)
      globalThis.alert(t('attach_load_error'))
      finishAttachDialog(null)
      return
    }
    if (!folders.length) folders = [{ abs: dir.replace(/[\\/]$/, '') + '/assets', rel: 'assets' }]
    let defaultFolder = folders[0] && folders[0].abs
    try {
      const last = await window.knoteDesktop.attachmentTargetGet(dir)
      if (last && last.target) {
        const match = folders.find((f) => f.abs === last.target)
        if (match) defaultFolder = match.abs
      }
    } catch { /* keep the first folder */ }
    attachState.value = { dir, folders, folder: defaultFolder, source: '', sourceName: '' }
    // focus the folder select so Esc closes the dialog immediately (the
    // overlay only receives keydown events while focus is inside it)
    nextTick(() => {
      const el = document.querySelector('[data-testid="attach-folder-select"]')
      if (el && typeof el.focus === 'function') el.focus()
    })
  }
  void open()
})

const finishAttachDialog = (result) => {
  attachState.value = null
  const resolve = attachResolve
  attachResolve = null
  if (resolve) resolve(result)
}

const cancelAttachInsert = () => finishAttachDialog(null)

const pickImportSource = async () => {
  if (!attachState.value || !window.knoteDesktop || !window.knoteDesktop.pickImportFile) return
  let r
  try {
    r = await window.knoteDesktop.pickImportFile(attachState.value.dir, attachState.value.folder)
  } catch (err) {
    console.error('Pick import file error:', err)
    return
  }
  if (!r || r.canceled || !r.source) return
  attachState.value.source = r.source
  attachState.value.sourceName = r.name || ''
}

const confirmAttachInsert = async () => {
  const s = attachState.value
  if (!s || !s.source) return
  let r
  try {
    r = await window.knoteDesktop.importAttachment(s.dir, s.folder, s.source)
  } catch (err) {
    console.error('Import attachment error:', err)
    globalThis.alert(`${t('insert_local_file')} 失败：${String(err.message || err)}`)
    return
  }
  if (!r || r.canceled) {
    finishAttachDialog(null)
    return
  }
  finishAttachDialog({ relative: r.relative, name: r.name })
}

// Re-fetch the restricted folder tree and keep the selection on the same
// folder (by path), falling back to the previously selected one.
const refreshAttachFolders = async (selectAbs) => {
  const s = attachState.value
  if (!s) return
  let folders = []
  try {
    const r = await window.knoteDesktop.attachmentDirs(s.dir)
    folders = (r && r.dirs) || []
  } catch (err) {
    console.error('Attachment dirs error:', err)
    return
  }
  if (!folders.length) folders = [{ abs: s.dir.replace(/[\\/]$/, '') + '/assets', rel: 'assets' }]
  s.folders = folders
  const wanted = selectAbs || s.folder
  s.folder = folders.some((f) => f.abs === wanted) ? wanted : (folders[0] && folders[0].abs)
}

const attachNewFolder = async () => {
  const s = attachState.value
  if (!s || !window.knoteDesktop || !window.knoteDesktop.attachmentMkdir) return
  const name = await promptInput(t('attach_new_folder_prompt'), lang.value === 'zh' ? '新建文件夹' : 'New Folder')
  if (!name) return
  try {
    const r = await window.knoteDesktop.attachmentMkdir(s.dir, s.folder, name)
    if (!r || !r.ok) {
      globalThis.alert(`${t('attach_folder_op_failed')}：${r && r.error ? r.error : ''}`)
      return
    }
    await refreshAttachFolders(r.folder.abs)
  } catch (err) {
    console.error('Attachment mkdir error:', err)
    globalThis.alert(`${t('attach_folder_op_failed')}：${String(err.message || err)}`)
  }
}

const attachRenameFolder = async () => {
  const s = attachState.value
  if (!s || !window.knoteDesktop || !window.knoteDesktop.attachmentRenameDir) return
  if (!s.folder || s.folder === s.dir.replace(/[\\/]$/, '')) {
    globalThis.alert(t('attach_folder_op_failed'))
    return
  }
  const current = s.folders.find((f) => f.abs === s.folder)
  const name = await promptInput(t('attach_rename_folder_prompt'), current ? current.rel.split('/').pop() : '')
  if (!name) return
  try {
    const r = await window.knoteDesktop.attachmentRenameDir(s.dir, s.folder, name)
    if (!r || !r.ok) {
      globalThis.alert(`${t('attach_folder_op_failed')}：${r && r.error ? r.error : ''}`)
      return
    }
    await refreshAttachFolders(r.folder.abs)
  } catch (err) {
    console.error('Attachment rename error:', err)
    globalThis.alert(`${t('attach_folder_op_failed')}：${String(err.message || err)}`)
  }
}

// ---- Shared hover annotation ----
// One app-rendered annotation covers dynamic editor/preview links and controls
// marked with data-hover-annotation. The existing white tooltip class remains
// on the renderer; data-placement exposes the resolved, viewport-flipped side.
const hoverAnnotation = ref(null) // { key, text, x, y, placement, source }
const hoverAnnotationRef = ref(null)
let hoverAnnotationTarget = null
let hoverAnnotationHideTimer = null
let hoverAnnotationSequence = 0

const hoverAnnotationDescriptor = (node) => {
  const el = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
  if (!el?.closest) return null
  const annotated = el.closest('[data-hover-annotation]')
  const annotatedText = annotated?.getAttribute('data-hover-annotation')
  if (annotated && annotatedText) {
    return {
      target: annotated,
      text: annotatedText,
      preferred: annotated.getAttribute('data-hover-placement') || 'top',
      source: annotated.getAttribute('data-hover-source') || 'control'
    }
  }
  const dataTooltip = el.closest('[data-tooltip], .tooltip[data-tip]')
  const dataTooltipText = dataTooltip?.getAttribute('data-tooltip') || dataTooltip?.getAttribute('data-tip')
  if (dataTooltip && dataTooltipText) {
    return {
      target: dataTooltip,
      text: dataTooltipText,
      preferred: dataTooltip.closest('.knote-titlebar') ? 'bottom' : 'top',
      source: 'control'
    }
  }
  const titled = el.closest('[title], [data-hover-native-title]')
  const nativeTitle = titled?.getAttribute('title') || titled?.getAttribute('data-hover-native-title')
  if (titled && nativeTitle) {
    // Remove the browser tooltip once discovered so every hover annotation
    // uses the same deterministic app-rendered motion and placement.
    if (titled.hasAttribute('title')) {
      titled.setAttribute('data-hover-native-title', nativeTitle)
      titled.removeAttribute('title')
      if (!titled.getAttribute('aria-label') && titled.matches('button, [role="button"], input, select, textarea')) {
        titled.setAttribute('aria-label', nativeTitle)
      }
    }
    return {
      target: titled,
      text: nativeTitle,
      preferred: titled.closest('.knote-titlebar') ? 'bottom' : 'top',
      source: 'native-title'
    }
  }
  const anchor = el.closest('a[href]')
  if (!anchor || anchor.getAttribute('href')?.startsWith('#')) return null
  if (!anchor.closest('.ProseMirror') && !anchor.closest('.knote-md-render')) return null
  return { target: anchor, text: t('link_tooltip_open'), preferred: 'top', source: 'link' }
}

const hoverAnnotationPosition = (rect, preferred, size) => {
  const gap = 10
  const margin = 8
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight
  const boundedSize = {
    width: Math.min(Math.max(0, Number(size?.width) || 0), Math.max(0, viewportWidth - margin * 2)),
    height: Math.min(Math.max(0, Number(size?.height) || 0), Math.max(0, viewportHeight - margin * 2))
  }
  const clampCenter = (value, extent, viewport) => {
    const lower = margin + extent / 2
    const upper = viewport - margin - extent / 2
    if (upper < lower) return viewport / 2
    return Math.min(Math.max(value, lower), upper)
  }
  const leftSpace = rect.left - margin
  const rightSpace = viewportWidth - rect.right - margin
  const topSpace = rect.top - margin
  const bottomSpace = viewportHeight - rect.bottom - margin
  let placement = preferred
  if (preferred === 'side') placement = rightSpace >= leftSpace ? 'right' : 'left'
  else if (preferred === 'top' && topSpace < boundedSize.height + gap && bottomSpace > topSpace) placement = 'bottom'
  else if (preferred === 'bottom' && bottomSpace < boundedSize.height + gap && topSpace > bottomSpace) placement = 'top'
  else if (preferred === 'right' && rightSpace < boundedSize.width + gap && leftSpace > rightSpace) placement = 'left'
  else if (preferred === 'left' && leftSpace < boundedSize.width + gap && rightSpace > leftSpace) placement = 'right'

  // A side annotation wider than both side gaps cannot fit by flipping. Move
  // it above/below, where its clamped center keeps the full box in viewport.
  if ((placement === 'left' || placement === 'right') &&
      leftSpace < boundedSize.width + gap && rightSpace < boundedSize.width + gap) {
    placement = bottomSpace >= topSpace ? 'bottom' : 'top'
  }

  if (placement === 'top' || placement === 'bottom') {
    return {
      placement,
      x: clampCenter(rect.left + rect.width / 2, boundedSize.width, viewportWidth),
      y: placement === 'top' ? rect.top : rect.bottom
    }
  }
  return {
    placement,
    x: placement === 'left' ? rect.left : rect.right,
    y: clampCenter(rect.top + rect.height / 2, boundedSize.height, viewportHeight)
  }
}

const showHoverAnnotation = (target, text, preferred = 'top', source = 'control') => {
  if (!target?.getBoundingClientRect || !text) return null
  clearTimeout(hoverAnnotationHideTimer)
  hoverAnnotationTarget = target
  const key = ++hoverAnnotationSequence
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth
  const maxWidth = Math.max(0, Math.min(360, viewportWidth - 16))
  const estimatedWidth = Math.min(maxWidth, Math.max(96, Array.from(String(text)).reduce((width, char) => width + (char.charCodeAt(0) > 255 ? 12 : 7), 24)))
  const position = hoverAnnotationPosition(target.getBoundingClientRect(), preferred, { width: estimatedWidth, height: 34 })
  hoverAnnotation.value = { key, text, source, ...position }
  nextTick(() => {
    if (hoverAnnotation.value?.key !== key || hoverAnnotationTarget !== target || !target.isConnected) return
    const tooltip = hoverAnnotationRef.value
    if (!tooltip) return
    const measured = hoverAnnotationPosition(target.getBoundingClientRect(), preferred, {
      width: tooltip.offsetWidth || estimatedWidth,
      height: tooltip.offsetHeight || 34
    })
    hoverAnnotation.value = { ...hoverAnnotation.value, ...measured }
  })
  return key
}

const hideHoverAnnotation = (key = null) => {
  if (key != null && hoverAnnotation.value?.key !== key) return
  clearTimeout(hoverAnnotationHideTimer)
  hoverAnnotationSequence += 1
  hoverAnnotationTarget = null
  hoverAnnotation.value = null
}

const onHoverAnnotationOver = (event) => {
  if (agentBallDrag?.moved) return
  const descriptor = hoverAnnotationDescriptor(event.target)
  if (!descriptor) return
  clearTimeout(hoverAnnotationHideTimer)
  if (descriptor.target === hoverAnnotationTarget && hoverAnnotation.value) return
  showHoverAnnotation(descriptor.target, descriptor.text, descriptor.preferred, descriptor.source)
}

const onHoverAnnotationOut = (event) => {
  const descriptor = hoverAnnotationDescriptor(event.target)
  if (!descriptor || descriptor.target !== hoverAnnotationTarget) return
  const relatedDescriptor = hoverAnnotationDescriptor(event.relatedTarget)
  if (relatedDescriptor?.target === descriptor.target) return
  const leavingTarget = descriptor.target
  hoverAnnotationHideTimer = setTimeout(() => {
    if (hoverAnnotationTarget === leavingTarget) hideHoverAnnotation()
  }, 120)
}

const onHoverAnnotationBlur = () => {
  hideHoverAnnotation()
}

// Clicking an annotated control can remove/replace it (e.g. the session
// popover's new-chat button closes the popover on click). The detached target
// never fires mouseout, so the annotation would hover forever. Match native
// tooltip behavior: any press dismisses the annotation; it reappears on the
// next real hover.
const onHoverAnnotationPointerDown = () => {
  hideHoverAnnotation()
}

// Split-mode toolbar entry: the popup picks the destination folder (restricted
// to the document tree) and the source file, then main copies the source in
// and returns the relative link target for the markdown.
const insertAttachmentBelow = async () => {
  const dir = currentDocDirPath()
  if (!dir || !window.knoteDesktop || !window.knoteDesktop.importAttachment) {
    globalThis.alert(t('insert_local_file_no_dir'))
    return
  }
  const r = await openAttachmentInsertDialog(dir)
  if (!r) return
  // rebuild the link through the shared router so destinations with spaces or
  // parentheses stay valid CommonMark (percent-encoded) and stay relative
  const copyPath = dir.replace(/[\\/]$/, '') + '/' + r.relative.replace(/\\/g, '/')
  insertMarkdownAfterLine(getInsertionAnchorLine(), localFileLinkMarkdown(copyPath, dir))
  toolbarVisible.value = false
}

// Split-mode toolbar entry: pick any local file and reference it in place —
// no copy, just a markdown link (relative when the file lives inside the doc
// directory, absolute file:// URL otherwise).
const insertLinkBelow = async () => {
  if (!window.knoteDesktop || !window.knoteDesktop.pickFileToLink) {
    globalThis.alert(t('insert_local_file_no_dir'))
    return
  }
  let r
  try {
    r = await window.knoteDesktop.pickFileToLink()
  } catch (err) {
    console.error('Pick file to link error:', err)
    globalThis.alert(`${t('insert_link_in_place')} 失败：${String(err.message || err)}`)
    return
  }
  if (!r || r.canceled) return
  insertMarkdownAfterLine(getInsertionAnchorLine(), localFileLinkMarkdown(r.path, currentDocDirPath()))
  toolbarVisible.value = false
}

// --- Image Toolbar Functions ---
const getImageFromBlock = (block) => {
  if (!block) return null
  if (block.nodeName === 'IMG') return block
  return block.querySelector('img')
}

const resolveSelectedImage = () => {
  let img = selectedImage.value
  if (!img || !previewRef.value?.contains(img)) {
    img = getImageFromBlock(selectedBlock.value)
  }
  if (!img) {
    const selection = window.getSelection()
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0)
      const rangeImg = range.cloneContents().querySelector('img')
      if (rangeImg && previewRef.value) {
        const src = rangeImg.getAttribute('src')
        img = Array.from(previewRef.value.querySelectorAll('img')).find((node) => {
          return node.getAttribute('src') === src || node.src === src
        }) || null
      }
    }
  }
  if (!img) return null
  const block = resolveImageBlockFromImage(img) || img
  return { img, block }
}

const resolveImageFromRange = (range) => {
  if (!range || !previewRef.value) return null
  let img = null
  if (range.startContainer && range.startContainer.nodeType === 1) {
    img = range.startContainer.querySelector('img')
  }
  if (!img && range.commonAncestorContainer && range.commonAncestorContainer.nodeType === 1) {
    img = range.commonAncestorContainer.querySelector('img')
  }
  if (!img) {
    const frag = range.cloneContents()
    img = frag?.querySelector?.('img') || null
  }
  if (!img) return null
  const src = img.getAttribute('src')
  const domImg = Array.from(previewRef.value.querySelectorAll('img')).find((node) => {
    return node.getAttribute('src') === src || node.src === src
  })
  if (!domImg) return null
  const block = resolveImageBlockFromImage(domImg) || domImg
  if (!isImageOnlyBlock(block, domImg)) return null
  return { img: domImg, block }
}

// imageScale is the CSS width percentage of the image (10-100).
// 0 / no style = natural size (up to 100%).
const imageScale = ref(100)
const imageAlign = ref('left') // 'left', 'center', 'right'

const updateImageAlign = () => {
  const resolved = resolveSelectedImage()
  if (!resolved) { imageAlign.value = 'left'; return }
  imageAlign.value = resolved.block.style?.textAlign || 'left'
}

const alignImage = (align) => {
  const resolved = resolveSelectedImage()
  if (!resolved) return
  imageAlign.value = align
  commitImageState(resolved.img, align)
}

const updateImageScale = () => {
  const resolved = resolveSelectedImage()
  const img = resolved?.img
  if (!img) { imageScale.value = 100; return }
  const w = img.style.width
  if (w && w.endsWith('%')) {
    imageScale.value = Number.parseInt(w)
  } else {
    imageScale.value = 100
  }
}

// pct: CSS width percentage (10-100). live=true only updates the DOM for
// smooth slider dragging; the markdown commit happens on release (live=false).
const resizeImage = (pct, live = false) => {
  const resolved = resolveSelectedImage()
  const img = resolved?.img
  if (!img) return
  const clamped = Math.max(10, Math.min(100, pct))
  img.style.width = `${clamped}%`
  img.style.height = 'auto'
  imageScale.value = clamped

  // Update selection highlight size after resize
  if (!live) {
    commitImageState(img)
  }
}

// Restore the image to its natural size (no explicit width)
const resetImageSize = () => {
  const resolved = resolveSelectedImage()
  const img = resolved?.img
  if (!img) return
  img.style.width = ''
  img.style.height = ''
  imageScale.value = 100
  commitImageState(img)
}

const replaceImage = () => {
  const resolved = resolveSelectedImage()
  if (!resolved) return
  // Use file picker to select new image
  const tempInput = document.createElement('input')
  tempInput.type = 'file'
  tempInput.accept = 'image/*'
  tempInput.style.display = 'none'
  tempInput.onchange = (e) => {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const img = resolved.img
      const currentSrc = img.getAttribute('src') || img.src || ''
      const currentId = getImageIdFromSrc(currentSrc)
      if (currentId) {
        // Same reference, new payload — re-render picks it up automatically
        imageStore[currentId] = ev.target.result
        img.setAttribute('src', ev.target.result)
        commitImageState(img)
      } else {
        img.setAttribute('src', ev.target.result)
        img.alt = file.name
        commitImageState(img)
      }
    }
    reader.readAsDataURL(file)
    tempInput.remove()
  }
  document.body.appendChild(tempInput)
  tempInput.click()
}

const deleteImageBlock = () => {
  const block = selectedBlock.value
  const img = getImageFromBlock(block) || selectedImage.value
  const blockEl = getBlockElFromNode(img || block)
  if (!blockEl) return

  // Hide UI elements immediately
  toolbarVisible.value = false
  lineButtonVisible.value = false
  clearSelectionUi()
  selectedBlock.value = null
  selectedImage.value = null

  const range = getBlockLineRange(blockEl)
  if (range) {
    spliceLines(range.start, range.end, '', false)
  }
}

// Keep floating overlays anchored while the preview scrolls
const handlePreviewScroll = () => {
  if (viewMode.value !== 'single') return
  showPreviewToolbarAtSelection()
  if (selectedBlock.value && selectedBlock.value.isConnected) {
    updateLineButtonToBlock(selectedBlock.value)
  } else {
    lineButtonVisible.value = false
  }
  if (tableToolbarVisible.value) {
    const table = getActiveTable()
    if (table && table.isConnected) updateTableToolbarPosition(table)
  }
}

// Cleanup of empty inline tags after Backspace/Delete inside the active block
// (prevents the caret from being stuck in "ghost" formatting)

const getLabel = (key) => {
    return t(key)
}

const handleGlobalMouseUp = async () => {
    isToolbarInteracting.value = false
    if (viewMode.value !== 'single') return
    // Wait for selection to fully update/settle
    await nextTick()
    
    // Check if we have a selection in the preview area
    const range = getPreviewRange()
    if (range && !range.collapsed) {
        handlePreviewSelection()
    }
    tableMouseDownFromTable.value = false
}

const headingPlaceholders = computed(() => ({
  '--placeholder-h1': `"${t('enter_h1')}"`,
  '--placeholder-h2': `"${t('enter_h2')}"`,
  '--placeholder-h3': `"${t('enter_h3')}"`,
  '--placeholder-h4': `"${t('enter_h4')}"`,
  '--placeholder-h5': `"${t('enter_h5')}"`,
  '--placeholder-h6': `"${t('enter_h6')}"`
}))

const cancelResidencySweep = () => {
  if (residencySweepHandle == null) return
  if (typeof globalThis.cancelIdleCallback === 'function') globalThis.cancelIdleCallback(residencySweepHandle)
  else clearTimeout(residencySweepHandle)
  residencySweepHandle = null
  residencySweepScheduled = false
}

// Electron holds native quit until this promise settles. Flush the focused
// control, the rich editor / paged source draft and every immutable file queue
// before cold-tab buffers are removed.
const flushRendererStateForQuit = (payload = {}) => {
  // A permission/delete/close dialog may own the renderer mutation lane. Quit
  // cannot wait on user input, so settle both the visible and queued requests.
  cancelAllDialogs()
  const token = String(payload?.token || '')
  if (rendererQuitFlushPromise && rendererQuitFlushToken === token) return rendererQuitFlushPromise
  rendererQuitFlushToken = token
  rendererQuitFlushing = true
  const generation = ++rendererQuitGeneration
  const run = async () => {
    let ok = true
    let recovered = 0
    const protectedRevisions = new Map()
    const assertCurrentAttempt = () => {
      if (generation !== rendererQuitGeneration) throw new Error('renderer quit attempt was superseded')
    }
    try {
      await flushAgentForRendererShutdown()
      assertCurrentAttempt()
      try {
        const focused = document.activeElement
        if (focused && typeof focused.blur === 'function') focused.blur()
      } catch { /* the document may already be detaching */ }
      await nextTick()
      assertCurrentAttempt()
      commitActiveBlockIfAny()
      await nextTick()
      assertCurrentAttempt()

      ++tabSwitchGeneration
      ++documentLoadGeneration
      cancelResidencySweep()

      // A failed first save is not terminal if the retry below or immutable
      // recovery succeeds for the same revision.
      await flushAutoSave()
      await waitForAllDocumentSaves()
      await residencySweepChain.catch(() => {})
      assertCurrentAttempt()

      for (const tb of tabs.value) {
        const key = snapshotDocKeyForTab(tb)
        if (!documentIsAheadOfDisk(key)) continue
        for (let pass = 0; pass < 3 && documentIsAheadOfDisk(key); pass++) {
          assertCurrentAttempt()
          const isActive = tb.id === activeTabId.value
          let markdown = isActive
            ? exportableMarkdown()
            : (typeof tb.exportedMd === 'string' ? tb.exportedMd : null)
          let snapshotText = isActive
            ? content.value
            : (typeof tb.content === 'string' ? tb.content : null)
          if (snapshotText == null && tabBufferApi && tb.bufferRef) {
            markdown = await tabBufferApi.tabBufferGet(tb.bufferRef)
            assertCurrentAttempt()
            if (typeof markdown !== 'string') {
              ok = false
              break
            }
            snapshotText = importMarkdown(markdown)
          }
          if (snapshotText == null || snapshotDocKeyForTab(tb) !== key) {
            ok = false
            break
          }
          const revision = documentEditRevision(key)
          const handle = isActive ? currentFileHandle.value : tb.fileHandle
          if (handle && markdown != null) {
            await saveToFileHandle(handle, {
              markdown,
              snapshotContent: snapshotText,
              snapshotKey: key,
              revision
            })
            await waitForDocumentSaves(key)
            assertCurrentAttempt()
          }
          if (!documentIsAheadOfDisk(key)) break
          if (snapshotDocKeyForTab(tb) !== key || documentEditRevision(key) !== revision) continue
          const recovery = await takeSnapshot('quit-recovery', key, snapshotText)
          assertCurrentAttempt()
          if (recovery == null) {
            ok = false
            break
          }
          if (snapshotDocKeyForTab(tb) === key && documentEditRevision(key) === revision) {
            recovered += 1
            protectedRevisions.set(key, revision)
            break
          }
        }
        if (documentIsAheadOfDisk(key) && protectedRevisions.get(key) !== documentEditRevision(key)) ok = false
      }

      await waitForAllDocumentSaves()
      await residencySweepChain.catch(() => {})
      assertCurrentAttempt()
      for (const tb of tabs.value) {
        const key = snapshotDocKeyForTab(tb)
        if (documentIsAheadOfDisk(key) && protectedRevisions.get(key) !== documentEditRevision(key)) ok = false
      }
      if (ok) {
        for (const tb of tabs.value) ++tb.bufferGeneration
      }
      // Main owns deletion after its filesystem and diagnostics barriers. A
      // cancelled quit therefore leaves every cold-tab ref readable.
      return { ok, recovered, tabBufferSessionId: ok ? TAB_BUFFER_SESSION_ID : '' }
    } catch (error) {
      console.error('Renderer quit flush failed:', error)
      return { ok: false, recovered, error: String(error && error.message || error) }
    }
  }
  const attempt = rendererQuitWorkChain.catch(() => {}).then(run)
  rendererQuitWorkChain = attempt.then(() => undefined, () => undefined)
  let exposed
  exposed = attempt.then((result) => {
    if (result.ok === false) {
      if (rendererQuitFlushPromise === exposed) {
        rendererQuitFlushPromise = null
        rendererQuitFlushing = false
      }
    }
    return result
  })
  rendererQuitFlushPromise = exposed
  return exposed
}

const resetRendererQuitAfterCancellation = () => {
  rendererQuitFlushPromise = null
  rendererQuitFlushToken = ''
  rendererQuitGeneration += 1
  rendererQuitFlushing = false
  resumeAgentSchedulingAfterRendererShutdown()
  scheduleTabResidencySweep()
}

let androidBackgroundWork = Promise.resolve(true)
let androidAppStateHandle = null
let androidBackHandle = null
let androidLifecycleDisposed = false
const protectAndroidBackgroundState = () => {
  if (!isAndroidNative) return Promise.resolve(true)
  const run = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      commitActiveBlockIfAny()
      const key = snapshotDocKey()
      const revision = documentEditRevision(key)
      const draft = content.value
      const needsRecovery = !isPristineTab() && (!isLocalFile.value || documentIsAheadOfDisk(key))
      const recovery = needsRecovery
        ? takeSnapshot('background-recovery', key, draft)
        : Promise.resolve(true)
      await flushAutoSave()
      await waitForDocumentSaves(key)
      const protectedDraft = await recovery
      if (protectedDraft == null) return false
      if (snapshotDocKey() === key && documentEditRevision(key) === revision && content.value === draft) return true
    }
    commitActiveBlockIfAny()
    return await takeSnapshot('background-recovery', snapshotDocKey(), content.value) != null
  }
  const operation = androidBackgroundWork.catch(() => false).then(run)
  androidBackgroundWork = operation.then(Boolean, () => false)
  return operation
}
const flushAndroidOnBackground = () => {
  if (!isAndroidNative || !document.hidden) return
  void protectAndroidBackgroundState()
}
const flushAndroidOnPageHide = () => {
  if (isAndroidNative) void protectAndroidBackgroundState()
}

onMounted(() => {
  listenAndroidLayoutMedia()
  listenAgentSidebarMedia()
  window.addEventListener('mousedown', hideToolbar)
  window.addEventListener('mouseup', handleGlobalMouseUp)
  window.addEventListener('keydown', handleGlobalKeydown, { capture: true })
  document.addEventListener('selectionchange', handleSelectionChange)
  document.addEventListener('visibilitychange', flushAndroidOnBackground)
  window.addEventListener('pagehide', flushAndroidOnPageHide)
  if (isAndroidNative) {
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) void protectAndroidBackgroundState()
    }).then((handle) => {
      if (androidLifecycleDisposed) void handle.remove()
      else androidAppStateHandle = handle
    }).catch((error) => console.warn('Android app-state listener unavailable:', error))
    void CapacitorApp.addListener('backButton', async ({ canGoBack }) => {
      if (mobileFilesOpen.value || agentOpen.value) {
        closeMobilePanels()
        return
      }
      await protectAndroidBackgroundState()
      if (canGoBack) window.history.back()
      else await CapacitorApp.exitApp()
    }).then((handle) => {
      if (androidLifecycleDisposed) void handle.remove()
      else androidBackHandle = handle
    }).catch((error) => console.warn('Android back listener unavailable:', error))
  }
  // RichEditor's Ctrl+click handler reports local-file links here; they open
  // with the OS default application through main's knote:open-path.
  window.addEventListener('knote:open-local-link', handleOpenLocalLinkEvent)
  // Local Markdown links open in a Knote tab on ANY click, in every view
  // (editor, split preview, history). A capture-phase delegate makes this
  // independent of editor readiness and of the Ctrl/Cmd convention that still
  // governs every other link.
  document.addEventListener('click', onDocumentClickForMarkdownLinks, true)
  // one delegated hover annotation for editor links and marked app controls
  window.addEventListener('mouseover', onHoverAnnotationOver)
  window.addEventListener('mouseout', onHoverAnnotationOut)
  window.addEventListener('blur', onHoverAnnotationBlur)
  window.addEventListener('pointerdown', onHoverAnnotationPointerDown, true)
  window.addEventListener('blur', cancelAgentPointerGestures)
  updateEditorMetrics()
  startSnapshotTimer()
  void restoreRememberedAndroidStorage()
  stopPrepareQuit = window.knoteDesktop?.onPrepareQuit?.(flushRendererStateForQuit) || null
  stopQuitCancelled = window.knoteDesktop?.onQuitCancelled?.(resetRendererQuitAfterCancellation) || null
  window.knoteDesktop?.ready?.()
  try {
    if (localStorage.getItem(ONBOARDING_KEY) !== '1') {
      onboardingTimer = setTimeout(() => { onboardingOpen.value = true }, 420)
    }
  } catch { /* storage unavailable: don't block the editor */ }
})

onBeforeUnmount(() => {
  appDialogQueue.dispose()
  clearSourceSelectionHighlight()
  unlistenAndroidLayoutMedia()
  unlistenAgentSidebarMedia()
  cancelAgentPointerGestures()
  resetTreeDoubleTap()
  androidLifecycleDisposed = true
  if (androidAppStateHandle) void androidAppStateHandle.remove()
  androidAppStateHandle = null
  if (androidBackHandle) void androidBackHandle.remove()
  androidBackHandle = null
  ++tabSwitchGeneration
  for (const tb of tabs.value) ++tb.bufferGeneration
  ++documentAnalysisGeneration
  clearTimeout(documentAnalysisTimer)
  cancelResidencySweep()
  if (onboardingTimer) clearTimeout(onboardingTimer)
  cancelLargeSourceDraftCommit()
  clearInterval(snapTimer)
  clearInterval(diskWatchTimer)
  if (stopPrepareQuit) stopPrepareQuit()
  if (stopQuitCancelled) stopQuitCancelled()
  if (stopWindowState) stopWindowState()
  window.removeEventListener('mousedown', hideToolbar)
  window.removeEventListener('mouseup', handleGlobalMouseUp)
  window.removeEventListener('keydown', handleGlobalKeydown, { capture: true })
  document.removeEventListener('selectionchange', handleSelectionChange)
  document.removeEventListener('visibilitychange', flushAndroidOnBackground)
  window.removeEventListener('pagehide', flushAndroidOnPageHide)
  window.removeEventListener('knote:open-local-link', handleOpenLocalLinkEvent)
  document.removeEventListener('click', onDocumentClickForMarkdownLinks, true)
  window.removeEventListener('mouseover', onHoverAnnotationOver)
  window.removeEventListener('mouseout', onHoverAnnotationOut)
  window.removeEventListener('blur', onHoverAnnotationBlur)
  window.removeEventListener('pointerdown', onHoverAnnotationPointerDown, true)
  window.removeEventListener('blur', cancelAgentPointerGestures)
  hideHoverAnnotation()
})
</script>

<template>
  <Teleport to="body">
    <OnboardingTour
      v-if="onboardingOpen"
      :lang="lang"
      :icon="theme === 'retro' ? KnoteIconPixel : KnoteIcon"
      :show-app-dialog="showAgentCapabilityDialog"
      @change-lang="lang = $event"
      @complete="completeOnboarding"
    />
  </Teleport>

  <!-- Desktop shell: slim draggable frosted title bar; the native window
       buttons overlay its right side (WCO) -->
  <div v-if="isDesktopShell && !androidLayoutActive" data-testid="desktop-titlebar" class="knote-titlebar print:hidden">
    <img :src="theme === 'retro' ? KnoteIconPixel : KnoteIcon" class="w-4 h-4 object-contain" alt="" />
    <span class="knote-titlebar-brand">Knote</span>
    <!-- Tab strip: rounded pills, doc/folder kinds; empty space stays a
         window drag region (each pill opts out) -->
    <div class="knote-tabs" :class="{ 'is-reordering': draggingTabId != null }">
      <!-- explicit duration: transitionend never fires in a hidden window
           (background tab / minimized), which would leave enter-from's
           max-width:0 stuck — the timer fallback always cleans up -->
      <TransitionGroup name="ktab" :duration="280">
        <div
          v-for="tb in tabs"
          :key="tb.id"
          data-testid="document-tab"
          :data-tab-id="tb.id"
          class="knote-tab"
          :class="{ 'is-active': tb.id === activeTabId, 'is-folder': tabKindOf(tb) === 'folder', 'is-dragging': tb.id === draggingTabId }"
          :aria-label="tabLabelOf(tb)"
          :data-hover-annotation="tabLabelOf(tb)"
          data-hover-placement="bottom"
          data-hover-source="tab"
          @mousedown="onTabPointerDown(tb.id, $event)"
          @auxclick="(e) => { if (e.button === 1) closeTab(tb.id) }"
          @contextmenu.prevent="openTabCtxMenu(tb, $event)"
        >
          <svg v-if="tabKindOf(tb) === 'folder'" class="knote-tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <svg v-else class="knote-tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span class="knote-tab-label">{{ tabLabelOf(tb) }}</span>
          <button class="knote-tab-x" :aria-label="t('tab_close')" :data-hover-annotation="t('tab_close')" data-hover-placement="bottom" data-hover-source="tab-control" tabindex="-1" @mousedown.stop @click.stop="closeTab(tb.id)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </TransitionGroup>
      <button class="knote-tab-add" :aria-label="t('tab_new')" :data-hover-annotation="t('tab_new')" data-hover-placement="bottom" data-hover-source="tab-control" tabindex="-1" @click="newTab">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  </div>
  <div
    class="knote-root bg-base-200 text-base-content flex flex-col p-4 gap-4 font-sans transition-colors duration-300"
    :class="[
      (pdfView || docPreviewHtml) ? 'h-screen overflow-hidden' : 'min-h-screen',
      {
        'knote-android-shell': androidLayoutActive,
        'is-android-tablet': isAndroidTablet,
        'is-android-compact': isAndroidCompact,
        'is-files-open': mobileFilesOpen,
        'is-agent-open': agentOpen
      }
    ]"
    :data-native-platform="androidLayoutActive ? 'android' : undefined"
    :data-android-layout="isAndroidTablet ? 'tablet' : (isAndroidCompact ? 'compact' : undefined)"
    :style="headingPlaceholders"
  >
    <!-- Android tablets keep document tabs in the app's normal flex flow. The
         pills use the same tab objects, controls and visual language as the
         Electron title bar without creating a desktop drag region. -->
    <div v-if="isAndroidTablet" data-testid="tablet-tab-strip" class="knote-tablet-tabbar print:hidden">
      <img :src="theme === 'retro' ? KnoteIconPixel : KnoteIcon" class="w-4 h-4 object-contain" alt="" />
      <span class="knote-titlebar-brand">Knote</span>
      <div class="knote-tabs" :class="{ 'is-reordering': draggingTabId != null }">
        <TransitionGroup name="ktab" :duration="280">
          <div
            v-for="tb in tabs"
            :key="tb.id"
            data-testid="document-tab"
            :data-tab-id="tb.id"
            class="knote-tab"
            :class="{ 'is-active': tb.id === activeTabId, 'is-folder': tabKindOf(tb) === 'folder', 'is-dragging': tb.id === draggingTabId }"
            :aria-label="tabLabelOf(tb)"
            :data-hover-annotation="tabLabelOf(tb)"
            data-hover-placement="bottom"
            data-hover-source="tab"
            @click="switchTab(tb.id)"
            @auxclick="(e) => { if (e.button === 1) closeTab(tb.id) }"
            @contextmenu.prevent="openTabCtxMenu(tb, $event)"
          >
            <svg v-if="tabKindOf(tb) === 'folder'" class="knote-tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <svg v-else class="knote-tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="knote-tab-label">{{ tabLabelOf(tb) }}</span>
            <button class="knote-tab-x" :aria-label="t('tab_close')" :data-hover-annotation="t('tab_close')" data-hover-placement="bottom" data-hover-source="tab-control" tabindex="-1" @pointerdown.stop @mousedown.stop @click.stop="closeTab(tb.id)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </TransitionGroup>
        <button data-testid="tablet-tab-add" class="knote-tab-add" :aria-label="t('tab_new')" :data-hover-annotation="t('tab_new')" data-hover-placement="bottom" data-hover-source="tab-control" tabindex="-1" @click="newTab">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
    </div>
    <!-- Navbar -->
    <header class="navbar bg-base-100 rounded-box shadow-lg z-[1001] print:hidden">
      <!-- Left: Stats (brand mark lives only in the window title bar now) -->
      <div class="navbar-start knote-navbar-start gap-3 flex-1">
        <!-- Stats -->
        <div
          class="knote-navbar-stats hidden md:flex join tooltip tooltip-bottom border border-base-300/30 rounded-lg bg-base-100/30"
          :data-tip="t('stats_tooltip')"
        >
            <div class="join-item px-3 py-1 text-xs flex flex-col items-center min-w-[60px]">
                <span class="text-base-content/50 scale-90">{{ t('words') }}</span>
                <span class="font-bold border-b-2 border-primary/20">{{ stats.words }}</span>
            </div>
            <div class="join-item px-3 py-1 text-xs flex flex-col items-center min-w-[60px]">
                <span class="text-base-content/50 scale-90">{{ t('chars') }}</span>
                <span class="font-bold border-b-2 border-secondary/20">{{ stats.chars }}</span>
            </div>
            <div class="join-item px-3 py-1 text-xs flex flex-col items-center min-w-[60px]">
                <span class="text-base-content/50 scale-90">{{ t('lines') }}</span>
                <span class="font-bold border-b-2 border-accent/20">{{ stats.lines }}</span>
            </div>
        </div>
      </div>

      <!-- Center: File Status -->
      <div class="navbar-center hidden xl:flex absolute left-1/2 -translate-x-1/2">
         <div 
          class="text-xs px-3 py-1.5 rounded-full font-medium transition-all duration-300 flex items-center gap-2"
          :class="isLocalFile 
            ? 'bg-base-200/50 text-base-content/70' 
            : 'bg-warning/10 text-warning'"
        >
          <template v-if="isLocalFile">
            <span class="w-2 h-2 rounded-full bg-success"></span>
            <span data-testid="current-file-name" class="max-w-[200px] truncate">{{ currentFileName }}</span>
            <span v-if="isSaving" class="loading loading-spinner loading-xs opacity-50"></span>
          </template>
          <template v-else>
            <span class="w-2 h-2 rounded-full bg-warning"></span>
            <span>{{ t('temp_file_warning') }}</span>
          </template>
        </div>
      </div>

      <!-- Right: Actions & Tools -->
      <div class="navbar-end knote-navbar-actions gap-1 flex-1">
        
        <!-- Undo/Redo -->
        <div class="knote-history-actions join mr-1">
          <button
            class="join-item btn btn-sm btn-ghost hover:text-[#84cc16] tooltip tooltip-bottom"
             :class="{ 'btn-disabled opacity-30': viewMode === 'single' ? !(largeDocumentPlainMode ? (largeRichEditorRef && largeRichEditorRef.canUndoR) : (richEditorRef && richEditorRef.canUndoR)) : undoStack.length === 0 }"
            :data-tip="t('undo') + ' (Ctrl+Z)'"
            @click="undo"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
            </svg>
          </button>
          <button
            class="join-item btn btn-sm btn-ghost hover:text-[#84cc16] tooltip tooltip-bottom"
             :class="{ 'btn-disabled opacity-30': viewMode === 'single' ? !(largeDocumentPlainMode ? (largeRichEditorRef && largeRichEditorRef.canRedoR) : (richEditorRef && richEditorRef.canRedoR)) : redoStack.length === 0 }"
            :data-tip="t('redo') + ' (Ctrl+Y)'"
            @click="redo"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4">
              <path stroke-linecap="round" stroke-linejoin="round" d="m15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3" />
            </svg>
          </button>
        </div>

        <!-- Open (file / folder) -->
        <div class="knote-open-actions dropdown dropdown-end">
          <div tabindex="0" role="button" class="btn btn-sm btn-ghost hover:text-[#84cc16] gap-1 font-normal">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
            <span class="hidden sm:inline">{{ t('open') }}</span>
            <span class="text-[10px] opacity-50">▼</span>
          </div>
          <!-- max-h + scroll: 12 recents plus the actions otherwise run past
               the bottom of a short window. Width hugs the longest entry up
               to a cap instead of hard-truncating every long filename. -->
          <ul tabindex="0" class="dropdown-content z-[2000] menu p-2 shadow-xl bg-base-100 rounded-box min-w-56 w-max max-w-[min(26rem,90vw)] border border-base-200 max-h-[70vh] overflow-y-auto flex-nowrap">
            <li :data-testid="isAndroidNative ? 'android-open-document' : undefined" @click="openLocalFile(); blurActiveElement()">
              <a class="flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-4 h-4 opacity-70">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
                {{ t('open_file') }}
              </a>
            </li>
            <li :data-testid="isAndroidNative ? 'android-open-tree' : undefined" @click="openFolder(); blurActiveElement()">
              <a class="flex items-center gap-2" :title="t('folder_hint')">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-4 h-4 opacity-70">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
                </svg>
                {{ t('open_folder') }}
              </a>
            </li>
            <li v-if="isAndroidNative" data-testid="android-open-legacy-workspace" @click="openLegacyNativeWorkspace(); blurActiveElement()">
              <a class="flex items-center gap-2">
                <svg class="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7.5h6l2 2h8v9.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 2"/><path stroke-linecap="round" d="M7 14h10M7 17h6"/></svg>
                {{ t('open_legacy_workspace') }}
              </a>
            </li>
            <!-- Recently opened (desktop) -->
            <template v-if="isDesktopShell && recentItems.length">
              <!-- !flex-row overrides daisyUI's .menu li column direction,
                   which otherwise stacks the title above a centered button.
                   Trash icon (not ✕) so it reads as "clear list", not
                   "close panel". Single entries removed via right-click. -->
              <li class="menu-title !flex-row flex items-center justify-between pr-1">
                <span class="text-[10px] uppercase tracking-wider opacity-50">{{ t('recent_open') }}</span>
                <button class="btn btn-ghost btn-xs btn-square opacity-40 hover:opacity-100 hover:text-error" :title="t('recent_clear')" @click.stop="clearRecents">
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6m4 5v6m4-6v6"/></svg>
                </button>
              </li>
              <li v-for="r in recentItems" :key="r.type + r.path" @click="openRecent(r)" @contextmenu.prevent="openRecentCtxMenu(r, $event)">
                <a class="flex items-center gap-2">
                  <svg v-if="r.type === 'folder'" class="w-4 h-4 opacity-60 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  <svg v-else class="w-4 h-4 opacity-60 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  <span class="truncate flex-1 min-w-0 max-w-[19rem]" :title="r.path">{{ r.name }}</span>
                </a>
              </li>
            </template>
          </ul>
        </div>

        <!-- Save -->
        <button 
          class="knote-save-action btn btn-sm btn-ghost hover:text-[#84cc16] gap-1 font-normal"
          :class="{ 'opacity-50': isSaving }"
          @click="saveFile"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          <span class="hidden sm:inline">{{ t('save') }}</span>
        </button>

        <!-- View Mode Toggle -->
        <div class="knote-view-toggle join shadow-sm mx-1 border border-base-300/50 rounded-lg overflow-hidden h-8 sm:h-9">
          <button 
            data-testid="view-single"
            class="join-item btn btn-xs sm:btn-sm border-none h-full min-h-0 whitespace-nowrap"
            :class="viewMode === 'single' ? '!bg-[#84cc16] !text-white' : 'btn-ghost hover:bg-base-300'" 
            @click="setViewMode('single')"
          >
            {{ t('single') }}
          </button>
          <button 
            data-testid="view-split"
            class="join-item btn btn-xs sm:btn-sm border-none h-full min-h-0 whitespace-nowrap"
            :class="viewMode === 'split' ? '!bg-[#84cc16] !text-white' : 'btn-ghost hover:bg-base-300'" 
            :disabled="!!pdfView"
            :title="largeDocumentPlainMode ? (lang === 'zh' ? '超长文档在分栏模式下仍仅渲染当前富文本分片' : 'Split mode remains bounded to the current rich-text chunk') : ''"
            @click="setViewMode('split')"
          >
            {{ t('split') }}
          </button>
        </div>

        <!-- Assistant (Req 4 click entry): toggles float ⇄ sidebar when the sidebar
             is available, otherwise opens/closes the floating window. -->
        <button
          v-if="!isAndroidCompact"
          type="button"
          data-testid="navbar-agent"
          class="btn btn-sm btn-ghost btn-square px-2 hover:text-[#84cc16]"
          :class="{ 'text-[#84cc16]': showAgentSidebar || agentOpen }"
          :title="agentSidebarAvailable ? (showAgentSidebar ? t('agent_to_float') : t('agent_to_sidebar')) : t('agent_open')"
          :aria-pressed="showAgentSidebar || agentOpen"
          @click="onNavbarAgent"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="8.4"/><ellipse cx="12" cy="12.5" rx="3.5" ry="4"/><path stroke-linecap="round" stroke-linejoin="round" d="M12 5.7v1.6M12 17.7v1.6M17.2 12.5h1.6M5.2 12.5h1.6M15.7 16.2l1.1 1.1M8.3 16.2l-1.1 1.1M8.3 8.8l-1.1-1.1M15.7 8.8l1.1-1.1"/></svg>
        </button>

        <!-- I18n -->
        <button class="knote-language-action btn btn-sm btn-ghost hover:text-[#84cc16] gap-1 px-2" @click="lang = lang === 'zh' ? 'en' : 'zh'">
           <span class="text-xs font-bold uppercase">{{ lang === 'zh' ? '中文' : 'EN' }}</span>
        </button>

        <!-- Theme -->
        <div class="knote-theme-action dropdown dropdown-end">
          <div data-testid="theme-menu" tabindex="0" role="button" class="btn btn-sm btn-ghost hover:text-[#84cc16] m-1 px-2">
             {{ t('theme') }} <span class="text-[10px] opacity-50">▼</span>
          </div>
          <ul tabindex="0" class="dropdown-content z-[2000] menu p-2 shadow-xl bg-base-100 rounded-box w-52 border border-base-200">
            <li>
              <a data-testid="theme-light" @click="theme = 'light'; blurActiveElement()" :class="{active: theme==='light'}" class="flex justify-between items-center">
                <span>{{ t('light') }}</span>
                <div class="theme-indicator indicator-light"></div>
              </a>
            </li>
            <li>
              <a data-testid="theme-dark" @click="theme = 'dark'; blurActiveElement()" :class="{active: theme==='dark'}" class="flex justify-between items-center">
                <span>{{ t('dark') }}</span>
                <div class="theme-indicator indicator-dark"></div>
              </a>
            </li>
            <!-- retro (pixel-arcade) theme HIDDEN from the picker for now —
                 the styling isn't polished enough to advertise. All theme CSS
                 stays, so anyone who already persisted theme==='retro' keeps
                 working; re-add this <li> to bring it back. -->
          </ul>
        </div>

        <!-- Actions -->
        <div class="knote-more-actions dropdown dropdown-end">
             <div data-testid="actions-menu" tabindex="0" role="button" class="btn btn-sm btn-square btn-ghost hover:text-[#84cc16]">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-5 h-5 stroke-current"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"></path></svg>
             </div>
              <ul tabindex="0" class="dropdown-content z-[2000] menu p-2 shadow-xl bg-base-100 rounded-box w-52 border border-base-200">
                <!-- Android WebView has no window.print() pipeline — hide PDF there -->
                <li v-if="!isNativeApp()" @click="exportPDF(); blurActiveElement()">
                    <a class="flex items-center gap-2">
                        <img :src="KpdfIcon" class="w-4 h-4 object-contain" />
                        {{ t('export_pdf') }}
                    </a>
                </li>
                <li @click="exportWord(); blurActiveElement()">
                    <a class="flex items-center gap-2">
                        <img :src="KdocIcon" class="w-4 h-4 object-contain" alt="Word Icon" />
                        {{ t('export_word') }}
                    </a>
                </li>
                <li @click="downloadMarkdown(); blurActiveElement()">
                    <a class="flex items-center gap-2">
                        <img :src="theme === 'retro' ? KnoteIconPixel : KnoteIcon" class="w-4 h-4 object-contain" alt="Markdown Icon" />
                        {{ t('export_md') }}
                    </a>
                </li>
                <li @click="exportHtml(); blurActiveElement()">
                    <a class="flex items-center gap-2">
                        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="m8 9-3 3 3 3m8-6 3 3-3 3M13.5 6l-3 12"/></svg>
                        {{ t('export_html') }}
                    </a>
                </li>
                <div class="divider my-1"></div>
                <li v-if="!isAndroidNative && viewMode === 'single'">
                  <a
                    data-testid="center-editor-toggle"
                    class="flex items-center gap-2"
                    role="menuitemcheckbox"
                    :aria-checked="editorCentered"
                    @click="toggleEditorCentered"
                  >
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5v14M20 5v14M8 8h8v8H8z"/><path d="M4 12h4m8 0h4"/></svg>
                    <span class="flex-1">{{ t('center_editor') }}</span>
                    <svg v-if="editorCentered" class="w-3.5 h-3.5 text-[#65a30d]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
                  </a>
                </li>
                                <li v-if="isDesktopShell">
                  <a
                    data-testid="hw-accel-toggle"
                    class="flex items-center gap-2"
                    role="menuitemcheckbox"
                    :aria-checked="!hwAccelDisabled"
                    :title="t('hw_accel_hint')"
                    @click="toggleHwAccel"
                  >
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>
                    <span class="flex-1">{{ t('hw_accel') }}</span>
                    <svg v-if="!hwAccelDisabled" class="w-3.5 h-3.5 text-[#65a30d]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
                  </a>
                </li>
                <li v-if="!isAndroidNative">
                  <a
                    data-testid="source-smart-edit-toggle"
                    class="flex items-center gap-2"
                    role="menuitemcheckbox"
                    :aria-checked="sourceSmartEdit"
                    :title="t('source_smart_edit_hint')"
                    @click="toggleSourceSmartEdit"
                  >
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>
                    <span class="flex-1">{{ t('source_smart_edit') }}</span>
                    <svg v-if="sourceSmartEdit" class="w-3.5 h-3.5 text-[#65a30d]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
                  </a>
                </li>
<li data-testid="open-history" @click="openHistory(); blurActiveElement()">
                    <a class="flex items-center gap-2">
                        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 2m6-2a9 9 0 1 1-3.5-7.1M21 3v5h-5"/></svg>
                        {{ t('history') }}
                    </a>
                </li>
                <li data-testid="load-sample-zh" @click="loadSample('zh'); blurActiveElement()">
                  <a class="flex items-center gap-2">
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9.5 16 1.3-2.7L13.5 12l-2.7-1.3L9.5 8l-1.3 2.7L5.5 12l2.7 1.3z"/></svg>
                    {{ t('load_sample_zh') }}
                  </a>
                </li>
                <li data-testid="load-sample-en" @click="loadSample('en'); blurActiveElement()">
                  <a class="flex items-center gap-2">
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9.5 16 1.3-2.7L13.5 12l-2.7-1.3L9.5 8l-1.3 2.7L5.5 12l2.7 1.3z"/></svg>
                    {{ t('load_sample_en') }}
                  </a>
                </li>
                <li @click="copyMarkdown(); blurActiveElement()">
                  <a class="flex items-center gap-2">
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/><path d="m12 14 2 2 3.5-4"/></svg>
                    {{ t('copy_markdown') }}
                  </a>
                </li>
                <li @click="openShortcuts(); blurActiveElement()">
                  <a class="flex items-center gap-2">
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h.01M10 14h7"/></svg>
                    {{ t('shortcuts') }}
                  </a>
                </li>
                <li @click="openOnboarding(); blurActiveElement()">
                  <a class="flex items-center gap-2">
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/><path d="M17 3h4v4"/><path d="m21 3-5 5"/></svg>
                    {{ t('product_tour') }}
                  </a>
                </li>
                <li @click="recallAgent(); blurActiveElement()">
                  <a class="flex items-center gap-2" :class="{ 'opacity-40 pointer-events-none': showAgentSidebar }" :aria-disabled="showAgentSidebar">
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/></svg>
                    {{ t('agent_recall') }}
                  </a>
                </li>
                <div class="divider my-1"></div>
                <li @click="clearAll(); blurActiveElement()"><a class="text-error">{{ t('clear_all') }}</a></li>
             </ul>
        </div>
      </div>
    </header>

    <button
      v-if="isAndroidCompact && (mobileFilesOpen || agentOpen)"
      data-testid="mobile-drawer-backdrop"
      class="knote-mobile-backdrop print:hidden"
      :aria-label="t('history_close')"
      @click="closeMobilePanels"
    ></button>

    <main
      class="knote-workbench flex-1 transition-all duration-300 relative"
      :class="[
        viewMode === 'split' ? 'grid gap-6 grid-cols-1 lg:grid-cols-2' : 'knote-workbench-single mx-auto w-full',
        (pdfView || docPreviewHtml) ? 'min-h-0 overflow-hidden' : '',
        (viewMode === 'split' && !largeDocumentPlainMode && !pdfView && !docPreviewHtml) ? 'knote-split-locked' : ''
      ]"
      :data-view-mode="viewMode"
      :data-editor-centered="viewMode === 'single' && editorCentered ? 'true' : 'false'"
      :data-sidebar-visible="viewMode === 'single' && (outlineVisible || androidLayoutActive) ? 'true' : 'false'"
      :data-agent-sidebar="showAgentSidebar ? 'true' : 'false'"
      :data-large-document-mode="largeDocumentPlainMode ? 'chunked-rich' : 'off'"
    >

      <!-- Invisible wheel gutter: this is the blank region to the LEFT of the
           sidebar (the area highlighted by the user), never the workbench or
           any card. It scrolls the card rail as a whole. -->
      <div
        v-if="viewMode === 'single' && outlineVisible"
        class="knote-sidebar-wheel-zone hidden lg:block print:hidden"
        aria-hidden="true"
        @wheel="onSidebarWheel"
      ></div>

      <button
        v-if="viewMode === 'single' && !outlineVisible"
        data-testid="sidebar-show"
        class="knote-sidebar-recall hidden lg:flex fixed left-2 top-1/2 -translate-y-1/2 z-[1050] w-8 h-12 items-center justify-center rounded-r-xl rounded-l-md border border-base-200 bg-base-100/90 backdrop-blur shadow-md text-base-content/45 hover:text-[#65a30d] hover:border-[#84cc16]/45 transition-colors print:hidden"
        :title="t('sidebar_show')"
        :aria-label="t('sidebar_show')"
        @click="outlineVisible = true"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="m9 18 6-6-6-6"/></svg>
      </button>

      <!-- Outline Panel (single mode). v-show (not v-if): toggling the sidebar
           must be instant — remounting the file tree, agent card and a large
           outline list every time it is opened is what made reopening a huge
           document feel frozen. The outline list itself is progressively
           revealed and kept bounded. -->
      <aside
        v-show="viewMode === 'single' && (outlineVisible || androidLayoutActive)"
        data-testid="workspace-sidebar"
        class="hidden lg:block shrink-0 transition-all duration-300 print:hidden knote-workspace-sidebar"
      >
        <!-- Follow the root scroll viewport. The left blank gutter moves this
             rail directly; a card moves it after reaching its own boundary. -->
        <div
          ref="sidebarRailRef"
          class="knote-left-sidebar-scroll sticky top-4 max-h-[calc(100vh-5rem)] overflow-y-hidden px-1.5 -mx-1.5 pb-2"
          @wheel="onSidebarWheel"
        >
        <!-- Actions card (single mode): navbar functions reachable while
             scrolling a long document — same handlers as the top navbar.
             Dropdowns open via the shared body-level popup (floatingMenu). -->
        <div data-testid="sidebar-actions-card" class="card bg-base-100 border border-base-200 shadow-md overflow-hidden mb-3">
          <div class="flex flex-wrap items-center justify-between gap-x-0.5 gap-y-1 px-1.5 py-1.5">
            <div class="join shrink-0 border border-base-300/50 rounded-lg overflow-hidden h-7">
              <button
                data-testid="sidebar-view-single"
                class="join-item btn btn-xs border-none h-full min-h-0 px-1"
                :class="viewMode === 'single' ? '!bg-[#84cc16] !text-white' : 'btn-ghost hover:bg-base-300'"
                @click="setViewMode('single')"
              >{{ t('single') }}</button>
              <button
                data-testid="sidebar-view-split"
                class="join-item btn btn-xs border-none h-full min-h-0 px-1"
                :class="viewMode === 'split' ? '!bg-[#84cc16] !text-white' : 'btn-ghost hover:bg-base-300'"
                :disabled="!!pdfView"
                @click="setViewMode('split')"
              >{{ t('split') }}</button>
            </div>
            <button
              data-testid="sidebar-open-menu"
              class="btn btn-xs btn-ghost h-7 px-1 gap-1 font-normal hover:text-[#65a30d] shrink-0"
              @click="openFloatingMenu('open', $event)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3 h-3"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
              <span>{{ t('open') }}</span>
            </button>
            <button
              class="btn btn-xs btn-ghost h-7 px-1 gap-1 font-normal hover:text-[#65a30d] shrink-0"
              :class="{ 'opacity-50': isSaving }"
              @click="saveFile"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3 h-3"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
              <span>{{ t('save') }}</span>
            </button>
            <button class="btn btn-xs btn-ghost h-7 px-1 gap-1 font-normal hover:text-[#65a30d] shrink-0" @click="lang = lang === 'zh' ? 'en' : 'zh'">
              <span class="text-[10px] font-bold uppercase">{{ lang === 'zh' ? '中文' : 'EN' }}</span>
            </button>
            <button
              data-testid="sidebar-theme-menu"
              class="btn btn-xs btn-ghost h-7 px-1 gap-1 font-normal hover:text-[#65a30d] shrink-0"
              @click="openFloatingMenu('theme', $event)"
            >
              {{ t('theme') }}
            </button>
            <button
              data-testid="sidebar-actions-menu"
              class="btn btn-xs btn-square btn-ghost h-7 hover:text-[#65a30d] shrink-0"
              @click="openFloatingMenu('menu', $event)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-4 h-4 stroke-current"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"></path></svg>
            </button>
          </div>
          <div class="px-3 py-1.5 border-t border-base-200/60 bg-base-200/30" :title="t('stats_tooltip')">
            <div class="flex items-center justify-center gap-1.5 text-[11px] leading-none text-base-content/50 whitespace-nowrap">
              <span class="font-semibold tabular-nums text-base-content/70 border-b-2 border-primary/20">{{ stats.words }}</span><span>{{ t('words') }}</span>
              <span class="opacity-30">·</span>
              <span class="font-semibold tabular-nums text-base-content/70 border-b-2 border-secondary/20">{{ stats.chars }}</span><span>{{ t('chars') }}</span>
              <span class="opacity-30">·</span>
              <span class="font-semibold tabular-nums text-base-content/70 border-b-2 border-accent/20">{{ stats.lines }}</span><span>{{ t('lines') }}</span>
            </div>
          </div>
        </div>
        <nav data-testid="outline-card" class="knote-outline-card card bg-base-100 border border-base-200 shadow-md overflow-hidden" :aria-label="t('outline')">
          <div class="flex items-center justify-between px-3 py-2 border-b border-base-200/60">
            <span class="text-xs font-bold text-base-content/50 uppercase tracking-widest">{{ t('outline') }}</span>
            <button
              data-testid="sidebar-hide"
              class="btn btn-xs btn-ghost btn-square"
              :title="t('sidebar_hide')"
              :aria-label="t('sidebar_hide')"
              @click="outlineVisible = false"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
            </button>
          </div>
<div class="knote-sidebar-card-scroll max-h-[45vh] overflow-auto py-2">
            <div v-if="outlineItems.length === 0" class="px-3 py-2 text-xs text-base-content/40">{{ t('outline_empty') }}</div>
            <ul v-else class="space-y-0.5">
              <li v-for="item in visibleOutlineItems" :key="item.id" class="flex items-stretch">
                <button
                  v-if="outlineNodeHasChildren.has(item.id)"
                  class="shrink-0 w-5 self-stretch flex items-center justify-center text-base-content/35 hover:text-[#65a30d]"
                  :aria-label="collapsedOutlineIds.has(item.id) ? t('ctx_expand') : t('ctx_collapse')"
                  @click.stop="toggleOutlineCollapsed(item.id)"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="w-3 h-3 transition-transform duration-150" :class="{ 'rotate-90': !collapsedOutlineIds.has(item.id) }"><path stroke-linecap="round" stroke-linejoin="round" d="m9 18 6-6-6-6"/></svg>
                </button>
                <span v-else class="shrink-0 w-5 self-stretch" aria-hidden="true"></span>
                <button
                  class="flex-1 min-w-0 text-left text-sm px-3 py-1 hover:bg-base-200/60 hover:text-[#84cc16] transition-colors truncate rounded-sm"
                  :class="{ 'font-bold': item.level === 1, 'text-base-content/80': item.level === 2, 'text-base-content/60': item.level >= 3, 'bg-[#84cc16]/10 text-[#65a30d]': activeOutlineId === item.id }"
                  :style="{ paddingLeft: `${12 + (item.level - 1) * 12}px` }"
                  :title="item.text"
                  :aria-current="activeOutlineId === item.id ? 'location' : undefined"
                  @click="scrollToBlock(item.id)"
                >
                  {{ item.text || '…' }}
                </button>
              </li>
              <li v-if="outlineHasMore" ref="outlineSentinelEl">
                <button
                  class="w-full text-left text-xs px-3 py-1.5 text-[#65a30d]/80 hover:text-[#65a30d] hover:bg-base-200/60 transition-colors rounded-sm"
                  @click="outlineRenderLimit = Math.min(outlineItems.length, outlineRenderLimit + 240)"
                >
                  {{ lang === 'zh' ? '展开更多标题…' : 'Show more headings…' }}
                </button>
              </li>
            </ul>
            <div v-if="outlineTruncated" class="px-3 py-2 text-[11px] text-amber-700/80" role="status">
              {{ lang === 'zh' ? '大纲过长，仅显示前 4000 个标题' : 'Outline is truncated to the first 4,000 headings' }}
            </div>
          </div>
        </nav>

        <!-- Chunked editing controls (large documents): always visible in the
             sidebar so switching sections never requires scrolling the editor
             back to the top -->
        <div
          v-if="largeDocumentPlainMode"
          data-testid="large-document-chunk-card"
          class="knote-chunk-card mt-3 card bg-base-100 border border-base-200 shadow-md overflow-hidden"
        >
          <div class="flex items-center gap-2 px-3 py-2 border-b border-[#84cc16]/20 bg-[#f7fbea]">
            <svg class="w-4 h-4 shrink-0 text-[#65a30d]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v18m9-9H3"/><path stroke-linecap="round" stroke-linejoin="round" d="M5.5 5.5h13v13h-13z"/></svg>
            <span class="text-xs font-bold text-base-content/70 truncate">
              {{ lang === 'zh' ? '分片富文本编辑' : 'Chunked editing' }}
            </span>
          </div>
          <div class="px-3 py-2 space-y-2">
            <div class="text-[11px] leading-relaxed text-base-content/55">
              {{ lang === 'zh' ? '仅载入当前段，可通过下方分段按钮或大纲切换。' : 'Only the current section is mounted. Use the controls below or the outline to move around.' }}
            </div>
            <div class="flex items-center gap-1 tabular-nums whitespace-nowrap">
              <button
                class="btn btn-ghost btn-xs btn-square border border-base-200"
                :disabled="largeSourcePage <= 0"
                :aria-label="lang === 'zh' ? '上一段' : 'Previous chunk'"
                @click="openLargeSourcePage(largeSourcePage - 1)"
              >‹</button>
              <select
                data-testid="large-source-page-select"
                class="select select-bordered select-xs flex-1 min-w-0 h-6 px-1 text-center"
                :value="String(largeSourcePage)"
                :aria-label="lang === 'zh' ? '选择文档分段' : 'Choose document chunk'"
                @change="openLargeSourcePage(Number($event.target.value))"
              >
                <option v-for="pageIndex in largeSourcePageCount" :key="pageIndex" :value="String(pageIndex - 1)">
                  {{ pageIndex }} / {{ largeSourcePageCount }}
                </option>
              </select>
              <button
                class="btn btn-ghost btn-xs btn-square border border-base-200"
                :disabled="largeSourcePage >= largeSourcePageCount - 1"
                :aria-label="lang === 'zh' ? '下一段' : 'Next chunk'"
                @click="openLargeSourcePage(largeSourcePage + 1)"
              >›</button>
            </div>
          </div>
        </div>


        <!-- File tree (open a folder, browse its .md files) -->
        <div data-testid="files-card" class="knote-files-card mt-3 card bg-base-100 border border-base-200 shadow-md overflow-hidden">
          <div class="flex items-center gap-0.5 px-3 py-2 border-b border-base-200/60">
            <span class="text-xs font-bold text-base-content/50 uppercase tracking-widest truncate flex-1" :title="folderName">{{ folderName || t('files') }}</span>
            <button v-if="folderHandle" data-testid="workspace-new-file" class="btn btn-xs btn-ghost btn-square" :title="t('file_new')" @click="openCreateTarget('file', $event)">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3h-6m-3.75 7.5h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125Z" /></svg>
            </button>
            <button v-if="folderHandle" data-testid="workspace-new-folder" class="btn btn-xs btn-ghost btn-square" :title="t('folder_new')" @click="openCreateTarget('folder', $event)">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" /></svg>
            </button>
            <button v-if="folderHandle" data-testid="tree-refresh" class="btn btn-xs btn-ghost btn-square" :title="t('file_refresh')" @click="refreshFolder">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
            </button>
            <button class="btn btn-xs btn-ghost btn-square" :title="t('open_folder')" @click="openFolder">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.893 6.25a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.893-6.25a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h2.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 8v1.75" /></svg>
            </button>
          </div>
          <!-- folder-wide full-text search -->
          <div v-if="folderHandle" class="px-2 pt-2">
            <div class="relative">
              <svg class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/35" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path stroke-linecap="round" d="m20 20-3.5-3.5"/></svg>
              <input
                v-model="folderSearchQuery"
                :placeholder="t('folder_search_placeholder')"
                class="w-full h-8 pl-7 pr-7 text-xs rounded-lg bg-base-200/50 border border-transparent focus:border-[#84cc16] focus:outline-none"
              />
              <button v-if="folderSearchQuery" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-base-content/40 hover:text-base-content" @click="folderSearchQuery = ''">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>
          <!-- search results -->
          <div v-if="folderSearchQuery.trim()" class="knote-sidebar-card-scroll max-h-[42vh] overflow-auto py-1.5">
            <div v-if="folderSearching" class="px-3 py-2 text-xs text-base-content/40">{{ t('searching') }}</div>
            <div v-else-if="!folderSearchResults.length" class="px-3 py-2 text-xs text-base-content/40">{{ t('folder_search_none') }}</div>
            <template v-else>
              <div class="px-3 py-1 text-[10px] uppercase tracking-wider text-base-content/35">{{ t('folder_search_count').replace('{n}', folderSearchHitCount).replace('{f}', folderSearchResults.length) }}</div>
              <div v-for="res in folderSearchResults" :key="res.path" class="mb-0.5">
                <div class="px-2 py-1 text-xs font-semibold text-base-content/70 truncate flex items-center gap-1.5" :title="res.path">
                  <svg class="w-3 h-3 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg>
                  {{ res.name }}
                </div>
                <button
                  v-for="hit in res.hits"
                  :key="hit.line"
                  class="w-full text-left pl-7 pr-2 py-1 text-[11px] text-base-content/60 hover:bg-[#84cc16]/10 hover:text-base-content rounded-sm flex gap-2"
                  @click="openSearchResult(res.node, hit.line)"
                >
                  <span class="text-base-content/35 tabular-nums shrink-0">{{ hit.line }}</span>
                  <span class="truncate">{{ hit.text }}</span>
                </button>
              </div>
            </template>
          </div>
          <div v-else class="knote-sidebar-card-scroll max-h-[32vh] overflow-auto py-1.5">
            <!-- single file open (no folder workspace): surface which document
                 is being viewed here, where the folder hint would otherwise sit -->
            <div
              v-if="!folderTree.length && !folderName && currentFileName"
              data-testid="single-file-row"
              class="px-3 py-2 cursor-pointer"
              @pointerdown.right.stop
              @contextmenu.prevent.stop="activeTab() && openTabCtxMenu(activeTab(), $event)"
            >
              <div class="flex items-center gap-1.5 text-xs font-medium text-[#84cc16]">
                <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <span class="truncate" :title="currentFileName">{{ t('browsing_now') }} {{ currentFileName }}</span>
              </div>
            </div>
            <div v-else-if="!folderTree.length" class="px-3 py-2 text-xs text-base-content/40">
              {{ folderName ? t('folder_empty') : t('folder_hint') }}
            </div>
            <div v-else>
              <div
                v-for="row in flatFolderTree"
                :key="row.node.path"
                data-testid="workspace-tree-row"
                :data-tree-path="row.node.path"
                :data-tree-kind="row.node.kind"
                :data-tree-active="row.node.path === activeTreePath ? 'true' : 'false'"
                class="knote-tree-row group w-full flex items-center gap-1.5 text-left text-xs px-2 py-1 hover:bg-base-200/60 transition-colors rounded-sm cursor-pointer"
                :class="row.node.path === activeTreePath ? 'text-[#84cc16] font-bold bg-[#84cc16]/10' : 'text-base-content/75'"
                :style="{ paddingLeft: `${10 + row.depth * 14}px` }"
                :title="row.node.kind === 'dir' ? row.node.name : undefined"
                :aria-label="row.node.name"
                :data-hover-annotation="row.node.kind === 'file' ? treeRowAnnotation(row.node) : undefined"
                :data-hover-placement="row.node.kind === 'file' ? 'right' : undefined"
                :data-hover-source="row.node.kind === 'file' ? 'file-row' : undefined"
                @click="onTreeRowClick(row.node, $event)"
                @dblclick="onTreeRowDoubleClick(row.node, $event)"
                @pointerdown.right.stop
                @contextmenu.prevent.stop="openTreeCtxMenu(row.node, $event)"
              >
                <svg v-if="row.node.kind === 'dir'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 opacity-60 transition-transform" :class="{ 'rotate-90': expandedDirs.has(row.node.path) }"><path stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
                <!-- pdf: red; image: sky; docx: blue; pptx: orange; xlsx: emerald;
                     txt/csv/rtf: gray; odt/ods/odp: purple; md/other: plain -->
                <svg v-else-if="row.node.ftype === 'pdf'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 text-rose-500/70"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                <svg v-else-if="row.node.ftype === 'image'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 text-sky-500/70"><path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
                <svg v-else-if="row.node.ftype === 'docx'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 text-blue-500/70"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                <svg v-else-if="row.node.ftype === 'pptx'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 text-orange-500/70"><rect x="3.75" y="3" width="16.5" height="18" rx="3" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 8.25h4.5a1.5 1.5 0 0 1 0 3h-4.5m0 4.5h7.5" /></svg>
                <svg v-else-if="row.node.ftype === 'xlsx'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 text-emerald-500/70"><rect x="3.75" y="3" width="16.5" height="18" rx="3" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 8.25h7.5M8.25 12h7.5m-7.5 3.75h4.5" /></svg>
                <svg v-else-if="row.node.ftype === 'txt' || row.node.ftype === 'csv' || row.node.ftype === 'rtf'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 text-gray-500/70"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 3.75h7.5m-7.5 3h7.5m-7.5 3h3.75M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                <svg v-else-if="row.node.ftype === 'odt' || row.node.ftype === 'ods' || row.node.ftype === 'odp'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 text-purple-500/70"><circle cx="12" cy="12" r="9" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 8.25h4.5a1.5 1.5 0 0 1 0 3h-4.5m3 3.75h-3" /></svg>
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 opacity-50"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                <span class="truncate flex-1">{{ row.node.name }}</span>
                <button
                  v-if="row.node.kind === 'file'"
                  class="hidden group-hover:block shrink-0 opacity-50 hover:opacity-100 hover:text-[#84cc16]"
                  :aria-label="t('file_rename')"
                  :data-hover-annotation="t('file_rename')"
                  data-hover-placement="right"
                  data-hover-source="file-control"
                  @click="renameTreeFile(row.node, $event)"
                  @dblclick.stop.prevent
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" /></svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        </div>
      </aside>

      <!-- Editor Section -->
      <section v-if="viewMode === 'split' && !largeDocumentPlainMode && !pdfView" class="card bg-base-100 shadow-xl border border-base-200 h-full flex flex-col relative group print:hidden">
         <div class="bg-base-200/30 p-2 text-xs font-bold text-base-content/40 uppercase tracking-widest text-center border-b border-base-200">{{ t('editor') }}</div>
         
         <div class="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden knote-source-scroll" ref="editorAreaRef" @scroll="handleScroll" @mouseleave="scheduleSplitHoverHide">
            <!-- Side Line Toolbar (Line Menu) -->
             <div
                v-if="toolbarVisible && toolbarMode === 'line'"
                ref="lineToolbarRef"
                class="absolute z-50 shadow-xl bg-base-100 border border-base-200 rounded-lg p-2 grid grid-cols-1 gap-1 min-w-[200px] line-toolbar"
                :style="{ top: `${toolbarTop}px`, left: `${toolbarLeft}px` }"
            >
                <!-- Context Aware Menu: Non-Empty Block -->
                <template v-if="selectedBlockData && selectedBlockData.raw.trim().length > 0">
                    <div class="text-xs font-bold opacity-50 px-2 py-1">{{ t('block_actions') }}</div>
                    
                    <!-- Bold Whole Line -->
                    <button 
                        v-if="getBlockBoldState(selectedBlockData) !== 'mixed'"
                        class="btn btn-sm btn-ghost justify-start" 
                        :class="{'text-primary bg-primary/10': getBlockBoldState(selectedBlockData) === 'full'}"
                        @mousedown.prevent
                        @click="toggleBlockBold(selectedBlockData)"
                    >
                        <span class="font-bold mr-2">B</span> {{ t('bold_line') }}
                    </button>

                    <!-- Convert to Heading -->
                    <div class="join w-full mt-1">
                        <button class="join-item btn btn-sm btn-ghost flex-1" :class="{'btn-active': headingLevelOf(selectedBlockData) === 1}" @mousedown.prevent @click="applyAction('h1')">H1</button>
                        <button class="join-item btn btn-sm btn-ghost flex-1" :class="{'btn-active': headingLevelOf(selectedBlockData) === 2}" @mousedown.prevent @click="applyAction('h2')">H2</button>
                        <button class="join-item btn btn-sm btn-ghost flex-1" :class="{'btn-active': headingLevelOf(selectedBlockData) === 3}" @mousedown.prevent @click="applyAction('h3')">H3</button>
                         <button class="join-item btn btn-sm btn-ghost flex-1" @mousedown.prevent @click="applyAction('p')" :title="t('paragraph')">¶</button>
                    </div>

                    <div class="divider my-1"></div>
                    
                    <button class="btn btn-sm btn-ghost justify-start" @mousedown.prevent @click="insertImageBelow()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2 opacity-70"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                        {{ t('insert_image_local') }}
                    </button>
                    <button class="btn btn-sm btn-ghost justify-start" @mousedown.prevent @click="insertImageByUrl()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2 opacity-70"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        {{ t('insert_image_url') }}
                    </button>
                    <button class="btn btn-sm btn-ghost justify-start" @mousedown.prevent @click="insertAttachmentBelow()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2 opacity-70"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        {{ t('insert_local_file') }}
                    </button>
                    <button class="btn btn-sm btn-ghost justify-start" @mousedown.prevent @click="insertLinkBelow()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="mr-2 opacity-70"><path d="M17 7h-4v2h4a3 3 0 0 1 0 6h-4v2h4a5 5 0 0 0 0-10zM7 7a5 5 0 0 0 0 10h4v-2H7a3 3 0 0 1 0-6h4V7H7zm1.5 4.25h7v1.5h-7z"/></svg>
                        {{ t('insert_link_in_place') }}
                    </button>
                     <button class="btn btn-sm btn-ghost justify-start" @mousedown.prevent @click="applyAction('table')">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2 opacity-70"><path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/></svg>
                        {{ t('table') }}
                    </button>
                     <button class="btn btn-sm btn-ghost justify-start text-error" @mousedown.prevent @click="clearBlockFormatting(selectedBlockData)">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2 opacity-70"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>
                        {{ t('clear_formatting') }}
                    </button>
                </template>

                <!-- Default Menu: Empty Block -->
                <template v-else>
                    <div class="text-xs font-bold opacity-50 px-2 py-1">{{ t('headings') }}</div>
                    <div class="join w-full">
                        <button class="join-item btn btn-sm btn-ghost flex-1" @mousedown.prevent @click="applyAction('h1')">H1</button>
                        <button class="join-item btn btn-sm btn-ghost flex-1" @mousedown.prevent @click="applyAction('h2')">H2</button>
                        <button class="join-item btn btn-sm btn-ghost flex-1" @mousedown.prevent @click="applyAction('h3')">H3</button>
                    </div>
                    
                    <div class="divider my-0"></div>
                    <div class="text-xs font-bold opacity-50 px-2 py-1">{{ t('lists_quote') }}</div>
                     <div class="grid grid-cols-4 gap-1">
                        <button class="btn btn-sm btn-ghost" @mousedown.prevent @click="applyAction('ul')" :title="t('bullet_list')">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" /></svg>
                        </button>
                         <button class="btn btn-sm btn-ghost" @mousedown.prevent @click="applyAction('ol')" :title="t('ordered_list')">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" /></svg>
                        </button>
                        <button class="btn btn-sm btn-ghost" @mousedown.prevent @click="applyAction('task')" :title="t('task_list')">☑</button>
                        <button class="btn btn-sm btn-ghost" @mousedown.prevent @click="applyAction('quote')" :title="t('quote')">“</button>
                    </div>

                    <div class="divider my-0"></div>
                    <div class="text-xs font-bold opacity-50 px-2 py-1">{{ t('insert') }}</div>
                    <button class="btn btn-sm btn-ghost justify-start" @mousedown.prevent @click="insertImageBelow()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2 opacity-70"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                        {{ t('insert_image_local') }}
                    </button>
                    <button class="btn btn-sm btn-ghost justify-start" @mousedown.prevent @click="insertImageByUrl()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2 opacity-70"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        {{ t('insert_image_url') }}
                    </button>
                    <button class="btn btn-sm btn-ghost justify-start" @mousedown.prevent @click="insertAttachmentBelow()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2 opacity-70"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        {{ t('insert_local_file') }}
                    </button>
                    <button class="btn btn-sm btn-ghost justify-start" @mousedown.prevent @click="insertLinkBelow()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="mr-2 opacity-70"><path d="M17 7h-4v2h4a3 3 0 0 1 0 6h-4v2h4a5 5 0 0 0 0-10zM7 7a5 5 0 0 0 0 10h4v-2H7a3 3 0 0 1 0-6h4V7H7zm1.5 4.25h7v1.5h-7z"/></svg>
                        {{ t('insert_link_in_place') }}
                    </button>
                    <button class="btn btn-sm btn-ghost justify-start" @mousedown.prevent @click="applyAction('table')">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2 opacity-70"><path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/></svg>
                        {{ t('table') }}
                    </button>
                    <button class="btn btn-sm btn-ghost justify-start" @mousedown.prevent @click="applyAction('codeblock')">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2 opacity-70"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>
                        {{ t('code_block') }}
                    </button>
                    <button class="btn btn-sm btn-ghost justify-start" @mousedown.prevent @click="applyAction('link')">
                         <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2 opacity-70"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                         Link
                    </button>
                    <button class="btn btn-sm btn-ghost justify-start" @mousedown.prevent @click="applyAction('hr')">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2 opacity-70"><path d="M5 12h14"/></svg>
                        {{ t('divider') }}
                    </button>
                </template>
            </div>

            <!-- Heading highlight layer + the transparent source textarea share
                 ONE content-height stack inside this single scroll container
                 (issue #16 refactor). Because both layers live in the same stack,
                 they scroll as a unit: no JS scroll mirror, no second scrollbar,
                 no lag, and they can never drift out of phase. -->
            <div class="knote-source-stack" @mousedown="onSourceStackMousedown">
              <pre
                  ref="sourceHighlightRef"
                  aria-hidden="true"
                  class="knote-source-highlight font-mono text-base leading-relaxed tracking-normal"
                  v-html="sourceHighlightHtml"
              ></pre>
              <textarea
                  ref="textareaRef"
                  v-model="content"
                  data-testid="markdown-source-editor"
                  class="textarea textarea-ghost w-full resize-none p-6 text-base leading-relaxed focus:outline-none focus:bg-base-100/50 font-mono tracking-normal knote-source-text"
                  spellcheck="false"
                  :placeholder="t('type_placeholder')"
                  @mouseup="handleSelectionChange"
                  @keyup="handleSelectionChange"
                  @keydown="handleTextareaKeydown"
                  @input="cancelSessionRestoreForForegroundIntent(); handleSelectionChange()"
                  @paste="handleEditorPaste"
                  @mousemove="handleMouseMove"
                  @mouseleave="hideLineButton"
              ></textarea>
            </div>
         </div>
      </section>

      <!-- Preview Section -->
      <section
        v-show="viewMode === 'split' || viewMode === 'single'"
        class="card bg-base-100 shadow-xl border border-base-200 h-full flex flex-col relative knote-editor-column"
        :class="[(viewMode === 'single' || largeDocumentPlainMode) ? 'flex-1 min-w-0' : '', (pdfView || docPreviewHtml) ? 'min-h-0 overflow-hidden' : '']"
      >
         <div class="bg-base-200/30 p-2 text-xs font-bold text-base-content/40 uppercase tracking-widest text-center border-b border-base-200 flex items-center justify-center gap-2">
           <span>{{ viewMode === 'single' || largeDocumentPlainMode ? t('editor') : t('preview') }}</span>
           <div v-if="viewMode === 'split' && largeDocumentPlainMode" class="ml-auto flex items-center gap-1 tabular-nums normal-case tracking-normal">
             <button
               class="btn btn-ghost btn-xs btn-square border border-base-200"
               :disabled="largeSourcePage <= 0"
               :aria-label="lang === 'zh' ? '上一段' : 'Previous chunk'"
               @click="openLargeSourcePage(largeSourcePage - 1)"
             >‹</button>
             <select
               data-testid="large-split-page-select"
               class="select select-bordered select-xs w-24 h-6 px-1 text-center"
               :value="String(largeSourcePage)"
               :aria-label="lang === 'zh' ? '选择文档分段' : 'Choose document chunk'"
               @change="openLargeSourcePage(Number($event.target.value))"
             >
               <option v-for="pageIndex in largeSourcePageCount" :key="pageIndex" :value="String(pageIndex - 1)">
                 {{ pageIndex }} / {{ largeSourcePageCount }}
               </option>
             </select>
             <button
               class="btn btn-ghost btn-xs btn-square border border-base-200"
               :disabled="largeSourcePage >= largeSourcePageCount - 1"
               :aria-label="lang === 'zh' ? '下一段' : 'Next chunk'"
               @click="openLargeSourcePage(largeSourcePage + 1)"
             >›</button>
           </div>
         </div>

         <!-- Read-only PDF viewer: overlays the editor/preview with the whole
              document (all pages), scroll + zoom, no editing -->
         <div v-if="pdfView" data-testid="pdf-viewer" class="absolute inset-0 z-[60] min-h-0 overflow-hidden flex flex-col bg-base-200 print:hidden">
           <div class="flex items-center gap-2 px-3 h-9 shrink-0 border-b border-base-200 bg-base-100">
             <svg class="w-3.5 h-3.5 shrink-0 text-rose-500/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg>
             <span class="text-xs font-semibold text-base-content/80 truncate flex-1 min-w-0" :title="pdfView.name">{{ pdfView.name }}</span>
             <span class="text-[11px] text-base-content/40 tabular-nums shrink-0">{{ pdfPageNum }}<template v-if="pdfNumPages">/{{ pdfNumPages }}</template> {{ t('pdf_pages') }}</span>
             <span class="text-[10px] px-1.5 py-0.5 rounded bg-base-200 text-base-content/45 shrink-0">{{ t('pdf_readonly') }}</span>
              <div class="flex items-center gap-0.5 shrink-0">
                <button class="btn btn-xs btn-ghost btn-square" :title="t('pdf_zoom_out')" :aria-label="t('pdf_zoom_out')" @click="pdfZoom(-1)"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg></button>
                 <span data-testid="pdf-scale" class="text-[11px] tabular-nums w-9 text-center text-base-content/50 select-none">{{ pdfScalePct }}%</span>
                <button class="btn btn-xs btn-ghost btn-square" :title="t('pdf_zoom_in')" :aria-label="t('pdf_zoom_in')" @click="pdfZoom(1)"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
              </div>
              <button data-testid="pdf-close" class="btn btn-xs btn-ghost btn-square ml-0.5" :title="t('pdf_close')" :aria-label="t('pdf_close')" @click="closePdfView()"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
            </div>
             <!-- Official pdf.js multi-page PDFViewer in a Shadow DOM: canvas,
                  selectable text, scrolling and pointer-anchored zoom stay local -->
            <PdfViewerHost
              ref="pdfHostRef"
              class="flex-1 min-h-0"
               @ready="onPdfReady"
               @pagechange="onPdfPageChange"
               @scalechange="onPdfScaleChange"
               @error="onPdfError"
            />
           </div>

           <!-- Read-only doc preview (docx/pptx/xlsx/txt...): rendered HTML overlay,
              similar to PDF viewer but with styled text instead of page images -->
           <div v-if="docPreviewHtml" class="absolute inset-0 z-30 flex flex-col bg-base-100 print:hidden">
           <div class="flex items-center gap-2 px-3 h-9 shrink-0 border-b border-base-200 bg-base-100">
             <span class="text-xs font-semibold text-base-content/80 truncate flex-1 min-w-0">{{ currentFileName }}</span>
             <span class="text-[10px] px-1.5 py-0.5 rounded bg-base-200 text-base-content/45 shrink-0">只读</span>
             <button class="btn btn-xs btn-ghost btn-square" @click="closeDocPreview()"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
           </div>
           <div class="flex-1 overflow-auto py-6 px-8 bg-base-200/50">
             <div class="knote-doc-preview max-w-[210mm] mx-auto bg-white shadow-lg rounded-sm" style="min-height:80vh" v-html="docPreviewHtml"></div>
           </div>
           </div>

           <!-- Folder workspace open but no file chosen yet -->
         <div v-if="folderHandle && !currentFileName && !pdfView && !docPreviewHtml" class="absolute inset-0 top-[37px] z-[45] flex flex-col items-center justify-center gap-3 bg-base-100 text-center px-8 print:hidden">
           <svg class="w-14 h-14 text-base-content/15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
           <p class="text-base-content/60 text-sm font-medium">{{ t('folder_pick_prompt') }}</p>
           <p class="text-base-content/35 text-xs">{{ t('folder_pick_hint') }}</p>
            <button data-testid="new-document-cta" class="btn btn-sm knote-new-document-cta gap-1.5 mt-1" @click="createMdFile()">
             <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
             {{ t('file_new') }}
           </button>
         </div>

         <!-- Local relative-path images can't be resolved: a single file opened
              via the browser picker has no directory handle. Offer a one-click
              folder grant (the only way the browser exposes a directory). -->
         <div v-if="relImagesNeedGrant" class="knote-relimg-banner print:hidden">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M21 15l-5-5L5 21"/><path d="M3 5h18v14H3z"/><circle cx="8.5" cy="8.5" r="1.5"/></svg>
           <span class="flex-1">{{ t('relimg_banner') }}</span>
           <button class="knote-relimg-btn" @click="grantImageFolder">{{ t('relimg_grant') }}</button>
           <button class="knote-relimg-x" :title="t('relimg_dismiss')" @click="relImagesNeedGrant = false">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
           </button>
         </div>

         <!-- Dangling knote-img refs: the document points at session-local image
              IDs whose data was never saved with it (written out through the
              compact form outside Knote's inlining export). Flag it instead of
              showing silent blank images. -->
         <div v-if="missingImageCount > 0 && !missingImgDismissed" class="knote-relimg-banner print:hidden">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M21 15l-5-5L5 21"/><path d="M3 5h18v14H3z"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m2 2 20 20"/></svg>
           <span class="flex-1">{{ t('missing_img_banner').replace('{n}', missingImageCount) }}</span>
           <button class="knote-relimg-x" :title="t('missing_img_dismiss')" @click="missingImgDismissed = true">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
           </button>
         </div>

         <!-- Find / replace bar (Ctrl+F / Ctrl+H) -->
         <div v-if="findState.open" class="knote-findbar print:hidden">
           <div class="knote-findbar-row">
             <input
               ref="findInputRef"
               v-model="findState.query"
               :placeholder="t('find_placeholder')"
               @keydown="onFindKeydown"
             />
             <span class="knote-findbar-count">{{ findState.query ? (findState.count ? `${findState.active + 1}/${findState.count}` : t('find_none')) : '' }}</span>
             <button class="knote-findbar-btn" :title="t('find_prev')" @click="findStep(-1)">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
             </button>
             <button class="knote-findbar-btn" :title="t('find_next')" @click="findStep(1)">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
             </button>
             <button class="knote-findbar-btn is-text" :class="{ 'is-on': findState.caseSensitive }" :title="t('find_case')" @click="findState.caseSensitive = !findState.caseSensitive">Aa</button>
             <button class="knote-findbar-btn is-text" :class="{ 'is-on': findState.wholeWord }" :title="t('find_word')" @click="findState.wholeWord = !findState.wholeWord">W</button>
             <button class="knote-findbar-btn" :class="{ 'is-on': findState.replace }" :title="t('find_toggle_replace')" @click="findState.replace = !findState.replace">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8M4 20l6-6M4 14v6h6"/></svg>
             </button>
             <button class="knote-findbar-btn" :title="t('find_close')" @click="closeFind">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
             </button>
           </div>
           <div v-if="findState.replace" class="knote-findbar-row">
             <input
               v-model="findState.replacement"
               :placeholder="t('replace_placeholder')"
               @keydown.enter.prevent="replaceOne"
               @keydown.esc.prevent="closeFind"
             />
             <button class="knote-findbar-btn is-text" :title="t('find_replace_one')" @click="replaceOne">↹</button>
             <button class="knote-findbar-btn is-text" style="width:auto;padding:0 8px" :title="t('find_replace_all')" @click="replaceAll">{{ t('find_replace_all') }}</button>
           </div>
         </div>

         <!-- v-if (not v-show): a hidden preview would still re-render its
              markdown-it HTML on every content change while typing in
              single mode — pure wasted work that grows with the document -->
         <div
           v-if="viewMode === 'split' && !largeDocumentPlainMode"
           ref="splitPreviewRef"
           data-testid="markdown-full-preview"
           class="knote-split-preview relative flex-1 min-h-0 bg-base-100 p-6 overflow-y-auto overflow-x-hidden"
           @scroll="handleSplitPreviewScroll"
           @mousemove="handleSplitPreviewMouseMove"
           @mouseleave="scheduleSplitHoverHide"
         >
             <div class="knote-md-render prose prose-sm md:prose-base dark:prose-invert max-w-none break-words" v-html="renderedHtml" @click="onPreviewLinkClick"></div>
         </div>

         <!-- Structurally large documents keep exactly one bounded TipTap
              chunk mounted. Markdown remains whole in `content`; changing
              chunks commits the current fragment before taking ownership. -->
         <div
           v-if="largeDocumentPlainMode && !pdfView"
           v-show="!largeDocumentLoading"
           data-testid="large-document-rich-mode"
           class="flex-1 min-h-0 flex flex-col bg-base-100"
           :aria-busy="largeDocumentLoading ? 'true' : 'false'"
         >
            <RichEditor
              ref="largeRichEditorRef"
              v-model="largeRichMarkdown"
              data-testid="large-document-rich-chunk"
              :content-key="largeSourceEditorVersion"
              :active="true"
               class="knote-rich-editor-bounded flex-1 min-h-0"
               :t="t"
               :render-md="renderMarkdownHtml"
               :attachment-dir="currentDocDirPath()"
              :placeholder="t('type_placeholder')"
              :prompt-text="promptInput"
              :insert-attachment-dialog="openAttachmentInsertDialog"
              @localchange="cancelSessionRestoreForForegroundIntent"
              @rowchange="commitLargeSourceDraft('row-change'); flushAutoSave()"
              @commit="commitLargeSourceDraft('rich-commit'); flushAutoSave()"
              @askagent="onAskAgent"
              @ctxmenu="(p) => openCtxMenu(p.x, p.y, p.items)"
              @viewimage="openImageViewer"
            />
          </div>

         <RichEditor
            v-else
            v-show="viewMode === 'single' && !pdfView && !docPreviewHtml"
            ref="richEditorRef"
            v-model="richEditorModel"
            @localchange="cancelSessionRestoreForForegroundIntent"
            :active="viewMode === 'single'"
             class="flex-1 min-h-0"
             :t="t"
              :render-md="renderMarkdownHtml"
             :attachment-dir="currentDocDirPath()"
            :placeholder="t('type_placeholder')"
            :prompt-text="promptInput"
            :insert-attachment-dialog="openAttachmentInsertDialog"
            @rowchange="flushAutoSave"
           @commit="flushAutoSave"
            @askagent="onAskAgent"
            @ctxmenu="(p) => openCtxMenu(p.x, p.y, p.items)"
            @viewimage="openImageViewer"
         />
         <div
           v-if="viewMode === 'single' && largeDocumentLoading"
           data-testid="large-document-loading"
           class="absolute inset-0 top-[37px] z-[55] flex flex-col items-center justify-center gap-3 bg-base-100/92 backdrop-blur-[2px] text-center print:hidden"
         >
           <span class="loading loading-spinner loading-md text-[#84cc16]"></span>
           <div class="text-sm font-semibold text-base-content/70">
             {{ lang === 'zh' ? '正在准备超长文档…' : 'Preparing the large document…' }}
           </div>
           <div class="text-xs text-base-content/40">
             {{ lang === 'zh' ? '界面已就绪，编辑器将在下一帧载入' : 'The workspace is ready; the editor loads on the next frame' }}
           </div>
         </div>
      </section>

      <!-- Right assistant sidebar (Req 2): occupies the far-right slot in single+
           centered mode — exactly where the centered ::after spacer sat. Its width
           equals --knote-sidebar-width, so the editor stays centered with no shift.
           Sticky + self-start + a viewport-capped height pin the whole rail at a fixed
           on-screen spot (mirrors the left rail): the editor column scrolls beneath it
           while the rail — and its header/composer — stay put instead of stretching to
           the document's full height. The chat scrolls internally inside AgentPanel. -->
      <aside v-if="showAgentSidebar" data-testid="agent-sidebar"
        class="knote-agent-sidebar hidden lg:flex flex-col shrink-0 min-h-0 print:hidden sticky top-4 self-start h-[calc(100vh-5rem)]">
        <AgentPanel mode="sidebar" :t="t" :render-md="renderAgentMd" :show-app-dialog="showAgentCapabilityDialog" :request-app-dialog="requestAgentAppDialog" @tofloat="onAgentSidebarToFloat" @ctxmenu="(p) => openCtxMenu(p.x, p.y, p.items)" />
      </aside>

      <section
        v-if="viewMode === 'split' && largeDocumentPlainMode && !pdfView"
        data-testid="large-document-split-preview"
        class="card bg-base-100 shadow-xl border border-base-200 h-full min-w-0 flex flex-col relative"
      >
        <div class="bg-base-200/30 p-2 text-xs font-bold text-base-content/40 uppercase tracking-widest text-center border-b border-base-200">{{ t('preview') }}</div>
        <div data-testid="large-document-chunk-preview" class="relative flex-1 bg-base-100 p-6 overflow-y-auto overflow-x-hidden">
          <div class="knote-md-render prose prose-sm md:prose-base dark:prose-invert max-w-none break-words" v-html="largeRenderedHtml" @click="onPreviewLinkClick"></div>
        </div>
      </section>

    </main>

    <!-- Split view: single "locate" button on the hovered line (viewport-fixed, one pane
         at a time). Clicking scrolls the OTHER pane so this line lands level with where
         it sits here. No `title` — the native hover tooltip just repeated the action. -->
    <button
      v-if="splitHoverBtn"
      ref="splitHoverRef"
      type="button"
      class="knote-split-locate fixed z-[1200] btn btn-sm btn-ghost btn-square bg-base-100 border border-base-200 rounded-lg shadow-xl print:hidden"
      :style="{ top: splitHoverBtn.top + 'px', left: splitHoverBtn.left + 'px' }"
      :aria-label="t('locate')"
      @mouseenter="keepSplitHover"
      @mouseleave="scheduleSplitHoverHide"
      @mousedown.prevent
      @click="locateOtherPane(splitHoverBtn.pane, splitHoverBtn.line)"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/></svg>
    </button>

    <!-- Split view: selection bubble. One row of AI actions shared by both panes,
         reusing the single-pane .selection-toolbar style. -->
    <div
      v-if="splitSelBubble"
      ref="splitBubbleRef"
      class="knote-bubble fixed z-[1200] flex flex-col shadow-xl rounded-2xl toolbar-glow isolate whitespace-nowrap selection-toolbar print:hidden"
      :class="splitSelBubble.below ? '' : 'transform -translate-y-full'"
      :style="{ top: splitSelBubble.top + 'px', left: splitSelBubble.left + 'px' }"
    >
      <!-- AI actions on the selection: one row shared by both panes (the agent
           edits the source Markdown via tools either way). The editing row was
           dropped; rich marks do not map onto a plain Markdown textarea, and the
           floating hover button already covers locate. -->
      <div class="flex items-stretch h-9">
        <button class="btn btn-ghost btn-sm flex-1 rounded-none rounded-l-2xl h-full px-2 text-xs gap-1 text-[#84cc16] font-bold" @mousedown.prevent @click="splitBubbleAgent('ask')">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09L18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z"/></svg>
          {{ t('ai_ask') }}
        </button>
        <button class="btn btn-ghost btn-sm flex-1 rounded-none h-full px-2 text-xs" @mousedown.prevent @click="splitBubbleAgent('polish')">{{ t('ai_polish') }}</button>
        <button class="btn btn-ghost btn-sm flex-1 rounded-none h-full px-2 text-xs" @mousedown.prevent @click="splitBubbleAgent('translate')">{{ t('ai_translate') }}</button>
        <button class="btn btn-ghost btn-sm flex-1 rounded-none h-full px-2 text-xs" @mousedown.prevent @click="splitBubbleAgent('expand')">{{ t('ai_expand') }}</button>
        <button class="btn btn-ghost btn-sm flex-1 rounded-none rounded-r-2xl h-full px-2 text-xs" @mousedown.prevent @click="splitBubbleAgent('condense')">{{ t('ai_condense') }}</button>
      </div>
    </div>

    <nav v-if="isAndroidCompact" class="knote-mobile-nav print:hidden" :aria-label="lang === 'zh' ? '移动端导航' : 'Mobile navigation'">
      <button
        data-testid="mobile-nav-files"
        :class="{ 'is-active': mobileFilesOpen }"
        :aria-current="mobileFilesOpen ? 'page' : undefined"
        @click="openMobileFiles"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>
        <span>{{ t('files') }}</span>
      </button>
      <button
        data-testid="mobile-nav-editor"
        :class="{ 'is-active': !mobileFilesOpen && !agentOpen }"
        :aria-current="!mobileFilesOpen && !agentOpen ? 'page' : undefined"
        @click="openMobileEditor"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg>
        <span>{{ t('editor') }}</span>
      </button>
      <button
        data-testid="mobile-nav-agent"
        :class="{ 'is-active': agentOpen }"
        :aria-current="agentOpen ? 'page' : undefined"
        @click="openMobileAgent"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="8.4"/><ellipse cx="12" cy="12.5" rx="3.5" ry="4"/><path stroke-linecap="round" stroke-linejoin="round" d="M12 5.7v1.6M12 17.7v1.6M17.2 12.5h1.6M5.2 12.5h1.6M15.7 16.2l1.1 1.1M8.3 16.2l-1.1 1.1M8.3 8.8l-1.1-1.1M15.7 8.8l1.1-1.1"/></svg>
        <span>{{ t('agent') }}</span>
      </button>
    </nav>

    <!-- Agent floating ball + window (drag the ball to move the dock). Hidden while
         the right sidebar is live — the two surfaces are mutually exclusive. -->
    <div
      v-if="showAgentFloatDock"
      class="knote-agent-dock fixed z-[2400] print:hidden flex items-end gap-3"
      :class="[dockPanelBelow ? 'flex-col-reverse' : 'flex-col', { 'bottom-6 right-6': !agentDockPos }]"
      :style="dockStyle"
    >
      <!-- WRAPPER holds the size + the resize handles; it does NOT clip, so a
           handle's glow can sit ON the window's outer border edge. The inner
           panel does the rounding/clipping. -->
      <div
        v-show="agentOpen"
        class="knote-agent-window relative max-w-[calc(100vw-3rem)] max-h-[85vh]"
        :class="[agentResized ? '' : (agentWorkspaceOpen ? 'w-[40rem] h-[36rem]' : 'w-[26rem] h-[36rem]'), { 'transition-[width] duration-200': !agentResized }]"
        :style="agentPanelStyle"
      >
        <div class="w-full h-full card bg-base-100 border border-base-200 shadow-2xl rounded-2xl overflow-hidden">
          <AgentPanel mode="float" :t="t" :render-md="renderAgentMd" :show-app-dialog="showAgentCapabilityDialog" :request-app-dialog="requestAgentAppDialog" @ctxmenu="(p) => openCtxMenu(p.x, p.y, p.items)" />
        </div>
        <!-- four CORNER resize handles: hover reveals a rounded pale-yellow glow
             straddling the border corner; drag to resize (opposite corner fixed) -->
        <div class="knote-rsz knote-rsz-nw" @pointerdown="onAgentResizeDown('nw', $event)"><i></i></div>
        <div class="knote-rsz knote-rsz-ne" @pointerdown="onAgentResizeDown('ne', $event)"><i></i></div>
        <div class="knote-rsz knote-rsz-sw" @pointerdown="onAgentResizeDown('sw', $event)"><i></i></div>
        <div class="knote-rsz knote-rsz-se" @pointerdown="onAgentResizeDown('se', $event)"><i></i></div>
        <!-- left/right side bars (width resize) — a thin rounded glow bar centered
             on each side edge -->
        <div class="knote-rsz knote-rsz-w" @pointerdown="onAgentResizeDown('w', $event)"><i></i></div>
        <div class="knote-rsz knote-rsz-e" @pointerdown="onAgentResizeDown('e', $event)"><i></i></div>
        <!-- restore default size (appears only after a resize) -->
        <button
          v-if="agentResized"
          class="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 z-[46] flex items-center gap-1 px-2.5 h-6 rounded-full bg-base-100/95 border border-base-300 shadow-md text-[11px] whitespace-nowrap text-base-content/70 hover:text-[#4d7c0f] hover:border-[#84cc16]/50 transition-colors"
          :title="t('agent_reset_size')"
          @click="resetAgentSize"
        >
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          {{ t('agent_reset_size') }}
        </button>
      </div>
      <!-- Animated pixel-kiwi assistant (replaces the plain green ball): its
           state reflects real agent activity; drag to move, click to open chat -->
      <KiwiMascot
        :state="mascotState"
        :message="mascotMessage"
        :t="t"
        :grab="onAgentBallDown"
        :hover-annotation="t('agent')"
        data-testid="agent-mascot"
        :data-agent-state="mascotState"
      />
    </div>

    <!-- float→sidebar drop indicator (Req 4): a frosted green glow pinned to the
         right-center edge. It appears while the dragged ball nears the edge and
         turns "hot" inside the release band. pointer-events:none — purely visual. -->
    <Transition name="kagentdrop">
      <div v-if="agentDropZoneVisible" class="knote-agent-dropzone fixed z-[2300] print:hidden"
           :class="{ 'is-hot': agentDropZoneActive }"
           :style="agentDropZoneStyle" aria-hidden="true">
        <div class="knote-agent-dropzone-inner knote-agent-drop">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="8.4"/><ellipse cx="12" cy="12.5" rx="3.5" ry="4"/><path stroke-linecap="round" stroke-linejoin="round" d="M12 5.7v1.6M12 17.7v1.6M17.2 12.5h1.6M5.2 12.5h1.6M15.7 16.2l1.1 1.1M8.3 16.2l-1.1 1.1M8.3 8.8l-1.1-1.1M15.7 8.8l1.1-1.1"/></svg>
          <span>{{ t('assistant_drop_hint') }}</span>
        </div>
      </div>
    </Transition>

    <!-- Agent review bar: proposals stay visible while their owner or
         post-owner reviewer holds the exact review lock. -->
    <div
      v-if="pendingHunksForCurrentDocument.length"
      data-testid="agent-review-bar"
      :data-review-locked="pendingHunksReviewLocked ? 'true' : 'false'"
      :aria-busy="pendingHunksReviewLocked"
      :title="pendingHunksReviewLocked ? t('agent_review_locked') : pendingHunksReviewReason"
      class="knote-agent-review-bar fixed bottom-5 left-1/2 -translate-x-1/2 z-[2600] flex max-w-[calc(100vw-1rem)] items-center gap-2 pl-4 pr-1.5 py-1.5 rounded-full bg-base-100/95 text-base-content backdrop-blur border shadow-xl print:hidden"
    >
      <span class="knote-agent-review-pulse w-2 h-2 rounded-full animate-pulse"></span>
      <span class="knote-agent-review-count text-sm font-medium whitespace-nowrap">{{ pendingHunksForCurrentDocument.length }} {{ t('agent_hunks_pending') }}</span>
      <span v-if="pendingHunksReviewReason" data-testid="agent-review-reason" class="knote-agent-review-reason max-w-72 truncate text-[10px] text-warning">{{ pendingHunksReviewReason }}</span>
      <button data-testid="agent-reject-all" class="btn btn-xs btn-ghost rounded-full" :disabled="pendingHunksReviewLocked" @click="rejectAllHunks()">{{ t('agent_reject_all') }}</button>
      <button data-testid="agent-accept-all" class="knote-agent-review-accept btn btn-xs rounded-full px-3" :disabled="pendingHunksReviewLocked" @click="acceptAllHunks()">{{ t('agent_accept_all') }}</button>
    </div>

    <!-- Transient agent notice (e.g. stale review batch discarded) -->
    <div
      v-if="agentNotice"
      class="fixed bottom-16 left-1/2 -translate-x-1/2 z-[1100] px-4 py-2 rounded-full bg-base-content/90 text-base-100 text-xs shadow-lg print:hidden"
    >{{ agentNotice }}</div>

    <!-- One app-level hover annotation; the legacy class keeps the existing
         white visual/animation while data-placement exposes directional hooks. -->
    <div
      v-if="hoverAnnotation"
      :key="hoverAnnotation.key"
      ref="hoverAnnotationRef"
      data-testid="link-tooltip"
      class="knote-link-tooltip knote-hover-annotation"
      role="tooltip"
      :aria-label="hoverAnnotation.text"
      :data-placement="hoverAnnotation.placement"
      :data-source="hoverAnnotation.source"
      :style="{ left: hoverAnnotation.x + 'px', top: hoverAnnotation.y + 'px' }"
    ><span class="knote-hover-annotation-text">{{ hoverAnnotation.text }}</span></div>

    <!-- Insert-attachment floating window: destination folder (restricted to
         the document's file tree) and source file are chosen together; the
         folder is remembered on disk for the next insert -->
    <div
      v-if="attachState"
      data-testid="attach-dialog"
      class="fixed inset-0 z-[2000] flex items-center justify-center bg-base-content/25 backdrop-blur-[1px] print:hidden"
      @mousedown.self="cancelAttachInsert"
      @keydown.esc="cancelAttachInsert"
    >
      <div class="bg-base-100 border border-base-200 rounded-2xl shadow-2xl p-5 w-[26rem] max-w-[92vw] space-y-4">
        <div class="text-sm font-bold flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="opacity-60"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          {{ t('attach_insert_title') }}
        </div>

        <div class="space-y-1">
          <div class="text-xs font-semibold opacity-60">{{ t('attach_target_folder') }}</div>
          <div class="flex gap-1.5">
            <select
              v-model="attachState.folder"
              data-testid="attach-folder-select"
              class="select select-sm select-bordered flex-1 min-w-0 font-mono text-xs"
            >
              <option
                v-for="f in attachState.folders"
                :key="f.abs"
                :value="f.abs"
              >{{ f.rel === '.' ? t('attach_doc_root') : f.rel }}</option>
            </select>
          </div>
          <div class="flex gap-1.5">
            <button
              class="btn btn-xs btn-ghost border border-base-300"
              data-testid="attach-new-folder"
              @mousedown.prevent
              @click="attachNewFolder"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="opacity-70"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6"/><path d="M9 14h6"/></svg>
              {{ t('attach_new_folder') }}
            </button>
            <button
              class="btn btn-xs btn-ghost border border-base-300"
              data-testid="attach-rename-folder"
              :disabled="!attachState.folder || attachState.folder === attachState.dir.replace(/[\\/]$/, '')"
              @mousedown.prevent
              @click="attachRenameFolder"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="opacity-70"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>
              {{ t('attach_rename_folder') }}
            </button>
          </div>
        </div>

        <div class="space-y-1">
          <div class="text-xs font-semibold opacity-60">{{ t('attach_source_file') }}</div>
          <div class="flex items-center gap-2">
            <button
              class="btn btn-sm btn-ghost border border-base-300 shrink-0"
              data-testid="attach-pick-source"
              @mousedown.prevent
              @click="pickImportSource"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="opacity-70"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <span class="font-mono text-xs">{{ attachState.source ? attachState.sourceName : t('attach_pick_file') }}</span>
            </button>
            <span v-if="attachState.source" class="text-[11px] opacity-50 truncate flex-1">{{ attachState.sourceName }}</span>
          </div>
        </div>

        <div class="text-[11px] opacity-50 flex items-center gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
          {{ t('attach_folder_note') }}
        </div>

        <div class="flex justify-end gap-2">
          <button data-testid="attach-cancel" class="btn btn-sm btn-ghost" @click="cancelAttachInsert">{{ t('dlg_cancel') }}</button>
          <button
            data-testid="attach-confirm"
            class="btn btn-sm text-white border-none disabled:opacity-40 disabled:cursor-not-allowed"
            style="background:#84cc16"
            :disabled="!attachState.source"
            @click="confirmAttachInsert"
          >{{ t('attach_confirm') }}</button>
        </div>
      </div>
    </div>

    <!-- In-app text prompt (replaces window.prompt, which the Electron shell
         does not support) -->
    <Teleport to="body">
      <div
        v-if="promptState"
        data-testid="app-dialog"
        :data-dialog-mode="promptState.mode || 'prompt'"
        :data-dialog-id="promptState.id"
        :data-dialog-owner="promptState.owner"
        :data-dialog-tone="promptState.tone || null"
        :role="promptState.mode === 'alert' ? 'alertdialog' : 'dialog'"
        aria-modal="true"
        :aria-label="promptState.title"
        class="fixed inset-0 z-[11000] flex items-center justify-center bg-base-content/25 print:hidden"
        :class="promptState.mode === 'alert' ? 'backdrop-blur-[8px]' : 'backdrop-blur-[1px]'"
        @mousedown.self="resolvePrompt(false)"
        @keydown.esc.prevent="resolvePrompt(false)"
      >
        <div class="knote-app-dialog-card" :class="promptState.mode === 'alert' ? `is-alert is-${promptState.tone || 'partial'}` : ''">
          <div v-if="promptState.mode === 'alert'" class="knote-app-dialog-alert-icon" aria-hidden="true">
            <svg v-if="promptState.tone === 'success'" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>
            <svg v-else viewBox="0 0 24 24"><path d="M12 8v5m0 3h.01"/><circle cx="12" cy="12" r="9"/></svg>
          </div>
          <div class="knote-app-dialog-title">{{ promptState.title }}</div>
          <p v-if="promptState.message" data-testid="app-dialog-message" class="knote-app-dialog-message">{{ promptState.message }}</p>
          <input
            v-if="promptState.mode === 'prompt'"
            ref="promptInputRef"
            v-model="promptState.value"
            type="text"
            class="input input-sm input-bordered w-full"
            @keydown.enter.prevent="resolvePrompt(true)"
            @keydown.esc.stop.prevent="resolvePrompt(false)"
          />
          <div class="flex justify-end gap-2 pt-1">
            <button v-if="promptState.mode !== 'alert'" data-testid="app-dialog-cancel" class="btn btn-sm btn-ghost" @click="resolvePrompt(false)">{{ t('dlg_cancel') }}</button>
            <button
              ref="promptAcceptRef"
              data-testid="app-dialog-accept"
              class="knote-dialog-brand-action btn btn-sm"
              @click="resolvePrompt(true)"
            >{{ t('dlg_ok') }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Header create actions choose an explicit workspace destination first. -->
    <div
      v-if="createState"
      ref="createDialogRef"
      data-testid="create-target-dialog"
      class="fixed inset-0 z-[2100] flex items-center justify-center bg-base-content/25 backdrop-blur-[1px] print:hidden"
      role="dialog"
      aria-modal="true"
      :aria-label="t(createState.kind === 'folder' ? 'create_target_title_folder' : 'create_target_title_file')"
      tabindex="-1"
      @mousedown.self="closeCreateTarget"
      @keydown.esc.stop.prevent="closeCreateTarget"
    >
      <div class="bg-base-100 border border-base-200 rounded-2xl shadow-2xl p-5 w-96 max-w-[92vw] space-y-3">
        <div>
          <div class="text-sm font-bold">{{ t(createState.kind === 'folder' ? 'create_target_title_folder' : 'create_target_title_file') }}</div>
          <p class="mt-1 text-xs text-base-content/50">{{ t('create_target_hint') }}</p>
        </div>
        <div class="max-h-72 overflow-auto -mx-1" role="radiogroup">
          <button
            v-for="destination in createDestinations"
            :key="destination.path || '__root'"
            type="button"
            data-testid="create-target-option"
            :data-target-path="destination.path"
            role="radio"
            :aria-checked="createState.targetPath === destination.path"
            class="w-full flex items-center gap-2 text-left text-xs px-2 py-1.5 rounded-lg border border-transparent hover:bg-[#84cc16]/10"
            :class="createState.targetPath === destination.path ? 'bg-[#84cc16]/10 border-[#84cc16]/25 text-[#4d7c0f] font-semibold' : 'text-base-content/75'"
            :style="{ paddingLeft: `${10 + destination.depth * 14}px` }"
            @click="createState.targetPath = destination.path"
            @dblclick="confirmCreateTarget"
          >
            <svg class="w-3.5 h-3.5 shrink-0 text-[#eab308]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span class="truncate">{{ destination.label }}</span>
            <svg v-if="createState.targetPath === destination.path" class="ml-auto w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="m5 12 4 4L19 6"/></svg>
          </button>
        </div>
        <div class="flex justify-end gap-2">
          <button data-testid="create-target-cancel" class="btn btn-sm btn-ghost" @click="closeCreateTarget">{{ t('dlg_cancel') }}</button>
          <button data-testid="create-target-confirm" class="knote-dialog-brand-action btn btn-sm" @click="confirmCreateTarget">{{ t('create_target_confirm') }}</button>
        </div>
      </div>
    </div>

    <!-- Move file/folder: destination picker -->
    <div
      v-if="moveState"
      data-testid="move-dialog"
      class="fixed inset-0 z-[2000] flex items-center justify-center bg-base-content/25 backdrop-blur-[1px] print:hidden"
      @mousedown.self="moveState = null"
      @keydown.esc="moveState = null"
    >
      <div class="bg-base-100 border border-base-200 rounded-2xl shadow-2xl p-5 w-96 max-w-[92vw] space-y-3">
        <div class="text-sm font-bold truncate">{{ t('move_title') }}「{{ moveState.node.name }}」</div>
        <div class="max-h-72 overflow-auto -mx-1">
          <button
            v-for="d in moveDestinations"
            :key="d.path || '__root'"
            data-testid="move-destination"
            class="w-full flex items-center gap-2 text-left text-xs px-2 py-1.5 rounded-lg hover:bg-[#84cc16]/10 hover:text-base-content text-base-content/75"
            :style="{ paddingLeft: `${10 + d.depth * 14}px` }"
            @click="performMove(d)"
          >
            <svg class="w-3.5 h-3.5 shrink-0 text-[#eab308]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span class="truncate">{{ d.label }}</span>
          </button>
          <div v-if="!moveDestinations.length" class="px-2 py-3 text-xs text-base-content/40">{{ t('move_none') }}</div>
        </div>
        <div class="flex justify-end">
          <button data-testid="move-cancel" class="btn btn-sm btn-ghost" @click="moveState = null">{{ t('dlg_cancel') }}</button>
        </div>
      </div>
    </div>

    <!-- Shared right-click context menu. Teleporting it out of the app root
         avoids the title bar/header stacking contexts covering tab menus. -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        :data-context-target="ctxMenu.target"
        class="knote-ctxmenu fixed z-[4000] w-52 bg-base-100 border border-base-200 rounded-xl shadow-2xl p-1.5 print:hidden"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @contextmenu.prevent
        @mousedown.stop
      >
        <template v-for="(it, i) in ctxMenu.items" :key="i">
          <div v-if="it.divider" class="my-1 h-px bg-base-200"></div>
          <button
            v-else
            class="w-full text-left text-[13px] px-2.5 py-1.5 rounded-lg transition-colors"
            :class="it.danger ? 'text-error hover:bg-error/10' : 'hover:bg-base-200'"
            @click="runCtxItem(it)"
          >{{ it.label }}</button>
        </template>
      </div>
    </Teleport>

    <!-- Hidden file input for image picker -->
    <input
      ref="imageFileInput"
      type="file"
      accept="image/*"
      style="display: none"
      @change="handleImageFileSelected"
    />

    <!-- Image viewer: fullscreen lightbox — wheel zooms at the cursor, drag
         pans, double-click toggles 2x/fit, Esc or backdrop click closes -->
    <div
      v-if="imageViewer"
      class="knote-imgviewer print:hidden"
      @wheel.prevent.stop="onViewerWheel"
      @mousedown.self="closeImageViewer"
      @contextmenu.prevent
    >
      <img
        :src="imageViewer.src"
        :alt="imageViewer.alt"
        draggable="false"
        :class="{ 'is-dragging': viewerDragging }"
        :style="{ transform: `translate(${imageViewer.tx}px, ${imageViewer.ty}px) scale(${imageViewer.scale})` }"
        @mousedown.prevent="onViewerDragStart"
        @dblclick.stop="viewerToggle"
      />
      <button class="knote-imgviewer-close" :title="t('viewer_close')" @click="closeImageViewer">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
      <div class="knote-imgviewer-bar" @mousedown.stop @dblclick.stop>
        <button :title="t('viewer_zoom_out')" @click="viewerStep(-1)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>
        </button>
        <button class="knote-imgviewer-pct" :title="t('viewer_reset')" @click="viewerReset">{{ Math.round(imageViewer.scale * 100) }}%</button>
        <button :title="t('viewer_zoom_in')" @click="viewerStep(1)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
    </div>

    <!-- Ctrl+wheel zoom indicator -->
    <div v-if="zoomToast" class="knote-zoom-toast print:hidden">{{ Math.round(uiZoom * 100) }}%</div>

    <!-- General toast -->
    <div v-if="toastMsg" class="knote-toast print:hidden">{{ toastMsg }}</div>

    <!-- Version history -->
    <div v-if="historyPanel.open" class="knote-modal-backdrop print:hidden" @mousedown.self="closeHistory">
      <div data-testid="history-modal" class="knote-modal knote-history">
        <div class="knote-modal-head">
          <span>{{ t('history') }}</span>
          <button class="knote-modal-x" @click="closeHistory"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="knote-history-body">
          <div class="knote-history-list">
            <div v-if="!historyPanel.items.length" class="knote-history-empty">{{ t('history_empty') }}</div>
            <button
              v-for="(it, i) in historyPanel.items"
              :key="it.id"
              :data-snapshot-id="it.id"
              class="knote-history-item"
              :class="{ 'is-active': historyPanel.previewIndex === i }"
              @click="selectHistorySnapshot(i)"
            >
              <span class="knote-history-time">{{ i === 0 ? t('history_current') : fmtSnapTime(it.t) }}</span>
              <span class="knote-history-size">{{ Math.max(1, Math.round(it.size / 100) / 10) }}k</span>
            </button>
          </div>
          <div class="knote-history-preview">
            <div v-if="historyPanel.previewIndex < 0" class="knote-history-hint">{{ t('history_preview_hint') }}</div>
            <template v-else>
              <pre class="knote-history-content">{{ historyPreview }}</pre>
              <button v-if="historyPanel.previewIndex > 0" data-testid="history-restore" class="knote-history-restore" @click="restoreSnapshot(historyPanel.items[historyPanel.previewIndex])">{{ t('history_restore') }}</button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Shortcuts cheatsheet -->
    <div v-if="shortcutsOpen" class="knote-modal-backdrop print:hidden" @mousedown.self="shortcutsOpen = false">
      <div class="knote-modal knote-shortcuts">
        <div class="knote-modal-head">
          <span>{{ t('shortcuts_title') }}</span>
          <button class="knote-modal-x" @click="shortcutsOpen = false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="knote-shortcuts-grid">
          <div v-for="row in shortcutRows" :key="row.k" class="knote-shortcut-row">
            <kbd>{{ row.k }}</kbd>
            <span>{{ row.d }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Quick open palette (Ctrl+P) -->
    <div v-if="quickOpen.open" class="knote-quickopen-backdrop print:hidden" @mousedown.self="closeQuickOpen">
      <div class="knote-quickopen">
        <input
          v-model="quickOpen.query"
          :placeholder="t('quick_open_placeholder')"
          @keydown="onQuickOpenKeydown"
        />
        <div class="knote-quickopen-list">
          <div v-if="!quickOpenResults.length" class="knote-quickopen-empty">{{ t('quick_open_empty') }}</div>
          <button
            v-for="(node, i) in quickOpenResults"
            :key="node.path"
            class="knote-quickopen-item"
            :class="{ 'is-active': i === quickOpen.index }"
            @mousemove="quickOpen.index = i"
            @click="runQuickOpen(node)"
          >
            <span class="knote-quickopen-name">{{ node.name }}</span>
            <span class="knote-quickopen-path">{{ node.path.replace(/^\//, '').replace(/\/[^/]+$/, '') }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Floating split-mode sidebar: hover the left edge to slide the
         outline + file tree in as an overlay (never reflows the split
         columns); leaving panel or edge slides it back out. -->
    <template v-if="viewMode === 'split' && !pdfView && !largeDocumentPlainMode">
      <div
        class="knote-floating-edge hidden lg:block fixed left-0 top-0 h-full w-2.5 z-[1050] print:hidden"
        :class="{ 'is-open': floatingSidebarOpen }"
        aria-hidden="true"
        @mouseenter="floatingSidebarShow"
        @mouseleave="floatingSidebarHide"
      ><span class="knote-floating-grip"></span></div>
      <Transition name="kfloating">
        <div
          v-if="floatingSidebarOpen"
          class="knote-floating-sidebar hidden lg:block fixed left-0 top-[7rem] w-[330px] z-[1050] print:hidden"
          @mouseenter="floatingSidebarCancelHide"
          @mouseleave="floatingSidebarHide"
        >
          <div class="knote-floating-sidebar-inner">
            <!-- Actions card: navbar functions (stats / open / save / view
                 mode / language / theme / menu) reachable while scrolling a
                 long document — same handlers as the top navbar. -->
            <div data-testid="floating-actions-card" class="card bg-base-100 border border-base-200 shadow-md overflow-hidden">
              <div class="flex flex-wrap items-center justify-between gap-x-0.5 gap-y-1 px-1.5 py-1.5">
                <div class="join shrink-0 border border-base-300/50 rounded-lg overflow-hidden h-7">
                  <button
                    data-testid="floating-view-single"
                    class="join-item btn btn-xs border-none h-full min-h-0 px-1"
                    :class="viewMode === 'single' ? '!bg-[#84cc16] !text-white' : 'btn-ghost hover:bg-base-300'"
                    @click="setViewMode('single')"
                  >{{ t('single') }}</button>
                  <button
                    data-testid="floating-view-split"
                    class="join-item btn btn-xs border-none h-full min-h-0 px-1"
                    :class="viewMode === 'split' ? '!bg-[#84cc16] !text-white' : 'btn-ghost hover:bg-base-300'"
                    :disabled="!!pdfView"
                    @click="setViewMode('split')"
                  >{{ t('split') }}</button>
                </div>
                <button
                  data-testid="floating-open-menu"
                  class="btn btn-xs btn-ghost h-7 px-1 gap-1 font-normal hover:text-[#65a30d] shrink-0"
                  @click="openFloatingMenu('open', $event)"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3 h-3"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                  <span>{{ t('open') }}</span>
                </button>
                <button
                  class="btn btn-xs btn-ghost h-7 px-1 gap-1 font-normal hover:text-[#65a30d] shrink-0"
                  :class="{ 'opacity-50': isSaving }"
                  @click="saveFile"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3 h-3"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                  <span>{{ t('save') }}</span>
                </button>
                <button class="btn btn-xs btn-ghost h-7 px-1 gap-1 font-normal hover:text-[#65a30d] shrink-0" @click="lang = lang === 'zh' ? 'en' : 'zh'">
                  <span class="text-[10px] font-bold uppercase">{{ lang === 'zh' ? '中文' : 'EN' }}</span>
                </button>
                <button
                  data-testid="floating-theme-menu"
                  class="btn btn-xs btn-ghost h-7 px-1 gap-1 font-normal hover:text-[#65a30d] shrink-0"
                  @click="openFloatingMenu('theme', $event)"
                >
                  {{ t('theme') }}
                </button>
                <button
                  data-testid="floating-actions-menu"
                  class="btn btn-xs btn-square btn-ghost h-7 hover:text-[#65a30d] shrink-0"
                  @click="openFloatingMenu('menu', $event)"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-4 h-4 stroke-current"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"></path></svg>
                </button>
              </div>
              <div class="px-3 py-1.5 border-t border-base-200/60 bg-base-200/30" :title="t('stats_tooltip')">
                <div class="flex items-center justify-center gap-1.5 text-[11px] leading-none text-base-content/50 whitespace-nowrap">
                  <span class="font-semibold tabular-nums text-base-content/70 border-b-2 border-primary/20">{{ stats.words }}</span><span>{{ t('words') }}</span>
                  <span class="opacity-30">·</span>
                  <span class="font-semibold tabular-nums text-base-content/70 border-b-2 border-secondary/20">{{ stats.chars }}</span><span>{{ t('chars') }}</span>
                  <span class="opacity-30">·</span>
                  <span class="font-semibold tabular-nums text-base-content/70 border-b-2 border-accent/20">{{ stats.lines }}</span><span>{{ t('lines') }}</span>
                </div>
              </div>
            </div>
            <!-- Outline card: same structure & bindings as the sidebar copy
                 (clicking a heading reuses scrollToBlock, which natively
                 scrolls the split preview). -->
            <nav data-testid="floating-outline-card" class="knote-outline-card card bg-base-100 border border-base-200 shadow-md overflow-hidden" :aria-label="t('outline')">
              <div class="flex items-center justify-between px-3 py-2 border-b border-base-200/60">
                <span class="text-xs font-bold text-base-content/50 uppercase tracking-widest">{{ t('outline') }}</span>
              </div>
              <div class="knote-sidebar-card-scroll max-h-[45vh] overflow-auto py-2">
                <div v-if="outlineItems.length === 0" class="px-3 py-2 text-xs text-base-content/40">{{ t('outline_empty') }}</div>
                <ul v-else class="space-y-0.5">
                  <li v-for="item in visibleOutlineItems" :key="item.id" class="flex items-stretch">
                    <button
                      v-if="outlineNodeHasChildren.has(item.id)"
                      class="shrink-0 w-5 self-stretch flex items-center justify-center text-base-content/35 hover:text-[#65a30d]"
                      :aria-label="collapsedOutlineIds.has(item.id) ? t('ctx_expand') : t('ctx_collapse')"
                      @click.stop="toggleOutlineCollapsed(item.id)"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="w-3 h-3 transition-transform duration-150" :class="{ 'rotate-90': !collapsedOutlineIds.has(item.id) }"><path stroke-linecap="round" stroke-linejoin="round" d="m9 18 6-6-6-6"/></svg>
                    </button>
                    <span v-else class="shrink-0 w-5 self-stretch" aria-hidden="true"></span>
                    <button
                      class="flex-1 min-w-0 text-left text-sm px-3 py-1 hover:bg-base-200/60 hover:text-[#84cc16] transition-colors truncate rounded-sm"
                      :class="{ 'font-bold': item.level === 1, 'text-base-content/80': item.level === 2, 'text-base-content/60': item.level >= 3, 'bg-[#84cc16]/10 text-[#65a30d]': activeOutlineId === item.id }"
                      :style="{ paddingLeft: `${12 + (item.level - 1) * 12}px` }"
                      :title="item.text"
                      :aria-current="activeOutlineId === item.id ? 'location' : undefined"
                      @click="scrollToBlock(item.id)"
                    >
                      {{ item.text || '…' }}
                    </button>
                  </li>
                  <li v-if="outlineHasMore">
                    <button
                      class="w-full text-left text-xs px-3 py-1.5 text-[#65a30d]/80 hover:text-[#65a30d] hover:bg-base-200/60 transition-colors rounded-sm"
                      @click="outlineRenderLimit = Math.min(outlineItems.length, outlineRenderLimit + 240)"
                    >
                      {{ lang === 'zh' ? '展开更多标题…' : 'Show more headings…' }}
                    </button>
                  </li>
                </ul>
                <div v-if="outlineTruncated" class="px-3 py-2 text-[11px] text-amber-700/80" role="status">
                  {{ lang === 'zh' ? '大纲过长，仅显示前 4000 个标题' : 'Outline is truncated to the first 4,000 headings' }}
                </div>
              </div>
            </nav>
            <!-- File tree card: same structure & bindings as the sidebar copy -->
            <div data-testid="floating-files-card" class="knote-files-card card bg-base-100 border border-base-200 shadow-md overflow-hidden">
              <div class="flex items-center gap-0.5 px-3 py-2 border-b border-base-200/60">
                <span class="text-xs font-bold text-base-content/50 uppercase tracking-widest truncate flex-1" :title="folderName">{{ folderName || t('files') }}</span>
                <button v-if="folderHandle" data-testid="floating-workspace-new-file" class="btn btn-xs btn-ghost btn-square" :title="t('file_new')" @click="openCreateTarget('file', $event)">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3h-6m-3.75 7.5h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125Z" /></svg>
                </button>
                <button v-if="folderHandle" data-testid="floating-workspace-new-folder" class="btn btn-xs btn-ghost btn-square" :title="t('folder_new')" @click="openCreateTarget('folder', $event)">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" /></svg>
                </button>
                <button v-if="folderHandle" data-testid="floating-tree-refresh" class="btn btn-xs btn-ghost btn-square" :title="t('file_refresh')" @click="refreshFolder">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                </button>
                <button class="btn btn-xs btn-ghost btn-square" :title="t('open_folder')" @click="openFolder">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.893 6.25a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.893-6.25a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h2.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 8v1.75" /></svg>
                </button>
              </div>
              <!-- folder-wide full-text search -->
              <div v-if="folderHandle" class="px-2 pt-2">
                <div class="relative">
                  <svg class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/35" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path stroke-linecap="round" d="m20 20-3.5-3.5"/></svg>
                  <input
                    v-model="folderSearchQuery"
                    :placeholder="t('folder_search_placeholder')"
                    class="w-full h-8 pl-7 pr-7 text-xs rounded-lg bg-base-200/50 border border-transparent focus:border-[#84cc16] focus:outline-none"
                  />
                  <button v-if="folderSearchQuery" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-base-content/40 hover:text-base-content" @click="folderSearchQuery = ''">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                  </button>
                </div>
              </div>
              <!-- search results -->
              <div v-if="folderSearchQuery.trim()" class="knote-sidebar-card-scroll max-h-[42vh] overflow-auto py-1.5">
                <div v-if="folderSearching" class="px-3 py-2 text-xs text-base-content/40">{{ t('searching') }}</div>
                <div v-else-if="!folderSearchResults.length" class="px-3 py-2 text-xs text-base-content/40">{{ t('folder_search_none') }}</div>
                <template v-else>
                  <div class="px-3 py-1 text-[10px] uppercase tracking-wider text-base-content/35">{{ t('folder_search_count').replace('{n}', folderSearchHitCount).replace('{f}', folderSearchResults.length) }}</div>
                  <div v-for="res in folderSearchResults" :key="res.path" class="mb-0.5">
                    <div class="px-2 py-1 text-xs font-semibold text-base-content/70 truncate flex items-center gap-1.5" :title="res.path">
                      <svg class="w-3 h-3 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg>
                      {{ res.name }}
                    </div>
                    <button
                      v-for="hit in res.hits"
                      :key="hit.line"
                      class="w-full text-left pl-7 pr-2 py-1 text-[11px] text-base-content/60 hover:bg-[#84cc16]/10 hover:text-base-content rounded-sm flex gap-2"
                      @click="openSearchResult(res.node, hit.line)"
                    >
                      <span class="text-base-content/35 tabular-nums shrink-0">{{ hit.line }}</span>
                      <span class="truncate">{{ hit.text }}</span>
                    </button>
                  </div>
                </template>
              </div>
              <div v-else class="knote-sidebar-card-scroll max-h-[32vh] overflow-auto py-1.5">
                <div
                  v-if="!folderTree.length && !folderName && currentFileName"
                  data-testid="floating-single-file-row"
                  class="px-3 py-2 cursor-pointer"
                  @pointerdown.right.stop
                  @contextmenu.prevent.stop="activeTab() && openTabCtxMenu(activeTab(), $event)"
                >
                  <div class="flex items-center gap-1.5 text-xs font-medium text-[#84cc16]">
                    <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <span class="truncate" :title="currentFileName">{{ t('browsing_now') }} {{ currentFileName }}</span>
                  </div>
                </div>
                <div v-else-if="!folderTree.length" class="px-3 py-2 text-xs text-base-content/40">
                  {{ folderName ? t('folder_empty') : t('folder_hint') }}
                </div>
                <div v-else>
                  <div
                    v-for="row in flatFolderTree"
                    :key="row.node.path"
                    data-testid="floating-workspace-tree-row"
                    :data-tree-path="row.node.path"
                    :data-tree-kind="row.node.kind"
                    :data-tree-active="row.node.path === activeTreePath ? 'true' : 'false'"
                    class="knote-tree-row group w-full flex items-center gap-1.5 text-left text-xs px-2 py-1 hover:bg-base-200/60 transition-colors rounded-sm cursor-pointer"
                    :class="row.node.path === activeTreePath ? 'text-[#84cc16] font-bold bg-[#84cc16]/10' : 'text-base-content/75'"
                    :style="{ paddingLeft: `${10 + row.depth * 14}px` }"
                    :title="row.node.kind === 'dir' ? row.node.name : undefined"
                    :aria-label="row.node.name"
                    :data-hover-annotation="row.node.kind === 'file' ? treeRowAnnotation(row.node) : undefined"
                    :data-hover-placement="row.node.kind === 'file' ? 'right' : undefined"
                    :data-hover-source="row.node.kind === 'file' ? 'file-row' : undefined"
                    @click="onTreeRowClick(row.node, $event)"
                    @dblclick="onTreeRowDoubleClick(row.node, $event)"
                    @pointerdown.right.stop
                    @contextmenu.prevent.stop="openTreeCtxMenu(row.node, $event)"
                  >
                    <svg v-if="row.node.kind === 'dir'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 opacity-60 transition-transform" :class="{ 'rotate-90': expandedDirs.has(row.node.path) }"><path stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
                    <svg v-else-if="row.node.ftype === 'pdf'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 text-rose-500/70"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                    <svg v-else-if="row.node.ftype === 'image'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 text-sky-500/70"><path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
                    <svg v-else-if="row.node.ftype === 'docx'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 text-blue-500/70"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                    <svg v-else-if="row.node.ftype === 'pptx'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 text-orange-500/70"><rect x="3.75" y="3" width="16.5" height="18" rx="3" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 8.25h4.5a1.5 1.5 0 0 1 0 3h-4.5m0 4.5h7.5" /></svg>
                    <svg v-else-if="row.node.ftype === 'xlsx'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 text-emerald-500/70"><rect x="3.75" y="3" width="16.5" height="18" rx="3" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 8.25h7.5M8.25 12h7.5m-7.5 3.75h4.5" /></svg>
                    <svg v-else-if="row.node.ftype === 'txt' || row.node.ftype === 'csv' || row.node.ftype === 'rtf'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 text-gray-500/70"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 3.75h7.5m-7.5 3h7.5m-7.5 3h3.75M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                    <svg v-else-if="row.node.ftype === 'odt' || row.node.ftype === 'ods' || row.node.ftype === 'odp'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 text-purple-500/70"><circle cx="12" cy="12" r="9" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 8.25h4.5a1.5 1.5 0 0 1 0 3h-4.5m3 3.75h-3" /></svg>
                    <svg v-else xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 opacity-50"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                    <span class="truncate flex-1">{{ row.node.name }}</span>
                    <button
                      v-if="row.node.kind === 'file'"
                      class="hidden group-hover:block shrink-0 opacity-50 hover:opacity-100 hover:text-[#84cc16]"
                      :aria-label="t('file_rename')"
                      :data-hover-annotation="t('file_rename')"
                      data-hover-placement="right"
                      data-hover-source="file-control"
                      @click="renameTreeFile(row.node, $event)"
                      @dblclick.stop.prevent
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" /></svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </template>
    <!-- Floating/sidebar actions-card popups: rendered at body level so the
         panel's scroll container never clips them. Click outside to close. -->
    <Teleport to="body">
      <div
        v-if="floatingMenu"
        class="fixed inset-0 z-[2000]"
        @mousedown.self="closeFloatingMenu"
      >
        <div
          class="absolute shadow-xl bg-base-100 rounded-box border border-base-200 menu p-1.5 min-w-[200px] w-max max-w-[min(24rem,85vw)] max-h-[70vh] overflow-y-auto flex-nowrap"
          :style="{ top: `${floatingMenuAnchor.top}px`, left: `${floatingMenuAnchor.left}px` }"
        >
          <!-- Open: file / folder / recents -->
          <template v-if="floatingMenu === 'open'">
            <li><a class="flex items-center gap-2 text-xs py-1" @click="openLocalFile(); closeFloatingMenu()">{{ t('open_file') }}</a></li>
            <li><a class="flex items-center gap-2 text-xs py-1" @click="openFolder(); closeFloatingMenu()">{{ t('open_folder') }}</a></li>
            <template v-if="isDesktopShell && recentItems.length">
              <li class="menu-title !flex-row flex items-center justify-between pr-1">
                <span class="text-[10px] uppercase tracking-wider opacity-50">{{ t('recent_open') }}</span>
                <button class="btn btn-ghost btn-xs btn-square opacity-40 hover:opacity-100 hover:text-error" :title="t('recent_clear')" @click.stop="clearRecents">
                  <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6m4 5v6m4-6v6"/></svg>
                </button>
              </li>
              <li v-for="r in recentItems" :key="r.type + r.path" @click="openRecent(r); closeFloatingMenu()" @contextmenu.prevent="openRecentCtxMenu(r, $event)">
                <a class="flex items-center gap-2 text-xs py-1">
                  <svg v-if="r.type === 'folder'" class="w-3.5 h-3.5 opacity-60 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  <svg v-else class="w-3.5 h-3.5 opacity-60 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  <span class="truncate flex-1 min-w-0 max-w-[19rem]" :title="r.path">{{ r.name }}</span>
                </a>
              </li>
            </template>
          </template>
          <!-- Theme -->
          <template v-else-if="floatingMenu === 'theme'">
            <li><a data-testid="floating-theme-light" class="flex justify-between items-center text-xs py-1" :class="{active: theme==='light'}" @click="theme = 'light'; closeFloatingMenu()"><span>{{ t('light') }}</span><div class="theme-indicator indicator-light"></div></a></li>
            <li><a data-testid="floating-theme-dark" class="flex justify-between items-center text-xs py-1" :class="{active: theme==='dark'}" @click="theme = 'dark'; closeFloatingMenu()"><span>{{ t('dark') }}</span><div class="theme-indicator indicator-dark"></div></a></li>
          </template>
          <!-- Actions -->
          <template v-else>
            <li v-if="!isNativeApp()"><a class="flex items-center gap-2 text-xs py-1" @click="exportPDF(); closeFloatingMenu()"><img :src="KpdfIcon" class="w-3.5 h-3.5 object-contain" />{{ t('export_pdf') }}</a></li>
            <li><a class="flex items-center gap-2 text-xs py-1" @click="exportWord(); closeFloatingMenu()"><img :src="KdocIcon" class="w-3.5 h-3.5 object-contain" />{{ t('export_word') }}</a></li>
            <li><a class="flex items-center gap-2 text-xs py-1" @click="downloadMarkdown(); closeFloatingMenu()"><img :src="theme === 'retro' ? KnoteIconPixel : KnoteIcon" class="w-3.5 h-3.5 object-contain" />{{ t('export_md') }}</a></li>
            <li><a class="flex items-center gap-2 text-xs py-1" @click="exportHtml(); closeFloatingMenu()"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="m8 9-3 3 3 3m8-6 3 3-3 3M13.5 6l-3 12"/></svg>{{ t('export_html') }}</a></li>
            <div class="divider my-0.5"></div>
            <li v-if="!isAndroidNative && viewMode === 'single'">
              <a class="flex items-center gap-2 text-xs py-1" role="menuitemcheckbox" :aria-checked="editorCentered" @click="toggleEditorCentered">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5v14M20 5v14M8 8h8v8H8z"/><path d="M4 12h4m8 0h4"/></svg>
                <span class="flex-1">{{ t('center_editor') }}</span>
                <svg v-if="editorCentered" class="w-3.5 h-3.5 text-[#65a30d]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
              </a>
            </li>
            <li v-if="isDesktopShell">
              <a class="flex items-center gap-2 text-xs py-1" role="menuitemcheckbox" :aria-checked="!hwAccelDisabled" :title="t('hw_accel_hint')" @click="toggleHwAccel">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>
                <span class="flex-1">{{ t('hw_accel') }}</span>
                <svg v-if="!hwAccelDisabled" class="w-3.5 h-3.5 text-[#65a30d]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
              </a>
            </li>
            <li v-if="!isAndroidNative">
              <a data-testid="floating-source-smart-edit" class="flex items-center gap-2 text-xs py-1" role="menuitemcheckbox" :aria-checked="sourceSmartEdit" :title="t('source_smart_edit_hint')" @click="toggleSourceSmartEdit">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>
                <span class="flex-1">{{ t('source_smart_edit') }}</span>
                <svg v-if="sourceSmartEdit" class="w-3.5 h-3.5 text-[#65a30d]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
              </a>
            </li>
            <li><a class="flex items-center gap-2 text-xs py-1" @click="openHistory(); closeFloatingMenu()"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 2m6-2a9 9 0 1 1-3.5-7.1M21 3v5h-5"/></svg>{{ t('history') }}</a></li>
            <li><a class="flex items-center gap-2 text-xs py-1" @click="loadSample('zh'); closeFloatingMenu()"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9.5 16 1.3-2.7L13.5 12l-2.7-1.3L9.5 8l-1.3 2.7L5.5 12l2.7 1.3z"/></svg>{{ t('load_sample_zh') }}</a></li>
            <li><a class="flex items-center gap-2 text-xs py-1" @click="loadSample('en'); closeFloatingMenu()"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9.5 16 1.3-2.7L13.5 12l-2.7-1.3L9.5 8l-1.3 2.7L5.5 12l2.7 1.3z"/></svg>{{ t('load_sample_en') }}</a></li>
            <li><a class="flex items-center gap-2 text-xs py-1" @click="copyMarkdown(); closeFloatingMenu()"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 1-2-2v8a2 2 0 0 0 2 2h2"/><path d="m12 14 2 2 3.5-4"/></svg>{{ t('copy_markdown') }}</a></li>
            <li><a class="flex items-center gap-2 text-xs py-1" @click="openShortcuts(); closeFloatingMenu()"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h.01M10 14h7"/></svg>{{ t('shortcuts') }}</a></li>
            <li><a class="flex items-center gap-2 text-xs py-1" @click="openOnboarding(); closeFloatingMenu()"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/><path d="M17 3h4v4"/><path d="m21 3-5 5"/></svg>{{ t('product_tour') }}</a></li>
            <li><a class="flex items-center gap-2 text-xs py-1" :class="{ 'opacity-40 pointer-events-none': showAgentSidebar }" :aria-disabled="showAgentSidebar" @click="recallAgent(); closeFloatingMenu()"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/></svg>{{ t('agent_recall') }}</a></li>
            <div class="divider my-0.5"></div>
            <li><a class="flex items-center gap-2 text-xs py-1 text-error" @click="clearAll(); closeFloatingMenu()">{{ t('clear_all') }}</a></li>
          </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style>
/* Floating split-mode sidebar: slide-in/out transition + overlay surface.
   top-[7rem] clears the 40px title bar and the 64px app navbar; the inner
   surface owns the height cap (100vh - 8rem leaves 1rem at the bottom) and
   scrolls when the cards are taller than the window. */
/* Floating split-mode sidebar: the left edge is an invisible hover zone; the
   visible affordance is a grab-handle tab that sits flush at the edge at vertical
   center, ALWAYS on (常驻) so the recall target is discoverable without having to
   find the edge first. It lights kiwi on hover and tucks away once the panel
   opens — the same recall-handle language as the left sidebar's sidebar-show. */
.knote-floating-edge {
  /* hit zone only; no visible paint of its own */
}
.knote-floating-grip {
  position: absolute;
  left: 0;
  top: 50%;
  translate: 0 -50%;
  width: 18px;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0 12px 12px 0;
  background: color-mix(in srgb, var(--color-base-100) 92%, transparent);
  border: 1px solid var(--color-base-200);
  border-left: none;
  box-shadow: 6px 0 16px rgb(0 0 0 / 0.10);
  backdrop-filter: blur(6px);
  color: var(--color-base-content);
  /* persistent (常驻): always visible and flush to the edge */
  opacity: 1;
  transform: translateX(0);
  transition: opacity 0.18s ease, transform 0.18s ease, background-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease;
}
.knote-floating-grip::before {
  content: "";
  width: 8px;
  height: 8px;
  border: solid currentColor;
  border-width: 2.2px 2.2px 0 0;   /* top+right strokes, rotated into a "›" */
  transform: rotate(45deg);
  margin-right: 2px;
  opacity: 0.55;
}
.knote-floating-edge:hover .knote-floating-grip {
  background: #84cc16;             /* kiwi — the panel is about to slide in */
  border-color: #65a30d;
  color: #fff;
  box-shadow: 6px 0 18px rgb(132 204 22 / 0.35);
}
.knote-floating-edge:hover .knote-floating-grip::before {
  opacity: 1;
}
.knote-floating-edge.is-open .knote-floating-grip {
  opacity: 0;
  transform: translateX(-9px);
  pointer-events: none;
}
.kfloating-enter-active,
.kfloating-leave-active {
  transition: transform 0.2s ease-out;
}
.kfloating-enter-from,
.kfloating-leave-to {
  transform: translateX(-100%);
}
.knote-floating-sidebar-inner {
  max-height: calc(100vh - 8rem);
  overflow-y: auto;
  background: color-mix(in srgb, var(--color-base-100) 96%, transparent);
  backdrop-filter: blur(8px);
  border-right: 1px solid var(--color-base-200);
  border-radius: 0 0.75rem 0.75rem 0;
  box-shadow: 8px 0 24px rgb(0 0 0 / 0.08);
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
/* Cards keep their natural height (never compressed by the flex layout);
   when they overflow, the panel scrolls as a whole. */
.knote-floating-sidebar-inner > * {
  flex: none;
}
.knote-agent-review-bar {
  border-color: color-mix(in srgb, var(--knote-brand) 24%, transparent);
  background: color-mix(in srgb, var(--knote-brand) 5%, var(--color-base-100));
}
.knote-agent-review-pulse { flex: none; background: var(--knote-brand); }
.knote-agent-review-accept {
  color: #fff;
  border-color: var(--knote-brand);
  background: var(--knote-brand);
}
.knote-dialog-brand-action {
  color: #fff;
  border-color: var(--knote-theme);
  background: var(--knote-theme);
}
.knote-agent-review-accept:hover:not(:disabled),
.knote-agent-review-accept:focus-visible:not(:disabled) {
  color: #fff;
  border-color: var(--knote-brand-strong);
  background: var(--knote-brand-strong);
}
.knote-dialog-brand-action:hover:not(:disabled),
.knote-dialog-brand-action:focus-visible:not(:disabled) {
  color: #fff;
  border-color: var(--knote-theme-strong);
  background: var(--knote-theme-strong);
}
.knote-agent-review-accept:disabled {
  color: #fff;
  border-color: var(--knote-brand);
  background: var(--knote-brand);
  opacity: 0.38;
}
@media (max-width: 520px) {
  .knote-agent-review-bar {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    width: calc(100vw - 1rem);
    padding: 0.5rem;
    border-radius: 14px;
  }
  .knote-agent-review-count { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .knote-agent-review-reason { grid-column: 1 / -1; grid-row: 2; max-width: none; }
}
.knote-app-dialog-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(320px, 90vw);
  padding: 20px;
  border: 1px solid color-mix(in srgb, var(--color-base-content) 14%, transparent);
  border-radius: 16px;
  color: var(--color-base-content);
  background: color-mix(in srgb, var(--color-base-100) 94%, transparent);
  box-shadow: 0 22px 60px color-mix(in srgb, var(--color-base-content) 18%, transparent);
}
.knote-app-dialog-card.is-alert { width: min(360px, 90vw); }
.knote-app-dialog-title { font-size: 14px; line-height: 1.35; font-weight: 750; }
.knote-app-dialog-message { margin: 0; white-space: pre-line; font-size: 12px; line-height: 1.65; color: color-mix(in srgb, var(--color-base-content) 66%, transparent); }
.knote-app-dialog-alert-icon {
  display: grid; place-items: center; width: 34px; height: 34px;
  border: 1px solid color-mix(in srgb, var(--color-success) 24%, transparent); border-radius: 10px; color: var(--color-success); background: color-mix(in srgb, var(--color-success) 11%, transparent);
}
.knote-app-dialog-alert-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.knote-app-dialog-card.is-partial .knote-app-dialog-alert-icon { border-color: color-mix(in srgb, var(--knote-brand-warm) 24%, transparent); color: var(--knote-brand-warm); background: color-mix(in srgb, var(--knote-brand-warm) 11%, transparent); }
.knote-app-dialog-card.is-failure .knote-app-dialog-alert-icon { border-color: color-mix(in srgb, var(--color-error) 22%, transparent); color: var(--color-error); background: color-mix(in srgb, var(--color-error) 9%, transparent); }
/* ---- Resizable agent window: four CORNER handles, pale-yellow glow that sits
   ON the window's outer border (the handles live on the non-clipping wrapper, so
   the glow straddles the boundary rather than showing inside the panel) ---- */
.knote-rsz {
  position: absolute;
  z-index: 44;
  width: 20px;
  height: 20px;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}
/* the glow is an L-BRACKET: two rounded bars running ALONG the two border edges
   of the corner, centered ON the boundary line (straddling it, ~1.5px each side),
   not a dot sitting outside */
.knote-rsz > i {
  position: absolute; display: block; width: 15px; height: 15px;
  border-style: solid; border-color: transparent; border-width: 0;
  transition: border-color .15s ease, filter .15s ease; pointer-events: none;
}
/* glow via drop-shadow (follows the L-shaped border pixels), NOT box-shadow
   (which would bloom the whole box and leak a square of light on the inside) */
.knote-rsz:hover > i, .knote-rsz:active > i {
  border-color: rgba(253, 224, 71, 0.98);
  filter: drop-shadow(0 0 2.5px rgba(250, 204, 21, 0.85));
}
/* corners: the grab box straddles the corner junction (centered ON it, not
   offset outside) so dragging bites where the bracket glow actually is; the
   bracket bars are 5px thick and sit centered on the two edge lines */
.knote-rsz-nw { top: -8px; left: -8px; width: 16px; height: 16px; cursor: nwse-resize; }
.knote-rsz-nw > i { top: 5.5px; left: 5.5px; border-top-width: 5px; border-left-width: 5px; border-top-left-radius: 8px; }
.knote-rsz-ne { top: -8px; right: -8px; width: 16px; height: 16px; cursor: nesw-resize; }
.knote-rsz-ne > i { top: 5.5px; right: 5.5px; border-top-width: 5px; border-right-width: 5px; border-top-right-radius: 8px; }
.knote-rsz-sw { bottom: -8px; left: -8px; width: 16px; height: 16px; cursor: nesw-resize; }
.knote-rsz-sw > i { bottom: 5.5px; left: 5.5px; border-bottom-width: 5px; border-left-width: 5px; border-bottom-left-radius: 8px; }
.knote-rsz-se { bottom: -8px; right: -8px; width: 16px; height: 16px; cursor: nwse-resize; }
.knote-rsz-se > i { bottom: 5.5px; right: 5.5px; border-bottom-width: 5px; border-right-width: 5px; border-bottom-right-radius: 8px; }
/* left/right side bars — a thin rounded vertical bar centered on the side edge,
   straddling the boundary line; drag to change width */
.knote-rsz-w, .knote-rsz-e { top: 50%; margin-top: -26px; width: 14px; height: 52px; }
.knote-rsz-w { left: -7px; cursor: ew-resize; }
.knote-rsz-e { right: -7px; cursor: ew-resize; }
.knote-rsz-w > i, .knote-rsz-e > i {
  top: 50%; margin-top: -17px; width: 4px; height: 34px; border-radius: 9999px; border-width: 0;
  background: transparent;
}
.knote-rsz-w > i { left: 5px; }
.knote-rsz-e > i { right: 5px; }
.knote-rsz-w:hover > i, .knote-rsz-e:hover > i, .knote-rsz-w:active > i, .knote-rsz-e:active > i {
  background: rgba(253, 224, 71, 0.95);
}

@media print {
  /* Hide chrome: navbar, outline, toolbars, desktop title bar, agent dock.
     The title bar is position:fixed with its own display:flex, so a bare
     Tailwind print:hidden (equal specificity) can lose the cascade — force
     it off here. */
  header.navbar,
  aside,
  .knote-titlebar,
  .knote-agent-dock,
  .line-button-bridge,
  .selection-toolbar,
  .table-toolbar,
  .toolbar-glow,
  .table-selector-popover {
    display: none !important;
  }

  /* No hover/selection indicators on paper */
  .knote-selected-simple,
  .knote-selected-complex {
    box-shadow: none !important;
  }
  .knote-selected-image img {
    box-shadow: none !important;
  }

  /* Let the document flow to its natural height (the on-screen layout
     scrolls inside a fixed-height container, which would clip to one page) */
  main {
    display: block !important;
    max-width: 100% !important;
  }
  /* printBackground:true paints the app's gray page background (bg-base-200)
     and the white card's rounded frame into the PDF — the "gray border"
     around the content. Neutralize the shell to a clean white page. */
  html,
  body,
  .knote-root {
    background: #ffffff !important;
  }
  /* desktop shell: the app root is a fixed-height scroll container under the
     title bar — unclip it or the print shows a single truncated page */
  .knote-root {
    height: auto !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: visible !important;
  }
  main {
    margin: 0 !important;
    padding: 0 !important;
    gap: 0 !important;
  }
  /* NOTE: do NOT force display:block here — the inactive view panel is kept
     in the DOM via v-show (display:none); forcing block would un-hide it,
     leaking the split-mode source textarea + a duplicate preview into the
     print. The active panel is already visible and prints fine. */
  section.card {
    box-shadow: none !important;
    border: none !important;
    border-radius: 0 !important;
    margin: 0 !important;
    background: #ffffff !important;
    height: auto !important;
  }
  /* the split-mode raw-source textarea must never appear in a PDF */
  textarea {
    display: none !important;
  }
  /* Section header strip ("编辑器"/"预览") */
  section.card > div.bg-base-200\/30 {
    display: none !important;
  }
  .h-full,
  .overflow-auto {
    height: auto !important;
    overflow: visible !important;
  }
  .relative.flex-1 {
    height: auto !important;
  }
  .prose {
    max-width: 100% !important;
  }
  .md-block-container {
    break-inside: avoid;
  }
}

/* ---- document preview (docx/pptx/xlsx) ---- */
.knote-doc-preview {
  padding: 25mm 20mm;
  font-family: 'Calibri', 'Segoe UI', 'Microsoft YaHei', sans-serif;
  font-size: 11pt;
  line-height: 1.5;
  color: #1a1a1a;
}
.knote-doc-preview h1 { font-size: 18pt; font-weight: 700; margin: 12pt 0 6pt; color: #000; }
.knote-doc-preview h2 { font-size: 14pt; font-weight: 700; margin: 10pt 0 4pt; color: #222; }
.knote-doc-preview h3 { font-size: 12pt; font-weight: 700; margin: 8pt 0 3pt; color: #333; }
.knote-doc-preview p { margin: 4pt 0; }
.knote-doc-preview table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 10pt; }
.knote-doc-preview td, .knote-doc-preview th { border: 0.5pt solid #999; padding: 3pt 6pt; }
.knote-doc-preview th { background: #e8e8e8; font-weight: 700; }
.knote-doc-preview tr:nth-child(even) td { background: #f5f5f5; }
.knote-doc-preview img { max-width: 100%; height: auto; }
.knote-doc-preview ul, .knote-doc-preview ol { margin: 4pt 0; padding-left: 20pt; }
.knote-doc-preview strong { font-weight: 700; }
.knote-doc-preview em { font-style: italic; }
.knote-doc-preview blockquote { border-left: 3pt solid #84cc16; margin: 8pt 0; padding: 4pt 12pt; color: #555; background: #f9f9f9; }

/* pptx slide cards */
.knote-doc-preview .pptx-slide {
  border: 1px solid #ddd; border-radius: 6px; padding: 16pt; margin: 12pt 0;
  box-shadow: 0 1px 3px rgba(0,0,0,.08); background: #fff;
}
.knote-doc-preview .pptx-slide strong { display: block; font-size: 10pt; color: #888; margin-bottom: 4pt; }
</style>
