/**
 * mcpClient 门面：把 Craft 只读检索工具接入阅读 Agent。
 * - 配置从 settings.ts 的 craftMcpUrlEnc 读取（含 linkid，是凭据），只在主进程解密。
 * - 未配置 / 未连接时 buildAgentToolsForTurn 返回空数组，不影响内置工具。
 */
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ExternalSource } from '../../shared/types'
import { getCraftMcpUrl } from '../settings'
import { createCraftSession, type CraftSession } from './craftSession'
import { mcpToolToAgentTool } from './agentTools'
import { isCraftMcpUrl, McpClientError } from './types'

let session: CraftSession | null = null
let configuredUrl = ''
/** 断开/换地址时自增：在途尝试只有代次未变才能接管会话，避免断开后又把旧连接挂回来。 */
let sessionGeneration = 0
/** 按 URL 分键的 in-flight：换 URL 时不会拿到旧端点的连接。 */
const connectingByUrl = new Map<string, Promise<CraftSession>>()

/** 用当前配置构造（或复用）会话；URL 变了就断开旧会话重建。并发调用共享同一次连接。 */
export async function ensureCraftSession(): Promise<CraftSession> {
  const url = await getCraftMcpUrl()
  if (!url) throw new McpClientError('not_configured', '尚未配置 Craft MCP 端点。')
  if (!isCraftMcpUrl(url)) throw new McpClientError('not_configured', 'Craft MCP 端点格式无效。')
  const inflight = connectingByUrl.get(url)
  if (inflight) return inflight
  if (session && configuredUrl === url) return session
  const generation = sessionGeneration
  const pending = (async (): Promise<CraftSession> => {
    // 每次尝试持有自己的会话对象：在途期间用户可能断开或改地址，碰全局那个会把
    // 「已断开」的会话又挂回去（或把新连接踩掉）。
    const created = createCraftSession({ serverUrl: url })
    try {
      const tools = await created.listTools()
      // 0 个只读工具视为不可用：不缓存，让调用方决定是否重试或报错。
      if (!tools.length) throw new McpClientError('not_configured', '连接成功但没有可用的只读工具。')
      if (generation !== sessionGeneration) {
        throw new McpClientError('not_configured', '连接已被断开，重新连接后重试。')
      }
      const previous = session
      session = created
      configuredUrl = url
      if (previous && previous !== created) await previous.disconnect().catch(() => {})
      return created
    } catch (error) {
      await created.disconnect().catch(() => {})
      throw error
    }
  })()
  connectingByUrl.set(url, pending)
  // 这次尝试落定就摘掉：失败时如果把它留在表里，之后每次调用都会拿到同一个拒绝，
  // 网络恢复或设置页重存地址也不会重试。
  pending
    .catch(() => {})
    .finally(() => {
      if (connectingByUrl.get(url) === pending) connectingByUrl.delete(url)
    })
  return pending
}

/** 连接测试：拉一次 tools/list，返回只读工具数；0 个只读工具视为失败。 */
export async function testCraftConnection(): Promise<{ ok: true; tools: number } | { ok: false; message: string }> {
  try {
    const s = await ensureCraftSession()
    const tools = await s.listTools()
    if (!tools.length) return { ok: false, message: '连接成功但没有可用的只读工具。' }
    return { ok: true, tools: tools.length }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 拉取当前可用工具（供设置页展示）。 */
export async function listCraftTools(): Promise<
  { ok: true; tools: Array<{ toolName: string; title: string; description: string; readOnly: boolean }> } | { ok: false; message: string }
> {
  try {
    const s = await ensureCraftSession()
    const tools = await s.listTools()
    return {
      ok: true,
      tools: tools.map((tool) => ({
        toolName: tool.toolName,
        title: tool.title,
        description: (tool.description ?? '').slice(0, 120),
        readOnly: tool.readOnly,
      })),
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 断开连接（设置页「断开」或退出时用）。 */
export async function disconnectCraft(): Promise<void> {
  // 不动 connectingByUrl 里在途的尝试：它们各自会在落定后把自己摘掉，
  // 这里清表反而会让同一地址出现两条并发的建会话路径。代次 +1 让在途尝试作废。
  sessionGeneration += 1
  if (session) {
    await session.disconnect().catch(() => {})
    session = null
    configuredUrl = ''
  }
}

/**
 * 每轮对话构造外部工具：已配置才拉取只读工具并转成 AgentTool。
 * onSources 累积外部引用（与 onCitations 并列）。
 * 连接失败不阻断本轮对话（模型仍可用内置工具），但把原因经 onToolEvent 暴露一次。
 */
export async function buildAgentToolsForTurn(options: {
  onToolEvent?: (event: { phase: 'start' | 'end'; toolName: string; label: string; isError?: boolean }) => void
  onSources?: (sources: ExternalSource[]) => void
}): Promise<{ tools: AgentTool<any>[] }> {
  const url = await getCraftMcpUrl()
  if (!url || !isCraftMcpUrl(url)) return { tools: [] }
  try {
    const s = await ensureCraftSession()
    const descriptors = await s.listTools()
    const tools = descriptors.map((descriptor) =>
      mcpToolToAgentTool(descriptor, s, {
        onToolEvent: options.onToolEvent,
        onSources: options.onSources,
      }),
    )
    return { tools }
  } catch (error) {
    options.onToolEvent?.({
      phase: 'end',
      toolName: 'craft',
      label: 'Craft 笔记库连接失败',
      isError: true,
    })
    return { tools: [] }
  }
}
