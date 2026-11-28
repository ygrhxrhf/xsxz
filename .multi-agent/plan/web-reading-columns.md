# 计划：网页阅读的翻页方式（单栏 / 双栏）

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。

## 目标

网页阅读模式的「排版」面板里可选 **滚动 / 单栏翻页 / 双栏翻页**：翻页时整屏左右换页，
双栏像摊开的书（左右两页一起翻），键盘、滚轮、触控板横扫、自动翻页、听书定位都跟着走。

## 步骤

- [x] 1. 定位：网页阅读只有纵向「滚动 / 一屏一页」，没有分栏；翻页位置全靠 scrollTop
      - 验：`git show a070314:src/renderer/pages/Browse.vue | grep -n readingPaged` → 只有 `readingMode === 'screen'`
- [x] 2. 偏好：`WebReadingPrefs.columns`（1/2），主进程 `normalizeWebReadingPrefs` 兜底与旧文件兼容
      - 验：`npx vitest run src/main/settings.test.ts` → 54 条通过（含 columns 归一化）
- [x] 3. 分栏分页几何：`readingColumns.ts` 提供页数 / 页码 / 对齐位置 / 段落→页 的纯函数
      - 验：`npx vitest run src/renderer/pages/readingColumns.test.ts` → 4 条通过
- [x] 4. 排版：正文容器定高、按栏横向铺开（`column-count`），栏距取两倍左右留白，
      于是每栏步长恰好是「一屏宽 ÷ 栏数」，翻页按屏对齐
      - 验：Electron/Chromium 实测（1180×820、986px 视口）：单栏与双栏每页首段都落在 59/60px，
        与 `--web-col-pad` 一致；页数 = `ceil(scrollWidth / clientWidth)`
- [x] 5. 接线：页码、翻页、章末续章、当前章判定、段落锚点、进度写盘、听书定位、
      自动翻页（按节拍翻页）、滚轮与触控板横扫、窗口尺寸变化后的整页吸附
      - 验：`npx vitest run src/renderer/pages/Browse.readingMode.ui.test.ts` → 12 条通过
- [x] 6. 面板入口：滚动 / 单栏 / 双栏三个按钮，切换时按段落锚点回到原处
      - 验：同上契约测试断言 `setPageLayout('scroll' | 'single' | 'double')`
- [x] 7. 全量验证
      - 验：`npm run typecheck` 通过；`npm test` 见结果；`npm run build` 通过
- [x] 8. 提交：`feat(browse): 网页阅读支持单栏 / 双栏翻页`
      - 验：`git log --oneline -1`

## 不做（显式出范围）

- 不改本地阅读器的书页 / 真实书籍模式（它已有自己的单双栏）。
- 不做「上下翻页」：用户要的是微信阅读式的左右整屏换页。

## 已知边界

- 分栏依赖 CSS 多栏排版，Chromium 实测按屏对齐；其它渲染引擎（如系统 WebView 以外的内核）未覆盖。
- 双栏在很窄的窗口里每栏会偏窄；仍按用户选择渲染，不自动改回单栏。

## 断点记录（每次停下前更新）

- 状态：已完成
- 下一步第一条命令：`git push`（如需推送）
- 未验证项：未在真实站点上逐个手测；已用同一套 CSS 在 Chromium 里实测分页对齐，并用截图核对版式。
