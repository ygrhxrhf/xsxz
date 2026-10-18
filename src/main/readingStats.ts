/**
 * 阅读统计（<书库>/reading-stats.json）：按天累计阅读时长、字数与活跃书目，并算连续阅读天数。
 *
 * 为什么单独落一个文件：现有的 `Book.progress`、browseState、tts 都只存「最新位置 + 单时间戳」，
 * 推不出「每天读了多少」；`readFrontier` 的 sessions 每书只留最近 12 段、且分散在各书目录里，
 * 没有全局聚合。要长期统计必须按天落盘一份聚合。
 *
 * 写入点挂在 `markReadFrontier`（已在书锁内、且带 updatedAt）：那里每次上报都顺手累加，
 * 不新增 IPC。跨进程按天滚动，超上限按最旧淘汰。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReadingStatsView, ReadingStatsDay } from '../shared/types'
import { atomicWriteText, getLibraryPath } from './library'

/** 单会话内两次上报间隔超过这个值就不再算连续阅读（与 readFrontier 的 30 分钟切分一致）。 */
const ACTIVE_GAP_MS = 5 * 60_000
/** 最多保留多少天：够看一年趋势，又不至于无限增长。 */
export const MAX_STATS_DAYS = 400

interface StatsFile {
  version: 1
  /** 最后一次上报的时间戳（ms），用于估算阅读时长。 */
  lastAt: number
  days: Record<string, ReadingStatsDay>
}

function filePath(): string {
  return join(getLibraryPath(), 'reading-stats.json')
}

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function empty(): StatsFile {
  return { version: 1, lastAt: 0, days: {} }
}

function readDay(value: unknown): ReadingStatsDay | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<ReadingStatsDay>
  const seconds = Number(raw.seconds)
  const chars = Number(raw.chars)
  const books = Array.isArray(raw.books) ? raw.books.filter((id): id is string => typeof id === 'string') : []
  return {
    seconds: Number.isFinite(seconds) && seconds >= 0 ? Math.trunc(seconds) : 0,
    chars: Number.isFinite(chars) && chars >= 0 ? Math.trunc(chars) : 0,
    books,
  }
}

async function read(): Promise<StatsFile> {
  try {
    const raw = JSON.parse(await readFile(filePath(), 'utf-8')) as Partial<StatsFile>
    if (raw.version !== 1 || !raw.days || typeof raw.days !== 'object') return empty()
    const days: Record<string, ReadingStatsDay> = {}
    for (const [key, value] of Object.entries(raw.days)) {
      const day = readDay(value)
      if (day) days[key] = day
    }
    return { version: 1, lastAt: Number.isFinite(raw.lastAt) ? Number(raw.lastAt) : 0, days }
  } catch {
    return empty()
  }
}

/** 只保留最近 MAX_STATS_DAYS 天，按日期字符串排序（ISO 日期天然可比）。 */
function prune(days: Record<string, ReadingStatsDay>): Record<string, ReadingStatsDay> {
  const keys = Object.keys(days).sort()
  if (keys.length <= MAX_STATS_DAYS) return days
  const kept: Record<string, ReadingStatsDay> = {}
  for (const key of keys.slice(keys.length - MAX_STATS_DAYS)) kept[key] = days[key]!
  return kept
}

/**
 * 记一次阅读上报：按「距上次上报的间隔」估算本次时长（上限 ACTIVE_GAP_MS，避免挂机虚增），
 * 并把新增字数累加到当天。`chars` 为本次前进的字符数（可为 0，只计时长）。
 */
export async function recordReadingActivity(bookId: string, chars: number, atMs = Date.now()): Promise<void> {
  const file = await read()
  const key = dayKey(atMs)
  const day = file.days[key] ?? { seconds: 0, chars: 0, books: [] }
  const gap = file.lastAt > 0 ? Math.min(ACTIVE_GAP_MS, Math.max(0, atMs - file.lastAt)) : 0
  day.seconds += Math.round(gap / 1000)
  day.chars += Number.isFinite(chars) && chars > 0 ? Math.trunc(chars) : 0
  if (!day.books.includes(bookId)) day.books.push(bookId)
  file.days[key] = day
  file.lastAt = atMs
  file.days = prune(file.days)
  await atomicWriteText(filePath(), JSON.stringify(file, null, 2))
}

/** 连续阅读天数：从今天（或昨天）往前数，直到某天没有记录。 */
export function computeStreak(days: Record<string, ReadingStatsDay>, nowMs = Date.now()): number {
  const active = new Set(Object.keys(days).filter((key) => {
    const day = days[key]!
    return day.seconds > 0 || day.chars > 0
  }))
  if (active.size === 0) return 0
  const DAY_MS = 24 * 60 * 60 * 1000
  // 今天还没读不算断：从今天或昨天起算，兼容「昨天读到半夜、今天还没打开」。
  let cursor = nowMs
  if (!active.has(dayKey(cursor))) {
    cursor -= DAY_MS
    if (!active.has(dayKey(cursor))) return 0
  }
  let streak = 0
  while (active.has(dayKey(cursor))) {
    streak += 1
    cursor -= DAY_MS
  }
  return streak
}

/** 统计视图：按日期倒序给最近若干天，附带连续天数与合计。 */
export async function readReadingStats(limitDays = 30, nowMs = Date.now()): Promise<ReadingStatsView> {
  const file = await read()
  const keys = Object.keys(file.days).sort().reverse()
  const recent = keys.slice(0, Math.max(1, Math.trunc(limitDays)))
  const days = recent.map((date) => ({ date, ...file.days[date]! }))
  const totalSeconds = keys.reduce((sum, key) => sum + file.days[key]!.seconds, 0)
  const totalChars = keys.reduce((sum, key) => sum + file.days[key]!.chars, 0)
  return { days, streak: computeStreak(file.days, nowMs), totalSeconds, totalChars }
}
