import { session, WebContentsView } from 'electron'
import type { BrowseChapterLink, BrowseReadingChapter, BrowseReadingPage, SiteRule, WebShelfChapter } from '../shared/types'
import { discoverChapterLinks, extractBrowseReadingPage } from './browseReading'
import { extractCatalog, extractPage } from './extract'
import { findContinuationUrls } from './paywallUnlock'
import { findSiteRuleForUrl } from './siteRules'
import { DOWNLOAD_SESSION_PARTITION, HIDDEN_VIEW_BOUNDS, isDownloadBusy } from './download'
import { canonicalizeUrl } from '../shared/urlHash'

/**
 * 网页阅读会话：用隐藏视图取章节 HTML，供阅读模式续章、目录跳章与书架续读使用。
 *
 * 与下载的隐藏视图分开：同一个 webContents 被下载任务抢占会把正文取成别的页。
 * 两者共用 `persist:novel`，登录态与 Cookie 一致。
 */
const LOAD_TIMEOUT_MS = 8_000
const PAGE_CACHE_LIMIT = 6
const CATALOG_CACHE_LIMIT = 4

export type ReadingPageResult =
  | { ok: true; page: BrowseReadingPage; cached: boolean }
  | { ok: false; message: string }

export interface PageBootstrap {
  pageUrl: string
  pageKind: 'catalog' | 'chapter'
  title: string
  author: string
  coverUrl?: string
  catalogUrl: string
  chapters: WebShelfChapter[]
}

let view: WebContentsView | null = null
let queue: Promise<unknown> = Promise.resolve()
let htmlLoaderForTests: ((url: string) => Promise<string>) | null = null

const pageCache = new Map<string, BrowseReadingPage>()
const catalogCache = new Map<string, WebShelfChapter[]>()

function isHttpUrl(url: string): boolean {
  if (typeof url !== 'string') return false
  try { return ['http:', 'https:'].includes(new URL(url).protocol) } catch { return false }
}

function cacheKey(url: string): string {
  try { return canonicalizeUrl(url) } catch { return url }
}

/** 测试钩子：替掉真实隐藏视图的抓取。 */
export function setReadingHtmlLoaderForTests(loader: ((url: string) => Promise<string>) | null): void {
  htmlLoaderForTests = loader
}

/** 测试钩子：清空会话状态与缓存。 */
export function dropReadingSessionForTests(): void {
  pageCache.clear()
  catalogCache.clear()
  htmlLoaderForTests = null
  if (view && !view.webContents.isDestroyed()) {
    try { view.webContents.stop() } catch { /* view already gone */ }
  }
  view = null
  queue = Promise.resolve()
}

export function destroyReadingSession(): void {
  if (view && !view.webContents.isDestroyed()) {
    try { view.webContents.stop() } catch { /* view already gone */ }
  }
  view = null
  pageCache.clear()
  catalogCache.clear()
}

function readingView(): WebContentsView {
  if (!view || view.webContents.isDestroyed()) {
    view = new WebContentsView({
      webPreferences: {
        session: session.fromPartition(DOWNLOAD_SESSION_PARTITION),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
  }
  // 不挂到窗口上：隐藏视图只负责取 HTML，不参与焦点与命中测试。
  view.setVisible(false)
  view.setBounds(HIDDEN_VIEW_BOUNDS)
  return view
}

/** 同一视图不能并发导航，取页一律排队。 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.then(() => undefined, () => undefined)
  return run
}

function settleNavigation(wc: Electron.WebContents, url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      wc.removeListener('did-finish-load', onOk)
      wc.removeListener('did-fail-load', onFail)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      finish(new Error('章节加载超时，请检查网络或稍后再试'))
      try { wc.stop() } catch { /* view already gone */ }
    }, LOAD_TIMEOUT_MS)
    const onOk = (): void => finish()
    const onFail = (_event: Electron.Event, code: number, desc: string, _url: string, isMainFrame: boolean): void => {
      if (!isMainFrame || code === -3) return
      finish(new Error(desc || `加载失败 (${code})`))
    }
    wc.on('did-finish-load', onOk)
    wc.on('did-fail-load', onFail)
    void wc.loadURL(url).catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error)
      if (text.includes('ERR_ABORTED') || text.includes('error code: -3')) return
      finish(error instanceof Error ? error : new Error(text))
    })
  })
}

