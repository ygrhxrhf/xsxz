import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import type { FailCode, MirrorBookResult, MirrorPlanItem, MirrorProgress, MirrorStateView } from '../shared/types'
import { canonicalizeUrl } from '../shared/urlHash'

/**
 * 整站镜像：把一个分类 / 作者 / 搜索结果列表页里的书批量下进书库。
 *
 * 边界（一期）：
 * - 只跟同源的「下一页」，最多 MIRROR_MAX_PAGES 页；
 * - 每本仍走 `download.startDownloadFromPage` 那条既有通道（隐藏视图 + 通用提取 + 撞墙暂停），
 *   所以镜像不另写一套抓正文逻辑，也不绕开登录态；
 * - 单任务锁：一本书下载完再开下一本，与「下载本书」互斥；
 * - 已完整入库的书按书目地址跳过，不重新抓；只下了一半的书仍交给下载层补章。
 */

export const MIRROR_DEFAULT_MAX_BOOKS = 10
export const MIRROR_MAX_BOOKS = 50
export const MIRROR_DEFAULT_MAX_PAGES = 3
export const MIRROR_MAX_PAGES = 10
const MIRROR_WAIT_SLICE_MS = 1_000
const MIRROR_WAIT_LIMIT_MS = 30 * 60_000
/** 取消 / 撞墙后等下载层收尾：不能再用 30 分钟预算，否则「立即停批」会变成空等。 */
const MIRROR_CLEANUP_WAIT_MS = 5_000

export interface MirrorCandidate {
  url: string
  title: string
}

export interface MirrorStartOptions {
  seedUrl?: string
  maxBooks?: number
  maxPages?: number
  /** 继续上次被取消 / 中断的任务；只处理上次没完成的书目。 */
  resume?: boolean
}

export interface MirrorDeps {
  loadHtml(url: string): Promise<string>
  startBook(html: string, url: string): Promise<{ ok: boolean; bookId?: string; message?: string; code?: string }>
  /** 等一个时间片：true = 下载队列已空闲，false = 仍忙。 */
  waitIdle(sliceMs: number): Promise<boolean>
  /** 当前下载是否停在站点墙上等人工处理；有则给出墙的类型。 */
  blockedReason?(): FailCode | null
  cancelBook(bookId: string): void
  /** 书库里的真值：这本书是否已存在、是否已完整。返回 null 表示没有。 */
  lookupExisting(url: string): Promise<{ bookId: string; complete: boolean } | null>
  /** 预取下一本的书目页；与下载并行，失败不影响主流程。 */
  prefetch?(url: string): void
  /** 任务收尾（done / cancelled / error）后调用一次，用来拆掉预取视图这类一次性资源。 */
  onFinish?(): void
  emit(progress: MirrorProgress): void
  saveState(progress: MirrorProgress): Promise<void>
  now(): number
}

type MirrorWaitResult =
  | { kind: 'idle' }
  | { kind: 'cancelled' }
  | { kind: 'blocked'; code: FailCode }
  | { kind: 'timeout' }

const WALL_TEXT: Partial<Record<FailCode, string>> = {
  NeedLogin: '需要登录',
  Paywall: '付费墙',
  Intercepted: '站点拦截',
}

function wallText(code: FailCode): string {
  return WALL_TEXT[code] ?? '站点墙'
}

function wallHalt(title: string, code: FailCode): string {
  return `撞到站点墙，已停止批量（《${title}》）：${wallText(code)}。处理后可点「继续上次」`
}

const BOOK_SEGMENT = /\/(book|novel|info|read|txt|article|story|n|b)\//i
const NON_BOOK = /(login|log-in|logout|signin|sign-in|signup|register|account|user|search|rank|ranking|toplist|top\b|shelf|bookcase|contact|about|help|privacy|terms|tag\/|category\/|sort\/|page\/|index\.)/i
const NEXT_TEXTS = new Set(['下一页', '下页', '下一頁', 'next', 'next page', '›', '»', '>', '>>'])
const ASSET_EXT = /\.(?:jpe?g|png|gif|webp|svg|css|js|ico|zip|rar|7z|pdf|mp3|mp4|woff2?|ttf)$/i
const LOAD_ATTEMPTS = 2

