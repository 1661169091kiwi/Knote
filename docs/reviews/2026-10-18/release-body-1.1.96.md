# Knote 1.1.96

- 修复含大量测试依赖或缓存的工作区只显示部分目录、不显示根目录文档的问题。
- 文件树按需展开目录，初次打开不再预先遍历全部子目录；刷新保留已展开状态。
- 全文搜索与 Agent 索引可覆盖未展开的目录，不将尚未扫描的子目录误判为空目录。
- 完善表格单元格空白区域点击定位，覆盖居中、右对齐、表头及加粗/斜体单元格，同时保留原生文字拖选。

## English

- Fixed missing root documents in workspaces containing large test or dependency trees.
- Folders now load on demand; search and Agent indexing still cover unopened directories.
- Improved caret placement when clicking table-cell whitespace, including aligned headers and inline formatting, while preserving native text selection.

> Android signing transition: APKs from v1.1.37 and earlier were debug-signed and cannot be upgraded in place. Back up app-local data before uninstalling the old Android app and installing the release APK. Uninstalling removes app-local settings, API keys, and sessions.

<!-- knote-manual-release:1.1.96:5c2abe3:39210967265 -->
