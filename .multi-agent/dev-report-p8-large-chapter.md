# 开发报告：reader-large-chapter-20260908 r1

战役目标：确认 P7 在默认分支，并按 P2.3 政策决定是否上大章优化。已完成。未 push。

## 分支与提交

| 项 | 值 |
|---|---|
| 默认分支 | `master` / `e9f9a08` |
| 合入 | P7 已由导演 ff；本战役无新业务 commit |

| 切片 | 状态 | 证据 |
|---|---|---|
| BASE P7 | ✅ | `e9f9a08` |
| P8.1 万段测量 | ⏭️ 已有 | `src/renderer/pages/readerPerf.test.ts`；政策 `gate-not-triggered-do-not-optimize` |

回滚：P7 为 `git revert e9f9a08 c84e494`。测量模块属既有 P2.3，不在本战役回滚。

## 验证

既有 `readerPerf.test.ts`：1 万段 `plainDecorateMs≈50`，门限 100ms 未触发。按 2026-08-31 决策不上虚拟化。

## TEST_DEBT

- 未手测滚动时双进度条宽度联动
- P5–P7 未补 Electron e2e
- 大章测量只覆盖 decorate，不覆盖真实 DOM 挂载/滚动

## 未做

- 未 push
- 未做真分页
- 未改 `ReadingProgress`
