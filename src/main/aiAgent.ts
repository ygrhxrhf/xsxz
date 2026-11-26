/**
 * 阅读器里的「AI 对话」：一个真正能调用工具的 agent，内核是 pi（@mariozechner/pi-agent-core）。
 *
 * 与证据问答（aiEvidenceQa）的分工：
 * - 证据问答是单次流水线：改述 → 检索 → 一次作答，回答里每条结论都强制绑定引用。
 * - 这里是多轮 agent：模型自己决定要不要查章节、检索原文、翻记忆，能追问、能改口、能连续读几章。
 *
 * 两条硬约束仍由代码守住，不交给提示词：
 * 1. 取数工具只读「已读前沿」以内（`readChapter` 调的是主进程夹好的正文），未读正文不进模型。
 * 2. 引用的段落坐标由检索工具算出并回传给界面，模型不能自己编坐标。
 */
import { Agent, type AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@mariozechner/pi-ai'
import type { AiCitation, AiMemoryFile } from '../shared/types'

export type ReaderAgentRecallScope = 'book' | 'progress'

/**
 * 对话型 agent 的系统提示：说清可用工具、检索范围与回答口径。
 * `recallScope` 控制能否聊到未读章节：默认 `book`（问答不设防剧透锁），只有读者主动关掉
 * 「可聊全书」时才回退到旧的已读前沿约束。真正的取数边界由 toolkit 夹紧，这里只让模型少走弯路。
 */
export function buildReaderAgentSystemPrompt(
  bookTitle: string,
  currentChapterTitle: string,
  recallScope: ReaderAgentRecallScope = 'book',
): string {
  const scopeRule = recallScope === 'progress'
    ? '- 已读范围之外的内容不要编：读者还没读到就直说“你还没读到那里”。'
    : '- 读者主动追问后续剧情或结局时可以直接回答：read_chapter 与 search_read_text 此时可以访问全书，不要因为某章标着「未读」就拒答；但没人问的时候不要主动把未读章节的后续透出来。'
  return `你是《${bookTitle}》这本书的阅读搭子，读者正读到这里：${currentChapterTitle}。

你可以调用工具：
- list_chapters：看书名、章节与读者读到哪。
- read_chapter：读一章正文。
- search_read_text：按关键词找原文，结果带段落坐标。
- get_memory：人物、关系、伏笔、关键事件（已整理好的记忆）。
- get_chapter_notes：AI 或读者写过的章节笔记。

工作方式（先按问题性质分流，再决定是否调用工具）：
- 【情况 A：字词释义 / 现实百科 / 通用文化常识（与本书具体剧情无关）】
  - 识别标准：读者询问某个字词的读音与本义、成语典故、现实历史地理常识或通用概念本义，且未点名《${bookTitle}》的角色/情节（也没有附带「选中原文」「【参考：…】」等书中上下文）。
  - 动作：**0 工具调用**，直接用自身通用知识简明作答；严禁去调 search_read_text 或 get_memory 空跑一圈，更不能拿“你还没读到那里”来拒绝回答常识。若某个词在小说里可能有专属设定，回答完通用本义后顺带补半句“（以上为通用释义；想看本书里的具体设定可以继续问我）”。
- 【情况 B：本书剧情 / 人物关系 / 设定伏笔 / 原文上下文（需结合书籍）】
  - 先用 memory / 章节笔记这类便宜材料；不够再 search_read_text 找原文；需要上下文与语气才 read_chapter。
  - 读者划词「询问 AI」时，必须将选中原文与《${bookTitle}》的已读剧情、人物设定、伏笔和当前章节上下文联系起来回答，不要脱离本书只给泛泛的词典式解释。
  ${scopeRule}
  - 不确定就说不确定，并指出需要查哪个工具。
- 回答用简洁中文，直接说结论；需要引原文时给出处（章名与段号）。`
}

/**
 * 侧边栏「字词 / 百科」（general 模式）的系统提示词：
 * 完全脱离当前书籍、不挂载查书工具、不校验阅读进度，支持多轮追问字词释义与通识百科。
 */
export function buildGeneralChatSystemPrompt(): string {
  return `你是一个博学、简明的汉语词典与通识百科助手。
当前处于「字词 / 百科（通用问答）」模式，回答与正在阅读的具体小说剧情、人物无关：
- 若读者询问字词、成语、诗词或短语，请直接给出读音/拼音、本义、常见释义、语境用法或典故出处；
- 若读者询问历史、地理、文化、科学等通用常识或百科问题，请直接用准确、简明的中文作答；
- 支持多轮追问；不要编造或关联任何小说剧情，也不要以“还没读到某章”为由拒绝回答；只输出有价值的回答，不加寒暄。`
}

/** 记忆按条压缩成可读摘要；工具输出会进模型上下文，所以只留对回答有用的字段。 */
export function formatMemoryDigest(memory: AiMemoryFile, limit = 40): string {
  const sections: string[] = []
  const push = (title: string, lines: string[]): void => {
    if (lines.length) sections.push(`${title}\n${lines.slice(0, limit).join('\n')}`)
  }
  push('人物', memory.characters.map((item) =>
    `- ${item.name}${item.aliases.length ? `（${item.aliases.join('、')}）` : ''}：${item.role} · ${item.status}。${item.summary}`))
  push('关系', memory.relations.map((item) => `- ${item.from} — ${item.to}：${item.relation}。${item.summary}`))
  push('伏笔', memory.foreshadows.map((item) => `- ${item.desc}（${item.status}）：${item.summary}`))
  push('关键事件', memory.events.map((item) => `- ${item.title}：${item.result}。${item.summary}`))
  return sections.join('\n\n')
}

/** 单轮里最多允许的工具调用次数：防止模型在小范围里反复检索停不下来。 */
export const MAX_AGENT_TOOL_CALLS = 12

export interface AgentChapterRef {
  id: string
  index: number
  title: string
  /** 已读比例 0..1；0 表示还没读到。 */
  readRatio: number
}

export interface AgentReaderToolkit {
  listChapters: () => Promise<AgentChapterRef[]>
  /** 返回的是已读前沿以内的正文，调用方负责夹紧。 */
  readChapter: (chapterId: string) => Promise<{ title: string; body: string; full: boolean }>
  searchReadText: (query: string) => Promise<AiCitation[]>
  memoryDigest: () => Promise<string>
  chapterNotesDigest: (chapterId?: string) => Promise<string>
}

export interface AgentModelConfig {
  baseUrl: string
  model: string
  apiKey: string
}

export interface RunReaderAgentOptions {
  config: AgentModelConfig
  systemPrompt: string
  /** 之前的问答轮次（纯文本），用于多轮追问。 */
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  question: string
  toolkit: AgentReaderToolkit
  signal: AbortSignal
  onDelta: (delta: string) => void
  onTool?: (event: { phase: 'start' | 'end'; name: string; label: string; isError?: boolean }) => void
  onCitations?: (citations: AiCitation[]) => void
}

const TOOL_LABELS: Record<string, string> = {
  list_chapters: '查看章节目录',
  read_chapter: '阅读章节原文',
  search_read_text: '检索已读原文',
  get_memory: '查看小说记忆',
  get_chapter_notes: '查看章节笔记',
}

export interface AgentRunResult {
  text: string
  citations: AiCitation[]
  toolCalls: number
  stopReason: 'stop' | 'stopped' | 'error'
}

function describeSnapshot(chapters: AgentChapterRef[]): string {
  if (!chapters.length) return '（这本书没有可读章节）'
  return chapters.map((chapter) => {
    const mark = chapter.readRatio >= 0.999 ? '已读完' : chapter.readRatio > 0 ? `读到 ${Math.round(chapter.readRatio * 100)}%` : '未读'
    return `- [${chapter.id}] 第${chapter.index + 1}章 ${chapter.title}（${mark}）`
  }).join('\n')
}

function buildTools(toolkit: AgentReaderToolkit, state: { toolCalls: number; citations: AiCitation[]; onCitations?: (citations: AiCitation[]) => void }): AgentTool<any>[] {
  const collect = (citations: AiCitation[]): AiCitation[] => {
    for (const citation of citations) {
      if (!state.citations.some((item) => item.id === citation.id)) state.citations.push(citation)
    }
    state.onCitations?.([...state.citations])
    return citations
  }

  return [
    {
      name: 'list_chapters',
      label: TOOL_LABELS.list_chapters!,
      description: '列出本书章节与每章的已读进度。想知道书名、章节顺序、或某章是否读过时先调用它。',
      parameters: Type.Object({}),
      execute: async () => {
        state.toolCalls += 1
        const chapters = await toolkit.listChapters()
        return { content: [{ type: 'text', text: describeSnapshot(chapters) }], details: chapters }
      },
    },
    {
      name: 'read_chapter',
      label: TOOL_LABELS.read_chapter!,
      description: '读取一章的正文（只返回读者已读到的部分）。需要原文细节、语气或具体描写时使用；正文较长，按需调用。',
      parameters: Type.Object({
        chapterId: Type.String({ description: 'list_chapters 返回的章节 id' }),
      }),
      execute: async (_toolCallId: string, params: any) => {
        state.toolCalls += 1
        const chapterId = typeof params?.chapterId === 'string' ? params.chapterId : ''
        if (!chapterId) throw new Error('缺少 chapterId')
        const chapter = await toolkit.readChapter(chapterId)
        if (!chapter.body.trim()) throw new Error(`《${chapter.title}》还没有可读正文`)
        return {
          content: [{
            type: 'text',
            text: `《${chapter.title}》${chapter.full ? '' : '（只到读者已读位置）'}\n\n${chapter.body}`,
          }],
          details: { chapterId, title: chapter.title, full: chapter.full },
        }
      },
    },
    {
      name: 'search_read_text',
      label: TOOL_LABELS.search_read_text!,
      description: '在已读正文里按关键词检索并返回带段落坐标的原文片段。找具体事件、人名、对话出处时使用，比通读章节省额度。',
      parameters: Type.Object({
        query: Type.String({ description: '检索词：人名、地名、物件或一个短句' }),
      }),
      execute: async (_toolCallId: string, params: any) => {
        state.toolCalls += 1
        const query = typeof params?.query === 'string' ? params.query.trim() : ''
        if (!query) throw new Error('缺少 query')
        const citations = collect(await toolkit.searchReadText(query))
        if (!citations.length) {
          return { content: [{ type: 'text', text: `已读正文里没有找到「${query}」。` }], details: [] }
        }
        return {
          content: [{
            type: 'text',
            text: citations.map((citation) => `〔${citation.chapterTitle} · 第${citation.paragraphIndex + 1}段〕${citation.excerpt}`).join('\n\n'),
          }],
          details: citations,
        }
      },
    },
    {
      name: 'get_memory',
      label: TOOL_LABELS.get_memory!,
      description: '读取已经整理好的小说记忆（人物、关系、伏笔、关键事件），带来源章节。问人物身份、关系变化、伏笔时先看这里，比翻原文快。',
      parameters: Type.Object({}),
      execute: async () => {
        state.toolCalls += 1
        const digest = await toolkit.memoryDigest()
        return {
          content: [{ type: 'text', text: digest || '还没有整理过小说记忆；可以用 search_read_text 或 read_chapter 直接查原文。' }],
          details: { empty: !digest },
        }
      },
    },
    {
      name: 'get_chapter_notes',
      label: TOOL_LABELS.get_chapter_notes!,
      description: '读取 AI 或读者写过的章节笔记。想知道之前对某章记过什么时使用。',
      parameters: Type.Object({
        chapterId: Type.Optional(Type.String({ description: '只读这一章；省略则返回最近几章' })),
      }),
      execute: async (_toolCallId: string, params: any) => {
        state.toolCalls += 1
        const chapterId = typeof params?.chapterId === 'string' ? params.chapterId : undefined
        const digest = await toolkit.chapterNotesDigest(chapterId)
        return {
          content: [{ type: 'text', text: digest || '这本书还没有章节笔记。' }],
          details: { empty: !digest },
        }
      },
    },
  ]
}

/** 自定义端点不保证支持 strict/推理参数：按「最保守的 OpenAI 兼容」发，宁可少特性也不要 400。 */
function buildModel(config: AgentModelConfig): any {
  return {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: 'custom',
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_000,
    compat: {
      supportsStrictMode: false,
      supportsReasoningEffort: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
    },
  }
}

function textOf(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text'
      ? String((block as { text?: unknown }).text ?? '')
      : ''))
    .join('')
}

