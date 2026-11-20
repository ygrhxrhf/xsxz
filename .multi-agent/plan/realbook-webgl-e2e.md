# 计划：真实书籍 WebGL 分支收口（合并 + 固化 e2e + 断点）

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工。

## 目标

把 `feat/realbook-webgl-fidelity` 的 5 个提交合进 `master`，把 WebGL 真机检查从
`.multi-agent/tmp/` 的临时脚本收进仓库 e2e，修好本机的低完整性环境，并更新 HANDOFF。

## 步骤

- [x] 1. 合并：`feat/realbook-webgl-fidelity` → `master`（ff-only）
      - 验：`git log --oneline` 出现 `e2ba190`；`git status --porcelain` 无已跟踪改动
      - 证据：`Updating 296f390..e2ba190 / Fast-forward`，175 文件、+11485/-397
- [x] 2. 全量单测：`npm test`
      - 验：EXIT 0
      - 证据：`.multi-agent/tmp/fulltest-postmerge.log` → `Tests  1991 passed (1991)`，EXIT 0
- [x] 3. 构建：`npm run build`（原 `chrome156` target）
      - 验：EXIT 0，`out/renderer/index.html` 与 `out/renderer/assets/` 重新产出
      - 证据：`.multi-agent/tmp/build-restored.log` → `✓ built in 26.43s`，EXIT 0；
            `index-CsRdDZfd.js` 4,044 kB（与 11-18 那版同量级）
- [x] 4. 修本机低完整性环境
      - 验：根目录与 `node_modules/electron/dist/electron.exe` 不再是 Low 标签；
            仓库 Electron 能起窗口、写 userData
      - 证据：根 `C:\codes\xsxz` 原是 `Low Mandatory Level:(OI)(CI)(NW)`，已改为
            `Medium Mandatory Level:(OI)(CI)(NW)`；`node_modules` 改名留底后 `npm ci`
            重装（新文件继承 Medium，无标签 ACE），旧的 `node_modules.low` 已删除。
            此前所有真机 e2e 都因 Electron 低完整性写不了 profile 而失败。
- [x] 5. 新增 `scripts/realbook-webgl-e2e.mjs` 并挂 `npm run e2e:realbook-webgl`
      - 验：24 项 PASS / 0 FAIL，EXIT 0，连续三次
      - 证据：`.multi-agent/tmp/e2e-webgl-m1..m3.log` 均为 `24 项通过，0 项失败`。
            覆盖：WebGL 能力、画布、命中区、DOM 文本层、选字、正/反向翻页、合上/打开、
            桌面/衬纸/视角面板、沉浸式顶栏、更多菜单、窄屏单页、无渲染进程异常。
- [x] 6. 三条既有真实书籍 e2e 复跑并修好
      - 验：各自 `N 项通过，0 项失败`，EXIT 0
      - 证据：flip `7/7`（`.multi-agent/tmp/final2-flip.log`）、notes `18/18`
            （`final2-notes.log`）、selection `18/18`（`final-selection.log`）
      - 改动：三条都补 `localStorage['spore:reader-realbook-renderer:v1']='css'` 并等外壳挂载
            （WebGL 已是默认渲染层；初始文档上 localStorage 会抛）；annotations / selection-pitch
            的「平放」改为向上拖——真实书籍现在没有平放按钮。
- [x] 7. 文档与断点：`docs/真实书籍-WebGL复刻.md` 验证段与已知限制、`HANDOFF.md`、本计划
      - 验：`npm run plan:status` → EXIT 0
- [x] 8. 提交本批改动
      - 验：`git log --oneline -1`

## 不做（显式出范围）

- 不推送远端（需用户点头）
- 不修下面的「拖页飞页正文丢失」——这是产品侧竞态，需单独立项
- 手机卷页正文打磨另开一轮

## 已知边界

- **拖页时飞页正文会丢（竞态，未修）**：逐帧读 DOM 的真机证据
  （`.multi-agent/tmp/debug-drag.mjs`，2026-11-20）：
  - 刚打开后的第一次拖页：`rightText` 已切到 `none`（peel 已开始），但
    `.real-book-flip-line` 始终 0 个；松手后页码推进，纸上没有字。
  - 正向翻过一张再拖：有一次在第 4 步建出 130 个片段，另一次整段都没有——约一半概率。
  - 先正向再反向翻过之后拖：两次都 0 个片段。
  - 连续拖 4 次：总页数从 5 一路涨到 11/13，页码跳着走。
  推断与 `RealBookStage` 的 `webglFlips` → `texturePageOf(run.from/to)` 在分页重排前后
  返回 null 有关，未定位。`e2e:realbook-webgl` 因此没有把「拖页贴面」列为断言。
- **真实书籍没有「平放」按钮**：Reader.vue 的 `:show-toolbar="bookView !== 'realbook'"`
  让舞台工具栏在真实书籍下不渲染，顶栏那颗平放按钮又写在 `<template v-if="!isRealBook">` 里。
  CSS 3D 回退没有回 0° 的入口，e2e 用向上拖绕过。
- **真机 e2e 对机器负载敏感**：`e2e:realbook-flip` 的「长帧比例 ≤ 10%」在后台跑
  `rm -rf node_modules.low` 时会超（24 帧里 10 个长帧）；同一命令空载重跑
  7/7 通过。跑性能类 e2e 时不要同时做重磁盘操作。

## 断点记录（每次停下前更新）

- 状态：四批验证全绿，待用户确认是否推送
- 下一步第一条命令：`git push origin master`（需用户点头）
- 未验证项：手机窄屏下的拖页（同上竞态）；未做多点触控/触控板