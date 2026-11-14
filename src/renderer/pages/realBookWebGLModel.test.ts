import { describe, expect, it } from 'vitest'
import {
  BOOK_HEIGHT,
  BOOK_WIDTH,
  DEFAULT_TILT_RAD,
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  bookOffsetX,
  bookThickness,
  cameraPose,
  degreesToTilt,
  fitDistance,
  spreadPages,
} from './realBookWebGLModel'

describe('realBookWebGLModel', () => {
  it('按双页开本和 24° FOV 计算适配距离', () => {
    const distance = fitDistance(1.6)
    expect(distance).toBeGreaterThan(28)
    expect(distance).toBeLessThan(32)
    expect(fitDistance(0.8)).toBeGreaterThan(distance)
  })

  it('相机从俯视方向看向书本中心，tilt 为默认 25°', () => {
    const pose = cameraPose(DEFAULT_TILT_RAD, 1, 0, 0, 1.6)
    expect(pose.position[0]).toBe(0)
    expect(pose.position[1]).toBeLessThan(0)
    expect(pose.position[2]).toBeGreaterThan(0)
    expect(pose.lookAt).toEqual([0, 0, 0])
  })

  it('开本常量与参考站一致', () => {
    expect(BOOK_WIDTH).toBe(6.4)
    expect(BOOK_HEIGHT).toBe(9.2)
  })

  it('默认缩放与范围对齐参考站', () => {
    expect(DEFAULT_ZOOM).toBe(0.9)
    expect(MIN_ZOOM).toBe(0.12)
    expect(MAX_ZOOM).toBe(7)
  })

  it('相机距离是 fitDistance / zoom，不再额外乘 1.1', () => {
    const aspect = 1.6
    const pose = cameraPose(DEFAULT_TILT_RAD, DEFAULT_ZOOM, 0, 0, aspect)
    const distance = Math.hypot(pose.position[1], pose.position[2])
    expect(distance).toBeCloseTo(fitDistance(aspect) / DEFAULT_ZOOM, 5)
  })

  it('页数与进度决定左右纸垛厚度，总厚度保持稳定', () => {
    const half = bookThickness(8, 0, 0.5)
    expect(half.total).toBeCloseTo(0.14, 5)
    expect(half.leaf).toBeCloseTo(0.0175, 5)
    expect(half.left).toBeCloseTo(half.right, 5)
    expect(half.hingeZ).toBeCloseTo(0.18, 5)

    const later = bookThickness(8, 0, 0.75)
    expect(later.total).toBeCloseTo(half.total, 5)
    expect(later.left).toBeGreaterThan(later.right)
  })

  it('合上时整本书向书脊中心平移，打开时回零', () => {
    expect(bookOffsetX(1, 0.18)).toBeCloseTo(0, 8)
    expect(bookOffsetX(0, 0.18)).toBeCloseTo(-(BOOK_WIDTH / 2 + 0.018), 5)
  })

  it('双页窗口左页是当前页，右页是下一页', () => {
    expect(spreadPages(0)).toEqual({ left: 0, right: 1 })
    expect(spreadPages(7)).toEqual({ left: 7, right: 8 })
  })

  it('视角度数在目标范围内换算为弧度', () => {
    expect(degreesToTilt(25)).toBeCloseTo(25 * Math.PI / 180, 5)
    expect(degreesToTilt(999)).toBeCloseTo(1.08, 5)
    expect(degreesToTilt(-10)).toBeCloseTo(0.02, 5)
  })
})
