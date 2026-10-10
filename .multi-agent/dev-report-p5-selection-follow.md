# 开发报告：reader-selection-follow-20260908 r1

战役目标：选区工具条跟随 Range 视觉矩形，而不是 mouseup 的 clientX/Y。未合入 `master`（仍为 `9c68310`），未 push。

## 分支与提交

| 项 | 值 |
|---|---|
| 默认分支 | `master` / `9c68310` |
| 交付 worktree | `/home/goot/cod/xs/xsxz/.dsh/worktrees/session-34919e4b` |
| 交付分支 | `agent/session-34919e4b` |
| 最终 HEAD | `bae107e` |

| 切片 | 状态 | commit |
|---|---|---|
| P5.1 定位纯函数 | ✅ | `2ae1813` fix(P5.1): add selection popup position helper |
| P5.2 Reader 接线 | ✅ | `6bf9f8d` feat(P5.2): position selection toolbar from range |
| P5.3 收口 | ✅ | `bae107e` test(P5.3): lock reader selection-follow wrap-up |

回滚：worktree `git revert` 对应提交，或丢弃 `agent/session-34919e4b`。

## 验证

| 切片 | 命令 | 退出码 | 报告 |
|---|---|---|---|
| P5.1 | helper 35 + npm test 533 + build | 0 | `test-reports/P5.1-*.md` |
| P5.2 | 契约 36 + npm test 534 + build | 0 | `P5.2-*.md` |
| P5.3 | 契约 36 + npm test 534 + build | 0 | `P5.3-*.md` |

未改 preload / types / 新 IPC。未修改受保护未跟踪项。

## 行为摘要

- `selectionPopupPosition`：优先选区下方，空间不足上方，水平居中并夹入视口。
- 工具条按 Range `getBoundingClientRect` + 360×40 定位。
- 备注编辑器按同一矩形 + 340×220 重算。
- 滚动 / 换章 / Esc / 空选仍关闭。
- 不再使用 `e.clientX - 120` / `e.clientY + 12`。

## TEST_DEBT

- 未手测触控板选区、跨段多行并集矩形、贴边窗口。
- P5.2-IMPL-1/2 无落盘 interrupt（实现延迟，非产品债）。
- P5.1-TEST-1 无落盘，由主 Agent 同列复跑。

## 未做

- 未合入 `master`、未 push
- 未做真分页 / 目录「已读」标签

## 合入建议（需用户授权）

```
git checkout master
git merge --ff-only agent/session-34919e4b
```
