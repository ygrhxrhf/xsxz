import { describe, expect, it } from 'vitest'
import { crossSelectionBoxes, orderSelection, type CrossSelectionLine } from './realBookCrossSelection'

const measure = (text: string): number => text.length * 10

const lines: CrossSelectionLine[] = [
  { paragraphIndex: 4, start: 0, end: 20, text: '零一二三四五六七八九十一二三四五六七八九', x: 80, y: 100, height: 33 },
  { paragraphIndex: 4, start: 20, end: 40, text: '二十一二三四五六七八九十一二三四五六七八', x: 80, y: 133, height: 33 },
  { paragraphIndex: 5, start: 0, end: 20, text: '丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙丙', x: 80, y: 166, height: 33 },
  { paragraphIndex: 5, start: 20, end: 40, text: '丁丁丁丁丁丁丁丁丁丁丁丁丁丁丁丁丁丁丁丁', x: 80, y: 199, height: 33 },
]

describe('orderSelection', () => {
  it('正选与反选都排成从前往后', () => {
    expect(orderSelection({ paragraph: 1, offset: 5 }, { paragraph: 3, offset: 2 }))
      .toEqual([{ paragraph: 1, offset: 5 }, { paragraph: 3, offset: 2 }])
    expect(orderSelection({ paragraph: 3, offset: 2 }, { paragraph: 1, offset: 5 }))
      .toEqual([{ paragraph: 1, offset: 5 }, { paragraph: 3, offset: 2 }])
    expect(orderSelection({ paragraph: 2, offset: 9 }, { paragraph: 2, offset: 3 }))
      .toEqual([{ paragraph: 2, offset: 3 }, { paragraph: 2, offset: 9 }])
  })
})

describe('crossSelectionBoxes', () => {
  it('首行从选区起点开始、末行到终点结束，中间整行高亮', () => {
    const boxes = crossSelectionBoxes(lines, { paragraph: 4, offset: 5 }, { paragraph: 5, offset: 12 }, measure)
    expect(boxes).toHaveLength(3)
    // 首行：偏移 5 → 行尾 20，左边 80 + 5×10，宽 15×10。
    expect(boxes[0]).toMatchObject({ left: 130, top: 100, width: 150, height: 33 })
    // 第二行整行。
    expect(boxes[1]).toMatchObject({ left: 80, top: 133, width: 200 })
    // 末行：0 → 12。
    expect(boxes[2]).toMatchObject({ left: 80, top: 166, width: 120 })
  })

  it('只覆盖段落在选区内的行，范围外的段落不画', () => {
    const boxes = crossSelectionBoxes(lines, { paragraph: 5, offset: 0 }, { paragraph: 5, offset: 1 }, measure)
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).toMatchObject({ left: 80, top: 166, width: 10 })
  })

  it('反选与正选得到同一组盒子', () => {
    const forward = crossSelectionBoxes(lines, { paragraph: 4, offset: 5 }, { paragraph: 5, offset: 12 }, measure)
    const backward = crossSelectionBoxes(lines, { paragraph: 5, offset: 12 }, { paragraph: 4, offset: 5 }, measure)
    expect(backward).toEqual(forward)
  })
})
