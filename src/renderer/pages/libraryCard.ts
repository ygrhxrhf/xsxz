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
  const m = /^c0*([0-9]+)$/i.exec(chapterId || '')
  if (m) return `第 ${Number(m[1])} 章`
  return chapterId || '未读'
}

export function formatLibraryProgress(b: BookListItem): string {
  const ready = `${b.readyCount}/${b.chapterCount} 章`
  if (!b.progress) return ready
  const pct = Math.round(Math.max(0, Math.min(1, b.progress.scrollRatio || 0)) * 100)
  return `${formatChapterOrdinal(b.progress.chapterId)} · ${pct}% · ${ready}`
}

export function checkUpdateNeedsBrowse(code?: FailCode | string): boolean {
  return code === 'NeedLogin' || code === 'Intercepted'
}

export function isLibraryFindShortcut(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey?: boolean
}): boolean {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f'
}

export function filterLibraryBooks(
  books: BookListItem[],
  opts: { q?: string; status?: LibraryStatusFilter },
): BookListItem[] {
  const q = (opts.q || '').trim().toLowerCase()
  const status = opts.status || 'all'
  return books.filter((b) => {
    if (status !== 'all' && b.status !== status) return false
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
