/**
 * 网页阅读分栏分页的几何。
 *
 * 单栏 / 双栏都用 CSS 多栏排版：正文容器固定一屏高，按栏宽横向铺开，
 * 外层的横向滚动一步就是一屏。`column-gap` 取两倍的左右内边距，
 * 于是每栏的步长恰好是「视口宽度 ÷ 栏数」，翻页按视口宽度对齐。
 */

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 总页数：横向滚动宽度里有几个视口宽。 */
export function columnPageCount(scrollWidth: number, viewportWidth: number): number {
  if (!isFiniteNumber(viewportWidth) || viewportWidth <= 0) return 1
  if (!isFiniteNumber(scrollWidth) || scrollWidth <= viewportWidth) return 1
  return Math.max(1, Math.ceil(scrollWidth / viewportWidth))
}

/** 当前页（0 基）：滚动位置落在第几屏。 */
export function columnPageIndex(scrollLeft: number, viewportWidth: number): number {
  if (!isFiniteNumber(scrollLeft) || !isFiniteNumber(viewportWidth) || viewportWidth <= 0) return 0
  return Math.max(0, Math.round(scrollLeft / viewportWidth))
}

/** 第 i 页（0 基）应对齐的 scrollLeft。 */
export function columnScrollLeft(pageIndex: number, viewportWidth: number): number {
  if (!isFiniteNumber(pageIndex) || !isFiniteNumber(viewportWidth) || viewportWidth <= 0) return 0
  return Math.max(0, Math.trunc(pageIndex)) * viewportWidth
}

/**
 * 段落离正文起点多远（已扣掉左内边距）→ 它落在第几页。
 * 用于「记住读到哪一段」与「换栏数后回到同一段」。
 */
export function columnPageForOffset(offsetLeft: number, viewportWidth: number): number {
  if (!isFiniteNumber(offsetLeft) || !isFiniteNumber(viewportWidth) || viewportWidth <= 0) return 0
  return Math.max(0, Math.floor(offsetLeft / viewportWidth + 1e-3))
}

/** 自动翻页的间隔：速度档 1–5，一页 6.8 秒到 2 秒。 */
export function autoPageIntervalMs(speed: number): number {
  const level = isFiniteNumber(speed) ? Math.max(1, Math.min(5, Math.round(speed))) : 3
  return 8000 - level * 1200
}
