import { BrowserWindow, WebContentsView, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JSDOM } from 'jsdom'
import { extractPage, extractCatalog, extractBody, findCatalogPageUrls } from './extract'
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
  ChapterFile,
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
  PreviewPageKind,
  FailCode,
  SiteRule,
  SiteRulePreview,
  UnlockMethod,
} from '../shared/types'
import { FAIL_CODE_ZH } from '../shared/types'
import { isPathLikeHash } from '../shared/urlHash'
import {
  classifyHttpStatus,
  clearMainFrameStatus,
  HttpStatusError,
  mainFrameRetryAfter,
  mainFrameStatus,
  observeHttpStatus,
  resetHttpStatusObservationForTests,
} from './httpStatus'
import { getSettings } from './settings'
import { isLibraryRestoring } from './libraryMaintenance'
import { auditBook } from './quality'
import { PAGE_PROBE_SCRIPT, mergePageProbe } from './pageProbe'
import {
  buildChapterApiScript,
  findChapterApiCandidates,
  joinApiPayload,
  parseChapterApiPayload,
  type ChapterApiCandidate,
} from './chapterApi'
import { normalizeRecoveredBody, recoverBodyFromText } from './paywallUnlock'
import { PAGE_OCR_SCRIPT, ocrImages, parseOcrPayload } from './ocrText'

export const DOWNLOAD_SESSION_PARTITION = 'persist:novel'
/** Off the visible chrome so chapter crawl cannot flash over the guest slot. */
export const HIDDEN_VIEW_BOUNDS = { x: -2400, y: -2400, width: 800, height: 600 }

const CHAPTER_GAP_MS: Record<DownloadPace, number> = {
  slow: 2_000,
  standard: 600,
  fast: 200,
}
/** 一章最多再接几页被藏起来的续页；再多就说明这不是「分页」，是整站。 */
const MAX_CONTINUATION_PAGES = 3
/** 墙页判定放在头几轮轮询里做：既快，又不给真正的 SPA 页面加每次轮询的解析开销。 */
const WALL_PROBE_POLLS = 2
const LOAD_TIMEOUT_MS = 25_000
/**
 * 子资源（广告/统计）会永久拖住 did-finish-load，但 dom-ready 后正文已经可读。
 * 等这么久还没 finish 就先行进入水合轮询，避免每章白等满 LOAD_TIMEOUT_MS。
 */
const DOM_READY_GRACE_MS = 1_500
let domReadyGraceMs = DOM_READY_GRACE_MS

/** 测试用：缩短 dom-ready 宽限，避免用例真等 1.5s。 */
export function setNavigationGraceForTests(ms: number | null): void {
  domReadyGraceMs = ms ?? DOM_READY_GRACE_MS
}
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
  /** 最近一次撞墙章「自动恢复为什么没成」的一句话，进人工提示给用户看。 */
  lastUnlockReason?: string
  /** 同一章被「我已处理好」重排过几次：超过上限就不再自动重排，避免死循环。 */
  wallRequeues?: Map<string, number>
  /** 终态进度等 book.json 落盘后再发，避免界面收到 done 却刷新到 downloading。 */
  deferTerminal?: boolean
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

/** 同一章撞墙后被重排的上限：超过就说明「处理好了」其实没生效，别再空转。 */
export const WALL_REQUEUE_LIMIT = 2