async function fetchHtml(url: string): Promise<string> {
  if (htmlLoaderForTests) return htmlLoaderForTests(url)
  const wc = readingView().webContents
  await settleNavigation(wc, url)
  // 兜底防串页：若期间有别的导航抢先完成（或站点重定向到别处），这里取到的就不是要的页，
  // 宁可报错也不能把别章正文按本 URL 缓存。enqueue 串行已能挡住绝大多数情况，这里是最后一道。
  const landed = wc.getURL()
  if (landed && landed !== url && canonicalizeUrl(landed) !== canonicalizeUrl(url)) {
    throw new Error('页面已跳转，未取到目标章节')
  }
  const html = await wc.executeJavaScript('document.documentElement.outerHTML') as string
  if (typeof html !== 'string' || !html) throw new Error('这个页面没有取到内容')
  return html
}

function rememberPage(key: string, page: BrowseReadingPage): void {
  pageCache.delete(key)
  pageCache.set(key, page)
  while (pageCache.size > PAGE_CACHE_LIMIT) {
    const oldest = pageCache.keys().next()
    if (oldest.done) break
    pageCache.delete(oldest.value)
  }
}

function rememberCatalog(key: string, chapters: WebShelfChapter[]): void {
  catalogCache.delete(key)
  catalogCache.set(key, chapters)
  while (catalogCache.size > CATALOG_CACHE_LIMIT) {
    const oldest = catalogCache.keys().next()
    if (oldest.done) break
    catalogCache.delete(oldest.value)
  }
}

/** 站点把一章切成多页时，最多再接这么多续页（与下载路径同一上限）。 */
const MAX_READING_CONTINUATION_PAGES = 3

/**
 * 站点分页章节（「第1/2页」）只给当前页 HTML，正文会缺后半章。
 * 复用付费墙那套续页候选探测，逐页抓取拼在正文后；单页失败跳过，不改判主体。
 * **必须已在 enqueue 内调用**（内部直接用 fetchHtml 导航共享隐藏视图）；外部入口用
 * 下面的 `appendReadingContinuations`，它会自行排队。
 */
async function appendReadingContinuationsInner(body: string, html: string, url: string, rule?: SiteRule): Promise<string> {
  let urls: string[]
  try {
    urls = findContinuationUrls(html, url, MAX_READING_CONTINUATION_PAGES)
  } catch {
    return body
  }
  let merged = body
  for (const next of urls.slice(0, MAX_READING_CONTINUATION_PAGES)) {
    try {
      const partHtml = await fetchHtml(next)
      const partRule = await findSiteRuleForUrl(next).catch(() => rule)
      const part = extractBrowseReadingPage(partHtml, next, partRule)
      if (!part.ok || !part.page.body) continue
      if (merged.includes(part.page.body)) continue
      merged = `${merged}\n\n${part.page.body}`
    } catch {
      /* 续页抓取失败不改判主体 */
    }
  }
  return merged
}

/**
 * 补抓续页的对外入口：自行排队，避免与其它取页任务在同一隐藏视图上并发导航。
 * 可见页分支（browse.readingPage）不在本模块的队列里，必须走这个版本。
 */
export function appendReadingContinuations(body: string, html: string, url: string, rule?: SiteRule): Promise<string> {
  return enqueue(() => appendReadingContinuationsInner(body, html, url, rule))
}

async function buildReadingPage(html: string, url: string): Promise<BrowseReadingPage> {
  let rule
  try { rule = await findSiteRuleForUrl(url) } catch { rule = undefined }
  const result = extractBrowseReadingPage(html, url, rule)
  if (!result.ok) throw new Error(result.message)
  const links = discoverChapterLinks(html, url, rule)
  // buildReadingPage 已在本模块队列内，用 Inner 版避免自锁。
  const body = await appendReadingContinuationsInner(result.page.body, html, url, rule)
  const chapter: BrowseReadingChapter = {
    title: result.page.title,
    url,
    previous: links.previous as BrowseChapterLink | undefined,
    next: links.next as BrowseChapterLink | undefined,
  }
  return { ...result.page, body, chapter }
}

