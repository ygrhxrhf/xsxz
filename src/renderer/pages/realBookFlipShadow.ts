/**
 * 飞页投在下面纸面上的影子网格。
 *
 * 早先是一张跟随飞页的椭圆软影：位置对、形状不对，纸翘起多高、卷成什么角度，
 * 影子都是一团。参考站按 20 行采样把飞页的轮廓投到纸面上；这里用同一份布料顶点
 * （40×26）做投影，按高度偏移、按轮廓外扩、按边/高度/进度衰减透明度，
 * 得到一张贴着飞页形状的软影。
 *
 * 纯函数，不依赖 Three.js，方便单测。
 */

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0
  const t = clamp01((value - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** 光从左前上方来：每升高一个世界单位，影子在纸面上偏移多少。 */
export const FLIP_SHADOW_LIGHT_X = 0.3
export const FLIP_SHADOW_LIGHT_Y = -0.36

/** 静止时影子比纸轮廓外扩的比例；升得越高，半影越宽。 */
export const FLIP_SHADOW_BASE_INFLATE = 0.1
/** 影子最深处的透明度。 */
export const FLIP_SHADOW_DENSITY = 0.34

export interface FlipShadowOptions {
  /** 布料网格列数/行数（与飞页几何一致：40×26）。 */
  columns: number
  rows: number
  /** 布料顶点（飞页组局部坐标：x 沿页宽、y 沿页高、z 朝观者），长度 columns×rows×3。 */
  cloth: ArrayLike<number>
  /** 飞页组的纵向缩放（窄屏时页高变了）。 */
  scaleY: number
  /** 飞页组的 z 偏移（纸离桌面的基础高度）。 */
  zOffset: number
  /** 下面纸面的大致高度。 */
  pageZ: number
  /** 影子所在的平面：在纸面之上、飞页最低点之下。 */
  shadowZ: number
  /** 翻页进度 0–1。 */
  progress: number
  /** 影子只允许落在书页矩形里；越界的顶点透明度归零，免得影子飘到桌面上。 */
  bounds?: { minX: number; maxX: number; minY: number; maxY: number }
}

export interface FlipShadowMesh {
  /** 书体局部坐标，长度与 cloth 相同。 */
  positions: Float32Array
  /** 每个顶点的不透明度。 */
  alpha: Float32Array
}

/**
 * 生成影子网格。
 *
 * 1. 按布料顶点求纸面投影：`x + lightX·h`、`y + lightY·h`（h = 离纸面的高度）。
 * 2. 以投影的质心为中心外扩（6% + 高度带来的半影），让影子从飞页轮廓外露出来。
 * 3. 透明度 = 基础密度 × 进度包络 × 边缘衰减 × 书脊侧衰减 × 高度衰减。
 *    书脊侧衰减是必须的：那里纸几乎贴着桌面（低于影子平面），不衰减会把影子画到纸上。
 */
export function buildFlipShadow(options: FlipShadowOptions): FlipShadowMesh {
  const columns = Math.max(2, Math.floor(options.columns))
  const rows = Math.max(2, Math.floor(options.rows))
  const count = columns * rows
  const zOffset = Number.isFinite(options.zOffset) ? options.zOffset : 0
  const scaleY = Number.isFinite(options.scaleY) && options.scaleY > 0 ? options.scaleY : 1
  const pageZ = Number.isFinite(options.pageZ) ? options.pageZ : 0
  const shadowZ = Number.isFinite(options.shadowZ) ? options.shadowZ : pageZ + 0.03
  const progress = clamp01(options.progress)
  const envelope = progress <= 0 || progress >= 1
    ? 0
    : Math.pow(Math.max(0, Math.sin(Math.PI * progress)), 0.8)
  const positions = new Float32Array(count * 3)
  const alpha = new Float32Array(count)
  const projected = new Float32Array(count * 2)
  const heights = new Float32Array(count)
  const cloth = options.cloth

  let centerX = 0
  let centerY = 0
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3
    const x = Number(cloth[offset] ?? 0)
    const y = Number(cloth[offset + 1] ?? 0) * scaleY
    const z = Number(cloth[offset + 2] ?? 0) + zOffset
    const height = Math.max(0, z - pageZ)
    heights[index] = height
    projected[index * 2] = x + FLIP_SHADOW_LIGHT_X * height
    projected[index * 2 + 1] = y + FLIP_SHADOW_LIGHT_Y * height
    centerX += projected[index * 2]!
    centerY += projected[index * 2 + 1]!
  }
  centerX /= count
  centerY /= count

  for (let index = 0; index < count; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    const u = columns > 1 ? column / (columns - 1) : 0
    const v = rows > 1 ? row / (rows - 1) : 0
    const height = heights[index]!
    // 半影随高度变宽；上限压住，免得高飞的纸把影子摊成一整页灰。
    const inflate = 1 + FLIP_SHADOW_BASE_INFLATE + Math.min(0.2, height * 1)
    const offset = index * 3
    const shadowX = centerX + (projected[index * 2]! - centerX) * inflate
    const shadowY = centerY + (projected[index * 2 + 1]! - centerY) * inflate
    positions[offset] = shadowX
    positions[offset + 1] = shadowY
    positions[offset + 2] = shadowZ
    const edge = Math.min(u, 1 - u, v, 1 - v)
    // 影子网格的边界是外扩后的轮廓：透明度收到 0，边缘才是渐隐的半影而不是一圈硬边。
    const edgeFade = smoothstep(0, 0.08, edge)
    // 书脊侧（u≈0）纸是钉住的、离桌面最近：影子收到 0，不能画到纸上。
    const spineFade = smoothstep(0, 0.05, u)
    const heightFade = 1 - Math.min(0.5, height * 1.8)
    const inBounds = !options.bounds || (
      shadowX >= options.bounds.minX && shadowX <= options.bounds.maxX
      && shadowY >= options.bounds.minY && shadowY <= options.bounds.maxY
    )
    alpha[index] = inBounds
      ? FLIP_SHADOW_DENSITY * envelope * edgeFade * spineFade * heightFade
      : 0
  }
  return { positions, alpha }
}
/** 影子覆盖范围的低分辨率栅格：多张纸同飞时用它查「这张纸被上面的纸盖住多少」。 */
export interface FlipShadowGrid {
  columns: number
  rows: number
  minX: number
  maxX: number
  minY: number
  maxY: number
  /** 每个格子的最大不透明度。 */
  alpha: Float32Array
}

export interface FlipShadowGridOptions {
  columns: number
  rows: number
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/**
 * 把一张飞页的影子网格栅格化成覆盖率。
 *
 * 影子网格的顶点比栅格密得多，直接落格就能盖住；同格取最大值，
 * 多张纸叠在一起时不会越叠越黑（纸影本身不该非线性累加）。
 */
export function rasterizeFlipShadow(
  positions: ArrayLike<number>,
  alpha: ArrayLike<number>,
  options: FlipShadowGridOptions,
): FlipShadowGrid {
  const columns = Math.max(2, Math.floor(options.columns))
  const rows = Math.max(2, Math.floor(options.rows))
  const grid: FlipShadowGrid = {
    columns,
    rows,
    minX: options.minX,
    maxX: options.maxX,
    minY: options.minY,
    maxY: options.maxY,
    alpha: new Float32Array(columns * rows),
  }
  const spanX = grid.maxX - grid.minX
  const spanY = grid.maxY - grid.minY
  if (!(spanX > 0) || !(spanY > 0)) return grid
  const count = Math.min(Math.floor(positions.length / 3), alpha.length)
  for (let index = 0; index < count; index += 1) {
    const value = Number(alpha[index] ?? 0)
    if (!(value > 0)) continue
    const x = Number(positions[index * 3] ?? 0)
    const y = Number(positions[index * 3 + 1] ?? 0)
    if (x < grid.minX || x > grid.maxX || y < grid.minY || y > grid.maxY) continue
    const column = Math.round(((x - grid.minX) / spanX) * (columns - 1))
    const row = Math.round(((y - grid.minY) / spanY) * (rows - 1))
    const offset = row * columns + column
    if (value > (grid.alpha[offset] ?? 0)) grid.alpha[offset] = value
  }
  return grid
}

/** 双线性采样影子覆盖率；落在书页外返回 0。 */
export function sampleFlipShadowGrid(grid: FlipShadowGrid, x: number, y: number): number {
  if (x < grid.minX || x > grid.maxX || y < grid.minY || y > grid.maxY) return 0
  const spanX = grid.maxX - grid.minX
  const spanY = grid.maxY - grid.minY
  if (!(spanX > 0) || !(spanY > 0)) return 0
  const fx = ((x - grid.minX) / spanX) * (grid.columns - 1)
  const fy = ((y - grid.minY) / spanY) * (grid.rows - 1)
  const c0 = Math.max(0, Math.min(grid.columns - 1, Math.floor(fx)))
  const c1 = Math.max(0, Math.min(grid.columns - 1, c0 + 1))
  const r0 = Math.max(0, Math.min(grid.rows - 1, Math.floor(fy)))
  const r1 = Math.max(0, Math.min(grid.rows - 1, r0 + 1))
  const tx = Math.min(1, fx - c0)
  const ty = Math.min(1, fy - r0)
  const v00 = grid.alpha[r0 * grid.columns + c0] ?? 0
  const v10 = grid.alpha[r0 * grid.columns + c1] ?? 0
  const v01 = grid.alpha[r1 * grid.columns + c0] ?? 0
  const v11 = grid.alpha[r1 * grid.columns + c1] ?? 0
  const top = v00 * (1 - tx) + v10 * tx
  const bottom = v01 * (1 - tx) + v11 * tx
  return top * (1 - ty) + bottom * ty
}
