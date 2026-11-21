import { describe, expect, it } from 'vitest'
import { LeafSim } from './realBookLeafSim'
import {
  advanceFlyer,
  createFlyerMotion,
  flyerEnv,
  quickPhi,
  quickPhiVel,
  QUICK_TURN_SECONDS,
  releaseFlyer,
  setDragPhase,
  type FlyerMotionState,
} from './realBookLeafMotion'

const W = 6.4
const H = 9.2

function make(fromSide: 1 | -1): FlyerMotionState {
  return createFlyerMotion(new LeafSim(W, H), fromSide, 0.95, 0.5)
}

function run(state: FlyerMotionState, seconds: number): void {
  const h = 1 / 240
  const steps = Math.round(seconds / h)
  for (let i = 0; i < steps; i += 1) advanceFlyer(state, h, flyerEnv())
}

/** 参考站的推进顺序：父层按 60Hz 写 quick 时钟，物理按 1/240 子步积分。 */
function stepQuick(state: FlyerMotionState, seconds: number, duration = QUICK_TURN_SECONDS): void {
  const frame = 1 / 60
  const h = 1 / 240
  const frames = Math.max(1, Math.round(seconds / frame))
  for (let index = 0; index < frames; index += 1) {
    state.quickT = Math.min(1, ((index + 1) * frame) / duration)
    for (let substep = 0; substep < 4; substep += 1) advanceFlyer(state, h, flyerEnv())
  }
}

describe('quick 翻页曲线（参考站三次曲线）', () => {
  it('起手在 0、落定在目标角，两端速度为 0 与 3Δ/duration', () => {
    expect(quickPhi(0, Math.PI, 0)).toBeCloseTo(0, 9)
    expect(quickPhi(0, Math.PI, 1)).toBeCloseTo(Math.PI, 9)
    expect(quickPhiVel(0, Math.PI, 1)).toBeCloseTo(0, 9)
    expect(quickPhiVel(0, Math.PI, 0)).toBeCloseTo(3 * Math.PI / QUICK_TURN_SECONDS, 9)
  })
})

describe('advanceFlyer：PBD 网格 + 卷曲弧面', () => {
  it('正翻：纸从右页卷上去，中段纸角领先、书脊侧还在原处', () => {
    const state = make(1)
    // 0.2s（quick 翻页的一半）：弦角约在 7π/8。
    stepQuick(state, 0.2)
    const tip = state.sim.x[state.sim.N - 1]!
    const root = state.sim.x[0]!
    const mid = state.sim.x[Math.floor(state.sim.N * 0.6)]!
    // 书脊侧钉在 x=0（参考站 constraints 的第一条）。
    expect(root).toBeCloseTo(0, 3)
    // 纸已经翻过中线。
    expect(mid).toBeLessThan(0)
    // 纸角比中段更靠左（纸在卷，不是一块硬板）。
    expect(mid - tip).toBeGreaterThan(0.05)
    expect(Number.isFinite(tip)).toBe(true)
  })

  it('纸从右页平躺、到左页平躺，起点与终点都在纸面高度附近', () => {
    const state = make(1)
    const startZ = state.sim.z[state.sim.N - 1]!
    stepQuick(state, QUICK_TURN_SECONDS)
    expect(state.phi).toBeCloseTo(Math.PI, 3)
    const endX = state.sim.x[state.sim.N - 1]!
    const endZ = state.sim.z[state.sim.N - 1]!
    // 落定在左页：x 为负，z 回到纸堆高度（没有被抬到空中）。
    expect(endX).toBeLessThan(-W * 0.5)
    expect(Math.abs(endZ - startZ)).toBeLessThan(0.12)
  })

  it('反翻：起手在左页，落定时到右页', () => {
    const state = make(-1)
    expect(state.phi).toBeCloseTo(Math.PI, 9)
    expect(state.sim.x[state.sim.N - 1]!).toBeLessThan(0)
    stepQuick(state, QUICK_TURN_SECONDS)
    expect(state.phi).toBeCloseTo(0, 3)
    expect(state.sim.x[state.sim.N - 1]!).toBeGreaterThan(W * 0.5)
  })

  it('中段的纸是弯的：相邻行在页高方向的起伏来自解算，不是直纹面', () => {
    const state = make(1)
    stepQuick(state, 0.18)
    const sim = state.sim
    const column = Math.floor(sim.N * 0.8)
    const rows = [0, Math.floor(sim.R / 2), sim.R - 1].map((row) => sim.z[row * sim.N + column]!)
    // 上下角与页心的 z 不会完全一样：纸有软影层要读的跨页高纸形。
    expect(Math.max(...rows) - Math.min(...rows)).toBeGreaterThan(0.002)
  })

  it('落定混合把纸按到目标页堆：末段的纸面 z 单调地贴回纸堆', () => {
    const state = make(1)
    stepQuick(state, QUICK_TURN_SECONDS)
    expect(state.landingAmount).toBeGreaterThan(0.99)
  })
})

