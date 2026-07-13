<script setup>
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, watchEffect } from 'vue'
import MarkdownIt from 'markdown-it'
import { full as emoji } from 'markdown-it-emoji'
import taskLists from 'markdown-it-task-lists'
import KnoteIcon from './icon/KnoteIcon.png'
import KnoteIconPixel from './icon/KnoteIcon-pixel.png'
import footnote from 'markdown-it-footnote'
import sub from 'markdown-it-sub'
import sup from 'markdown-it-sup'
import abbr from 'markdown-it-abbr'
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
import { agentBridge, agentOpen, pendingHunks, acceptAllHunks, rejectAllHunks, resyncAgentPreview, agentNotice, sendToAgent, selectionContext, setChatWorkspace, loadPersisted as loadAgentPersisted, agentStatus, agentActivity, agentError, attachmentPool, pdfElements } from './lib/agentStore.js'
import { isNativeApp, openNativeWorkspace, nativeExportText } from './lib/nativeFs.js'
import { mkDesktopDirHandle } from './lib/desktopFs.js'
import { addSnapshot, listSnapshots, getSnapshot } from './lib/snapshots.js'
import { renderMermaidIn } from './lib/mermaidRender.js'
import { toInternal } from './lib/emptyRows.js'
import * as mdKatex from '@vscode/markdown-it-katex'
import 'katex/dist/katex.min.css'

import KpdfIcon from './icon/Kpdf.png'
import KdocIcon from './icon/Kdoc.png'

