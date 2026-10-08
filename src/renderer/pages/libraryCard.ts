import type { BookListItem, FailCode } from '@shared/types'

export type LibraryStatusFilter = 'all' | 'downloading' | 'ready' | 'partial'
export type LibrarySortKey = 'updated' | 'title' | 'author'
export type LibraryMenuKey =
  | 'recap'
  | 'check-update'
  | 'retry-failed'
  | 'view-failed'
  | 'export-txt'
  | 'export-epub'
  | 'trash'
export type LibraryMenuEntry = LibraryMenuKey | 'divider-export' | 'divider-trash'

const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const LATIN_OR_NUMBER_CHARACTER = /[\p{Script=Latin}\p{Number}]/u
const COVER_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Latin}\p{Number}]/u

export function libraryCoverHue(id: string): number {
  let hue = 0
  for (let i = 0; i < id.length; i += 1) hue = (hue * 31 + id.charCodeAt(i)) % 360
  return hue
}

export function libraryCoverHues(id: string): { primary: number; secondary: number } {
  const primary = libraryCoverHue(id)
  return { primary, secondary: (primary + 36) % 360 }
}

export function libraryCoverText(title: string): string {
  const normalized = title
    .trim()
    .replace(/^[《〈「『【〔（(]+|[》〉」』】〕）)]+$/gu, '')
    .trim()
  const first = COVER_CHARACTER.exec(normalized)
  if (!first || first.index === undefined) return '书'
  if (CJK_CHARACTER.test(first[0])) return first[0]
  if (!LATIN_OR_NUMBER_CHARACTER.test(first[0])) return '书'
  return normalized.slice(first.index).match(/^[\p{Script=Latin}\p{Number}]{1,2}/u)?.[0].toUpperCase() || '书'
}

export function createLibraryRefreshTracker(): {
  begin: () => number
  isLatest: (requestId: number) => boolean
  end: () => void
  readonly loading: boolean
} {
  let latestRequestId = 0
  let activeRequests = 0
  return {
    begin() {
      activeRequests += 1
      latestRequestId += 1
      return latestRequestId
    },
    isLatest(requestId) {
      return requestId === latestRequestId
    },
    end() {
      activeRequests = Math.max(0, activeRequests - 1)
    },
    get loading() {
      return activeRequests > 0
    },
  }
}

export function libraryFailureLabel(
  book: Pick<BookListItem, 'status' | 'readyCount' | 'chapterCount'>,
): string {
  if (!hasFailedChapters(book)) return ''
  return `${Math.max(1, book.chapterCount - book.readyCount)} 章下载失败`
}

export function isDownloadBook(b: Pick<BookListItem, 'importType'>): boolean {
  return b.importType === 'download'
}

export function hasFailedChapters(b: Pick<BookListItem, 'status' | 'readyCount' | 'chapterCount'>): boolean {
  return b.status === 'partial' && b.readyCount < b.chapterCount
}

export function libraryMenuEntries(
  book: Pick<BookListItem, 'importType' | 'status' | 'readyCount' | 'chapterCount'>,
): LibraryMenuEntry[] {
  const entries: LibraryMenuEntry[] = ['recap']
  if (isDownloadBook(book)) entries.push('check-update')
  if (hasFailedChapters(book)) entries.push('retry-failed', 'view-failed')
  entries.push('divider-export', 'export-txt', 'export-epub', 'divider-trash', 'trash')
  return entries
}

export function checkUpdateMessage(
  res: { ok: true; added: number } | { ok: false; message: string },
): string {
  if (!res.ok) return res.message
  if (res.added > 0) return `新增 ${res.added} 章`
  return '没有更新'
}

export function applyAddedChapterCount(chapterCount: number, added: number): number {
  return added > 0 ? chapterCount + added : chapterCount
}

export function formatChapterOrdinal(chapterId?: string | null, fallbackIndex?: number): string {
  if (typeof fallbackIndex === 'number' && fallbackIndex > 0) return `第 ${fallbackIndex} 章`
  const ordinal = catalogChapterOrdinal(chapterId)
  if (ordinal > 0) return `第 ${ordinal} 章`
  return chapterId || '未读'
}

/** progress 所在章在目录中的序号（从 1 计）。无 progress 或无法从 chapterId 解析时为 0。 */
export function libraryReadChapterOrdinal(b: Pick<BookListItem, 'progress'>): number {
  if (!b.progress) return 0
  return catalogChapterOrdinal(b.progress.chapterId)
}

function catalogChapterOrdinal(chapterId?: string | null): number {
  const m = /^c0*([0-9]+)$/i.exec(chapterId || '')
  return m ? Number(m[1]) : 0
}

export function formatLibraryProgress(b: Pick<BookListItem, 'chapterCount' | 'progress'>): string {
  return `已读 ${libraryReadChapterOrdinal(b)} / 共 ${b.chapterCount} 章`
}

