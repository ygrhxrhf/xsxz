import { describe, expect, it } from 'vitest'
import { highlightRects, homographyFromQuad, noteDots, quadToMatrix3d, type PageScreenQuad } from './realBookTextLayer'
import type { PageTextureLine } from './realBookTexture'

const SRC: PageScreenQuad = [
  { x: 0, y: 0 },
  { x: 640, y: 0 },
  { x: 640, y: 920 },
  { x: 0, y: 920 },
]
const DST: PageScreenQuad = [
  { x: 120, y: 80 },
  { x: 760, y: 120 },
  { x: 780, y: 700 },
  { x: 90, y: 660 },
]

function apply(h: number[], x: number, y: number): { x: number; y: number } {
  const [h00, h01, h02, h10, h11, h12, h20, h21, h22] = h
  const w = h20 * x + h21 * y + h22
  return {
    x: (h00 * x + h01 * y + h02) / w,
    y: (h10 * x + h11 * y + h12) / w,
  }
}

describe('realBookTextLayer', () => {
  it('由 4 个页角解出单应，并把源四角投到目标四角', () => {
    const h = homographyFromQuad(SRC, DST)
    expect(h).not.toBeNull()
    for (let i = 0; i < 4; i += 1) {
      const point = apply(h!, SRC[i]!.x, SRC[i]!.y)
      expect(point.x).toBeCloseTo(DST[i]!.x, 6)
      expect(point.y).toBeCloseTo(DST[i]!.y, 6)
    }
  })

  it('quadToMatrix3d 输出 16 个分量的 CSS 3D 矩阵', () => {
    const matrix = quadToMatrix3d(SRC, DST)
    expect(matrix.startsWith('matrix3d(')).toBe(true)
    expect(matrix.slice(9, -1).split(',')).toHaveLength(16)
  })

  it('共线点回退到单位矩阵', () => {
    const bad: PageScreenQuad = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]
    expect(quadToMatrix3d(SRC, bad)).toBe('matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)')
  })
})

/** 固定字宽 20px/字，几何断言不依赖 canvas。 */
const measure = (text: string): number => text.length * 20

function line(partial: Partial<PageTextureLine> = {}): PageTextureLine {
  return {
    text: '一二三四五六',
    start: 0,
    end: 6,
    paragraphIndex: 0,
    x: 100,
    y: 200,
    height: 33,
    firstLine: true,
    continued: false,
    marks: [],
    noteMarks: [],
    ...partial,
  }
}

describe('highlightRects', () => {
  it('按字符区间量出底色块，左右各外扩 1px、纵向取行盒的 18%–92%', () => {
    const rects = highlightRects([line({
      marks: [
        { start: 1, end: 3, color: 'rgba(240,185,90,0.34)' },
        { start: 4, end: 6, color: 'rgba(206,82,82,0.3)' },
      ],
    })], measure)
    expect(rects).toHaveLength(2)
    expect(rects[0]!.x).toBeCloseTo(100 + 20 - 1)
    expect(rects[0]!.width).toBeCloseTo(40 + 2)
    expect(rects[0]!.y).toBeCloseTo(200 + 33 * 0.18)
    expect(rects[0]!.height).toBeCloseTo(33 * 0.74)
    expect(rects[0]!.color).toBe('rgba(240,185,90,0.34)')
    expect(rects[1]!.x).toBeCloseTo(100 + 80 - 1)
    expect(rects[1]!.color).toBe('rgba(206,82,82,0.3)')
  })

  it('没有划线时不给空盒子', () => {
    expect(highlightRects([line()], measure)).toEqual([])
  })
})

describe('noteDots', () => {
  it('「注」点落在锚点后的字缝里，圆心在基线上方 0.28em', () => {
    const dots = noteDots([line({ noteMarks: [2, 5] })], 22, measure)
    expect(dots).toHaveLength(2)
    expect(dots[0]!.x).toBeCloseTo(100 + 40 + 22 * 0.34)
    expect(dots[0]!.y).toBeCloseTo(200 + 33 * 0.76 - 22 * 0.28)
    expect(dots[0]!.diameter).toBeCloseTo(22 * 0.18 * 2)
    expect(dots[0]!.fontSize).toBeCloseTo(Math.max(5, 22 * 0.22))
    expect(dots[1]!.x).toBeCloseTo(100 + 100 + 22 * 0.34)
  })
})
