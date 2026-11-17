/**
 * 飞页正文的 DOM 分片与贴面变换。
 *
 * 静态页的正文已经在 DOM 文本层里，飞页此前只能靠纹理带字：纸一卷，纹理一起弯，
 * 但字是位图，放大看会发软。这里把飞页的每一行再切成小段，按纸面在每段处的
 * 局部仿射逐段贴上去——字是矢量的，同时跟着纸的卷曲走。
 *
 * 纯函数，不依赖 DOM 与 Three.js，方便单测。
 */

import type { PageTextureLine } from './realBookTexture'

/** 飞页上的一小段正文（同一行按宽度切开）。 */
export interface FlyerTextPiece {
  text: string
  /** 段落原始下标：与静态页的 data-p 同一套编号。 */
  paragraphIndex: number
  /** 段内起始字符：与静态页的 data-start 同一套编号。 */
  start: number
  /** 页面逻辑坐标（640×920 的页心坐标）。 */
  x: number
  y: number
  width: number
  height: number
}

export interface FlyerScreenPoint {
  x: number
  y: number
}

/** 飞页两个面各自该印哪一页、用哪一侧版心。 */
export interface FlyerFacePage<T> {
  /** 1 = 正面网格（弧的起点，右页平躺），-1 = 纸背网格（弧的终点，左页平躺）。 */
  face: 1 | -1
  page: T | null
  side: 'left' | 'right'
}

/**
 * 飞页两张页心到两个面的分配。
 *
 * 弧面永远从「右页平躺、正面朝上」量到「左页平躺、纸背朝上」，所以正面网格一定印右页、
 * 纸背网格一定印左页，与翻页方向无关。往回翻是同一段弧的**倒放**：进度 0 对应弧的终点
 * （纸背朝上的左页），此时朝上的纸背印的才是这一页本身（`front`）。两页不互换的话，
 * 起手会闪出上一张右页的内容，落定后又跳回它。
 */
export function flyerFacePages<T>(
  direction: 1 | -1,
  front: T | null,
  back: T | null,
): [FlyerFacePage<T>, FlyerFacePage<T>] {
  return direction === 1
    ? [{ face: 1, page: front, side: 'right' }, { face: -1, page: back, side: 'left' }]
    : [{ face: 1, page: back, side: 'right' }, { face: -1, page: front, side: 'left' }]
}

export interface FlyerSplitOptions {
  /** 每段最宽多少逻辑像素。越窄越贴合弧面，代价是 DOM 片段更多。 */
  maxWidth?: number
  /** 每段最多几个字（宽字符的兜底上限）。 */
  maxChars?: number
}

/**
 * 一行切段的上限：4 个汉字约 88px，弧面在一段内的弯曲不到 1px；
 * 再加宽会让纸卷得最急的位置出现肉眼可见的折线。
 */
export const FLYER_PIECE_MAX_WIDTH = 96
export const FLYER_PIECE_MAX_CHARS = 6

/**
 * 把一行正文切成小段。
 *
 * 断点只落在字与字之间（不切半个字），每段的横向位置由累计字宽给出；
 * `measure` 必须与静态页量宽用的是同一套字体（canvas.measureText）。
 */
export function splitFlyerLine(
  line: Pick<PageTextureLine, 'text' | 'x' | 'y' | 'height' | 'paragraphIndex' | 'start'>,
  measure: (text: string) => number,
  options: FlyerSplitOptions = {},
): FlyerTextPiece[] {
  const text = line.text ?? ''
  if (!text) return []
  const maxWidth = Number.isFinite(options.maxWidth) && (options.maxWidth as number) > 0
    ? (options.maxWidth as number)
    : FLYER_PIECE_MAX_WIDTH
  const maxChars = Number.isFinite(options.maxChars) && (options.maxChars as number) > 0
    ? Math.max(1, Math.floor(options.maxChars as number))
    : FLYER_PIECE_MAX_CHARS
  const pieces: FlyerTextPiece[] = []
  let index = 0
  while (index < text.length) {
    let end = index + 1
    // 至少带一个字：单字比 maxWidth 还宽时也得画，不能死循环。
    while (
      end < text.length
      && end - index < maxChars
      && measure(text.slice(index, end + 1)) <= maxWidth
    ) {
      end += 1
    }
    const chunk = text.slice(index, end)
    pieces.push({
      text: chunk,
      paragraphIndex: line.paragraphIndex,
      start: line.start + index,
      x: line.x + measure(text.slice(0, index)),
      y: line.y,
      width: measure(chunk),
      height: line.height,
    })
    index = end
  }
  return pieces
}

/**
 * 用纸面上一段的「原点 + 两条边」换算出 CSS matrix3d。
 *
 * 入参是同一段文字在屏幕上的三个角：左上（origin）、右上（xEdge）、左下（yEdge）。
 * 返回 null 表示这一段在屏幕上已经侧成一条线（或坐标失效），这一帧不必画。
 */
export function flyerPieceMatrix(
  origin: FlyerScreenPoint,
  xEdge: FlyerScreenPoint,
  yEdge: FlyerScreenPoint,
  width: number,
  height: number,
): string | null {
  if (!(width > 0) || !(height > 0)) return null
  const ax = xEdge.x - origin.x
  const ay = xEdge.y - origin.y
  const bx = yEdge.x - origin.x
  const by = yEdge.y - origin.y
  if (![ax, ay, bx, by, origin.x, origin.y].every((value) => Number.isFinite(value))) return null
  // 纸面侧对镜头时投影面积趋近 0：继续贴会把字拉成一道墨线。
  if (Math.abs(ax * by - ay * bx) < 0.5) return null
  const m00 = ax / width
  const m10 = ay / width
  const m01 = bx / height
  const m11 = by / height
  return `matrix3d(${m00},${m10},0,0,${m01},${m11},0,0,0,0,1,0,${origin.x},${origin.y},0,1)`
}
