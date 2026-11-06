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
export function measureLines(text: string, el: HTMLElement): RealBookLine[] {
  const length = text.length
  if (length <= 0) return []
  el.textContent = text
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

  const probe = document.createRange()
  const topAt = (offset: number): number => {
    const at = Math.max(0, Math.min(offset, length - 1))
    try {
      probe.setStart(node, at)
      probe.setEnd(node, Math.min(at + 1, length))
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
    let high = length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (topAt(middle) <= top + 0.5) low = middle
      else high = middle - 1
    }
    const end = Math.min(length, low + 1)
    if (end <= start) continue
    lines.push({ start, end })
    start = end
    if (start >= length) break
  }
  if (!lines.length) return [{ start: 0, end: length }]
  if (lines[lines.length - 1]!.end < length) {
    lines.push({ start: lines[lines.length - 1]!.end, end: length })
  }
  return lines
}
