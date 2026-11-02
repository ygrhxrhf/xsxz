# HANDOFF

## 当前事实

- 战役 quiet-reading-20261023 进行中；Goal 已恢复，并已更新为全部完成验收后推送 master 至已配置上游。用户授权原话：开发完成后，直接推送。
- master HEAD：6a05226。产品文件干净。
- **大章窗口化战役（4 大章节全量排版 20.2s、后段滚动空白）已收尾**：
  - `a844bea` 占位估算/窗口定位纯函数 + 单测
  - `ff7604c` 大章节窗口化渲染（拖动进度条毫秒级落点，后段不再空白）
  - `e02995a` 修复 recenterWindowTo spot=null 放弃补偿 → 按目标段真实 DOM 几何补偿 + shift>=1800 早退
  - `6a05226` 手动回归证据归档（raf-probe13 9/9 通过）
- 回归探针 raf-probe13 覆盖：睡眠模式、压暗遮罩、目录抽屉、屏幕翻页，全部零回归；翻页后大章窗口 240 段有界。
- 证据目录：`.multi-agent/evidence/large-chapter-window-2026-11-02/`（probe-window 18/18 + raf-probe13 9/9）
- 探针修正要点（若后续再跑 raf-probe13）：
  - 翻页前必须确认 `.n-drawer === null`（抽屉未关会让 anyDrawerOpen() 吞掉空格）与 `.bottom-panel === null`（字体面板同理）
  - smooth 滚动是异步动画，轮询等 scrollTop 前移 ≤2.5s，勿固定 sleep
- worktree `.delta/worktrees/{8f792tj3eq1d,sb3j3p5netq9}` 与 master 同步（6a05226）。
