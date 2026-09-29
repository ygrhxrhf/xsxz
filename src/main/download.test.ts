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
    app: {
      getPath(): string {
        throw new Error('download tests must inject setSiteRulesDir when they need rules')
      },
    },
  }
})

import {
  cancelCheckAll,
  cancelDownload,
  chapterGapMs,
  chapterNeedsDownload,
  chapterRetryDelayMs,
  checkAllUpdates,
  checkUpdate,
  checkUpdateFailHint,
  CHAPTER_RETRY_TIMES,
  DOWNLOAD_SESSION_PARTITION,
  followCatalogIfNeeded,
  getHiddenView,
  HIDDEN_VIEW_BOUNDS,
  identityFromPage,
  resetDownloadStateForTests,
  setBrowseView,
  setOwnerWindow,
  setTestHtmlLoader,
  retryFailed,
  shouldRetryChapterFail,
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
import {
  bookIdFromUrl,
  createBookFromBootstrap,
  listBooks,
  loadBook,
  readChapter,
  saveBook,
  setLibraryPath,
} from './library'
import { extractPage } from './extract'
import { setSiteRulesDir, upsertSiteRule } from './siteRules'
import { FAIL_CODE_ZH } from '../shared/types'

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

  it('hash chapter extract bootstrap yields the catalog bookId (VAL-IDENT-024)', () => {
    const filler =
      '张若尘从梦中惊醒，发现自己身处一间简陋的房间之中。窗外月光如水，照在斑驳的墙壁上。他低头看了看自己的双手，年轻、有力，却不是他记忆中的样子。这个少年来自一个偏远的小城，自幼父母双亡，靠邻居接济长大。他站起身来，走到窗前，望着远处连绵的山峦。这个世界比地球更加广阔，充满了未知的危险和机遇。既然老天给了我第二次生命，我一定要活出个样子来。他握紧了拳头，眼中闪过坚定的光芒。'
    const chapterHtml = `<!DOCTYPE html>
<html>
<head><title>第1章 千金攻略（1）</title></head>
<body>
<div id="chaptercontent">
${filler}
<a href="#/book/65/">返回目录</a>
</div>
</body>
</html>`
    const pageUrl = 'https://www.bqg858.cc/#/book/65/1.html'
    const extracted = extractPage(chapterHtml, pageUrl)
    expect(extracted.ok).toBe(true)
    expect(extracted.pageKind).toBe('chapter')
    expect(extracted.bootstrap!.catalogUrl).toContain('#/book/65')
    expect(extracted.bootstrap!.catalogUrl).not.toContain('1.html')

    const id = identityFromPage(pageUrl, extracted.bootstrap!)
    expect(id.catalogUrl).toContain('#/book/65')
    expect(id.catalogUrl).not.toBe(pageUrl)
    expect(id.bookId).toBe(bookIdFromUrl('www.bqg858.cc', 'https://www.bqg858.cc/#/book/65/'))
    expect(id.bookId).not.toBe(bookIdFromUrl('www.bqg858.cc', 'https://www.bqg858.cc/'))
  })

  it('hash chapter identityFromPage equals catalog bookId; bare path does not (VAL-IDENT-018)', async () => {
    const host = 'www.bqg858.cc'
    const hashCatalog = 'https://www.bqg858.cc/#/book/65/'
    const hashChapter = 'https://www.bqg858.cc/#/book/65/1.html'
    const bareCatalog = 'https://www.bqg858.cc/book/65/'
    const bareChapter = 'https://www.bqg858.cc/book/65/1.html'
    const catalogId = bookIdFromUrl(host, hashCatalog)

    const catalogHtml = `<!DOCTYPE html>
<html>
<head><title>这个大佬画风不对</title></head>
<body>
<h1>这个大佬画风不对</h1>
<div id="list">
<dl>
<dd><a href="#/book/65/1.html">第1章 千金攻略（1）</a></dd>
<dd><a href="#/book/65/2.html">第2章 千金攻略（2）</a></dd>
<dd><a href="#/book/65/3.html">第3章 千金攻略（3）</a></dd>
<dd><a href="#/book/65/4.html">第4章 千金攻略（4）</a></dd>
<dd><a href="#/book/65/5.html">第5章 千金攻略（5）</a></dd>
</dl>
</div>
</body>
</html>`
    const filler =
      '张若尘从梦中惊醒，发现自己身处一间简陋的房间之中。窗外月光如水，照在斑驳的墙壁上。他低头看了看自己的双手，年轻、有力，却不是他记忆中的样子。这个少年来自一个偏远的小城，自幼父母双亡，靠邻居接济长大。他站起身来，走到窗前，望着远处连绵的山峦。这个世界比地球更加广阔，充满了未知的危险和机遇。既然老天给了我第二次生命，我一定要活出个样子来。他握紧了拳头，眼中闪过坚定的光芒。'
    const chapterHtml = `<!DOCTYPE html>
<html>
<head><title>第1章 千金攻略（1）</title></head>
<body>
<div id="chaptercontent">
${filler}
<a href="#/book/65/">返回目录</a>
</div>
</body>
</html>`

    const catalogPage = extractPage(catalogHtml, hashCatalog)
    expect(catalogPage.ok).toBe(true)
    expect(catalogPage.pageKind).toBe('catalog')
    const fromCatalog = identityFromPage(hashCatalog, catalogPage.bootstrap!)
    expect(fromCatalog.bookId).toBe(catalogId)

    const chapterPage = extractPage(chapterHtml, hashChapter)
    expect(chapterPage.ok).toBe(true)
    expect(chapterPage.pageKind).toBe('chapter')
    expect(chapterPage.bootstrap!.catalogUrl).toContain('#/book/65')
    const fromChapter = identityFromPage(hashChapter, chapterPage.bootstrap!)
    expect(fromChapter.bookId).toBe(catalogId)
    expect(fromChapter.bookId).toBe(fromCatalog.bookId)

    const followed = await followCatalogIfNeeded(chapterPage.bootstrap!, async (url) => {
      expect(url).toContain('#/book/65')
      expect(url).not.toContain('1.html')
      return catalogHtml
    })
    expect(followed.ok).toBe(true)
    if (!followed.ok) return
    expect(followed.bootstrap.chapters.length).toBeGreaterThanOrEqual(5)
    expect(identityFromPage(hashChapter, followed.bootstrap).bookId).toBe(catalogId)

    const bareCatalogPage = extractPage(catalogHtml, bareCatalog)
    expect(bareCatalogPage.ok).toBe(true)
    expect(bareCatalogPage.pageKind).toBe('catalog')
    const fromBareCatalog = identityFromPage(bareCatalog, bareCatalogPage.bootstrap!)
    expect(fromBareCatalog.bookId).toBe(bookIdFromUrl(host, bareCatalog))
    expect(fromBareCatalog.bookId).not.toBe(catalogId)

    const bareChapterPage = extractPage(chapterHtml, bareChapter)
    expect(bareChapterPage.pageKind).toBe('chapter')
    const fromBareChapter = identityFromPage(bareChapter, bareChapterPage.bootstrap!)
    expect(fromBareChapter.bookId).not.toBe(catalogId)
    expect(fromBareChapter.bookId).not.toBe(bookIdFromUrl(host, hashChapter))
  })

  it('Alice chapter recovers chapters catalog as one bookId; novel without recovery is documented (VAL-IDENT-021)', async () => {
    const host = 'www.alicesw.com'
    const chaptersCatalog = 'https://www.alicesw.com/other/chapters/id/44828.html'
    const novelUrl = 'https://www.alicesw.com/novel/44828.html'
    const chapterUrl = 'https://www.alicesw.com/book/46268/9c5ec36414c68.html'
    const catalogId = bookIdFromUrl(host, chaptersCatalog)

    const aliceCatalogHtml = `<!DOCTYPE html>
<html>
<head><title>三国杀同人短篇合集 目录</title>
<meta property="og:title" content="三国杀同人短篇合集">
</head>
<body>
<h1>三国杀同人短篇合集</h1>
<ul>
  <li><a href="https://www.alicesw.com/book/46268/9c5ec36414c68.html">第一章 序</a></li>
  <li><a href="https://www.alicesw.com/book/46268/77281b2336468.html">第二章 同人短篇</a></li>
  <li><a href="https://www.alicesw.com/book/46268/49003fd028942.html">第三章 续写</a></li>
  <li><a href="https://www.alicesw.com/book/46268/aaa1111111111.html">第四章 第四篇</a></li>
  <li><a href="https://www.alicesw.com/book/46268/bbb2222222222.html">第五章 第五篇</a></li>
</ul>
</body>
</html>`
    const filler =
      '张若尘从梦中惊醒，发现自己身处一间简陋的房间之中。窗外月光如水，照在斑驳的墙壁上。他低头看了看自己的双手，年轻、有力，却不是他记忆中的样子。这个少年来自一个偏远的小城，自幼父母双亡，靠邻居接济长大。他站起身来，走到窗前，望着远处连绵的山峦。这个世界比地球更加广阔，充满了未知的危险和机遇。既然老天给了我第二次生命，我一定要活出个样子来。他握紧了拳头，眼中闪过坚定的光芒。'
    const aliceChapterHtml = `<!DOCTYPE html>
<html>
<head><title>序 - 三国杀同人短篇合集</title></head>
<body>
<div id="content">
${filler}
上一章 | <a href="/other/chapters/id/44828.html">返回目录</a> | 下一章
</div>
</body>
</html>`
    const aliceNovelHtml = `<!DOCTYPE html>
<html>
<head><title>三国杀同人短篇合集</title>
<meta property="og:title" content="三国杀同人短篇合集">
</head>
<body>
<h1>三国杀同人短篇合集</h1>
<div id="content">
${filler}
</div>
<p>最近更新：第2篇</p>
<a href="/other/chapters/id/44828.html">查看所有章节</a>
<ul>
  <li><a href="/book/46268/9c5ec36414c68.html">第一章 序</a></li>
  <li><a href="/book/46268/77281b2336468.html">第二章 同人短篇</a></li>
</ul>
</body>
</html>`

    const catalogPage = extractPage(aliceCatalogHtml, chaptersCatalog)
    expect(catalogPage.ok).toBe(true)
    expect(catalogPage.pageKind).toBe('catalog')
    expect(identityFromPage(chaptersCatalog, catalogPage.bootstrap!).bookId).toBe(catalogId)

    const chapterPage = extractPage(aliceChapterHtml, chapterUrl)
    expect(chapterPage.ok).toBe(true)
    expect(chapterPage.pageKind).toBe('chapter')
    expect(chapterPage.bootstrap!.catalogUrl).toContain('/other/chapters/id/44828.html')
    const fromChapter = identityFromPage(chapterUrl, chapterPage.bootstrap!)
    expect(fromChapter.bookId).toBe(catalogId)
    expect(fromChapter.bookId).not.toBe(bookIdFromUrl(host, chapterUrl))
    expect(fromChapter.bookId).not.toBe(bookIdFromUrl(host, 'https://www.alicesw.com/book/46268/'))

    const followed = await followCatalogIfNeeded(chapterPage.bootstrap!, async (url) => {
      expect(url).toContain('/other/chapters/id/44828.html')
      return aliceCatalogHtml
    })
    expect(followed.ok).toBe(true)
    if (!followed.ok) return
    expect(followed.bootstrap.chapters.length).toBeGreaterThanOrEqual(5)
    expect(identityFromPage(chapterUrl, followed.bootstrap).bookId).toBe(catalogId)

    const novelPage = extractPage(aliceNovelHtml, novelUrl)
    const novelId = novelPage.ok && novelPage.bootstrap
      ? identityFromPage(novelUrl, novelPage.bootstrap).bookId
      : bookIdFromUrl(host, novelUrl)
    if (novelPage.ok && novelPage.bootstrap?.catalogUrl?.includes('/other/chapters/id/44828.html')) {
      expect(novelId).toBe(catalogId)
    } else {
      // Live tests must paste only the chapters URL (VAL-DL-001). Do not start from
      // /novel/44828.html — that would be a second Alice card for the same title.
      expect(novelId).not.toBe(catalogId)
      expect(bookIdFromUrl(host, novelUrl)).not.toBe(catalogId)
    }
  })
})

