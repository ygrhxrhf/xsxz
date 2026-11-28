/**
 * 单 provider 的 MCP 会话：懒连接、tools/list 缓存、tools/call、断开。
 * 探针实测：/links/<id>/mcp 裸连成功（免 OAuth），所以不实现 token 存储与授权流程。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  McpClientError,
  type McpCallResult,
  type McpToolDescriptor,
} from './types'
import { CRAFT_READ_TOOL_NAME } from './types'

export interface CraftSessionOptions {
  serverUrl: string
}

export interface CraftSession {
  /** 已缓存则直接返回；未连接时先懒连接。只返回白名单内的只读工具。 */
  listTools(): Promise<McpToolDescriptor[]>
  /** 调一个已通过白名单的工具；未命中白名单直接抛 tool_not_readonly。 */
  callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>
  disconnect(): Promise<void>
}

/** 归一化：非 [a-zA-Z0-9_] 一律换成 _，避免暴露名里有非法字符。 */
function normalizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_')
}

/** 探针实测的只读白名单：craft_read 是唯一 readOnlyHint=true 的工具。 */
const READONLY_SERVER_NAMES = new Set([CRAFT_READ_TOOL_NAME])

function toDescriptor(serverName: string, tool: { title?: string; description?: string; inputSchema?: unknown }): McpToolDescriptor {
  const readOnly = READONLY_SERVER_NAMES.has(serverName)
  return {
    serverName,
    toolName: `craft__${normalizeToolName(serverName)}`,
    title: tool.title ?? '',
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {},
    readOnly,
  }
}

export function createCraftSession(options: CraftSessionOptions): CraftSession {
  let client: Client | null = null
  let transport: StreamableHTTPClientTransport | null = null
  let toolCache: McpToolDescriptor[] | null = null
  let connecting: Promise<Client> | null = null

  async function ensureConnected(): Promise<Client> {
    if (client) return client
    if (!connecting) {
      connecting = (async (): Promise<Client> => {
        const t = new StreamableHTTPClientTransport(new URL(options.serverUrl))
        const c = new Client({ name: 'spbf-craft', version: '0.1.0' })
        try {
          await c.connect(t)
          transport = t
          client = c
          return c
        } catch (error) {
          await c.close().catch(() => {})
          throw new McpClientError(
            'network',
            `无法连接 Craft 笔记库：${error instanceof Error ? error.message.split('\n')[0]?.slice(0, 120) : String(error).slice(0, 120)}`,
          )
        }
      })()
    }
    try {
      return await connecting
    } finally {
      connecting = null
    }
  }

  return {
    async listTools(): Promise<McpToolDescriptor[]> {
      if (toolCache) return toolCache
      const c = await ensureConnected()
      try {
        const listed = await c.listTools()
        const tools = (listed.tools ?? [])
          .map((tool) => toDescriptor(tool.name, tool))
          .filter((tool) => tool.readOnly)
        toolCache = tools
        return tools
      } catch (error) {
        if (error instanceof McpClientError) throw error
        throw new McpClientError(
          'network',
          `拉取 Craft 工具列表失败：${error instanceof Error ? error.message.split('\n')[0]?.slice(0, 120) : String(error).slice(0, 120)}`,
        )
      }
    },

    async callTool(toolName, args, signal) {
      const tools = await this.listTools()
      const descriptor = tools.find((tool) => tool.toolName === toolName)
      if (!descriptor) throw new McpClientError('tool_not_readonly', '该工具不在只读白名单内，模型不可调用。')
      const c = await ensureConnected()
      try {
        const result = await c.callTool(
          { name: descriptor.serverName, arguments: args },
          undefined,
          signal ? { signal } : undefined,
        )
        const blocks = Array.isArray(result.content) ? result.content : []
        return {
          content: blocks
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
            .map((block) => ({ type: block.type, text: block.text })),
          isError: result.isError === true,
        }
      } catch (error) {
        if (error instanceof McpClientError) throw error
        throw new McpClientError(
          'network',
          `调用 Craft 工具失败：${error instanceof Error ? error.message.split('\n')[0]?.slice(0, 120) : String(error).slice(0, 120)}`,
        )
      }
    },

    async disconnect() {
      const c = client
      client = null
      transport = null
      toolCache = null
      if (c) await c.close().catch(() => {})
    },
  }
}
