# 第三方代码与许可

## Infinite Reader

`src/renderer/pages/` 下的 `realBookLeafSim.ts`、`realBookLeafMesh.ts`、
`realBookPaperMaterial.ts`、`realBookGutterFold.ts`、`realBookPhoneCurl.ts`、
`realBookCaseBinding.ts` 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）
的 `web/src/engine/` 同名模块；`realBookBookModel.ts` 源自其
`web/src/engine/book.ts`（书体、静态页、书垛、开合、飞页、落定），
`realBookStack.ts` / `realBookCover.ts` / `realBookDesk.ts` 分别源自
`stack.ts` / `cover.ts` / `desk.ts`；`referenceBook/` 下的 `layout.ts` /
`pageRender.ts` / `types.ts` / `annotations.ts` / `typography.ts` /
`imageFootnotes.ts` / `fontCatalog.ts` / `noteFontCatalog.ts` 源自
`web/src/book/` 同名模块（`pageRender` 已接入页面纹理，`layout.paginate` 已接管 WebGL 真实书籍分页）。以上均按 Apache License 2.0 使用并修改：

- 文件改名并接入 spbf 的真实书籍场景；
- 书壳改由 `CaseBinding` 接在封面/后书板之间，书垛与书页改为从桌面向上堆叠；
  书板改用 `RoundedBoxGeometry`；
- 书体与飞页就是上游的 `BookModel` + `LeafSim` PBD 解算；
- 纸底色改为 `uPaperTint` uniform（spbf 的页面纹理已带纸色），中缝压暗改为
  `uGutter`（spbf 的页面纹理已画中缝）；
- 默认空白贴图从 Canvas 改为 DataTexture，模块在无 canvas 环境也能导入；
- `referenceBook/i18n.ts` 与 `noteMarkdown` 的最小替身只保留书页排版用到的中文串/类型。

许可全文见 `third_party/infinite-reader/LICENSE`，上游署名见
`third_party/infinite-reader/NOTICE`。

`src/renderer/pages/atlas/` 下的 `catalog.ts`、`terrainView.ts`、`mapStyle.ts`、
`hydrology.ts`、`types.ts` 及其测试源自 Infinite Reader 的 `web/src/atlas/` 与
`shared/atlas.ts`，`AtlasMap.vue` 由其 `web/src/ui/AtlasMap.tsx` 改写、
`AtlasDock.vue` 由其 `web/src/ui/AtlasDock.tsx` 改写；同样按
Apache License 2.0 使用并修改（类型改从 `./types` 取、去掉 `.ts` 扩展名、
React 改 Vue、`identifyBookMap` 支持注入地图清单用于测试、接入 spbf 的 BookMapPage 与阅读器）。
`atlas/mapPins.ts` 的范围算法取自其 `shared/textAtlas.ts`，只保留本项目需要的部分。

**书中原图自动识别**：`src/shared/atlas.ts`、`src/main/atlasRecognition.ts`、
`src/main/atlasCities.ts` 与 `resources/atlas-cities.json` 源自其 `shared/atlas.ts`、
`worker/src/atlas/recognition.ts`、`worker/src/atlas/cache.ts` 与
`worker/src/atlas/data/cities.json`，同样按 Apache License 2.0 使用并修改：

- Cloudflare Worker 的路由 / R2 缓存 / 限流换成 Electron 主进程的按书落盘缓存与既有 AI 配置；
- Cloudflare GLM 备用模型没有对应运行时，省略（只用一个模型，参数由本项目配置决定）；
- 用 `noUncheckedIndexedAccess` 下的手写校验替代 zod，保留同一组约束（上限 24 个落点、
  最多校验 64 条候选、`bounds` 与 `imagePoint` 的取值域）；
- 城市库按需从打包资源读取，并支持测试注入。

数据来源与哈希见 `resources/atlas-cities.README.md`。

## 阅读地图数据

`src/renderer/public/atlas/` 的数据沿用 Infinite Reader 的 `web/public/atlas/`：

- `relief/**`：85 张 0–3 级地形瓦片，来自 Mapzen terrain / Tilezen 与 Natural Earth
  land mask；署名与链接见 `src/renderer/public/atlas/README.md`。
- `rivers.json` / `water.json`：Natural Earth 1:10m 物理矢量（公共领域），
  构建方式与哈希见同一份 README。
- 在线高程与详细水系分别来自 Mapzen/AWS Terrarium 与 OpenFreeMap（© OpenMapTiles、
  © OpenStreetMap contributors），界面由 MapLibre 的 attribution 控件显示。

## maplibre-gl

`maplibre-gl@6.15.0` 为 BSD-3-Clause；许可文本见
`third_party/maplibre-gl/LICENSE.txt`。