/** 撞墙时给人的话：说清卡在哪、要本人去做什么。软件不代做登录、付费或验证。 */
function blockedMessage(code: FailCode, unlockReason?: string): string {
  const why =
    code === 'Paywall'
      ? '本章需要付费或会员，页面里也没有能自动找回的正文'
      : code === 'NeedLogin'
        ? '本章需要登录'
        : '页面被拦截或要求验证'
  const tried =
    code === 'Paywall' && unlockReason ? `（自动恢复已试过：${unlockReason}）` : ''
  return `${why}${tried}，已暂停本次下载。请在该页面用自己的账号登录或完成验证，再点「我已处理好，继续下载」。`
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
  testScriptRunner = null
  hiddenView = null
  browseView = null
  ownerWindow = null
  checkAllCancelled = false
  checkAllRunning = false
  domReadyGraceMs = DOM_READY_GRACE_MS
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

/**
 * 拆掉下载用的隐藏视图：只 stop() 不够，视图从未挂窗口，渲染进程会一直占内存。
 * close() 释放 webContents 与其渲染进程；测试替身没有 close 时退回 stop。
 */
export function disposeHiddenView(): void {
  const target = hiddenView
  hiddenView = null
  if (!target) return
  const wc = target.webContents
  if (wc && !wc.isDestroyed()) {
    try {
      if (typeof wc.close === 'function') wc.close()
      else wc.stop()
    } catch { /* view already gone */ }
  }
}

const EMPTY_CHAPTER_REASON = '正文为空或过短'
const CATALOG_PAGE_HINT = '这是目录页，没有正文。点「下载本书」会按目录把整本下载到书库。'
const CHAPTER_PAGE_HINT = '这一页没有目录。回到这本书的目录页再下载，或先在设置里配置本站规则。'

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
  const holdTerminal = finished && dl.deferTerminal === true && !dl.cancelled && !dl.pausedForHuman
  const status: DownloadProgress['status'] = dl.cancelled
    ? 'cancelled'
    : dl.pausedForHuman
      ? 'awaitingHuman'
      : !finished || holdTerminal
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
    message: blockedMessage(code, dl.lastUnlockReason),
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
  const requeues = dl.wallRequeues ?? (dl.wallRequeues = new Map<string, number>())
  let count = 0
  let exhausted = 0
  for (const ch of book.chapters) {
    if (ch.status !== 'failed' || !isSiteWallFail(ch.failCode)) continue
    const tries = requeues.get(ch.id) ?? 0
    // 「我已处理好」却没生效时别再无限重排：同一章最多退回 pending 两次
    if (tries >= WALL_REQUEUE_LIMIT) {
      exhausted++
      continue
    }
    requeues.set(ch.id, tries + 1)
    await markChapterStatus(bookId, ch.id, 'pending')
    dl.failed = Math.max(0, dl.failed - 1)
    count++
  }
  if (count > 0) dl.requeued = true
  if (exhausted > 0 && count === 0) {
    dl.lastError = `有 ${exhausted} 章连续 ${WALL_REQUEUE_LIMIT + 1} 次都卡在同一堵墙，已停止自动重排。请确认页面已可正常阅读后，用书库的「重试失败章」继续。`
  }
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

/**
 * 墙页（登录 / 付费 / 拦截）不会因为等更久长出正文。
 * 认出来就立刻把 HTML 交回主流程——否则每张墙页都要白等满 `HYDRATE_TIMEOUT_MS`，
 * 而付费墙自动解锁让「墙页不少是能读的章」，这个等待会摊到每一章上。
 */
export function isWallPageHtml(html: string, pageUrl: string, rule?: SiteRule): boolean {
  const page = extractPage(html, pageUrl, undefined, rule)
  if (page.ok) return false
  // 乱码 / 字形替换页也不会因为等更久长出可读正文：直接交回主流程记失败原因
  if (page.failCode === 'BodyGarbled') return true
  return page.failCode === 'Paywall' || page.failCode === 'NeedLogin' || page.failCode === 'Intercepted'
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

/** 空正文页（占位章 / 已删章）等不来内容，把总预算收到这里就走。 */
export const EMPTY_BODY_TIMEOUT_MS = 3_000

function isEmptyBodyHtml(html: string, pageUrl: string, rule?: SiteRule): boolean {
  const page = extractPage(html, pageUrl, undefined, rule)
  return !page.ok && page.failCode === 'BodyEmpty'
}

export async function waitUntilHydrated(
  pollHtml: () => Promise<string>,
  pageUrl: string,
  opts?: { pollMs?: number; timeoutMs?: number; rule?: SiteRule },
): Promise<string> {
  const pollMs = opts?.pollMs ?? HYDRATE_POLL_MS
  let timeoutMs = opts?.timeoutMs ?? HYDRATE_TIMEOUT_MS
  const started = Date.now()
  const rule = opts?.rule
  let last = ''
  let polls = 0
  while (true) {
    if (anyActiveCancelled()) throw new Error('已取消')
    last = await withCancel(pollHtml())
    if (anyActiveCancelled()) throw new Error('已取消')
    const siteRule = rule ?? (await ruleForPage(pageUrl))
    if (isHydratedHtml(last, pageUrl, siteRule)) return last
    // 墙页只在头两轮判定：真站点的墙第二眼就能看出，SPA 骨架也在这一轮之后有内容
    if (polls++ < WALL_PROBE_POLLS && isWallPageHtml(last, pageUrl, siteRule)) return last
    // 页面已经看得出是「空正文」就不再等满 12s（每章 3 次重试下来是 37s 的白等）
    if (timeoutMs > EMPTY_BODY_TIMEOUT_MS && polls > WALL_PROBE_POLLS && isEmptyBodyHtml(last, pageUrl, siteRule)) {
      timeoutMs = EMPTY_BODY_TIMEOUT_MS
    }
    if (Date.now() - started >= timeoutMs) return last
    await interruptibleDelay(pollMs)
  }
}

async function waitForNavigationSettle(wc: Electron.WebContents, url: string): Promise<void> {
  // 先清掉该地址的旧状态码观察：上一次的 429/503 残留会让本次已恢复的请求被误退避/误判失败。
  clearMainFrameStatus(url)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let graceTimer: NodeJS.Timeout | undefined
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
    const onDomReady = () => {
      if (settled || graceTimer) return
      // 正文已在 DOM 里；水合轮询会继续等 SPA，这里不再陪挂起的广告子资源。
      graceTimer = setTimeout(onOk, domReadyGraceMs)
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
      if (graceTimer) clearTimeout(graceTimer)
      cancelWaiters.delete(onCancel)
      wc.removeListener('dom-ready', onDomReady)
      wc.removeListener('did-finish-load', onOk)
      wc.removeListener('did-navigate-in-page', onOk)
      wc.removeListener('did-fail-load', onFail)
    }
    cancelWaiters.add(onCancel)
    if (anyActiveCancelled()) {
      onCancel()
      return
    }
    wc.on('dom-ready', onDomReady)
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
  const html = await waitUntilHydrated(() => wc.executeJavaScript('document.documentElement.outerHTML') as Promise<string>, url, {
    rule,
  })
  // 不像正常章节 / 目录的页面（墙页、SPA 骨架）：Shadow DOM、iframe、window 上的数据
  // 都不在 outerHTML 里，让页面自己报一次。正常章节不付这份开销。
  if (isHydratedHtml(html, url, rule)) return html
  return appendPageProbe(wc, html)
}

/** 页面内探测：合并失败、脚本报错都不影响主流程。 */
async function appendPageProbe(wc: Electron.WebContents, html: string): Promise<string> {
  try {
    const probe = (await wc.executeJavaScript(PAGE_PROBE_SCRIPT)) as string
    return mergePageProbe(html, probe)
  } catch {
    return html
  }
}

/** 在页面上下文里跑一段脚本。测试可用 `setTestScriptRunner` 替掉。 */
let testScriptRunner: ((script: string) => Promise<string>) | null = null

export function setTestScriptRunner(runner: ((script: string) => Promise<string>) | null): void {
  testScriptRunner = runner
}

async function runInPageContext(script: string): Promise<string> {
  if (testScriptRunner) return testScriptRunner(script)
  return (await getHiddenView().webContents.executeJavaScript(script)) as string
}

/** Test hook for the hidden-view settle path (skips setTestHtmlLoader). */
export function loadAndGetHtmlForTests(view: WebContentsView, url: string): Promise<string> {
  return loadAndGetHtml(view, url, true)
}

/** 给镜像预取用：在调用方自己的隐藏视图里加载页面，复用同一套水合与探测。 */
export function loadPageHtmlWithView(view: WebContentsView, url: string): Promise<string> {
  return loadAndGetHtml(view, url)
}

export async function loadPageHtml(url: string): Promise<string> {
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
          : await collectCatalogWithPages(catHtml, bs.catalogUrl, catRule, loadHtml)
      if (chapters.length < 2) {
        return { ok: false, code: 'CatalogNotFound', message: '这一章识别到了目录，但目录里没有足够的章节链接。' }
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
    return { ok: false, code: 'CatalogNotFound', message: CHAPTER_PAGE_HINT }
  }
  return { ok: true, bootstrap: bs }
}

/**
 * 抓目录并按分页续页补齐：站点把目录切成多页（`?page=2`、`_2.html`、`/list/2/`）时，
 * 只取第一页会丢章。逐页抓回后续页，各自跑 `extractCatalog` 自校验，只有真产出章节才合并；
 * 单页失败跳过。不做 URL 归一化（`?page=N` 的抹平是有意的，改了会让同一本书重复入库）。
 */
async function collectCatalogWithPages(
  firstHtml: string,
  catalogUrl: string,
  rule: SiteRule | undefined,
  loadHtml: HtmlLoader,
): Promise<CatalogChapter[]> {
  const merged = extractCatalog(firstHtml, catalogUrl, rule)
  const seen = new Set(merged.map((chapter) => chapter.url))
  const candidates = findCatalogPageUrls(firstHtml, catalogUrl, MAX_CONTINUATION_PAGES)
  for (const url of candidates) {
    try {
      const html = await loadHtml(url)
      const pageRule = await ruleForPage(url)
      const extra = extractCatalog(html, url, pageRule)
      if (extra.length === 0) continue
      for (const chapter of extra) {
        if (seen.has(chapter.url)) continue
        seen.add(chapter.url)
        merged.push(chapter)
      }
    } catch {
      /* 续页抓取失败不改判：第一页的目录仍可用 */
    }
  }
  // 合并后重排序号：目录顺序以「第一页在前、后续页追加」为准。
  return merged.map((chapter, index) => ({ ...chapter, index: index + 1 }))
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
  // 目录页直接入口：站点分页目录（?page=2 / _2.html / /list/2/）只取第一页会丢章，补抓续页。
  if (followed.bootstrap.pageKind === 'catalog' && followed.bootstrap.chapters.length > 0) {
    const merged = await collectCatalogWithPages(pageHtml, pageUrl, rule, loadPageHtml)
    if (merged.length > followed.bootstrap.chapters.length) {
      followed.bootstrap = { ...followed.bootstrap, chapters: merged }
    }
  }
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
/**
 * 预览取哪几章做样本：中位章优先。
 * 第 1 章常常是站点自己的「作者的话 / 公告 / 空占位」，拿它当样本会让用户盲确认。
 */
function sampleChapterOrder<T>(chapters: T[]): T[] {
  if (chapters.length <= 1) return [...chapters]
  const mid = Math.floor(chapters.length / 2)
  const picks = [chapters[mid], chapters[0], chapters[Math.min(mid + 1, chapters.length - 1)]]
  return picks.filter((item, index) => item !== undefined && picks.indexOf(item) === index)
}

/** 失败提示要带页面类型：目录页可以继续下，章节页要先回到目录。 */
function previewFailure(
  message: string,
  pageKind: PreviewPageKind,
  code?: FailCode,
): { ok: false; code?: FailCode; message: string; pageKind: PreviewPageKind } {
  return { ok: false, code, message, pageKind }
}

export async function previewDownload(): Promise<
  { ok: true; preview: DownloadPreview } | { ok: false; code?: FailCode; message: string; pageKind?: PreviewPageKind }
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
    // extractPage 只在整体识别成功时才回 catalog，所以这里自己再判一次：
    // 页面上确实有目录却没能成书时，提示不该说「这一页没有目录」。
    const catalogHits = extractCatalog(html, pageUrl, rule).length
    const pageKind: PreviewPageKind = catalogHits >= 2 ? 'catalog' : extracted.pageKind === 'chapter' ? 'chapter' : 'unknown'
    const message = catalogHits >= 2
      ? `页面里有 ${catalogHits} 条目录链接，但没能识别成书。请在设置里为本站配置站点规则后重试。`
      : pageKind === 'catalog'
        ? CATALOG_PAGE_HINT
        : pageKind === 'chapter'
          ? CHAPTER_PAGE_HINT
          : extracted.failMessage || '无法识别为书'
    return previewFailure(message, pageKind, extracted.failCode || 'UnknownPage')
  }
  const followed = await followCatalogIfNeeded(extracted.bootstrap, loadPageHtml)
  if (!followed.ok) return previewFailure(followed.message || '无法识别目录', 'chapter', followed.code)
  if (wc.isDestroyed() || wc.getURL() !== pageUrl) return { ok: false, message: '网页已切换，请重新预览' }
  const bootstrap = followed.bootstrap
  const order = sampleChapterOrder(bootstrap.chapters)
  let sampleChapter = bootstrap.chapters[0]
  let sampleBody = ''
  let sampleError: string | undefined
  for (const candidate of order) {
    sampleChapter = candidate
    try {
      const sampleHtml = await loadPageHtml(candidate.url)
      const body = extractBody(sampleHtml, candidate.url, await ruleForPage(candidate.url))
      if (body.ok) {
        sampleBody = body.body.slice(0, 800)
        sampleError = undefined
        break
      }
      sampleError = body.failMessage || '样本正文无法提取'
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
): Promise<{ ok: true; bookId: string } | { ok: false; bookId?: string; code?: FailCode; message?: string }> {
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

  // 全书都已经下好了：入队只会首帧就显示「完成」，用户以为自己点了没反应
  if (!book.chapters.some((c) => chapterNeedsDownload(c.status))) {
    await refreshBookStatus(bookId)
    return {
      ok: false,
      bookId,
      message: '这本书的章节都已经下载好了，没有需要补的章。要补新章节请在书库里用「检查更新」。',
    }
  }

  const dl: ActiveDownload = {
    bookId,
    title: book.title || bs.bookTitle,
    total: book.chapters.length,
    done: book.chapters.filter((c) => c.status === 'ready').length,
    failed: 0,
    cancelled: false,
    deferTerminal: true,
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
      dl.deferTerminal = false
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
 * DOM 内恢复都失败后的最后一招：在**页面上下文**里调站点自己的章节接口。
 *
 * 隐藏视图此刻就停在这一章，cookie / referer / UA / 站点指纹与用户本人点击时一致；
 * 主进程不裸 fetch、不伪造会员凭证、不猜接口签名。每章最多两个候选，
 * 候选之间隔一次下载档位节流，失败不重试。
 */
type ApiUnlockOutcome =
  | { ok: true; body: string; method: UnlockMethod; detail: string }
  | { ok: false; /** 是否真的打过接口（用于给用户一句准确的话） */ attempted: boolean }

async function tryChapterApiUnlock(
  pageUrl: string,
  html: string,
  rule: SiteRule | undefined,
  dl: ActiveDownload,
): Promise<ApiUnlockOutcome> {
  if (rule?.paywallUnlock === false) return { ok: false, attempted: false }
  let candidates: ChapterApiCandidate[]
  try {
    candidates = findChapterApiCandidates(html, pageUrl, rule)
  } catch {
    return { ok: false, attempted: false }
  }
  if (candidates.length === 0) return { ok: false, attempted: false }

  let attempted = false
  for (const candidate of candidates) {
    if (dl.cancelled) return { ok: false, attempted }
    try {
      await chapterGapDelay()
    } catch (e: unknown) {
      if (isCancelledError(e)) return { ok: false, attempted }
    }
    let payload: string
    try {
      attempted = true
      payload = await runInPageContext(buildChapterApiScript([candidate]))
    } catch {
      continue
    }
    const responses = parseChapterApiPayload(payload)
    const recovered = recoverBodyFromText(joinApiPayload(responses), '', {
      method: 'api',
      detail: `章节接口 ${candidate.detail}`,
    })
    if (recovered) return { ok: true, ...recovered }
  }
  return { ok: false, attempted }
}

/**
 * 最后一层兜底：DOM 里没有字可抓（图片化正文 / 字形替换）时，把图交给 OCR 认字。
 * 默认关闭，按站点在站点规则里用 `ocrUnlock` 打开——它慢，而且认出来要本人核对。
 */
async function tryOcrUnlock(
  pageUrl: string,
  rule: SiteRule | undefined,
  dl: ActiveDownload,
): Promise<{ body: string; method: UnlockMethod; detail: string } | null> {
  if (rule?.ocrUnlock !== true) return null
  if (dl.cancelled) return null
  const note = (reason: string): void => {
    dl.lastUnlockReason = `${dl.lastUnlockReason ? `${dl.lastUnlockReason}；` : ''}${reason}`
  }
  let payload: string
  try {
    payload = await runInPageContext(PAGE_OCR_SCRIPT)
  } catch {
    note('OCR 引擎没能取到页面里的图片')
    return null
  }
  const { images } = parseOcrPayload(payload)
  if (images.length === 0) {
    note('页面里没有可认的图片正文')
    return null
  }
  let recognized: Awaited<ReturnType<typeof ocrImages>>
  try {
    recognized = await ocrImages(images, ocrTempDir())
  } catch (error) {
    note(`OCR 失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (!recognized.ok) {
    note(
      recognized.reason === 'no-engine'
        ? `本机没有可用的 OCR 引擎（${recognized.detail ?? 'tesseract.js'}）`
        : recognized.reason === 'no-image'
          ? '页面里没有可认的图片正文'
          : 'OCR 认了图片，但没认出可读文字（图片可能过小或字迹不清）',
    )
    return null
  }
  const body = normalizeRecoveredBody(recognized.text)
  if (!body) {
    note('OCR 认出的文字经清理后不足一段，未采用')
    return null
  }
  return { body, method: 'ocr', detail: `OCR ${recognized.detail}` }
}

/** OCR 临时图目录：走系统临时目录，取不到才退回进程目录，绝不因此中断下载。 */
function ocrTempDir(): string {
  try {
    return join(tmpdir(), 'spbf-ocr')
  } catch {
    return join(process.cwd(), '.spbf-ocr')
  }
}

/**
 * 付费墙把正文切成多页时：把被站点藏起来的续页抓回来接在后面。
 * 单页失败只跳过那一页——主体正文已经在手，不因为续页把整章判失败。
 */async function appendContinuationPages(
  baseBody: string,
  urls: string[],
  dl: ActiveDownload,
): Promise<{ body: string; appended: number }> {
  let body = baseBody
  let appended = 0
  for (const url of urls) {
    if (dl.cancelled) break
    try {
      await chapterGapDelay()
    } catch (e: unknown) {
      if (isCancelledError(e)) break
    }
    try {
      const html = await loadPageHtml(url)
      const part = extractBody(html, url, await ruleForPage(url))
      if (!part.ok || !part.body) continue
      if (body.includes(part.body)) continue
      body = `${body}\n\n${part.body}`
      appended++
    } catch {
      /* 续页抓取失败不改判 */
    }
  }
  return { body, appended }
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
    // 原因是「这一章」的：上一章的解锁原因不能带到这一章的提示里
    if (attempt === 1) dl.lastUnlockReason = undefined
    try {
      const html = await loadPageHtml(chapterUrl)
      if (dl.cancelled) break
      const bodyRule = await ruleForPage(chapterUrl)
      const bodyResult = extractBody(html, chapterUrl, bodyRule)
      if (bodyResult.ok) {
        let body = bodyResult.body
        let bodyRaw = bodyResult.bodyRaw ?? bodyResult.body
        let unlockedBy: UnlockMethod | undefined = bodyResult.unlockedBy
        if (unlockedBy && bodyResult.continuationUrls?.length) {
          const merged = await appendContinuationPages(
            body,
            bodyResult.continuationUrls.slice(0, MAX_CONTINUATION_PAGES),
            dl,
          )
          if (merged.appended > 0) {
            body = merged.body
            bodyRaw = merged.body
            unlockedBy = 'paged'
          }
        }
        const chapterData: ChapterFile = {
          title: ch.title,
          url: chapterUrl,
          body,
          bodyRaw,
          status: 'ready',
        }
        if (unlockedBy) chapterData.unlockedBy = unlockedBy
        // writeChapterFile 已在同一次锁内落盘 status/url/unlockedBy；再调一次 markChapterStatus
        // 只会多一次 book.json 读改写，且那次写若失败会被 catch 收口成 failed 占位、抹掉刚写好的正文。
        await writeChapterFile(bookId, ch.id, chapterData)
        ch.status = 'ready'
        dl.done++
        return undefined
      }
      // DOM 内恢复失败：最后一招是站点自己的章节接口（页面上下文里发，带用户当前会话）
      if (bodyResult.unlockReason) dl.lastUnlockReason = bodyResult.unlockReason
      if (bodyResult.failCode === 'Paywall') {
        const api = await tryChapterApiUnlock(chapterUrl, html, bodyRule, dl)
        if (api.ok) {
          const apiChapter: ChapterFile = {
            title: ch.title,
            url: chapterUrl,
            body: api.body,
            bodyRaw: api.body,
            status: 'ready',
            unlockedBy: api.method,
          }
          await writeChapterFile(bookId, ch.id, apiChapter)
          ch.status = 'ready'
          dl.done++
          return undefined
        }
        if (api.attempted) {
          dl.lastUnlockReason = `${dl.lastUnlockReason ?? '页面内没有可恢复的正文'}；章节接口也没拿到正文`
        }
      }
      // 再退一层：图片化正文 / 字形替换 / 空占位，按站点开关走 OCR
      if (
        bodyResult.failCode === 'Paywall' ||
        bodyResult.failCode === 'BodyGarbled' ||
        bodyResult.failCode === 'BodyEmpty' ||
        bodyResult.unlockReason
      ) {
        const viaOcr = await tryOcrUnlock(chapterUrl, bodyRule, dl)
        if (viaOcr) {
          const ocrChapter: ChapterFile = {
            title: ch.title,
            url: chapterUrl,
            body: viaOcr.body,
            bodyRaw: viaOcr.body,
            status: 'ready',
            unlockedBy: viaOcr.method,
          }
          await writeChapterFile(bookId, ch.id, ocrChapter)
          ch.status = 'ready'
          dl.done++
          return undefined
        }
        // OCR 为什么没成由 tryOcrUnlock 写进 dl.lastUnlockReason
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
  // 失败原因随章节文件一次写入（failCode + failMessage），不再另起一次 book.json 读改写。
  await writeChapterFile(bookId, chapterId, {
    title,
    url,
    body: '',
    status: 'failed',
    failCode,
    failMessage: failMessageText,
  })
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
): Promise<{ ok: true; bookId: string; added: number; changed: number } | { ok: false; code?: FailCode; message: string }> {
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
        : await collectCatalogWithPages(catHtml, sourceUrl, catRule, loadPageHtml)
    if (chapters.length === 0) {
      return { ok: false, code: 'CatalogNotFound', message: '目录页无法访问或内容变化' }
    }

    const { added, changed } = mergeIncomingChapters(book, chapters, { requeueChangedUrls: true })
    book.status = 'downloading'
    await saveBook(book)

    try {
      const dl: ActiveDownload = {
        bookId,
        title: book.title,
        total: book.chapters.length,
        done: book.chapters.filter((c) => c.status === 'ready').length,
        failed: 0,
        cancelled: false,
        deferTerminal: true,
      }
      active.set(bookId, dl)
      void emitProgress(bookId)
      const job = downloadChapters(bookId).catch(() => {})
      runningJobs.add(job)
      void job.finally(() => runningJobs.delete(job))
    } catch (e: unknown) {
      // book.json 已写成 downloading，任务却没起来：按实际章节重算，别卡在「下载中」。
      active.delete(bookId)
      await refreshBookStatus(bookId).catch(() => {})
      throw e
    }
    return { ok: true, bookId, added, changed }
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
        results.push({ ok: true, bookId: res.bookId, title: b.title, added: res.added, changed: res.changed })
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
    const chapters: CatalogChapter[] = await collectCatalogWithPages(catHtml, book.sourceUrl, catRule, loadPageHtml)
    if (chapters.length === 0) {
      return { ok: false, message: '目录页无法访问或内容变化' }
    }

    mergeIncomingChapters(book, chapters)
    for (const ch of book.chapters) {
      if (chapterNeedsDownload(ch.status) && ch.status !== 'pending') ch.status = 'pending'
    }
    book.status = 'downloading'
    await saveBook(book)

    try {
      const dl: ActiveDownload = {
        bookId,
        title: book.title,
        total: book.chapters.length,
        done: book.chapters.filter((c) => c.status === 'ready').length,
        failed: 0,
        cancelled: false,
        deferTerminal: true,
      }
      active.set(bookId, dl)
      void emitProgress(bookId)
      const job = downloadChapters(bookId).catch(() => {})
      runningJobs.add(job)
      void job.finally(() => runningJobs.delete(job))
    } catch (e: unknown) {
      // book.json 已写成 downloading，任务却没起来：按实际章节重算，别卡在「下载中」。
      active.delete(bookId)
      await refreshBookStatus(bookId).catch(() => {})
      throw e
    }
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
