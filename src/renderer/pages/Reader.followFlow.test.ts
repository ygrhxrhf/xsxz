// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'
import { DEFAULT_AI_PREFS } from '../../shared/types'
import type { AiBudgetEstimate, AiFollowCoverage, AiFollowMode, AiMaterialCoverage } from '../../shared/types'

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true,
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })
Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
  value: () => ({ top: 120, left: 40, bottom: 140, right: 200, width: 160, height: 20, x: 40, y: 120 }),
  configurable: true,
})

function followView(overrides: Partial<AiFollowCoverage> = {}): AiFollowCoverage {
  return {
    mode: 'manual', running: false, paused: false, queuedChapters: 0,
    organizedChapters: 0, calls: 0, estimatedTokens: 0, ...overrides,
  }
}

function materialView(follow: AiFollowCoverage): AiMaterialCoverage {
  return {
    uptoChapterId: 'c2', uptoChapterTitle: '第二章', readyChapters: 2,
    summarizedChapters: follow.organizedChapters, missing: [], follow,
  }
}

const overBudget: AiBudgetEstimate = {
  originalCharacters: 42000, sentCharacters: 30000, estimatedTokens: 24000,
  chapterCount: 12, paragraphCount: 600, batchCount: 3, range: '第一章 ~ 第十二章',
}

type Fixture = {
  follow: AiFollowCoverage
  finished: Array<{ chapterId: string; ratio: number }>
  sets: Array<{ mode: AiFollowMode; confirmOverBudget: boolean }>
  setResults: Array<Record<string, unknown>>
  retries: number
  coverageCalls: number
}

function installApi(fixture: Fixture) {
  const book = {
    id: 'book1', title: '验收书', author: '', tags: [], importType: 'txt', status: 'ready',
    createdAt: '', updatedAt: '',
    chapters: [
      { id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const },
      { id: 'c2', index: 2, title: '第二章', file: '0002.json', status: 'ready' as const },
    ],
    progress: { chapterId: 'c1', chapterIndex: 1, scrollRatio: 0, updatedAt: '' },
  }
  Object.defineProperty(window, 'api', { configurable: true, value: {
    library: {
      get: async () => ({ book: JSON.parse(JSON.stringify(book)) }),
      readChapter: async (_bookId: string, id: string) => ({ chapter: { title: id, status: 'ready', body: `${id}正文。` } }),
      setProgress: async () => ({ ok: true }),
    },
    tts: { getPosition: async () => null, setPosition: async () => ({ ok: true }), cancel: async () => ({ ok: true }), synthesize: async () => new Uint8Array() },
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
    annotations: { list: async () => ({ ok: true, items: [] }) },
    download: { onProgress: () => () => {} },
    ai: {
      onChunk: () => () => {}, onStage: () => () => {}, onBudget: () => () => {}, onDone: () => () => {},
      getMemory: async () => ({ ok: true, memory: null }),
      getSummaries: async () => ({ ok: true, summaries: {} }),
      getChat: async () => ({ ok: true, version: 2, messages: [] }),
      chapterNotes: async () => ({ ok: true, notes: [], current: null }),
      getUsage: async () => ({ ok: true, usage: { calls: 0, inputTokens: 0, outputTokens: 0 } }),
      getMaterialCoverage: async () => {
        fixture.coverageCalls += 1
        return { ok: true, coverage: materialView(fixture.follow) }
      },
      chapterFinished: async (_bookId: string, chapterId: string, ratio: number) => {
        fixture.finished.push({ chapterId, ratio })
        return { ok: true, coverage: fixture.follow }
      },
      followSet: async (_bookId: string, mode: AiFollowMode, confirmOverBudget = false) => {
        fixture.sets.push({ mode, confirmOverBudget })
        return (fixture.setResults.shift()
          ?? { ok: true, coverage: { ...fixture.follow, mode } }) as never
      },
      followRetry: async () => { fixture.retries += 1; return { ok: true, coverage: fixture.follow } },
    },
  } })
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === label)
}

async function mountReader() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book1' }) }) })
  app.mount(host)
  await vi.waitFor(() => expect(document.querySelector('.reader-content')?.textContent).toContain('c1正文。'))
  return {
    app,
    pane: document.querySelector<HTMLElement>('.reader-content')!,
    goNextChapter() { document.querySelector<HTMLButtonElement>('[aria-label="下一章"]')?.click() },
    async openAssistant() {
      document.querySelector<HTMLButtonElement>('[aria-label="AI"]')?.click()
      await vi.waitFor(() => expect(document.body.textContent).toContain('AI 助手'))
      const entry = findButton('AI 助手')
      if (!entry) throw new Error('工具面板里的「AI 助手」入口没渲染')
      entry.click()
      await vi.waitFor(() => expect(document.body.textContent).toContain('读完一章后整理'))
      await nextTick()
    },
    async pickMode(label: '手动' | '提醒我' | '自动') {
      const input = [...document.querySelectorAll<HTMLInputElement>('.n-radio-button input[type="radio"]')]
        .find((item) => item.closest('label')?.textContent?.trim() === label)
      if (!input) throw new Error(`找不到模式按钮「${label}」`)
      input.click()
      await nextTick()
    },
    button(label: string) {
      const item = findButton(label)
      if (!item) throw new Error(`找不到按钮「${label}」`)
      return item
    },
    bodyText: () => document.body.textContent ?? '',
  }
}

