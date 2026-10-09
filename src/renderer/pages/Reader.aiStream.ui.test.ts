// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'
import type {
  AiBudgetEvent,
  AiChapterNote,
  AiChunkEvent,
  AiCitation,
  AiDoneEvent,
  AiStageEvent,
} from '../../shared/types'

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true,
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })
// jsdom 的 Range 没有几何信息，选区工具条定位需要 getBoundingClientRect
Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
  value: () => ({ top: 120, left: 40, bottom: 140, right: 200, width: 160, height: 20, x: 40, y: 120 }),
  configurable: true,
})

const citation: AiCitation = {
  id: 'qa-c1-p1', chapterId: 'c1', chapterTitle: '第一章', paragraphIndex: 0,
  excerpt: '她把玉印交了出去。',
}

type Handlers = {
  chunk?: (event: AiChunkEvent) => void
  stage?: (event: AiStageEvent) => void
  budget?: (event: AiBudgetEvent) => void
  done?: (event: AiDoneEvent) => void
}

/** 本章笔记的后端替身：记录渲染层怎么调用，并按队列返回主进程可能给出的各种响应。 */
type NoteFixture = {
  notes: AiChapterNote[]
  current: (AiChapterNote & { stale: boolean }) | null
  starts: Array<{ confirmOverBudget: boolean; overwriteUserNote: boolean }>
  startResults: Array<Record<string, unknown>>
  saves: string[]
  listCalls: Array<string | undefined>
  cancels: string[]
}

function createNoteFixture(): NoteFixture {
  return { notes: [], current: null, starts: [], startResults: [], saves: [], listCalls: [], cancels: [] }
}

/** 笔记 pane 用文案认，不靠 naive-ui 生成的 tab id */
function readerNotesPane(): HTMLElement {
  const pane = [...document.querySelectorAll<HTMLElement>('.n-tab-pane')]
    .find((item) => item.textContent?.includes('只发送本章正文和本章的划线批注'))
  if (!pane) throw new Error('笔记 pane 没渲染')
  return pane
}

function readerNotesView(): string {
  return readerNotesPane().querySelector('.ai-result')?.textContent ?? ''
}

