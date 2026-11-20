# 计划：工作区收口 + 启动自动追更

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工（未勾项 + 脏工作区都会让它失败）。

## 目标

打开应用后，书库里的下载书会在到期时自动检查更新并补下新章，结果在书架提示一次；同时把工作区里约 930MB 的未跟踪临时产物清掉，探针脚本留档。

## 步骤

- [x] 1. 盘点未跟踪产物，找出文档点名的探针脚本
      - 验：`grep -rhoE "\.multi-agent/tmp/[A-Za-z0-9._/-]+" docs .multi-agent/HANDOFF.md` → 10 个脚本 + logs-2026-11-20
- [x] 2. 归档脚本、补 `.gitignore`、清理临时产物
      - 验：`du -sh .multi-agent/visual .multi-agent/archive` → 1.2M / 280K（原 tmp 483M + visual 451M）
- [x] 3. 查清现有检查更新链路与可复用点
      - 验：`download.checkAll` 已有批量串行检查且会补章；`addedChapters` 是网页书架字段，不复用
- [x] 4. 实现到期自动检查（不新增 IPC 频道，复用 `settings.get/set`）
      - 验：`npm run typecheck` → EXIT 0
- [x] 5. 设置页开关/间隔、书库页提示、契约与磁盘文档
      - 验：`npx vitest run src/renderer/pages/Settings.ui.contract.test.ts src/renderer/pages/Library.ui.contract.test.ts` → 全通过
- [x] 6. 单测：到期判定、摘要、忙/失败不写时间戳、空书库不写摘要、设置归一
      - 验：`npx vitest run src/main/autoUpdateCheck.test.ts src/main/settings.autoUpdateCheck.test.ts` → 15 + 5 用例通过
- [x] 7. 全量单测与构建
      - 验：`npm test` → 199 文件 / 2014 用例全绿；`npm run build` → EXIT 0
- [x] 8. 真机闭环：本地站真下载 5 章 → 加第 6 章 → 等 60 秒自动追更 → 书架提示
      - 验：`npm run e2e:auto-update` → 11 项通过 0 失败
- [x] 9. 安装包重打 + 交互式向导点通 + 已安装版冒烟
      - 验：`npm run dist:local` → EXIT 0；向导 6 次默认按钮点击、退出码 0；已安装版设置页 4/4 PASS
- [x] 10. 提交与 HANDOFF
      - 验：`git log --oneline -3`；`npm run plan:status` → EXIT 0

## 不做（显式出范围）

- 多设备同步（与个人自用定位冲突）
- 签名与自动更新（此前已明确出范围）
- 自动追更的逐书开关、失败重试调度（下次启动会重试，不做常驻定时器）

## 已知边界

- 自动检查固定等启动 60 秒后跑一次；错过（当时在下载/恢复/批量检查）就留到下次启动，不在本次会话内补跑。
- `--remote-debugging-port` 启动（e2e）不触发自动检查；另支持 `--no-auto-update-check`。
- 检查会直接补下新章，不做“只提示不下载”的分支。
- 安装向导验证覆盖默认目录；未在干净机器装过。

## 断点记录（每次停下前更新）

- 状态：完成（未推送）
- 下一步第一条命令：`git push origin master`（需用户点头）
- 未验证项：干净机器安装；自选非默认目录安装