export function formatLibraryProgressTime(b: Pick<BookListItem, 'progress'>): string {
  if (!b.progress) return '未读'
  const d = new Date(b.progress.updatedAt)
  return Number.isNaN(d.getTime()) ? b.progress.updatedAt : d.toLocaleString('zh-CN')
}

export function checkUpdateNeedsBrowse(code?: FailCode | string): boolean {
  return code === 'NeedLogin' || code === 'Paywall' || code === 'Intercepted'
}

export function isLibraryFindShortcut(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey?: boolean
}): boolean {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f'
}

export function collectLibraryTags(books: Array<Pick<BookListItem, 'tags'>>): string[] {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const book of books) {
    for (const raw of book.tags || []) {
      const tag = raw.trim()
      if (!tag) continue
      const key = tag.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      tags.push(tag)
    }
  }
  return tags
}

/** 编辑信息：按逗号/回车拆分，trim 丢空串，同书大小写不敏感去重并保留先出现写法。 */
export function normalizeEditTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    for (const part of String(raw).split(/[,，]/)) {
      const tag = part.trim()
      if (!tag) continue
      const key = tag.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      result.push(tag)
    }
  }
  return result
}

export function filterLibraryBooks(
  books: BookListItem[],
  opts: { q?: string; status?: LibraryStatusFilter; selectedTag?: string },
): BookListItem[] {
  const q = (opts.q || '').trim().toLowerCase()
  const status = opts.status || 'all'
  const selectedTag = (opts.selectedTag || '').trim().toLowerCase()
  return books.filter((b) => {
    if (status !== 'all' && b.status !== status) return false
    if (selectedTag && !(b.tags || []).some((tag) => tag.toLowerCase() === selectedTag)) return false
    if (!q) return true
    if (b.title.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q)) return true
    return (b.tags || []).some((tag) => tag.toLowerCase().includes(q))
  })
}

export function sortLibraryBooks(books: BookListItem[], key: LibrarySortKey = 'updated'): BookListItem[] {
  const next = books.slice()
  if (key === 'title') next.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
  else if (key === 'author') next.sort((a, b) => (a.author || '').localeCompare(b.author || '', 'zh'))
  else next.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  return next
}

const COVER_FILE_RE = /^cover\.(jpg|png|webp)$/i

export function libraryCoverFileName(coverPath?: string | null): string | null {
  if (typeof coverPath !== 'string') return null
  const name = coverPath.trim().replace(/\\/g, '/')
  if (!name || name.includes('/') || name.includes('..')) return null
  if (!COVER_FILE_RE.test(name)) return null
  return name.toLowerCase()
}

function encodeFileUrlPath(unixPath: string): string {
  return unixPath
    .split('/')
    .map((segment) => {
      if (segment === '') return ''
      if (/^[A-Za-z]:$/.test(segment)) return segment
      return encodeURIComponent(segment)
    })
    .join('/')
}

export function libraryCoverSrc(
  libraryPath: string,
  bookId: string,
  coverPath?: string | null,
): string | null {
  const file = libraryCoverFileName(coverPath)
  const root = (libraryPath || '').trim()
  const id = (bookId || '').trim()
  if (!file || !root || !id) return null
  if (id.includes('..') || /[\\/]/.test(id)) return null
  const unixRoot = root.replace(/\\/g, '/').replace(/\/+$/g, '')
  const abs = `${unixRoot}/${id}/${file}`
  const withLead = abs.startsWith('/') ? abs : `/${abs}`
  return `file://${encodeFileUrlPath(withLead)}`
}

export function mapLibraryCoverError(message?: string | null): string {
  const text = (message || '').toLowerCase()
  if (text.includes('8mb') || text.includes('超过')) return '封面不能超过 8MB'
  if (text.includes('jpg') || text.includes('png') || text.includes('webp') || text.includes('仅支持')) {
    return '仅支持 jpg、png、webp'
  }
  return '保存失败，已保留原来的信息'
}

export type LibraryDuplicateGroup = {
  key: string
  title: string
  author: string
  books: BookListItem[]
}

/** 书名与作者均 trim 后大小写不敏感比较用的分组键。 */
export function libraryDuplicateKey(book: Pick<BookListItem, 'title' | 'author'>): string {
  return `${book.title.trim().toLowerCase()}\0${(book.author || '').trim().toLowerCase()}`
}

/** 书名+作者完全相同（trim、大小写不敏感）且 ≥2 本的组；组序与组内书序保持书库原顺序，展示文案取先出现写法。 */
export function findLibraryDuplicateGroups(books: BookListItem[]): LibraryDuplicateGroup[] {
  const buckets = new Map<string, BookListItem[]>()
  for (const book of books) {
    const key = libraryDuplicateKey(book)
    const list = buckets.get(key)
    if (list) list.push(book)
    else buckets.set(key, [book])
  }
  const groups: LibraryDuplicateGroup[] = []
  for (const [key, list] of buckets) {
    if (list.length < 2) continue
    groups.push({
      key,
      title: list[0].title,
      author: list[0].author || '',
      books: list,
    })
  }
  return groups
}
