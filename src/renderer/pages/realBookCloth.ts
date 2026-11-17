/**
 * 飞页的布料层：40×8 质点网格 + 惯性 + 邻域松弛。
 *
 * ## 为什么在解析弧面之外还要一层布料
 *
 * `realBookFlip.flipPoses` 给出的弧面是**沿页宽变化的**：每一条竖带的转角只由它
 * 离书脊多远决定，与它在页高方向的位置无关。这样一个曲面是「直纹面」——
 * 把一张纸沿宽度方向弯起来，再沿高度方向直直拉出去。纸摊平时看不出差别，
 * 一翻起来就是一张弯了的**卡片**：页脚、页眉、页心三条线始终平行，
 * 上下两角不会比中间先落，整片纸像一块塑料。
 *
 * 真纸在翻动里有三件直纹面给不出的事：
 *
 *   1. **对角线的起伏**——中间的纸鼓着，两个自由角往下垂，曲面是马鞍而不是圆筒；
 *   2. **迟滞**——纸被手甩出去，外缘不会立刻跟到解析位置，它晚一点、还会过冲一点；
 *   3. **低频的整片抖动**——抖动是顺着纸面传的，不是每个点各抖各的。
 *
 * 所以这里做两件事：目标位置在解析弧面上叠一层二维细节（马鞍 + 行波），
 * 再把「质点相对目标位置的偏离」当弹簧-阻尼系统积分，最后沿网格做一次邻域平均
 * 把偏离抹成低频。渲染网格比 40×8 更细，用双线性采样取布料场。
 */

import { flipPhases, flipPoses, type FlipSlicePose } from './realBookFlip'

/** 参考站网格：沿页宽 40 段、沿页高 8 段。 */
export const CLOTH_COLUMNS = 40
export const CLOTH_ROWS = 8

/** 解析弧面的像素宽度（与 `realBookFlip` 同一套坐标）。 */
const CLOTH_PIXEL_WIDTH = 640

/**
 * 弹簧刚度（1/s²）与阻尼（1/s）。
 *
 * 刚度 900 → 固有角频率 30 rad/s，一个来回约 0.21 秒：纸在空中的那一小段滞后
 * 就是这个量级。临界阻尼是 2√900 = 60，取 26 即阻尼比 0.43——略微欠阻尼，
 * 落位时有一点点回弹，正是纸落到对面时的余颤；再大就成了泡在糖浆里的纸。
 */
const CLOTH_STIFFNESS = 900
const CLOTH_DAMPING = 26

/** 单步最大 dt：掉帧或切后台回来时不让积分炸开。 */
const CLOTH_MAX_STEP = 1 / 30
/** 每步最多积分几次固定子步。 */
const CLOTH_MAX_SUBSTEPS = 3

/**
 * 质点相对目标位置的最大偏离（世界单位）。
 *
 * 整页宽 6.4，0.09 约等于 1.4%：纸可以滞后、可以鼓出来一点，
 * 但不能被惯性拉出书体轮廓——那会变成「页面被撕下来飞走」。
 */
const CLOTH_MAX_STRAY = 0.09

/**
 * 邻域松弛权重（每次 step 一轮）。
 *
 * 把偏离沿网格平均一遍，等于对偏离做低通：纸的滞后是整片的，
 * 不会出现某个质点独自甩出去、纸面上鼓起一个尖。
 */
const CLOTH_SMOOTH = 0.16

export interface ClothFieldOptions {
  /** 整页宽度（世界单位） */
  width: number
  /** 整页高度（世界单位） */
  height: number
  /** 翻页进度 0–1 */
  progress: number
  /** 翻页方向：1 = 往左翻（右页飞起），-1 = 往右翻 */
  direction: 1 | -1
  /** 窄屏单页：飞页的中缝位置与双页不同 */
  singlePage?: boolean
}

