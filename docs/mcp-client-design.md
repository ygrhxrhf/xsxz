# MCP 客户端层设计：Notion 与 Craft 作为只读知识源

> **实现状态（2026-11-27 更新）**：Craft 已接入并验证；Notion 未实现（本轮范围内只做 Craft）。
> 实际落地与本文早期的 Notion 设想有出入，以 §9「已落地的 Craft 接入」为准。

> 本文只给文件清单与接口签名，不含实现代码，也不改 `src/` 下任何现有文件。
> 结论先行：新建 `src/main/mcpClient/` 通用客户端层；Notion 与 Craft 各自只贡献一份 provider 配置；
> 工具在 `src/main/aiAgent.ts:140` 的 `buildTools` 并入；外部引用**不**写进 `state.citations`（原因见 §5）。

---

## 0. 已核实的代码事实

每一条都在本会话内读过或查过，未核实的不写。三类来源分开标注：

- **读文件**：`read` / `grep_search` 命中行，行号即命中行；
- **搜全仓**（「零命中」类结论）：`grep_search` 的 `files_with_matches` 结果为空；
- **网络**（§「关于两个服务端点」）：`curl.exe` 取的元数据、`agent_extract` 取的第三方目录，
  结果不可复现的以「待探针确认」标注。

| 事实 | 位置 |
|---|---|
| 工具唯一挂载点：`tools: buildTools(options.toolkit, state)` | `src/main/aiAgent.ts:288` |
| `buildTools(toolkit, state)` 返回 `AgentTool<any>[]`，`state` 形状 `{ toolCalls; citations; onCitations? }` | `src/main/aiAgent.ts:140` |
| 引用收集器 `collect()` 把引用去重推进 `state.citations` 并回调 `onCitations` | `src/main/aiAgent.ts:141-146` |
| 工具上限常量 `MAX_AGENT_TOOL_CALLS = 12` | `src/main/aiAgent.ts:79` |
| 工具状态行标签：`TOOL_LABELS[event.toolName] ?? event.toolName`（回落值即工具名） | `src/main/aiAgent.ts:318`、`:326` |
| 系统提示 `buildReaderAgentSystemPrompt` 手写工具清单与用法分流 | `src/main/aiAgent.ts:23-63` |
| `AgentReaderToolkit` 五个书籍本地方法（`listChapters` … `chapterNotesDigest`） | `src/main/aiAgent.ts:88-97` |
| 只有一个 `ai.agentChat` handler 调 `runReaderAgent`，`onCitations` 走 `sendAiEvidence` | `src/main/index.ts:2233`、`:2248`、`:292-296` |
| `AiCitation` 只有 id/chapterId/chapterTitle/paragraphIndex/excerpt，**没有 url、没有来源区分** | `src/shared/types.ts:1083-1089` |
| `AiStageEvent.citations?: AiCitation[]` | `src/shared/types.ts:1365-1372` |
| `isChatCitation` 要求 `chapterId` 非空、`paragraphIndex` 为非负整数、`excerpt` 非空 | `src/main/library.ts:1038-1042` |
| 任一条 citation 不合法 → 整条消息在读取时被丢弃（`return null`） | `src/main/library.ts:1069-1071` |
| 设置页分区类型 `SettingsSection` 与 `sectionOptions` 数组 | `src/renderer/pages/Settings.vue:50`、`:265-277` |
| preload 的 `settings` / `ai` 命名空间即白名单形状 | `src/preload/index.ts:254`、`:464` |
| IPC 契约文档已有 `## AI`、`## Agent 调用审计`、`## preload 白名单形状` 三节 | `docs/ipc-contract.md:510`、`:609`、`:617` |
| 主进程 `index.ts` **没有**引入 `shell`；全 `src/` 搜 `openExternal` 零命中 | `src/main/index.ts:1`（import 行） |
| `src/main` 有两处 `createServer`：`agentBridge.ts` 用 `node:net`（命名管道，MCP 服务端）、`proxyKernel.ts` 起本地代理进程；**都没有现成的 HTTP 回环服务器可复用** | `src/main/agentBridge.ts:18` |
| pi 的 `AgentTool` 支持 `prepareArguments(args: unknown)` 与 `execute(toolCallId, params, signal?, onUpdate?)` | `node_modules/@mariozechner/pi-agent-core/dist/types.d.ts:295-304` |
| `beforeToolCall(context, signal)` 为异步且被 await，返回 `{ block, reason }` 可拦截 | 同上 `:199-205` |
| SDK 自带 `Client.listTools()` / `Client.callTool()` | `node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts:539`、`:431` |
| SDK 的 `OAuthClientProvider` 提供 `redirectUrl` / `saveClientInformation` / `saveTokens` / `redirectToAuthorization` / `saveCodeVerifier` / `codeVerifier` | `node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.d.ts:21,56,69,73,78,83` |
| `StreamableHTTPClientTransport` 支持 `authProvider` 与 `finishAuth(code)` 后重连 | `node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.d.ts:67,73` |
| `tools/list` 每项可带 `annotations.readOnlyHint` | `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts:2395` |

