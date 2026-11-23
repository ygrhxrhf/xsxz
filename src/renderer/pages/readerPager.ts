import { clampRatio, scrollableDistance } from './readerHelpers'

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clampIndex(index: number, count: number): number {
  if (!isFiniteNumber(index) || count <= 1) return 0
  return Math.max(0, Math.min(count - 1, Math.trunc(index)))
}

/** 可视页数：一屏一页，最后一页可不足一屏。 */
export function visualPageCount(scrollHeight: number, clientHeight: number): number {
  if (!isFiniteNumber(clientHeight) || clientHeight <= 0) return 1
  if (!isFiniteNumber(scrollHeight) || scrollHeight <= clientHeight) return 1
  return Math.max(1, Math.ceil(scrollHeight / clientHeight))
}

/** 第 i 页（0-based）应对齐的 scrollTop。 */
export function scrollTopForVisualPage(pageIndex: number, scrollHeight: number, clientHeight: number): number {
  if (!isFiniteNumber(pageIndex) || !isFiniteNumber(scrollHeight) || !isFiniteNumber(clientHeight)) return 0
  const count = visualPageCount(scrollHeight, clientHeight)
  const i = clampIndex(pageIndex, count)
  return Math.min(i * clientHeight, scrollableDistance(scrollHeight, clientHeight))
}

/** 把当前 scrollTop 吸附到最近的可视页。 */
export function visualPageIndex(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  if (!isFiniteNumber(scrollTop) || !isFiniteNumber(scrollHeight) || !isFiniteNumber(clientHeight)) return 0
  const count = visualPageCount(scrollHeight, clientHeight)
  if (count <= 1) return 0
  
  // O(1) calculation: find the page whose start is closest to scrollTop
  // Each page i starts at i * clientHeight, except the last page which starts at maxScrollTop
  const maxScrollTop = scrollHeight - clientHeight
  const clampedScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop))
  
  // Calculate candidate page index
  const pageIndex = Math.floor(clampedScrollTop / clientHeight)
  
  // Clamp to valid range
  const currentIndex = Math.max(0, Math.min(pageIndex, count - 1))
  
  // Check if next page is closer or equidistant (handles short last page case)
  if (currentIndex < count - 1) {
    const currentStart = currentIndex * clientHeight
    const nextStart = Math.min((currentIndex + 1) * clientHeight, maxScrollTop)
    const distToCurrent = Math.abs(clampedScrollTop - currentStart)
    const distToNext = Math.abs(clampedScrollTop - nextStart)
    
    // Use <= to prefer next page when equidistant (matches original behavior)
    if (distToNext <= distToCurrent) {
      return currentIndex + 1
    }
  }
  
  return currentIndex
}

/** 进度比例对应的可视页；复用 clampRatio，不复制滚动进度公式。 */
export function visualPageIndexFromRatio(ratio: number, scrollHeight: number, clientHeight: number): number {
  const count = visualPageCount(scrollHeight, clientHeight)
  if (count <= 1) return 0
  return Math.round(clampRatio(ratio) * (count - 1))
}

/** 段落相对正文的纵向范围（px，以正文内容顶为 0）。 */
export interface ReaderParagraphSpan {
  top: number
  bottom: number
}

interface ParagraphPagingInput {
  /** 段落 spans，顺序无关；非法项会被丢掉。 */
  paragraphs: readonly ReaderParagraphSpan[]
  scrollTop: number
  clientHeight: number
  direction: 1 | -1
  /** 正文可滚动总高；缺省时用最后一段的 bottom 兜底。 */
  scrollHeight?: number
  /** 段间空隙容差（px），默认 0。 */
  tolerance?: number
}

function isSpan(value: ReaderParagraphSpan | null | undefined): value is ReaderParagraphSpan {
  return !!value && isFiniteNumber(value.top) && isFiniteNumber(value.bottom) && value.bottom > value.top
}

/**
 * 屏幕翻页落点：视口顶部停在段落边界上。
 *
 * 向下：先按一屏算新屏底部；若底部切断某段（top < 底部 < bottom），落点收到该段段首，
 * 让该段第一句在新屏顶部完整出现。超长段（bottom - top > clientHeight）只前进
 * clientHeight，不跳过该段剩余文字。
 * 向上：退一屏后若落在某段内部，就收到该段段首；超长段只退一屏。
 * 结果钳制在 [0, maxScrollTop]，章首/章末不越界。
 */
