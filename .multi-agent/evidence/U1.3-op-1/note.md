# U1.3-op-1 操作记录（合入后画面复核）

- 任务：`U1.3-op-1`　切片：`U1.3`　阶段：合入后画面复核
- 目标 commit：`35002d153bd2a3e23bf20e43448efaa68131f252`（目标即被测版本，未切换、未重建）
- 仓库：`/home/goot/cod/xs/xsxz`　渲染产物：`out/renderer/assets/index-DlnPvun8.js`（构建于 10:57，含 `scrollTopForParagraphPage` / `snapScrollToParagraph`）
- 窗口：X11 id `0x4400004`，`WM_NAME="小说浏览器"`，`WM_CLASS="spbf"`，`Map State=IsViewable`，窗口 1280×800，内容视口 **1280×771**，DPR 1，窗口绝对位置 (640,320)
- 进程：主进程 pid **145627**（`_NET_WM_PID` 一致）；CDP 端口 `127.0.0.1:37494`，Browser `Chrome/150.0.7871.224` Electron/43.4.0，页面 target id `58B53C1DE2763D4E63847C7BC365967F`，URL `file:///home/goot/cod/xs/xsxz/out/renderer/index.html`
- 启动命令：
  `setsid nohup ./node_modules/electron/dist/electron /home/goot/cod/xs/xsxz --no-sandbox --user-data-dir=/tmp/U1.3-op-1/userData --remote-debugging-port=37494 > /tmp/U1.3-op-1/electron.log 2>&1 < /dev/null & disown`

## 操作方式（只发真实输入事件）

- 全部交互走 CDP `Input.dispatchMouseEvent`（`mouseMoved` / `mousePressed` / `mouseReleased`）与 `mouseWheel`；坐标取自元素 `getBoundingClientRect()` 中心，按下前用 `document.elementFromPoint` 记录命中的真实节点。
- 未调用任何 Vue 组件方法或 `$refs`，未读写 `readingMode` 等状态变量，未设置 `scrollTop`，未加/删 class 或 style，未 reload，未改产品代码。
- 采样为只读 `Runtime.evaluate`：`scrollTop` / `clientHeight` / `scrollHeight` / 章标题 / 段落 `absTop`(内容绝对) 与 `viewTop`(视口相对) / 首句文本；截图为 `Page.captureScreenshot`。
- 已核对 CDP 截图与真实窗口画面：`ffmpeg -f x11grab` 抓窗口后裁掉 29px 标题栏，与 `B-after.png` 逐像素比对 **986880 个像素全同（差异 0.0000%）**，证明所操作画面就是屏幕上这一个窗口。

## 坐标（真实点击位置）

| 用途 | 坐标 | 命中节点 |
|---|---|---|
| 正文中区（显形/收起工具条） | (666, 386) | `DIV.reader-content.reader-pane` |
| 正文右区（点右侧翻页，位于段落 TTS 按钮右侧的留白） | (960, 380) | `DIV.reader-content.reader-pane.chapter` |
| 底栏「字体」按钮 | (1225, 455) | `BUTTON.bottom-button[aria-label=字体]` |
| 面板「屏幕翻页」 | (983, 530) | 面板内 `button`，`elementFromPoint` 命中自身 |
| 面板「连续滚动」 | (865, 530) | 面板内 `button`，`elementFromPoint` 命中自身 |

面板两选项初始被面板滚动容器裁掉，用真实 `mouseWheel`（面板矩形中心、`deltaY=120`）滚到命中自身后才点，避免与正文抢点击。

## 样例（自造，非真实数据）

- 书库：`/tmp/U1.3-op-1/library`，书 id `sample_u13`，书名 `样例·屏底翻页`，标签 `["样例"]`，2 章（`第一章 样例翻页` / `第二章 样例续页`），正文全部为生成文本。
- userData：`/tmp/U1.3-op-1/userData`，起始 `settings.json.reader.readingMode = "scroll"`；每轮开始前重置 `book.json.progress` 到 `c0001`/`scrollRatio 0`、`index.json` 进度与 `reading-frontier.json.chapters = {}`。
- 段落构造（`_gen-library.mjs`）：`[...Array(9).fill(40), 110, 40, 40, 40, 2000, ...Array(8).fill(40)]`，共 22 段。
  - 「短段」= `i=9`（第 10 段），115 字，实测高 130px、4 行，首句固定为「第 10 段：这是样例段落的完整首句。」——放在第 10 位，使第一屏正好把它切在屏底。
  - 「超长段」= `i=13`（第 14 段），2005 字，实测高 2170px（约 67 行），内容段首仍以可辨认的「第 14 段：这是样例段落的完整首句。」开头，之后是连续可数编号短句，便于判断视口是否停在段内。
  - 其余为 45 字（2 行、65px）的填充段。
- 章内几何：`scrollHeight 4162`、`clientHeight 723`、`maxTop 3439`，正文区 x=324、宽 684、y=24。

## 本轮文件

- `OP-8-before.png` / `OP-8-after.png` / `OP-8-before-state.json` / `OP-8-after-state.json` / `OP-8.md`
- `A-before.png` / `A-after.png` / `A-before-state.json` / `A-after-state.json` / `A.md`
- `B-after.png` / `B-after-state.json` / `B.md`
- 过程帧：`_t00-boot.png`、`_t02-font-panel.png`、`_t04-screen-mode.png`、`_t05-panel-closed.png`（各带 `-state.json`）
- 全量时间线：`_trace.json`；汇总：`_summary.json`；窗口原图：`_window-x11.png`、`_window-content.png`
- 裁剪辅助：`_crop-OP-8-before-bottom.png`、`_crop-OP-8-after-top.png`、`_crop-A-before-top.png`、`_crop-A-after-top.png`
- 脚本：`_cdp-lib.mjs`（CDP 封装 + 只读采样表达式）、`_gen-library.mjs`（样例生成）、`_run-op8-a-b.mjs`（本轮一次跑完的采集脚本）；`_build.log`、`_ax-buttons.txt`

## 未执行 / 边界

- 未验证第二章、其他字号与窗口尺寸、Windows 平台；未改任何产品文件、账本，未提交、未 push。
