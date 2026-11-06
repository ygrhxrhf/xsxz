# 计划：Electron 43 → 45（Chromium 156）

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工（未勾项 + 脏工作区都会让它失败）。

## 目标

Electron 从 43.4.0 升到 45.2.1 —— Chromium 156.0.8078.75 首次出现在该版本，
是满足「Chrome 156+」的唯一稳定版。升级后产品代码零行为变化，
同时把 45 里即将移除的 safeStorage 同步 API 迁到异步，避免下次升 46 再改一遍。

## 步骤

- [x] 1. 调查：Electron 版本 ↔ Chromium 对照，以及本仓库实际用到的 Electron API 面
      - 验：`node -e` 读 releases.json 得 45.2.1 = chrome 156.0.8078.75
      - 验：`grep -rn "from 'electron'" src` → 仅 BrowserWindow/WebContentsView/session/ipcMain/dialog/app/safeStorage/contextBridge
- [x] 2. 设计与范围确认
      - 验：用户确认「同步 API 顺手改异步」「加 .npmrc 镜像」「自动化全覆盖 + 手测真站」「开独立 worktree」
- [x] 3. 依赖与二进制
      - 验：`cat node_modules/electron/dist/version` → `45.2.1`
      - 验：`npx electron --version` → `v45.2.1`
      - 注：Electron 42+ 不再在 install 时下载二进制，必须显式 `npx install-electron`
- [x] 4. safeStorage 异步化
      - 验：`npx vitest run src/main/settings.test.ts src/main/settings.readerPrefs.test.ts` → 43 用例全绿
      - 验：`npx vitest run src/renderer/pages/Settings.aiFollow.contract.test.ts` → 2 用例全绿
- [x] 5. 钉死构建 target
      - 验：解析配置得 main/preload=`node24`、renderer=`chrome156`
      - 验：`grep -c "Buffer\|setImmediate" out/preload/index.mjs` → 0
- [x] 6. 全量验证
      - 验：`npm run typecheck` → exit 0
      - 验：`npx vitest run src` → 136 文件 / 1306 用例全绿
      - 验：`npm run build` → exit 0
- [x] 7. 真 Electron 端到端
      - 验：`npm run e2e:startup` → 10/10
      - 验：`npm run e2e:ocr` → 11/11
      - 验：`npm run e2e:reader` → 11/11
      - 验：`npm run e2e:mirror` → 19/19
- [x] 8. 打包
      - 验：`npm run pack:local` → exit 0，日志 `electronVersion=45.2.1`
      - 验：`cat release/win-unpacked/version` → `45.2.1`
- [x] 9. CF 挑战页复测（升级的意外收益）
      - 验：`node .multi-agent/evidence/electron-45-cf-2026-11-02/cf-probe.mjs` → A/B/C 三变体均 PASS
      - 证据：`.multi-agent/evidence/electron-45-cf-2026-11-02/results.md`
- [x] 10. 收尾：HANDOFF 与决策记录
      - 验：`npm run plan:status` → exit 0

## 不做（显式出范围）

- 不升 electron-vite 到 6（rolldown 内核，preload 的 CJS 强制输出需重新验证）。
- 不升 electron-builder（26.17 已按本地 electron 包动态取版本）。
- 不改 `FALLBACK_CHROME_VERSION`（仅 runtime 无 chrome 时兜底，测试依赖 140 字面量）。
- 不动挑战页逻辑，只做复测与记录。

## 已知边界

- CF 复测为单站单次采样；Cloudflare 按指纹动态调难度，不能保证所有站。
- 真实小说站的 UA 识别只能人工验收，自动化测不出。
- 早期一次 B 变体出现过 `ERR_FAILED (-2)` 后静默退出；独立 partition 重跑正常，
  判断为 partition 复用下的偶发，未纳入结论。

## 断点记录（每次停下前更新）

- 状态：已完成并已合入 master（`git log master..worktree-electron-45-upgrade` 为空；master 的 `package.json` electron 已是 `^45.2.1`）
- 下一步第一条命令：无（待人工验收：真实小说站的浏览/下载/登录态、API Key 跨重启解密）
- 未验证项：真实小说站的浏览/下载/登录态、API Key 跨重启解密（需人工）

## 合并到 master 时追加

- [x] 11. rebase 到 master `c8b93b5`（应用内代理 9 个提交）
      - 验：`git log --oneline master..HEAD` 只剩本次 6 个提交
      - 发现：代理密码路径仍用同步 safeStorage，且 `requireEncryptionAvailable()` 漏 await → 已在 `8e6aef6` 修
      - 验：`grep -rn "isEncryptionAvailable\|encryptString(\|decryptString(" src` → 无输出
- [x] 12. 合并后全量验证
      - 验：`npm run typecheck` → exit 0
      - 验：`npx vitest run src` → 142 文件 / 1428 用例全绿
      - 验：`npm run build` → exit 0；preload 仍为 CJS 且无 Buffer/setImmediate
      - 验：e2e startup 10/10、ocr 11/11、reader 11/11、mirror 19/19
