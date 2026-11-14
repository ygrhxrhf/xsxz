# 真实书籍 WebGL 复刻

## 开关

阅读界面 → 真实书籍 → 展开底栏 → **背景** → **书籍渲染**：

- **WebGL 3D**：Three.js 书体、双页纹理、书脊/封面/页堆、开合与翻页、视角与缩放。
- **CSS 3D 回退**：原来的 DOM 文本 + CSS 3D 实现，保留批注、选字和既有 E2E。

选择存本机 `localStorage`，不写入 `ReaderPrefs`，不跨设备同步。支持 WebGL 的机器默认进入 WebGL 3D；用户显式选过 CSS 3D 或环境不支持 WebGL 时才回退。WebGL 层的文字选择/批注命中仍未接上，需要完整选字时手动切回 CSS 3D。

## 已实现

- 固定 `640×920` 逻辑页、2× 分辨率页面纹理；分页器现在把每页的真实断行一起交给纹理层。
- 双页摊开、书脊、硬壳封面、封内衬纸、左右纸垛厚度、桌面材质和基础灯光/阴影。
- 自动翻页：飞行页正反面纹理、绕书脊旋转 + 连续弧面收卷、1500ms 行程，翻页页参与投影阴影。
- 合上/打开书籍；底栏按钮状态通过 `update:open` 回传 Reader。
- 相机：`24°` FOV、默认 25° 俯仰、平视 1° / 斜视 52°、最大 62°；右键或 Alt 拖动调整视角；`T` 在 WebGL 真实书籍里循环视角预设。
- 缩放：默认 90%，范围 12%–700%；底栏 ± 按 ×0.8/×1.25，滚轮缩放，复原回到 90%。
- 阅读外观：胡桃木/亚麻/石墨/鼠尾草/石灰岩桌面（使用采集的 webp 贴图），象牙白/沙色/板岩/鼠尾草/勃艮第红衬纸，存本机。
- 透明命中层：按 WebGL 书体屏幕投影给 Reader 做左右三分区翻页。
- 批注与划线会绘制进页面纹理；注卡和“注”标记在 WebGL 页面中可见；红/紫划线不再回落成黄色。

## 未实现 / 已知限制

- WebGL 模式没有透明 DOM 逐词文本层，因此原生选字、跨页选择、点击页内批注编辑、搜索命中交互仍只在 CSS 3D 回退中完整可用。
- 翻页目前是连续弧面 + 绕脊旋转，不是参考站的 40×8 质点布料模拟；飞页软阴影只借用 Three 的 shadowMap，尚未做飞页之间的自阴影。
- 拖页抓角、取消回弹、悬停预掀与多飞页并发仍未接；目前按钮/方向键/点击分区翻页可用。
- 手机单页重排未接：WebGL 仍按桌面双页排版，窄屏只做相机适配。
- 封面仍是程序化绘制；桌面已改用采集的 webp，衬纸仍是色板。
- WebGL 模式仍缺透明 DOM 逐词文本层，选字/跨页选择/页内批注编辑要切回 CSS 3D。

## 技术边界

- 新增 `RealBookWebGLStage.vue` 作为 `RealBookStage.vue` 的渲染子层，分页、锚点、进度和批注数据仍由父组件提供。
- 新增 `realBookTexture.ts` 负责页面纹理计划与 Canvas 绘制；`realBookWebGLModel.ts` 负责可测试的相机/厚度/色板数值；`realBookWebGLScene.ts` 是 Three.js 场景。
- 新增 JS 依赖 `three@0.187.0`，无 native 模块。
- `src/preload/index.ts`、`src/shared/types.ts` 未改动。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run e2e:realbook-notes   # CSS 3D 回退的批注/持久化 E2E
```

WebGL 模式的真实 Electron 检查使用临时脚本 `.multi-agent/tmp/realbook-webgl-check.mjs`：确认 canvas 挂载、书体命中区、翻页页码推进、合上/打开按钮和外观/视角面板。
