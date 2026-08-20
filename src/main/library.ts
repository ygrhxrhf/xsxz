import { mkdir, readFile, writeFile, readdir, rm, stat, cp } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import type {
  AiSummaries,
  Book,
  BookListItem,
  CatalogChapter,
  ChapterFile,
  ChapterMeta,
  ChapterStatus,
  FailCode,
  ImportType,
  ReadingProgress,
} from '../shared/types'
import { DEFAULT_LIBRARY_PATH } from '../shared/types'
import { canonicalizeUrl } from '../shared/urlHash'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let currentLibraryPath = DEFAULT_LIBRARY_PATH

export function getLibraryPath(): string {
  return currentLibraryPath
}

export async function setLibraryPath(next: string): Promise<void> {
  const trimmed = (next || '').trim() || DEFAULT_LIBRARY_PATH
  currentLibraryPath = trimmed
  await ensureLibrary()
}

export function bookDir(bookId: string): string {
  return join(getLibraryPath(), bookId)
}

function chapterPath(bookId: string, file: string): string {
  return join(bookDir(bookId), file)
}

function indexFile(): string {
  return join(getLibraryPath(), 'index.json')
}

export function bookIdFromUrl(host: string, catalogUrl: string): string {
  const href = canonicalizeUrl(catalogUrl)
  const clean = `${host}\n${href}`.toLowerCase()
  return 'd_' + createHash('sha256').update(clean).digest('hex').slice(0, 16)
}

export function assertImportable(
  filePath: string,
): { ok: true } | { ok: false; message: string } {
  const ext = extname(filePath || '').toLowerCase()
  if (ext === '.txt' || ext === '.epub') return { ok: true }
  const typeLabel = ext ? ext.slice(1) : '无后缀'
  return {
    ok: false,
    message: `不支持的文件类型「${typeLabel}」，仅接受 txt / epub`,
  }
}

export function bookIdFromBytes(bytes: Uint8Array): string {
  return 'i_' + createHash('sha256').update(Buffer.from(bytes)).digest('hex').slice(0, 16)
}

export function normalizeChapterUrl(url: string): string {
  try {
    const u = new URL(canonicalizeUrl(url))
    u.hostname = u.hostname.toLowerCase()
    return u.toString()
  } catch {
    return url
  }
}

function now(): string {
  return new Date().toISOString()
}

function pad4(n: number): string {
  return String(n).padStart(4, '0')
}

function applyOverallStatus(book: Book): void {
  const allReady = book.chapters.length > 0 && book.chapters.every((c) => c.status === 'ready' || c.status === 'empty')
  book.status = allReady ? 'ready' : 'partial'
}

/** Serialize load-modify-save so setProgress cannot revert ready promotion. */
const bookLocks = new Map<string, Promise<unknown>>()

async function withBookLock<T>(bookId: string, fn: () => Promise<T>): Promise<T> {
  const prev = bookLocks.get(bookId) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = prev.then(() => mine)
  bookLocks.set(bookId, tail)
  await prev.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (bookLocks.get(bookId) === tail) bookLocks.delete(bookId)
  }
}

function chapterBodyText(file: Pick<ChapterFile, 'body'>): string {
  return typeof file.body === 'string' ? file.body.trim() : ''
}

function shouldPromoteReady(file: Pick<ChapterFile, 'body' | 'status'>): boolean {
  if (file.status === 'failed') return false
  if (file.status === 'ready') return true
  return chapterBodyText(file).length > 0 && (file.status === 'pending' || file.status === 'empty' || !file.status)
}

function applyChapterStatus(
  meta: ChapterMeta,
  status: ChapterStatus,
  extra?: { failCode?: FailCode; failMessage?: string; url?: string },
): void {
  meta.status = status
  if (extra?.url) meta.url = extra.url
  if (status === 'ready') {
    delete meta.failCode
    delete meta.failMessage
  } else if (extra?.failCode) {
    meta.failCode = extra.failCode
    meta.failMessage = extra.failMessage
  }
}