export interface ClothGrid {
  columns: number
  rows: number
  /** 长度 columns × rows × 3：每点 (x, y, z)，世界坐标，原点是整页中心 */
  positions: Float32Array
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/**
 * 折线上 s 处的 (x, z)：与 `realBookWebGLScene.writeFlipGeometry` 早先的逐带写法同一套插值。
 *
 * 竖带本身是直的，带与带之间用线性插值连起来就是一条连续折线；s 落在最后一条带
 * 之外（浮点误差）时退回最后一条带自己的终点。
 */
function poseAt(poses: FlipSlicePose[], s: number): { x: number; z: number } {
  let index = poses.findIndex((pose) => s >= pose.offset && s < pose.offset + pose.width)
  if (index < 0) index = poses.length - 1
  const pose = poses[index]!
  const local = pose.width > 0 ? clamp01((s - pose.offset) / pose.width) : 0
  const next = poses[index + 1]
  const angleRad = (pose.angle * Math.PI) / 180
  const nextX = next ? next.x : pose.x + pose.width * Math.cos(angleRad)
  const nextZ = next ? next.z : pose.z - pose.width * Math.sin(angleRad)
  return { x: pose.x + (nextX - pose.x) * local, z: pose.z + (nextZ - pose.z) * local }
}

/**
 * 飞页此刻的布料目标场。
 *
 * 解析弧面负责「纸转到哪儿」，这里的二维细节负责「纸是什么做的」：
 * 中间鼓起、两个自由角下垂、沿页高有行波。所有细节都乘 `sin(π·纸角行程)`，
 * 起手与落定两帧回到零，因此首尾与静止页面严丝合缝，不会在落定瞬间跳一下。
 */
export function flipClothField(options: ClothFieldOptions): ClothGrid {
  const columns = CLOTH_COLUMNS
  const rows = CLOTH_ROWS
  const width = Number.isFinite(options.width) && options.width > 0 ? options.width : 0
  const height = Number.isFinite(options.height) && options.height > 0 ? options.height : 0
  // 往回翻就是把同一段弧面**倒放**：纸起手贴在左页、落定贴到右页，走的还是那条弧。
  // 早先的做法是把 x 取反，位置对了、贴图却整体镜像——落定那一刻纸上的字是反的。
  const direction = options.direction === -1 ? -1 : 1
  const t = clamp01(direction === -1 ? 1 - clamp01(options.progress) : options.progress)
  const singlePage = options.singlePage === true
  const scale = CLOTH_PIXEL_WIDTH > 0 ? width / CLOTH_PIXEL_WIDTH : 0
  const poses = flipPoses(t, { width: CLOTH_PIXEL_WIDTH, fromDeg: 0, toDeg: 180, slices: CLOTH_COLUMNS })
  const phases = flipPhases(t)
  // 细节包络吃纸角行程：纸被甩起来的时候它才起，落定时收回。
  const envelope = Math.sin(Math.PI * phases.tip)
  const positions = new Float32Array(columns * rows * 3)

  for (let column = 0; column < columns; column += 1) {
    const u = columns > 1 ? column / (columns - 1) : 0
    const pose = poseAt(poses, u * CLOTH_PIXEL_WIDTH)
    // 不镜像：弧面本身已经由「倒放」改到了左页，再取反 x 会把贴图也镜像过去。
    let x = pose.x * scale
    // 单页模式只有一页：纸从这一页掀起来、往翻页方向甩出去，中缝始终对齐页心。
    if (singlePage) x += direction === 1 ? -width / 2 : width / 2
    const baseZ = (3 - pose.z) * scale
    for (let row = 0; row < rows; row += 1) {
      const v = rows > 1 ? row / (rows - 1) : 0
      const across = Math.abs(v - 0.5) * 2
      // 中间鼓起：纸被甩出去时页心比纸边更「顶」。
      const belly = 0.03 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v)
      // 两个自由角下垂：只有远离书脊、又在页高两端的地方才垂。
      const droop = -0.075 * u * u * across * across
      // 沿页高的行波：纸在空中的那一段有低频起伏，读起来才是软的。
      const wave = 0.02 * u * Math.sin(v * Math.PI * 2.4 + t * 15)
      const z = baseZ + (belly + droop + wave) * envelope
      const y = (v - 0.5) * height
      const offset = (row * columns + column) * 3
      positions[offset] = x
      positions[offset + 1] = y
      positions[offset + 2] = z
    }
  }
  return { columns, rows, positions }
}

/**
 * 质点布料：跟踪目标场，带惯性，并把偏离抹成低频。
 *
 * 状态只有「当前位置」和「速度」两个数组。目标场每帧重算（它是纯函数），
 * 积分放在固定子步上，因此同一串输入必然得到同一串结果——测试可以断言它。
 */
export class ClothSheet {
  readonly columns = CLOTH_COLUMNS
  readonly rows = CLOTH_ROWS
  private readonly current: Float32Array
  private readonly velocity: Float32Array
  private readonly target: Float32Array
  private readonly deviation: Float32Array
  private accumulator = 0
  private primed = false

  constructor() {
    const size = this.columns * this.rows * 3
    this.current = new Float32Array(size)
    this.velocity = new Float32Array(size)
    this.target = new Float32Array(size)
    this.deviation = new Float32Array(size)
  }

  /** 直接把布料按到目标场上：起翻、换向、重新打开时用，避免纸从上一帧的状态飞进来。 */
  reset(field: ClothGrid): void {
    this.copyField(field, this.current)
    this.copyField(field, this.target)
    this.velocity.fill(0)
    this.accumulator = 0
    this.primed = true
  }

  /** 推进布料。dt 用真实帧间隔，内部切成固定子步。 */
  step(field: ClothGrid, dt: number): void {
    if (!this.primed) {
      this.reset(field)
      return
    }
    this.copyField(field, this.target)
    const stepDt = CLOTH_MAX_STEP / CLOTH_MAX_SUBSTEPS
    const budget = stepDt * CLOTH_MAX_SUBSTEPS * 2
    this.accumulator = Math.min(budget, this.accumulator + Math.max(0, Math.min(CLOTH_MAX_STEP, dt)))
    let steps = 0
    while (this.accumulator >= stepDt && steps < CLOTH_MAX_SUBSTEPS * 2) {
      this.integrate(stepDt)
      this.accumulator -= stepDt
      steps += 1
    }
    if (steps === 0) return
    this.relax()
  }

