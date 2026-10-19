import { describe, expect, it } from 'vitest'
import { chapterRetryDelayMs, isSiteWallFail, shouldRetryChapterFail } from './download'

// Mirrors the private constants in download.ts; kept here so the test does not
// depend on production exports that exist only for tests.
const BASE_MS = 1_000
const CAP_MS = 30_000

// These cover the two pure decisions behind chapter retries: which failures are
// retried at all, and how long the backoff waits before the next attempt.
describe('shouldRetryChapterFail', () => {
  it('retries the three transient failures', () => {
    expect(shouldRetryChapterFail('NavFailed')).toBe(true)
    expect(shouldRetryChapterFail('BodyEmpty')).toBe(true)
    expect(shouldRetryChapterFail('RateLimited')).toBe(true)
  })

  it('gives up immediately on permanent failures', () => {
    const permanent = ['NeedLogin', 'Paywall', 'Intercepted', 'BodyGarbled', 'UnknownPage', 'CatalogNotFound'] as const
    for (const code of permanent) expect(shouldRetryChapterFail(code)).toBe(false)
  })

  it('treats a missing code as permanent', () => {
    expect(shouldRetryChapterFail(undefined)).toBe(false)
  })
})

describe('isSiteWallFail', () => {
  it('flags the three wall failures', () => {
    expect(isSiteWallFail('NeedLogin')).toBe(true)
    expect(isSiteWallFail('Paywall')).toBe(true)
    expect(isSiteWallFail('Intercepted')).toBe(true)
  })

  it('does not flag retryable or unknown failures as walls', () => {
    expect(isSiteWallFail('RateLimited')).toBe(false)
    expect(isSiteWallFail('NavFailed')).toBe(false)
    expect(isSiteWallFail(undefined)).toBe(false)
  })
})

describe('chapterRetryDelayMs', () => {
  const zeroJitter = { random: () => 0 }

  it('starts at half the base delay with no jitter', () => {
    expect(chapterRetryDelayMs(1, { testing: false, ...zeroJitter })).toBe(BASE_MS / 2)
  })

  it('doubles per attempt', () => {
    expect(chapterRetryDelayMs(2, { testing: false, ...zeroJitter })).toBe(BASE_MS)
    expect(chapterRetryDelayMs(3, { testing: false, ...zeroJitter })).toBe(BASE_MS * 2)
    expect(chapterRetryDelayMs(4, { testing: false, ...zeroJitter })).toBe(BASE_MS * 4)
  })

  it('clamps at the cap instead of growing without bound', () => {
    // 2^(20-1) would be 524_288 s of base delay; the cap keeps it bounded.
    expect(chapterRetryDelayMs(20, { testing: false, ...zeroJitter })).toBe(CAP_MS / 2)
    expect(chapterRetryDelayMs(20, { testing: false, random: () => 1 })).toBe(CAP_MS)
  })

  it('honours an explicit cap', () => {
    expect(chapterRetryDelayMs(10, { testing: false, capMs: 4_000, ...zeroJitter })).toBe(2_000)
  })

  it('adds up to 50 percent jitter on top of half the delay', () => {
    expect(chapterRetryDelayMs(1, { testing: false, random: () => 1 })).toBe(BASE_MS)
    expect(chapterRetryDelayMs(1, { testing: false, random: () => 0.5 })).toBe(750)
  })

  it('never waits in test mode', () => {
    expect(chapterRetryDelayMs(1, { testing: true, random: () => 1 })).toBe(0)
    expect(chapterRetryDelayMs(5, { testing: true })).toBe(0)
  })

  it('treats non-positive attempts as the first attempt', () => {
    expect(chapterRetryDelayMs(0, { testing: false, ...zeroJitter })).toBe(chapterRetryDelayMs(1, { testing: false, ...zeroJitter }))
    expect(chapterRetryDelayMs(-3, { testing: false, ...zeroJitter })).toBe(chapterRetryDelayMs(1, { testing: false, ...zeroJitter }))
  })
})
