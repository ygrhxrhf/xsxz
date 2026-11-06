// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'

/**
 * 章节抽屉的「导图」入口只在真挂载时才能验证：抽屉是 teleport 的，节点点击又要
 * 真的派发到 SVG 节点上。这里钉住两件事——入口把导图渲染出来，以及节点跳转在
 * 两种阅读模式下走的是不同落点（经典滚动锚点 / 真实书籍页锚点）。
 */
class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  configurable: true,
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

afterEach(() => { document.body.innerHTML = '' })

const CLASSIC_BODY = Array.from({ length: 12 }, (_, i) => `第${i + 1}段第一句。第二句！`).join('\n\n')
const REAL_BOOK_BODY = Array.from({ length: 40 }, (_, i) => `第${i + 1}段第一句。`).join('\n\n')
/** 超过 Reader 的 LARGE_CHAPTER_PARAS（2000）：导图应默认只展开到段落层。 */
const LARGE_CHAPTER_BODY = Array.from({ length: 2001 }, (_, i) => `第${i + 1}段第一句。`).join('\n\n')

type BookView = 'classic' | 'realbook'

function installReaderApi(bookView: BookView, body: string) {
  const chapters = [{ id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const }]
  const book = {
    id: 'book-1', title: '导图书', author: '', tags: [] as string[], importType: 'txt' as const,
    createdAt: '', updatedAt: '', status: 'ready' as const, chapters, progress: null,
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      library: {
        get: async () => ({ book }),
        readChapter: async () => ({ chapter: { title: '第一章', body, status: 'ready' } }),
        setProgress: async () => ({ ok: true }),
      },
      settings: {
        get: async () => ({
          reader: {
            fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
            paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll',
            bookView,
          },
          tts: { rate: 1, autoNextChapter: true }, baseUrl: '',
        }),
        set: async () => ({}),
      },
      annotations: {
        list: async () => ({ ok: true, items: [] }),
        add: async () => ({ ok: false, message: '测试桩：不新增' }),
        update: async () => ({ ok: false, message: '测试桩：不更新' }),
        remove: async () => ({ ok: true }),
      },
      download: { onProgress: () => () => {} },
      ai: {
        onChunk: () => () => {}, onStage: () => () => {}, onBudget: () => () => {}, onDone: () => () => {},
        getMaterialCoverage: async () => ({ ok: true, coverage: null }),
        getUsage: async () => ({ ok: true, usage: { calls: 0 } }),
        chapterFinished: async () => ({ ok: false, message: '测试桩：不追剧' }),
      },
    },
  })
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function mountReader() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }) })
  app.mount(host)
  await nextTick(); await nextTick(); await flush()
  return app
}

async function openMindmapTab() {
  document.querySelector<HTMLElement>('.bottom-button[aria-label="目录"]')?.click()
  await nextTick(); await flush()
  const tab = document.querySelector<HTMLElement>('[data-drawer-tab="mindmap"]')
  expect(tab).not.toBeNull()
  expect(tab?.getAttribute('aria-selected')).toBe('false')
  tab?.click()
  await nextTick(); await flush()
  expect(document.querySelector('[data-drawer-tab="mindmap"]')?.getAttribute('aria-selected')).toBe('true')
}

function mindmapNode(nodeId: string): Element | undefined {
  return document.querySelector<SVGElement>(`[data-node-id="${nodeId}"]`) ?? undefined
}

