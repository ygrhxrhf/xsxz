# 章节导图：全屏 + 缩放可读性

背景：用户反馈抽屉里 560px 宽的导图「根本看不清」——适应窗口后缩到 20%，标签还溢出节点框。

## 计划

- [x] 全屏查看：工具栏「全屏」把导图 Teleport 到 body 覆盖整窗，Esc 退出，滚动锁住。
      验：`npm test -- src/renderer/components/ReaderMindmap.ui.test.ts`（全屏开关 + Esc 用例）→ 全绿
- [x] 缩放范围/复位：最小缩放 0.2 → 0.08，复位改成以视口中心缩回 100%（不再跳左上角）；
      视口尺寸变化（全屏切换 / 窗口缩放）在未手动调整时自动重新适应。
      验：`npm test -- src/renderer/pages/readerMindmapCanvas.test.ts` → 全绿
- [x] 节点标签折行：按全角/半角权重重排成最多 3 行，节点高度随行数增长，树布局改为「子树高度」
      自底向上排，避免父节点与兄弟重叠。
      验：`npx vitest run src/renderer` → 全绿
- [x] 真实应用端到端：夹具书库 → 阅读器 → 抽屉 → 导图 → 全屏 / 放大 / 适应。
      验：`npm run build && node scripts/mindmap-fullscreen-e2e.mjs` → 全通过
- [x] 类型检查与收口：`npm run typecheck` 0；`npm run plan:status` 0。
