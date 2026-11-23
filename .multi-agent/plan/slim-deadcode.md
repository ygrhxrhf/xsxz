# 计划：死代码与死类型清理（瘦身第一层）

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工（未勾项 + 脏工作区都会让它失败）。

## 目标

删掉全仓没有任何引用的代码，并把「只在本文件用」的导出收窄为非导出；运行时行为零变化，`npm run typecheck` / `npm test` / `npm run build` 全绿，`npx knip` 在 `src/` 下不再报真正的死导出与死类型。

## 基线（2026-11-23，开工前实测）

- `npx knip@5 --reporter json`：`src/` 下未用导出的名字 129 个、未用导出类型 180 个，分布 105 个文件。
- `npm test` 基线：199 文件 / 2017 用例全绿（比上一轮 HANDOFF 记的 2014 多 3 个用例）。
- `npm run plan:status`：exit 0（既有计划项全部完成，工作区干净）。
- 完全无引用的文件 2 个（含注释、脚本、docs 全仓 grep 确认）：
  `src/renderer/pages/realBookPeel.ts`（98 行）、`src/renderer/pages/realBookFlipShadow.ts`（211 行）。

## 步骤

- [x] 1. 落盘计划与基线（commit `3fffdd2`）
      - 验：`git log --oneline -1` → `chore(plan): 死代码与死类型清理计划与基线`
- [x] 2. 删两个死文件及其测试（`realBookPeel.ts|.test.ts`、`realBookFlipShadow.ts|.test.ts`），并修正 `docs/真实书籍-WebGL复刻.md` 里指向它们的两处描述（commit `9ce5809`）
      - 验：`grep -rn "realBookPeel\|realBookFlipShadow" src scripts docs` → 无输出
      - 验：`npm run typecheck` → exit 0
      - 验：`npx vitest run src/renderer/pages/` → 75 文件 / 622 用例通过（删掉 11 个用例）
- [x] 3. 删 30 处零引用导出与类型（22 个文件，−288 行），并清掉删除残留的无用 import 与局部变量（commit `a89e060`）
      - 验：`npm run typecheck` → exit 0
      - 验：`npx tsc --noEmit -p tsconfig.node.json --noUnusedLocals | grep 改动文件` → 无新增
      - 说明：实际 30 处（原估 33）；判据改成「全仓任何文件（含 .vue、scripts、docs）都不出现该名字」，
        knip 原始清单里有 14 处其实是跨行 import 的真用法。
- [x] 4. 收窄导出面：去掉「只在本文件用」的 `export` 关键字，256 处 / 94 文件（commit `e4e4ef9`），再清掉 knip 剩余 7 处死符号（commit `9900dfa`）
      - 验：`npx knip@5 --reporter json` → `src/` 下未用导出 7、未用类型 7（开工时 129 + 180），
        剩余 7 项逐条核过都是 knip 漏解析的真用法
      - 验：`npm run typecheck` → exit 0
- [x] 5. 全链路验证与收尾
      - 验：`npm run typecheck` → exit 0
      - 验：`npx vitest run --maxWorkers=4` → 197 文件 / 2006 用例全绿（基线 2017 − 删掉的 11）
      - 验：`npm run build` → exit 0
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

- knip 的三条 `package.json` 依赖误报（`lxgw-wenkai-screen-webfont` 走 CSS 导入、`tesseract.js` 动态 `import()`、`@modelcontextprotocol/sdk` 只在 `scripts/` 用）与四个入口文件误报（`App.vue`、`renderer/main.ts`、`preload/index.d.ts`、`renderer/env.d.ts`）保留。
- knip 会漏掉 `.vue` 里的跨行 import 与行内 `import('...')` 类型断言，只能当候选生成器用，落地前必须自己再核一遍。
- 两个慢用例在满并发下会超时（`aiEvidenceIndex.test.ts` 60s、`browseState.test.ts` 20s）。单独跑分别 9.2s / 5.4s 通过，
  `--maxWorkers=4` 下全绿；属既有负载敏感 flaky，与本轮改动无关（这两个模块本轮没有逻辑改动）。

## 断点记录（每次停下前更新）

- 状态：已完成（待用户决定是否推送）
- 下一步第一条命令：`git push origin master`（需用户点头）
- 未验证项：未在干净机器上重装验证；未跑 e2e（本轮只动类型与导出可见性，没有行为面）
