/**
 * MCP 客户端层：把外部 MCP 服务器（当前 Craft）的只读工具接入阅读 Agent。
 *
 * 与 src/main/agentBridge.ts 方向相反：那套是「MCP 服务端」（供 Claude Desktop 调 spbf），
 * 这里是「MCP 客户端」（把 Craft 的只读检索工具交给 pi agent）。两者命名上严格隔离。
 */

/** 服务端原始工具（tools/list 返回项）归一化后本层要用的形状。 */
export interface McpToolDescriptor {
  /** 服务端原始工具名，如 craft_read。 */
  serverName: string
  /** 暴露给模型的工具名：provider.toolPrefix + serverName 归一化（非 [a-zA-Z0-9_] 换 _）。 */
  toolName: string
  title: string
  description: string
  /** 服务端原始 inputSchema，原样保留；适配时再断言成 TSchema。 */
  inputSchema: unknown
  readOnly: boolean
}

/** tools/call 的结果（只留本层要用的字段）。 */
export interface McpCallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

/** 外部来源引用。刻意不复用 AiCitation（后者是纯书籍坐标类型，没有 url）。 */
export interface ExternalSource {
  /** 稳定 id：`craft:<文档或块 id>`；同一轮内去重靠它。 */
  id: string
  providerName: string
  /** 页面/文档标题；标题缺失时用 id 兜底。 */
  title: string
  /** 可点击链接；服务端没给就只有标题。 */
  url?: string
  /** 命中的片段，截断到 300 字符。 */
  excerpt: string
}

export type McpErrorCode =
  | 'not_configured'
  | 'not_connected'
  | 'network'
  | 'unauthorized'
  | 'tool_not_readonly'
  | 'tool_call_failed'

export class McpClientError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'McpClientError'
  }
}

/** 探针实测：唯一只读工具名（readOnlyHint=true），其余 3 个均为 destructive。 */
export const CRAFT_READ_TOOL_NAME = 'craft_read'

/**
 * 链接型授权（探针实测裸连成功，免 OAuth）：serverUrl 即整条 URL，含私有 linkid。
 * 校验只做 protocol + host 白名单（任务约束），不校验路径形状 —— linkid 是凭据，不写进任何错误信息。
 * 额外拒绝：带 userinfo 的 URL（凭据可能藏在 userinfo，且会进日志泄露面）、根路径（没有实际 MCP 端点）。
 */
export function isCraftMcpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value.trim())
    return (
      url.protocol === 'https:' &&
      url.host === 'mcp.craft.do' &&
      !url.username &&
      !url.password &&
      url.pathname.length > 1
    )
  } catch {
    return false
  }
}
