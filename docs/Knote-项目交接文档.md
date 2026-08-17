# Knote 项目交接文档

> 更新时间：2026-08-15
> 面向对象：接手 Knote 后续开发、测试、发布的下一位 Agent / 开发者  
> 本文是当前仓库状态、长期产品约束、近期故障上下文和验证证据的集中交接。它不替代 README，而是回答"现在代码处于什么状态、为什么这样设计、下一步怎样安全继续"。

## 0. 接手前必须先读

- 仓库：本文所在的 Git 仓库根目录
- 远端：`https://github.com/1661169091kiwi/Knote.git`
- 当前分支：`main`，应用版本 `1.1.37`；精确提交和工作树状态以 Git 命令为准
- 已发布版本：`v1.1.31` → `v1.1.36`（v1.1.30 为手动发布，CI 因 e2e 窗口尺寸失败过一次；从 v1.1.31 起由 CI 构建并自动发布 Windows 与 Android 产物）
- 发布地址：https://github.com/1661169091kiwi/Knote/releases
- GitHub 身份验证和网络代理由各开发环境自行配置；禁止把 PAT、密码或代理凭据写入仓库
- `release/`、`dist/`、`android/` 被 `.gitignore` 忽略；本地安装包不等于 GitHub 已发布
- 发布流程：`npm run dist:win` 本地打包 → 推送 `main` → 为新版本创建唯一的 `v*` 标签并推送 → CI 自动构建并发布 Windows 安装包与 Android APK

### 系统稳定性红线（沿用，必须遵守）

本机曾因 Codex 桌面端泄漏 `taskkill.exe`/`conhost.exe` 引发整机假死。后续操作必须遵守：

1. 不从外部工具调用 `taskkill`、WMI 进程树查询或循环式进程清理。
2. Electron 测试一次只运行一个，使用隔离临时目录，让应用自己正常关闭。
3. 不因测试暂时无输出而强制取消；先等待自然结束。
4. 不并行启动 Electron、NSIS、Android Gradle 等重型任务。
5. Knote 安装器自身仍有一次有界的"检测并关闭 Knote"逻辑；持续审计，避免无界重试。

## 1. 产品定位与不可破坏的原则

Knote 是"本地优先的 Markdown 编辑工具 + 内置工作区 AI 助手"。

不可破坏的产品原则：

- **文档优先**：任何异步切换、自动保存、Agent 修改、删除、重命名、更新安装都不能导致原文档丢失或 A 文档覆盖 B 文档。
- **永久历史**：历史版本写在安装目录之外，原位置升级不得删除；同名文档也不能串历史。
- **可审核 AI**：Agent 对文档的修改先形成红/绿 diff；“编辑文档时人工审核”开启时由用户审核后生效，关闭时仅经 exact CAS 自动应用；工具返回"成功"不等于任务完成，必须经过后置验证。
- **工作区优先**：Agent 会话绑定工作区根目录和会话，而不是永久绑定第一次打开的某一个文档。
- **本地优先与自带密钥**：API Key 保存在本地用户数据中，Knote 没有中转服务器。
- **桌面操作原生可靠**：文件关联、打开参数、托盘退出、升级、自锁和退出前写盘都属于发布门禁。
- **风格一致**：Soft Futuristic Minimalism——白色主导，低饱和浅绿/淡黄/雾白动态柔光，克制、轻盈、慢速。
- **链接交互统一**：编辑器与预览中所有链接（本地文件 + 网页）一律 Ctrl/Cmd + 左键 打开；普通左键只放光标/不导航。悬停显示单行提示"Ctrl + 左键 打开"（白底小卡片）。
- **本地文件链接安全**：工作区外路径只有用户显式 pick 过（`pickedOpenPaths`，上限 128）才可打开；附件目标文件夹只允许文档树内（主进程 `creatableAssetPath` 探针授权）。

## 2. 技术栈与平台

| 层 | 技术 / 入口 | 说明 |
|---|---|---|
| 渲染层 | Vue 3、Vite、Tailwind CSS、daisyUI | `src/main.js` 挂载，`src/App.vue` 是当前总控组件 |
| 富文本 | TipTap / ProseMirror、tiptap-markdown、Turndown | Markdown 与编辑器文档互转 |
| Markdown 渲染 | markdown-it、KaTeX、Mermaid、highlight.js | 公式、图表、代码、脚注、Callout 等 |
| 桌面壳 | Electron | `electron/main.cjs`、`electron/preload.cjs` |
| 安装器 | electron-builder + NSIS | `build/installer.nsh` |
| Web | Vite 静态站点 | GitHub Pages 使用 `--base=/Knote/` |
| Android | Capacitor 8 + Gradle | `capacitor.config.json`，`webDir=dist` |
| PDF | pdf.js v6（官方 PDFSinglePageViewer，Apache-2.0）+ 可选 Python/PaddleOCR sidecar | 查看器 = 官方组件嵌入 Shadow DOM；sidecar 用于 Agent 的精确图表提取 |
| 测试 | Node test runner + Playwright/Electron | 纯逻辑、对抗、真实鼠标级 UI 三层 |

