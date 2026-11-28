import type { AutoUpdateCheckPrefs, CheckAllResult } from '../shared/types'
import { isLibraryRestoring } from './libraryMaintenance'
import { checkAllUpdates, isDownloadBusy } from './download'
import { getSettings, updateSettings } from './settings'

type AutoUpdateCheckOutcome =
  | { status: 'disabled' | 'notDue' | 'busy' }
  | { status: 'ran'; summary: string; result: CheckAllResult }
  | { status: 'failed'; message: string }

interface AutoUpdateCheckDeps {
  now?: Date
  getPrefs?: () => Promise<AutoUpdateCheckPrefs>
  checkAll?: () => Promise<CheckAllResult>
  savePrefs?: (patch: Partial<AutoUpdateCheckPrefs>) => Promise<unknown>
  busy?: () => boolean
}

const HOUR_MS = 60 * 60_000

/** 距上次成功检查不足一个间隔就不跑；从未检查过、时间戳损坏都视为到期。 */
export function isAutoUpdateCheckDue(prefs: AutoUpdateCheckPrefs, now = Date.now()): boolean {
  const last = Date.parse(prefs.lastCheckedAt)
  if (!Number.isFinite(last)) return true
  return now - last >= prefs.intervalHours * HOUR_MS
}

/** 把批量检查结果压成一句中文摘要，写进设置并在书库页展示。 */
export function formatAutoUpdateSummary(result: CheckAllResult): string {
  const failed = result.results.filter((item) => !item.ok).length
  const failedText = failed > 0 ? `，${failed} 本检查失败` : ''
  if (result.total === 0) return '书库里还没有可追更的下载书'
  const updated = result.results
    .filter((item): item is Extract<CheckAllResult['results'][number], { ok: true }> => item.ok && item.added > 0)
  if (updated.length === 0) return `已检查 ${result.total} 本，暂无新章${failedText}`
  const added = updated.reduce((sum, item) => sum + item.added, 0)
  const names = updated.map((item) => `《${item.title}》`)
  const head = names.length > 3 ? `${names.slice(0, 3).join('')}等 ${names.length} 本` : names.join('')
  return `已检查 ${result.total} 本，${head}有新章，共补 ${added} 章${failedText}`
}

/**
 * 到期就串行检查书库里每本下载书；检查本身会顺带把新章补下来。
 * 忙（下载 / 书库恢复 / 已有批量检查）时不写时间戳，留给下次启动重试。
 */
export async function runAutoUpdateCheckIfDue(
  deps: AutoUpdateCheckDeps = {},
): Promise<AutoUpdateCheckOutcome> {
  const now = deps.now ?? new Date()
  const getPrefs = deps.getPrefs ?? (async () => (await getSettings()).autoUpdateCheck ?? {
    enabled: true,
    intervalHours: 24,
    lastCheckedAt: '',
    lastSummary: '',
  })
  const prefs = await getPrefs()
  if (!prefs.enabled) return { status: 'disabled' }
  if (!isAutoUpdateCheckDue(prefs, now.getTime())) return { status: 'notDue' }

  const busy = deps.busy ?? (() => isDownloadBusy() || isLibraryRestoring())
  if (busy()) return { status: 'busy' }

  const checkAll = deps.checkAll ?? checkAllUpdates
  const result = await checkAll()
  if (!result.ok) return { status: 'failed', message: result.message ?? '自动检查更新失败' }

  // 空书库只记时间、不写摘要：否则每次启动都在书库页弹一句「还没有可追更的书」。
  const summary = result.total === 0 ? '' : formatAutoUpdateSummary(result)
  const savePrefs = deps.savePrefs ?? ((patch) => updateSettings({ autoUpdateCheck: patch }))
  await savePrefs({ lastCheckedAt: now.toISOString(), lastSummary: summary })
  return { status: 'ran', summary, result }
}
