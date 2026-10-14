/**
 * 阅读模式自动滚动：纯计算 + 可注入的推进节奏，方便单测。
 * 渲染侧每帧调 `tick(dt)`，这里只负责位移与到端处理。
 */
export const AUTO_SCROLL_SPEEDS = [12, 20, 32, 48, 72] as const

/** 档位 1–5 映射到每秒像素；越界夹紧，非数值按最慢档。 */
export function autoScrollSpeedPx(speed: number): number {
  const value = Number.isFinite(speed) ? Math.round(speed) : 1
  const index = Math.max(1, Math.min(AUTO_SCROLL_SPEEDS.length, value)) - 1
  return AUTO_SCROLL_SPEEDS[index]
}

export interface AutoScrollEndInput {
  scrollTop: number
  delta: number
  scrollHeight: number
  viewportHeight: number
}

/** 推进后的滚动位置；贴底时标记到端。 */
export function nextAutoScrollTop(input: AutoScrollEndInput): { top: number; reachedEnd: boolean } {
  const max = Math.max(0, input.scrollHeight - input.viewportHeight)
  const top = input.scrollTop + Math.max(0, input.delta)
  if (top >= max) return { top: max, reachedEnd: true }
  return { top, reachedEnd: false }
}

export interface AutoScrollSource {
  scrollTop(): number
  scrollHeight(): number
  viewportHeight(): number
  setScrollTop(value: number): void
  /**
   * 到底了：翻页或续下一章。
   * 返回 true 表示已经接上（继续滚），false 表示没有下文（自动滚动停下）。
   */
  onReachEnd(): boolean
  onTick?(scrollTop: number): void
}

export interface AutoScroll {
  start(): void
  stop(): void
  running(): boolean
  /** 推进 dtMs 毫秒；返回是否仍在运行。 */
  tick(dtMs: number): boolean
}

export function createAutoScroll(source: AutoScrollSource, options: { speedPx: () => number }): AutoScroll {
  let running = false
  // 低速档每帧不足 1px，余量留着累加，否则会被取整吃掉。
  let carry = 0
  return {
    running: () => running,
    start: () => {
      running = true
      carry = 0
    },
    stop: () => {
      running = false
    },
    tick: (dtMs: number) => {
      if (!running) return false
      carry += (options.speedPx() * Math.max(0, dtMs)) / 1000
      const whole = Math.floor(carry)
      if (whole <= 0) return true
      carry -= whole
      const { top, reachedEnd } = nextAutoScrollTop({
        scrollTop: source.scrollTop(),
        delta: whole,
        scrollHeight: source.scrollHeight(),
        viewportHeight: source.viewportHeight(),
      })
      source.setScrollTop(top)
      source.onTick?.(top)
      if (reachedEnd && !source.onReachEnd()) {
        running = false
        return false
      }
      return running
    },
  }
}
