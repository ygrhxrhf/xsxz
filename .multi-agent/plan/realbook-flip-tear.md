# 计划：真实书籍翻页起手「先撕开再翻页」

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工（未勾项 + 脏工作区都会让它失败）。

## 目标

真实书籍翻页从起手到落定始终是一张连续的纸：不再先在外缘裂出一条竖缝、
露出下一页，再开始翻转。

## 步骤

- [x] 1. 复现：真实 Electron 慢动作截起手 0/3/7/12/20/30% 七帧
      - 验：`$env:SPBF_SLOW_FLIP='1'; $env:SPBF_KEEP_SHOTS='1'; node scripts/.tmp-realbook-flip-frames.mjs` → 修复前起手 12% 帧可见纸顶被裁出横缝、下面静态页从缝里露出；同帧右缘也先裂开一条竖缝
- [x] 2. 定位：对照截图、`flipPoses` 的 x/z 与起手角度分布，确认分层判据
      - 验：`npx vitest run src/renderer/pages/realBookFlip.test.ts` → 修复前基线通过，确认几何本身连续，问题出在渲染裁切与转轴
- [x] 3. 设计：起手阶段保持整页覆盖，只有纸角抬起时才逐步让出下面一页
      - 验：设计结论写在本文件「定位结论」
- [x] 4. 实现：只改 `src/renderer/pages/realBookFlip.ts`、`src/renderer/pages/RealBookStage.vue` 及其测试
      - 验：`npm run typecheck` → exit 0
- [x] 5. 测试：补「起手不得露出底下页」的回归
      - 验：`npx vitest run src/renderer/pages/realBookFlip.test.ts src/renderer/pages/RealBookStage.ui.test.ts src/renderer/pages/Reader.realBook.ui.test.ts` → 3 文件 / 59 用例全绿
- [x] 6. 真机验证：重建后按同一慢动作脚本截同一组帧
      - 验：`npm run build` 后重跑慢动作截图 → 12% / 20% 帧纸顶、纸底连续覆盖，无横缝；右缘不再在起手阶段先裂出底下页
- [x] 7. 提交与断点：只暂存本任务文件，更新 HANDOFF
      - 验：`git log --oneline -1` → 本任务提交；在该提交的干净 worktree 跑 `node scripts/plan-status.mjs` → exit 0

## 不做（显式出范围）

- 不改分页算法、书厚、俯仰与底部工具栏。
- 不重写真实书籍渲染层，不追求逐像素物理仿真。
- 不碰工作区里其他未提交改动。

## 已知边界

- 半页宽度 600px 附近、1365×768 视口下验收；其他字号/视口只做单测约束。
- 翻页中的纸张纹理与光照沿现有实现，不新增贴图或 native 依赖。

## 定位结论

- 根因一：`flipSlices` 给每条竖带下发 `clip-path`，把纸的上下缘**向内**裁掉
  （外缘最多 16px）。被裁掉的地方没有纸，直接透出下面的静态页；起手纸还没明显
  转动，上下各一条横缝已经先出现，读起来就是「先撕开」。
- 根因二：`.real-book-flip` 固定在 `left:50%`（书心正中）。书心实际占 14px，
  右页装订边在中心线 +7px、左页在 −7px；翻动页以书心正中为轴时，起手就比本页
  少覆盖 7px，右缘先露出下面那页的一条竖缝。
- 修法：竖带保持整页高度，不再下发 `clip-path`；翻动页按方向把转轴放到本半页
  的装订边（中心线 ±7px）。不动分页、书厚与俯仰。

## 断点记录（每次停下前更新）

- 状态：已提交（`fix(reader): 修复真实书籍翻页起手先撕开的分层`）
- 下一步第一条命令：无（本任务完成）
- 未验证项：真实用户视口下的连续肉眼观感（已用确定性慢动作帧代替）；`scripts/realbook-flip-fps-e2e.mjs` 非慢动作收尾有既有 `shotDir` 未定义异常（核心 9 项检查仍全过）