const sample = `# Knote Markdown 编辑器

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

const content = ref(sample)
const theme = ref('light')
const viewMode = ref('single')
const viewModeSelectionSnapshot = ref(null)
const lastSelectionSnapshot = ref(null)
const selectedImage = ref(null)
const lang = ref('zh') // i18n state: 'zh' or 'en'

// Undo/Redo system
const undoStack = ref([])
const redoStack = ref([])
const MAX_UNDO = 50
let undoTimer = null
let isUndoRedoAction = false
let lastSavedSnapshot = { content: sample, selection: null }

// File management
const currentFileHandle = ref(null)
const isLocalFile = ref(false)
const currentFileName = ref('')
let autoSaveTimer = null
const isSaving = ref(false)

const translations = {
  zh: {
    editor: '编辑器',
    preview: '预览',
    modern_editor: '由KV制作',
    words: '字数',
    chars: '字符',
    lines: '行数',
    single: '单栏',
    split: '分栏',
    theme: '主题',
    light: '明亮',
    dark: '暗黑',
    retro: '复古',
    load_sample: '加载示例',
    copy_markdown: '复制 Markdown',
    download_file: '下载文件',
    clear_all: '清除全部',
    block_actions: '块操作',
    bold_line: '整行加粗',
    insert_image_below: '插入图片',
    insert_image_local: '从本地选择图片',
    insert_image_url: '输入图片 URL',
    insert_image_url_prompt: '请输入图片 URL:',
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
    agent_clear: '清空对话',
    agent_base_url: 'API 地址',
    agent_api_key: 'API Key',
    agent_model: '模型名称',
    agent_jina_key: '联网搜索 Jina Key（选填）',
    agent_pdf_page_hint: '该模型不支持 PDF 直读；PDF 附件仍可上传，会通过逐页截图交给模型处理。',
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
    agent_persona: '助手人设 / 风格要求（选填）',
    agent_persona_ph: '例如：始终使用学术语气；回复尽量简短',
    agent_sel_ref: '已引用选中内容',
    agent_tok_in: '输入',
    agent_tok_out: '输出',
    agent_jina_hint: '网页无法直接抓取搜索引擎（跨域限制），联网搜索经由 r.jina.ai 代理完成；免费 Key 在 jina.ai 获取。未填写时不会给模型提供搜索工具。',
    agent_verify: '完成后自我验证',
    agent_verify_hint: '每次回复后额外让模型自查一遍：任务是否真正完成、该调的工具是否调了；未通过会自动补做（最多 2 轮）。会增加一次额外调用，成本略升。',
    batch_title: '多 Agent 批量处理',
    agent_pdf_layout: 'PDF 版面分析（PaddleOCR）',
    agent_pdf_layout_hint: '让助手用本地 PaddleOCR / PP-Structure 精准识别 PDF 里的标题/图/表并插入。点下方一键下载配置（装进独立环境，需本机有 Python，建议 3.10/3.11）。未配置时会自动改用视觉定位裁剪。',
    agent_pdf_env_ready: '已就绪',
    agent_pdf_env_install: '一键下载并配置',
    agent_pdf_env_reinstall: '重新下载',
    agent_pdf_env_uninstall: '卸载',
    agent_pdf_env_installing: '正在下载配置（较大，可能数分钟，请勿关闭）…',
    agent_pdf_env_uninstall_confirm: '确定卸载 PDF 版面分析环境吗？将删除已下载的依赖（约数百 MB）。',
    agent_check: '保存并检测能力',
    agent_key_local_hint: '密钥仅保存在本机浏览器',
    agent_no_tools_hint: '该模型不支持工具调用，助手将无法阅读/修改文档，仅能对话',
    agent_empty_hint: '我是文档助手，可以阅读并修改当前文档、联网搜索、把 PDF 页面截图插入文中。所有修改会以红/绿对比显示在文档里，由你逐块或一键接受。',
    agent_input_placeholder: '问点什么，或让我改文档…（Enter 发送）',
    agent_configure_first: '请先在 ⚙ 设置里配置模型',
    agent_attach: '添加图片 / PDF 附件',
    agent_drop_hint: '松开以添加图片 / PDF',
    agent_drop_unsupported: '仅支持图片和 PDF 文件',
    agent_drop_need_config: '当前模型不支持图片/PDF，或尚未配置',
    agent_send: '发送',
    agent_stop: '停止',
    agent_hunks_pending: '处改动待审核',
    agent_accept_all: '全部接受',
    agent_reject_all: '全部拒绝',
    agent_hunk_accept: '接受此改动',
    agent_hunk_reject: '拒绝此改动',
    agent_new_chat: '新对话',
    agent_hide: '收起助手',
    agent_running_badge: '生成中',
    agent_running_elsewhere: '另一个对话正在生成回复…',
    folder_hint: '将只读取该文件夹下的 .md 文件',
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
    ctx_open_as_folder: '用文件夹打开',
    move_title: '移动',
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
    agent_sec_extra: '增强',
    agent_ctx_used: '上下文已用',
    missing_img_banner: '本文档有 {n} 张图片无法显示：图片数据没有随文档保存下来（多见于文档在 Knote 之外被复制或生成）。若有原图，请重新插入后保存。',
    missing_img_dismiss: '忽略',
    files: '文件',
    file_new: '新建文档',
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
    fold_section: '折叠 / 展开',
    folder_search_placeholder: '搜索文件夹内全文…',
    folder_search_none: '未找到匹配',
    folder_search_count: '{f} 个文件，{n} 处匹配',
    searching: '搜索中…',
    history: '版本历史',
    history_empty: '暂无历史版本',
    history_restore: '恢复此版本',
    history_restored: '已恢复到该版本（可 Ctrl+Z 撤回）',
    history_current: '当前',
    history_preview_hint: '点击版本预览内容',
    history_close: '关闭',
    export_html: '导出 HTML',
    shortcuts: '快捷键',
    shortcuts_title: '快捷键速查',
    align_left: '居左',
    align_center: '居中',
    align_right: '居右',
    outline: '大纲',
    outline_empty: '暂无标题',
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
    words: 'Words',
    chars: 'Chars',
    lines: 'Lines',
    single: 'Single',
    split: 'Split',
    theme: 'Theme',
    light: 'Light',
    dark: 'Dark',
    retro: 'Retro',
    load_sample: 'Load Sample',
    copy_markdown: 'Copy Markdown',
    download_file: 'Download File',
    clear_all: 'Clear All',
    block_actions: 'Block Actions',
    bold_line: 'Bold Whole Line',
    insert_image_below: 'Insert Image',
    insert_image_local: 'Choose Local Image',
    insert_image_url: 'Enter Image URL',
    insert_image_url_prompt: 'Enter image URL:',
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
    agent_clear: 'Clear chat',
    agent_base_url: 'API base URL',
    agent_api_key: 'API Key',
    agent_model: 'Model name',
    agent_jina_key: 'Jina key for web search (optional)',
    agent_pdf_page_hint: 'No native PDF reading — PDFs can still be attached and are processed page-by-page as images.',
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
    agent_persona: 'Persona / style (optional)',
    agent_persona_ph: 'e.g. always academic tone; keep replies short',
    agent_sel_ref: 'Quoting selection',
    agent_tok_in: 'in',
    agent_tok_out: 'out',
    agent_jina_hint: 'Web pages cannot scrape search engines directly (CORS); search goes through the r.jina.ai proxy. Get a free key at jina.ai. Without it the model gets no search tool.',
    agent_verify: 'Self-verify when done',
    agent_verify_hint: 'After each reply, have the model check itself: was the task truly done, were the right tools called? A fail auto-retries (up to 2 rounds). Adds one extra call, slightly higher cost.',
    batch_title: 'Multi-agent batch',
    agent_pdf_layout: 'PDF layout analysis (PaddleOCR)',
    agent_pdf_layout_hint: 'Let the assistant use local PaddleOCR / PP-Structure to precisely detect titles/figures/tables in a PDF and insert them. Click below to download & set up (into an isolated env; needs Python, 3.10/3.11 recommended). Falls back to vision-based cropping when not set up.',
    agent_pdf_env_ready: 'Ready',
    agent_pdf_env_install: 'Download & set up',
    agent_pdf_env_reinstall: 'Reinstall',
    agent_pdf_env_uninstall: 'Uninstall',
    agent_pdf_env_installing: 'Downloading & setting up (large, may take minutes — keep open)…',
    agent_pdf_env_uninstall_confirm: 'Uninstall the PDF layout environment? This deletes the downloaded dependencies (several hundred MB).',
    agent_check: 'Save & detect capabilities',
    agent_key_local_hint: 'The key is stored only in this browser',
    agent_no_tools_hint: 'This model does not support tool calling; the agent can chat but cannot read/edit the document',
    agent_empty_hint: 'I can read and edit this document, search the web, and insert PDF page snapshots. Edits appear as red/green diffs in the document for you to accept individually or all at once.',
    agent_input_placeholder: 'Ask something or request an edit… (Enter to send)',
    agent_configure_first: 'Configure the model in ⚙ settings first',
    agent_attach: 'Attach image / PDF',
    agent_drop_hint: 'Drop to attach image / PDF',
    agent_drop_unsupported: 'Only images and PDF files are supported',
    agent_drop_need_config: 'This model does not support images/PDF, or is not configured',
    agent_send: 'Send',
    agent_stop: 'Stop',
    agent_hunks_pending: 'pending changes',
    agent_accept_all: 'Accept all',
    agent_reject_all: 'Reject all',
    agent_hunk_accept: 'Accept this change',
    agent_hunk_reject: 'Reject this change',
    agent_new_chat: 'New chat',
    agent_hide: 'Hide agent',
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
    agent_sec_extra: 'Enhancements',
    agent_ctx_used: 'Context used',
    missing_img_banner: '{n} image(s) in this document can’t be shown: their data was not saved with the document (usually from copying or generating it outside Knote). If you have the originals, re-insert and save.',
    missing_img_dismiss: 'Dismiss',
    files: 'Files',
    file_new: 'New file',
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
    fold_section: 'Fold / unfold',
    folder_search_placeholder: 'Search across folder…',
    folder_search_none: 'No matches found',
    folder_search_count: '{f} files, {n} matches',
    searching: 'Searching…',
    history: 'Version history',
    history_empty: 'No previous versions yet',
    history_restore: 'Restore this version',
    history_restored: 'Restored (Ctrl+Z to undo)',
    history_current: 'Current',
    history_preview_hint: 'Click a version to preview',
    history_close: 'Close',
    export_html: 'Export HTML',
    shortcuts: 'Shortcuts',
    shortcuts_title: 'Keyboard shortcuts',
    align_left: 'Align Left',
    align_center: 'Align Center',
    align_right: 'Align Right',
    outline: 'Outline',
    outline_empty: 'No headings yet',
    text_color: 'Text Color',
    bg_color: 'Background',
    default_color: 'Default',
    drag_move: 'Drag to move this block',
    stats_tooltip: 'Count fluctuations may differ due to Markdown consistency. The editor automatically trims trailing whitespace and file-end newlines. Contact author if this affects use.'
  }
}

const t = (key) => translations[lang.value][key] || key

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
    if (lang && hljs.getLanguage(lang)) {
      return `<pre class="hljs"><code class="language-${lang}" data-code="${encoded}">${hljs.highlight(code, { language: lang }).value}</code></pre>`
    }
    return `<pre class="hljs"><code class="language-plaintext" data-code="${encoded}">${md.utils.escapeHtml(code)}</code></pre>`
  }
})
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
    ADD_ATTR: ['checked', 'type', 'disabled', 'style', 'data-knote-emoji', 'class', 'data-code'] 
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
// generation token: resolves are async (IPC / FileReader) and every doc open
// clears + refills the map — a stale in-flight resolve from the PREVIOUS doc
// must not land in the next doc's freshly cleared map (it could shadow a
// same-named path with the wrong image, or corrupt the set-swap)
let relImgGen = 0
const clearRelImages = () => { relImgGen++; for (const k in relImages) delete relImages[k] }
// display-boundary swaps (both `](path)` and `](path "title")` forms)
const relPathsToDataUrls = (mdText) => {
  let out = mdText || ''
  for (const p in relImages) {
    const url = relImages[p]
    out = out.split(`](${p})`).join(`](${url})`).split(`](${p} `).join(`](${url} `)
  }
  return out
}
const dataUrlsToRelPaths = (mdText) => {
  let out = mdText || ''
  for (const p in relImages) {
    const url = relImages[p]
    out = out.split(`](${url})`).join(`](${p})`).split(`](${url} `).join(`](${p} `)
  }
  return out
}
const relImgFileToDataUrl = (fileHandle) => fileHandle.getFile().then((file) => new Promise((res, rej) => {
  const r = new FileReader()
  r.onload = () => res(r.result)
  r.onerror = rej
  r.readAsDataURL(file)
}))
const resolveRelImagePath = async (dirHandle, relPath) => {
  const clean = relPath.replace(/^\.\//, '')
  // reject absolute paths and parent traversal (stay inside the doc's folder)
  if (clean.startsWith('/') || clean.split('/').includes('..')) return null
  const segs = clean.split('/').filter(Boolean).map(decodeURIComponent)
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
const REL_IMG_RE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g
const loadRelativeImages = async (dirHandle) => {
  if (!dirHandle) return
  const gen = relImgGen // superseded the moment another doc clears the map
  const paths = new Set()
  let m
  REL_IMG_RE.lastIndex = 0
  while ((m = REL_IMG_RE.exec(content.value))) {
    const p = m[1]
    if (/^(data:|https?:|knote-img:|blob:|file:|#|\/)/i.test(p)) continue
    paths.add(p)
  }
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
const persistImageToAssets = async (id, dataUrl) => {
  if (!docDir.value || !dataUrl || !dataUrl.startsWith('data:image/')) return null
  const relPath = `assets/knote-${id}.${mimeToExt(dataUrl)}`
  if (relImages[relPath]) return relPath // already written this session
  try {
    await writeAssetFile(docDir.value, `knote-${id}.${mimeToExt(dataUrl)}`, dataUrl)
    relImages[relPath] = dataUrl // display resolves immediately, no reload
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
let assetsFlushTimer = null
let migratingAssets = false
const flushImagesToAssets = async () => {
  if (migratingAssets || !docDir.value || pendingHunks.value.length) return
  const re = /knote-img:([^\s)"'\]]+)/g
  const ids = new Set()
  let m
  while ((m = re.exec(content.value))) { if (imageStore[m[1]]) ids.add(m[1]) }
  if (!ids.size) return
  const conv = []
  for (const id of ids) {
    const rel = await persistImageToAssets(id, imageStore[id])
    if (rel) conv.push([id, rel])
  }
  if (!conv.length) return
  migratingAssets = true
  let out = content.value
  for (const [id, rel] of conv) out = out.split(`knote-img:${id}`).join(rel)
  if (out !== content.value) content.value = out
  nextTick(() => { migratingAssets = false })
}
const scheduleAssetsFlush = () => {
  if (!docDir.value) return
  clearTimeout(assetsFlushTimer)
  assetsFlushTimer = setTimeout(flushImagesToAssets, 500)
}
watch(content, () => { if (!migratingAssets) scheduleAssetsFlush() })

// true while the document references local relative-path images that haven't
// been resolved (a single file opened via the browser picker has no directory
// handle — the user can grant its folder to load them)
const relImagesNeedGrant = ref(false)
const hasUnresolvedRelImages = () => {
  REL_IMG_RE.lastIndex = 0
  let m
  while ((m = REL_IMG_RE.exec(content.value))) {
    const p = m[1]
    if (/^(data:|https?:|knote-img:|blob:|file:|#|\/)/i.test(p)) continue
    if (!relImages[p]) return true
  }
  return false
}
// user grants the document's own folder (only way the browser exposes a
// directory) so ![](relative/x.png) images can be read
const grantImageFolder = async () => {
  if (!globalThis.showDirectoryPicker) { globalThis.alert(t('folder_unsupported')); return }
  try {
    const dir = await globalThis.showDirectoryPicker({ mode: 'read' })
    await loadRelativeImages(dir)
    relImagesNeedGrant.value = hasUnresolvedRelImages()
    notify(relImagesNeedGrant.value
      ? (lang.value === 'zh' ? '部分图片仍未找到，请确认选的是该文档所在文件夹' : 'Some images still missing — pick the document’s own folder')
      : (lang.value === 'zh' ? '图片已加载' : 'Images loaded'))
  } catch (err) {
    if (err && err.name !== 'AbortError') console.error('Grant image folder error:', err)
  }
}

// A `knote-img:<id>` reference is a SESSION-LOCAL pointer into imageStore. Knote's
// own save/export always inlines it to a real data URL (imageStore is never
// cleared, so the data is always there). But if a document is written out through
// the COMPACT form — e.g. an agent reads the doc and saves it to a file directly,
// bypassing Knote's inlining export — the image bytes never travel with it. On
// open those refs are dangling and their images can't be shown. Surface that
// (a count of refs with no data) instead of leaving silent blank images.
const missingImageCount = computed(() => {
  const re = /knote-img:([^\s)"'\]]+)/g
  const seen = new Set()
  let m
  let n = 0
  while ((m = re.exec(content.value))) {
    const id = m[1]
    if (seen.has(id)) continue
    seen.add(id)
    if (!imageStore[id]) n++
  }
  return n
})
const missingImgDismissed = ref(false)
// re-show the warning whenever the set of missing images changes (a new doc, or
// images added/removed) — but stay dismissed while merely typing (count stable)
watch(missingImageCount, () => { missingImgDismissed.value = false })

const generateImageId = () => {
  imageIdCounter++
  return `img-${Date.now()}-${imageIdCounter}`
}

const renderedHtml = computed(() => {
  // Empty rows: reuse the editor's exact conversion (fence-aware, correct
  // leading/trailing handling) — each empty row becomes a `&nbsp;` line,
  // which markdown-it renders as an empty-looking paragraph. This keeps the
  // split preview's row count identical to the single-mode editor.
  // Swap knote-img: references back to real data URLs for rendering
  let processedContent = content.value
  for (const [id, url] of Object.entries(imageStore)) {
    processedContent = processedContent.split(`knote-img:${id}`).join(url)
  }
  // resolve relative-path images to their data URLs for display (content stays
  // untouched — this is a derived value)
  processedContent = relPathsToDataUrls(processedContent)
  const preserved = toInternal(processedContent)
  
  let html = md.render(preserved)
  
  html = html.replace(/<p>\s*:::\s*align:(\w+)\s*:::\s*<\/p>\s*<p>/g, (match, align) => {
      return `<p style="text-align: ${align}">`
  })
  html = html.replace(/<p>\s*:::\s*align:(\w+)\s*:::\s*/g, (match, align) => {
      return `<p style="text-align: ${align}">`
  })
  html = html.replace(/<p>\s*:::\s*align:\w+\s*:::\s*<\/p>/g, '')
  
  return sanitizeHtml(html)
})

// Render mermaid diagrams in the split preview after each HTML update AND
// when entering split mode (switching in doesn't change renderedHtml)
const renderPreviewMermaid = () => {
  if (viewMode.value !== 'split') return
  nextTick(() => {
    const root = document.querySelector('.knote-md-render')
    if (!root) return
    const isDark = ((document.querySelector('[data-theme]') || document.documentElement).getAttribute('data-theme') || '').includes('dark')
    renderMermaidIn(root, isDark)
  })
}
watch(renderedHtml, renderPreviewMermaid, { flush: 'post' })
watch(() => viewMode.value, (m) => { if (m === 'split') renderPreviewMermaid() })

// ------ BLOCK SPLITTER ENGINE ------

// Per-block HTML render with content-addressed caching: on every keystroke
// commit the whole document re-parses, but only blocks whose raw text changed
// need to go through markdown-it again. The imageStore watcher clears the
// cache because rendered HTML embeds resolved data URLs.
const blockHtmlCache = new Map()
watch(imageStore, () => blockHtmlCache.clear())

const renderBlockHtml = (rawContent) => {
  const cached = blockHtmlCache.get(rawContent)
  if (cached !== undefined) return cached

  let html = md.render(rawContent)
  for (const [id, url] of Object.entries(imageStore)) {
    html = html.split(`knote-img:${id}`).join(url)
  }
  // Apply alignment markers (::: align:x :::) the same way renderedHtml does,
  // so aligned paragraphs display correctly in single mode too
  html = html.replace(/<p>\s*:::\s*align:(\w+)\s*:::\s*<\/p>\s*<p>/g, (m, align) => `<p style="text-align: ${align}">`)
  html = html.replace(/<p>\s*:::\s*align:(\w+)\s*:::\s*/g, (m, align) => `<p style="text-align: ${align}">`)
  html = html.replace(/<p>\s*:::\s*align:\w+\s*:::\s*<\/p>/g, '')

  if (blockHtmlCache.size > 1000) blockHtmlCache.clear()
  blockHtmlCache.set(rawContent, html)
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
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__knoteDebug = {
    getContent: () => content.value,
    getEditor: () => richEditorRef.value ? richEditorRef.value.editor : null,
    // the LIVE agent store instance (a bare dynamic import may resolve to a
    // different HMR-versioned module and mutate the wrong instance)
    agent: () => import('./lib/agentStore.js'),
    // folder-tree test hook: inject any FileSystemDirectoryHandle (e.g. OPFS)
    folder: {
      setHandle: async (h, name) => {
        folderHandle.value = h
        folderName.value = name || h.name || 'test'
        folderTree.value = await buildFolderTree(h)
      },
      tree: () => folderTree.value,
      create: () => createMdFile(),
      rename: (node) => renameTreeFile(node),
      refresh: () => refreshFolder(),
      open: (node) => openTreeFile(node)
    },
    // tab test hooks
    tabs: {
      list: () => tabs.value.map((tb) => ({
        id: tb.id,
        kind: tabKindOf(tb),
        label: tabLabelOf(tb),
        active: tb.id === activeTabId.value
      })),
      switch: (id) => switchTab(id),
      close: (id) => closeTab(id),
      create: () => newTab(),
      openFolderHandle: (h, name) => adoptFolderHandle(h, name),
      openFileHandle: (h) => openFileFromHandle(h)
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
const stats = computed(() => {
  let text = content.value
  
  // 1. Strip knote-img references: ![...](knote-img:...)
  text = text.replace(/!\[.*?\]\(knote-img:[^)]+\)/g, '')
  
  // 2. Strip Magic Markers: ::: align:mode :::
  // We also strip a trailing newline if it exists to avoid phantom lines
  text = text.replace(/:::\s*align:\w+\s*:::\n?/g, '')
  
  // 3. Strip ZWS and Windows Carriage Returns
  text = text.replace(/[\u200B\r]/g, '')
  
  const chars = text.length
  // Count non-empty lines only, so blank separators don't inflate the metric
  const lines = text.split('\n').filter(l => l.trim().length > 0).length
  // Simple word count
  const words = text.trim().split(/\s+/).filter(Boolean).length

  return { chars, lines, words }
})


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
const exportableMarkdown = () => {
  let out = content.value
  for (const [id, url] of Object.entries(imageStore)) {
    out = out.split(`knote-img:${id}`).join(url)
  }
  return out
}

// Inverse on import: register embedded data URLs into the image store and
// replace them with short references so the source stays readable.
const importMarkdown = (text) => {
  // Normalize CRLF/CR: the empty-row conventions and the preview's newline
  // handling all assume \n line endings
  let next = (text || '').replace(/\r\n?/g, '\n')
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

const clearAll = () => {
  const msg = lang.value === 'zh'
    ? '确定要清除全部内容吗？此操作会同步到已打开的本地文件。'
    : 'Clear the entire document? This also updates the opened local file.'
  if (!window.confirm(msg)) return
  resetEditingState()
  content.value = ''
}

const loadSample = () => {
  // Never silently destroy work: confirm when the doc has content, DETACH
  // any opened file first (auto-save must not write the sample into it),
  // and record the swap in the editor history so Ctrl+Z restores the doc.
  if (content.value.trim()) {
    const msg = lang.value === 'zh'
      ? '加载示例会替换当前文档的显示内容（可用 Ctrl+Z 撤回）。已打开的本地文件会先断开连接，文件本身不会被写入示例。是否继续？'
      : 'Loading the sample replaces the current document view (Ctrl+Z restores it). Any opened local file is detached first and will NOT be overwritten. Continue?'
    if (!window.confirm(msg)) return
  }
  resetEditingState()
  clearTimeout(autoSaveTimer)
  currentFileHandle.value = null
  isLocalFile.value = false
  currentFileName.value = ''
  activeTreePath.value = ''
  content.value = sample
  if (viewMode.value === 'single' && richEditorRef.value) {
    richEditorRef.value.applyExternal(richMarkdown.value)
  }
}

// ========== Undo/Redo System ==========

// ========== Selection Persistence Helpers ==========
const getSelectionSnapshot = () => {
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
    
    if (viewMode.value === 'split' && snapshot.type === 'split') {
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

const setViewMode = (mode) => {
    if (viewMode.value === mode) return
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
}

const pushUndo = () => {
  if (isUndoRedoAction) return
  undoStack.value.push(lastSavedSnapshot)
  if (undoStack.value.length > MAX_UNDO) undoStack.value.shift()
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
  if (viewMode.value === 'single' && richEditorRef.value) {
    richEditorRef.value.undo()
    return
  }
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
  lastSavedSnapshot = prev
  
  // Block engine reactively re-renders when content.value changes - no manual preview needed
  
  nextTick(() => {
      restoreSelectionSnapshot(prev.selection)
      isUndoRedoAction = false
  })
}

const redo = () => {
  if (viewMode.value === 'single' && richEditorRef.value) {
    richEditorRef.value.redo()
    return
  }
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
  lastSavedSnapshot = next
  
  // Block engine reactively re-renders when content.value changes - no manual preview needed
  
  nextTick(() => {
      restoreSelectionSnapshot(next.selection)
      isUndoRedoAction = false
  })
}


// ========== File Management ==========
// Load a .md FILE HANDLE (picker / drag-drop) into a NEW doc tab (a pristine
// current tab is reused instead — see openInNewTab)
const openFileFromHandle = async (handle) => {
  // Ask for WRITE access now, inside the user gesture — the open picker
  // only grants read, and a permission prompt can't be shown later from
  // the auto-save timer. Granted => live-save (green indicator).
  let writable = true
  if (handle.requestPermission) {
    writable = (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
  }
  const file = await handle.getFile()
  const text = await file.text()
  openInNewTab()
  resetEditingState()
  clearRelImages()
  content.value = importMarkdown(text)
  currentFileHandle.value = writable ? handle : null
  currentFileName.value = file.name
  isLocalFile.value = writable
  // Reset undo history for new file
  undoStack.value = []
  redoStack.value = []
  lastSavedSnapshot = { content: content.value, selection: null }
  // a picker-opened file has no directory handle — if it references local
  // relative-path images, offer a one-click folder grant to load them
  relImagesNeedGrant.value = hasUnresolvedRelImages()
  docDir.value = null // no parent dir from a single-file picker: keep inline
}

const openLocalFile = async () => {
  try {
    // desktop: native dialog feeding the same open pipeline as double-click
    // opens — path-backed handle, auto-save roots and the recents list all
    // come for free (the FS-Access picker below returns PATHLESS handles,
    // which is why in-app opens never showed up under 最近打开)
    if (isDesktopShell && window.knoteDesktop.pickOpen) {
      await window.knoteDesktop.pickOpen('file')
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
        const text = await file.text()
        openInNewTab()
        resetEditingState()
        clearRelImages()
        content.value = importMarkdown(text)
        currentFileName.value = file.name
        isLocalFile.value = false // Can't write back without FileSystemAccess
        currentFileHandle.value = null
        undoStack.value = []
        redoStack.value = []
        lastSavedSnapshot = { content: content.value, selection: null }
        relImagesNeedGrant.value = hasUnresolvedRelImages()
        docDir.value = null
      }
      input.click()
    }
  } catch (err) {
    if (err.name !== 'AbortError') console.error('Open file error:', err)
  }
}

const saveToFileHandle = async (handle) => {
  try {
    isSaving.value = true
    // Permission can lapse (e.g. after a reload); without this check every
    // debounced auto-save spams NotAllowedError into the console
    if (handle.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if (!handle.requestPermission || (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        isLocalFile.value = false
        return
      }
    }
    const writable = await handle.createWritable()
    await writable.write(exportableMarkdown())
    await writable.close()
    // each successful disk save is a natural version checkpoint
    takeSnapshot()
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      isLocalFile.value = false
    } else {
      console.error('Save error:', err)
    }
  } finally {
    isSaving.value = false
  }
}

// ---- Version snapshots (local history + rollback) ----
// A stable per-document key: prefer the disk path (deskKey), else the file
// name, else the active tab id so scratch docs still get history.
const snapshotDocKey = () => {
  const tb = activeTab && activeTab()
  if (tb && tb.deskKey) return tb.deskKey
  if (currentFileHandle.value && currentFileHandle.value._deskPath) return 'file:' + currentFileHandle.value._deskPath
  if (currentFileName.value) return 'name:' + currentFileName.value
  return 'scratch:' + (tb ? tb.id : '0')
}
const takeSnapshot = (label = '') => {
  try { addSnapshot(snapshotDocKey(), content.value, Date.now(), label) } catch { /* ignore */ }
}
const historyPanel = ref({ open: false, items: [], previewIndex: -1 })
const openHistory = () => {
  commitActiveBlockIfAny()
  takeSnapshot('current') // capture the live state so it's in the list
  historyPanel.value = { open: true, items: listSnapshots(snapshotDocKey()), previewIndex: -1, key: snapshotDocKey() }
}
const closeHistory = () => { historyPanel.value.open = false }
const historyPreview = computed(() => {
  const h = historyPanel.value
  if (!h.open || h.previewIndex < 0) return ''
  const item = h.items[h.previewIndex]
  return item ? (getSnapshot(h.key, item.index) || '') : ''
})
const restoreSnapshot = (item) => {
  const md = getSnapshot(historyPanel.value.key, item.index)
  if (md == null) return
  resetEditingState()
  content.value = importMarkdown(md)
  if (viewMode.value === 'single' && richEditorRef.value) richEditorRef.value.applyExternal(richMarkdown.value)
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
  if (viewMode.value === 'single' && activeBlockId.value) {
    const block = parsedBlocks.value.find(b => b.id === activeBlockId.value)
    if (block) commitBlockEdit(block)
  }
}

const saveFile = async () => {
  commitActiveBlockIfAny()
  if (isLocalFile.value && currentFileHandle.value) {
    // Direct save to local file
    await saveToFileHandle(currentFileHandle.value)
  } else {
    // First save: prompt user to pick location
    try {
      if (globalThis.showSaveFilePicker) {
        const handle = await globalThis.showSaveFilePicker({
          suggestedName: `knote-${localDateStamp()}.md`,
          types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }]
        })
        await saveToFileHandle(handle)
        currentFileHandle.value = handle
        const file = await handle.getFile()
        currentFileName.value = file.name
        isLocalFile.value = true
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
// tab switches swap `content` wholesale — that's navigation, not an edit:
// no undo snapshot, no autosave marking
let restoringTab = false
watch(() => content.value, () => {
  if (restoringTab) return
  // Track undo (skipped during undo/redo transitions)
  scheduleUndoSnapshot()

  // Auto-save to local file. Undo/redo results must also reach the disk —
  // otherwise the file keeps the undone content forever.
  if (isLocalFile.value && currentFileHandle.value) {
    autoSaveDirty = true
    clearTimeout(autoSaveTimer)
    autoSaveTimer = setTimeout(() => {
      autoSaveDirty = false
      saveToFileHandle(currentFileHandle.value)
    }, 1000)
  }
})

// Moving the caret to another row is a natural commit point: flush the
// pending auto-save immediately instead of waiting out the debounce
const flushAutoSave = () => {
  if (!autoSaveDirty || !isLocalFile.value || !currentFileHandle.value) return
  clearTimeout(autoSaveTimer)
  autoSaveDirty = false
  saveToFileHandle(currentFileHandle.value)
}

// ========== Folder tree (File System Access API) ==========
const folderHandle = ref(null)
const folderName = ref('')
const folderTree = ref([])
const expandedDirs = ref(new Set())
const activeTreePath = ref('')

const buildFolderTree = async (dirHandle, path = '', depth = 0) => {
  if (depth > 6) return []
  const dirs = []
  const files = []
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'directory') {
      if (name.startsWith('.') || name === 'node_modules') continue
      const children = await buildFolderTree(handle, `${path}/${name}`, depth + 1)
      // show ALL directories (incl. empty ones) so the folder structure is
      // browsable and user-created folders appear immediately. The handle +
      // parent enable new-file/new-folder/rename/delete on the node.
      dirs.push({ name, kind: 'dir', handle, parent: dirHandle, path: `${path}/${name}`, children })
    } else if (/\.(md|markdown)$/i.test(name)) {
      // parent handle enables rename (move/copy+delete) later
      files.push({ name, kind: 'file', handle, parent: dirHandle, path: `${path}/${name}` })
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name)
  return [...dirs.sort(byName), ...files.sort(byName)]
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

const adoptFolderHandle = async (handle, name, deskKey = '') => {
  if (deskKey) {
    const existing = tabs.value.find((tb) => sameDeskKey(tb.deskKey, deskKey))
    if (existing) {
      if (existing.id !== activeTabId.value) switchTab(existing.id)
      return
    }
  }
  const tree = await buildFolderTree(handle)
  openInNewTab()
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
  content.value = ''
  undoStack.value = []
  redoStack.value = []
  lastSavedSnapshot = { content: '', selection: null }
  relImagesNeedGrant.value = false
  docDir.value = null // no file open yet; set when a tree file is opened
  folderHandle.value = handle
  folderName.value = name || handle.name
  folderTree.value = tree
  expandedDirs.value = new Set()
  activeTreePath.value = ''
  activeDirPath.value = ''
  outlineVisible.value = true
  const tb = activeTab()
  if (tb && deskKey) tb.deskKey = deskKey
}

const openFolder = async () => {
  try {
    // desktop: same native-dialog route as openLocalFile (recents included)
    if (isDesktopShell && window.knoteDesktop.pickOpen) {
      await window.knoteDesktop.pickOpen('folder')
      return
    }
    // Android app: no directory picker in the WebView — open the standing
    // "Knote" workspace folder through the native filesystem adapter
    if (isNativeApp()) {
      const nh = await openNativeWorkspace()
      if (!nh) {
        globalThis.alert(t('folder_unsupported'))
        return
      }
      await adoptFolderHandle(nh, nh.name)
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
  if (!folderHandle.value) return
  try {
    folderTree.value = await buildFolderTree(folderHandle.value)
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
  await openTreeFile(node)
  // let the doc render, then jump to the line (proportional scroll)
  nextTick(() => setTimeout(() => { if (agentBridge.scrollToLine) agentBridge.scrollToLine(line) }, 320))
}

// In-app text prompt (window.prompt is unsupported in the Electron shell —
// it returns null there, which broke new-file / rename). Returns the trimmed
// input, or null if cancelled.
const promptState = ref(null) // { title, value, resolve } | null
const promptInputRef = ref(null)
const promptInput = (title, defaultValue = '') => new Promise((resolve) => {
  promptState.value = { title, value: defaultValue, resolve }
  nextTick(() => {
    const el = promptInputRef.value
    if (el) { el.focus(); el.select() }
  })
})
const resolvePrompt = (accepted) => {
  const p = promptState.value
  if (!p) return
  promptState.value = null
  if (p.mode === 'confirm') {
    p.resolve(accepted ? 'yes' : null)
    return
  }
  const val = accepted ? String(p.value || '').trim() : null
  p.resolve(val || null)
}

// yes/no variant of the same dialog (no input row)
const confirmDialog = (title) => new Promise((resolve) => {
  promptState.value = { title, value: '', mode: 'confirm', resolve: (v) => resolve(v !== null) }
})

// ---- Shared context menu (right-click) ----
// One renderer for every zone: the editor emits its items, the file tree
// builds its own. Items: { label, action, danger?, disabled? } | { divider }
const ctxMenu = ref(null) // { x, y, items }
const openCtxMenu = (x, y, items) => {
  const rows = items.filter((i) => !i.divider).length
  const dividers = items.length - rows
  const estH = rows * 32 + dividers * 9 + 12
  const estW = 208
  ctxMenu.value = {
    x: Math.min(x, window.innerWidth - estW - 8),
    y: Math.min(y, window.innerHeight - estH - 8),
    items
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
const canRevealNode = (node) => !!(window.knoteDesktop && window.knoteDesktop.reveal && node.handle && node.handle._deskPath)
const revealNodeInExplorer = async (node) => {
  try {
    await window.knoteDesktop.reveal(node.handle._deskPath)
  } catch (err) {
    console.error('Reveal error:', err)
    globalThis.alert(`${t('ctx_open_as_folder')} 失败：${String(err.message || err)}`)
  }
}

const openTreeCtxMenu = (node, e) => {
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
        ...(canRevealNode(node) ? [{ label: t('ctx_open_as_folder'), action: () => revealNodeInExplorer(node) }] : []),
        { label: t('file_rename'), action: () => renameTreeFile(node) },
        { label: t('ctx_move'), action: () => { moveState.value = { node } } },
        { label: t('ctx_copy_name'), action: () => navigator.clipboard.writeText(node.name).catch(() => {}) },
        { divider: true },
        { label: t('ctx_delete'), danger: true, action: () => deleteTreeFile(node) }
      ]
  openCtxMenu(e.clientX, e.clientY, items)
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
      : (zh ? `删除${noun}「${node.name}」${folderWarn}？此操作不可恢复。` : `Delete ${noun} "${node.name}"${folderWarn}? This cannot be undone.`)
  )
  if (!ok) return
  try {
    if (canTrash) await window.knoteDesktop.trash(node.handle._deskPath)
    else await node.parent.removeEntry(node.name, { recursive: isDir })
    // dropping the active file, or a folder that contains it, clears state
    if (activeTreePath.value === node.path || (isDir && activeTreePath.value.startsWith(node.path + '/'))) {
      currentFileHandle.value = null
      isLocalFile.value = false
      currentFileName.value = ''
      activeTreePath.value = ''
    }
    await refreshFolder()
    notify(canTrash ? (zh ? '已移到回收站' : 'Moved to Recycle Bin') : (zh ? '已删除' : 'Deleted'))
  } catch (err) {
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
  let name = await promptInput(`${t('file_new_prompt')}（→ ${folderName.value}${createTargetLabel(base)}）`, '未命名.md')
  if (!name) return
  name = name.trim()
  if (!name) return
  if (/[\\/:*?"<>|]/.test(name)) { globalThis.alert(t('file_bad_name')); return }
  if (!/\.(md|markdown)$/i.test(name)) name += '.md'
  try {
    await dir.getFileHandle(name)
    globalThis.alert(t('file_exists'))
    return
  } catch { /* not found — good */ }
  try {
    const fh = await dir.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    await w.write(`# ${name.replace(/\.(md|markdown)$/i, '')}\n`)
    await w.close()
    await refreshFolder()
    if (parentNode) expandedDirs.value = new Set([...expandedDirs.value, parentNode.path])
    await openTreeFile({ name, kind: 'file', handle: fh, parent: dir, path: `${base}/${name}` })
  } catch (err) {
    console.error('Create file error:', err)
    globalThis.alert(`${t('file_new')} 失败：${String(err.message || err)}`)
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
    globalThis.alert(`${t('folder_new')} 失败：${String(err.message || err)}`)
  }
}

