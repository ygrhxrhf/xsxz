import { BrowserWindow, WebContentsView, session } from 'electron'
import { extractPage, extractCatalog, extractBody } from './extract'
import { findSiteRuleForUrl } from './siteRules'
import {
  bookExists,
  bookIdFromUrl,
  createBookFromBootstrap,
  listBooks,
  loadBook,
  markChapterStatus,
  mergeIncomingChapters,
  refreshBookStatus,
  saveBook,
  writeChapterFile,
} from './library'
import type {
  CatalogChapter,
  ChapterStatus,
  CheckAllProgress,
  CheckAllResult,
  CheckOneResult,
  DownloadPace,
  DownloadProgress,
  ExtractBootstrap,
  FailCode,
  SiteRule,
} from '../shared/types'
import { FAIL_CODE_ZH } from '../shared/types'
import { isPathLikeHash } from '../shared/urlHash'
import { getSettings } from './settings'

export const DOWNLOAD_SESSION_PARTITION = 'persist:novel'
/** Off the visible chrome so chapter crawl cannot flash over the guest slot. */
export const HIDDEN_VIEW_BOUNDS = { x: -2400, y: -2400, width: 800, height: 600 }

const CHAPTER_GAP_MS: Record<DownloadPace, number> = {
  slow: 2_000,
  standard: 600,
  fast: 200,
}
const LOAD_TIMEOUT_MS = 25_000
/** Poll interval after navigation settles. Classic HTML should pass the first tick. */
export const HYDRATE_POLL_MS = 300
/** Cap for catalog/body ready wait (10–15s). Hash SPA hydration, not a extra sleep on HTML. */
export const HYDRATE_TIMEOUT_MS = 12_000
/** Extra attempts after the first try, only for NavFailed / BodyEmpty. */
export const CHAPTER_RETRY_TIMES = 2
const CHAPTER_RETRY_BASE_MS = 1_000
/** 批量检查更新：两本书之间的间隔，降低对站点的请求压力。 */
export const CHECK_ALL_GAP_MS = 1_000

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
const cancelWaiters = new Set<() => void>()
let checkAllCancelled = false
let checkAllRunning = false

export function chapterNeedsDownload(status: ChapterStatus): boolean {
  return status === 'pending' || status === 'failed' || status === 'empty'
}

export function shouldRetryChapterFail(code: FailCode | undefined): boolean {
  return code === 'NavFailed' || code === 'BodyEmpty'
}

/** 章与章之间的固定间隔。未知档位按 standard。 */
export function chapterGapMs(pace: DownloadPace): number {
  if (pace === 'slow' || pace === 'standard' || pace === 'fast') return CHAPTER_GAP_MS[pace]
  return CHAPTER_GAP_MS.standard
}

async function currentChapterGapMs(): Promise<number> {
  if (testHtmlLoader) return 0
  try {
    return chapterGapMs((await getSettings()).downloadPace)
  } catch {
    return 0
  }
}

export function chapterRetryDelayMs(attempt: number, opts?: { testing?: boolean }): number {
  const testing = opts?.testing ?? Boolean(testHtmlLoader)
  if (testing) return 0
  const n = Math.max(1, attempt)
  return CHAPTER_RETRY_BASE_MS * 2 ** (n - 1)
}

export function checkUpdateFailHint(
  code: FailCode | undefined,
): { goBrowse: boolean; message: string } | null {
  if (code === 'NeedLogin') {
    return { goBrowse: true, message: '需要登录后才能看，请先到浏览页登录再检查更新' }
  }
  if (code === 'Intercepted') {
    return { goBrowse: true, message: '目录页被拦截或验证，请先到浏览页打开该站后再试' }
  }
  return null
}

function anyActiveCancelled(): boolean {
  for (const dl of active.values()) {
    if (dl.cancelled) return true
  }
  return false
}

function isCancelledError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return msg === '已取消' || msg.includes('已取消')
}

function abortHiddenLoad(): void {
  if (!hiddenView || hiddenView.webContents.isDestroyed()) return
  try {
    hiddenView.webContents.stop()
  } catch {
    /* view already gone */
  }
}

