import { describe, expect, it } from 'vitest'
import { CLOTH_COLUMNS, CLOTH_ROWS, ClothSheet, flipClothField } from './realBookCloth'

const WIDTH = 6.4
const HEIGHT = 9.2

function field(progress: number, direction: 1 | -1 = 1) {
  return flipClothField({ width: WIDTH, height: HEIGHT, progress, direction })
}

function point(fieldValue: ReturnType<typeof field>, column: number, row: number): [number, number, number] {
  const offset = (row * fieldValue.columns + column) * 3
  return [fieldValue.positions[offset]!, fieldValue.positions[offset + 1]!, fieldValue.positions[offset + 2]!]
}

describe('flipClothField', () => {
  it('网格就是参考站的 40×8', () => {
    const value = field(0.5)
    expect(value.columns).toBe(CLOTH_COLUMNS)
    expect(value.rows).toBe(CLOTH_ROWS)
    expect(value.positions).toHaveLength(CLOTH_COLUMNS * CLOTH_ROWS * 3)
    expect(value.positions.every((n) => Number.isFinite(n))).toBe(true)
  })

  it('起手与落定都是平的：细节全部随包络收干净', () => {
    const start = field(0)
    for (let row = 0; row < start.rows; row += 1) {
      for (let column = 0; column < start.columns; column += 1) {
        expect(point(start, column, row)[2]).toBeCloseTo(0, 6)
      }
    }
    const end = field(1)
    for (let row = 0; row < end.rows; row += 1) {
      for (let column = 0; column < end.columns; column += 1) {
        expect(point(end, column, row)[2]).toBeCloseTo(0, 6)
      }
    }
  })

  it('起手时铺在右页上，落定时镜像到左页', () => {
    const start = field(0)
    const end = field(1)
    const last = CLOTH_COLUMNS - 1
    expect(point(start, 0, 0)[0]).toBeCloseTo(0, 6)
    expect(point(start, last, 0)[0]).toBeCloseTo(WIDTH, 5)
    expect(point(end, 0, 0)[0]).toBeCloseTo(0, 6)
    expect(point(end, last, 0)[0]).toBeCloseTo(-WIDTH, 5)
  })

  it('往回翻是同一段弧面的倒放，不是把 x 取反', () => {
    // 取反 x 会把贴图也镜像过去，落定时纸上的字是反的。
    // 倒放则让纸起手贴在左页、沿同一条弧落回右页。
    const backStart = field(0, -1)
    const backEnd = field(1, -1)
    const forwardEnd = field(1, 1)
    const forwardStart = field(0, 1)
    expect(point(backStart, CLOTH_COLUMNS - 1, 0)[0]).toBeCloseTo(-WIDTH, 5)
    expect(point(backEnd, CLOTH_COLUMNS - 1, 0)[0]).toBeCloseTo(WIDTH, 5)
    for (let row = 0; row < CLOTH_ROWS; row += 1) {
      for (let column = 0; column < CLOTH_COLUMNS; column += 1) {
        expect(point(backStart, column, row)).toEqual(point(forwardEnd, column, row))
      }
    }
    // 中途必须真的翻起来，而不是一条直线插值。
    const mid = field(0.5, -1)
    expect(point(mid, CLOTH_COLUMNS - 1, 0)[2]).toBeGreaterThan(1)
    expect(point(forwardStart, CLOTH_COLUMNS - 1, 0)[2]).toBeCloseTo(0, 6)
  })

  it('书脊那一列钉死在中缝上，不跟页高走', () => {
    const value = field(0.5)
    for (let row = 0; row < value.rows; row += 1) {
      const [x, , z] = point(value, 0, row)
      expect(x).toBeCloseTo(0, 6)
      expect(z).toBeCloseTo(0, 6)
    }
  })

  it('窄屏单页把飞页的中缝挪到页中心', () => {
    const value = flipClothField({ width: WIDTH, height: HEIGHT, progress: 0, direction: 1, singlePage: true })
    expect(point(value, 0, 0)[0]).toBeCloseTo(-WIDTH / 2, 6)
    expect(point(value, CLOTH_COLUMNS - 1, 0)[0]).toBeCloseTo(WIDTH / 2, 5)
  })

  it('二维细节让曲面不是直纹面：同一列上下两端不再平行', () => {
    const value = field(0.5)
    const last = CLOTH_COLUMNS - 1
    const bottom = point(value, last, 0)
    const middle = point(value, last, Math.floor(CLOTH_ROWS / 2))
    const top = point(value, last, CLOTH_ROWS - 1)
    // 页心比两个自由角更「顶」：中间鼓起来，两端垂下去。
    expect(middle[2] - bottom[2]).toBeGreaterThan(0.02)
    expect(middle[2] - top[2]).toBeGreaterThan(0.02)
    // 行波让上下两端不完全对称——这正是直纹面给不出的那一层。
    expect(Math.abs(bottom[2] - top[2])).toBeGreaterThan(0.001)
    expect(Math.abs(bottom[2] - top[2])).toBeLessThan(0.05)
  })
})