`vite.config.js` 使用 `base: './'`（Electron 从 `file://` 加载 `dist/index.html`）。GitHub Pages 工作流构建时覆盖为 `/Knote/`。

## 3. 代码结构（相对上版新增/变化的重点）

| 路径 | 当前职责 |
|---|---|
| `src/App.vue` | 应用总状态（文件很大）；含附件插入悬浮窗、大纲/分片、PDF 查看器集成、链接打开分发、主题/语言。 |
| `src/components/RichEditor.vue` | TipTap 编辑器。**`KnoteLink` 覆写了 `isAllowedUri`**：tiptap 2.27 默认正则的未转义连字符会形成 `-`..`:` 字符范围，导致所有含 `/` 的相对链接（`assets/x.pdf`）在 parse/render 时被静默丢弃——现允许 web/file 协议 + 相对/盘符路径，仍拦截 `javascript:` 等。`CtrlClickLink` 插件统一 Ctrl+左键 打开。 |
| `src/components/PdfViewerHost.vue` | **官方 pdf.js PDFSinglePageViewer 的 Shadow DOM 宿主**。v6 的 `pdf_viewer.mjs` 要求 `globalThis.pdfjsLib` 预先存在，导入顺序：先 `import('pdfjs-dist')` 挂全局，再懒加载 viewer 模块；完整 `pdf_viewer.css`（163KB）注入 shadow root，不污染全局样式。文本层、缩放、页码全部官方实现。 |
| `src/lib/local-file-links.js` | 本地文件链接生成：`localFileLinkMarkdown`（文档目录内相对 + 百分号编码，目录外前斜杠盘符绝对路径，绝不用 `file://`——markdown-it 的 BAD_PROTO 会拦 `file:`）、`relativePathFrom`、`decodeLocalPath`。 |
| `src/lib/documentMetrics.js` | 大文档统计、大纲、缺图检测的单次分块扫描。**大纲缓存有效性以"缓存源 == 当前源"为准**，任何中间状态（空白 tab）产生的空大纲都会被新文档加载覆盖。 |
| `src/lib/agentStore.js` | Agent 会话/工具/执行账本。**活动字符串双语化**：`setAgentUiLang(lang)` + `uiT(zh, en)`，`ACTIVITY_LABEL` 为 `[zh, en]` 对；App 在语言切换时同步。含 `renderPdfPagesWithText`（保留未用，查看器已由官方组件取代）。 |
| `electron/main.cjs` | 窗口/IPC/权限/历史/sidecar/退出握手。附件相关：`knote:import-attachment`（支持 `source` 参数跳过原生对话框）、`knote:attachment-dirs`（**只返回通过 `creatableAssetPath` 探针的目录树**，单文件文档仅 `assets/**`）、`knote:pick-import-file`、`knote:attachment-mkdir/rename-dir`、`attachmentTargetStore`（`userData/attachment-targets.json`，按文档目录持久化上次选择的附件文件夹，每次读取重新授权）、`pickedOpenPaths`（原位链接安全集合）。 |
| `src/style.css` | 全局样式；`.textLayer` 等 PDF 样式已移除（官方 CSS 在 shadow 内）。 |

## 4. 文档打开、编辑与保存链路

（不变，见 git 历史版本本文档 §4）关键不变量：

- 保存任务绑定"文件句柄/规范化绝对路径 + 当时 Markdown + 修订号"。
- 同一物理文件不能同时存在两个可编辑标签。
- 所有 Electron 写路径进入同一变更协调器。
- 删除/重命名后旧路径 tombstone，迟到写入被拒。
- 文件 A/B 历史身份基于规范化完整身份 SHA-256。

## 5. 历史、用户数据与退出

（结构不变）实际子目录：

- 文档历史：`<userData>/document-history/v1/<SHA-256(identity)>/snapshots/`
- 冷标签缓冲：`<userData>/tab-buffers/v1/sessions/`
- 崩溃诊断：`<userData>/crash-diagnostics/`
- PDF 环境：`<userData>/pdf-env/`
- **附件目标记忆：`<userData>/attachment-targets.json`**（`{ [docDir]: targetAbs }`，每次读取经 `creatableAssetPath` 校验，失效回退 `assets`）
- Agent 配置/会话和编辑器会话：Chromium localStorage / IndexedDB

