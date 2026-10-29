# OP-1R 操作记录

清单原文：OP-1R：启动后自动进入上次那本书。点正文中间三分之一让顶栏和右侧胶囊出现。点左侧书脊回书库。在书库点同一本书书卡重新进入阅读页。应看到正文和左侧书脊可见，顶栏与右侧「目录」「进度」「背景」「字体」都不可见。

## 操作（定稿遍次，2026-10-26 17:53）

1. 启动指定实例（PID 3556873，CDP 37482，独立 userData），未发送任何输入前即自动进入「样例·长夜行舟」第二章：`app-shell app-shell-reader`，scrollTop=1010（clientHeight 723 / scrollHeight 14155），可视段落 6 段，首段「第7段：夜色沿着河岸缓缓展开……」。此时顶栏已为 `reader-toolbar reader-tools-hidden`（hidden / opacity 0 / 高度 0 / aria-hidden=true），胶囊 `reader-bottombar reader-tools-hidden`（hidden / opacity 0 / aria-hidden=true），四个按钮 hidden；书脊 `.reader-spine` visible、矩形 (0,0,52×771)。
2. 步骤一，点正文横向中间三分之一：纸面 `.reader-pane` 矩形 (324,24,684×723)，中三分之一 x=552..780，实点 **(666,386)**。CDP `Input.dispatchMouseEvent` 序列 mouseMoved(button=none) → mousePressed(left, buttons=1, clickCount=1) → mouseReleased。等 900ms 采集 **OP-1R-before**（截图 + state + ax）。
3. 步骤二，点左侧书脊：书脊矩形 (0,0,52×771)，实点 **(26,386)**。等 1100ms 采集 **OP-1R-library**。
4. 步骤三，在书库点同一本书书卡：书卡 `.book-open-area`（aria-label「打开《样例·长夜行舟》」）矩形 (71,552,104×325)，实点 **(123,715)**。点击后按 0 / 300 / 800 / 1500 / 2500 / 4000 ms 逐点采样（结果见 OP-1R-timeline.json），4000ms 后采集 **OP-1R-after**。

全程只用 CDP 原生鼠标事件点坐标；未调用 Vue 组件内部方法，未写 scrollTop，未改 DOM 类名或样式，未做 Page.reload，未发滚轮或键盘。三次点击坐标同样记录在 OP-1R-timeline.json 的 `clicks`。

## 实际文字

- 重入后（OP-1R-after）`body.innerText` 开头：「样 / ‹ / 第二章 样例长夜 / 第1段：夜色沿着河岸缓缓展开，船上的灯光照亮纸页。这是验收专用的样例正文……」；可视段落 6 段，首段为「第7段：夜色沿着河岸缓缓展开……」。
- 点书卡前（OP-1R-before）`body.innerText` 开头：「样例·长夜行舟 / 书架 / 搜索 / 标记 / 朗读 / AI / 设置 / 浏览 / 样 / ‹ / 第二章 样例长夜 ……」。
- 书库（OP-1R-library）innerText 含「书架」「最近在读」「样例·长夜行舟」「样例作者」「读到第 2 章 / 共 3 章」；书卡 aria-label 为「打开《样例·长夜行舟》」。
- 无障碍树 button 名计数：before 中「书架、搜索、标记、朗读、AI、设置、浏览、目录、进度、背景、字体」各 1 个（具名 button 共 117）；after 中这 11 个名字出现次数**全部为 0**（具名 button 共 104，余「返回书库」「上一章」「下一章」「下一章：第三章 样例归途」「从第 N 段开始朗读」等）。

## 读数

| 元素 | OP-1R-before（点书卡前，工具已展开） | OP-1R-after（重入后） |
|---|---|---|
| `.reader-toolbar` class | `reader-toolbar` | `reader-toolbar reader-tools-hidden` |
| 顶栏 visibility / opacity / 高度 | visible / 1 / 56px（0,0,1280×56） | hidden / 0 / 0px（0,0,1280×0） |
| 顶栏 aria-hidden / inert | false / false | true / true |
| `.reader-bottombar` class | `reader-bottombar` | `reader-bottombar reader-tools-hidden` |
| 胶囊 visibility / opacity / aria-hidden | visible / 1 / false | hidden / 0 / true |
| 目录 | visible / opacity 1 / (1199,296,52×42) | hidden / opacity 1 / (1199,304,52×42) |
| 进度 | visible / 1 / (1199,342,52×42) | hidden / 1 / (1199,350,52×42) |
| 背景 | visible / 1 / (1199,388,52×42) | hidden / 1 / (1199,396,52×42) |
| 字体 | visible / 1 / (1199,434,52×42) | hidden / 1 / (1199,442,52×42) |
| `.reader-spine` | visible / 1 / (0,0,52×771) | visible / 1 / (0,0,52×771) |
| 可视段落 / scrollTop | 6 段 / 1010 | 6 段 / 1010（clientHeight 723 / scrollHeight 14155） |

