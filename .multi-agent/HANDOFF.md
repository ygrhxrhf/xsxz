# HANDOFF

## 弧面删除后真机回归：三条 e2e 全通过（2026-11-11，本轮完成）

- 做到哪：补齐 `60b1c2e` 删除弧面实验时留下的真机验证缺口，在真实 Electron 窗口（1266×763）上复跑三条 e2e。
- 结果：
  - 翻页帧率 `scripts/realbook-flip-fps-e2e.mjs`：`7 项通过，0 项失败`，EXIT 0。基线 827ms/60 帧、中位 13.9ms、最大 20.9ms、40ms 以上长帧 0。
  - 页内批注 `scripts/realbook-annotations-e2e.mjs`：`17 项通过，0 项失败`，EXIT 0。
  - 选区俯仰 `scripts/realbook-selection-pitch-e2e.mjs`：`18 项通过，0 项失败`，EXIT 0（平放 0°、20°、35° 下单行/多行选区的工具条位置与真实划词全部通过）。
- 本轮唯一代码改动是 e2e 脚本：`realbook-selection-pitch-e2e.mjs` 的拖拽起点原先写死「书体左上角 +8px」，选完字后顶部阅读工具栏常显正好盖住该点（`elementFromPoint` 命中「书架」按钮），pointerdown 到不了书体；平放 0° 时该点还落在页内标题区，已有选区时浏览器起原生拖拽并 `pointercancel`，8px 就中止。改成在书体内部扫描「命中书体、不落在正文/批注、不被工具栏或选区工具条盖住」的纸面点，并先清空选区。
- 产品侧判定：不是回归。同一位置无选区时 0° 能拖到 20°、默认 18° 能拖到 35°，俯仰逻辑（`realBookPitch.ts` + `RealBookStage` 指针接管）完好；平面正文路径无变化。
- 未验证/边界：真机只跑一次窗口尺寸；未做多显示器/缩放比例变化下的重现。`realbook-flip-fps-e2e.mjs` 日志里的 `长任务 undefined 次共 NaNms` 是既有统计空值，不是失败项。
- 下一步：无遗留。`git push origin master` 仍需用户点头。

## 弧面排版裁决：删除（2026-11-11，本轮完成）

- 裁决：**删除弧面实验**，保留平面 `.real-book-para` 渲染。理由：
  - 真机截图对比：`realbook-flat.png` 两页干净；`realbook-arc.png` 字被
    `textLength lengthAdjust="spacingAndGlyphs"` 按弧带宽度拉伸成巨型字形、行间重叠、右缘裁切、
    左页整页空白（弧面分支缺空态）。根因在 `layoutArcRuns`：每带给整段几何宽度并把文字拉满，
    未占满全部带的行（段末短行）必然撑大。
  - 叠加此前两次 3D 竖带失败（投影宽度对不上中线），弧面路线没有可交付版本。
- 已删：`RealBookArcPage.ts`、`realBookArcText.ts` 与两份测试；`realBookFlip.ts` 的
  `valleyBands`/`ValleyBand`/`ValleyBandOptions`；`RealBookStage.vue` 的「弧面」按钮、
  谷竖带层与其 CSS、`ENABLE_ARC_TEXT`/`ENABLE_VALLEY_STRIPS` 及全部接线；`scripts/realbook-arc-e2e.mjs`
  与 `scripts/tmp-arc-*`。
- 保留：`realBookMeasure`（分页器依赖）、`spineValleyPoses`（`realBookFlip.test.ts` 仍覆盖）。
- 验证：`npm run typecheck` → EXIT:0；
  `npx vitest run src/renderer/pages/realBook*.test.ts src/renderer/pages/Reader.realBook.ui.test.ts --maxWorkers=6`
  → 7 文件 / 83 用例全通过，EXIT:0。
- 截图不入库（`.gitignore:12` 忽略 `.multi-agent/**/*.png`），证据存于
  `.multi-agent/acceptance/arc-2026-11-11/`，结论以文字留档。计划：`.multi-agent/plan/realbook-arc-adjudication.md`。
- 未验证/边界：删除后未再跑真机翻页/批注 e2e；本轮改动只删弧面分支与竖带层，平面路径代码未变。

## 工作区积压已落成三笔提交（2026-11-11，本轮完成）

