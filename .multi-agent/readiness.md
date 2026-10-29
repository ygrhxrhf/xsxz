# Campaign Readiness

> 仅用于 objective 中 `执行模式=campaign`、`状态=进行中` 的长期战役。每项必须 PASS 且证据非空。

| 项 | 值 |
|---|---|
| 战役 ID | quiet-reading-20261023 |
| 目标修订 | 1 |
| 默认分支 HEAD | 2e7db64dbae0b317fd8b1e6d47e5b072f348e0c1 |
| 对照日期 | 2026-10-23 |
| 结果 | PASS |
| 处置 | 专家组从 U1.1 开工。样板已确认，不暂停等代表页 |

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 1 | 当前切片目标、范围、非目标明确 | PASS | scheme 逐刀实现说明 U1.6 与真实操作验收 OP-13、OP-14；objective 非目标。本刀只把 hideSiteTail 与 hideReaderChrome 两布尔写进 ReaderPrefs、DEFAULT_READER_PREFS 与 settings 归一，并在字体面板接 COPY-1「净化」与 COPY-3「工具一直显示」 |
| 2 | 当前切片验收标准可观察 | PASS | scheme 真实操作验收 OP-13、OP-14，对应 U1.6；另有缺省 true、旧文件缺字段补 true、两开关方向断言 |
| 3 | 验证命令来自仓库且可执行 | PASS | package.json：`npm run build`、`npm test`。U1.6 验证列 build,contract |
| 4 | worktree、回滚与集成策略明确 | PASS | decision-log：业务只在 worktree；ff-only 合入；用户已授权完成后推送。失败处置在 scheme。worktree `.dsh/worktrees/session-<短ID>` |
| 5 | 目标修订和默认分支 HEAD 已核对 | PASS | 目标修订 1。合入后 HEAD 2e7db64dbae0b317fd8b1e6d47e5b072f348e0c1，git rev-parse HEAD 一致。本刀为协调者批准的字段级补丁：两可选布尔进 ReaderPrefs 与 DEFAULT_READER_PREFS（均 true），settings 归一按现有 bool 写法补缺；合入前已核对 src/preload/index.ts、docs/ipc-contract.md、docs/disk-schema.md 零命中，IPC 名未变。合入后 OP-13、OP-14 画面待跑，U1.6 保持 integrated 不标 done |
| 6 | 未决假设有 owner、验证时点和失败处置 | PASS | 无未决产品假设。挑刺已核销，见 sweep.md「挑刺复核：通过」。实现者说明：关闭「工具一直显示」只记偏好、不立刻收起顶栏（避免抢走正开着的字体面板），收起发生在下次进入与 Esc；该取舍已由实现按 scheme 落定，OP-14 只要求开启后重启仍在 |
| 7 | 跨模块接口和依赖已识别，或明确不适用 | PASS | 本刀即契约补丁：types.ts 加两可选布尔、settings.ts 归一补齐。不改 preload、不改 IPC 名、不改其他设置项。无 native 模块、无新依赖 |
| 8 | 数据与兼容策略明确，或明确不碰数据 | PASS | 旧 settings.json 缺两字段按 true 补齐，已由 settings.readerPrefs.test.ts 锁定；不改章节 json、annotations、tts-position、reading-frontier、书库格式 |
| 9 | 安全、权限和敏感信息边界明确 | PASS | 不碰 API Key，不新增网络，正文仍纯文本渲染且禁止 v-html。AGENTS.md 禁令仍在 |
| 10 | 用户授权覆盖实现、commit、合入和 Goal；「继续推进」视为合入授权 | PASS | 用户原话「完全确认，专家组可无人值守推进直到完成」。本轮口令「继续推进」。objective 自主实现/commit/合入/Goal=是。push 授权：用户原话「开发完成后，直接推送」，只在全部 done 后推 master |
| 11 | 当前阶段需要的体验、文案和异常行为明确，或说明不适用 | PASS | scheme 默认体验、文案 COPY-7 空态沿用、快捷键节。样板已确认：用户原话「完全确认，专家组可无人值守推进直到完成」，样板 153961e |
| 12 | 风险、Reviewer/Red Team 条件和停止规则明确 | PASS | scheme 越权墙：改章节、改下载、改其他页、加字体或新依赖则停。主路径不可 skipped |

## 本轮变化与局部复审

- 变化：U1.1 ff-only 合入。HEAD 从 8997870 变为 1b86a79890b18c81011271963ea62285abc44c24
- 受影响条目：第 5 行已按新 HEAD 复核为 PASS。总结果改回 PASS，只为派合入后 e2e 与 OP-1 至 OP-5。未跑完之前 U1.1 保持 integrated，不标 done
- 待用户决定：无


- HEAD 已变化为 995e69d616deafbee3383fea0ee6252261f0ed2c。门禁已把结果标为 PENDING。复核受影响行之后才能再派工。


- HEAD 已变化为 09f165ab7fe5c4bfc6707088f1b8de2331097a31。门禁已把结果标为 PENDING。复核受影响行之后才能再派工。


- HEAD 已变化为 35002d153bd2a3e23bf20e43448efaa68131f252。门禁已把结果标为 PENDING。复核受影响行之后才能再派工。


- HEAD 已变化为 33e1401ea52103871e8974a13aaf579227c80f5e。门禁已把结果标为 PENDING。复核受影响行之后才能再派工。


- HEAD 已变化为 2944406d0e9b166db884835c1b552fdeb72b0eb3。门禁已把结果标为 PENDING。复核受影响行之后才能再派工。


- HEAD 已变化为 2e7db64dbae0b317fd8b1e6d47e5b072f348e0c1。门禁已把结果标为 PENDING。复核受影响行之后才能再派工。
