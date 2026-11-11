# 计划：真实书籍弧面排版裁决

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工。

## 目标

把留档的 RealBookArcPage/realBookArcText 接进真实书籍书页（可开关），用真机截图对比「平面竖带 / CSS 竖条 / SVG 弧面」，按证据决定合并或删除，消除悬而未决的实验状态。

## 步骤

- [x] 1. 接入可开关弧面模式：RealBookStage 增加会话级开关（不进 settings），开启时左右页正文改用 ArcPage 渲染，输入为本页 pieces（paragraphs + paragraphIndexes + paragraphRanges），保留 `g[data-p]` 供选择/划线
      - 验：`npm run typecheck` → 退出码 0（已跑，EXIT:0）
      - 工具条「弧面」按钮可切换 `ENABLE_ARC_TEXT`（aria-pressed），`RealBookArcPage bare` 只画正文，纸面/眉脚仍由书页提供
- [x] 2. 单测不回归：现有 realbook 相关 vitest 全绿
      - 验：`npx vitest run src/renderer/pages/realBookArcSelection.test.ts src/renderer/pages/realBook*.test.ts --maxWorkers=6` → 全部通过
      - 实跑：8 个文件 80 用例全通过（realBookArcSelection/ArcText/Flip/Measure/Notes/Pager/Pitch/Spine），EXIT:0
- [x] 3. 真机截图对比：CDP e2e 起真实 Electron，同一夹具书分别截「平面（现状）」与「弧面」整页图，检查弧面文本节点存在、划线区间可用、无横向溢出
      - 验：`node scripts/realbook-arc-e2e.mjs` → 产出 PNG 到 `.multi-agent/acceptance/arc-2026-11-11/`，断言全 PASS
      - 实跑：14/14 断言 PASS，产出 `realbook-flat.png` / `realbook-arc.png`（`.gitignore:12` 忽略 `.multi-agent/**/*.png`，截图不入库，结论以文字留档）
      - 目视结论：`realbook-flat.png` 两页正文排布干净；`realbook-arc.png` 字被 `textLength` 按弧面带宽度拉伸成巨型字形、行与行重叠、右缘裁切、左页整页空白（弧面分支缺 `real-book-empty` 空态）——弧面不可用
- [x] 4. 按证据裁决：合并（接稳/接修）或删除（删 Valley 竖条实验与/或 ArcPage），结论写进本文件与 HANDOFF
      - 验：`git log --oneline -3` 出现裁决提交
      - 裁决：**删除**。根因是 `layoutArcRuns` 给每个弧面带分配整段几何宽度，再用 `<text textLength lengthAdjust="spacingAndGlyphs">` 把该带文字横向拉满——未占满所有带的行（如段末短行）字被撑成巨型；叠加此前两次 3D 竖带失败（投影宽度对不上中线），弧面路线在本仓库没有可交付版本
      - 已删：`RealBookArcPage.ts`、`realBookArcText.ts` 及两份测试、`realBookFlip.ts` 的 `valleyBands`/`ValleyBand`/`ValleyBandOptions`、`RealBookStage.vue` 的弧面开关按钮与谷竖带层及配套 CSS、`scripts/realbook-arc-e2e.mjs`、`scripts/tmp-arc-*`
      - 保留：平面 `.real-book-para` 渲染、`realBookMeasure`（分页器依赖）、`spineValleyPoses`（中缝谷带测试仍覆盖）
      - 验证：`npm run typecheck` → EXIT:0；`npx vitest run src/renderer/pages/realBook*.test.ts src/renderer/pages/Reader.realBook.ui.test.ts --maxWorkers=6` → 7 文件 83 用例全通过，EXIT:0
      - 全量：`npx vitest run src --exclude .delta/ --exclude .qoder/ --maxWorkers=6` → 177 文件 1840 用例全通过，EXIT:0；`npm run build` → EXIT:0

- [ ] 5. 收工自检
      - 验：`npm run plan:status` → 退出码 0

## 不做（显式出范围）

- 弧面模式不做批注卡片排版（notes 不进 SVG）
- 不动翻页动画渲染路径
- 不改 settings 持久化结构

## 已知边界

- ArcPage 量测元素固定 textIndent 2em，续段（para-continued 切片）会有错误缩进——裁决时计入
- 弧面曲线主要来自靠脊基线下沉（dip），横向压缩量较小

## 断点记录（每次停下前更新）

- 状态：已裁决（删除弧面实验），待提交与收工自检
- 下一步第一条命令：`git add -A && git commit` 记录裁决，再 `npm run plan:status`
- 未验证项：步骤 5（收工自检）
