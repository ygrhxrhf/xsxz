// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { selectionRangeOffsets } from './readerSelection'

/**
 * 纯函数的 jsdom 单测：不挂载组件，所以没有「重渲染把选区折叠掉」的问题。
 * 段落夹具与真实渲染一致：段落里可能有多个文本节点（mark/模板片段）。
 */
const PARAS = ['第一段文字。', '第二段文字。']
/** 规范化正文：段落以空行连接（与 Reader 的 normalizedBody 同构） */
const BODY = PARAS.join('\n\n')
const STARTS = [0, PARAS[0]!.length + 2]

function mountParagraphs(html?: string): void {
  document.body.innerHTML = html ?? PARAS.map((text, index) => `<p data-p="${index}">${text}</p>`).join('')
}

function select(fromP: number, fromOff: number, toP: number, toOff: number): void {
  const startP = document.querySelector(`[data-p="${fromP}"]`)!
  const endP = document.querySelector(`[data-p="${toP}"]`)!
  const range = document.createRange()
  range.setStart(startP.firstChild as Text, fromOff)
  range.setEnd(endP.firstChild as Text, toOff)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

describe('selectionRangeOffsets（选区 → 规范化坐标）', () => {
  it('同一段里的部分选区', () => {
    mountParagraphs()
    select(0, 0, 0, 3)
    expect(selectionRangeOffsets(window.getSelection(), STARTS, BODY)).toEqual({
      start: 0, end: 3, text: '第一段',
    })
  })

  it('跨段选区带上段落之间的空行', () => {
    mountParagraphs()
    select(0, 0, 1, 3)
    expect(selectionRangeOffsets(window.getSelection(), STARTS, BODY)).toEqual({
      start: 0, end: STARTS[1]! + 3, text: '第一段文字。\n\n第二段',
    })
  })

  it('没有选区、折叠选区、只选中空白，都返回 null', () => {
    mountParagraphs()
    expect(selectionRangeOffsets(window.getSelection(), STARTS, BODY)).toBeNull()

    select(0, 2, 0, 2)
    expect(selectionRangeOffsets(window.getSelection(), STARTS, BODY)).toBeNull()

    document.body.innerHTML = '<p data-p="0">   </p>'
    const range = document.createRange()
    range.setStart(document.querySelector('[data-p="0"]')!.firstChild as Text, 0)
    range.setEnd(document.querySelector('[data-p="0"]')!.firstChild as Text, 3)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(selectionRangeOffsets(window.getSelection(), [0], '   ')).toBeNull()
  })

  it('选区落在正文之外的节点上（比如标题）返回 null', () => {
    mountParagraphs('<h3>第一章</h3><p data-p="0">第一段文字。</p>')
    const heading = document.querySelector('h3')!
    const range = document.createRange()
    range.setStart(heading.firstChild as Text, 0)
    range.setEnd(heading.firstChild as Text, 2)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(selectionRangeOffsets(window.getSelection(), STARTS, BODY)).toBeNull()
  })

  it('段落里有多个文本节点时偏移按整段累计（mark/模板片段的真实结构）', () => {
    mountParagraphs('<p data-p="0">前<span>中</span>后</p><p data-p="1">第二段文字。</p>')
    // 第三个文本节点（"后"）里的第 1 个字符 = 整段第 3 个字符
    const para = document.querySelector('[data-p="0"]')!
    const last = para.lastChild as Text
    const range = document.createRange()
    range.setStart(last, 0)
    range.setEnd(last, 1)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(selectionRangeOffsets(window.getSelection(), [0, 5], '前中后\n\n第二段文字。')).toEqual({
      start: 2, end: 3, text: '后',
    })
  })

  it('段落下标表缺项时按 0 兜底，不抛错', () => {
    mountParagraphs()
    select(0, 1, 0, 3)
    expect(selectionRangeOffsets(window.getSelection(), [], BODY)).toEqual({
      start: 1, end: 3, text: '一段',
    })
  })
})
