<div align="center">

# Knote

**A modern, Feishu-style WYSIWYG Markdown editor with a built-in AI assistant.**
**类飞书体验的所见即所得 Markdown 编辑器，内置 AI 助手。**

Cross-platform · Local-first · Bring-your-own-AI-key
跨平台 · 本地优先 · 自带 AI 密钥

[English](#english) · [中文](#中文)

</div>

---

## English

Knote is a local-first Markdown editor that feels like a modern block editor (Feishu / Notion style) while keeping **plain Markdown as the single source of truth**. It runs as a web app, a Windows desktop app (Electron), and an Android app (Capacitor).

### ✨ Features

- **True WYSIWYG editing** — type Markdown syntax and it converts live (TipTap / ProseMirror); a split source/preview mode is one click away.
- **Rich Markdown** — headings, lists, tasks, tables, code blocks with syntax highlighting, KaTeX math, footnotes, emoji, highlight/underline, and more.
- **Callout blocks** — `> [!tip]`, `> [!warning]`, etc. render as colored cards.
- **Mermaid diagrams** — write `mermaid` code blocks and see the diagram render live.
- **Built-in AI assistant** — connect any OpenAI-compatible or Anthropic API (DeepSeek, SiliconFlow, OpenAI, Kimi, Claude…). It can read and edit the document, with edits shown as red/green diffs you accept per-block or all at once. Attach images / PDFs by clicking or **drag-and-drop**. Your API key is stored **only in your browser**.
- **Tabs & folder workspaces** — open multiple documents/folders like a browser; drag to reorder; the session restores on restart. Browse a folder tree, create/rename/delete files and folders, and search full-text across the whole folder.
- **Find & replace** (`Ctrl+F` / `Ctrl+H`), **quick open** (`Ctrl+P`), **heading fold**, **version history** with one-click rollback, **image viewer** (double-click to zoom/pan), and **UI zoom** (`Ctrl+Wheel`).
- **Export** to PDF, Word (`.doc`), HTML, and Markdown.
- **Desktop niceties** — frosted title bar, `.md` file association, tray residence, delete-to-Recycle-Bin.
- **Bilingual UI** (中文 / English).

### 🛠 Tech stack

Vue 3 · Vite · TipTap / ProseMirror · markdown-it · Tailwind CSS · daisyUI · KaTeX · Mermaid · highlight.js · Electron · Capacitor

### 🚀 Getting started

```bash
# install dependencies
npm install

# web dev server (hot reload)
npm run dev

# build the web assets
npm run build
```

**Run the desktop app (Electron):**

```bash
npm run build      # build web assets first
npm run app:dev    # launch Electron
```

**Build the Windows installer:**

```bash
npm run dist:win   # -> release/Knote Setup <version>.exe
```

**Build the Android APK** (the native project is not committed — generate it first):

```bash
npx cap add android
npm run dist:apk   # -> android/app/build/outputs/apk/debug/
```

### 🤖 Configuring the AI assistant

Click the green floating ball (bottom-right) to open the assistant, then open settings:

1. Choose the protocol — **OpenAI-compatible** for most providers, or **Anthropic** for Claude's native API.
2. Fill in **API URL**, **API Key**, and **model name**.
3. Click **Detect** — Knote probes the model and lights up capability badges (chat / tools / vision / PDF).

Keys are stored in your browser's local storage only; Knote has no server and never uploads them.

### 📄 License & attributions

Released under the [MIT License](LICENSE). Built on excellent open-source projects (Vue, TipTap/ProseMirror, markdown-it, KaTeX, Mermaid, highlight.js, Electron, Capacitor — all permissively licensed). The retro theme uses the **Press Start 2P** font under the SIL Open Font License.

> "Feishu" and other product names are trademarks of their respective owners; Knote is an independent project and is not affiliated with or endorsed by them.

---

## 中文

Knote 是一款**本地优先**的 Markdown 编辑器，拥有现代块编辑器（飞书 / Notion 风格）的顺滑体验，同时坚持**以纯 Markdown 字符串作为唯一数据源**。可作为网页应用、Windows 桌面应用（Electron）和 Android 应用（Capacitor）运行。

### ✨ 功能特性

- **真·所见即所得** —— 输入 Markdown 语法即时转换（TipTap / ProseMirror），一键可切到源码/预览双栏模式。
- **丰富的 Markdown** —— 标题、列表、任务、表格、带语法高亮的代码块、KaTeX 公式、脚注、Emoji、高亮/下划线等。
- **Callout 提示块** —— `> [!tip]`、`> [!warning]` 等渲染为彩色卡片。
- **Mermaid 图表** —— 写 `mermaid` 代码块即可实时渲染流程图/时序图。
- **内置 AI 助手** —— 接入任意 OpenAI 兼容或 Anthropic 接口（DeepSeek、硅基流动、OpenAI、Kimi、Claude……）。助手可读写文档，改动以红绿 diff 呈现，可逐块或一键接受。支持点击或**拖拽**添加图片 / PDF。API 密钥**只保存在本机浏览器**。
- **标签页与文件夹工作区** —— 像浏览器一样同时打开多个文档/文件夹，可拖拽排序，重启自动恢复。浏览文件夹树、新建/重命名/删除文件与文件夹，并跨文件全文搜索。
- **查找替换**（`Ctrl+F` / `Ctrl+H`）、**快速打开**（`Ctrl+P`）、**标题折叠**、**版本历史**（一键回滚）、**图片查看器**（双击放大/拖拽）、**界面缩放**（`Ctrl+滚轮`）。
- **导出** PDF、Word（`.doc`）、HTML、Markdown。
- **桌面端体验** —— 毛玻璃标题栏、`.md` 文件关联、托盘后台驻留、删除进回收站。
- **中英双语界面**。

### 🛠 技术栈

Vue 3 · Vite · TipTap / ProseMirror · markdown-it · Tailwind CSS · daisyUI · KaTeX · Mermaid · highlight.js · Electron · Capacitor

### 🚀 快速开始

```bash
# 安装依赖
npm install

# 网页开发服务器（热更新）
npm run dev

# 构建网页资源
npm run build
```

**运行桌面应用（Electron）：**

```bash
npm run build      # 先构建网页资源
npm run app:dev    # 启动 Electron
```

**打包 Windows 安装包：**

```bash
npm run dist:win   # -> release/Knote Setup <版本>.exe
```

**打包 Android APK**（原生工程未纳入版本库，需先生成）：

```bash
npx cap add android
npm run dist:apk   # -> android/app/build/outputs/apk/debug/
```

### 🤖 配置 AI 助手

点击右下角绿色圆球打开助手，进入设置：

1. 选择协议 —— 多数服务选 **OpenAI 兼容**，Claude 官方接口选 **Anthropic**。
2. 填写 **API 地址**、**API Key**、**模型名称**。
3. 点击**检测** —— Knote 会探测模型能力并亮起徽章（对话 / 工具 / 图片 / PDF）。

密钥仅存于浏览器本地存储；Knote 没有服务器，绝不上传。

### 📄 许可证与致谢

基于 [MIT 许可证](LICENSE) 发布。构建于诸多优秀开源项目之上（Vue、TipTap/ProseMirror、markdown-it、KaTeX、Mermaid、highlight.js、Electron、Capacitor —— 均为宽松协议）。复古主题使用 **Press Start 2P** 字体（SIL 开放字体许可 OFL）。

> "飞书"及其他产品名称为各自所有者的商标；Knote 为独立项目，与之无关联、亦未获其背书。
