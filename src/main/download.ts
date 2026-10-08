import { BrowserWindow, WebContentsView, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { extractPage, extractCatalog, extractBody } from './extract'
import { findSiteRuleForUrl, normalizeHost } from './siteRules'
import {
  bookExists,
  canonicalBookId,
  createBookFromBootstrap,
  findExistingBookId,
  listBooks,
  loadBook,
  markChapterStatus,
  mergeIncomingChapters,
  normalizeBookHost,
  refreshBookStatus,
  saveBook,
  writeChapterFile,
} from './library'
import type {
  CatalogChapter,
  ChapterMeta,
  ChapterStatus,
  CheckAllProgress,
  CheckAllResult,
  CheckOneResult,
  DownloadBlocked,
  DownloadPace,
  DownloadProgress,
  DownloadPreview,
  ExtractBootstrap,
  FailCode,
  SiteRule,
  SiteRulePreview,
} from '../shared/types'
import { FAIL_CODE_ZH } from '../shared/types'
import { isPathLikeHash } from '../shared/urlHash'
import {
  classifyHttpStatus,
  HttpStatusError,
  mainFrameRetryAfter,
  mainFrameStatus,
  observeHttpStatus,
  resetHttpStatusObservationForTests,
} from './httpStatus'
import { getSettings } from './settings'
import { isLibraryRestoring } from './libraryMaintenance'
import { auditBook } from './quality'

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
/** Extra attempts after the first try, only for NavFailed / BodyEmpty / RateLimited. */
export const CHAPTER_RETRY_TIMES = 2
const CHAPTER_RETRY_BASE_MS = 1_000
/** 退避上限：指数增长到这里就停，不再往后章里越睡越久。 */
const CHAPTER_RETRY_CAP_MS = 30_000
/** 限流每次重试都要先等完退避，试两次就够，别把一章的额度全花在睡觉上。 */
export const RATE_LIMIT_MAX_TRIES = 2
/** 连续这么多章都被限流就收工：等站点缓过来，稍后用「重试失败章」继续。 */
export const RATE_LIMIT_STOP_COUNT = 3
/** 批量检查更新：两本书之间的间隔，降低对站点的请求压力。 */
export const CHECK_ALL_GAP_MS = 1_000
/**
 * 同类墙连撞这么多章，判定为整站性质：停在这一章等用户本人处理。
 * 单章付费的书里偶然一章撞墙不该把后面几百章免费内容卡住，所以仍按连撞计数。
 */
export const WALL_PAUSE_STREAK = 3

interface ActiveDownload {
  bookId: string
  title: string
  total: number
  done: number
  failed: number
  currentTitle?: string
  lastError?: string
  cancelled: boolean
  wallKind?: FailCode
  wallStreak?: number
  /** 连续限流的章数；成功或非限流失败会清零。 */
  rateStreak?: number
  /** 连撞整站墙后提前收工：剩下的章保持 pending，等用户解锁再补。 */
  stopped?: boolean
  /** 撞见登录 / 付费 / 验证墙时暂停在当章，等用户在浏览页亲自处理。 */
  pausedForHuman?: DownloadBlocked
  /** 用户处理完：本轮跑完后需要再来一轮把退回 pending 的墙章补上。 */
  requeued?: boolean
}

type HtmlLoader = (url: string) => Promise<string>

let hiddenView: WebContentsView | null = null
let ownerWindow: BrowserWindow | null = null
let browseView: WebContentsView | null = null
const active = new Map<string, ActiveDownload>()
let testHtmlLoader: HtmlLoader | null = null
const runningJobs = new Set<Promise<void>>()
const cancelWaiters = new Set<() => void>()
/** bookId → 等待「我已处理好」的续跑回调；取消时一并撤掉。 */
const humanWaiters = new Map<string, Set<() => void>>()
let checkAllCancelled = false
let checkAllRunning = false
let pendingPreview: { token: string; pageUrl: string; createdAt: number; bootstrap: ExtractBootstrap } | null = null

export function chapterNeedsDownload(status: ChapterStatus): boolean {
  return status === 'pending' || status === 'failed' || status === 'empty'
}

export function shouldRetryChapterFail(code: FailCode | undefined): boolean {
  return code === 'NavFailed' || code === 'BodyEmpty' || code === 'RateLimited'
}

export function isSiteWallFail(code: FailCode | undefined): boolean {
  return code === 'NeedLogin' || code === 'Paywall' || code === 'Intercepted'
}

/** 撞墙时给人的话：说清卡在哪、要本人去做什么。软件不代做登录、付费或验证。 */
function blockedMessage(code: FailCode): string {
  const why =
    code === 'Paywall'
      ? '本章需要付费或会员'
      : code === 'NeedLogin'
        ? '本章需要登录'
        : '页面被拦截或要求验证'
  return `${why}，已暂停本次下载。请到浏览页用自己的账号登录或完成验证，再点「已处理好，继续下载」。`
}

const RATE_LIMIT_STOP_MESSAGE = '站点连续限流，已停止本次下载。稍后用「重试失败章」继续。'

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

/**
 * 重试退避：指数增长到上限后加抖动。
 * 抖动是为了避免「固定 1s / 2s」让同一站点的所有客户端在同一刻一起回来重试。
 */
export function chapterRetryDelayMs(
  attempt: number,
  opts?: { testing?: boolean; capMs?: number; random?: () => number },
): number {
  const testing = opts?.testing ?? Boolean(testHtmlLoader)
  if (testing) return 0
  const n = Math.max(1, attempt)
  const cap = opts?.capMs ?? CHAPTER_RETRY_CAP_MS
  const grow = Math.min(cap, CHAPTER_RETRY_BASE_MS * 2 ** (n - 1))
  const random = opts?.random ?? Math.random
  return Math.round(grow * (0.5 + random() * 0.5))
}

export function checkUpdateFailHint(
  code: FailCode | undefined,
): { goBrowse: boolean; message: string } | null {
  if (code === 'NeedLogin') {
    return { goBrowse: true, message: '需要登录后才能看，请先到浏览页登录再检查更新' }
  }
  if (code === 'Paywall') {
    return { goBrowse: true, message: '本章需要付费或会员，请在浏览页解锁后再检查更新' }
  }
  if (code === 'Intercepted') {
    return { goBrowse: true, message: '目录页被拦截或验证，请先到浏览页打开该站后再试' }
  }
  if (code === 'RateLimited') {
    return { goBrowse: false, message: '站点限流，请稍后再试' }
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
  humanWaiters.clear()
  resetHttpStatusObservationForTests()
  testHtmlLoader = null
  hiddenView = null
  browseView = null
  ownerWindow = null
  checkAllCancelled = false
  checkAllRunning = false
  pendingPreview = null
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

export function isDownloadBusy(): boolean {
  return active.size > 0 || runningJobs.size > 0 || checkAllRunning
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
    observeHttpStatus(hiddenView.webContents.session)
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
        failCode: ch.failCode,
      }))
  } catch {
    return []
  }
}

