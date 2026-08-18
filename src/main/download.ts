import { BrowserWindow, WebContentsView, session } from 'electron'
import { extractPage, extractCatalog, extractBody } from './extract'
import {
  bookExists,
  bookIdFromUrl,
  createBookFromBootstrap,
  loadBook,
  markChapterStatus,
  mergeIncomingChapters,
  refreshBookStatus,
  saveBook,
  writeChapterFile,
} from './library'
import type { CatalogChapter, ChapterStatus, DownloadProgress, ExtractBootstrap, FailCode } from '../shared/types'
import { FAIL_CODE_ZH } from '../shared/types'

export const DOWNLOAD_SESSION_PARTITION = 'persist:novel'
/** Off the visible chrome so chapter crawl cannot flash over the guest slot. */
export const HIDDEN_VIEW_BOUNDS = { x: -2400, y: -2400, width: 800, height: 600 }

const DELAY_MIN = 400
const DELAY_MAX = 800
const LOAD_TIMEOUT_MS = 25_000

interface ActiveDownload {
  bookId: string
  title: string
  total: number
  done: number
  failed: number
  currentTitle?: string
  lastError?: string
  cancelled: boolean
}

type HtmlLoader = (url: string) => Promise<string>

let hiddenView: WebContentsView | null = null
let ownerWindow: BrowserWindow | null = null
let browseView: WebContentsView | null = null
const active = new Map<string, ActiveDownload>()
let testHtmlLoader: HtmlLoader | null = null
const runningJobs = new Set<Promise<void>>()

export function chapterNeedsDownload(status: ChapterStatus): boolean {
  return status === 'pending' || status === 'failed' || status === 'empty'
}

export function setOwnerWindow(win: BrowserWindow): void {
  ownerWindow = win
}

export function setBrowseView(view: WebContentsView): void {
  browseView = view
}

export function setTestHtmlLoader(loader: HtmlLoader | null): void {
  testHtmlLoader = loader
}

export function resetDownloadStateForTests(): void {
  active.clear()
  runningJobs.clear()
  testHtmlLoader = null
  hiddenView = null
  browseView = null
  ownerWindow = null
}

export async function waitForIdle(timeoutMs = 15_000): Promise<void> {
  const started = Date.now()
  while (active.size > 0 || runningJobs.size > 0) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('download did not become idle')
    }
    await delay(20)
  }
}

export function getHiddenView(): WebContentsView {
  if (!hiddenView || hiddenView.webContents.isDestroyed()) {
    hiddenView = new WebContentsView({
      webPreferences: {
        session: session.fromPartition(DOWNLOAD_SESSION_PARTITION),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
  }
  // Detached on purpose: attaching to the window makes CDP list this as t1
  // and the crawler can steal focus from the visible browse guest.
  try {
    ownerWindow?.contentView.removeChildView(hiddenView)
  } catch {
    /* never attached, or already detached */
  }
  hiddenView.setVisible(false)
  hiddenView.setBounds(HIDDEN_VIEW_BOUNDS)
  return hiddenView
}

function emitProgress(bookId: string): void {
  const dl = active.get(bookId)
  if (!dl || !ownerWindow) return
  const finished = dl.cancelled || dl.done + dl.failed >= dl.total
  const status: DownloadProgress['status'] = dl.cancelled
    ? 'cancelled'
    : !finished
      ? 'running'
      : dl.failed > 0
        ? 'error'
        : 'done'
  const progress: DownloadProgress = {
    bookId: dl.bookId,
    title: dl.title,
    total: dl.total,
    done: dl.done,
    failed: dl.failed,
    currentTitle: dl.currentTitle,
    status,
    lastError: dl.lastError,
  }
  ownerWindow.webContents.send('download.progress', progress)
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function randomDelay(): Promise<void> {
  if (testHtmlLoader) return delay(0)
  return delay(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN))
}

async function loadAndGetHtml(view: WebContentsView, url: string): Promise<string> {
  if (testHtmlLoader) return testHtmlLoader(url)

  const wc = view.webContents
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('章节地址加载超时'))
    }, LOAD_TIMEOUT_MS)
    const onFail = (_e: Electron.Event, code: number, desc: string, _failedUrl: string, isMainFrame: boolean) => {
      if (!isMainFrame || code === -3) return
      cleanup()
      reject(new Error(desc || `加载失败 (${code})`))
    }
    const onOk = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      clearTimeout(timer)
      wc.removeListener('did-finish-load', onOk)
      wc.removeListener('did-fail-load', onFail)
    }
    wc.on('did-finish-load', onOk)
    wc.on('did-fail-load', onFail)
    void wc.loadURL(url).catch((err) => {
      cleanup()
      reject(err)
    })
  })
  await delay(300)
  return wc.executeJavaScript('document.documentElement.outerHTML')
}

async function loadPageHtml(url: string): Promise<string> {
  if (testHtmlLoader) return testHtmlLoader(url)
  return loadAndGetHtml(getHiddenView(), url)
}

