# Knote 1.1.62：独立侧栏宽度与单文档保存

## 交付范围

- 实装已批准的侧栏操作卡片，单栏侧栏与分栏浮出侧栏共用 `SidebarActions.vue`。
- 左侧默认 280 px，可调 240–400 px；Agent 默认 420 px，受当前窗口约 45% 及编辑器可用宽度限制。
- 移除左右自动等宽扩张和空白镜像占位，编辑器在剩余区域居中。
- 左栏右边缘、Agent 左边缘支持拖动；双击恢复该侧默认值；分隔条支持方向键，Shift 加大步长，Home 恢复默认。
- 宽度分别保存在 `knote-sidebar-widths-v1`。拖动帧仅改 CSS 变量，松开后持久化；取消拖动不保存；高度变化不触发宽度重算。
- 不安装应用，不回退/覆盖用户原有未提交修改；不包含此前诊断报告里的聊天缓存/代码高亮性能改造。

## 保存根因与修复

`grantWritablePath` 为单文件保存打开时的 dev/ino 等身份。`DocumentRetentionStore` 通过临时文件 + 原子替换保存，正常保存本身会改变文件 inode。原来的授权未随成功提交更新，后续 `authorizeWritablePath` 会拒绝写入；旧恢复 capability 也会失效。

新流程：

1. 保持准确的单文件授权与固定父目录边界。
2. 保存前、原子提交前重新核对原目标身份。
3. 留存层返回它实际写入并 fsync 的临时文件身份。
4. 校验保存后路径仍指向该身份，且仍在原父目录边界内，才续接授权。
5. 主进程签发新文件 capability，通过 `knote:file-saved` 更新最近打开与会话恢复记录。

禁止以移除身份检查、开放整个父目录、盲信保存后任意路径的方式修复。外部替换与未授权相邻文件仍被拒绝。

## 验证记录

- 新增精确文件授权测试：连续四次保存、能力令牌重启验证、外部替换拒绝、提交后替换拒绝、首次另存创建。
- 新增 Electron UI 测试：单文件连续三次实际写盘、刷新后使用新 capability 打开、未授权相邻文件拒绝。
- 新增 Electron 鼠标测试：左右独立拖动、拖动中不持久化、松开后保存、刷新恢复、单侧双击恢复、文档内容不被改动。
- 完整单测已通过。首次受限环境运行中的 Windows AppContainer 祖先目录访问限制，在正常权限环境重跑通过，未放宽安全策略。
- 首轮 Electron UI 为 81/83：发现并修复 Android 横屏侧栏定位回归；更新旧的 Agent 320 px 默认宽度断言以匹配批准的 420 px 设计。
- 修正后 `npm run test:electron-ui` 为 83/83 通过，包含单文件保存和侧栏鼠标级测试。
- `npm run test:editor-native` 在此前受限执行环境中未能启动：Vite 读取工作区上级目录时收到 Access denied；该项仍未重新执行。
- 修正图片边框计入自然尺寸后，编辑器原生测试直接重跑为 4/4 通过。
- 提权恢复后 `npm run dist:win` 已成功完成，生成 [Knote-Setup-1.1.62.exe](../../../release/Knote-Setup-1.1.62.exe)，大小 108,350,738 字节，SHA-256：`71287C186B7620B80EA46D33980ABBED6BD3E385F08FF4143C5F40BC3975B007`。
- `release/win-unpacked/Knote.exe` 的 FileVersion 为 1.1.62；本次只完成打包，未自动安装。

实装截图由 `KNOTE_CAPTURE_UI=1` 的鼠标测试生成：`docs/screenshots/sidebar-layout-1.1.62.png`。
