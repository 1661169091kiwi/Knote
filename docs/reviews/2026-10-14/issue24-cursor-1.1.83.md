# Knote 1.1.83 — YAML 属性展示与文本光标

## 范围

- 基于 `83d756f`（main，包含 PR #25 的 Undici 7.29.1 修复）。
- 最新 issue 是 [#24](https://github.com/1661169091kiwi/Knote/issues/24)，新反馈发表于 2026-10-05：1.1.82 的单栏和双栏仍显示 YAML 源码引用块，用户希望正常呈现文档属性。
- 本轮另修用户截图反馈：浅色界面下文本选择鼠标仍为白色、难以定位。
- 已按用户要求在 issue 致歉，未宣称尚未完成的发布：[评论](https://github.com/1661169091kiwi/Knote/issues/24#issuecomment-6163736545)。评论已通过 API 回读确认。

## 实现

### YAML

- 使用同一个 `renderFrontmatterBody()` 生成编辑器原子节点、双栏预览和导出中的属性列表。
- 字段和值两列排版；列表值显示为标签；去掉引用块左边框、整块灰底、默认源码面板。
- 源码仍由 `data-knote-frontmatter` / 节点 `src` 属性保存；展示层解析结果绝不反向生成 YAML 覆盖原文。原有 Markdown 序列化器继续写回原始源码。
- 使用固定版本 `yaml@2.9.1`（构建依赖，随 Vite 打包）解析 AST；failsafe schema 保留日期、数字拼写。只展示文本，不执行标签、不解析图片路径、不生成可执行 HTML。
- 不展开 aliases，不将映射转换为 JavaScript 对象。重复键线性检查，避免原解析器逐对比较的二次复杂度。
- 解析前限制为 16,384 字符、258 行；展示遍历限制为 512 节点、8 层。无效、重复键、未知标签或超限内容显示完整转义源码，绝不丢弃或改写。
- 本机 3,000 字段 / 43,897 字符的超限样例：加预检前约 60.8ms，预检后约 0.16ms。此数字仅为一次本地诊断，不是跨设备性能承诺。

### 光标

- 应用切换主题时，Electron 的 `nativeTheme.themeSource` 同步为 light/dark，而非仅更新标题栏按钮。
- 主题 IPC 限制为主窗口主 frame。
- 明确设置应用 CSS `color-scheme`。编辑器、预览、聊天与普通文本输入使用主题对应的双描边 SVG I-beam：浅色背景深色主体、深色背景浅色主体，反色外描边帮助在选区上辨认。
- 输入插入光标也使用对应高对比颜色。按钮、链接、图片缩放及拖动手柄保留自身光标。
- 没有增加鼠标跟踪、动画循环、DOM 浮动光标或后台定时任务。

## 验证记录

- 修复前，新增的两个 Electron 专项测试均真实失败：没有属性行；浅色 UI 重载后 nativeTheme 仍为 dark。
- 修复后专项 2/2 通过，覆盖属性列表、保存原始 YAML、重载、双栏，以及对抗原生深色主题、明暗切换、编辑器和聊天光标。还实际监听到 Chromium 的 `cursor-changed` 返回非空 custom cursor 图片。
- 专项初次回归有一项测试等待超时：重载后程序按既有行为回到单栏，测试错误地等待双栏。已修正测试为验证单栏重载，不修改产品的模式恢复逻辑；重新运行 2/2 通过。
- YAML / HTML 专项单测 16/16 通过，包含注入、原型键、aliases、无效 YAML、重复键、嵌套对象和超限输入。
- 完整单测初轮：819 passed / 1 skipped，0 failed。随后加入解析前性能限制，完整重跑时 tab-buffer 全局配额用例偶发失败；隔离整个 tab-buffer 文件 21/21 通过。未改动该用例或存储实现，继续完整重跑以验证最终代码。
- 最终完整单测重跑：819 passed / 1 skipped，0 failed。跳过项为 Windows 环境无法创建文件 symlink；没有跳过失败用例。
- 首轮前台 Electron 完整回归出现单文件保存失败、光标用例超时及外部字体网络超时。因用户明确反馈测试窗口不断抢前台，该轮与同时运行的诊断轮已中断，不能算作通过。
- 新增 `scripts/windows-background-test.ps1`：使用 Win32 CreateDesktop/CreateProcess 将真实有界面的测试运行在独立、未选中的桌面；不调用 SwitchDesktop，不改变正式应用显示逻辑，也不使用 taskkill/WMI。两个失败用例在该环境重新运行 2/2 通过（约 19 秒）。尚不能据此单独认定之前超时的唯一原因。
- Electron UI 在该独立桌面完整重跑：104/104 通过，0 failed / cancelled / skipped；用时约 794 秒。单文件保存、YAML 与光标用例全部通过，没有降低断言或跳过失败项。
- 长文档 PDF 回归：586,237 字节样例导出完整 295 页，包含末页；导出期间 UI 心跳最大间隔约 225ms。本次回归实测约 147.5 秒，不是即时完成。
- 原生编辑器测试在独立桌面通过：5/5，0 failed / cancelled / skipped；包括原生双 MIME 粘贴、格式化复制边界及图片对齐/缩放保存重载。
- Windows 打包在独立桌面成功：`release/Knote-Setup-1.1.83.exe`，108,374,636 字节。
- 包内版本 1.1.83、Undici 7.29.1；全部 dist / electron / 图标共 191 个文件与当前构建逐字节一致。核验脚本首次使用 POSIX 分隔符读取 Windows ASAR 失败，改为本机 `path.normalize()` 后全部通过；没有修改产品资源规避检查。
- 本地安装包 SHA-256：`02B996D74674B0B0D0A24089F66F4798D07F39678A9FBFD68C622DE338347A97`。
- ASAR 实际启动的 PDF 冒烟测试在独立桌面通过：版本 1.1.83、导出 1 页 / 28,949 字节，首尾哨兵齐全，打印窗口已回收。

## 后台测试

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-background-test.ps1 -Task electron-ui -LogPath electron-ui.log
```

`Task` 还支持 `editor-native`、`dist-win`、`packaged-pdf` 和两个失败用例的 `focus` 诊断。子进程真实退出码会传回调用方；测试运行在独立桌面，不通过隐藏正式应用、删除断言或替换真实鼠标交互来达成后台运行。

## 发布

用户已明确批准验证通过后直接发布正式版 v1.1.83。GitHub 发布流程与线上产物核验待完成后补记；本地 EXE 与 CI 重建 EXE 的哈希须分别记录。

所有桌面测试使用独立临时 profile 和工作区；长文档测试只读取真实样例并在临时工作区测试，没有写入用户真实文档，也没有安装覆盖用户的 Knote。原有未跟踪文件保持不动。
