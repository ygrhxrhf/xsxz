/**
 * 通用小说提取器（不绑站点）。
 *
 * 对当前页 HTML 跑一套启发式，按得分选最优。
 * 不写站点插件；失败返回 FailCode。
 */
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import type { CatalogChapter, ExtractBootstrap, FailCode, PageKind } from '../shared/types'
import { FAIL_CODE_ZH } from '../shared/types'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function visibleText(el: Element): string {
  return (el.textContent || '').replace(/\s+/g, ' ').trim()
}

function linkDensity(el: Element): number {
  const total = visibleText(el).length || 1
  const linkLen = [...el.querySelectorAll('a')].reduce((s, a) => s + visibleText(a).length, 0)
  return linkLen / total
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url)
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return url
  }
}

function sameDomain(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// title extraction
// ---------------------------------------------------------------------------

const SITE_SUFFIX_RE = /[-_|—]\s*[^-\s|_—]{2,30}\s*$/

function extractBookTitle(doc: Document): string {
  // og:title
  const og = doc.querySelector('meta[property="og:title"]')
  if (og) return og.getAttribute('content')?.replace(SITE_SUFFIX_RE, '').trim() || ''
  // h1
  const h1 = doc.querySelector('h1')
  if (h1 && visibleText(h1).length >= 2) return visibleText(h1).replace(SITE_SUFFIX_RE, '').trim()
  // <title>
  return (doc.title || '').replace(SITE_SUFFIX_RE, '').trim()
}

function extractAuthor(doc: Document): string {
  const og = doc.querySelector('meta[property="og:novel:author"]')
  if (og) return og.getAttribute('content')?.trim() || ''
  const el = doc.querySelector('.author, .bookinfo a[href*="author"], .info .author')
  return el ? visibleText(el) : ''
}

// ---------------------------------------------------------------------------
// catalog detection
// ---------------------------------------------------------------------------

const CHAPTER_RE = /第[0-9一二三四五六七八九十百千万零〇两壹贰叁肆伍陆柒捌玖拾佰仟]+[章节卷回部集]|chapter\s*\d+/i
const SEQ_RE = /^\s*\d{1,4}\s*[.、:：\s]/u

function isChapterLink(a: HTMLAnchorElement): boolean {
  const text = visibleText(a)
  if (text.length < 2 || text.length > 100) return false
  return CHAPTER_RE.test(text) || SEQ_RE.test(text)
}

interface CatalogHit {
  bookTitle: string
  author: string
  coverUrl?: string
  chapters: CatalogChapter[]
}

function tryCatalogFromDoc(doc: Document, pageUrl: string): CatalogHit | null {
  const allLinks = [...doc.querySelectorAll('a[href]')] as HTMLAnchorElement[]
  // Group by parent container
  const containers = new Map<Element, HTMLAnchorElement[]>()
  for (const a of allLinks) {
    if (!sameDomain(a.href, pageUrl)) continue
    if (!isChapterLink(a)) continue
    const parent = a.parentElement || doc.body
    // Walk up past DD/LI/TR to find the common container (e.g. DL/UL/TABLE)
    let key: Element = parent
    while (/^(DD|LI|TR|DT)$/i.test(key.tagName) && key.parentElement) {
      key = key.parentElement
    }
    const arr = containers.get(key) || []
    arr.push(a)
    containers.set(key, arr)
  }

  let best: { container: Element; links: HTMLAnchorElement[] } | null = null
  for (const [container, links] of containers) {
    if (links.length < 5) continue
    if (!best || links.length > best.links.length) {
      best = { container, links }
    }
  }
  if (!best) return null

  const seen = new Set<string>()
  const chapters: CatalogChapter[] = []
  let index = 0
  for (const a of best.links) {
    const href = stripQuery(a.href)
    if (seen.has(href)) continue
    seen.add(href)
    index++
    chapters.push({ title: visibleText(a), url: a.href, index })
  }

  if (chapters.length < 5) return null

  return {
    bookTitle: extractBookTitle(doc),
    author: extractAuthor(doc),
    chapters,
  }
}

// ---------------------------------------------------------------------------
// catalog link discovery (from chapter page)
// ---------------------------------------------------------------------------

function findCatalogLink(doc: Document, pageUrl: string): string | null {
  const catalogTexts = ['目录', '章节列表', '返回目录', '回目录', '返回书页', '书页', 'TOC', 'Chapter List']
  const anchors = [...doc.querySelectorAll('a[href]')] as HTMLAnchorElement[]
  for (const a of anchors) {
    const text = visibleText(a)
    if (catalogTexts.some((t) => text.includes(t)) && sameDomain(a.href, pageUrl)) {
      return a.href
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// body extraction
// ---------------------------------------------------------------------------

const BODY_SELECTORS = [
  '#content',
  '#chaptercontent',
  '#booktext',
  '#BookText',
  '#readbook',
  '#partContent',
  '#novel_content',
  '#article_content',
  '#text_area',
  '.content',
  '.chapter-content',
  '.read-content',
  '.bookcontent',
  '.novelcontent',
  '.articlecontent',
  'article',
]

const NAV_LINE_RE = /(?:^|\s).{0,10}(?:上一[章节页]|下一[章节页]|返回目录|回目录|返回书页|目录).{0,10}(?=\s|$)/g

function cleanBodyText(text: string): string {
  return text
    .replace(NAV_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function effectiveLength(text: string): number {
  // Count CJK + alphanumeric, skip whitespace and punctuation
  return text.replace(/[\s\p{P}]/gu, '').length
}

function tryExtractBody(doc: Document): { body: string; ok: boolean; partialText: string } {
  // 1. Common selectors
  for (const sel of BODY_SELECTORS) {
    const el = doc.querySelector(sel)
    if (!el) continue
    const text = cleanBodyText(visibleText(el))
    if (effectiveLength(text) >= 80) return { body: text, ok: true, partialText: text }
    if (text.length > 0) return { body: '', ok: false, partialText: text }
  }

  // 2. Readability
  try {
    const article = new Readability(doc).parse()
    if (article && article.textContent) {
      const text = cleanBodyText(article.textContent)
      if (effectiveLength(text) >= 80) return { body: text, ok: true, partialText: text }
      if (text.length > 0) return { body: '', ok: false, partialText: text }
    }
  } catch { /* skip */ }

  // 3. Largest text block
  const blocks = doc.querySelectorAll('div, section, article')
  let best: { el: Element; len: number } | null = null
  for (const el of blocks) {
    if (linkDensity(el) > 0.35) continue
    const len = effectiveLength(visibleText(el))
    if (len >= 80 && (!best || len > best.len)) {
      best = { el, len }
    }
  }
  if (best) {
    const text = cleanBodyText(visibleText(best.el))
    return { body: text, ok: true, partialText: text }
  }

  return { body: '', ok: false, partialText: '' }
}

function isLoginWall(doc: Document, bodyText: string): boolean {
  const indicators = ['请登录', '登录后阅读', '需要登录']
  const title = (doc.title || '')
  // Check body text
  if (bodyText.length < 200 && indicators.some((w) => bodyText.includes(w))) return true
  // Check title
  if (title.includes('login') || title.includes('登录')) return true
  // Check full page text for login indicators when body is empty
  if (bodyText.length === 0) {
    const pageText = visibleText(doc.body)
    if (indicators.some((w) => pageText.includes(w))) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export interface ExtractResult {
  ok: boolean
  pageKind: PageKind
  bootstrap?: ExtractBootstrap
  body?: string
  failCode?: FailCode
  failMessage?: string
}

/**
 * 从当前页 HTML 推断页面类型并提取内容。
 *
 * @param html 当前页 HTML 字符串
 * @param pageUrl 当前页 URL
 * @param catalogHint 若已知目录页 URL，传入以跳过目录发现
 */
export function extractPage(html: string, pageUrl: string, catalogHint?: string): ExtractResult {
  const dom = new JSDOM(html, { url: pageUrl })
  const doc = dom.window.document

  // Try catalog first
  const catalog = tryCatalogFromDoc(doc, pageUrl)
  if (catalog && catalog.chapters.length >= 5) {
    return {
      ok: true,
      pageKind: 'catalog',
      bootstrap: {
        pageKind: 'catalog',
        bookTitle: catalog.bookTitle,
        author: catalog.author,
        coverUrl: catalog.coverUrl,
        chapters: catalog.chapters,
      },
    }
  }

  // Try body extraction (likely a chapter page)
  const { body, ok: bodyOk, partialText } = tryExtractBody(doc)
  if (bodyOk) {
    if (isLoginWall(doc, body)) {
      return { ok: false, pageKind: 'chapter', failCode: 'NeedLogin', failMessage: FAIL_CODE_ZH.NeedLogin }
    }
    // This looks like a chapter page - try to find catalog link
    const catalogUrl = findCatalogLink(doc, pageUrl)
    return {
      ok: true,
      pageKind: 'chapter',
      bootstrap: {
        pageKind: 'chapter',
        bookTitle: extractBookTitle(doc),
        author: extractAuthor(doc),
        catalogUrl: catalogUrl || catalogHint || undefined,
        chapters: [], // will be filled after fetching catalog
      },
      body,
    }
  }

  // Body too short / empty — check login wall on partial text
  if (partialText.length > 0) {
    if (isLoginWall(doc, partialText)) {
      return { ok: false, pageKind: 'unknown', failCode: 'NeedLogin', failMessage: FAIL_CODE_ZH.NeedLogin }
    }
    return { ok: false, pageKind: 'unknown', failCode: 'BodyEmpty', failMessage: '正文为空或过短' }
  }

  // No body found at all — check login wall on full page text
  if (isLoginWall(doc, '')) {
    return { ok: false, pageKind: 'unknown', failCode: 'NeedLogin', failMessage: FAIL_CODE_ZH.NeedLogin }
  }

  return { ok: false, pageKind: 'unknown', failCode: 'UnknownPage', failMessage: '无法识别为书' }
}

/**
 * 从目录页 HTML 提取章节列表。
 */
export function extractCatalog(html: string, catalogUrl: string): CatalogChapter[] {
  const dom = new JSDOM(html, { url: catalogUrl })
  const doc = dom.window.document
  const hit = tryCatalogFromDoc(doc, catalogUrl)
  return hit?.chapters ?? []
}

/**
 * 从章页 HTML 提取正文。
 */
export function extractBody(html: string, pageUrl: string): { body: string; ok: boolean; failCode?: FailCode; failMessage?: string } {
  const dom = new JSDOM(html, { url: pageUrl })
  const doc = dom.window.document
  const { body, ok, partialText } = tryExtractBody(doc)
  if (!ok) {
    if (isLoginWall(doc, partialText)) {
      return { body: '', ok: false, failCode: 'NeedLogin', failMessage: FAIL_CODE_ZH.NeedLogin }
    }
    return { body: '', ok: false, failCode: 'BodyEmpty', failMessage: '正文为空或过短' }
  }
  if (isLoginWall(doc, body)) {
    return { body: '', ok: false, failCode: 'NeedLogin', failMessage: FAIL_CODE_ZH.NeedLogin }
  }
  return { body, ok: true }
}
