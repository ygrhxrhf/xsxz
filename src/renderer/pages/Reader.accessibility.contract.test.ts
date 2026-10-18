// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'
import { readerScrollBehavior, resolveReaderKey } from './readerHelpers'

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }), configurable: true })
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

afterEach(() => { document.body.innerHTML = '' })

function installReaderApi() {
  const chapters = [
    { id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const },
  ]
  const book = { id: 'book-1', title: '验收书', author: '', tags: [] as string[], importType: 'txt' as const, createdAt: '', updatedAt: '', status: 'ready' as const, chapters, progress: null }
  Object.defineProperty(window, 'api', { configurable: true, value: {
    library: {
      get: async () => ({ book }),
      readChapter: async () => ({ chapter: { title: '第一章', body: '第一段。\n\n第二段。', status: 'ready' } }),
      setProgress: async () => ({ ok: true }),
    },
    settings: { get: async () => ({ reader: { fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium', paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll' }, tts: { rate: 1, autoNextChapter: true }, baseUrl: '' }), set: async () => ({}) },
    annotations: { list: async () => ({ ok: true, items: [] }) },
    download: { onProgress: () => () => {} },
    ai: { onChunk: () => () => {}, onStage: () => () => {}, onBudget: () => () => {}, onDone: () => () => {}, getMaterialCoverage: async () => ({ ok: true, coverage: null }), getUsage: async () => ({ ok: true, usage: { calls: 0 } }), chapterFinished: async () => ({ ok: false, message: '测试桩：不追剧' }) },
  } })
}

describe('Reader P2.1 accessibility behavior', () => {
  it('keeps ordinary paragraph clicks silent and exposes focusable, named controls', async () => {
    installReaderApi()
    const spoken: string[] = []
    class MockUtterance { rate = 1; lang = ''; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(readonly text: string) {} }
    const speechSynthesis = { cancel() {}, speak: (utterance: MockUtterance) => spoken.push(utterance.text), pause() {}, resume() {} }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: speechSynthesis })
    Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, value: speechSynthesis })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: MockUtterance })
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, value: MockUtterance })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }) })
    app.mount(host)
    await nextTick(); await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    const paragraphs = [...document.querySelectorAll('.reader-content [data-p]')]
    expect(paragraphs).toHaveLength(2)
    paragraphs[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    paragraphs[0].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(spoken).toEqual([])
    const start = paragraphs[1].querySelector<HTMLButtonElement>('.para-tts-start')
    expect(start?.tagName).toBe('BUTTON')
    expect(start?.type).toBe('button')
    expect(start?.getAttribute('aria-label')).toBe('从第 2 段开始朗读')
    start?.focus()
    expect(document.activeElement).toBe(start)
    start?.click()
    await nextTick()
    expect(spoken).toEqual(['第二段。'])
    const shortcuts = document.querySelector<HTMLButtonElement>('[aria-label="快捷键说明"]')
    shortcuts?.click()
    await nextTick()
    expect(document.querySelector('.tool-panel')?.textContent).toContain('Space / Shift+Space，J / K')
    expect(spoken).toEqual(['第二段。'])
    app.unmount()
  })

  it('maps J/K to the existing page actions', async () => {
    expect(resolveReaderKey({ key: 'j' })).toBe('page-down')
    expect(resolveReaderKey({ key: 'K' })).toBe('page-up')
  })
})

