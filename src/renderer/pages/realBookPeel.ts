/**
 * 悬停预掀：指针靠近书页外角时，纸角先被掀起一小块。
 *
 * 参考站在鼠标移到页角时纸会自己翘起一角（`setPeel`），移开后落回；
 * 我们的静态书页是 40×26 的网格，可以直接把这一角的顶点抬起来。
 * 这里只算位移，纯函数，场景按页面的本地坐标套用。
 */

export interface PeelDisplacement {
  /** 本地 x 位移（向书脊收） */
  x: number
  /** 本地 y 位移（向页心收） */
  y: number
  /** 本地 z 位移（抬离纸面，朝观者） */
  z: number
}

/** 掀起的最大高度（场景单位）：整页高 9.2，0.42 约 4.5%，和参考站的预掀幅度相当。 */
export const PEEL_MAX_LIFT = 0.42
/** 向书脊收的最大距离：纸角翘起时不是纯平移，会往页心卷一点。 */
const PEEL_PULL_X = 0.09
/** 向页心收的最大距离。 */
const PEEL_PULL_Y = 0.05
/** 外缘从多宽开始起掀（0–1，1 = 外口边）。 */
const PEEL_EDGE_START = 0.62
/** 纸角从多高开始起掀（0 = 页心，1 = 上/下缘）。 */
const PEEL_CORNER_START = 0.35

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0
  const t = clamp01((value - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** 空闲多久之后开始飘动（与参考站的 flutterCorner 同量级）。 */
export const IDLE_FLUTTER_DELAY_MS = 2600
/** 一轮飘动的时长（秒）：约两个来回，落定后纸角收回。 */
export const IDLE_FLUTTER_DURATION_S = 3.2
/** 两轮飘动之间的静默（毫秒）：纸不是一直在动，动静交替才有「活」。 */
export const IDLE_FLUTTER_REST_MS = 4500
/** 飘动的最大强度：比悬停预掀弱很多，只是「纸在呼吸」。 */
export const IDLE_FLUTTER_STRENGTH = 0.4

/**
 * 空闲纸角飘动的强度包络（0–`IDLE_FLUTTER_STRENGTH`）。
 *
 * 整段先淡入再淡出，中间按 1.15Hz 轻微起伏：起手不猛抬，结束自然收零。
 * 参考站的 flutterCorner 是同一条 1.15Hz 余弦，只是它按一次短促脉冲算包络。
 */
export function idleFlutterAmount(idleMs: number): number {
  if (!Number.isFinite(idleMs) || idleMs <= IDLE_FLUTTER_DELAY_MS) return 0
  // 空闲是周期性的：一轮 3.2s 的飘动，然后静默 4.5s，再飘一轮。
  const cycle = IDLE_FLUTTER_DURATION_S * 1000 + IDLE_FLUTTER_REST_MS
  const phase = (idleMs - IDLE_FLUTTER_DELAY_MS) % cycle
  const t = phase / 1000
  if (t < 0 || t >= IDLE_FLUTTER_DURATION_S) return 0
  // 整段先淡入再淡出，中间按 1.15Hz 起伏；不像一次猛抬，更像纸在呼吸。
  const fade = Math.sin(Math.PI * Math.min(1, t / IDLE_FLUTTER_DURATION_S))
  const wave = 0.5 - 0.5 * Math.cos(t * Math.PI * 2 * 1.15)
  return Math.max(0, Math.min(IDLE_FLUTTER_STRENGTH, fade * wave))
}

export interface CornerPeelOptions {
  /** 0–1：预掀强度（0 = 平放） */
  amount: number
  /** 1 = 上角，-1 = 下角 */
  corner: 1 | -1
  /** 外口边在本地坐标的哪一侧：true = u=1 是外口（右页），false = u=0（左页） */
  outerAtU1: boolean
}

/**
 * 页面本地坐标 (u, v) 处的预掀位移。
 *
 * u 沿页宽（0 = 书脊，1 = 外口），v 沿页高（-0.5 = 下缘，0.5 = 上缘）。
 * 掀起的区域用两道平滑遮罩相乘：只在靠外口、且靠被指的那个角时才有位移；
 * 越靠纸角抬得越高，抬的同时向书脊和页心各收一点，读起来是「纸角被捏起」，不是整块平移。
 */
export function pageCornerPeel(u: number, v: number, options: CornerPeelOptions): PeelDisplacement {
  const amount = clamp01(options.amount)
  if (amount <= 0) return { x: 0, y: 0, z: 0 }
  const outer = options.outerAtU1 ? clamp01(u) : 1 - clamp01(u)
  const edge = smoothstep(PEEL_EDGE_START, 1, outer)
  const cornerSide = options.corner >= 0 ? clamp01(v) * 2 : clamp01(-v) * 2
  const corner = smoothstep(PEEL_CORNER_START, 1, cornerSide)
  if (edge <= 0 || corner <= 0) return { x: 0, y: 0, z: 0 }
  const k = amount * Math.pow(edge, 1.5) * Math.pow(corner, 1.2)
  return {
    x: (options.outerAtU1 ? -1 : 1) * PEEL_PULL_X * k,
    y: -options.corner * PEEL_PULL_Y * k,
    z: PEEL_MAX_LIFT * k,
  }
}