### 关于两个服务端点

- **Notion**：线上元数据已读到 —— `https://mcp.notion.com/mcp`（Streamable HTTP），
  `registration_endpoint: https://mcp.notion.com/register`（支持 RFC 7591 动态注册），
  `code_challenge_methods_supported: ["S256"]`，`token_endpoint_auth_methods_supported` 含 `none`（公开客户端 + PKCE），
  `grant_types_supported` 含 `refresh_token`。
- **Craft**：据第三方集成目录（integrations.sh/craft.do）端点 `https://mcp.craft.do/my/mcp`，声称同样支持动态注册；
  但本机对 `https://mcp.craft.do/.well-known/oauth-protected-resource` 的请求返回 Cloudflare 504，
  **元数据未取得** —— 端点与 DCR 均标为「待探针确认」，见 §7。

---

## 1. 文件清单

新增目录 `src/main/mcpClient/`（**不叫 `src/main/mcp/`**，避免与 `agentBridge.ts` 那套 MCP 服务端混淆）。

| 文件 | 职责 |
|---|---|
| `src/main/mcpClient/types.ts` | 本层所有对外类型：provider 配置、工具描述、状态、错误码、引用草案 |
| `src/main/mcpClient/providers.ts` | 只有两份 provider 配置：`NOTION_PROVIDER`、`CRAFT_PROVIDER`；不许出现逻辑分支 |
| `src/main/mcpClient/credentialStore.ts` | 凭据落盘（`safeStorage` 加密 + `atomicWriteText`），读写与清除，主进程独占 |
| `src/main/mcpClient/oauthFlow.ts` | `OAuthClientProvider` 实现 + `127.0.0.1` 回环回调服务器 + 打开系统浏览器 |
| `src/main/mcpClient/session.ts` | 单 provider 的连接生命周期：懒连接、`tools/list` 缓存、`tools/call`、一次重连、关闭 |
| `src/main/mcpClient/agentTools.ts` | MCP 工具 → pi `AgentTool` 适配（前缀、`prepareArguments`、结果压文本、引用抽取） |
| `src/main/mcpClient/index.ts` | 门面：`listProviders` / `connect` / `disconnect` / `status` / `listTools` / `refreshTools` / `buildAgentTools` / `disposeAll` |

修改（只加不改语义）：

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | 新增 `McpProviderId`、`McpConnectionStatus`、`McpToolSummary`、`ExternalSource`；`AiStageEvent` 与 `AiDoneEvent` 加可选 `externalSources` |
| `src/main/settings.ts` | 新增 `getMcpSelection` / `saveMcpSelection`（选中工具 id 列表），复用既有加密与落盘 |
| `src/main/index.ts` | 新增 `mcp.*` IPC 通道；`ai.agentChat` 里把 `buildAgentTools()` 传给 `runReaderAgent`；`before-quit` 调 `disposeAll()` |
| `src/main/aiAgent.ts` | `RunReaderAgentOptions` 加 `extraTools?`；`runReaderAgent` 合并；`AgentRunResult` 加 `externalSources`；系统提示追加笔记库段落；`beforeToolCall` 按前缀分配预算 |
| `src/preload/index.ts` | 新增 `mcp` 命名空间 |
| `src/renderer/pages/Settings.vue` | `SettingsSection` 加 `'connections'`，`sectionOptions` 加一项，新增 Notion/Craft 两张卡 |
| `src/renderer/pages/Reader.vue` | 依据区渲染 `externalSources`（外链按钮，不走 `jumpToMemorySource`） |
| `docs/ipc-contract.md` | `## AI` 与新增 `## MCP 客户端` 节 |

---

## 2. 导出签名

### 2.1 `types.ts`

