# 计划：工作区积压提交清理

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。

## 目标

把 2026-11-09/10 三轮真实书籍工作（页内批注、翻页竖缝、弧面实验）从工作区落成分笔提交，
补断点记录，使 `npm run plan:status` 退出码 0。

## 步骤

- [x] 1. 全量回归确认当前工作区为绿
      - 验：`npm run typecheck`、`npx vitest run src --exclude .delta/ --exclude .qoder/ --maxWorkers=6`、`npm run build` → 全 0
- [x] 2. 提交翻页竖缝线（翻页/书脊核心 + 慢动作 e2e + 报告与证据）
      - 验：`git log --oneline -1` → `d1091da`，16 文件；全量回归已在本轮开头跑过（179 文件 / 1858 用例）
- [x] 3. 提交页内批注线（偏好/IPC/分页/渲染/Reader 接线 + 文档）
      - 验：`git log --oneline -1` → `028e32f`，24 文件
- [x] 4. 提交弧面实验留档，删除纯日志与临时探针
      - 验：`git log --oneline -1` → `ab377a8`；`git status --porcelain --untracked-files=all` → 只剩 .gitignore / HANDOFF / 本计划
- [ ] 5. 更新 HANDOFF 与断点，`npm run plan:status` 退出码 0
      - 验：`npm run plan:status; echo $?` → 0

## 不做（显式出范围）

- 不改产品行为；本轮只整理提交与留档。
- 不把 `tmp-arc-*` 探针脚本与运行日志入库。

## 已知边界

- `RealBookStage.vue` 同时含两条线的改动，无法按文件干净切分：
  第 2 笔只提交纯翻页文件，舞台组件与其测试归入第 3 笔。
- 弧面实验未接入任何产品页面，提交仅为留档。
