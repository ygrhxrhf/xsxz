# 计划：真实书籍拖页飞页正文（白纸）结案

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工。

## 目标

拖页时飞页正文稳定贴面：`.real-book-flip-line` 有内容、带 `matrix3d`、正反面都建，
弹回不翻页、落定翻页；并把这条列进真机 e2e，后台窗口不再制造「白纸」假象。

## 步骤

- [x] 1. 复现：用 CDP 在真实 Electron 窗口里拖页，逐帧读 `.real-book-flip-line`
      - 验：`node .multi-agent/tmp/debug-drag.mjs` → 每一步 `lines: 0`
      - 证据：与 HANDOFF 记录一致（0 段、页码只到 3/5），复现成立
- [x] 2. 定位：插入计数器确认 `hitLoop` 跑过若干帧后停住、`updateFlipText` 从未进入
      - 验：页面内 `window.__hitTicks` 冻结、`__flipCalls` 为 0；`frontItems: 9`（页本身不空）
      - 结论：窗口在后台时 Chromium 停 rAF，飞页正文层永远不建；`front/back` 并非 null
- [x] 3. 反证：同一拖页加上 `Emulation.setFocusEmulationEnabled`
      - 验：`node /tmp/dbg-drag3.mjs` → 正向/反向/取消每一步 `lines: 184~193、vis: 92~103`
      - 结论：上一轮「产品竞态」是自动化夹具的假象
- [x] 4. 实现（两道保险）：
      - 起纸时冻结正反面页快照（`FlipRun.front/back` + `flyerPageIndexes`），页表重排不会让飞页取到越界下标
      - `props.flips` 一变就同步飞页正文层，不等 rAF
      - 验：`npm run typecheck` → EXIT 0
- [x] 5. 测试：
      - `npx vitest run src/renderer/pages/realBookFlyerText.test.ts src/renderer/pages/RealBookStage.ui.test.ts` → 2 文件 / 48 用例
      - `npm test` → 197 文件 / 1995 用例全绿（EXIT 0，日志 `.multi-agent/tmp/logs-2026-11-20/fulltest.log`）
      - `npm run e2e:realbook-webgl` → **31 项通过 0 失败**（新增 7 项拖页断言；日志 `webgl.log`）
      - `e2e:realbook-flip` 7/7、`e2e:realbook-notes` 18/18、`e2e:realbook-selection` 18/18（同目录日志）
- [x] 6. 提交：`fix(realbook): 拖页飞页正文按快照贴面，e2e 开焦点模拟并断言拖页`
      - 验：`git log --oneline -1`
- [x] 7. 交付物：`docs/真实书籍-WebGL复刻.md` 更正「已知限制」；HANDOFF 记本轮
      - 验：文档第 47 行由「未修竞态」改为结案说明

## 不做（显式出范围）

- 不改 CSS 3D 回退的翻页几何（未受影响，notes/selection/flip 三条 e2e 全绿）。
- 不给后台窗口做「无 rAF 也能渲染」的兜底（rAF 停时整张纸本来就不动，用户看不到）。

## 已知边界

- 后台窗口里 DOM 飞页正文会建好但 `display:none`（可见性由帧循环按纸面投影给），
  回到前台第一帧即贴面——这是渲染暂停的必然结果，不是空白页。
- 页快照在起纸时冻结：翻页途中改划线/批注不会出现在空中这张纸上，落定后静态页立即按最新数据重排。

## 断点记录（每次停下前更新）

- 状态：待推送
- 下一步第一条命令：`git push origin master`（需用户点头）
- 未验证项：多点触控/触控板拖页；非 1 DPR 缩放下拖页未单独压测。
