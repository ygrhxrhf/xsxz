# HANDOFF — 新会话第一件事读这里

> 规则：每次停手前更新本文件。写「做到哪、下一步第一条命令、未验证项」，
> 不写「差不多完成」这类没法验证的话。

## 现在

- 任务：整站镜像（分类页 → 批量入书库）
- 状态：**代码完成、验证通过、本地领先 `origin/master` 5 个 commit，未推送**
- 计划与证据：`.multi-agent/plan/mirror-site.md`
- PR 正文：`.multi-agent/pr-mirror-2026-10-20.md`、`.multi-agent/pr-mirror-wall-2026-10-20.md`
- 审查报告：`.multi-agent/reviews/review-b.md`（BLOCKER/MAJOR 已收口，见下）

## 下一步（按顺序）

1. `npm run plan:status` —— 必须是「可以收工」，否则先补
2. `git push gitee master`（本机无 `gh`；GitHub 远端走 SSH `origin`）
3. 推送后把 PR 正文贴到 Gitee / GitHub 的 PR 页
4. 真站手测一遍：选一个分类页镜像 3 本，确认跳过与续跑

## 已验证的证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck` | 0 |
| 单测 | `npx vitest run` | 135 文件 / 1236 通过 |
| 构建 | `npm run build` | 0 |
| 端到端 | `node scripts/mirror-e2e.mjs` | 19/19 PASS（含撞墙 6 秒内停批） |

## 审查 B 收口（2026-10-21）

| 级别 | 问题 | 处理 |
|---|---|---|
| BLOCKER | 镜像与下载互斥只有单向，会并发驱动同一个隐藏视图 | `0ee14e6`：`setExternalBusyProbe` 让 `isDownloadBusy` 算上镜像；两个 start 入口分辨提示；界面双向禁用 |
| MAJOR | `mirror-state.json` 非原子写，截断即丢 plan | `0ee14e6`：改 `atomicWriteText` |
| MINOR | resume 无待办仍返回 ok | `ff38d38`：只跑未完成书目，全done 返回 `{ok:false}` |
| MINOR | 旧索引被当增量基底写回 v2 | `e8c34da`：先整体重建，重建不出就跳过增量 |
| MINOR | before-quit 没取消镜像 | `0ee14e6`：补 `cancelMirror()` + 释放预取视图 |
| MINOR | 启动降级写可能覆盖新任务 | `0ee14e6`：写回前复查 `running` |
| MINOR | 文档说 UI 按 `interrupted` 判断 | `0ee14e6`：文档改为按 plan/results 推导 |
| MINOR | seedUrl 仅前缀校验 | 不修：评估不引入新 SSRF 面 |

## 未验证 / 风险

- 只测了本地夹具站，没有真实站点数据
- 撞墙即停批：处理墙要用户自己来，镜像不会自动解锁
- 两个模型出了审查报告（judgment / scout），`gpt-6-luna` 两次 runtime error 未产出

## 历史坑（别再踩）

- **turn 边界即停**：长任务开工先挂 goal，否则上下文一断就没人接着跑
- **脏工作区 = 没有断点**：`ff527ed` 那次改动在盘上躺了 9 分钟才被提交
- **一个 worktree 一个写者**：这次实际出现过第三个写入方——`ff527ed`、`f5d49e5` 和 11:20 对 `mirror.ts` 的改动都不是主 Agent 写的。现象是「我正要提交，文件已经被别人提交掉了」。对策：动手前 `git status` + `git log -1` 对账，出现来源不明的提交先停手问人
- **子代理只信文件**：不给文件路径、只让它「回复结论」，那么它 error/超时=白跑（本任务三个审查模型只回来一个）

## 2026-10-21 10:25 工作区已修复

- 2026-10-20 下午第三方留下的 9 个文件已收口并分成 3 个可验证提交：
  - `e8c34da` 旧索引先重建再写增量补丁（library）；
  - `0ee14e6` 镜像与下载双向互斥、`mirror-state.json` 原子写、退出时取消（download/index/Browse/契约/磁盘文档）；
  - `ff38d38` 续跑只处理未完成书目，总数按待办算（mirror + 单测，含 2 条原本红的用例）。
- 验证：`npm run typecheck` 0；`npx vitest run` 135 文件 / 1236 通过；`npm run build` 0；`node scripts/mirror-e2e.mjs` 19/19（撞墙 7088ms 停批）；`npm run plan:status` 见提交后结果。
- 下一步：要交付就 `git push gitee master`；再挑一个真实分类页手测 3 本。
- 若第三方写者再出现，先 `git status --short; git log --oneline -3` 对账，不要在来源不明的改动上继续加码。
- 流程评估：`.multi-agent/pstack-flow-eval-2026-10-20.md`；对抗审查：`.multi-agent/reviews/review-A-mirror-wall-2026-10-20.md` 与 `review-b.md`。