- 做到哪：2026-11-09/10 三轮真实书籍工作从工作区拆成三笔提交，`plan:status` 归零。
- 提交：
  - `d1091da` fix(reader): 翻页 84°–91° 竖缝按投影宽度收字 —— `flipContentSideFalloff`、
    书脊纸垛调薄（20→12 层、间距 3→2.5、纵深 8→4）、`valleyBands` 弧面几何、
    2026-11-10 实机复核报告 + 墨迹密度脚本 + 证据截图。
  - `028e32f` feat(reader): 真实书籍页内批注 —— `showInlineNotes` 偏好、`library.readBookStats` IPC、
    批注原子块分页、`RealBookStage` 渲染与编辑浮层、`Reader.vue` 接线、契约与磁盘说明同步。
  - `ab377a8` chore(reader): 留档书脊弧面排版实验 —— `RealBookArcPage` / `realBookArcText`
    与 2 个单测；未接入产品页面。
- 本轮回归证据：`npm run typecheck` 0；`npx vitest run src --exclude .delta/ --exclude .qoder/ --maxWorkers=6`
  → **179 文件 / 1858 用例全绿**；`npm run build` 0。
- 计划：`.multi-agent/plan/workspace-commit-sweep.md`。
- 不入库（已进 `.gitignore`）：`arc*.log`、`scripts/tmp-arc-*`、`.multi-agent/e2e-artifacts/`、
  `docs/img/*.log.bak-*`、`.cancricode/`、`.openbitfun/`。
- 未验证/边界：三笔提交后未再单独跑 e2e（翻页慢动作、批注 17 项）——全量单测与构建已覆盖接线；
  弧面实验只是留档，没有产品入口。
- 下一步：无功能遗留。若要发布，`git push origin master`（需用户点头）。

## 真实书籍页内批注（2026-11-09，已提交 `028e32f`）

- 做到哪：`bookView === 'realbook'` 下加入可持久化的页内批注。选区工具条「批注」写下的内容复用
  `annotations.json` 的 `highlight.note/noteSource/color`，以原子卡片插入锚定段落之后；默认开启，
  关闭只隐藏卡片、保留划线。工具栏「批注」开关带 `aria-pressed`，卡片点击打开固定定位编辑浮层，
  可保存/二次确认删除；AI 批注改写后由主进程既有规则落回 `user`。
- 关键文件：`src/shared/types.ts`、`src/main/settings.ts`、`src/renderer/pages/realBookPager.ts`、
  `realBookNotes.ts`、`RealBookStage.vue`、`Reader.vue`、`readerMarks.ts`、`scripts/realbook-annotations-e2e.mjs`。
- 已验证证据：
  - `npx vitest run src/renderer/pages/realBookPager.test.ts src/renderer/pages/realBookNotes.test.ts src/renderer/pages/RealBookStage.ui.test.ts src/renderer/pages/Reader.realBook.ui.test.ts src/renderer/pages/Reader.marks.ui.test.ts src/renderer/pages/readerMarks.test.ts src/main/settings.test.ts`
    → 7 文件 / 130 用例全绿。
  - `npx vitest run src/renderer/pages/Reader.pagination.contract.test.ts src/renderer/pages/Reader.accessibility.contract.test.ts src/renderer/pages/Reader.selection.contract.test.ts`
    → 3 文件 / 29 用例全绿（选区契约同步改为「批注」）。
  - `npm run typecheck` → 0；`npm run build` → 0。
  - `node scripts/realbook-annotations-e2e.mjs` → 17/17 PASS：预置批注显示、就地编辑落盘、
    关闭后划线保留、设置写盘、重启后开关保持关闭；平放 / 20° / 35° 与四套主题截图产出到
    `%TEMP%\spbf-realbook-annotations-shots`。
- 下一步第一条命令：无功能遗留。若要收工提交，先按用户要求只暂存本任务文件；当前按系统约束未 commit。
- 未验证/边界：`npm run plan:status` 仍因既有 `.multi-agent/plan/realbook-flip-tear-2.md` 未勾项与整个
  工作区未提交改动而失败，属既有基线；真实站点超长章下的批注分页未单独压测；经典/书页模式按设计
  不出现页内批注。

## 当前事实

