import { describe, expect, it } from 'vitest'
import {
  MAX_SPINE_LAYERS,
  SPINE_LAYER_DEPTH_PX,
  SPINE_LAYER_SPACING_PX,
  spineLayers,
  spineStack,
} from './realBookSpine'

/**
 * 书厚伪页的纯计算：比例 → 层数、层数 → 逐层偏移。
 * 这两条规则决定 E3（书厚层次）能不能对上阅读进度，所以用单测钉住边界。
 */

describe('spineStack（整本规模 + 全书进度 → 连续纸垛厚度）', () => {
  it('正文规模不同会得到不同基础厚度', () => {
    expect(spineStack(10_000, 0.5).total).toBeLessThan(spineStack(1_000_000, 0.5).total)
  })

  it('全书进度在左右两侧连续转移', () => {
    const start = spineStack(500_000, 0)
    const middle = spineStack(500_000, 0.5)
    const end = spineStack(500_000, 1)
    expect(start.read).toBe(0)
    expect(end.remaining).toBe(0)
    expect(middle.read).toBeCloseTo(middle.remaining, 8)
    expect(start.total).toBe(end.total)
  })

  it('进度越界与非法正文规模都被钳制', () => {
    expect(spineStack(Number.NaN, -1).read).toBe(0)
    expect(spineStack(Number.NaN, 2).remaining).toBe(0)
  })

  it('已读厚度随全书进度单调不减', () => {
    let previous = -1
    for (let ratio = 0; ratio <= 1.0001; ratio += 0.05) {
      const stack = spineStack(500_000, ratio)
      expect(stack.read).toBeGreaterThanOrEqual(previous)
      previous = stack.read
    }
  })

  it('上限可覆盖且总厚度不超出上限', () => {
    expect(spineStack(10_000_000, 0.5, 6).total).toBe(6)
    expect(spineStack(10_000_000, 0.5, 0).total).toBe(MAX_SPINE_LAYERS)
  })
})

describe('spineLayers（层数 → 逐层偏移）', () => {
  it('逐层向外偏移，纵深向后，透明度不低于下限', () => {
    const layers = spineLayers(3, { direction: 1 })
    expect(layers).toHaveLength(3)
    expect(layers.map((layer) => layer.translateY)).toEqual([
      SPINE_LAYER_SPACING_PX,
      SPINE_LAYER_SPACING_PX * 2,
      SPINE_LAYER_SPACING_PX * 3,
    ])
    expect(layers.map((layer) => layer.translateZ)).toEqual([
      -SPINE_LAYER_DEPTH_PX,
      -SPINE_LAYER_DEPTH_PX * 2,
      -SPINE_LAYER_DEPTH_PX * 3,
    ])
    for (const layer of layers) expect(layer.opacity).toBeGreaterThanOrEqual(0.55)
  })

  it('已读侧方向为负（向上），剩余侧为正（向下）', () => {
    expect(spineLayers(2, { direction: -1 })[0]!.translateY).toBe(-SPINE_LAYER_SPACING_PX)
    expect(spineLayers(2, { direction: 1 })[0]!.translateY).toBe(SPINE_LAYER_SPACING_PX)
  })

  it('层数被上限截断：传 99 也只给 8 层', () => {
    expect(spineLayers(99)).toHaveLength(MAX_SPINE_LAYERS)
  })

  it('非法层数给空数组，不抛异常', () => {
    expect(spineLayers(0)).toEqual([])
    expect(spineLayers(-5)).toEqual([])
    expect(spineLayers(Number.NaN)).toEqual([])
  })

  it('间距与纵深可覆盖，非法值回退默认', () => {
    expect(spineLayers(1, { spacing: 4 })[0]!.translateY).toBe(4)
    expect(spineLayers(1, { spacing: -1 })[0]!.translateY).toBe(SPINE_LAYER_SPACING_PX)
    expect(spineLayers(1, { depth: 3 })[0]!.translateZ).toBe(-3)
    expect(spineLayers(1, { depth: 0 })[0]!.translateZ).toBe(-SPINE_LAYER_DEPTH_PX)
  })
})
