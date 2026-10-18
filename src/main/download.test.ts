import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { beginLibraryRestore } from './libraryMaintenance'
import { setMainFrameStatusForTests } from './httpStatus'

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
  isSiteWallFail,
  openUnblock,
  resumeUnblock,
  RATE_LIMIT_MAX_TRIES,
  RATE_LIMIT_STOP_COUNT,
  WALL_PAUSE_STREAK,
  checkAllUpdates,
  checkUpdate,
  checkUpdateFailHint,
  failedChapterReason,
  CHAPTER_RETRY_TIMES,
  DOWNLOAD_SESSION_PARTITION,
  followCatalogIfNeeded,
  getHiddenView,
  HIDDEN_VIEW_BOUNDS,
  identityFromPage,
  isDownloadBusy,
  resetDownloadStateForTests,
  setBrowseView,
  setOwnerWindow,
  setTestHtmlLoader,
  setTestScriptRunner,
  retryFailed,
  previewDownload,
  confirmDownload,
  previewCurrentSiteRule,
  redownloadChapter,
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
  bookExists,
  bookIdFromUrl,
  canonicalBookId,
  createBookFromBootstrap,
  listBooks,
  loadBook,
  readChapter,
  saveBook,
  setLibraryPath,
  updateChapterBody,
  writeChapterFile,
} from './library'
import { extractPage } from './extract'
import { setSiteRulesDir, upsertSiteRule } from './siteRules'
import { __setOcrEngineForTests as setOcrEngineForTests } from './ocrText'
import { setAtomicWriteBeforeCommitForTests } from './atomicFile'
import { FAIL_CODE_ZH, type DownloadBlocked, type DownloadProgress } from '../shared/types'

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+g6wAAAAASUVORK5CYII='

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '../../fixtures', name), 'utf-8')

