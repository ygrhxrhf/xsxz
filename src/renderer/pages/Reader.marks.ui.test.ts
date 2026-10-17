// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'

/**
 * 模板与 readerMarks.ts 的接线是 `tsc` 看不出来的（typecheck 不检查 .vue 模板），
 * 这里真挂载一次，靠界面把这条线钉住：标记抽屉能列出书签/划线并显示备注。
 */
class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  configurable: true,
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

afterEach(() => { document.body.innerHTML = '' })

const ANNOTATIONS = [
  {
    id: 'a1', bookId: 'book-1', chapterId: 'c1', kind: 'highlight' as const,
    start: 0, end: 3, excerpt: '第一段', note: '记一笔', noteSource: 'user' as const,
    createdAt: '2026-10-16T00:00:00.000Z',
  },
  {
    id: 'b1', bookId: 'book-1', chapterId: 'c1', kind: 'bookmark' as const,
    start: 0, end: 0, excerpt: '', createdAt: '2026-10-16T00:00:01.000Z',
  },
]

function installReaderApi(items = ANNOTATIONS) {
  const chapters = [{ id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const }]
  const book = {
    id: 'book-1', title: '标记书', author: '', tags: [] as string[], importType: 'txt' as const,
    createdAt: '', updatedAt: '', status: 'ready' as const, chapters, progress: null,
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      library: {
        get: async () => ({ book }),
        readChapter: async () => ({ chapter: { title: '第一章', body: '第一段。\n\n第二段。', status: 'ready' } }),
        setProgress: async () => ({ ok: true }),
      },
      settings: {
        get: async () => ({
          reader: {
            fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
            paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll',
          },
          tts: { rate: 1, autoNextChapter: true }, baseUrl: '',
        }),
        set: async () => ({}),
      },
      annotations: {
        list: async () => ({ ok: true, items }),
        add: async () => ({ ok: false, message: '测试桩：不新增' }),
        update: async () => ({ ok: true, item: items[0] }),
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

async function mountReader() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }) })
  app.mount(host)
  await nextTick(); await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
  return app
}

describe('Reader 标记面板（模板 ↔ readerMarks 接线）', () => {
  it('打开标记抽屉后列出本章书签与划线，并带上备注', async () => {
    installReaderApi()
    const app = await mountReader()

    const marksButton = document.querySelector<HTMLElement>('[title="标记"]')
    expect(marksButton, '顶栏应有标记入口').toBeTruthy()
    marksButton?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    const rows = [...document.querySelectorAll('.mark-row')]
    expect(rows).toHaveLength(2)
    const texts = rows.map((row) => row.textContent ?? '')
    // 划线那行带摘录与备注；书签那行不带摘录
    expect(texts.some((text) => text.includes('第一段') && text.includes('记一笔'))).toBe(true)
    expect(texts.some((text) => !text.includes('第一段'))).toBe(true)
    app.unmount()
  })

  it('没有标记时抽屉给空态，不是空白', async () => {
    installReaderApi([])
    const app = await mountReader()

    document.querySelector<HTMLElement>('[title="标记"]')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelectorAll('.mark-row')).toHaveLength(0)
    expect(document.querySelector('.n-drawer')?.textContent ?? '').not.toBe('')
    app.unmount()
  })
})
