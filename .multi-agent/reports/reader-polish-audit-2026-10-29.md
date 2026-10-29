# 阅读器手感体检报告（2026-10-29，只读）

- 仓库：`c:\codes\xsxz`（master = origin/master = d1fba2e，开工时工作区干净）
- 取证方式：真实启动 Electron（`spawn(electron, [repoRoot])` + CDP），造夹具书驱动阅读页；证据目录 `.multi-agent/evidence/reader-polish-2026-10-29/`
- 本轮边界：未改 `src/`、`docs/`、`scripts/`、`package.json`；未 commit、未 push；仅新增本报告与证据文件。
- 已知项复核：`docs/reader-experience-upgrade.md`、`docs/ux-review-2026-10-14.md`、`docs/ux-acceptance-2026-10-15.md` 与 2026-10-23 quiet-reading 的已验收项**没有重复上报**；下面每条都发生在这些修复之后。

---

## 0. 基线（命令证据）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 通过（`TYPECHECK_EXIT=0`，`baseline.log`） |
| `npm test`（首轮） | 1 | `1 failed | 135 passed (136)`，失败的是 `src/main/backup.test.ts`：运行时 `import('electron')` 触发 `electron/install.js` 子进程挂起（工作副本缺 `node_modules`/Electron 二进制，非产品缺陷） |
| `npm ci` + `node node_modules/electron/install.js` | 0 | 安装 472 包；补齐 Electron 二进制（未改 `package.json`） |
| `npm test`（复跑） | 0 | **136 个测试文件 / 1291 个用例全部通过**，耗时 86.04s（`baseline-test-rerun.log`） |
| `npm run build` | 0 | `BUILD_EXIT=0`，renderer/preload/main 全部产出（`baseline.log`） |

> 说明：首轮 `npm test` 的失败已用复跑证伪（同一提交、同一测试，缺二进制才失败）。基线结论：仓库本身是绿的。

---

## 1. 问题清单（按「用户可感知收益 / 改动风险」排序，5 条）

### 1) 底部面板关闭/重开后状态不同步：面板透明残留 + 阅读快捷键被静默吞掉

- **现象**
  - 用「字体」面板改完设置、按 Esc 关闭后，再点「字体」：`.bottom-panel` 已挂载，但 `opacity` 一直是 0，屏幕上什么也看不到；**再点一次**才出现。
  - 同一条路径上还会出现「按 PageDown 完全不动」：面板 DOM 仍在（用户可能已看不见），`anyDrawerOpen()` 判真，`resolveReaderKey` 对除 Esc 外的键全部返回 null。
- **复现步骤**
  1. 进书 → 点中区唤出底栏 → 点「字体」打开面板；
  2. 按 Esc 关闭 → 再点「字体」（间隔 1.4s，属于正常手速）；
  3. 逐帧采样：面板 `opacity=0` 持续 ≥1.4s，需再点一次才变 1。
  4. 另：打开「字体」后连按 6 次 Esc，仍能读到 `.bottom-panel` 存在；此时按 PageDown，`scrollTop` 位移 = 0。
- **证据**
  - `probe-esc2.log` 段 `E click-font-reopen`：`0ms~1433ms` 全部 `panel=1 / opacity=0`；段 `F click-font-close` 反而 `0→0.86→1`。
  - `verify-round2.log` 段 `B after panel keys`：`bClose={panel:true,...}`、`b0={top:1000}`、`b1={top:1000}`、`delta:0`；按键日志确认 Escape 事件已到达 `BODY`（不是按键没送达）。
  - 对应截图：`22-screen-snap-round2.png`、`23-annotation-220.png`（均为此状态下的页面）。
  - 第一轮同样现象的记录：`result.json` →「连续滚动 PageDown 不吸附」「屏幕翻页段落吸附」两处 0 位移。
- **影响的产品路径**：连续滚动翻屏、屏幕翻页、所有阅读快捷键（PageDown/PageUp/Home/End/Space/j/k）；字体/背景面板的二次打开。
- **建议改法**
  - `.bottom-panel` 的显隐不要只靠 `<Transition>` + `v-if` 推导：关闭分支显式置 `activeBottomPanel.value = null` 并确保离场结束（或改用 `v-show` + 显式 `opacity` 状态，避免离场被下一次进入打断后卡在 `enter-from`）。
  - `anyDrawerOpen()` 改成「有真正可见的浮层」判定（DOM 存在且非 `opacity:0`/非 `inert`），不要让残留节点拦快捷键。
  - 涉及文件：`src/renderer/pages/Reader.vue`（Transition 与 `anyDrawerOpen`），必要时同步 `src/renderer/pages/readerHelpers.ts` 的纯函数与测试。
