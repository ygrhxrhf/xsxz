# 开发报告：reader-focus-tts-20260908 r1

战役目标：可持久化行焦点（关/1/3/5 段）并与 TTS `spokenPara` / 视口中心段联动。未合入 `master`（用户未授权自动合入）。

## 分支与提交

| 项 | 值 |
|---|---|
| 默认分支 | `master` / `2eb32ed9199c249e29ef2011f66ac534ed9c325e` |
| 交付 worktree | `/home/goot/cod/xs/xsxz/.dsh/worktrees/session-4336bb3e` |
| 交付分支 | `agent/session-4336bb3e` |
| 最终 HEAD | `a555ec9115f4de0e861a7cf340d00c6e520e9f2a` |

| 切片 | 状态 | commit |
|---|---|---|
| P3.1 行焦点契约 | ✅ | `fb5b262` fix(P3.1): add reader focusMode contract |
| P3.2 外观与焦点窗 | ✅ | `f9bbe1c` feat(P3.2): render reader focus window |
| P3.3 视口锚点 | ✅ | `d0c5ab1` feat(P3.3): follow viewport focus anchor |
| P3.4 无障碍收口 | ✅ | `a555ec9` test(P3.4): lock reader focus-mode wrap-up |

回滚：在 worktree 上 `git revert` 对应 commit，或丢弃 `agent/session-4336bb3e`。

## 验证

| 切片 | 命令 | workdir | 退出码 | 报告 |
|---|---|---|---|---|
| P3.1 | settings 21 + npm test 514 + build | @ fb5b262 | 0 | `test-reports/P3.1-contract.md` `P3.1-build.md` |
| P3.2 | 定向 26 + npm test 519 + build | @ f9bbe1c | 0 | `P3.2-contract.md` `P3.2-build.md` |
| P3.3 | helper 27 + npm test 522 + build | @ d0c5ab1 | 0 | `P3.3-contract.md` `P3.3-build.md` |
| P3.4 | a11y 8 + npm test 523 + build | @ a555ec9 | 0 | `P3.4-contract.md` `P3.4-build.md` |

未改 preload / 新 IPC 频道。未修改 `D:\spbf\library/` 与 `docs/reader-experience-upgrade.md`。

## 行为摘要

- **P3.1**：`ReaderPrefs.focusMode` 默认 `off`；缺失/非法回退；旧字段保留。
- **P3.2**：外观「行焦点」关/1 段/3 段/5 段；朗读时窗外 `para-unfocused` opacity 0.4。
- **P3.3**：朗读优先 `spokenPara`，否则视口中心最近段；该路径不写进度。
- **P3.4**：源码契约钉死文案、降权 class、视口锚点与 reduced-motion。

## TEST_DEBT

- 未重跑隔离 Electron 双窗口截图。以 jsdom/源码契约代替。**不是产品 blocker**。
- P3.1-R1：settings 非法 `focusMode` 样例仅 `'huge'`（minor）。

## 未做

- 未合入 `master`、未 push
- 未做 `readingMode`、真分页、新快捷键、大章虚拟化

## 合入建议（需用户授权）

```
git checkout master
git merge --ff-only agent/session-4336bb3e
```
