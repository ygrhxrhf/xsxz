import { mkdir, readFile, readdir, rm, rename, stat, cp } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteText, type AtomicWriteOptions } from './atomicFile'
import { withLibraryWrite } from './libraryMaintenance'
export { atomicWriteText } from './atomicFile'
import type {
  AiBookUsage,
  AiChatFile,
  AiChatFileV2,
  AiEvidenceChatMessage,
  AiMemoryBase,
  AiMemoryCharacter,
  AiMemoryFile,
  AiSummaries,
  AiUsage,
  Book,
  BookListItem,
  CatalogChapter,
  ChapterFile,
  ChapterMeta,
  ChapterStatus,
  FailCode,
  ImportType,
  ReadingProgress,
  TrashItem,
  CharacterCard,
  UnlockMethod,
} from '../shared/types'
import { defaultLibraryPath } from './libraryPath'
import { canonicalizeUrl } from '../shared/urlHash'
import { correctCharacterAliases, correctMemorySummary, type MemoryItemKind } from './aiMaterial'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let currentLibraryPath = defaultLibraryPath()

export function getLibraryPath(): string {
  return currentLibraryPath
}

export async function setLibraryPath(next: string): Promise<void> {
  await withLibraryWrite(async () => {
    const trimmed = (next || '').trim() || defaultLibraryPath()
    const previous = currentLibraryPath
    currentLibraryPath = trimmed
    try {
      await ensureLibrary()
    } catch (error) {
      currentLibraryPath = previous
      throw error
    }
  })
}

/** 书 id 只允许 [A-Za-z0-9_]：真实 id 形如 d_<hex>/i_<hex>，回收站条目名同形。
 *  收紧在路径拼装的唯一出口，既挡住 IPC 传来的 `../` 穿越，也挡住内部误传。 */
const BOOK_ID_RE = /^[A-Za-z0-9_]+$/

export function assertBookId(bookId: string): string {
  if (typeof bookId !== 'string' || !BOOK_ID_RE.test(bookId)) {
    throw new Error(`非法的书籍编号：${String(bookId)}`)
  }
  return bookId
}

