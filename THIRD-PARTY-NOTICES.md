# 第三方代码与许可

## Infinite Reader

`src/renderer/pages/` 下的 `realBookLeafSim.ts`、`realBookLeafMesh.ts`、
`realBookPaperMaterial.ts`、`realBookGutterFold.ts`、`realBookPhoneCurl.ts`、
`realBookCaseBinding.ts` 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）
的 `web/src/engine/` 同名模块，`realBookLeafMotion.ts` 源自其
`web/src/engine/book.ts` 的飞页运动段（`stepFlyers` / `blendQuickLanding` /
`endDrag` / `moveDrag`），均按 Apache License 2.0 使用并修改：

- 文件改名并接入 spbf 的真实书籍场景；
- 书壳改由 `CaseBinding` 接在封面/后书板之间，书垛与书页改为从桌面向上堆叠；
  书板改用 `RoundedBoxGeometry`；
- 飞页运动就是上游的 `LeafSim` PBD 解算（`realBookLeafMotion.ts`）；
- 纸底色改为 `uPaperTint` uniform（spbf 的页面纹理已带纸色），中缝压暗改为
  `uGutter`（spbf 的页面纹理已画中缝）；
- 默认空白贴图从 Canvas 改为 DataTexture，模块在无 canvas 环境也能导入。

许可全文见 `third_party/infinite-reader/LICENSE`，上游署名见
`third_party/infinite-reader/NOTICE`。

`src/renderer/pages/atlas/` 下的 `catalog.ts`、`terrainView.ts`、`mapStyle.ts`、
`hydrology.ts`、`types.ts` 及其测试源自 Infinite Reader 的 `web/src/atlas/` 与
`shared/atlas.ts`，`AtlasMap.vue` 由其 `web/src/ui/AtlasMap.tsx` 改写、
`AtlasDock.vue` 由其 `web/src/ui/AtlasDock.tsx` 改写；同样按
Apache License 2.0 使用并修改（类型改从 `./types` 取、去掉 `.ts` 扩展名、
React 改 Vue、`identifyBookMap` 支持注入地图清单用于测试、接入 spbf 的 BookMapPage 与阅读器）。
`atlas/mapPins.ts` 的范围算法取自其 `shared/textAtlas.ts`，只保留本项目需要的部分。

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