- **真实书籍翻页起手「撕开」已修（2026-11-09）**：
  - 根因：竖带按 `clip-path` 把纸的上下缘向内裁掉，裁口直接透出下面静态页；
    起手还没转动就先出现上下横缝。另有转轴落在书心正中，比本半页装订边偏 7px，
    右缘也会先裂出竖缝。
  - 修法：竖带保持整页高度、不再裁上下缘；翻动页转轴按方向放到中心线 ±7px。
  - 提交：`cce36a2` fix(reader): 修复真实书籍翻页起手先撕开的分层
  - 验证：`npm run typecheck` 0；3 个 Reader 用例文件 59 用例全绿；`npm run build` 0；
    确定性慢动作截图 12%/20% 帧无横缝、无起手竖缝。
  - 注意：`scripts/realbook-flip-fps-e2e.mjs` 非慢动作收尾仍有既有 `shotDir` 未定义
    的 ReferenceError（帧率 9 项检查本身全过）；慢动作模式 exit 0。
  - 计划：`.multi-agent/plan/realbook-flip-tear.md`。

- **真实书籍翻页外缘竖折缝（2026-11-09 第二轮）**：
  - 用户第二次反馈仍像「先撕开」；宽视口慢动作帧确认外缘额外 20° 翻卷把
    最外一条竖带折成与纸身分离的窄带，窄带里还是同一页的行尾字。
  - 修法：去掉外缘独立翻卷，曲率只由整页连续角度分布给出；另补纸背正文
    90° 淡入（`flipBackContentOpacity`），避免正反面交界硬切文字。
  - 提交：`9a47b32` fix(reader): 翻页外缘连续，去掉撕开式折边
  - 验证：主工作区 typecheck 0、73 用例全绿、build 0；慢动作 21 帧无竖折缝；
    非慢动作 e2e 9/9，55 帧、中位 13.9ms、长帧 0。
  - 干净 worktree 复核（`26408a5`）：本任务 2 个测试文件 59 用例全绿；
    排除既有过期 `realBookSpine.test.ts` 后 `tsc --noEmit` 0；`plan:status` exit 0。
  - 既有基线（父提交 `cce36a2` 同样存在，非本轮引入）：HEAD 上 `realBookSpine.test.ts`
    仍是旧签名 9 处 TS2554；`Reader.realBook.ui.test.ts` 键盘/点按翻页仍断言 +1 页，
    实际书页模式翻一张 +2，工作区已有其他批次未提交的测试修正。
  - 计划：`.multi-agent/plan/realbook-flip-tear-2.md`。

- **真实书籍纸张与翻页弯曲精修（2026-11-08，进行中/待提交）**：
  - 纸张：硬壳封面、三面书口、纸垛层线、纤维斑点、桌面布纹与书下软影；
    书脊改为窄暖谷，不再像金属圆棒。
  - 翻页：书脊侧延后 30% 行程，整页中段弯度约 64°；外角卷曲 20°，
    上下缘连续内收；整张纸加帆起、侧滚与落定余颤。外缘转角用 tanh 软压缩，
    接近挺度上限时增速变缓但不会钉死。
  - 性能：去掉动态模糊与翻页面两层不可见纤维；竖带 `contain` + `will-change`。
    热态真机 823ms / 34 帧 / 中位 21.0ms / 严重长帧 0。
  - 计划：`.multi-agent/plan/realbook-realism.md`。截图脚本新增确定性慢动作帧。
  - 追加（2026-11-09）：书心去掉深色谷与折痕，改为纯纸色；书心向两侧压 2px
    盖住页缘缝，并用纸色渐变过渡。书心剖面 222.8 / 223.1 / 224.2，无暗带。

- **真实书籍翻页鬼影已修（2026-11-07）**：翻页中间态不再出现整页残影。
  - 根因：竖带转过 90° 后仍按 `opacity` 画正面内容，和翻过来的背面叠在一起，
    在下方页面留下半透明的上一页。
  - 修法：`RealBookStage.vue` 的 `flipSlices` 按纸面自身转角下发 `--rb-flip-side`，
    转角 ≥90° 时正面整层停画；补了对应回归用例。
  - 提交：`115a58c` fix(reader): 修复真实书籍翻页中间态重影
  - 验证：`npm run typecheck` 通过；相关单测 56 项通过；
    `npm run build` 后 `node scripts/realbook-flip-fps-e2e.mjs` 10 项通过，
    翻页中态截图无整页重影。
  - 追加修复：纸背不再印字影、纸背色与正面一致；翻过去的那页不再像一块灰影。
    提交：`a17150c` fix(reader): 去掉真实书籍翻页纸背灰影
  - 再追加：保留纸背以维持翻页动作，只把透墨压到 0.08；提交
    `e0e6d6c` fix(reader): 保留真实书籍翻页纸背，只留极淡透墨
  - 计划：`.multi-agent/plan/realbook-flip-ghosting.md`

