import type { BookListItem, FailCode } from '@shared/types'

export type LibraryStatusFilter = 'all' | 'downloading' | 'ready' | 'partial'
export type LibrarySortKey = 'updated' | 'title' | 'author'

export function isDownloadBook(b: Pick<BookListItem, 'importType'>): boolean {
  return b.importType === 'download'
}

export function hasFailedChapters(b: Pick<BookListItem, 'status' | 'readyCount' | 'chapterCount'>): boolean {
  return b.status === 'partial' && b.readyCount < b.chapterCount
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

export function filterLibraryBooks(
  books: BookListItem[],
  opts: { q?: string; status?: LibraryStatusFilter },
): BookListItem[] {
  const q = (opts.q || '').trim().toLowerCase()
  const status = opts.status || 'all'
  return books.filter((b) => {
    if (status !== 'all' && b.status !== status) return false
    if (!q) return true
    return b.title.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q)
  })
}

export function sortLibraryBooks(books: BookListItem[], key: LibrarySortKey = 'updated'): BookListItem[] {
  const next = books.slice()
  if (key === 'title') next.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
  else if (key === 'author') next.sort((a, b) => (a.author || '').localeCompare(b.author || '', 'zh'))
  else next.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  return next
}
