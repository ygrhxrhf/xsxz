# U1.2-op-1 实例记录（OP-6 / OP-7）

## 坐标与版本

- 坐标 U1.2；阶段：合入后画面复核。指定默认分支 commit **`09f165ab7fe5c4bfc6707088f1b8de2331097a31`**（`feat(U1.2): 进度按章拖动并落在章首`）。
- 启动前 `git rev-parse HEAD` = 09f165ab7fe5c4bfc6707088f1b8de2331097a31；工作区改动只有 `.multi-agent/` 下的账本与证据，产品文件无改动（`git status --porcelain` 仅 `.multi-agent/*` 与未跟踪的 `evidence/`）。
- 上一轮中断只留下 `_build.log` 与 `_probe.txt`（内容为 `test`，属中断残留，不是本轮证据）。本轮沿用该目录，补全了全部截图、state json 与记录；`_build.log` 已追加本轮构建输出。

## 构建

`cd /home/goot/cod/xs/xsxz && npm run build`，退出码 **0**（日志见 `_build.log` 末尾）。
产物：`out/main/index.js`（581.78 kB）、`out/preload/index.mjs`（13.73 kB）、`out/renderer/assets/index-Bxh6AM7w.css`、`out/renderer/assets/index-DDqx1TmH.js`（3,936.61 kB），10:07 生成本轮构建。
产物内容校验：`out/renderer/assets/index-DDqx1TmH.js` 内含 `progressScrubTarget` / `progressScrubLabel`，即本 commit 的新进度条代码。

## 启动命令（本刀唯一实例）

```
/home/goot/cod/xs/xsxz/node_modules/electron/dist/electron /home/goot/cod/xs/xsxz \
  --no-sandbox \
  --user-data-dir=/tmp/U1.2-op-1/userData \
  --remote-debugging-port=37493
```

- 主进程 PID **34857**（父 shell 34855；`_NET_WM_PID` = 34857）。
- 子进程：zygote 34860 / 34861、gpu 34888、network 34893、renderer 34914 / 34919。
- 开工前 `ps aux | grep electron` 为空，本机没有其他 spbf 实例；pid 树里只有这一棵，操作对象即本刀构建的实例，没有碰任何旧窗口。

## 窗口与 CDP

- 窗口：桌面窗口 id `0x4400004`，`WM_NAME(UTF8_STRING)="小说浏览器"`，`WM_CLASS="spbf","spbf"`，绝对位置 (640,320)，外框 1280×800，`Map State: IsViewable`。
- 内容视口：**1280×771**，DPR=1（`innerWidth/innerHeight/devicePixelRatio` 实测）。标题栏 29px（X11 抓屏比对得出）。
- CDP：`http://127.0.0.1:37493`，`Browser: Chrome/150.0.7871.224`；browser `ws://127.0.0.1:37493/devtools/browser/7a37cdd3-40e8-4df3-99be-06bf86df009c`；目标 page `DED14A1084F377439F629BCA61CC6824`，标题「小说浏览器」，地址 `file:///home/goot/cod/xs/xsxz/out/renderer/index.html`。另有 `about:blank` target（`4E0120254DF2F6DEB0355AE3AEF84F01`）未操作。
- 画面佐证：`_window-x11.png`（DISPLAY=:1，`ffmpeg -f x11grab -video_size 1280x800 -i :1+640,320`）。裁掉 29px 标题栏后与 `OP-7-after.png` 逐像素差异 **0.000%**（`_window-vs-cdp.json`），证明 CDP 截图就是这块真实窗口的画面。

## 样例库（自建，标「样例」）

- 路径 `/tmp/U1.2-op-1/library`，`settings.json` 在独立 userData `/tmp/U1.2-op-1/userData`，`libraryPath` 指向该样例库。与真实书库完全隔离。
- 书 `sample_u12`：书名 **`样例·夜行舟`**，作者「样例作者」，标签 `["样例"]`，`importType=download`，`status=partial`，共 **3 章**：

| 章 | 标题 | status | failCode |
|---|---|---|---|
| c0001 | 第一章 样例起风 | ready | — |
| c0002 | 第二章 样例夜行 | ready | — |
| c0003 | **第三章 样例断章** | **failed** | **Paywall** |

- 正文为生成的 60 段占位纯文本，每段首行即写明「这是验收专用的样例正文，非真实小说」，正文文件 12,818 字节/章。
- **失败章构造方式**：`chapters/0003.json` 写 `status:"failed"`、`failCode:"Paywall"`、`failMessage:"本章需要付费或会员（样例构造）"`、`body:""`；`book.json` 的 `chapters[2]` 同步写同一 `status` / `failCode` / `failMessage`（磁盘 schema 要求两处一致）。未改产品代码、未改渲染分支。
- 预置阅读进度：`book.json.progress = { chapterId:"c0001", scrollRatio:0.02 }`，`reading-frontier.json` 为 v1 `legacyConfirmed:true`、空 chapters。启动后自动进阅读页第一章，实测 `scrollTop=118`。