```ts
export type McpProviderId = 'notion' | 'craft'

export interface McpProviderConfig {
  id: McpProviderId
  /** 界面显示名，如「Notion」。 */
  name: string
  /** Streamable HTTP 端点，必须 https。 */
  serverUrl: string
  /** 工具名前缀（`'notion__'` / `'craft__'`）。不写成字面量联合：加第三个 provider 时不必改类型。 */
  toolPrefix: string
  /** 授权时请求的 scope；服务端未声明时省略。 */
  scope?: string[]
  /**
   * 只读白名单。返回 false 的工具一律不暴露给模型——
   * 这是唯一的准入判断，任何创建/更新/删除类工具都必须落在这里返回 false。
   */
  isReadOnly: (tool: McpToolDescriptor) => boolean
  /** 工具结果 → 引用草案；认不出就返回空数组，正文照旧回给模型。 */
  toSources: (tool: McpToolDescriptor, result: McpCallResult) => ExternalSource[]
  /** 工具结果压成给模型看的纯文本。 */
  formatResult: (tool: McpToolDescriptor, result: McpCallResult) => string
}

/** listTools 归一化后的一项：只留本层要用的字段。 */
export interface McpToolDescriptor {
  providerId: McpProviderId
  /** 服务端原始工具名，如 notion-search。 */
  serverName: string
  /** 暴露给模型的工具名：provider.toolPrefix + serverName 归一化（非 [a-zA-Z0-9_] 换成 _）。 */
  toolName: string
  title: string
  description: string
  /** 服务端原始 inputSchema，原样保留，适配时再断言成 TSchema。 */
  inputSchema: unknown
  readOnly: boolean
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string }>
  structuredContent?: unknown
  isError?: boolean
}

export type McpConnectionState = 'disconnected' | 'authorizing' | 'connected' | 'error'

export interface McpConnectionStatus {
  providerId: McpProviderId
  state: McpConnectionState
  /** 授权进行中的回环地址（如 http://127.0.0.1:53682/callback），仅 authorizing 时有值。 */
  authorizationUrl?: string
  /** state 为 error 时给界面看的可读原因；不含 token、不含响应正文。 */
  message?: string
  /** 上次成功拉取 tools/list 的时间（ISO）；从未成功则为空串。 */
  toolsFetchedAt: string
  toolCount: number
}

/** 外部来源引用。刻意不复用 AiCitation —— 后者是纯书籍坐标类型，没有 url。 */
export interface ExternalSource {
  /** 稳定 id：`${providerId}:${页面或文档 id}`；同一轮内去重靠它。 */
  id: string
  providerId: McpProviderId
  providerName: string
  /** 页面/文档标题；标题缺失时用 id 兜底。 */
  title: string
  /** 可点击链接；服务端没给就只有标题。 */
  url?: string
  /** 命中的片段，截断到 300 字符。 */
  excerpt: string
}

export type McpErrorCode =
  | 'not_authorized'
  | 'auth_failed'
  | 'auth_redirect_rejected'
  | 'network'
  | 'tool_not_found'
  | 'tool_not_readonly'
  | 'tool_input_unsupported'
  | 'tool_call_failed'

export class McpClientError extends Error {
  constructor(readonly code: McpErrorCode, message: string, readonly providerId?: McpProviderId)
}
```

### 2.2 `providers.ts`

```ts
import type { McpProviderConfig, McpProviderId } from './types'

export const MCP_PROVIDERS: readonly McpProviderConfig[]
export function getProvider(id: McpProviderId): McpProviderConfig
export function isMcpProviderId(value: unknown): value is McpProviderId
```

两份配置的全部差异只在数据里：`id`、`name`、`serverUrl`、`toolPrefix`、`scope`、以及两个纯函数
`isReadOnly` / `toSources`。连接、OAuth、缓存、预算、IPC 一行都不分叉。

`isReadOnly` 的判定顺序（两者共用同一实现，由 `providers.ts` 内的私有 helper 提供）：
1. `annotations.readOnlyHint === true` → 只读；
2. `annotations.destructiveHint === true` → 否；
3. 名字启发式：命中 `/search|fetch|retrieve|list|get|read|query|find/i` → 是；
   命中 `/create|update|patch|delete|archive|move|append|insert|write|comment|share|invite/i` → 否；
4. 都不命中 → **否**（默认拒绝，宁可少一个工具，也不放一个写操作给模型）。

### 2.3 `credentialStore.ts`

```ts
export interface StoredCredentials {
  clientInformation?: unknown    // DCR 结果，必须持久化复用，否则重复注册会孤立既有授权
  tokens?: unknown
  codeVerifier?: string
  redirectUri?: string
}

export async function readCredentials(providerId: McpProviderId): Promise<StoredCredentials | null>
export async function writeCredentials(providerId: McpProviderId, value: StoredCredentials): Promise<void>
export async function clearCredentials(providerId: McpProviderId): Promise<void>
/** 有密文但本机解不开（换机/钥匙串重置）：用来把「没授权过」和「授权过但坏了」分开告诉用户。 */
export async function credentialsUnreadable(providerId: McpProviderId): Promise<boolean>
```

落点：`settings.json` 里每 provider 一个 `*Enc` 字段，与既有 API Key 完全同一套做法
（`requireEncryptionAvailable` 在 `src/main/settings.ts:445`，解密在 `:461`，写入走 `atomicWriteText`
在 `src/main/atomicFile.ts:50`）。明文 token 只在 `session.ts` 与 `oauthFlow.ts` 之间传，不出主进程、不进日志。