- **CF 挑战在 Electron 45 上已解决**：`6b5a4f8` + `a164083` + `2c7d8ee`
  - 根因：会话 UA 被覆盖成纯 Chrome，抹掉 `Electron/45.2.1` 与完整版本号，
    造成「UA 与指纹不一致」，Cloudflare 判为伪装（比原生 UA 更严）。
  - 修法：`sessionUserAgent()` 默认返回空串 = 不覆盖，保留 Chromium 原生 UA。
  - 实测（全新分区 + 隐藏视图 + 订阅代理）：uaa001 **26.0s / 54 链接**，
    alicesw **13.8s / 259 链接**，两个站都自动进入正文。
- 工作区有**别人未提交的 agent-integration 改动**（`src/main/agent*.ts`、`src/main/ipc/`、
  `docs/agent-integration-design.md` 等）。不要动，也不要在全量测试里把它算进结论。

- **Electron 45 升级已合入 master**（原分支 `worktree-electron-45-upgrade`，计划见 `.multi-agent/plan/electron-45.md`）：
  - `package.json` electron `^45.2.1` = **Chromium 156.0.8078.75 / Node 24.22.1**（master 的 `package.json` 已是此版本）。
  - 该分支相对 master 无未合入提交（`git log master..worktree-electron-45-upgrade` 为空），升级内容已在 master 上。
  - safeStorage 全部改异步，包括订阅代理新增的密码加解密路径。
  - rebase 时发现：应用内代理在 `settings.ts` 里新增了同步 safeStorage 调用，
    且 `requireEncryptionAvailable()` 漏了 `await`（等于跳过密钥库检查）。已在 `8e6aef6` 修复。
  - 合并后验证：typecheck 通过；全量 142 文件 / 1428 用例全绿；build 通过；
    e2e startup 10/10、ocr 11/11、reader 11/11、mirror 19/19。
- **订阅代理（内置内核）已提交**：`5f4ebbf` feat(proxy): 订阅模式，内置 sing-box 内核
- **应用内代理（proxy）已提交**：`9d33a5e` feat(proxy): 应用内代理，浏览与下载共用同一出口
- **挑战页自动重试（challenge-page）已提交**：
  - `053c13c` feat(download): 站点验证挑战页自动重载 + 落人工续跑
  - `ee80288` docs: 计划与实测结论归档
- **agent 集成（MCP 桥接）已提交并推送**：`5a6d4bf..7fe37f3`（10 个提交，origin/master = 7fe37f3）
  - 能力清单 `src/shared/agentCapabilities.ts` + 两份机器化契约测试
  - 路径预检 `agentPaths.ts`、审计 `agentAudit.ts`、任务注册表 `agentJobs.ts`
  - 协议核心 `agentBridgeCore.ts`、命名管道服务器 `agentBridge.ts`
  - 接线：`index.ts`（注册表 → registerIpc → 开管道、单实例锁、job 事件旁路）、
    `preload` 加 `agentAudit.list`、设置页「Agent 调用记录」
  - MCP 服务端与冒烟脚本：`scripts/agent-mcp-server.mjs`、`scripts/agent-bridge-smoke.mjs`
- 推送注意：本机 `credential.helper-selector` 会让 `git push` 卡在等待凭据，
  用 `git -c credential.helper=manager push origin master` 可非交互推成功。
- master HEAD：`7fe37f3`（master 干净；`.qoder/`、`.probe-cf/` 未跟踪，属并行工作/探针产物）。

## 订阅代理（内置内核）做了什么

用户只有一条订阅链接、机器上没有任何客户端时走这条路。

- `src/main/subscription.ts`：正文解码（base64 / 明文 / JSON 识别）→ 节点 URI 解析
  （vless 含 REALITY、hysteria2、tuic、anytls）→ `buildSingBoxConfig`。
  公告行（剩余流量/到期/通知）按名字过滤。
- `src/main/proxyKernel.ts`：写配置 + `sing-box run -c` 拉起 + 等端口监听 + 停止。
  端口 20801–20899 挑空闲；只监听 127.0.0.1。
