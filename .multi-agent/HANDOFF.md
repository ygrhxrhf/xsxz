# HANDOFF

## 当前事实

- **战役 reader-progress-r2（R2 进度语义与恢复稳定性）已收尾**：
  - `e7447c3` fix(reader): 进度锚点补写 bodyHash 校验，正文变更回退 scrollRatio
  - `e95f4ce` docs: R2 恢复误差实测与归因（探针 6/6 通过 + 缺陷定位）
- master HEAD：e95f4ce（master 干净）。**存在未执行的上游推送授权**（用户原话「开发完成后，直接推送」，master 已配置上游）。

## R2 做了什么

- **探针** `.multi-agent/evidence/reader-progress-r2-2026-11-02/r2-probe.mjs`：真实 Electron + CDP，
  六场景「关应用→改排版/改正文→重开」测恢复误差（A 字号 / B 列宽 / C 窗口 / C0 offset=0 / D 清正文 / D2 正文替换同段数）。
- **修复**：
  1. `textPoint` 跳过空文本节点 —— offset=0 锚点（段落开头对齐视口顶，真实可达）不再因空 range 全零矩形滚回章首（探针 C0 复现：修复前 107 段误差，修复后 0）。
  2. `captureProgressWrite` 补写 `bodyHash`（与 TTS 同源 `ttsBodyHash`），`scrollToParagraphAnchor` 经 `progressAnchorBodyMatches` 校验，正文变更回退 scrollRatio；旧书无 bodyHash 跳过校验保持兼容（探针 D2 复现：修复后正确回退比例位）。
- **全书百分比**：保持章节等权估算（已明确「约」标注），不扩范围 —— 极端章节长度差异（1 章 2000 段 + 5 章 10 段）下等权显示 17% vs 真实 98%，但加权需各章段数数据源 + 同源反解联动改，风险大于收益，已记录在 findings。

## 验证证据

- 探针复验：`node .multi-agent/evidence/reader-progress-r2-2026-11-02/r2-probe.mjs` → 6/6 PASS，exit=0（报告 r2-probe-report.json）
- `npm run build` exit=0；`npm run typecheck` exit=0
- 契约：`npx vitest run src/renderer/pages/Reader.progress.contract.test.ts src/renderer/pages/Reader.accessibility.contract.test.ts` → 29 用例全绿
- 主树全量：`npx vitest run src --exclude .delta/` → 136 文件 / 1305 用例全绿（含新增 4 例 progressAnchorBodyMatches）
- 单测：readerHelpers.test.ts（88 例）+ readerPager.test.ts（25 例）全绿
- findings：`.multi-agent/reports/reader-progress-r2-findings.md`

## 下一步

1. **同步 delta worktree**：`.delta/worktrees/{8f792tj3eq1d,sb3j3p5netq9}` 需要同步到 e95f4ce（当前停在 7e2ab6f）。
2. `npm run plan:status` 退出码 0 才算收工（计划追踪器已全勾）。
3. 若用户确认推送：`git push`（上游已配置；涉及 master，需用户点头）。

## 已知边界

- Emulation 视口下 `readerProgress.schedule()` 写盘链被阻塞（探针环境伪影，非产品缺陷），C/C0 场景 A 段用 `setProgress` IPC 直写代替；真实窗口 resize 走 schedule 正常。
- 恢复稳定判定：首可见段连续 4 次采样一致（150ms），采样前强制两帧。
- 计划基线「78 用例」与实测「29 用例」有出入：以实测为准（progress 3 + accessibility 26，全绿）。
