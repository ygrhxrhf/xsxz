# HANDOFF — 新会话第一件事读这里

> 规则：每次停手前更新本文件。写「做到哪、下一步第一条命令、未验证项」，
> 不写「差不多完成」这类没法验证的话。

## 现在

- 任务：整站镜像（分类页 → 批量入书库）
- 状态：**代码完成、验证通过、已提交 14 个 commit，未推送**
- 计划与证据：`.multi-agent/plan/mirror-site.md`
- PR 正文：`.multi-agent/pr-mirror-2026-10-20.md`

## 下一步（按顺序）

1. `npm run plan:status` —— 必须是「可以收工」，否则先补
2. `git push gitee master`（本机无 `gh`；GitHub 远端走 SSH `origin`）
3. 推送后把 PR 正文贴到 Gitee / GitHub 的 PR 页
4. 真站手测一遍：选一个分类页镜像 3 本，确认跳过与续跑

## 已验证的证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck` | 0 |
| 单测 | `npx vitest run` | 135 文件 / 1229 通过 |
| 构建 | `npm run build` | 0 |
| 端到端 | `node scripts/mirror-e2e.mjs` | 13/13 PASS |

## 未验证 / 风险

- 只测了本地夹具站，没有真实站点数据
- 章节撞墙时单本最多静默等 30 分钟（契约已记）
- 审查只拿到 1 个模型的报告（`gpt-6-luna` 两次 runtime error、`mimo` 超时）

## 历史坑（别再踩）

- **turn 边界即停**：长任务开工先挂 goal，否则上下文一断就没人接着跑
- **脏工作区 = 没有断点**：`ff527ed` 那次改动在盘上躺了 9 分钟才被提交
- **一个 worktree 一个写者**：这次实际出现过第三个写入方——`ff527ed`、`f5d49e5` 和 11:20 对 `mirror.ts` 的改动都不是主 Agent 写的。现象是「我正要提交，文件已经被别人提交掉了」。对策：动手前 `git status` + `git log -1` 对账，出现来源不明的提交先停手问人
- **子代理只信文件**：不给文件路径、只让它「回复结论」，那么它 error/超时=白跑（本任务三个审查模型只回来一个）

## 2026-10-20 12:20 停机对账（pstack 实测）

- `10efaa7` 已提交「撞墙停批 + 等待期取消」；`7edb55f` 补 `getPausedForHuman` 的单测探针。验证绑定 `10efaa7`：单测 1234/1234、e2e 19/19、撞墙 5917ms 停批。
- 之后工作区被第三方写者改写：`index.ts`、`mirror.ts`、`mirror.test.ts`、`library.ts`、`Browse.vue`、`docs/disk-schema.md`、`docs/ipc-contract.md` 未提交；12:17 `mirror` 2 条红；12:20 `npm run build` 因 `Browse.vue:1503` 语法错误红。
- 下一步第一条命令：`git status --short; git log --oneline -3`。确认第三方是否还在写；**不要在脏树上继续加码**。
- 恢复后重跑：`npm run typecheck` → `npx vitest run` → `npm run build` → `node scripts/mirror-e2e.mjs` → `npm run plan:status`。
- 流程评估：`.multi-agent/pstack-flow-eval-2026-10-20.md`；对抗审查：`.multi-agent/reviews/review-A-mirror-wall-2026-10-20.md`。
