# 实际文档图片编辑卡顿：诊断记录

后续修复、完整验证与本地 1.1.98 安装包记录见 `image-edit-performance-1.1.98.md`；以下保留本轮诊断时的状态。

本轮用户询问实际文档调整图片为何仍卡顿，仅诊断，不更改产品实现、不构建安装包、不安装、不发布。

## 样本与隔离

- 用户原件 43,816 字节、304 行、18 个 Markdown 标题、3 张图片；不将私有正文、文件名和截图加入仓库。
- 三张 PNG 分别约 1.11 MB、1.02 MB、1.32 MB，尺寸为 1536×1024、1774×887、1536×1024。
- 原件 SHA-256：`44fac538b94d6b84e12e8a762460c82d7eeb1b5687c35c23401edf91e96c13fe`；测前、测后相同。
- 每次仅将正文及引用的三张图片复制到一次性临时工作区，使用隔离的临时 userData，并断言实际 userData 正确。
- 使用开发 Electron 加载安装目录 ASAR，实测其版本为 1.1.96；另以当前 1.1.97 源码构建对照。不是启动用户正在运行的正式实例。
- 所有 GUI 操作在未切换的 Windows 后台桌面运行，无 taskkill、WMI 或进程树终止。

## 实测（单轮本机数据）

| 操作（第一张图） | 安装版 1.1.96 | 当前源码 1.1.97 |
| --- | ---: | ---: |
| Home、ArrowRight 两次缩放提交 | 3965 ms | 3678 ms |
| 靠右 | 1877 ms | 1896 ms |
| 确认裁剪 | 2568 ms | 2859 ms |

首次“居中”是无变化操作，因为原图已居中；31/25 ms 不能当作正常修改的性能。

## 热点一：HTML 图片源行锚点丢失，退回全文序列化

- 前两张图片已经以带缩放属性的 `<img ...>` 保存。读入后的宿主 paragraph 都是 `sline:null, eline:null`；第三张仍是普通 Markdown 图片，宿主具有准确的第 128 行锚点（0-based 127）。
- `markdownRawHtml.js` 对已有模型的 HTML 使用 `if (isModeled(content)) return content`，没有像可编辑 HTML 表格那样补齐源行属性。`SourceLineAnchors` 从段落节点采集不到对应源行。
- 首次实际缩放触发 `fallback:edited an unanchored block`，随后全文回退会清空锚点，后续操作变成 `fallback:no anchors`。不能通过猜测文档位置强行绕过保护，否则有覆盖正文的风险。
- 3 张图片的显示 Base64 使中间 Markdown 达到 4,612,304 字符。每次全文序列化约 1.5～2.2 秒，长任务约 1.7～2.7 秒。
- CPU 样本集中在序列化 `atBlank`、`normalizeInline` 及垃圾回收；被记录的图片修改没有调用全文 parser。不要把本次问题误称为“图片编辑重解析全文”。
- 新开文档直接操作第三张图的对照：保持 `splice:1`，局部序列化仅 4～5 ms，证明锚点丢失是主要放大器，不是标题数量或图片尺寸就能解释。

## 热点二：HTML 图片地址扫描仍有独立长任务

- 第三张图的局部保存仍有 339～353 ms 操作耗时、313～326 ms 长任务。
- CPU 定位到 `imagePathMapping.js` 的 `rewriteHtmlImageUrls` / `IMG_TAG`：当前 `<img>` 正则对含百万字符 Base64 的标签进行逐字符的重复分支匹配。前两张 HTML 图也会在第三张图编辑后进入这条扫描路径。
- 相同原文与三张真实图片在独立 Node 调用 `rewriteImageResourcePaths`：显示文本转回资源相对路径三次分别 202.8、204.8、202.2 ms，且每次还原结果与原文逐字相同。它不是磁盘 I/O 或 UI 重绘造成的耗时。
- 两个热点相叠加，解释了为何之前“纯 Markdown 图片压力测试”改善后，这份含已调整过样式的 HTML 图片的文档仍卡。

## 后续修复边界（本轮未实施）

1. 为支持的独立 HTML 图片恢复准确的源行锚点，并验证缩放/对齐、保存重开、非图片正文逐字保留；不能删掉未知锚点回退保护来掩盖问题。
2. 优化 HTML 图片标签扫描，避免按每个 Base64 字符走重复正则分支；保留带引号的 `>`、实体、残缺标签、真实路径及保存格式。
3. 用“已带 HTML 缩放/对齐属性的图片”补充基线，分别验证首次编辑、连续编辑、拖动预览和提交，而不只用新插入的纯 Markdown 图片。

## 工具与日志

诊断脚本 `scripts/image-edit-profile.mjs` 仅新增可选真实文档/应用入口/图片序号/操作过滤环境变量，仍使用临时副本；修正测试启动参数顺序及临时 userData 断言，输出 CPU 行列、文档模型锚点和长任务。未变更生产源码。

- `image-profile-aidb-installed-1.1.96.log`
- `image-profile-aidb-current-1.1.97.log`
- `image-profile-aidb-anchored-control.log`
- `image-profile-aidb-residual-hotspot.log`
- `node --check scripts/image-edit-profile.mjs` 通过。

根目录 `.log` 为本地诊断结果，Git 忽略；未运行发布验证套件，因为本轮没有产品修复或发布。
