import { describe, expect, it } from 'vitest'
import {
  LARGE_CHAPTER_PLAIN_DECORATE_GATE_MS,
  measureLargeChapterRender,
  shouldOptimizeLargeChapter,
} from './readerPerf'

function expectFiniteNonNegative(ms: number): void {
  expect(Number.isFinite(ms)).toBe(true)
  expect(ms).toBeGreaterThanOrEqual(0)
}

describe('shouldOptimizeLargeChapter', () => {
  it('treats the 100ms gate as exclusive: at the gate, do not optimize', () => {
    expect(LARGE_CHAPTER_PLAIN_DECORATE_GATE_MS).toBe(100)
    expect(shouldOptimizeLargeChapter(100)).toBe(false)
    expect(shouldOptimizeLargeChapter(99)).toBe(false)
    expect(shouldOptimizeLargeChapter(0)).toBe(false)
    expect(shouldOptimizeLargeChapter(Number.NaN)).toBe(false)
    expect(shouldOptimizeLargeChapter(Number.POSITIVE_INFINITY)).toBe(false)
    expect(shouldOptimizeLargeChapter(101)).toBe(true)
  })
})

describe('measureLargeChapterRender', () => {
  it('runs a real 10_000-paragraph decorate measurement', { timeout: 30_000 }, () => {
    const sample = measureLargeChapterRender(10_000)

    expect(sample.paragraphCount).toBe(10_000)
    expectFiniteNonNegative(sample.splitMs)
    expectFiniteNonNegative(sample.plainDecorateMs)
    expectFiniteNonNegative(sample.searchDecorateMs)
    expectFiniteNonNegative(sample.highlightDecorateMs)

    expect(sample.shouldOptimize).toBe(shouldOptimizeLargeChapter(sample.plainDecorateMs))
    expect(sample.shouldOptimize).toBe(sample.plainDecorateMs > 100)

    // 记录本次机器上的门判定；不把耗时写死成必须 <100。
    // 门未触发则本切片不得改 Reader 渲染策略。
    const policy = sample.shouldOptimize
      ? 'optimize-allowed'
      : 'gate-not-triggered-do-not-optimize'
    console.info('P2.3 large-chapter perf sample', {
      paragraphCount: sample.paragraphCount,
      splitMs: sample.splitMs,
      plainDecorateMs: sample.plainDecorateMs,
      searchDecorateMs: sample.searchDecorateMs,
      highlightDecorateMs: sample.highlightDecorateMs,
      shouldOptimizeLargeChapter: sample.shouldOptimize,
      policy,
    })
    expect(policy).toBe(
      shouldOptimizeLargeChapter(sample.plainDecorateMs)
        ? 'optimize-allowed'
        : 'gate-not-triggered-do-not-optimize',
    )
  })
})
