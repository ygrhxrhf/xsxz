# U1.4-op-1 实例记录（OP-9 / OP-10 / OP-11）

## 坐标与版本

- 坐标 **U1.4**；阶段：**合入后画面复核**。
- 指定默认分支 commit **`33e1401ea52103871e8974a13aaf579227c80f5e`**（`feat(U1.4): 渲染层整段尾巴净化`）。
- 启动前后 `git rev-parse HEAD` 均为 `33e1401ea52103871e8974a13aaf579227c80f5e`；`git status --porcelain -- src docs package.json` 为空，产品文件无改动（工作区脏的只有 `.multi-agent/` 账本与本证据目录）。
- 本目录所有截图、state json、`_summary.json` 都出自本轮这一刀构建启动的**唯一一个**实例。

## 构建

`cd /home/goot/cod/xs/xsxz && npm run build`，退出码 **0**（日志见 `_build.log`）。
产物：`out/main/index.js`（581.78 kB）、`out/preload/index.mjs`（13.73 kB）、`out/renderer/assets/index-XRAFzTOw.css`（90.10 kB）、`out/renderer/assets/index-DNPXr5z6.js`（3,944.66 kB）。
产物内容校验：`out/renderer/assets/index-DNPXr5z6.js` 内含本 commit 才有的字符串 `净化（整段站点尾巴不显示）`、`本章显示原文` 与规则词 `请收藏`，即本刀渲染层净化代码确实在跑。

## 启动命令（本刀唯一实例）

```
cd /home/goot/cod/xs/xsxz && setsid nohup ./node_modules/electron/dist/electron /home/goot/cod/xs/xsxz \
  --no-sandbox --user-data-dir=/tmp/U1.4-op-1/userData --remote-debugging-port=37495 \
  > /tmp/U1.4-op-1/electron.log 2>&1 < /dev/null & disown
```

- 主进程 PID **212998**（`_NET_WM_PID` = 212998）；子进程 gpu / network / renderer 均带同一 `--user-data-dir=/tmp/U1.4-op-1/userData`。
- 起始前 `pgrep -af electron` 无相关实例，pid 树里只有这一棵；**没有碰任何旧窗口**。
- 结束时用 `kill -TERM 212998` 正常关闭；关闭后 `curl http://127.0.0.1:37495/json/version` 不通、`pgrep -af electron/dist/electron` 无残留。

## 窗口与 CDP

- 窗口：X11 `0x4400004`，`WM_NAME(UTF8_STRING)="小说浏览器"`，`WM_CLASS="spbf","spbf"`，绝对位置 (640,320)，外框 **1280×800**，`Map State: IsViewable`。父框 `0x600067 ("mutter-x11-frames")` 1308×866+626+271。
- 内容视口：**1280×771**，DPR=1（实测 `innerWidth/innerHeight/devicePixelRatio`）。
- CDP：`http://127.0.0.1:37495`，`Chrome/150.0.7871.224`，Electron 43.4.0。目标 page `id=B029D7A04AC7D6DF40BC87DC0930D674`，标题「小说浏览器」，地址 `file:///home/goot/cod/xs/xsxz/out/renderer/index.html`。另有 `about:blank` target（`E367B710A0C26622AC16DB518B5FF888`）未操作。
- 画面佐证：`_window-x11.png`（`DISPLAY=:1 ffmpeg -f x11grab -video_size 1280x800 -i :1+640,320 -frames:v 1`）与 `_window-cdp.png`（同刻 CDP 截图）。裁掉 29px 标题栏后逐像素差异 **0 px（0.0000%）**，`ImageChops.difference().getbbox()` 为 `None` —— **CDP 截图就是这块真实窗口的画面**。

## 样例库（自建，标「样例」，只写 /tmp）

- 路径 `/tmp/U1.4-op-1/library`；独立 userData `/tmp/U1.4-op-1/userData`，`settings.json` 的 `libraryPath` 指向该样例库。与真实书库完全隔离。
- 书 `sample_u14`：书名 **`样例·整段净化`**，作者「样例作者」，标签 `["样例"]`，`importType=download`，共 **2 章**，两章 `status=ready`。
- 生成脚本 `_gen-library.mjs`（只写 /tmp，不属于产品代码）。

