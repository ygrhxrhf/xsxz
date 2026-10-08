import type { ChapterMeta, ChapterStatus, FailCode, ReaderFocusMode } from '@shared/types'
import { formatChapterOrdinal } from './libraryCard'

export function chapterIndexOf(chapters: Array<Pick<ChapterMeta, 'id'>>, chapterId?: string | null): number {
  if (!chapterId) return -1
  return chapters.findIndex((c) => c.id === chapterId)
}

export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function scrollableDistance(scrollHeight: number, clientHeight: number): number {
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return 0
  return Math.max(0, scrollHeight - clientHeight)
}

export function chapterScrollRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const distance = scrollableDistance(scrollHeight, clientHeight)
  if (distance === 0 || !Number.isFinite(scrollTop)) return 0
  return clampRatio(scrollTop / distance)
}

export function scrollTopFromRatio(ratio: number, scrollHeight: number, clientHeight: number): number {
  return clampRatio(ratio) * scrollableDistance(scrollHeight, clientHeight)
}

export function approximateBookRatio(
  chapters: Array<Pick<ChapterMeta, 'id'>>,
  chapterId?: string | null,
  chapterRatio = 0,
): number {
  if (chapters.length === 0) return 0
  const chapterIndex = Math.max(0, chapterIndexOf(chapters, chapterId))
  return clampRatio((chapterIndex + clampRatio(chapterRatio)) / chapters.length)
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
  const pct = Math.round(clampRatio(scrollRatio) * 100)
  const left = remainingChapterCount(chapters, chapterId)
  return `${ordinal} · 本章 ${pct}% · 还剩 ${left} 章`
}

export type CatalogChapterBadge = 'failed' | 'pending' | 'empty' | 'current' | 'read' | null

export function catalogChapterBadge(opts: {
  status: ChapterStatus
  chapterId: string
  currentChapterId?: string | null
  progressChapterId?: string | null
  chapters: Array<Pick<ChapterMeta, 'id'>>
}): CatalogChapterBadge {
  const status = opts?.status
  if (status === 'failed') return 'failed'
  if (status === 'pending') return 'pending'
  if (status === 'empty') return 'empty'
  const chapterId = opts?.chapterId
  if (chapterId && chapterId === opts?.currentChapterId) return 'current'
  const chapters = Array.isArray(opts?.chapters) ? opts.chapters : []
  const chapterIndex = chapterIndexOf(chapters, chapterId)
  const progressIndex = chapterIndexOf(chapters, opts?.progressChapterId)
  if (
    Number.isFinite(chapterIndex) &&
    Number.isFinite(progressIndex) &&
    chapterIndex >= 0 &&
    progressIndex >= 0 &&
    chapterIndex < progressIndex
  ) {
    return 'read'
  }
  return null
}

export function filterCatalogChapters<T extends Pick<ChapterMeta, 'title'>>(chapters: T[], q: string): T[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return chapters
  return chapters.filter((c) => c.title.toLowerCase().includes(needle))
}

export function failAdvice(code?: FailCode): string {
  if (code === 'NeedLogin') return '请先到浏览页登录该站，再重试失败章'
  if (code === 'Paywall') return '本章要付费或会员，请到浏览页解锁后重试该章'
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
  | 'open-catalog'
  | 'open-appearance'
  | 'toggle-tts'
  | 'close-drawer'

export type ReaderImmersiveMode = 'normal' | 'locked'

export interface ReaderToolVisibilityContext {
  idleMs: number
  overlayOpen: boolean
  selectionOpen: boolean
  pointerInToolbar: boolean
}

export interface ReaderImmersiveKeyResult {
  mode: ReaderImmersiveMode
  toolsVisible: boolean
  temporaryReveal: boolean
}

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const TOOL_HIDE_DELAY_MS = 3000

/** 工具层只在阅读现场完全空闲时自动隐藏。 */
export function shouldAutoHideReaderTools(context: ReaderToolVisibilityContext): boolean {
  return (
    context.idleMs >= TOOL_HIDE_DELAY_MS &&
    !context.overlayOpen &&
    !context.selectionOpen &&
    !context.pointerInToolbar
  )
}

/** 解析沉浸阅读快捷键；抽屉关闭等优先级由组件负责。 */
export function resolveImmersiveKey(
  key: string,
  mode: ReaderImmersiveMode,
): ReaderImmersiveKeyResult | null {
  const normalized = key.toLowerCase()
  if (normalized === 'm') {
    return {
      mode: mode === 'locked' ? 'normal' : 'locked',
      toolsVisible: true,
      temporaryReveal: false,
    }
  }
  if (key === 'Alt') {
    return { mode, toolsVisible: true, temporaryReveal: mode === 'locked' }
  }
  if (key === 'Escape') {
    return { mode: 'normal', toolsVisible: true, temporaryReveal: false }
  }
  return null
}

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
  if (opts.key.toLowerCase() === 'j') return 'page-down'
  if (opts.key.toLowerCase() === 'k') return 'page-up'
  if (opts.key === 'Escape') return 'close-drawer'
  if (opts.key.toLowerCase() === 't') return 'open-catalog'
  if (opts.key.toLowerCase() === 'a') return 'open-appearance'
  if (opts.key.toLowerCase() === 'r') return 'toggle-tts'
  if (opts.key === '+' || opts.key === '=') return 'font-larger'
  if (opts.key === '-' || opts.key === '_') return 'font-smaller'
  return null
}

