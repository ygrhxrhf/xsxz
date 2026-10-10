# 过期 worktree 清理留痕（2026-10-10）

清理对象：`.dsh/worktrees/` 下 11 个历史会话工作树及其 `agent/*` 本地分支。
清理方式：`git worktree remove --force` + `git worktree prune` + `git branch -D`。
回收空间：约 1.5G（其中 `session-68bf4330` 单体 671M，主要是各自的 `node_modules`）。

## 判定依据

清理前逐个比对分支与 `master` 的提交关系（`git rev-list --left-right --count master...<branch>`），
并对 3 个相对 master 有独有 sha 的分支，用 `git patch-id --stable` 逐一校验其提交与本仓库
master 上同名提交的补丁内容是否等价。结论：**不存在只存在于这些分支的工作**。

| worktree | 分支 | 末位 sha | master 领先 / 分支领先 | 结论 |
|---|---|---|---|---|
| campaign-reader-p2 | agent/campaign-reader-p2 | a91643d | 81 / 0 | 纯落后 |
| session-201c674a | agent/session-201c674a | 53ba222 | 60 / 0 | 纯落后 |
| session-251d113b | agent/session-251d113b | 2eb32ed | 78 / 0 | 纯落后 |
| session-34919e4b | agent/session-34919e4b | e9f9a08 | 63 / 0 | 纯落后 |
| session-4336bb3e | agent/session-4336bb3e | 9c68310 | 71 / 0 | 纯落后 |
| session-4f46eb55 | agent/session-4f46eb55 | f27b57f | 5 / 0 | 纯落后 |
| session-59ad00a9 | agent/session-59ad00a9 | 08fe07f | 85 / 1 | 独有提交 patch-id 等价 |
| session-643da0f2 | agent/session-643da0f2 | bfcb8d1 | 97 / 4 | 独有提交 patch-id 等价 |
| session-68bf4330 | agent/session-68bf4330 | 31e23ff | 168 / 1 | 独有提交 patch-id 等价 |
| session-ccff2241 | agent/session-ccff2241 | 47f15db | 44 / 0 | 纯落后 |
| session-e495e69a | agent/session-e495e69a | c6f0e67 | 51 / 0 | 纯落后 |

## patch-id 等价对照

| 分支上的提交 | master 上的同名提交 | patch-id |
|---|---|---|
| 08fe07f feat(U2.6): unify reader surfaces | b162300 | 相同 |
| bfcb8d1 docs(D1.2): document assistant budget events | 3e85c76 | 相同 |
| 1cca275 fix(D1.2): publish budgets on every AI request | 479c3b8 | 相同 |
| 7538642 fix(D1.2): align budgets with actual requests | 1593c60 | 相同 |
| bd86dc2 feat(D1.2): show assistant request budgets | 2b77885 | 相同 |
| 31e23ff test(U3.2): stabilize download cancellation contract | a958156 | 相同 |

即这些是 rebase 之后的残留副本，内容已随主线提交进入 master，删除不丢工作。

## 随 worktree 一并丢弃的未提交内容

各工作树的未提交项只有三类，均无手工成果：本轮改过的 4 个范围文档（主仓已另行提交）、
构建生成物（`electron.vite.config.*.mjs` 二十余个、`chi_sim/eng.traineddata`、
`vite.preview.config.ts`）、以及误建的 Windows 路径目录 `"D:\spbf\library"` 与 `node_modules`。

## 保留项

- `stash@{0}` 未动：`WIP on agent/session-4f46eb55: 8d5d7de`，基线 `5e2198d`（2026-09-29），
  内容为 `src/renderer/styles.css` 的 9 行增量。stash 保存在仓库级 `refs/stash`，与 worktree
  无关，删除工作树后仍可 `git stash show -p 'stash@{0}'` 查看。待人工核对后决定是否丢弃。
- `.dsh/design-skills`、`.dsh/impeccable-source`、`.dsh/workflow-presets` 为会话资产，未清理。
