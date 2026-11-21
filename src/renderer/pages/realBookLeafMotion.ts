/**
 * 飞页运动：把 Infinite Reader 的 `BookModel.stepFlyers` / `blendQuickLanding`
 * （web/src/engine/book.ts，Apache-2.0）原样搬成可单测的纯模块。
 *
 * 之前这里是「解析弧面 + 另做的一层 40×8 质点布料」：弧面来自 CSS 3D 时代的
 * `realBookFlip`，布料只是个低通滤波器。参考站不是这么翻的——纸是一张由
 * `LeafSim` 解算的 PBD 网格：每一行是一根不可伸长、有挺度的杆，中间被手捏住的
 * 那一行领着走，整张纸按 `curlAngles` 的对称弧面卷起，行与行之间有滞后，
 * 空气阻力作用在纸面法向上。这样纸角会先走、纸心会鼓、落定前会颤。
 *
 * 这里保留了参考实现的全部关键量：起手角度、quick 翻页的三次曲线、拖动时
 * 直接写角度、松手后的弹簧（含靠近落点时的额外阻尼）、纸面 flex 的弹簧振荡，
 * 以及落定前把纸混到目标页堆形状的 landing 混合。
 *
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */

import { curlAngles, LeafSim, type SimEnv } from './realBookLeafSim'

/** 参考站的翻页基础量（book.ts）。 */
export const FLYER_GRAVITY = 85
export const FLYER_CLEARANCE = 0.004
export const FLYER_REST_LIFT = 0.006
export const QUICK_TURN_SECONDS = 0.4

/** 快速翻页的三次曲线：参考站 quick 翻页同一条。 */
export function quickPhi(start: number, target: number, t: number): number {
  const k = clamp01(t)
  return start + (target - start) * (1 - (1 - k) ** 3)
}

/** 快速翻页的角速度，供 flex 与 pin 使用。 */
export function quickPhiVel(start: number, target: number, t: number): number {
  const k = clamp01(t)
  return (target - start) * 3 * (1 - k) ** 2 / QUICK_TURN_SECONDS
}

export type FlyerMode = 'quick' | 'drag' | 'auto' | 'free'

export interface LandingSnapshot {
  /** 落点所在的一侧：1 = 右页堆，-1 = 左页堆。 */
  side: 1 | -1
  /** 沿页宽的落点 x（与 sim 同一套坐标）。 */
  x: Float32Array
  /** 落点 z。 */
  z: Float32Array
}

export interface FlyerMotionState {
  sim: LeafSim
  fromSide: 1 | -1
  mode: FlyerMode
  /** 纸的弦角：0 = 平躺在右页，PI = 平躺在左页。 */
  phi: number
  phiVel: number
  targetPhi: number
  /** 手捏住的位置（页宽 0–1）。 */
  u: number
  /** 手捏住的行（页高 0–1）。 */
  v: number
  /** 起拖时捏住的那一行：拖动中手指纵向移动时，纸的行跟随有一个阻尼。 */
  grabV: number
  /** 手指此刻在纸上的行（页高 0–1）：拖动时 `v` 向它靠拢。 */
  pointerV: number
  /** 纸面的额外弯曲（由甩动速度驱动，落定时会回振一次）。 */
  flex: number
  flexVel: number
  /** quick 翻页的 0–1 时钟（父层给的线性进度）。 */
  quickT: number
  /** 起手时的弦角，quick 曲线从这里出发。 */
  startPhi: number
  /** 落定混合强度 0–1。 */
  landingAmount: number
  landing?: LandingSnapshot
  /** 这一张纸的碰撞/铰链环境（页面的外缘翘起由 scene 提供）。 */
  env: SimEnv
  age: number
}

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value))
const clamp01 = (value: number): number => clamp(value, 0, 1)
const smooth = (x: number): number => x * x * (3 - 2 * x)

/**
 * 纸的碰撞环境。
 *
 * `surface(x)` 是不含间隙的纸面高度（spbf 的静态页外缘微微翘起），换到碰撞面时
 * 统一加 `FLYER_CLEARANCE`；书脊侧（x=0）是纸面最低处，飞页的 hinge 也钉在这里。
 */
