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
- 整站镜像、站点 CSS 选择器市场
- 账号 / 云同步

## 不要做

- 破解付费墙、验证码自动打码、IP 池与代理轮换、专门反反爬：这些绕过站点自身的访问控制与反滥用机制，本项目不做。允许的是用户用自己的账号在内置浏览页亲自登录或通过验证，再用这份已有登录态续下原本就对他开放的章节。
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
