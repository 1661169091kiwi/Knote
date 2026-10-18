# v1.1.93 发布验证

## v1.1.92 未发布与失败记录

- 源码提交 `f325be367993aa1638cb9731b54f650cd41d7d3f`、标签 v1.1.92 已推送，未覆盖或删除。
- 云端流水线：<https://github.com/1661169091kiwi/Knote/actions/runs/39126749659>。
- Android、Linux 成功，Windows 自动重试三轮，每轮都是 108/109 通过；唯一失败为新增教程用例的 `pause must freeze the scene`。最终 publish 跳过，因此没有创建正式版 v1.1.92，不能把代码推送当作发布成功。
- 本地 1.1.92 的 846 个单测、109 个桌面用例、17 个原生编辑器用例通过这一历史记录保留，但不能据此宣称云端也通过。

## 修正范围与验证方式

仅修正测试同步、增加发布前置专项检查和更新版本元数据，未改变应用的暂停逻辑、CSS、拖拽或编辑器实现。原断言未等待 CSS 暂停的渲染帧提交，可能把提交前的时钟变化当成暂停后漂移。

测试先等待 `playState === paused && pending === false` 再取样，暂停后漂移阈值从 25ms 收紧为 0.01ms；同时检查按钮状态。分别在正常和 6 倍 CPU 降速下检查真实动画推进、暂停与重播；显式设置正常动态偏好，再单独覆盖减少动态效果，不依赖 CI 操作系统设置。

后台专项：`resize-pause-ci-fix.log`，5/5 通过，正常和 6 倍 CPU 降速下，暂停完成后的漂移均为 0ms。

发布流水线在完整鼠标回归之前单独检查教程，尽早暴露本次修改的问题；之后仍跑原有完整套件，没有减少用例或取消发布校验。失败日志包含专项日志。

使用 v1.1.93 新标签发布，保留 v1.1.92 失败记录，不重写标签。

## 最终结果

本地小修验证：`npm test` 846 通过、1 个平台跳过；发布流程/侧栏相关 25/25 通过；后台鼠标专项 5/5 通过。没有改动功能源码，原有 109 项桌面与 17 项原生编辑器的本地通过记录属于 v1.1.92，不伪记为本次重新运行；完整鼠标套件会由新云端流水线再跑。

`npm run dist:win` 成功；1.1.93 ASAR 的 191 个文件与当前构建/源文件逐字节一致，Undici 仍为 7.29.1。安装包 108,383,960 字节，SHA-256：`32F5640E90C2B0390389159D69CF575B7EA6E0B06167ADFC70D9F086C9AB6800`。

新云端发布未成功：<https://github.com/1661169091kiwi/Knote/actions/runs/39128884682>。前置专项检查捕获 `demo should actually animate`：原有播放检查也未等待 pending play 完成，就使用 180ms 墙钟等待检查动画时钟。完整鼠标套件和 publish 因此前置失败而跳过，未创建正式版 v1.1.93。

后续在 `codex/release-preflight` 分支统一等待播放/暂停提交，再检查动画时钟实际推进；重播也等待启动完成。不是增加原来暂停后的漂移容差，暂停后阈值仍为 0.01ms。播放时钟检查在 3 秒上限内等待推进超过 60ms，不再把 CI 渲染调度等同于精确墙钟延迟。

云端预检 <https://github.com/1661169091kiwi/Knote/actions/runs/39129329713> 已成功；正式发布转为 v1.1.94，保留 v1.1.92 与 v1.1.93 的失败标签、记录和日志。

API 依据：[Animation.pending](https://developer.mozilla.org/en-US/docs/Web/API/Animation/pending)、[Animation.ready](https://developer.mozilla.org/en-US/docs/Web/API/Animation/ready)。pending play 和 pending pause 都是异步状态，不能仅凭 playState 提前采样。
