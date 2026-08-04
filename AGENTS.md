# AGENTS.md

## 构建与验证约定（用户明确要求，所有会话必须遵守）

- 每次完成**大改动**（功能/重构/测试规模较大）后，必须按顺序自动执行：
  1. 单元测试：`npm test`
  2. 桌面端 e2e：`npm run test:electron-ui`（含构建）
  3. 编辑器 e2e：`npm run test:editor-native`
  4. 构建 Windows 安装包：`npm run dist:win`
- 产物：`release/Knote-Setup-<version>.exe`
- 如用户只要求小改动（修文案、调样式等），可只跑相关测试并说明。

## 测试说明

- `npm test` 链式运行多套对抗/单测（retention/agent/image/paste/installer/tab-buffer/crash/pdf/sidebar/boundary/native）。
- `tab-buffer-store.test.cjs` 的配额用例偶发超时（与改动无关），隔离重跑即可。
- 完整套件：`npm run test:all`。
