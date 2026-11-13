// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'
import type { Annotation } from '@shared/types'

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

function installReaderApi(
  items: Annotation[] = ANNOTATIONS,
  initialBookView: 'classic' | 'realbook' = 'classic',
  handwritingFont: 'none' | 'kai' | 'xingshu' = 'none',
) {
  const updateCalls: Array<{ bookId: string; annotationId: string; patch: Partial<Annotation> }> = []
  const settingsWrites: unknown[] = []
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
            bookView: initialBookView, handwritingFont,
          },
          tts: { rate: 1, autoNextChapter: true }, baseUrl: '',
        }),
        set: async (patch: unknown) => { settingsWrites.push(patch); return {} },
      },
      annotations: {
        list: async () => ({ ok: true, items }),
        add: async () => ({ ok: false, message: '测试桩：不新增' }),
        update: async (bookId: string, annotationId: string, patch: Partial<Annotation>) => {
          updateCalls.push({ bookId, annotationId, patch })
          const base = items.find((item) => item.id === annotationId) ?? items[0]!
          return { ok: true, item: { ...base, ...patch } }
        },
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
  return { updateCalls, settingsWrites }
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

  it('有标签时按 #tag 分组，未分类排最后，多标签标记在各分组重复出现', async () => {
    installReaderApi([
      {
        id: 't1', bookId: 'book-1', chapterId: 'c1', kind: 'highlight',
        start: 0, end: 3, excerpt: '第一段', note: '记一笔', tags: ['quote'],
        createdAt: '2026-10-16T00:00:00.000Z',
      },
      {
        id: 't2', bookId: 'book-1', chapterId: 'c1', kind: 'highlight',
        start: 4, end: 7, excerpt: '第二段', tags: ['scene', 'quote'],
        createdAt: '2026-10-16T00:00:01.000Z',
      },
      {
        id: 'b1', bookId: 'book-1', chapterId: 'c1', kind: 'bookmark',
        start: 0, end: 0, excerpt: '', createdAt: '2026-10-16T00:00:02.000Z',
      },
    ])
    const app = await mountReader()

    document.querySelector<HTMLElement>('[title="标记"]')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    const groups = [...document.querySelectorAll<HTMLElement>('.mark-group')]
    expect(groups).toHaveLength(3)
    const titles = groups.map((group) => group.querySelector('.mark-group-title')?.textContent ?? '')
    expect(titles[0]).toContain('#quote')
    expect(titles[1]).toContain('#scene')
    expect(titles[2]).toContain('未分类')
    // 多标签那条在 #quote 与 #scene 各出现一次；书签没有标签，只落在未分类
    expect(groups[0]?.querySelectorAll('.mark-row')).toHaveLength(2)
    expect(groups[1]?.querySelectorAll('.mark-row')).toHaveLength(1)
    expect(groups[2]?.querySelectorAll('.mark-row')).toHaveLength(1)
    app.unmount()
  })

  it('全部标记都没有标签时不显示分组标题，保持平铺列表', async () => {
    installReaderApi()
    const app = await mountReader()

    document.querySelector<HTMLElement>('[title="标记"]')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelectorAll('.mark-group')).toHaveLength(1)
    expect(document.querySelector('.mark-group-title')).toBeNull()
    expect(document.querySelectorAll('.mark-row')).toHaveLength(2)
    app.unmount()
  })

  it('划线卡片提供颜色选择器，选择后按 update 落盘并反映选中态', async () => {
    const { updateCalls } = installReaderApi()
    const app = await mountReader()

    document.querySelector<HTMLElement>('[title="标记"]')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    const swatches = [...document.querySelectorAll<HTMLElement>('.mark-color-option')]
    expect(swatches.map((el) => el.dataset.color)).toEqual(['yellow', 'green', 'blue', 'red', 'purple'])
    // 旧标记没有 color 字段，按默认黄色呈现选中态
    expect(swatches[0]?.getAttribute('aria-pressed')).toBe('true')

    swatches[1]?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    expect(updateCalls).toEqual([{ bookId: 'book-1', annotationId: 'a1', patch: { color: 'green' } }])
    expect(document.querySelector('.mark-color-option[data-color="green"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.mark-color-option[data-color="yellow"]')?.getAttribute('aria-pressed')).toBe('false')
    app.unmount()
  })

  it('手写体偏好只改变标记抽屉批注预览字体，不影响正文', async () => {
    installReaderApi([
      {
        id: 'note-kai', bookId: 'book-1', chapterId: 'c1', kind: 'highlight',
        start: 0, end: 3, excerpt: '第一段', note: '楷体批注',
        createdAt: '2026-10-16T00:00:00.000Z',
      },
    ], 'classic', 'kai')
    const app = await mountReader()

    document.querySelector<HTMLElement>('.bottom-button[aria-label="字体"]')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    document.querySelector<HTMLElement>('[aria-label="批注手写体"] button:nth-child(2)')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    document.querySelector<HTMLElement>('[title="标记"]')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    const note = document.querySelector<HTMLElement>('.mark-note')
    expect(note?.textContent).toContain('楷体批注')
    expect(note?.classList.contains('handwriting-kai')).toBe(true)
    // 正文段落不因批注字体偏好获得手写体 class；批注卡按偏好单独套用。
    expect(document.querySelector('.reader-content .para.handwriting-kai')).toBeNull()
    expect(document.querySelector('.reader-content .classic-inline-note.handwriting-kai')).not.toBeNull()
    app.unmount()
  })

  it('书签没有颜色选择器（书签不渲染底色）', async () => {
    installReaderApi([
      {
        id: 'b1', bookId: 'book-1', chapterId: 'c1', kind: 'bookmark',
        start: 0, end: 0, excerpt: '', createdAt: '2026-10-16T00:00:00.000Z',
      },
    ])
    const app = await mountReader()

    document.querySelector<HTMLElement>('[title="标记"]')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelectorAll('.mark-row')).toHaveLength(1)
    expect(document.querySelectorAll('.mark-color-option')).toHaveLength(0)
    app.unmount()
  })
})
