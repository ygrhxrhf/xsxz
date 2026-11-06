import type { RuleMarketEntry, RuleMarketListing, RuleMarketSource, SiteRule } from '../shared/types'

/**
 * 站点规则市场的纯函数层。
 *
 * 市场的条目是「别人写好的抽取规则」：只含 CSS 选择器。任何凭据形状的字段
 * （Key / token / password / 密文等）在这一层就被剔除，调用方拿到的条目
 * 不可能带凭据，也就不可能把它们写进本机规则或同步包。
 */

/** 市场条目里允许出现的规则字段：全是 CSS 选择器与开关。 */
const MARKET_RULE_STRING_FIELDS = [
  'title',
  'author',
  'catalog',
  'body',
  'previousChapter',
  'nextChapter',
  'adHideSelectors',
  'bodyCleanPatterns',
  'unlockSelectors',
  'chapterApi',
  'chapterApiBody',
] as const

const MARKET_RULE_BOOLEAN_FIELDS = [
  'adFilterEnabled',
  'paywallUnlock',
  'ocrUnlock',
] as const

type MarketRuleStringField = (typeof MARKET_RULE_STRING_FIELDS)[number]
type MarketRuleBooleanField = (typeof MARKET_RULE_BOOLEAN_FIELDS)[number]

/**
 * 凭据形状的词元。
 *
 * 这里按「字段名形状」判断而不是按字段值判断：市场条目与同步包都是别人写的
 * 数据，字段名本身足以说明它装的是凭据，按值猜会漏。
 */
const CREDENTIAL_TOKENS = new Set([
  'key',
  'keys',
  'token',
  'tokens',
  'password',
  'passwd',
  'pwd',
  'secret',
  'secrets',
  'credential',
  'credentials',
  'cookie',
  'cookies',
  'session',
  'auth',
  'authorization',
  'signature',
])

/** 把字段名拆成词元：`onlineKey` → `online` + `key`，`apiKeyEnc` → `api` + `key` + `enc`。 */
function splitKeyTokens(key: string): string[] {
  return key
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((part) => part.toLowerCase())
    .filter(Boolean)
}

/**
 * 字段名带凭据形状就剔除：密文字段（`*Enc`）与任何以 key/token/password 命名的字段同样算。
 */
export function isCredentialShapedKey(key: string): boolean {
  if (typeof key !== 'string') return false
  const normalized = key.trim().toLowerCase()
  if (!normalized) return false
  if (splitKeyTokens(key).some((token) => CREDENTIAL_TOKENS.has(token))) return true
  return /enc$/.test(normalized)
}

/**
 * 规范化域名：trim、小写、URL 取 hostname、去掉一层前导 `www.`。
 *
 * 与 `siteRules.normalizeHost` 同语义，但这里不 import 它——那个模块连带
 * electron，市场解析必须能在主进程之外的纯环境里跑（单测即如此）。
 */
export function normalizeMarketHost(input: unknown): string {
  const trimmed = typeof input === 'string' ? input.trim() : ''
  if (!trimmed) return ''
  let host = trimmed
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
      host = new URL(trimmed).hostname
    } else if (/[/?#]/.test(trimmed)) {
      host = new URL(`https://${trimmed}`).hostname
    }
  } catch {
    return ''
  }
  host = host.toLowerCase()
  if (host.startsWith('www.')) host = host.slice(4)
  return host
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 只保留能解析成时间的 ISO 串；解析不了按「没有时间」处理。 */
function pickIso(value: unknown): string {
  const text = pickString(value)
  if (!text) return ''
  return Number.isNaN(Date.parse(text)) ? '' : text
}

/** 时间戳比较：解析不了的按最早处理。 */
function timestampOf(value: string): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function assignStringField(rule: SiteRule, source: Record<string, unknown>, key: MarketRuleStringField): void {
  const value = source[key]
  if (typeof value === 'string' && value.trim()) rule[key] = value
}

function assignBooleanField(rule: SiteRule, source: Record<string, unknown>, key: MarketRuleBooleanField): void {
  const value = source[key]
  if (typeof value === 'boolean') rule[key] = value
}

/**
 * 把任意来源的规则整理成干净的 `SiteRule`。
 *
 * 只认白名单字段（全是 CSS 选择器与开关），凭据形状的字段一律不进来；
 * host 规范化失败返回 null（这一条不可用）。
 */
