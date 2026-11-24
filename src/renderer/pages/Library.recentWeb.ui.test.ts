// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import LibraryPage from './Library.vue'
import type { BookListItem, Settings, WebShelfBook } from '../../shared/types'
import { DEFAULT_AI_PREFS, DEFAULT_APPEARANCE_PREFS, DEFAULT_READER_PREFS, DEFAULT_TTS_PREFS } from '../../shared/types'

/**
 * 网页书在书架里的接线：加入书架后书名不是章名、简介能显示、
 * 而且「最近在读」和书库书一起参与排序并走 open-web-book 打开。
 * 这些是模板与脚本之间的连线，tsc 看不出来，所以真挂载一次。
 */

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  configurable: true,
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

const webBook: WebShelfBook = {
  id: 'site-1',
  host: 'example.com',
  title: '万古神帝',
  author: '飞天鱼',
  coverUrl: undefined,
  description: '前世惨死，今生重来，少年从山谷里一步步走回那座城。',
  catalogUrl: 'https://example.com/book/65/',
  lastChapter: { title: '第 12 章 起风', url: 'https://example.com/book/65/c12.html' },
  chapters: [
    { title: '第 11 章 出谷', url: 'https://example.com/book/65/c11.html' },
    { title: '第 12 章 起风', url: 'https://example.com/book/65/c12.html' },
  ],
  chaptersFetchedAt: '2026-11-20T10:00:00.000Z',
  addedChapters: 0,
  lastRefreshedAt: '',
  progress: { paragraphIndex: 12, scrollRatio: 0.4, updatedAt: '2026-11-24T08:00:00.000Z' },
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-24T08:00:00.000Z',
}

const localBook: BookListItem = {
  id: 'book-1',
  title: '书库里的旧书',
  author: '某作者',
  tags: [],
  importType: 'txt',
  status: 'ready',
  chapterCount: 20,
  readyCount: 20,
  progress: { chapterId: 'c3', paragraphIndex: 0, scrollRatio: 0.2, updatedAt: '2026-11-20T08:00:00.000Z' },
  updatedAt: '2026-11-20T08:00:00.000Z',
}

function settings(): Settings {
  return {
    libraryPath: '/tmp/library',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyConfigured: true,
    tierSenseKeyConfigured: false,
    reader: DEFAULT_READER_PREFS,
    tts: DEFAULT_TTS_PREFS,
    appearance: DEFAULT_APPEARANCE_PREFS,
    ai: { ...DEFAULT_AI_PREFS },
  }
}

function installApi(): void {
  const unsubscribe = (): void => {}
  ;(window as unknown as { api: unknown }).api = {
    library: { list: async () => ({ books: [localBook] }) },
    settings: { get: async () => settings(), set: async () => ({ ok: true }) },
    shelf: {
      list: async () => ({ ok: true, books: [webBook] }),
      onChanged: () => unsubscribe,
      refresh: async () => ({ ok: true, added: 0, book: webBook }),
      refreshAll: async () => ({ ok: true, checked: 1, updated: 0 }),
      remove: async () => ({ ok: true }),
    },
    bookOverview: { onChanged: () => unsubscribe },
    ai: { onChunk: () => unsubscribe, onDone: () => unsubscribe },
    download: {
      onProgress: () => unsubscribe,
      onBlocked: () => unsubscribe,
      onCheckAllProgress: () => unsubscribe,
    },
  }
}

async function flushUi(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

const opened: string[] = []

async function mountLibrary(): Promise<{ unmount: () => void }> {
  installApi()
  const Host = defineComponent({
    setup: () => () => h(NMessageProvider, null, {
      default: () => h(LibraryPage, {
        active: true,
        onOpenWebBook: (url: string) => opened.push(url),
        onOpenBook: (id: string) => opened.push(`book:${id}`),
      }),
    }),
  })
  const app = createApp(Host)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  await flushUi()
  return { unmount: () => { app.unmount(); host.remove() } }
}

afterEach(() => {
  opened.length = 0
  document.body.innerHTML = ''
})

describe('书架里的网页书', () => {
  it('卡片显示书名和简介，不显示章名当书名', async () => {
    const { unmount } = await mountLibrary()
    const card = document.querySelector('.web-shelf-card') as HTMLElement | null
    expect(card).not.toBeNull()
    expect(card!.querySelector('.book-title')?.textContent?.trim()).toBe('万古神帝')
    expect(card!.querySelector('.book-author')?.textContent?.trim()).toBe('飞天鱼')
    expect(card!.querySelector('.book-intro')?.textContent?.trim()).toContain('前世惨死')
    unmount()
  })

  it('最近在读显示网页书，点开走 open-web-book', async () => {
    const { unmount } = await mountLibrary()
    const recent = document.querySelector('.shelf-continue') as HTMLElement | null
    expect(recent).not.toBeNull()
    expect(recent!.textContent).toContain('最近在读 · 网页书')
    expect(recent!.textContent).toContain('万古神帝')
    expect(recent!.textContent).toContain('读到第 2 / 2 章')
    const open = recent!.querySelector('.shelf-continue-open') as HTMLButtonElement
    open.click()
    await flushUi()
    expect(opened).toEqual([webBook.lastChapter.url])
    unmount()
  })

  it('读得比本地书早时，最近在读仍显示本地书', async () => {
    installApi()
    const older: WebShelfBook = { ...webBook, progress: { ...webBook.progress!, updatedAt: '2026-11-10T08:00:00.000Z' } }
    const api = (window as unknown as { api: Record<string, any> }).api
    api.shelf.list = async () => ({ ok: true, books: [older] })
    const Host = defineComponent({
      setup: () => () => h(NMessageProvider, null, { default: () => h(LibraryPage, { active: true }) }),
    })
    const app = createApp(Host)
    const host = document.createElement('div')
    document.body.appendChild(host)
    app.mount(host)
    await flushUi()
    const recent = document.querySelector('.shelf-continue') as HTMLElement | null
    expect(recent?.textContent).toContain('书库里的旧书')
    expect(recent?.textContent).not.toContain('网页书')
    app.unmount()
    host.remove()
  })
})
