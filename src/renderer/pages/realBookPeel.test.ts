import { describe, expect, it } from 'vitest'
import {
  IDLE_FLUTTER_DELAY_MS,
  IDLE_FLUTTER_DURATION_S,
  IDLE_FLUTTER_STRENGTH,
  PEEL_MAX_LIFT,
  idleFlutterAmount,
  pageCornerPeel,
} from './realBookPeel'

describe('pageCornerPeel', () => {
  it('强度为 0 时纸面不动', () => {
    expect(pageCornerPeel(1, 0.5, { amount: 0, corner: 1, outerAtU1: true }))
      .toEqual({ x: 0, y: 0, z: 0 })
  })

  it('页心与外口中部没有位移，只有外角会翘', () => {
    expect(pageCornerPeel(0.5, 0, { amount: 1, corner: 1, outerAtU1: true }).z).toBe(0)
    expect(pageCornerPeel(1, 0, { amount: 1, corner: 1, outerAtU1: true }).z).toBe(0)
    expect(pageCornerPeel(1, 0.5, { amount: 1, corner: 1, outerAtU1: true }).z).toBeGreaterThan(0)
  })

  it('抬起高度不超过上限，并向书脊与页心各收一点', () => {
    const right = pageCornerPeel(1, 0.5, { amount: 1, corner: 1, outerAtU1: true })
    expect(right.z).toBeLessThanOrEqual(PEEL_MAX_LIFT + 1e-9)
    expect(right.z).toBeGreaterThan(PEEL_MAX_LIFT * 0.8)
    // 右页外口在 u=1，向书脊收是 -x；上角向页心收是 -y。
    expect(right.x).toBeLessThan(0)
    expect(right.y).toBeLessThan(0)
    const left = pageCornerPeel(0, -0.5, { amount: 1, corner: -1, outerAtU1: false })
    // 左页外口在 u=0，向书脊收是 +x；下角向页心收是 +y。
    expect(left.x).toBeGreaterThan(0)
    expect(left.y).toBeGreaterThan(0)
  })

  it('空闲飘动：延迟前为 0，一轮结束回到 0，幅度不超过上限', () => {
    expect(idleFlutterAmount(0)).toBe(0)
    expect(idleFlutterAmount(IDLE_FLUTTER_DELAY_MS)).toBe(0)
    const mid = IDLE_FLUTTER_DELAY_MS + (IDLE_FLUTTER_DURATION_S * 1000) / 2
    expect(idleFlutterAmount(mid)).toBeGreaterThan(0)
    expect(idleFlutterAmount(mid)).toBeLessThanOrEqual(IDLE_FLUTTER_STRENGTH)
    expect(idleFlutterAmount(IDLE_FLUTTER_DELAY_MS + IDLE_FLUTTER_DURATION_S * 1000 + 1)).toBe(0)
  })

  it('只掀被指到的那只角', () => {
    const top = pageCornerPeel(1, 0.5, { amount: 1, corner: 1, outerAtU1: true })
    const bottom = pageCornerPeel(1, -0.5, { amount: 1, corner: 1, outerAtU1: true })
    expect(top.z).toBeGreaterThan(0)
    expect(bottom.z).toBe(0)
    expect(pageCornerPeel(1, -0.5, { amount: 1, corner: -1, outerAtU1: true }).z).toBeGreaterThan(0)
  })
})
