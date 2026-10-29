# FINAL 全战役最终验证（U1.1–U1.6 全部合入后）

任务：U1.6-final
坐标：U1.6
模式：subagent_test（只跑 build 档；不改产品代码、不提交、不合入、不 git push）

## 0. 前置核对

```
$ git rev-parse HEAD
2e7db64dbae0b317fd8b1e6d47e5b072f348e0c1

$ git status --porcelain -- src scripts
（空输出）
```

两条前置全部满足：HEAD 与派工 commit 一致；`src` 与 `scripts` 零改动（产品文件干净）。

工作区其余脏文件全部位于 `.multi-agent/`，与产品代码无关：

```
$ git status --porcelain | grep -v '^??' | grep -v '.multi-agent/'
（空输出）
```

`out/` 产物时间 14:27，与本次 build 同步，非旧产物冒充。

## 1. `npm run build` — PASS（退出码 0）

```
> electron-vite build
vite v7.3.6 building ssr environment for production...
✓ 66 modules transformed.
out/main/index.js  582.08 kB
✓ built in 726ms
vite v7.3.6 building ssr environment for production...
✓ 1 modules transformed.
out/preload/index.mjs  13.73 kB
✓ built in 18ms
vite v7.3.6 building client environment for production...
✓ 2820 modules transformed.
../../out/renderer/index.html                     0.42 kB
../../out/renderer/assets/index-CN7jSOKF.css     90.10 kB
../../out/renderer/assets/index-C3Y2RQCO.js   3,949.45 kB
✓ built in 5.49s
```

main / preload / renderer 三段产物全部生成，无警告阻断。

## 2. `npm test` — PASS（退出码 0）

```
 Test Files  136 passed (136)
      Tests  1289 passed (1289)
   Duration  19.22s
```

136 文件 / 1289 用例全通过，0 失败、0 跳过。

## 3. `npm run e2e:reader` — PASS（退出码 0，11/11）

环境：`DISPLAY=:1`（X11 可用），Electron 真实窗口 + CDP。

```
夹具：书库=/tmp/spbf-reader-e2e-lib-sG7znW
      userData=/tmp/spbf-reader-e2e-user-1GyKKN（reader.dim=40，进度停在第二章中段）
PASS  夹具的书在书库列表里渲染成可打开的书卡
PASS  点书卡后阅读器正文渲染出来
PASS  打开书自动跳回上次所在章节（第二章）  — 第二章
PASS  跳回上次非起点位置时出现「已回到上次读到」提示
PASS  dim>0 时正文上叠了压暗遮罩 .reader-dim
PASS  遮罩不透明度随 dim(40) 落到 0.4  — opacity=0.4
PASS  遮罩 pointer-events:none 不吞点击  — pointer-events:none
PASS  遮罩 z-index 压在正文与导航之间(15)  — z-index=15
PASS  压暗层中心点仍可命中下层正文（未拦截指针）  — 命中=reader-content reader-pane chapter-fade-in
PASS  恢复默认后压暗遮罩消失（v-if dim>0 生效）
PASS  恢复默认把 dim 写回 settings.json（读盘↔写盘闭环）  — settings.reader.dim=0
结果：11 项通过，0 项失败
阅读器新特性端到端通过：dim 压暗遮罩渲染/不吞点击/写盘闭环 + 续读可见提示
```

### 关于「已回到上次读到」断言

本轮该断言 PASS，未出现 U1.5 那次 10/11 的失败，本次无需归因。

已知依据来自 `.multi-agent/test-reports/U1.5-toast-probe.md` 的只读诊断（结论 A）：

- 「已回到上次读到」提示在 `App.vue` 启动 `onMounted` 自动进 reader 的那一次 `loadBook` 里弹出并自动消失；
- 仓库内脚本要等「进书库 → 找到书卡」之后才安装 MutationObserver，此时提示已消失，`msgCount=0` 表示「已消失」而非「没弹」；
- 探针把 arm 提前到取得 CDP target 之后两次稳定 11/11；原时序三次为 11/11 → 10/11 → 11/11，同 commit 同夹具，纯时序竞争；
- 因此该项万一失败属**测试脚本观测窗缺陷**，不是产品回归，也不是 U1.5 引入。

本轮同一 HEAD、同一脚本落在通过侧，与结论 A 一致；脚本与产品代码均未改动。

## 4. `npm run typecheck` — PASS（退出码 0）

`package.json` 存在该脚本（`tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json`），非 SKIP。

```
> tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json
（无诊断输出）
```

node 与 web 两套 tsconfig 均零类型错误。

## 5. `npm run plan:status` — FAIL（退出码 1）

按派工要求未加 `--strict`，未修改 `.multi-agent` 下任何现有文件。