退出链路：主进程 `before-quit` → `knote:prepare-quit`（带 nonce）→ 渲染器提交草稿并排空队列 → ACK → 退出；sidecar 按已登记子进程做有界清理。

## 6. 长文档与内存策略

（策略不变：结构复杂度判定 + 200k 分页 + 冷标签缓冲 + 单次分块扫描）本轮新增约束：

- **分片切换控件已从文档顶部移到侧栏**（`large-document-chunk-card`，含 ‹ 页码选择 ›），不再被加载遮罩遮挡、无需滚回文档顶部。
- 文档区域无横向滚动：编辑器/预览容器 `overflow-x-hidden`，长 URL 用 `overflow-wrap: anywhere` 断行，代码块与宽表格保留自身横向滚动。
- **大纲必须能检测到标题**：`outlineStale` 判断是 `!sameSource || !cache.outline`（曾因"分片模式复用缓存"特判导致首次打开大文档大纲永远为空——中间空白 tab 状态缓存的空大纲被复用）。
- 大文档分析防抖 500ms（打字停顿后才扫描全文档）。

## 7. 本轮（1.1.30 → 1.1.36）完成的关键功能与修复

### 7.1 任意本地文件链接与附件（@davi-jorge-art 提议）

- 工具栏/行菜单两个入口："插入附件（复制到文件夹）"与"插入文件链接（保持原位置）"（zh 名：插入附件 / 插入文件链接；图标：附件=文档图标，文件链接=纯色实心链环，区别于图片 URL 的描边链环）。
- 插入附件弹窗（`attachState`，风格同改名弹窗）：目标文件夹下拉（**只列出文档树内可写目录**，主进程授权）+ 选择源文件按钮同时展示；所选文件夹持久化（`attachment-targets.json`）为下次默认；支持弹窗内新建/重命名文件夹（`knote:attachment-mkdir/rename-dir`，同探针授权 + mutation coordinator）。
- 原位链接：工作区外路径 pick 后注册到 `pickedOpenPaths`，链接点击仅可打开这些路径。
- 链接交互统一为 Ctrl+左键 打开（编辑器 + 预览、本地 + 网页），悬停单行提示。
- 插入位置修正：工具栏插入落在**当前行**（`getInsertionAnchorLine` 返回块首行），RichEditor 行菜单同样插在 gutter 块首行。

### 7.2 TipTap 相对链接被剥（重要根因）

tiptap 2.27 的 `isAllowedUri` 用未转义连字符构建字符类 `[^a-z+.-:]`，被解析成 `-`..`:` 范围（0x2D–0x3A），吞掉 `/ . 0-9`——所有 `assets/...` 相对 href 在 parseHTML/renderHTML 中被静默判失败，编辑器里渲染成纯文本。`KnoteLink.addOptions().isAllowedUri` 覆写解决；这是用户最初"编辑器里链接打不开/不渲染"抱怨的根因。

### 7.3 PDF：打不开修复 + 官方查看器

- 打不开根因：延迟到达的打开意图事件会递增全局 `documentLoadGeneration`，导致刚渲染完的预览被 `stillCurrent()` 取消。修复：PDF 预览用宽松 `previewCurrent`（只检查 tab/folder 切换），取消由自身 `pdfViewGen` 管理；txt/docx 预览保持严格检查（慢提取不能覆盖更新的选择）。
- 查看器重写：**官方 `PDFSinglePageViewer` 嵌入 Shadow DOM**（v6，`globalThis.pdfjsLib` 前置 + 懒加载，完整官方 CSS 注入 shadow）。文本层/缩放/页码全官方实现，对齐由 e2e 几何断言保证：612pt 页面 x=72pt 处文本，选中区域水平位置实测 0.1176 vs 理论 0.1176。

### 7.4 其它

- Agent 状态串/工作区活动栈/工具标签双语化（`setAgentUiLang`），英文界面不再出现中文。
- 主题名：简约（zh）/ Clean white（en）、光晕（zh）/ Kiwi glow（en）。
- CI e2e 不依赖 runner 窗口尺寸：fixture 固定 1440×900 视口；`current-file-name` 等改为 attached+文本匹配（该元素在 `hidden xl:flex` 容器，窄窗口下不可见——v1.1.30 CI 失败根因）。
- 大纲首开修复（见 §6）、分片控件移侧栏、横向滚动修复、插入当前行。

### 7.5 v1.1.36 通用 Agent 与跨平台安全运行时

