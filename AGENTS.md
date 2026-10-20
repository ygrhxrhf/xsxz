# 小说浏览器（spbf）

Windows 单机：内置浏览 → 下载本书 → 书库 + 阅读器 → 自备 API Key 的 AI。

需求：`docs/requirements.md`  
IPC：`docs/ipc-contract.md`  
磁盘：`docs/disk-schema.md`  
类型：`src/shared/types.ts`

界面语言：**中文**。

## 技术钉死

- Electron + electron-vite + Vue 3 + TypeScript + Naive UI
- 浏览与下载共用 `session.fromPartition('persist:novel')`
- 下载用隐藏 `webContents` 逐章 `loadURL`，禁止裸 `fetch` 当下书主路径
- 无 native 模块（本机无 VS2022）
- 章节正文只渲染纯文本，禁止 `v-html`

## 可以做

- 内置浏览、下载本书、书库 / 阅读、自备 API Key 的 AI
- 本机按域名配置站点 CSS 规则；导入 txt / epub
- 付费墙自动解锁（页面内恢复正文：隐藏节点 / 内嵌数据 / 编码载荷 / 隐藏续页；服务端不下发的正文不找回）
- 整站镜像、站点 CSS 选择器市场
- 账号 / 云同步

## 不要做

- 工人私自改 `src/preload/index.ts` 或给 `types.ts` 加字段（走协调者补丁）
- 工人改不属于自己的文件

## 文件所有权

| 路径 | 写者 |
|---|---|
| `src/shared/types.ts` | 契约官；之后协调者补丁 |
| `docs/ipc-contract.md` `docs/disk-schema.md` | 同上 |
| `src/main/index.ts` | 脚手架工；之后协调者按 IPC 补丁追加 |
| `src/preload/index.ts` | 契约阶段定白名单；各阶段协调者合并 |
| `src/main/session.ts` 浏览 View | 脚手架 / 浏览 |
| `src/main/library.ts` `importTxt.ts` `importEpub.ts` | 书库工 |
| `src/main/extract.ts` `download.ts` | 下载工 |
| `src/main/ai.ts` `settings.ts` | AI 工 |
| `src/renderer/App.vue` | 脚手架工 |
| `src/renderer/pages/Browse.vue` | 浏览 |
| `src/renderer/pages/Library.vue` | 书库工 |
| `src/renderer/pages/Reader.vue` | 阅读工 |
| `src/renderer/pages/Settings.vue` | AI 工（书库路径经协调者并入） |

需要改非己文件：先问协调者，禁止直接改。

### 协调者补丁的执行方式

协调者负责审核共享类型、契约、IPC 白名单和集成接线的字段级补丁，不要求主 Agent 亲自改产品代码。允许协调者通过 `subagent_implement` 委派一名“契约/集成实现专家”执行已批准补丁；任务必须明确 worktree、文件白名单、字段/IPC 变更、前置依赖与验证方式。此授权仅限该任务，普通工人仍不得越权。

同一 worktree 的实现串行执行。契约/集成专家在 worktree 提交后，由协调者审核变更和验证证据并合入；不得用 shell 绕过写入门禁，不得借集成任务扩大产品范围。

## 工人交付

```
结果: succeeded | failed
做了: （3～8 条）
文件: 逗号分隔路径
怎么验: 命令或手测步骤
风险: 未测的站/边界
需要协调者: 要挂的 IPC 名 / 要求补的类型
```

失败必须明确 failed。产品范围不清就问，不要猜。

## 长任务断点协议（防「活没干完就停」）

turn 边界、上下文上限、子代理静默失败都会把工作停在半路。判断「做完」不许靠自述，只认下面两条硬证据：**计划项都有命令证据** + **工作区干净**。

1. **开工先挂 goal**：多步任务第一条动作是建持久目标（objective 可验收）。goal 没到 complete，不许把回复写成「已完成」。
2. **计划落盘**：`.multi-agent/plan/<task>.md`，模板 `TEMPLATE.md`；每项写清「验：命令 → 期望」。没跑过的项不许勾。
3. **一步一提交**：一个可验证的小单元一个 commit。工作区脏着 = 没有断点，不许停手。
4. **停手前写 HANDOFF**：更新 `.multi-agent/HANDOFF.md`——做到哪、下一步第一条命令、已验证证据、未验证项。新会话读它，不读上一轮的聊天记录。
5. **收工自检**：`npm run plan:status` 退出码 0 才允许说完成（未勾项、未提交改动都会让它失败）。
6. **子代理只信文件**：委派必须给报告文件路径，并要求回复不超过 5 行。子代理 error / 超时 → 换模型重试一次，仍失败就自己做，**不许把没产出当通过**。
7. **一个 worktree 一个写者**：并行前先分文件范围；出现来源不明的提交就停下来对账，别在别人半截工作上加码。