function failMessage(code?: FailCode, extra?: string): string {
  const base = code ? FAIL_CODE_ZH[code] : extra || '下载失败'
  return extra && extra !== base ? `${base}：${extra}` : base
}

export function identityFromPage(
  pageUrl: string,
  bs: ExtractBootstrap,
): { host: string; catalogUrl: string; bookId: string } {
  const host = new URL(pageUrl).hostname
  const catalogUrl = bs.pageKind === 'catalog' ? pageUrl : bs.catalogUrl || pageUrl
  return { host, catalogUrl, bookId: bookIdFromUrl(host, catalogUrl) }
}

export async function followCatalogIfNeeded(
  bs: ExtractBootstrap,
  loadHtml: HtmlLoader,
): Promise<{ ok: true; bootstrap: ExtractBootstrap } | { ok: false; code?: FailCode; message?: string }> {
  if (bs.pageKind === 'chapter' && bs.catalogUrl && bs.chapters.length === 0) {
    try {
      const catHtml = await loadHtml(bs.catalogUrl)
      const catPage = extractPage(catHtml, bs.catalogUrl)
      if (catPage.failCode === 'NeedLogin') {
        return {
          ok: false,
          code: 'NeedLogin',
          message: catPage.failMessage || FAIL_CODE_ZH.NeedLogin,
        }
      }
      const chapters =
        catPage.ok && catPage.bootstrap && catPage.bootstrap.chapters.length >= 2
          ? catPage.bootstrap.chapters
          : extractCatalog(catHtml, bs.catalogUrl)
      if (chapters.length < 2) {
        return { ok: false, code: 'CatalogNotFound', message: '从章节目录未找到足够的章节链接' }
      }
      return {
        ok: true,
        bootstrap: {
          ...bs,
          bookTitle: catPage.bootstrap?.bookTitle || bs.bookTitle,
          author: catPage.bootstrap?.author || bs.author,
          chapters,
        },
      }
    } catch {
      return { ok: false, code: 'CatalogNotFound', message: '无法访问目录页' }
    }
  }

  if (bs.chapters.length === 0) {
    return { ok: false, code: 'CatalogNotFound', message: '未找到章节列表' }
  }
  return { ok: true, bootstrap: bs }
}

export async function startDownloadFromPage(
  pageHtml: string,
  pageUrl: string,
): Promise<{ ok: boolean; bookId?: string; code?: FailCode; message?: string }> {
  if (active.size > 0) {
    return { ok: false, message: '已有下载任务在进行中，请等待完成或取消后再试' }
  }

  if (!pageUrl || pageUrl === 'about:blank') {
    return { ok: false, code: 'UnknownPage', message: '请先打开一本书的目录页或章节页' }
  }

  const result = extractPage(pageHtml, pageUrl)
  if (!result.ok || !result.bootstrap) {
    return { ok: false, code: result.failCode || 'UnknownPage', message: result.failMessage || '无法识别为书' }
  }

  const followed = await followCatalogIfNeeded(result.bootstrap, loadPageHtml)
  if (!followed.ok) return followed
  return beginDownloadFromBootstrap(followed.bootstrap, pageUrl)
}

export async function startDownload(): Promise<{ ok: boolean; bookId?: string; code?: FailCode; message?: string }> {
  if (active.size > 0) {
    return { ok: false, message: '已有下载任务在进行中，请等待完成或取消后再试' }
  }

  if (!browseView || browseView.webContents.isDestroyed()) {
    return { ok: false, code: 'NavFailed', message: '无法获取当前页面' }
  }

  const pageUrl = browseView.webContents.getURL()
  if (!pageUrl || pageUrl === 'about:blank') {
    return { ok: false, code: 'UnknownPage', message: '请先打开一本书的目录页或章节页' }
  }

  const pageHtml = await browseView.webContents.executeJavaScript('document.documentElement.outerHTML')
  return startDownloadFromPage(pageHtml, pageUrl)
}

async function beginDownloadFromBootstrap(
  bs: ExtractBootstrap,
  pageUrl: string,
): Promise<{ ok: true; bookId: string } | { ok: false; code?: FailCode; message?: string }> {
  if (active.size > 0) {
    return { ok: false, message: '已有下载任务在进行中，请等待完成或取消后再试' }
  }

  const { host, catalogUrl, bookId } = identityFromPage(pageUrl, bs)

  let book
  if (await bookExists(bookId)) {
    book = await loadBook(bookId)
    mergeIncomingChapters(book, bs.chapters)
    if (bs.bookTitle && (!book.title || book.title === catalogUrl)) book.title = bs.bookTitle
    if (bs.author && !book.author) book.author = bs.author
    book.sourceUrl = catalogUrl
    book.sourceHost = host
    book.status = 'downloading'
    await saveBook(book)
  } else {
    book = await createBookFromBootstrap({
      bookId,
      title: bs.bookTitle,
      author: bs.author,
      sourceUrl: catalogUrl,
      sourceHost: host,
      importType: 'download',
      chapterTitles: bs.chapters.map((c) => c.title),
      chapterUrls: bs.chapters.map((c) => c.url),
    })
    book.status = 'downloading'
    await saveBook(book)
  }

  const dl: ActiveDownload = {
    bookId,
    title: book.title || bs.bookTitle,
    total: book.chapters.length,
    done: book.chapters.filter((c) => c.status === 'ready').length,
    failed: 0,
    cancelled: false,
  }
  active.set(bookId, dl)
  emitProgress(bookId)
  const job = downloadChapters(bookId).catch(() => {})
  runningJobs.add(job)
  void job.finally(() => runningJobs.delete(job))
  return { ok: true, bookId }
}

