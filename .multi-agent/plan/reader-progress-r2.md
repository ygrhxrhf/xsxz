# 计划：阅读器 R2 进度语义与恢复稳定性（reader-progress-r2）

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工（未勾项 + 脏工作区都会让它失败）。

## 目标

读完关掉再开书，重开位置与离开处相差不超过一屏（跨字号 / 列宽 / 窗口尺寸 / 清正文前后）；正文被清理或重下过时，锚点恢复不落到错误段落；全书百分比语义经真实数据验证并明确「估算」表达。旧书库（无锚点字段）仍可打开，回退 scrollRatio。

## 步骤

- [x] 1. 基线实证：真实 Electron + CDP 探针（复用 probe-window 骨架，不放 product 代码），夹具书驱动阅读页，测 4 组「关闭重开」恢复误差：
      组 A 换字号 18→24；组 B 换列宽 窄→宽；组 C 窗口 1100×720 → 1920×1080；组 D 清正文（body 变更）后重开。
      探针按「离开时首可见段下标 vs 重开后首可见段下标」记录误差，并强制出帧（防 smooth 滚动中途采样的测量伪影，前车之鉴：Home/End 假缺陷）。
      - 验：`node .multi-agent/evidence/reader-progress-r2-2026-11-02/r2-probe.mjs` → JSON 输出四组误差；归档证据目录
      - 验：`npm run build` 先行（探针需产物），退出码 0
- [x] 2. 按证据定位缺口（只修被测出的真问题）：
      - 若锚点恢复误差 ≤ 一屏：只补证据与语义收口，不改恢复算法。
      - 若超一屏：定位是捕获错（paragraphAnchor/visibleReadEnd）、恢复错（scrollToParagraphAnchor 时序）、还是正文变化未校验（已知嫌疑：`bodyHash` 在进度里未写，Reader.vue 只有 TTS 写 bodyHash）。
      - 结论落 `.multi-agent/reports/reader-progress-r2-findings.md`。
      - 验：报告文件含四组实测数据与逐条归因
- [x] 3. 实现修复（仅当步骤 2 测出真实缺口；文件白名单：`src/renderer/pages/Reader.vue`、`readerPager.ts`、`readerPager.test.ts`、`readerHelpers.ts`、`readerHelpers.test.ts`）：
      - 嫌疑修复 A：`captureProgressWrite` 补写 `bodyHash`（复用 ttsBodyHash 同源函数，见 Reader.vue:215），`scrollToParagraphAnchor` 先校验 `bodyHash` 一致，不一致回退 scrollRatio。
      - 嫌疑修复 B：锚点恢复在分批渲染 / 大章窗口化下的时序修正（如 waitForParagraph 已迁窗则直接 flush）。
      - 纯函数一律进 readerPager.ts / readerHelpers.ts 并配 vitest 单测；UI 文案只改数值语义不改名。
      - 验：`npm run typecheck` 退出码 0
      - 验：新增单测 `npx vitest run src/renderer/pages/readerPager.test.ts src/renderer/pages/readerHelpers.test.ts` 全绿
- [x] 4. 契约与全量回归（不得删改测试来修复）：
      - 契约：`npx vitest run src/renderer/pages/Reader.progress.contract.test.ts src/renderer/pages/Reader.accessibility.contract.test.ts` 全绿（78 用例基线）
      - 主树：`npx vitest run src --exclude .delta/`（136 文件 / 1301 用例基线）全绿
      - 验：两个命令退出码 0
- [x] 5. build + 探针复验：`npm run build` 退出码 0；重跑 r2-probe.mjs，四组恢复误差全部 ≤ 一屏可视段落数（验收线）；旧书（无锚点字段）重开仍回退 scrollRatio 不报错
      - 验：探针 JSON 四组通过 + build 退出码 0
- [x] 6. 全书百分比语义：对章节长短差异明显的夹具书（如 1 章 2000 段 + 5 章 10 段）实测展示值；确认「约/估算」表达。若证据显示误导明显，才评估按段落数加权的算法（同源反解约束：`chapterIndexFromBookRatio` 必须与写盘公式一致），否则记为「等权估算，已明确标注」不扩范围。
      - 验：归因落 reports 文件，说明留等权或改加权的理由与证据
- [x] 7. 提交与收尾：一步一提交（如：`docs: R2 恢复误差实测与归因`、`fix(reader): 进度锚点补写 bodyHash 校验`、`docs: R2 收尾`），同步 delta worktree；更新 `.multi-agent/HANDOFF.md`
      - 验：`npm run plan:status` 退出码 0；`git status --short` 干净

## 不做（显式出范围）

- 不扩展共享契约新增字段（`bodyHash` 已存在，直接接线；若实测证明必须新字段，停下来走协调者补丁流程，不擅自改 types.ts）
- 不改章节文件、annotations、tts-position、reading-frontier 格式
- 不动下载引擎、preload、IPC 白名单、`scripts/*.mjs`
- 不做网页阅读模式（Browse.vue）的进度改动
- 不重写全书进度算法除非步骤 6 证据触发，且必须同源反解
- 不引入第三方依赖、不用 v-html、不改 `data-p` 动作协议

## 已知边界

- 探针每轮真开桌面窗口（十几秒），结束自动关闭；跨 shell 重启后需 `npm run build` 先行（约 25s）
- 探针只读 instrumentation，测完按需保留在证据目录，不进 product 代码
- 大章（>2000 段）与普通章两条渲染路径都必须零回归：小章逐字节现状、大章窗口 240 段有界
- `.delta/worktrees/{8f792tj3eq1d,sb3j3p5netq9}` 与 master 同步；worktree 不同步会污染共享 .delta
- 恢复误差的「首可见段」判定沿用既有 `[data-p]` 与窗口真实几何，不引入新选择器

## 断点记录（每次停下前更新）

- 状态：进行中（步骤 1）
- 下一步第一条命令：`node .multi-agent/evidence/reader-progress-r2-2026-11-02/r2-probe.mjs`
- 未验证项：四组恢复误差的实测值（探针正在后台跑）；bodyHash 是否确为漂移根因
