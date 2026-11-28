import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { atomicWriteText } from './atomicFile'
import { parseMarketListing } from './ruleMarket'
import type { RuleMarketEntry } from '../shared/types'

/**
 * 规则市场的订阅清单存储。
 *
 * 与 `ruleMarketIpc.ts` 分开：那边只管频道语义与解析，磁盘格式归这里，
 * 两边各自可单测。落盘位置是 `%APPDATA%/spbf/rule-market.json`。
 *
 * 文件里只有规则清单（CSS 选择器），**不得含任何凭据**。
 */

/** 一个已订阅的清单来源。 */
export interface MarketSubscription {
  /** 清单地址（http(s) 绝对地址）。 */
  url: string
  /** 上次拉回的条目快照。 */
  entries: RuleMarketEntry[]
  /** 上次成功拉取的时间（ISO 字符串）。 */
  updatedAt: string
}

/** 单测注入目录；null = 用真实的 userData 目录。 */
let overrideDir: string | null = null

function storePath(): string {
  return join(overrideDir ?? app.getPath('userData'), 'rule-market.json')
}

/** 从磁盘读出订阅列表；文件缺失或损坏时按「没有订阅」处理。 */
export async function readMarketSubscriptions(): Promise<MarketSubscription[]> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(storePath(), 'utf-8'))
  } catch {
    return []
  }
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as { subscriptions?: unknown }).subscriptions
  if (!Array.isArray(list)) return []
  const out: MarketSubscription[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const source = item as Record<string, unknown>
    const url = typeof source.url === 'string' ? source.url.trim() : ''
    if (!url) continue
    out.push({
      url,
      entries: parseMarketListing(source.entries),
      updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
    })
  }
  return out
}

/** 原子写：临时文件 + rename，半截 JSON 等于丢掉整份清单。 */
async function writeMarketSubscriptions(subscriptions: MarketSubscription[]): Promise<void> {
  await mkdir(join(storePath(), '..'), { recursive: true })
  await atomicWriteText(storePath(), JSON.stringify({ version: 1, subscriptions }, null, 2))
}

/** 新增或覆盖一个来源（同 url 替换）。 */
export async function saveMarketSubscription(subscription: MarketSubscription): Promise<void> {
  const current = await readMarketSubscriptions()
  const next = current.filter((item) => item.url !== subscription.url)
  next.push(subscription)
  await writeMarketSubscriptions(next)
}

/** 取消订阅某个来源；不存在时不算错。 */
export async function removeMarketSubscription(url: string): Promise<void> {
  const current = await readMarketSubscriptions()
  const next = current.filter((item) => item.url !== url)
  if (next.length === current.length) return
  await writeMarketSubscriptions(next)
}
