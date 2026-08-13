import { mkdir, readFile, writeFile, readdir, rm, stat, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type {
  Book,
  BookListItem,
  ChapterFile,
  ChapterMeta,
  ChapterStatus,
  ExtractBootstrap,
  ImportType,
  ReadingProgress,
} from '../shared/types'
import { DEFAULT_LIBRARY_PATH } from '../shared/types'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function getLibraryPath(): string {
  return DEFAULT_LIBRARY_PATH
}

export function bookDir(bookId: string): string {
  return join(getLibraryPath(), bookId)
}

function chapterFile(bookId: string, file: string): string {
  return join(bookDir(bookId), file)
}

function indexFile(): string {
  return join(getLibraryPath(), 'index.json')
}

export function bookIdFromUrl(host: string, catalogUrl: string): string {
  const u = new URL(catalogUrl)
  u.hash = ''
  const clean = (host + '\n' + u.toString().replace(/[?&](page|utm_[^=]*)=[^&]*/gi, '').replace(/\/+$/, '')).toLowerCase()
  return 'd_' + createHash('sha256').update(clean).digest('hex').slice(0, 16)
}

export function bookIdFromBytes(bytes: Uint8Array): string {
  return 'i_' + createHash('sha256').update(Buffer.from(bytes)).digest('hex').slice(0, 16)
}

function now(): string {
  return new Date().toISOString()
}

function pad4(n: number): string {
  return String(n).padStart(4, '0')
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

async function readIndex(): Promise<IndexData> {
  try {
    return JSON.parse(await readFile(indexFile(), 'utf-8'))
  } catch {
    return { version: 1, books: [] }
  }
}

async function writeIndex(data: IndexData): Promise<void> {
  await writeFile(indexFile(), JSON.stringify(data, null, 2), 'utf-8')
}

async function rebuildIndex(): Promise<BookListItem[]> {
  const lib = getLibraryPath()
  let entries: string[]
  try {
    entries = (await readdir(lib, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('__')).map((d) => d.name)
  } catch {
    return []
  }
  const items: BookListItem[] = []
  for (const id of entries) {
    try {
      const book = await loadBook(id)
      items.push(bookToList(book))
    } catch { /* skip corrupt */ }
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

export async function loadBook(bookId: string): Promise<Book> {
  const raw = await readFile(join(bookDir(bookId), 'book.json'), 'utf-8')
  return JSON.parse(raw)
}

export async function saveBook(book: Book): Promise<void> {
  book.updatedAt = now()
  await writeFile(join(bookDir(book.id), 'book.json'), JSON.stringify(book, null, 2), 'utf-8')
  // update index silently
  try {
    const idx = await readIndex()
    const i = idx.books.findIndex((b) => b.id === book.id)
    const item = bookToList(book)
    if (i >= 0) idx.books[i] = item
    else idx.books.unshift(item)
    await writeIndex(idx)
  } catch { /* best effort */ }
}

export async function listBooks(): Promise<BookListItem[]> {
  const idx = await readIndex()
  if (idx.books.length > 0) return idx.books
  return rebuildIndex()
}

export async function getBook(bookId: string): Promise<Book> {
  return loadBook(bookId)
}

export async function deleteBook(bookId: string): Promise<void> {
  await rm(bookDir(bookId), { recursive: true, force: true })
  const idx = await readIndex()
  idx.books = idx.books.filter((b) => b.id !== bookId)
  await writeIndex(idx)
}

export async function readChapter(bookId: string, chapterId: string): Promise<ChapterFile> {
  const book = await loadBook(bookId)
  const meta = book.chapters.find((c) => c.id === chapterId)
  if (!meta) throw new Error(`章节 ${chapterId} 不存在`)
  const raw = await readFile(chapterFile(bookId, meta.file), 'utf-8')
  return JSON.parse(raw)
}

export async function updateChapterBody(bookId: string, chapterId: string, body: string, restoreRaw?: boolean): Promise<void> {
  const book = await loadBook(bookId)
  const meta = book.chapters.find((c) => c.id === chapterId)
  if (!meta) throw new Error(`章节 ${chapterId} 不存在`)
  const file: ChapterFile = JSON.parse(await readFile(chapterFile(bookId, meta.file), 'utf-8'))
  if (restoreRaw && file.bodyRaw) {
    file.body = file.bodyRaw
  } else {
    file.body = body
  }
  await writeFile(chapterFile(bookId, meta.file), JSON.stringify(file, null, 2), 'utf-8')
}

export async function setProgress(bookId: string, progress: ReadingProgress): Promise<void> {
  const book = await loadBook(bookId)
  book.progress = { ...progress, updatedAt: now() }
  await saveBook(book)
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
  coverUrl?: string
}): Promise<Book> {
  const dir = bookDir(opts.bookId)
  await mkdir(join(dir, 'chapters'), { recursive: true })
  await mkdir(join(dir, 'ai'), { recursive: true })

  const chapters: ChapterMeta[] = opts.chapterTitles.map((title, i) => ({
    id: `c${pad4(i + 1)}`,
    index: i + 1,
    title,
    file: `chapters/${pad4(i + 1)}.json`,
    status: 'pending' as ChapterStatus,
  }))

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
  const book = await loadBook(bookId)
  const meta = book.chapters.find((c) => c.id === chapterId)
  if (!meta) throw new Error(`章节 ${chapterId} 不存在`)
  await writeFile(chapterFile(bookId, meta.file), JSON.stringify(data, null, 2), 'utf-8')
}

export async function markChapterReady(bookId: string, chapterId: string, status: ChapterStatus): Promise<void> {
  const book = await loadBook(bookId)
  const meta = book.chapters.find((c) => c.id === chapterId)
  if (meta) meta.status = status
  // update overall status
  const allReady = book.chapters.every((c) => c.status === 'ready' || c.status === 'empty')
  const anyReady = book.chapters.some((c) => c.status === 'ready')
  book.status = allReady ? 'ready' : anyReady ? 'partial' : book.status
  await saveBook(book)
}
