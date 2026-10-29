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
  // 非法输入（NaN / Infinity）不能当成「已经到底」
  if (!Number.isFinite(scrollTop) || !Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return 0
  const distance = scrollableDistance(scrollHeight, clientHeight)
  // 没有可滚动距离 = 这一章只有一屏、人已经看到底了。
  // 以前这里返回 0，导致短章永远判不出「读完」，追剧因此永远不入队。
  // 但尺寸还是 0（章刚切进去、还没渲染完）不算看到底，否则会误报读完。
  if (distance === 0) return scrollHeight > 0 && clientHeight > 0 ? 1 : 0
  return clampRatio(scrollTop / distance)
}

export function scrollTopFromRatio(ratio: number, scrollHeight: number, clientHeight: number): number {
  return clampRatio(ratio) * scrollableDistance(scrollHeight, clientHeight)
}

/**
 * 全书比例：章节等权估算。已知章节序号时走这条，本地阅读器与网页阅读模式共用同一公式。
 *
 * 它表示的是「读到第几章的位置」，不等于已读文字占比——章节长短差异大时两者差很多，
 * 界面上要按「估算」呈现。
 */
export function approximateBookRatioFromIndex(
  chapterIndex: number,
  totalChapters: number,
  chapterRatio = 0,
): number {
  if (!Number.isFinite(totalChapters) || totalChapters <= 0) return 0
  const index = Number.isFinite(chapterIndex) ? Math.max(0, chapterIndex) : 0
  return clampRatio((index + clampRatio(chapterRatio)) / totalChapters)
}

export function approximateBookRatio(
  chapters: Array<Pick<ChapterMeta, 'id'>>,
  chapterId?: string | null,
  chapterRatio = 0,
): number {
  if (chapters.length === 0) return 0
  const chapterIndex = Math.max(0, chapterIndexOf(chapters, chapterId))
  return approximateBookRatioFromIndex(chapterIndex, chapters.length, chapterRatio)
}

/**
 * 全书比例 → 章节序号：`approximateBookRatioFromIndex` 的反解。
 *
 * 进度条拖动拿到的只有 0–1 的比例，要落回「第几章」。映射规则必须和写盘用的公式同源，
 * 否则拖到进度条 50% 会跳到和面板显示不一致的章。
 */
export function chapterIndexFromBookRatio(ratio: number, totalChapters: number): number {
  if (!Number.isFinite(totalChapters) || totalChapters <= 0) return -1
  const total = Math.trunc(totalChapters)
  if (total <= 0) return -1
  const index = Math.floor(clampRatio(ratio) * total)
  return Math.min(total - 1, Math.max(0, index))
}

export interface ProgressScrubTarget<T extends Pick<ChapterMeta, 'id'>> {
  index: number
  chapter: T
  /** 松手后落点：始终是章首。 */
  scrollRatio: number
}

/**
 * 进度条松手后要打开的章。落点固定 0（章首）——拖进度条是「跳到某章」，不是「跳到某章的某个位置」，
 * 沿用手上的 scrollRatio 会把读者丢进陌生半章。
 */
export function progressScrubTarget<T extends Pick<ChapterMeta, 'id'>>(
  chapters: readonly T[],
  ratio: number,
): ProgressScrubTarget<T> | null {
  if (!Array.isArray(chapters) || chapters.length === 0) return null
  const index = chapterIndexFromBookRatio(ratio, chapters.length)
  if (index < 0) return null
  const chapter = chapters[index]
  if (!chapter) return null
  return { index, chapter, scrollRatio: 0 }
}

