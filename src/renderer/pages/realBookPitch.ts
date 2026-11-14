/**
 * 真实书籍俯仰的纯计算层。
 *
 * 俯仰角是会话内视觉状态，不参与分页签名、不落盘；这里仅负责把拖拽位移映射为
 * 安全的缓角，并提供回弹所需的目标值。把这部分抽出来可直接测试边界，不依赖 DOM。
 */

/** CSS 3D 回退的俯仰上限：缓角，避免 DOM 正文严重模糊或亚像素抖动。 */
export const MAX_PITCH_DEG = 35
/** WebGL 复刻的俯仰上限：参考站 1.08rad ≈ 61.9°。 */
export const MAX_TILT_DEG = 62
/** 平放角。 */
export const FLAT_PITCH_DEG = 0
/**
 * CSS 3D 回退的默认俯仰角。
 *
 * 平放时页面正对观者，纸垛只剩页脚一道纸边、落地投影也被压成一条线，书读不出厚度；
 * 18° 是「书厚与投影都看得清」和「正文还没被透视压扁」之间的折中。
 */
export const DEFAULT_PITCH_DEG = 18
/** WebGL 复刻的默认俯仰角：参考站 0.44rad ≈ 25°。 */
export const DEFAULT_TILT_DEG = 25
/** CSS 3D 默认拖拽灵敏度：每 10px 竖向位移改变 1 度。 */
export const DEFAULT_PITCH_SENSITIVITY = 0.1
/** WebGL 灵敏度：拖 330px 走完 0–62° 全量程。 */
export const TILT_SENSITIVITY = MAX_TILT_DEG / 330

export interface PitchDragState {
  startY: number
  startPitch: number
}

export function clampPitch(value: number, max = MAX_PITCH_DEG): number {
  const limit = Number.isFinite(max) && max > 0 ? max : MAX_PITCH_DEG
  const pitch = Number.isFinite(value) ? value : FLAT_PITCH_DEG
  return Math.max(FLAT_PITCH_DEG, Math.min(limit, pitch))
}

/** 竖向拖拽向下增加俯仰角；向上拖回平放。 */
export function pitchFromDrag(
  state: PitchDragState,
  currentY: number,
  sensitivity = DEFAULT_PITCH_SENSITIVITY,
  max = MAX_PITCH_DEG,
): number {
  const factor = Number.isFinite(sensitivity) && sensitivity > 0 ? sensitivity : DEFAULT_PITCH_SENSITIVITY
  const deltaY = Number.isFinite(currentY) && Number.isFinite(state.startY) ? currentY - state.startY : 0
  // 平台事件可能出现反向/异常值，最终仍由 clampPitch 负责边界。
  return clampPitch(state.startPitch + deltaY * factor, max)
}

/** 减少动态效果时不做回弹，直接回到目标角度。 */
export function settlePitch(value: number, reducedMotion: boolean): number {
  const pitch = clampPitch(value)
  return reducedMotion ? pitch : pitch
}

/** 拖拽结束后的回弹目标；当前策略不改变用户角度，只做钳制。 */
export function pitchResetTarget(): number {
  return FLAT_PITCH_DEG
}