const renameTreeFile = async (node, e) => {
  if (e) e.stopPropagation()
  let name = await promptInput(t('file_rename_prompt'), node.name)
  if (!name) return
  name = name.trim()
  if (!name || name === node.name) return
  if (!/\.(md|markdown)$/i.test(name)) name += '.md'
  try {
    await node.parent.getFileHandle(name)
    globalThis.alert(t('file_exists'))
    return
  } catch { /* target free */ }
  try {
    let newHandle = node.handle
    if (typeof node.handle.move === 'function') {
      // Chromium supports in-place rename; the handle then points at the new name
      await node.handle.move(name)
    } else {
      // fallback: copy + delete
      const file = await node.handle.getFile()
      newHandle = await node.parent.getFileHandle(name, { create: true })
      const w = await newHandle.createWritable()
      await w.write(await file.text())
      await w.close()
      await node.parent.removeEntry(node.name)
    }
    if (activeTreePath.value === node.path) {
      currentFileName.value = name
      currentFileHandle.value = newHandle
      activeTreePath.value = node.path.replace(/[^/]+$/, name)
    }
    await refreshFolder()
  } catch (err) {
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
    const srcDesk = node.handle._deskPath
    const destDesk = destHandle._deskPath
    if (srcDesk && destDesk && window.knoteDesktop && window.knoteDesktop.fsRename) {
      // desktop: one atomic rename (works for files AND directories)
      const sep = destDesk.includes('\\') ? '\\' : '/'
      await window.knoteDesktop.fsRename(srcDesk, destDesk.replace(/[\\/]$/, '') + sep + node.name)
    } else if (node.kind === 'file' && typeof node.handle.move === 'function') {
      // FSA file move (falls back to copy+delete if the browser refuses)
      try { await node.handle.move(destHandle, node.name) } catch {
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
    globalThis.alert(`${t('ctx_move')} 失败：${String(err.message || err)}`)
  }
}

const openTreeFile = async (node) => {
  try {
    // Confirm WRITE access now, inside the click gesture — the directory
    // grant doesn't always cover per-file readwrite, and the auto-save timer
    // can't show a permission prompt later. Granted => live-save (green).
    let writable = true
    if (node.handle.queryPermission && (await node.handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      writable = node.handle.requestPermission
        ? (await node.handle.requestPermission({ mode: 'readwrite' })) === 'granted'
        : false
    }
    const file = await node.handle.getFile()
    resetEditingState()
    clearRelImages()
    content.value = importMarkdown(await file.text())
    currentFileHandle.value = writable ? node.handle : null
    currentFileName.value = file.name
    isLocalFile.value = writable
    autoSaveDirty = false
    undoStack.value = []
    redoStack.value = []
    lastSavedSnapshot = { content: content.value, selection: null }
    activeTreePath.value = node.path
    // the opened file's own folder becomes the new-file/new-folder target
    activeDirPath.value = node.path.replace(/\/[^/]*$/, '')
    // resolve ![](relative/path) images against the file's own folder — a
    // folder workspace always has the directory handle, so no grant needed
    relImagesNeedGrant.value = false
    docDir.value = node.parent // new images persist into <this folder>/assets/
    loadRelativeImages(node.parent)
  } catch (err) {
    console.error('Open tree file error:', err)
  }
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
  { k: 'Ctrl + Z / Y', d: lang.value === 'zh' ? '撤销 / 重做' : 'Undo / Redo' },
  { k: 'Ctrl + B / I / U', d: lang.value === 'zh' ? '加粗 / 斜体 / 下划线' : 'Bold / Italic / Underline' },
  { k: 'Ctrl + Tab', d: lang.value === 'zh' ? '切换标签页' : 'Switch tab' },
  { k: 'Ctrl + ' + (lang.value === 'zh' ? '滚轮' : 'Wheel'), d: lang.value === 'zh' ? '缩放界面' : 'Zoom UI' },
  { k: 'Ctrl + 0', d: lang.value === 'zh' ? '重置缩放' : 'Reset zoom' },
  { k: lang.value === 'zh' ? '双击图片' : 'Double-click image', d: lang.value === 'zh' ? '放大查看' : 'Open viewer' },
  { k: 'Esc', d: lang.value === 'zh' ? '关闭弹层' : 'Close overlay' }
]))

// ========== Rich editor (single mode, TipTap) ==========
const richEditorRef = ref(null)

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

// ========== Agent (AI assistant) ==========
// Document bridge: the agent reads the compact model (knote-img refs) and
// writes back through importMarkdown so inserted data-URL images register
// in the imageStore automatically.
agentBridge.getMarkdown = () => {
  // the agent must read the CURRENT document, not the debounced mirror
  if (richEditorRef.value && richEditorRef.value.flushEmit) richEditorRef.value.flushEmit()
  return content.value
}
agentBridge.applyMarkdown = (md) => {
  resetEditingState()
  content.value = importMarkdown(md || '')
  // push the change into the editor's undo history so Ctrl+Z reverts an
  // accepted agent edit; the direct call sets lastEmitted, so the modelValue
  // watcher skips its own history-less sync of the same value
  if (viewMode.value === 'single' && richEditorRef.value) {
    richEditorRef.value.applyExternal(richMarkdown.value)
  }
}
agentBridge.scrollToLine = (line) => {
  const total = Math.max(1, content.value.split('\n').length)
  // desktop shell: the app root is the scroll container (the document
  // doesn't scroll there — the title bar strip must stay clear)
  const root = document.querySelector('.knote-root')
  const el = (root && root.scrollHeight > root.clientHeight + 1) ? root : document.scrollingElement
  if (el) el.scrollTo({ top: (el.scrollHeight - el.clientHeight) * Math.min(1, line / total), behavior: 'smooth' })
}
// In-document diff of the staged hunks (red tint on old blocks + green boxes
// with per-hunk ✓/✕). Deferred to nextTick: accepting a hunk changes content,
// and the paint must land AFTER the editor has synced the new doc.
agentBridge.previewChange = (payload) => {
  nextTick(() => {
    if (viewMode.value === 'single' && richEditorRef.value) richEditorRef.value.setAgentPreview(payload)
  })
}
agentBridge.clearPreview = () => {
  nextTick(() => { if (richEditorRef.value) richEditorRef.value.clearAgentPreview() })
}

// Folder workspace: read-only visibility into the opened folder's .md files
const walkTreeFiles = (nodes, out) => {
  for (const n of nodes) {
    if (n.kind === 'dir') walkTreeFiles(n.children, out)
    else out.push(n)
  }
  return out
}
agentBridge.hasFolder = () => !!folderHandle.value
agentBridge.folderName = () => folderName.value
agentBridge.listFiles = () => {
  if (!folderHandle.value) return null
  return walkTreeFiles(folderTree.value, []).map((n) => ({
    path: n.path.replace(/^\//, ''),
    active: n.path === activeTreePath.value || n.handle === currentFileHandle.value
  }))
}
agentBridge.readFile = async (path) => {
  if (!folderHandle.value) return null
  const norm = '/' + String(path).replace(/^\/+/, '')
  const node = walkTreeFiles(folderTree.value, []).find((n) => n.path === norm)
  if (!node) return null
  try {
    const f = await node.handle.getFile()
    return await f.text()
  } catch { return null }
}
// create a NEW workspace file (used by batch_process). Never overwrites — on a
// name collision it appends -2/-3/... Returns the actual relative path written.
// reservedWritePaths closes the concurrent check-then-create race: batch runs
// several writeFile()s at once, and two whose names collide would otherwise
// both pass the async existence probe and clobber each other. Reserving the
// chosen name SYNCHRONOUSLY (before any await) makes a peer skip it.
const reservedWritePaths = new Set()
agentBridge.writeFile = async (relPath, content) => {
  if (!folderHandle.value) return null
  try {
    const segs = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean)
    let fname = segs.pop() || 'untitled.md'
    if (!/\.(md|markdown)$/i.test(fname)) fname += '.md'
    let dir = folderHandle.value
    for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: true })
    const dot = fname.lastIndexOf('.'); const base = fname.slice(0, dot); const ext = fname.slice(dot)
    const dirKey = segs.join('/').toLowerCase()
    let finalName = ''; let key = ''
    for (let n = 1; n < 1000; n++) {
      const cand = n === 1 ? fname : `${base}-${n}${ext}`
      const k = dirKey + '/' + cand.toLowerCase()
      if (reservedWritePaths.has(k)) continue // an in-flight write already took it
      reservedWritePaths.add(k) // reserve SYNCHRONOUSLY, before the await below
      let onDisk = false
      try { await dir.getFileHandle(cand); onDisk = true } catch { onDisk = false }
      if (onDisk) { reservedWritePaths.delete(k); continue } // taken on disk — next
      finalName = cand; key = k; break
    }
    if (!finalName) return null
    try {
      const fh = await dir.getFileHandle(finalName, { create: true })
      const w = await fh.createWritable()
      await w.write(String(content ?? ''))
      await w.close()
    } finally {
      reservedWritePaths.delete(key)
    }
    if (folderHandle.value) { try { await refreshFolder() } catch { /* tree refresh best-effort */ } }
    return (segs.length ? segs.join('/') + '/' : '') + finalName
  } catch (err) {
    console.error('agentBridge.writeFile failed:', err)
    return null
  }
}
// Register an image payload under an EXPLICIT id (agent flows: the model may
// hand-write `knote-img:att-…` refs into edits instead of calling
// insert_image — registering the attachment's bytes under that id turns the
// fabricated ref into a working one instead of a permanently broken image)
agentBridge.registerImage = (id, dataUrl) => {
  if (id && dataUrl && !imageStore[id]) imageStore[id] = dataUrl
}
// Expand knote-img refs in ARBITRARY text to data URLs (create_file writes
// straight to disk, bypassing exportableMarkdown — without this, compact refs
// in generated files would be dangling forever)
agentBridge.expandImages = (text) => {
  let out = String(text ?? '')
  for (const [id, url] of Object.entries(imageStore)) {
    out = out.split(`knote-img:${id}`).join(url)
  }
  return out
}
// create a folder (multi-level) inside the workspace; idempotent
agentBridge.createFolder = async (relPath) => {
  if (!folderHandle.value) return null
  try {
    const segs = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean)
    if (!segs.length) return null
    let dir = folderHandle.value
    for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: true })
    try { await refreshFolder() } catch { /* tree refresh best-effort */ }
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
if (isDesktopShell) document.documentElement.classList.add('knote-wco') // frosted title bar CSS
if (window.knoteDesktop) {
  const mkDesktopHandle = (p, name, initialText) => ({
    kind: 'file',
    name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFile: async () => ({ name, text: async () => initialText }),
    createWritable: async () => {
      let buf = ''
      return {
        write: async (chunk) => { buf += String(chunk) },
        close: async () => { await window.knoteDesktop.writeFile(p, buf) }
      }
    }
  })
  // a path-backed dir handle for the file's OWN folder, so ![](relative/x.png)
  // images sitting next to a file-associated .md can be resolved (main
  // registers the folder as an image-read root when it sends the open)
  const dirHandleForFile = (p) => {
    const d = String(p).replace(/[\\/][^\\/]*$/, '')
    return mkDesktopDirHandle(d, d.replace(/.*[\\/]/, '') || d)
  }
  window.knoteDesktop.onOpenFile(({ path: p, name, data }) => {
    // an already-open file (same disk path) activates its tab instead of
    // duplicating
    const key = `file:${p}`
    const existing = tabs.value.find((tb) => sameDeskKey(tb.deskKey, key))
    if (existing) {
      if (existing.id !== activeTabId.value) switchTab(existing.id)
      // reconcile with the fresh disk read — external edits (or a past
      // failed load) must win over the tab's stale snapshot. Skip only if
      // this tab has its own unflushed edits (it's ahead of the disk).
      const fresh = importMarkdown(data)
      currentFileHandle.value = mkDesktopHandle(p, name, data)
      isLocalFile.value = true
      if (!autoSaveDirty && content.value !== fresh) {
        resetEditingState()
        clearRelImages()
        content.value = fresh
        undoStack.value = []
        redoStack.value = []
        lastSavedSnapshot = { content: fresh, selection: null }
        relImagesNeedGrant.value = false // desktop resolves rel images via IPC
        docDir.value = dirHandleForFile(p)
        loadRelativeImages(dirHandleForFile(p))
      }
      return
    }
    openInNewTab()
    resetEditingState()
    clearRelImages()
    content.value = importMarkdown(data)
    currentFileHandle.value = mkDesktopHandle(p, name, data)
    currentFileName.value = name
    isLocalFile.value = true
    activeTreePath.value = ''
    undoStack.value = []
    redoStack.value = []
    lastSavedSnapshot = { content: content.value, selection: null }
    const tb = activeTab()
    if (tb) tb.deskKey = key
    relImagesNeedGrant.value = false // desktop resolves rel images via IPC
    docDir.value = dirHandleForFile(p)
    persistSession()
    addRecent('file', p, name)
    loadRelativeImages(dirHandleForFile(p))
  })
  // folders dropped onto the Knote icon / opened via argv: a path-backed
  // handle adapter (IPC fs) makes them a normal folder-tab workspace
  if (window.knoteDesktop.onOpenFolder) {
    window.knoteDesktop.onOpenFolder(async ({ path: p, name }) => {
      try {
        await adoptFolderHandle(mkDesktopDirHandle(p, name), name, `folder:${p}`)
        persistSession()
        addRecent('folder', p, name)
      } catch (err) {
        console.error('Open folder (desktop) error:', err)
      }
    })
  }
  window.knoteDesktop.ready()
  // restore last session's tabs after the bridge is live; a slight delay
  // lets any argv-opened file (double-click launch) land first so the
  // deskKey dedupe folds it into the restored set instead of duplicating.
  // Arrow-wrapped: restoreSession is declared later in setup, so referencing
  // it lazily (at fire time) avoids a temporal-dead-zone error here.
  setTimeout(() => restoreSession(), 300)
}

