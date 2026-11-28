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

/**
 * 三条关系分别在第1、2、3章成立：读者停在第2章时只该看到前两条，
 * 「陈七 — 苏三 宿敌」是第3章的事，提前看到就是剧透。
 */
const MEMORY: AiMemoryFile = {
  version: 1,
  characters: [
    { id: 'c1', name: '林小满', aliases: ['小满'], role: '剑修', status: '主角', summary: '', sources: [], accuracy: 'normal', updatedAt: '' },
    { id: 'c2', name: '陈七', aliases: [], role: '符师', status: '配角', summary: '', sources: [], accuracy: 'normal', updatedAt: '' },
    { id: 'c3', name: '苏三', aliases: [], role: '散修', status: '龙套', summary: '', sources: [], accuracy: 'normal', updatedAt: '' },
  ],
  relations: [
    {
      id: 'r1', from: '林小满', to: '陈七', relation: '同门', status: '稳定', summary: '',
      sources: [{ id: 's1', chapterId: 'c1', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '两人同门。' }],
      accuracy: 'normal', updatedAt: '',
    },
    {
      id: 'r2', from: '林小满', to: '苏三', relation: '师徒', status: '稳定', summary: '',
      sources: [{ id: 's2', chapterId: 'c2', chapterTitle: '第二章', paragraphIndex: 0, excerpt: '收为徒弟。' }],
      accuracy: 'normal', updatedAt: '',
    },
    {
      id: 'r3', from: '陈七', to: '苏三', relation: '宿敌', status: '稳定', summary: '',
      sources: [{ id: 's3', chapterId: 'c3', chapterTitle: '第三章', paragraphIndex: 0, excerpt: '两人结仇。' }],
      accuracy: 'normal', updatedAt: '',
    },
  ],
  foreshadows: [],
  events: [],
  updatedAt: '',
}

/**
 * 三章的书，续读停在第2章。
 * 章节表故意**不按 index 排序**：切片上限必须靠 id 找到当前章的 index，
 * 不能拿数组下标当章节号（真书里补章、重导都会打乱顺序）。
 */
function installApi() {
  const book = {
    id: 'book1', title: '验收书', author: '', tags: [], importType: 'txt', status: 'ready',
    createdAt: '', updatedAt: '',
    chapters: [
      { id: 'c2', index: 2, title: '第二章', file: '0002.json', status: 'ready' as const },
      { id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const },
      { id: 'c3', index: 3, title: '第三章', file: '0003.json', status: 'ready' as const },
    ],
    progress: { chapterId: 'c2', chapterIndex: 2, scrollRatio: 0.5, updatedAt: '' },
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
      onChunk: () => () => {}, onStage: () => () => {}, onExternalSources: () => () => {}, onBudget: () => () => {}, onDone: () => () => {},
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
  // 续读停在第2章：等它的正文渲染出来，currentChapter 才是确定的。
  await vi.waitFor(() => expect(document.querySelector('.reader-content')?.textContent).toContain('c2正文。'))
  document.querySelector<HTMLButtonElement>('[aria-label="AI"]')?.click()
  // 单层页签：直接点「记忆」tab。
  await vi.waitFor(() => expect(document.querySelectorAll('.ai-top-switch button').length).toBeGreaterThan(0))
  const tab = [...document.querySelectorAll<HTMLElement>('.ai-top-switch button')]
    .find((item) => item.textContent?.trim() === '记忆')!
  tab.click()
  await nextTick()
  return app
}

afterEach(() => { document.body.innerHTML = '' })

function memoryPanel(): HTMLDetailsElement {
  const panel = document.querySelector<HTMLDetailsElement>('.memory-graph-panel')
  expect(panel, '有关系时才有这块').not.toBeNull()
  return panel!
}

function graphRange(): HTMLInputElement {
  const range = memoryPanel().querySelector<HTMLInputElement>('input[type="range"]')
  expect(range, '进度滑块是切片入口，必须有').not.toBeNull()
  return range!
}

/** 拖动滑块：v-model 听的是 input 事件。 */
async function dragUpto(index: number) {
  const range = graphRange()
  range.value = String(index)
  range.dispatchEvent(new Event('input'))
  await nextTick()
}

describe('Reader 记忆页签的关系图接线', () => {
  it('折叠标题带人数与关系数，默认收起，展开后画出节点', async () => {
    installApi()
    const app = await openMemoryTab()
    try {
      const panel = memoryPanel()
      // 读到第2章：三条关系里第3章那条被切掉，标题也只算切片后的规模 → 「3 人 / 2 条关系」。
      expect(panel.querySelector('summary')?.textContent?.trim()).toBe('人物关系图 · 3 人 / 2 条关系')
      expect(panel.open, '默认该收起，别让一进记忆页就要滚过一张图').toBe(false)
      // 收起时内容也在 DOM 里，但没有展开就看不见；点击 summary 展开后节点出现。
      panel.open = true
      await nextTick()
      expect(panel.querySelectorAll('[data-node-id]')).toHaveLength(3)
    } finally { app.unmount() }
  })

  it('进度滑块默认停在当前章，上界也是当前章', async () => {
    installApi()
    const app = await openMemoryTab()
    try {
      memoryPanel().open = true
      await nextTick()
      const range = graphRange()
      // 上界就是当前章的 index=2（不能往后拉，往后就是剧透），
      // 而章节表里第2章排在第一行、下标是 0——取 index 不能拿下标凑。
      expect([range.min, range.max, range.value]).toEqual(['1', '2', '2'])
      expect(memoryPanel().querySelector('.memory-graph-progress-label')?.textContent?.trim())
        .toBe('只看读到第 2 章为止')
      // 右侧小字是当前章标题。
      expect(memoryPanel().querySelector('.memory-graph-progress-title')?.textContent?.trim()).toBe('第二章')
    } finally { app.unmount() }
  })

  it('往回拖动滑块后图里只剩那个进度之前成立的关系', async () => {
    installApi()
    const app = await openMemoryTab()
    try {
      const panel = memoryPanel()
      panel.open = true
      await nextTick()
      expect(panel.querySelectorAll('[data-node-id]')).toHaveLength(3)

      await dragUpto(1)
      // 第1章只成立「林小满 — 陈七」，苏三这时还没出场。
      expect(panel.querySelectorAll('[data-node-id]')).toHaveLength(2)
      expect(panel.querySelector('[data-node-id="苏三"]')).toBeNull()
      expect(panel.querySelectorAll('.memory-graph-edges line')).toHaveLength(1)
      expect(panel.querySelector('summary')?.textContent?.trim()).toBe('人物关系图 · 2 人 / 1 条关系')
      expect(panel.querySelector('.memory-graph-progress-label')?.textContent?.trim())
        .toBe('只看读到第 1 章为止')
    } finally { app.unmount() }
  })
})