describe('failedChapterReason', () => {
  it('prefers failMessage, then FAIL_CODE_ZH, then the empty-body sentence', () => {
    expect(failedChapterReason({ failMessage: '  目录丢了  ', failCode: 'NeedLogin' })).toBe('目录丢了')
    expect(failedChapterReason({ failCode: 'NavFailed' })).toBe(FAIL_CODE_ZH.NavFailed)
    expect(failedChapterReason({})).toBe('正文为空或过短')
    expect(failedChapterReason({ failMessage: '   ' })).toBe('正文为空或过短')
  })
})

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
    expect(id.bookId).toBe(canonicalBookId(id.host, id.catalogUrl))
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
    expect(id.bookId).toBe(canonicalBookId('www.bqg858.cc', 'https://www.bqg858.cc/#/book/65/'))
    expect(id.bookId).not.toBe(canonicalBookId('www.bqg858.cc', 'https://www.bqg858.cc/'))
  })

  it('hash chapter identityFromPage equals catalog bookId; bare path does not (VAL-IDENT-018)', async () => {
    const host = 'www.bqg858.cc'
    const hashCatalog = 'https://www.bqg858.cc/#/book/65/'
    const hashChapter = 'https://www.bqg858.cc/#/book/65/1.html'
    const bareCatalog = 'https://www.bqg858.cc/book/65/'
    const bareChapter = 'https://www.bqg858.cc/book/65/1.html'
    const catalogId = canonicalBookId(host, hashCatalog)

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
    expect(fromBareCatalog.bookId).toBe(canonicalBookId(host, bareCatalog))
    expect(fromBareCatalog.bookId).not.toBe(catalogId)

    const bareChapterPage = extractPage(chapterHtml, bareChapter)
    expect(bareChapterPage.pageKind).toBe('chapter')
    const fromBareChapter = identityFromPage(bareChapter, bareChapterPage.bootstrap!)
    expect(fromBareChapter.bookId).not.toBe(catalogId)
    expect(fromBareChapter.bookId).not.toBe(canonicalBookId(host, hashChapter))
  })

  it('Alice chapter recovers chapters catalog as one bookId; novel without recovery is documented (VAL-IDENT-021)', async () => {
    const host = 'www.alicesw.com'
    const chaptersCatalog = 'https://www.alicesw.com/other/chapters/id/44828.html'
    const novelUrl = 'https://www.alicesw.com/novel/44828.html'
    const chapterUrl = 'https://www.alicesw.com/book/46268/9c5ec36414c68.html'
    const catalogId = canonicalBookId(host, chaptersCatalog)

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
    expect(fromChapter.bookId).not.toBe(canonicalBookId(host, chapterUrl))
    expect(fromChapter.bookId).not.toBe(canonicalBookId(host, 'https://www.alicesw.com/book/46268/'))

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
      : canonicalBookId(host, novelUrl)
    if (novelPage.ok && novelPage.bootstrap?.catalogUrl?.includes('/other/chapters/id/44828.html')) {
      expect(novelId).toBe(catalogId)
    } else {
      // Live tests must paste only the chapters URL (VAL-DL-001). Do not start from
      // /novel/44828.html — that would be a second Alice card for the same title.
      expect(novelId).not.toBe(catalogId)
      expect(canonicalBookId(host, novelUrl)).not.toBe(catalogId)
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

  it('retries NavFailed / BodyEmpty / RateLimited and backs off with jitter outside tests', () => {
    expect(shouldRetryChapterFail('NavFailed')).toBe(true)
    expect(shouldRetryChapterFail('BodyEmpty')).toBe(true)
    expect(shouldRetryChapterFail('RateLimited')).toBe(true)
    expect(shouldRetryChapterFail('Intercepted')).toBe(false)
    expect(shouldRetryChapterFail('NeedLogin')).toBe(false)
    expect(shouldRetryChapterFail('Paywall')).toBe(false)
    expect([isSiteWallFail('NeedLogin'), isSiteWallFail('Paywall'), isSiteWallFail('Intercepted')]).toEqual([
      true,
      true,
      true,
    ])
    expect([isSiteWallFail('NavFailed'), isSiteWallFail('BodyEmpty'), isSiteWallFail('CatalogNotFound')]).toEqual([
      false,
      false,
      false,
    ])
    expect([isSiteWallFail('RateLimited')]).toEqual([false])
    expect(CHAPTER_RETRY_TIMES).toBe(2)
    resetDownloadStateForTests()
    const atRandom = (value: number, attempt: number) =>
      chapterRetryDelayMs(attempt, { testing: false, random: () => value })
    expect(atRandom(1, 1)).toBe(1000)
    expect(atRandom(1, 2)).toBe(2000)
    expect(atRandom(1, 3)).toBe(4000)
    expect(atRandom(0, 1)).toBe(500)
    expect(atRandom(0, 2)).toBe(1000)
    expect(atRandom(1, 12)).toBe(30_000)
    expect(atRandom(0, 12)).toBe(15_000)
    expect(RATE_LIMIT_MAX_TRIES).toBe(2)
    expect(RATE_LIMIT_STOP_COUNT).toBe(3)
    expect(WALL_PAUSE_STREAK).toBe(3)
  })

  it('uses zero retry delay when a test html loader is injected', () => {
    setTestHtmlLoader(async () => '<html></html>')
    expect(chapterRetryDelayMs(1)).toBe(0)
    resetDownloadStateForTests()
  })

  it('maps download pace to a fixed chapter gap and treats unknown values as standard', () => {
    expect(chapterGapMs('slow')).toBe(2000)
    expect(chapterGapMs('standard')).toBe(600)
    expect(chapterGapMs('fast')).toBe(200)
    expect(chapterGapMs('turbo' as 'standard')).toBe(600)
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

  it('rejects a new download while the library is restoring', async () => {
    const release = beginLibraryRestore()
    try {
      await expect(startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/'))
        .resolves.toMatchObject({ ok: false, message: '书库正在恢复，请稍后再试' })
      expect(loadedUrls).toEqual([])
    } finally {
      release()
    }
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
    await expect(loadBook(canonicalBookId('example.com', 'https://example.com/book/login-wall.html'))).rejects.toThrow()
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
    expect(result.bookId).toBe(canonicalBookId('example.com', book.sourceUrl || ''))
    expect(loadedUrls.some((u) => u.includes('/book/') && !u.includes('.html'))).toBe(true)
  })

  it('同一本书的 www 与裸主机地址只建一本', async () => {
    // 章节目录链接改成站内相对路径，章节主机才跟着页面主机走，两种地址都能认成同一本书
    const relativeCatalog = fixture('catalog.html').replace(/https:\/\/example\.com/g, '')
    const first = await startDownloadFromPage(relativeCatalog, 'https://www.example.com/book/')
    expect(first.ok).toBe(true)
    await waitForIdle()

    const second = await startDownloadFromPage(relativeCatalog, 'https://example.com/book/')
    expect(second.ok).toBe(true)
    await waitForIdle()

    expect(second.bookId).toBe(first.bookId)
    expect(await listBooks()).toHaveLength(1)
    expect(await bookExists(canonicalBookId('example.com', 'https://example.com/book/'))).toBe(true)
    expect(loadedUrls.some((u) => u.startsWith('https://www.example.com/book/1.html'))).toBe(true)
  })

  it('老库按带 www 的旧键建好的书，重新下载时复用而不是新开一本', async () => {
    const legacyId = bookIdFromUrl('www.example.com', 'https://www.example.com/book/')
    await createBookFromBootstrap({
      bookId: legacyId,
      title: '万古神帝',
      author: '飞天鱼',
      sourceUrl: 'https://www.example.com/book/',
      sourceHost: 'www.example.com',
      importType: 'download',
      chapterTitles: ['第一章 前世记忆'],
      chapterUrls: ['https://example.com/book/1.html'],
    })

    const result = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/')
    expect(result.ok).toBe(true)
    await waitForIdle()

    expect(result.bookId).toBe(legacyId)
    expect(await listBooks()).toHaveLength(1)
    expect(await bookExists(canonicalBookId('example.com', 'https://example.com/book/'))).toBe(false)
  })

  it('uses the displayed guest HTML/URL, not an uncommitted draft', async () => {
    const draftUrl = 'https://evil.example/uncommitted-draft'
    const result = await startDownloadFromPage(
      fixture('catalog.html'),
      'https://example.com/book/index.html',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bookId).toBe(canonicalBookId('example.com', 'https://example.com/book/index.html'))
    expect(result.bookId).not.toBe(canonicalBookId('evil.example', draftUrl))
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

  it('previews without writing and rejects confirmation after navigation', async () => {
    let currentUrl = 'https://example.com/book/index.html'
    const { win } = trackingWindow()
    setOwnerWindow(win as never)
    setBrowseView({ webContents: {
      isDestroyed: () => false,
      getURL: () => currentUrl,
      executeJavaScript: async () => fixture('catalog.html'),
    } } as never)
    setTestHtmlLoader(async (url) => url.includes('index.html') ? fixture('catalog.html') : fixture('chapter.html'))
    const preview = await previewDownload()
    expect(preview.ok).toBe(true)
    expect(await listBooks()).toHaveLength(0)
    if (!preview.ok) return
    expect(preview.preview.chapterCount).toBeGreaterThan(0)
    currentUrl = 'https://example.com/other'
    expect(await confirmDownload(preview.preview.token)).toMatchObject({ ok: false })
    expect(await listBooks()).toHaveLength(0)
  })

  it('confirms a preview only once and downloads through the hidden loader', async () => {
    const { win } = trackingWindow()
    setOwnerWindow(win as never)
    setBrowseView({ webContents: {
      isDestroyed: () => false,
      getURL: () => 'https://example.com/book/index.html',
      executeJavaScript: async () => fixture('catalog.html'),
    } } as never)
    setTestHtmlLoader(async (url) => url.includes('index.html') ? fixture('catalog.html') : fixture('chapter.html'))
    const preview = await previewDownload()
    if (!preview.ok) throw new Error(preview.message)
    const confirmed = await confirmDownload(preview.preview.token)
    expect(confirmed.ok).toBe(true)
    expect(await confirmDownload(preview.preview.token)).toMatchObject({ ok: false })
    await waitForIdle()
    expect((await listBooks()).length).toBe(1)
  })

  it('keeps the old body and URL when one-chapter re-extraction fails', async () => {
    await createBookFromBootstrap({ bookId: 'd_repair', title: '修复测试', author: '',
      importType: 'download', chapterTitles: ['第一章'],
      chapterUrls: ['https://example.com/old.html'] })
    await writeChapterFile('d_repair', 'c0001', {
      title: '第一章', url: 'https://example.com/old.html', body: '原来的正文', status: 'ready',
    })
    setTestHtmlLoader(async () => fixture('login-wall.html'))
    expect((await redownloadChapter('d_repair', 'c0001', 'https://example.com/new.html')).ok).toBe(false)
    expect((await readChapter('d_repair', 'c0001')).body).toBe('原来的正文')
    expect((await loadBook('d_repair')).chapters[0].url).toBe('https://example.com/old.html')
    setTestHtmlLoader(async () => fixture('chapter.html'))
    expect((await redownloadChapter('d_repair', 'c0001', 'https://example.com/new.html')).ok).toBe(true)
    expect((await loadBook('d_repair')).chapters[0].url).toBe('https://example.com/new.html')
  })

  it('tests unsaved selectors against the current site and sample chapter', async () => {
    setBrowseView({ webContents: {
      isDestroyed: () => false,
      getURL: () => 'https://example.com/book/index.html',
      executeJavaScript: async () => fixture('catalog.html'),
    } } as never)
    setTestHtmlLoader(async () => fixture('chapter.html'))
    const result = await previewCurrentSiteRule({
      host: 'example.com', title: 'h1', author: '.author', catalog: '#list', body: '#content',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.preview.chapterCount).toBe(6)
      expect(result.preview.diagnostics).toMatchObject({ title: '已命中', author: '已命中', catalog: '已命中', body: '已命中' })
      expect(result.preview.bodySample).toContain('张若尘')
    }
    expect(await previewCurrentSiteRule({ host: 'elsewhere.com' })).toMatchObject({ ok: false })
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

  it('saves cleaned text and raw text separately so a chapter can be restored', async () => {
    await upsertSiteRule(matching)
    const story = '夜风吹过城墙，林舟看见远处的灯火。他把信收进袖中，沿着石阶继续前行。第二天清晨，船终于靠岸，众人商量入城路线，把行李分给同行伙伴，约定天黑前在旧桥旁会合。'
    setTestHtmlLoader(async (url) => url.includes('catalog.html')
      ? ruleFixture('catalog.html')
      : `<html><body><div id="spbf-body"><p>${story}</p><p>最新网址：www.example.com，请收藏本站网址以便继续阅读</p><p>${story}</p></div></body></html>`)
    const started = await startDownloadFromPage(ruleFixture('catalog.html'), catalogUrl)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()
    const book = await loadBook(started.bookId!)
    const first = await readChapter(book.id, book.chapters[0].id)
    expect(first.bodyRaw).toContain('最新网址')
    expect(first.body).not.toContain('最新网址')
    await updateChapterBody(book.id, book.chapters[0].id, '', true)
    const restored = await readChapter(book.id, book.chapters[0].id)
    expect(restored.body).toBe(first.bodyRaw)
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

function progressWindow(events: unknown[], blocked: unknown[] = []): {
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
        if (channel === 'download.blocked') blocked.push(payload)
      },
    },
  }
}

/** 等下载循环停在「等你本人处理」上：撞墙暂停不会自己结束，用例必须显式续跑或取消。 */
async function waitForBlocked(blocked: unknown[], minCount = 1, timeoutMs = 15_000): Promise<DownloadBlocked> {
  const started = Date.now()
  while (blocked.length < minCount) {
    if (Date.now() - started > timeoutMs) throw new Error('download never paused for the user')
    await new Promise((r) => setTimeout(r, 20))
  }
  return blocked[blocked.length - 1] as DownloadBlocked
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
    expect(result).toEqual({ ok: true, bookId, added: 0, changed: 0 })
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

  it('retryFailed leaves chapter status unchanged when the catalog cannot be opened', async () => {
    const { bookId, readySnapshots } = await seedSixChapterBook({ failSixth: true })
    const before = await loadBook(bookId)
    const snapshot = before.chapters.map((ch) => ({
      id: ch.id,
      status: ch.status,
      failCode: ch.failCode,
      failMessage: ch.failMessage,
    }))
    expect(snapshot.filter((ch) => ch.status === 'ready')).toHaveLength(5)
    expect(snapshot.filter((ch) => ch.status === 'failed')).toHaveLength(1)
    const bookStatus = before.status

    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) throw new Error('目录打不开')
      return fixture('chapter.html')
    })
    const thrown = await retryFailed(bookId)
    expect(thrown.ok).toBe(false)
    if (thrown.ok) return
    expect(thrown.message).toContain('目录打不开')

    loadedUrls.length = 0
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return emptyCatalogHtml()
      return fixture('chapter.html')
    })
    const empty = await retryFailed(bookId)
    expect(empty).toEqual({ ok: false, message: '目录页无法访问或内容变化' })
    expect(loadedUrls.filter((u) => /\/book\/[1-6]\.html$/.test(u))).toEqual([])

    const after = await loadBook(bookId)
    expect(after.status).toBe(bookStatus)
    expect(after.chapters.map((ch) => ({
      id: ch.id,
      status: ch.status,
      failCode: ch.failCode,
      failMessage: ch.failMessage,
    }))).toEqual(snapshot)
    for (const snap of readySnapshots) {
      const file = await readChapter(bookId, snap.id)
      expect(file.status).toBe('ready')
      expect(file.body).toBe(snap.body)
    }
    expect(await listBooks()).toHaveLength(1)
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
    // 已全部下好：不静默报「完成」，而是明确告诉用户并回同一本书的 id
    expect(second.ok).toBe(false)
    expect(second.bookId).toBe(first.bookId)
    expect(second.message).toContain('都已经下载好了')
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

  it('releases the download lock when the retry backoff is cancelled (VAL-DL-015b)', async () => {
    const { bookId } = await seedSixChapterBook({ failSixth: true })
    const events: Array<{ status?: string }> = []
    let chapterFailures = 0
    setOwnerWindow(progressWindow(events) as never)
    // 交回真实退避时长：测试加载器存在时 chapterRetryDelayMs 返回 0，取消就落不进退避窗口
    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      setTestHtmlLoader(null)
      chapterFailures++
      throw new Error('导航失败')
    })
    const started = await retryFailed(bookId)
    expect(started.ok).toBe(true)
    // 必须等到退避已经开始再取消：循环顶部的 cancelled 检查会干净退出，走不到抛出的那一步
    await vi.waitFor(() => expect(chapterFailures).toBeGreaterThan(0), { timeout: 2_000, interval: 1 })

    cancelDownload(bookId)

    await vi.waitFor(() => expect(isDownloadBusy()).toBe(false), { timeout: 4_000 })
    expect((await loadBook(bookId)).status).not.toBe('downloading')
    expect(events.some((p) =>
      p.status === 'cancelled' || p.status === 'error' || p.status === 'done')).toBe(true)

    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })
    const retryAfter = await retryFailed(bookId)
    expect(retryAfter.ok).toBe(true)
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
    expect(result).toEqual({ ok: true, bookId, added: 1, changed: 0 })
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
    expect(result).toEqual({ ok: true, bookId, added: 1, changed: 0 })
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
    expect(result).toEqual({ ok: true, bookId, added: 0, changed: 0 })
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

  it('stores a VIP teaser as a failed Paywall chapter, never as ready', async () => {
    let hits = 0
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      if (url.includes('1.html')) {
        hits++
        return fixture('paywall-vip.html')
      }
      return fixture('chapter.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()
    expect(hits).toBe(1)
    const book = await loadBook(started.bookId!)
    const paid = book.chapters.find((c) => c.url?.includes('1.html'))
    expect(paid?.status).toBe('failed')
    expect(paid?.failCode).toBe('Paywall')
    expect(paid?.failMessage).toBe('本章需要付费或会员')
    expect(book.chapters.filter((c) => c.status === 'ready').length).toBe(5)
  })

  it('recovers a paywalled chapter from hidden nodes and records how it was unlocked', async () => {
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      if (url.includes('1.html')) return fixture('paywall-hidden-dom.html')
      return fixture('chapter.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()
    const book = await loadBook(started.bookId!)
    const unlocked = book.chapters.find((c) => c.url?.includes('1.html'))
    expect(unlocked?.status).toBe('ready')
    expect(unlocked?.failCode).toBeUndefined()
    const file = await readChapter(started.bookId!, unlocked!.id)
    expect(file.unlockedBy).toBe('hiddenDom')
    expect(file.body).toContain('他数着那盏灯晃动的次数')
    expect(book.chapters.filter((c) => c.status === 'ready').length).toBe(6)
  })

  it('asks the site chapter API in page context when DOM recovery fails', async () => {
    const apiBody = '旧桥那头的灯笼忽然矮了一截，像是被谁按住了灯杆。林舟停住脚，听见桥下冰面裂开的声音。'.repeat(8)
    const scripts: string[] = []
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      if (url.includes('1.html')) return fixture('paywall-api.html')
      return fixture('chapter.html')
    })
    setTestScriptRunner(async (script) => {
      scripts.push(script)
      return JSON.stringify([
        { url: 'https://example.com/ajax/chapter?cid=1', status: 200, text: JSON.stringify({ code: 0, data: { content: apiBody } }) },
      ])
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()
    expect(scripts.length).toBe(1)
    expect(scripts[0]).toContain("credentials: 'include'")
    expect(scripts[0]).toContain('ajax/chapter')
    const book = await loadBook(started.bookId!)
    const viaApi = book.chapters.find((c) => c.url?.includes('1.html'))
    expect(viaApi?.status).toBe('ready')
    expect(viaApi?.unlockedBy).toBe('api')
    const file = await readChapter(started.bookId!, viaApi!.id)
    expect(file.unlockedBy).toBe('api')
    expect(file.body).toContain('旧桥那头的灯笼忽然矮了一截')
  })

  it('site rule can turn off automatic unlock and the wall stays a wall', async () => {
    const rulesDir = await mkdtemp(join(tmpdir(), 'spbf-rules-api-'))
    setSiteRulesDir(rulesDir)
    try {
      await upsertSiteRule({ host: 'example.com', paywallUnlock: false })
      setTestHtmlLoader(async (url) => {
        loadedUrls.push(url)
        if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
        if (url.includes('1.html')) return fixture('paywall-api.html')
        return fixture('chapter.html')
      })
      let scriptCalls = 0
      setTestScriptRunner(async () => {
        scriptCalls++
        return '[]'
      })
      const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
      expect(started.ok).toBe(true)
      if (!started.ok) return
      await waitForIdle()
      const book = await loadBook(started.bookId!)
      const walled = book.chapters.find((c) => c.url?.includes('1.html'))
      expect(walled?.status).toBe('failed')
      expect(walled?.failCode).toBe('Paywall')
      expect(scriptCalls).toBe(0)
    } finally {
      setSiteRulesDir(null)
      await rm(rulesDir, { recursive: true, force: true })
    }
  })

  it('站点开了 OCR 开关时，图片正文走 OCR 认字入库', async () => {
    const rulesDir = await mkdtemp(join(tmpdir(), 'spbf-rules-ocr-'))
    setSiteRulesDir(rulesDir)
    const ocrBody =
      '雪下得很密，灯罩上结了薄薄一层白。林舟把灯笼搁在石阶上，蹲下去看那道刻痕，指尖碰到的地方凉得像铁。'.repeat(6)
    try {
      await upsertSiteRule({ host: 'example.com', ocrUnlock: true })
      setTestHtmlLoader(async (url) => {
        loadedUrls.push(url)
        if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
        if (url.includes('1.html')) return fixture('paywall-ocr.html')
        return fixture('chapter.html')
      })
      const ocrScripts: string[] = []
      setTestScriptRunner(async (script) => {
        ocrScripts.push(script)
        return JSON.stringify({ images: [{ src: PNG_DATA_URL }], redraw: [] })
      })
      setOcrEngineForTests({
        async recognize() {
          return { data: { text: ocrBody } }
        },
      })
      const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
      expect(started.ok).toBe(true)
      if (!started.ok) return
      await waitForIdle()
      expect(ocrScripts.length).toBe(1)
      expect(ocrScripts[0]).toContain('document.fonts.ready')
      const book = await loadBook(started.bookId!)
      const viaOcr = book.chapters.find((c) => c.url?.includes('1.html'))
      expect(viaOcr?.status).toBe('ready')
      expect(viaOcr?.unlockedBy).toBe('ocr')
      const file = await readChapter(started.bookId!, viaOcr!.id)
      expect(file.unlockedBy).toBe('ocr')
      expect(file.body).toContain('雪下得很密')
    } finally {
      setOcrEngineForTests(null)
      setSiteRulesDir(null)
      await rm(rulesDir, { recursive: true, force: true })
    }
  })

  it('人工提示里写明自动恢复为什么没成', async () => {
    const events: Array<{ status?: string }> = []
    const blocked: unknown[] = []
    setOwnerWindow(progressWindow(events, blocked) as never)
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('paywall-api.html')
    })
    setTestScriptRunner(async () => '[]')
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const payload = await waitForBlocked(blocked)
    expect(payload.failCode).toBe('Paywall')
    expect(payload.message).toMatch(/自动恢复已试过/)
    expect(payload.message).toMatch(/章节接口也没拿到正文/)
    cancelDownload(started.bookId!)
    await waitForIdle()
  })

  it('glues hidden continuation pages onto the recovered chapter', async () => {    const pagedFirstPage = fixture('paywall-hidden-dom.html').replace(
      '<div class="footer">',
      '<a href="1.html?page=2" style="display:none">下一页</a><div class="footer">',
    )
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      if (url.includes('page=2')) return fixture('chapter.html')
      if (url.includes('1.html')) return pagedFirstPage
      return fixture('chapter.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()
    expect(loadedUrls.some((url) => url.includes('page=2'))).toBe(true)
    const book = await loadBook(started.bookId!)
    const glued = book.chapters.find((c) => c.url?.includes('1.html'))
    expect(glued?.status).toBe('ready')
    const file = await readChapter(started.bookId!, glued!.id)
    expect(file.unlockedBy).toBe('paged')
    expect(file.body).toContain('他数着那盏灯晃动的次数')
    expect(file.body).toContain('张若尘从梦中惊醒')
  })

  it('pauses on the third same-kind wall chapter and waits for the user', async () => {
    const chapterHits: string[] = []
    const events: Array<{ status?: string; lastError?: string }> = []
    const blocked: unknown[] = []
    setOwnerWindow(progressWindow(events, blocked) as never)
    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      chapterHits.push(url)
      return fixture('login-wall.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const payload = await waitForBlocked(blocked)
    expect(chapterHits.length).toBe(WALL_PAUSE_STREAK)
    expect(payload).toMatchObject({
      bookId: started.bookId,
      chapterTitle: '第三章 入门',
      url: 'https://example.com/book/3.html',
      failCode: 'NeedLogin',
    })
    expect(payload.message).toMatch(/需要登录[\s\S]*已暂停本次下载/)
    expect(events.at(-1)?.status).toBe('awaitingHuman')
    const book = await loadBook(started.bookId!)
    expect(book.chapters.filter((c) => c.status === 'failed').length).toBe(WALL_PAUSE_STREAK)
    expect(book.chapters.filter((c) => c.status === 'pending').length).toBe(6 - WALL_PAUSE_STREAK)
    // 撞墙暂停不是结束态：进度里不该带失败章明细
    expect(events.at(-1)).not.toHaveProperty('failedChapters')
    expect(isDownloadBusy()).toBe(true)
    cancelDownload(started.bookId!)
    await waitForIdle()
  })

  it('fills every chapter after the user handles the wall and resumes', async () => {
    const chapterHits: string[] = []
    const events: Array<{ status?: string }> = []
    const blocked: unknown[] = []
    setOwnerWindow(progressWindow(events, blocked) as never)
    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      chapterHits.push(url)
      return fixture('login-wall.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForBlocked(blocked)
    expect(await resumeUnblock('no-such-book')).toMatchObject({ ok: false })

    // 用户在浏览页用自己的账号登录好了：换成能拿到正文的页面
    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      chapterHits.push(url)
      return fixture('chapter.html')
    })
    expect(await resumeUnblock(started.bookId!)).toEqual({ ok: true })
    expect(await resumeUnblock(started.bookId!)).toMatchObject({ ok: false, message: '当前下载没有在等待处理' })
    await waitForIdle()
    expect(chapterHits.length).toBe(6 + WALL_PAUSE_STREAK)
    const book = await loadBook(started.bookId!)
    expect(book.chapters.filter((c) => c.status === 'ready').length).toBe(6)
    expect(events.at(-1)?.status).toBe('done')
    expect(isDownloadBusy()).toBe(false)
  })

  it('keeps the wall chapters for retryFailed when the user cancels instead of resuming', async () => {
    const blocked: unknown[] = []
    const events: Array<{ status?: string }> = []
    setOwnerWindow(progressWindow(events, blocked) as never)
    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('login-wall.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForBlocked(blocked)
    cancelDownload(started.bookId!)
    await waitForIdle()
    expect(events.at(-1)?.status).toBe('cancelled')
    const stopped = await loadBook(started.bookId!)
    expect(stopped.status).toBe('partial')
    expect(stopped.chapters.filter((c) => c.status === 'failed').length).toBe(WALL_PAUSE_STREAK)

    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })
    expect((await retryFailed(started.bookId!)).ok).toBe(true)
    await waitForIdle()
    const book = await loadBook(started.bookId!)
    expect(book.chapters.filter((c) => c.status === 'ready').length).toBe(6)
    expect(isDownloadBusy()).toBe(false)
  })

  it('maps HTTP 402 to Paywall without storing the teaser as a chapter', async () => {
    setMainFrameStatusForTests('https://example.com/book/1.html', 402)
    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      if (url.includes('1.html')) return fixture('paywall-vip.html')
      return fixture('chapter.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()
    const book = await loadBook(started.bookId!)
    const paid = book.chapters.find((c) => c.url?.endsWith('/1.html'))
    expect(paid?.status).toBe('failed')
    expect(paid?.failCode).toBe('Paywall')
    expect(paid?.failMessage).toMatch(/HTTP 402/)
  })

  it('never fetches a rate-limited chapter body and settles it as a retryable rate limit', async () => {
    const chapterHits: string[] = []
    const events: Array<{ status?: string }> = []
    const blocked: unknown[] = []
    setOwnerWindow(progressWindow(events, blocked) as never)
    setMainFrameStatusForTests('https://example.com/book/1.html', 429)
    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      chapterHits.push(url)
      return fixture('chapter.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()
    expect(chapterHits.filter((u) => u.endsWith('/1.html')).length).toBe(0)
    expect(chapterHits.filter((u) => u.endsWith('/2.html')).length).toBe(1)
    const book = await loadBook(started.bookId!)
    const throttled = book.chapters.find((c) => c.url?.endsWith('/1.html'))
    expect(throttled?.status).toBe('failed')
    expect(throttled?.failCode).toBe('RateLimited')
    expect(throttled?.failMessage).toMatch(/HTTP 429/)
    // 限流是站点负载信号，不是访问控制：不该拦下来等用户本人处理
    expect(blocked).toEqual([])
    expect(events.at(-1)?.status).toBe('error')
  })

  it('stops politely after consecutive rate-limited chapters instead of hammering the site', async () => {
    const chapterHits: string[] = []
    const events: Array<{ status?: string; lastError?: string }> = []
    const blocked: unknown[] = []
    setOwnerWindow(progressWindow(events, blocked) as never)
    for (const n of [1, 2, 3]) setMainFrameStatusForTests(`https://example.com/book/${n}.html`, 429)
    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      chapterHits.push(url)
      return fixture('chapter.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()
    expect(chapterHits).toEqual([])
    expect(blocked).toEqual([])
    const book = await loadBook(started.bookId!)
    expect(book.chapters.filter((c) => c.failCode === 'RateLimited').length).toBe(RATE_LIMIT_STOP_COUNT)
    expect(book.chapters.filter((c) => c.status === 'pending').length).toBe(6 - RATE_LIMIT_STOP_COUNT)
    expect(book.status).toBe('partial')
    expect(events.at(-1)?.status).toBe('error')
    expect(events.at(-1)?.lastError).toMatch(/站点连续限流/)
  })

  it('hands the user the blocked chapter when the whole site answers HTTP 403', async () => {
    const chapterHits: string[] = []
    const events: Array<{ status?: string }> = []
    const blocked: unknown[] = []
    setOwnerWindow(progressWindow(events, blocked) as never)
    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      chapterHits.push(url)
      setMainFrameStatusForTests(url, 403)
      return '<html><body><div id="content">Access Denied</div></body></html>'
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const payload = await waitForBlocked(blocked)
    expect(chapterHits.length).toBe(WALL_PAUSE_STREAK)
    expect(payload.failCode).toBe('Intercepted')
    expect(payload.url).toBe('https://example.com/book/3.html')
    const book = await loadBook(started.bookId!)
    expect(book.chapters.find((c) => c.url?.endsWith('/1.html'))?.failCode).toBe('Intercepted')
    cancelDownload(started.bookId!)
    await waitForIdle()
    expect((await loadBook(started.bookId!)).status).toBe('partial')
    expect(events.at(-1)?.status).toBe('cancelled')
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
    expect(checkUpdateFailHint('RateLimited')).toEqual({
      goBrowse: false,
      message: '站点限流，请稍后再试',
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

  it('opens just the blocked chapter in the browse view for the user to unlock', async () => {
    const navigated: string[] = []
    setBrowseView(
      {
        webContents: {
          isDestroyed: () => false,
          getURL: () => 'https://example.com/book/index.html',
          executeJavaScript: async () => fixture('catalog.html'),
          loadURL: async (url: string) => {
            navigated.push(url)
          },
        },
      } as never,
    )
    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      if (url.includes('1.html')) return fixture('paywall-vip.html')
      return fixture('chapter.html')
    })
    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()
    const paid = (await loadBook(started.bookId!)).chapters.find((c) => c.failCode === 'Paywall')
    expect(paid?.url).toBeDefined()
    expect(await openUnblock(started.bookId!, paid!.id)).toEqual({ ok: true, url: paid!.url })
    expect(navigated).toEqual([paid!.url])
    expect(await openUnblock(started.bookId!, 'no-such-chapter')).toMatchObject({
      ok: false,
      message: '章节不存在',
    })
    setBrowseView({ webContents: { isDestroyed: () => true } } as never)
    expect(await openUnblock(started.bookId!, paid!.id)).toMatchObject({ ok: false, message: '浏览页不可用' })
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

describe('terminal progress ordering', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-dl-order-'))
    await setLibraryPath(dir)
    resetDownloadStateForTests()
  })

  afterEach(async () => {
    resetDownloadStateForTests()
    await rm(dir, { recursive: true, force: true })
  })

  it('persists the book status before sending a terminal done event', async () => {
    const events: DownloadProgress[] = []
    const statusAtTerminal: string[] = []
    setOwnerWindow({
      contentView: { addChildView(): void {}, removeChildView(): void {} },
      webContents: {
        send(channel: string, payload: unknown): void {
          if (channel !== 'download.progress') return
          const progress = payload as DownloadProgress
          events.push(progress)
          if (progress.status !== 'done' && progress.status !== 'error') return
          const bookPath = join(dir, progress.bookId, 'book.json')
          statusAtTerminal.push(String(JSON.parse(readFileSync(bookPath, 'utf-8')).status))
        },
      },
    } as never)
    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })

    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()

    expect(events.some((progress) => progress.status === 'done')).toBe(true)
    expect(statusAtTerminal.length).toBeGreaterThan(0)
    expect(statusAtTerminal.every((status) => status === 'ready' || status === 'partial')).toBe(true)
  })
})

describe('failedChapters on terminal progress', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-dl-failch-'))
    await setLibraryPath(dir)
    resetDownloadStateForTests()
  })

  afterEach(async () => {
    resetDownloadStateForTests()
    await rm(dir, { recursive: true, force: true })
  })

  it('omits the list while running and sends [] or the failed/empty rows when finished', async () => {
    const events: DownloadProgress[] = []
    setOwnerWindow(progressWindow(events) as never)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setTestHtmlLoader(async (url) => {
      if (url.includes('2.html')) await gate
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      if (url.includes('3.html')) return '<html><body><div id="content">短</div></body></html>'
      return fixture('chapter.html')
    })

    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok, started.ok ? '' : `${started.code ?? ''} ${started.message ?? ''}`).toBe(true)
    if (!started.ok) return
    await vi.waitFor(() => {
      expect(events.some((p) => p.status === 'running')).toBe(true)
    })
    expect(events.filter((p) => p.status === 'running').every((p) => p.failedChapters === undefined)).toBe(true)

    release()
    await waitForIdle()

    const terminal = events.filter((p) => p.status === 'done' || p.status === 'error' || p.status === 'cancelled')
    expect(terminal.length).toBeGreaterThan(0)
    const last = terminal[terminal.length - 1]
    expect(last.failedChapters).toEqual(expect.any(Array))
    const book = await loadBook(started.bookId!)
    const expected = book.chapters
      .filter((ch) => ch.status === 'failed' || ch.status === 'empty')
      .map((ch) => ({
        chapterId: ch.id,
        title: ch.title,
        index: ch.index,
        failCode: ch.failCode,
        reason: ch.failMessage || (ch.failCode ? FAIL_CODE_ZH[ch.failCode] : '正文为空或过短'),
      }))
    expect(last.failedChapters).toEqual(expected)
    if (expected.length === 0) expect(last.failedChapters).toEqual([])
  })
})

describe('章写入只碰一次 book.json', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-dl-writecount-'))
    await setLibraryPath(dir)
    resetDownloadStateForTests()
  })

  afterEach(async () => {
    setAtomicWriteBeforeCommitForTests(null)
    resetDownloadStateForTests()
    await rm(dir, { recursive: true, force: true })
  })

  it('成功下载一章只写一次 book.json，不留第二次可失败的写', async () => {
    const writes: string[] = []
    setAtomicWriteBeforeCommitForTests((path) => {
      writes.push(path.slice(dir.length).replace(/\\/g, '/'))
    })
    setOwnerWindow(progressWindow([]) as never)
    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })

    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()

    // 每章成功路径应恰好写一次 book.json。旧代码是 writeChapterFile + markChapterStatus 两次，
    // 第二次写失败会被 catch 收口成 failed 占位、把刚下好的正文抹掉。
    // 统计「两个相邻章节文件写之间」的 book.json 写次数（末章后紧跟收尾刷新，不纳入）。
    const chapterIndexes = writes
      .map((entry, i) => (entry.includes('/chapters/') ? i : -1))
      .filter((i) => i >= 0)
    expect(chapterIndexes.length).toBeGreaterThanOrEqual(2)
    const commitsPerChapter: number[] = []
    for (let c = 0; c < chapterIndexes.length - 1; c++) {
      const from = chapterIndexes[c]!
      const to = chapterIndexes[c + 1]!
      commitsPerChapter.push(writes.slice(from + 1, to).filter((entry) => entry.endsWith('/book.json')).length)
    }
    expect(commitsPerChapter.every((n) => n === 1), `每章提交次数应为 1，实测 ${commitsPerChapter.join(',')}`).toBe(true)
    const book = await loadBook(started.bookId!)
    expect(book.chapters.filter((c) => c.status === 'ready').length).toBe(6)
  })

  it('成功路径的 book.json 写失败不会把已 ready 的正文抹成占位', async () => {
    // 只对「首章章节文件写之后的第二次 book.json 写」放行一次失败：
    // 旧实现里这一次正是 markChapterStatus 的冗余写，失败会被 catch 收口成 failed 占位、覆盖刚下好的正文；
    // 新实现里首章之后只有一次 book.json 写，第二次落在第二章，首章正文安然无恙。
    let seenFirstChapterFile = false
    let bookWritesAfterFirstChapter = 0
    let threw = false
    setAtomicWriteBeforeCommitForTests((path) => {
      const rel = path.slice(dir.length).replace(/\\/g, '/')
      if (rel.endsWith('/chapters/0001.json')) {
        seenFirstChapterFile = true
        return
      }
      if (!seenFirstChapterFile || !rel.endsWith('/book.json')) return
      bookWritesAfterFirstChapter++
      if (bookWritesAfterFirstChapter === 2 && !threw) {
        threw = true
        throw new Error('rename EPERM')
      }
    })
    setOwnerWindow(progressWindow([]) as never)
    setTestHtmlLoader(async (url) => {
      if (url.includes('index.html') || url.endsWith('/book/')) return fixture('catalog.html')
      return fixture('chapter.html')
    })

    const started = await startDownloadFromPage(fixture('catalog.html'), 'https://example.com/book/index.html')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitForIdle()

    const book = await loadBook(started.bookId!)
    const first = book.chapters[0]
    expect(first.status).toBe('ready')
    const file = await readChapter(started.bookId!, first.id)
    expect(file.status).toBe('ready')
    expect(file.body.length).toBeGreaterThan(0)
  })
})