- `src/main/proxyRuntime.ts`：解析→挑端口→拉起→把 `persist:novel` 指到内核端口。
  订阅正文缓存在主进程；换节点 = 重启内核。退出时 `stopSubscriptionProxy()`。
- IPC：`proxy.subscribe` / `parseSubscription` / `selectNode` / `kernelState` / `stopKernel`。
- 内核二进制**不随包分发**，放 `userData/proxy-kernel/sing-box.exe`，只认官方 GitHub Release。

### 验证证据（订阅）

- `npx vitest run src/main/subscription.test.ts` → 27/27
- `npx vitest run src/main/proxyKernel.test.ts` → 12/12
- `npx vitest run src/main/proxyRuntime.test.ts` → 12/12
- 全量 `npx vitest run src --exclude '.delta/' --exclude '.qoder/'` → 142 文件 / 1420 用例全绿
- `npm run typecheck` → 0；`npm run build` → 0
- **真实订阅**：88 条里解析出 86 个节点（跳过公告行），
  `hysteria2 30 / tuic 23 / vless 20 / anytls 13`，配置结构正确生成。

### ✅ 已全部实测（2026-11-03）

sing-box 1.14.4 下载成功（32891280 字节，`with_quic`/`with_utls` 齐全）。

| 项目 | 结果 |
|---|---|
| 四份配置 `sing-box check` | 全部 exit=0 |
| hysteria2 / tuic / anytls / vless | 四种都拿到境外出口 IP（302） |
| alicesw.com 经代理 | **200**，项目 Electron 会话加载到 71716 字节真实内容 |
| uaa001.com 经代理 | 403 挑战页（网络已通，剩站点策略） |

### 过程中修掉的两个真实缺陷（`b49a8a1`）

1. **REALITY 缺 utls**：sing-box 强制要求 uTLS，缺这段 `FATAL "uTLS is required
   by reality client"` 拒绝启动。分享链接常不带 `fp`，原代码会省略整段。已改默认 `chrome`。
2. **closeAllConnections 打崩 network service**：代理指向已死进程时，
   「改代理 + 立刻断连」让 network service 崩溃、会话不可用。复现矩阵确认崩 2 次，
   加 300ms 等待后 0 次且会话可用。`proxyRuntime` 也改走 `applyProxyToSession`。

### 剩余边界

- 长时限运行稳定性未测（只做单次连通验证）。
- 订阅自动更新、多节点测速未实现。
- uaa001 这类站仍需用户在浏览页手动过一次 Cloudflare 验证。

## proxy 做了什么

- `src/main/proxy.ts`：`normalizeProxyPrefs` / `buildProxyRules` / `buildProxyBypassList` /
  `applyProxyToSession` / `judgeProxyProbe`。
- 三种模式：`off`（`direct://`，连系统代理也不走，**默认**）、`system`、`manual`
  （http/https/socks4/socks5）。作用于浏览与下载共用的 `persist:novel` 分区。
- 应用后必调 `closeAllConnections()`；否则 `setProxy` 只影响新连接，会表现为
  「改了设置但还要开系统代理才生效」。
- 代理认证走 `app` 级 `login` 事件，只处理 `authInfo.isProxy`；密码经 `safeStorage`，
  `settings.get` 只回 `passwordConfigured`。
- 新 IPC `proxy.test`：一次性隐藏视图 + 真会话加载目标，只判有没有 HTTP 响应。
- 设置界面新增「网络代理」区块。

### 验证证据（代理）

- `npx vitest run src/main/proxy.test.ts` → 29/29
- `npx vitest run src/main/settings.test.ts` → 45/45（含 6 条代理持久化用例）
- `npx vitest run src/preload/ipcContract.test.ts` → 5/5；`Settings.ui.test.ts` → 7/7
- 全量 `npx vitest run src --exclude '.delta/' --exclude '.qoder/'` → 138 文件 / 1359 用例全绿
- `npm run typecheck` → 0；`npm run build` → 0
- **真实链路探针**（本地转发型 HTTP 代理）：
  `resolveProxy → PROXY 127.0.0.1:38084`；`localhost → DIRECT`（`<local>` 生效）；
  `connects: ["example.com:443"]`；`title: "Example Domain"`；切回 direct → `DIRECT`

## electron-45 做了什么

