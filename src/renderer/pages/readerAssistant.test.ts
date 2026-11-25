import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Book, ChapterMeta } from '@shared/types'
import { useReaderAssistant } from './readerAssistant'

/**
 * 助手面板搬出 Reader.vue 之后可以单独测了：这里只喂最小依赖，验证
 * 「入口开对 tab、没书时不发请求、忙闲按任务种类分开」这几条不变量。
 */
const CHAPTER: ChapterMeta = { id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' }
const BOOK: Book = {
  id: 'book-1', title: '助手书', author: '', tags: [], importType: 'txt',
  createdAt: '', updatedAt: '', status: 'ready', chapters: [CHAPTER], progress: null,
}

const api = {
  ai: {
    getChat: vi.fn(), getSummaries: vi.fn(), getMemory: vi.fn(), getTimeline: vi.fn(),
    timeline: vi.fn(), chapterNotes: vi.fn(), resumeCard: vi.fn(), getMaterialCoverage: vi.fn(),
    getUsage: vi.fn(), chatStream: vi.fn(), agentChat: vi.fn(), replaceChat: vi.fn(),
    storySoFar: vi.fn(), summarizeChapter: vi.fn(), semanticIndexStatus: vi.fn(),
  },
}

const notices: string[] = []

function makeAssistant(overrides: { book?: Book | null } = {}) {
  return useReaderAssistant({
    book: ref(overrides.book === undefined ? BOOK : overrides.book),
    currentChapter: ref(CHAPTER),
    chapterBody: ref('第一段。\n\n第二段。'),
    paras: ref(['第一段。', '第二段。']),
    chapters: ref([CHAPTER]),
    contentRef: ref(null),
    fontSize: ref(18),
    readingMode: ref('scroll'),
    message: {
      error: (text: string) => notices.push(`error:${text}`),
      success: (text: string) => notices.push(`success:${text}`),
      warning: (text: string) => notices.push(`warning:${text}`),
      info: (text: string) => notices.push(`info:${text}`),
    },
    loadBook: async () => {},
    openChapter: async () => {},
    pendingScrollPara: { get: () => -1, set: () => {} },
    resumeCardView: ref(null),
    resumeCardLoading: ref(false),
    resumeCardWarning: ref(''),
    showSelPopup: ref(false),
    selectedExcerpt: ref(''),
    selectedRange: ref(null),
    selectionOffsets: () => null,
    restoringChat: ref(false),
    aiResult: ref(''),
    aiResultTitle: ref(''),
    closeSelectionTools: () => {},
  })
}

beforeEach(() => {
  notices.length = 0
  vi.clearAllMocks()
  for (const fn of Object.values(api.ai)) fn.mockResolvedValue({ ok: true, messages: [], notes: [], usage: { calls: 0 } })
  api.ai.getChat.mockResolvedValue({ ok: true, version: 2, messages: [] })
  vi.stubGlobal('window', { api } as unknown as Window & typeof globalThis)
})

describe('useReaderAssistant（助手面板域）', () => {
  it('openAiAssistant 打开抽屉并切到指定 tab', async () => {
    const assistant = makeAssistant()
    expect(assistant.showAiAssistant.value).toBe(false)

    await assistant.openAiAssistant('qa')
    expect(assistant.showAiAssistant.value).toBe(true)
    expect(assistant.aiAssistantTab.value).toBe('qa')

    assistant.showAiAssistant.value = false
    await assistant.openAiAssistant('memory')
    expect(assistant.aiAssistantTab.value).toBe('memory')
  })

  it('没有打开书时不发任何模型请求', async () => {
    const assistant = makeAssistant({ book: null })
    await assistant.openAiAssistant('recap')
    await assistant.sendChat()
    expect(api.ai.chatStream).not.toHaveBeenCalled()
    expect(api.ai.storySoFar).not.toHaveBeenCalled()
  })

  it('忙闲按任务种类分开：记忆在跑不灰掉问答', async () => {
    const assistant = makeAssistant()
    assistant.memoryJobId.value = 'job-memory'
    expect(assistant.assistantBusyByKind.value.memory).toBe(true)
    expect(assistant.assistantBusyByKind.value.qa).toBe(false)
    expect(assistant.assistantBusyByKind.value.notes).toBe(false)
  })
})

  it('对话模式把参考范围附在问题后面，payload 与聊天记录一致', async () => {
    const assistant = makeAssistant()
    assistant.qaContextChips.value = { chapter: true, memory: false, notes: false }
    assistant.chatInput.value = '玉印去了哪里？'
    await assistant.sendChat()

    expect(api.ai.agentChat).toHaveBeenCalledTimes(1)
    const payload = api.ai.agentChat.mock.calls[0]![2] as { role: string; content: string }[]
    expect(payload.at(-1)!.content).toBe('玉印去了哪里？\n\n【参考：本章原文】')
    // 主进程会原样落盘：界面上的聊天记录必须和 payload 是同一句
    // 主进程会原样落盘：界面上的聊天记录必须和 payload 是同一句（最后一条是刚占位的助手气泡）
    expect(assistant.chatMessages.value.at(-2)!.content).toBe(payload.at(-1)!.content)
  })

  it('证据模式不拼参考范围，只把问题原样发出去', async () => {
    const assistant = makeAssistant()
    assistant.qaContextChips.value = { chapter: true, memory: true, notes: true }
    assistant.chatMode.value = 'evidence'
    assistant.chatInput.value = '玉印去了哪里？'
    await assistant.sendChat()

    expect(api.ai.chatStream).toHaveBeenCalledTimes(1)
    const payload = api.ai.chatStream.mock.calls[0]![2] as { role: string; content: string }[]
    expect(payload.at(-1)!.content).toBe('玉印去了哪里？')
  })

  it('重问拿旧句子再发时不把参考范围叠成两行', async () => {
    const assistant = makeAssistant()
    assistant.qaContextChips.value = { chapter: false, memory: false, notes: true }
    // 旧一轮的问题里已经带着上次那行标记：重问会把这句话原样再发一遍
    assistant.chatMessages.value = [
      { role: 'user' as const, content: '玉印去了哪里？\n\n【参考：本章原文】' },
      { role: 'assistant' as const, content: '她把玉印交了出去。' },
    ]
    await assistant.reAskChatAnswer(1)

    const payload = api.ai.agentChat.mock.calls[0]![2] as { role: string; content: string }[]
    // 旧标记先剥掉，再按当前开关拼——否则会变成两行「【参考：…】」
    expect(payload.at(-1)!.content).toBe('玉印去了哪里？\n\n【参考：我的批注】')
  })

  it('证据模式下点开关不改变状态', async () => {
    const assistant = makeAssistant()
    assistant.chatMode.value = 'evidence'
    assistant.toggleQaContextChip('chapter')
    expect(assistant.qaContextChips.value.chapter).toBe(false)
  })
