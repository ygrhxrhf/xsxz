// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'
import type { AiBudgetEvent, AiCitation, AiChunkEvent, AiDoneEvent, AiStageEvent } from '../../shared/types'

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true,
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

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

async function mountAssistant(handlers: Handlers, chatStarts: { count: number }) {
  const book = {
    id: 'book1', title: '验收书', author: '', tags: [], importType: 'txt', status: 'ready',
    createdAt: '', updatedAt: '',
    chapters: [{ id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const }],
    progress: { chapterId: 'c1', chapterIndex: 1, scrollRatio: 0.5, updatedAt: '' },
  }
  Object.defineProperty(window, 'api', { configurable: true, value: {
    library: {
      get: async () => ({ book: JSON.parse(JSON.stringify(book)) }),
      readChapter: async (_bookId: string, id: string) => ({ chapter: { title: id, status: 'ready', body: `${id}正文。` } }),
      setProgress: async () => ({ ok: true }),
      updateChapterBody: async () => ({ ok: true }),
    },
    annotations: { list: async () => ({ ok: true, items: [] }), add: async () => ({ ok: true }), update: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
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
      cancel: async () => ({ ok: true }),
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
    bubbles: () => [...document.querySelectorAll('.chat-msg.assistant .chat-bubble')].map((el) => el.textContent ?? ''),
    stopButton: () => [...document.querySelectorAll<HTMLButtonElement>('.chat-input-row button')]
      .find((item) => item.textContent?.includes('停止生成')),
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
})
