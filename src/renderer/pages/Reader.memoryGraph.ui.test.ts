// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'
import { DEFAULT_AI_PREFS } from '../../shared/types'
import type { AiMemoryFile } from '../../shared/types'

/**
 * 记忆页签里的关系图接线：折叠标题、默认收起、展开后画出来。
 * 图本身的行为在 components/MemoryGraph.ui.test.ts 里测，这里只钉住 Reader 的接线与位置。
 */
class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true,
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

const MEMORY: AiMemoryFile = {
  version: 1,
  characters: [
    { id: 'c1', name: '林小满', aliases: ['小满'], role: '剑修', status: '主角', summary: '', sources: [], accuracy: 'normal', updatedAt: '' },
    { id: 'c2', name: '陈七', aliases: [], role: '符师', status: '配角', summary: '', sources: [], accuracy: 'normal', updatedAt: '' },
  ],
  relations: [
    {
      id: 'r1', from: '林小满', to: '陈七', relation: '同门', status: '稳定', summary: '',
      sources: [{ id: 's1', chapterId: 'c1', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '两人同门。' }],
      accuracy: 'normal', updatedAt: '',
    },
  ],
  foreshadows: [],
  events: [],
  updatedAt: '',
}

function installApi() {
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
    },
    tts: { getPosition: async () => null, setPosition: async () => ({ ok: true }), cancel: async () => ({ ok: true }), synthesize: async () => new Uint8Array() },
    annotations: { list: async () => ({ ok: true, items: [] }) },
    download: { onProgress: () => () => {} },
    settings: {
      get: async () => ({
        reader: {
          fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
          paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll', bookView: 'classic',
        },
        tts: { rate: 1, autoNextChapter: false, source: 'system' },
        baseUrl: '', libraryPath: '', ai: { ...DEFAULT_AI_PREFS },
      }),
      set: async () => ({}),
    },
    ai: {
      onChunk: () => () => {}, onStage: () => () => {}, onBudget: () => () => {}, onDone: () => () => {},
      getMemory: async () => ({ ok: true, memory: MEMORY }),
      getSummaries: async () => ({ ok: true, summaries: {} }),
      getChat: async () => ({ ok: true, version: 2, messages: [] }),
      chapterNotes: async () => ({ ok: true, notes: [], current: null }),
      getUsage: async () => ({ ok: true, usage: { calls: 0, inputTokens: 0, outputTokens: 0 } }),
      getMaterialCoverage: async () => ({ ok: true, coverage: null }),
      getTimeline: async () => ({ ok: true, timeline: { entries: [] } }),
      chapterFinished: async () => ({ ok: true }),
      followSet: async () => ({ ok: true }),
      followRetry: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
    },
  } })
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)
}

async function openMemoryTab() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book1' }) }) })
  app.mount(host)
  await vi.waitFor(() => expect(document.querySelector('.reader-content')?.textContent).toContain('c1正文。'))
  document.querySelector<HTMLButtonElement>('[aria-label="AI"]')?.click()
  await vi.waitFor(() => expect(findButton('AI 助手')).toBeTruthy())
  findButton('AI 助手')!.click()
  await vi.waitFor(() => expect([...document.querySelectorAll('.n-tabs-tab')]
    .some((tab) => tab.textContent?.trim() === '记忆')).toBe(true))
  const tab = [...document.querySelectorAll<HTMLElement>('.n-tabs-tab')].find((item) => item.textContent?.trim() === '记忆')!
  tab.click()
  await nextTick()
  return app
}

afterEach(() => { document.body.innerHTML = '' })

describe('Reader 记忆页签的关系图接线', () => {
  it('折叠标题带人数与关系数，默认收起，展开后画出节点', async () => {
    installApi()
    const app = await openMemoryTab()
    try {
      const panel = document.querySelector<HTMLDetailsElement>('.memory-graph-panel')
      expect(panel, '有关系时才有这块').not.toBeNull()
      // 两张人物卡都在关系里，1 条关系 → 「2 人 / 1 条关系」。
      expect(panel!.querySelector('summary')?.textContent?.trim()).toBe('人物关系图 · 2 人 / 1 条关系')
      expect(panel!.open, '默认该收起，别让一进记忆页就要滚过一张图').toBe(false)
      // 收起时内容也在 DOM 里，但没有展开就看不见；点击 summary 展开后节点出现。
      panel!.open = true
      await nextTick()
      expect(panel!.querySelectorAll('[data-node-id]')).toHaveLength(2)
    } finally { app.unmount() }
  })
})