describe('ClothSheet', () => {
  it('重置后严格落在目标场上', () => {
    const sheet = new ClothSheet()
    const value = field(0.4)
    sheet.reset(value)
    for (let row = 0; row < CLOTH_ROWS; row += 1) {
      for (let column = 0; column < CLOTH_COLUMNS; column += 1) {
        const target = point(value, column, row)
        expect(sheet.pointAt(column, row)).toEqual(target)
      }
    }
  })

  it('目标不动时收敛回目标，不会自己漂', () => {
    const sheet = new ClothSheet()
    const value = field(0.4)
    sheet.reset(value)
    // 先给一点偏离，再看它是否被拉回来。
    sheet.step(field(0.55), 1 / 60)
    for (let index = 0; index < 90; index += 1) sheet.step(value, 1 / 60)
    for (let row = 0; row < CLOTH_ROWS; row += 1) {
      for (let column = 0; column < CLOTH_COLUMNS; column += 1) {
        const target = point(value, column, row)
        const current = sheet.pointAt(column, row)
        for (let axis = 0; axis < 3; axis += 1) expect(Math.abs(current[axis]! - target[axis]!)).toBeLessThan(0.005)
      }
    }
  })

  it('跟随时偏离有上限：纸会滞后，但不会被惯性拉出书体轮廓', () => {
    const sheet = new ClothSheet()
    sheet.reset(field(0))
    let worst = 0
    for (let index = 1; index <= 60; index += 1) {
      const value = field(index / 60)
      sheet.step(value, 1 / 60)
      for (let row = 0; row < CLOTH_ROWS; row += 1) {
        for (let column = 1; column < CLOTH_COLUMNS; column += 1) {
          const target = point(value, column, row)
          const current = sheet.pointAt(column, row)
          for (let axis = 0; axis < 3; axis += 1) {
            worst = Math.max(worst, Math.abs(current[axis]! - target[axis]!))
          }
        }
      }
    }
    expect(worst).toBeGreaterThan(0.001)
    expect(worst).toBeLessThan(0.1)
  })

  it('书脊侧全程钉死在目标上', () => {
    const sheet = new ClothSheet()
    sheet.reset(field(0))
    for (let index = 1; index <= 30; index += 1) {
      const value = field(index / 30)
      sheet.step(value, 1 / 60)
      for (let row = 0; row < CLOTH_ROWS; row += 1) {
        expect(sheet.pointAt(0, row)).toEqual(point(value, 0, row))
      }
    }
  })

  it('同样的输入得到同样的结果（固定子步，可测试）', () => {
    const a = new ClothSheet()
    const b = new ClothSheet()
    a.reset(field(0))
    b.reset(field(0))
    for (let index = 1; index <= 24; index += 1) {
      const value = field(index / 24)
      a.step(value, 1 / 60)
      b.step(value, 1 / 60)
    }
    for (let row = 0; row < CLOTH_ROWS; row += 1) {
      for (let column = 0; column < CLOTH_COLUMNS; column += 1) {
        expect(a.pointAt(column, row)).toEqual(b.pointAt(column, row))
      }
    }
  })

  it('双线性采样四个角落在网格点上', () => {
    const sheet = new ClothSheet()
    const value = field(0.3)
    sheet.reset(value)
    const out = new Float32Array(3)
    sheet.sampleInto(0, 0, out, 0)
    expect([out[0], out[1], out[2]]).toEqual(point(value, 0, 0))
    sheet.sampleInto(1, 1, out, 0)
    expect([out[0], out[1], out[2]]).toEqual(point(value, CLOTH_COLUMNS - 1, CLOTH_ROWS - 1))
    sheet.sampleInto(0.5, 0.5, out, 0)
    const middle = out.slice()
    expect(Number.isFinite(middle[0]) && Number.isFinite(middle[2])).toBe(true)
  })
})
