# 计划：真实书籍页内批注

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 当前工作区已有其他真实书籍改动；本任务只增量修改批注相关文件，不重置现有改动。

## 目标

真实书籍模式下，读者选中文字写下的批注会显示在被批注段落下方，并能从书页直接编辑或删除；开关与批注跨章节、重开应用后保留。

## 步骤

- [x] 1. 偏好与契约：`ReaderPrefs.showInlineNotes` 默认开启，设置归一化与文档同步
      - 验：`npx vitest run src/main/settings.test.ts` → 全绿
- [x] 2. 分页：页条目支持原子批注块，批注紧跟锚定段落且空间不足时整张下移
      - 验：`npx vitest run src/renderer/pages/realBookPager.test.ts` → 全绿
- [x] 3. 渲染：真实书页显示三行批注、开关、手写体、AI 标记，左右页与翻页正反面一致
      - 验：`npx vitest run src/renderer/pages/RealBookStage.ui.test.ts` → 全绿
- [x] 4. 接线：Reader 派生批注、选区写批注、页内编辑/删除与重排后的位置保持
      - 验：`npx vitest run src/renderer/pages/Reader.realBook.ui.test.ts src/renderer/pages/Reader.marks.ui.test.ts` → 全绿
- [x] 5. 回归：相关阅读器测试、类型检查、构建
      - 验：`npm run typecheck`、`npm run build` → exit 0
- [x] 6. 端到端：真实 Electron 中验证批注显示、编辑、开关持久与主题/俯仰截图
      - 验：`npm run build` 后运行 `realbook-annotations-e2e.mjs` → 全 PASS
- [x] 7. 文档与断点：契约、磁盘说明、实施记录与 HANDOFF
      - 验：`npm run plan:status` → 只剩既有工作区改动导致的基线失败

## 不做（显式出范围）

- 经典模式与书页模式不新增页内批注。
- 不新增 IPC、批注磁盘字段或运行时依赖。
- 不改正文纯文本约束，不使用 `v-html`。

## 已知边界

- 卡片最多显示三行，完整内容在编辑浮层中修改。
- 批注卡片不可拆分；空间不足时整张移动到下一页。
- 现有未提交改动可能让 `plan:status` 无法以 0 退出。

## 断点记录（每次停下前更新）

- 状态：已完成（2026-11-09）
- 已验证：7 个相关测试文件 130 项全绿；`npm run typecheck` 0；`npm run build` 0；
  `node scripts/realbook-annotations-e2e.mjs` 17 项全过，截图在系统临时目录
  `spbf-realbook-annotations-shots`。
- 下一步第一条命令：无（`npm run plan:status` 仍会因既有 `.multi-agent/plan/realbook-flip-tear-2.md`
  未勾项与整个工作区未提交改动而失败，属既有基线，不是本任务未完成）。
- 未验证项：批注模式在真实站点下载书上的超长章表现未单独压测；经典/书页模式按设计不出现页内批注。
