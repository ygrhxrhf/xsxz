# 计划：Crafty 联动（把读书笔记推成文档）

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工（未勾项 + 脏工作区都会让它失败）。

## 目标

读者在 xsxz 里点一下「推送到 Crafty」，这本书的全书概览、人物与伏笔、章节笔记、划线批注
变成 Crafty 里的一篇文档；再点一次更新同一篇，不重复建。书库正文永不离开本机。

对端契约（craft 仓库已实现）：`POST /api/v1/import/markdown`，`Authorization: Bearer <写令牌>`，
body `{ folder?, files: [{ name, text, documentId?, parentDocumentId? }] }`，
回 `{ ok: true, documents: [{ id, title, created }] }`；令牌只读时 403 `read_only`，
`documentId` 不属于本人时 404 `not_found`。

## 步骤

- [x] 1. 契约字段：`src/shared/types.ts` 加 `CraftState` / `CraftPushResult`
      - 验：`npm run typecheck` → 0
- [x] 2. 纯函数：`src/main/craftMarkdown.ts` 生成笔记 Markdown（无 electron、无 fs）
      - 验：`npx vitest run src/main/craftMarkdown.test.ts`
- [x] 3. 客户端：`src/main/craftPush.ts`（配置 + 令牌 safeStorage + 推送 + 每书 `ai/craft-link.json`）
      - 验：`npx vitest run src/main/craftPush.test.ts`
- [x] 4. IPC：`src/main/craftIpc.ts` 三频道 + index.ts 接线 + preload 白名单
      - 验：`npx vitest run src/main/craftIpc.test.ts src/main/ipcChannels.contract.test.ts`
- [x] 5. 能力清单与文档：`agentCapabilities.ts` 三条 + `docs/agent-integration-design.md` §4.12.2
      + `docs/ipc-contract.md` 一节
      - 验：`npx vitest run src/main/agentCapabilities.contract.test.ts`
- [x] 6. 界面：`CraftPanel.vue` 挂进设置页；阅读器/书库的推送入口
      - 验：`npx vitest run src/renderer/pages/Settings.ui.contract.test.ts`
- [x] 7. 全量校验：`npm run typecheck && npm test`
      - 验：typecheck 退出码 0；`npm test` 2384 passed / 4 failed，4 条红全是既存漂移
        （`git stash push -u` 后同样 4 条红，与本轮无关：aiAssistantBudget / aiRecapIpc /
        aiContractSurface / Reader.pagination）。另有 browseState / atlasCities / aiEvidenceIndex
        偶发随机器负载红，重跑即过。

## 不做（显式出范围）

- 不推正文：书库 `chapters/*.json` 不上传，只推摘要与笔记。
- 不做 craft → xsxz 的反向拉取（阅读清单是下一件事）。
- 不做深链回原文（`spbf://book/...`，下一步）。
- 不碰 craft 的协同通道（hocuspocus/Yjs）。
