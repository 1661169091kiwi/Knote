# v1.1.96 发布核验

用户明确要求发布。源码和附注标签已推送：

- 标签：`v1.1.96`。
- 标签提交：`5c2abe3d0b705754beaa35482b541677cc9a0d98`，属于 `origin/main`。
- 正式多平台流水线：<https://github.com/1661169091kiwi/Knote/actions/runs/39208582384>。
- 更新内容：工作区根目录完整列举、子目录按需加载、未展开目录搜索和 Agent 访问，以及表格空白点击定位补全。

## 已完成的本地验证

详见相邻 `workspace-tree-1.1.96.md`，保留首轮失败及修复过程。最终按顺序执行：

1. `npm test`：864 通过、1 平台跳过、0 失败。
2. `npm run test:electron-ui`：111/111，包含真实用户目录只读检查，67 个根目录 Markdown 文件全部可见。
3. `npm run test:editor-native`：18/18。
4. `npm run dist:win`：退出码 0，191 个应用资源逐字节匹配。

本地 Windows 安装包 108,385,051 字节，SHA-256 `F589FA3D95EC336A460F62435AAC751ACDE6EAA6B18EA7FF84E6808C8C74AD57`。发布前已重新计算哈希一致。未安装程序。

云端构建和正式公开的最终结果在核验完成后追加；不能将标签推送或构建进行中称为发布成功。

## 首次云端回归与夹具修正

正式运行 39208582384 的 Windows 步骤长时间未结束，取消后取得完整日志，确认不是纯粹无响应：第一轮 110/111，失败是队列恢复用例；自动重试中表格下正文保存重载用例超时。运行结论为 cancelled，**不计为全套通过**。日志保留在本地 `windows-cloud-1.1.96.log`，不得隐去这两项失败。

检查发现测试将 Chromium 开关排在开发入口 `.` 之前；应用按 `argv.slice(2)` 解析用户路径时会把 `.` 当成另一个工作区。云端失败诊断确有 `D:/a/Knote/Knote` 与测试工作区并存。修正仅针对测试夹具：入口排在参数第一位，额外断言主进程 `argv[1]` 解析为应用目录；不改变应用的 argv 处理、不改产品资源、不重写 v1.1.96 标签。

本地四项专项 4/4，包括两项云端失败用例和两项文件树用例。初次新增诊断断言误在 evaluate 内使用 `require`，四项因诊断本身失败；已将路径解析放回测试进程，保留两轮本地日志 `release96-reload-local.log`、`release96-reload-local-final.log`。

修订提交 `5f7bd1b` 只涉及夹具、后台专项入口和已有预检工作流；预检先验证启动/重载/流式专项，再运行原完整 111 项，未减少断言或放宽超时。云端预检：<https://github.com/1661169091kiwi/Knote/actions/runs/39210967265>。最终结果待追加。

发布复查 `npm test` 首轮和缓存文件隔离重跑均遇到已知的并发全局配额错误码断言失败，未修改或放宽断言；最终完整重跑为 864 通过、1 平台跳过、0 失败，退出码 0（`unit-1.1.96-publication-final.log`）。再次确认 `git diff v1.1.96 HEAD -- src electron build package.json package-lock.json` 为空，191 个 ASAR 资源和 Windows 安装包哈希不变。

手动草稿 Release ID `416981242`，所有权标记 `knote-manual-release:1.1.96:5c2abe3:39210967265`。五个文件均上传成功，远端字节数及 GitHub digest 与待发布清单一致，仍等待云端完整预检后才公开。

## Android / Linux 产物复核

原标签流水线的 Android、Linux job 已成功。下载对应 CI 产物后复核，Android 使用本地 `verify-android-apk.mjs` 再次通过：包名 `com.kv.knote`、版本 `1.1.96` / `1001096`、非 debuggable、固定发布签名。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Knote-v1.1.96-android-release.apk | 11022863 | 74987ea7ad45ca3c853642bcf62e7c2e3ff2984238c05c19178d77ce3f3f93bd |
| Knote-1.1.96.AppImage | 138775866 | 5216562e31eb91d7d5aa744b3c60b7e9299fad6ec549516a0f2527e3dd08d439 |
| Knote-1.1.96.deb | 107717684 | f4bef25e17a8c426832046ff4ebeb8072c596af081f307048ff3118182f76bcb |
| Knote-1.1.96.rpm | 94554693 | 4188162caf22f777291f23f97f9ac128977f852bd42ddfb3ab2db5cd57c000aa |

## 最终公开发布

2026-10-19 06:52:21 UTC（America/Los_Angeles：2026-10-18 23:52:21）正式公开：<https://github.com/1661169091kiwi/Knote/releases/tag/v1.1.96>。

- Release ID `416981242`，`draft=false`、`prerelease=false`，`releases/latest` 已确认为 v1.1.96。
- 修正后的云端预检 39210967265 **成功**：启动/重载/流式专项 5/5，随后完整桌面 111/111，0 失败、0 跳过、0 取消。完整套件约 654.7 秒，日志 `windows-preflight-1.1.96.log`。原发布运行的取消和失败记录保留，不将它改称成功。
- 云端预检提交 `5f7bd1b73be8ba7163f5688e7e4ef3e8b27427a2` 的应用资源与发布标签完全一致；变更只有测试夹具、专项后台入口和预检步骤。
- Windows 使用原本地完整验证后的安装包：108,385,051 字节，SHA-256 `f589fa3d95ec336a460f62435aac751acde6eaa6b18ea7ff84e6808c8c74ad57`。未重建覆盖、未安装。Android / Linux 使用原标签 CI 成功产物，哈希见上表。
- 公开前重新检查草稿 ID、标签、所有权标记、正式/草稿状态及五个文件的 uploaded 状态、字节数、GitHub SHA-256 digest；全部一致后才公开并设为 latest。公开后再次从 latest API 逐个复核，五个文件全部一致。
- Windows 公共下载链接经跟随重定向的 HTTP HEAD 检查返回 200；更新公告同时提供中英文说明及原有 Android 签名迁移提示。
- 没有修改用户文档、安装程序或提交无关截图/未跟踪文件。`tmp-release-v1.1.96/` 为发布复核缓存，未声称已清理。
