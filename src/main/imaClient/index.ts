/**
 * ima 门面：读凭据、构造每轮的外部工具、连接测试。
 * 凭据从 settings 的解密读取拿，只在主进程内存里存在。
 */
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ExternalSource } from '../../shared/types'
import { getImaCredentials } from '../settings'
import { buildImaAgentTools } from './agentTools'
import {
  imaListAddableKnowledgeBases,
  imaSearchNotes,
  type ImaCredentials,
} from './api'

export interface ImaKnowledgeBaseOption {
  id: string
  name: string
}

/** 连接测试：用一次笔记搜索证明凭据可用，并顺带列出可添加的知识库。 */
export async function testImaConnection(): Promise<
  { ok: true; knowledgeBases: ImaKnowledgeBaseOption[] } | { ok: false; message: string }
> {
  const credentials = await getImaCredentials()
  if (!credentials) return { ok: false, message: '尚未配置 ima 凭据。' }
  try {
    // 搜索一个不会命中的词：只验证鉴权与接口通，不写任何东西。
    await imaSearchNotes('连接测试', credentials)
    let knowledgeBases: ImaKnowledgeBaseOption[] = []
    try {
      knowledgeBases = (await imaListAddableKnowledgeBases(credentials)).map((item) => ({ id: item.id, name: item.name }))
    } catch {
      // 知识库列表失败不影响「凭据可用」这个结论。
    }
    return { ok: true, knowledgeBases }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 列出可添加的知识库（设置页选目标知识库用）。 */
export async function listImaKnowledgeBases(): Promise<
  { ok: true; knowledgeBases: ImaKnowledgeBaseOption[] } | { ok: false; message: string }
> {
  const credentials = await getImaCredentials()
  if (!credentials) return { ok: false, message: '尚未配置 ima 凭据。' }
  try {
    const list = await imaListAddableKnowledgeBases(credentials)
    return { ok: true, knowledgeBases: list.map((item) => ({ id: item.id, name: item.name })) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 每轮对话构造 ima 工具；未配置凭据返回空数组。 */
export async function buildImaToolsForTurn(options: {
  knowledgeBaseId?: string
  onToolEvent?: (event: { phase: 'start' | 'end'; toolName: string; label: string; isError?: boolean }) => void
  onSources?: (sources: ExternalSource[]) => void
}): Promise<{ tools: AgentTool<any>[] }> {
  const credentials: ImaCredentials | null = await getImaCredentials()
  if (!credentials) return { tools: [] }
  return {
    tools: buildImaAgentTools({
      credentials,
      knowledgeBaseId: options.knowledgeBaseId,
      onToolEvent: options.onToolEvent,
      onSources: options.onSources,
    }),
  }
}