### 2.4 `oauthFlow.ts`

```ts
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

export interface PendingAuthorization {
  providerId: McpProviderId
  authorizationUrl: string
  redirectUri: string
  /** 关闭回环服务器并清理挂起状态。 */
  cancel: () => void
}

/**
 * 启动一次授权：起 127.0.0.1 回环服务器 → 动态注册（若服务端有 registration_endpoint）→
 * 生成 PKCE → 返回授权 URL 并交给 shell.openExternal。
 * 回调命中时用 state 校验，再 finishAuth(code)，然后 resolve；
 * 用户取消或 10 分钟无回调则 reject（McpClientError('auth_failed')）。
 */
export async function beginAuthorization(
  config: McpProviderConfig,
): Promise<PendingAuthorization>

/** 供 session.ts 构造传输层用；每次连接取同一个实例即可。 */
export function createAuthProvider(config: McpProviderConfig): OAuthClientProvider

/** 退出时关掉所有仍在监听的回环端口。 */
export function disposeAuthorizationServers(): void
```

要点（全部有 SDK 依据）：`redirectUrl` 返回 `http://127.0.0.1:<port>/callback`；
`saveClientInformation` 写 `credentialStore`；`redirectToAuthorization(url)` 只把 URL 记进挂起状态，
由调用方 `shell.openExternal` 打开（`src/main/index.ts:1` 现在没有引入 `shell`，需要新增，
这是本层唯一新的 Electron 能力依赖）。

### 2.5 `session.ts`

```ts
import type { McpProviderConfig, McpCallResult, McpConnectionStatus, McpToolDescriptor } from './types'

export interface McpSessionDeps {
  /** 打开系统浏览器；由 index.ts 注入 shell.openExternal，便于测试替换。 */
  openExternal: (url: string) => Promise<void>
  onStatusChange?: (status: McpConnectionStatus) => void
}

export function createSession(config: McpProviderConfig, deps: McpSessionDeps): McpSession

export interface McpSession {
  status(): McpConnectionStatus
  /** 已缓存则直接返回；未连接则抛 McpClientError('not_authorized')。 */
  listTools(): Promise<McpToolDescriptor[]>
  /** 主动重连并重拉 tools/list（设置页「刷新」用）。 */
  refreshTools(): Promise<McpToolDescriptor[]>
  /** 调一个**已通过白名单**的工具；未命中白名单直接抛 tool_not_readonly。 */
  callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>
  /** 进入授权流程并等待回调；成功后自动连接一次。 */
  authorize(): Promise<McpConnectionStatus>
  disconnect(): Promise<void>
}
```

生命周期：首次 `listTools()`/`callTool()` 时懒连接；连接抛 `UnauthorizedError` 则把状态置
`authorizing` 并走 `oauthFlow.beginAuthorization`；`UnauthorizedError` 出现在普通调用上时重连一次，
第二次仍失败即返回 `McpClientError('not_authorized')`，不再循环。

### 2.6 `agentTools.ts`

```ts
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ExternalSource, McpConnectionStatus, McpProviderConfig } from './types'

export interface BuildAgentToolsOptions {
  /** 用户在设置里勾选的工具名（暴露名，含前缀）；未勾选的一律不暴露。 */
  enabledToolNames: ReadonlySet<string>
  /** 单轮 MCP 调用预算；由调用方从设置读，默认 6。 */
  maxCallsPerTurn: number
  /** 工具开始/结束回报，接现有 ai.stage 的 detail 行。 */
  onToolEvent?: (event: { phase: 'start' | 'end'; toolName: string; label: string; isError?: boolean }) => void
  /** 抽到的外部引用，按轮次累积。 */
  onSources?: (sources: ExternalSource[]) => void
}

export interface AgentToolBundle {
  tools: AgentTool<any>[]
  /** 已消耗的 MCP 调用次数（供 beforeToolCall 判预算）。 */
  callsUsed: () => number
  /** 本轮累计的外部引用。 */
  sources: () => ExternalSource[]
}

export async function buildAgentTools(
  config: McpProviderConfig,
  session: McpSession,
  options: BuildAgentToolsOptions,
): Promise<AgentToolBundle>
```

每个工具的形状：

```ts
{
  name: 'notion__notion_search',        // 前缀 + 归一化后的服务端名
  label: tool.title || tool.serverName, // 直接进 aiAgent.ts:318 的 detail 行
  description: tool.description,
  parameters: Type.Unsafe(tool.inputSchema as TSchema),
  prepareArguments: (args) => stripUndeclared(args, tool.inputSchema), // 见 §5 的 schema 事实
  execute: async (_id, params, signal) => { /* callTool → formatResult + toSources */ },
}
```