- **工作量**：S～M（状态同步 S；若改 `anyDrawerOpen` 判定需补契约测试，升到 M）
- **越权墙**：不触碰。`Reader.vue` 属阅读工自有文件，不改 `types.ts`/IPC。

### 2) AI 抽屉：焦点在抽屉里的按钮上时，Esc 关不掉

- **现象**：点开 AI 抽屉、点过里面任意按钮（例如「生成本章摘要」）后按 Esc，抽屉仍然可见；焦点在正文（BODY）时 Esc 正常。
- **复现步骤**
  1. 阅读页按 `i` 打开 AI 抽屉；
  2. 点抽屉内任一按钮（焦点落在 `<button>`）；
  3. 不点击别处，直接按 Esc → 抽屉保持 `420×738` 可见。
- **证据**
  - `probe-esc2.log` 段 `H esc-close-ai`：14 帧（0～1436ms）`drawer=1` 全程不变；按键日志末条 `{"k":"Escape","target":"BUTTON"}`。
  - 第一轮同一结论：`result.json` →「Esc 关闭 AI 抽屉」`aiClosed:1`；`16-ai-drawer.png`。
  - 对照：焦点在 BODY 时 Esc 能关目录抽屉（`probe-esc.log` 段 2）。
- **影响的产品路径**：AI 抽屉（摘要/跟读/证据问答）的打开与中断；键盘可达性。
- **建议改法**
  - 在 window 的 **capture** 阶段先处理 Escape（`closeTopReaderOverlay()`），再让 Naive UI 的焦点陷阱处理；或给 `n-drawer` 显式 `:close-on-esc="true"` 并确认 `n-drawer-content` 不会被按钮 `keydown` 吃掉。
  - 涉及文件：`src/renderer/pages/Reader.vue`（`onReaderKeydown` 注册方式 / NDrawer 属性）。
- **工作量**：S
- **越权墙**：不触碰。

### 3) 失败章「重试」后弹的是英文内部错误：`HttpStatusError: HTTP 404`

- **现象**：章节加载失败页点「重试失败章」，约 2.6s 后 toast 显示 `HttpStatusError: HTTP 404`，不是中文可读原因；而失败页本身的中文说明（「章节地址加载失败 / 地址加载失败，可稍后重试这一章」）是对的。
- **复现步骤**
  1. 打开含失败章的夹具书（第 211 章 / 第 2 章）；
  2. 点「重试失败章」→ 等 2.5s → 读 `.n-message__content`。
- **证据**：`07b-failed-chapter-retry-toast.png`；`result.json` →「失败章重试按钮给出可读反馈」`retryToast:"HttpStatusError: HTTP 404"`、`elapsedMs:2606`。
- **影响的产品路径**：章节加载失败提示与重试、下载失败章重试。
- **建议改法**：在失败链路统一做错误映射（HTTP 状态、超时、DNS），复用 `FAIL_CODE_ZH` 的写法给「网络失败」一组中文文案；不要把 `Error.toString()` 直接透出。
  - 涉及文件：`src/main/library.ts`、`src/main/download.ts`（错误来源），必要时 `src/shared/types.ts` 的 `FAIL_CODE_ZH` 加枚举——**加字段要走协调者补丁**。
- **工作量**：S
- **越权墙**：**触碰文件所有权**（书库工 / 下载工文件；`types.ts` 归契约官）。本报告只提建议，实施需对应 owner 或协调者排期。

### 4) 大章节（2600 段 / 约 6 万字）全量排版 20.2 秒，后段滚动存在空白风险

- **现象**：首屏正文 42ms 就出现（很好），但 2600 个段落全部进入排版要 20.2s；期间 `scrollHeight` 逐步增长，滚到后段可能看到未排版区域。
- **复现步骤**
  1. 目录过滤「开篇」→ 点第 1 章（夹具：2600 段，约 6 万字）；
  2. 页面内 MutationObserver 记录首个 `.para` 与第 2600 个 `.para` 的时间。
- **证据**：`verify-round2.log` 段 `E large`：`first:42ms`、`all:20191ms`、`paras:2600`、`sh:220224`、`ch:690`；截图 `24-large-chapter-round2.png`。（第一轮「大章打开成功=false」是驱动脚本目录定位错误，已复测证伪。）
- **影响的产品路径**：大章节首屏与翻页、进度条/听书跳到章内后段、章内搜索。
- **建议改法**：沿用已有 `renderedCount` 分批渲染，把首批提高到 1～2 屏、空闲补批；未渲染段用占位高度保持 `scrollHeight` 可拖动，并在滚动落点优先补批（类似虚拟列表的「按需渲染窗口」）。
  - 涉及文件：`src/renderer/pages/Reader.vue`（渲染批次）、`src/renderer/pages/readerPager.ts`（段落测量）。
