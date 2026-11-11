/**
 * 书脊弧面的二维投影几何（实验用，与 `RealBookStage.vue` 解耦）。
 *
 * ## 为什么需要这一层
 *
 * 3D `rotateY` 方案在真实渲染里失败过两次：竖带的投影宽度比纸面短，
 * 端点贴不到中线；页面自身的 9° 折角又把覆盖进一步压短。屏幕坐标量测显示
 * 六条带投影合计只到 681.5px，而中线在 682.8px，永远差一截露出桌面。
 *
 * 这一层把同一件事改成**纯二维积分 + 按投影宽度反向补偿**：
 * 纸面在谷区里倾斜 θ(u)，屏幕上的横向长度按 ∫cosθ du 缩短；
 * 再把整行按 `页面宽 / 投影总长` 等比拉回去，于是整页正好铺满自己的宽度，
 * 不会再有「差几像素」的缝。倾斜带来的压缩量由每段自己的投影宽度承担。
 *
 * ## 视觉上的弯曲从哪来
 *
 * 横向压缩只让靠脊那一小段变窄，肉眼几乎看不出弯。真正读成「弧」的是
 * 基线在谷区的下沉（`dip`）：纸向书脊塌下去，字行跟着往下弯一小段。
 * 两者合起来，才是参考图里那种「字沿弧面走」的读感。
 */

export interface ArcSegment {
  /** 该段在屏幕上的左缘（px，从页面左缘算） */
  x: number
  /** 该段在屏幕上的宽度（px，已按投影压缩并整体补偿） */
  width: number
  /** 该段占纸面宽度的比例（0–1）：用来把整行文字按纸面比例切段 */
  share: number
  /** 该段中点的基线纵向偏移（px，正值向下）：谷区下沉量 */
  dip: number
  /** 该段中点的纸面倾角（deg） */
  angle: number
}

export interface ArcLineOptions {
  /** 整页宽度（px） */
  pageWidth: number
  /** 谷区宽度（px）：从书脊向外这一段纸是弯的 */
  valleyWidth: number
  /** 谷底倾角（deg）：书脊处的最大倾角 */
  valleyDeg: number
  /** 谷底基线最多下沉多少（px） */
  dipPx?: number
  /** 一行切成几段（段越多弧越顺） */
  segments?: number
  /** 书脊在页面的哪一侧 */
  spineAt: 'left' | 'right'
}

/** 倾角沿谷方向衰减的指数：越大越集中到书脊那一小段。 */
const ANGLE_FALLOFF = 1.5
/** 积分采样数：64 段对一页宽度已经足够，误差远小于 1px。 */
const INTEGRATE_STEPS = 64
const DEFAULT_SEGMENTS = 8
const DEFAULT_DIP_PX = 9

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

/** 距离书脊 u 处的纸面倾角（deg）。u ≥ 谷宽时纸已摊平。 */
export function arcAngleAt(u: number, valleyWidth: number, valleyDeg: number): number {
  if (!Number.isFinite(u) || !Number.isFinite(valleyWidth) || !Number.isFinite(valleyDeg)) return 0
  if (!(valleyWidth > 0) || u >= valleyWidth || u < 0) return 0
  return valleyDeg * Math.pow(1 - u / valleyWidth, ANGLE_FALLOFF)
}

/**
 * 从页面左缘到 a 的**投影**长度：∫cosθ。
 *
 * 书脊在右时，距脊距离随 a 增大而减小，所以用 `pageWidth - t` 取距离。
 * 这个函数只做数值积分，不依赖任何 DOM，单测可以钉住它的单调性。
 */
export function arcProjectedAt(
  a: number,
  pageWidth: number,
  valleyWidth: number,
  valleyDeg: number,
  spineAt: 'left' | 'right',
): number {
  if (!(a > 0)) return 0
  const width = Math.max(0, pageWidth)
  const clampA = Math.min(a, width)
  let sum = 0
  for (let index = 0; index < INTEGRATE_STEPS; index += 1) {
    const t = (clampA * (index + 0.5)) / INTEGRATE_STEPS
    const u = spineAt === 'left' ? t : width - t
    sum += Math.cos((arcAngleAt(u, valleyWidth, valleyDeg) * Math.PI) / 180)
  }
  return (sum / INTEGRATE_STEPS) * clampA
}