async function loadBookUnlocked(bookId: string): Promise<Book> {
  const raw = await readFile(join(bookDir(bookId), 'book.json'), 'utf-8')
  return JSON.parse(raw)
}

async function saveBookUnlocked(book: Book): Promise<void> {
  book.updatedAt = now()
  await mkdir(bookDir(book.id), { recursive: true })
  await writeFile(join(bookDir(book.id), 'book.json'), JSON.stringify(book, null, 2), 'utf-8')
}

async function persistChapterJson(bookId: string, relFile: string, data: ChapterFile): Promise<void> {
  await mkdir(join(bookDir(bookId), 'chapters'), { recursive: true })
  await writeFile(chapterPath(bookId, relFile), JSON.stringify(data, null, 2), 'utf-8')
}

async function reconcilePendingChapters(bookId: string): Promise<void> {
  await withBookLock(bookId, async () => {
    const book = await loadBookUnlocked(bookId)
    let dirty = false
    for (const meta of book.chapters) {
      try {
        const file = JSON.parse(await readFile(chapterPath(bookId, meta.file), 'utf-8')) as ChapterFile
        if (!shouldPromoteReady(file)) continue
        if (file.status !== 'ready') {
          file.status = 'ready'
          delete file.failCode
          await persistChapterJson(bookId, meta.file, file)
        }
        if (meta.status !== 'ready') {
          applyChapterStatus(meta, 'ready', { url: file.url })
          dirty = true
        }
      } catch {
        /* missing or corrupt chapter file */
      }
    }
    if (dirty) {
      if (book.status !== 'downloading') applyOverallStatus(book)
      await saveBookUnlocked(book)
    }
  })
}

/** Merge catalog entries into an existing book. Ready chapters stay; new ones append. Does not persist. */
export function mergeIncomingChapters(book: Book, incoming: CatalogChapter[]): { added: number } {
  const byUrl = new Map<string, ChapterMeta>()
  const byTitle = new Map<string, ChapterMeta>()
  for (const ch of book.chapters) {
    if (ch.url) byUrl.set(normalizeChapterUrl(ch.url), ch)
    const titleKey = ch.title.trim()
    if (titleKey && !byTitle.has(titleKey)) byTitle.set(titleKey, ch)
  }

  let nextIndex = book.chapters.length ? Math.max(...book.chapters.map((c) => c.index)) : 0
  let added = 0

  for (const inc of incoming) {
    const nurl = inc.url ? normalizeChapterUrl(inc.url) : ''
    const titleKey = inc.title.trim()
    const existing = (nurl && byUrl.get(nurl)) || (titleKey ? byTitle.get(titleKey) : undefined)
    if (existing) {
      if (inc.url && !existing.url) existing.url = inc.url
      if (nurl) byUrl.set(nurl, existing)
      continue
    }
    nextIndex++
    const meta: ChapterMeta = {
      id: `c${pad4(nextIndex)}`,
      index: nextIndex,
      title: inc.title,
      url: inc.url,
      file: `chapters/${pad4(nextIndex)}.json`,
      status: 'pending',
    }
    book.chapters.push(meta)
    if (nurl) byUrl.set(nurl, meta)
    if (titleKey && !byTitle.has(titleKey)) byTitle.set(titleKey, meta)
    added++
  }
  return { added }
}

// ---------------------------------------------------------------------------
// ensure dirs
// ---------------------------------------------------------------------------

export async function ensureLibrary(): Promise<void> {
  await mkdir(getLibraryPath(), { recursive: true })
  await mkdir(join(getLibraryPath(), '__tmp__'), { recursive: true }).catch(() => {})
}

// ---------------------------------------------------------------------------
// index (cache)
// ---------------------------------------------------------------------------

interface IndexData {
  version: number
  books: BookListItem[]
}

async function writeIndex(data: IndexData): Promise<void> {
  await writeFile(indexFile(), JSON.stringify(data, null, 2), 'utf-8')
}

