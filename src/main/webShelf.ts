import { app } from 'electron'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from './atomicFile'
import { canonicalBookId } from './library'
import { normalizeHost } from './siteRules'
import { loadCatalog, loadPageBootstrap } from './readingSession'
import type { WebShelfBook, WebShelfChapter, WebShelfProgress } from '../shared/types'

/**
 * 网页书架：只保存书目、目录快照与阅读位置，不保存正文。
 * 磁盘格式见 `docs/disk-schema.md` 的「网页书架」。文件不进书库备份。
 */
const FILE_VERSION = 1
export const WEB_SHELF_BOOK_LIMIT = 500
export const WEB_SHELF_CHAPTER_LIMIT = 3000
/** 同一本书两次刷新之间的最小间隔，避免连点刷新打站点。 */
export const REFRESH_BACKOFF_MS = 10 * 60 * 1000
export const REFRESH_ALL_LIMIT = 50
export const REFRESH_ALL_GAP_MS = 800

export type ShelfChangeReason = 'add' | 'remove' | 'refresh' | 'progress'

interface WebShelfFile {
  version: number
  books: WebShelfBook[]
}

export type ShelfResult<T> = { ok: true } & T | { ok: false; message: string }

let state: WebShelfFile | null = null
let pending: Promise<void> = Promise.resolve()
let overrideDir: string | null = null
let changeListener: ((reason: ShelfChangeReason) => void) | null = null

function filePath(): string {
  return join(overrideDir ?? app.getPath('userData'), 'web-shelf.json')
}

export function setWebShelfDirForTests(dir: string | null): void {
  overrideDir = dir
  state = null
  pending = Promise.resolve()
}

export function setWebShelfChangeListener(listener: ((reason: ShelfChangeReason) => void) | null): void {
  changeListener = listener
}

function notify(reason: ShelfChangeReason): void {
  try { changeListener?.(reason) } catch { /* 广播失败不影响落盘 */ }
}

function isHttpUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try { return ['http:', 'https:'].includes(new URL(url).protocol) } catch { return false }
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/#.*$/, '')
}

function asChapter(value: unknown): WebShelfChapter | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (typeof item.title !== 'string' || !isHttpUrl(item.url)) return null
  const title = item.title.trim().slice(0, 200) || '未命名章节'
  return { title, url: normalizeUrl(item.url) }
}

function dedupeChapters(chapters: WebShelfChapter[]): WebShelfChapter[] {
  const seen = new Set<string>()
  const out: WebShelfChapter[] = []
  for (const chapter of chapters) {
    const key = chapter.url
    if (seen.has(key)) continue
    seen.add(key)
    out.push(chapter)
    if (out.length >= WEB_SHELF_CHAPTER_LIMIT) break
  }
  return out
}

function asProgress(value: unknown): WebShelfProgress | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const paragraph = item.paragraphIndex
  const ratio = item.scrollRatio
  return {
    paragraphIndex: typeof paragraph === 'number' && Number.isFinite(paragraph) && paragraph >= 0 ? Math.trunc(paragraph) : 0,
    scrollRatio: typeof ratio === 'number' && Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
  }
}

/** 单条非法时只丢弃该条，不影响其它条目。 */
function asBook(value: unknown): WebShelfBook | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || !item.id || !isHttpUrl(item.catalogUrl)) return null
  const lastChapter = asChapter(item.lastChapter)
  if (!lastChapter) return null
  const chapters = Array.isArray(item.chapters)
    ? item.chapters.map(asChapter).filter((chapter): chapter is WebShelfChapter => chapter !== null)
    : []
  return {
    id: item.id,
    host: typeof item.host === 'string' ? item.host : normalizeHost(item.catalogUrl),
    title: typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 200) : '未命名',
    author: typeof item.author === 'string' ? item.author.trim().slice(0, 120) : '',
    coverUrl: isHttpUrl(item.coverUrl) ? String(item.coverUrl) : undefined,
    catalogUrl: normalizeUrl(item.catalogUrl),
    lastChapter,
    chapters: dedupeChapters(chapters),
    chaptersFetchedAt: typeof item.chaptersFetchedAt === 'string' ? item.chaptersFetchedAt : '',
    addedChapters: typeof item.addedChapters === 'number' && Number.isFinite(item.addedChapters) && item.addedChapters > 0
      ? Math.trunc(item.addedChapters) : 0,
    lastRefreshedAt: typeof item.lastRefreshedAt === 'string' ? item.lastRefreshedAt : '',
    progress: asProgress(item.progress),
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
  }
}

