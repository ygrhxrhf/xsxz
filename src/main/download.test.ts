import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('electron', () => {
  class FakeWebContents {
    isDestroyed(): boolean {
      return false
    }
    getURL(): string {
      return 'about:blank'
    }
    async loadURL(): Promise<void> {}
    async executeJavaScript(): Promise<string> {
      return '<html></html>'
    }
    on(): this {
      return this
    }
    removeListener(): this {
      return this
    }
  }
  class WebContentsView {
    webContents = new FakeWebContents()
    webPreferences: { session?: { partition?: string } }
    visible = true
    bounds: { x: number; y: number; width: number; height: number } | null = null
    constructor(opts: { webPreferences?: { session?: { partition?: string } } } = {}) {
      this.webPreferences = opts.webPreferences ?? {}
    }
    setVisible(visible: boolean): void {
      this.visible = visible
    }
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
      this.bounds = bounds
    }
  }
  return {
    BrowserWindow: class {},
    WebContentsView,
    session: { fromPartition: (partition: string) => ({ partition }) },
  }
})

import {
  chapterNeedsDownload,
  DOWNLOAD_SESSION_PARTITION,
  followCatalogIfNeeded,
  getHiddenView,
  HIDDEN_VIEW_BOUNDS,
  identityFromPage,
  resetDownloadStateForTests,
  setOwnerWindow,
  setTestHtmlLoader,
  startDownload,
  startDownloadFromPage,
  waitForIdle,
} from './download'

type MockHiddenView = {
  webPreferences: { session?: { partition?: string } }
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number } | null
  webContents: {
    loadURL: (url: string) => Promise<void>
    executeJavaScript: (script: string) => Promise<string>
  }
}

function trackingWindow(): {
  attached: unknown[]
  win: { contentView: { addChildView: (view: unknown) => void; removeChildView: (view: unknown) => void }; webContents: { send: () => void } }
} {
  const attached: unknown[] = []
  return {
    attached,
    win: {
      contentView: {
        addChildView(view: unknown) {
          attached.push(view)
        },
        removeChildView(view: unknown) {
          const i = attached.indexOf(view)
          if (i >= 0) attached.splice(i, 1)
        },
      },
      webContents: { send(): void {} },
    },
  }
}
import { bookIdFromUrl, listBooks, loadBook, readChapter, setLibraryPath } from './library'
import { extractPage } from './extract'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '../../fixtures', name), 'utf-8')

describe('identityFromPage + followCatalogIfNeeded', () => {
  it('recovers the catalog from a chapter page and hashes one bookId', async () => {
    const chapterHtml = fixture('chapter.html')
    const catalogHtml = fixture('catalog.html')
    const pageUrl = 'https://example.com/book/1.html'
    const extracted = extractPage(chapterHtml, pageUrl)
    expect(extracted.ok).toBe(true)
    expect(extracted.bootstrap!.pageKind).toBe('chapter')
    expect(extracted.bootstrap!.chapters).toHaveLength(0)

    const followed = await followCatalogIfNeeded(extracted.bootstrap!, async (url) => {
      expect(url).toMatch(/\/book\/?$/)
      return catalogHtml
    })
    expect(followed.ok).toBe(true)
    if (!followed.ok) return
    expect(followed.bootstrap.chapters).toHaveLength(6)
    expect(followed.bootstrap.chapters.map((c) => c.title).join('')).toContain('第一章')
    expect(followed.bootstrap.chapters.map((c) => c.url).join('')).not.toBe(pageUrl)

    const id = identityFromPage(pageUrl, followed.bootstrap)
    expect(id.catalogUrl).not.toContain('1.html')
    expect(id.bookId).toBe(bookIdFromUrl(id.host, id.catalogUrl))
    expect(id.bookId).toMatch(/^d_[0-9a-f]{16}$/)
  })
})

describe('chapterNeedsDownload', () => {
  it('fills pending / failed / empty and skips ready', () => {
    expect(chapterNeedsDownload('pending')).toBe(true)
    expect(chapterNeedsDownload('failed')).toBe(true)
    expect(chapterNeedsDownload('empty')).toBe(true)
    expect(chapterNeedsDownload('ready')).toBe(false)
  })
})

