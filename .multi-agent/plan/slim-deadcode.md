# 计划：死代码与死类型清理（瘦身第一层）

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工（未勾项 + 脏工作区都会让它失败）。

## 目标

删掉全仓没有任何引用的代码，并把「只在本文件用」的导出收窄为非导出；运行时行为零变化，`npm run typecheck` / `npm test` / `npm run build` 全绿，`npx knip` 在 `src/` 下不再报未用导出与未用类型。

## 基线（2026-11-23，开工前实测）

- `npx knip@5 --reporter json`：`src/` 下未用导出的名字 129 个、未用导出类型 180 个，分布 105 个文件。
- `npm test` 基线：199 文件 / 2014 用例全绿。
- `npm run plan:status`：exit 0（既有计划项全部完成，工作区干净）。
- 完全无引用的文件 2 个（含注释、脚本、docs 全仓 grep 确认）：
  `src/renderer/pages/realBookPeel.ts`（98 行）、`src/renderer/pages/realBookFlipShadow.ts`（211 行）。

## 步骤

- [ ] 1. 落盘计划与基线
      - 验：`git status --short` → 只有本文件与本轮改动
- [ ] 2. 删两个死文件及其测试（`realBookPeel.ts|.test.ts`、`realBookFlipShadow.ts|.test.ts`）
      - 验：`grep -rn "realBookPeel\|realBookFlipShadow" src scripts docs` → 无输出
      - 验：`npm run typecheck` → exit 0
- [ ] 3. 删 33 处零引用导出与类型（22 个文件，含 4 个零引用类型）
      - 验：`npm run typecheck` → exit 0
      - 验：`npx vitest run src/renderer/pages/referenceBook src/main/library.test.ts src/main/webShelf.test.ts src/main/paywallUnlock.test.ts src/main/syncCloud.test.ts src/main/ocrText.test.ts src/main/mirror.test.ts` → 全绿
- [ ] 4. 收窄导出面：去掉「只在本文件用」的 `export` 关键字（约 280 处，105 文件）
      - 验：`npx knip@5 --reporter compact` → `src/` 下无未用导出与未用类型条目
      - 验：`npm run typecheck` → exit 0
- [ ] 5. 全链路验证与收尾
      - 验：`npm run typecheck && npm test && npm run build` → 全 exit 0，用例数 = 2014 − 11
      - 验：`npm run plan:status` → exit 0
      - 验：`.multi-agent/HANDOFF.md` 已更新本轮断点

## 不做（显式出范围）

- 不压 `src/renderer/public/atlas/*.json`（14 MB）、不动 `resources/*.traineddata.gz`（4.5 MB）——用户要求地图与资产原样。
- 不清理 `.multi-agent/` 探针与 `docs/img` 证据体积。
- 不拆 `Reader.vue` / `Browse.vue` / `main/index.ts` 等超大文件。
- 不砍任何可选子系统（订阅代理、MCP agent 桥、云同步与规则市场、付费墙、OCR）。
- 不改 `src/shared/types.ts`（knip 报 0 条，契约本身干净）与 `docs/ipc-contract.md`。
- 不修 `atlas/hydrology.test.ts` 未声明的 `@maplibre/maplibre-gl-style-spec`（要改 lockfile + 联网装包）。
- 不 push，不开 PR。

## 已知边界

- knip 的三条 `package.json` 依赖误报（`lxgw-wenkai-screen-webfont` 走 CSS 导入、`tesseract.js` 动态 `import()`、`@modelcontextprotocol/sdk` 只在 `scripts/` 用）与四个入口文件误报（`App.vue`、`renderer/main.ts`、`preload/index.d.ts`、`renderer/env.d.ts`）保留，原因写进 HANDOFF。
- 第 4 步 diff 面宽（105 文件）但零运行时变化，独立提交以便单独回滚。

## 断点记录（每次停下前更新）

- 状态：进行中
- 下一步第一条命令：
- 未验证项：