function notifyLoadCancelled(): void {
  abortHiddenLoad()
  for (const wait of cancelWaiters) wait()
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
  cancelWaiters.clear()
  testHtmlLoader = null
  hiddenView = null
  browseView = null
  ownerWindow = null
  checkAllCancelled = false
  checkAllRunning = false
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

const EMPTY_CHAPTER_REASON = '正文为空或过短'

/** 结束清单原因：failMessage > FAIL_CODE_ZH[failCode] > 正文为空或过短。 */
export function failedChapterReason(ch: {
  failMessage?: string
  failCode?: FailCode
}): string {
  const message = ch.failMessage?.trim()
  if (message) return message
  if (ch.failCode && FAIL_CODE_ZH[ch.failCode]) return FAIL_CODE_ZH[ch.failCode]
  return EMPTY_CHAPTER_REASON
}

async function loadFailedChapters(bookId: string): Promise<DownloadProgress['failedChapters']> {
  try {
    const book = await loadBook(bookId)
    return book.chapters
      .filter((ch) => ch.status === 'failed' || ch.status === 'empty')
      .map((ch) => ({
        chapterId: ch.id,
        title: ch.title,
        index: ch.index,
        reason: failedChapterReason(ch),
      }))
  } catch {
    return []
  }
}

async function emitProgress(bookId: string): Promise<void> {
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
  if (status === 'done' || status === 'error' || status === 'cancelled') {
    progress.failedChapters = (await loadFailedChapters(bookId)) ?? []
  }
  try {
    ownerWindow.webContents.send('download.progress', progress)
  } catch {
    /* 进度推送失败不打断下载 */
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function interruptibleDelay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (anyActiveCancelled()) {
      reject(new Error('已取消'))
      return
    }
    const timer = setTimeout(() => {
      cancelWaiters.delete(onCancel)
      resolve()
    }, ms)
    const onCancel = () => {
      clearTimeout(timer)
      cancelWaiters.delete(onCancel)
      reject(new Error('已取消'))
    }
    cancelWaiters.add(onCancel)
  })
}

async function chapterGapDelay(): Promise<void> {
  const ms = await currentChapterGapMs()
  if (ms <= 0) return delay(0)
  return interruptibleDelay(ms)
}

function pageUrlHasPathLikeHash(pageUrl: string): boolean {
  try {
    return isPathLikeHash(new URL(pageUrl).hash)
  } catch {
    return false
  }
}

/** Catalog ≥5 (or rule ≥2); body rule / BODY_SELECTORS effective length ≥80. */
export function isHydratedHtml(html: string, pageUrl: string, rule?: SiteRule): boolean {
  if (extractCatalog(html, pageUrl, rule).length >= 2) return true
  return extractBody(html, pageUrl, rule).ok
}

async function withCancel<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false
    const onCancel = () => {
      if (finished) return
      finished = true
      cancelWaiters.delete(onCancel)
      reject(new Error('已取消'))
    }
    if (anyActiveCancelled()) {
      reject(new Error('已取消'))
      return
    }
    cancelWaiters.add(onCancel)
    work.then(
      (value) => {
        if (finished) return
        finished = true
        cancelWaiters.delete(onCancel)
        resolve(value)
      },
      (err) => {
        if (finished) return
        finished = true
        cancelWaiters.delete(onCancel)
        reject(err)
      },
    )
  })
}

export async function waitUntilHydrated(
  pollHtml: () => Promise<string>,
  pageUrl: string,
  opts?: { pollMs?: number; timeoutMs?: number; rule?: SiteRule },
): Promise<string> {
  const pollMs = opts?.pollMs ?? HYDRATE_POLL_MS
  const timeoutMs = opts?.timeoutMs ?? HYDRATE_TIMEOUT_MS
  const started = Date.now()
  const rule = opts?.rule
  let last = ''
  while (true) {
    if (anyActiveCancelled()) throw new Error('已取消')
    last = await withCancel(pollHtml())
    if (anyActiveCancelled()) throw new Error('已取消')
    const siteRule = rule ?? (await ruleForPage(pageUrl))
    if (isHydratedHtml(last, pageUrl, siteRule)) return last
    if (Date.now() - started >= timeoutMs) return last
    await interruptibleDelay(pollMs)
  }
}