export function bookDir(bookId: string): string {
  return join(getLibraryPath(), assertBookId(bookId))
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

/** www.example.com 与 example.com 是同一本书。 */
export function normalizeBookHost(host: string): string {
  return (host ?? '').trim().toLowerCase().replace(/^www\./, '')
}

function withWwwHost(host: string): string {
  return host.startsWith('www.') ? host : `www.${host}`
}

/** 只改主机大小写和 www，路径原样保留。 */
function setBookUrlHost(url: string, host: string): string | null {
  try {
    const u = new URL(url)
    u.hostname = host
    return u.toString()
  } catch {
    return null
  }
}

/** 目录地址里的主机同样参与身份，所以也要跟着归一。 */
export function normalizeBookUrl(url: string): string {
  return setBookUrlHost(url, normalizeBookHost(urlHost(url))) ?? url
}

function hostVariants(host: string): string[] {
  const bare = normalizeBookHost(host)
  return [...new Set([bare, withWwwHost(bare)])]
}

function urlVariants(url: string): string[] {
  const bare = setBookUrlHost(url, normalizeBookHost(urlHost(url))) ?? url
  const withWww = setBookUrlHost(bare, withWwwHost(urlHost(bare)))
  return [...new Set(withWww ? [bare, withWww] : [bare])]
}

function urlHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * 同一本书的候选 id：去 www 的规范键在前，其余写法在后。
 * www 要双向补：当年按 www 建的书，这次从裸主机进来也得找得到。
 */
export function bookIdCandidates(host: string, catalogUrl: string): string[] {
  const out: string[] = []
  for (const h of hostVariants(host)) {
    for (const u of urlVariants(catalogUrl)) {
      const id = bookIdFromUrl(h, u)
      if (!out.includes(id)) out.push(id)
    }
  }
  return out
}

/** 新书一律用规范键；候选顺序保证它与 bookIdCandidates[0] 一致。 */
export function canonicalBookId(host: string, catalogUrl: string): string {
  return bookIdCandidates(host, catalogUrl)[0]
}

export async function findExistingBookId(host: string, catalogUrl: string): Promise<string | null> {
  for (const candidate of bookIdCandidates(host, catalogUrl)) {
    if (await bookExists(candidate)) return candidate
  }
  return null
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

/** Per-book serial lock; shared with the annotations store in the same dir. */
type BodyChangeHook = (bookId: string, chapterId: string, oldBody: string, newBody: string) => Promise<void>
let bodyChangeHook: BodyChangeHook | null = null

/**
 * 正文被改写（清正文 / 重下 / 手工修复）后要迁移已读位置。
 * 钩子由 readFrontier 注册：library 不能反过来 import readFrontier，会成环。
 */
export function registerBodyChangeHook(hook: BodyChangeHook): void {
  bodyChangeHook = hook
}

export async function withBookLock<T>(bookId: string, fn: () => Promise<T>): Promise<T> {
  return withLibraryWrite(async () => {
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
  })
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
  extra?: { failCode?: FailCode; failMessage?: string; url?: string; unlockedBy?: UnlockMethod },
): void {
  meta.status = status
  if (extra?.url) meta.url = extra.url
  if (status === 'ready' || status === 'pending') {
    delete meta.failCode
    delete meta.failMessage
  } else if (extra?.failCode) {
    meta.failCode = extra.failCode
    meta.failMessage = extra.failMessage
  }
  if (status === 'ready') {
    if (extra?.unlockedBy) meta.unlockedBy = extra.unlockedBy
    else delete meta.unlockedBy
  }
}

/** 非法（非字符串数组）整段当 []。合法项 trim、丢空串，同书大小写不敏感去重并保留先出现写法。 */
function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return []
  const seen = new Set<string>()
  const tags: string[] = []
  for (const item of value) {
    const tag = item.trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return tags
}

async function loadBookUnlocked(bookId: string): Promise<Book> {
  const raw = await readFile(join(bookDir(bookId), 'book.json'), 'utf-8')
  const book = JSON.parse(raw) as Book
  book.tags = normalizeTags(book.tags)
  return book
}

async function saveBookUnlocked(book: Book): Promise<void> {
  book.updatedAt = now()
  await mkdir(bookDir(book.id), { recursive: true })
  await atomicWriteText(join(bookDir(book.id), 'book.json'), JSON.stringify(book, null, 2))
}

async function persistChapterJson(bookId: string, relFile: string, data: ChapterFile): Promise<void> {
  await mkdir(join(bookDir(bookId), 'chapters'), { recursive: true })
  await atomicWriteText(chapterPath(bookId, relFile), JSON.stringify(data, null, 2))
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
export function mergeIncomingChapters(
  book: Book,
  incoming: CatalogChapter[],
  opts?: { requeueChangedUrls?: boolean },
): { added: number; changed: number } {
  const byUrl = new Map<string, ChapterMeta>()
  const byTitle = new Map<string, ChapterMeta>()
  for (const ch of book.chapters) {
    if (ch.url) byUrl.set(normalizeChapterUrl(ch.url), ch)
    const titleKey = ch.title.trim()
    if (titleKey && !byTitle.has(titleKey)) byTitle.set(titleKey, ch)
  }

  let nextIndex = book.chapters.length ? Math.max(...book.chapters.map((c) => c.index)) : 0
  let added = 0
  let changed = 0

  for (const inc of incoming) {
    const nurl = inc.url ? normalizeChapterUrl(inc.url) : ''
    const titleKey = inc.title.trim()
    const existing = (nurl && byUrl.get(nurl)) || (titleKey ? byTitle.get(titleKey) : undefined)
    if (existing) {
      const oldUrl = existing.url ? normalizeChapterUrl(existing.url) : ''
      const urlChanged = Boolean(inc.url) && Boolean(existing.url) && nurl !== oldUrl
      if (inc.url && !existing.url) existing.url = inc.url
      // 同名但章节地址变了（站点重排过目录）：老地址多半已失效。
      // 只有「检查更新」会把这一章退回 pending 重下，普通「重试失败章」不动已读的内容。
      if (urlChanged && opts?.requeueChangedUrls) {
        existing.url = inc.url
        if (existing.status === 'ready') {
          existing.status = 'pending'
          existing.failCode = undefined
          changed++
        }
      }
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
  return { added, changed }
}

// ---------------------------------------------------------------------------
// ensure dirs
// ---------------------------------------------------------------------------

export async function ensureLibrary(): Promise<void> {
  await mkdir(getLibraryPath(), { recursive: true })
  await mkdir(join(getLibraryPath(), '__tmp__'), { recursive: true }).catch(() => {})
}

// ---------------------------------------------------------------------------
// trash（回收站）
// ---------------------------------------------------------------------------

function trashDir(): string {
  return join(getLibraryPath(), '__trash__')
}

/** 回收站条目名固定为 `<bookId>-<删除时间毫秒>`；不合法返回 null。 */
function safeTrashName(name: string): string | null {
  return /^[A-Za-z0-9_]+-\d+$/.test(name) ? name : null
}

function splitTrashName(name: string): { bookId: string; trashedAt: string } | null {
  const idx = name.lastIndexOf('-')
  if (idx <= 0) return null
  const ms = Number(name.slice(idx + 1))
  const bookId = name.slice(0, idx)
  if (!Number.isFinite(ms)) return null
  return { bookId, trashedAt: new Date(ms).toISOString() }
}

// ---------------------------------------------------------------------------
// index (cache)
// ---------------------------------------------------------------------------

interface IndexData {
  version: number
  /** 上次写入时间：缓存是什么时候的，一眼能看出来。 */
  writtenAt?: string
  /** bookId → book.json 的 mtime(ms)。对得上就说明这本书没被改过，缓存可直接用。 */
  mtimes?: Record<string, number>
  books: BookListItem[]
}

async function readIndex(): Promise<IndexData | null> {
  try {
    const parsed = JSON.parse(await readFile(indexFile(), 'utf-8')) as IndexData
    return Array.isArray(parsed.books) ? parsed : null
  } catch {
    return null
  }
}

async function bookJsonMtime(bookId: string): Promise<number | null> {
  try {
    return (await stat(join(bookDir(bookId), 'book.json'))).mtimeMs
  } catch {
    return null
  }
}

async function writeIndex(data: IndexData): Promise<void> {
  await atomicWriteText(indexFile(), JSON.stringify(data, null, 2))
}

async function upsertIndexItem(book: Book): Promise<void> {
  const cached = await readIndex()
  const books = (cached?.books ?? []).filter((item) => item?.id !== book.id)
  books.push(bookToList(book))
  books.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const mtimes = { ...(cached?.mtimes ?? {}) }
  const mtime = await bookJsonMtime(book.id)
  if (mtime !== null) mtimes[book.id] = mtime
  await writeIndex({ version: 1, books, writtenAt: new Date().toISOString(), mtimes })
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

  // 缓存命中判据：书目录集合一致，且每本 book.json 的 mtime 都没变过。
  // 走缓存时只做一次 stat；不走缓存要逐本 loadBook + 逐章对账（1600 章要读 1600 个文件）。
  const mtimes: Record<string, number> = {}
  for (const id of entries) {
    const mtime = await bookJsonMtime(id)
    if (mtime !== null) mtimes[id] = mtime
  }
  const ids = Object.keys(mtimes)
  const cached = await readIndex()
  if (
    cached?.mtimes &&
    cached.books.length === ids.length &&
    Object.keys(cached.mtimes).length === ids.length &&
    ids.every((id) => cached.mtimes![id] === mtimes[id])
  ) {
    return cached.books
  }

  const items: BookListItem[] = []
  for (const id of ids) {
    try {
      await reconcilePendingChapters(id)
      const book = await loadBook(id)
      items.push(bookToList(book))
    } catch {
      /* skip corrupt */
    }
  }
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  // 对账过程可能改写了 book.json，落盘前重新取一遍 mtime
  const fresh: Record<string, number> = {}
  for (const id of ids) {
    const mtime = await bookJsonMtime(id)
    if (mtime !== null) fresh[id] = mtime
  }
  await writeIndex({ version: 1, books: items, writtenAt: new Date().toISOString(), mtimes: fresh })
  return items
}

function bookToList(b: Book): BookListItem {
  const readyCount = b.chapters.filter((c) => c.status === 'ready').length
  const unlockedCount = b.chapters.filter((c) => c.status === 'ready' && c.unlockedBy).length
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    tags: normalizeTags(b.tags),
    coverPath: b.coverPath,
    importType: b.importType,
    status: b.status,
    chapterCount: b.chapters.length,
    readyCount,
    unlockedCount,
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

/**
 * 书是否已完整入库：book.json 存在且每章都落到 ready/empty。
 * 导入中途被杀会留下「目录已建、章节残缺」的半本书；只看 bookExists 会让再次导入永远短路，
 * 半本书再也不会被修复。调用方用这个判据决定要不要重跑导入。
 */
export async function isBookComplete(bookId: string): Promise<boolean> {
  try {
    const book = await loadBookUnlocked(bookId)
    return book.chapters.length > 0 && book.chapters.every((chapter) => chapter.status === 'ready' || chapter.status === 'empty')
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
  await withLibraryWrite(async () => {
    const src = bookDir(bookId)
    try {
      await stat(join(src, 'book.json'))
    } catch {
      await rebuildIndex()
      return
    }
    await mkdir(trashDir(), { recursive: true })
    const dest = join(trashDir(), `${bookId}-${Date.now()}`)
    await rename(src, dest)
    await rebuildIndex()
  })
}

export async function listTrash(): Promise<TrashItem[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(trashDir(), { withFileTypes: true })
  } catch {
    return []
  }
  const items: TrashItem[] = []
  for (const ent of entries) {
    if (!ent.isDirectory() || !safeTrashName(ent.name)) continue
    const parts = splitTrashName(ent.name)
    if (!parts) continue
    try {
      const raw = await readFile(join(trashDir(), ent.name, 'book.json'), 'utf-8')
      const book = JSON.parse(raw) as Book
      items.push({
        name: ent.name,
        bookId: parts.bookId,
        title: book.title || '(未命名)',
        author: book.author || '',
        chapterCount: Array.isArray(book.chapters) ? book.chapters.length : 0,
        trashedAt: parts.trashedAt,
        sizeBytes: await dirSizeBytes(join(trashDir(), ent.name)),
      })
    } catch {
      /* skip corrupt trash entry */
    }
  }
  items.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt))
  return items
}

/** 目录占用的字节数：回收站条目要显示「删掉的这些占了多少盘」。 */
async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0
  const walk = async (current: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = join(current, ent.name)
      if (ent.isDirectory()) {
        await walk(full)
        continue
      }
      try {
        total += (await stat(full)).size
      } catch {
        /* 读不到大小就跳过这一项 */
      }
    }
  }
  await walk(dir)
  return total
}

/** 回收站条目保留天数：超过就由启动时的清理删掉。 */
export const TRASH_MAX_AGE_DAYS = 30

/** 清掉回收站里过期的条目：回收站不是长期仓库，占的是同一块盘。 */
export async function purgeExpiredTrash(maxAgeDays = TRASH_MAX_AGE_DAYS): Promise<number> {
  return withLibraryWrite(async () => {
    const deadline = Date.now() - maxAgeDays * 86_400_000
    let entries: Dirent[]
    try {
      entries = await readdir(trashDir(), { withFileTypes: true })
    } catch {
      return 0
    }
    let count = 0
    for (const ent of entries) {
      if (!ent.isDirectory() || !safeTrashName(ent.name)) continue
      const parts = splitTrashName(ent.name)
      if (!parts) continue
      if (new Date(parts.trashedAt).getTime() > deadline) continue
      await rm(join(trashDir(), ent.name), { recursive: true, force: true }).catch(() => {})
      count++
    }
    return count
  })
}

export async function restoreFromTrash(name: string): Promise<void> {
  await withLibraryWrite(async () => {
    const safe = safeTrashName(name)
    if (!safe) throw new Error('回收站条目名不合法')
    const parts = splitTrashName(safe)
    if (!parts) throw new Error('回收站条目名不合法')
    if (await bookExists(parts.bookId)) {
      throw new Error('书库中已存在这本书，无法还原')
    }
    await rename(join(trashDir(), safe), bookDir(parts.bookId))
    await rebuildIndex()
  })
}

export async function purgeTrash(name?: string): Promise<number> {
  return withLibraryWrite(async () => {
    if (name) {
      const safe = safeTrashName(name)
      if (!safe) throw new Error('回收站条目名不合法')
      await rm(join(trashDir(), safe), { recursive: true, force: true })
      return 1
    }
    let count = 0
    try {
      const entries = await readdir(trashDir(), { withFileTypes: true })
      for (const ent of entries) {
        if (ent.isDirectory() && safeTrashName(ent.name)) count++
      }
    } catch {
      return 0
    }
    await rm(trashDir(), { recursive: true, force: true })
    return count
  })
}

/**
 * 旧书可能存着 CRLF（早期导入端没做换行规范化）：读出来先统一，
 * 否则阅读器按空行分段时整章会挤成一段。只改内存里的副本，不改磁盘格式。
 */
export function normalizeChapterNewlines(file: ChapterFile): ChapterFile {
  if (file.body?.includes('\r')) file.body = file.body.replace(/\r\n?/g, '\n')
  if (file.bodyRaw?.includes('\r')) file.bodyRaw = file.bodyRaw.replace(/\r\n?/g, '\n')
  return file
}

export async function readChapter(bookId: string, chapterId: string): Promise<ChapterFile> {
  const book = await loadBook(bookId)
  const meta = book.chapters.find((c) => c.id === chapterId)
  if (!meta) throw new Error(`章节 ${chapterId} 不存在`)
  try {
    const raw = await readFile(chapterPath(bookId, meta.file), 'utf-8')
    const file = normalizeChapterNewlines(JSON.parse(raw) as ChapterFile)
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
  // 在锁内只记下新旧正文，迁移已读位置放到锁外做（withBookLock 不可重入）
  const changed = await withBookLock(bookId, async () => {
    const book = await loadBook(bookId)
    const meta = book.chapters.find((c) => c.id === chapterId)
    if (!meta) throw new Error(`章节 ${chapterId} 不存在`)
    const file: ChapterFile = JSON.parse(await readFile(chapterPath(bookId, meta.file), 'utf-8'))
    const before = file.body
    if (restoreRaw) {
      if (file.bodyRaw) file.body = file.bodyRaw
    } else {
      if (file.bodyRaw === undefined) file.bodyRaw = file.body
      file.body = body
    }
    await atomicWriteText(chapterPath(bookId, meta.file), JSON.stringify(file, null, 2))
    return before === file.body ? null : { oldBody: before, newBody: file.body }
  })
  if (changed) await bodyChangeHook?.(bookId, chapterId, changed.oldBody, changed.newBody).catch(() => {})
}

/** 人工修复正文：保留首次编辑前的文本，失败章可直接恢复为可读状态。 */
export async function repairChapterBody(bookId: string, chapterId: string, body: string): Promise<void> {
  const text = body.replace(/\r\n?/g, '\n').trim()
  if (!text) throw new Error('正文不能为空')
  const old = await readChapter(bookId, chapterId)
  await writeChapterFile(bookId, chapterId, {
    ...old,
    body: text,
    bodyRaw: old.bodyRaw ?? old.body,
    status: 'ready',
    failCode: undefined,
  })
  await refreshBookStatus(bookId)
}

export async function setProgress(bookId: string, progress: ReadingProgress): Promise<void> {
  await withBookLock(bookId, async () => {
    const book = await loadBookUnlocked(bookId)
    book.progress = { ...progress, updatedAt: now() }
    await saveBookUnlocked(book)
  })
}

export async function copyOriginFile(bookId: string, sourcePath: string): Promise<void> {
  await withLibraryWrite(async () => {
    const destDir = join(bookDir(bookId), 'origin')
    await mkdir(destDir, { recursive: true })
    await cp(sourcePath, join(destDir, basename(sourcePath)))
  })
}

function emptySummaries(): AiSummaries {
  return { version: 2, byChapter: {}, updatedAt: now() }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringEntries(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.some(([, text]) => typeof text !== 'string')) return null
  return Object.fromEntries(entries) as Record<string, string>
}

/**
 * Convert the legacy `byChapter = whole story so far` shape into v2 without
 * ever exposing legacy text as a per-chapter summary to a model caller.
 */
export async function migrateSummariesV1(bookId: string, legacy: Record<string, string>): Promise<AiSummaries> {
  const migrated = emptySummaries()
  let book: Book | null = null
  try {
    book = await loadBook(bookId)
  } catch {
    return migrated
  }

  const progressId = book.progress?.chapterId
  let sourceId = progressId && legacy[progressId] ? progressId : undefined
  if (!sourceId) {
    sourceId = [...book.chapters]
      .sort((a, b) => b.index - a.index)
      .find((chapter) => Boolean(legacy[chapter.id]))?.id
  }
  if (sourceId) {
    migrated.storySoFar = {
      uptoChapterId: sourceId,
      text: legacy[sourceId]!,
      updatedAt: migrated.updatedAt,
    }
  }
  return migrated
}

export async function readSummaries(bookId: string): Promise<AiSummaries> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(bookDir(bookId), 'ai', 'summaries.json'), 'utf-8'))
  } catch {
    return emptySummaries()
  }
  if (!isRecord(parsed)) return emptySummaries()

  const byChapter = stringEntries(parsed.byChapter)
  if (!byChapter) return emptySummaries()
  if (parsed.version === 2) {
    const story = isRecord(parsed.storySoFar)
      && typeof parsed.storySoFar.uptoChapterId === 'string'
      && typeof parsed.storySoFar.text === 'string'
      && typeof parsed.storySoFar.updatedAt === 'string'
      ? {
          uptoChapterId: parsed.storySoFar.uptoChapterId,
          text: parsed.storySoFar.text,
          updatedAt: parsed.storySoFar.updatedAt,
        }
      : undefined
    return {
      version: 2,
      byChapter,
      ...(story ? { storySoFar: story } : {}),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now(),
    }
  }
  return migrateSummariesV1(bookId, byChapter)
}

