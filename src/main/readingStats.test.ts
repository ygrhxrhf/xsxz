import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeStreak, readReadingStats, recordReadingActivity, MAX_STATS_DAYS } from './readingStats'
import { setLibraryPath } from './library'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spbf-stats-'))
  await setLibraryPath(dir)
})

afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** 构造某天的本地时间戳（正午，避开时区跨日边界）。 */
function atNoon(daysAgo: number): number {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(12, 0, 0, 0)
  return d.getTime()
}

describe('readingStats', () => {
  it('按天累计时长与字数，同一天两次上报间隔计入时长', async () => {
    const day = atNoon(0)
    await recordReadingActivity('d_a', 100, day)
    // 距上次 90 秒：计入时长（小于 5 分钟上限）
    await recordReadingActivity('d_a', 50, day + 90_000)
    const stats = await readReadingStats(30, day + 90_000)
    expect(stats.days).toHaveLength(1)
    expect(stats.days[0]!.chars).toBe(150)
    expect(stats.days[0]!.seconds).toBe(90)
    expect(stats.days[0]!.books).toEqual(['d_a'])
  })

  it('挂机超时不算时长：单次间隔封顶 5 分钟', async () => {
    const day = atNoon(0)
    await recordReadingActivity('d_a', 0, day)
    await recordReadingActivity('d_a', 0, day + 60 * 60_000) // 隔了 1 小时
    const stats = await readReadingStats(30, day + 60 * 60_000)
    expect(stats.days[0]!.seconds).toBe(5 * 60)
  })

  it('字数只在前进时累加，负数/换章不虚增', async () => {
    const day = atNoon(0)
    await recordReadingActivity('d_a', 200, day)
    await recordReadingActivity('d_a', -50, day + 1000)
    const stats = await readReadingStats(30, day + 1000)
    expect(stats.days[0]!.chars).toBe(200)
  })

  it('streak 从今天或昨天起算连续天数，断一天就停', async () => {
    await recordReadingActivity('d_a', 10, atNoon(0))
    await recordReadingActivity('d_a', 10, atNoon(1))
    await recordReadingActivity('d_a', 10, atNoon(2))
    // 第 3 天断档，第 4 天又有
    await recordReadingActivity('d_a', 10, atNoon(4))
    const stats = await readReadingStats(30, atNoon(0))
    expect(stats.streak).toBe(3)
  })

  it('今天还没读但昨天读了：streak 不断', async () => {
    await recordReadingActivity('d_a', 10, atNoon(1))
    await recordReadingActivity('d_a', 10, atNoon(2))
    const stats = await readReadingStats(30, atNoon(0))
    expect(stats.streak).toBe(2)
  })

  it('computeStreak 对空数据返回 0', () => {
    expect(computeStreak({})).toBe(0)
  })

  it('按日期倒序返回最近 N 天，并给出合计', async () => {
    await recordReadingActivity('d_a', 10, atNoon(0))
    await recordReadingActivity('d_a', 20, atNoon(1))
    const stats = await readReadingStats(30, atNoon(0))
    expect(stats.days.map((d) => d.date)).toEqual([...stats.days.map((d) => d.date)].sort().reverse())
    expect(stats.totalChars).toBe(30)
  })

  // 405 次 recordReadingActivity = 405 轮 read+atomicWrite；全量并行下 Windows rename 抖动会
  // 把这条撑过默认 20s，给它单独的超时上限，避免被负载误判成红。
  it('天数超过上限时按最旧淘汰', async () => {
    for (let i = 0; i < MAX_STATS_DAYS + 5; i += 1) {
      await recordReadingActivity('d_a', 1, atNoon(i))
    }
    const stats = await readReadingStats(MAX_STATS_DAYS + 10, atNoon(0))
    expect(stats.days).toHaveLength(MAX_STATS_DAYS)
  }, 60_000)
})