export async function rebuildIndex(): Promise<BookListItem[]> {
  const lib = getLibraryPath()
  let entries: string[]
  try {
    entries = (await readdir(lib, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('__'))
      .map((d) => d.name)
  } catch {
    return []
  }
  const items: BookListItem[] = []
  for (const id of entries) {
    try {
      await reconcilePendingChapters(id)
      const book = await loadBook(id)
      items.push(bookToList(book))
    } catch {
      /* skip corrupt */
    }
  }
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  await writeIndex({ version: 1, books: items })
  return items
}

function bookToList(b: Book): BookListItem {
  const readyCount = b.chapters.filter((c) => c.status === 'ready').length
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    importType: b.importType,
    status: b.status,
    chapterCount: b.chapters.length,
    readyCount,
    progress: b.progress,
    updatedAt: b.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function bookExists(bookId: string): Promise<boolean> {
  try {
    await stat(join(bookDir(bookId), 'book.json'))
    return true
  } catch {
    return false
  }
}

export async function loadBook(bookId: string): Promise<Book> {
  return loadBookUnlocked(bookId)
}

export async function saveBook(book: Book): Promise<void> {
  await withBookLock(book.id, async () => {
    await saveBookUnlocked(book)
  })
}

export async function listBooks(): Promise<BookListItem[]> {
  return rebuildIndex()
}

export async function getBook(bookId: string): Promise<Book> {
  await reconcilePendingChapters(bookId)
  return loadBook(bookId)
}

export async function deleteBook(bookId: string): Promise<void> {
  await rm(bookDir(bookId), { recursive: true, force: true })
  await rebuildIndex()
}

export async function readChapter(bookId: string, chapterId: string): Promise<ChapterFile> {
  const book = await loadBook(bookId)
  const meta = book.chapters.find((c) => c.id === chapterId)
  if (!meta) throw new Error(`章节 ${chapterId} 不存在`)
  try {
    const raw = await readFile(chapterPath(bookId, meta.file), 'utf-8')
    const file = JSON.parse(raw) as ChapterFile
    if (shouldPromoteReady(file) && file.status !== 'ready') {
      await writeChapterFile(bookId, chapterId, { ...file, status: 'ready' })
      const latest = await loadBook(bookId)
      if (latest.status !== 'downloading') await refreshBookStatus(bookId)
      return { ...file, status: 'ready' }
    }
    if (file.status === 'ready' && meta.status !== 'ready') {
      await markChapterStatus(bookId, chapterId, 'ready', { url: file.url })
      const latest = await loadBook(bookId)
      if (latest.status !== 'downloading') await refreshBookStatus(bookId)
    }
    return file
  } catch {
    const file: ChapterFile = {
      title: meta.title,
      url: meta.url,
      body: '',
      status: meta.status,
      failCode: meta.failCode,
    }
    return file
  }
}

export async function updateChapterBody(bookId: string, chapterId: string, body: string, restoreRaw?: boolean): Promise<void> {
  const book = await loadBook(bookId)
  const meta = book.chapters.find((c) => c.id === chapterId)
  if (!meta) throw new Error(`章节 ${chapterId} 不存在`)
  const file: ChapterFile = JSON.parse(await readFile(chapterPath(bookId, meta.file), 'utf-8'))
  if (restoreRaw) {
    if (file.bodyRaw) file.body = file.bodyRaw
  } else {
    if (file.bodyRaw === undefined) file.bodyRaw = file.body
    file.body = body
  }
  await writeFile(chapterPath(bookId, meta.file), JSON.stringify(file, null, 2), 'utf-8')
}

export async function setProgress(bookId: string, progress: ReadingProgress): Promise<void> {
  await withBookLock(bookId, async () => {
    const book = await loadBookUnlocked(bookId)
    book.progress = { ...progress, updatedAt: now() }
    await saveBookUnlocked(book)
  })
}

export async function copyOriginFile(bookId: string, sourcePath: string): Promise<void> {
  const destDir = join(bookDir(bookId), 'origin')
  await mkdir(destDir, { recursive: true })
  await cp(sourcePath, join(destDir, basename(sourcePath)))
}

export async function readSummaries(bookId: string): Promise<AiSummaries> {
  try {
    return JSON.parse(await readFile(join(bookDir(bookId), 'ai', 'summaries.json'), 'utf-8'))
  } catch {
    return { byChapter: {}, updatedAt: now() }
  }
}

export async function writeChapterSummary(bookId: string, chapterId: string, text: string): Promise<void> {
  await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
  const data = await readSummaries(bookId)
  data.byChapter[chapterId] = text
  data.updatedAt = now()
  await writeFile(join(bookDir(bookId), 'ai', 'summaries.json'), JSON.stringify(data, null, 2), 'utf-8')
}

// ---------------------------------------------------------------------------
// bootstrap book (from download or import)
// ---------------------------------------------------------------------------

export async function createBookFromBootstrap(opts: {
  bookId: string
  title: string
  author: string
  sourceUrl?: string
  sourceHost?: string
  importType: ImportType
  chapterTitles: string[]
  chapterUrls?: (string | undefined)[]
  coverUrl?: string
}): Promise<Book> {
  const dir = bookDir(opts.bookId)
  await mkdir(join(dir, 'chapters'), { recursive: true })
  await mkdir(join(dir, 'ai'), { recursive: true })

  const chapters: ChapterMeta[] = opts.chapterTitles.map((title, i) => {
    const url = opts.chapterUrls?.[i]
    const meta: ChapterMeta = {
      id: `c${pad4(i + 1)}`,
      index: i + 1,
      title,
      file: `chapters/${pad4(i + 1)}.json`,
      status: 'pending' as ChapterStatus,
    }
    if (url) meta.url = url
    return meta
  })

  const book: Book = {
    id: opts.bookId,
    title: opts.title,
    author: opts.author,
    sourceUrl: opts.sourceUrl,
    sourceHost: opts.sourceHost,
    importType: opts.importType,
    createdAt: now(),
    updatedAt: now(),
    status: 'partial',
    chapters,
    progress: null,
  }
  await saveBook(book)
  return book
}

export async function writeChapterFile(bookId: string, chapterId: string, data: ChapterFile): Promise<void> {
  await withBookLock(bookId, async () => {
    const book = await loadBookUnlocked(bookId)
    const meta = book.chapters.find((c) => c.id === chapterId)
    if (!meta) throw new Error(`章节 ${chapterId} 不存在`)
    const toWrite: ChapterFile = { ...data }
    if (shouldPromoteReady(toWrite)) {
      toWrite.status = 'ready'
      delete toWrite.failCode
    }
    await persistChapterJson(bookId, meta.file, toWrite)
    const nextStatus = toWrite.status
    let dirty = false
    if (nextStatus && meta.status !== nextStatus) {
      applyChapterStatus(meta, nextStatus, { failCode: toWrite.failCode, url: toWrite.url })
      dirty = true
    } else if (toWrite.url && meta.url !== toWrite.url) {
      meta.url = toWrite.url
      dirty = true
    } else if (nextStatus === 'ready' && (meta.failCode || meta.failMessage)) {
      applyChapterStatus(meta, 'ready')
      dirty = true
    }
    if (dirty) await saveBookUnlocked(book)
  })
}

export async function markChapterReady(bookId: string, chapterId: string, status: ChapterStatus): Promise<void> {
  await markChapterStatus(bookId, chapterId, status)
}

export async function markChapterStatus(
  bookId: string,
  chapterId: string,
  status: ChapterStatus,
  extra?: { failCode?: FailCode; failMessage?: string; url?: string },
): Promise<void> {
  await withBookLock(bookId, async () => {
    const book = await loadBookUnlocked(bookId)
    const meta = book.chapters.find((c) => c.id === chapterId)
    if (!meta) throw new Error(`章节 ${chapterId} 不存在`)
    applyChapterStatus(meta, status, extra)
    await saveBookUnlocked(book)
  })
}

export async function refreshBookStatus(bookId: string, status?: Book['status']): Promise<void> {
  await withBookLock(bookId, async () => {
    const book = await loadBookUnlocked(bookId)
    if (status) book.status = status
    else applyOverallStatus(book)
    await saveBookUnlocked(book)
  })
}
