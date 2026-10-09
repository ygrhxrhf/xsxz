// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'
import { DEFAULT_AI_PREFS } from '../../shared/types'

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true,
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

type Fixture = { memoryStarts: number; chatStarts: number; applies: string[]; cleaned: string }

function installApi(fixture: Fixture) {
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
      updateChapterBody: async (_bookId: string, _chapterId: string, body: string) => {
        fixture.applies.push(body)
        return { ok: true }
      },
    },
    tts: { getPosition: async () => null, setPosition: async () => ({ ok: true }), cancel: async () => ({ ok: true }), synthesize: async () => new Uint8Array() },
    annotations: { list: async () => ({ ok: true, items: [] }) },
    download: { onProgress: () => () => {} },
    settings: {
      get: async () => ({
        reader: {
          fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
          paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll',
        },
        tts: { rate: 1, autoNextChapter: false, source: 'system' },
        baseUrl: '', libraryPath: '', ai: { ...DEFAULT_AI_PREFS },
      }),
      set: async () => ({}),
    },
    ai: {
      onChunk: () => () => {}, onStage: () => () => {}, onBudget: () => () => {}, onDone: () => () => {},
      getMemory: async () => ({ ok: true, memory: null }),
      getSummaries: async () => ({ ok: true, summaries: {} }),
      getChat: async () => ({ ok: true, version: 2, messages: [] }),
      chapterNotes: async () => ({ ok: true, notes: [], current: null }),
      getUsage: async () => ({ ok: true, usage: { calls: 0, inputTokens: 0, outputTokens: 0 } }),
      getMaterialCoverage: async () => ({ ok: true, coverage: null }),
      chapterFinished: async () => ({ ok: true }),
      followSet: async () => ({ ok: true }),
      followRetry: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      updateMemory: async () => { fixture.memoryStarts += 1; return { ok: true, jobId: 'mem-1' } },
      clean: async () => ({
        ok: true,
        result: { cleaned: fixture.cleaned },
        budget: { originalCharacters: 1200, sentCharacters: 1000, estimatedTokens: 800, chapterCount: 1,
          paragraphCount: 20, batchCount: 1, range: '第一章' },
      }),
      chatStream: async () => { fixture.chatStarts += 1; return { ok: true, jobId: 'qa-1' } },
    },
  } })
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)
}

/** 只把工具面板打开；AI 壳由用例按用户那两条入口之一自己进入。 */
async function mountReader() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book1' }) }) })
  app.mount(host)
  await vi.waitFor(() => expect(document.querySelector('.reader-content')?.textContent).toContain('c1正文。'))
  document.querySelector<HTMLButtonElement>('[aria-label="AI"]')?.click()
  await vi.waitFor(() => expect(findButton('AI 助手')).toBeTruthy())
  return {
    app,
    bodyText: () => document.body.textContent ?? '',
    paneText: () => document.querySelector('.reader-content')?.textContent ?? '',
    async openAssistant() {
      findButton('AI 助手')!.click()
      await vi.waitFor(() => expect(document.body.textContent).toContain('读完一章后整理'))
      await nextTick()
    },
    button(label: string) {
      const item = findButton(label)
      if (!item) throw new Error(`找不到按钮「${label}」`)
      return item
    },
    async clickTab(label: '前情' | '记忆' | '问答' | '输出') {
      const tab = [...document.querySelectorAll<HTMLElement>('.n-tabs-tab')]
        .find((item) => item.textContent?.trim() === label)
      if (!tab) throw new Error(`找不到 tab「${label}」`)
      tab.click()
      await nextTick()
    },
    activeTab: () => document.querySelector<HTMLElement>('.n-tabs-tab--active')?.textContent?.trim() ?? '',
    async closeToolPanel() {
      document.querySelector<HTMLButtonElement>('[aria-label="AI"]')?.click()
      await vi.waitFor(() => expect(document.querySelector('.tool-panel')).toBeNull())
    },
    chatField: () => document.querySelector<HTMLTextAreaElement>('.chat-input-row textarea'),
    sendButton: () => [...document.querySelectorAll<HTMLButtonElement>('.chat-input-row button')]
      .find((item) => item.textContent?.includes('发送问题'))!,
  }
}

afterEach(() => { document.body.innerHTML = '' })

describe('Reader AI 壳的分任务忙闲', () => {
  it('记忆在跑时问答照常可用，只有问答自己开始才灰掉输入框', async () => {
    const fixture: Fixture = { memoryStarts: 0, chatStarts: 0, applies: [], cleaned: '干净正文' }
    installApi(fixture)
    const reader = await mountReader()
    try {
      await reader.openAssistant()
      await reader.clickTab('记忆')
      reader.button('更新记忆').click()
      await vi.waitFor(() => expect(fixture.memoryStarts).toBe(1))

      await reader.clickTab('问答')
      await vi.waitFor(() => expect(reader.chatField()).toBeTruthy())
      expect(reader.chatField()!.disabled, '后台在整理记忆时不该挡住提问').toBe(false)
      const send = reader.sendButton()
      expect(send.disabled, '记忆在跑时发送按钮也不该被灰掉').toBe(true)

      await reader.clickTab('前情')
      expect(reader.button('刷新前情').disabled, '记忆在跑不该挡住前情').toBe(false)

      await reader.clickTab('问答')
      const field = reader.chatField()!
      field.value = '玉印后来去了哪里？'
      field.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.waitFor(() => expect(reader.sendButton().disabled).toBe(false))
      reader.sendButton().click()
      await vi.waitFor(() => expect(fixture.chatStarts).toBe(1))
      expect(reader.chatField()!.disabled, '问答自己在跑时才该灰').toBe(true)
    } finally { reader.app.unmount() }
  })

  it('清正文结果落在同一个壳的「输出」tab，应用后写回正文', async () => {
    const fixture: Fixture = { memoryStarts: 0, chatStarts: 0, applies: [], cleaned: '干净正文' }
    installApi(fixture)
    const reader = await mountReader()
    try {
      reader.button('清正文').click()
      await vi.waitFor(() => expect(reader.bodyText()).toContain('干净正文'))
      expect(reader.activeTab(), '一次性结果应停在输出 tab').toBe('输出')
      expect(reader.bodyText()).toContain('预计发送：1 章 / 20 段')
      expect(document.querySelectorAll('.n-drawer'), '不该再有第二个 AI 抽屉').toHaveLength(1)

      reader.button('应用到正文').click()
      await vi.waitFor(() => expect(fixture.applies).toEqual(['干净正文']))
      await vi.waitFor(() => expect(reader.paneText()).toContain('干净正文'))
    } finally { reader.app.unmount() }
  })

  it('I 打开 AI 助手，N 直达本章笔记', async () => {
    const fixture: Fixture = { memoryStarts: 0, chatStarts: 0, applies: [], cleaned: '干净正文' }
    installApi(fixture)
    const reader = await mountReader()
    try {
      await reader.closeToolPanel()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }))
      await vi.waitFor(() => expect(reader.bodyText()).toContain('读完一章后整理'))
      expect(reader.activeTab()).toBe('前情')

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await vi.waitFor(() => expect(reader.bodyText()).not.toContain('读完一章后整理'))

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }))
      await vi.waitFor(() => expect(reader.bodyText()).toContain('只发送本章正文和本章的划线批注'))
      expect(reader.activeTab()).toBe('笔记')
    } finally { reader.app.unmount() }
  })
})
