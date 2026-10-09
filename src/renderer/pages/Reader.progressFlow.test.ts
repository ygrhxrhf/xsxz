// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

function newBook() {
  return {
    id: 'book1', title: '验收书', author: '', tags: [], importType: 'txt', status: 'ready',
    createdAt: '', updatedAt: '',
    chapters: [
      { id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const },
      { id: 'c2', index: 2, title: '第二章', file: '0002.json', status: 'ready' as const },
    ],
    progress: null,
  }
}
const bodies: Record<string, string> = {
  c1: '第一章正文。第一章正文。',
  c2: '第二章正文。第二章正文。',
}

function installApi(book: unknown, setProgress: (bookId: string, progress: never) => Promise<unknown>) {
  Object.defineProperty(window, 'api', { configurable: true, value: {
    library: {
      get: async () => ({ book: JSON.parse(JSON.stringify(book)) }),
      readChapter: async (_bookId: string, id: string) => ({ chapter: { title: id, status: 'ready', body: bodies[id] } }),
      setProgress,
    },
    tts: { getPosition: async () => null, setPosition: async () => ({ ok: true }), cancel: async () => ({ ok: true }), synthesize: async () => new Uint8Array() },
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
    annotations: { list: async () => ({ ok: true, items: [] }) },
    download: { onProgress: () => () => {} },
    ai: {
      onChunk: () => () => {}, onStage: () => () => {}, onBudget: () => () => {}, onDone: () => () => {},
      getMaterialCoverage: async () => ({ ok: true, coverage: null }),
      getUsage: async () => ({ ok: true, usage: { calls: 0, inputTokens: 0, outputTokens: 0 } }),
      chapterFinished: async () => ({ ok: false, message: '测试桩：不追剧' }),
      followSet: async () => ({ ok: false, message: '测试桩：不追剧' }),
      followRetry: async () => ({ ok: false, message: '测试桩：不追剧' }),
    },
  } })
}

async function mountReader() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book1' }) }) })
  app.mount(host)
  await vi.waitFor(() => expect(document.querySelector('.reader-content')?.textContent).toContain('第一章正文。'))
  await nextTick()
  return {
    app,
    goNextChapter() { document.querySelector<HTMLButtonElement>('[aria-label="下一章"]')?.click() },
    pane: document.querySelector<HTMLElement>('.reader-content')!,
  }
}

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('Reader 阅读进度落盘', () => {
  it('换章写的是要走那一章的位置，新章位置只来自新章自己的滚动', async () => {
    const writes: Array<{ chapterId: string; scrollRatio: number }> = []
    installApi(newBook(), async (_bookId, progress) => {
      const p = progress as unknown as { chapterId: string; scrollRatio: number }
      writes.push({ chapterId: p.chapterId, scrollRatio: p.scrollRatio })
      return { ok: true }
    })
    const reader = await mountReader()
    try {
      Object.defineProperty(reader.pane, 'scrollHeight', { configurable: true, value: 2000 })
      Object.defineProperty(reader.pane, 'clientHeight', { configurable: true, value: 500 })
      Object.defineProperty(reader.pane, 'scrollTop', { configurable: true, writable: true, value: 750 })

      // 滚到本章一半后立刻换章：位置必须在滚动那一刻锁死
      reader.pane.dispatchEvent(new Event('scroll'))
      await nextTick()
      reader.goNextChapter()
      await vi.waitFor(() => expect(reader.pane.textContent).toContain('第二章正文。'))
      await new Promise((resolve) => setTimeout(resolve, 1400))

      expect(writes.some((w) => w.chapterId === 'c1' && w.scrollRatio === 0.5)).toBe(true)
      expect(writes.filter((w) => w.chapterId === 'c2').every((w) => w.scrollRatio === 0)).toBe(true)
    } finally { reader.app.unmount() }
  })

  it('进度被主进程拒绝时提示出来，不假装保存成功', async () => {
    installApi(newBook(), async () => ({ ok: false, message: '书库正在恢复，请稍后再试' }))
    const reader = await mountReader()
    try {
      reader.goNextChapter()
      await vi.waitFor(() => expect(document.body.textContent).toContain('阅读进度保存失败'))
    } finally { reader.app.unmount() }
  })
})
