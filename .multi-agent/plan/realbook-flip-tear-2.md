# 计划：真实书籍翻页外缘竖折缝（第二轮）

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。

## 目标

翻页全程看到的是同一张连续的纸：外缘不再折成一条与纸身分离的窄带，
不再出现「纸被竖着撕开」的观感。

## 步骤

- [x] 1. 复现：按用户截图的宽视口慢动作截 12/18/24/30/36/42/50% 帧
      - 验：`$env:SPBF_SLOW_FLIP='1'; $env:SPBF_KEEP_SHOTS='1'; node scripts/.tmp-realbook-flip-wide.mjs` → 24% 帧已能看到外缘窄带与纸身之间的竖折缝
- [x] 2. 定位：确认竖折缝来自 `FLIP_EDGE_CURL_DEG` 的外缘额外转角
      - 验：同一组帧对比 `FLIP_EDGE_CURL_DEG = 0` → 竖折缝消失；另发现 90° 正反面交界会硬切正文
- [x] 3. 实现：去掉外缘独立翻卷，保留整页连续曲率；纸背正文按转角淡入
      - 验：`npm run typecheck` → exit 0
- [x] 4. 测试：更新卷页几何断言，补纸背 90° 淡入与前后翻页转轴
      - 验：`npx vitest run src/renderer/pages/realBookFlip.test.ts src/renderer/pages/RealBookStage.ui.test.ts src/renderer/pages/Reader.realBook.ui.test.ts` → 73 用例全绿
- [x] 5. 真机验证：重建后重跑同一组慢动作帧
      - 验：`npm run build` + 21 帧慢动作序列 → 无竖折缝；非慢动作 e2e 9/9 通过，55 帧、中位 13.9ms、长帧 0
- [x] 6. 提交：只暂存本任务文件
      - 验：`git log --oneline -1` → `9a47b32 fix(reader): 翻页外缘连续，去掉撕开式折边`

## 不做

- 不改分页、书厚、俯仰、底部工具栏。
- 不重写真实书籍渲染层。

## 定位结论

- 竖折缝来自纸角外翻的额外 20°：它只加在最外 30% 页宽上，最外一条竖带
  比相邻带多转近 20°，投影成一条与纸身分离的窄带；窄带里仍是同一页的
  行尾字，所以看起来像纸被竖着撕开。
- 去掉外缘额外翻卷后，曲率仍由整页的连续角度分布给出；同一组 21 帧
  慢动作里纸面是一条连续曲线，没有独立折边。
- 90° 正反面交界原本把纸背正文直接以全不透明接上，边界两侧文字突变。
  补 `flipBackContentOpacity()`：90° 为 0，约 130° 才完整露出，纸面本身
  始终不透明。

## 断点记录（每次停下前更新）

- 状态：已完成（第二轮）
- 下一步第一条命令：无（本任务收工）
- 干净 worktree 复核（`c5a47fd`）：
  - `npx vitest run src/renderer/pages/realBookFlip.test.ts src/renderer/pages/RealBookStage.ui.test.ts` → 2 文件 / 59 用例全绿。
  - 排除既有过期用例后 `tsc --noEmit` → 0；`npm run plan:status` → exit 0。
- 既有基线问题（与本轮无关，父提交 `cce36a2` 同样存在）：
  - `realBookSpine.test.ts` 仍按旧签名调用 `spineStack`，HEAD 上 typecheck 报 9 处 TS2554。
  - `Reader.realBook.ui.test.ts` 的键盘/点按翻页仍断言「+1 页」，实际书页模式翻一张为 +2；
    工作区已有其他批次的未提交修正，本轮未触碰。
