# 计划：弧面删除后真实书籍真机回归

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工。

## 目标

弧面实验与谷竖带层已删（`60b1c2e`），但当时只跑了单测与构建，没在真实 Electron 上复跑三条真机 e2e。本计划补齐这块证据，确认平面正文路径无回归。

## 步骤

- [x] 1. 构建产物刷新：`npm run build` → EXIT:0，`out/main/index.js` 时间戳晚于 `60b1c2e`
      - 验：`npm run build`；`stat -c '%y' out/main/index.js`
      - 证据：EXIT 0；`out/main/index.js` = 2026-11-11 23:46，`60b1c2e` = 2026-11-11 16:43:43
- [x] 2. 翻页帧率 e2e：`node scripts/realbook-flip-fps-e2e.mjs`
      - 验：全部检查 PASS。
      - 证据：`结果：7 项通过，0 项失败`，EXIT 0；基线 827ms / 60 帧 / 中位 13.9ms / 最大 20.9ms / 长帧 0。已知既有缺陷：非慢动作收尾 `shotDir` ReferenceError 本轮未复现；日志 `长任务 undefined 次共 NaNms` 为既有统计空值，非失败项
- [x] 3. 页内批注 e2e：`node scripts/realbook-annotations-e2e.mjs`
      - 验：17/17 PASS，退出码 0
      - 证据：`结果：17 项通过，0 项失败`，EXIT 0
- [x] 4. 选区俯仰 e2e：`node scripts/realbook-selection-pitch-e2e.mjs`
      - 验：全 PASS，退出码 0
      - 证据：`结果：18 项通过，0 项失败`，EXIT 0（修脚本起点后；见下方根因）
      - 根因：e2e 把拖拽起点写死为「书体左上角 +8px」。选完字后顶部阅读工具栏常显，正好盖住该点（`elementFromPoint` 命中 `button.tool-text` 书架），pointerdown 到不了 `.real-book-book`；平放（0°）时该点还落在页内标题区，已有选区时浏览器起原生拖拽并触发 `pointercancel`，拖拽 8px 即中止。产品侧拖拽逻辑本身正常（无选区时同一位置 0° 可拖到 20°；18° 起点在书体空白处可拖到 35°）。修法：改成在书体内部扫描一个「命中书体、不落在正文/批注、不被工具栏或选区工具条盖住」的纸面点作为起点，并先清空选区。
- [x] 5. 结果写进 HANDOFF，提交本计划与结论
      - 验：`git log --oneline -1` 出现本计划提交；`npm run plan:status` → 0

## 不做（显式出范围）

- 不改产品代码（本计划只验证；只改了 e2e 脚本的拖拽起点）
- 不推送远端（需用户点头）

## 断点记录（每次停下前更新）

- 状态：三条 e2e 全部通过，待提交
- 下一步第一条命令：`npm run plan:status`
- 未验证项：无（真机窗口尺寸 1266×763 下的三条 e2e 均已复跑）