/** 已缓存的章节页；命中即代表续章可以瞬时切换。 */
export function peekCachedReadingPage(url: string): BrowseReadingPage | null {
  if (!isHttpUrl(url)) return null
  return pageCache.get(cacheKey(url)) ?? null
}

export async function loadReadingPage(url: string): Promise<ReadingPageResult> {
  if (!isHttpUrl(url)) return { ok: false, message: '只支持 http(s) 地址' }
  const key = cacheKey(url)
  const cached = pageCache.get(key)
  if (cached) {
    rememberPage(key, cached)
    return { ok: true, page: cached, cached: true }
  }
  try {
    const page = await enqueue(async () => buildReadingPage(await fetchHtml(url), url))
    rememberPage(key, page)
    return { ok: true, page, cached: false }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '章节加载失败' }
  }
}

/** 只预热缓存，不返回正文。下载忙时让路，避免和下载抢站点限流。 */
export async function prefetchReadingPage(url: string): Promise<{ ok: boolean; cached: boolean }> {
  if (!isHttpUrl(url)) return { ok: false, cached: false }
  if (pageCache.has(cacheKey(url))) return { ok: true, cached: true }
  if (isDownloadBusy()) return { ok: false, cached: false }
  const result = await loadReadingPage(url)
  return { ok: result.ok, cached: false }
}

export async function loadCatalog(catalogUrl: string): Promise<{ ok: true; catalogUrl: string; chapters: WebShelfChapter[] } | { ok: false; message: string }> {
  if (!isHttpUrl(catalogUrl)) return { ok: false, message: '目录地址无效' }
  const key = cacheKey(catalogUrl)
  const cached = catalogCache.get(key)
  if (cached && cached.length) {
    rememberCatalog(key, cached)
    return { ok: true, catalogUrl, chapters: cached }
  }
  try {
    const chapters = await enqueue(async () => {
      const html = await fetchHtml(catalogUrl)
      let rule
      try { rule = await findSiteRuleForUrl(catalogUrl) } catch { rule = undefined }
      return extractCatalog(html, catalogUrl, rule).map((chapter) => ({ title: chapter.title, url: chapter.url }))
    })
    if (!chapters.length) return { ok: false, message: '这个页面里没有找到章节目录' }
    rememberCatalog(key, chapters)
    return { ok: true, catalogUrl, chapters }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '目录加载失败' }
  }
}

/**
 * 从任意页取书目信息：目录页直接给章节表，章节页给书名/作者与目录地址。
 * 识别不出书目时不报错，退回「用页面标题当书名、正文页当目录入口」。
 */
export async function loadPageBootstrap(url: string): Promise<{ ok: true; bootstrap: PageBootstrap } | { ok: false; message: string }> {
  if (!isHttpUrl(url)) return { ok: false, message: '只支持 http(s) 地址' }
  let html: string
  try {
    html = await enqueue(() => fetchHtml(url))
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '页面加载失败' }
  }
  let rule
  try { rule = await findSiteRuleForUrl(url) } catch { rule = undefined }
  const extracted = extractPage(html, url, undefined, rule)
  const readingPage = extractBrowseReadingPage(html, url, rule)
  const fallbackTitle = readingPage.ok ? readingPage.page.title : ''
  if (extracted.ok && extracted.bootstrap) {
    const bs = extracted.bootstrap
    const isCatalog = extracted.pageKind === 'catalog'
    return {
      ok: true,
      bootstrap: {
        pageUrl: url,
        pageKind: isCatalog ? 'catalog' : 'chapter',
        title: bs.bookTitle || fallbackTitle || '未命名',
        author: bs.author || '',
        coverUrl: bs.coverUrl,
        catalogUrl: isCatalog ? url : bs.catalogUrl || url,
        chapters: isCatalog ? bs.chapters.map((chapter) => ({ title: chapter.title, url: chapter.url })) : [],
      },
    }
  }
  if (!fallbackTitle) return { ok: false, message: '这个页面里没有识别出书名或正文' }
  return {
    ok: true,
    bootstrap: {
      pageUrl: url,
      pageKind: 'chapter',
      title: fallbackTitle,
      author: '',
      catalogUrl: url,
      chapters: [],
    },
  }
}