四个提交（按依赖顺序）：

1. `chore(deps)` Electron 45.2.1 + `.npmrc` 的 `electron_mirror`（npmmirror）。
   Electron 42+ 取消 install 时下载二进制，必须 `npx install-electron` 补，
   否则 electron-builder 的 `electronDist` 会把旧内核打进包。
2. `refactor(settings)` safeStorage 同步 API → 异步。45 弃用、46 删除。
   `getSettings` 里四把 Key 并发解且每把只解一次（原实现主 Key 解了两遍）。
3. `build` 显式钉 `build.target`。electron-vite 5 的映射表只到 Electron 39，
   45 会**静默回退到 chrome142**（已实测复算），不会报错。
4. `test(cf)` 挑战页在 Chromium 156 上的复测结论与探针。

## 验证证据（全部实跑）

- `npm run typecheck` → exit 0
- `npx vitest run src` → **136 文件 / 1306 用例全绿**
- `npm run build` → exit 0；`out/preload/index.mjs` 仍是 CJS 且无 Buffer/setImmediate/events
- 真 Electron e2e：startup 10/10、ocr 11/11、reader 11/11、mirror 19/19
- `npm run pack:local` → exit 0，日志 `electronVersion=45.2.1`；
  `release/win-unpacked/version` = `45.2.1`，`app.asar.unpacked` 含 tesseract.js(-core)
- 运行时探针：`{"chrome":"156.0.8078.75","node":"24.22.1","electron":"45.2.1"}`，
  UA 实际变成 `Chrome/156.0.8078.75`

## 升级带来的意外收益（重要）

挑战页战役当时结论是「隐藏下载视图拿不到 `cf_clearance`，只有可见窗口能过」（测于 Electron 43 / Chrome 150）。
在 Chromium 156 上用三个独立变体复测：

| 变体 | clearance | 首载 | 重载后 | 结论 |
|---|---|---|---|---|
| A 可见 BrowserWindow | 4316 ms | 116 字（挑战页） | 14036 字 / 264 链接 | PASS |
| B 下载视图（不挂窗口，产品配置） | 2338 ms | 14028 字 / 264 链接 | 同上 | PASS |
| C 下载视图（挂隐藏窗口） | 2578 ms | 13311 字 / 264 链接 | 同上 | PASS |

→ **产品隐藏下载视图在 45 上能拿到 cookie**，`challengePage.ts` 的自动重试是真有效的；
A 变体首载只有 116 字，证明站点挑战仍在，不是站取消了挑战。
细节：`.multi-agent/evidence/electron-45-cf-2026-11-02/results.md`

## 下一步

1. **人工验收（自动化测不出）**：
   - 常用小说站首页正常出书目（不被新 UA 拦）
   - 打开章节 / 下载本书 / 阅读器翻页
   - 设置里存 API Key → **重启** → 仍显示「已配置」→ AI 请求能返回

## 已知边界

- CF 复测单站单次采样，Cloudflare 按指纹动态调难度。
- 早期一次 B 变体出现 `ERR_FAILED (-2)` 后静默退出；独立 partition 重跑正常，
  判断为 partition 复用偶发，未纳入结论。
- `.qoder/worktrees/electron-45-upgrade` 这个 worktree 目录仍在，但它相对 master
  没有未合入提交，已无用途，可在确认无未提交改动后删除。

## challenge-page 做了什么

- 新增 `src/main/challengePage.ts`：
  - `detectChallengePage(html)`：引用 `challenges.cloudflare.com` / `cdn-cgi/challenge-platform`
    即判挑战页（最硬信号）；无脚本时要求页面近乎空白（可见正文 < 120 字）且命中 CF 专属
    标题 / 话术。**刻意不收「安全验证」这类中文标题**——站点拦截残页也用它，误判会白等。
  - `waitForChallengeClearance({ hasClearance, wait, now })`：轮询 `cf_clearance`，
    1s 间隔、20s 预算；读 cookie 抛错继续等，不打断下载。
- `download.ts`：`retryIfChallengePage(load, url)` 统一两处——`loadAndGetHtml` 与
  `loadPageHtml`（含夹具路径）。命中挑战页 → 等 cookie → 重载一次；仍不放行则原样返回，
  交给正文启发式判 `Intercepted`，落到既有 `download.blocked` / `resumeUnblock` 人在环。
