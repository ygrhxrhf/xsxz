# 开发报告：reader-true-pagination-20260908 r1

战役目标：把「屏幕翻页」从 90% 视口重叠滚动升级为视觉整页吸附；正文坐标不变。已合入 `master` `53ba222`。未 push。

## 分支与提交

| 项 | 值 |
|---|---|
| 默认分支 | `master` / `53ba222` |
| 来源分支 | `agent/session-201c674a` |
| 合入 | 导演 `git merge --ff-only`（P3.1/P3.2/P3.3 各一次） |

| 切片 | 状态 | commit |
|---|---|---|
| P3.1 视觉页纯函数 | integrated | `c90f589` |
| P3.2 Reader 接线 | integrated | `5edd26d` |
| P3.3 契约收口 | integrated | `53ba222` |

回滚：`git revert 53ba222 5edd26d c90f589`。

## 验证

| 切片 | 命令 | 结果 |
|---|---|---|
| P3.1 | pager 15 + npm test 561 + build | PASS 退出码 0 |
| P3.2 | 24 + npm test 561 + build | PASS 退出码 0 |
| P3.3 | 26 + npm test 563 + build | PASS 退出码 0 |

未改 preload / types 字段 / 新 IPC / ReadingProgress。禁止 v-html 与 CSS 多栏。

## 行为摘要

- `readingMode === 'screen'`：按 `clientHeight` 整页 `scrollTo`，显示「第 x / y 页」
- `readingMode === 'scroll'`：连续滚动；Space/J/K 仍 `clientHeight * 0.9`
- 落盘仍 `chapterScrollRatio`；恢复后 screen 吸附最近页
- 划线仍用规范化正文 start/end

## TEST_DEBT

- 未手测窗口缩放时页码浮层是否被裁切
- 未做 Electron e2e
- 全量测试中 `readerPerf` 偶发 `plainDecorateMs>100`（既有 P2.3 抖动，本战役未改渲染）

## 未做

- 未 push
- 未做 CSS 多栏真分页
- 未改段落坐标进度