`label` 用服务端 `title`（没有就用原名），于是侧栏那行「正在查看…」不需要任何新字段——
`aiAgent.ts:318` 已经是 `TOOL_LABELS[event.toolName] ?? event.toolName`，未登记的名字原样透出。

### 2.7 `index.ts`（门面）

```ts
import type { AgentTool } from '@mariozechner/pi-agent-core'

export interface FacadeDeps {
  openExternal: (url: string) => Promise<void>
}

export function initMcpClient(deps: FacadeDeps): void
export function listProviderStatuses(): McpConnectionStatus[]
export async function authorizeProvider(id: McpProviderId): Promise<McpConnectionStatus>
export async function disconnectProvider(id: McpProviderId): Promise<McpConnectionStatus>
export async function listProviderTools(id: McpProviderId): Promise<{
  status: McpConnectionStatus
  tools: McpToolSummary[]           // { toolName, title, description, readOnly, enabled }
}>
export async function refreshProviderTools(id: McpProviderId): Promise<McpToolSummary[]>

/** ai.agentChat 每轮调用一次：只返回已授权且被勾选的只读工具。 */
export async function buildAgentToolsForTurn(options: {
  maxCallsPerTurn: number
  onToolEvent?: (event: { phase: 'start' | 'end'; toolName: string; label: string; isError?: boolean }) => void
}): Promise<{ tools: AgentTool<any>[]; sources: () => ExternalSource[] }>

/** app.before-quit 调用：关连接、关回环端口。 */
export function disposeAll(): void
```

---

## 3. IPC、preload 与渲染侧

### 3.1 通道（全部 invoke）

| 频道 | 请求 | 响应 |
|---|---|---|
| `mcp.listProviders` | 无 | `{ ok: true; providers: McpConnectionStatus[] }` |
| `mcp.authorize` | `{ providerId: McpProviderId }` | `{ ok: true; status: McpConnectionStatus } \| { ok: false; code: McpErrorCode; message: string }` |
| `mcp.disconnect` | `{ providerId: McpProviderId }` | `{ ok: true; status: McpConnectionStatus }` |
| `mcp.listTools` | `{ providerId: McpProviderId }` | `{ ok: true; status; tools: McpToolSummary[] } \| { ok: false; message }` |
| `mcp.refreshTools` | `{ providerId: McpProviderId }` | `{ ok: true; tools: McpToolSummary[] } \| { ok: false; message }` |
| `mcp.setEnabledTools` | `{ providerId: McpProviderId; toolNames: string[] }` | `{ ok: true }` |
| `mcp.setCallBudget` | `{ maxCallsPerTurn: number }` | `{ ok: true }` |
| `mcp.status` | 主→渲染（推送） | `McpConnectionStatus` |

规矩照 `docs/ipc-contract.md:11` 的约定：只追加、不改已有字段；失败优先返回 `ok:false` 而不是抛错。
`mcp.status` 推送用于授权回调完成后刷新设置页，不需要渲染层轮询。

**响应与日志里绝不出现 token、client_secret、授权码或响应正文**；错误只带 `code` 与一句可读中文。

### 3.2 preload

在 `src/preload/index.ts` 现有 `settings`（`:254`）、`ai`（`:464`）旁边加：

```ts
mcp: {
  listProviders: () => ipcRenderer.invoke('mcp.listProviders') as Promise<...>,
  authorize: (providerId: McpProviderId) => ipcRenderer.invoke('mcp.authorize', { providerId }) as Promise<...>,
  disconnect: (providerId: McpProviderId) => ipcRenderer.invoke('mcp.disconnect', { providerId }) as Promise<...>,
  listTools: (providerId: McpProviderId) => ipcRenderer.invoke('mcp.listTools', { providerId }) as Promise<...>,
  refreshTools: (providerId: McpProviderId) => ipcRenderer.invoke('mcp.refreshTools', { providerId }) as Promise<...>,
  setEnabledTools: (providerId: McpProviderId, toolNames: string[]) => ipcRenderer.invoke('mcp.setEnabledTools', { providerId, toolNames }) as Promise<...>,
  setCallBudget: (maxCallsPerTurn: number) => ipcRenderer.invoke('mcp.setCallBudget', { maxCallsPerTurn }) as Promise<...>,
  onStatus: (handler: (status: McpConnectionStatus) => void) => on('mcp.status', handler),
},
```

### 3.3 设置页

- `SettingsSection`（`Settings.vue:50`）加 `'connections'`；`sectionOptions`（`:265-277`）在「AI」之后插
  `{ id: 'connections', label: '连接服务' }`。
- 一张卡内两个 provider 区块，结构相同：状态徽标（未连接 / 等待浏览器授权 / 已连接 · N 个工具 / 出错原因）、
  「连接」/「断开」/「刷新工具」按钮、工具勾选列表（读类默认全勾，非读类灰显并注明「不提供给模型」）、
  底部一行「本轮最多调用 M 次」的数字输入。
