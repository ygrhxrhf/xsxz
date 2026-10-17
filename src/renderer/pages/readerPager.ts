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