export function sanitizeSiteRule(raw: unknown): SiteRule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const host = normalizeMarketHost(source.host)
  if (!host) return null

  const rule: SiteRule = { host }
  for (const key of MARKET_RULE_STRING_FIELDS) assignStringField(rule, source, key)
  for (const key of MARKET_RULE_BOOLEAN_FIELDS) assignBooleanField(rule, source, key)
  const method = source.chapterApiMethod
  if (method === 'GET' || method === 'POST') rule.chapterApiMethod = method
  return rule
}

/**
 * 解析一条市场条目。
 *
 * 条目形状有两种：规则嵌在 `rule` 里，或选择器直接摊在条目上。
 * 两条硬要求：host 必须能规范化；抽取规则至少要有正文或目录选择器，
 * 否则这条规则装了也用不起来，直接丢弃。
 */
export function parseMarketEntry(raw: unknown): RuleMarketEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const nested =
    source.rule && typeof source.rule === 'object' && !Array.isArray(source.rule)
      ? (source.rule as Record<string, unknown>)
      : null

  const host = normalizeMarketHost(source.host ?? source.id ?? nested?.host)
  if (!host) return null

  const rule = sanitizeSiteRule({ ...(nested ?? source), host })
  if (!rule) return null
  if (!rule.body && !rule.catalog) return null

  const title = pickString(source.title) || pickString(rule.title) || host
  const note = pickString(source.note)
  const updatedAt = pickIso(source.updatedAt)
  const uses =
    typeof source.uses === 'number' && Number.isFinite(source.uses) && source.uses > 0
      ? Math.floor(source.uses)
      : 0
  const id = pickString(source.id) || host

  return { id, host, title, rule, note, updatedAt, uses }
}

/**
 * 解析远端清单。
 *
 * 接受三种形状：顶层数组、`{ entries: [] }`、`{ rules: [] }`。
 * 解析不了的条目直接丢弃，不让脏条目进市场。
 */
export function parseMarketListing(raw: unknown): RuleMarketEntry[] {
  let list: unknown[] = []
  if (Array.isArray(raw)) {
    list = raw
  } else if (raw && typeof raw === 'object') {
    const source = raw as Record<string, unknown>
    for (const key of ['entries', 'rules', 'market', 'items']) {
      const value = source[key]
      if (Array.isArray(value)) {
        list = value
        break
      }
    }
  }
  const entries: RuleMarketEntry[] = []
  for (const item of list) {
    const entry = parseMarketEntry(item)
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * 合并来源优先级：本机自建 > 内置 > 远端订阅。
 *
 * 同 host 只留一条：本机自己写过的规则是本人确认过的，远端清单不覆盖它。
 * 同优先级再按更新时间取新者。
 */
const SOURCE_PRIORITY: Record<RuleMarketSource, number> = { local: 3, builtin: 2, remote: 1 }

/** 按 host 去重合并多个来源，返回条目与逐条来源。 */
export function mergeMarketEntries(
  groups: { source: RuleMarketSource; entries: RuleMarketEntry[] }[],
): RuleMarketListing {
  const byHost = new Map<string, { entry: RuleMarketEntry; source: RuleMarketSource }>()
  for (const group of groups) {
    for (const entry of group.entries) {
      const current = byHost.get(entry.host)
      if (!current) {
        byHost.set(entry.host, { entry, source: group.source })
        continue
      }
      const currentPriority = SOURCE_PRIORITY[current.source]
      const groupPriority = SOURCE_PRIORITY[group.source]
      const wins =
        groupPriority > currentPriority ||
        (groupPriority === currentPriority &&
          timestampOf(entry.updatedAt) > timestampOf(current.entry.updatedAt))
      if (wins) byHost.set(entry.host, { entry, source: group.source })
    }
  }
  const entries: RuleMarketEntry[] = []
  const sources: Record<string, RuleMarketSource> = {}
  for (const { entry, source } of byHost.values()) {
    entries.push(entry)
    sources[entry.id] = source
  }
  return { entries, sources }
}

/** 市场条目 → 本机站点规则：只取白名单字段，host 规范化。 */
export function marketEntryToSiteRule(entry: RuleMarketEntry): SiteRule {
  const rule = sanitizeSiteRule({ ...entry.rule, host: entry.host })
  return rule ?? { host: normalizeMarketHost(entry.host) }
}

/** 本机自建规则 → 市场条目（来源标为 local）。 */
export function localRuleToMarketEntry(rule: SiteRule): RuleMarketEntry | null {
  const clean = sanitizeSiteRule(rule)
  if (!clean) return null
  return {
    id: clean.host,
    host: clean.host,
    title: clean.title ?? clean.host,
    rule: clean,
    note: '',
    updatedAt: '',
    uses: 0,
  }
}
