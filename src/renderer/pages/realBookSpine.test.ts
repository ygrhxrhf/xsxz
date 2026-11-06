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

describe('spineStack（阅读进度 → 上下纸堆层数）', () => {
  it('章首全部压在下侧（剩余），章末全部叠到上侧（已读）', () => {
    expect(spineStack(0)).toEqual({ read: 0, remaining: MAX_SPINE_LAYERS })
    expect(spineStack(1)).toEqual({ read: MAX_SPINE_LAYERS, remaining: 0 })
  })

  it('比例居中时两侧对半分', () => {
    expect(spineStack(0.5)).toEqual({ read: 4, remaining: 4 })
  })

  it('总层数恒等于上限，不随比例变化', () => {
    for (const ratio of [0, 0.13, 0.37, 0.62, 0.88, 1]) {
      const stack = spineStack(ratio)
      expect(stack.read + stack.remaining).toBe(MAX_SPINE_LAYERS)
      expect(stack.read).toBeGreaterThanOrEqual(0)
      expect(stack.remaining).toBeGreaterThanOrEqual(0)
    }
  })

  it('比例越界与非数值都被钳制', () => {
    expect(spineStack(-1)).toEqual({ read: 0, remaining: MAX_SPINE_LAYERS })
    expect(spineStack(2)).toEqual({ read: MAX_SPINE_LAYERS, remaining: 0 })
    expect(spineStack(Number.NaN)).toEqual({ read: 0, remaining: MAX_SPINE_LAYERS })
    expect(spineStack(Number.POSITIVE_INFINITY)).toEqual({ read: 0, remaining: MAX_SPINE_LAYERS })
  })

  it('已读层数随比例单调不减', () => {
    let previous = -1
    for (let ratio = 0; ratio <= 1.0001; ratio += 0.05) {
      const stack = spineStack(ratio)
      expect(stack.read).toBeGreaterThanOrEqual(previous)
      previous = stack.read
    }
  })

  it('上限可覆盖，且非法上限回退默认值', () => {
    expect(spineStack(0.5, 4)).toEqual({ read: 2, remaining: 2 })
    expect(spineStack(0.5, 0)).toEqual({ read: 4, remaining: 4 })
    expect(spineStack(0.5, Number.NaN)).toEqual({ read: 4, remaining: 4 })
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