- 未授权时整块只有一句说明，不显示空列表；授权中显示「已在浏览器打开授权页…」，并可「取消」。

### 3.4 侧栏

- 工具活动行：不动。`aiAgent.ts:318`/`:326` 已把未登记的工具名原样透出，MCP 工具带 `label` 就够了。
- 依据区：在 `Reader.vue` 现有 `citations` 分支旁边加一组 `externalSources`，
  每项渲染成「Notion · 页面标题 ↗」，点击走 `shell.openExternal`（经新通道或复用既有点击处理），
  **不调用 `jumpToMemorySource`** —— 那个函数在 `readerAssistant.ts:727-765` 依赖 `chapterId` 打开本地章节，
  MCP 来源没有章节坐标。
- 旧记录：`externalSources` 缺省即不渲染，不需要迁移。

---

## 4. `aiAgent.ts` 的接入方式

```ts
// aiAgent.ts:104（RunReaderAgentOptions 声明处），增量字段
export interface RunReaderAgentOptions {
  // ...既有字段不动
  /** 外部 MCP 工具；未配置或未授权时为空数组。 */
  extraTools?: AgentTool<any>[]
  /** 由 extraTools 抽到的外部引用（与 citations 并列，互不污染）。 */
  onExternalSources?: (sources: ExternalSource[]) => void
  /** 单轮 MCP 预算，默认 6。 */
  mcpCallBudget?: number
}

// :125 AgentRunResult 增量
export interface AgentRunResult {
  text: string
  citations: AiCitation[]
  /** 必填：`AgentRunResult` 只在本层内部流转，三处 return 都要补这个字段（`:335`、`:353`、`:360`）。
   *  对外事件 `AiStageEvent` / `AiDoneEvent` 上则是可选，因为旧监听方要能忽略它。 */
  externalSources: ExternalSource[]
  toolCalls: number
  stopReason: 'stop' | 'stopped' | 'error'
}
```

三处具体接线：

1. **并入工具** —— `:288` 改为 `tools: [...buildTools(options.toolkit, state), ...(options.extraTools ?? [])]`。
   `buildTools` 的签名与返回不变，内置 5 个工具一字不改；未授权时 `extraTools` 为空数组，行为与现在完全相同。
2. **引用** —— `collect()`（`:141-146`）只处理书籍引用，继续写 `state.citations`。
   外部引用走 `state.externalSources`，由 `agentTools.ts` 在自己的 `execute` 里累积并按需 `onExternalSources` 回调。
   两者在 `runReaderAgent` 收尾处分别放进返回值。
3. **预算** —— `beforeToolCall`（现位于 `:297-302`）在原有 12 次判断之前加一段：
   若 `context.toolCall.name` 命中任一 `extraTools` 的名字，则查独立的 `mcpCalls` 计数，
   超 `mcpCallBudget` 返回 `{ block: true, reason: '本轮笔记检索已达 N 次上限，请直接基于已有材料作答。' }`。
   内置工具的 12 次上限与计数逻辑不变。

系统提示（`:23-63`）追加一段，只在 `extraTools` 非空时拼入：

```
- 读者还授权了笔记库（Notion / Craft）。仅当读者自己提到「我的笔记」「之前记过的」「查一下我写的」，
  或问题明显指向他自己的记录时才调用；不要把书中内容往笔记库里反查。
- 引用笔记时写明页面标题；笔记里的说法与本书冲突时，以本书正文为准并指出冲突。
```

`index.ts:2233` 的调用处加两行：`extraTools` 取 `buildAgentToolsForTurn(...)` 的结果，
`onExternalSources` 走新推送（见 §5.2）。

---

## 5. 两处必须绕开的既有约束

### 5.1 外部引用不能写进 `state.citations`（**对任务原案的修正**）

> 任务原案要求「MCP 来源的引用并列写入 `state.citations`」。读代码后确认那样会破坏两处既有行为，
> 因此本文改为新增并列字段 `externalSources`。这是有意偏离，不是遗漏；下面是失败链条。
> 若坚持走 `state.citations`，最小改动路线是给 `AiCitation` 加可选 `url` / `kind`，
> 并同步放宽 `isChatCitation`、给 `Reader.vue` 依据区加外链分支 —— 改动面同样不小，且会让
> 「书籍坐标引用」这个类型不再纯粹，任何按 `chapterId` 遍历 `citations` 的既有代码都要重新审一遍。

`AiCitation` 只有书籍坐标（`types.ts:1083-1089`），硬塞会有两处坏掉：

- 渲染：`Reader.vue` 依据区对每条 `citation` 都渲染「第 N 段 … 查看原文」并绑 `jumpToMemorySource`；
  MCP 来源没有段落，点击只会走到 `readerAssistant.ts:731-734` 的「来源章节不存在」。
