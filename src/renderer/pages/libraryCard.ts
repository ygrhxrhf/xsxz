import type { BookListItem } from '@shared/types'

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
