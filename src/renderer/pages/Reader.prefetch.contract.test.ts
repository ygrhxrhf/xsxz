// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  configurable: true,
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

afterEach(() => { document.body.innerHTML = '' })

const idleQueue: Array<() => void> = []

function installIdle() {
  idleQueue.length = 0
  Object.defineProperty(window, 'requestIdleCallback', {
    configurable: true,
    value: (cb: () => void) => {
      idleQueue.push(cb)
      return idleQueue.length
    },
  })
  Object.defineProperty(window, 'cancelIdleCallback', {
    configurable: true,
    value: () => { idleQueue.length = 0 },
  })
}

async function flushIdle() {
  const jobs = idleQueue.splice(0)
  for (const job of jobs) job()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function installReaderApi() {
  const chapters = [
    { id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const },
    { id: 'c2', index: 2, title: '第二章', file: '0002.json', status: 'ready' as const },
    { id: 'c3', index: 3, title: '第三章', file: '0003.json', status: 'pending' as const },
  ]
  const book = {
    id: 'book-1',
    title: '验收书',
    author: '',
    importType: 'txt' as const,
    createdAt: '',
    updatedAt: '',
    status: 'ready' as const,
    chapters,
    progress: null,
  }
  const reads: string[] = []
  const progress: unknown[] = []
  const forbidden: string[] = []
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      library: {
        get: async () => ({ book }),
        readChapter: async (_bookId: string, chapterId: string) => {
          reads.push(chapterId)
          const chapter = chapters.find((item) => item.id === chapterId)
          return {
            chapter: {
              title: chapter?.title || chapterId,
              body: `正文${chapterId}`,
              status: chapter?.status || 'ready',
            },
          }
        },
        setProgress: async (payload: unknown) => {
          progress.push(payload)
          return { ok: true }
        },
        updateChapterBody: async () => ({ ok: true }),
      },
      settings: {
        get: async () => ({
          reader: {
            fontSize: 18,
            lineHeight: 1.8,
            theme: 'paper',
            fontFamily: 'serif',
            contentWidth: 'medium',
            paragraphSpacing: 'normal',
            paragraphIndent: true,
          },
          tts: { rate: 1, autoNextChapter: true },
          baseUrl: '',
        }),
        set: async () => {
          forbidden.push('settings.set')
          return {}
        },
      },
      annotations: {
        list: async () => ({ ok: true, items: [] }),
        create: async () => { forbidden.push('annotations.create'); return { ok: false } },
      },
      download: {
        onProgress: () => () => {},
        retryFailed: async () => { forbidden.push('download.retryFailed'); return { ok: false } },
      },
      ai: {
        onChunk: () => () => {},
        onStage: () => () => {},
        onBudget: () => () => {},
        onDone: () => () => {},
        clean: async () => { forbidden.push('ai.clean'); return { ok: false } },
      },
    },
  })
  return { reads, progress, forbidden }
}

async function mountReader() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }),
  })
  app.mount(host)
  await nextTick()
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return app
}

describe('Reader adjacent prefetch contract', () => {
  it('wires cache hits, idle neighbors, book change, and rewrite invalidation', async () => {
    const source = await readFile('src/renderer/pages/Reader.vue', 'utf-8')
    expect(source).toContain("import { createChapterPrefetch } from './readerPrefetch'")
    expect(source).toContain('const chapterPrefetch = createChapterPrefetch()')
    expect(source).toContain('chapterPrefetch.onBookChange(bookId)')
    expect(source).toContain('chapterPrefetch.beginNavigation()')
    expect(source).toContain('const cached = chapterPrefetch.get(book.value.id, ch.id)')
    expect(source).toContain('chapterPrefetch.scheduleNeighbors({')
    expect(source).toContain('readChapter: (bookId, chapterId) => window.api.library.readChapter(bookId, chapterId)')
    expect(source).toContain('chapterPrefetch.invalidate(book.value.id, currentChapter.value.id)')
    expect(source).toContain('chapterPrefetch.dispose()')
    const openStart = source.indexOf('async function openChapter')
    const openEnd = source.indexOf('function scrollToRatio', openStart)
    const openBlock = source.slice(openStart, openEnd)
    expect(openBlock).toContain('closeSelectionTools()')
    expect(openBlock).toContain('ttsStop()')
    expect(openBlock).toContain('saveProgress()')
    expect(openBlock.indexOf('closeSelectionTools()')).toBeLessThan(openBlock.indexOf('const cached'))
    expect(openBlock).toContain('cached')
    expect(openBlock).toContain('window.api.library.readChapter(book.value.id, ch.id)')
    expect(openBlock).not.toContain('window.api.library.setProgress')
    expect(openBlock).not.toContain('window.api.settings')
    expect(openBlock).not.toContain('window.api.annotations')
    expect(openBlock).not.toContain('window.api.ai')
    expect(openBlock).not.toContain('window.api.download')
    const scheduleStart = openBlock.indexOf('chapterPrefetch.scheduleNeighbors')
    expect(openBlock.slice(scheduleStart)).not.toContain('setProgress')
  })

  it('uses a cached ready neighbor without a second readChapter and does not prefetch pending or write progress', async () => {
    installIdle()
    const { reads, progress, forbidden } = installReaderApi()
    const app = await mountReader()
    expect(reads).toEqual(['c1'])
    await flushIdle()
    expect(reads).toEqual(['c1', 'c2'])
    expect(progress).toEqual([])
    expect(forbidden).toEqual([])
    document.querySelector<HTMLButtonElement>('.chapter-hotzone.right')?.click()
    await nextTick()
    await nextTick()
    expect(reads).toEqual(['c1', 'c2'])
    await flushIdle()
    expect(reads).toEqual(['c1', 'c2', 'c1'])
    expect(reads).not.toContain('c3')
    expect(forbidden).toEqual([])
    app.unmount()
  })
})
