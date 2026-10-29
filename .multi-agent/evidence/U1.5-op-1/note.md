# U1.5-op-1 环境与构造记录

## 坐标与主体
- 坐标：U1.5，阶段＝合入后画面复核
- 默认分支 commit：`2944406d0e9b166db884835c1b552fdeb72b0eb3`（`git rev-parse HEAD` 实测一致）
- 本目录所有截图均来自**这一刀 commit 自己构建的产物**，不是旧窗口。
- 构建：`npm run build` 退出码 0，日志 `_build.log`；产物 `out/renderer/assets/index-BU9u1Q1T.js` 含本刀标记 `data-reader-dl`。
- 产品文件未改：`git status --porcelain -- src docs package.json` 输出为空。

## 实例启动
```
setsid nohup ./node_modules/electron/dist/electron /home/goot/cod/xs/xsxz \
  --no-sandbox \
  --user-data-dir=/tmp/U1.5-op-1/userData \
  --remote-debugging-port=37495 \
  > /tmp/U1.5-op-1/electron.log 2>&1 < /dev/null & disown
```
- 主进程 PID：`309601`
- 启动前确认：37495 / 37855 端口空闲，无 `electron/dist/electron` 残留进程（不存在旧窗口被误操作的情况）。
- CDP：`http://127.0.0.1:37495`；页面 target 标题「小说浏览器」，URL `file:///home/goot/cod/xs/xsxz/out/renderer/index.html`。

## 窗口
- X11 顶层 frame `0x60008f`「小说浏览器」1308×866 @ (659,287)
- 内容窗口 `0x5400004`（WM_CLASS `spbf`）1280×800 @ (673,336)
- CDP 视口 1280×771，DPR=1
- 截图方式：`Page.captureScreenshot{captureBeyondViewport:false}`，输出恒为 1280×771。

## 隔离
- userData：`/tmp/U1.5-op-1/userData`，`settings.json` 写 `libraryPath=/tmp/U1.5-op-1/library`、`downloadPace=standard`。真实书库 `~/spbf/library` 全程未被读写。

## 样例站点（本地 HTTP，样例数据）
- 脚本：`_site.mjs`（`node --check` 通过），只写 `/tmp` 与本站证据目录。
- 启动：`SITE_CHAPTERS=200 SITE_DELAY_MS=450 node .multi-agent/evidence/U1.5-op-1/_site.mjs 37855 /tmp/U1.5-op-1/site-access.log`，PID `308012`。
- 入口：`http://127.0.0.1:37855/book1/index.html`（目录 200 章，链接文案「第N章 样例章节 NNN」），章节页 `<div id="content">` 内 6 段**标注为占位的样例正文**（每段都写明「这一段只是样例正文…不含任何作品内容」）。
- 每章 450ms 延迟，用于把下载压在 `running` 状态足够久。
- 每请求追加一行到 `/tmp/U1.5-op-1/site-access.log`，可据此核对下载真实发生与被取消的位置。

## 下载任务是怎么起来的（全走产品自己的入口，无伪造）
1. 底栏/顶栏「浏览」→ 地址栏 `input[aria-label="网页地址"]` 键入目录页地址 → 点「打开」。
2. 页面加载后点「下载本书」→ 出「下载前预览」抽屉（读到「样例站点·示例书一 / 目录 200 章 / 样本：第101章」）。
3. 点「确认下载这本书」→ 主进程隐藏 `WebContentsView` 逐章 `loadURL` 真下载，侧栏出现「已下 x / 200 章 取消」。
- 第一次下载在 c125 处被真实「取消」中止；第二次用书库「更多」→「重试失败章」再起一份，在 c173 处被真实「取消」中止。
- 站点日志共 179 次 GET，与两次下载的推进一致。

## 基线对照（未下载时）
`_stage0.json`：启动即落到阅读页，`.reader-toolbar` 带 `reader-tools-hidden`，`aria-hidden="true"`，`height:0`、`opacity:0`、`visibility:hidden`，无 `[data-reader-dl]` 任何节点。→ 默认确实是收起。

## 只读工具
`_cdp-lib.mjs`（连接/求值/截图/原生鼠标键盘/AX 树）、`_lib-click.mjs`（点击前用 `elementFromPoint` 校验命中，被遮罩挡住就不点）。所有点击都是 `Input.dispatchMouseEvent`（move→press→release），未调用组件方法、未改 DOM、未改组件状态。

## 收尾
- 实例正常关闭：`kill -TERM 309601`，之后 `ps` 精确核对 `electron/dist/electron … U1.5-op-1` 计数为 0。
- 样例站点已停：`kill -TERM 308012`，37855 / 37495 端口均无监听（curl 返回 000）。
- 产品代码未改：`git status --porcelain -- src docs package.json` 为空。
- 顶栏像素旁证：`OP-12-running-toolbar.png` / `B-expanded-toolbar.png` / `A-after-finish-topband.png` 是 1280×56 顶栏条带的 2 倍放大裁图；进度+取消区域（x940–1130, y10–46）暗像素数 running=308、B 展开=335、A=0，与读数一致。