- `extract.ts`：`INTERCEPT_TITLE` / `INTERCEPT_TEXT` 补 CF 挑战页特征，「请稍候…」不再记 `UnknownPage`。
- 契约：`docs/ipc-contract.md` 新增「站点验证挑战页（Cloudflare / Turnstile）」一节。

## 验证证据

- `npx vitest run src/main/challengePage.test.ts` → 17/17
- `npx vitest run src/main/download.test.ts src/main/challengePage.test.ts` → 334/334
- 全量 `npx vitest run src --exclude '.delta/' --exclude '.qoder/'` → 137 文件 / 1324 用例全绿
- `npm run typecheck` → 0；`npm run build` → 0
- `npm run plan:status` → 0

## 关键实测结论（重要，别再重复踩）

对 `https://www.uaa001.com/`（Cloudflare 托管）实测：

| 载体 | 结果 |
|---|---|
| curl（Schannel） | TCP 通但在 TLS 层即失败 |
| ego-browser（Chrome 156） | 正常，47 个书目链接 |
| Electron 43 `BrowserWindow`（Chrome 150） | **曾成功**：`cf_clearance` 约 5–11s 下发，重载后 47 链接 |
| Electron 43 隐藏 `WebContentsView`（产品下载视图） | **拿不到 cookie**，25s 内一直停在挑战页 |

产品下载视图是 `sandbox: true` + `setVisible(false)` + 负坐标 bounds，
与 `BrowserWindow` 唯一差别在可见性/渲染路径。反复请求后连 `BrowserWindow` 也
退回失败，同一时刻 ego-browser 仍正常 → 判断为 Chromium 版本 + 隐藏视图指纹差异，
**不是**自动重试逻辑缺陷。

因此：该站当下实际会落到「人在环」——用户在内置浏览里过验证（`persist:novel`
会话与下载共用，cookie 天然复用），再点「我已处理好，继续下载」。

## 已知边界

- 自动重试只做「等真实浏览器跑完 + 重载」，**不解 Turnstile 载荷、不伪造 cookie**。
- 要求真人点击的挑战，自动重试无效，只能落人工。
- 重载上限 1 次（`CHALLENGE_MAX_RELOAD`），避免对判死的站反复撞。
- 本机并行存在 `.qoder/worktrees/electron-45-upgrade`——升级 Electron 可能才是根治
  该站的办法，但那是另一条线，本次未碰。

## 下一步

1. 若要让 uaa001 这类站真正自动通过：跟踪 `.qoder` 的 electron-45 升级线，
   升级后在真实下载视图上复测 `cf_clearance`。
2. `npm run plan:status` 已 0；`git push` 需用户点头（master）。

## R2 做了什么

- **探针** `.multi-agent/evidence/reader-progress-r2-2026-11-02/r2-probe.mjs`：真实 Electron + CDP，
  六场景「关应用→改排版/改正文→重开」测恢复误差（A 字号 / B 列宽 / C 窗口 / C0 offset=0 / D 清正文 / D2 正文替换同段数）。
- **修复**：
  1. `textPoint` 跳过空文本节点 —— offset=0 锚点（段落开头对齐视口顶，真实可达）不再因空 range 全零矩形滚回章首（探针 C0 复现：修复前 107 段误差，修复后 0）。
  2. `captureProgressWrite` 补写 `bodyHash`（与 TTS 同源 `ttsBodyHash`），`scrollToParagraphAnchor` 经 `progressAnchorBodyMatches` 校验，正文变更回退 scrollRatio；旧书无 bodyHash 跳过校验保持兼容（探针 D2 复现：修复后正确回退比例位）。
- **全书百分比**：保持章节等权估算（已明确「约」标注），不扩范围 —— 极端章节长度差异（1 章 2000 段 + 5 章 10 段）下等权显示 17% vs 真实 98%，但加权需各章段数数据源 + 同源反解联动改，风险大于收益，已记录在 findings。

## 验证证据

- 探针复验：`node .multi-agent/evidence/reader-progress-r2-2026-11-02/r2-probe.mjs` → 6/6 PASS，exit=0（报告 r2-probe-report.json）
- `npm run build` exit=0；`npm run typecheck` exit=0
- 契约：`npx vitest run src/renderer/pages/Reader.progress.contract.test.ts src/renderer/pages/Reader.accessibility.contract.test.ts` → 29 用例全绿
- 主树全量：`npx vitest run src --exclude .delta/` → 136 文件 / 1305 用例全绿（含新增 4 例 progressAnchorBodyMatches）
- 单测：readerHelpers.test.ts（88 例）+ readerPager.test.ts（25 例）全绿
- findings：`.multi-agent/reports/reader-progress-r2-findings.md`

