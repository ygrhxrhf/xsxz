import type { ChapterMeta, FailCode } from '@shared/types'
import { formatChapterOrdinal } from './libraryCard'

export function chapterIndexOf(chapters: Array<Pick<ChapterMeta, 'id'>>, chapterId?: string | null): number {
  if (!chapterId) return -1
  return chapters.findIndex((c) => c.id === chapterId)
}

export function remainingChapterCount(
  chapters: Array<Pick<ChapterMeta, 'id'>>,
  chapterId?: string | null,
): number {
  const i = chapterIndexOf(chapters, chapterId)
  if (i < 0) return chapters.length
  return Math.max(0, chapters.length - i - 1)
}

export function readerProgressLabel(
  chapters: Array<Pick<ChapterMeta, 'id' | 'index'>>,
  chapterId?: string | null,
  scrollRatio = 0,
): string {
  const i = chapterIndexOf(chapters, chapterId)
  const ordinal =
    i >= 0 ? formatChapterOrdinal(chapterId, chapters[i]?.index || i + 1) : formatChapterOrdinal(chapterId)
  const pct = Math.round(Math.max(0, Math.min(1, scrollRatio)) * 100)
  const left = remainingChapterCount(chapters, chapterId)
  return `${ordinal} · 本章 ${pct}% · 还剩 ${left} 章`
}

export function filterCatalogChapters<T extends Pick<ChapterMeta, 'title'>>(chapters: T[], q: string): T[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return chapters
  return chapters.filter((c) => c.title.toLowerCase().includes(needle))
}

export function failAdvice(code?: FailCode): string {
  if (code === 'NeedLogin') return '请先到浏览页登录该站，再重试失败章'
  if (code === 'Intercepted') return '页面被拦截，请先到浏览页打开该站后再重试'
  if (code === 'NavFailed') return '地址加载失败，可稍后重试这一章'
  if (code === 'BodyEmpty') return '正文过短，可重试或为该站填写正文选择器'
  return ''
}
