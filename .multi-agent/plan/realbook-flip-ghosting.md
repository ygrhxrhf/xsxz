# 计划：真实书籍翻页鬼影修复

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工（未勾项 + 脏工作区都会让它失败）。

## 目标

真实书籍模式翻页中间态不再出现整页重影/鬼影，翻页过程与落定后的左右页内容一致。

## 步骤

- [x] 1. 调查 / 定位：对照截图、DOM 分层与翻动页显隐路径，确认鬼影来源
      - 验：`rg -n "real-book-flip-(face|back|slice)" src/renderer/pages/RealBookStage.vue` → 找到正反面合成与显隐相关代码
- [x] 2. 设计：按竖带转角在 90° 处整层停画正面，避免与背面叠出残影
      - 验：`rg -n "rb-flip-side" src/renderer/pages/RealBookStage.vue` → 正反面显隐相关代码
- [x] 3. 实现：仅修改 `src/renderer/pages/RealBookStage.vue`
      - 验：`npm run typecheck` → 通过
- [x] 4. 测试：真实书籍舞台、卷页几何、Reader 真实书籍用例
      - 验：`npx vitest run src/renderer/pages/RealBookStage.ui.test.ts src/renderer/pages/realBookFlip.test.ts src/renderer/pages/Reader.realBook.ui.test.ts` → 56 passed
- [x] 5. 真机验证：构建后用 Electron 截图检查翻页中态
      - 验：`npm run build` 后 `node scripts/realbook-flip-fps-e2e.mjs` → 10 项通过，中态截图无整页鬼影
- [x] 6. 提交：`fix(reader): 修复真实书籍翻页中间态重影`
      - 验：`git log --oneline -1` → `115a58c`

## 不做（显式出范围）

- 不改分页算法、不改书厚、不改俯仰交互。
- 不重写真实书籍渲染层。

## 已知边界

- 工作区原本就有其他未提交改动，本任务只改 `RealBookStage.vue` 与其测试，提交时只暂存这两个文件。

## 断点记录（每次停下前更新）

- 状态：已提交（工作区仍有其他未提交改动，与本任务无关）
- 下一步第一条命令：无（本任务完成）
- 未验证项：无
