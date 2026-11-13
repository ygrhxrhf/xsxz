/**
 * 真实书籍的纸垛模型：把整本书规模与全书进度换算成连续厚度。
 *
 * 纸垛不是固定 8 层：短书与长书的基础厚度不同；阅读进度只是在同一份总厚度
 * 上把纸从右侧连续转移到左侧。翻页时再对进度做一小段连续插值，避免整数层数
 * 在落页瞬间跳变。
 */

export const MIN_SPINE_LAYERS = 3
export const MAX_SPINE_LAYERS = 12
export const SPINE_LAYER_SPACING_PX = 1.8
/** 每层纸的纵深（px）：参考书是纸页本身，不是一块厚砖，纸垛只留几像素的边。 */
export const SPINE_LAYER_DEPTH_PX = 1.6

/** 正文字符数对应的视觉厚度：以 10 万字作为中等厚度基准。 */
const CHARS_PER_LAYER = 5_000

export interface SpineStack {
  /** 书的总视觉层数（可为小数，CSS 进深用它） */
  total: number
  /** 左侧已读厚度（层） */
  read: number
  /** 右侧未读厚度（层） */
  remaining: number
}

export interface SpineLayer {
  /** 第几层（0 起） */
  index: number
  /** 纵向偏移（px） */
  translateY: number
  /** 纵深偏移（px） */
  translateZ: number
  /** 越深的层越淡 */
  opacity: number
}

export interface SpineLayerOptions {
  /** 1 = 向下（剩余侧），-1 = 向上（已读侧） */
  direction?: 1 | -1
  /** 层间距（px） */
  spacing?: number
  /** 纵深间距（px） */
  depth?: number
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

/** 正文规模 → 总视觉厚度；空正文仍显示一本薄书。 */
export function spineTotalLayers(totalChars: number, maxLayers = MAX_SPINE_LAYERS): number {
  const max = Number.isFinite(maxLayers) && maxLayers > 0 ? maxLayers : MAX_SPINE_LAYERS
  const chars = Number.isFinite(totalChars) ? Math.max(0, totalChars) : 0
  return Math.max(MIN_SPINE_LAYERS, Math.min(max, MIN_SPINE_LAYERS + Math.sqrt(chars / CHARS_PER_LAYER)))
}

/** 总厚度 + 全书进度 → 左右连续纸垛厚度。 */
export function spineStack(totalChars: number, progress: number, maxLayers = MAX_SPINE_LAYERS): SpineStack {
  const total = spineTotalLayers(totalChars, maxLayers)
  const ratio = clamp01(progress)
  return { total, read: total * ratio, remaining: total * (1 - ratio) }
}

/**
 * 只渲染可见的纸层，CSS 的块进深使用连续 read/remaining，
 * 所以层数从 4.2 变成 4.3 时不会突然多出一张纸。
 */
export function spineLayers(count: number, options: SpineLayerOptions = {}): SpineLayer[] {
  const spacing = Number.isFinite(options.spacing) && (options.spacing as number) > 0
    ? options.spacing as number : SPINE_LAYER_SPACING_PX
  const depth = Number.isFinite(options.depth) && (options.depth as number) > 0
    ? options.depth as number : SPINE_LAYER_DEPTH_PX
  const direction = options.direction === -1 ? -1 : 1
  const total = Math.max(0, Math.min(MAX_SPINE_LAYERS, Math.ceil(Number.isFinite(count) ? count : 0)))
  return Array.from({ length: total }, (_, index) => ({
    index,
    translateY: direction * (index + 1) * spacing,
    translateZ: -(index + 1) * depth,
    opacity: Math.max(0.55, 1 - index * 0.05),
  }))
}