export async function runReaderAgent(options: RunReaderAgentOptions): Promise<AgentRunResult> {
  const state: { toolCalls: number; citations: AiCitation[]; onCitations?: (citations: AiCitation[]) => void } = {
    toolCalls: 0,
    citations: [],
    onCitations: options.onCitations,
  }
  let streamed = ''

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: buildModel(options.config),
      thinkingLevel: 'off',
      tools: buildTools(options.toolkit, state),
      messages: options.history.map((turn) => ({
        role: turn.role,
        content: turn.content,
        timestamp: Date.now(),
      })) as any,
    },
    getApiKey: () => options.config.apiKey,
    // 模型想无限往下查时会话会失控：按次数掐死，并把事实告诉它而不是静默截断。
    beforeToolCall: async () => {
      if (state.toolCalls >= MAX_AGENT_TOOL_CALLS) {
        return { block: true, reason: `本轮工具调用已达 ${MAX_AGENT_TOOL_CALLS} 次上限，请直接基于已有材料作答。` }
      }
      return undefined
    },
  })

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent
      if (update.type === 'text_delta' && update.delta) {
        streamed += update.delta
        options.onDelta(update.delta)
      }
      return
    }
    if (event.type === 'tool_execution_start') {
      options.onTool?.({
        phase: 'start',
        name: event.toolName,
        label: TOOL_LABELS[event.toolName] ?? event.toolName,
      })
      return
    }
    if (event.type === 'tool_execution_end') {
      options.onTool?.({
        phase: 'end',
        name: event.toolName,
        label: TOOL_LABELS[event.toolName] ?? event.toolName,
        isError: event.isError,
      })
    }
  })

  const onAbort = (): void => agent.abort()
  if (options.signal.aborted) {
    unsubscribe()
    return { text: '', citations: [], toolCalls: 0, stopReason: 'stopped' }
  }
  options.signal.addEventListener('abort', onAbort, { once: true })

  try {
    await agent.prompt(options.question)
    await agent.waitForIdle()
  } finally {
    unsubscribe()
    options.signal.removeEventListener('abort', onAbort)
  }

  const messages = agent.state.messages
  const lastAssistant = [...messages].reverse().find((message) => (message as { role?: string }).role === 'assistant') as
    | { stopReason?: string; errorMessage?: string }
    | undefined

  if (options.signal.aborted || lastAssistant?.stopReason === 'aborted') {
    return { text: streamed.trim(), citations: [...state.citations], toolCalls: state.toolCalls, stopReason: 'stopped' }
  }
  if (lastAssistant?.stopReason === 'error') {
    throw new Error(lastAssistant.errorMessage || '模型调用失败')
  }
  const text = (streamed.trim() || textOf(lastAssistant).trim())
  if (!text) throw new Error('模型没有返回任何内容，请重试')
  return { text, citations: [...state.citations], toolCalls: state.toolCalls, stopReason: 'stop' }
}