// Chats live per workspace: the opened FOLDER wins while one is open (files
// opened from its tree share it); otherwise the single opened file; else the
// default scratch workspace.
watch([folderHandle, currentFileHandle], () => {
  const ws = folderHandle.value
    ? `folder:${folderName.value}`
    : currentFileHandle.value ? `file:${currentFileHandle.value.name}` : ''
  setChatWorkspace(ws)
})
loadAgentPersisted()

// Chat bubbles render the assistant's markdown through the same pipeline as
// the preview (markdown-it + KaTeX + hljs), sanitized before injection.
// "第 N 行" references become clickable jump links (injected AFTER sanitize
// so our own markup survives; AgentPanel delegates the click).
const linkifyLineRefs = (html) => html.replace(
  /第\s*(\d+)(?:\s*[-–~—至]\s*\d+)?\s*行/g,
  (m, a) => `<a class="knote-line-ref" data-line="${a}">${m}</a>`
)
// The assistant likes writing ![图注](att-x / el-x / knote-img:…) in CHAT
// replies too — resolve those ids to their data URLs BEFORE render/sanitize
// (DOMPurify strips the unknown knote-img: scheme, and bare ids aren't URLs).
// Display size is capped in CSS (.knote-agent-md img); the existing dblclick
// lightbox opens the full image. Dead ids (new session, restart) degrade to a
// visible text placeholder instead of a broken image icon.
const resolveAgentChatImages = (mdText) => String(mdText || '').replace(
  /!\[([^\]]*)\]\(\s*(?:knote-img:)?((?:att|el|img)-[\w-]+)\s*\)/g,
  (m, alt, id) => {
    const rec = attachmentPool[id] || pdfElements[id]
    const url = (rec && rec.dataUrl) || imageStore[id]
    return url ? `![${alt}](${url})` : `【图片 ${id} 已失效】`
  }
)
const renderAgentMd = (text) => linkifyLineRefs(sanitizeHtml(md.render(resolveAgentChatImages(text))))

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
  const sel = { text: String(text).slice(0, 4000), lineHint: selectionLineHint(text) }
  // make a chat surface visible: the sidebar panel if it's on screen,
  // otherwise pop the floating window
  if (!(viewMode.value === 'single' && sidebarAgentOpen.value && outlineVisible.value)) agentOpen.value = true
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