| 章 | 标题 | 段落数 | 关键构造 |
|---|---|---|---|
| c0001 | 第一章 样例尾巴章 | 9（下标 0–8） | p=1 **(a) 纯站点尾巴整段**：`请收藏本站，下次不迷路。本站域名 www.example.com 请记住。`；p=2 **(b) 叙述句**：`请收藏这封信。信上只写了三行字，字迹很轻，末尾没有署名。`（不含本站/网址/地址/域名）；其余 p=0、3–8 为**正常正文段** |
| c0002 | 第二章 样例换章 | 7（下标 0–6） | p=1 **同类 (a) 整段**：`请收藏本站：本章已完，下一章更精彩。本站域名 www.example.com 请记住。`；其余为正常正文段 |

- 正文均为样例占位文字（每段首句写明「验收占位，不含真实作品内容」），不含任何真实作品内容。
- 预置阅读进度 `book.json.progress = { chapterId:"c0001", scrollRatio:0 }`，启动后自动进第一章、`scrollTop=0`，尾巴整段在首屏第二段位置——便于同屏一次证完 (a)(b) 与正常段。

## 操作方式（只发原生鼠标）

- 只对这一个 CDP page target 发 `Input.dispatchMouseEvent`：`mouseMoved`（预热 hover）→ `mousePressed`（left, buttons=1, clickCount=1）→ `mouseReleased`（left, buttons=0, clickCount=1）；面板内滚动用 `mouseWheel`。
- 落点全部取自目标元素**真实** `getBoundingClientRect()` 中心，并先用 `document.elementFromPoint` 确认命中（开关命中 `DIV.n-switch__rail`，翻章热区命中 `BUTTON.chapter-hotzone right`）。
- **未调用任何 Vue 组件方法**，未读改 `showRawThisChapter` / `hideSiteTail` 等组件状态，未写 DOM、未改 class/style，未直接改 `scrollTop`，未 reload，未用键盘。
- 读数用只读表达式：`getBoundingClientRect` / `getComputedStyle` / `elementFromPoint` / `innerText` / `Accessibility.getFullAXTree`，见 `_cdp-lib.mjs` 的 `READ_U14`、`READ_SWITCHES`。
- 截图用 `Page.captureScreenshot`（`captureBeyondViewport:false`），1280×771 完整视口，不裁剪不拼接；裁片只用于放大对照，原图保留。

## 采集遍次

- 第 1 遍（12:15 左右）在点「本章显示原文」时落点落到正文 `<p>`（`hitBefore="P.para|…"`），开关实际没被点上（`raw` 仍 false）。该遍作废，只保留为脚本调试，未作为证据。
- 定稿遍次：**12:23:37 – 12:23:59**，重启实例、重置样例库后一次跑完 OP-9 → OP-10 → OP-11（`_summary.json`、`_trace.json` 与全部 `OP-*.png` / `OP-*-state.json` 均出自该遍）。修复点：开关先在面板内用真实滚轮滚到 `elementFromPoint` 真正命中开关本体，再点。
- 12:24 – 12:27 补做两件只读侧证（不覆盖定稿截图）：换章后开「字体」面板读两个开关状态（`_op11-next-switch-state.json`、`_op11-next-switch-panel.png`）；真实鼠标「继续读」回阅读页 + 点左侧热区回第一章抓 AX 文本（`_ax-chapter1.txt`、`_ax-chapter1-state.json`、`_ax-chapter1.png`）。

## 文件 hash 对比（是否写盘）

时点：`t0 启动` → `点击「本章显示原文」前` → `点击后` → `换章后` → `全部操作结束` → `关闭实例后`。分文件见 `_hash-<tag>.json`、`_hashes.json`。

| 文件 | t0 | 点前 | 点后 | 换章后 | 关闭后 |
|---|---|---|---|---|---|
| `userData/settings.json` | be8fbde8fe6d | 同 | 同 | 同 | 同 |
| `library/index.json` | d08dcc21f842 | 同 | 同 | 同 | d99b8369a794 |
| `sample_u14/book.json` | 25e98b7a2ed2 | 同 | 同 | 1c25c11ddc0b | a13fe76d88d9 |
| `sample_u14/chapters/0001.json` | dabb60cf4c78 | 同 | 同 | 同 | 同 |
| `sample_u14/chapters/0002.json` | 23b870ec150f | 同 | 同 | 同 | 同 |
| `sample_u14/reading-frontier.json` | fc69c527ef4d | 同 | 同 | 9be29f76b782 | 5118d3d5d60e |

