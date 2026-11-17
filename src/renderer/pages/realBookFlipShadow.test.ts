import { describe, expect, it } from 'vitest'
import { buildFlipShadow, FLIP_SHADOW_DENSITY, rasterizeFlipShadow, sampleFlipShadowGrid } from './realBookFlipShadow'

const COLUMNS = 40
const ROWS = 26

/** 一张平躺的纸：x∈[-W/2,W/2]、y∈[-H/2,H/2]，整张同一个 z。 */
function flatCloth(z = 0, width = 6.4, height = 9.2): Float32Array {
  const out = new Float32Array(COLUMNS * ROWS * 3)
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLUMNS; col += 1) {
      const index = (row * COLUMNS + col) * 3
      out[index] = -width / 2 + (col / (COLUMNS - 1)) * width
      out[index + 1] = -height / 2 + (row / (ROWS - 1)) * height
      out[index + 2] = z
    }
  }
  return out
}

const base = {
  columns: COLUMNS,
  rows: ROWS,
  scaleY: 1,
  zOffset: 0.105,
  pageZ: 0.1,
  shadowZ: 0.13,
}

describe('buildFlipShadow', () => {
  it('影子落在纸面上方一张平纸上，中间深、书脊与四角浅', () => {
    const mesh = buildFlipShadow({ ...base, cloth: flatCloth(), progress: 0.5 })
    expect(mesh.positions).toHaveLength(COLUMNS * ROWS * 3)
    expect(mesh.alpha).toHaveLength(COLUMNS * ROWS)
    for (let index = 2; index < mesh.positions.length; index += 3) {
      expect(mesh.positions[index]).toBeCloseTo(0.13, 6)
    }
    const center = (Math.floor(ROWS / 2) * COLUMNS + Math.floor(COLUMNS / 2))
    // 离纸 0.005：高度衰减只剩 0.991。
    expect(mesh.alpha[center]).toBeCloseTo(FLIP_SHADOW_DENSITY * 0.991, 2)
    // 书脊侧（u=0）贴在桌面上：影子必须收干净。
    expect(mesh.alpha[Math.floor(ROWS / 2) * COLUMNS]).toBe(0)
    // 四个角是边缘，往轮廓外 fading 到低值。
    expect(mesh.alpha[0]).toBeLessThan(FLIP_SHADOW_DENSITY * 0.25)
  })

  it('纸升得越高：影子横移更多、变淡、半影更宽', () => {
    const low = buildFlipShadow({ ...base, cloth: flatCloth(), progress: 0.5 })
    const high = buildFlipShadow({ ...base, cloth: flatCloth(0.12), progress: 0.5 })
    const center = (Math.floor(ROWS / 2) * COLUMNS + Math.floor(COLUMNS / 2))
    const last = (Math.floor(ROWS / 2) * COLUMNS + (COLUMNS - 1))
    expect(high.alpha[center]).toBeLessThan(low.alpha[center]!)
    // 光从左前方来：抬得越高，影子越往 +x、−y 偏。
    expect(high.positions[(Math.floor(ROWS / 2) * COLUMNS + COLUMNS - 1) * 3]!)
      .toBeGreaterThan(low.positions[last * 3]!)
    // 半影随高度变宽：右下角投影面积更大。
    const corner = (ROWS - 1) * COLUMNS + (COLUMNS - 1)
    expect(Math.abs(high.positions[corner * 3]!)).toBeGreaterThan(Math.abs(low.positions[corner * 3]!))
  })

  it('起翻与落定两帧影子透明，不会在静止页上留一层灰', () => {
    for (const progress of [0, 1]) {
      const mesh = buildFlipShadow({ ...base, cloth: flatCloth(), progress })
      expect(mesh.alpha.every((value) => value === 0)).toBe(true)
    }
    const invalid = buildFlipShadow({ ...base, cloth: flatCloth(), progress: Number.NaN })
    expect(invalid.alpha.every((value) => value === 0)).toBe(true)
  })
})
describe('影子覆盖率栅格', () => {
  const bounds = { columns: 8, rows: 8, minX: -2, maxX: 2, minY: -2, maxY: 2 }

  it('把影子顶点落进格子，采样回原位置附近的透明度', () => {
    // 一个覆盖 x∈[-1,1]、y∈[-1,1] 的矩形影子，透明度 0.3。
    const positions: number[] = []
    const alpha: number[] = []
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        positions.push(-1 + (col / 4) * 2, -1 + (row / 4) * 2, 0.13)
        alpha.push(0.3)
      }
    }
    const grid = rasterizeFlipShadow(positions, alpha, bounds)
    expect(sampleFlipShadowGrid(grid, 0, 0)).toBeCloseTo(0.3, 6)
    expect(sampleFlipShadowGrid(grid, 0.6, -0.4)).toBeGreaterThan(0.1)
    expect(sampleFlipShadowGrid(grid, 1.8, 1.8)).toBe(0)
    expect(sampleFlipShadowGrid(grid, 3, 0)).toBe(0)
  })

  it('多张纸的影子同格取最大值，不会叠加成更黑', () => {
    const positions: number[] = []
    const alpha: number[] = []
    for (const [value, shift] of [[0.2, 0], [0.34, 0.05]] as const) {
      for (let row = 0; row < 5; row += 1) {
        for (let col = 0; col < 5; col += 1) {
          positions.push(-1 + (col / 4) * 2 + shift, -1 + (row / 4) * 2 + shift, 0.13)
          alpha.push(value)
        }
      }
    }
    const grid = rasterizeFlipShadow(positions, alpha, bounds)
    const value = sampleFlipShadowGrid(grid, 0, 0)
    expect(value).toBeGreaterThan(0.3)
    expect(value).toBeLessThanOrEqual(0.341)
  })

  it('空影子网格采样为零', () => {
    const grid = rasterizeFlipShadow([], [], bounds)
    expect(sampleFlipShadowGrid(grid, 0, 0)).toBe(0)
  })
})