// Sidebar/agent scrollbars show only WHILE scrolling (green glow bar, see
// style.css). Scroll events don't bubble, so listen in the capture phase.
const scrollFadeTimers = new WeakMap()
document.addEventListener('scroll', (e) => {
  const el = e.target
  if (!(el instanceof Element)) return
  if (!el.closest('aside') && !el.closest('.knote-agent-dock') && !el.classList.contains('knote-agent-input') && !el.classList.contains('knote-root') && !el.classList.contains('knote-doc-scroll')) return
  el.classList.add('knote-scrolling')
  clearTimeout(scrollFadeTimers.get(el))
  scrollFadeTimers.set(el, setTimeout(() => el.classList.remove('knote-scrolling'), 900))
}, true)

// Floating agent dock: DRAG THE GREEN BALL to move the whole dock (ball +
// window). The dock anchors to the BALL's bottom-right corner so the chat
// window always opens upward from the ball. A press without movement (<5px)
// counts as a click and toggles the window.
const agentDockPos = ref(null) // null = default bottom-right; {right,bottom} once dragged
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
const onAgentBallDown = (e) => {
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
    moved: false
  }
  e.preventDefault()
}
const onAgentBallMove = (e) => {
  if (!agentBallDrag) return
  const dx = e.clientX - agentBallDrag.startX
  const dy = e.clientY - agentBallDrag.startY
  if (!agentBallDrag.moved && Math.abs(dx) + Math.abs(dy) < 5) return
  agentBallDrag.moved = true
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  agentDockPos.value = {
    right: Math.min(Math.max(0, agentBallDrag.originRight - dx), vw - agentBallDrag.ballW),
    bottom: Math.min(Math.max(0, agentBallDrag.originBottom - dy), vh - agentBallDrag.ballH)
  }
}
const onAgentBallUp = () => {
  if (!agentBallDrag) return
  if (!agentBallDrag.moved) agentOpen.value = !agentOpen.value
  agentBallDrag = null
}
window.addEventListener('mousemove', onAgentBallMove)
window.addEventListener('mouseup', onAgentBallUp)

// ---- Kiwi mascot: map real agent state -> the mascot's animation states ----
const mascotOverride = ref('hello') // transient one-shots: hello (load), done/error (run end)
const mascotState = computed(() => {
  // a LIVE run always wins, so a lingering done/hello/error one-shot can't mask it
  if (agentStatus.value === 'running') return 'working'
  if (mascotOverride.value) return mascotOverride.value
  if (pendingHunks.value.length) return 'waiting'
  return 'idle'
})
const mascotMessage = computed(() => {
  // the open chat window already shows live activity — the bubble would be
  // redundant noise floating over it. It comes back when the chat closes
  // (unless the user muted it for this session).
  if (agentOpen.value) return ''
  const s = mascotState.value
  if (s === 'working') return agentActivity.value || (lang.value === 'zh' ? '正在思考…' : 'Thinking…')
  if (s === 'waiting') return lang.value === 'zh' ? `请审核我的修改（${pendingHunks.value.length} 处）` : `Please review my ${pendingHunks.value.length} change(s)`
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
    else if (!pendingHunks.value.length) flashMascot('done', 2100)
  }
})

// Sidebar agent card: collapsible (the floating window still exists)
const sidebarAgentOpen = ref(localStorage.getItem('knote-agent-sidebar') !== '0')
const toggleSidebarAgent = () => {
  sidebarAgentOpen.value = !sidebarAgentOpen.value
  try { localStorage.setItem('knote-agent-sidebar', sidebarAgentOpen.value ? '1' : '0') } catch { /* quota */ }
}