async function emitProgress(bookId: string): Promise<void> {
  const dl = active.get(bookId)
  if (!dl || !ownerWindow) return
  const finished = dl.cancelled || dl.stopped || dl.done + dl.failed >= dl.total
  const status: DownloadProgress['status'] = dl.cancelled
    ? 'cancelled'
    : dl.pausedForHuman
      ? 'awaitingHuman'
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
    try { progress.qualityIssueCount = (await auditBook(bookId)).issues.length } catch { /* report remains available on demand */ }
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

/** 把卡住的那一章推给渲染层：由用户本人去浏览页处理，软件不代登录、不代付费、不代验证。 */
function emitBlocked(payload: DownloadBlocked): void {
  try {
    ownerWindow?.webContents.send('download.blocked', payload)
  } catch {
    /* 推送失败不打断下载：暂停状态仍在进度里 */
  }
}

async function pauseForHuman(dl: ActiveDownload, ch: ChapterMeta, code: FailCode): Promise<void> {
  dl.pausedForHuman = {
    bookId: dl.bookId,
    chapterId: ch.id,
    chapterTitle: ch.title,
    url: ch.url ?? '',
    failCode: code,
    message: blockedMessage(code),
  }
  dl.lastError = dl.pausedForHuman.message
  emitBlocked(dl.pausedForHuman)
  await emitProgress(dl.bookId)
}

/** 等用户处理：唤醒走 download.resumeUnblock，取消沿用同一套 waiter。 */
function waitWhilePausedForHuman(dl: ActiveDownload): Promise<void> {
  if (!dl.pausedForHuman) return Promise.resolve()
  const bookId = dl.bookId
  return new Promise<void>((resolve, reject) => {
    const waiters = humanWaiters.get(bookId) ?? new Set<() => void>()
    humanWaiters.set(bookId, waiters)
    function cleanup(): void {
      waiters.delete(onResume)
      waiters.delete(onCancel)
      if (waiters.size === 0) humanWaiters.delete(bookId)
    }
    const onResume = (): void => {
      cleanup()
      resolve()
    }
    const onCancel = (): void => {
      cleanup()
      cancelWaiters.delete(onCancel)
      reject(new Error('已取消'))
    }
    waiters.add(onResume)
    cancelWaiters.add(onCancel)
  })
}

function notifyHumanResumed(bookId: string): void {
  const waiters = humanWaiters.get(bookId)
  if (!waiters) return
  humanWaiters.delete(bookId)
  for (const resume of [...waiters]) resume()
}

/**
 * 解锁后续跑：把所有撞站点墙的章退回 pending，并安排再来一轮。
 * 网络类失败（NavFailed / BodyEmpty）不动，仍归书库的「重试失败章」管。
 */
async function requeueWallFailedChapters(bookId: string, dl: ActiveDownload): Promise<void> {
  const book = await loadBook(bookId)
  let count = 0
  for (const ch of book.chapters) {
    if (ch.status !== 'failed' || !isSiteWallFail(ch.failCode)) continue
    await markChapterStatus(bookId, ch.id, 'pending')
    dl.failed = Math.max(0, dl.failed - 1)
    count++
  }
  if (count > 0) dl.requeued = true
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

/** 状态码未知时放行：观察失败不该拖住下载，正文启发式仍会兜住明显不是书的页面。 */
async function guardHttpStatus(url: string): Promise<void> {
  const status = mainFrameStatus(url)
  if (status === undefined) return
  const retryAfterMs = mainFrameRetryAfter(url)
  const verdict = classifyHttpStatus(status, { testing: Boolean(testHtmlLoader), retryAfterMs })
  if (verdict.action === 'ok') return
  if (verdict.action === 'throttle') await interruptibleDelay(verdict.backoffMs)
  throw new HttpStatusError(verdict.code, status, `HTTP ${status}`, retryAfterMs)
}

async function loadAndGetHtml(view: WebContentsView, url: string, forceView = false): Promise<string> {
  if (testHtmlLoader && !forceView) {
    if (anyActiveCancelled()) throw new Error('已取消')
    await guardHttpStatus(url)
    return testHtmlLoader(url)
  }

  const wc = view.webContents
  await waitForNavigationSettle(wc, url)
  await guardHttpStatus(wc.getURL() || url)
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
    await guardHttpStatus(url)
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
): { host: string; rawHost: string; catalogUrl: string; bookId: string } {
  const rawHost = new URL(pageUrl).hostname
  const host = normalizeBookHost(rawHost)
  // Prefer recovered catalog (hash `#/book/65/` or Alice `/other/chapters/…`).
  // Catalog pages omit catalogUrl, so identity is the opened URL.
  // Do not hash the chapter URL when bootstrap already recovered the catalog.
  const catalogUrl = bs.catalogUrl || pageUrl
  return { host, rawHost, catalogUrl, bookId: canonicalBookId(host, catalogUrl) }
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
  if (isLibraryRestoring()) return { ok: false, message: '书库正在恢复，请稍后再试' }
  if (active.size > 0) {
    return { ok: false, message: '已有下载任务在进行中，请等待完成或取消后再试' }
  }

  if (!pageUrl || pageUrl === 'about:blank') {
    return { ok: false, code: 'UnknownPage', message: '请先打开一本书的目录页或章节页' }
  }

  return startFromExtractedHtml(pageHtml, pageUrl)
}

export async function startDownload(): Promise<{ ok: boolean; bookId?: string; code?: FailCode; message?: string }> {
  if (isLibraryRestoring()) return { ok: false, message: '书库正在恢复，请稍后再试' }
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

/** 识别当前页和样本，不创建书籍。确认令牌只在当前浏览页有效。 */
export async function previewDownload(): Promise<
  { ok: true; preview: DownloadPreview } | { ok: false; code?: FailCode; message: string }
> {
  pendingPreview = null
  if (isLibraryRestoring() || isDownloadBusy()) return { ok: false, message: '书库或下载任务正忙，请稍后再试' }
  const wc = browseView?.webContents
  if (!wc || wc.isDestroyed()) return { ok: false, code: 'NavFailed', message: '无法获取当前页面' }
  const pageUrl = wc.getURL()
  if (!/^https?:\/\//i.test(pageUrl)) return { ok: false, code: 'UnknownPage', message: '请先打开一本书的目录页或章节页' }
  const html = await wc.executeJavaScript('document.documentElement.outerHTML') as string
  const rule = await ruleForPage(pageUrl)
  let extracted = extractPage(html, pageUrl, undefined, rule)
  if ((!extracted.ok || !extracted.bootstrap) && pageUrlHasPathLikeHash(pageUrl) && extractLooksEmpty(extracted)) {
    const reloaded = await loadPageHtml(pageUrl)
    extracted = extractPage(reloaded, pageUrl, undefined, rule)
  }
  if (!extracted.ok || !extracted.bootstrap) {
    return { ok: false, code: extracted.failCode || 'UnknownPage', message: extracted.failMessage || '无法识别为书' }
  }
  const followed = await followCatalogIfNeeded(extracted.bootstrap, loadPageHtml)
  if (!followed.ok) return { ok: false, code: followed.code, message: followed.message || '无法识别目录' }
  if (wc.isDestroyed() || wc.getURL() !== pageUrl) return { ok: false, message: '网页已切换，请重新预览' }
  const bootstrap = followed.bootstrap
  const sampleChapter = bootstrap.chapters[0]
  let sampleBody = ''
  let sampleError: string | undefined
  if (sampleChapter) {
    try {
      const sampleHtml = await loadPageHtml(sampleChapter.url)
      const body = extractBody(sampleHtml, sampleChapter.url, await ruleForPage(sampleChapter.url))
      if (body.ok) sampleBody = body.body.slice(0, 800)
      else sampleError = body.failMessage || '样本正文无法提取'
    } catch (error) {
      sampleError = error instanceof Error ? error.message : '样本正文加载失败'
    }
  }
  if (wc.isDestroyed() || wc.getURL() !== pageUrl) return { ok: false, message: '网页已切换，请重新预览' }
  const token = randomUUID()
  pendingPreview = { token, pageUrl, createdAt: Date.now(), bootstrap }
  return { ok: true, preview: {
    token, pageUrl, bookTitle: bootstrap.bookTitle, author: bootstrap.author,
    chapterCount: bootstrap.chapters.length,
    chapterTitles: bootstrap.chapters.slice(0, 8).map((chapter) => chapter.title),
    sampleTitle: sampleChapter?.title || '', sampleBody, sampleError,
  } }
}

export async function confirmDownload(token: string): Promise<
  { ok: true; bookId: string } | { ok: false; message: string }
> {
  const preview = pendingPreview
  pendingPreview = null
  if (!preview || preview.token !== token || Date.now() - preview.createdAt > 10 * 60_000) {
    return { ok: false, message: '预览已过期，请重新预览' }
  }
  if (browseView?.webContents.isDestroyed() || browseView?.webContents.getURL() !== preview.pageUrl) {
    return { ok: false, message: '网页已切换，请重新预览' }
  }
  const started = await beginDownloadFromBootstrap(preview.bootstrap, preview.pageUrl)
  return started.ok ? started : { ok: false, message: started.message || '下载失败，请重新预览' }
}

/** 对未保存的选择器试运行；当前浏览页与样本章均不落盘。 */
export async function previewCurrentSiteRule(rule: SiteRule): Promise<
  { ok: true; preview: SiteRulePreview } | { ok: false; message: string }
> {
  const wc = browseView?.webContents
  if (!wc || wc.isDestroyed()) return { ok: false, message: '请先在浏览页打开站点' }
  const pageUrl = wc.getURL()
  if (!/^https?:\/\//i.test(pageUrl)) return { ok: false, message: '请先在浏览页打开站点' }
  let host: string
  try { host = normalizeHost(rule.host) } catch { return { ok: false, message: '域名无效' } }
  if (host !== normalizeHost(new URL(pageUrl).hostname)) return { ok: false, message: '当前浏览页与填写的域名不同' }
  const html = await wc.executeJavaScript('document.documentElement.outerHTML') as string
  const extracted = extractPage(html, pageUrl, undefined, rule)
  let bootstrap = extracted.ok ? extracted.bootstrap : undefined
  if (bootstrap) {
    const followed = await followCatalogIfNeeded(bootstrap, loadPageHtml)
    if (followed.ok) bootstrap = followed.bootstrap
  }
  const sample = bootstrap?.chapters[0]
  let sampleHtml = html
  let sampleUrl = pageUrl
  if (sample) {
    try { sampleHtml = await loadPageHtml(sample.url); sampleUrl = sample.url } catch { /* diagnostics show missing sample */ }
  }
  const sourceDoc = new JSDOM(html, { url: pageUrl }).window.document
  const sampleDoc = new JSDOM(sampleHtml, { url: sampleUrl }).window.document
  const diagnostics = {} as SiteRulePreview['diagnostics']
  for (const field of ['title', 'author', 'catalog', 'body'] as const) {
    const selector = rule[field]?.trim()
    if (!selector) { diagnostics[field] = '未填写，使用通用提取'; continue }
    try {
      const found = (field === 'body' ? sampleDoc : sourceDoc).querySelector(selector)
      diagnostics[field] = found ? '已命中' : '未命中'
    } catch { diagnostics[field] = '选择器无效' }
  }
  const body = extractBody(sampleHtml, sampleUrl, rule)
  if (wc.isDestroyed() || wc.getURL() !== pageUrl) return { ok: false, message: '网页已切换，请重新试运行' }
  return { ok: true, preview: {
    pageUrl, title: bootstrap?.bookTitle || '', author: bootstrap?.author || '',
    chapterCount: bootstrap?.chapters.length || 0,
    chapterTitles: bootstrap?.chapters.slice(0, 5).map((chapter) => chapter.title) || [],
    bodySample: body.ok ? body.body.slice(0, 500) : '', diagnostics,
  } }
}

async function beginDownloadFromBootstrap(
  bs: ExtractBootstrap,
  pageUrl: string,
): Promise<{ ok: true; bookId: string } | { ok: false; code?: FailCode; message?: string }> {
  if (isLibraryRestoring()) return { ok: false, message: '书库正在恢复，请稍后再试' }
  if (active.size > 0) {
    return { ok: false, message: '已有下载任务在进行中，请等待完成或取消后再试' }
  }

  const identity = identityFromPage(pageUrl, bs)
  // 老库里的书可能按带 www 的旧键建过：复用已存在的那本，避免同一书变成两本
  const bookId = (await findExistingBookId(identity.rawHost, identity.catalogUrl)) ?? identity.bookId
  const { host, catalogUrl } = identity

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

  try {
    await runChapterDownloads(bookId, dl)
  } finally {
    // 循环里的任何抛出（重试退避期间点「取消」就是其中一条）都必须走完收尾：
    // 否则 active 永不清空，后续所有下载都会被 active.size > 0 的闸门挡到重启。
    dl.currentTitle = undefined
    try {
      if (dl.cancelled || dl.stopped) {
        await refreshBookStatus(bookId, 'partial')
      } else {
        await refreshBookStatus(bookId)
      }
      await emitProgress(bookId)
    } finally {
      active.delete(bookId)
    }
  }
}

async function runChapterDownloads(bookId: string, dl: ActiveDownload): Promise<void> {
  do {
    dl.requeued = false
    dl.done = 0
    dl.failed = 0
    dl.wallKind = undefined
    dl.wallStreak = 0
    dl.rateStreak = 0
    const book = await loadBook(bookId)
    dl.total = book.chapters.length
    dl.done = book.chapters.filter((c) => c.status === 'ready').length
    await downloadPass(bookId, book.chapters, dl)
  } while (dl.requeued && !dl.cancelled && !dl.stopped)
}

async function downloadPass(bookId: string, chapters: ChapterMeta[], dl: ActiveDownload): Promise<void> {
  for (const ch of chapters) {
    if (dl.cancelled) return
    if (!chapterNeedsDownload(ch.status)) continue

    dl.currentTitle = ch.title
    await emitProgress(bookId)

    const finalFail = await attemptChapter(bookId, ch, dl)
    const wallCode = finalFail && isSiteWallFail(finalFail) ? finalFail : undefined
    if (wallCode) {
      dl.wallStreak = dl.wallKind === wallCode ? (dl.wallStreak ?? 0) + 1 : 1
      dl.wallKind = wallCode
    } else {
      dl.wallKind = undefined
      dl.wallStreak = 0
    }

    if (finalFail === 'RateLimited') {
      dl.rateStreak = (dl.rateStreak ?? 0) + 1
      if (dl.rateStreak >= RATE_LIMIT_STOP_COUNT) {
        dl.stopped = true
        dl.lastError = RATE_LIMIT_STOP_MESSAGE
        return
      }
    } else {
      dl.rateStreak = 0
    }

    await emitProgress(bookId)

    // 同类墙连撞够多才判定整站性质：停在这一章等用户本人在浏览页处理，不再逐章硬撞。
    if (wallCode && (dl.wallStreak ?? 0) >= WALL_PAUSE_STREAK && !dl.cancelled) {
      await pauseForHuman(dl, ch, wallCode)
      try {
        await waitWhilePausedForHuman(dl)
      } catch (e: unknown) {
        if (!isCancelledError(e)) throw e
        return
      }
      if (dl.cancelled) return
      await requeueWallFailedChapters(bookId, dl)
      return
    }

    if (!dl.cancelled) {
      try {
        await chapterGapDelay()
      } catch (e: unknown) {
        if (!isCancelledError(e)) throw e
      }
    }
  }
}

/**
 * 下一张章：成功写正文，失败写占位并计数。
 * 返回最终失败码；当章成功或中途被取消时返回 undefined。
 */
async function attemptChapter(bookId: string, ch: ChapterMeta, dl: ActiveDownload): Promise<FailCode | undefined> {
  const chapterUrl = ch.url
  if (!chapterUrl) {
    const message = failMessage('CatalogNotFound', '章节没有地址')
    dl.failed++
    dl.lastError = message
    await writeFailedPlaceholder(bookId, ch.id, ch.title, undefined, 'CatalogNotFound', message)
    await emitProgress(bookId)
    return 'CatalogNotFound'
  }

  let lastCode: FailCode = 'NavFailed'
  let lastMsg = ''
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
          bodyRaw: bodyResult.bodyRaw ?? bodyResult.body,
          status: 'ready',
        })
        ch.status = 'ready'
        await markChapterStatus(bookId, ch.id, 'ready', { url: chapterUrl })
        dl.done++
        return undefined
      }
      lastCode = bodyResult.failCode || 'BodyEmpty'
      lastMsg = failMessage(lastCode, bodyResult.failMessage)
      if (!chapterWillRetry(lastCode, attempt, maxTries)) {
        await failChapter(bookId, ch, chapterUrl, lastCode, lastMsg, dl)
        return lastCode
      }
      await interruptibleDelay(chapterRetryDelayMs(attempt))
    } catch (e: unknown) {
      if (isCancelledError(e) || dl.cancelled) break
      lastCode = e instanceof HttpStatusError ? e.code : 'NavFailed'
      lastMsg = failMessage(lastCode, e instanceof Error ? e.message : String(e))
      if (!chapterWillRetry(lastCode, attempt, maxTries)) {
        await failChapter(bookId, ch, chapterUrl, lastCode, lastMsg, dl)
        return lastCode
      }
      await interruptibleDelay(chapterRetryDelayMs(attempt))
    }
  }

  if (dl.cancelled) return undefined
  await failChapter(bookId, ch, chapterUrl, lastCode, lastMsg || failMessage(lastCode), dl)
  return lastCode
}

