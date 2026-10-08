import { FiltersEngine, Request } from '@ghostery/adblocker'
import type { Session } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SiteRule } from '../shared/types'

export const ADGUARD_BASE_URL = 'https://filters.adtidy.org/extension/chromium/filters/2.txt'
const CACHE_AGE_MS = 8 * 24 * 60 * 60 * 1000
const MAX_LIST_BYTES = 12 * 1024 * 1024
const ENGINE_FILE = 'adguard-network.bin'
const META_FILE = 'adguard-network.json'

interface BrowserIdentity {
  id: number
  url: string
}

interface CacheMeta {
  updatedAt: number
  source: string
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname.replace(/^www\./i, '')
  } catch {
    return null
  }
}

function frameUrl(details: Electron.OnBeforeRequestListenerDetails): string | null {
  try {
    const top = details.frame?.top?.url
    return top && hostOf(top) ? top : null
  } catch {
    return null
  }
}

function sourceUrl(details: Electron.OnBeforeRequestListenerDetails, pageUrl: string): string {
  try {
    const frame = details.frame?.url
    if (frame && hostOf(frame)) return frame
  } catch { /* frame may have been destroyed */ }
  return hostOf(details.referrer) ? details.referrer : pageUrl
}

async function fetchAdGuardList(fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(ADGUARD_BASE_URL, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok || !response.body) throw new Error(`规则下载失败：HTTP ${response.status}`)
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_LIST_BYTES) throw new Error('规则文件过大')
      parts.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const list = Buffer.concat(parts).toString('utf-8')
  if (!list.includes('! Title: AdGuard Base filter') || !list.includes('||')) {
    throw new Error('规则文件内容无效')
  }
  return list
}

function parseNetworkRules(list: string): FiltersEngine {
  return FiltersEngine.parse(list, {
    loadNetworkFilters: true,
    loadExceptionFilters: true,
    loadCosmeticFilters: false,
    loadCSPFilters: false,
    loadGenericCosmeticsFilters: false,
    loadExtendedSelectors: false,
    enableHtmlFiltering: false,
  })
}

/** Network rules from AdGuard Base, scoped to the visible browser webContents. */
export class BrowserAdRequestFilter {
  private engine: FiltersEngine | null = null
  private disabledHosts = new Set<string>()
  private updatedAt = 0

  constructor(
    private readonly cacheDir: string,
    private readonly browser: () => BrowserIdentity | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get ready(): boolean { return this.engine !== null }

  setSiteRules(rules: SiteRule[]): void {
    this.disabledHosts = new Set(rules.filter((rule) => rule.adFilterEnabled === false).map((rule) => rule.host))
  }

  updateSiteRule(rule: SiteRule): void {
    if (rule.adFilterEnabled === false) this.disabledHosts.add(rule.host)
    else this.disabledHosts.delete(rule.host)
  }

  removeSiteRule(host: string): void {
    this.disabledHosts.delete(host)
  }

  shouldBlock(details: Electron.OnBeforeRequestListenerDetails): boolean {
    const browser = this.browser()
    if (!this.engine || !browser || details.webContentsId !== browser.id || details.resourceType === 'mainFrame') return false
    const pageUrl = frameUrl(details) ?? browser.url
    const pageHost = hostOf(pageUrl)
    if (!pageHost || this.disabledHosts.has(pageHost) || !hostOf(details.url)) return false
    try {
      const request = Request.fromRawDetails({
        url: details.url,
        sourceUrl: sourceUrl(details, pageUrl),
        type: details.resourceType,
      })
      const result = this.engine.match(request)
      // The app only cancels requests; it does not implement redirect/rewrite substitutes.
      return result.match && !result.redirect && !result.rewrite
    } catch {
      return false
    }
  }

  install(ses: Session): void {
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      let cancel = false
      try { cancel = this.shouldBlock(details) } catch { /* always complete the request callback */ }
      callback({ cancel })
    })
  }

  async start(): Promise<void> {
    try {
      const [binary, metaRaw] = await Promise.all([
        readFile(join(this.cacheDir, ENGINE_FILE)),
        readFile(join(this.cacheDir, META_FILE), 'utf-8').catch(() => ''),
      ])
      this.engine = FiltersEngine.deserialize(binary)
      const meta = JSON.parse(metaRaw) as CacheMeta
      if (meta.source === ADGUARD_BASE_URL && Number.isFinite(meta.updatedAt)) this.updatedAt = meta.updatedAt
    } catch { /* no compatible cache; CSS filtering still works */ }

    if (this.engine && Date.now() - this.updatedAt < CACHE_AGE_MS) return
    try {
      const list = await fetchAdGuardList(this.fetchImpl)
      const updated = parseNetworkRules(list)
      this.engine = updated
      this.updatedAt = Date.now()
      await mkdir(this.cacheDir, { recursive: true })
      const binaryPath = join(this.cacheDir, ENGINE_FILE)
      const metaPath = join(this.cacheDir, META_FILE)
      await writeFile(`${binaryPath}.tmp`, updated.serialize())
      await rename(`${binaryPath}.tmp`, binaryPath)
      await writeFile(`${metaPath}.tmp`, JSON.stringify({ updatedAt: this.updatedAt, source: ADGUARD_BASE_URL }))
      await rename(`${metaPath}.tmp`, metaPath)
    } catch (error) {
      // Keep the last valid engine; never interrupt browsing or downloads.
      console.warn('AdGuard 网络规则暂不可用：', error)
    }
  }
}