// ========== Outline (document structure panel) ==========
const outlineVisible = ref(true)
const outlineItems = computed(() => {
  return parsedBlocks.value
    .filter((b) => b.type === 'heading_open')
    .map((b, idx) => {
      const m = b.raw.match(/^(#{1,6})\s+(.*)$/)
      // The outline shows PLAIN text: strip inline HTML (color spans etc.),
      // links/images, and markdown format markers from the heading source
      const plain = (s) => s
        .replace(/<[^>]*>/g, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\\([\\`*_{}[\]()#+\-.!~])/g, '$1')
        .replace(/[*_`~]|==|\+\+|\[\^[^\]]*\]/g, '')
        .trim()
      return {
        id: b.id,
        index: idx,
        level: m ? m[1].length : 1,
        text: m ? plain(m[2]) : plain(b.raw)
      }
    })
})

const scrollToBlock = (id) => {
  if (viewMode.value === 'single') {
    const item = outlineItems.value.find((o) => o.id === id)
    if (item && richEditorRef.value) {
      richEditorRef.value.scrollToHeading(item.index)
    }
    return
  }
  const el = document.getElementById(`block-content-${id}`)
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
  fileHandle: null,
  isLocal: false,
  fileName: '',
  treePath: '',
  folderHandle: null,
  folderName: '',
  folderTree: [],
  expandedDirs: new Set(),
  outline: true,
  undo: [],
  redo: [],
  lastSaved: null,
  baseContent: '', // creation-time content: unchanged + no handles = pristine
  relImagesNeedGrant: false, // browser single-file: rel images need a folder grant
  docDir: null, // the doc's own directory handle (for writing assets/ images)
  activeDirPath: '', // header "new file/folder" target dir within the workspace
  ...over
})
const tabs = ref([])
const activeTabId = ref(0)
const activeTab = () => tabs.value.find((tb) => tb.id === activeTabId.value)
{
  const first = mkTab({ content: sample, baseContent: sample })
  tabs.value.push(first)
  activeTabId.value = first.id
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
  tb.kind = folderHandle.value ? 'folder' : 'doc'
  tb.title = folderHandle.value ? folderName.value : currentFileName.value
  tb.content = content.value
  tb.exportedMd = exportableMarkdown()
  const snap = viewMode.value === 'single' && richEditorRef.value
    ? richEditorRef.value.snapshotState()
    : null
  // a BLANK snapshot of a non-blank document is poison — restoring it would
  // show blank and re-capture blank (self-propagating). Drop it; the fresh
  // parse path rebuilds the doc from the markdown instead.
  tb.editorState = snap && snap.doc.content.size <= 2 && content.value.trim()
    ? null
    : snap
  const root = document.querySelector('.knote-root')
  tb.scrollTop = root ? root.scrollTop : 0
  tb.fileHandle = currentFileHandle.value
  tb.isLocal = isLocalFile.value
  tb.fileName = currentFileName.value
  tb.treePath = activeTreePath.value
  tb.folderHandle = folderHandle.value
  tb.folderName = folderName.value
  tb.folderTree = folderTree.value
  tb.expandedDirs = expandedDirs.value
  tb.outline = outlineVisible.value
  tb.undo = undoStack.value
  tb.redo = redoStack.value
  tb.lastSaved = lastSavedSnapshot
  tb.relImagesNeedGrant = relImagesNeedGrant.value
  tb.docDir = docDir.value
  tb.activeDirPath = activeDirPath.value
}

const restoreTab = (tb) => {
  restoringTab = true
  resetEditingState()
  clearTimeout(autoSaveTimer)
  autoSaveDirty = false
  currentFileHandle.value = tb.fileHandle
  isLocalFile.value = tb.isLocal
  currentFileName.value = tb.fileName
  activeTreePath.value = tb.treePath
  folderHandle.value = tb.folderHandle
  folderName.value = tb.folderName
  folderTree.value = tb.folderTree
  expandedDirs.value = tb.expandedDirs
  outlineVisible.value = tb.outline
  undoStack.value = tb.undo
  redoStack.value = tb.redo
  lastSavedSnapshot = tb.lastSaved || { content: tb.content, selection: null }
  relImagesNeedGrant.value = tb.relImagesNeedGrant || false
  docDir.value = tb.docDir || null
  activeDirPath.value = tb.activeDirPath || ''
  // with a snapshot the whole EditorState (incl. undo history) swaps in one
  // updateState and the modelValue watcher skips (lastEmitted pre-marked)
  const restored = viewMode.value === 'single' && richEditorRef.value && tb.editorState
    ? richEditorRef.value.restoreState(tb.editorState, tb.exportedMd)
    : false
  content.value = tb.content
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
    // fresh parse (no snapshot): forceSync re-parses on ANY mismatch (even
    // when the watcher couldn't fire — unchanged string / stale lastEmitted)
    // and starts the tab with a clean undo history so Ctrl+Z can't bleed
    // the previous tab's edits into this one
    if (!restored && viewMode.value === 'single' && richEditorRef.value) {
      richEditorRef.value.forceSync(richMarkdown.value)
    }
    const root = document.querySelector('.knote-root')
    if (root) root.scrollTop = tb.scrollTop || 0
    restoringTab = false
  })
}

const switchTab = (id) => {
  if (id === activeTabId.value) return
  const next = tabs.value.find((tb) => tb.id === id)
  if (!next) return
  commitActiveBlockIfAny()
  flushAutoSave()
  captureActiveTab()
  activeTabId.value = id
  restoreTab(next)
}

// A pristine tab (nothing typed, no file/folder attached) is REUSED by the
// next open instead of spawning another tab — like a browser's new-tab page
const isPristineTab = () => {
  if (currentFileHandle.value || folderHandle.value) return false
  const tb = activeTab()
  return !content.value.trim() || (tb ? content.value === tb.baseContent : false)
}

// Enter a fresh tab context; the caller loads its document/folder into the
// live refs right after (captured into the tab on the next switch/close)
const openInNewTab = () => {
  // no tab strip in the plain browser (no title bar) — opening there
  // replaces in place like before instead of stacking invisible tabs
  if (!isDesktopShell) return
  if (isPristineTab()) return
  commitActiveBlockIfAny()
  flushAutoSave()
  captureActiveTab()
  const tb = mkTab({ outline: outlineVisible.value })
  tabs.value.push(tb)
  activeTabId.value = tb.id
  restoreTab(tb)
}

const newTab = () => {
  commitActiveBlockIfAny()
  flushAutoSave()
  captureActiveTab()
  const tb = mkTab({ outline: outlineVisible.value })
  tabs.value.push(tb)
  activeTabId.value = tb.id
  restoreTab(tb)
}

const closeTab = async (id) => {
  const tb = tabs.value.find((t) => t.id === id)
  if (!tb) return
  {
    // scratch content with no backing file: confirm before dropping it
    const active = id === activeTabId.value
    const text = active ? content.value : tb.content
    const backed = active
      ? !!(currentFileHandle.value || folderHandle.value)
      : !!(tb.fileHandle || tb.folderHandle)
    if (!backed && text.trim() && text !== tb.baseContent) {
      const ok = await confirmDialog(t('tab_close_confirm'))
      if (!ok) return
    }
  }
  // (re)derive AFTER the modal — tabs and the active id may have changed
  // while it was open (e.g. a file association just opened a new tab)
  const idx = tabs.value.findIndex((t) => t.id === id)
  if (idx < 0) return
  const isActive = id === activeTabId.value
  if (isActive) {
    commitActiveBlockIfAny()
    flushAutoSave()
  }
  tabs.value.splice(idx, 1)
  if (!tabs.value.length) {
    const fresh = mkTab({ outline: outlineVisible.value })
    tabs.value.push(fresh)
    activeTabId.value = fresh.id
    restoreTab(fresh)
    return
  }
  if (isActive) {
    // activate the right neighbor (browser behavior), clamped at the end
    const next = tabs.value[Math.min(idx, tabs.value.length - 1)]
    activeTabId.value = next.id
    restoreTab(next)
  }
}

// Ctrl+Tab / Ctrl+Shift+Tab cycle tabs (browser muscle memory)
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !e.ctrlKey || tabs.value.length < 2) return
  e.preventDefault()
  const idx = tabs.value.findIndex((tb) => tb.id === activeTabId.value)
  const next = tabs.value[(idx + (e.shiftKey ? -1 : 1) + tabs.value.length) % tabs.value.length]
  switchTab(next.id)
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
  if (!moved) switchTab(id) // no movement => it was a plain click
}
const onTabPointerDown = (id, e) => {
  if (e.button !== 0) return // left button only; middle-click closes (auxclick)
  if (e.target.closest('.knote-tab-x')) return // the × button handles itself
  if (tabDrag) cleanupTabDrag(false) // clean up any stranded prior drag first
  // activate immediately (Chrome shows the grabbed tab active as you press)
  if (id !== activeTabId.value) switchTab(id)
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
const addRecent = (type, path, name) => {
  if (!isDesktopShell || !path || sessionRestoring) return
  const key = `${type}:${path}`
  const list = recentItems.value.filter((r) => `${r.type}:${r.path}` !== key)
  list.unshift({ type, path, name: name || String(path).split(/[\\/]/).pop() })
  recentItems.value = list.slice(0, 12)
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(recentItems.value)) } catch { /* quota */ }
}
const openRecent = (r) => {
  blurActiveElement()
  if (window.knoteDesktop && window.knoteDesktop.reopen) {
    window.knoteDesktop.reopen(r.type, r.path).then((ok) => {
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
let sessionRestoring = false
const persistSession = () => {
  if (!isDesktopShell || sessionRestoring) return
  try {
    const open = tabs.value
      .map((tb) => tb.deskKey)
      .filter((k) => k && (k.startsWith('file:') || k.startsWith('folder:')))
      .map((k) => ({ type: k.slice(0, k.indexOf(':')), path: k.slice(k.indexOf(':') + 1) }))
    const active = (activeTab() || {}).deskKey || ''
    localStorage.setItem(SESSION_KEY, JSON.stringify({ open, active }))
  } catch { /* quota */ }
}
const restoreSession = async () => {
  if (!isDesktopShell || !window.knoteDesktop || !window.knoteDesktop.reopen) return
  let saved
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { saved = null }
  if (!saved || !Array.isArray(saved.open) || !saved.open.length) return
  sessionRestoring = true
  // reopen sequentially — each reopen makes main emit open-file/open-folder,
  // handled by our bridge listeners (which create/dedupe tabs)
  for (const it of saved.open) {
    try {
      await window.knoteDesktop.reopen(it.type, it.path)
      await new Promise((r) => setTimeout(r, 140))
    } catch { /* gone / unreadable — skip */ }
  }
  sessionRestoring = false
  if (saved.active) {
    const tb = tabs.value.find((t) => t.deskKey === saved.active)
    if (tb && tb.id !== activeTabId.value) switchTab(tb.id)
  }
  persistSession()
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
    if (!e.ctrlKey || imageViewer.value) return // viewer has its own wheel zoom
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
    const m = splitMatches[s.active]
    if (!m) return
    content.value = content.value.slice(0, m.from) + s.replacement + content.value.slice(m.to)
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
    splitFindMatches(s.query, { caseSensitive: s.caseSensitive, wholeWord: s.wholeWord })
    if (!splitMatches.length) return
    let out = ''
    let last = 0
    for (const m of splitMatches) { out += content.value.slice(last, m.from) + s.replacement; last = m.to }
    out += content.value.slice(last)
    const n = splitMatches.length
    content.value = out
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
  snapTimer = setInterval(() => { if (content.value.trim()) takeSnapshot() }, 180000)
}

// Close daisyUI focus-based dropdowns after picking an item
const blurActiveElement = () => {
  const el = document.activeElement
  if (el && typeof el.blur === 'function') el.blur()
}

// ========== Keyboard Shortcuts ==========
const handleGlobalKeydown = (e) => {
  // image viewer is modal: no global shortcut (undo, image delete, …) may
  // act on the document behind the overlay; Esc has its own listener
  if (imageViewer.value) return
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

  const key = e.key.toLowerCase()

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
        if (key === 'b') insertAround('**', '**', '加粗文本')
        else if (key === 'i') insertAround('*', '*', '强调文本')
        else if (key === 'u') insertAround('++', '++', '下划线文本')
        else if (key === 'e') insertAround('`', '`', '行内代码')
        else insertAround('[', '](https://)', '链接文本')
      }
    }
    // Single mode: TipTap's own keymap covers Ctrl+B/I/U/E when focused
    void typeMap
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
    if (pendingHunks.value.length) resyncAgentPreview()
  }
})

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
    if (r) return r.end
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
  const rect = el.getBoundingClientRect()
  const y = lastHoverY.value - rect.top + el.scrollTop - paddingTop.value
  const lineIndex = Math.max(0, Math.floor(y / lineHeight.value))
  const top = lineIndex * lineHeight.value + paddingTop.value - el.scrollTop
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
  if (!el) return
  lineButtonVisible.value = el.selectionStart === el.selectionEnd
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
  toolbarTop.value = rect.top - areaRect.top + lineButtonTop.value + lineHeight.value * 0.6
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
  const isPlusButton = target.closest('.line-button-bridge')
  const isInsideTable = target.closest('table')
  
  if (isSelectionToolbar || isLineToolbar || isTableToolbar || isPlusButton) return
  
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