- **工作量**：M
- **越权墙**：不触碰（阅读工文件）。

### 5) `Home` / `End` 到不了章首/章末：各差约 157px

- **现象**：在屏幕翻页模式下按 `End` 滚到底后 `scrollTop=6216.8`，而 `scrollHeight-clientHeight=6373`（差 156.2）；再按 `Home` 停在 `157.6` 而不是 0。
- **复现步骤**
  1. 阅读页（无任何浮层）连续按 PageDown / End / Home；
  2. 读 `.reader-content` 的 `scrollTop / scrollHeight / clientHeight`。
- **证据**：`verify-round2.log` 段 `A fresh keys`：`a1.top=602.4`（PageDown 生效）、`a2.top=157.6`（Home 后）、`a3.top=6216.8`（End 后，max=6373）；`a4.top=5492.8`（PageUp 生效）。
- **影响的产品路径**：键盘可达性、翻屏边界、回到章首/章末。
- **建议改法**：`scroll-top`/`scroll-bottom` 用 `scrollTo(0)` / `scrollTo(scrollHeight)` 后，在屏幕翻页模式下跳过「段落吸附回弹」，或吸附到第 0 段/最后一段的真实 `offsetTop`。
  - 涉及文件：`src/renderer/pages/Reader.vue`（`case 'scroll-top'/'scroll-bottom'`）、`src/renderer/pages/readerPager.ts`。
- **工作量**：S
- **越权墙**：不触碰。

> **修复后复盘（2026-10-29 晚）**：第 5 条为**测量伪影**，非产品缺陷。强制出帧后复测（`probe-keys2.json`）：连续滚动三次 PageDown 均为 620.8px（0.9×690），`Home` 精确回到 `0`，`End` 落在 `max=197081`。原因是上一轮 CDP 采样时窗口不出帧，平滑滚动停在中途；产品本身无需改动。

---

## 1b. 修复实施与验证（2026-10-29，本轮已改产品代码）

| 项 | 改动文件 | 验证证据 | 结果 |
|---|---|---|---|
| Top 3 失败章重试提示 | `src/main/download.ts`（新增 `retryFailureMessage`，catch 不再 `String(e)`；原始错误仍 `console.warn`） | `probe-retry.json`：点击「重试失败章」849ms 后 toast=「目录页或章节页返回 404，可能已下架或地址已变更」，`hasEnglish=false`；截图 `40-retry-toast.png` | 通过 |
| Top 1 面板幽灵/透明残留 | `src/renderer/pages/Reader.vue`：`.bottom-panel` 去掉 `<Transition name="panel-slide">`，入场改为 CSS `@keyframes` 仅动 opacity | `probe-fixed.json`：打开 `opacity=1`；Esc 后 `panel=false`；再次打开仍 `opacity=1`（无幽灵层）；截图 `27/28/29` | 通过 |
| Top 2 抽屉内焦点按 Esc | `src/renderer/pages/Reader.vue`：新增 `onOverlayEscapeCapture`（window capture，`isComposing` 守卫，`stopPropagation` 防双处理），onMounted/onUnmounted 对称注册 | `probe-fixed.json`：焦点在抽屉内按钮「确认旧进度为已读」时按 Esc，300ms 内 `drawer=false`（420×738 → 0）；截图 `30/31` | 通过 |
| 回归 | — | `npm run typecheck`=0；`npm test`：136 文件 / 1291 用例全通过；`npm run build`=0 | 通过 |

补充：同样强制出帧后复测「屏幕翻页段落吸附」（`probe-keys-fixed.json`）：3 次翻页均对齐到段首（671.2 / 1355.2 / 2039.2），被屏幕切断的段落（#12/#28/#44）翻页后完整进入视口（距视口顶 33.6～33.9px）。此项此前记为「未能取证」，现确认**工作正常**，原判同样是出帧问题。

---

## 2. 已验证无问题（本轮实测）

