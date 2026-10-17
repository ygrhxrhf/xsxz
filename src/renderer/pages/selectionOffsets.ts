/**
 * 阅读器选区 → 规范化正文坐标的换算。
 *
 * 抽成纯函数有两个原因：一是这是整条选区链路里唯一有算法的一段（DOM 遍历 + 段落下标表），
 * 二是它在组件里没法测——选区是在 `setTimeout` 里才被读的，而 jsdom 里组件一重渲染就把选区
 * 折叠了，挂载级测试永远等不到工具条。这里只吃 DOM 事实（选区 + 段落下标表 + 规范化正文），
 * 不碰任何组件状态，于是可以直接在 jsdom 里测。
 */
export interface SelectionOffsets {
  start: number
  end: number
  /** 选中区间在规范化正文里的原文（含跨段的 `\n\n`），用于划线摘录与漂移校正 */
  text: string
}

/**
 * @param selection 当前 DOM 选区
 * @param paragraphStarts 每段在规范化正文里的起始下标（第 i 段 = paragraphStarts[i]）
 * @param normalizedBody 规范化正文（段落以空行连接）
 */
export function selectionRangeOffsets(
  selection: Selection | null,
  paragraphStarts: number[],
  normalizedBody: string,
): SelectionOffsets | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const locateEl = (node: Node): Element | null => {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
    return el?.closest('[data-p]') ?? null
  }
  const startP = locateEl(range.startContainer)
  const endP = locateEl(range.endContainer)
  if (!startP || !endP) return null

  const localOffsetIn = (p: Element, container: Node, off: number): number | null => {
    let acc = 0
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const n = walker.currentNode
      if (n === container) return acc + off
      acc += n.textContent?.length ?? 0
    }
    return null
  }
  const l0 = localOffsetIn(startP, range.startContainer, range.startOffset)
  const l1 = localOffsetIn(endP, range.endContainer, range.endOffset)
  if (l0 === null || l1 === null) return null

  const i0 = Number(startP.getAttribute('data-p'))
  const i1 = Number(endP.getAttribute('data-p'))
  const start = (paragraphStarts[i0] ?? 0) + l0
  const end = (paragraphStarts[i1] ?? 0) + l1
  if (end <= start) return null
  const text = normalizedBody.slice(start, end)
  if (!text.trim()) return null
  return { start, end, text }
}