重入后 computed 补充：顶栏 computed `transition-property: opacity, transform, visibility`、`transition-duration: 0.25s, 0.25s, 0.25s`、`animation-name: none`、`pointer-events: none`。

## 重入后的时间序列（OP-1R-timeline.json，同一次点击后连续采样）

| 采样点 | 顶栏 class | visibility / opacity / 高度 / aria-hidden | 四按钮 visibility |
|---|---|---|---|
| 点击瞬间（+0ms） | 含 reader-tools-hidden | visible / 1 / 0 / true | visible |
| +300ms | 含 reader-tools-hidden | visible / 1 / 0 / true | visible |
| +800ms | 含 reader-tools-hidden | visible / 1 / 0 / true | visible |
| +1500ms | 含 reader-tools-hidden | visible / 1 / 0 / true | visible |
| +2500ms | 含 reader-tools-hidden | hidden / 0 / 0 / true | hidden |
| +4000ms | 含 reader-tools-hidden | hidden / 0 / 0 / true | hidden |

即：class、高度、aria-hidden、inert 从点击即刻就是收起态；computed `visibility`（离散属性，受 0.25s 过渡与主线程调度影响）在本次采样中到 +2500ms 才读到 hidden。之后每 1000ms 采样 12 次（17:52:25–17:52:36）全部 hidden / opacity 0 / 高度 0 / aria-hidden=true、四按钮 hidden，未回弹。

## 像素交叉核对（PIL，全部 1280×771）

- 顶栏区 y=0..56：before（工具展开，均值 251.4/251.4/251.5）与 after（均值 231.0/226.0/215.1）差异像素 98.2%；after 该区均值等于纸面外底色 (233,227,215) 附近，与正文纸面 (247,243,232) 不同，说明顶栏条不在画面上。
- 右侧胶囊区 (1194,287)-(1256,485)：before↔after 差异像素 95.3%；after 该区采样色 (233,227,215)，与 before 的胶囊底/描边不同。
- 正文区 (324,100)-(1008,700)：before↔after 差异像素 0.4%，正文未被顶栏或胶囊遮挡性改变。
- 书脊列 x=26 采样色 before/after 均为 (252,252,250)；正文 x=400,y=120 均为 (247,243,232)，书脊与正文两次一致。
- 同一遍 clicks 之前的逐帧探针截图（+0/+300/+800/+1500/+2500/+4000ms，已删除，读数留在 OP-1R-timeline.json 与 _probe-throttle.json）中，顶栏区六帧均值全部为 231.0/226.0/215.1、与工具展开态差异均 98.2%，即画面从点击那一刻起就不再显示顶栏条，即使 computed `visibility` 仍读到 visible。

## 前几遍的读数差异（只登记，未覆盖证据文件）

本轮把 OP-1R 三步路径跑了五遍。class / 高度 / aria-hidden / 四按钮 visibility 的结论每遍一致；差别只在 computed `visibility`/`opacity` 的采样时机：在点击书卡后 1200–1800ms 采样时读到 `visibility: visible`、opacity 1（3 遍），在 2000ms 及之后采样读到 hidden、opacity 0（2 遍）。该差异与启动前 4 条独立样本一致，均出现在过渡窗口内；画面像素不受影响（见上节）。目录中的截图、state json、ax 全部出自 17:53 定稿遍次。

## 证据清单

截图（`Page.captureScreenshot`，1280×771 完整视口，不裁剪不拼接）：OP-1R-before.png、OP-1R-library.png、OP-1R-after.png。
状态读数：OP-1R-before-state.json、OP-1R-library-state.json、OP-1R-after-state.json（含 size、scroll、toolbar/bottombar/spine/buttons 的 visibility·opacity·rect·aria-hidden·inert、bodyText、visibleParagraphs、libraryCards）。
无障碍树：OP-1R-before-ax.json、OP-1R-library-ax.json、OP-1R-after-ax.json（`Accessibility.getFullAXTree` 全量）及对应 *-ax-excerpt.txt（具名 button 前 40 个）。
时间线与复现脚本：OP-1R-timeline.json、_run-OP-1R.mjs、_cdp-lib.mjs、_probe-throttle.json。

bodyText 含滚动容器内未进入视口的段落，「可视段落」以 `[data-p]` 与视口相交判定；截图才是实际纸面范围。
