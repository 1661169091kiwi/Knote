# Knote 1.1.82 — 更新栏刷新按钮与 PDF 提示文案

- 将刷新改为更新状态栏右侧的纯图标按钮，移除单独的刷新菜单行。
- 主操作与刷新是同一容器内两个独立按钮，不嵌套按钮；点击刷新仅重新检查版本。
- 下载进度动画仍限制在整个更新状态栏内。
- 删除 PDF 导出进度弹窗中的“阶段进度 · 页面生成期间不显示虚假的逐页百分比”及英文对应文案，同时移除不再使用的样式。
- 不改 PDF 后端、导出阶段事件、取消机制或文档编辑逻辑。

按 AGENTS.md 的小改动规则执行相关测试，没有把上一版完整套件结果冒充本次结果：

- 更新服务单元测试：10/10 通过。
- Electron UI 专项：3/3 通过，覆盖图标同栏/右侧位置、刷新不下载、进度边界、错误重试及 PDF 弹窗文案删除。
- 前端构建通过。
- Windows 安装包：构建通过，`release/Knote-Setup-1.1.82.exe`，108,351,173 字节。
- 包内版本 1.1.82，150 个关键文件与完整构建资源逐字节一致；包内 ASAR 启动的 PDF 导出冒烟测试通过。
- SHA-256：`84D3E8520908C2C56BED89E3B433CC88F5C8854EF6DFAF9F544905728DEE5D34`。

上述本地构建完成时未自动安装，也未推送或发布 GitHub。

## GitHub 发布与真实更新链路验证

应用户要求，于 2026-10-01 发布 `v1.1.82`：

- 发布源码提交：`8ecafc22ecc8194468d35407878f37a5bafef260`，已推送 main，并创建、推送对应版本标签。
- 发布流程：https://github.com/1661169091kiwi/Knote/actions/runs/36871231675 ，validate / Windows / Linux / Android / publish 全部成功。
- GitHub Windows 测试：源模式编辑单测 52/52、完整 Electron UI 103/103，一次通过。
- 正式 Release：https://github.com/1661169091kiwi/Knote/releases/tag/v1.1.82 ，包含 Windows 安装包、Linux AppImage / deb / rpm 和 Android 签名 APK。
- `/releases/latest` 已返回 `v1.1.82`，非草稿、非预发布，五个附件均为 uploaded。
- 本次线上安装包由 GitHub CI 从上述提交重新构建，并非上传本地 EXE；线上文件为 108,340,139 字节，SHA-256 为 `92692DB5BAEA2B4EE92F4266A8614C77EB0A80184F3A3CE8E290E7CB9D284402`。不要与上方本地构建的哈希混用。
- 使用生产更新服务、真实 GitHub API 和真实安装包链接，以 1.1.81 为当前版本，在独立临时目录执行完整检查和流式下载：available → downloading → downloaded，长度与 SHA-256 校验通过。
- 本机 `D:\Knote` 安装版本只读确认是 1.1.81；本轮没有启动安装程序，也没有修改其用户档案。开发者原有未跟踪文件未加入提交。