// Handle keydown in split-view textarea: skip over ZWS (\u200B) on Backspace/Delete
const handleTextareaKeydown = (e) => {
  const el = e.target
  const pos = el.selectionStart
  const end = el.selectionEnd
  const val = el.value

  // Only intercept when cursor is collapsed (no selection)
  if (pos !== end) return

  if (e.key === 'Backspace' && pos > 0) {
    // Look behind: if char before cursor is ZWS, delete it AND the newline before it
    if (val[pos - 1] === '\u200B') {
      e.preventDefault()
      const deleteFrom = (pos >= 2 && val[pos - 2] === '\n') ? pos - 2 : pos - 1
      content.value = val.slice(0, deleteFrom) + val.slice(pos)
      nextTick(() => {
        el.selectionStart = el.selectionEnd = deleteFrom
      })
      return
    }
    // Also: if char before cursor is \n and char before THAT is ZWS, delete both
    if (pos >= 2 && val[pos - 1] === '\n' && val[pos - 2] === '\u200B') {
      e.preventDefault()
      const deleteFrom = (pos >= 3 && val[pos - 3] === '\n') ? pos - 3 : pos - 2
      content.value = val.slice(0, deleteFrom) + val.slice(pos)
      nextTick(() => {
        el.selectionStart = el.selectionEnd = deleteFrom
      })
      return
    }
  }

  if (e.key === 'Delete' && pos < val.length) {
    // Look ahead: if char after cursor is ZWS, delete it AND the next char
    if (val[pos] === '\u200B') {
      e.preventDefault()
      const deleteTo = (pos + 1 < val.length && val[pos + 1] === '\n') ? pos + 2 : pos + 1
      content.value = val.slice(0, pos) + val.slice(deleteTo)
      nextTick(() => {
        el.selectionStart = el.selectionEnd = pos
      })
      return
    }
  }
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

onMounted(() => {
  window.addEventListener('mousedown', hideToolbar)
  window.addEventListener('mouseup', handleGlobalMouseUp)
  window.addEventListener('keydown', handleGlobalKeydown, { capture: true })
  document.addEventListener('selectionchange', handleSelectionChange)
  updateEditorMetrics()
  startSnapshotTimer()
})

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', hideToolbar)
  window.removeEventListener('mouseup', handleGlobalMouseUp)
  window.removeEventListener('keydown', handleGlobalKeydown, { capture: true })
  document.removeEventListener('selectionchange', handleSelectionChange)
})
</script>

