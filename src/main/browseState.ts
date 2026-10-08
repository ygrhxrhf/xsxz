import { app } from 'electron'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from './atomicFile'
import { normalizeHost } from './siteRules'

export interface SavedBrowsePosition { url: string; ratio: number; updatedAt: string }
interface BrowseDiskState { version: 1; last?: SavedBrowsePosition; zoomByHost: Record<string, number> }

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
  state = { version: 1, zoomByHost }
  if (validUrl(last.url) && typeof last.ratio === 'number' && Number.isFinite(last.ratio)) {
    state.last = { url: last.url, ratio: Math.max(0, Math.min(1, last.ratio)), updatedAt: typeof last.updatedAt === 'string' ? last.updatedAt : '' }
  }
  return state
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
  ;(await load()).zoomByHost[host] = factor
  await save()
  return factor
}
export async function setBrowsePosition(url: string, ratio: number): Promise<void> {
  if (!validUrl(url) || !Number.isFinite(ratio)) return
  ;(await load()).last = { url, ratio: Math.max(0, Math.min(1, ratio)), updatedAt: new Date().toISOString() }
  await save()
}