```
完成：.multi-agent/plan/mirror-site.md
未完成 9 项：.multi-agent/plan/quiet-reading.md
  - [ ] U1.1 默认收起与点按：验 npm run build、npm test、合入后 npm run e2e:reader → 退出码 0 或已正式核准的不影响目标的既有测试债；OP-1–OP-5 新版截图逐条达到。
  - [ ] U1.2 按章拖动：验 npm run build、npm test、合入后 npm run e2e:reader → 同上；OP-6–OP-7 达到。
  - [ ] U1.3 段落翻屏：验 npm run build、npm test → 构建与段落落点单测通过；OP-8 达到。
  - [ ] U1.4 渲染层净化：验 npm run build、npm test、合入后 npm run e2e:reader → 规则与原文坐标兼容通过；OP-9–OP-11 达到，原始章节不变。
  - [ ] U1.5 下载进度露出：验 npm run build、npm test、合入后 npm run e2e:reader → running 强制显示状态通过；OP-12 达到。
  - [ ] U1.6 偏好兼容：验 npm run build、npm test → 两字段旧数据缺省和保存兼容通过；OP-13–OP-14 达到。
  - [ ] 默认分支最终复验：验 git rev-parse HEAD、npm run build、npm test、npm run e2e:reader → 证据明确绑定最终 HEAD；所有切片 done，无 blocker。
  - [ ] 收工自检：验 npm run plan:status → 退出码 0，已跟踪工作区干净。
  - [ ] 已授权推送：验 git push 与远端分支 HEAD → 推送成功且与验收提交一致；不 force push。
```

另两类计数项：

1. **工作区有未提交改动 13 个**，全部是账本：`.multi-agent/HANDOFF.md`、`decision-log.md`、`dev-plan.md`、`expert-board.md`、`interview-log.md`、`lessons-learned.md`、`main-log.md`、`objective.md`、`readiness.md`、`scheme.md`、`world.md`、`test-reports/U1.1-build.md`、`test-reports/U1.1-contract.md`。
2. **未跟踪文件 23 个**（不加 `--strict` 不算失败）：7 个 `evidence/*-op-*` 目录、`implementers.json`、`plan/quiet-reading.md`、`sweep.md`、13 份 `test-reports/*` 报告。

汇总行：`还不能收工：22 项待处理`（9 未勾 + 13 脏文件）。

### 失败项逐条归因

| 失败项 | 归因 | 产品缺陷 |
|---|---|---|
| `quiet-reading.md` 9 项复选框全部未勾 | `dev-plan.md` 中 U1.1–U1.6 六刀均为 `done`、尝试 0–1/3、合入与画面证据齐备，但计划文件复选框未随之勾选，属账本记账不同步 | 否 |
| 「收工自检」要求 `plan:status` 退出码 0 | 该项自身未勾 → 脚本退出码 1 → 该项无法通过，构成自指条件；需先勾前 8 项并由主 Agent 提交账本 | 否 |
| 「已授权推送」 | 本轮未授权推送，该项本就应保持未完成 | 否 |
| 13 个已跟踪脏文件 | 全部为 `.multi-agent/` 账本，`src` 与 `scripts` 零改动 | 否 |

结论：本项 FAIL 的根因是**账本复选框与已 done 的切片状态不同步**，叠加 `plan:status` 的自指判据，不是 U1.1–U1.6 的产品回归。未勾项与已跟踪脏文件只能由主 Agent 更新账本并提交来关闭，本轮测试角色不做该动作。

## 6. 判定汇总（逐条，不合并）

| # | 命令 | 结果 | 退出码 | 关键指标 |
|---|---|---|---|---|
| 1 | `npm run build` | PASS | 0 | main 582.08 kB / preload 13.73 kB / renderer 3,949.45 kB |
| 2 | `npm test` | PASS | 0 | 136 文件 / 1289 用例全通过 |
| 3 | `npm run e2e:reader` | PASS | 0 | 11 项通过，0 项失败 |
| 4 | `npm run typecheck` | PASS | 0 | node + web 两套 tsconfig 零错误 |
| 5 | `npm run plan:status` | FAIL | 1 | 9 项未勾 + 13 个已跟踪账本脏文件；22 项待处理 |

**产品侧（第 1–4 项）全部 PASS，均绑定 commit `2e7db64`。** 第 5 项 FAIL 属账本状态问题，不指向产品缺陷。

## 7. 未做项与边界

- 未跑 `e2e:startup`、`e2e:ocr`、`e2e:mirror`、`test:live-ai`：不在本轮派工档内。
- 未加 `--strict` 跑 `plan:status`（派工明确禁止）。
- 未改 `scripts/reader-features-e2e.mjs`；U1.5 诊断中「观察器提前安装」的建议仍未落地，该断言长期仍有摆动风险。
- 未改产品代码、未提交、未合入、未推送。除本报告外未新增或修改仓库任何文件。
- 单机单环境：Linux / X11 `DISPLAY=:1` / Electron 43.4.0；Windows 单机目标环境未覆盖。
- 视觉复核（OP-1 至 OP-14 截图）不在本档范围，画面证据见 `evidence/U1.1-op-1` 至 `U1.6-op-1`。