export function flyerEnv(surface: (x: number) => number = () => 0): SimEnv {
  const collider = (x: number) => surface(x) + FLYER_CLEARANCE
  return {
    gravity: FLYER_GRAVITY,
    rootZ: collider(0) + FLYER_REST_LIFT,
    surface: collider,
  }
}

/** 新起一张纸：先按出发页堆的形状铺平，再交回给运动时钟。 */
export function createFlyerMotion(
  sim: LeafSim,
  fromSide: 1 | -1,
  u: number,
  v: number,
  env: SimEnv = flyerEnv(),
): FlyerMotionState {
  sim.rest(fromSide, env, FLYER_REST_LIFT)
  const phi = fromSide === 1 ? 0 : Math.PI
  return {
    sim,
    fromSide,
    mode: 'quick',
    phi,
    phiVel: 0,
    targetPhi: fromSide === 1 ? Math.PI : 0,
    u,
    v,
    grabV: v,
    pointerV: v,
    flex: 0,
    flexVel: 0,
    quickT: 0,
    startPhi: phi,
    landingAmount: 0,
    env,
    age: 0,
  }
}

/** 拖动中手指换了一行：纸的行会以 14/s 的速度追过去（参考站 moveDrag 的 pointerV）。 */
export function setDragPointerRow(state: FlyerMotionState, row: number): void {
  state.pointerV = clamp(row, 0.04, 0.96)
}

/** 拖页：手指直接写弦角（参考站 moveDrag 的相位），不做弹簧滞后。 */
export function setDragPhase(state: FlyerMotionState, phase: number): void {
  const k = clamp01(phase)
  const phi = state.fromSide === 1 ? Math.PI * k : Math.PI * (1 - k)
  state.phiVel = (phi - state.phi) / (1 / 60)
  state.phi = phi
  state.mode = 'drag'
}

/** 松手：交给参考站的自然弹簧。 */
export function releaseFlyer(state: FlyerMotionState): void {
  state.mode = 'auto'
}

/** 快速翻页时钟（父层线性进度）。 */
export function setQuickPhase(state: FlyerMotionState, progress: number): void {
  state.quickT = clamp01(progress)
}

/**
 * 一帧的运动子步（参考站固定 1/240）。
 *
 * `h` 是子步时长；quick 时钟由父层写入，拖动角度已经由 `setDragPhase` 写好，
 * 松手后的状态在这里用弹簧推进。最后一步把 `sim` 交给 PBD 解算。
 */
export function advanceFlyer(state: FlyerMotionState, h: number, env: SimEnv = state.env): void {
  const { sim, fromSide } = state
  switch (state.mode) {
    case 'quick': {
      state.phi = quickPhi(state.startPhi, state.targetPhi, state.quickT)
      state.phiVel = quickPhiVel(state.startPhi, state.targetPhi, state.quickT)
      break
    }
    case 'auto': {
      // 参考站：k = 22；越靠近落点阻尼越大，落下去是滑下去而不是砸下去。
      const k = 22
      const c = 6.4 + 3.4 * (1 - clamp(Math.abs(state.targetPhi - state.phi) / 1.1, 0, 1))
      state.phiVel += (k * (state.targetPhi - state.phi) - c * state.phiVel) * h
      state.phi += state.phiVel * h
      // 弹簧本身让纸在落点附近来回振；连续落定混合已经把纸按到页堆上，
      // 这里只负责摘掉 pin，让 PBD 自由地贴住纸堆。
      if (Math.abs(state.phi - state.targetPhi) < 0.07 && Math.abs(state.phiVel) < 1) {
        state.mode = 'free'
        state.phi = state.targetPhi
        state.phiVel = 0
        sim.pin = null
      }
      break
    }
    case 'drag':
      // 参考站：拖动中纸的行以 14/s 的速率追手指，捏近页角时整页的滞后形状才跟手。
      state.v += (state.pointerV - state.v) * Math.min(1, h * 14)
      break
    case 'free':
      break
  }

  if (state.mode !== 'free') {
    // 参考站：纸被甩得越快，弓得越多；停手时 flex 自己回振一次。
    const travel = state.phiVel * fromSide
    const flexTarget = clamp(travel * 0.035, -0.12, 0.26)
    const wf = 22
    state.flexVel += (wf * wf * (flexTarget - state.flex) - 2 * 0.4 * wf * state.flexVel) * h
    state.flex += state.flexVel * h
    const phi = clamp(state.phi, -0.02, Math.PI + 0.02)
    // 参考站：被捏住的点走一段略短的臂，纸越立起来捏点离书脊越近。
    const d = sim.W * state.u * (1 - 0.07 * Math.sin(phi))
    sim.pin = {
      u: state.u,
      v: state.v,
      sigma: state.mode === 'drag' ? 0.62 : 0.8,
      x: d * Math.cos(phi),
      z: env.rootZ + d * Math.sin(phi),
      strength: state.mode === 'drag' ? 0.8 : 0.62,
      shape: {
        phi,
        fromSide,
        flex: state.mode === 'quick' ? state.flex * Math.sin(phi) : state.flex,
      },
    }
  } else {
    sim.pin = null
  }

  state.age += h
  sim.step(h, env, env.rootZ)

  updateLandingAmount(state)
  if (state.landingAmount > 0) {
    if (!state.landing) state.landing = landingSnapshot(state)
    blendToLanding(state, state.landingAmount)
  }
}

