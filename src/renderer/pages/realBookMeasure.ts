import type { RealBookLine } from './realBookPager'

/**
 * 量一段文字在给定宽度下怎么断行。
 *
 * 真实书籍的页表是排版缓存，算错就会整章漂页，所以量测必须与真实渲染同宽同字体
 * （调用方把离屏容器设成与页面版心一样的样式）。这里不自己实现断行算法——
 * 用浏览器自己的排版结果：Range 的 getClientRects() 每行返回一个矩形，
 * 再对每行边界做一次二分，找到该行的字符区间。
 *
 * 量不出来时（无布局环境、字体未就绪）退化为「整段一行」：宁可多页也不腰斩，
 * 页表仍自洽，只是页数偏多。
 */
export function measureLines(
  text: string,
  el: HTMLElement,
  /** 段内「注」标记的偏移：量断行时按一个全角字符占位，页表才不会少算一行。 */
  noteOffsets: readonly number[] = [],
): RealBookLine[] {
  const length = text.length
  if (length <= 0) return []
  const marks = [...new Set(noteOffsets)]
    .filter((offset) => Number.isFinite(offset) && offset >= 0 && offset <= length)
    .sort((a, b) => a - b)
  let measureText = text
  const markIndexes: number[] = []
  if (marks.length) {
    let out = ''
    let cursor = 0
    for (const offset of marks) {
      // 全角空格 + 半个字宽的间隔，约等于「注」圆标加左右留白的占位。
      out += text.slice(cursor, offset) + '　 '
      cursor = offset
      markIndexes.push(out.length - 2, out.length - 1)
    }
    out += text.slice(cursor)
    measureText = out
  }
  const measureLength = measureText.length
  el.textContent = measureText
  const node = el.firstChild
  if (!node) return [{ start: 0, end: length }]

  let rects: DOMRect[]
  try {
    const range = document.createRange()
    range.selectNodeContents(node)
    rects = Array.from(range.getClientRects?.() ?? [])
  } catch {
    return [{ start: 0, end: length }]
  }
  const usable = rects.filter((rect) => rect.height > 0 || rect.width > 0)
  if (!usable.length) return [{ start: 0, end: length }]

  /** 量测串下标 → 原文字符下标（扣掉插入的占位符）。 */
  const toOriginal = (index: number): number => {
    let inserted = 0
    for (const markIndex of markIndexes) {
      if (markIndex < index) inserted += 1
      else break
    }
    return Math.max(0, Math.min(length, index - inserted))
  }

  const probe = document.createRange()
  const topAt = (offset: number): number => {
    const at = Math.max(0, Math.min(offset, measureLength - 1))
    try {
      probe.setStart(node, at)
      probe.setEnd(node, Math.min(at + 1, measureLength))
      return probe.getBoundingClientRect().top
    } catch {
      return usable[0]!.top
    }
  }

  const lines: RealBookLine[] = []
  let start = 0
  for (const rect of usable) {
    const top = rect.top
    // 该行最后一个字符的下标：二分找「行顶还等于 top」的最大偏移。
    let low = start
    let high = measureLength - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (topAt(middle) <= top + 0.5) low = middle
      else high = middle - 1
    }
    const end = Math.min(measureLength, low + 1)
    const originalStart = toOriginal(start)
    const originalEnd = toOriginal(end)
    if (originalEnd <= originalStart) {
      start = end
      continue
    }
    lines.push({ start: originalStart, end: originalEnd })
    start = end
    if (start >= measureLength) break
  }
  if (!lines.length) return [{ start: 0, end: length }]
  if (lines[lines.length - 1]!.end < length) {
    lines.push({ start: lines[lines.length - 1]!.end, end: length })
  }
  return lines
}