describe('Reader P2.4 accessibility wrap-up', () => {
  it('names core toolbar and chapter controls in Chinese', async () => {
    installReaderApi()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }) })
    app.mount(host)
    await nextTick(); await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    const labels = [
      '返回书库',
      '目录',
      '搜索',
      '标记',
      '朗读',
      '背景',
      '字体',
      '快捷键说明',
      '沉浸模式',
      '上一章',
      '下一章',
    ]
    for (const label of labels) {
      expect(document.querySelector(`[aria-label="${label}"]`)).not.toBeNull()
    }
    app.unmount()
  })

  it('lets the shortcut help button take keyboard focus', async () => {
    installReaderApi()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }) })
    app.mount(host)
    await nextTick(); await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    const shortcuts = document.querySelector<HTMLButtonElement>('[aria-label="快捷键说明"]')
    expect(shortcuts?.tagName).toBe('BUTTON')
    shortcuts?.focus()
    expect(document.activeElement).toBe(shortcuts)
    app.unmount()
  })

  it('keeps focus-visible outlines, reduced-motion rails, and toolbar title shrink in source', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    expect(source).toContain(':focus-visible')
    expect(source).toContain('outline: 2px solid var(--r-focus)')
    expect(source).toContain('@media (prefers-reduced-motion: reduce)')
    expect(source).toContain('transition: none !important; animation: none !important; scroll-behavior: auto !important;')
    expect(source).toContain('.reader-toolbar .reader-book-title { min-width: 0; }')
    expect(source).toContain("window.matchMedia?.('(prefers-reduced-motion: reduce)')")
  })

  it('maps reader keys and does not steal them from text fields', () => {
    expect(resolveReaderKey({ key: 'ArrowLeft' })).toBe('prev-chapter')
    expect(resolveReaderKey({ key: 'ArrowRight' })).toBe('next-chapter')
    expect(resolveReaderKey({ key: ' ' })).toBe('page-down')
    expect(resolveReaderKey({ key: ' ', shift: true })).toBe('page-up')
    expect(resolveReaderKey({ key: 'j' })).toBe('page-down')
    expect(resolveReaderKey({ key: 'K' })).toBe('page-up')
    expect(resolveReaderKey({ key: 't' })).toBe('open-catalog')
    expect(resolveReaderKey({ key: 'a' })).toBe('open-appearance')
    expect(resolveReaderKey({ key: 'r' })).toBe('toggle-tts')
    expect(resolveReaderKey({ key: 'Escape' })).toBe('close-drawer')
    expect(resolveReaderKey({ key: ' ', targetTag: 'input' })).toBeNull()
    expect(resolveReaderKey({ key: 'ArrowRight', targetTag: 'textarea' })).toBeNull()
    expect(resolveReaderKey({ key: 't', targetTag: 'input' })).toBeNull()
  })

  it('maps reduced-motion preference to auto scroll', () => {
    expect(readerScrollBehavior(true)).toBe('auto')
    expect(readerScrollBehavior(false)).toBe('smooth')
  })

  it('locks focus-mode copy, dim class, and viewport anchor in source', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    expect(source).toContain('行焦点')
    expect(source).toContain('1 段')
    expect(source).toContain('3 段')
    expect(source).toContain('5 段')
    expect(source).toContain('para-unfocused')
    expect(source).toContain('opacity: 0.4')
    expect(source).toContain('updateViewportFocusAnchor')
    expect(source).toContain('paragraphIndexAtViewportCenter')
    expect(source).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('locks reading-mode copy and wheel paging in source', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    expect(source).toContain('阅读方式')
    expect(source).toContain('连续滚动')
    expect(source).toContain('屏幕翻页')
    expect(source).toContain('onContentWheel')
    expect(source).toContain('wheelPageDirection')
    expect(source).toContain('@wheel="onContentWheel"')
    expect(source).toContain('readingMode.value !== \'screen\'')
    expect(source).toContain('el.clientHeight * 0.9')
    expect(source).toContain('readerScrollBehavior')
  })

  it('locks the eye-care dim overlay and its z-order in source', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    expect(source).toContain('屏幕压暗')
    expect(source).toContain('class="reader-dim"')
    expect(source).toContain(':style="{ opacity: dim / 100 }"')
    // 遮罩只压暗正文：z-index 必须高于正文(0)、低于翻章热区(18)与页码(26)，且不吞点击。
    expect(source).toContain('.reader-dim {')
    expect(source).toContain('z-index: 15;')
    expect(source).toContain('pointer-events: none;')
  })

  it('makes resuming to the last position visible in source', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    expect(source).toContain('已回到上次读到')
    expect(source).toContain('resumeRatio > 0.02')
  })
})
