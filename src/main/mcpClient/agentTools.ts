/**
 * MCP 工具 → pi AgentTool 适配：把 craft__ 前缀工具变成模型可调的工具。
 * 参数 schema 用 Type.Unsafe 原样透传（探针实测：属性级 anyOf 校验偏松，
 * 但 craft_read 只有 command 字符串参数，无嵌套 anyOf，透传安全）。
 */
import { Type } from '@mariozechner/pi-ai'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ExternalSource } from '../../shared/types'
import type { McpToolDescriptor } from './types'
import type { CraftSession } from './craftSession'

export interface AgentToolContext {
  /** 工具调用开始/结束回报，接 ai.stage 的 detail 行。 */
  onToolEvent?: (event: { phase: 'start' | 'end'; toolName: string; label: string; isError?: boolean }) => void
  /** 抽到的外部引用，按轮次累积。 */
  onSources?: (sources: ExternalSource[]) => void
}

/**
 * 从一次 craft_read 调用的文本结果里抽出可回链的文档条目。
 * 探针实测：返回以 text 块为主，不含稳定 URL 字段；这里尽力识别「标题 + 片段」。
 * 识别规则（不猜 id）：把每一行当候选，含文档名特征（书名号、Markdown 链接、Craft 块 id）才收。
 */
export function extractSourcesFromText(text: string): ExternalSource[] {
  const sources: ExternalSource[] = []
  const lines = text.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.length < 4) continue
    // 书名号包裹的标题，或 Markdown 链接文本，或形如 /blocks/<id> 的 Craft 内部引用。
    const bookTitle = /《([^》]{1,80})》/.exec(trimmed)
    const mdLink = /\[([^\]]{1,80})\]\(([^)]+)\)/.exec(trimmed)
    const blockRef = /(?:blocks|documents)\/([A-Za-z0-9-]{6,})/.exec(trimmed)
    if (bookTitle || mdLink || blockRef) {
      const title = (bookTitle?.[1] ?? mdLink?.[1] ?? '').trim().slice(0, 80) || 'Craft 文档'
      const id = blockRef?.[1] ?? `craft:${title}`
      const excerpt = trimmed.replace(/^[#>*\-\s]+/, '').slice(0, 300)
      sources.push({
        id,
        providerName: 'Craft',
        title,
        // 只把绝对 http(s) 链接放进 url：持久化解析会过滤非 http(s)，相对路径存进去会丢掉。
        ...(mdLink?.[2] && /^https?:\/\//i.test(mdLink[2]) ? { url: mdLink[2] } : {}),
        excerpt,
      })
    }
  }
  // 去重（同一 id 只留第一条）
  const seen = new Set<string>()
  return sources.filter((source) => {
    if (seen.has(source.id)) return false
    seen.add(source.id)
    return true
  })
}

/**
 * 把一条 MCP 只读工具描述转成 pi AgentTool。
 * execute 的返回值压成纯文本给模型；抽到的外部引用经 onSources 回调。
 */
export function mcpToolToAgentTool(
  descriptor: McpToolDescriptor,
  session: CraftSession,
  context: AgentToolContext,
): AgentTool<any> {
  return {
    name: descriptor.toolName,
    label: descriptor.title || descriptor.serverName,
    description: descriptor.description || '调用外部笔记库的只读检索工具。',
    parameters: Type.Unsafe(descriptor.inputSchema as never),
    prepareArguments: (args: unknown) => {
      // 探针实测：只剔除未声明键，不猜测服务端字段；模型多带字段会被服务端拒，这里先兜住。
      const record = (args ?? {}) as Record<string, unknown>
      const props = (descriptor.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties
      if (!props) return record
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(record)) {
        if (key in props) out[key] = record[key]
      }
      return out
    },
    execute: async (_toolCallId, params, signal, _onUpdate) => {
      // 调用次数与预算由 aiAgent.ts 的 beforeToolCall 统一统计（MAX_AGENT_TOOL_CALLS 对 MCP 工具同样生效），
      // 这里不重复计数；只负责连接与执行。
      context.onToolEvent?.({ phase: 'start', toolName: descriptor.toolName, label: descriptor.title || descriptor.serverName })
      try {
        const result = await session.callTool(descriptor.toolName, params as Record<string, unknown>, signal)
        const text = result.content.map((block) => block.text).join('\n')
        if (result.isError) {
          return {
            content: [{ type: 'text', text: `Craft 检索失败：${text.slice(0, 300) || '未知错误'}` }],
            details: { isError: true },
          }
        }
        const sources = extractSourcesFromText(text)
        if (sources.length) context.onSources?.(sources)
        return {
          content: [{ type: 'text', text: text.slice(0, 12000) }],
          details: { sources },
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Craft 检索失败：${error instanceof Error ? error.message : String(error)}` }],
          details: { isError: true },
        }
      } finally {
        context.onToolEvent?.({ phase: 'end', toolName: descriptor.toolName, label: descriptor.title || descriptor.serverName })
      }
    },
  }
}