function clickNode(nodeId: string): void {
  mindmapNode(nodeId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/** 落点在 requestAnimationFrame 里执行；负载高时一帧会晚到，轮询到目标值再断言。 */
async function scrollTopEventually(expected: number, timeoutMs = 3000): Promise<number> {
  const started = Date.now()
  for (;;) {
    const value = document.querySelector<HTMLElement>('.reader-content')?.scrollTop ?? 0
    if (value === expected || Date.now() - started >= timeoutMs) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('Reader 章节抽屉的导图入口', () => {
  it('目录抽屉里有「导图」视图，切换后渲染本章导图', async () => {
    installReaderApi('classic', CLASSIC_BODY)
    const app = await mountReader()

    await openMindmapTab()

    expect(document.querySelector('.reader-mindmap')).not.toBeNull()
    // 章节标题与段落都进了树：根节点 + 12 个段落节点。
    expect(mindmapNode('root')?.getAttribute('aria-label')).toContain('第一章')
    expect(mindmapNode('p11')).not.toBeUndefined()
    expect(document.querySelector('.reader-mindmap-count')?.textContent).toBeTruthy()
    app.unmount()
  })

  it('经典模式：点击句组节点滚到段内锚点', async () => {
    installReaderApi('classic', CLASSIC_BODY)
    const app = await mountReader()
    await openMindmapTab()

    // jsdom 没有排版：把 Range 的矩形固定住，跳转后的 scrollTop 才能反映锚点落点。
    const rect = { top: 300, bottom: 320, left: 0, right: 0, width: 0, height: 20, x: 0, y: 300, toJSON: () => ({}) }
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })

    clickNode('p5-s1')
    expect(await scrollTopEventually(296)).toBe(296)
    delete (Range.prototype as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect
    app.unmount()
  })

  it('只有一段正文时「导图」入口照常显示，并渲染出根节点、段落与句组', async () => {
    installReaderApi('classic', '只有一段。没有换行。')
    const app = await mountReader()

    await openMindmapTab()

    expect(mindmapNode('root')?.getAttribute('aria-label')).toContain('第一章')
    expect(mindmapNode('p0')).not.toBeUndefined()
    expect(mindmapNode('p0-s1')).not.toBeUndefined()
    // root + p0 + 两个句组：单段章不是空态。
    expect(document.querySelector('.reader-mindmap-count')?.textContent).toContain('4')
    expect(document.querySelector('.reader-mindmap-empty')).toBeNull()

    // 单段章同样能走锚点跳转：段内第二个句组的偏移是 5。
    const rect = { top: 300, bottom: 320, left: 0, right: 0, width: 0, height: 20, x: 0, y: 300, toJSON: () => ({}) }
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })
    clickNode('p0-s1')
    expect(await scrollTopEventually(296)).toBe(296)
    delete (Range.prototype as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect
    app.unmount()
  })

  it('只有两段正文时导图按两段分叉，不出现空态', async () => {
    installReaderApi('classic', '第一段。第二句！\n\n第二段只有一句。')
    const app = await mountReader()

    await openMindmapTab()

    // root + p0（两个句组）+ p1（一个句组）= 6 个可见节点。
    expect(document.querySelector('.reader-mindmap-count')?.textContent).toContain('6')
    expect(mindmapNode('p0-s1')).not.toBeUndefined()
    expect(mindmapNode('p1-s0')).not.toBeUndefined()
    expect(document.querySelectorAll('[data-node-id^="p1-"]')).toHaveLength(1)
    expect(document.querySelector('.reader-mindmap-empty')).toBeNull()
    app.unmount()
  })

  it('超长章默认只展开到段落层，展开后仍能跳到该段的锚点', async () => {
    installReaderApi('classic', LARGE_CHAPTER_BODY)
    const app = await mountReader()
    await openMindmapTab()

    // 2001 段 + 根：默认展开只到段落层，句组节点一个都不落地。
    expect(document.querySelector('.reader-mindmap-count')?.textContent).toContain('2002')
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(2002)
    expect(mindmapNode('p0')).not.toBeUndefined()
    expect(mindmapNode('p0-s0')).toBeUndefined()
    expect(mindmapNode('p0')?.getAttribute('aria-label')).toContain('已折叠')

    // 展开末尾段落：句组落地后才能作为跳转目标。
    clickNode('p1999')
    await nextTick()
    expect(mindmapNode('p1999-s0')).not.toBeUndefined()

    const rect = { top: 300, bottom: 320, left: 0, right: 0, width: 0, height: 20, x: 0, y: 300, toJSON: () => ({}) }
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })
    clickNode('p1999-s0')
    // 大章节跳转要先迁渲染窗口再把锚点滚到视口顶。
    expect(await scrollTopEventually(296)).toBe(296)

    // 目标段已迁进 DOM，滚动落点来自节点锚点。
    expect(document.querySelector('.reader-content [data-p="1999"]')).not.toBeNull()
    delete (Range.prototype as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect
    app.unmount()
  })

  it('真实书籍模式：点击句组节点落在对应的真实页', async () => {
    installReaderApi('realbook', REAL_BOOK_BODY)
    const app = await mountReader()
    expect(document.querySelector('.real-book-stage')).not.toBeNull()

    await openMindmapTab()
    clickNode('p30-s0')
    await nextTick(); await flush(); await nextTick()

    const label = document.querySelector('.real-book-page-label')?.textContent ?? ''
    const page = Number(label.match(/第 (\d+)/)?.[1] ?? '1')
    expect(page).toBeGreaterThan(1)
    app.unmount()
  })

  it('真实书籍模式：超长章展开后的句组节点翻到对应页', async () => {
    installReaderApi('realbook', LARGE_CHAPTER_BODY)
    const app = await mountReader()
    expect(document.querySelector('.real-book-stage')).not.toBeNull()

    await openMindmapTab()
    // 超长章默认只到段落层，先展开末尾段落才能拿到可点击的句组。
    clickNode('p1999')
    await nextTick()
    expect(mindmapNode('p1999-s0')).not.toBeUndefined()

    clickNode('p1999-s0')
    // 书台要先惰性排到第 1999 段再查页，页表很长；等它落定。
    await new Promise((resolve) => setTimeout(resolve, 120))
    await nextTick(); await flush(); await nextTick()

    const label = document.querySelector('.real-book-page-label')?.textContent ?? ''
    const page = Number(label.match(/第 (\d+)/)?.[1] ?? '1')
    expect(page).toBeGreaterThan(1)
    // 目标段真的出现在摊开的书页里，而不只是页码变了。
    expect(document.querySelector('.real-book-stage [data-p="1999"]')).not.toBeNull()
    app.unmount()
  })
})