function sortBooks(books: WebShelfBook[]): WebShelfBook[] {
  const time = (value: string): number => {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return [...books].sort((a, b) => {
    const aKey = a.progress?.updatedAt || a.createdAt
    const bKey = b.progress?.updatedAt || b.createdAt
    return time(bKey) - time(aKey)
  })
}

async function load(): Promise<WebShelfFile> {
  if (state) return state
  let raw: unknown
  try { raw = JSON.parse(await readFile(filePath(), 'utf-8')) } catch { raw = {} }
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const list = Array.isArray(input.books) ? input.books : []
  const books: WebShelfBook[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const book = asBook(item)
    if (!book || seen.has(book.id)) continue
    seen.add(book.id)
    books.push(book)
    if (books.length >= WEB_SHELF_BOOK_LIMIT) break
  }
  state = { version: FILE_VERSION, books }
  return state
}

function save(): Promise<void> {
  pending = pending.catch(() => {}).then(async () => {
    await mkdir(join(filePath(), '..'), { recursive: true })
    await atomicWriteText(filePath(), JSON.stringify(state, null, 2))
  })
  return pending
}

function bookId(host: string, catalogUrl: string): string {
  return canonicalBookId(host, catalogUrl)
}

export function webShelfBookIdForUrl(url: string): string | null {
  if (!isHttpUrl(url)) return null
  const host = normalizeHost(url)
  const catalogUrl = normalizeUrl(url)
  try { return bookId(host, catalogUrl) } catch { return null }
}

export async function listWebShelf(): Promise<WebShelfBook[]> {
  return sortBooks((await load()).books)
}

async function findBook(id: string): Promise<WebShelfBook | undefined> {
  return (await load()).books.find((book) => book.id === id)
}

/** 目录里匹配当前章节的位置；找不到返回 -1。 */
function chapterIndex(chapters: WebShelfChapter[], url: string): number {
  const target = normalizeUrl(url)
  return chapters.findIndex((chapter) => chapter.url === target)
}

/**
 * 加入书架：以当前页为入口，能认目录就存目录快照，认不出也允许加入。
 * 同一本书重复加入时更新原条目并保留阅读位置。
 */
export async function addWebShelf(input: { url?: string }): Promise<ShelfResult<{ book: WebShelfBook }>> {
  const url = typeof input?.url === 'string' ? input.url.trim() : ''
  if (!isHttpUrl(url)) return { ok: false, message: '请先在内置浏览器里打开这本书的页面' }
  const bootstrap = await loadPageBootstrap(url)
  if (!bootstrap.ok) return { ok: false, message: bootstrap.message }
  const info = bootstrap.bootstrap
  const host = normalizeHost(info.pageUrl)
  const catalogUrl = normalizeUrl(info.catalogUrl || info.pageUrl)

  let chapters = dedupeChapters(info.chapters)
  if (!chapters.length && catalogUrl !== normalizeUrl(info.pageUrl)) {
    const catalog = await loadCatalog(catalogUrl)
    if (catalog.ok) chapters = dedupeChapters(catalog.chapters)
  } else if (!chapters.length && info.pageKind === 'chapter') {
    const catalog = await loadCatalog(info.pageUrl)
    if (catalog.ok) chapters = dedupeChapters(catalog.chapters)
  }

  const shelf = await load()
  const id = bookId(host, catalogUrl)
  const now = new Date().toISOString()
  const existing = shelf.books.find((book) => book.id === id)
  const lastChapter = chapters[chapterIndex(chapters, info.pageUrl)] ?? { title: info.title, url: normalizeUrl(info.pageUrl) }

  const book: WebShelfBook = {
    id,
    host,
    title: info.title || existing?.title || '未命名',
    author: info.author || existing?.author || '',
    coverUrl: info.coverUrl ?? existing?.coverUrl,
    catalogUrl,
    lastChapter,
    chapters,
    chaptersFetchedAt: chapters.length ? now : existing?.chaptersFetchedAt ?? '',
    addedChapters: existing?.addedChapters ?? 0,
    lastRefreshedAt: existing?.lastRefreshedAt ?? '',
    progress: existing?.progress ?? null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }

  if (existing) Object.assign(existing, book)
  else {
    shelf.books.unshift(book)
    while (shelf.books.length > WEB_SHELF_BOOK_LIMIT) shelf.books.pop()
  }
  await save()
  notify('add')
  return { ok: true, book }
}

export async function removeWebShelf(id: string): Promise<{ ok: boolean }> {
  const shelf = await load()
  const before = shelf.books.length
  shelf.books = shelf.books.filter((book) => book.id !== id)
  if (shelf.books.length === before) return { ok: false }
  await save()
  notify('remove')
  return { ok: true }
}

export async function getWebShelfBook(id: string): Promise<WebShelfBook | undefined> {
  const book = await findBook(id)
  return book ? { ...book } : undefined
}

/**
 * 判断某个章节地址属于书架里的哪本书，并给出它在目录中的位置。
 * 目录里没有这一章时仍返回书（靠目录前缀猜），index 为 -1。
 */
export async function locateChapterInShelf(url: string): Promise<{ bookId: string; index: number; total: number } | null> {
  if (!isHttpUrl(url)) return null
  const target = normalizeUrl(url)
  const books = await listWebShelf()
  for (const book of books) {
    const index = chapterIndex(book.chapters, target)
    if (index >= 0) return { bookId: book.id, index, total: book.chapters.length }
    if (book.lastChapter.url === target) return { bookId: book.id, index: -1, total: book.chapters.length }
  }
  for (const book of books) {
    if (target.startsWith(book.catalogUrl)) return { bookId: book.id, index: -1, total: book.chapters.length }
  }
  return null
}

export async function getWebShelfChapters(id: string): Promise<ShelfResult<{ chapters: WebShelfChapter[]; currentIndex: number }>> {
  const book = await findBook(id)
  if (!book) return { ok: false, message: '这本书已不在书架里' }
  return { ok: true, chapters: book.chapters, currentIndex: chapterIndex(book.chapters, book.lastChapter.url) }
}

/** 刷新目录并算出新增章数；同一本书 10 分钟内不重复抓取。 */
export async function refreshWebShelf(id: string): Promise<ShelfResult<{ added: number; book: WebShelfBook }>> {
  const shelf = await load()
  const book = shelf.books.find((item) => item.id === id)
  if (!book) return { ok: false, message: '这本书已不在书架里' }
  const lastAt = Date.parse(book.lastRefreshedAt)
  if (Number.isFinite(lastAt) && Date.now() - lastAt < REFRESH_BACKOFF_MS) {
    return { ok: true, added: 0, book: { ...book } }
  }
  const catalog = await loadCatalog(book.catalogUrl)
  if (!catalog.ok) return { ok: false, message: catalog.message }
  const next = dedupeChapters(catalog.chapters)
  const known = new Set(book.chapters.map((chapter) => chapter.url))
  const added = next.filter((chapter) => !known.has(chapter.url)).length
  const now = new Date().toISOString()
  book.chapters = next
  book.chaptersFetchedAt = now
  book.lastRefreshedAt = now
  book.addedChapters = added
  book.updatedAt = now
  book.catalogUrl = normalizeUrl(catalog.catalogUrl)
  await save()
  notify('refresh')
  return { ok: true, added, book: { ...book } }
}

/** 逐本刷新：串行、限量、带间隔，失败逐本跳过不中断。 */
export async function refreshAllWebShelf(): Promise<{ ok: true; checked: number; updated: number }> {
  const shelf = await load()
  const targets = shelf.books.slice(0, REFRESH_ALL_LIMIT)
  let checked = 0
  let updated = 0
  for (const book of targets) {
    checked++
    const result = await refreshWebShelf(book.id)
    if (result.ok && result.added > 0) updated++
    await delay(REFRESH_ALL_GAP_MS)
  }
  return { ok: true, checked, updated }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 保存阅读位置：段落锚点 + 滚动比例，同时把最近章节写回目录快照。 */
export async function setWebShelfProgress(
  id: string,
  chapter: WebShelfChapter,
  paragraphIndex: number,
  scrollRatio: number,
): Promise<{ ok: boolean }> {
  const shelf = await load()
  const book = shelf.books.find((item) => item.id === id)
  if (!book) return { ok: false }
  const now = new Date().toISOString()
  book.progress = asProgress({ paragraphIndex, scrollRatio, updatedAt: now })
  const safeChapter = asChapter(chapter)
  if (safeChapter) book.lastChapter = safeChapter
  book.updatedAt = now
  await save()
  notify('progress')
  return { ok: true }
}