## 下一步

1. **同步 delta worktree**：`.delta/worktrees/{8f792tj3eq1d,sb3j3p5netq9}` 需要同步到 e95f4ce（当前停在 7e2ab6f）。
2. `npm run plan:status` 退出码 0 才算收工（计划追踪器已全勾）。
3. 若用户确认推送：`git push`（上游已配置；涉及 master，需用户点头）。

## 已知边界

- Emulation 视口下 `readerProgress.schedule()` 写盘链被阻塞（探针环境伪影，非产品缺陷），C/C0 场景 A 段用 `setProgress` IPC 直写代替；真实窗口 resize 走 schedule 正常。
- 恢复稳定判定：首可见段连续 4 次采样一致（150ms），采样前强制两帧。
- 计划基线「78 用例」与实测「29 用例」有出入：以实测为准（progress 3 + accessibility 26，全绿）。

## 2026-11-07 收尾复查（回归与覆盖补齐）

上一轮实现收尾后做了一次「实现 vs 覆盖」对账，补掉了三块只有实现没有界面用例的新功能，
并修掉一处 e2e 断言用了过期文案。

**修掉的真实问题**

- `scripts/map-e2e.mjs` 断言「尚未提供书中地图素材」，但界面实际文案是「尚未选择书中地图图片」
  （`BookMapPage.vue` 与 `BookMapPage.ui.test.ts` 都是后者）。e2e 假红。改断言，不改界面。

**补上的覆盖**

- `src/renderer/components/RuleMarketPanel.ui.test.ts`（8 例）：条目列表与来源标签、
  空态、读取失败、应用成功/失败、订阅与取消订阅、空地址不发请求。
- `src/renderer/components/SyncPanel.ui.test.ts`（9 例）：登录状态、令牌为空不发请求、
  登录成功/失败、同步结果摘要、同步失败、退出登录、状态读取失败。
- `src/renderer/components/ProxySubscriptionPanel.ui.test.ts`（9 例）：自动更新状态读取、
  开关保存、保存失败、立即重拉成功/失败（概览抛给设置页）、测速排序、
  全部失败时给警告、测速失败、以及「面板不提供自动换节点入口」这条边界。
- `src/renderer/pages/Library.ui.contract.test.ts`：全书概览入口的契约（剧透提示、
  失败重试、弹层展示、关闭清状态）。
- `src/renderer/pages/Settings.ui.contract.test.ts`：三个新面板在设置页的挂载与接线。

**顺手修掉的测试脆弱点**

Windows 上后台任务（原子写 + rename）落盘期间删临时目录会撞 `ENOTEMPTY` / `EBUSY` / `EPERM`，
全量并行时让 `readingStats` / `bookOverview` / `aiReadingFollow` / `aiEvidenceIndex`
偶发假红（断言已过，清理失败）。抽出 `src/main/testSupport/tempDir.ts` 的 `removeTempDir()`
统一带重试，别处错误码照旧抛出。`aiEvidenceIndex.test.ts` 里原先内联的那段重试逻辑改为复用它。

### 验证证据（本轮实跑）

- `npm run typecheck` → 0
- `npx vitest run src --exclude .delta/ --exclude .qoder/` → **176 文件 / 1805 用例全绿**（默认并发）
- `npm run build` → exit 0（`out/main/index.js` 798.67 kB、`out/preload/index.mjs` 17.94 kB）
- e2e（真起 Electron）：map **13/13**、reader **11/11**、startup **10/10**、mirror **19/19**、
  realbook-selection **18/18**，全部通过

### 已知边界

- 全量并发在 16 核上偶发超时（`readingStats` 405 次写盘、`aiEvidenceIndex` 800 章建索引）。
  降到 `--maxWorkers=6` 必绿；默认并发已用上面的清理重试消掉了目录锁那一类，剩余超时属负载相关。
- 规则市场面板的「已订阅来源」只记在本次会话内（契约里没有「列出订阅来源」的频道），
  重开应用后地址由主机的 `rule-market.json` 保留，重新订阅同址即可。