/** 从列表页取「像一本书」的同源链接，按可信度排序后去重。 */
export function extractMirrorBookLinks(html: string, pageUrl: string): MirrorCandidate[] {
  const base = new URL(pageUrl)
  const origin = base.origin
  const doc = new JSDOM(html, { url: pageUrl }).window.document
  const scored: Array<{ candidate: MirrorCandidate; score: number; order: number }> = []
  let order = 0
  for (const anchor of Array.from(doc.querySelectorAll('a[href]'))) {
    const raw = anchor.getAttribute('href')?.trim() ?? ''
    if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:')) continue
    let url: URL
    try {
      url = new URL(raw, pageUrl)
    } catch {
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    if (url.origin !== origin) continue
    url.hash = ''
    if (canonicalizeUrl(url.toString()) === canonicalizeUrl(pageUrl)) continue
    const title = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (title.length < 2 || title.length > 60) continue
    if (NEXT_TEXTS.has(title.toLowerCase())) continue
    if (ASSET_EXT.test(url.pathname)) continue
    if (NON_BOOK.test(url.pathname + url.search)) continue
    let score = 0
    if (BOOK_SEGMENT.test(url.pathname)) score += 3
    if (/\/\d+(?:\/|$)/.test(url.pathname)) score += 1
    if (anchor.closest('li, .item, .book, .list, .result, tr')) score += 1
    scored.push({ candidate: { url: url.toString(), title }, score, order: order++ })
  }
  const preferred = scored.some((item) => item.score > 0)
  const picked = preferred ? scored.filter((item) => item.score > 0) : scored
  const seen = new Set<string>()
  const result: MirrorCandidate[] = []
  picked
    .slice()
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .forEach((item) => {
      const key = canonicalizeUrl(item.candidate.url)
      if (seen.has(key)) return
      seen.add(key)
      result.push(item.candidate)
    })
  return result
}

/** 同源「下一页」链接；没有就返回 null。 */
export function findMirrorNextPage(html: string, pageUrl: string): string | null {
  const base = new URL(pageUrl)
  const doc = new JSDOM(html, { url: pageUrl }).window.document
  const anchors = Array.from(doc.querySelectorAll('a[href]'))
  const byRel = anchors.find((anchor) => (anchor.getAttribute('rel') ?? '').toLowerCase() === 'next')
  const byText = anchors.find((anchor) => NEXT_TEXTS.has((anchor.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase()))
  const anchor = byRel ?? byText
  if (!anchor) return null
  const raw = anchor.getAttribute('href')?.trim() ?? ''
  if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return null
  let url: URL
  try {
    url = new URL(raw, pageUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.origin !== base.origin) return null
  url.hash = ''
  // Compare raw URLs: canonicalizeUrl drops `page`, which is exactly the parameter pagination uses.
  if (url.toString() === base.toString()) return null
  return url.toString()
}

export function clampMirrorOptions(options: MirrorStartOptions): { maxBooks: number; maxPages: number } {
  const books = Number.isSafeInteger(options.maxBooks) ? (options.maxBooks as number) : MIRROR_DEFAULT_MAX_BOOKS
  const pages = Number.isSafeInteger(options.maxPages) ? (options.maxPages as number) : MIRROR_DEFAULT_MAX_PAGES
  return {
    maxBooks: Math.min(MIRROR_MAX_BOOKS, Math.max(1, books)),
    maxPages: Math.min(MIRROR_MAX_PAGES, Math.max(1, pages)),
  }
}

let deps: MirrorDeps | null = null
let current: MirrorProgress | null = null
let cancelled = false
let currentBookId: string | undefined

export function setMirrorDeps(next: MirrorDeps): void {
  deps = next
}

export function setMirrorLastState(progress: MirrorProgress | null): void {
  if (current?.status === 'running') return
  current = progress
}

export function resetMirrorForTests(): void {
  deps = null
  current = null
  cancelled = false
  currentBookId = undefined
}

export function getMirrorState(): MirrorStateView {
  return { running: current?.status === 'running', last: current ? snapshot(current) : null }
}

export function cancelMirror(): void {
  if (current?.status !== 'running') return
  cancelled = true
  if (currentBookId) deps?.cancelBook(currentBookId)
}

async function waitForDownloadSlot(deadline: number = deps!.now() + MIRROR_WAIT_LIMIT_MS): Promise<MirrorWaitResult> {
  const d = deps!
  for (;;) {
    if (cancelled) return { kind: 'cancelled' }
    const blocked = d.blockedReason?.() ?? null
    if (blocked !== null) return { kind: 'blocked', code: blocked }
    if (await d.waitIdle(MIRROR_WAIT_SLICE_MS)) return { kind: 'idle' }
    if (d.now() >= deadline) return { kind: 'timeout' }
  }
}

/** 书库对账读失败时退回上一次的判据，不让一次读盘失败把书误判成没下过。 */
async function readExisting(url: string, fallback: { bookId: string; complete: boolean } | null): Promise<{ bookId: string; complete: boolean } | null> {
  try {
    return (await deps!.lookupExisting(url)) ?? fallback
  } catch {
    return fallback
  }
}

export async function startMirror(options: MirrorStartOptions): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  if (!deps) return { ok: false, message: '镜像模块未初始化' }
  if (current?.status === 'running') return { ok: false, message: '已有镜像任务在进行中，请等待完成或取消' }
  const seedUrl = (options.seedUrl ?? '').trim()
  if (!/^https?:\/\//i.test(seedUrl)) return { ok: false, message: '请先打开一个分类页或作者页' }
  const { maxBooks, maxPages } = clampMirrorOptions(options)
  cancelled = false
  currentBookId = undefined

  if (options.resume) {
    const previous = current
    const sameSeed = previous !== null && canonicalizeUrl(previous.seedUrl) === canonicalizeUrl(seedUrl)
    if (!previous || !sameSeed) return { ok: false, message: '没有可继续的镜像任务，请重新开始' }
    if (!Array.isArray(previous.plan) || previous.plan.length === 0) return { ok: false, message: '上次任务没有保存书目，请重新开始' }
    // 续跑从书目重新对账：完整已入库的会被跳过，未完成 / 失败的重下。
    // 不沿用上次的 results，否则同一条目会重复计数，半本书也会被当成已完成。
    const job: MirrorProgress = {
      ...previous,
      jobId: randomUUID(),
      status: 'running',
      total: previous.plan.length,
      done: 0,
      failed: 0,
      skipped: 0,
      results: [],
      currentTitle: undefined,
      message: undefined,
      interrupted: undefined,
    }
    current = job
    void run(job, maxBooks, maxPages, previous.plan)
    return { ok: true, jobId: job.jobId }
  }

  const job: MirrorProgress = {
    jobId: randomUUID(),
    seedUrl,
    status: 'running',
    total: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    pagesScanned: 0,
    results: [],
    plan: [],
  }
  current = job
  void run(job, maxBooks, maxPages, null)
  return { ok: true, jobId: job.jobId }
}

function snapshot(progress: MirrorProgress): MirrorProgress {
  return {
    ...progress,
    results: progress.results.map((item) => ({ ...item })),
    ...(progress.plan === undefined ? {} : { plan: progress.plan.map((item) => ({ ...item })) }),
  }
}

async function publish(job: MirrorProgress): Promise<void> {
  const snap = snapshot(job)
  deps?.emit(snap)
  try {
    await deps?.saveState(snap)
  } catch {
    /* 状态落盘失败不影响镜像本身 */
  }
}

async function loadWithRetry(url: string): Promise<string> {
  const d = deps
  if (!d) throw new Error('镜像模块未初始化')
  let lastError: unknown
  for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt++) {
    try {
      return await d.loadHtml(url)
    } catch (error) {
      lastError = error
      if (cancelled || attempt === LOAD_ATTEMPTS) break
      await new Promise((resolve) => setTimeout(resolve, attempt * 400))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function discover(job: MirrorProgress, maxBooks: number, maxPages: number): Promise<MirrorPlanItem[]> {
  const candidates: MirrorCandidate[] = []
  const seenBooks = new Set<string>()
  const seenPages = new Set<string>()
  let next: string | null = job.seedUrl
  while (next && job.pagesScanned < maxPages && !cancelled) {
    const pageUrl = next
    // 翻页身份用原始 URL：canonicalizeUrl 会删掉 page 参数（标注身份用），拿它去重会把第二页当成第一页。
    seenPages.add(new URL(pageUrl).toString())
    let html: string
    try {
      html = await loadWithRetry(pageUrl)
    } catch (error) {
      if (job.pagesScanned === 0) throw error
      break
    }
    job.pagesScanned += 1
    for (const candidate of extractMirrorBookLinks(html, pageUrl)) {
      const key = canonicalizeUrl(candidate.url)
      if (seenBooks.has(key)) continue
      seenBooks.add(key)
      candidates.push(candidate)
    }
    if (candidates.length >= maxBooks) break
    next = findMirrorNextPage(html, pageUrl)
    if (next && seenPages.has(new URL(next).toString())) next = null
  }
  return candidates.slice(0, maxBooks).map((candidate) => ({ url: candidate.url, title: candidate.title }))
}

interface BookRun {
  outcome: MirrorBookResult | null
  haltedBy: FailCode | null
  cancelled: boolean
}

/** 一本书：对账 → 加载书目页 → 起下载 → 等它结束。取消 / 撞墙 / 超时都收敛成返回值。 */
async function runOneBook(
  item: MirrorPlanItem,
  upcoming: MirrorPlanItem | undefined,
  existing: { bookId: string; complete: boolean } | null,
  deadline: number,
): Promise<BookRun> {
  const d = deps!
  try {
    const latest = await readExisting(item.url, existing)
    if (latest?.complete) {
      return { outcome: { url: item.url, title: item.title, status: 'skipped', bookId: latest.bookId }, haltedBy: null, cancelled: false }
    }
    const html = await loadWithRetry(item.url)
    // 目录页加载也可能花上几秒：开下之前再确认一次，取消后不再建出一本半成品。
    if (cancelled) return { outcome: null, haltedBy: null, cancelled: true }
    const started = await d.startBook(html, item.url)
    if (!started.bookId) {
      return {
        outcome: {
          url: item.url,
          title: item.title,
          status: 'failed',
          ...(started.message === undefined ? {} : { message: started.message }),
          ...(started.code === undefined ? {} : { code: started.code as MirrorBookResult['code'] }),
        },
        haltedBy: null,
        cancelled: false,
      }
    }
    if (!started.ok) {
      // 下载层认出这是同一本已完整的书并拒绝重下：按「已在书库」处理。
      return { outcome: { url: item.url, title: item.title, status: 'skipped', bookId: started.bookId }, haltedBy: null, cancelled: false }
    }
    currentBookId = started.bookId
    // 下载这本书的时候，用独立的预取视图抓下一本的书目页。
    if (upcoming) d.prefetch?.(upcoming.url)
    const wait = await waitForDownloadSlot(deadline)
    if (wait.kind === 'cancelled') return { outcome: null, haltedBy: null, cancelled: true }
    if (wait.kind === 'blocked') {
      return {
        outcome: {
          url: item.url,
          title: item.title,
          status: 'failed',
          bookId: started.bookId,
          code: wait.code,
          message: `撞到${wallText(wait.code)}，已停止本批`,
        },
        haltedBy: wait.code,
        cancelled: false,
      }
    }
    if (wait.kind === 'timeout') {
      return {
        outcome: { url: item.url, title: item.title, status: 'failed', bookId: started.bookId, message: '等待下载任务结束超时，可继续重试' },
        haltedBy: null,
        cancelled: false,
      }
    }
    currentBookId = undefined
    if (cancelled) return { outcome: null, haltedBy: null, cancelled: true }
    // 下载层「跑完了」不等于整本完整：以书库为准，半本留给续跑补。
    const complete = (await readExisting(item.url, null))?.complete === true
    return {
      outcome: complete
        ? { url: item.url, title: item.title, status: 'downloaded', bookId: started.bookId }
        : { url: item.url, title: item.title, status: 'failed', bookId: started.bookId, message: '下载结束但书未完整，可继续重试' },
      haltedBy: null,
      cancelled: false,
    }
  } catch (error) {
    return {
      outcome: {
        url: item.url,
        title: item.title,
        status: 'failed',
        ...(error instanceof Error ? { message: error.message } : { message: String(error) }),
      },
      haltedBy: null,
      cancelled: false,
    }
  } finally {
    if (currentBookId) {
      const stuck = currentBookId
      currentBookId = undefined
      d.cancelBook(stuck)
      // 只等一小段：更长的收尾会拖住「停批」发布；等不到就让下一本的等锁循环接着等。
      await d.waitIdle(MIRROR_CLEANUP_WAIT_MS)
    }
  }
}

async function run(job: MirrorProgress, maxBooks: number, maxPages: number, pending: MirrorPlanItem[] | null): Promise<void> {
  const d = deps!
  try {
    if (pending === null) {
      const plan = await discover(job, maxBooks, maxPages)
      job.plan = plan
      job.total = plan.length
      await publish(job)
      if (job.total === 0) {
        job.status = 'error'
        job.message = '列表页没有找到可下载的书目链接，请确认这是分类 / 作者 / 搜索结果页'
        await publish(job)
        return
      }
      pending = plan
    } else {
      job.total = job.plan?.length ?? job.results.length + pending.length
      await publish(job)
    }

    let halt: string | null = null

    for (let index = 0; index < pending.length; index++) {
      const item = pending[index]!
      if (cancelled) break
      job.currentTitle = item.title
      await publish(job)

      const existing = await readExisting(item.url, null)
      let outcome: MirrorBookResult | null = null

      if (existing?.complete) {
        outcome = { url: item.url, title: item.title, status: 'skipped', bookId: existing.bookId }
      } else {
        // 每本书一个 30 分钟预算：等锁和下载共用，别让一本吃掉几次 30 分钟。
        const deadline = d.now() + MIRROR_WAIT_LIMIT_MS
        const slot = await waitForDownloadSlot(deadline)
        if (slot.kind === 'cancelled') break
        if (slot.kind === 'blocked') {
          outcome = { url: item.url, title: item.title, status: 'failed', code: slot.code, message: `撞到${wallText(slot.code)}，已停止本批` }
          halt = wallHalt(item.title, slot.code)
        } else if (slot.kind === 'timeout') {
          outcome = { url: item.url, title: item.title, status: 'failed', message: '等待其它下载任务结束超时' }
          halt = `等待其它下载任务结束超时，已停止批量（《${item.title}》）。检查其它下载后再点「继续上次」`
        } else {
          const bookRun = await runOneBook(item, pending[index + 1], existing, deadline)
          if (bookRun.cancelled) break
          outcome = bookRun.outcome
          if (bookRun.haltedBy !== null) halt = wallHalt(item.title, bookRun.haltedBy)
        }
      }

      if (outcome) {
        if (outcome.status === 'downloaded') job.done += 1
        else if (outcome.status === 'skipped') job.skipped += 1
        else job.failed += 1
        job.results.push(outcome)
      }
      await publish(job)
      if (halt !== null) break
    }

    job.currentTitle = undefined
    if (halt !== null) {
      job.status = 'error'
      job.message = halt
    } else {
      job.status = cancelled ? 'cancelled' : 'done'
      if (job.status === 'cancelled') job.message = '已取消，已入库的书保留，可继续'
    }
    await publish(job)
  } catch (error) {
    job.currentTitle = undefined
    job.status = 'error'
    job.message = error instanceof Error ? error.message : String(error)
    await publish(job)
  } finally {
    // 收尾无论成败都跑一次：预取视图 / 队列不该在一个结束的任务后面继续占资源。
    try {
      d.onFinish?.()
    } catch {
      /* 释放失败不影响任务结果 */
    }
  }
}
