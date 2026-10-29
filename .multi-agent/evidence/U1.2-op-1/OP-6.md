# OP-6 · 进度条按章拖动（合入后画面复核）

- 坐标：U1.2；commit `09f165ab7fe5c4bfc6707088f1b8de2331097a31`（`git rev-parse HEAD` 启动前后一致）。
- 实例：窗口「小说浏览器」，CDP page `DED14A1084F377439F629BCA61CC6824`，视口 1280×771，DPR=1。
- 清单原文：按下底部进度条约一半后松开。应看到章标题变为目录中间章的标题。视口在该章第一段。
- 目录共 3 章：`第一章 样例起风`（ready）／`第二章 样例夜行`（ready）／`第三章 样例断章`（failed）。中间章 = 第二章。

## 操作（只有 CDP 原生鼠标事件）

1. `mouseMoved` 到进度条 (640,768)（保证 hover 把 4px 轨道抬到 6px，读数里 y=765..771）。
2. `mousePressed` left @ (640,768)，buttons=1 —— `.reader-progress-track` 的 ratio = 640/1280 = **0.500**。
3. `mouseMoved` buttons=1 依次 (678,768) → (717,768) → (640,768)，即按住推出再回到一半，证明这是拖动而不是原地按放。
4. **未松手**截图 `OP-6-drag.png`，读数 `OP-6-drag-state.json`。
5. `mouseReleased` left @ (640,768)。
6. 等章标题变化且浮标消失，再等 1.8s 稳定，截图 `OP-6-after.png`，读数 `OP-6-after-state.json`。

`elementFromPoint(640,768)` = `DIV.reader-progress-row`（轨道内的填充行），不是别的浮层。

## 操作前后读数

| 项 | 松手前（OP-6-before） | 未松手（OP-6-drag） | 松手后（OP-6-after） |
|---|---|---|---|
| 章标题 `.ch-title` | 第一章 样例起风 | 第一章 样例起风 | **第二章 样例夜行** |
| 轨道 rect | x0 y767 w1280 h4 | x0 y763 w1280 h8 | x0 y765 w1280 h6 |
| 轨道 class | reader-progress-track | reader-progress-track **scrubbing** | reader-progress-track |
| aria-valuenow / max | 0 / 2 | 0 / 2 | **1 / 2** |
| aria-valuetext | 全书约 1% · 本章 2% · 还剩 2 章 | **第 2 章 · 第二章 样例夜行** | 全书约 33% · 本章 0% · 还剩 1 章 |
| 浮标 `.reader-progress-scrub-hint` | 无 | **「第 2 章　第二章 样例夜行」**，rect x12 y728 w153 h27 | 无 |
| 拖动预览 `.scrub-preview` 宽度 | 无 | **50%** | 无 |
| 正文 scrollTop | 118 | 118（未松手不换章） | **0** |
| 正文 clientHeight | 723 | 723 | 723 |
| 正文 scrollHeight | 6640 | 6640 | 6640 |
| 首个可视段 `[data-p="0"]` 顶部 y | 59 | 59 | **177** |
| 首个可视段文字 | 「…第一章 样例起风开篇。」 | 同左 | **「…第二章 样例夜行开篇。」** |

屏内实际可见文字（`OP-6-after.png`，`document.body.innerText` 头几行）：`样例·夜行舟 / 书架 / 搜索 / 标记 / 朗读 / AI / 设置 / 浏览 / 样 / ‹ / 第二章 样例夜行 / 这是验收专用的样例正文，非真实小说。第二章 样例夜行开篇。`

## 判定材料（本文件不判达标）

- 章标题由第一章变成中间章第二章：见上表与 `OP-6-after.png`、`_crop-OP-6-after-title.png`。
- 视口在该章第一段：`scrollTop=0`、`scrollHeight=6640 > clientHeight=723`（该章可滚动，但仍停在顶），且 `[data-p="0"]` 顶部 y=177 位于正文区 y24..747 内，正文字面即第二章开篇句。
- 未松手时浮标已显示目标章名：`OP-6-drag.png`、`_crop-OP-6-drag-hint-x3.png`（浮标区域裁剪放大 3 倍）。

## 文件

`OP-6-before.png` / `OP-6-before-state.json` / `OP-6-before-ax-buttons.txt`、`OP-6-drag.png` / `OP-6-drag-state.json` / `OP-6-drag-ax-buttons.txt`、`OP-6-after.png` / `OP-6-after-state.json` / `OP-6-after-ax-buttons.txt`、`_crop-OP-6-drag-hint-x3.png`、`_crop-OP-6-after-title.png`。