- 持久化：`isChatCitation`（`library.ts:1038-1042`）要求 `chapterId` 非空、`paragraphIndex` 为整数、
  `excerpt` 非空；不满足时 `parseChatMessage` **整条消息返回 null**（`:1069-1071`），
  重开侧栏整轮问答消失。

所以：`state.citations` 保持纯书籍引用，外部引用走并列字段 `externalSources`，
不经过 `isChatCitation`，也不进 `citations`。代价是侧栏要多一条渲染分支，换来的是旧记录零迁移、旧路径零风险。

### 5.2 外部引用的推送与落盘

- `AiStageEvent`（`types.ts:1365-1372`）与 `AiDoneEvent` 各加可选 `externalSources?: ExternalSource[]`，
  与现有 `citations` 并列。`sendAiEvidence`（`index.ts:292-296`）保持不变，另加一个
  `sendMcpSources(jobId, sources)` 推同一个 `ai.stage` 通道（带 `externalSources`）。
- 落盘：`AiEvidenceChatMessage` 加可选 `externalSources?: ExternalSource[]`；
  `parseChatMessage`（`library.ts:1065`）加一段与 `parseChatClaims` 同风格的宽容解析 —— 字段不合法就丢掉这一条，
  不影响正文与 `citations`，不做数据迁移。

### 5.3 schema 透传的实测结论

探针（`.tmp/` 下已跑完并删除）用 pi 自己的校验函数验证过：根级 `anyOf`、`$defs/$ref` 正常；
属性级 `anyOf` 校验不严格（非法值也放行）；`additionalProperties: false` 会拒掉多余键。

因此适配器必须做两件事：
- 参数用 `Type.Unsafe(inputSchema as TSchema)` 原样透传，**不要**改写成 `Type.Object`（会把 `anyOf` 丢掉）；
- `prepareArguments` 按 `inputSchema.properties` 剔除未声明键，避免模型多带字段被服务端判死。

---

## 6. 只读保证（三层，缺一不可）

1. **准入**：`providers.isReadOnly` 决定工具是否出现在 `listTools` 结果里；默认拒绝。
2. **勾选**：`enabledToolNames` 决定是否进入本轮 `extraTools`；设置页里非只读工具不可勾选。
3. **执行**：`session.callTool` 再查一次白名单，不在白名单直接抛 `tool_not_readonly`，不发请求。

没有保存 / 导出 / 写路径，没有 `mcpSources` 写回，没有向 Notion/Craft 创建任何内容的代码。

---

## 7. 开放风险与探针步骤

| 风险 | 现状 | 探针 |
|---|---|---|
| Craft 端点与 DCR 未证实 | `https://mcp.craft.do/my/mcp` 只有第三方目录背书；本机取元数据返回 Cloudflare 504 | 授权前先 `GET {serverUrl}` 看是否 `401 + WWW-Authenticate`，再取 protected-resource 与 authorization-server 元数据，确认 `registration_endpoint` 存在 |
| 回环重定向是否被接受 | Notion 元数据支持 DCR 与 PKCE，但未证实它接受 `http://127.0.0.1:<port>/callback` | 用固定端口 53682 发一次 `/register`，检查响应是否原样回显该 redirect_uri；被拒则改用服务端返回的允许值，**仍拒就停下报告，不改走 integration token** |
| 真实 `tools/list` 与 `inputSchema` 未知 | 两家都需要授权后才能看 | 授权成功后落一份 `tools/list` 快照到 `.tmp/`（提交前删除），核对：工具名、`readOnlyHint` 是否存在、`inputSchema` 是否用 `anyOf` / `$ref` / `additionalProperties:false` |
| 工具结果里是否带页面 URL | 未知 | 同上快照里跑一次检索类工具，看返回的 `content` 是否含 `notion.so` / `craft.do` 链接；没有 URL 时 `toSources` 只给标题，界面不显示外链按钮 |
| `Type.Unsafe` + 属性级 `anyOf` 校验偏松 | 已实测 | 无需再探；靠 `prepareArguments` 剔键 + 服务端兜底 |
| Craft 的页面 id 与标题字段形状 | 未知 | 同 `tools/list` 快照；`toSources` 认不出就返回空数组（正文照旧回给模型），不猜 |

探针脚本一律放 `.tmp/`，用完即删；不写进仓库。

---

## 9. 已落地的 Craft 接入（2026-11-27）

### 9.1 探针结论（实测）

对 Craft 分享出的 `/links/<id>/mcp` 端点（linkid 不记录）用 SDK 的 `StreamableHTTPClientTransport`
跑 `initialize` + `tools/list` + `tools/call`：

