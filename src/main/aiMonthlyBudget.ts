import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiUsage } from '../shared/types'
import { atomicWriteText, bookDir, withBookLock } from './library'

interface MonthlyFile {
  version: 1
  month: string
  consumedTokens: number
  reservations: Record<string, number>
}

const locks = new Map<string, number>()
let sequence = 0
function month(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}
function pathFor(bookId: string): string { return join(bookDir(bookId), 'ai', 'monthly-usage.json') }
function empty(): MonthlyFile { return { version: 1, month: month(), consumedTokens: 0, reservations: {} } }

/**
 * 读文件并把「进程已不在、预约却还挂着」的孤儿预约回收成已消耗。
 * 纯读不落盘：回收的持久化交给调用方在锁内做，避免无锁写覆盖并发中的预约/结算。
 */
async function read(bookId: string): Promise<{ file: MonthlyFile; recovered: boolean }> {
  try {
    const value = JSON.parse(await readFile(pathFor(bookId), 'utf-8')) as Partial<MonthlyFile>
    if (value.version !== 1 || value.month !== month() || !Number.isSafeInteger(value.consumedTokens) || value.consumedTokens! < 0 || !value.reservations || typeof value.reservations !== 'object') return { file: empty(), recovered: false }
    const file = value as MonthlyFile
    let recovered = false
    for (const [id, reserved] of Object.entries(file.reservations)) {
      if (!Number.isSafeInteger(reserved) || reserved < 0) { delete file.reservations[id]; recovered = true; continue }
      if (!locks.has(id)) {
        file.consumedTokens += reserved
        delete file.reservations[id]
        recovered = true
      }
    }
    return { file, recovered }
  } catch { return { file: empty(), recovered: false } }
}
async function save(bookId: string, value: MonthlyFile): Promise<void> {
  await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
  await atomicWriteText(pathFor(bookId), JSON.stringify(value, null, 2))
}
export async function monthlyBudgetStatus(bookId: string, limitTokens: number): Promise<{ month: string; usedTokens: number; reservedTokens: number; limitTokens: number; remainingTokens: number }> {
  // 只读快照：孤儿回收的落盘留给持锁的写路径，状态查询不写盘就不会与并发结算打架。
  const { file } = await read(bookId)
  const reservedTokens = Object.values(file.reservations).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
  return { month: file.month, usedTokens: file.consumedTokens, reservedTokens, limitTokens, remainingTokens: Math.max(0, limitTokens - file.consumedTokens - reservedTokens) }
}

/** Reserve before dispatch. Unknown/failed provider responses consume the reservation conservatively. */
export async function reserveAutomaticTokens(bookId: string, estimate: number, limitTokens: number): Promise<{ settle: (usage?: AiUsage) => Promise<void>; release: () => Promise<void> }> {
  if (!Number.isSafeInteger(estimate) || estimate < 1) throw new Error('自动任务额度估算无效')
  const id = `${Date.now()}-${++sequence}`
  locks.set(id, estimate)
  try { await withBookLock(bookId, async () => {
    const { file } = await read(bookId)
    const occupied = file.consumedTokens + Object.values(file.reservations).reduce((sum, value) => sum + value, 0)
    if (occupied + estimate > limitTokens) throw new Error(`本书本月自动 AI 额度已到上限（${limitTokens} tokens），自动任务已暂停`)
    file.reservations[id] = estimate
    // read() 顺带回收的孤儿预约随这次写一并落盘。
    await save(bookId, file)
  }) } catch (error) { locks.delete(id); throw error }
  const finish = async (charge: number) => {
    if (!locks.has(id)) return
    await withBookLock(bookId, async () => {
      const { file } = await read(bookId)
      delete file.reservations[id]
      // 预约不在文件里也照样计费：跨月时 read() 会返回空文件，那笔消耗不能被丢掉。
      file.consumedTokens += charge
      await save(bookId, file)
    })
    locks.delete(id)
  }
  return {
    settle: async (usage) => {
      const reported = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
      await finish(reported > 0 ? reported : estimate)
    },
    release: () => finish(0),
  }
}