| 路径 | 证据 | 结论 |
|---|---|---|
| 入口默认收起顶栏/底栏 | `01-reader-entry.png`；`result.json` | 进第 200 章时顶栏/底栏都 `reader-tools-hidden` |
| 点正文中区唤出工具 | `02-tools-revealed.png` | 一次点击顶栏+底栏出现；再点收起 |
| 进度条拖拽松手跳章且落章首 | `05-progress-drag-85.png`、`06-progress-jump.png` | 提示「第 358 章」，松手后标题=第 358 章、`scrollTop=0` |
| 拖到失败章：停在该章 + 失败说明 + 重试按钮 | `07-failed-chapter.png` | 「第 211 章 / 章节地址加载失败 / 重试失败章」全部到位 |
| 长目录（420 章）打开与定位当前章 | `08-catalog-open.png` | 420 项，147ms 打开，当前章滚到可见 |
| 长目录过滤 + 跳转 | `09-catalog-filter-jump.png`；`verify-round2` `catalog220` | 过滤「第 350 章」后 1 项、跳转 24ms；「第 220 章」跳转成功 |
| 夜间背景即时生效 | `10-night-theme.png` | 正文 `rgb(27,29,32)`，文字 `rgb(216,210,199)` |
| 字号滑块键盘操作不误跳章 | `11-slider-arrow-key.png` | 焦点在 `n-slider-handle-wrapper`，按 → 只改字号 18→19，章节不变 |
| 工具收起时 Tab 不进入隐藏工具条 | `result.json` tabStops | 10 次 Tab，落入 `.reader-tools-hidden` 次数 = 0 |
| 选中正文出选区工具条 | `12-selection-popup.png` | 复制/划线/备注/翻译/问 AI·解释这段/这个人物是谁/这件事之前发生了什么 |
| 划线即时渲染 + 落盘 | `13-highlight-applied.png`、`23-annotation-220.png` | 高亮 0→1；`annotations.json` 结构 `{version,items}`，`chapterId=c0220`（与当时章节一致）。**第一轮「条数=n/a」是脚本按数组读文件的误判，已证伪** |
| 标记抽屉 | `14-marks-drawer.png` | 1 行，能看到刚写的划线 |
| 听书播放与位置 | `15-tts-speaking.png`；书目录 `tts-position.json` | 段落高亮、「本章第 4 / 60 段」；位置 `chapterId=c0350` 与 `reading-frontier.json` 当前章一致。**第一轮「听书位置错位」是脚本误以为当时在第 220 章，已证伪（实际在第 350 章）** |
| AI 抽屉打开 | `16-ai-drawer.png` | 93ms 打开；未配置 key 时提示可读 |
| AI 无 key 的摘要路径 | `result.json` | 121ms 给出中文提示「读完本章后才能保存完整章节摘要…」，抽屉内 loading=0，不卡住 |
| 换字号后重开恢复位置 | `18-restore-after-font.png` | 重开前后首段都是 #24（比例 0.450），段落偏差 0 |
| 下载进行中常显进度 + 取消 | `19-download-book-failed-chapter.png`、`20-download-running.png`、`21-download-cancelled.png` | 顶栏「已下 1 / 2 章」+ 取消按钮；取消后 875ms 内进度消失并回默认收起 |
| 连续滚动 PageDown / PageUp 生效（无浮层时） | `verify-round2.log` 段 A | PageDown 0→602.4px；PageUp 6216.8→5492.8（除 Home/End 落点问题见第 5 条） |

---

## 3. 未能取证（写明原因，不用推测填空）

1. **屏幕翻页「段落吸附」是否真的对齐段首**：第一轮 5 次翻页 0 位移、第二轮 5 次仍 0 位移，原因是第 1 条的面板状态残留把按键吞了；单独在无浮层状态下只拿到 1 次 PageDown（602.4px），不足以判定「是否吸附段首/切断段是否完整」。需要先修第 1 条再复测。
2. **大章节单次翻页耗时**：大章打开后切「屏幕翻页」，`scrollTop=0` 被吸附到 147.2，PageDown 无位移，页面内计时 `ms=null`。同上受第 1 条干扰，未能取得可信耗时。
3. **AI「跟读 / 证据问答」**：夹具未配置 API Key，只验证了「未配置时的提示与不卡住」；真实流式跟读/问答/中断需要可用 key 与外网，本轮未取证。
4. **长目录滚动流畅度（帧率/惯性）**：CDP 无法量到真实刷新率（窗口非前台），只测到「打开 147ms、定位与跳转 24ms」这类结构化耗时；滚动掉帧未取证。
5. **划线/批注的删除、跨章列表分页**：本轮只验到「新增高亮 + 标记抽屉 1 行」，删除与大量标注的列表行为未取证。

---

## 4. 取证脚本与产物

- 主驱动：`audit-driver.mjs` → `result.json`、`01`～`21` 截图、`driver-console.log`
- 定向复核：`verify-round2.mjs` → `verify-round2.json`、`verify-round2.log`、`22`～`25` 截图
- 细粒度探针：`probe-esc2.mjs` → `probe-esc2.json`、`probe-esc2.log`（面板 opacity 逐帧、Esc 焦点对比）
- 基线日志：`baseline.log`、`baseline-test-rerun.log`、`npm-ci.log`、`electron-install.log`
- 收尾：窗口关闭后 `Get-Process electron` 无残留；`git status --porcelain` 只有 `?? .multi-agent/evidence/reader-polish-2026-10-29/`。
