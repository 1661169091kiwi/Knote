# Knote PDF 版面分析服务（PaddleOCR / PP-Structure）

Knote 桌面版内置了一个本地的 PDF 版面分析服务，让内置 AI 助手能**精准识别 PDF 每一页里的数据元**（标题 / 正文 / 公式 / 图 / 表），并把其中的图、表准确裁剪、插入到你的 Markdown 文档中。

分析完全在你本机运行，PDF 不会离开你的电脑。

## 架构

- `knote_pdf_service.py` —— 一个只用 Python 标准库的本地 HTTP 服务（`127.0.0.1`，每次启动带随机令牌）。Knote 主进程在**首次用到时**才把它拉起，退出时自动结束。
- 真正的版面分析用 **PaddleOCR / PP-Structure**（Apache-2.0，开源商用皆可）。它较重，所以按需安装；**Knote 的「一键下载并配置」会连同 PP-Structure 的模型一起预下载好**（否则模型会在首次分析时才下载、看起来像卡住）。
- 没装依赖时，助手会自动**降级**为"用视觉模型看整页 + `pdf_crop_region` 裁剪"。

## 安装（一次性）

1. 装好 **Python 3**（3.10 / 3.11 兼容性最好；PaddlePaddle 的 wheel 有时跟不上最新版 Python）。
2. 在本文件所在的 `sidecar` 目录执行：

   ```bash
   pip install -r requirements.txt
   ```

   > GPU 用户可改装对应的 `paddlepaddle-gpu`；显存不够就用默认的 CPU 版。

3. 回到 Knote → 助手设置（⚙）→「PDF 版面分析」→ 点**检测服务**，看到"服务就绪"即可。

## 使用

装好后，直接对助手说例如：

> 把这份 PDF 第 12 页那张表插到我的笔记里

助手会：`pdf_layout(第12页)` 拿到各元素的精确 bbox → `pdf_crop_region` 按 bbox 裁出那张表 → `insert_image` 以红绿 diff 暂存，等你确认。

## 状态自检

```bash
python knote_pdf_service.py --port 8756 --token test
# 另开一个终端：
curl http://127.0.0.1:8756/health          # {"paddle": true/false, ...}
```

`paddle: false` 说明依赖还没装好；`paddle: true` 即就绪。
