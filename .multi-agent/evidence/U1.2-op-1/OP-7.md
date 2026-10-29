# OP-7 · 进度条拖到失败章（合入后画面复核）

- 坐标：U1.2；commit `09f165ab7fe5c4bfc6707088f1b8de2331097a31`。
- 实例：窗口「小说浏览器」，CDP page `DED14A1084F377439F629BCA61CC6824`，视口 1280×771，DPR=1。
- 清单原文：把进度拖到一本含失败章的位置并松开。应看到该失败章的现有失败说明仍在，并有重试或去浏览页。
- 样例库这本书第 3 章 `c0003 第三章 样例断章` 预置为 `status=failed`、`failCode=Paywall`、`failMessage=本章需要付费或会员（样例构造）`；`book.json` 与 `chapters/0003.json` 两处一致。

## 操作（只有 CDP 原生鼠标事件）

起点是 OP-6 结束后停在第二章的开局。

1. `mouseMoved` 到 (640,768) 触发 hover（轨道 6px）。
2. `mousePressed` left @ (640,768) → ratio 0.500（第二章）。
3. `mouseMoved` buttons=1 依次 (678,768) → (717,768) → **(1024,768)** → ratio 0.800。
   3 章时 `chapterIndexFromBookRatio(0.8, 3) = floor(2.4) = 2`，即第三章（失败章）。
4. **未松手**截图 `OP-7-drag.png`，读数 `OP-7-drag-state.json`。
5. `mouseReleased` left @ (1024,768)。
6. 等章标题变化且浮标消失，再等 1.8s 稳定，截图 `OP-7-after.png`，读数 `OP-7-after-state.json`。

`elementFromPoint(640,768)` = `DIV.reader-progress-row`（轨道内填充行）。

## 操作前后读数

| 项 | 松手前（OP-7-before） | 未松手（OP-7-drag） | 松手后（OP-7-after） |
|---|---|---|---|
| 章标题 `.ch-title` | 第二章 样例夜行 | 第二章 样例夜行 | **第三章 样例断章** |
| 轨道 rect | x0 y765 w1280 h6 | x0 y763 w1280 h8 | x0 y765 w1280 h6 |
| 轨道 class | reader-progress-track | reader-progress-track **scrubbing** | reader-progress-track |
| aria-valuenow / max | 1 / 2 | 1 / 2 | **2 / 2** |
| aria-valuetext | 全书约 33% · 本章 0% · 还剩 1 章 | **第 3 章 · 第三章 样例断章** | 全书约 100% · 本章 100% · 还剩 0 章 |
| 浮标 | 无 | **「第 3 章　第三章 样例断章」**，rect x12 y728 w153 h27 | 无 |
| 拖动预览宽度 | 无 | **80%** | 无 |
| 失败说明 `.chapter-error` | 无 | 无 | **「本章需要付费或会员」** |
| 失败建议 `.chapter-hint` | 无 | 无 | **「本章要付费或会员，请到浏览页解锁后重试该章」** |
| 正文 scrollTop / clientHeight | 0 / 723 | 0 / 723 | 0 / 723 |
| 正文 scrollHeight | 6640 | 6640 | **723**（无正文，未渲染段落） |
| 段落数 `[data-p]` | 60 | 60 | **0** |

松手后屏内实际可见文字（`document.body.innerText` 全文，加上 `OP-7-after-ax-buttons.txt` 的无障碍按钮名）：

```
样例·夜行舟
书架
搜索
标记
朗读
AI
设置
浏览
样
‹
第三章 样例断章
本章需要付费或会员
本章要付费或会员，请到浏览页解锁后重试该章
重试失败章
去浏览页
›
目录
进度
背景
字体
```

无障碍树（`Accessibility.getFullAXTree`）里 role=button 且有名字的项含 **`重试失败章`** 与 **`去浏览页`**，与画面一致。

## 判定材料（本文件不判达标）

- 失败说明仍在：`.chapter-error` 文本「本章需要付费或会员」（`failCode=Paywall` 的既有文案，`FAIL_CODE_ZH.Paywall`）＋ `.chapter-hint` 建议句。
- 有重试或去浏览页：可见按钮「重试失败章」「去浏览页」同时存在，截图里位于失败说明下方居中。
- 拖动过程中未提前换章：`OP-7-drag` 的章标题仍是第二章，只更新浮标与 80% 预览。

## 文件

`OP-7-before.png` / `OP-7-before-state.json` / `OP-7-before-ax-buttons.txt`、`OP-7-drag.png` / `OP-7-drag-state.json` / `OP-7-drag-ax-buttons.txt`、`OP-7-after.png` / `OP-7-after-state.json` / `OP-7-after-ax-buttons.txt`、`_crop-OP-7-drag-hint-x3.png`、`_crop-OP-7-after-fail.png`。
