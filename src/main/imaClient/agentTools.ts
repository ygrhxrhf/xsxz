/**
 * 把 ima 的检索能力接成 pi AgentTool。
 * - ima_search_notes：先搜笔记标题，命中后读正文——这是「当知识库」的路径。
 * - ima_search_knowledge：在指定知识库里搜内容，命中项带 highlight_content。
 * 两者都只读；结果同时压成文本给模型、抽成 ExternalSource 给侧栏。
 */
import { Type } from '@mariozechner/pi-ai'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ExternalSource } from '../../shared/types'
import {
  imaGetNoteContent,
  imaSearchKnowledge,
  imaSearchNotes,
  type ImaCredentials,
  type ImaSearchHit,
} from './api'

export interface ImaToolContext {
  credentials: ImaCredentials
  /** 用户在设置里选定的知识库；为空时只暴露笔记检索。 */
  knowledgeBaseId?: string
  onToolEvent?: (event: { phase: 'start' | 'end'; toolName: string; label: string; isError?: boolean }) => void
  onSources?: (sources: ExternalSource[]) => void
}

const EXCERPT_LIMIT = 300
const BODY_LIMIT = 6000

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * ima 的检索结果没有公开页面 URL（只有 media_id / note_id），
 * 所以来源条目不写 url，只给标题与摘要；id 用 ima 自身的标识，保证同轮去重稳定。
 */
function hitsToSources(hits: ImaSearchHit[], providerName: string): ExternalSource[] {
  return hits
    .filter((hit) => hit.title)
    .map((hit) => ({
      id: `ima:${hit.media_id || hit.title}`,
      providerName,
      title: hit.title,
      excerpt: clip(hit.highlight_content ?? '', EXCERPT_LIMIT),
    }))
}

export function buildImaAgentTools(context: ImaToolContext): AgentTool<any>[] {
  const tools: AgentTool<any>[] = []

  tools.push({
    name: 'ima_search_notes',
    label: '检索 ima 笔记',
    description:
      '在读者的 ima 笔记里按标题搜索，并读出命中的笔记正文。只有读者自己提到「我的笔记」「之前记过」「查一下我写的」这类指向个人记录的说法时才使用；不要把书里的内容拿到笔记里反查。',
    parameters: Type.Object({
      query: Type.String({ description: '要搜索的标题关键词，尽量短' }),
      fetchBody: Type.Optional(Type.Boolean({ description: '命中后是否读取正文，默认 true' })),
    }),
    execute: async (_toolCallId: string, params: any, signal?: AbortSignal) => {
      const query = typeof params?.query === 'string' ? params.query.trim() : ''
      if (!query) throw new Error('缺少 query')
      const shouldFetchBody = params?.fetchBody !== false
      context.onToolEvent?.({ phase: 'start', toolName: 'ima_search_notes', label: '检索 ima 笔记' })
      try {
        const hits = await imaSearchNotes(query, context.credentials, signal)
        if (!hits.length) {
          return { content: [{ type: 'text', text: `ima 笔记里没有匹配「${query}」的条目。` }], details: { sources: [] } }
        }
        const sources: ExternalSource[] = []
        const parts: string[] = []
        for (const hit of hits.slice(0, 3)) {
          let body = ''
          if (shouldFetchBody) {
            body = await imaGetNoteContent(hit.noteId, context.credentials, signal).catch(() => '')
          }
          parts.push(`《${hit.title}》${body ? `\n${clip(body, BODY_LIMIT)}` : ''}`)
          sources.push({
            id: `ima:${hit.noteId}`,
            providerName: 'ima 笔记',
            title: hit.title,
            excerpt: clip(body, EXCERPT_LIMIT),
          })
        }
        if (sources.length) context.onSources?.(sources)
        return { content: [{ type: 'text', text: parts.join('\n\n') }], details: { sources } }
      } finally {
        context.onToolEvent?.({ phase: 'end', toolName: 'ima_search_notes', label: '检索 ima 笔记' })
      }
    },
  })

  if (context.knowledgeBaseId) {
    tools.push({
      name: 'ima_search_knowledge',
      label: '检索 ima 知识库',
      description:
        '在读者指定的 ima 知识库里搜索内容。读者问「我知识库里有没有…」「资料库里怎么写的」这类问题时使用，命中结果带高亮片段。',
      parameters: Type.Object({
        query: Type.String({ description: '检索关键词' }),
      }),
      execute: async (_toolCallId: string, params: any, signal?: AbortSignal) => {
        const query = typeof params?.query === 'string' ? params.query.trim() : ''
        if (!query) throw new Error('缺少 query')
        context.onToolEvent?.({ phase: 'start', toolName: 'ima_search_knowledge', label: '检索 ima 知识库' })
        try {
          const hits = await imaSearchKnowledge(query, context.knowledgeBaseId!, context.credentials, signal)
          if (!hits.length) {
            return { content: [{ type: 'text', text: `知识库里没有匹配「${query}」的条目。` }], details: { sources: [] } }
          }
          const sources = hitsToSources(hits, 'ima 知识库')
          if (sources.length) context.onSources?.(sources)
          const text = hits
            .slice(0, 8)
            .map((hit) => `《${hit.title}》${hit.highlight_content ? `\n${clip(hit.highlight_content, EXCERPT_LIMIT)}` : ''}`)
            .join('\n\n')
          return { content: [{ type: 'text', text }], details: { sources } }
        } finally {
          context.onToolEvent?.({ phase: 'end', toolName: 'ima_search_knowledge', label: '检索 ima 知识库' })
        }
      },
    })
  }

  return tools
}