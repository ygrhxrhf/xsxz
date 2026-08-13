import { BrowserWindow, WebContentsView, session } from 'electron'
import { extractPage, extractCatalog, extractBody } from './extract'
import {
  createBookFromBootstrap,
  loadBook,
  writeChapterFile,
  markChapterReady,
  saveBook,
  bookIdFromUrl,
} from './library'
import type { DownloadProgress, ExtractBootstrap, FailCode, ChapterFile } from '../shared/types'

const PARTITION = 'persist:novel'
const DELAY_MIN = 400
const DELAY_MAX = 800

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

interface ActiveDownload {
  bookId: string
  title: string
  total: number
  done: number
  failed: number
  currentTitle?: string
  cancelled: boolean
}

let hiddenView: WebContentsView | null = null
let ownerWindow: BrowserWindow | null = null
const active = new Map<string, ActiveDownload>()

// ---------------------------------------------------------------------------
// hidden view
// ---------------------------------------------------------------------------

function getHiddenView(): WebContentsView {
  if (hiddenView && !hiddenView.webContents.isDestroyed()) return hiddenView
  hiddenView = new WebContentsView({
    webPreferences: {
      session: session.fromPartition(PARTITION),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // detach from any parent if previously attached
  try { ownerWindow?.contentView.removeChildView(hiddenView) } catch {}
  ownerWindow?.contentView.addChildView(hiddenView)
  hiddenView.setVisible(false)
  return hiddenView
}

export function setOwnerWindow(win: BrowserWindow): void {
  ownerWindow = win
}

// ---------------------------------------------------------------------------
// progress
// ---------------------------------------------------------------------------

function emitProgress(bookId: string): void {
  const dl = active.get(bookId)
  if (!dl || !ownerWindow) return
  const progress: DownloadProgress = {
    bookId: dl.bookId,
    title: dl.title,
    total: dl.total,
    done: dl.done,
    failed: dl.failed,
    currentTitle: dl.currentTitle,
    status: dl.cancelled ? 'cancelled' : dl.done + dl.failed >= dl.total ? (dl.failed > 0 ? 'error' : 'done') : 'running',
  }
  ownerWindow.webContents.send('download.progress', progress)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function randomDelay(): Promise<void> {
  return delay(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN))
}

async function loadAndGetHtml(wc: WebContentsView, url: string): Promise<string> {
  await wc.webContents.loadURL(url)
  // wait for page settle
  await delay(500)
  return wc.webContents.executeJavaScript('document.documentElement.outerHTML')
}

function extractBodyFromHtml(html: string, url: string): { body: string; ok: boolean; failCode?: FailCode } {
  return extractBody(html, url)
}

// ---------------------------------------------------------------------------
// main download flow
// ---------------------------------------------------------------------------

export async function startDownload(): Promise<{ ok: boolean; bookId?: string; code?: FailCode; message?: string }> {
  if (active.size > 0) {
    return { ok: false, message: '已有下载任务在进行中，请等待完成或取消后再试' }
  }

  const view = getHiddenView()
  const currentUrl = ownerWindow?.webContents.getURL() || ''

  // We need the browse view's current URL. Get it from IPC context or stored state.
  // The caller should have set up the browse view URL. For now, we'll extract from
  // the visible page's HTML.
  const browseView = ownerWindow?.contentView.children.find(
    (c) => c !== hiddenView
  ) as WebContentsView | undefined

  if (!browseView) {
    return { ok: false, code: 'NavFailed', message: '无法获取当前页面' }
  }

  const pageUrl = browseView.webContents.getURL()
  if (!pageUrl || pageUrl === 'about:blank') {
    return { ok: false, code: 'UnknownPage', message: '请先打开一本书的目录页或章节页' }
  }

  // Extract from current visible page
  const pageHtml = await browseView.webContents.executeJavaScript('document.documentElement.outerHTML')
  const result = extractPage(pageHtml, pageUrl)

  if (!result.ok || !result.bootstrap) {
    return { ok: false, code: result.failCode || 'UnknownPage', message: result.failMessage || '无法识别为书' }
  }

  const bs = result.bootstrap

  // If we got a chapter page, we need to fetch the catalog first
  if (bs.pageKind === 'chapter' && bs.catalogUrl && bs.chapters.length === 0) {
    try {
      const catHtml = await loadAndGetHtml(view, bs.catalogUrl)
      const chapters = extractCatalog(catHtml, bs.catalogUrl)
      if (chapters.length < 2) {
        return { ok: false, code: 'CatalogNotFound', message: '从章节目录未找到足够的章节链接' }
      }
      bs.chapters = chapters
    } catch {
      return { ok: false, code: 'CatalogNotFound', message: '无法访问目录页' }
    }
  }

  if (bs.chapters.length === 0) {
    return { ok: false, code: 'CatalogNotFound', message: '未找到章节列表' }
  }

  // Create or load book
  const host = new URL(pageUrl).hostname
  const catalogUrl = bs.pageKind === 'catalog' ? pageUrl : bs.catalogUrl || pageUrl
  const bookId = bookIdFromUrl(host, catalogUrl)

  // Check if book exists (for retry)
  let book
  try {
    book = await loadBook(bookId)
    // Merge new chapter list
    const newTitles = bs.chapters.map((c) => c.title)
    // Only add chapters that don't exist yet
    for (const ch of bs.chapters) {
      if (!book.chapters.find((c) => c.title === ch.title)) {
        // New chapter
      }
    }
  } catch {
    // New book
    book = await createBookFromBootstrap({
      bookId,
      title: bs.bookTitle,
      author: bs.author,
      sourceUrl: catalogUrl,
      sourceHost: host,
      importType: 'download',
      chapterTitles: bs.chapters.map((c) => c.title),
    })
  }

  // Set up download state
  const dl: ActiveDownload = {
    bookId,
    title: bs.bookTitle,
    total: book.chapters.length,
    done: book.chapters.filter((c) => c.status === 'ready').length,
    failed: 0,
    cancelled: false,
  }
  active.set(bookId, dl)
  emitProgress(bookId)

  // Start downloading chapters
  downloadChapters(bookId, bs).catch(() => {})

  return { ok: true, bookId }
}

async function downloadChapters(bookId: string, bs: ExtractBootstrap): Promise<void> {
  const dl = active.get(bookId)
  if (!dl) return

  const view = getHiddenView()
  const book = await loadBook(bookId)

  for (let i = 0; i < book.chapters.length; i++) {
    if (dl.cancelled) break

    const ch = book.chapters[i]
    if (ch.status === 'ready') continue

    dl.currentTitle = ch.title
    emitProgress(bookId)

    const chapterUrl = bs.chapters[i]?.url
    if (!chapterUrl) {
      dl.failed++
      await markChapterReady(bookId, ch.id, 'failed')
      emitProgress(bookId)
      continue
    }

    try {
      const html = await loadAndGetHtml(view, chapterUrl)
      const bodyResult = extractBodyFromHtml(html, chapterUrl)

      if (bodyResult.ok) {
        const file: ChapterFile = {
          title: ch.title,
          url: chapterUrl,
          body: bodyResult.body,
          bodyRaw: bodyResult.body,
          status: 'ready',
        }
        await writeChapterFile(bookId, ch.id, file)
        await markChapterReady(bookId, ch.id, 'ready')
        dl.done++
      } else {
        dl.failed++
        await markChapterReady(bookId, ch.id, 'failed')
      }
    } catch {
      dl.failed++
      await markChapterReady(bookId, ch.id, 'failed')
    }

    emitProgress(bookId)
    await randomDelay()
  }

  // Final status
  dl.currentTitle = undefined
  emitProgress(bookId)
  active.delete(bookId)
}

// ---------------------------------------------------------------------------
// cancel / retry
// ---------------------------------------------------------------------------

export function cancelDownload(bookId?: string): void {
  if (bookId) {
    const dl = active.get(bookId)
    if (dl) dl.cancelled = true
  } else {
    // cancel all
    for (const dl of active.values()) dl.cancelled = true
  }
}

export async function retryFailed(bookId: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const book = await loadBook(bookId)
    // Reset failed chapters to pending
    for (const ch of book.chapters) {
      if (ch.status === 'failed') {
        ch.status = 'pending'
      }
    }
    await saveBook(book)

    // Re-trigger download with stored source URL
    if (!book.sourceUrl) {
      return { ok: false, message: '无原始目录地址，无法重试' }
    }

    const view = getHiddenView()
    const catHtml = await loadAndGetHtml(view, book.sourceUrl)
    const chapters = extractCatalog(catHtml, book.sourceUrl)

    if (chapters.length === 0) {
      return { ok: false, message: '目录页无法访问或内容变化' }
    }

    const bs: ExtractBootstrap = {
      pageKind: 'catalog',
      bookTitle: book.title,
      author: book.author,
      chapters,
    }

    const dl: ActiveDownload = {
      bookId,
      title: book.title,
      total: book.chapters.length,
      done: book.chapters.filter((c) => c.status === 'ready').length,
      failed: 0,
      cancelled: false,
    }
    active.set(bookId, dl)
    emitProgress(bookId)
    downloadChapters(bookId, bs).catch(() => {})

    return { ok: true }
  } catch (e: unknown) {
    return { ok: false, message: String(e) }
  }
}