/** 系统要求减少动效时用瞬时滚动，否则平滑滚动。 */
export function readerScrollBehavior(reduceMotion: boolean): ScrollBehavior {
  return reduceMotion ? 'auto' : 'smooth'
}

export function focusHalfWindow(mode: ReaderFocusMode): number {
  if (mode === 'three') return 1
  if (mode === 'five') return 2
  return 0
}

export function isParagraphInFocus(opts: {
  mode: ReaderFocusMode
  anchorIndex: number
  paragraphIndex: number
  paragraphCount: number
}): boolean {
  if (opts.mode === 'off' || opts.paragraphCount <= 0) return true
  const last = opts.paragraphCount - 1
  const anchor = Number.isFinite(opts.anchorIndex)
    ? Math.max(0, Math.min(last, Math.trunc(opts.anchorIndex)))
    : 0
  const half = focusHalfWindow(opts.mode)
  const i = opts.paragraphIndex
  return i >= anchor - half && i <= anchor + half
}

export function resolveFocusAnchor(opts: { spokenPara: number; viewportCenterPara: number }): number {
  if (Number.isFinite(opts.spokenPara) && opts.spokenPara >= 0) return opts.spokenPara
  if (Number.isFinite(opts.viewportCenterPara) && opts.viewportCenterPara >= 0) return opts.viewportCenterPara
  return -1
}

export function paragraphIndexAtViewportCenter(opts: {
  viewportCenter: number
  paragraphCenters: number[]
}): number {
  if (!Array.isArray(opts.paragraphCenters) || opts.paragraphCenters.length === 0) return -1
  if (!Number.isFinite(opts.viewportCenter)) return -1
  let best = -1
  let bestDist = Number.POSITIVE_INFINITY
  for (let i = 0; i < opts.paragraphCenters.length; i++) {
    const c = opts.paragraphCenters[i]
    if (!Number.isFinite(c)) continue
    const d = Math.abs(c - opts.viewportCenter)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return best
}

export function wheelPageDirection(deltaY: number, minDelta = 8): 1 | -1 | 0 {
  if (!Number.isFinite(deltaY) || Math.abs(deltaY) < minDelta) return 0
  return deltaY > 0 ? 1 : -1
}

export type SelectionPopupPlacement = 'above' | 'below'

export interface SelectionPopupPositionOpts {
  range: { top: number; right: number; bottom: number; left: number; width: number; height: number }
  viewport: { width: number; height: number }
  popup: { width: number; height: number }
  gap?: number
  margin?: number
}

function finiteOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nonNegOr(value: unknown, fallback = 0): number {
  const n = finiteOr(value, fallback)
  return n < 0 ? 0 : n
}

/** 夹入 [margin, viewport - size - margin]；可用空间不足时贴 margin。 */
function clampPopupAxis(value: number, size: number, viewport: number, margin: number): number {
  const min = margin
  const max = viewport - size - margin
  const start = Number.isFinite(value) ? value : min
  if (!Number.isFinite(min)) return 0
  if (!Number.isFinite(max) || max < min) return min
  return Math.min(max, Math.max(min, start))
}

/** 选区弹出层的 viewport 坐标，供 position:fixed 使用。 */
export function selectionPopupPosition(opts: SelectionPopupPositionOpts): {
  x: number
  y: number
  placement: SelectionPopupPlacement
} {
  const gap = nonNegOr(opts?.gap, 8)
  const margin = nonNegOr(opts?.margin, 8)
  const range = opts?.range
  const viewport = opts?.viewport
  const popup = opts?.popup

  const popupW = nonNegOr(popup?.width)
  const popupH = nonNegOr(popup?.height)
  const vpW = nonNegOr(viewport?.width)
  const vpH = nonNegOr(viewport?.height)

  const left = finiteOr(range?.left)
  const top = finiteOr(range?.top)
  const width = nonNegOr(range?.width)
  const bottom = finiteOr(range?.bottom)

  let placement: SelectionPopupPlacement = 'below'
  let y = bottom + gap
  if (y + popupH + margin > vpH) {
    placement = 'above'
    y = top - gap - popupH
  }

  const x = left + width / 2 - popupW / 2
  return {
    x: clampPopupAxis(x, popupW, vpW, margin),
    y: clampPopupAxis(y, popupH, vpH, margin),
    placement,
  }
}
