# HANDOFF

## 当前事实

- **挑战页自动重试（challenge-page）已提交**：
  - `053c13c` feat(download): 站点验证挑战页自动重载 + 落人工续跑
  - `ee80288` docs: 计划与实测结论归档
- master HEAD：ee80288（master 干净；`.qoder/` 未跟踪，属并行 worktree）。

## challenge-page 做了什么

- 新增 `src/main/challengePage.ts`：
  - `detectChallengePage(html)`：引用 `challenges.cloudflare.com` / `cdn-cgi/challenge-platform`
    即判挑战页（最硬信号）；无脚本时要求页面近乎空白（可见正文 < 120 字）且命中 CF 专属
    标题 / 话术。**刻意不收「安全验证」这类中文标题**——站点拦截残页也用它，误判会白等。
  - `waitForChallengeClearance({ hasClearance, wait, now })`：轮询 `cf_clearance`，
    1s 间隔、20s 预算；读 cookie 抛错继续等，不打断下载。
- `download.ts`：`retryIfChallengePage(load, url)` 统一两处——`loadAndGetHtml` 与
  `loadPageHtml`（含夹具路径）。命中挑战页 → 等 cookie → 重载一次；仍不放行则原样返回，
  交给正文启发式判 `Intercepted`，落到既有 `download.blocked` / `resumeUnblock` 人在环。
- `extract.ts`：`INTERCEPT_TITLE` / `INTERCEPT_TEXT` 补 CF 挑战页特征，「请稍候…」不再记 `UnknownPage`。
- 契约：`docs/ipc-contract.md` 新增「站点验证挑战页（Cloudflare / Turnstile）」一节。

## 验证证据

- `npx vitest run src/main/challengePage.test.ts` → 17/17
- `npx vitest run src/main/download.test.ts src/main/challengePage.test.ts` → 334/334
- 全量 `npx vitest run src --exclude '.delta/' --exclude '.qoder/'` → 137 文件 / 1324 用例全绿
- `npm run typecheck` → 0；`npm run build` → 0
- `npm run plan:status` → 0

## 关键实测结论（重要，别再重复踩）

对 `https://www.uaa001.com/`（Cloudflare 托管）实测：

| 载体 | 结果 |
|---|---|
| curl（Schannel） | TCP 通但在 TLS 层即失败 |
| ego-browser（Chrome 156） | 正常，47 个书目链接 |
| Electron 43 `BrowserWindow`（Chrome 150） | **曾成功**：`cf_clearance` 约 5–11s 下发，重载后 47 链接 |
| Electron 43 隐藏 `WebContentsView`（产品下载视图） | **拿不到 cookie**，25s 内一直停在挑战页 |

产品下载视图是 `sandbox: true` + `setVisible(false)` + 负坐标 bounds，
与 `BrowserWindow` 唯一差别在可见性/渲染路径。反复请求后连 `BrowserWindow` 也
退回失败，同一时刻 ego-browser 仍正常 → 判断为 Chromium 版本 + 隐藏视图指纹差异，
**不是**自动重试逻辑缺陷。

因此：该站当下实际会落到「人在环」——用户在内置浏览里过验证（`persist:novel`
会话与下载共用，cookie 天然复用），再点「我已处理好，继续下载」。

## 已知边界

- 自动重试只做「等真实浏览器跑完 + 重载」，**不解 Turnstile 载荷、不伪造 cookie**。
- 要求真人点击的挑战，自动重试无效，只能落人工。
- 重载上限 1 次（`CHALLENGE_MAX_RELOAD`），避免对判死的站反复撞。
- 本机并行存在 `.qoder/worktrees/electron-45-upgrade`——升级 Electron 可能才是根治
  该站的办法，但那是另一条线，本次未碰。

## 下一步

1. 若要让 uaa001 这类站真正自动通过：跟踪 `.qoder` 的 electron-45 升级线，
   升级后在真实下载视图上复测 `cf_clearance`。
2. `npm run plan:status` 已 0；`git push` 需用户点头（master）。

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
