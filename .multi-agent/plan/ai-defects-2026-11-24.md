# 计划：修复 AI 功能剩余缺陷（2026-11-24）

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工（未勾项 + 脏工作区都会让它失败）。

## 目标

把 2026-11-24 审计列出的 AI 缺陷全部修掉：问答支持多轮、问答不再预读全书、语义面板不再全量读正文；自动追剧记忆不丢章、读完最后一章即上报；AI 请求走应用内代理；自定义端点启用 JSON 模式与 usage；地名抽取守住 30000 字预算；502/504 重试；清正文可显示批次进度且不会覆盖新正文；无 Key 时追剧不空转；TierSense 压缩不丢 system 规则；未验证的连接测试不写信任列表。

## 步骤

- [x] 1. 问答多轮 + 去掉预读全书（`src/main/index.ts`、`src/main/aiEvidenceQa.ts`、测试）
      - 验：`npx vitest run src/main/aiEvidenceQa.test.ts src/main/aiEvidenceQa.ipc.contract.test.ts src/main/aiReaderNotesIntoQa.test.ts` → 全绿
- [x] 2. 语义状态/找场景按需读盘（`src/main/semanticSearch.ts`、测试）
      - 验：`npx vitest run src/main/semanticSearch.test.ts` → 全绿
- [x] 3. 追剧记忆只标记已处理章 + 读完即上报 + 无 Key 不空转（`src/main/aiReadingFollow.ts`、`src/renderer/pages/Reader.vue`、测试）
      - 验：`npx vitest run src/main/aiReadingFollow.test.ts src/renderer/pages/Reader.followFlow.test.ts` → 全绿
- [x] 4. AI 请求走应用内代理（`src/main/aiFetch.ts`、`src/main/ai.ts`、`src/main/semanticSearch.ts`、`src/main/tts.ts`、`src/main/coverImage.ts`、`src/main/index.ts`、`src/main/proxyRuntime.ts`、测试）
      - 验：`npx vitest run src/main/ai.transport.test.ts src/main/proxy.test.ts` → 全绿
- [x] 5. 自定义端点响应格式/usage + 502/504 重试 + 地名抽取预算（`src/main/ai.ts`、`src/main/aiPlaces.ts`、`src/main/index.ts`、测试）
      - 验：`npx vitest run src/main/ai.transport.test.ts src/main/aiPlaces.test.ts` → 全绿
- [x] 6. 清正文进度与覆盖保护 + TierSense 保留 system + 提示词防注入 + 连接测试后置信任（`src/main/index.ts`、`src/main/ai.ts`、`src/main/aiPlaces.ts`、`src/main/tierSense.ts`、`src/renderer/pages/Reader.vue`、`src/renderer/pages/Settings.vue`、`src/preload/index.ts`、测试）
      - 验：`npx vitest run src/main/tierSense.test.ts src/main/ai.prompts.test.ts src/main/ai.cleanBatch.test.ts` → 全绿
- [x] 7. 全量回归 + 断点收尾
      - 验：`npm run typecheck` 退出码 0；`npm run build` 退出码 0；`npx vitest run --maxWorkers=2` → 208 文件 / 2069 用例全绿；`npm run plan:status` 退出码 0

## 不做（显式出范围）

- 不实现「推荐同类书」：与现有「只答书内证据」的隐私边界冲突，需产品决策。
- 不重做 ai.clean 的 IPC 形状（仅加批次进度事件，不改返回契约）。
- 不接入 Anthropic 原生协议，继续只做 OpenAI 兼容。

## 已知边界

- Electron 的 `net.fetch` 只在真实 Electron 进程使用，单测仍走全局 fetch。
- 自动追剧「上次正文失效」的章仍可能需要用户点一次「继续」，但不再永久静默丢记忆。
- 语义索引总段数改为落盘计数，刚读完的新章在下一次索引唤醒前显示为「待更新」。

## 断点记录（每次停下前更新）

- 状态：完成
- 下一步第一条命令：（无）
- 未验证项：真实代理环境下 AI 请求走 `net.fetch` 的 e2e 未跑；Electron 打包版未重装冒烟。
