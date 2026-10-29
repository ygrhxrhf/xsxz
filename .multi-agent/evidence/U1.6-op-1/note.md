# U1.6-op-1：U1.6 合入后画面复核（OP-13 / OP-14）

## 这一刀

- 默认分支 commit：`2e7db64dbae0b317fd8b1e6d47e5b072f348e0c1`（`feat(U1.6): 净化与工具常显两个偏好字段`）
- 构建：仓库内 `npx electron-vite build`，EXIT=0（`_build.log`）。产物：
  - `out/main/index.js` 582.08 kB（14:06）
  - `out/preload/index.mjs` 13.73 kB
  - `out/renderer/assets/index-C3Y2RQCO.js` 3,949.45 kB、`index-CN7jSOKF.css` 90.10 kB
  - 产物内含 `hideSiteTail` / `hideReaderChrome`（渲染层 6 处命中）
- 未改任何产品文件、未提交、未 push。

## 启动命令与实例

```
cd /home/goot/cod/xs/xsxz && setsid nohup ./node_modules/electron/dist/electron /home/goot/cod/xs/xsxz \
  --no-sandbox --user-data-dir=/tmp/U1.6-op-1/userData --remote-debugging-port=37496 \
  > /tmp/U1.6-op-1/electron.log 2>&1 < /dev/null & disown
```

- 首次启动主进程 PID **390863**（父 390870）；OP-14 关闭进程后重新启动，新主进程 PID **395062**（父 395061）。
- 窗口：`_NET_WM_NAME="小说浏览器"`、`WM_CLASS(STRING)="spbf","spbf"`、窗口 id `0x1c00004`、`_NET_WM_PID=395062`、1280×800（外框 `mutter-x11-frames` 1308×866）。
- 渲染：viewport **1280×771**，dpr 1。
- CDP：`http://127.0.0.1:37496/json/list` → page target title `小说浏览器`，url `file:///home/goot/cod/xs/xsxz/out/renderer/index.html`（另有 `about:blank` 隐藏页）。操作脚本用原生 `Input.dispatchMouseEvent`（mousePressed/mouseReleased/mouseWheel），每步先核 `document.elementFromPoint` 是否命中目标。
- 启动日志：`DevTools listening on ws://127.0.0.1:37496/devtools/browser/...`，无其它报错。
- 用完已关闭：`pkill -TERM -f "electron --no-sandbox --user-data-dir=/tmp/U1.6-op-1/userData"`，之后 `pgrep -af dist/electron` 无残留、`/json/list` 无响应。

## 样例构造（只在 /tmp，脚本 `_gen-library.mjs`）

- 书库：`/tmp/U1.6-op-1/library`，书 id `sample_tail`，书名 **`样例·站尾样书`**，作者 `样例作者`，tags `["样例"]`，2 章，均为 `ready`。
- 第 1 章 `chapters/0001.json` 正文四段（`\n\n` 分隔）：
  1. `样例正文第一段：雨停之后，街灯把水面照成一条条亮线，他沿着巷口慢慢往家走。`
  2. `样例正文第二段：这一段是正常叙述，用来对照站点尾巴是否被整段藏掉。`
  3. **`请收藏本站，下次不迷路。本站域名 www.example.com 请记住。`**（整段站点尾巴，命中渲染层 R1：整段含「请收藏」+「本站」）
  4. `样例正文第三段：这是尾巴之后的正常段落，净化打开时它仍然应当显示。`
- 第 2 章只有两段正常样例正文。
- userData：`/tmp/U1.6-op-1/userData`，初值仅 `{"libraryPath":"/tmp/U1.6-op-1/library"}`（`settings-before.json`），reader 段由应用自己写。

## settings.json 前后对照（`/tmp/U1.6-op-1/userData/settings.json`）

| 时点 | `reader.hideSiteTail` | `reader.hideReaderChrome` | 证据文件 |
|---|---|---|---|
| 启动前 | 字段不存在（缺省按 true） | 字段不存在（缺省按 true） | `settings-before.json` |
| 关掉「净化」后 | **false** | true | `settings-after-op13-purge-off.json` |
| 打开「工具一直显示」后 | false | **false** | `settings-after-op14-always-on.json` |
| 重启后（同一 userData） | false | **false** | `settings-after-restart.json` |

## 证据清单

| 文件 | 内容 |
|---|---|
| `OP-13.md` `OP-13-state.json` | 净化关闭 + 离页 + 重开书的逐步读数 |
| `OP-14.md` `OP-14-step1-state.json` `OP-14-step2-state.json` `OP-14-step3-state.json` | 工具一直显示 + 真重启 + 再开书读数 |
| `OP-13-off.png` `OP-13-reopen.png` `OP-14-on.png` `OP-14-restart.png` | 清单要求的四张画面（1280×771） |
| `_ax-panel.json` `_ax-panel.txt` | 字体面板 5 个开关的 DOM 顺序 / aria-checked / AX checked 对齐摘录 |
| `_confirm-state.json` `_t10-state.json` `_para-geom.json` | 重开后段落 rect 与视口可见性 |
| `_t*.png` | 过程截图（唤出工具层、字体面板、书库、重启首屏、无工具层站尾等） |

## 脚本（本目录，不进产品）

`_ws.mjs`（取 CDP ws）、`_cdp-lib.mjs`（原生鼠标/滚轮/截图/AX）、`_lib-click.mjs`、`_readers.mjs`（统一读数：顶栏 visibility/高度、开关 aria-checked、正文段落 rect、api 与磁盘 settings）、`_gen-library.mjs`、`_op13.mjs`、`_op14a.mjs`、`_op14b.mjs`、`_op14c.mjs`、`_confirm.mjs`、`_t10.mjs`、`_ax3.mjs`、`_probe*.mjs`。

## 清单覆盖

- OP-13：已执行（关净化 → 点书脊回书库 → 点书卡重开同一本书 → 整段站尾可见 + `hideSiteTail=false` 落盘）。
- OP-14：已执行（点开工具一直显示 → 关进程重启同一 userData → 再开书 → 顶栏 height 56 可见 + `hideReaderChrome=false` 落盘）。