async function mountAssistant(
  handlers: Handlers,
  chatStarts: { count: number },
  notes: NoteFixture = createNoteFixture(),
) {
  const book = {
    id: 'book1', title: '验收书', author: '', tags: [], importType: 'txt', status: 'ready',
    createdAt: '', updatedAt: '',
    chapters: [{ id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const }],
    progress: { chapterId: 'c1', chapterIndex: 1, scrollRatio: 0.5, updatedAt: '' },
  }
  const annotationAdds: Array<Record<string, unknown>> = []
  Object.defineProperty(window, 'api', { configurable: true, value: {
    library: {
      get: async () => ({ book: JSON.parse(JSON.stringify(book)) }),
      readChapter: async (_bookId: string, id: string) => ({ chapter: { title: id, status: 'ready', body: `${id}正文。` } }),
      setProgress: async () => ({ ok: true }),
      updateChapterBody: async () => ({ ok: true }),
    },
    annotations: {
      list: async () => ({ ok: true, items: [] }),
      add: async (draft: Record<string, unknown>) => {
        annotationAdds.push(draft)
        return { ok: true, item: { ...draft, id: 'a1', createdAt: new Date().toISOString() } }
      },
      update: async () => ({ ok: true }),
      remove: async () => ({ ok: true }),
    },
    download: { onProgress: () => () => {}, cancel: async () => ({ ok: true }), retryFailed: async () => ({ ok: true }) },
    settings: {
      get: async () => ({
        reader: {
          fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
          paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll',
        },
        tts: { rate: 1, autoNextChapter: false, source: 'system' }, baseUrl: '', libraryPath: '',
      }),
      set: async () => ({}),
    },
    ai: {
      onChunk: (fn: (event: AiChunkEvent) => void) => { handlers.chunk = fn; return () => { handlers.chunk = undefined } },
      onStage: (fn: (event: AiStageEvent) => void) => { handlers.stage = fn; return () => { handlers.stage = undefined } },
      onBudget: (fn: (event: never) => void) => { handlers.budget = fn as Handlers['budget']; return () => { handlers.budget = undefined } },
      onDone: (fn: (event: AiDoneEvent) => void) => { handlers.done = fn; return () => { handlers.done = undefined } },
      chatStream: async () => { chatStarts.count += 1; return { ok: true, jobId: 'qa-1' } },
      getChat: async () => ({ ok: true, version: 2, messages: [] }),
      clearChat: async () => ({ ok: true }),
      cancel: async (jobId?: string) => { notes.cancels.push(jobId ?? ''); return { ok: true } },
      chapterNote: async (
        _bookId: string,
        _chapterId: string,
        confirmOverBudget = false,
        overwriteUserNote = false,
      ) => {
        notes.starts.push({ confirmOverBudget, overwriteUserNote })
        return (notes.startResults.shift() ?? { ok: true, jobId: 'note-1' }) as never
      },
      chapterNotes: async (_bookId: string, chapterId?: string) => {
        notes.listCalls.push(chapterId)
        return { ok: true, notes: notes.notes, current: notes.current }
      },
      saveChapterNote: async (_bookId: string, chapterId: string, text: string) => {
        notes.saves.push(text)
        const note: AiChapterNote = { chapterId, bodyHash: 'hash-本章', text, updatedAt: '', userEdited: true }
        notes.notes = [note]
        notes.current = { ...note, stale: false }
        return { ok: true, note }
      },
      getMemory: async () => ({ ok: true, memory: null }),
      getSummaries: async () => ({ ok: true, summaries: {} }),
      getMaterialCoverage: async () => ({ ok: true, coverage: null }),
      getUsage: async () => ({ ok: true, usage: { calls: 0, inputTokens: 0, outputTokens: 0 } }),
    },
  } })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book1' }) }) })
  app.mount(host)
  await vi.waitFor(() => expect(document.querySelector('.reader-content')?.textContent).toContain('c1正文。'))
  document.querySelector<HTMLButtonElement>('[aria-label="AI"]')?.click()
  await nextTick()
  const qaButton = [...document.querySelectorAll<HTMLButtonElement>('.tool-panel button')]
    .find((item) => item.textContent?.includes('聊书'))
  expect(qaButton, 'AI 面板里的「聊书」入口').toBeTruthy()
  qaButton?.click()
  await vi.waitFor(() => expect(document.querySelector('.chat-input-row textarea')).toBeTruthy())
  return {
    app,
    annotationAdds,
    notes,
    bodyText: () => document.body.textContent ?? '',
    bubbles: () => [...document.querySelectorAll('.chat-msg.assistant .chat-bubble')].map((el) => el.textContent ?? ''),
    async clickTab(label: string) {
      const tab = [...document.querySelectorAll<HTMLElement>('.n-tabs-tab')]
        .find((item) => item.textContent?.trim() === label)
      expect(tab, `抽屉里应有「${label}」tab`).toBeTruthy()
      tab!.click()
      await vi.waitFor(() => expect(document.body.textContent).toContain('只发送本章正文和本章的划线批注'))
      await nextTick()
    },
    notesPane: readerNotesPane,
    noteView: () => readerNotesView(),
    clickNoteButton: (label: string) => {
      const button = [...readerNotesPane().querySelectorAll<HTMLButtonElement>('button')]
        .find((item) => item.textContent?.trim() === label)
      if (!button) throw new Error(`笔记 pane 里没有「${label}」按钮`)
      button.click()
      return nextTick()
    },
    writeNoteDraft: async (text: string) => {
      const field = readerNotesPane().querySelector<HTMLTextAreaElement>('textarea')!
      field.value = text
      field.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
    },
    stopButton: () => [...document.querySelectorAll<HTMLButtonElement>('.chat-input-row button')]
      .find((item) => item.textContent?.includes('停止生成')),
    saveNoteButton: () => [...document.querySelectorAll<HTMLButtonElement>('.chat-msg button')]
      .find((item) => item.textContent?.includes('存为这段的批注')),
    /** 在渲染出的段落上建立真实 DOM 选区并松开鼠标，走的就是用户那条路径 */
    async selectText(from: number, to: number) {
      const para = document.querySelector<HTMLElement>('[data-p]')!
      // 段落里还有 Vue 留下的空文本锚点，选区要落在真正承载文字的那个节点上
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT)
      let node: Text | null = null
      while (walker.nextNode()) {
        const candidate = walker.currentNode as Text
        if (candidate.data.length >= to) { node = candidate; break }
      }
      if (!node) throw new Error('段落里没有可断言的文本节点')
      const range = document.createRange()
      range.setStart(node, from)
      range.setEnd(node, to)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      para.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
      await nextTick()
    },
    async ask(question: string) {
      const field = document.querySelector<HTMLTextAreaElement>('.chat-input-row textarea')!
      field.value = question
      field.dispatchEvent(new Event('input', { bubbles: true }))
      const send = [...document.querySelectorAll<HTMLButtonElement>('.chat-input-row button')]
        .find((item) => item.textContent?.includes('发送问题'))!
      await vi.waitFor(() => expect(send.disabled, '输入后发送按钮应可用').toBe(false))
      send.click()
    },
  }
}

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('Reader 问答流式呈现', () => {
  it('依据芯片与回答正文都在 ai.done 之前进入气泡', async () => {
    const handlers: Handlers = {}
    const chatStarts = { count: 0 }
    const reader = await mountAssistant(handlers, chatStarts)
    try {
      await reader.ask('玉印后来去了哪里？')
      await vi.waitFor(() => expect(reader.bubbles()).toHaveLength(1))
      expect(reader.bubbles()[0]).toBe('')
      expect(handlers.stage, '已订阅 ai.stage').toBeTruthy()

      handlers.stage?.({ jobId: 'qa-1', stage: 'requesting', citations: [citation], uptoChapterId: 'c1' })
      await nextTick()
      const evidence = document.querySelector('.chat-msg.assistant .chat-evidence')
      expect(evidence?.textContent).toContain('依据')
      expect(evidence?.textContent).toContain('第一章 · 第 1 段：她把玉印交了出去。')
      expect(reader.bubbles()[0], '依据先于回答，正文此时仍为空').toBe('')

      for (const delta of ['她把玉印', '交给了', '码头的账房先生。']) {
        handlers.chunk?.({ jobId: 'qa-1', delta })
        await nextTick()
      }
      expect(reader.bubbles()[0]).toBe('她把玉印交给了码头的账房先生。')
      expect(reader.stopButton(), '流式期间仍是生成中状态').toBeTruthy()
      expect(document.body.textContent, 'ai.done 之前不得出现终态用量').not.toContain('最近一次：')

      handlers.done?.({
        jobId: 'qa-1', ok: true, text: '她把玉印交给了码头的账房先生。此后她离开了码头。',
        citations: [citation], uptoChapterId: 'c1', stopped: false, truncated: false,
        usage: { inputTokens: 12, outputTokens: 8 },
      })
      await nextTick()
      expect(reader.bubbles()[0]).toBe('她把玉印交给了码头的账房先生。此后她离开了码头。')
      expect(reader.stopButton(), '终态后回到可再次提问').toBeUndefined()
      expect(document.body.textContent).toContain('最近一次：输入 12 / 输出 8 tokens')
      expect(document.body.textContent).not.toContain('服务未返回 token 用量。')
      expect(chatStarts.count).toBe(1)
    } finally { reader.app.unmount() }
  })

  it('停止后仍显示已流出的部分回答并标注来源', async () => {
    const handlers: Handlers = {}
    const reader = await mountAssistant(handlers, { count: 0 })
    try {
      await reader.ask('玉印后来去了哪里？')
      await vi.waitFor(() => expect(reader.bubbles()).toHaveLength(1))
      handlers.chunk?.({ jobId: 'qa-1', delta: '她把玉印交了出去。' })
      await nextTick()
      handlers.done?.({
        jobId: 'qa-1', ok: true, text: '她把玉印交了出去。', citations: [citation],
        uptoChapterId: 'c1', stopped: true, truncated: false,
      })
      await nextTick()
      expect(reader.bubbles()).toEqual(['她把玉印交了出去。'])
      expect(document.body.textContent).toContain('已停止，以下为停止前生成的部分回答。')
      expect(document.querySelector('.chat-msg.assistant .chat-evidence')?.textContent).toContain('第一章 · 第 1 段')
    } finally { reader.app.unmount() }
  })

  it('模型失败时用中文错误替换空气泡，不留下无来源的回答', async () => {
    const handlers: Handlers = {}
    const reader = await mountAssistant(handlers, { count: 0 })
    try {
      await reader.ask('玉印后来去了哪里？')
      await vi.waitFor(() => expect(reader.bubbles()).toHaveLength(1))
      handlers.done?.({ jobId: 'qa-1', ok: false, message: 'API Key 无效或无权限，请到设置页核对' })
      await nextTick()
      expect(reader.bubbles()).toEqual(['错误：API Key 无效或无权限，请到设置页核对'])
      expect(document.querySelector('.chat-msg.assistant .chat-evidence')).toBeNull()
      expect(document.querySelector('.chat-msg.assistant .chat-legacy')).toBeNull()
    } finally { reader.app.unmount() }
  })

  it('选区提问的回答存回被选中的那个区间', async () => {
    const handlers: Handlers = {}
    const chatStarts = { count: 0 }
    const reader = await mountAssistant(handlers, chatStarts)
    try {
      await reader.selectText(2, 4)
      const askButton = [...document.querySelectorAll<HTMLButtonElement>('.sel-popup button')]
        .find((item) => item.textContent?.includes('问 AI'))
      expect(askButton, '选区工具条应有「问 AI」入口').toBeTruthy()
      askButton!.click()
      await vi.waitFor(() => expect(reader.bubbles()).toHaveLength(1))
      expect(chatStarts.count).toBe(1)
      expect(reader.saveNoteButton(), '回答还没生成时不给存批注').toBeUndefined()

      handlers.done?.({
        jobId: 'qa-1', ok: true, text: '「正文」是这一章反复出现的词。',
        citations: [], uptoChapterId: 'c1', stopped: false,
      })
      await nextTick()
      const save = reader.saveNoteButton()
      expect(save, '选区提问的回答应能存回原文').toBeTruthy()
      save!.click()
      await vi.waitFor(() => expect(reader.annotationAdds).toHaveLength(1))
      expect(reader.annotationAdds[0]).toMatchObject({
        bookId: 'book1', chapterId: 'c1', kind: 'highlight',
        start: 2, end: 4, excerpt: '正文',
        note: '「正文」是这一章反复出现的词。', noteSource: 'ai',
      })
      await vi.waitFor(() => expect(reader.saveNoteButton(), '存过一次就收起，避免重复落同一条批注').toBeUndefined())
    } finally { reader.app.unmount() }
  })
})