describe('chapterNeedsDownload', () => {
  it('fills pending / failed / empty and skips ready', () => {
    expect(chapterNeedsDownload('pending')).toBe(true)
    expect(chapterNeedsDownload('failed')).toBe(true)
    expect(chapterNeedsDownload('empty')).toBe(true)
    expect(chapterNeedsDownload('ready')).toBe(false)
  })

  it('retries only NavFailed / BodyEmpty and uses 1s/2s backoff outside tests', () => {
    expect(shouldRetryChapterFail('NavFailed')).toBe(true)
    expect(shouldRetryChapterFail('BodyEmpty')).toBe(true)
    expect(shouldRetryChapterFail('Intercepted')).toBe(false)
    expect(shouldRetryChapterFail('NeedLogin')).toBe(false)
    expect(CHAPTER_RETRY_TIMES).toBe(2)
    resetDownloadStateForTests()
    expect(chapterRetryDelayMs(1, { testing: false })).toBe(1000)
    expect(chapterRetryDelayMs(2, { testing: false })).toBe(2000)
  })

  it('uses zero retry delay when a test html loader is injected', () => {
    setTestHtmlLoader(async () => '<html></html>')
    expect(chapterRetryDelayMs(1)).toBe(0)
    resetDownloadStateForTests()
  })

  it('maps download pace to a fixed chapter gap and treats unknown values as standard', () => {
    resetDownloadStateForTests()
    expect(chapterGapMs('slow', { testing: false })).toBe(2000)
    expect(chapterGapMs('standard', { testing: false })).toBe(600)
    expect(chapterGapMs('fast', { testing: false })).toBe(200)
    expect(chapterGapMs('turbo', { testing: false })).toBe(600)
    expect(chapterGapMs(undefined, { testing: false })).toBe(600)
  })

  it('uses zero chapter gap when a test html loader is injected', () => {
    setTestHtmlLoader(async () => '<html></html>')
    expect(chapterGapMs('slow')).toBe(0)
    expect(chapterGapMs('standard')).toBe(0)
    resetDownloadStateForTests()
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
    expect(result.bookId).toBeDefined()
    await waitForIdle()
    const book = await loadBook(result.bookId!)
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
    await waitForIdle()
    expect(loadedUrls.every((u) => !u.includes('uncommitted-draft'))).toBe(true)
  })

  it('re-download fills failed/empty/pending and does not rewrite ready bodies', async () => {
    const first = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.bookId).toBeDefined()
    await waitForIdle()

    const book = await loadBook(first.bookId!)
    const readyMeta = book.chapters.find((c) => c.url?.includes('1.html'))
    const gapMeta = book.chapters.find((c) => c.url?.includes('2.html'))
    expect(readyMeta?.status).toBe('ready')
    expect(gapMeta?.status).toBe('failed')

    const readyFile = join(dir, first.bookId!, readyMeta!.file)
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

    const gap = await readChapter(first.bookId!, gapMeta!.id)
    expect(gap.status).toBe('ready')
    expect(gap.body).toContain('张若尘')

    const again = await loadBook(first.bookId!)
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
    expect(result.bookId).toBeDefined()
    await waitForIdle()

    const book = await loadBook(result.bookId!)
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

describe('download resolves site rules per URL', () => {
  let dir: string
  let rulesDir: string
  const ruleFixture = (name: string) =>
    readFileSync(join(import.meta.dirname, '../../fixtures/rule-site', name), 'utf-8')
  const catalogUrl = 'http://127.0.0.1:5176/catalog.html'
  const matching = {
    host: '127.0.0.1',
    title: '#spbf-title',
    author: '#spbf-author',
    catalog: '#spbf-toc',
    body: '#spbf-body',
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-dl-rule-'))
    rulesDir = await mkdtemp(join(tmpdir(), 'spbf-rules-dl-'))
    await setLibraryPath(dir)
    setSiteRulesDir(rulesDir)
    resetDownloadStateForTests()
    setTestHtmlLoader(async (url) => {
      if (url.includes('c1.html')) return ruleFixture('c1.html')
      if (url.includes('c2.html')) return ruleFixture('c2.html')
      return ruleFixture('catalog.html')
    })
  })

  afterEach(async () => {
    resetDownloadStateForTests()
    setSiteRulesDir(null)
    await rm(dir, { recursive: true, force: true })
    await rm(rulesDir, { recursive: true, force: true })
  })

  it('fails rule-site catalog without a stored rule', async () => {
    const result = await startDownloadFromPage(ruleFixture('catalog.html'), catalogUrl)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(['UnknownPage', 'CatalogNotFound', 'BodyEmpty']).toContain(result.code)
    expect(await listBooks()).toEqual([])
  })

  it('start and chapter-page follow use the matching rule for Alpha/Beta bodies', async () => {
    await upsertSiteRule(matching)
    const fromCatalog = await startDownloadFromPage(ruleFixture('catalog.html'), catalogUrl)
    expect(fromCatalog.ok).toBe(true)
    if (!fromCatalog.ok) return
    expect(fromCatalog.bookId).toBeDefined()
    await waitForIdle()
    const book = await loadBook(fromCatalog.bookId!)
    expect(book.chapters.map((c) => c.title)).toEqual(expect.arrayContaining(['Alpha', 'Beta']))
    expect(book.chapters).toHaveLength(2)
    const bodies = await Promise.all(book.chapters.map((c) => readChapter(book.id, c.id)))
    expect(bodies.some((b) => b.body.includes('SPBF_RULE_BODY_ALPHA'))).toBe(true)
    expect(bodies.some((b) => b.body.includes('SPBF_RULE_BODY_BETA'))).toBe(true)
    expect(bodies.every((b) => !b.body.includes('DECOY_BANNER_CLICK'))).toBe(true)
  })

  it('start from a chapter page still follows the catalog via the matching rule', async () => {
    await upsertSiteRule(matching)
    const fromChapter = await startDownloadFromPage(ruleFixture('c1.html'), 'http://127.0.0.1:5176/c1.html')
    expect(fromChapter.ok).toBe(true)
    if (!fromChapter.ok) return
    expect(fromChapter.bookId).toBeDefined()
    await waitForIdle()
    const book = await loadBook(fromChapter.bookId!)
    expect(book.chapters.map((c) => c.title)).toEqual(expect.arrayContaining(['Alpha', 'Beta']))
    expect(book.chapters).toHaveLength(2)
    const bodies = await Promise.all(book.chapters.map((c) => readChapter(book.id, c.id)))
    expect(bodies.some((b) => b.body.includes('SPBF_RULE_BODY_ALPHA'))).toBe(true)
    expect(bodies.some((b) => b.body.includes('SPBF_RULE_BODY_BETA'))).toBe(true)
  })

  it('retryFailed re-extracts failed chapters with the current host rule', async () => {
    await upsertSiteRule({
      host: '127.0.0.1',
      title: '#spbf-title',
      author: '#spbf-author',
      catalog: '#spbf-toc',
    })
    const started = await startDownloadFromPage(ruleFixture('catalog.html'), catalogUrl)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.bookId).toBeDefined()
    await waitForIdle()
    const before = await loadBook(started.bookId!)
    expect(before.chapters).toHaveLength(2)
    expect(before.chapters.every((c) => c.status === 'failed' || c.status === 'empty')).toBe(true)

    await upsertSiteRule(matching)
    const retried = await retryFailed(started.bookId!)
    expect(retried.ok).toBe(true)
    await waitForIdle()
    const after = await loadBook(started.bookId!)
    expect(after.chapters.every((c) => c.status === 'ready')).toBe(true)
    const bodies = await Promise.all(after.chapters.map((c) => readChapter(after.id, c.id)))
    expect(bodies.some((b) => b.body.includes('SPBF_RULE_BODY_ALPHA'))).toBe(true)
    expect(bodies.some((b) => b.body.includes('SPBF_RULE_BODY_BETA'))).toBe(true)
  })
})

const LOCK_MSG = '已有下载任务在进行中，请等待完成或取消后再试'
const NO_SOURCE_CHECK = '无原始目录地址，无法检查更新'
const NO_SOURCE_RETRY = '无原始目录地址，无法重试'

function catalogWithSeventh(): string {
  return fixture('catalog.html').replace(
    '<dd><a href="https://example.com/book/6.html">第六章 师兄</a></dd>',
    '<dd><a href="https://example.com/book/6.html">第六章 师兄</a></dd>\n<dd><a href="https://example.com/book/7.html">第七章 新篇</a></dd>',
  )
}

function shortCatalogThree(): string {
  return `<!DOCTYPE html>
<html>
<head><title>某小说网 - 万古神帝 目录</title>
<meta property="og:title" content="万古神帝">
<meta property="og:novel:author" content="飞天鱼">
</head>
<body>
<h1>万古神帝</h1>
<div class="bookinfo"><span class="author">飞天鱼</span></div>
<div id="list">
<dl>
<dt>正文</dt>
<dd><a href="https://example.com/book/1.html">第一章 前世记忆</a></dd>
<dd><a href="https://example.com/book/2.html">第二章 苏醒</a></dd>
<dd><a href="https://example.com/book/3.html">第三章 入门</a></dd>
</dl>
</div>
</body>
</html>`
}

function emptyCatalogHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><title>某小说网 - 万古神帝 目录</title>
<meta property="og:title" content="万古神帝">
</head>
<body>
<h1>万古神帝</h1>
<p>暂无章节</p>
</body>
</html>`
}

function interceptedHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><title>安全验证</title></head>
<body>
<div id="content">
请完成人机验证 检测到异常访问 点击按钮继续 Cloudflare Access Denied
页面不像正文拦截套话填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充
再补一长段汉字以确保有效长度远超八十字阈值星河倒转灯火通明山河远阔江水东流春去秋来
</div>
</body>
</html>`
}

