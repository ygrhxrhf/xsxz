# 计划：真实书籍纸书精细建模

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工（未判定的脏工作区会单独说明）。

## 目标

让真实书籍模式从「两张贴平的纸」提升为可读的精细纸书：有硬壳封面、四周页缘与纸垛、
可信的书脊谷、纸张纤维和层次光影；正文排版、分页与翻页位置不变。

## 步骤

- [x] 1. 调查 / 定位：对照用户截图、现有截图、DOM 与样式，列出平面感来源
      - 验：`git diff -- src/renderer/pages/RealBookStage.vue` 与基线截图 → 确认封面、页缘、纸纹、书脊缺失
- [x] 2. 设计：只改视觉层，补硬壳、三面书口、纸纹、书脊谷与桌面光；不改分页和正文 DOM 结构
      - 验：本计划「设计结论」段落 → 逐项对应到实现
- [x] 3. 实现：`src/renderer/pages/RealBookStage.vue`，必要时只补本地测试
      - 验：`npm run typecheck` → exit 0
- [x] 4. 测试：真实书籍舞台、卷页几何、书厚与 Reader 接线
      - 验：`npx vitest run src/renderer/pages/RealBookStage.ui.test.ts src/renderer/pages/realBookFlip.test.ts src/renderer/pages/realBookSpine.test.ts src/renderer/pages/Reader.realBook.ui.test.ts` → 全绿
- [x] 5. 真机视觉与性能：构建后跑 Electron 截图脚本，检查封面、书口、纸纹、书缝与翻页
      - 验：`npm run build` 后 `$env:SPBF_KEEP_SHOTS='1'; node scripts/realbook-flip-fps-e2e.mjs` → 截图可看，视觉断言通过
- [x] 6. 提交：`feat(reader): 真实书籍翻页弯曲舒展与纸张精修`
      - 验：`git log --oneline -1` → 本地提交存在
- [x] 7. 收尾：写 HANDOFF，更新计划证据，核对工作区
      - 验：`npm run plan:status` → 本任务项全勾；既有未提交并行改动明确列出

## 设计结论

1. **硬壳封面**：左右各一块略大于纸页的深色封面，沿各自书脊轴旋转，露出包边与压印线。
2. **三面书口**：纸垛同时画外书口、上下切口，用多层细线表现纸页叠层，而不是只挂一条厚边。
3. **书脊谷**：去掉当前像金属圆棒的双亮边，改成纸页向脊心逐渐落入的窄暗谷和一条极弱折痕。
4. **纸张纤维**：页面与翻动纸共用多尺度纤维纹理、轻微斑点、全局受光与边缘暗角；纹理不挡字。
5. **光与重量**：页面外缘受光、书心保持纸色，不压暗带；书下加接触阴影与更远的软投影；桌面加低对比布纹。
6. **边界**：不改分页算法、翻页时间线、IPC、类型或正文结构；纹理全部 CSS 生成，不引入图片与 native 依赖。

## 不做（显式出范围）

- 不重写翻页几何，不改页表、字号、版心与书厚进度算法。
- 不引入 WebGL / Three.js / 图片贴图。
- 不改 `src/preload/index.ts`、`types.ts`、IPC 或非阅读器文件。

## 已知边界

- 工作区已有大量并行未提交改动（`Reader.vue`、书库 IPC、agent 集成等）；本任务只动
  `RealBookStage.vue`、其测试与本计划，不清理、不暂存别人的改动。
- 视觉验收以真实 Electron 截图为主；jsdom 只钉住结构，不能证明 CSS 光影。

## 断点记录（每次停下前更新）

- 状态：已提交（`93282dc`），收尾完成
- 已验证：
  - `npm run typecheck` → exit 0
  - 4 个阅读器测试文件 → 70/70 通过
  - `node scripts/realbook-flip-fps-e2e.mjs`（热态，左右交替翻页）→ 10/10 通过：
    823ms / 34 帧 / 中位 21.0ms / 严重长帧 0 / 长帧 1
  - 慢动作确定性截图（t=0.30/0.45/0.62）：
    纸面弓起、外角卷曲、上下缘收弯，落定前舒展摊平
- 下一步第一条命令：无（本任务完成）
- 未验证项：不同 DPI / 低端机上的长期帧率；其他主题色下的纸纹观感

## 收尾核对

- `npm run plan:status`：本计划 7 项已全勾；退出码仍为 1，因为工作区有 14 个
  并行任务的未提交文件（`Reader.vue`、书库 IPC、preload、agent 集成、`realBookSpine` 等）。
  这些都不是本任务改动，未清理、未暂存、未提交。
- `.multi-agent/HANDOFF.md` 已追加本任务状态；该文件同时含并行任务的未提交段落，
  因此未纳入本任务提交。

## 追加修正：书心去阴影（2026-11-09）

- 用户反馈：书籍中间仍有一条阴影。
- 根因：`.real-book-gutter` 用深色渐变画“书脊谷”，左右页又叠了靠脊暗渐变；
  14px 书心因此读成一条竖直暗带。
- 修法：书心改成与纸页相同的纸色；删除书脊暗渐变、中线折痕与向下阴影；
  书心向两侧各压进 2px 盖住页缘抗锯齿缝；再用纸色渐变过渡抹平 1px 边界差。
- 验：`npm run typecheck` → 0；3 个阅读器测试文件 → 60/60；
  `SPBF_SLOW_FLIP=1 node scripts/realbook-flip-fps-e2e.mjs` →
  书心亮度：左纸 222.8 / 中缝均 223.1 / 右纸 224.2，中缝最低 223；
  “书心没有暗带”用例通过，5/5。
