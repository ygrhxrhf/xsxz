import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PITCH_SENSITIVITY,
  FLAT_PITCH_DEG,
  MAX_PITCH_DEG,
  clampPitch,
  pitchFromDrag,
  pitchResetTarget,
  settlePitch,
} from './realBookPitch'

describe('realBookPitch（俯仰角纯计算）', () => {
  it('角度钳制在 0–35 度', () => {
    expect(clampPitch(-1)).toBe(0)
    expect(clampPitch(12)).toBe(12)
    expect(clampPitch(100)).toBe(MAX_PITCH_DEG)
    expect(clampPitch(Number.NaN)).toBe(FLAT_PITCH_DEG)
    expect(clampPitch(20, 10)).toBe(10)
  })

  it('竖向拖拽向下增加角度，向上减少角度', () => {
    const state = { startY: 100, startPitch: 10 }
    expect(pitchFromDrag(state, 200)).toBe(20)
    expect(pitchFromDrag(state, 0)).toBe(0)
  })

  it('拖拽灵敏度非法时回退默认值', () => {
    const state = { startY: 0, startPitch: 0 }
    expect(pitchFromDrag(state, 100, Number.NaN)).toBe(100 * DEFAULT_PITCH_SENSITIVITY)
    expect(pitchFromDrag(state, 100, -1)).toBe(100 * DEFAULT_PITCH_SENSITIVITY)
  })

  it('拖拽输出永远不越界', () => {
    const state = { startY: 0, startPitch: 30 }
    expect(pitchFromDrag(state, 1000)).toBe(MAX_PITCH_DEG)
    expect(pitchFromDrag(state, -1000)).toBe(0)
  })

  it('reduced-motion 只影响动画策略，不改变角度值', () => {
    expect(settlePitch(12, true)).toBe(12)
    expect(settlePitch(12, false)).toBe(12)
    expect(settlePitch(100, true)).toBe(MAX_PITCH_DEG)
  })

  it('平放复位目标是 0 度', () => {
    expect(pitchResetTarget()).toBe(FLAT_PITCH_DEG)
  })
})