function progressWindow(events: unknown[]): {
  contentView: { addChildView: () => void; removeChildView: () => void }
  webContents: { send: (channel: string, payload: unknown) => void }
} {
  return {
    contentView: {
      addChildView(): void {},
      removeChildView(): void {},
    },
    webContents: {
      send(channel: string, payload: unknown): void {
        if (channel === 'download.progress') events.push(payload)
      },
    },
  }
}

describe('checkUpdate', () => {
  let dir: string
  const loadedUrls: string[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-dl-upd-'))
    await setLibraryPath(dir)
    loadedUrls.length = 0
    resetDownloadStateForTests()
  })

  afterEach(async () => {
    resetDownloadStateForTests()
    await rm(dir, { recursive: true, force: true })
  })

  async function readStoredChapter(bookId: string, chapterId: string): Promise<{ status: string; body: string }> {
    const book = JSON.parse(await readFile(join(dir, bookId, 'book.json'), 'utf-8')) as {
      chapters: Array<{ id: string; file: string; status: string }>
    }
    const meta = book.chapters.find((chapter) => chapter.id === chapterId)
    if (!meta) throw new Error(`missing chapter ${chapterId}`)
    const file = JSON.parse(await readFile(join(dir, bookId, meta.file), 'utf-8')) as {
      status: string
      body: string
    }
    expect(meta.status).toBe('ready')
    expect(file.status).toBe('ready')
    return file
  }

  async function seedSixChapterBook(opts?: { failSixth?: boolean }): Promise<{
    bookId: string
    readySnapshots: Array<{ id: string; body: string; url?: string }>
  }> {
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) throw new Error('seed start failed')
    expect(started.bookId).toBeDefined()
    await waitForIdle()
    const book = await loadBook(started.bookId!)
    if (opts?.failSixth) {
      const sixth = book.chapters[5]
      await writeFile(
        join(dir, book.id, sixth.file),
        JSON.stringify({
          title: sixth.title,
          url: sixth.url,
          body: '',
          status: 'failed',
          failCode: 'NavFailed',
        }),
        'utf-8',
      )
      sixth.status = 'failed'
      sixth.failCode = 'NavFailed'
      await saveBook(book)
    }
    const readySnapshots = []
    for (const ch of (await loadBook(started.bookId!)).chapters.filter((c) => c.status === 'ready')) {
      const file = await readStoredChapter(started.bookId!, ch.id)
      readySnapshots.push({ id: ch.id, body: file.body, url: ch.url })
    }
    loadedUrls.length = 0
    return { bookId: started.bookId!, readySnapshots }
  }

  it('adds only a new catalog row and downloads it without rewriting ready bodies (VAL-DL-001/002/019)', async () => {
    const { bookId, readySnapshots } = await seedSixChapterBook()
    expect(readySnapshots).toHaveLength(6)
    const marker = 'READY_BODY_MUST_NOT_CHANGE'
    for (const snap of readySnapshots) {
      const book = await loadBook(bookId)
      const meta = book.chapters.find((c) => c.id === snap.id)!
      const raw = JSON.parse(await readFile(join(dir, bookId, meta.file), 'utf-8')) as { body: string }
      raw.body = `${marker}:${snap.id}`
      await writeFile(join(dir, bookId, meta.file), JSON.stringify(raw), 'utf-8')
    }

    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return catalogWithSeventh()
      return fixture('chapter.html')
    })
    const result = await checkUpdate(bookId)
    expect(result).toMatchObject({ ok: true, bookId, added: 1 })
    await waitForIdle()

    const listed = await listBooks()
    expect(listed.map((b) => b.id)).toEqual([bookId])
    const after = await loadBook(bookId)
    expect(after.chapters).toHaveLength(7)
    expect(after.importType).toBe('download')
    expect(after.sourceUrl).toBe('https://example.com/book/index.html')
    const seventh = after.chapters.find((c) => c.url?.includes('7.html'))
    expect(seventh).toBeTruthy()
    expect(loadedUrls.filter((u) => u.includes('7.html')).length).toBeGreaterThanOrEqual(1)
    expect(loadedUrls.filter((u) => /\/book\/[1-6]\.html$/.test(u))).toEqual([])

    for (const snap of readySnapshots) {
      const file = await readChapter(bookId, snap.id)
      expect(file.body).toBe(`${marker}:${snap.id}`)
      const still = after.chapters.find((c) => c.id === snap.id)
      expect(still?.id).toBe(snap.id)
    }
    const seventhFile = await readChapter(bookId, seventh!.id)
    expect(['ready', 'failed', 'empty'].includes(seventhFile.status) || seventhFile.failCode === 'Intercepted').toBe(
      true,
    )
  })

  it('retries a failed chapter without counting added (VAL-DL-003)', async () => {
    const { bookId } = await seedSixChapterBook({ failSixth: true })
    const before = await loadBook(bookId)
    const failed = before.chapters.find((c) => c.status === 'failed')
    expect(failed?.url).toContain('6.html')
    const failedId = failed!.id
    const chapterCount = before.chapters.length

    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })
    const result = await checkUpdate(bookId)
    expect(result).toEqual({ ok: true, bookId, added: 0 })
    await waitForIdle()

    const after = await loadBook(bookId)
    expect(after.chapters).toHaveLength(chapterCount)
    expect(after.chapters.filter((c) => c.url === failed!.url)).toHaveLength(1)
    expect(after.chapters.find((c) => c.id === failedId)?.id).toBe(failedId)
    expect(loadedUrls.filter((u) => u.includes('6.html')).length).toBeGreaterThanOrEqual(1)
    const retried = await readChapter(bookId, failedId)
    expect(retried.status).toBe('ready')
  })

  it('rejects imported or sourceless books with the exact checkUpdate sentence (VAL-DL-004)', async () => {
    const imported = await createBookFromBootstrap({
      bookId: 'i_txtbook00000001',
      title: '导入书',
      author: '甲',
      importType: 'txt',
      chapterTitles: ['第一章'],
    })
    const events: unknown[] = []
    setOwnerWindow(progressWindow(events) as never)
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      return fixture('catalog.html')
    })
    const noSource = await checkUpdate(imported.id)
    expect(noSource).toEqual({ ok: false, message: NO_SOURCE_CHECK })
    expect(loadedUrls).toEqual([])
    expect(events).toEqual([])

    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.bookId).toBeDefined()
    await waitForIdle()
    const dl = await loadBook(started.bookId!)
    delete dl.sourceUrl
    await saveBook(dl)
    loadedUrls.length = 0
    events.length = 0
    const emptySource = await checkUpdate(dl.id)
    expect(emptySource).toEqual({ ok: false, message: NO_SOURCE_CHECK })
    expect(loadedUrls).toEqual([])
    expect(events).toEqual([])
  })

  it('keeps retryFailed sourceless wording unchanged (VAL-DL-008)', async () => {
    const imported = await createBookFromBootstrap({
      bookId: 'i_txtbook00000002',
      title: '导入书',
      author: '甲',
      importType: 'txt',
      chapterTitles: ['第一章'],
    })
    const retried = await retryFailed(imported.id)
    expect(retried).toEqual({ ok: false, message: NO_SOURCE_RETRY })
  })

  it('refuses when another download already holds the lock (VAL-DL-005)', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('1.html')) await gate
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) {
      release()
      return
    }
    expect(started.bookId).toBeDefined()
    await vi.waitFor(() => {
      expect(loadedUrls.some((u) => u.includes('1.html'))).toBe(true)
    })
    const blocked = await checkUpdate(started.bookId!)
    expect(blocked).toEqual({ ok: false, message: LOCK_MSG })
    release()
    await waitForIdle()
  })

  it('refuses while startDownloadFromPage is running (VAL-DL-006)', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('2.html')) await gate
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })
    const startP = startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    const started = await startP
    expect(started.ok).toBe(true)
    if (!started.ok) {
      release()
      return
    }
    expect(started.bookId).toBeDefined()
    const blocked = await checkUpdate(started.bookId!)
    expect(blocked).toEqual({ ok: false, message: LOCK_MSG })
    release()
    await waitForIdle()
  })

  it('refuses while retryFailed holds the lock (VAL-DL-007)', async () => {
    const { bookId } = await seedSixChapterBook({ failSixth: true })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('6.html')) await gate
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })
    const retryP = retryFailed(bookId)
    await vi.waitFor(() => {
      expect(loadedUrls.some((u) => u.includes('6.html'))).toBe(true)
    })
    const blocked = await checkUpdate(bookId)
    expect(blocked).toEqual({ ok: false, message: LOCK_MSG })
    release()
    expect((await retryP).ok).toBe(true)
    await waitForIdle()
  })

  it('fails with Chinese when the catalog has zero chapter links (VAL-DL-009)', async () => {
    const { bookId, readySnapshots } = await seedSixChapterBook()
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return emptyCatalogHtml()
      return fixture('chapter.html')
    })
    const result = await checkUpdate(bookId)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(/[\u4e00-\u9fff]/)
    expect(result.message.length).toBeGreaterThan(0)
    expect(result.message).not.toContain('没有更新')
    const after = await loadBook(bookId)
    expect(after.id).toBe(bookId)
    expect(after.chapters).toHaveLength(6)
    for (const snap of readySnapshots) {
      const file = await readChapter(bookId, snap.id)
      expect(file.body).toBe(snap.body)
    }
    expect(await listBooks()).toHaveLength(1)
  })

  it('start still identities a download book from the current page (VAL-DL-014)', async () => {
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })
    const first = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.bookId).toBeDefined()
    expect(first.bookId!.startsWith('d_')).toBe(true)
    await waitForIdle()
    const second = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.bookId).toBe(first.bookId)
    await waitForIdle()
    const listed = await listBooks()
    expect(listed.filter((b) => b.importType === 'download')).toHaveLength(1)
    expect(listed[0].id).toBe(first.bookId)
  })

  it('emits progress, cancel releases the lock, and ready chapters remain (VAL-DL-015)', async () => {
    const { bookId, readySnapshots } = await seedSixChapterBook()
    const events: Array<{ status?: string; bookId?: string }> = []
    setOwnerWindow(progressWindow(events) as never)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('7.html')) await gate
      if (url.includes('index.html') || url.endsWith('/book/')) return catalogWithSeventh()
      return fixture('chapter.html')
    })
    const updating = checkUpdate(bookId)
    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThan(0)
    })
    cancelDownload(bookId)
    release()
    const accepted = await updating
    expect(accepted.ok).toBe(true)
    await waitForIdle()
    expect(cancelDownload).toBeTypeOf('function')
    const listed = await listBooks()
    expect(listed[0].id).toBe(bookId)
    for (const snap of readySnapshots) {
      const file = await readStoredChapter(bookId, snap.id)
      expect(file.body).toBe(snap.body)
    }
    loadedUrls.length = 0
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return catalogWithSeventh()
      return fixture('chapter.html')
    })
    const again = await checkUpdate(bookId)
    expect(again.ok === false && again.message === LOCK_MSG).toBe(false)
    if (again.ok) expect(again.added).toBeGreaterThanOrEqual(0)
    await waitForIdle()
  })

  it('counts only the new row when an old failed chapter is retried at the same time (VAL-DL-016)', async () => {
    const { bookId, readySnapshots } = await seedSixChapterBook({ failSixth: true })
    expect(readySnapshots).toHaveLength(5)
    const before = await loadBook(bookId)
    const sixthId = before.chapters[5].id
    const readyIds = readySnapshots.map((s) => s.id)
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return catalogWithSeventh()
      return fixture('chapter.html')
    })
    const result = await checkUpdate(bookId)
    expect(result).toEqual({ ok: true, bookId, added: 1 })
    await waitForIdle()
    const after = await loadBook(bookId)
    expect(after.chapters).toHaveLength(7)
    expect(after.chapters[5].id).toBe(sixthId)
    expect(loadedUrls.filter((u) => u.includes('6.html')).length).toBeGreaterThanOrEqual(1)
    const seventh = after.chapters.find((c) => c.url?.includes('7.html'))
    expect(seventh).toBeTruthy()
    expect(seventh!.id).not.toBe(sixthId)
    expect(readyIds).not.toContain(seventh!.id)
    expect(loadedUrls.filter((u) => /\/book\/[1-5]\.html$/.test(u))).toEqual([])
    for (const snap of readySnapshots) {
      const file = await readChapter(bookId, snap.id)
      expect(file.body).toBe(snap.body)
    }
  })

  it('still reports added=1 when the new row is Intercepted (VAL-DL-017)', async () => {
    const { bookId } = await seedSixChapterBook()
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return catalogWithSeventh()
      if (url.includes('7.html')) return interceptedHtml()
      return fixture('chapter.html')
    })
    const result = await checkUpdate(bookId)
    expect(result).toEqual({ ok: true, bookId, added: 1 })
    await waitForIdle()
    const after = await loadBook(bookId)
    const seventh = after.chapters.find((c) => c.url?.includes('7.html'))
    expect(seventh).toBeTruthy()
    expect(seventh!.status).not.toBe('ready')
    expect(seventh!.failCode).toBe('Intercepted')
    expect(seventh!.failMessage).toBe(FAIL_CODE_ZH.Intercepted)
    expect(loadedUrls.filter((u) => u.includes('7.html')).length).toBeGreaterThanOrEqual(1)
  })

  it('loads only the stored sourceUrl even if the browse page is another book (VAL-DL-018)', async () => {
    const { bookId } = await seedSixChapterBook()
    const guest = {
      webContents: {
        isDestroyed: () => false,
        getURL: () => 'https://other.example/catalog-b.html',
        executeJavaScript: async () => fixture('catalog.html'),
      },
    }
    setBrowseView(guest as never)
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('catalog-b')) throw new Error('must not load browse page B')
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })
    const result = await checkUpdate(bookId)
    expect(result).toEqual({ ok: true, bookId, added: 0 })
    await waitForIdle()
    expect(loadedUrls.every((u) => !u.includes('catalog-b') && !u.includes('other.example'))).toBe(true)
    expect(loadedUrls.some((u) => u.includes('https://example.com/book/index.html'))).toBe(true)
    const listed = await listBooks()
    expect(listed.map((b) => b.id)).toEqual([bookId])
    const after = await loadBook(bookId)
    expect(after.sourceUrl).toBe('https://example.com/book/index.html')
    expect(after.importType).toBe('download')
  })

  it('does not delete existing rows when the catalog shrinks (VAL-DL-020)', async () => {
    const { bookId, readySnapshots } = await seedSixChapterBook()
    const omitted = readySnapshots.find((s) => s.url?.includes('6.html'))
    expect(omitted).toBeTruthy()
    const rulesDir = await mkdtemp(join(tmpdir(), 'spbf-rules-short-'))
    setSiteRulesDir(rulesDir)
    try {
      await upsertSiteRule({ host: 'example.com', catalog: '#list' })
      setTestHtmlLoader(async (url) => {
        loadedUrls.push(url)
        if (url.includes('index.html') || url.endsWith('/book/')) return shortCatalogThree()
        return fixture('chapter.html')
      })
      const result = await checkUpdate(bookId)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.added).toBe(0)
      await waitForIdle()
      const after = await loadBook(bookId)
      expect(after.id).toBe(bookId)
      expect(after.chapters).toHaveLength(6)
      const omittedFile = await readChapter(bookId, omitted!.id)
      expect(omittedFile.body).toBe(omitted!.body)
    } finally {
      setSiteRulesDir(null)
      await rm(rulesDir, { recursive: true, force: true })
    }
  })

  it('applies isolated host rules when checking updates (VAL-DL-021)', async () => {
    const rulesDir = await mkdtemp(join(tmpdir(), 'spbf-rules-upd-'))
    setSiteRulesDir(rulesDir)
    try {
      const catalogUrl = 'http://127.0.0.1:5176/catalog.html'
      const ruleFixture = (name: string) =>
        readFileSync(join(import.meta.dirname, '../../fixtures/rule-site', name), 'utf-8')
      setTestHtmlLoader(async (url) => {
        loadedUrls.push(url)
        if (url.includes('c1.html')) return ruleFixture('c1.html')
        if (url.includes('c2.html')) return ruleFixture('c2.html')
        return ruleFixture('catalog.html')
      })
      const noRule = await startDownloadFromPage(ruleFixture('catalog.html'), catalogUrl)
      expect(noRule.ok).toBe(false)

      await upsertSiteRule({
        host: '127.0.0.1',
        title: '#spbf-title',
        author: '#spbf-author',
        catalog: '#spbf-toc',
        body: '#spbf-body',
      })
      const started = await startDownloadFromPage(ruleFixture('catalog.html'), catalogUrl)
      expect(started.ok).toBe(true)
      if (!started.ok) return
      expect(started.bookId).toBeDefined()
      await waitForIdle()
      loadedUrls.length = 0
      const result = await checkUpdate(started.bookId!)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.added).toBe(0)
      await waitForIdle()
      const isolatedRules = join(rulesDir, 'site-rules.json')
      expect(JSON.parse(await readFile(isolatedRules, 'utf-8')).rules[0].host).toBe('127.0.0.1')
      const userRules = join(process.env.APPDATA || '', 'spbf', 'site-rules.json')
      expect(isolatedRules.toLowerCase()).not.toBe(userRules.toLowerCase())
    } finally {
      setSiteRulesDir(null)
      await rm(rulesDir, { recursive: true, force: true })
    }
  })

  it('rejects a second checkUpdate / start / retryFailed while one is running (VAL-DL-022/023/024)', async () => {
    const { bookId } = await seedSixChapterBook({ failSixth: true })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('7.html') || url.includes('6.html')) await gate
      if (url.includes('index.html') || url.endsWith('/book/')) return catalogWithSeventh()
      return fixture('chapter.html')
    })
    const first = checkUpdate(bookId)
    await vi.waitFor(() => {
      expect(loadedUrls.some((u) => u.includes('6.html') || u.includes('7.html'))).toBe(true)
    })
    const second = await checkUpdate(bookId)
    expect(second).toEqual({ ok: false, message: LOCK_MSG })
    const startBlocked = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(startBlocked).toMatchObject({ ok: false, message: LOCK_MSG })
    const retryBlocked = await retryFailed(bookId)
    expect(retryBlocked).toEqual({ ok: false, message: LOCK_MSG })
    release()
    const accepted = await first
    expect(accepted.ok).toBe(true)
    await waitForIdle()
  })

  it('retries NavFailed twice then keeps the last failure', async () => {
    let hits = 0
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      if (url.includes('1.html')) {
        hits++
        throw new Error('temporary nav fail')
      }
      return fixture('chapter.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()
    expect(hits).toBe(1 + CHAPTER_RETRY_TIMES)
    const book = await loadBook(started.bookId!)
    const first = book.chapters.find((c) => c.url?.includes('1.html'))
    expect(first?.status).toBe('failed')
    expect(first?.failCode).toBe('NavFailed')
    expect(first?.failMessage).toMatch(/temporary nav fail/)
  })

  it('recovers a NavFailed chapter on the last retry', async () => {
    let hits = 0
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      if (url.includes('1.html')) {
        hits++
        if (hits < 1 + CHAPTER_RETRY_TIMES) throw new Error('flaky')
      }
      return fixture('chapter.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()
    expect(hits).toBe(1 + CHAPTER_RETRY_TIMES)
    const book = await loadBook(started.bookId!)
    expect(book.chapters.find((c) => c.url?.includes('1.html'))?.status).toBe('ready')
  })

  it('does not retry Intercepted chapter pages', async () => {
    let hits = 0
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      if (url.includes('1.html')) {
        hits++
        return interceptedHtml()
      }
      return fixture('chapter.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()
    expect(hits).toBe(1)
    const book = await loadBook(started.bookId!)
    expect(book.chapters.find((c) => c.url?.includes('1.html'))?.failCode).toBe('Intercepted')
  })

  it('returns NeedLogin / Intercepted codes so the library can send the user to browse', async () => {
    expect(checkUpdateFailHint('NeedLogin')).toEqual({
      goBrowse: true,
      message: '需要登录后才能看，请先到浏览页登录再检查更新',
    })
    expect(checkUpdateFailHint('Intercepted')).toEqual({
      goBrowse: true,
      message: '目录页被拦截或验证，请先到浏览页打开该站后再试',
    })
    expect(checkUpdateFailHint('CatalogNotFound')).toBeNull()

    const { bookId } = await seedSixChapterBook()
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('login-wall.html')
      return fixture('chapter.html')
    })
    const login = await checkUpdate(bookId)
    expect(login.ok).toBe(false)
    if (login.ok) return
    expect(login.code).toBe('NeedLogin')
    expect(login.message).toMatch(/登录/)

    loadedUrls.length = 0
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('intercepted.html')
      return fixture('chapter.html')
    })
    const blocked = await checkUpdate(bookId)
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.code).toBe('Intercepted')
    expect(blocked.message).toMatch(/拦截|验证/)
  })
})