export async function writeChapterSummary(
  bookId: string,
  chapterId: string,
  text: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  // summaries.json 是整文件读改写：前情提要（storySoFar）与自动追剧（本章摘要）会写同一份文件，
  // 无锁并发会互相覆盖。加 per-book 锁与其它书库写串行。
  await withBookLock(bookId, async () => {
    await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
    const data = await readSummaries(bookId)
    data.byChapter[chapterId] = text
    data.updatedAt = now()
    await atomicWriteText(join(bookDir(bookId), 'ai', 'summaries.json'), JSON.stringify(data, null, 2), options)
  })
}

export async function writeStorySoFar(
  bookId: string,
  uptoChapterId: string,
  text: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await withBookLock(bookId, async () => {
    await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
    const data = await readSummaries(bookId)
    const updatedAt = now()
    data.storySoFar = { uptoChapterId, text, updatedAt }
    data.updatedAt = updatedAt
    await atomicWriteText(join(bookDir(bookId), 'ai', 'summaries.json'), JSON.stringify(data, null, 2), options)
  })
}

function trimChatPairs(messages: readonly AiEvidenceChatMessage[], limit = 40): AiEvidenceChatMessage[] {
  const units: AiEvidenceChatMessage[][] = []
  for (const message of messages) {
    if (message.role === 'user') {
      units.push([message])
    } else {
      const latest = units.at(-1)
      if (latest?.length === 1 && latest[0]?.role === 'user') latest.push(message)
    }
  }
  const kept: AiEvidenceChatMessage[][] = []
  let count = 0
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]!
    if (count + unit.length > limit) break
    kept.unshift(unit)
    count += unit.length
  }
  return kept.flat()
}