  private copyField(field: ClothGrid, into: Float32Array): void {
    if (field.positions.length === into.length) into.set(field.positions)
  }

  private integrate(dt: number): void {
    const damping = Math.exp(-CLOTH_DAMPING * dt)
    for (let row = 0; row < this.rows; row += 1) {
      for (let column = 0; column < this.columns; column += 1) {
        const offset = (row * this.columns + column) * 3
        if (column === 0) {
          // 书脊侧钉死：翻动页那一端装在书脊的折缝里，任何一帧都不能离开。
          this.current[offset] = this.target[offset]!
          this.current[offset + 1] = this.target[offset + 1]!
          this.current[offset + 2] = this.target[offset + 2]!
          this.velocity[offset] = 0
          this.velocity[offset + 1] = 0
          this.velocity[offset + 2] = 0
          continue
        }
        for (let axis = 0; axis < 3; axis += 1) {
          const index = offset + axis
          const delta = this.target[index]! - this.current[index]!
          this.velocity[index] = (this.velocity[index]! + delta * CLOTH_STIFFNESS * dt) * damping
          this.current[index] = this.current[index]! + this.velocity[index]! * dt
        }
      }
    }
  }

  /** 沿网格把「相对目标的偏离」平均一遍，再夹到上限。 */
  private relax(): void {
    const { columns, rows, current, target, deviation } = this
    for (let index = 0; index < deviation.length; index += 1) {
      deviation[index] = current[index]! - target[index]!
    }
    for (let row = 0; row < rows; row += 1) {
      for (let column = 1; column < columns; column += 1) {
        const offset = (row * columns + column) * 3
        let count = 0
        let sumX = 0
        let sumY = 0
        let sumZ = 0
        // 四邻域：左（书脊侧）、右（纸角侧）、下、上。列 0 是钉住的，不参与平均。
        for (let neighbourIndex = 0; neighbourIndex < 4; neighbourIndex += 1) {
          let neighbour = -1
          if (neighbourIndex === 0) neighbour = column > 0 ? offset - 3 : -1
          else if (neighbourIndex === 1) neighbour = column < columns - 1 ? offset + 3 : -1
          else if (neighbourIndex === 2) neighbour = row > 0 ? offset - columns * 3 : -1
          else neighbour = row < rows - 1 ? offset + columns * 3 : -1
          if (neighbour < 0) continue
          count += 1
          sumX += deviation[neighbour]!
          sumY += deviation[neighbour + 1]!
          sumZ += deviation[neighbour + 2]!
        }
        if (!count) continue
        const averages = [sumX / count, sumY / count, sumZ / count]
        for (let axis = 0; axis < 3; axis += 1) {
          const index = offset + axis
          const blended = deviation[index]! * (1 - CLOTH_SMOOTH) + averages[axis]! * CLOTH_SMOOTH
          current[index] = target[index]! + Math.max(-CLOTH_MAX_STRAY, Math.min(CLOTH_MAX_STRAY, blended))
        }
      }
    }
  }

  /** 双线性采样：u 沿页宽（0 = 书脊），v 沿页高（0 = 下缘），写入 out[offset..offset+2]。 */
  sampleInto(u: number, v: number, out: Float32Array, offset: number): void {
    const columns = this.columns
    const rows = this.rows
    const cx = clamp01(u) * (columns - 1)
    const rx = clamp01(v) * (rows - 1)
    const c0 = Math.min(columns - 2, Math.floor(cx))
    const r0 = Math.min(rows - 2, Math.floor(rx))
    const fx = Math.min(1, cx - c0)
    const fy = Math.min(1, rx - r0)
    const i00 = (r0 * columns + c0) * 3
    const i10 = i00 + 3
    const i01 = i00 + columns * 3
    const i11 = i01 + 3
    const positions = this.current
    for (let axis = 0; axis < 3; axis += 1) {
      const bottom = positions[i00 + axis]! * (1 - fx) + positions[i10 + axis]! * fx
      const top = positions[i01 + axis]! * (1 - fx) + positions[i11 + axis]! * fx
      out[offset + axis] = bottom * (1 - fy) + top * fy
    }
  }

  /** 取某个质点的当前位置（测试与诊断用）。 */
  pointAt(column: number, row: number): [number, number, number] {
    const offset = (Math.max(0, Math.min(this.rows - 1, row)) * this.columns
      + Math.max(0, Math.min(this.columns - 1, column))) * 3
    return [this.current[offset]!, this.current[offset + 1]!, this.current[offset + 2]!]
  }
}