<template>
  <!-- Desktop shell: slim draggable frosted title bar; the native window
       buttons overlay its right side (WCO) -->
  <div v-if="isDesktopShell" class="knote-titlebar print:hidden">
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
          class="knote-tab"
          :class="{ 'is-active': tb.id === activeTabId, 'is-folder': tabKindOf(tb) === 'folder', 'is-dragging': tb.id === draggingTabId }"
          :title="tabLabelOf(tb)"
          @mousedown="onTabPointerDown(tb.id, $event)"
          @auxclick="(e) => { if (e.button === 1) closeTab(tb.id) }"
        >
          <svg v-if="tabKindOf(tb) === 'folder'" class="knote-tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <svg v-else class="knote-tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span class="knote-tab-label">{{ tabLabelOf(tb) }}</span>
          <button class="knote-tab-x" :title="t('tab_close')" tabindex="-1" @mousedown.stop @click.stop="closeTab(tb.id)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </TransitionGroup>
      <button class="knote-tab-add" :title="t('tab_new')" tabindex="-1" @click="newTab">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  </div>
  <div
    class="knote-root min-h-screen bg-base-200 text-base-content flex flex-col p-4 gap-4 font-sans transition-colors duration-300"
    :style="headingPlaceholders"
  >
    <!-- Navbar -->
    <header class="navbar bg-base-100 rounded-box shadow-lg z-[1001] print:hidden">
      <!-- Left: Logo & Stats -->
      <div class="navbar-start gap-3 flex-1">
        <div class="w-10 h-10 transform hover:scale-105 transition-transform flex items-center justify-center">
          <img :src="theme === 'retro' ? KnoteIconPixel : KnoteIcon" alt="Knote Logo" class="w-full h-full object-contain" />
        </div>
        <div class="flex flex-col justify-center">
          <span class="font-bold text-lg leading-tight tracking-tight">Knote</span>
        </div>
        <!-- Stats -->
        <div 
          class="hidden lg:flex join ml-2 tooltip tooltip-bottom border border-base-300/30 rounded-lg bg-base-100/30" 
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
            <span class="max-w-[200px] truncate">{{ currentFileName }}</span>
            <span v-if="isSaving" class="loading loading-spinner loading-xs opacity-50"></span>
          </template>
          <template v-else>
            <span class="w-2 h-2 rounded-full bg-warning"></span>
            <span>{{ t('temp_file_warning') }}</span>
          </template>
        </div>
      </div>

      <!-- Right: Actions & Tools -->
      <div class="navbar-end gap-1 flex-1">
        
        <!-- Undo/Redo -->
        <div class="join mr-1">
          <button
            class="join-item btn btn-sm btn-ghost hover:text-[#84cc16] tooltip tooltip-bottom"
            :class="{ 'btn-disabled opacity-30': viewMode === 'single' ? !(richEditorRef && richEditorRef.canUndoR) : undoStack.length === 0 }"
            :data-tip="t('undo') + ' (Ctrl+Z)'"
            @click="undo"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
            </svg>
          </button>
          <button
            class="join-item btn btn-sm btn-ghost hover:text-[#84cc16] tooltip tooltip-bottom"
            :class="{ 'btn-disabled opacity-30': viewMode === 'single' ? !(richEditorRef && richEditorRef.canRedoR) : redoStack.length === 0 }"
            :data-tip="t('redo') + ' (Ctrl+Y)'"
            @click="redo"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4">
              <path stroke-linecap="round" stroke-linejoin="round" d="m15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3" />
            </svg>
          </button>
        </div>

        <!-- Open (file / folder) -->
        <div class="dropdown dropdown-end">
          <div tabindex="0" role="button" class="btn btn-sm btn-ghost hover:text-[#84cc16] gap-1 font-normal">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
            <span class="hidden sm:inline">{{ t('open') }}</span>
            <span class="text-[10px] opacity-50">▼</span>
          </div>
          <!-- max-h + scroll: 12 recents plus the actions otherwise run past
               the bottom of a short window -->
          <ul tabindex="0" class="dropdown-content z-[2000] menu p-2 shadow-xl bg-base-100 rounded-box w-56 border border-base-200 max-h-[70vh] overflow-y-auto flex-nowrap">
            <li @click="openLocalFile(); blurActiveElement()">
              <a class="flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-4 h-4 opacity-70">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
                {{ t('open_file') }}
              </a>
            </li>
            <li @click="openFolder(); blurActiveElement()">
              <a class="flex items-center gap-2" :title="t('folder_hint')">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-4 h-4 opacity-70">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
                </svg>
                {{ t('open_folder') }}
              </a>
            </li>
            <!-- Recently opened (desktop) -->
            <template v-if="isDesktopShell && recentItems.length">
              <li class="menu-title flex items-center justify-between pr-0">
                <span class="text-[10px] uppercase tracking-wider opacity-50">{{ t('recent_open') }}</span>
                <button class="btn btn-ghost btn-xs opacity-50 hover:opacity-100" :title="t('recent_clear')" @click.stop="clearRecents">
                  <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M6 6l12 12M6 18 18 6"/></svg>
                </button>
              </li>
              <li v-for="r in recentItems" :key="r.type + r.path" @click="openRecent(r)">
                <a class="flex items-center gap-2">
                  <svg v-if="r.type === 'folder'" class="w-4 h-4 opacity-60 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  <svg v-else class="w-4 h-4 opacity-60 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  <span class="truncate flex-1" :title="r.path">{{ r.name }}</span>
                </a>
              </li>
            </template>
          </ul>
        </div>

        <!-- Save -->
        <button 
          class="btn btn-sm btn-ghost hover:text-[#84cc16] gap-1 font-normal"
          :class="{ 'opacity-50': isSaving }"
          @click="saveFile"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          <span class="hidden sm:inline">{{ t('save') }}</span>
        </button>

        <!-- View Mode Toggle -->
        <div class="join shadow-sm mx-1 border border-base-300/50 rounded-lg overflow-hidden h-8 sm:h-9">
          <button 
            class="join-item btn btn-xs sm:btn-sm border-none h-full min-h-0" 
            :class="viewMode === 'single' ? '!bg-[#84cc16] !text-white' : 'btn-ghost hover:bg-base-300'" 
            @click="setViewMode('single')"
          >
            {{ t('single') }}
          </button>
          <button 
            class="join-item btn btn-xs sm:btn-sm border-none h-full min-h-0" 
            :class="viewMode === 'split' ? '!bg-[#84cc16] !text-white' : 'btn-ghost hover:bg-base-300'" 
            @click="setViewMode('split')"
          >
            {{ t('split') }}
          </button>
        </div>

        <!-- I18n -->
        <button class="btn btn-sm btn-ghost hover:text-[#84cc16] gap-1 px-2" @click="lang = lang === 'zh' ? 'en' : 'zh'">
           <span class="text-xs font-bold uppercase">{{ lang === 'zh' ? '中文' : 'EN' }}</span>
        </button>

        <!-- Theme -->
        <div class="dropdown dropdown-end">
          <div tabindex="0" role="button" class="btn btn-sm btn-ghost hover:text-[#84cc16] m-1 px-2">
             {{ t('theme') }} <span class="text-[10px] opacity-50">▼</span>
          </div>
          <ul tabindex="0" class="dropdown-content z-[2000] menu p-2 shadow-xl bg-base-100 rounded-box w-52 border border-base-200">
            <li>
              <a @click="theme = 'light'; blurActiveElement()" :class="{active: theme==='light'}" class="flex justify-between items-center">
                <span>{{ t('light') }}</span>
                <div class="theme-indicator indicator-light"></div>
              </a>
            </li>
            <li>
              <a @click="theme = 'dark'; blurActiveElement()" :class="{active: theme==='dark'}" class="flex justify-between items-center">
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
        <div class="dropdown dropdown-end">
             <div tabindex="0" role="button" class="btn btn-sm btn-square btn-ghost hover:text-[#84cc16]">
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
                <li @click="openHistory(); blurActiveElement()">
                    <a class="flex items-center gap-2">
                        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 2m6-2a9 9 0 1 1-3.5-7.1M21 3v5h-5"/></svg>
                        {{ t('history') }}
                    </a>
                </li>
                <li @click="loadSample(); blurActiveElement()"><a>{{ t('load_sample') }}</a></li>
                <li @click="copyMarkdown(); blurActiveElement()"><a>{{ t('copy_markdown') }}</a></li>
                <li @click="openShortcuts(); blurActiveElement()"><a>{{ t('shortcuts') }}</a></li>
                <div class="divider my-1"></div>
                <li @click="clearAll(); blurActiveElement()"><a class="text-error">{{ t('clear_all') }}</a></li>
             </ul>
        </div>
      </div>
    </header>

    <main
      class="flex-1 transition-all duration-300 relative"
      :class="viewMode === 'split' ? 'grid gap-6 grid-cols-1 lg:grid-cols-2' : 'flex gap-4 max-w-6xl mx-auto w-full'"
    >

      <!-- Outline Panel (single mode) -->
      <aside
        v-if="viewMode === 'single'"
        class="hidden lg:block shrink-0 transition-all duration-300 print:hidden"
        :class="outlineVisible ? 'w-72' : 'w-10'"
      >
        <!-- px/pb + negative mx: room for the cards' box-shadows, which the
             overflow-y-auto box would otherwise clip at its edges -->
        <div class="sticky top-4 max-h-[calc(100vh-2.5rem)] overflow-y-auto px-1.5 -mx-1.5 pb-2">
        <div class="card bg-base-100 border border-base-200 shadow-md overflow-hidden">
          <div class="flex items-center justify-between px-3 py-2 border-b border-base-200/60">
            <span v-if="outlineVisible" class="text-xs font-bold text-base-content/50 uppercase tracking-widest">{{ t('outline') }}</span>
            <button
              class="btn btn-xs btn-ghost btn-square"
              :title="t('outline')"
              @click="outlineVisible = !outlineVisible"
            >
              <svg v-if="outlineVisible" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" /></svg>
            </button>
          </div>
          <div v-if="outlineVisible" class="max-h-[45vh] overflow-auto py-2">
            <div v-if="outlineItems.length === 0" class="px-3 py-2 text-xs text-base-content/40">{{ t('outline_empty') }}</div>
            <ul v-else class="space-y-0.5">
              <li v-for="item in outlineItems" :key="item.id">
                <button
                  class="w-full text-left text-sm px-3 py-1 hover:bg-base-200/60 hover:text-[#84cc16] transition-colors truncate rounded-sm"
                  :class="{ 'font-bold': item.level === 1, 'text-base-content/80': item.level === 2, 'text-base-content/60': item.level >= 3 }"
                  :style="{ paddingLeft: `${12 + (item.level - 1) * 12}px` }"
                  :title="item.text"
                  @click="scrollToBlock(item.id)"
                >
                  {{ item.text || '…' }}
                </button>
              </li>
            </ul>
          </div>
        </div>

        <!-- File tree (open a folder, browse its .md files) -->
        <div v-if="outlineVisible" class="mt-3 card bg-base-100 border border-base-200 shadow-md overflow-hidden">
          <div class="flex items-center gap-0.5 px-3 py-2 border-b border-base-200/60">
            <span class="text-xs font-bold text-base-content/50 uppercase tracking-widest truncate flex-1" :title="folderName">{{ folderName || t('files') }}</span>
            <button v-if="folderHandle" class="btn btn-xs btn-ghost btn-square" :title="t('file_new')" @click="createMdFile(activeDirNode())">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3h-6m-3.75 7.5h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125Z" /></svg>
            </button>
            <button v-if="folderHandle" class="btn btn-xs btn-ghost btn-square" :title="t('folder_new')" @click="createFolder(activeDirNode())">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" /></svg>
            </button>
            <button v-if="folderHandle" class="btn btn-xs btn-ghost btn-square" :title="t('file_refresh')" @click="refreshFolder">
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
          <div v-if="folderSearchQuery.trim()" class="max-h-[42vh] overflow-auto py-1.5">
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
          <div v-else class="max-h-[32vh] overflow-auto py-1.5">
            <!-- single file open (no folder workspace): surface which document
                 is being viewed here, where the folder hint would otherwise sit -->
            <div v-if="!folderTree.length && !folderName && currentFileName" class="px-3 py-2">
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
                class="group w-full flex items-center gap-1.5 text-left text-xs px-2 py-1 hover:bg-base-200/60 transition-colors rounded-sm cursor-pointer"
                :class="row.node.path === activeTreePath ? 'text-[#84cc16] font-bold bg-[#84cc16]/10' : 'text-base-content/75'"
                :style="{ paddingLeft: `${10 + row.depth * 14}px` }"
                :title="row.node.name"
                @click="row.node.kind === 'dir' ? toggleDir(row.node.path) : openTreeFile(row.node)"
                @contextmenu.prevent="openTreeCtxMenu(row.node, $event)"
              >
                <svg v-if="row.node.kind === 'dir'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 opacity-60 transition-transform" :class="{ 'rotate-90': expandedDirs.has(row.node.path) }"><path stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="shrink-0 opacity-60"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                <span class="truncate flex-1">{{ row.node.name }}</span>
                <button
                  v-if="row.node.kind === 'file'"
                  class="hidden group-hover:block shrink-0 opacity-50 hover:opacity-100 hover:text-[#84cc16]"
                  :title="t('file_rename')"
                  @click="renameTreeFile(row.node, $event)"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" /></svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Agent chat (sidebar instance — same conversation as the float) -->
        <div v-if="outlineVisible && sidebarAgentOpen" class="mt-3 card bg-base-100 border border-base-200 shadow-md overflow-hidden h-[52vh]">
          <AgentPanel mode="sidebar" :t="t" :render-md="renderAgentMd" @collapse="toggleSidebarAgent" @ctxmenu="(p) => openCtxMenu(p.x, p.y, p.items)" />
        </div>
        <button
          v-else-if="outlineVisible"
          class="mt-3 w-full card bg-base-100 border border-base-200 shadow-md px-3 py-2 flex flex-row items-center gap-2 text-xs font-bold text-base-content/50 uppercase tracking-widest hover:text-[#84cc16] transition-colors"
          @click="toggleSidebarAgent"
        >
          <span class="w-2 h-2 rounded-full bg-[#84cc16]/50"></span>
          {{ t('agent') }}
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="ml-auto"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/></svg>
        </button>
        </div>
      </aside>

      <!-- Editor Section -->
      <section v-show="viewMode === 'split'" class="card bg-base-100 shadow-xl border border-base-200 h-full flex flex-col relative group print:hidden">
         <div class="bg-base-200/30 p-2 text-xs font-bold text-base-content/40 uppercase tracking-widest text-center border-b border-base-200">{{ t('editor') }}</div>
         
         <div class="relative flex-1" ref="editorAreaRef">
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

            <textarea
                ref="textareaRef"
                v-model="content"
                class="textarea textarea-ghost w-full h-full resize-none p-6 text-base leading-relaxed focus:outline-none focus:bg-base-100/50 font-mono tracking-normal"
                spellcheck="false"
                :placeholder="t('type_placeholder')"
                @mouseup="handleSelectionChange"
                @keyup="handleSelectionChange"
                @keydown="handleTextareaKeydown"
                @input="handleSelectionChange"
                @paste="handleEditorPaste"
                @scroll="handleScroll"
                @mousemove="handleMouseMove"
                @mouseleave="hideLineButton"
            ></textarea>
         </div>
      </section>

      <!-- Preview Section -->
      <section
        v-show="viewMode === 'split' || viewMode === 'single'"
        class="card bg-base-100 shadow-xl border border-base-200 h-full flex flex-col relative"
        :class="viewMode === 'single' ? 'flex-1 min-w-0' : ''"
      >
         <div class="bg-base-200/30 p-2 text-xs font-bold text-base-content/40 uppercase tracking-widest text-center border-b border-base-200">{{ viewMode === 'single' ? t('editor') : t('preview') }}</div>

         <!-- Folder workspace open but no file chosen yet: the blank untitled
              doc reads as a confusing "staged" file, so cover the editor with a
              clear prompt to open or create one instead. -->
         <div v-if="folderHandle && !currentFileName" class="absolute inset-0 top-[37px] z-20 flex flex-col items-center justify-center gap-3 bg-base-100 text-center px-8 print:hidden">
           <svg class="w-14 h-14 text-base-content/15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
           <p class="text-base-content/60 text-sm font-medium">{{ t('folder_pick_prompt') }}</p>
           <p class="text-base-content/35 text-xs">{{ t('folder_pick_hint') }}</p>
           <button class="btn btn-sm btn-primary gap-1.5 mt-1" @click="createMdFile()">
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
         <div v-if="viewMode === 'split'" class="relative flex-1 bg-base-100 p-6 overflow-auto">
             <div class="knote-md-render prose prose-sm md:prose-base dark:prose-invert max-w-none" v-html="renderedHtml"></div>
         </div>

         <!-- WYSIWYG editor (Single Mode) — TipTap/ProseMirror.
              v-show (not v-if) keeps the editor instance alive across mode
              switches, preserving undo history and resized column widths -->
         <RichEditor
            v-show="viewMode === 'single'"
            ref="richEditorRef"
            v-model="richMarkdown"
            :active="viewMode === 'single'"
            class="flex-1 min-h-0"
            :t="t"
            :placeholder="t('type_placeholder')"
            :prompt-text="promptInput"
            @rowchange="flushAutoSave"
            @askagent="onAskAgent"
            @ctxmenu="(p) => openCtxMenu(p.x, p.y, p.items)"
            @viewimage="openImageViewer"
         />
      </section>

    </main>

    <!-- Footer -->
    <footer class="mt-6 py-3 text-center text-xs text-base-content/40 print:hidden">
      {{ t('modern_editor') }}
    </footer>

    <!-- Agent floating ball + window (drag the ball to move the dock) -->
    <div
      class="knote-agent-dock fixed z-[900] print:hidden flex items-end gap-3"
      :class="[dockPanelBelow ? 'flex-col-reverse' : 'flex-col', { 'bottom-6 right-6': !agentDockPos }]"
      :style="dockStyle"
    >
      <div
        v-show="agentOpen"
        class="w-[26rem] max-w-[calc(100vw-3rem)] h-[36rem] max-h-[80vh] card bg-base-100 border border-base-200 shadow-2xl rounded-2xl overflow-hidden"
      >
        <AgentPanel mode="float" :t="t" :render-md="renderAgentMd" @ctxmenu="(p) => openCtxMenu(p.x, p.y, p.items)" />
      </div>
      <!-- Animated pixel-kiwi assistant (replaces the plain green ball): its
           state reflects real agent activity; drag to move, click to open chat -->
      <KiwiMascot
        :state="mascotState"
        :message="mascotMessage"
        :t="t"
        :grab="onAgentBallDown"
      />
    </div>

    <!-- Agent review bar: staged hunks are shown in-document (red/green diff
         with per-hunk ✓/✕); this compact pill batch-resolves the rest.
         Hidden while a run is in progress: diffs are batch-painted at run end,
         so a mid-run pill would invite blind accepts against an unpainted doc
         (and a mid-run accept invalidates the run's later edits) -->
    <div
      v-if="pendingHunks.length && agentStatus !== 'running'"
      class="fixed bottom-5 left-1/2 -translate-x-1/2 z-[1100] flex items-center gap-2 pl-4 pr-1.5 py-1.5 rounded-full bg-base-100/95 backdrop-blur border border-base-200 shadow-xl print:hidden"
    >
      <span class="w-2 h-2 rounded-full bg-[#84cc16] animate-pulse"></span>
      <span class="text-sm font-medium whitespace-nowrap">{{ pendingHunks.length }} {{ t('agent_hunks_pending') }}</span>
      <button class="btn btn-xs btn-ghost rounded-full" @click="rejectAllHunks()">{{ t('agent_reject_all') }}</button>
      <button class="btn btn-xs text-white border-none rounded-full px-3" style="background:#84cc16" @click="acceptAllHunks()">{{ t('agent_accept_all') }}</button>
    </div>

    <!-- Transient agent notice (e.g. stale review batch discarded) -->
    <div
      v-if="agentNotice"
      class="fixed bottom-16 left-1/2 -translate-x-1/2 z-[1100] px-4 py-2 rounded-full bg-base-content/90 text-base-100 text-xs shadow-lg print:hidden"
    >{{ agentNotice }}</div>

    <!-- In-app text prompt (replaces window.prompt, which the Electron shell
         does not support) -->
    <div
      v-if="promptState"
      class="fixed inset-0 z-[2000] flex items-center justify-center bg-base-content/25 backdrop-blur-[1px] print:hidden"
      @mousedown.self="resolvePrompt(false)"
    >
      <div class="bg-base-100 border border-base-200 rounded-2xl shadow-2xl p-5 w-80 max-w-[90vw] space-y-3">
        <div class="text-sm font-bold">{{ promptState.title }}</div>
        <input
          v-if="promptState.mode !== 'confirm'"
          ref="promptInputRef"
          v-model="promptState.value"
          type="text"
          class="input input-sm input-bordered w-full"
          @keydown.enter.prevent="resolvePrompt(true)"
          @keydown.esc.prevent="resolvePrompt(false)"
        />
        <div class="flex justify-end gap-2">
          <button class="btn btn-sm btn-ghost" @click="resolvePrompt(false)">{{ t('dlg_cancel') }}</button>
          <button class="btn btn-sm text-white border-none" style="background:#84cc16" @click="resolvePrompt(true)">{{ t('dlg_ok') }}</button>
        </div>
      </div>
    </div>

    <!-- Move file/folder: destination picker -->
    <div
      v-if="moveState"
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
          <button class="btn btn-sm btn-ghost" @click="moveState = null">{{ t('dlg_cancel') }}</button>
        </div>
      </div>
    </div>

    <!-- Shared right-click context menu -->
    <div
      v-if="ctxMenu"
      class="knote-ctxmenu fixed z-[2600] w-52 bg-base-100 border border-base-200 rounded-xl shadow-2xl p-1.5 print:hidden"
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
      <div class="knote-modal knote-history">
        <div class="knote-modal-head">
          <span>{{ t('history') }}</span>
          <button class="knote-modal-x" @click="closeHistory"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="knote-history-body">
          <div class="knote-history-list">
            <div v-if="!historyPanel.items.length" class="knote-history-empty">{{ t('history_empty') }}</div>
            <button
              v-for="(it, i) in historyPanel.items"
              :key="it.index"
              class="knote-history-item"
              :class="{ 'is-active': historyPanel.previewIndex === i }"
              @click="historyPanel.previewIndex = i"
            >
              <span class="knote-history-time">{{ i === 0 ? t('history_current') : fmtSnapTime(it.t) }}</span>
              <span class="knote-history-size">{{ Math.max(1, Math.round(it.size / 100) / 10) }}k</span>
            </button>
          </div>
          <div class="knote-history-preview">
            <div v-if="historyPanel.previewIndex < 0" class="knote-history-hint">{{ t('history_preview_hint') }}</div>
            <template v-else>
              <pre class="knote-history-content">{{ historyPreview }}</pre>
              <button v-if="historyPanel.previewIndex > 0" class="knote-history-restore" @click="restoreSnapshot(historyPanel.items[historyPanel.previewIndex])">{{ t('history_restore') }}</button>
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
  </div>
</template>

<style>
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
</style>
