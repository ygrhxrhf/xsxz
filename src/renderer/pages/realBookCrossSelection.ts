/**
 * 跨页选择的纯逻辑：坐标排序、跨页高亮盒子。
 *
 * WebGL 书页的正文是逐行绝对定位的，原生选区一旦翻页就会被重建的文本层清掉，
 * 所以跨页选择不能继续依赖 `window.getSelection()`，而是把两端记成
 * 「段落下标 + 段内偏移」，再按当前可见页的行表画伪选区。
 */

/** 选区一端：段落原始下标 + 段内字符偏移。 */
export interface SelectionPoint {
  paragraph: number
  /** 段内偏移 */
  offset: number
}

/** 交给 Reader 的跨页选区：两端坐标 + 松手位置（工具条落点用）。 */
export interface CrossSelectionRange {
  startParagraph: number
  startOffset: number
  endParagraph: number
  endOffset: number
  /** 视口坐标：松手时的指针位置 */
  x: number
  y: number
}

/** 选区两端按「段落 → 段内偏移」排序；反选时也返回从前往后的一对。 */
export function orderSelection(a: SelectionPoint, b: SelectionPoint): [SelectionPoint, SelectionPoint] {
  if (a.paragraph < b.paragraph) return [a, b]
  if (a.paragraph > b.paragraph) return [b, a]
  return a.offset <= b.offset ? [a, b] : [b, a]
}

export interface CrossSelectionLine {
  /** 段落原始下标 */
  paragraphIndex: number
  /** 行首在段内的偏移 */
  start: number
  /** 行尾在段内的偏移 */
  end: number
  /** 行文字 */
  text: string
  x: number
  y: number
  height: number
}

export interface CrossLineBox {
  left: number
  top: number
  width: number
  height: number
}

/**
 * 一页里被跨页选区覆盖的高亮盒子。
 *
 * `measure` 量的是「同一字体下一段文字的宽度」，由调用方注入（画布 measureText），
 * 这样盒子与纹理里画出来的字共用一套字宽，不会错位。
 */
export function crossSelectionBoxes(
  lines: readonly CrossSelectionLine[],
  a: SelectionPoint,
  b: SelectionPoint,
  measure: (text: string) => number,
): CrossLineBox[] {
  const [from, to] = orderSelection(a, b)
  const boxes: CrossLineBox[] = []
  for (const line of lines) {
    const paragraph = line.paragraphIndex
    if (paragraph < from.paragraph || paragraph > to.paragraph) continue
    const start = paragraph === from.paragraph ? Math.max(from.offset, line.start) : line.start
    const end = paragraph === to.paragraph ? Math.min(to.offset, line.end) : line.end
    if (end <= start) continue
    const localStart = Math.max(0, Math.min(line.text.length, start - line.start))
    const localEnd = Math.max(localStart, Math.min(line.text.length, end - line.start))
    const prefix = line.text.slice(0, localStart)
    const picked = line.text.slice(localStart, localEnd)
    if (!picked) continue
    const width = Math.max(1, measure(picked))
    boxes.push({
      left: line.x + measure(prefix),
      top: line.y,
      width,
      height: line.height,
    })
  }
  return boxes
}