（表中为 sha256 前 12 位；完整值见各 `_hash-*.json`。）

- **点「本章显示原文」前后六个文件 hash 与 mtime 全部逐字节相同** → 该开关没有写盘。
- `settings.json` 全程未变，且文件内不含 `showRawThisChapter` / `hideSiteTail` / `show_raw` 任何字段。
- **两个章节正文文件全程未变**：`0001.json` 仍是 `dabb60cf4c78…`、`0002.json` 仍是 `23b870ec150f…`，磁盘正文里 `请收藏本站` 与「请收藏这封信」都原样保留 → 净化只发生渲染层，没改章节数据。
- 变化只出现在阅读进度：`book.json.progress` 由 `{chapterId:"c0001",scrollRatio:0}` 变 `{chapterId:"c0001",scrollRatio:1,updatedAt:"2026-10-29T04:27:45.909Z"}`；`reading-frontier.json` 只在 `chapters` 里写 `c0001`/`c0002` 的 `paragraphIndex`/`characterOffset`/`bodyHash`。`library/index.json` 在关闭实例时由主进程回写书卡进度（`status` 由 `partial` 变 `ready`、`progress.chapterId` 变 `c0002`），同样是进度字段，与本次点击无因果（点前后同 hash）。

## 文件清单

- 记录：`note.md`、`OP-9.md`、`OP-10.md`、`OP-11.md`。
- 截图：`OP-9.png`、`OP-10.png`、`OP-11-raw.png`、`OP-11-next-chapter.png`；辅助 `_t00-boot.png`、`_op11-next-switch-panel.png`、`_ax-chapter1.png`、`_probe2.png`、`_window-x11.png`、`_window-cdp.png`。
- 放大裁片：`_crop-OP-9-zoom.png`、`_crop-OP-9-target.png`、`_crop-OP-10-keep.png`、`_crop-OP-11-raw-zoom.png`、`_crop-OP-11-raw-target.png`、`_crop-OP-11-next-zoom.png`、`_crop-OP-9-vs-OP-11raw.png`、`_crop-switch-panel-zoom.png`、`_crop-*-top2.png`。
- 读数：`OP-9-state.json`、`OP-10-state.json`、`OP-11-raw-state.json`、`OP-11-next-chapter-state.json`、`_t00-boot-state.json`、`_op11-next-switch-state.json`、`_ax-chapter1-state.json`、`_summary.json`、`_trace.json`、`_ink-bands.json`。
- 无障碍：`_ax.txt`（第二章）、`_ax-chapter1.txt`（第一章）。
- hash：`_hash-t0-boot.json`、`_hash-before-switch.json`、`_hash-after-switch.json`、`_hash-after-chapter-change.json`、`_hash-final.json`、`_hash-end-after-all-ops.json`、`_hash-after-close.json`、`_hashes.json`。
- 复现脚本（只读 CDP，不改产品）：`_cdp-lib.mjs`、`_run.mjs`、`_verify-switch-next.mjs`、`_reopen-book.mjs`、`_back-to-ch1-ax.mjs`、`_ax.mjs`、`_grab-window.mjs`、`_probe.mjs`、`_probe2.mjs`、`_final-hash.mjs`、`_gen-library.mjs`。
- 日志：`_build.log`、`_electron.log`（`DevTools listening on ws://127.0.0.1:37495/devtools/browser/5c790da9-d1c9-4296-b0a1-baf9c1bfd1ac`，无其他 stderr）。

## 复现入口

```
cd /home/goot/cod/xs/xsxz && npm run build
node .multi-agent/evidence/U1.4-op-1/_gen-library.mjs
setsid nohup ./node_modules/electron/dist/electron /home/goot/cod/xs/xsxz --no-sandbox \
  --user-data-dir=/tmp/U1.4-op-1/userData --remote-debugging-port=37495 \
  > /tmp/U1.4-op-1/electron.log 2>&1 < /dev/null & disown
cd .multi-agent/evidence/U1.4-op-1
node _run.mjs "$(curl -s http://127.0.0.1:37495/json/list | python3 -c 'import json,sys;print([t["webSocketDebuggerUrl"] for t in json.load(sys.stdin) if t["title"]=="小说浏览器"][0])')"
```
