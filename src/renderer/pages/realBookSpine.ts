/**
 * 书厚伪页：把「已读 / 剩余」换算成左右两条纸堆的层数与偏移。
 *
 * 为什么单独放一层纯函数：书厚是视觉量，但它的驱动量是阅读进度（页码比例）。
 * 层数、方向、偏移全是可算的数字，写成纯函数就能在 vitest 里钉住边界（比例 0 / 1、
 * 非法值、层数上限），不必靠截图比对。组件只负责把结果铺成 DOM。
 *
 * 规则（方案稿 §5.2）：伪页层数上限 8，左右两侧合计不超过上限；已读侧在左、剩余侧在右。
 */

/** 一侧最多几层伪页（§5.2 的性能护栏）。 */
export const MAX_SPINE_LAYERS = 8
/** 相邻两层伪页的纵向间距（px）。 */
export const SPINE_LAYER_SPACING_PX = 3
/** 相邻两层伪页的纵深间距（px），俯仰时这层差值才让纸堆有厚度。 */
export const SPINE_LAYER_DEPTH_PX = 5

export interface SpineStack {
  /** 左侧（已读）层数 */
  read: number
  /** 右侧（剩余）层数 */
  remaining: number
}

/**
 * 阅读进度 → 上下纸堆层数。
 *
 * 比例是「当前页在章内的位置」：0 = 章首，1 = 章末。两侧层数之和恒等于上限，
 * 所以纸堆总厚度不随章节长短跳变，只随读到哪儿重新分配。
 */
export function spineStack(ratio: number, maxLayers: number = MAX_SPINE_LAYERS): SpineStack {
  const max = Number.isFinite(maxLayers) && maxLayers > 0
    ? Math.floor(maxLayers)
    : MAX_SPINE_LAYERS
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  const read = Math.round(clamped * max)
  return { read, remaining: max - read }
}

export interface SpineLayer {
  /** 第几层（0 起） */
  index: number
  /** 纵向偏移（px）：纸堆自页面下沿向下叠 */
  translateY: number
  /** 纵深偏移（px）：越深的层越靠后，俯仰时才露出层次 */
  translateZ: number
  /** 越深的层越淡，避免边缘糊成一条黑线 */
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

/**
 * 一侧纸堆的逐层偏移。层数超过上限会被截断——调用方传什么都不会渲染出第 9 层。
 */
export function spineLayers(count: number, options: SpineLayerOptions = {}): SpineLayer[] {
  const spacing = Number.isFinite(options.spacing) && (options.spacing as number) > 0
    ? (options.spacing as number)
    : SPINE_LAYER_SPACING_PX
  const depth = Number.isFinite(options.depth) && (options.depth as number) > 0
    ? (options.depth as number)
    : SPINE_LAYER_DEPTH_PX
  const direction = options.direction === -1 ? -1 : 1
  const total = Math.max(0, Math.min(MAX_SPINE_LAYERS, Math.floor(Number.isFinite(count) ? count : 0)))
  const layers: SpineLayer[] = []
  for (let index = 0; index < total; index += 1) {
    layers.push({
      index,
      translateY: direction * (index + 1) * spacing,
      translateZ: -(index + 1) * depth,
      opacity: Math.max(0.55, 1 - index * 0.05),
    })
  }
  return layers
}