function isChatCitation(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.chapterId === 'string' && value.chapterId.length > 0 &&
    typeof value.chapterTitle === 'string' && Number.isSafeInteger(value.paragraphIndex) &&
    Number(value.paragraphIndex) >= 0 && typeof value.excerpt === 'string' && value.excerpt.length > 0
}

function parseChatMessage(value: unknown, v2: boolean): AiEvidenceChatMessage | null {
  if (!isRecord(value) || (value.role !== 'user' && value.role !== 'assistant') || typeof value.content !== 'string') return null
  const message: AiEvidenceChatMessage = { role: value.role, content: value.content }
  if (!v2 || value.role !== 'assistant') return message
  if ('citations' in value) {
    if (!Array.isArray(value.citations) || !value.citations.every(isChatCitation)) return null
    message.citations = value.citations
  }
  if ('uptoChapterId' in value) {
    if (typeof value.uptoChapterId !== 'string') return null
    message.uptoChapterId = value.uptoChapterId
  }
  if ('stopped' in value) {
    if (typeof value.stopped !== 'boolean') return null
    if (value.stopped) message.stopped = true
  }
  return message
}

export async function readChat(bookId: string): Promise<AiChatFile | AiChatFileV2> {
  try {
    const data: unknown = JSON.parse(await readFile(join(bookDir(bookId), 'ai', 'chat.json'), 'utf-8'))
    if (!isRecord(data) || (data.version !== 1 && data.version !== 2) || !Array.isArray(data.messages)) throw new Error('invalid chat')
    const v2 = data.version === 2
    const parsed = data.messages.map((message) => parseChatMessage(message, v2))
    if (parsed.some((message) => message === null)) throw new Error('invalid chat message')
    const messages = trimChatPairs(parsed as AiEvidenceChatMessage[])
    return v2
      ? { version: 2, messages, updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : now() }
      : { version: 1, messages: messages.map(({ role, content }) => ({ role, content })), updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : now() }
  } catch {
    return { version: 1, messages: [], updatedAt: now() }
  }
}