/** 可重试性：限流只给一次重试，因为每轮重试前都要先等完整退避。 */
function chapterWillRetry(code: FailCode, attempt: number, maxTries: number): boolean {
  if (attempt >= maxTries) return false
  if (!shouldRetryChapterFail(code)) return false
  if (code === 'RateLimited') return attempt < RATE_LIMIT_MAX_TRIES
  return true
}

async function failChapter(
  bookId: string,
  ch: ChapterMeta,
  url: string,
  failCode: FailCode,
  failMessageText: string,
  dl: ActiveDownload,
): Promise<void> {
  dl.failed++
  dl.lastError = failMessageText
  await writeFailedPlaceholder(bookId, ch.id, ch.title, url, failCode, failMessageText)
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

/**
 * 把卡住的那一章交给用户：只在内置浏览页导航过去，登录、付费、验证都由用户本人完成。
 * 不注入脚本、不代点击、不代填表单。
 */
export async function openUnblock(
  bookId: string,
  chapterId: string,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  try {
    const book = await loadBook(bookId)
    const chapter = book.chapters.find((item) => item.id === chapterId)
    if (!chapter) return { ok: false, message: '章节不存在' }
    const url = (chapter.url || '').trim()
    if (!url) return { ok: false, message: '该章没有源地址，请到浏览页手动打开目录页' }
    if (!['http:', 'https:'].includes(new URL(url).protocol)) return { ok: false, message: '章节地址只支持 http(s)' }
    if (!browseView || browseView.webContents.isDestroyed()) return { ok: false, message: '浏览页不可用' }
    try {
      await browseView.webContents.loadURL(url)
    } catch (e: unknown) {
      // ERR_ABORTED 是站内重定向打断导航，页面已经落在目标地址上，不算失败。
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('ERR_ABORTED')) return { ok: false, message: msg }
    }
    return { ok: true, url }
  } catch (e: unknown) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

/** 用户在浏览页处理完了：解除暂停标志并唤醒等待中的下载轮次，墙章由下载循环退回 pending 后再来一轮。 */
export async function resumeUnblock(bookId: string): Promise<{ ok: boolean; message?: string }> {
  const dl = active.get(bookId)
  if (!dl) return { ok: false, message: '没有正在进行的下载，请在书库用「重试失败章」继续' }
  if (dl.cancelled) return { ok: false, message: '本次下载已取消，请在书库用「重试失败章」继续' }
  if (!dl.pausedForHuman) return { ok: false, message: '当前下载没有在等待处理' }
  dl.pausedForHuman = undefined
  dl.lastError = undefined
  await emitProgress(bookId)
  notifyHumanResumed(bookId)
  return { ok: true }
}

export async function checkUpdate(
  bookId: string,
): Promise<{ ok: true; bookId: string; added: number } | { ok: false; code?: FailCode; message: string }> {
  if (isLibraryRestoring()) return { ok: false, message: '书库正在恢复，请稍后再试' }
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
    const hint = checkUpdateFailHint(page.failCode)
    if (hint) {
      return { ok: false, code: page.failCode, message: hint.message }
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
  if (isLibraryRestoring()) {
    return { ok: false, message: '书库正在恢复，请稍后再试', total: 0, checked: 0, booksWithUpdates: 0, results: [] }
  }
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
  if (isLibraryRestoring()) return { ok: false, message: '书库正在恢复，请稍后再试' }
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

/** 仅重新提取指定章节；失败时保留原 URL 和正文。 */
export async function redownloadChapter(
  bookId: string, chapterId: string, rawUrl: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (isLibraryRestoring() || isDownloadBusy()) return { ok: false, message: '已有书库或下载任务在进行中' }
  let url: URL
  try { url = new URL(rawUrl.trim()) } catch { return { ok: false, message: '章节地址无效' } }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, message: '章节地址只支持 http(s)' }
  try {
    const book = await loadBook(bookId)
    const chapter = book.chapters.find((item) => item.id === chapterId)
    if (!chapter || book.importType !== 'download') return { ok: false, message: '下载章节不存在' }
    const dl: ActiveDownload = {
      bookId, title: book.title, total: 1, done: 0, failed: 0,
      currentTitle: chapter.title, cancelled: false,
    }
    active.set(bookId, dl)
    await emitProgress(bookId)
    let message = ''
    try {
      const html = await loadPageHtml(url.toString())
      if (dl.cancelled) return { ok: false, message: '已取消' }
      const extracted = extractBody(html, url.toString(), await ruleForPage(url.toString()))
      if (!extracted.ok) {
        message = extracted.failMessage || failMessage(extracted.failCode)
        return { ok: false, message }
      }
      await writeChapterFile(bookId, chapterId, {
        title: chapter.title, url: url.toString(), body: extracted.body,
        bodyRaw: extracted.bodyRaw ?? extracted.body, status: 'ready',
      })
      await refreshBookStatus(bookId)
      dl.done = 1
      return { ok: true }
    } catch (error) {
      message = error instanceof Error ? error.message : '重新提取失败'
      return { ok: false, message }
    } finally {
      if (!dl.done && !dl.cancelled) {
        dl.failed = 1
        dl.lastError = `${message || '重新提取失败'}；旧正文已保留`
      }
      dl.currentTitle = undefined
      await emitProgress(bookId)
      active.delete(bookId)
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
