// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('Reader listening flow', () => {
  it('loads the next ready chapter and keeps speaking', async () => {
    const utterances: Array<{ text: string; onend: (() => void) | null }> = []
    class Utterance {
      onend: (() => void) | null = null
      onerror = null
      rate = 1
      lang = ''
      constructor(readonly text: string) {}
    }
    const synthesis = { cancel() {}, pause() {}, resume() {}, getVoices: () => [], speak: (u: Utterance) => utterances.push(u) }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synthesis })
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
    const chapters = [
      { id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const },
      { id: 'c2', index: 2, title: '第二章', file: '0002.json', status: 'ready' as const },
    ]
    const book = { id: 'book1', title: '验收书', author: '', tags: [], importType: 'txt', status: 'ready', createdAt: '', updatedAt: '', chapters, progress: null }
    Object.defineProperty(window, 'api', { configurable: true, value: {
      library: { get: async () => ({ book }), readChapter: async (_bookId: string, id: string) => ({ chapter: { title: id, status: 'ready', body: id === 'c1' ? '第一章正文。' : '第二章正文。' } }), setProgress: async () => ({ ok: true }) },
      tts: { getPosition: async () => null, setPosition: async () => ({ ok: true }), cancel: async () => ({ ok: true }), synthesize: async () => new Uint8Array() },
      settings: { get: async () => ({ reader: { fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium', paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll' }, tts: { rate: 1, autoNextChapter: true, source: 'system' }, baseUrl: '', libraryPath: '' }), set: async () => ({}) },
      annotations: { list: async () => ({ ok: true, items: [] }) },
      download: { onProgress: () => () => {} },
      ai: { onChunk: () => () => {}, onStage: () => () => {}, onBudget: () => () => {}, onDone: () => () => {}, getMaterialCoverage: async () => ({ ok: true, coverage: null }), getUsage: async () => ({ ok: true, usage: { calls: 0 } }), chapterFinished: async () => ({ ok: false, message: '测试桩：不追剧' }) },
    } })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book1' }) }) })
    app.mount(host)
    try {
      await vi.waitFor(() => expect(document.querySelector('.reader-content')?.textContent).toContain('第一章正文。'))
      document.querySelector<HTMLButtonElement>('[aria-label="朗读"]')?.click()
      await nextTick()
      const button = [...document.querySelectorAll<HTMLButtonElement>('.tool-panel button')]
        .find((item) => item.textContent?.includes('从本章开头播放'))
      button?.click()
      expect(utterances[0]?.text).toBe('第一章正文。')
      utterances[0]?.onend?.()
      await vi.waitFor(() => expect(utterances[1]?.text).toBe('第二章正文。'))
    } finally { app.unmount() }
  })
})