- Agent 增加 durable event/state、上下文记忆、来源续接、恢复事务、工具输出存储和受约束的 provider retry。
- 桌面端增加工作区 mutation CAS、可恢复下载、公开 URL 策略、命令沙箱服务和 Windows AppContainer broker 原型。
- Android 增加 Capacitor 原生插件、SAF 工作区文件操作与原生搜索；移动端补齐安全区、抽屉和原生 Back 行为。
- 选中的“审查”与“全部通过”行都显示文档人工审核拨片；关闭后分别经独立审核器或 Allow All grant 授权，并只在 exact CAS 成立时自动应用。
- PDF 恢复原生文字拖选并统一为单滚动容器；Agent 暗色模式、审核入口和自定义 checkbox 完成对比度回归。

## 8. Agent 架构与行为约束

（不变，见 git 历史 §8）主要 localStorage / IndexedDB 之外，新增：`attachment-targets.json`（主进程，非 localStorage）。

## 9. PDF 与图片引用协议

（能力降级顺序、缓存 key、引用校验不变）注意区分两条 PDF 链路：

- **查看器**（用户点文件树）：`PdfViewerHost.vue` 官方组件，纯本地渲染，无 sidecar。
- **Agent 精确提取**：`pdf_prepare/pdf_get_element/pdf_layout` 走 PaddleOCR sidecar（`<userData>/pdf-env/`），输出 element_id 与 markdown_reference。

## 10. UI 与历史产品上下文

（视觉规范不变）新增/变化：

- 悬停注释统一为白底单行提示层，支持四向自动翻转；顶部标签固定向下。文件树中非 Markdown/PDF 文件首次点击显示“再次点击打开”，同一项 1.2 秒内再次点击才打开；Ctrl+点击和右键“打开”仍直接执行。
- HTML/HTM 与 Office 文档一样交给系统默认程序；主进程文档打开白名单明确包含 `.html`/`.htm`。
- 审核 diff 使用直角矩形；新增内容通过同一条已净化 Markdown 渲染链预览，接受时仍只写入原始 `applyLines`。编辑器支持 Ctrl/Cmd 拖选多个文本范围，并按文档顺序复制或删除。
- Agent 绿色虚线“生成中”文本在工具调用期间常驻，下一轮正文到达时就地替换，最终完整消息提交后消失；该文本仍不进入持久化会话。
- 编辑器、拆分预览和 Agent 消息中的长代码行在代码块内部横向滚动，不再撑破布局。
- 分片提示与切换在侧栏（大纲卡片下方），不再占文档区顶部。
- 附件插入弹窗：文件夹下拉 + 新建/重命名按钮 + 源文件选择 + 记忆提示。
- 回归必查项（新增）：相对链接必须渲染为 `<a>` 且 Ctrl+左键 可开；分片大文档首开大纲非空；PDF 文本层选中与字形对齐；英文界面 Agent 状态无中文。

## 11. Windows 安装器

（配置与四选项升级不变，见 git 历史 §11）本机已装版本随发布推进；最新本地安装包 `release/Knote-Setup-1.1.37.exe`。安装器测试：

```powershell
node scripts/installer-association.windows.integration.mjs release/Knote-Setup-<version>.exe --require-protected-user-choice
```

## 12. 本轮验证证据

| 层级 | 结果 | 覆盖 |
|---|---:|---|
| 纯 Node/对抗测试（npm test） | 全绿（boundary 139 通过、1 个 Windows symlink 用例跳过） | 历史、并发保存、Agent 协议、工作区边界、附件链接路由（local-file-links）、PDF、图片、粘贴、长文档、冷标签、崩溃、安装器、侧栏、原生 fs |
| Electron UI（test:electron-ui） | 64/64 | 含统一悬停注释、文件二次点击与 HTML 系统打开、Ctrl 多段选区、Markdown 审核 diff、代码块内滚动、附件全流程、Markdown/PDF 滚动边界、Agent 流式状态、暗色对比度、长文档与历史恢复 |
| 编辑器原生（test:editor-native） | 4/4 | 原生宽度拖拽、写入去重、markdown 往返、Windows 双 MIME 粘贴 |
| CI（release.yml，tag 触发） | Windows+Android | Windows job 运行 Electron UI 后打包；Android job生成并上传 debug APK |
| dist:win | 通过 | `Knote-Setup-1.1.37.exe`（108,302,223 字节，SHA-256 `343CCFBE2DF0ED1C0C27E299D65B8D56140E802CF5643C66E66127E713EA7F52`） |
| Android APK | 通过 | `app-debug.apk`（versionCode `1001036`，v2 debug 签名，SHA-256 `099E63E7F4979710F7396F729BA035FD6D7D301018183C4052BA80BE9AC90516`） |