describe('hidden persist:novel crawl placement', () => {
  afterEach(() => {
    resetDownloadStateForTests()
  })

  it('uses persist:novel and keeps the hidden view off the visible chrome', () => {
    expect(DOWNLOAD_SESSION_PARTITION).toBe('persist:novel')
    expect(HIDDEN_VIEW_BOUNDS.x).toBeLessThan(0)
    expect(HIDDEN_VIEW_BOUNDS.y).toBeLessThan(0)
    expect(HIDDEN_VIEW_BOUNDS.width).toBeGreaterThan(1)
    expect(HIDDEN_VIEW_BOUNDS.height).toBeGreaterThan(1)
  })

  it('does not addChildView the crawler; loadURL/executeJavaScript still work detached', async () => {
    const { attached, win } = trackingWindow()
    setOwnerWindow(win as never)
    const view = getHiddenView() as unknown as MockHiddenView
    expect(attached).toEqual([])
    expect(view.webPreferences.session?.partition).toBe('persist:novel')
    expect(view.visible).toBe(false)
    expect(view.bounds).toEqual(HIDDEN_VIEW_BOUNDS)
    expect(view.webContents.loadURL).toBeTypeOf('function')
    expect(view.webContents.executeJavaScript).toBeTypeOf('function')
    await expect(view.webContents.loadURL('https://example.com/book/1.html')).resolves.toBeUndefined()
    await expect(view.webContents.executeJavaScript('document.documentElement.outerHTML')).resolves.toBeTypeOf('string')
    expect(getHiddenView()).toBe(view)
    expect(attached).toEqual([])
  })
})

