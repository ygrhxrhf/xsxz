import { app } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SiteRule } from '../shared/types'
import { atomicWriteText } from './atomicFile'

const FILE_VERSION = 1

interface SiteRulesFile {
  version: number
  rules: SiteRule[]
}

/** Injected userData dir for unit tests. Null = real `app.getPath('userData')`. */
let overrideDir: string | null = null

export function setSiteRulesDir(dir: string | null): void {
  overrideDir = dir
}

function rulesPath(): string {
  const root = overrideDir ?? app.getPath('userData')
  return join(root, 'site-rules.json')
}

/** trim → lowercase → optional hostname from URL → strip one leading www. */
export function normalizeHost(input: string): string {
  const trimmed = (input ?? '').trim()
  if (!trimmed) throw new Error('域名不能为空')

  let host = trimmed
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
      host = new URL(trimmed).hostname
    } else if (/[/?#]/.test(trimmed)) {
      host = new URL(`https://${trimmed}`).hostname
    }
  } catch {
    throw new Error('域名无效')
  }

  host = host.toLowerCase()
  if (host.startsWith('www.')) host = host.slice(4)
  if (!host) throw new Error('域名不能为空')
  return host
}

function asSelector(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

const CLEAN_PATTERN_LINE_LIMIT = 200
const CLEAN_PATTERN_MAX_LINES = 20

/** 正文噪音正则：每行一条，丢空行、超限行与非法正则，最多 20 条。 */
function asCleanPatterns(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const lines: string[] = []
  for (const line of value.split('\n')) {
    const text = line.trim()
    if (!text || text.length > CLEAN_PATTERN_LINE_LIMIT) continue
    try { new RegExp(text, 'i') } catch { continue }
    lines.push(text)
    if (lines.length >= CLEAN_PATTERN_MAX_LINES) break
  }
  return lines.length ? lines.join('\n') : undefined
}

function toStoredRule(rule: SiteRule, host: string): SiteRule {
  const stored: SiteRule = { host }
  const title = asSelector(rule.title)
  const author = asSelector(rule.author)
  const catalog = asSelector(rule.catalog)
  const body = asSelector(rule.body)
  const previousChapter = asSelector(rule.previousChapter)
  const nextChapter = asSelector(rule.nextChapter)
  if (title !== undefined) stored.title = title
  if (author !== undefined) stored.author = author
  if (catalog !== undefined) stored.catalog = catalog
  if (body !== undefined) stored.body = body
  if (previousChapter !== undefined) stored.previousChapter = previousChapter
  if (nextChapter !== undefined) stored.nextChapter = nextChapter
  if (typeof rule.adFilterEnabled === 'boolean') stored.adFilterEnabled = rule.adFilterEnabled
  if (typeof rule.adHideSelectors === 'string') stored.adHideSelectors = rule.adHideSelectors
  if (typeof rule.paywallUnlock === 'boolean') stored.paywallUnlock = rule.paywallUnlock
  if (typeof rule.unlockSelectors === 'string') stored.unlockSelectors = rule.unlockSelectors
  if (typeof rule.chapterApi === 'string') stored.chapterApi = rule.chapterApi
  if (rule.chapterApiMethod === 'GET' || rule.chapterApiMethod === 'POST') stored.chapterApiMethod = rule.chapterApiMethod
  if (typeof rule.chapterApiBody === 'string') stored.chapterApiBody = rule.chapterApiBody
  if (typeof rule.ocrUnlock === 'boolean') stored.ocrUnlock = rule.ocrUnlock
  // 手写的正文噪音正则也要落盘：以前这一项没被带过来，
  // site-rules.json 里写好的 bodyCleanPatterns 会在任何一次保存后消失
  const cleanPatterns = asCleanPatterns(rule.bodyCleanPatterns)
  if (cleanPatterns !== undefined) stored.bodyCleanPatterns = cleanPatterns
  return stored
}

function parseFile(raw: unknown): SiteRulesFile {
  if (!raw || typeof raw !== 'object') return { version: FILE_VERSION, rules: [] }
  const rulesIn = (raw as { rules?: unknown }).rules
  if (!Array.isArray(rulesIn)) return { version: FILE_VERSION, rules: [] }
  const rules: SiteRule[] = []
  for (const item of rulesIn) {
    if (!item || typeof item !== 'object') continue
    const rawHost = typeof (item as SiteRule).host === 'string' ? (item as SiteRule).host : ''
    if (!rawHost) continue
    let host = rawHost
    try {
      host = normalizeHost(rawHost)
    } catch {
      continue
    }
    rules.push({
      host,
      title: asSelector((item as SiteRule).title),
      author: asSelector((item as SiteRule).author),
      catalog: asSelector((item as SiteRule).catalog),
      body: asSelector((item as SiteRule).body),
      previousChapter: asSelector((item as SiteRule).previousChapter),
      nextChapter: asSelector((item as SiteRule).nextChapter),
      adFilterEnabled: typeof (item as SiteRule).adFilterEnabled === 'boolean'
        ? (item as SiteRule).adFilterEnabled : undefined,
      adHideSelectors: asSelector((item as SiteRule).adHideSelectors),
      bodyCleanPatterns: asCleanPatterns((item as SiteRule).bodyCleanPatterns),
      paywallUnlock: typeof (item as SiteRule).paywallUnlock === 'boolean'
        ? (item as SiteRule).paywallUnlock : undefined,
      unlockSelectors: asSelector((item as SiteRule).unlockSelectors),
      chapterApi: asSelector((item as SiteRule).chapterApi),
      chapterApiMethod: (item as SiteRule).chapterApiMethod === 'GET' || (item as SiteRule).chapterApiMethod === 'POST'
        ? (item as SiteRule).chapterApiMethod : undefined,
      chapterApiBody: asSelector((item as SiteRule).chapterApiBody),
      ocrUnlock: typeof (item as SiteRule).ocrUnlock === 'boolean' ? (item as SiteRule).ocrUnlock : undefined,
    })
  }
  return { version: FILE_VERSION, rules }
}

async function loadFile(): Promise<SiteRulesFile> {
  try {
    return parseFile(JSON.parse(await readFile(rulesPath(), 'utf-8')))
  } catch {
    return { version: FILE_VERSION, rules: [] }
  }
}

async function saveFile(data: SiteRulesFile): Promise<void> {
  await mkdir(join(rulesPath(), '..'), { recursive: true }).catch(() => {})
  // 原子写：站点规则是用户手填的，崩溃/断电时不能只剩半截 JSON 把规则全丢掉
  await atomicWriteText(rulesPath(), JSON.stringify(data, null, 2))
}

export async function listSiteRules(): Promise<SiteRule[]> {
  const { rules } = await loadFile()
  return rules
}

export async function upsertSiteRule(rule: SiteRule): Promise<SiteRule> {
  if (!rule || typeof rule !== 'object') throw new Error('规则无效')
  const host = normalizeHost(rule.host)
  const stored = toStoredRule(rule, host)
  const file = await loadFile()
  const idx = file.rules.findIndex((r) => r.host === host)
  if (idx >= 0) file.rules[idx] = stored
  else file.rules.push(stored)
  await saveFile(file)
  return stored
}

export async function removeSiteRule(host: string): Promise<void> {
  const normalized = normalizeHost(host)
  const file = await loadFile()
  file.rules = file.rules.filter((r) => r.host !== normalized)
  await saveFile(file)
}

export async function findSiteRuleForUrl(pageUrl: string): Promise<SiteRule | undefined> {
  const host = normalizeHost(pageUrl)
  const { rules } = await loadFile()
  return rules.find((r) => r.host === host)
}
