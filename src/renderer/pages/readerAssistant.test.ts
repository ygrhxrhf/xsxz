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
    getUsage: vi.fn(), chatStream: vi.fn(), storySoFar: vi.fn(), summarizeChapter: vi.fn(),
    semanticIndexStatus: vi.fn(),
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