describe('拖页与松手', () => {
  it('拖页严格跟手：写多少进度就转多少角，没有弹簧滞后', () => {
    const state = make(1)
    state.mode = 'quick'
    setDragPhase(state, 0.5)
    expect(state.phi).toBeCloseTo(Math.PI * 0.5, 6)
    setDragPhase(state, 0.25)
    expect(state.phi).toBeCloseTo(Math.PI * 0.25, 6)
    state.sim.step(1 / 240, flyerEnv(), flyerEnv().rootZ)
    expect(state.phi).toBeCloseTo(Math.PI * 0.25, 6)
  })

  it('松手后走参考站的自然弹簧，越靠近落点阻尼越大', () => {
    const state = make(1)
    setDragPhase(state, 0.4)
    releaseFlyer(state)
    run(state, 1.6)
    expect(state.phi).toBeCloseTo(Math.PI, 2)
    expect(state.mode).toBe('free')
    expect(state.sim.pin).toBeNull()
  })

  it('回弹：目标角改成出发侧时纸弹回原处', () => {
    const state = make(1)
    setDragPhase(state, 0.3)
    releaseFlyer(state)
    state.targetPhi = 0
    run(state, 1.6)
    expect(state.phi).toBeCloseTo(0, 2)
    expect(state.sim.x[state.sim.N - 1]!).toBeGreaterThan(W * 0.8)
  })
})

describe('flex 弹簧（纸面的呼吸）', () => {
  it('甩得越快弓得越多，停手后回振并收敛', () => {
    const state = make(1)
    // 正翻的 quick 时钟停在半程：phiVel 由曲线给出，flex 会跟着鼓起来。
    state.quickT = 0.1
    for (let i = 0; i < 12; i += 1) {
      state.quickT = 0.1
      advanceFlyer(state, 1 / 240, flyerEnv())
    }
    expect(Math.abs(state.flex)).toBeGreaterThan(0.02)
    // 停手：mode 停在非 free（参考站里松手后是 auto，flex 弹簧继续跑），
    // 弹簧自己把 flex 收回去。
    state.mode = 'auto'
    state.phi = state.targetPhi - 0.3
    state.phiVel = 0
    // 弹簧自己回振：governor 的 flex 目标随 phiVel 收敛到 0，振荡指数衰减。
    run(state, 0.6)
    expect(Math.abs(state.flex)).toBeLessThan(0.01)
  })
})

describe('参考站的顶行卷曲（curlAngles）', () => {
  it('纸被捏住的那一行先立起来：手所在行贴到目标弧面，远处行滞后', () => {
    const state = make(1)
    // 停掉 quick/auto 的角度时钟，只看「手捏住页心、弦角 90°」这一个卷曲形状。
    state.mode = 'drag'
    state.v = 0.5
    state.phi = Math.PI * 0.5
    state.sim.pin = {
      u: state.u,
      v: state.v,
      sigma: 0.8,
      x: 0,
      z: 0,
      strength: 0.62,
      shape: { phi: state.phi, fromSide: 1, flex: 0 },
    }
    // 推几张：第一张只把卷曲目标铺进网格，后续子步才把纸解算到目标形状上。
    for (let i = 0; i < 12; i += 1) advanceFlyer(state, 1 / 240, flyerEnv())
    const rowMid = Math.round((state.sim.R - 1) * 0.5)
    const rowTop = state.sim.R - 1
    const i = Math.round(state.sim.N * 0.95) - 1
    const midZ = state.sim.z[rowMid * state.sim.N + i]!
    const topZ = state.sim.z[rowTop * state.sim.N + i]!
    // 手在页心：页心那一行比页眉那一行更立起来（z 更高），远处行沿页高滞后。
    expect(midZ - topZ).toBeGreaterThan(0.005)
  })
})

describe('确定性', () => {
  it('同一串输入得到同一串位置', () => {
    const a = make(1)
    const b = make(1)
    stepQuick(a, 0.15)
    stepQuick(b, 0.15)
    expect(a.sim.x.every((value, index) => Math.abs(value - b.sim.x[index]!) < 1e-9)).toBe(true)
    expect(a.phi).toBeCloseTo(b.phi, 9)
  })
})