export async function writeChat(
  bookId: string,
  messages: readonly AiEvidenceChatMessage[],
  options: AtomicWriteOptions & { version?: 1 | 2 } = {},
): Promise<void> {
  await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
  const trimmed = trimChatPairs(messages)
  const version = options.version ?? 2
  const data: AiChatFile | AiChatFileV2 = version === 1
    ? { version: 1, messages: trimmed.map(({ role, content }) => ({ role, content })), updatedAt: now() }
    : { version: 2, messages: trimmed, updatedAt: now() }
  await atomicWriteText(join(bookDir(bookId), 'ai', 'chat.json'), JSON.stringify(data, null, 2), options)
}

export type AiMemoryCollection = 'characters' | 'relations' | 'foreshadows' | 'events'
export type AiMemoryIdKind = 'character' | 'relation' | 'foreshadow' | 'event'

function isAiCitation(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.chapterId === 'string' &&
    typeof value.chapterTitle === 'string' &&
    Number.isSafeInteger(value.paragraphIndex) && Number(value.paragraphIndex) >= 0 &&
    typeof value.excerpt === 'string' &&
    Array.from(value.excerpt).length >= 80 && Array.from(value.excerpt).length <= 160
}

function isAiMemoryBase(value: unknown): value is AiMemoryBase & Record<string, unknown> {
  return isRecord(value) &&
    typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.summary === 'string' &&
    Array.isArray(value.sources) && value.sources.length > 0 && value.sources.every(isAiCitation) &&
    (value.accuracy === 'normal' || value.accuracy === 'review' || value.accuracy === 'uncertain') &&
    (value.userEditedSummary === undefined || typeof value.userEditedSummary === 'boolean') &&
    typeof value.updatedAt === 'string'
}

