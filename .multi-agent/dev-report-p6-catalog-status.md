# 开发报告：reader-catalog-status-20260908 r1

战役目标：目录显示未下/失败/空/当前/已读。已与 P5 一并合入 `master` `1996386`（未 push）。

## 分支与提交

| 项 | 值 |
|---|---|
| 默认分支 | `master` / `1996386` |
| 交付 worktree | `/home/goot/cod/xs/xsxz/.dsh/worktrees/session-34919e4b` |
| 交付分支 | `agent/session-34919e4b` |
| 最终 HEAD | `1996386` |

| 切片 | 状态 | commit |
|---|---|---|
| P5 选区跟随（基线） | ✅ 未合入 | `bae107e` |
| P6.1 徽章纯函数 | ✅ | `a09a518` |
| P6.2 目录接线 | ✅ | `f176d5a` |
| P6.3 收口 | ✅ | `1996386` |

回滚：`git revert` 对应提交，或丢弃 `agent/session-34919e4b`。

## 验证

| 切片 | 命令 | 退出码 |
|---|---|---|
| P6.1 | helper 44 + npm test 543 + build | 0 |
| P6.2 | 45 + npm test 544 + build | 0 |
| P6.3 | 45 + npm test 544 + build | 0 |

未改 preload / types / 新 IPC。未改 ReadingProgress 落盘。

## 行为摘要

- 优先级：失败 > 未下 > 空 > 当前 > 已读
- 当前 = 打开中的章；已读 = 进度章之前的 ready 章
- 失败仍可用 FAIL_CODE_ZH；`.ch-item.active` 保留

## TEST_DEBT

- 未手测目录抽屉过滤后的徽章
- 未做 Electron e2e

## 未做

- 未 push
- 未做真分页

## 合入建议（需用户授权，含 P5+P6）

```
git checkout master
git merge --ff-only agent/session-34919e4b
```
