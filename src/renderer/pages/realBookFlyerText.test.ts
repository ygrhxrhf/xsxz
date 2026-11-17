import { describe, expect, it } from 'vitest'
import { FLYER_PIECE_MAX_CHARS, flyerFacePages, flyerPieceMatrix, splitFlyerLine } from './realBookFlyerText'

/** 固定字宽：每个字 20px，方便断言切段位置。 */
const measure = (text: string): number => text.length * 20

const line = {
  text: '一二三四五六七八九十一二三四五六',
  x: 100,
  y: 200,
  height: 33,
  paragraphIndex: 4,
  start: 7,
}

describe('splitFlyerLine', () => {
  it('按宽度把一行切成连续的小段，字不重不漏', () => {
    const pieces = splitFlyerLine(line, measure, { maxWidth: 100 })
    expect(pieces.map((piece) => piece.text).join('')).toBe(line.text)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) {
      expect(piece.width).toBe(piece.text.length * 20)
      expect(piece.width).toBeLessThanOrEqual(100)
      expect(piece.height).toBe(line.height)
      expect(piece.y).toBe(line.y)
      expect(piece.paragraphIndex).toBe(4)
    }
    // 每段的 x 由前面所有字的累计宽度给出，贴回原行时首尾相接。
    let offset = 0
    for (const piece of pieces) {
      expect(piece.x).toBe(line.x + offset)
      expect(piece.start).toBe(line.start + offset / 20)
      offset += piece.width
    }
    expect(offset).toBe(line.text.length * 20)
  })

  it('段数受字数上限约束，单字再宽也不会被丢掉', () => {
    const pieces = splitFlyerLine({ ...line, text: '一二三四五六七八' }, measure, { maxChars: 3 })
    expect(pieces.map((piece) => piece.text)).toEqual(['一二三', '四五六', '七八'])
    expect(pieces.length).toBe(3)
    expect(FLYER_PIECE_MAX_CHARS).toBeGreaterThan(3)

    const wide = splitFlyerLine(
      { ...line, text: '一二' },
      (text) => text.length * 500,
      { maxWidth: 100 },
    )
    expect(wide.map((piece) => piece.text)).toEqual(['一', '二'])
  })

  it('空行不产生片段', () => {
    expect(splitFlyerLine({ ...line, text: '' }, measure)).toEqual([])
  })
})

describe('flyerFacePages', () => {
  it('往后翻：正面印右页、纸背印落下的左页', () => {
    const faces = flyerFacePages(1, 'right-page', 'left-page')
    expect(faces[0]).toEqual({ face: 1, page: 'right-page', side: 'right' })
    expect(faces[1]).toEqual({ face: -1, page: 'left-page', side: 'left' })
  })

  it('往回翻：弧是倒放的，起手朝上的纸背印这一页本身', () => {
    const faces = flyerFacePages(-1, 'left-page', 'right-page')
    expect(faces[0]).toEqual({ face: 1, page: 'right-page', side: 'right' })
    expect(faces[1]).toEqual({ face: -1, page: 'left-page', side: 'left' })
  })
})

describe('flyerPieceMatrix', () => {
  /** 读出 matrix3d 的线性部分与平移，按 CSS 列主序还原。 */
  function parse(transform: string): { m00: number; m10: number; m01: number; m11: number; tx: number; ty: number } {
    const values = transform.slice('matrix3d('.length, -1).split(',').map(Number)
    return { m00: values[0]!, m10: values[1]!, m01: values[4]!, m11: values[5]!, tx: values[12]!, ty: values[13]! }
  }

  it('把片段的三个角映射到给定的屏幕位置', () => {
    const origin = { x: 300, y: 400 }
    const xEdge = { x: 380, y: 396 }
    const yEdge = { x: 304, y: 432 }
    const transform = flyerPieceMatrix(origin, xEdge, yEdge, 80, 32)
    expect(transform).not.toBeNull()
    const { m00, m10, m01, m11, tx, ty } = parse(transform!)
    const map = (x: number, y: number): { x: number; y: number } => ({
      x: m00 * x + m01 * y + tx,
      y: m10 * x + m11 * y + ty,
    })
    expect(map(0, 0)).toEqual({ x: origin.x, y: origin.y })
    expect(map(80, 0).x).toBeCloseTo(xEdge.x, 6)
    expect(map(80, 0).y).toBeCloseTo(xEdge.y, 6)
    expect(map(0, 32).x).toBeCloseTo(yEdge.x, 6)
    expect(map(0, 32).y).toBeCloseTo(yEdge.y, 6)
  })

  it('纸面侧成一条线或尺寸失效时不画', () => {
    const origin = { x: 10, y: 10 }
    expect(flyerPieceMatrix(origin, { x: 90, y: 10 }, { x: 10, y: 10 }, 80, 0)).toBeNull()
    expect(flyerPieceMatrix(origin, { x: 90, y: 10 }, { x: 10, y: 10 }, 0, 32)).toBeNull()
    // 三个点共线：投影面积为零。
    expect(flyerPieceMatrix(origin, { x: 90, y: 10 }, { x: 50, y: 10 }, 80, 32)).toBeNull()
    expect(flyerPieceMatrix(origin, { x: Number.NaN, y: 10 }, { x: 10, y: 42 }, 80, 32)).toBeNull()
  })
})