/**
 * 落定混合强度。
 *
 * quick 翻页在 60%–90% 行程之间把纸混到目标页堆（参考站 `quickLandingAmount`）；
 * 松手后的弹簧则在离目标不到约 17° 时开始混，保证纸在父亲提交换页前已经平躺。
 */
function updateLandingAmount(state: FlyerMotionState): void {
  if (state.mode === 'quick') {
    state.landingAmount = smooth(clamp((state.quickT - 0.6) / 0.3, 0, 1))
    return
  }
  if (state.mode === 'auto' || state.mode === 'free') {
    // 参考站的 quick 落定混合从 60% 行程开始；松手后的弹簧没有父层可等待的
    // 「平静」信号，所以把混合窗口放到离落点 0.45 rad：纸在提交前已经平躺，
    // 不会在拆掉飞页的那一帧跳一下。
    state.landingAmount = smooth(clamp((0.45 - Math.abs(state.targetPhi - state.phi)) / 0.45, 0, 1))
    return
  }
  state.landingAmount = 0
}

/** 目标页堆上这一页的落点形状（参考站 blendQuickLanding 的 `tmpSim.rest`）。 */
function landingSnapshot(state: FlyerMotionState): LandingSnapshot {
  const side: 1 | -1 = state.targetPhi > Math.PI / 2 ? -1 : 1
  const sim = new LeafSim(state.sim.W, state.sim.H)
  sim.rest(side, state.env, FLYER_REST_LIFT)
  return {
    side,
    x: sim.x.slice(0, sim.N),
    z: sim.z.slice(0, sim.N),
  }
}

/**
 * 把纸的每个网格点混向落点。
 *
 * `landing.x/z` 只有一行（参考站取 `tmpSim` 的第一行再按列复制到所有行），
 * 因为页堆在页高方向是平直的。
 */
export function blendToLanding(state: FlyerMotionState, amount: number): void {
  const { sim, landing } = state
  if (!landing) return
  const blend = clamp01(amount)
  if (blend <= 0) return
  for (let index = 0; index < sim.x.length; index += 1) {
    const column = index % sim.N
    const dx = (landing.x[column]! - sim.x[index]!) * blend
    const dz = (landing.z[column]! - sim.z[index]!) * blend
    sim.x[index] += dx
    sim.px[index] += dx
    sim.z[index] += dz
    sim.pz[index] += dz
  }
}

/** 参考站的对称卷曲弧面，供渲染层做页面曲率/明暗诊断。 */
export function flyerCurl(state: FlyerMotionState, row: number): ReturnType<typeof curlAngles> {
  return curlAngles(state.phi, state.fromSide, state.v, row, state.flex)
}
