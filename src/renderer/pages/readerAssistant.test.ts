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
    getUsage: vi.fn(), chatStream: vi.fn(), agentChat: vi.fn(), generalChat: vi.fn(), explainText: vi.fn(), replaceChat: vi.fn(),
    clearChat: vi.fn(), listThreads: vi.fn(), createThread: vi.fn(), deleteThread: vi.fn(),
    storySoFar: vi.fn(), summarizeChapter: vi.fn(), semanticIndexStatus: vi.fn(),
  },
}

const notices: string[] = []

function makeAssistant(overrides: { book?: Book | null; selectedExcerpt?: string } = {}) {
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
    selectedExcerpt: ref(overrides.selectedExcerpt ?? ''),
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
  // 会话栏的默认桩：一本书还没有会话，界面就停在欢迎态。
  api.ai.listThreads.mockResolvedValue({ ok: true, threads: [], activeThreadId: '' })
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
  it('通用字词/百科模式（general）不拼参考范围，走 generalChat 通道并标记 scope=general', async () => {
    const assistant = makeAssistant()
    assistant.qaContextChips.value = { chapter: true, memory: true, notes: true }
    assistant.chatMode.value = 'general'
    assistant.chatInput.value = '“夺舍”原本是道教什么概念？'
    await assistant.sendChat()

    expect(api.ai.generalChat).toHaveBeenCalledTimes(1)
    expect(api.ai.agentChat).not.toHaveBeenCalled()
    expect(api.ai.chatStream).not.toHaveBeenCalled()
    const payload = api.ai.generalChat.mock.calls[0]![1] as { role: string; content: string }[]
    expect(payload.at(-1)!.content).toBe('“夺舍”原本是道教什么概念？')
    expect(assistant.chatMessages.value.at(-1)?.scope).toBe('general')
  })

  it('划词「解释字词」点「在侧边栏中继续」后自动落到 general 模式，不会硬切回书籍 agent', async () => {
    api.ai.explainText.mockResolvedValue({ ok: true, jobId: 'job-1' })
    const assistant = makeAssistant({ selectedExcerpt: '踟蹰' })
    await assistant.explainSelection('word')
    assistant.inlineAsk.finish({ jobId: 'job-1', ok: true, text: '踟蹰：徘徊不前。' })
    assistant.inlineAsk.continueInSidebar()

    expect(assistant.chatMode.value).toBe('general')
    expect(assistant.chatMessages.value.at(-1)).toMatchObject({
      role: 'assistant',
      content: '踟蹰：徘徊不前。',
      citations: [],
      scope: 'general',
    })
  })

/**
 * 会话栏的动作层：切/建/删会话和发问时带的是哪个 threadId。
 *
 * 主进程已经按 threadId 分好了文件，但界面这一层如果传错一个 id，
 * 消息就会落进另一条会话——这类错误界面上看不出来，只能在这一层盯住。
 */
describe('useReaderAssistant（问答会话）', () => {
  const thread = (id: string, title: string, messageCount = 1) => ({
    id, title, messageCount, updatedAt: '2026-01-01T00:00:00.000Z',
  })

  it('发问时把当前会话 id 透传给主进程，没有会话时传 undefined', async () => {
    const agent = makeAssistant()
    agent.chatThreadId.value = 'th_story'
    agent.chatInput.value = '玉印去了哪里？'
    await agent.sendChat()
    expect(api.ai.agentChat).toHaveBeenCalledTimes(1)
    // 第三个参数是 history，第四个才是 threadId
    expect(api.ai.agentChat.mock.calls[0]![3]).toBe('th_story')
    expect(api.ai.chatStream).not.toHaveBeenCalled()

    const evidence = makeAssistant()
    evidence.chatMode.value = 'evidence'
    evidence.chatThreadId.value = 'th_story'
    evidence.chatInput.value = '再问一次'
    await evidence.sendChat()
    expect(api.ai.chatStream.mock.calls[0]![3]).toBe('th_story')

    // 空串是「这本书还没有会话」：要传 undefined，让主进程自己按需开一条
    const fresh = makeAssistant()
    fresh.chatInput.value = '第一次提问'
    await fresh.sendChat()
    expect(api.ai.agentChat.mock.calls.at(-1)![3]).toBeUndefined()
  })

  it('clearChat 只清当前会话，不删会话本身', async () => {
    const assistant = makeAssistant()
    assistant.chatThreadId.value = 'th_story'
    assistant.chatMessages.value = [
      { role: 'user', content: '玉印去了哪里？' },
      { role: 'assistant', content: '她把玉印交了出去。' },
    ]
    assistant.chatInput.value = '半句草稿'
    await assistant.clearChat()

    // 不带 threadId 会清到主进程的 active 上：清错一条别处的会话
    expect(api.ai.clearChat).toHaveBeenCalledWith('book-1', 'th_story')
    expect(api.ai.deleteThread).not.toHaveBeenCalled()
    expect(assistant.chatMessages.value).toEqual([])
    expect(assistant.chatInput.value).toBe('')
    // 条数变了，会话栏上的「N 条」得跟着回到 0
    expect(api.ai.listThreads).toHaveBeenCalled()

    const empty = makeAssistant()
    await empty.clearChat()
    expect(api.ai.clearChat).toHaveBeenCalledWith('book-1', undefined)
  })

  it('生成中切会话直接返回，一次历史都不读', async () => {
    const assistant = makeAssistant()
    assistant.chatThreadId.value = 'th_a'
    assistant.chatMessages.value = [{ role: 'user', content: 'A 会话的问题' }]
    assistant.chatLoading.value = true

    await assistant.switchChatThread('th_b')

    // 流式回答还在往当前会话追加：切走会把后面的句子写进另一条
    expect(api.ai.getChat).not.toHaveBeenCalled()
    expect(assistant.chatThreadId.value).toBe('th_a')
    expect(assistant.chatMessages.value.map((message) => message.content)).toEqual(['A 会话的问题'])
  })

  it('切会话用磁盘上的那条历史整段覆盖界面，草稿一并清掉', async () => {
    api.ai.getChat.mockResolvedValue({
      ok: true, version: 2, threadId: 'th_b',
      messages: [{ role: 'user', content: 'B 会话的问题' }],
    })
    const assistant = makeAssistant()
    assistant.chatThreadId.value = 'th_a'
    assistant.chatMessages.value = [{ role: 'user', content: 'A 会话的问题' }]
    assistant.chatInput.value = '这条草稿属于 A 会话'

    await assistant.switchChatThread('th_b')

    expect(api.ai.getChat).toHaveBeenCalledWith('book-1', 'th_b')
    expect(assistant.chatThreadId.value).toBe('th_b')
    expect(assistant.chatMessages.value.map((message) => message.content)).toEqual(['B 会话的问题'])
    // 留着就会把 A 会话的问题发进 B 会话
    expect(assistant.chatInput.value).toBe('')
  })

  it('删掉当前会话后自动加载剩下的那条', async () => {
    api.ai.listThreads.mockResolvedValue({
      ok: true, activeThreadId: 'th_b', threads: [thread('th_b', '剧情线')],
    })
    api.ai.getChat.mockResolvedValue({
      ok: true, version: 2, threadId: 'th_b',
      messages: [{ role: 'user', content: '剩下来的那条会话' }],
    })
    const assistant = makeAssistant()
    assistant.chatThreadId.value = 'th_a'
    assistant.chatMessages.value = [{ role: 'user', content: '要删掉的那条会话' }]

    await assistant.removeChatThread('th_a')

    expect(api.ai.deleteThread).toHaveBeenCalledWith('book-1', 'th_a')
    // 主进程已经把 active 交给了最近的剩余会话，界面跟着落到它上面
    expect(assistant.chatThreadId.value).toBe('th_b')
    expect(api.ai.getChat).toHaveBeenCalledWith('book-1', 'th_b')
    expect(assistant.chatMessages.value.map((message) => message.content)).toEqual(['剩下来的那条会话'])
  })

  it('删到一条不剩时回欢迎态：清空消息，不去读不存在的会话', async () => {
    api.ai.listThreads.mockResolvedValue({ ok: true, activeThreadId: '', threads: [] })
    const assistant = makeAssistant()
    assistant.chatThreadId.value = 'th_only'
    assistant.chatMessages.value = [{ role: 'user', content: '唯一一条会话' }]
    assistant.chatInput.value = '草稿'

    await assistant.removeChatThread('th_only')

    expect(api.ai.deleteThread).toHaveBeenCalledWith('book-1', 'th_only')
    expect(assistant.chatThreadId.value).toBe('')
    expect(assistant.chatMessages.value).toEqual([])
    expect(assistant.chatInput.value).toBe('')
    expect(api.ai.getChat).not.toHaveBeenCalled()
  })

  it('删的不是当前会话时不重新加载历史，界面停在原处', async () => {
    api.ai.listThreads.mockResolvedValue({
      ok: true, activeThreadId: 'th_a', threads: [thread('th_a', '人物线')],
    })
    const assistant = makeAssistant()
    assistant.chatThreadId.value = 'th_a'
    assistant.chatMessages.value = [{ role: 'user', content: '正在看的这条会话' }]

    await assistant.removeChatThread('th_b')

    expect(api.ai.deleteThread).toHaveBeenCalledWith('book-1', 'th_b')
    expect(api.ai.getChat).not.toHaveBeenCalled()
    expect(assistant.chatThreadId.value).toBe('th_a')
    expect(assistant.chatMessages.value.map((message) => message.content)).toEqual(['正在看的这条会话'])
  })

  it('会话到上限时把主进程的可读原因说给读者，不静默失败', async () => {
    api.ai.createThread.mockResolvedValue({ ok: false, message: '会话数量已达上限（20），请先删除不用的会话' })
    const assistant = makeAssistant()

    await assistant.newChatThread()

    expect(api.ai.createThread).toHaveBeenCalledWith('book-1')
    expect(notices).toContain('error:会话数量已达上限（20），请先删除不用的会话')
    // 没建出来就不该去读一条不存在的新会话
    expect(api.ai.getChat).not.toHaveBeenCalled()
  })
})
