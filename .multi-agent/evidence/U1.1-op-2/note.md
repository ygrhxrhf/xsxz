# U1.1-op-2 实例记录

- 指定坐标：U1.1；阶段：合入后画面复核第二轮；指定默认分支 commit `995e69d616deafbee3383fea0ee6252261f0ed2c`（`git rev-parse HEAD` 启动前一致，工作区里只有 `.multi-agent/` 账本与证据改动，产品文件无改动）。
- 构建：`npm run build`，退出码 0；产物 `out/renderer/assets/index-D4u4Aec0.js`、`index-CV3lnEVy.css`（17:39 生成，晚于 HEAD 提交时间，属于本 commit 构建）。
- 启动命令：
  `/home/goot/cod/xs/xsxz/node_modules/electron/dist/electron /home/goot/cod/xs/xsxz --no-sandbox --user-data-dir=/tmp/U1.1-op-2-49d64062/userData --remote-debugging-port=37482`
- PID：Electron 主进程 3556873（窗口 0xa00004 的 `_NET_WM_PID` 即 3556873，`WM_CLASS="spbf","spbf"`）；GPU 3556904、network 3556909、renderer 3556930 / 3556932（参数含 `--user-data-dir=/tmp/U1.1-op-2-49d64062/userData --remote-debugging-port=37482 --app-path=/home/goot/cod/xs/xsxz`）。本机没有其他 spbf 实例在跑，pid 列表里只有这一棵。
- CDP：`http://127.0.0.1:37482`；browser `ws://127.0.0.1:37482/devtools/browser/4cf66758-40e3-4f98-8a64-26ad13447d24`；目标 page `D21CCF805C96AEC923114C7C61777D66`，标题「小说浏览器」，地址 `file:///home/goot/cod/xs/xsxz/out/renderer/index.html`。另有一个 `about:blank` target 未操作。
- 窗口：桌面 win_2，application electron，实际标题「小说浏览器」，位置 (640,320)，外框 1280×800；内容视口 1280×771，DPR=1。纸张 `.reader-pane` x=324..1008、y=24..747（684×723）；左书脊 `.reader-spine` x=0..52、全高 771。
- 样例库：`/tmp/U1.1-op-2-49d64062/library`（从上一轮样例复制，与真实书库隔离），独立 userData `/tmp/U1.1-op-2-49d64062/userData`，`settings.json` 的 `libraryPath` 指向该样例库。书 `sample_u11`：书名「样例·长夜行舟」、作者「样例作者」、标签「样例」、importType=download、3 章 ready，每章 100 段生成的纯文本占位正文（正文内容本身即标注「这是验收专用的样例正文」）。预置进度：`progress.chapterId=c0002`、`paragraphIndex=6`、`scrollRatio≈0.0768`；`reading-frontier.json` 记 c0002 paragraphIndex=11。启动后自动进入第二章，实测 scrollTop=1010。
- 操作方式：只对该 CDP target 发 `Input.dispatchMouseEvent` 原生 mouseMoved / mousePressed / mouseReleased（left，clickCount=1）点坐标；未调用 Vue 组件内部方法，未写 scrollTop，未改 DOM 类名或样式，未做 Page.reload，未发滚轮与键盘。
- 读数方式：每步执行同一段只读采集表达式（见 `_cdp-lib.mjs` 的 `READ_STATE`）取 `getComputedStyle` 与 `getBoundingClientRect`、`document.body.innerText`、`[data-p]` 可视段落，并 `Accessibility.getFullAXTree`。截图用 `Page.captureScreenshot` 直接生成，1280×771 完整视口，不裁剪不拼接。
- 本目录只承载本轮证据与复现脚本（`_cdp-lib.mjs`、`_run-OP-1R.mjs`），不改产品、不写账本、不提交。
- 复跑说明：OP-1R 完整三步路径本轮跑了五遍（17:44、17:45、17:46、17:47、17:53）。目录里的 before / library / after 三张截图、三份 state json、三份 ax、OP-1R-timeline.json 全部出自 **17:53 定稿遍次**；该遍在点击书卡后按 0/300/800/1500/2500/4000ms 连续采样，再另做 12 次每 1000ms 的稳定采样。前几遍的 computed visibility/opacity 差异按遍次写入 OP-1R.md，未覆盖任何证据文件。
- 探针：为确认「画面是否真的没有顶栏」，另跑一次逐帧截图探针（+0/+300/+800/+1500/+2500/+4000ms），像素比对后删掉 PNG，读数留在 `_probe-throttle.json` 与 `_probe-throttle.mjs`。探针同样只做鼠标点击与只读读取。
- 复现入口：`node _run-OP-1R.mjs`（连接同一 CDP target 重跑三步并覆盖 OP-1R-before/library/after 三组文件与 timeline）。
- 收尾：证据采集完成后按 PID 正常结束该实例（`kill -TERM` 主进程），未改动宿主设置、样例库与 userData 保留在 /tmp 以便复现。终止时的 Electron 输出另附于本目录 `_shutdown.log`。
- 未执行项：无。未做通过/未通过判定。
