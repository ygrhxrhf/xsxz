import { app } from 'electron'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from './atomicFile'
import { normalizeHost } from './siteRules'
import { canonicalizeUrl } from '../shared/urlHash'

export interface SavedBrowsePosition { url: string; ratio: number; updatedAt: string }

/** 网页阅读模式的位置：段落锚点优先，滚动比例兜底。 */
export interface SavedReadingPosition {
  url: string
  paragraphIndex: number
  scrollRatio: number
  updatedAt: string
}

interface BrowseDiskState {
  version: 1
  last?: SavedBrowsePosition
  zoomByHost: Record<string, number>
  /** 按规范化地址存的阅读模式位置，最多 READING_POSITION_LIMIT 条。 */
  readingByUrl: Record<string, SavedReadingPosition>
}

/** 阅读位置上限：超出按 updatedAt 淘汰最旧。 */
export const READING_POSITION_LIMIT = 200
/** 缩放偏好上限：按 host 记录，浏览过的站会一直累积，需要一个封顶避免无界增长。 */
export const ZOOM_HOST_LIMIT = 200

let state: BrowseDiskState | null = null
let pending: Promise<void> = Promise.resolve()
let overrideDir: string | null = null

export function setBrowseStateDirForTests(dir: string | null): void { overrideDir = dir; state = null; pending = Promise.resolve() }
function filePath(): string { return join(overrideDir ?? app.getPath('userData'), 'browse-state.json') }
function validUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}
export function clampZoom(value: number): number { return Math.max(0.5, Math.min(2, Math.round(value * 10) / 10)) }

async function load(): Promise<BrowseDiskState> {
  if (state) return state
  let raw: unknown
  try { raw = JSON.parse(await readFile(filePath(), 'utf-8')) } catch { raw = {} }
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const zoomByHost: Record<string, number> = {}
  if (input.zoomByHost && typeof input.zoomByHost === 'object') {
    for (const [host, zoom] of Object.entries(input.zoomByHost)) {
      try {
        if (normalizeHost(host) === host && typeof zoom === 'number' && Number.isFinite(zoom)) zoomByHost[host] = clampZoom(zoom)
      } catch { /* bad saved host */ }
    }
  }
  const last = input.last && typeof input.last === 'object' ? input.last as Record<string, unknown> : {}
  state = { version: 1, zoomByHost, readingByUrl: readReadingByUrl(input.readingByUrl) }
  if (validUrl(last.url) && typeof last.ratio === 'number' && Number.isFinite(last.ratio)) {
    state.last = { url: last.url, ratio: Math.max(0, Math.min(1, last.ratio)), updatedAt: typeof last.updatedAt === 'string' ? last.updatedAt : '' }
  }
  return state
}

function staleTime(value: string): number {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

/** 读取 readingByUrl：非法条目与非法地址丢弃，超出上限按 updatedAt 淘汰最旧。 */
function readReadingByUrl(raw: unknown): Record<string, SavedReadingPosition> {
  if (!raw || typeof raw !== 'object') return {}
  const entries: SavedReadingPosition[] = []
  for (const [url, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!validUrl(url) || !value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    const paragraph = item.paragraphIndex
    const ratio = item.scrollRatio
    entries.push({
      url,
      paragraphIndex: typeof paragraph === 'number' && Number.isFinite(paragraph) && paragraph >= 0 ? Math.trunc(paragraph) : 0,
      scrollRatio: typeof ratio === 'number' && Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    })
  }
  entries.sort((a, b) => staleTime(b.updatedAt) - staleTime(a.updatedAt))
  const out: Record<string, SavedReadingPosition> = {}
  for (const entry of entries.slice(0, READING_POSITION_LIMIT)) out[entry.url] = entry
  return out
}

function save(): Promise<void> {
  pending = pending.catch(() => {}).then(async () => {
    await mkdir(join(filePath(), '..'), { recursive: true })
    await atomicWriteText(filePath(), JSON.stringify(state, null, 2))
  })
  return pending
}

export async function getLastBrowsePosition(): Promise<SavedBrowsePosition | null> { return (await load()).last ?? null }
export async function getBrowseZoom(url: string): Promise<number> {
  try { return (await load()).zoomByHost[normalizeHost(url)] ?? 1 } catch { return 1 }
}
export async function setBrowseZoom(url: string, zoom: number): Promise<number> {
  const host = normalizeHost(url)
  const factor = clampZoom(zoom)
  const state = await load()
  // 重新插入以把它挪到 Map 末尾（最近使用），再按插入顺序淘汰最旧的。
  state.zoomByHost[host] = factor
  const keys = Object.keys(state.zoomByHost)
  if (keys.length > ZOOM_HOST_LIMIT) {
    for (const stale of keys.slice(0, keys.length - ZOOM_HOST_LIMIT)) delete state.zoomByHost[stale]
  }
  await save()
  return factor
}
export async function setBrowsePosition(url: string, ratio: number): Promise<void> {
  if (!validUrl(url) || !Number.isFinite(ratio)) return
  ;(await load()).last = { url, ratio: Math.max(0, Math.min(1, ratio)), updatedAt: new Date().toISOString() }
  await save()
}

/** 阅读位置的键：规范化地址；非法地址返回 null。 */
function readingKey(url: string): string | null {
  if (!validUrl(url)) return null
  try { return canonicalizeUrl(url) } catch { return null }
}

export async function getReadingPos(url: string): Promise<SavedReadingPosition | null> {
  const key = readingKey(url)
  if (!key) return null
  return (await load()).readingByUrl[key] ?? null
}

export async function setReadingPos(url: string, paragraphIndex: number, scrollRatio: number): Promise<SavedReadingPosition | null> {
  const key = readingKey(url)
  if (!key) return null
  const state = await load()
  const position: SavedReadingPosition = {
    url: key,
    paragraphIndex: Number.isFinite(paragraphIndex) && paragraphIndex >= 0 ? Math.trunc(paragraphIndex) : 0,
    scrollRatio: Number.isFinite(scrollRatio) ? Math.max(0, Math.min(1, scrollRatio)) : 0,
    updatedAt: new Date().toISOString(),
  }
  state.readingByUrl[key] = position
  const entries = Object.values(state.readingByUrl)
  if (entries.length > READING_POSITION_LIMIT) {
    entries.sort((a, b) => staleTime(b.updatedAt) - staleTime(a.updatedAt))
    state.readingByUrl = {}
    for (const entry of entries.slice(0, READING_POSITION_LIMIT)) state.readingByUrl[entry.url] = entry
  }
  await save()
  return position
}