## 操作方式（只发原生鼠标事件）

- 只对该 CDP page target 发 `Input.dispatchMouseEvent`：`mouseMoved`（button=none 预热 hover）→ `mousePressed`（left, buttons=1, clickCount=1）→ 多次 `mouseMoved`（buttons=1）→ `mouseReleased`（left, buttons=0）。
- 落点取自 `.reader-progress-track` 的**真实** `getBoundingClientRect()`：轨道 x0..1280、底边 y=771，取 `y = bottom - h/2 = 768`，`x = width × ratio`；`elementFromPoint` 确认命中 `DIV.reader-progress-row`。
- **未调用任何 Vue 组件内部方法**，未读改 `scrubRatio` / `scrubTarget` 等组件状态，未写 DOM、未改 class 或 style，未改 `scrollTop`，未 reload，未发滚轮与键盘。
- 读数（`_cdp-lib.mjs` 的只读表达式 + 本轮扩展）取 `getComputedStyle` / `getBoundingClientRect` / `document.body.innerText` / `[data-p]` 可视段落，并 `Accessibility.getFullAXTree` 抽按钮名。截图用 `Page.captureScreenshot`，1280×771 完整视口，不裁剪不拼接。
- 每次拖动的三段几何（press / 移动中间点 / release 的像素坐标与对应 ratio）写在对应 `-state.json` 的 `pointer` 字段里。

## 采集遍次

本轮对同一实例跑了两遍完整 OP-6 → OP-7。第一遍（10:20）OP-6 从 0.45 按下拖到 0.50，属「约一半」但起点不在中点；为严格对齐清单原句，定稿遍次改成**在中点按下、按住推出再回到中点释放**，然后重启实例、重置 `book.json.progress` 与 `reader-frontier.json`，从第一章重跑第二遍。

目录里的 `OP-6-*.png` / `OP-7-*.png` / `*-state.json` / `*-ax-buttons.txt` / `_run-summary.json` / `_run.log` **全部出自 10:24–10:25 定稿遍次**。`_boot.png` / `_boot-state.json` 是定稿遍次启动后的首帧读数。第一遍的读数未落盘为证据文件，只在本 note 中说明遍次差异，未覆盖任何定稿证据。

## 文件清单

- `_build.log`（构建，含上一轮与本轮两次输出）、`_probe.txt`（上一轮中断残留）、`_cdp-lib.mjs`、`_run-OP-6-7.mjs`（复现脚本）、`_run.log`（定稿遍次控制台输出）、`_run-summary.json`（两单全部前后读数汇总）。
- `_boot.png` / `_boot-state.json` / `_boot-ax-buttons.txt`。
- OP-6：`OP-6-before.*`、`OP-6-drag.*`（未松手）、`OP-6-after.*`、`_crop-OP-6-drag-hint-x3.png`、`_crop-OP-6-after-title.png`、`OP-6.md`。
- OP-7：`OP-7-before.*`、`OP-7-drag.*`（未松手）、`OP-7-after.*`、`_crop-OP-7-drag-hint-x3.png`、`_crop-OP-7-after-fail.png`、`OP-7.md`。
- `_window-x11.png`、`_window-vs-cdp.json`（窗口画面与 CDP 截图一致性）。

## 复现入口

```
cd /home/goot/cod/xs/xsxz && npm run build
/home/goot/cod/xs/xsxz/node_modules/electron/dist/electron /home/goot/cod/xs/xsxz \
  --no-sandbox --user-data-dir=/tmp/U1.2-op-1/userData --remote-debugging-port=37493 &
cd .multi-agent/evidence/U1.2-op-1
CDP_PAGE=ws://127.0.0.1:37493/devtools/page/<pageId> node _run-OP-6-7.mjs
```

复跑前需把 `book.json.progress` 重置回 `c0001 / 0.02`，否则实例会从上次停的章开局。

## 边界

- 未改产品代码、未写账本、未提交、未 push、未判定达标、未委派。
- 只操作了本刀构建并启动的实例；未操作任何其他窗口。

## 实例当前状态

采集结束后**未终止**该实例：主进程 34857、窗口 `0x4400004`、CDP `http://127.0.0.1:37493` 仍然存活，画面停在 OP-7 结束态（第三章 样例断章 / 失败说明 / 重试失败章 / 去浏览页），便于后续复核同一画面。需要关闭时 `kill -TERM 34857`。
