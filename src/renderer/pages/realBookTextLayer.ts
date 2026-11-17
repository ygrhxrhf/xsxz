/**
 * WebGL 书页上的透明 DOM 文本层投影。
 *
 * Three.js 只认纹理，不认 DOM。选字、跨页选择、页内批注命中都需要 DOM 文本节点，
 * 所以这里把 4 个页角的屏幕投影换算成 CSS `matrix3d`，让透明文字层贴在弯曲纸面上。
 * 纯函数，不依赖 DOM，方便单测。
 */

import type { PageTextureLine } from './realBookTexture'

export interface ScreenPoint {
  x: number
  y: number
}

export type PageScreenQuad = [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint]

/** 解 8x8 线性方程组；失败时返回 null。 */
function solveLinearSystem(matrix: number[][], rhs: number[]): number[] | null {
  const size = rhs.length
  const a = matrix.map((row, rowIndex) => [...row, rhs[rowIndex]!])
  for (let col = 0; col < size; col += 1) {
    let pivot = col
    for (let row = col + 1; row < size; row += 1) {
      if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row
    }
    if (Math.abs(a[pivot]![col]!) < 1e-12) return null
    if (pivot !== col) {
      const tmp = a[col]!
      a[col] = a[pivot]!
      a[pivot] = tmp
    }
    for (let row = col + 1; row < size; row += 1) {
      const factor = a[row]![col]! / a[col]![col]!
      for (let k = col; k <= size; k += 1) a[row]![k] = a[row]![k]! - factor * a[col]![k]!
    }
  }
  const out = new Array<number>(size).fill(0)
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = a[row]![size]!
    for (let col = row + 1; col < size; col += 1) sum -= a[row]![col]! * out[col]!
    out[row] = sum / a[row]![row]!
  }
  return out
}

/**
 * 由 4 组对应点求 2D 单应（源点 logical page 0..W/0..H，目标点屏幕像素）。
 * 返回 `[h00,h01,h02,h10,h11,h12,h20,h21,h22]`，h22 归一为 1。
 */
export function homographyFromQuad(src: PageScreenQuad, dst: PageScreenQuad): number[] | null {
  if (!src || !dst || src.length < 4 || dst.length < 4) return null
  const matrix: number[][] = []
  const rhs: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const [sx, sy] = [src[i]!.x, src[i]!.y]
    const [dx, dy] = [dst[i]!.x, dst[i]!.y]
    matrix.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy])
    rhs.push(dx)
    matrix.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy])
    rhs.push(dy)
  }
  const solved = solveLinearSystem(matrix, rhs)
  if (!solved) return null
  const h00 = solved[0]!
  const h01 = solved[1]!
  const h02 = solved[2]!
  const h10 = solved[3]!
  const h11 = solved[4]!
  const h12 = solved[5]!
  const h20 = solved[6]!
  const h21 = solved[7]!
  return [h00, h01, h02, h10, h11, h12, h20, h21, 1]
}

/** 把页角投影换算成 CSS matrix3d；点共线或不可逆时回退到单位矩阵。 */
export function quadToMatrix3d(src: PageScreenQuad, dst: PageScreenQuad): string {
  const h = homographyFromQuad(src, dst)
  if (!h) return 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)'
  const [h00, h01, h02, h10, h11, h12, h20, h21, h22] = h
  return `matrix3d(${h00},${h10},0,${h20},${h01},${h11},0,${h21},0,0,1,0,${h02},${h12},0,${h22})`
}

/** 一行里的一段划线底色（页面逻辑坐标）。 */
export interface PageMarkRect {
  x: number
  y: number
  width: number
  height: number
  color: string
}

/**
 * 划线与搜索高亮的底色块。
 *
 * 几何与 `drawPageTexture` 逐项一致：左右各外扩 1px，纵向取行盒的 18%–92%，
 * 半透明色块压在字下面。走 DOM 的页面用它画，纹理里不再重复。
 */
export function highlightRects(
  lines: readonly PageTextureLine[],
  measure: (text: string) => number,
): PageMarkRect[] {
  const out: PageMarkRect[] = []
  for (const line of lines) {
    for (const mark of line.marks) {
      const before = measure(line.text.slice(0, mark.start))
      const width = measure(line.text.slice(mark.start, mark.end))
      out.push({
        x: line.x + before - 1,
        y: line.y + line.height * 0.18,
        width: Math.max(1, width + 2),
        height: line.height * 0.74,
        color: mark.color,
      })
    }
  }
  return out
}

/** 段内「注」点：圆心在行基线上方 0.28em，直径随字号。 */
export interface PageNoteDot {
  x: number
  y: number
  diameter: number
  fontSize: number
}

export function noteDots(
  lines: readonly PageTextureLine[],
  fontSize: number,
  measure: (text: string) => number,
): PageNoteDot[] {
  const base = Math.max(8, fontSize)
  const out: PageNoteDot[] = []
  for (const line of lines) {
    for (const offset of line.noteMarks) {
      const before = measure(line.text.slice(0, offset))
      out.push({
        x: line.x + before + Math.max(2, base * 0.34),
        y: line.y + line.height * 0.76 - base * 0.28,
        diameter: Math.max(3, base * 0.18) * 2,
        fontSize: Math.max(5, base * 0.22),
      })
    }
  }
  return out
}
