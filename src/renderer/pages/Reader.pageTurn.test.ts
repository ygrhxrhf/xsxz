// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })
// jsdom 的 Range 没有几何信息，选区工具条定位需要 getBoundingClientRect
Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
  value: () => ({ top: 120, left: 40, bottom: 140, right: 200, width: 160, height: 20, x: 40, y: 120 }),
  configurable: true,
})

const bodies: Record<string, string> = {
  c1: '第一章正文。第一章正文。',
  c2: '第二章正文。第二章正文。',
}

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

function installApi() {
  Object.defineProperty(window, 'api', { configurable: true, value: {
    library: {
      get: async () => ({ book: newBook() }),
      readChapter: async (_bookId: string, id: string) => ({ chapter: { title: id, status: 'ready', body: bodies[id] } }),
      setProgress: async () => ({ ok: true }),
    },
    tts: { getPosition: async () => null, setPosition: async () => ({ ok: true }), cancel: async () => ({ ok: true }), synthesize: async () => new Uint8Array() },
    settings: {
      get: async () => ({
        reader: {
          fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
          paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll', bookView: 'classic',
        },
        tts: { rate: 1, autoNextChapter: false, source: 'system' }, baseUrl: '', libraryPath: '',
      }),
      set: async () => ({}),
    },
    annotations: { list: async () => ({ ok: true, items: [] }) },
    download: { onProgress: () => () => {} },
    ai: {
      onChunk: () => () => {}, onStage: () => () => {}, onExternalSources: () => () => {}, onBudget: () => () => {}, onDone: () => () => {},
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
  return { app, pane: document.querySelector<HTMLElement>('.reader-content')! }
}

/** 点正文右侧三分之一：翻下一页。翻页没有按钮了，靠点按分区。 */
function clickRightZone(pane: HTMLElement) {
  Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 300 })
  pane.getBoundingClientRect = () => ({ left: 0, width: 300 } as DOMRect)
  pane.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 250 }))
}

afterEach(() => {
  // 选区是全局的：残留的选区会让后续用例的「点纸面翻页」全部失灵（选字时本就不该翻页）。
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/** 段落里最长的那个文本节点：段落可能被 <mark> 拆成多段，不能拿 firstChild。 */
function longestTextNode(el: HTMLElement): Text {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let best: Text | null = null
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (!best || node.textContent!.length > best.textContent!.length) best = node
  }
  return best!
}

describe('Reader 章末翻页', () => {
  it('章末点右侧不换章：换章走章末的「下一章」卡片', async () => {
    installApi()
    const reader = await mountReader()
    try {
      // 内容不足一屏：scrollHeight 与 clientHeight 相等，滚动条已经在底
      Object.defineProperty(reader.pane, 'scrollHeight', { configurable: true, value: 500 })
      Object.defineProperty(reader.pane, 'clientHeight', { configurable: true, value: 500 })
      Object.defineProperty(reader.pane, 'scrollTop', { configurable: true, writable: true, value: 0 })

      clickRightZone(reader.pane)
      await nextTick()
      // 章末点按停在本章：翻页按钮去掉后也不该把读者一下甩到下一章。
      expect(reader.pane.textContent).toContain('第一章正文。')
      expect(reader.pane.textContent).not.toContain('第二章正文。')

      const endCard = reader.pane.querySelector<HTMLButtonElement>('.chapter-end-card')
      expect(endCard?.textContent).toContain('第二章')
      endCard?.click()
      await vi.waitFor(() => expect(reader.pane.textContent).toContain('第二章正文。'))
    } finally { reader.app.unmount() }
  })

  it('经典模式：拖选文字后松手不翻页', async () => {
    installApi()
    const reader = await mountReader()
    try {
      const scrollBy = vi.fn()
      Object.defineProperty(reader.pane, 'scrollBy', { configurable: true, value: scrollBy })
      Object.defineProperty(reader.pane, 'scrollHeight', { configurable: true, value: 2000 })
      Object.defineProperty(reader.pane, 'clientHeight', { configurable: true, value: 500 })
      Object.defineProperty(reader.pane, 'scrollTop', { configurable: true, writable: true, value: 0 })
      Object.defineProperty(reader.pane, 'clientWidth', { configurable: true, value: 300 })
      reader.pane.getBoundingClientRect = () => ({ left: 0, width: 300 } as DOMRect)

      // 拖选：选区在松手那一刻已确定且非折叠。
      const para = reader.pane.querySelector<HTMLElement>('.para')!
      const text = longestTextNode(para)
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, Math.min(3, text.textContent!.length))
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      expect(selection.isCollapsed).toBe(false)

      // 松手落在右区（会翻页的位置）：选字的那一下不能翻页。
      para.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 250 }))
      // 选区工具条是在 setTimeout(0) 里读的选区，等它落地。
      await new Promise((resolve) => setTimeout(resolve, 0))
      await nextTick()

      expect(scrollBy).not.toHaveBeenCalled()
      // 选区工具条照常出现：这一下仍然是「选字」，不是「翻页」。
      expect(document.querySelector('.sel-popup')).not.toBeNull()
    } finally { reader.app.unmount() }
  })

  it('还有没滚完的正文时，「下一页」留在本章继续往下翻', async () => {
    installApi()
    const reader = await mountReader()
    try {
      Object.defineProperty(reader.pane, 'scrollHeight', { configurable: true, value: 2000 })
      Object.defineProperty(reader.pane, 'clientHeight', { configurable: true, value: 500 })
      Object.defineProperty(reader.pane, 'scrollTop', { configurable: true, writable: true, value: 0 })
      const scrollBy = vi.fn()
      Object.defineProperty(reader.pane, 'scrollBy', { configurable: true, value: scrollBy })

      clickRightZone(reader.pane)
      await nextTick()
      expect(scrollBy).toHaveBeenCalled()
      expect(reader.pane.textContent).toContain('第一章正文。')
      expect(reader.pane.textContent).not.toContain('第二章正文。')
    } finally { reader.app.unmount() }
  })
})