/**
 * 一整行的弧面分段：从页面左缘到右缘，按纸面等宽切段，给出每段的屏幕位置与下沉量。
 *
 * 关键不变量：所有段的 `width` 之和等于 `pageWidth`（浮点误差内）。
 * 有了这一条，页面就不会在书脊处露出背景——那正是 3D 方案栽的地方。
 */
export function arcLineSegments(options: ArcLineOptions): ArcSegment[] {
  const pageWidth = Math.max(0, Number.isFinite(options.pageWidth) ? options.pageWidth : 0)
  if (pageWidth <= 0) return []
  const valleyWidth = clamp(options.valleyWidth, 0, pageWidth)
  const valleyDeg = clamp(options.valleyDeg, 0, 60)
  const dipPx = Number.isFinite(options.dipPx as number) ? Math.max(0, options.dipPx as number) : DEFAULT_DIP_PX
  const segments = Number.isFinite(options.segments as number) && (options.segments as number) >= 1
    ? Math.min(64, Math.floor(options.segments as number))
    : DEFAULT_SEGMENTS
  const spineAt = options.spineAt === 'left' ? 'left' : 'right'

  // 整页投影总长 < pageWidth：把差距按比例摊回去，端点才正好落在页缘。
  const total = arcProjectedAt(pageWidth, pageWidth, valleyWidth, valleyDeg, spineAt)
  const stretch = total > 0 ? pageWidth / total : 1
  const step = pageWidth / segments

  const out: ArcSegment[] = []
  for (let index = 0; index < segments; index += 1) {
    const a0 = index * step
    const a1 = index === segments - 1 ? pageWidth : (index + 1) * step
    const x0 = arcProjectedAt(a0, pageWidth, valleyWidth, valleyDeg, spineAt) * stretch
    const x1 = arcProjectedAt(a1, pageWidth, valleyWidth, valleyDeg, spineAt) * stretch
    const mid = (a0 + a1) / 2
    // 下沉取该段**最靠书脊**的那一点：基线最低处就在书脊边上，
    // 用段中点会系统性低估，让谷底永远沉不到设定深度。
    const nearestToSpine = spineAt === 'left' ? a0 : pageWidth - a1
    const u = Math.max(0, nearestToSpine)
    const falloff = valleyWidth > 0 && u < valleyWidth ? 1 - u / valleyWidth : 0
    out.push({
      x: x0,
      width: x1 - x0,
      share: (a1 - a0) / pageWidth,
      dip: dipPx * falloff * falloff,
      angle: arcAngleAt(spineAt === 'left' ? mid : pageWidth - mid, valleyWidth, valleyDeg),
    })
  }
  return out
}

/**
 * 把一行文字按纸面比例切成与分段等长的字符区间。
 *
 * 中文正文近似等宽，按段数均分即可；末尾不足一段的字并进最后一段，
 * 保证拼起来与原文完全一致（一个字都不丢）。
 */
export function splitLineBySegments(text: string, segments: number): string[] {
  const count = Number.isFinite(segments) && segments >= 1 ? Math.floor(segments) : DEFAULT_SEGMENTS
  if (!text.length) return Array.from({ length: count }, () => '')
  const per = Math.ceil(text.length / count)
  const out: string[] = []
  for (let index = 0; index < count; index += 1) {
    out.push(text.slice(index * per, (index + 1) * per))
  }
  return out
}

/**
 * 行内高亮／搜索命中的区间，坐标是**段落内的字符偏移**。
 *
 * 与 `RealBookStage` 用的是同一套局部坐标（`decorateText` 的输出），
 * 所以在经典模式里已经算对的高亮与命中，拿到弧面上后不必重新换算。
 */
export interface ArcRange {
  start: number
  end: number
  /** hit = 搜索命中；hl = 划线 */
  kind: 'hit' | 'hl'
  color?: string
}