describe('startDownloadFromPage', () => {
  let dir: string
  const loadedUrls: string[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-dl-'))
    await setLibraryPath(dir)
    loadedUrls.length = 0
    resetDownloadStateForTests()
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('login-wall')) return fixture('login-wall.html')
      if (url.endsWith('/book/') || url.includes('index.html')) return fixture('catalog.html')
      if (url.includes('2.html')) return fixture('chapter-empty.html')
      return fixture('chapter.html')
    })
  })

  afterEach(async () => {
    resetDownloadStateForTests()
    await rm(dir, { recursive: true, force: true })
  })

  it('maps login-wall.html to NeedLogin 需要登录 and does not create a book', async () => {
    const result = await startDownloadFromPage(
      fixture('login-wall.html'),
      'https://example.com/book/login-wall.html',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('NeedLogin')
    expect(result.message).toMatch(/需要登录/)
    expect(result.message).not.toBe('无法识别为书')
    await expect(loadBook(bookIdFromUrl('example.com', 'https://example.com/book/login-wall.html'))).rejects.toThrow()
  })

  it('starts from a chapter page, follows the catalog, and stores one six-chapter book', async () => {
    const result = await startDownloadFromPage(fixture('chapter.html'), 'https://example.com/book/1.html')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await waitForIdle()
    const book = await loadBook(result.bookId)
    expect(book.importType).toBe('download')
    expect(book.chapters).toHaveLength(6)
    expect(book.chapters.some((c) => c.url === 'https://example.com/book/1.html' && book.chapters.length === 1)).toBe(
      false,
    )
    expect(result.bookId).toBe(bookIdFromUrl('example.com', book.sourceUrl || ''))
    expect(loadedUrls.some((u) => u.includes('/book/') && !u.includes('.html'))).toBe(true)
  })

  it('uses the displayed guest HTML/URL, not an uncommitted draft', async () => {
    const draftUrl = 'https://evil.example/uncommitted-draft'
    const result = await startDownloadFromPage(
      fixture('catalog.html'),
      'https://example.com/book/index.html',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bookId).toBe(bookIdFromUrl('example.com', 'https://example.com/book/index.html'))
    expect(result.bookId).not.toBe(bookIdFromUrl('evil.example', draftUrl))
    expect(loadedUrls.every((u) => !u.includes('uncommitted-draft'))).toBe(true)
  })

  it('re-download fills failed/empty/pending and does not rewrite ready bodies', async () => {
    const first = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await waitForIdle()

    const book = await loadBook(first.bookId)
    const readyMeta = book.chapters.find((c) => c.url?.includes('1.html'))
    const gapMeta = book.chapters.find((c) => c.url?.includes('2.html'))
    expect(readyMeta?.status).toBe('ready')
    expect(gapMeta?.status).toBe('failed')

    const readyFile = join(dir, first.bookId, readyMeta!.file)
    const beforeBytes = await readFile(readyFile)
    const beforeJson = JSON.parse(beforeBytes.toString('utf-8')) as { body: string }
    expect(beforeJson.body.length).toBeGreaterThan(20)

    const marker = 'READY_BODY_MUST_NOT_CHANGE'
    beforeJson.body = marker
    await writeFile(readyFile, JSON.stringify(beforeJson), 'utf-8')

    loadedUrls.length = 0
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })

    const second = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.bookId).toBe(first.bookId)
    await waitForIdle()

    const afterBytes = await readFile(readyFile)
    const afterJson = JSON.parse(afterBytes.toString('utf-8')) as { body: string }
    expect(afterJson.body).toBe(marker)
    expect(loadedUrls.some((u) => u.includes('1.html'))).toBe(false)

    const gap = await readChapter(first.bookId, gapMeta!.id)
    expect(gap.status).toBe('ready')
    expect(gap.body).toContain('张若尘')

    const again = await loadBook(first.bookId)
    expect(again.chapters).toHaveLength(6)
  })

  it('promotes every extractable chapter to ready on disk and in the library index', async () => {
    loadedUrls.length = 0
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })

    const result = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await waitForIdle()

    const book = await loadBook(result.bookId)
    expect(book.chapters).toHaveLength(6)
    expect(book.status).toBe('ready')
    const readyCount = book.chapters.filter((c) => c.status === 'ready').length
    expect(readyCount).toBe(book.chapters.length)
    expect(book.chapters.every((c) => c.status === 'ready')).toBe(true)

    for (const ch of book.chapters) {
      const raw = await readFile(join(dir, book.id, ch.file), 'utf-8')
      const file = JSON.parse(raw) as { status: string; body: string }
      expect(file.status).toBe('ready')
      expect(file.body.length).toBeGreaterThan(20)
      const opened = await readChapter(book.id, ch.id)
      expect(opened.status).toBe('ready')
      expect(opened.body.length).toBeGreaterThan(20)
    }

    const listed = await listBooks()
    const item = listed.find((b) => b.id === book.id)
    expect(item?.chapterCount).toBe(6)
    expect(item?.readyCount).toBe(6)
    expect(item?.status).toBe('ready')
    expect(loadedUrls.filter((u) => /\d\.html$/.test(u)).length).toBe(6)
  })
})

describe('startDownload reads the displayed guest view', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-dl-guest-'))
    await setLibraryPath(dir)
    resetDownloadStateForTests()
  })

  afterEach(async () => {
    resetDownloadStateForTests()
    await rm(dir, { recursive: true, force: true })
  })

  it('does not navigate the visible guest when crawling chapters', async () => {
    const { attached, win } = trackingWindow()
    const guest = {
      navigated: [] as string[],
      webContents: {
        isDestroyed: () => false,
        getURL: () => 'https://example.com/book/index.html',
        executeJavaScript: async (script: string) => {
          expect(script).toContain('outerHTML')
          return fixture('catalog.html')
        },
        loadURL: async (url: string) => {
          guest.navigated.push(url)
        },
      },
    }
    const { setBrowseView } = await import('./download')
    setOwnerWindow(win as never)
    setBrowseView(guest as never)
    setTestHtmlLoader(async (url) => {
      if (url.includes('2.html')) return fixture('chapter-empty.html')
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })

    const result = await startDownload()
    expect(result.ok).toBe(true)
    await waitForIdle()
    expect(guest.navigated).toEqual([])
    expect(guest.webContents.getURL()).toBe('https://example.com/book/index.html')
    getHiddenView()
    expect(attached).toEqual([])
  })
})