export function isAiMemoryFile(value: unknown): value is AiMemoryFile {
  if (!isRecord(value) || value.version !== 1 || typeof value.updatedAt !== 'string') return false
  if (value.uptoChapterId !== undefined && typeof value.uptoChapterId !== 'string') return false
  if (!Array.isArray(value.characters) || !value.characters.every((item) =>
    isAiMemoryBase(item) && typeof item.name === 'string' && Array.isArray(item.aliases) &&
    (item.userEditedAliases === undefined || typeof item.userEditedAliases === 'boolean') &&
    item.aliases.every((alias) => typeof alias === 'string') && typeof item.role === 'string' &&
    typeof item.status === 'string')) return false
  if (!Array.isArray(value.relations) || !value.relations.every((item) =>
    isAiMemoryBase(item) && typeof item.from === 'string' && typeof item.to === 'string' &&
    typeof item.relation === 'string' && typeof item.status === 'string')) return false
  if (!Array.isArray(value.foreshadows) || !value.foreshadows.every((item) =>
    isAiMemoryBase(item) && typeof item.desc === 'string' &&
    (item.status === 'open' || item.status === 'resolved' || item.status === 'uncertain'))) return false
  if (!Array.isArray(value.events) || !value.events.every((item) =>
    isAiMemoryBase(item) && typeof item.title === 'string' && Array.isArray(item.participants) &&
    item.participants.every((participant) => typeof participant === 'string') &&
    typeof item.result === 'string')) return false
  const ids = [...value.characters, ...value.relations, ...value.foreshadows, ...value.events]
    .map((item) => item.id)
  return new Set(ids).size === ids.length
}

export function stableAiMemoryId(
  kind: AiMemoryIdKind,
  primaryKey: string,
  firstSourceId: string,
): string {
  const normalizedKey = primaryKey.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ')
  const normalizedSource = firstSourceId.normalize('NFKC').trim()
  const digest = createHash('sha256')
    .update(`${kind}\0${normalizedKey}\0${normalizedSource}`)
    .digest('hex')
    .slice(0, 16)
  return `${kind}-${digest}`
}

export async function readAiMemory(bookId: string): Promise<AiMemoryFile | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(bookDir(bookId), 'ai', 'memory.json'), 'utf-8'))
    return isAiMemoryFile(value) ? value : null
  } catch {
    return null
  }
}

export async function readAiMemoryCompat(bookId: string): Promise<AiMemoryFile | CharacterCard | null> {
  const memory = await readAiMemory(bookId)
  return memory ?? readCharacterCard(bookId)
}

export async function writeAiMemory(
  bookId: string,
  memory: AiMemoryFile,
  options: AtomicWriteOptions = {},
): Promise<void> {
  if (!isAiMemoryFile(memory)) throw new Error('小说记忆数据格式无效')
  const content = JSON.stringify(memory, null, 2)
  await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
  await atomicWriteText(
    join(bookDir(bookId), 'ai', 'memory.json'),
    content,
    options,
  )
}

function emptyBookUsage(updatedAt = now()): AiBookUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, updatedAt }
}

