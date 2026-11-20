# 探索性真机探针（已归档）

这些脚本原先散在 `.multi-agent/tmp/`，只用于开发时看帧、截图和逐帧取证，**不是回归测试**。
正式回归在仓库 `scripts/` 下（`npm run e2e:*`）。

归档理由：`docs/` 与 `HANDOFF.md` 点名引用过它们；`tmp/` 其余产物（截图、日志、探针 exe）已在
2026-11-21 清理，目录整体不再入库。

## 用法

从仓库根目录运行，先 `npm run build`；脚本会自己用仓库里的 Electron 起应用：

```bash
node .multi-agent/archive/probes/check-atlas.mjs
```

注意：

- 多数脚本把仓库根写死成 `C:\codes\xsxz`；换机器要改 `const root`。
- `realbook-webgl-check.mjs` 用 `import.meta.url` 推根目录，归档时已补一层 `dirname`。
- 输出截图默认写回 `.multi-agent/visual/…`（该目录已忽略，仅本地保留）。

## 清单

| 脚本 | 用途 | 首次记录 |
|---|---|---|
| `check-atlas.mjs` | 书中地图：3D 地形、图片识别、文字地点、阅读器胶囊 | `docs/阅读地图.md` |
| `realbook-webgl-check.mjs` | 真实书籍 WebGL：canvas、命中区、翻页、面板 | `docs/真实书籍-WebGL复刻.md` |
| `debug-drag.mjs` | 拖页飞页正文逐帧 DOM 取证 | `HANDOFF` 2026-11-20 |
| `capture-drag-hold.mjs` | 拖页半程/落定截图 | `HANDOFF` 2026-11-20 |
| `capture-flyer-text.mjs` | 飞页正文贴面截图 | `HANDOFF` 2026-11-20 |
| `capture-phone-drag.mjs` | 手机单页卷页拖拽截图 | `docs/真实书籍-WebGL复刻.md` |
| `capture-blocks.mjs` | 页内注卡/图片排版截图 | 开发记录 |
| `capture-close.mjs` | 合上/打开书体截图 | 开发记录 |
| `capture-immersive.mjs` | 沉浸式顶栏与「更多」菜单 | 开发记录 |
| `capture-panel-fit.mjs` | 外观/视角面板 | 开发记录 |
