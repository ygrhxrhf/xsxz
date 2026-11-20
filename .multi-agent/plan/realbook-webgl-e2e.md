# 计划：真实书籍 WebGL 分支收口（合并 + 固化 e2e + 断点）

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工。

## 目标

把 `feat/realbook-webgl-fidelity` 的 5 个提交合进 `master`，把 WebGL 真机检查从
`.multi-agent/tmp/` 的临时脚本收进仓库 e2e，并更新 HANDOFF，让这条分支的断点不再缺失。

## 步骤

- [x] 1. 合并：`feat/realbook-webgl-fidelity` → `master`（ff-only）
      - 验：`git log --oneline -1` → `e2ba190`；`git status --porcelain` 无已跟踪改动
      - 证据：`Updating 296f390..e2ba190 / Fast-forward`，175 文件、+11485/-397
- [x] 2. 全量单测：`npm test`
      - 验：EXIT 0
      - 证据：`.multi-agent/tmp/fulltest-postmerge.log` → `Tests  1991 passed (1991)`，EXIT 0
- [x] 3. 构建：`npm run build`
      - 验：EXIT 0，`out/renderer/index.html` 与 `out/renderer/assets/` 重新产出
      - 证据：EXIT 0，`out/renderer/assets/index-*.js` 4.33MB、`realBookWebGLScene-*.js` 1.42MB
      - 备注：渲染层 target 从 `chrome156` 改 `esnext`，见「已知边界」
- [x] 4. 新增 `scripts/realbook-webgl-e2e.mjs` 并挂 `npm run e2e:realbook-webgl`
      - 验：26 项 PASS / 0 FAIL，EXIT 0
      - 证据：`.multi-agent/tmp/e2e-webgl-copy6.log` → `26 项通过，0 项失败`
      - 备注：本机直接用 `npm run` 跑不起来（低完整性，见「已知边界」），验证时用中完整性
            的 Electron 副本跑同一份脚本
- [x] 5. 三条既有真实书籍 e2e 复跑并修好
      - 验：各自 `N 项通过，0 项失败`
      - 证据：`postmerge2-realbook-flip-fps-e2e.log` 7/7；`postmerge4-realbook-annotations-e2e.log` 18/18；
            `postmerge4-realbook-selection-pitch-e2e.log` 18/18
      - 改动：三条脚本都补 `localStorage['spore:reader-realbook-renderer:v1']='css'`（WebGL 已是默认渲染层）；
            annotations / selection-pitch 的「平放」改为向上拖——真实书籍现在没有平放按钮
- [x] 6. 文档与断点：`docs/真实书籍-WebGL复刻.md` 验证段、`HANDOFF.md`、本计划
      - 验：`npm run plan:status` → EXIT 0
- [x] 7. 提交本批改动
      - 验：`git log --oneline -1`

## 不做（显式出范围）

- 不推送远端（需用户点头）
- 不改真实书籍产品代码（本计划只合并、加/修 e2e、修构建环境阻塞）
- 手机卷页正文打磨另开一轮

## 已知边界

- **本机 Electron 跑不了真机 e2e**：`node_modules` 带 `Mandatory Label\Low Mandatory Level`，
  `electron.exe` 因此以低完整性启动，写不了 userData / `%TEMP%` / 桌面，只剩同低完整性的路径可写，
  应用启动即退。解释性证据：`icacls node_modules` 有 Low 标签；Electron 建的文件也是 Low；
  把 `electron/dist` 复制到无 Low 标签的目录后，同一个 app 能正常起窗口、写文件。
  修法（需用户执行，涉及安全描述符）：`icacls C:\codes\xsxz\node_modules /setintegritylevel M /T /C`。
  本计划的 e2e 证据是用「复制到底完整性目录的 Electron」跑出来的，脚本逻辑与仓库脚本一致。
- **构建阻塞与绕过**：vite7 + esbuild 0.28 的 JS API 对超过约 1MB 的 chunk 走临时文件回传，
  本机删除该临时文件稳定报 `Access is denied`（同一条低完整性根因），renderer 主包 ~4.3MB 会打断构建。
  渲染层 target 改 `esnext` 后 `resolveEsbuildTranspileOptions` 返回 null，跳过该步；
  Chromium 156 运行时不需要降级。若日后修好完整性，可考虑改回 `chrome156`。
- **真实书籍已无「平放」按钮**：Reader.vue 的 `:show-toolbar="bookView !== 'realbook'"` 让舞台
  工具栏在真实书籍下不渲染，顶栏那颗平放按钮又写在 `<template v-if="!isRealBook">` 里。
  CSS 3D 回退因此没有回 0° 的入口，只能拖。这是产品侧缺口，本计划只在 e2e 里用向上拖绕过。

## 断点记录（每次停下前更新）

- 状态：四批验证全绿，待用户处理低完整性 + 确认是否推送
- 下一步第一条命令：`icacls C:\codes\xsxz\node_modules /setintegritylevel M /T /C`（用户执行）
- 未验证项：用仓库内 `node_modules` 的 Electron 直接跑 e2e（被低完整性挡住，未验证）