function finiteToken(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function isAiBookUsage(value: unknown): value is AiBookUsage {
  return isRecord(value) &&
    finiteToken(value.calls) === value.calls &&
    finiteToken(value.inputTokens) === value.inputTokens &&
    finiteToken(value.outputTokens) === value.outputTokens &&
    finiteToken(value.cacheHitTokens) === value.cacheHitTokens &&
    finiteToken(value.cacheMissTokens) === value.cacheMissTokens &&
    typeof value.updatedAt === 'string'
}

export async function readAiUsage(bookId: string): Promise<AiBookUsage> {
  try {
    const value: unknown = JSON.parse(await readFile(join(bookDir(bookId), 'ai', 'usage.json'), 'utf-8'))
    return isAiBookUsage(value) ? value : emptyBookUsage()
  } catch {
    return emptyBookUsage()
  }
}

export async function recordAiUsage(
  bookId: string,
  usage: AiUsage | undefined,
  options: AtomicWriteOptions = {},
): Promise<AiBookUsage> {
  return withBookLock(bookId, async () => {
    await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
    const current = await readAiUsage(bookId)
    const updatedAt = now()
    const next: AiBookUsage = {
      calls: current.calls + 1,
      inputTokens: current.inputTokens + finiteToken(usage?.inputTokens),
      outputTokens: current.outputTokens + finiteToken(usage?.outputTokens),
      cacheHitTokens: current.cacheHitTokens + finiteToken(usage?.cacheHitTokens),
      cacheMissTokens: current.cacheMissTokens + finiteToken(usage?.cacheMissTokens),
      updatedAt,
    }
    await atomicWriteText(join(bookDir(bookId), 'ai', 'usage.json'), JSON.stringify(next, null, 2), options)
    return next
  })
}

export async function correctAiCharacterAliases(
  bookId: string,
  itemId: string,
  aliases: readonly string[],
  options: AtomicWriteOptions = {},
): Promise<{ character: AiMemoryCharacter; affectedChapterIds: string[] }> {
  return withBookLock(bookId, async () => {
    const memory = await readAiMemory(bookId)
    if (!memory) throw new Error('尚未生成小说记忆')
    const corrected = correctCharacterAliases(memory, itemId, aliases, now())
    await writeAiMemory(bookId, corrected.memory, options)
    return { character: corrected.character, affectedChapterIds: corrected.affectedChapterIds }
  })
}

export async function correctAiMemorySummary(
  bookId: string,
  kind: MemoryItemKind,
  itemId: string,
  summary: string,
  options: AtomicWriteOptions = {},
): Promise<{ item: AiMemoryBase; affectedChapterIds: string[] }> {
  return withBookLock(bookId, async () => {
    const memory = await readAiMemory(bookId)
    if (!memory) throw new Error('尚未生成小说记忆')
    const corrected = correctMemorySummary(memory, kind, itemId, summary, now())
    await writeAiMemory(bookId, corrected.memory, options)
    return { item: corrected.item, affectedChapterIds: corrected.affectedChapterIds }
  })
}

export async function markAiMemoryAccuracy(
  bookId: string,
  collection: AiMemoryCollection,
  itemId: string,
  accuracy: Exclude<AiMemoryBase['accuracy'], 'normal'>,
  options: AtomicWriteOptions = {},
): Promise<AiMemoryBase> {
  if (accuracy !== 'review' && accuracy !== 'uncertain') throw new Error('记忆准确性状态无效')
  return withBookLock(bookId, async () => {
    const memory = await readAiMemory(bookId)
    if (!memory) throw new Error('尚未生成小说记忆')
    const item = memory[collection].find((candidate) => candidate.id === itemId)
    if (!item) throw new Error('记忆条目不存在')
    const updatedAt = now()
    item.accuracy = accuracy
    item.updatedAt = updatedAt
    memory.updatedAt = updatedAt
    await writeAiMemory(bookId, memory, options)
    return item
  })
}

export async function readCharacterCard(bookId: string): Promise<CharacterCard | null> {
  try {
    return JSON.parse(await readFile(join(bookDir(bookId), 'ai', 'characters.json'), 'utf-8')) as CharacterCard
  } catch {
    return null
  }
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
    tags: [],
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

const COVER_MAX_BYTES = 8 * 1024 * 1024
const COVER_STALE_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp'] as const

function coverDestName(sourcePath: string): 'cover.jpg' | 'cover.png' | 'cover.webp' | null {
  const ext = extname(sourcePath || '').toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'cover.jpg'
  if (ext === '.png') return 'cover.png'
  if (ext === '.webp') return 'cover.webp'
  return null
}

export async function updateMeta(payload: {
  bookId: string
  title: string
  author: string
  tags: string[]
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const title = typeof payload.title === 'string' ? payload.title.trim() : ''
  if (!title) return { ok: false, message: '书名不能为空' }
  const author = typeof payload.author === 'string' ? payload.author.trim() : ''
  const tags = normalizeTags(payload.tags)
  const bookId = payload.bookId
  if (!(await bookExists(bookId))) return { ok: false, message: '书不存在' }
  return withBookLock(bookId, async () => {
    let book: Book
    try {
      book = await loadBookUnlocked(bookId)
    } catch {
      return { ok: false, message: '书不存在' }
    }
    book.title = title
    book.author = author
    book.tags = tags
    await saveBookUnlocked(book)
    await upsertIndexItem(book)
    return { ok: true }
  })
}

export async function setCover(payload: {
  bookId: string
  sourcePath: string
}): Promise<{ ok: true; coverPath: string } | { ok: false; message: string }> {
  const sourcePath = typeof payload.sourcePath === 'string' ? payload.sourcePath.trim() : ''
  if (!sourcePath) return { ok: false, message: '封面文件不存在' }
  const destName = coverDestName(sourcePath)
  if (!destName) return { ok: false, message: '仅支持 jpg、png、webp' }
  let sourceStat: Awaited<ReturnType<typeof stat>>
  try {
    sourceStat = await stat(sourcePath)
  } catch {
    return { ok: false, message: '封面文件不存在' }
  }
  if (!sourceStat.isFile()) return { ok: false, message: '封面文件不存在' }
  if (sourceStat.size > COVER_MAX_BYTES) return { ok: false, message: '封面不能超过 8MB' }
  const bookId = payload.bookId
  if (!(await bookExists(bookId))) return { ok: false, message: '书不存在' }
  return withBookLock(bookId, async () => {
    let book: Book
    try {
      book = await loadBookUnlocked(bookId)
    } catch {
      return { ok: false, message: '书不存在' }
    }
    const destPath = join(bookDir(bookId), destName)
    await cp(sourcePath, destPath)
    for (const name of COVER_STALE_NAMES) {
      if (name === destName) continue
      await rm(join(bookDir(bookId), name), { force: true }).catch(() => {})
    }
    book.coverPath = destName
    await saveBookUnlocked(book)
    await upsertIndexItem(book)
    return { ok: true, coverPath: destName }
  })
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
      applyChapterStatus(meta, nextStatus, {
        failCode: toWrite.failCode,
        failMessage: toWrite.failMessage,
        url: toWrite.url,
        unlockedBy: toWrite.unlockedBy,
      })
      dirty = true
    } else {
      // 状态没变也要跟上来源标记：重下后「这章是恢复来的」不该留在旧值上
      if (nextStatus === 'ready' && meta.unlockedBy !== toWrite.unlockedBy) {
        applyChapterStatus(meta, 'ready', { unlockedBy: toWrite.unlockedBy })
        dirty = true
      }
      if (toWrite.url && meta.url !== toWrite.url) {
        meta.url = toWrite.url
        dirty = true
      }
      if (nextStatus === 'ready' && (meta.failCode || meta.failMessage)) {
        applyChapterStatus(meta, 'ready')
        dirty = true
      }
      // 已失败再失败（重试换了个失败码/说明）：跟上新原因，别停在旧值上
      if (nextStatus === 'failed' && (meta.failCode !== toWrite.failCode || meta.failMessage !== toWrite.failMessage)) {
        applyChapterStatus(meta, 'failed', { failCode: toWrite.failCode, failMessage: toWrite.failMessage })
        dirty = true
      }
    }
    if (dirty) await saveBookUnlocked(book)
  })
}

