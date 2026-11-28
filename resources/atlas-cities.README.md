# 书中地图识别用的城市坐标库

`atlas-cities.json` 是从 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）
的 `worker/src/atlas/data/cities.json` 原样取来的，Apache-2.0；数据本身来自
Natural Earth 1:10m populated places（公共领域）。

- 来源：https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson
- 来源 SHA-256：`fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f`
- 行数：7342，每行 `[ne_id, name, iso_a2, longitude, latitude, aliases]`

用途：书中地图的自动识别里，模型只给地名与现代国家代码，坐标一律由这张表按
「国家 + 规范化名称」唯一匹配得出；同名或置信度不足的条目不落点。

只在主进程读取（`src/main/atlasCities.ts`），不进入渲染层、不上传到任何服务。