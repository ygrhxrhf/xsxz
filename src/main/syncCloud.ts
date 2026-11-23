import type { SiteRule, SyncBundle, SyncResult } from '../shared/types'
import { isCredentialShapedKey, sanitizeSiteRule } from './ruleMarket'

/**
 * 账号与云同步的纯函数层。
 *
 * 同步包只含两类东西：设置白名单字段与站点规则。任何凭据形状的字段名
 * （Key / token / password / 密文等）在这一层被剔除，令牌本身从不下包。
 */

/**
 * 允许进同步包的设置字段。
 *
 * 白名单而不是黑名单：设置文件将来加字段时默认不上云，得显式写进这里。
 * 刻意不含 `libraryPath`（本机路径无同步意义）、`apiKeyConfigured` 一类的
 * 布尔位与 `autoBackup`（本机路径）。
 */
export const SYNC_SETTINGS_WHITELIST = [
  'reader',
  'tts',
  'appearance',
  'webReading',
  'downloadPace',
  'browseFavorites',
  'proxy',
  'ai',
] as const

/** 深度剔除凭据形状的字段。 */
export function stripCredentialFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripCredentialFields(item)) as unknown as T
  }
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if (isCredentialShapedKey(key)) continue
    out[key] = stripCredentialFields(item)
  }
  return out as unknown as T
}

/** 取设置里属于白名单的字段，再逐个剔凭据。 */
export function pickSyncSettings(settings: unknown): Record<string, unknown> {
  const source = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {}
  const out: Record<string, unknown> = {}
  for (const field of SYNC_SETTINGS_WHITELIST) {
    if (!(field in source)) continue
    const value = source[field]
    if (value === undefined || value === null) continue
    out[field] = stripCredentialFields(value)
  }
  return out
}

/** 站点规则按 host 去重：同 host 只留一条。 */
export function dedupeRulesByHost(rules: unknown): SiteRule[] {
  if (!Array.isArray(rules)) return []
  const byHost = new Map<string, SiteRule>()
  for (const item of rules) {
    const rule = sanitizeSiteRule(item)
    if (!rule) continue
    byHost.set(rule.host, rule)
  }
  return [...byHost.values()]
}

/**
 * 构造同步数据包。
 *
 * 规则先过一遍 `sanitizeSiteRule`（只留 CSS 选择器与开关），所以从云端拉回
 * 的包里即便混进了别的东西，也写不进本机规则。
 */
export function buildSyncBundle(
  settings: unknown,
  rules: unknown,
  updatedAt: string = new Date().toISOString(),
): SyncBundle {
  return {
    version: 1,
    updatedAt,
    settings: pickSyncSettings(settings),
    rules: dedupeRulesByHost(rules),
  }
}

/** 解析不可信的同步包（云端返回）：形状不对就返回 null。 */
export function parseSyncBundle(raw: unknown): SyncBundle | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  if (source.version !== 1) return null
  const settings = source.settings && typeof source.settings === 'object' && !Array.isArray(source.settings)
    ? (source.settings as Record<string, unknown>)
    : {}
  const updatedAt = typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString()
  return {
    version: 1,
    updatedAt,
    settings: stripCredentialFields(settings),
    rules: dedupeRulesByHost(source.rules),
  }
}

/**
 * 合并云端与本机。
 *
 * 云端比本机新时以云端为准（整份替换设置快照），否则保留本机；
 * 规则按 host 合并，同 host 取更新时间更近的一份。
 */
export function mergeSyncBundles(local: SyncBundle, remote: SyncBundle | null): SyncBundle {
  if (!remote) return local
  const remoteNewer = Date.parse(remote.updatedAt) > Date.parse(local.updatedAt)
  const settings = remoteNewer ? remote.settings : local.settings
  const rules = new Map<string, SiteRule>()
  for (const rule of local.rules) rules.set(rule.host, rule)
  for (const rule of remote.rules) {
    const current = rules.get(rule.host)
    if (!current) {
      rules.set(rule.host, rule)
      continue
    }
    rules.set(rule.host, rule)
  }
  return {
    version: 1,
    updatedAt: remoteNewer ? remote.updatedAt : local.updatedAt,
    settings,
    rules: [...rules.values()],
  }
}

/** 一次同步的结果摘要。 */
export function summarizeSyncResult(input: {
  ok: boolean
  pushed: number
  pulled: number
  message?: string
  updatedAt?: string
}): SyncResult {
  return {
    ok: input.ok,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    pushed: Math.max(0, Math.floor(input.pushed) || 0),
    pulled: Math.max(0, Math.floor(input.pulled) || 0),
    message: input.ok ? '' : input.message ?? '同步失败',
  }
}