/** 一个可直接摆到 SVG 里的文字片段。 */
export interface ArcRun {
  /** 该片段在页面上的左缘（px，从页左缘算） */
  x: number
  /** 该片段的屏幕宽度（px，带 textLength 用） */
  width: number
  /** 该片段中点的基线纵向偏移（px）：谷区下沉量。逐片段取，整行才会沿弧面弯 */
  dip: number
  text: string
  kind: 'plain' | 'hit' | 'hl'
  color?: string
}

/**
 * 把一行文字切成可直接渲染的弧面文字片段：先按弧面分段，再在每段内按高亮边界切开。
 *
 * 为什么不能只按弧面分段：一个高亮区间常常跨过段边界，若只按段渲染，
 * 高亮就只能整段底色或完全不上色。这里把「段」与「高亮边界」两套切点取并集，
 * 于是高亮范围能精确到字，而每段的屏幕宽度仍由弧面几何给定。
 *
 * 宽度分配：段内各片段按**字符数比例**均分该段宽度，最后一片吃掉余数，
 * 所以各片段宽度之和严格等于段落宽度。中文正文近似等宽，这个近似与
 * `splitLineBySegments` 用的是同一个假设（有单测钉住）。
 */
export function layoutArcRuns(
  lineText: string,
  lineStart: number,
  bands: ArcSegment[],
  ranges: readonly ArcRange[] = [],
): ArcRun[] {
  if (!lineText.length || !bands.length) return []
  const lineEnd = lineStart + lineText.length
  const applicable = ranges
    .map((range) => ({
      ...range,
      start: Math.max(range.start, lineStart),
      end: Math.min(range.end, lineEnd),
    }))
    .filter((range) => range.end > range.start)

  const per = Math.ceil(lineText.length / bands.length)
  const out: ArcRun[] = []

  bands.forEach((band, bandIndex) => {
    const partStart = bandIndex * per
    const partEnd = Math.min(lineText.length, partStart + per)
    if (partEnd <= partStart) return
    const partText = lineText.slice(partStart, partEnd)
    const absStart = lineStart + partStart
    const absEnd = lineStart + partEnd

    // 该段内的高亮边界（转成段内偏移）。
    const points = new Set<number>([0, partText.length])
    for (const range of applicable) {
      if (range.end <= absStart || range.start >= absEnd) continue
      points.add(Math.max(0, range.start - absStart))
      points.add(Math.min(partText.length, range.end - absStart))
    }
    const sorted = [...points].sort((a, b) => a - b)

    for (let index = 0; index < sorted.length - 1; index += 1) {
      const from = sorted[index]!
      const to = sorted[index + 1]!
      if (to <= from) continue
      const abs = absStart + from
      const hit = applicable.some((range) => range.kind === 'hit' && range.start <= abs && abs < range.end)
      const covered = applicable.find((range) => range.kind === 'hl' && range.start <= abs && abs < range.end)
      const isLast = index === sorted.length - 2
      out.push({
        x: band.x + band.width * (from / partText.length),
        // 最后一片吃掉余数：宽度之和必须严格等于段宽，否则会漏出背景。
        width: isLast
          ? band.x + band.width - (band.x + band.width * (from / partText.length))
          : band.width * ((to - from) / partText.length),
        // 下沉量逐片段从所属弧面带取：整行才会沿弧面弯下去。
        dip: band.dip,
        text: partText.slice(from, to),
        kind: hit ? 'hit' : covered ? 'hl' : 'plain',
        ...(covered?.color ? { color: covered.color } : {}),
      })
    }
  })
  return out.filter((run) => run.text.length > 0 && run.width > 0)
}

/** 划线颜色 → 弧面上的填充色。与经典模式的 `hl-*` 变量同一套色值。 */
export function arcHighlightFill(color: string | undefined): string {
  switch (color) {
    case 'green': return 'rgba(146, 196, 125, 0.45)'
    case 'blue': return 'rgba(130, 170, 220, 0.45)'
    case 'pink': return 'rgba(226, 152, 168, 0.45)'
    default: return 'rgba(242, 216, 135, 0.5)'
  }
}