注意：

- `npm test` 链式包含 quit-cleanup 等测试，一次一个自然运行，不中途取消。
- quick-rail 测试在满负载全量套件下偶发失败（rail 滚动/几何时序），单独重跑即过，非功能回归。
- 构建仍有非阻塞警告：daisyUI `@property` 未知、主 chunk / Mermaid / PDF viewer chunk 偏大（PDF viewer 现为懒加载 chunk）。

## 13. 提交与发布状态

- 本文不固化易过期的 HEAD、工作树或远端同步状态；接手时先执行 `git status --short --branch` 和 `git log --oneline -10`。
- 已发布：`v1.1.31`（CI e2e 窗口尺寸修复）、`v1.1.32`（长文档 UX）、`v1.1.33`（PDF 文本层第一版 + Agent i18n）、`v1.1.34`（PDF TextLayerBuilder + 简约主题）、`v1.1.35`（PDFSinglePageViewer Shadow DOM）、`v1.1.36`（通用 Agent、安全沙箱、Android SAF、审核与 PDF/暗色回归）。
- 发布流程：提交 → bump `package.json` → `npm run dist:win` 本地验证 → push main + tag → CI 自动发布 → gh 更新 Release 描述（注意保留/补充功能摘要，CI 自动生成的是提交列表）。
- GitHub 访问、代理和凭据使用开发环境的安全配置；不得在命令输出、日志或文档中打印访问令牌。

## 14. Web、Android、CI

- Web/Android 随推送自动构建（pages.yml 仅 main 分支；release.yml 仅 tag）。
- 本地 Android 构建：`npm run cap:sync && npm run dist:apk`（需 Java 17，CI 用 21 + fix-android-java 脚本）。
- 发布新版本必须等 CI 全绿再宣称完成。

## 15. 已知边界与下一阶段优先级

### P0：若用户反馈回归，优先检查

1. 相对链接渲染 + Ctrl+左键（`KnoteLink.isAllowedUri`、`CtrlClickLink`、`resolveLocalLinkPath` 三者联动）。
2. 分片大文档首开大纲（`outlineStale` 的 `!sameSource` 判断；任何"缓存优化"改动都可能复现空大纲）。
3. PDF 查看器（`PdfViewerHost.vue`：`globalThis.pdfjsLib` 前置顺序、shadow 内 `#viewerContainer` 定位、懒加载 chunk）。
4. 附件目标授权（任何主进程路径判断改动都要复测 `creatableAssetPath` 探针与 `attachment-dirs` 白名单）。

### P1：降低架构复杂度

- 拆分 `App.vue`（文档会话/文件树/历史/长文档/导出/Agent 容器各自 store）。
- 拆分 `agentStore.js`（provider 协议、工具注册、执行账本、PDF、会话持久化）。
- 真正拆分 Mermaid、PDF viewer、Word 导出 chunk。
- 为保存/工作区/Agent 运行身份建立显式 schema。

### P1：长期数据安全

- 慢删除/慢重命名鼠标级 E2E；断电/磁盘满/权限故障注入。
- 用户可见的历史目录导出/校验/恢复入口。
- userData 迁移版本清单；GitHub/Gitee 同步冲突界面。

### P2：无自建服务器在线文档

（Git 仓库作为远端、Device Flow、三方 diff、assets/、系统凭据库等，见 git 历史 §15）

## 16. 下一位 Agent 的建议开工顺序

1. 阅读本文、`README.md`、`package.json`、`AGENTS.md`。
2. `git status --short`、`git log --oneline -10` 确认与本文基准一致。
3. 改动前先跑相关测试建立基线：`npm test`、`npm run test:electron-ui`（62 个）、`npm run test:editor-native`。
4. 只运行一个 Electron 测试并等其自然退出；不并行重型任务。
5. 大改动按 AGENTS.md 顺序验证：npm test → test:electron-ui → test:editor-native → dist:win。
6. 发布：提交 → bump 版本 → dist:win → push main + tag → 等 CI 绿 → 更新 Release 描述。
7. 每个"已完成"声明必须附测试/安装/CI 证据。

## 17. 最后一句

v1.1.31–v1.1.36 已把文件链接/附件、PDF 真实显示、大纲首开、通用 Agent、安全沙箱、Android SAF 和审核策略等收进可验证的实现与测试，且全部经 CI 发布。接手时最重要的：动缓存/竞态/授权代码前先复测 §15 P0 四条链路，发布必须走 tag CI，不手工宣称完成。
