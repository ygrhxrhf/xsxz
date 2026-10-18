import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ busy: false }))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/spbf-reading-session-test' },
  session: { fromPartition: () => ({}) },
  WebContentsView: class {
    webContents = { isDestroyed: () => true, stop: () => {}, on: () => {}, removeListener: () => {}, loadURL: async () => {} }
    setVisible(): void {}
    setBounds(): void {}
  },
}))

vi.mock('./download', () => ({
  DOWNLOAD_SESSION_PARTITION: 'persist:novel',
  HIDDEN_VIEW_BOUNDS: { x: -2400, y: -2400, width: 800, height: 600 },
  isDownloadBusy: () => state.busy,
}))

import {
  dropReadingSessionForTests,
  loadCatalog,
  loadPageBootstrap,
  loadReadingPage,
  peekCachedReadingPage,
  prefetchReadingPage,
  setReadingHtmlLoaderForTests,
} from './readingSession'

const CHAPTER_URL = 'https://example.com/book/65/c2.html'
const BODY_TEXT = '风从山口压下来，把整片草场按出一道长长的波纹。'.repeat(12)

function chapterHtml(): string {
  return `<!doctype html><html><head><title>第 2 章 起风</title></head><body>
    <div id="content"><p>${BODY_TEXT}</p><p>${BODY_TEXT}</p></div>
    <a href="/book/65/c1.html">上一章</a>
    <a href="/book/65/c3.html">下一章</a>
  </body></html>`
}

function catalogHtml(count = 6): string {
  const items = Array.from({ length: count }, (_, index) => `<li><a href="/book/65/c${index + 1}.html">第${index + 1}章 起风</a></li>`).join('')
  return `<!doctype html><html><head><title>示例书 目录</title></head><body><div id="list"><ul>${items}</ul></div></body></html>`
}

beforeEach(() => {
  state.busy = false
  dropReadingSessionForTests()
  setReadingHtmlLoaderForTests(null)
})

describe('reading session page loading', () => {
  it('extracts a chapter with previous and next links', async () => {
    setReadingHtmlLoaderForTests(async () => chapterHtml())
    const res = await loadReadingPage(CHAPTER_URL)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.cached).toBe(false)
    expect(res.page.title).toBe('第 2 章 起风')
    expect(res.page.body).toContain('风从山口压下来')
    expect(res.page.chapter?.next?.url).toBe('https://example.com/book/65/c3.html')
    expect(res.page.chapter?.previous?.url).toBe('https://example.com/book/65/c1.html')
  })

  it('serves a repeat request from cache without a second fetch', async () => {
    let calls = 0
    setReadingHtmlLoaderForTests(async () => { calls++; return chapterHtml() })
    await loadReadingPage(CHAPTER_URL)
    const second = await loadReadingPage(CHAPTER_URL)
    expect(second.ok && second.cached).toBe(true)
    expect(calls).toBe(1)
    expect(peekCachedReadingPage(CHAPTER_URL)?.body).toContain('风从山口压下来')
  })

  it('站点分页章节续抓后半章：拼上被藏起来的下一页', async () => {
    const PAGE2 = 'https://example.com/book/65/c2.html?page=2'
    const page2Text = '后半章的内容：林舟把灯笼搁在石阶上，蹲下去看那道刻痕。'.repeat(6)
    setReadingHtmlLoaderForTests(async (url) => {
      if (url === PAGE2) {
        return `<!doctype html><html><head><title>第 2 章 起风</title></head><body><div id="content"><p>${page2Text}</p></div></body></html>`
      }
      return `<!doctype html><html><head><title>第 2 章 起风</title></head><body>
        <div id="content"><p>${BODY_TEXT}</p><p>${BODY_TEXT}</p></div>
        <a href="?page=2" style="display:none">下一页</a>
      </body></html>`
    })
    const res = await loadReadingPage(CHAPTER_URL)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.page.body).toContain('风从山口压下来')
    expect(res.page.body).toContain('林舟把灯笼搁在石阶上')
  })

  it('reports a friendly failure instead of throwing', async () => {
    setReadingHtmlLoaderForTests(async () => { throw new Error('章节加载超时') })
    const res = await loadReadingPage(CHAPTER_URL)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.message).toContain('超时')
    expect(await loadReadingPage('about:blank')).toMatchObject({ ok: false })
  })

  it('refuses a page without chapter text', async () => {
    setReadingHtmlLoaderForTests(async () => '<html><body><p>首页导航</p></body></html>')
    const res = await loadReadingPage(CHAPTER_URL)
    expect(res.ok).toBe(false)
  })

  it('prefetches only when nothing is downloading', async () => {
    setReadingHtmlLoaderForTests(async () => chapterHtml())
    state.busy = true
    expect(await prefetchReadingPage(CHAPTER_URL)).toEqual({ ok: false, cached: false })
    state.busy = false
    expect(await prefetchReadingPage(CHAPTER_URL)).toEqual({ ok: true, cached: false })
    expect(await prefetchReadingPage(CHAPTER_URL)).toEqual({ ok: true, cached: true })
  })
})

describe('reading session catalog and bootstrap', () => {
  it('parses a catalog page', async () => {
    setReadingHtmlLoaderForTests(async () => catalogHtml())
    const res = await loadCatalog(CHAPTER_URL)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.chapters).toHaveLength(6)
    expect(res.chapters[0].url).toBe('https://example.com/book/65/c1.html')
  })

  it('reports an unreadable catalog', async () => {
    setReadingHtmlLoaderForTests(async () => '<html><body><p>404</p></body></html>')
    expect((await loadCatalog(CHAPTER_URL)).ok).toBe(false)
    expect((await loadCatalog('file:///etc/passwd')).ok).toBe(false)
  })

  it('bootstraps a catalog page with its chapter list', async () => {
    setReadingHtmlLoaderForTests(async () => catalogHtml())
    const res = await loadPageBootstrap(CHAPTER_URL)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.bootstrap.pageKind).toBe('catalog')
    expect(res.bootstrap.catalogUrl).toBe(CHAPTER_URL)
    expect(res.bootstrap.chapters).toHaveLength(6)
  })

  it('bootstraps a chapter page with its own url as the catalog entry', async () => {
    setReadingHtmlLoaderForTests(async () => chapterHtml())
    const res = await loadPageBootstrap(CHAPTER_URL)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.bootstrap.pageKind).toBe('chapter')
    expect(res.bootstrap.title).toBe('第 2 章 起风')
    expect(res.bootstrap.catalogUrl).toBe(CHAPTER_URL)
    expect(res.bootstrap.chapters).toEqual([])
  })

  it('keeps a readable title even when the site cannot be classified', async () => {
    setReadingHtmlLoaderForTests(async () => chapterHtml())
    const res = await loadPageBootstrap(CHAPTER_URL)
    expect(res.ok && res.bootstrap.title.length > 0).toBe(true)
  })
})