/** 拖动浮标上的章名：`第 N 章 · 标题`，标题缺失时只留章序。 */
export function progressScrubLabel(
  chapter: Pick<ChapterMeta, 'id' | 'index' | 'title'>,
  index: number,
): string {
  const ordinal = formatChapterOrdinal(chapter.id, chapter.index || index + 1)
  const title = (chapter.title || '').trim()
  return title ? `${ordinal} · ${title}` : ordinal
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

export type CatalogChapterBadge = 'failed' | 'pending' | 'empty' | 'unlocked' | 'current' | 'read' | null

export function catalogChapterBadge(opts: {
  status: ChapterStatus
  chapterId: string
  currentChapterId?: string | null
  progressChapterId?: string | null
  chapters: Array<Pick<ChapterMeta, 'id'>>
  /** 正文是付费墙自动恢复来的（见 UNLOCK_METHOD_ZH）；有值就挂「恢复」角标。 */
  unlockedBy?: string
}): CatalogChapterBadge {
  const status = opts?.status
  if (status === 'failed') return 'failed'
  if (status === 'pending') return 'pending'
  if (status === 'empty') return 'empty'
  // 恢复来的正文要本人核对完整性，比「当前/已读」更该被看见
  if (status === 'ready' && opts?.unlockedBy) return 'unlocked'
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
  if (code === 'RateLimited') return '站点限流，请过一会儿再重试这一章'
  if (code === 'BodyEmpty') return '正文过短，可重试或为该站填写正文选择器'
  return ''
}

export type ReaderKeyAction =
  | 'prev-chapter'
  | 'next-chapter'
  | 'page-down'
  | 'page-up'
  | 'scroll-top'
  | 'scroll-bottom'
  | 'font-larger'
  | 'font-smaller'
  | 'open-catalog'
  | 'open-appearance'
  | 'open-assistant'
  | 'open-note'
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

/**
 * 阅读页从「不在屏幕上」变回可见时，工具要回到默认收起。
 * 首次观测（null）只登记状态；一直可见的重复回调不收起，避免打断正在读的人。
 */
export function shouldResetReaderToolsOnEntry(
  wasOnScreen: boolean | null,
  isOnScreen: boolean,
): boolean {
  return wasOnScreen === false && isOnScreen === true
}

/** 工具层只在阅读现场完全空闲时自动隐藏。 */
export function shouldAutoHideReaderTools(context: ReaderToolVisibilityContext): boolean {
  return (
    context.idleMs >= TOOL_HIDE_DELAY_MS &&
    !context.overlayOpen &&
    !context.selectionOpen &&
    !context.pointerInToolbar
  )
}

/** 下载状态里与「顶栏要不要自动露出」相关的字段最小组。 */
export interface ReaderDownloadSignal {
  status?: string | null
  bookId?: string | null
}

/**
 * 当前书是否正在下载（未结束）。
 * awaitingHuman 是 running 的子态：下载停在当章等用户去浏览页处理，进度和取消仍要看得见，
 * 所以算「还在下载」。只有 done / error / cancelled 才算结束。
 * 只看状态与书号，不看进度数字——数字随时在变，不该让顶栏抖动。
 */
export function isCurrentBookDownloading(
  progress: ReaderDownloadSignal | null | undefined,
  currentBookId: string | null | undefined,
): boolean {
  if (!progress || !currentBookId) return false
  if (progress.bookId !== currentBookId) return false
  return progress.status === 'running' || progress.status === 'awaitingHuman'
}

/**
 * 下载 running 时顶栏必须露出：正文没被点过也要能看见「已下 x / y 章」与「取消」。
 * 这是「自动露出」，不是「钉死」——用户手动收起仍然优先，所以不参与本函数。
 */
export function shouldForceToolsForDownload(
  progress: ReaderDownloadSignal | null | undefined,
  currentBookId: string | null | undefined,
): boolean {
  return isCurrentBookDownloading(progress, currentBookId)
}

/**
 * 偏好「工具一直显示」是否打开。字段语义是反义：hideReaderChrome 为 false 才表示常显；
 * 缺字段按缺省 true（收起）。
 */
export function shouldRevealToolsForPreference(
  hideReaderChrome: boolean | null | undefined,
): boolean {
  return hideReaderChrome === false
}

/**
 * 下载由 running 转为其他状态（done / error / cancelled）的那一次变化。
 * 只有「曾经在跑、现在停了」才成立；本来就没在跑不算结束，避免每次进度事件都收起。
 */
export function isDownloadJustSettled(
  previous: ReaderDownloadSignal | null | undefined,
  next: ReaderDownloadSignal | null | undefined,
  currentBookId: string | null | undefined,
): boolean {
  return (
    isCurrentBookDownloading(previous, currentBookId) &&
    !isCurrentBookDownloading(next, currentBookId)
  )
}

/** 下载期间的顶栏去留意图。untouched = 用户没表态，自动逻辑说了算。 */
export type ReaderDownloadToolsIntent = 'untouched' | 'revealed' | 'collapsed'

export interface ReaderDownloadToolsDecision {
  /** true 露出、false 收起、null 这次不动。 */
  visible: boolean | null
  intent: ReaderDownloadToolsIntent
}

/**
 * 下载状态变化时顶栏该怎么走。三条硬要求的唯一实现点：
 * 1. 进入 running（新下载或首次拿到状态）就自动露出，正文没点过也看得见进度与取消；
 * 2. 由 running 变结束，用户没表态过就自动收起，表态过就按用户的选择留着；
 * 3. running 期间用户可以自己收自己展，自动逻辑不再跟他抢（不点也不会被自动隐藏）。
 */
export function resolveDownloadToolsPolicy(opts: {
  previous: ReaderDownloadSignal | null | undefined
  next: ReaderDownloadSignal | null | undefined
  currentBookId: string | null | undefined
  intent: ReaderDownloadToolsIntent
}): ReaderDownloadToolsDecision {
  const wasRunning = isCurrentBookDownloading(opts.previous, opts.currentBookId)
  const isRunning = isCurrentBookDownloading(opts.next, opts.currentBookId)

  if (isRunning) {
    // 新一次下载开始：上一次留下的意图作废，重新由自动逻辑露出。
    if (!wasRunning) return { visible: true, intent: 'untouched' }
    if (opts.intent === 'collapsed') return { visible: null, intent: 'collapsed' }
    return { visible: true, intent: opts.intent }
  }

  if (wasRunning) {
    const intent: ReaderDownloadToolsIntent = 'untouched'
    // 用户手动展开过就留着；没表态或只收起过（本来就收着）都回到收起。
    if (opts.intent === 'revealed') return { visible: null, intent }
    return { visible: false, intent }
  }

  return { visible: null, intent: opts.intent === 'collapsed' ? opts.intent : 'untouched' }
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

export type ReaderContentZone = 'left' | 'center' | 'right'

const READER_ZONE_IGNORE_SELECTOR = 'button, a, input, textarea, select, [role="slider"]'

/** 章首/章末停住的滚动余量。差不足这个值就不再翻屏，也不换章。 */
export const READER_SCREEN_EDGE_PX = 8

/**
 * 指针相对 .reader-content 内容盒的横向分区。
 * 左 [0, 1/3)，中 [1/3, 2/3)，右 [2/3, 1]。
 * 点在按钮、链接、输入、滑杆上，或存在未折叠选区时，这次点击不分区。
 */
export function readerContentZone(opts: {
  clientX: number
  contentLeft: number
  contentWidth: number
  target?: EventTarget | null
  selectionCollapsed?: boolean
}): ReaderContentZone | null {
  if (!opts || opts.selectionCollapsed === false) return null
  const target = opts.target as { closest?: (selector: string) => unknown } | null | undefined
  if (target && typeof target.closest === 'function' && target.closest(READER_ZONE_IGNORE_SELECTOR)) return null
  const width = opts.contentWidth
  if (!Number.isFinite(width) || width <= 0) return null
  const x = opts.clientX
  const left = opts.contentLeft
  if (!Number.isFinite(x) || !Number.isFinite(left)) return null
  const ratio = (x - left) / width
  if (ratio < 0 || ratio > 1) return null
  if (ratio < 1 / 3) return 'left'
  if (ratio < 2 / 3) return 'center'
  return 'right'
}

/**
 * 点按翻屏能否在本章内移动。章首点左、章末点右都停住，不换章。
 * 距最大滚动不足 READER_SCREEN_EDGE_PX 视为已经在最后一屏。
 */
export function readerTapCanPage(opts: {
  zone: ReaderContentZone
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  edgePx?: number
}): boolean {
  if (!opts || (opts.zone !== 'left' && opts.zone !== 'right')) return false
  const top = opts.scrollTop
  const height = opts.scrollHeight
  const view = opts.clientHeight
  if (!Number.isFinite(top) || !Number.isFinite(height) || !Number.isFinite(view)) return false
  const edge = Number.isFinite(opts.edgePx) ? Math.max(0, opts.edgePx as number) : READER_SCREEN_EDGE_PX
  if (opts.zone === 'left') return top > edge
  return height - view - top >= edge
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
  // PageUp / PageDown / Home / End 是最常见的翻页键：以前按下去毫无反应
  if (opts.key === 'PageDown') return 'page-down'
  if (opts.key === 'PageUp') return 'page-up'
  if (opts.key === 'Home') return 'scroll-top'
  if (opts.key === 'End') return 'scroll-bottom'
  if (opts.key.toLowerCase() === 'j') return 'page-down'
  if (opts.key.toLowerCase() === 'k') return 'page-up'
  if (opts.key === 'Escape') return 'close-drawer'
  if (opts.key.toLowerCase() === 't') return 'open-catalog'
  if (opts.key.toLowerCase() === 'a') return 'open-appearance'
  if (opts.key.toLowerCase() === 'i') return 'open-assistant'
  if (opts.key.toLowerCase() === 'n') return 'open-note'
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