async function waitForNavigationSettle(wc: Electron.WebContents, url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      cleanup()
      try {
        wc.stop()
      } catch {
        /* ignore */
      }
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
    const onCancel = () => {
      cleanup()
      try {
        wc.stop()
      } catch {
        /* ignore */
      }
      reject(new Error('已取消'))
    }
    const cleanup = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cancelWaiters.delete(onCancel)
      wc.removeListener('did-finish-load', onOk)
      wc.removeListener('did-navigate-in-page', onOk)
      wc.removeListener('did-fail-load', onFail)
    }
    cancelWaiters.add(onCancel)
    if (anyActiveCancelled()) {
      onCancel()
      return
    }
    wc.on('did-finish-load', onOk)
    wc.on('did-navigate-in-page', onOk)
    wc.on('did-fail-load', onFail)
    void wc
      .loadURL(url)
      .then(() => {
        if (settled) return
        cleanup()
        resolve()
      })
      .catch((err: unknown) => {
        if (settled) return
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('ERR_ABORTED') || msg.includes('(-3)') || msg.includes('error code: -3')) return
        cleanup()
        reject(err)
      })
  })
}

async function loadAndGetHtml(view: WebContentsView, url: string, forceView = false): Promise<string> {
  if (testHtmlLoader && !forceView) {
    if (anyActiveCancelled()) throw new Error('已取消')
    return testHtmlLoader(url)
  }

  const wc = view.webContents
  await waitForNavigationSettle(wc, url)
  if (anyActiveCancelled()) throw new Error('已取消')
  const rule = await ruleForPage(url)
  return waitUntilHydrated(() => wc.executeJavaScript('document.documentElement.outerHTML') as Promise<string>, url, {
    rule,
  })
}

/** Test hook for the hidden-view settle path (skips setTestHtmlLoader). */
export function loadAndGetHtmlForTests(view: WebContentsView, url: string): Promise<string> {
  return loadAndGetHtml(view, url, true)
}

async function loadPageHtml(url: string): Promise<string> {
  if (testHtmlLoader) {
    if (anyActiveCancelled()) throw new Error('已取消')
    return testHtmlLoader(url)
  }
  return loadAndGetHtml(getHiddenView(), url)
}

async function ruleForPage(pageUrl: string): Promise<SiteRule | undefined> {
  try {
    return await findSiteRuleForUrl(pageUrl)
  } catch {
    return undefined
  }
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
  // Prefer recovered catalog (hash `#/book/65/` or Alice `/other/chapters/…`).
  // Catalog pages omit catalogUrl, so identity is the opened URL.
  // Do not hash the chapter URL when bootstrap already recovered the catalog.
  const catalogUrl = bs.catalogUrl || pageUrl
  return { host, catalogUrl, bookId: bookIdFromUrl(host, catalogUrl) }
}