describe('checkAllUpdates（全部检查更新）', () => {
  let dir: string
  const loadedUrls: string[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-dl-checkall-'))
    await setLibraryPath(dir)
    loadedUrls.length = 0
    resetDownloadStateForTests()
  })

  afterEach(async () => {
    resetDownloadStateForTests()
    await rm(dir, { recursive: true, force: true })
  })

  async function seedBook(suffix: string): Promise<string> {
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), `https://example.com/${suffix}/index.html`)
    if (!started.ok || !started.bookId) throw new Error(`seed ${suffix} failed`)
    await waitForIdle()
    loadedUrls.length = 0
    return started.bookId
  }

  function serveUpdatedCatalog(): void {
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html')) return catalogWithSeventh()
      return fixture('chapter.html')
    })
  }

  it('updates every download book serially and aggregates results', async () => {
    const a = await seedBook('alpha')
    const b = await seedBook('beta')
    serveUpdatedCatalog()

    const res = await checkAllUpdates()

    expect(res.ok).toBe(true)
    expect(res.total).toBe(2)
    expect(res.checked).toBe(2)
    expect(res.booksWithUpdates).toBe(2)
    expect(res.results).toHaveLength(2)
    expect(res.results.every((r) => r.ok)).toBe(true)
    for (const id of [a, b]) {
      const book = await loadBook(id)
      expect(book.chapters).toHaveLength(7)
      expect(book.chapters[6].status).toBe('ready')
    }
  })

  it('skips imported books and books without sourceUrl', async () => {
    await createBookFromBootstrap({
      bookId: 'i_txt_only',
      title: '导入的书',
      author: '',
      importType: 'txt',
      chapterTitles: ['第一章'],
    })
    const real = await seedBook('real')
    serveUpdatedCatalog()

    const res = await checkAllUpdates()

    expect(res.total).toBe(1)
    expect(res.checked).toBe(1)
    expect(res.results).toHaveLength(1)
    expect(res.results[0]).toMatchObject({ ok: true, bookId: real, added: 1 })
  })

  it('refuses while another download job holds the lock', async () => {
    const bookId = await seedBook('lock')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('7.html') || url.includes('6.html')) await gate
      if (url.includes('index.html')) return catalogWithSeventh()
      return fixture('chapter.html')
    })
    const first = checkUpdate(bookId)
    await vi.waitFor(() => {
      expect(loadedUrls.some((u) => u.includes('6.html') || u.includes('7.html'))).toBe(true)
    })

    const blocked = await checkAllUpdates()

    expect(blocked.ok).toBe(false)
    expect(blocked.message).toBe(LOCK_MSG)
    release()
    expect((await first).ok).toBe(true)
    await waitForIdle()
  })

  it('cancelCheckAll stops before the remaining books', async () => {
    await seedBook('one')
    await seedBook('two')

    let cancelFired = false
    setOwnerWindow({
      contentView: {
        addChildView(): void {},
        removeChildView(): void {},
      },
      webContents: {
        send(channel: string): void {
          if (channel === 'download.checkAll.progress' && !cancelFired) {
            cancelFired = true
            cancelCheckAll()
          }
        },
      },
    } as unknown as Parameters<typeof setOwnerWindow>[0])

    serveUpdatedCatalog()
    const res = await checkAllUpdates()

    expect(cancelFired).toBe(true)
    expect(res.total).toBe(2)
    expect(res.checked).toBe(1)
    expect(res.results[0].ok).toBe(true)
    // 只补完第一本，另一本保持 6 章
    const counts = (await listBooks()).map((x) => x.chapterCount).sort((a, b) => a - b)
    expect(counts).toEqual([6, 7])
  })
})
