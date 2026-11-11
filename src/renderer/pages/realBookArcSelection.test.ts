// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { selectionRangeOffsets } from './selectionOffsets'
import { arcLineSegments, splitLineBySegments } from './realBookArcText'

/**
 * 弧面 SVG 结构与真实选区链路的对接测试。
 *
 * ## 为什么必须单独测这件事
 *
 * `RealBookArcPage` 把一行文字拆成多个 `<text>`（每段一个），而段落锚点挂在它们的
 * 公共父级 `<g data-p>` 上。`selectionRangeOffsets` 靠 `closest('[data-p]')` 找段落、
 * 再用 TreeWalker 在该元素内**累加文本长度**算段内偏移——只要同段各段的文本节点
 * 在 DOM 里连续且顺序正确，偏移就该算对。这是设计时的假设，不是事实，必须验证。
 *
 * 另一个要钉住的点：整段切分后拼回去必须与原文完全一致。少一个字，偏移会整体错位。
 */
const SVG_NS = 'http://www.w3.org/2000/svg'

const PARAS = ['第一段文字，用来验证弧面分段后的选区偏移是否仍然正确。', '第二段文字。']
const BODY = PARAS.join('\n\n')
const STARTS = [0, PARAS[0]!.length + 2]

/** 按组件的方式建树：一页一行一段，每行再按弧面切成若干 <text>。 */
function mountArcPage(paragraphs: string[], segments = 5): void {
  document.body.innerHTML = ''
  const svg = document.createElementNS(SVG_NS, 'svg')
  paragraphs.forEach((text, index) => {
    const group = document.createElementNS(SVG_NS, 'g')
    group.setAttribute('data-p', String(index))
    const bands = arcLineSegments({
      pageWidth: 420,
      valleyWidth: 190,
      valleyDeg: 28,
      segments,
      spineAt: 'left',
    })
    const parts = splitLineBySegments(text, bands.length)
    parts.forEach((part) => {
      const node = document.createElementNS(SVG_NS, 'text')
      node.textContent = part
      group.appendChild(node)
    })
    svg.appendChild(group)
  })
  document.body.appendChild(svg)
}

/** 取某段第 n 个 <text> 里的文本节点。 */
function textNodeOf(paragraph: number, index: number): Text {
  const group = document.querySelector(`[data-p="${paragraph}"]`)!
  return group.querySelectorAll('text')[index]!.firstChild as Text
}

function select(startNode: Text, startOffset: number, endNode: Text, endOffset: number): void {
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

describe('弧面 SVG 分段与选区链路', () => {
  it('同段各 <text> 拼回去与原文完全一致，一个字都不丢', () => {
    mountArcPage(PARAS, 7)
    PARAS.forEach((text, index) => {
      const group = document.querySelector(`[data-p="${index}"]`)!
      const joined = [...group.querySelectorAll('text')].map((node) => node.textContent).join('')
      expect(joined).toBe(text)
    })
  })

  it('选区落在同段的不同 <text> 里：段内偏移按整段累计', () => {
    mountArcPage(PARAS, 5)
    // 选中第 1 段第 1 个片段的开头 → 第 3 个片段的首字
    const start = textNodeOf(0, 0)
    const end = textNodeOf(0, 2)
    select(start, 0, end, 1)
    const offsets = selectionRangeOffsets(window.getSelection(), STARTS, BODY)
    expect(offsets).not.toBeNull()
    expect(offsets!.start).toBe(0)
    // 前两个片段的长度之和 + 1
    const group = document.querySelector('[data-p="0"]')!
    const sizes = [...group.querySelectorAll('text')].map((node) => (node.textContent ?? '').length)
    expect(offsets!.end).toBe(sizes[0]! + sizes[1]! + 1)
    expect(offsets!.text).toBe(PARAS[0]!.slice(0, sizes[0]! + sizes[1]! + 1))
  })

  it('跨段的选区仍带上段落之间的空行', () => {
    mountArcPage(PARAS, 4)
    const start = textNodeOf(0, 0)
    const end = textNodeOf(1, 0)
    select(start, 0, end, 1)
    expect(selectionRangeOffsets(window.getSelection(), STARTS, BODY)).toEqual({
      start: 0,
      end: STARTS[1]! + 1,
      text: `${PARAS[0]!}\n\n${PARAS[1]!.slice(0, 1)}`,
    })
  })

  it('只选中单个片段的中间一小截也能算对', () => {
    mountArcPage(PARAS, 6)
    const node = textNodeOf(0, 3)
    select(node, 1, node, 3)
    const offsets = selectionRangeOffsets(window.getSelection(), STARTS, BODY)
    expect(offsets).not.toBeNull()
    const group = document.querySelector('[data-p="0"]')!
    const before = [...group.querySelectorAll('text')]
      .slice(0, 3)
      .reduce((sum, item) => sum + (item.textContent ?? '').length, 0)
    expect(offsets!.start).toBe(before + 1)
    expect(offsets!.end).toBe(before + 3)
  })

  it('折叠选区（只是光标）返回 null，不会误触发工具条', () => {
    mountArcPage(PARAS, 5)
    const node = textNodeOf(0, 1)
    select(node, 2, node, 2)
    expect(selectionRangeOffsets(window.getSelection(), STARTS, BODY)).toBeNull()
  })
})
