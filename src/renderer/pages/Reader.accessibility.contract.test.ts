// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }), configurable: true })

afterEach(() => { document.body.innerHTML = '' })

function installReaderApi() {
  const chapters = [
    { id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const },
  ]
  const book = { id: 'book-1', title: '验收书', author: '', importType: 'txt' as const, createdAt: '', updatedAt: '', status: 'ready' as const, chapters, progress: null }
  Object.defineProperty(window, 'api', { configurable: true, value: {
    library: {
      get: async () => ({ book }),
      readChapter: async () => ({ chapter: { title: '第一章', body: '第一段。\n\n第二段。', status: 'ready' } }),
      setProgress: async () => ({ ok: true }),
    },
    settings: { get: async () => ({ reader: { fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium', paragraphSpacing: 'normal', paragraphIndent: true }, tts: { rate: 1, autoNextChapter: true }, baseUrl: '' }), set: async () => ({}) },
    annotations: { list: async () => ({ ok: true, items: [] }) },
    download: { onProgress: () => () => {} },
    ai: { onChunk: () => () => {}, onStage: () => () => {}, onBudget: () => () => {}, onDone: () => () => {} },
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
    expect(spoken).toEqual([])
    const start = paragraphs[1].querySelector<HTMLButtonElement>('.para-tts-start')
    expect(start?.getAttribute('aria-label')).toBe('从第 2 段开始朗读')
    start?.focus()
    expect(document.activeElement).toBe(start)
    const shortcuts = document.querySelector<HTMLButtonElement>('[aria-label="快捷键说明"]')
    shortcuts?.click()
    await nextTick()
    expect(document.querySelector('.tool-panel')?.textContent).toContain('Space / Shift+Space，J / K')
    expect(spoken).toEqual([])
    app.unmount()
  })

  it('maps J/K to the existing page actions', async () => {
    const source = await import('./readerHelpers')
    expect(source.resolveReaderKey({ key: 'j' })).toBe('page-down')
    expect(source.resolveReaderKey({ key: 'K' })).toBe('page-up')
  })
})