| 项 | 结果 |
|---|---|
| `initialize` 裸连 | **成功，不需要 OAuth**（无 401，无 `WWW-Authenticate`）——所以没有实现 `oauthFlow.ts` / `credentialStore.ts` |
| `tools/list` | 4 个工具：`craft_read`(readOnlyHint=true)、`craft_write`、`craft_write_and_show`、`blocks_revert`（后三个 destructiveHint=true） |
| `craft_read` 入参 | 唯一必填参数 `command: string`（如 `search <q>`、`documents list`、`blocks get <id>`） |
| `callTool` 返回 | 主要是 `{type:'text'}` 纯文本，无 `structuredContent`，也没有稳定的页面 URL 字段 |

由此确定三条实现取舍：
1. 只接 `craft_read` 一个工具，其余三个不进模型（`types.ts:READONLY_SERVER_NAMES`）。
2. 引用只能从文本里启发式抽取（标题/片段），没有稳定外链就只显示标题——`externalSources.url` 可选。
3. 端点 URL 含 linkid，视同凭据：只走 `craftMcpUrlEnc`（`safeStorage` 加密），渲染层只拿布尔值。

### 9.2 实际落地的文件

新增 `src/main/mcpClient/`：

| 文件 | 职责 |
|---|---|
| `types.ts` | `McpToolDescriptor`、`McpCallResult`、`McpClientError`；`isCraftMcpUrl` 只校验 https + host 白名单 + 拒绝 userinfo |
| `craftSession.ts` | 懒连接、`tools/list` 缓存并过滤只读、`tools/call`（再查一次白名单）、断开 |
| `agentTools.ts` | MCP 工具 → pi `AgentTool`；`Type.Unsafe` 透传 schema；`prepareArguments` 剔未声明键；`extractSourcesFromText` 抽外部引用 |
| `index.ts` | 门面：`ensureCraftSession`（按 URL 分键的 in-flight）、`testCraftConnection`、`listCraftTools`、`disconnectCraft`、`buildAgentToolsForTurn` |

修改：`shared/types.ts`（`ExternalSource`、`AiEvidenceChatMessage.externalSources`）、`settings.ts`
（`craftMcpUrlEnc` 加密读写 + `normalizeCraftMcpUrl`）、`main/index.ts`（`mcp.*` 三个通道、agentChat 接线、
`ai.externalSources` 事件、URL 变更时断开旧会话）、`aiAgent.ts`（`extraTools` 包装计次 + `externalSources` 回传）、
`preload/index.ts`（`mcp` 命名空间、`ai.onExternalSources`）、`Settings.vue`（Craft 卡片）、
`Reader.vue`（依据区外链分支 + 事件订阅）、`readerAssistant.ts`（快照保留 externalSources）、`library.ts`（宽容解析）。

### 9.3 与早期设想的差异

- **没有 OAuth 层**：探针证明裸连即可，`oauthFlow.ts` / `credentialStore.ts` 不需要。
- **没有通用多 provider 注册表**：本轮只做 Craft 一个 provider（`isCraftMcpUrl` 就是白名单）。
- **externalSources 走独立 IPC 事件** `ai.externalSources`，而不复用 `ai.stage`：避免把阶段指示倒回 `requesting`。
- **工具计次在 `aiAgent.ts` 的包装层**：`extraTools` 每个工具执行前 `state.toolCalls += 1`，
  因此 `MAX_AGENT_TOOL_CALLS`（12）对 `craft__` 工具同样生效。

### 9.4 验证结果

- `npm.cmd run typecheck` 通过。
- `npm.cmd run build` 通过。
- 真实连接（用源码里的 `craftSession` 跑 vitest，端点经环境变量传入）：
  只返回 `craft_read`、调用 `craft_write` 被拒（`tool_not_readonly`）、`connection info` 调用成功。
- 探针脚本与临时测试均已从 `.tmp/` 删除。

---

## 10. 原 Notion 设想的验证清单（未执行，Craft 未覆盖）

- `npm.cmd run typecheck` 通过，无新增类型错误。
- 设置页「连接服务」：Notion 连接 → 浏览器完成授权 → 状态「已连接 · N 个工具」并列出真实工具名。
- Craft 同流程；若在探针阶段就被拒，本条降级为「不可用并给出原因」，不算缺陷。
- 侧栏问「我笔记里记过 X 吗」：出现一行工具活动（服务端 title 或工具名），回答带 `externalSources`，
  点击链接在系统浏览器打开；`citations` 里没有任何 MCP 条目。
- 不勾任何工具时模型无法调用 MCP；内置 5 工具与 12 次上限行为不变。
- 打开旧对话记录正常渲染；新记录重开后 `externalSources` 仍在。
- 渲染进程 IPC payload、`settings.json`、审计日志、终端输出里都搜不到 token 或授权码。