describe('Reader 本章笔记流式呈现', () => {
  it('笔记逐字长出来，ai.done 之后按磁盘内容定稿', async () => {
    const handlers: Handlers = {}
    const notes = createNoteFixture()
    const reader = await mountAssistant(handlers, { count: 0 }, notes)
    try {
      await reader.clickTab('笔记')
      expect(reader.noteView()).toBe('还没有本章笔记。')
      expect(notes.listCalls.at(-1), '打开笔记 tab 才按当前章读取').toBe('c1')

      await reader.clickNoteButton('生成本章笔记')
      await vi.waitFor(() => expect(notes.starts).toHaveLength(1))
      expect(notes.starts[0]).toEqual({ confirmOverBudget: false, overwriteUserNote: false })

      for (const delta of ['这一章', '写玉印交接，', '顾清第一次说谎。']) {
        handlers.chunk?.({ jobId: 'note-1', delta })
        await nextTick()
      }
      expect(reader.noteView()).toBe('这一章写玉印交接，顾清第一次说谎。')
      expect(reader.bodyText()).not.toContain('本章笔记已保存')

      const saved: AiChapterNote = {
        chapterId: 'c1', bodyHash: 'hash-本章', text: '这一章写玉印交接，顾清第一次说谎。此后她离开了码头。', updatedAt: '',
      }
      notes.notes = [saved]
      notes.current = { ...saved, stale: false }
      handlers.done?.({ jobId: 'note-1', ok: true, text: saved.text })
      await vi.waitFor(() => expect(reader.noteView()).toBe(saved.text))
      expect(reader.bodyText()).toContain('本章笔记已保存')
      expect(notes.listCalls.length, '成功后回读磁盘，界面不自存一份').toBeGreaterThan(1)
      expect(reader.bodyText()).not.toContain('正文已变，建议重新生成')
    } finally { reader.app.unmount() }
  })

  it('停止生成把已流出的部分留在界面上，不去回读磁盘', async () => {
    const handlers: Handlers = {}
    const notes = createNoteFixture()
    const reader = await mountAssistant(handlers, { count: 0 }, notes)
    try {
      await reader.clickTab('笔记')
      const readsBefore = notes.listCalls.length
      await reader.clickNoteButton('生成本章笔记')
      await vi.waitFor(() => expect(notes.starts).toHaveLength(1))
      handlers.chunk?.({ jobId: 'note-1', delta: '这一章写玉印交接。' })
      await nextTick()

      await reader.clickNoteButton('停止生成')
      expect(notes.cancels).toEqual(['note-1'])
      handlers.done?.({ jobId: 'note-1', ok: true, text: '这一章写玉印交接。', stopped: true })
      await nextTick()

      expect(reader.noteView()).toBe('这一章写玉印交接。')
      expect(reader.bodyText()).toContain('已停止，以下为停止前生成的部分笔记。')
      expect(notes.listCalls.length, '停止的笔记没有落盘，不该去磁盘找').toBe(readsBefore)
      expect(reader.stopButton(), '任务已终结，停止按钮收起').toBeUndefined()
    } finally { reader.app.unmount() }
  })

  it('手改过的笔记先问一句：保留就不动，覆盖才重生成', async () => {
    const handlers: Handlers = {}
    const notes = createNoteFixture()
    const mine: AiChapterNote = {
      chapterId: 'c1', bodyHash: 'hash-本章', text: '我自己写的笔记', updatedAt: '', userEdited: true,
    }
    notes.notes = [mine]
    notes.current = { ...mine, stale: false }
    const overwritePrompt = {
      ok: false,
      userNoteConfirmedRequired: true,
      message: '本章笔记你已经改过，重新生成会覆盖你的修改。是否继续？',
    }
    notes.startResults = [overwritePrompt]
    const reader = await mountAssistant(handlers, { count: 0 }, notes)
    try {
      await reader.clickTab('笔记')
      expect(reader.noteView()).toBe('我自己写的笔记')
      await reader.clickNoteButton('重新生成')
      await vi.waitFor(() => expect(reader.bodyText()).toContain('覆盖重新生成'))
      expect(reader.bodyText()).toContain('本章笔记你已经改过，重新生成会覆盖你的修改。是否继续？')
      expect(notes.starts).toHaveLength(1)

      await reader.clickNoteButton('保留我的笔记')
      await nextTick()
      expect(reader.bodyText()).not.toContain('覆盖重新生成')
      expect(notes.starts, '保留我的笔记只收起提示，绝不发任务').toHaveLength(1)
      expect(reader.noteView()).toBe('我自己写的笔记')

      notes.startResults = [overwritePrompt]
      await reader.clickNoteButton('重新生成')
      await vi.waitFor(() => expect(reader.bodyText()).toContain('覆盖重新生成'))
      await reader.clickNoteButton('覆盖重新生成')
      await vi.waitFor(() => expect(notes.starts).toHaveLength(3))
      expect(notes.starts[2]).toEqual({ confirmOverBudget: false, overwriteUserNote: true })
      expect(reader.bodyText()).not.toContain('本章笔记你已经改过')
    } finally { reader.app.unmount() }
  })

  it('自己写的笔记去头尾空白后保存，空正文按中文报错', async () => {
    const handlers: Handlers = {}
    const notes = createNoteFixture()
    const reader = await mountAssistant(handlers, { count: 0 }, notes)
    try {
      await reader.clickTab('笔记')
      await reader.writeNoteDraft('  玉印给了码头账房。  ')
      await reader.clickNoteButton('保存笔记')
      await vi.waitFor(() => expect(notes.saves).toEqual(['玉印给了码头账房。']))
      await vi.waitFor(() => expect(reader.noteView()).toBe('玉印给了码头账房。'))

      await reader.writeNoteDraft('   ')
      await reader.clickNoteButton('保存笔记')
      await vi.waitFor(() => expect(reader.bodyText()).toContain('笔记不能为空'))
      expect(notes.saves).toHaveLength(1)
    } finally { reader.app.unmount() }
  })

  it('正文改过的笔记标成过期，过期判定只落在当前这一章', async () => {
    const handlers: Handlers = {}
    const notes = createNoteFixture()
    const old: AiChapterNote = { chapterId: 'c1', bodyHash: '旧hash', text: '旧笔记', updatedAt: '', userEdited: true }
    notes.notes = [old, { chapterId: 'c2', bodyHash: 'hash-2', text: '别的章', updatedAt: '' }]
    notes.current = { ...old, stale: true }
    const reader = await mountAssistant(handlers, { count: 0 }, notes)
    try {
      await reader.clickTab('笔记')
      expect(reader.noteView()).toBe('旧笔记')
      expect(reader.bodyText()).toContain('正文已变，建议重新生成')
      expect([...reader.notesPane().querySelectorAll<HTMLButtonElement>('button')]
        .some((item) => item.textContent?.trim() === '重新生成')).toBe(true)
      expect(notes.starts).toHaveLength(0)
      expect(reader.bodyText()).toContain('别的章')
    } finally { reader.app.unmount() }
  })
})
