import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import type { MirrorBookResult, MirrorProgress, MirrorStateView } from '../shared/types'
import { canonicalizeUrl } from '../shared/urlHash'

/**
 * 整站镜像：把一个分类 / 作者 / 搜索结果列表页里的书批量下进书库。
 *
 * 边界（一期）：
 * - 只跟同源的「下一页」，最多 MIRROR_MAX_PAGES 页；
 * - 每本仍走 `download.startDownloadFromPage` 那条既有通道（隐藏视图 + 通用提取 + 撞墙暂停），
 *   所以镜像不另写一套抓正文逻辑，也不绕开登录态；
 * - 单任务锁：一本书下载完再开下一本，与「下载本书」互斥。
 */

export const MIRROR_DEFAULT_MAX_BOOKS = 10
export const MIRROR_MAX_BOOKS = 50
export const MIRROR_DEFAULT_MAX_PAGES = 3
export const MIRROR_MAX_PAGES = 10

export interface MirrorCandidate {
  url: string
  title: string
}

export interface MirrorStartOptions {
  seedUrl?: string
  maxBooks?: number
  maxPages?: number
}

export interface MirrorDeps {
  loadHtml(url: string): Promise<string>
  startBook(html: string, url: string): Promise<{ ok: boolean; bookId?: string; message?: string }>
  waitIdle(): Promise<void>
  cancelBook(bookId: string): void
  emit(progress: MirrorProgress): void
  saveState(progress: MirrorProgress): Promise<void>
  now(): number
}

const BOOK_SEGMENT = /\/(book|novel|info|read|txt|article|story|n|b)\//i
const NON_BOOK = /(login|log-in|logout|signin|sign-in|signup|register|account|user|search|rank|ranking|toplist|top\b|shelf|bookcase|contact|about|help|privacy|terms|tag\/|category\/|sort\/|page\/|index\.)/i
const NEXT_TEXTS = new Set(['下一页', '下页', '下一頁', 'next', 'next page', '›', '»', '>', '>>'])
const ASSET_EXT = /\.(?:jpe?g|png|gif|webp|svg|css|js|ico|zip|rar|7z|pdf|mp3|mp4|woff2?|ttf)$/i

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

export async function startMirror(options: MirrorStartOptions): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  if (!deps) return { ok: false, message: '镜像模块未初始化' }
  if (current?.status === 'running') return { ok: false, message: '已有镜像任务在进行中，请等待完成或取消' }
  const seedUrl = (options.seedUrl ?? '').trim()
  if (!/^https?:\/\//i.test(seedUrl)) return { ok: false, message: '请先打开一个分类页或作者页' }
  const { maxBooks, maxPages } = clampMirrorOptions(options)
  cancelled = false
  currentBookId = undefined
  const job: MirrorProgress = {
    jobId: randomUUID(),
    seedUrl,
    status: 'running',
    total: 0,
    done: 0,
    failed: 0,
    pagesScanned: 0,
    results: [],
  }
  current = job
  void run(job, maxBooks, maxPages)
  return { ok: true, jobId: job.jobId }
}

function snapshot(progress: MirrorProgress): MirrorProgress {
  return { ...progress, results: progress.results.map((item) => ({ ...item })) }
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

async function run(job: MirrorProgress, maxBooks: number, maxPages: number): Promise<void> {
  const d = deps
  if (!d) return
  try {
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
        html = await d.loadHtml(pageUrl)
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

    job.total = Math.min(candidates.length, maxBooks)
    await publish(job)
    if (job.total === 0) {
      job.status = 'error'
      job.message = '列表页没有找到可下载的书目链接，请确认这是分类 / 作者 / 搜索结果页'
      await publish(job)
      return
    }

    for (const candidate of candidates.slice(0, maxBooks)) {
      if (cancelled) break
      job.currentTitle = candidate.title
      await publish(job)
      let started: { ok: boolean; bookId?: string; message?: string }
      try {
        const html = await d.loadHtml(candidate.url)
        started = await d.startBook(html, candidate.url)
      } catch (error) {
        started = { ok: false, message: error instanceof Error ? error.message : '加载失败' }
      }
      if (started.ok && started.bookId) {
        job.done += 1
        currentBookId = started.bookId
        const result: MirrorBookResult = {
          url: candidate.url,
          title: candidate.title,
          status: 'downloaded',
          bookId: started.bookId,
        }
        job.results.push(result)
        await d.waitIdle()
        currentBookId = undefined
      } else {
        job.failed += 1
        job.results.push({
          url: candidate.url,
          title: candidate.title,
          status: 'failed',
          message: started.message || '无法识别为书',
        })
        await publish(job)
      }
    }

    job.currentTitle = undefined
    job.status = cancelled ? 'cancelled' : 'done'
    if (job.status === 'cancelled') job.message = '已取消，已入库的书保留'
    await publish(job)
  } catch (error) {
    job.currentTitle = undefined
    job.status = 'error'
    job.message = error instanceof Error ? error.message : String(error)
    await publish(job)
  }
}
