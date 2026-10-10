# 开发报告：reader-experience-p2-20260831 r1

战役目标：P2 导航、性能与无障碍。未合入 `master`（用户未授权自动合入）。

## 分支与提交

| 项 | 值 |
|---|---|
| 默认分支 | `master` / `b1623004e0068c6c6c2b8a9be4be13ae070b1652` |
| 交付 worktree | `/home/goot/cod/xs/xsxz/.dsh/worktrees/session-251d113b` |
| 交付分支 | `agent/session-251d113b` |
| 基线 | `agent/campaign-reader-p2` @ `a91643d`（含 P2.1） |

| 切片 | 状态 | worktree commit |
|---|---|---|
| P2.1 段落起读/快捷键/无障碍核验 | 本战役开始前已完成 | `a91643d` |
| P2.2 相邻章节空闲预读 | ✅ | `bd0d491` feat(P2.2): prefetch adjacent ready chapters |
| P2.3 大章性能测量与按证据优化 | ✅ | `bbcdaf2` feat(P2.3): measure large-chapter render cost |
| P2.4 无障碍及全量收口 | ✅ | `2eb32ed` test(P2.4): lock reader accessibility wrap-up |

回滚：在 worktree 上 `git revert` 对应 commit，或丢弃 `agent/session-251d113b`。预读删除 `readerPrefetch.ts` 接线即可；P2.3 仅测量模块；P2.4 回退 helper 抽取与契约测试。

## 验证

| 切片 | 命令 | workdir | 退出码 | 报告 |
|---|---|---|---|---|
| P2.2 | 定向 29 + `npm test` 505 + `npm run build` | session-251d113b @ bd0d491 | 0 | `.multi-agent/test-reports/P2.2-contract.md` `.multi-agent/test-reports/P2.2-build.md` |
| P2.3 | 定向 13 + `npm test` 507 + build | @ bbcdaf2 | 0 | `P2.3-contract.md` `P2.3-build.md` |
| P2.4 | 定向 33 + `npm test` 513 + build | @ 2eb32ed | 0 | `P2.4-contract.md` `P2.4-build.md` |

未改 `types.ts` / IPC / preload / main / schema / 依赖。未修改 `D:\spbf\library/` 与 `docs/reader-experience-upgrade.md`。

## 行为摘要

- **P2.2**：当前章成功后空闲预读相邻 `ready` 章，会话内存最多 2 项；命中跳过 `readChapter`；切书/改写/过期丢弃；预读不写进度。
- **P2.3**：1 万段合成章测量。独立跑 `plainDecorateMs` 约 34–92ms，门 100ms 未触发，**未改** `Reader.vue` 渲染。`npm test` 高负载下曾到 111ms 且 `shouldOptimize=true`，属测量抖动，不回溯改渲染。
- **P2.4**：`readerScrollBehavior(reduceMotion)` 可单测；契约钉死中文 aria、焦点、J/K/T/A/R/Esc/Space、reduced-motion CSS、标题 `min-width:0`。

## TEST_DEBT

- 本战役未重跑隔离 Electron 双窗口截图（历史工件在 `.multi-agent/e2e-artifacts/`）。P2.4 以 jsdom/源码契约代替现场 Electron。**不是产品 blocker**。
- P2.3 全量测试并行时 decorate 可超过 100ms；切片门以定向测量为准。

## 未做

- 未合入 `master`
- 未虚拟化大章
- 未新增 IPC/下载预读/持久化缓存
- 未新增方案稿以外快捷键

## 合入建议（需用户授权）

```
git checkout master
git merge --ff-only agent/session-251d113b
```

或审阅 `a91643d..2eb32ed` 后挑选合入。