export async function markChapterReady(bookId: string, chapterId: string, status: ChapterStatus): Promise<void> {
  await markChapterStatus(bookId, chapterId, status)
}

/**
 * 批量写入章节正文：导入一本 txt 要写上千章，逐章走 `writeChapterFile`
 * 会把同一份 book.json 反复读、反复写上千次（导入卡住的主因）。
 * 这里只加一次锁、只读写一次 book.json，章节文件逐个落盘。
 */
export async function writeChaptersBatch(
  bookId: string,
  entries: Array<{ chapterId: string; file: ChapterFile }>,
): Promise<void> {
  if (entries.length === 0) return
  await withBookLock(bookId, async () => {
    const book = await loadBookUnlocked(bookId)
    const byId = new Map(book.chapters.map((meta) => [meta.id, meta]))
    let dirty = false
    for (const entry of entries) {
      const meta = byId.get(entry.chapterId)
      if (!meta) continue
      const toWrite: ChapterFile = { ...entry.file }
      if (shouldPromoteReady(toWrite)) {
        toWrite.status = 'ready'
        delete toWrite.failCode
      }
      await persistChapterJson(bookId, meta.file, toWrite)
      if (toWrite.status && meta.status !== toWrite.status) {
        applyChapterStatus(meta, toWrite.status, {
          failCode: toWrite.failCode,
          url: toWrite.url,
          unlockedBy: toWrite.unlockedBy,
        })
        dirty = true
      } else if (toWrite.url && meta.url !== toWrite.url) {
        meta.url = toWrite.url
        dirty = true
      }
    }
    if (dirty) await saveBookUnlocked(book)
  })
}

export async function markChapterStatus(
  bookId: string,
  chapterId: string,
  status: ChapterStatus,
  extra?: { failCode?: FailCode; failMessage?: string; url?: string; unlockedBy?: UnlockMethod },
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

/**
 * 退出或被杀掉时 book.json 可能永远停在 downloading：没有任务在跑却显示下载中。
 * 启动时按实际章节重算一次，返回修复的本数。
 */
export async function recoverInterruptedStatus(
  items?: readonly Pick<BookListItem, 'id' | 'status'>[],
): Promise<number> {
  let fixed = 0
  for (const item of items ?? (await listBooks())) {
    if (item.status !== 'downloading') continue
    await refreshBookStatus(item.id)
    fixed += 1
  }
  return fixed
}
