# R2 恢复误差实测与归因（reader-progress-r2）

> 证据目录：`.multi-agent/evidence/reader-progress-r2-2026-11-02/`（r2-probe.mjs + r2-probe-report.json）
> 方法：真实 Electron + CDP 探针，每组「关闭应用 → 改排版/改正文 → 重开应用」，
> 按「离开时盘上的锚点段 vs 重开后首可见段」记误差，采样前强制出帧（防 smooth 滚动伪影）。

## 一、六组实测数据（修复后复验，2026-11-02T07:22 全量）

| 场景 | 离开锚点段 | 重开首可见段 | 误差（段） | 一屏段数 | 判定 |
|---|---|---|---|---|---|
| A 字号 18→24 | 105 | 105 | 0 | 8.0 | PASS |
| B 列宽 窄→宽 | 105 | 105 | 0 | 10.6 | PASS |
| C 窗口 1100×720→1920×1080 | 107 | 107 | 0 | 15.9 | PASS |
| C0 锚点 offset=0 | 107 | 107 | 0 | 15.9 | PASS（修复后） |
| D 清正文（200→60 段） | 105 | 28 | 5（回退位） | 10.6 | PASS |
| D2 正文替换（段数相同） | 105 | 105 | 5（回退位） | 10.6 | PASS（修复后） |

修复前基线：C0 首可见 0（滚回章首，107 段误差）；D2 无 bodyHash 校验撞进错段。
修复后：6/6 全 PASS，`npm run build` 退出码 0。

## 二、逐条归因

### 1. 锚点恢复跨排版零漂移（A / B / C）
- 锚点 = `paragraphIndex + paragraphOffset`（正文段落坐标 + 段内字符偏移），
  捕获端 `paragraphAnchor()` 按「视口顶 +4px 处的段落与字符」二分定位，
  恢复端 `scrollToParagraphAnchor()` 把同一字符滚回视口顶 -4px。
- 字号变大、列宽变宽、窗口变大都不改变「段落下标 + 段内字符偏移」的正文坐标语义，
  恢复落点与离开处一致（误差 0 段，远小于一屏）。
- 结论：**锚点捕获与恢复算法本身正确**，R2 核心目标在正常锚点下成立。

### 2. 真实缺陷（修复）：`paragraphOffset=0` 时恢复滚回章首（C0）
- 触发条件：`paragraphAnchor()` 在「段落顶部 ≥ 视口顶 +4px」时返回
  `{ paragraphIndex, paragraphOffset: 0 }`（段落开头恰好压在视口顶线下，真实可达）。
- 失效机制（探针复刻实证）：
  1. 段落 `<p data-p="N">` 内嵌 `<button class="para-tts-start">从此段朗读</button>`，
     `paragraphTextNodes()` 过滤按钮后代文本，但**按钮前后的空白文本节点（缩进/换行）留下**；
  2. `textPoint(nodes, 0)` 命中第一个空文本节点（`left(0) <= length(0)`）；
  3. `range.setStart(空节点, 0)`、`setEnd(空节点, min(1, 0)=0)` → **空 range**；
  4. 空 range 的 `getBoundingClientRect()` 返回全零矩形 `(0,0)`；
  5. `pane.scrollTop += 0 - paneTop - 4` → **负值被钳到 0，页面滚回章首**。
- 修复：`Reader.vue` `textPoint()` 跳过空文本节点（`node.length === 0` continue），
  空节点不能作锚点（无可视字符、无几何）。修复后 C0 首可见段 = 107，恢复精确。
- 影响面：任何以空文本节点开头的段落（含朗读按钮的段落普遍如此）+ 锚点 offset=0
  （段落开头对齐视口顶）都会触发；真实书库中概率不低。

### 3. 真实缺陷（修复）：正文变更未校验，锚点落到错误段落（D / D2）
- 修复前：`captureProgressWrite` 不写 `bodyHash`（磁盘 progress 实测 `hasBodyHash: false`），
  `scrollToParagraphAnchor` 也不校验正文指纹。
- D（段数变少 200→60）：锚点 105 越界 → 校验失败返回 false → `scrollToRatio(0.55)`
  回退到比例位（新正文 ~33 段附近，实测首可见 28，误差 5 段 < 一屏）。
  **修复前这段路径是侥幸正确的**：依赖「越界 → 回退」，段数恰好变少才触发。
- D2（段数相同、内容全不同）：旧锚点 105 依然有效 → 照常定位到新正文的 105 段——
  **内容已变但毫无察觉，读者被带进错误段落**（位置恰好同位，段号法测不出内容错位）。
- 修复：`captureProgressWrite` 补写 `bodyHash`（复用 `ttsBodyHash`，与 TTS 同源）；
  `scrollToParagraphAnchor` 先经 `progressAnchorBodyMatches` 校验正文指纹，
  不一致返回 false → `openChapter` 回退 `scrollRatio`。旧书（无 bodyHash）跳过校验保持兼容。
- 修复后：D2 磁盘 `hasBodyHash: true`，正文替换后指纹不一致 → 回退比例位（误差 5 段 < 一屏）。
- 单测：`readerHelpers.test.ts` 新增 4 例 `progressAnchorBodyMatches`（缺省放行 / 一致放行 /
  清理后拒绝 / 段数相同也识破），全绿。

## 三、全书百分比语义（步骤 6）

### 等权估算的误导实测（1 章 2000 段 + 5 章 10 段）
| 位置 | 等权估算显示 | 段落加权真实已读 |
|---|---|---|
| 第 1 章（2000 段）读完 | 17% | 98% |
| 第 2 章（10 段）开头 | 17% | 98% |
| 最后一章读完 | 100% | 100% |

### 决策：保持等权估算，已明确标注，不扩范围
- 理由 1：**误导确实存在**（章节长短差异极端时），但加权需要「各章段落数」数据源——
  `ChapterMeta` 无段落数字段，Reader 打开书时只有当前章 body，需读全部章节文件或常驻段数缓存，
  改动面超出 R2 白名单语义收口。
- 理由 2：**同源反解约束**：进度条拖动 `chapterIndexFromBookRatio` 若改加权，必须与写盘公式
  同步改（当前 50% → 第 4 章等权；加权想定下 50% 应落第 1 章内）。两处联动改，风险大于收益。
- 理由 3：UI 文案已带「约」（`全书约 X%`），readerHelpers 注释已明示「章节等权估算」。
- 结论：记为「等权估算，已明确标注」，不扩范围；留待后续（若引入章节段数缓存）再评估加权。

## 四、修复清单（提交）

1. `fix(reader): textPoint 跳过空文本节点，offset=0 锚点恢复不再滚回章首`
2. `fix(reader): 进度补写 bodyHash 并在恢复端校验，正文变更回退 scrollRatio`
3. `test(reader): progressAnchorBodyMatches 指纹校验单测`

## 五、验收对照（修复后探针复验）

- A/B/C 恢复误差 0 段（≤ 一屏）✓
- C0（offset=0）恢复误差 0 段（修复后）✓
- D 回退比例位（误差 5 段 < 一屏）✓
- D2 正文替换：bodyHash 不一致 → 回退 scrollRatio（修复后）✓
- 旧书（无 bodyHash / 无锚点字段）重开回退 scrollRatio 不报错（C0 场景 leaveViaIpc
  未写 bodyHash，恢复仍成功，等价旧书路径）✓
- `npm run build` 退出码 0 ✓；`npm run typecheck` 退出码 0 ✓
- 单测：readerHelpers.test.ts（88 例）+ readerPager.test.ts（25 例）全绿 ✓

