## 修复

- 修复 #24：YAML 文档属性在单栏编辑器和双栏预览中按字段、值及标签展示，不再呈现为引用块；保存仍保留原始 YAML，不改写注释和格式。
- 修复浅色界面下文本选择光标难以辨认的问题。鼠标文本光标、输入插入光标和原生控件主题现在跟随 Knote 的明暗主题。
- 包含 #25 的 Undici 7.29.1 安全修复，同时保持 jsdom 网页正文提取兼容性。

## 验证

- 本地单测：819 项通过，1 项 Windows symlink 环境跳过。
- 完整 Electron 交互测试：本地与 GitHub Windows CI 均为 104/104 通过。
- 本地原生编辑器测试：5/5 通过；Windows 安装包资源核验及包内 PDF 导出冒烟测试通过。

> **Android signing transition:** Back up any app-local data you need before installing. APKs from v1.1.37 and earlier were debug-signed and cannot be upgraded in place. Uninstall the old Android app, then reinstall this APK. Uninstalling removes app-local settings, API keys, and sessions.

**Full Changelog**: https://github.com/1661169091kiwi/Knote/compare/v1.1.82...v1.1.83

<!-- knote-release-run:38540865692:1 -->