export async function downloadChapters(bookId: string): Promise<void> {
  const dl = active.get(bookId)
  if (!dl) return

  const book = await loadBook(bookId)
  dl.total = book.chapters.length
  dl.done = book.chapters.filter((c) => c.status === 'ready').length

  for (const ch of book.chapters) {
    if (dl.cancelled) break
    if (!chapterNeedsDownload(ch.status)) continue

    dl.currentTitle = ch.title
    emitProgress(bookId)

    const chapterUrl = ch.url
    if (!chapterUrl) {
      dl.failed++
      dl.lastError = failMessage('CatalogNotFound', '章节没有地址')
      await writeFailedPlaceholder(bookId, ch.id, ch.title, undefined, 'CatalogNotFound', dl.lastError)
      emitProgress(bookId)
      continue
    }

    try {
      const html = await loadPageHtml(chapterUrl)
      if (dl.cancelled) break
      const bodyResult = extractBody(html, chapterUrl)
      if (bodyResult.ok) {
        await writeChapterFile(bookId, ch.id, {
          title: ch.title,
          url: chapterUrl,
          body: bodyResult.body,
          bodyRaw: bodyResult.body,
          status: 'ready',
        })
        ch.status = 'ready'
        await markChapterStatus(bookId, ch.id, 'ready', { url: chapterUrl })
        dl.done++
      } else {
        const code = bodyResult.failCode || 'BodyEmpty'
        dl.failed++
        dl.lastError = failMessage(code, bodyResult.failMessage)
        await writeFailedPlaceholder(bookId, ch.id, ch.title, chapterUrl, code, dl.lastError)
      }
    } catch (e: unknown) {
      dl.failed++
      dl.lastError = failMessage('NavFailed', e instanceof Error ? e.message : String(e))
      await writeFailedPlaceholder(bookId, ch.id, ch.title, chapterUrl, 'NavFailed', dl.lastError)
    }

    emitProgress(bookId)
    if (!dl.cancelled) await randomDelay()
  }

  dl.currentTitle = undefined
  if (dl.cancelled) {
    await refreshBookStatus(bookId, 'partial')
  } else {
    await refreshBookStatus(bookId)
  }
  emitProgress(bookId)
  active.delete(bookId)
}

async function writeFailedPlaceholder(
  bookId: string,
  chapterId: string,
  title: string,
  url: string | undefined,
  failCode: FailCode,
  failMessageText: string,
): Promise<void> {
  await writeChapterFile(bookId, chapterId, {
    title,
    url,
    body: '',
    status: 'failed',
    failCode,
  })
  await markChapterStatus(bookId, chapterId, 'failed', { failCode, failMessage: failMessageText })
}

export function cancelDownload(bookId?: string): void {
  if (bookId) {
    const dl = active.get(bookId)
    if (dl) dl.cancelled = true
  } else {
    for (const dl of active.values()) dl.cancelled = true
  }
}

export async function retryFailed(bookId: string): Promise<{ ok: boolean; message?: string }> {
  if (active.size > 0) {
    return { ok: false, message: '已有下载任务在进行中，请等待完成或取消后再试' }
  }

  try {
    const book = await loadBook(bookId)
    if (!book.sourceUrl) {
      return { ok: false, message: '无原始目录地址，无法重试' }
    }

    const catHtml = await loadPageHtml(book.sourceUrl)
    const chapters: CatalogChapter[] = extractCatalog(catHtml, book.sourceUrl)
    if (chapters.length === 0) {
      return { ok: false, message: '目录页无法访问或内容变化' }
    }

    mergeIncomingChapters(book, chapters)
    for (const ch of book.chapters) {
      if (chapterNeedsDownload(ch.status) && ch.status !== 'pending') ch.status = 'pending'
    }
    book.status = 'downloading'
    await saveBook(book)

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
    const job = downloadChapters(bookId).catch(() => {})
    runningJobs.add(job)
    void job.finally(() => runningJobs.delete(job))
    return { ok: true }
  } catch (e: unknown) {
    return { ok: false, message: String(e) }
  }
}
