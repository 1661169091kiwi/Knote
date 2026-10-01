# Knote 1.1.80：更新下载、完整 PDF 导出与悬浮提示

## 需求与实现

### 桌面更新

- Windows/Linux 桌面端从官方 GitHub Releases 的 latest API 检查稳定版本，不使用额外服务器。
- 右上角三个点菜单新增更新入口与“启动时自动检查更新”开关；默认开启，保存在用户数据目录的 `updates/preferences.json`。
- 每次应用启动只检查一次；重载渲染页面不会重复检查。自动检查失败不弹窗、不显示错误；手动检查失败允许重试。
- 检查到新版本后，标题栏出现绿色、无文字的下载图标。点击开始下载并打开进度菜单。
- 下载行左侧为浅绿色，右侧保留背景；波动的前沿和从左向右移动的亮带均裁剪在该行内部，不影响其他菜单项。
- 流式写入应用私有临时目录，不把整个安装包读入内存。进度事件最多约每 100ms 推送一次，空闲时不轮询、不启动子进程。
- 安装包必须匹配官方文件名、平台、URL、发布大小和 GitHub SHA-256；校验并写盘完成后才显示“已下载”。失败/退出清理本次未完成文件。
- 下载完成后点击入口打开安装包所在文件夹。本版本不擅自启动安装、不自动替换正在运行的应用。此更新入口不用于 Android。

### PDF 导出

- 导出前提交当前编辑分片，取得完整 Markdown 快照；后续切换标签页不会改变该次导出的内容。
- 从完整源内容重新生成渲染 HTML，解析尚未挂载分片中的图片，并转换 Mermaid 图表。
- Electron 创建无 preload、无 Node 权限、不可见的独立打印窗口；等待图片与字体后生成 A4 PDF，并销毁窗口与临时 HTML。
- 打印页面没有聊天、工具栏、悬浮提示、编辑光标或选中节点；不再截取/打印正在使用的编辑器页面。
- 保留已有输出文件的留存、原子替换与目标身份复核机制。

### 悬浮提示

- 普通悬浮提示等待 1000ms；提前移开指针取消提示。
- 点击后直接产生的反馈（如“再次点击打开”）仍走立即显示的通道，不增加等待。

## 验证记录

- 新增更新服务单测 10/10 通过，覆盖版本比较、默认/持久化开关、静默失败、超时、单次下载、校验拒绝与退出清理。
- 新增真实 Electron 交互专项测试 4/4 通过：启动检查及下载、静默失败与手动重试、完整多分片 PDF、悬浮延迟。
- PDF 专项既检查独立打印页面，也逐页解析实际导出的 PDF，确认首/中/尾与未保存修改存在，确认提示文字不在 PDF 中，尾部分片图片加载成功。
- `npm test` 通过：812 项通过、1 项因当前 Windows 环境无法创建文件符号链接而跳过；Windows 沙箱 broker 探针也通过。
- `npm run test:electron-ui` 通过：101/101，包含新增用例和 #20/#21、#24 的既有回归用例。
- `npm run test:editor-native` 未通过：1/4 通过，3 项失败。随后在未修改的 Git 提交 `765b74c` 的独立 worktree 中构建并运行同一命令，仍为 1/4，且失败在完全相同位置。未修改测试断言，也未宣称编辑器套件通过。
  - 原生双 MIME 粘贴：第二次粘贴的空行写盘等待失败（`rich-editor-native.e2e.test.mjs:200`）。
  - 空行/键盘输入：等待 `alpha\n\nomega` 内容失败（`:360`）。
  - 图片：居中之后等待宽度滑块可见失败（`:462`）。
  - 以上是当前 Git 基线已存在的失败，本次未扩大改动范围修复；应由后续单独诊断处理。
- 全量桌面测试中的性能回归用例通过：8MiB 文档两次打开 234.9/270.4ms，分片输入 58.8ms，最大渲染长任务 66.0ms；350k 结构化 Markdown 打开 428.8ms、输入 72.2ms。数据仅为本机该次测试，不作为其他机器的保证。
- `npm run dist:win` 完成，退出码 0；产物 `release/Knote-Setup-1.1.80.exe`，108,372,794 字节。
- 安装包 SHA-256：`BAEA862797E3AAAFA82F86ECAC5AD39034F2FABBDD90EC4448D930AC9B2B2348`。
- 已核对 `release/win-unpacked/resources/app.asar` 内版本为 `1.1.80`；`electron/main.cjs`、`electron/preload.cjs`、`electron/app-updates.cjs`、`electron/document-pdf.cjs`、`dist/index.html` 与当前构建输入逐项 SHA-256 一致。
- 下载菜单截图：`docs/screenshots/update-download-1.1.80.png`。
- 基线诊断临时 worktree 保留在 `C:/Users/16611/AppData/Local/Temp/knote-update-baseline-3db2fd392e9f469dbfba26ac31049c57`。清理调用被工具策略拒绝，未绕过，也未删除主项目依赖。

## 关键文件

- `electron/app-updates.cjs`：主进程检查、下载、校验、设置与生命周期。
- `src/lib/useAppUpdates.js`、`src/components/UpdateMenuItems.vue`：事件驱动状态与菜单视觉。
- `src/lib/documentPrint.js`、`electron/document-pdf.cjs`：独立完整文档打印。
- `electron/main.cjs`、`electron/preload.cjs`、`src/App.vue`：集成入口与 IPC。
- `electron/app-updates.test.cjs`、`scripts/electron-ui.e2e.test.mjs`：新增回归用例。

本次不重复回复已经关闭的 #20/#21；截图中的三条通知对应这两个 issue，而不是三个尚待处理的问题。本次也未发布新的 GitHub Release。