export function scrollTopForParagraphPage(input: ParagraphPagingInput): number {
  const view = input?.clientHeight
  const direction = input?.direction === -1 ? -1 : 1
  const tolerance = isFiniteNumber(input?.tolerance) ? Math.max(0, input.tolerance as number) : 0
  const spans = (input?.paragraphs ?? []).filter(isSpan).slice().sort((a, b) => a.top - b.top)

  if (!isFiniteNumber(view) || view <= 0) return 0

  const contentBottom = spans.length ? spans[spans.length - 1]!.bottom : 0
  const height = isFiniteNumber(input?.scrollHeight) && (input.scrollHeight as number) > 0
    ? (input.scrollHeight as number)
    : contentBottom
  const maxTop = Math.max(0, height - view)
  const current = Math.max(0, Math.min(isFiniteNumber(input?.scrollTop) ? input.scrollTop : 0, maxTop))

  if (!spans.length) {
    // 没有段落信息（空章 / 还没量出排版）：退回整屏翻页。
    return direction === -1 ? Math.max(0, current - view) : Math.min(current + view, maxTop)
  }

  const clampTop = (value: number) => Math.max(0, Math.min(value, maxTop))

  if (direction === -1) {
    const candidate = Math.max(0, current - view)
    const covering = spans.find((s) => s.top < candidate - tolerance && s.bottom > candidate + tolerance)
    if (!covering) return clampTop(candidate)
    // 超长段一次退到段首会跨过一整屏文字，只退一屏。
    if (covering.bottom - covering.top > view) return clampTop(candidate)
    return clampTop(covering.top)
  }

  const edge = current + view
  // 新屏底部切断的那一段（最先出现的那段）：落点收到它的段首。
  const cut = spans.find((s) => s.top < edge - tolerance && s.bottom > edge + tolerance)
  let target: number
  if (cut) {
    if (cut.bottom - cut.top > view) {
      // 超长段：只前进一屏，不越过段内剩余文字。
      target = cut.top > current + tolerance
        ? cut.top
        : Math.min(edge, cut.bottom - view)
    } else {
      target = Math.max(current, cut.top)
    }
  } else {
    // 底部落在段间空白或章末：对齐到下一段段首，没有下一段就整屏前进。
    const next = spans.find((s) => s.top >= edge - tolerance)
    target = next ? next.top : edge
  }

  target = clampTop(target)
  // 兜底：任何情况下章内都要能往前走，否则翻页会卡死。
  if (target <= current + tolerance && current < maxTop) target = clampTop(current + view)
  return clampTop(target)
}

/**
 * 把任意 scrollTop 吸附到最近的段落段首（用于「滚动停下后回吸」）。
 * 优先取当前视口顶部所在段的段首；比它更近的下一段段首才会被采纳。
 * 传入 clientHeight 时，视口顶部落在超长段内部就原地不动——否则会一下跳回很远的段首。
 * 没有段落信息时返回原值，交给调用方兜底。
 */
export function snapScrollTopToParagraph(
  paragraphs: readonly ReaderParagraphSpan[],
  scrollTop: number,
  tolerance = 0,
  clientHeight = 0,
): number {
  const spans = (paragraphs ?? []).filter(isSpan).slice().sort((a, b) => a.top - b.top)
  if (!spans.length || !isFiniteNumber(scrollTop)) return isFiniteNumber(scrollTop) ? scrollTop : 0
  const tol = isFiniteNumber(tolerance) ? Math.max(0, tolerance) : 0
  const current = Math.max(0, scrollTop)
  const view = isFiniteNumber(clientHeight) ? clientHeight : 0
  if (view > 0) {
    const tall = spans.find((s) => s.bottom - s.top > view && s.top < current - tol && s.bottom > current + tol)
    if (tall) return current
  }
  let target = spans[0]!.top
  for (const span of spans) {
    if (span.top <= current + tol) target = span.top
    else break
  }
  return Math.max(0, target)
}

export function adjacentVisualPage(pageIndex: number, direction: 1 | -1, pageCount: number): number {
  if (!isFiniteNumber(pageCount) || pageCount <= 1) return 0
  const start = clampIndex(pageIndex, pageCount)
  const step = direction === 1 || direction === -1 ? direction : 0
  return clampIndex(start + step, pageCount)
}

/** 1-based 中文页码标签。 */
export function visualPageLabel(pageIndex: number, pageCount: number): string {
  if (!isFiniteNumber(pageIndex) || !isFiniteNumber(pageCount) || pageCount < 1) return '第 1 / 1 页'
  const y = Math.max(1, Math.trunc(pageCount))
  const x = Math.max(1, Math.min(y, Math.trunc(pageIndex) + 1))
  return `第 ${x} / ${y} 页`
}

/**
 * 已渲染段落的平均段高（px），用于给未渲染段估算占位高度。
 * 无有效数据时回退 fallback（调用方传入基于字号的估算值）。
 */
export function estimateParagraphHeight(spans: readonly ReaderParagraphSpan[], fallback: number): number {
  const valid = (spans ?? []).filter(isSpan)
  if (!valid.length) return Number.isFinite(fallback) && fallback > 0 ? fallback : 0
  let sum = 0
  for (const s of valid) sum += s.bottom - s.top
  const avg = sum / valid.length
  return avg > 0 ? avg : fallback
}

/** 未渲染段数的估算总高（px）；count <= 0 或非法返回 0。 */
export function placeholderHeight(count: number, avgHeight: number): number {
  if (!isFiniteNumber(count) || count <= 0) return 0
  const avg = Number.isFinite(avgHeight) && avgHeight > 0 ? avgHeight : 0
  return count * avg
}

/** 进度比例对应的目标段下标（0-based，夹紧到 [0, total-1]）。 */
export function paragraphIndexForRatio(ratio: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  return clampIndex(Math.round(clampRatio(ratio) * (total - 1)), total)
}

/**
 * 窗口化渲染的段落区间：以 target 为中心、size 为窗口大小，夹紧在 [0, total)。
 * size >= total 时整章渲染（start=0, end=total）。
 */
export function windowBoundsFor(target: number, total: number, size: number): { start: number; end: number } {
  if (!Number.isFinite(total) || total <= 0) return { start: 0, end: 0 }
  const win = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0
  if (win <= 0) return { start: 0, end: 0 }
  if (win >= total) return { start: 0, end: total }
  const t = clampIndex(target, total)
  let start = Math.max(0, t - Math.floor(win / 2))
  start = Math.min(start, total - win)
  return { start, end: start + win }
}