export async function followCatalogIfNeeded(
  bs: ExtractBootstrap,
  loadHtml: HtmlLoader,
): Promise<{ ok: true; bootstrap: ExtractBootstrap } | { ok: false; code?: FailCode; message?: string }> {
  if (bs.pageKind === 'chapter' && bs.catalogUrl && bs.chapters.length === 0) {
    try {
      const catHtml = await loadHtml(bs.catalogUrl)
      const catRule = await ruleForPage(bs.catalogUrl)
      const catPage = extractPage(catHtml, bs.catalogUrl, undefined, catRule)
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
          : extractCatalog(catHtml, bs.catalogUrl, catRule)
      if (chapters.length < 2) {
        return { ok: false, code: 'CatalogNotFound', message: '从章节目录未找到足够的章节链接' }
      }
      return {
        ok: true,
        bootstrap: {
          ...bs,
          pageKind: 'chapter',
          catalogUrl: bs.catalogUrl,
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

function extractLooksEmpty(result: { ok: boolean; failCode?: FailCode }): boolean {
  return !result.ok && (result.failCode === 'UnknownPage' || result.failCode === 'BodyEmpty' || !result.failCode)
}

async function startFromExtractedHtml(
  pageHtml: string,
  pageUrl: string,
  opts?: { allowHiddenReload?: boolean },
): Promise<{ ok: boolean; bookId?: string; code?: FailCode; message?: string }> {
  const rule = await ruleForPage(pageUrl)
  const result = extractPage(pageHtml, pageUrl, undefined, rule)
  if (!result.ok || !result.bootstrap) {
    const canReload =
      (opts?.allowHiddenReload ?? true) &&
      pageUrlHasPathLikeHash(pageUrl) &&
      extractLooksEmpty(result)
    if (canReload) {
      const reloaded = await loadPageHtml(pageUrl)
      return startFromExtractedHtml(reloaded, pageUrl, { allowHiddenReload: false })
    }
    return { ok: false, code: result.failCode || 'UnknownPage', message: result.failMessage || '无法识别为书' }
  }

  const followed = await followCatalogIfNeeded(result.bootstrap, loadPageHtml)
  if (!followed.ok) return followed
  return beginDownloadFromBootstrap(followed.bootstrap, pageUrl)
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

  return startFromExtractedHtml(pageHtml, pageUrl)
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
  return startFromExtractedHtml(pageHtml, pageUrl)
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
  void emitProgress(bookId)
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
    await emitProgress(bookId)

    const chapterUrl = ch.url
    if (!chapterUrl) {
      dl.failed++
      dl.lastError = failMessage('CatalogNotFound', '章节没有地址')
      await writeFailedPlaceholder(bookId, ch.id, ch.title, undefined, 'CatalogNotFound', dl.lastError)
      await emitProgress(bookId)
      continue
    }

    let lastCode: FailCode = 'NavFailed'
    let lastMsg = ''
    let saved = false
    const maxTries = 1 + CHAPTER_RETRY_TIMES

    for (let attempt = 1; attempt <= maxTries; attempt++) {
      if (dl.cancelled) break
      try {
        const html = await loadPageHtml(chapterUrl)
        if (dl.cancelled) break
        const bodyRule = await ruleForPage(chapterUrl)
        const bodyResult = extractBody(html, chapterUrl, bodyRule)
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
          saved = true
          break
        }
        lastCode = bodyResult.failCode || 'BodyEmpty'
        lastMsg = failMessage(lastCode, bodyResult.failMessage)
        if (!shouldRetryChapterFail(lastCode) || attempt >= maxTries) {
          dl.failed++
          dl.lastError = lastMsg
          await writeFailedPlaceholder(bookId, ch.id, ch.title, chapterUrl, lastCode, lastMsg)
          saved = true
          break
        }
        await interruptibleDelay(chapterRetryDelayMs(attempt))
      } catch (e: unknown) {
        if (isCancelledError(e) || dl.cancelled) break
        lastCode = 'NavFailed'
        lastMsg = failMessage('NavFailed', e instanceof Error ? e.message : String(e))
        if (!shouldRetryChapterFail(lastCode) || attempt >= maxTries) {
          dl.failed++
          dl.lastError = lastMsg
          await writeFailedPlaceholder(bookId, ch.id, ch.title, chapterUrl, lastCode, lastMsg)
          saved = true
          break
        }
        await interruptibleDelay(chapterRetryDelayMs(attempt))
      }
    }

    if (!saved && !dl.cancelled) {
      dl.failed++
      dl.lastError = lastMsg || failMessage(lastCode)
      await writeFailedPlaceholder(bookId, ch.id, ch.title, chapterUrl, lastCode, dl.lastError)
    }

    await emitProgress(bookId)
    if (!dl.cancelled) {
      try {
        await chapterGapDelay()
      } catch (e: unknown) {
        if (!isCancelledError(e)) throw e
      }
    }
  }

  dl.currentTitle = undefined
  if (dl.cancelled) {
    await refreshBookStatus(bookId, 'partial')
  } else {
    await refreshBookStatus(bookId)
  }
  await emitProgress(bookId)
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
  notifyLoadCancelled()
}

export async function checkUpdate(
  bookId: string,
): Promise<{ ok: true; bookId: string; added: number } | { ok: false; code?: FailCode; message: string }> {
  if (active.size > 0) {
    return { ok: false, message: '已有下载任务在进行中，请等待完成或取消后再试' }
  }

  try {
    const book = await loadBook(bookId)
    const sourceUrl = (book.sourceUrl || '').trim()
    if (book.importType !== 'download' || !sourceUrl) {
      return { ok: false, message: '无原始目录地址，无法检查更新' }
    }

    const catHtml = await loadPageHtml(sourceUrl)
    const catRule = await ruleForPage(sourceUrl)
    const page = extractPage(catHtml, sourceUrl, undefined, catRule)
    if (page.failCode === 'NeedLogin' || page.failCode === 'Intercepted') {
      const hint = checkUpdateFailHint(page.failCode)
      return {
        ok: false,
        code: page.failCode,
        message: hint?.message || page.failMessage || FAIL_CODE_ZH[page.failCode],
      }
    }
    const chapters: CatalogChapter[] =
      page.ok && page.bootstrap && page.bootstrap.chapters.length > 0
        ? page.bootstrap.chapters
        : extractCatalog(catHtml, sourceUrl, catRule)
    if (chapters.length === 0) {
      return { ok: false, code: 'CatalogNotFound', message: '目录页无法访问或内容变化' }
    }

    const { added } = mergeIncomingChapters(book, chapters)
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
    void emitProgress(bookId)
    const job = downloadChapters(bookId).catch(() => {})
    runningJobs.add(job)
    void job.finally(() => runningJobs.delete(job))
    return { ok: true, bookId, added }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, message: message || '检查更新失败' }
  }
}

function emitCheckAllProgress(p: CheckAllProgress): void {
  ownerWindow?.webContents.send('download.checkAll.progress', p)
}

/**
 * 全部检查更新：对书库里每本带 sourceUrl 的下载书逐本串行调 checkUpdate。
 * 每本完成后等下载队列空闲再继续，两本之间留 CHECK_ALL_GAP_MS 间隔；
 * 中途 cancelCheckAll 只影响尚未检查的书。
 */
export async function checkAllUpdates(): Promise<CheckAllResult> {
  if (checkAllRunning) {
    return { ok: false, message: '已有批量检查更新在进行中', total: 0, checked: 0, booksWithUpdates: 0, results: [] }
  }
  if (active.size > 0) {
    return {
      ok: false,
      message: '已有下载任务在进行中，请等待完成或取消后再试',
      total: 0,
      checked: 0,
      booksWithUpdates: 0,
      results: [],
    }
  }
  checkAllRunning = true
  checkAllCancelled = false
  try {
    const items = await listBooks()
    const candidates = []
    for (const item of items) {
      if (item.importType !== 'download') continue
      try {
        const b = await loadBook(item.id)
        if ((b.sourceUrl || '').trim()) candidates.push(b)
      } catch {
        /* skip corrupt book */
      }
    }

    const total = candidates.length
    const results: CheckOneResult[] = []
    let checked = 0
    let booksWithUpdates = 0

    for (let i = 0; i < candidates.length; i++) {
      if (checkAllCancelled) break
      const b = candidates[i]
      emitCheckAllProgress({ current: i + 1, total, bookId: b.id, title: b.title })
      const res = await checkUpdate(b.id)
      checked++
      if (res.ok) {
        if (res.added > 0) booksWithUpdates++
        results.push({ ok: true, bookId: res.bookId, title: b.title, added: res.added })
        try {
          await waitForIdle()
        } catch {
          results.push({ ok: false, bookId: b.id, title: b.title, message: '等待该书章节下载完成超时，批量检查已停止' })
          break
        }
      } else {
        results.push({ ok: false, bookId: b.id, title: b.title, message: res.message })
      }
      if (i < candidates.length - 1 && !checkAllCancelled && !testHtmlLoader) {
        await delay(CHECK_ALL_GAP_MS)
      }
    }
    return { ok: true, total, checked, booksWithUpdates, results }
  } finally {
    checkAllRunning = false
  }
}

/** 停止批量检查：不再检查剩余的书；当前正在补章的那本也会被取消。 */
export function cancelCheckAll(): void {
  checkAllCancelled = true
  cancelDownload()
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
    const catRule = await ruleForPage(book.sourceUrl)
    const chapters: CatalogChapter[] = extractCatalog(catHtml, book.sourceUrl, catRule)
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
    void emitProgress(bookId)
    const job = downloadChapters(bookId).catch(() => {})
    runningJobs.add(job)
    void job.finally(() => runningJobs.delete(job))
    return { ok: true }
  } catch (e: unknown) {
    return { ok: false, message: String(e) }
  }
}
