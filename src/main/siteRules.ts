import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SiteRule } from '../shared/types'

const FILE_VERSION = 1

interface SiteRulesFile {
  version: number
  rules: SiteRule[]
}

function rulesPath(): string {
  return join(app.getPath('userData'), 'site-rules.json')
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

function toStoredRule(rule: SiteRule, host: string): SiteRule {
  const stored: SiteRule = { host }
  const title = asSelector(rule.title)
  const author = asSelector(rule.author)
  const catalog = asSelector(rule.catalog)
  const body = asSelector(rule.body)
  if (title !== undefined) stored.title = title
  if (author !== undefined) stored.author = author
  if (catalog !== undefined) stored.catalog = catalog
  if (body !== undefined) stored.body = body
  return stored
}

function parseFile(raw: unknown): SiteRulesFile {
  if (!raw || typeof raw !== 'object') return { version: FILE_VERSION, rules: [] }
  const rulesIn = (raw as { rules?: unknown }).rules
  if (!Array.isArray(rulesIn)) return { version: FILE_VERSION, rules: [] }
  const rules: SiteRule[] = []
  for (const item of rulesIn) {
    if (!item || typeof item !== 'object') continue
    const host = typeof (item as SiteRule).host === 'string' ? (item as SiteRule).host : ''
    if (!host) continue
    rules.push({
      host,
      title: asSelector((item as SiteRule).title),
      author: asSelector((item as SiteRule).author),
      catalog: asSelector((item as SiteRule).catalog),
      body: asSelector((item as SiteRule).body),
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
  await writeFile(rulesPath(), JSON.stringify(data, null, 2), 'utf-8')
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
