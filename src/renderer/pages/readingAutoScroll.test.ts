import { describe, expect, it } from 'vitest'
import { AUTO_SCROLL_SPEEDS, autoScrollSpeedPx, createAutoScroll, nextAutoScrollTop } from './readingAutoScroll'

describe('auto scroll speed mapping', () => {
  it('maps 1-5 to px per second and clamps out of range', () => {
    expect(AUTO_SCROLL_SPEEDS).toHaveLength(5)
    expect(autoScrollSpeedPx(1)).toBe(12)
    expect(autoScrollSpeedPx(3)).toBe(32)
    expect(autoScrollSpeedPx(5)).toBe(72)
    expect(autoScrollSpeedPx(0)).toBe(AUTO_SCROLL_SPEEDS[0])
    expect(autoScrollSpeedPx(99)).toBe(AUTO_SCROLL_SPEEDS[AUTO_SCROLL_SPEEDS.length - 1])
    expect(autoScrollSpeedPx(Number.NaN)).toBe(AUTO_SCROLL_SPEEDS[0])
  })
})

describe('nextAutoScrollTop', () => {
  it('advances by the delta and clamps at the bottom', () => {
    expect(nextAutoScrollTop({ scrollTop: 10, delta: 5, scrollHeight: 1000, viewportHeight: 400 }))
      .toEqual({ top: 15, reachedEnd: false })
    expect(nextAutoScrollTop({ scrollTop: 590, delta: 30, scrollHeight: 1000, viewportHeight: 400 }))
      .toEqual({ top: 600, reachedEnd: true })
  })

  it('never scrolls above the top and never ends on a short page', () => {
    expect(nextAutoScrollTop({ scrollTop: 0, delta: -20, scrollHeight: 1000, viewportHeight: 400 }).top).toBe(0)
    expect(nextAutoScrollTop({ scrollTop: 0, delta: 10, scrollHeight: 300, viewportHeight: 400 }).reachedEnd).toBe(true)
  })
})

function makeBox(height = 4000, view = 400) {
  const box = { top: 0, height, view }
  return {
    box,
    source: {
      scrollTop: () => box.top,
      scrollHeight: () => box.height,
      viewportHeight: () => box.view,
      setScrollTop: (value: number) => { box.top = value },
      onReachEnd: () => false,
    },
  }
}

describe('createAutoScroll', () => {
  it('does not move until started and stops on demand', () => {
    const { box, source } = makeBox()
    const scroll = createAutoScroll(source, { speedPx: () => 72 })
    expect(scroll.running()).toBe(false)
    scroll.tick(1000)
    expect(box.top).toBe(0)
    scroll.start()
    scroll.tick(1000)
    expect(box.top).toBe(72)
    scroll.stop()
    scroll.tick(1000)
    expect(box.top).toBe(72)
    expect(scroll.running()).toBe(false)
  })

  it('accumulates sub-pixel motion instead of dropping it', () => {
    const { box, source } = makeBox()
    const scroll = createAutoScroll(source, { speedPx: () => 12 })
    scroll.start()
    for (let i = 0; i < 100; i++) scroll.tick(100)
    // 12px/秒 × 10 秒；浮点累加允许最后不到 1px 的误差
    expect(box.top).toBeGreaterThanOrEqual(118)
    expect(box.top).toBeLessThanOrEqual(120)
  })

  it('keeps running when the end handler continues to the next chapter', () => {
    const { box, source } = makeBox(450, 400)
    let continued = 0
    const scroll = createAutoScroll(
      { ...source, onReachEnd: () => { continued++; box.top = 0; return true } },
      { speedPx: () => 72 },
    )
    scroll.start()
    scroll.tick(1000)
    expect(continued).toBe(1)
    expect(box.top).toBe(0)
    expect(scroll.running()).toBe(true)
  })

  it('stops when the end handler has nowhere to go', () => {
    const { box, source } = makeBox(500, 400)
    const scroll = createAutoScroll(source, { speedPx: () => 72 })
    scroll.start()
    expect(scroll.tick(1000)).toBe(true)
    expect(scroll.tick(1000)).toBe(false)
    expect(box.top).toBe(100)
    expect(scroll.running()).toBe(false)
  })

  it('reports the new scroll position to the caller', () => {
    const { source } = makeBox()
    const seen: number[] = []
    const scroll = createAutoScroll({ ...source, onTick: (top) => seen.push(top) }, { speedPx: () => 72 })
    scroll.start()
    scroll.tick(1000)
    scroll.tick(1000)
    expect(seen).toEqual([72, 144])
  })
})
