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

export type ReaderKeyAction =
  | 'prev-chapter'
  | 'next-chapter'
  | 'page-down'
  | 'page-up'
  | 'font-larger'
  | 'font-smaller'
  | 'close-drawer'

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** 把人物卡整理成可读文本；解析失败时回退原始返回。 */
export function formatCharacterCard(
  card: {
    uptoChapterId?: string
    characters?: Array<{ name: string; role?: string; relations?: string; status?: string }>
    foreshadows?: Array<{ desc: string; where?: string; open?: boolean }>
    raw?: string
  },
  chapterLabel?: (chapterId: string) => string,
): string {
  const lines: string[] = []
  const upto = card.uptoChapterId && chapterLabel ? chapterLabel(card.uptoChapterId) : ''
  if (upto) lines.push(`截至：${upto}`)

  const chars = card.characters ?? []
  if (chars.length) {
    lines.push('', '【人物】')
    for (const c of chars) {
      const parts = [
        c.role ? `（${c.role}）` : '',
        c.relations ? `${c.relations}` : '',
        c.status ? `目前：${c.status}` : '',
      ].filter(Boolean)
      lines.push(`· ${c.name}${parts.length ? ` ${parts.join('；')}` : ''}`)
    }
  }
  const fores = card.foreshadows ?? []
  if (fores.length) {
    lines.push('', '【伏笔】')
    for (const f of fores) {
      const where = f.where ? `（首次出现：${f.where}）` : ''
      const state = f.open === false ? '[已回收]' : '[未回收]'
      lines.push(`· ${f.desc}${where} ${state}`)
    }
  }
  if (!chars.length && !fores.length) {
    return card.raw?.trim() || '（人物卡为空）'
  }
  return lines.join('\n')
}

/** 把键盘事件解析成阅读器动作；不认识或不应处理时返回 null。 */
export function resolveReaderKey(opts: {
  key: string
  targetTag?: string | null
  isContentEditable?: boolean
  anyDrawerOpen?: boolean
  ctrlOrMeta?: boolean
  shift?: boolean
}): ReaderKeyAction | null {
  if (opts.ctrlOrMeta) return null
  const tag = opts.targetTag?.toUpperCase() ?? ''
  if (TEXT_ENTRY_TAGS.has(tag) || opts.isContentEditable) return null
  if (opts.anyDrawerOpen) return opts.key === 'Escape' ? 'close-drawer' : null
  if (opts.key === 'ArrowLeft') return 'prev-chapter'
  if (opts.key === 'ArrowRight') return 'next-chapter'
  if (opts.key === ' ') return opts.shift ? 'page-up' : 'page-down'
  if (opts.key === 'Escape') return 'close-drawer'
  if (opts.key === '+' || opts.key === '=') return 'font-larger'
  if (opts.key === '-' || opts.key === '_') return 'font-smaller'
  return null
}