/** 把滚动位置做成 jsdom 里可读的量：jsdom 的 scrollHeight/clientHeight 恒为 0。 */
function setScroll(pane: HTMLElement, scrollTop: number, scrollHeight = 2000, clientHeight = 500) {
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: clientHeight })
  Object.defineProperty(pane, 'scrollTop', { configurable: true, writable: true, value: scrollTop })
  pane.dispatchEvent(new Event('scroll'))
}

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

describe('Reader 追剧改用主进程状态', () => {
  it('离开读完的章节才上报，比率交给主进程判定', async () => {
    const fixture: Fixture = {
      follow: followView({ mode: 'auto' }), finished: [], sets: [], setResults: [], retries: 0, coverageCalls: 0,
    }
    installApi(fixture)
    const reader = await mountReader()
    try {
      setScroll(reader.pane, 1490)
      await nextTick()
      reader.goNextChapter()
      await vi.waitFor(() => expect(reader.bodyText()).toContain('c2正文。'))
      await vi.waitFor(() => expect(fixture.finished).toHaveLength(1))
      expect(fixture.finished[0]!.chapterId).toBe('c1')
      expect(fixture.finished[0]!.ratio).toBeGreaterThanOrEqual(0.9)
    } finally { reader.app.unmount() }
  })

  it('没读完的章节不上报，读章也不被 AI 挡住', async () => {
    const fixture: Fixture = {
      follow: followView({ mode: 'auto' }), finished: [], sets: [], setResults: [], retries: 0, coverageCalls: 0,
    }
    installApi(fixture)
    const reader = await mountReader()
    try {
      setScroll(reader.pane, 300)
      await nextTick()
      reader.goNextChapter()
      await vi.waitFor(() => expect(reader.bodyText()).toContain('c2正文。'))
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(fixture.finished).toEqual([])
    } finally { reader.app.unmount() }
  })

  it('队列与进度显示的是主进程记账，不是界面自己数的', async () => {
    const fixture: Fixture = {
      follow: followView({ mode: 'ask', queuedChapters: 2, organizedChapters: 5, uptoChapterTitle: '第五章', calls: 3, estimatedTokens: 1200 }),
      finished: [], sets: [], setResults: [], retries: 0, coverageCalls: 0,
    }
    installApi(fixture)
    const reader = await mountReader()
    try {
      await reader.openAssistant()
      expect(reader.bodyText()).toContain('待整理 2 章')
      expect(reader.bodyText()).toContain('已整理 5 章')
      expect(reader.bodyText()).toContain('第五章')
    } finally { reader.app.unmount() }
  })

  it('切自动先过预算门禁，主进程没答应就不改模式', async () => {
    const fixture: Fixture = {
      follow: followView({ mode: 'ask' }), finished: [], sets: [],
      setResults: [
        { ok: false, confirmationRequired: true, message: '开启自动追剧后，每读完一章都会把本章正文送给模型整理摘要与小说记忆。', budget: overBudget },
        { ok: true, coverage: followView({ mode: 'auto', running: true, queuedChapters: 4 }) },
      ],
      retries: 0, coverageCalls: 0,
    }
    installApi(fixture)
    const reader = await mountReader()
    try {
      await reader.openAssistant()
      await reader.pickMode('自动')
      expect(fixture.sets).toEqual([{ mode: 'auto', confirmOverBudget: false }])
      await vi.waitFor(() => expect(reader.bodyText()).toContain('确认发送范围'))
      expect(reader.bodyText()).toContain('每读完一章都会把本章正文送给模型')

      reader.button('继续').click()
      await vi.waitFor(() => expect(fixture.sets).toHaveLength(2))
      expect(fixture.sets[1]).toEqual({ mode: 'auto', confirmOverBudget: true })
      await vi.waitFor(() => expect(reader.bodyText()).toContain('待整理 4 章'))
      await vi.waitFor(() => expect(reader.bodyText()).toContain('正在整理'))
    } finally { reader.app.unmount() }
  })

  it('主进程在跑时界面按轮询拉状态，不靠本地事件', async () => {
    const fixture: Fixture = {
      follow: followView({ mode: 'auto', running: true, queuedChapters: 1 }),
      finished: [], sets: [], setResults: [], retries: 0, coverageCalls: 0,
    }
    const ticks: Array<() => void> = []
    vi.spyOn(globalThis, 'setInterval').mockImplementation((fn: () => void) => {
      ticks.push(fn)
      return 1 as unknown as ReturnType<typeof setInterval>
    })
    installApi(fixture)
    const reader = await mountReader()
    try {
      await vi.waitFor(() => expect(ticks.length).toBeGreaterThan(0))
      const before = fixture.coverageCalls
      for (const tick of ticks) tick()
      await vi.waitFor(() => expect(fixture.coverageCalls).toBeGreaterThan(before))
    } finally { reader.app.unmount() }
  })

  it('暂停原因与失败原因来自磁盘，「现在整理」走 followRetry', async () => {
    const fixture: Fixture = {
      follow: followView({
        mode: 'auto', paused: true, pauseReason: '本轮已达到 12 章上限', queuedChapters: 6,
        failed: { message: '模型服务连接超时', at: '2026-10-08T00:00:00.000Z' },
      }),
      finished: [], sets: [], setResults: [], retries: 0, coverageCalls: 0,
    }
    installApi(fixture)
    const reader = await mountReader()
    try {
      await reader.openAssistant()
      expect(reader.bodyText()).toContain('已暂停：本轮已达到 12 章上限')
      expect(reader.bodyText()).toContain('上次失败：模型服务连接超时')
      reader.button('继续整理').click()
      await vi.waitFor(() => expect(fixture.retries).toBe(1))
    } finally { reader.app.unmount() }
  })
})
