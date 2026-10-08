/**
 * 通用小说提取器（不绑站点）。
 *
 * 对当前页 HTML 跑一套启发式，按得分选最优。
 * 不写站点插件；失败返回 FailCode。
 */
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import type { CatalogChapter, ExtractBootstrap, FailCode, PageKind, SiteRule } from '../shared/types'
import { FAIL_CODE_ZH } from '../shared/types'
import { canonicalizeUrl, isPathLikeHash } from '../shared/urlHash'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function visibleText(el: Element): string {
  return (el.textContent || '').replace(/\s+/g, ' ').trim()
}

const BODY_BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'DIV', 'H1', 'H2', 'H3', 'H4', 'LI', 'P', 'SECTION'])
const BODY_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'])

/** Preserve paragraph boundaries so standalone site notices can be identified safely. */
function bodyText(el: Element): string {
  const chunks: string[] = []
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      chunks.push(node.textContent ?? '')
      return
    }
    if (node.nodeType !== 1) return
    const element = node as Element
    if (BODY_SKIP.has(element.tagName)) return
    if (element.tagName === 'BR') {
      chunks.push('\n\n')
      return
    }
    const block = BODY_BLOCKS.has(element.tagName)
    if (block) chunks.push('\n\n')
    for (const child of element.childNodes) walk(child)
    if (block) chunks.push('\n\n')
  }
  walk(el)
  return chunks.join('')
    .replace(/\u00a0/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function linkDensity(el: Element): number {
  const total = visibleText(el).length || 1
  const linkLen = [...el.querySelectorAll('a')].reduce((s, a) => s + visibleText(a).length, 0)
  return linkLen / total
}

function catalogSeenKey(url: string): string {
  try {
    return canonicalizeUrl(url)
  } catch {
    return url
  }
}

function resolveCatalogHref(rawHref: string, pageUrl: string, resolvedHref?: string): string {
  const raw = (rawHref || '').trim()
  const candidates = [resolvedHref, raw]
  for (const c of candidates) {
    if (!c) continue
    try {
      return new URL(c, pageUrl).href
    } catch {
      /* try next */
    }
  }
  return resolvedHref || raw
}

/** Empty, javascript:, and in-page fragments (`#`, `#top`, `#content`, `#list`). Keep `#/…` routes. */
function shouldSkipCatalogHref(rawHref: string, resolvedHref?: string): boolean {
  const raw = (rawHref || '').trim()
  if (!raw) return true
  if (/^javascript:/i.test(raw)) return true

  if (raw.startsWith('#')) return !isPathLikeHash(raw)

  try {
    const u = new URL(resolvedHref || raw)
    if (isPathLikeHash(u.hash)) return false
    const path = u.pathname.replace(/\/+$/, '') || '/'
    if (u.hash && !isPathLikeHash(u.hash) && path === '/') return true
  } catch {
    const i = raw.indexOf('#')
    if (i >= 0) return !isPathLikeHash(raw.slice(i))
  }
  return false
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

function ruleSelector(value?: string): string | undefined {
  const s = (value ?? '').trim()
  return s || undefined
}

function querySafe(doc: Document, selector: string): Element | null {
  try {
    return doc.querySelector(selector)
  } catch {
    return null
  }
}

function textFromRuleSelector(doc: Document, selector?: string): string {
  const sel = ruleSelector(selector)
  if (!sel) return ''
  const el = querySafe(doc, sel)
  return el ? visibleText(el) : ''
}

function bookTitleWithRule(doc: Document, rule?: SiteRule): string {
  return textFromRuleSelector(doc, rule?.title) || extractBookTitle(doc)
}

function authorWithRule(doc: Document, rule?: SiteRule): string {
  return textFromRuleSelector(doc, rule?.author) || extractAuthor(doc)
}

interface CatalogHit {
  bookTitle: string
  author: string
  coverUrl?: string
  chapters: CatalogChapter[]
}

function tryCatalogFromRule(doc: Document, pageUrl: string, rule?: SiteRule): CatalogHit | null {
  const sel = ruleSelector(rule?.catalog)
  if (!sel) return null
  const container = querySafe(doc, sel)
  if (!container) return null
  let anchors: HTMLAnchorElement[] = []
  try {
    anchors = [...container.querySelectorAll('a[href]')] as HTMLAnchorElement[]
  } catch {
    return null
  }
  const seen = new Set<string>()
  const chapters: CatalogChapter[] = []
  let index = 0
  for (const a of anchors) {
    const rawHref = (a.getAttribute('href') || '').trim()
    if (shouldSkipCatalogHref(rawHref, a.href)) continue
    if (!sameDomain(a.href, pageUrl)) continue
    const text = visibleText(a)
    if (text.length < 1 || text.length > 100) continue
    const url = resolveCatalogHref(rawHref, pageUrl, a.href)
    const href = catalogSeenKey(url)
    if (seen.has(href)) continue
    seen.add(href)
    index++
    chapters.push({ title: text, url, index })
  }
  if (chapters.length < 2) return null
  return {
    bookTitle: bookTitleWithRule(doc, rule),
    author: authorWithRule(doc, rule),
    chapters,
  }
}

function tryBodyFromRule(doc: Document, rule?: SiteRule): string | null {
  const sel = ruleSelector(rule?.body)
  if (!sel) return null
  const el = querySafe(doc, sel)
  if (!el) return null
  // A site rule may intentionally point at a text/plain script carrying the chapter.
  const text = cleanBodyText(el.tagName === 'SCRIPT' ? visibleText(el) : bodyText(el))
  if (effectiveLength(text) >= 80) return text
  return null
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

function tryCatalogFromDoc(doc: Document, pageUrl: string): CatalogHit | null {
  const allLinks = [...doc.querySelectorAll('a[href]')] as HTMLAnchorElement[]
  // Group by parent container
  const containers = new Map<Element, HTMLAnchorElement[]>()
  for (const a of allLinks) {
    const rawHref = (a.getAttribute('href') || '').trim()
    if (shouldSkipCatalogHref(rawHref, a.href)) continue
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
    const rawHref = (a.getAttribute('href') || '').trim()
    const url = resolveCatalogHref(rawHref, pageUrl, a.href)
    const href = catalogSeenKey(url)
    if (seen.has(href)) continue
    seen.add(href)
    index++
    chapters.push({ title: visibleText(a), url, index })
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
  const catalogTexts = [
    '目录',
    '章节列表',
    '返回目录',
    '回目录',
    '返回书页',
    '书页',
    '查看所有章节',
    '所有章节',
    'TOC',
    'Chapter List',
  ]
  const anchors = [...doc.querySelectorAll('a[href]')] as HTMLAnchorElement[]
  for (const a of anchors) {
    const text = visibleText(a)
    const rawHref = (a.getAttribute('href') || '').trim()
    if (shouldSkipCatalogHref(rawHref, a.href)) continue
    if (catalogTexts.some((t) => text.includes(t)) && sameDomain(a.href, pageUrl)) {
      return resolveCatalogHref(rawHref, pageUrl, a.href)
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

const AD_PARAGRAPHS = [
  /^(?:最新网址|最新地址|本站网址|本书地址|小说最新地址).{0,100}(?:https?:\/\/|www\.|\.(?:com|net|cn|cc|org)|请收藏|搜索)/i,
  /^(?:请|记得)(?:先)?(?:收藏|关注)(?:本站|本书|本网站|我们的)?(?:网址|地址|域名|微信公众号|公众号|QQ群).{0,100}$/,
  /^(?:广告|推广|友情提示)[:：]\s*.{5,120}(?:点击|下载|关注|访问|网址|公众号|扫码|注册)/,
]

function cleanAdParagraphs(raw: string): string {
  let removed = 0
  const kept = raw.split(/\n{2,}/).filter((paragraph) => {
    const text = paragraph.trim()
    if (!text || text.length > 160 || !AD_PARAGRAPHS.some((pattern) => pattern.test(text))) return true
    removed++
    return false
  })
  if (!removed) return raw
  const cleaned = kept.join('\n\n').trim()
  const rawLength = effectiveLength(raw)
  const cleanedLength = effectiveLength(cleaned)
  return cleanedLength >= 80 && cleanedLength >= rawLength * 0.7 ? cleaned : raw
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
    const text = cleanBodyText(bodyText(el))
    if (effectiveLength(text) >= 80) return { body: text, ok: true, partialText: text }
    if (text.length > 0) return { body: '', ok: false, partialText: text }
  }

  // 2. Readability
  try {
    const article = new Readability(doc).parse()
    if (article && article.textContent) {
      const articleDoc = doc.createElement('div')
      articleDoc.innerHTML = article.content ?? ''
      const text = cleanBodyText(bodyText(articleDoc))
      if (effectiveLength(text) >= 80) return { body: text, ok: true, partialText: text }
      if (text.length > 0) return { body: '', ok: false, partialText: text }
    }
  } catch { /* skip */ }

  // 3. Largest text block
  const blocks = doc.querySelectorAll('div, section, article')
  let best: { el: Element; len: number } | null = null
  for (const el of blocks) {
    if (linkDensity(el) > 0.35) continue
    const len = effectiveLength(bodyText(el))
    if (len >= 80 && (!best || len > best.len)) {
      best = { el, len }
    }
  }
  if (best) {
    const text = cleanBodyText(bodyText(best.el))
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

// 付费墙的判据只有「话术」是不够的：站点页头页脚常带 VIP/会员入口。
// 因此额外要求正文很短——真章不会只剩个开头。
const PAYWALL_MAX_EFFECTIVE = 800
const PAYWALL_TEXT = [
  '购买本章',
  '付费阅读',
  '付费章节',
  '本章需要付费',
  '本章需付费',
  '付费解锁',
  '订阅后可读',
  '订阅后阅读',
  '请输入订阅密码',
  '会员后可读',
  'VIP章节',
  '解锁本章',
  '解锁后续',
  '打赏解锁',
  '本章试读',
  '剩余章节需',
]

function isPaywall(doc: Document, bodyText: string): boolean {
  const effective = effectiveLength(bodyText)
  if (bodyText.length > 0) {
    if (effective > PAYWALL_MAX_EFFECTIVE) return false
    return PAYWALL_TEXT.some((w) => `${doc.title || ''} ${bodyText}`.includes(w))
  }
  const pageText = doc.body ? visibleText(doc.body) : ''
  return PAYWALL_TEXT.some((w) => `${doc.title || ''} ${pageText}`.includes(w))
}

const INTERCEPT_TITLE = ['安全验证', '人机验证', 'Access Denied', 'Just a moment', 'Attention Required']
const INTERCEPT_TEXT = ['请完成人机验证', '检测到异常访问', '点击按钮继续', 'Cloudflare', 'Access Denied']

function isInterceptedPage(doc: Document, bodyText: string): boolean {
  if (isLoginWall(doc, bodyText)) return false
  const title = doc.title || ''
  if (INTERCEPT_TITLE.some((w) => title.includes(w))) return true
  const pageText = `${bodyText} ${doc.body ? visibleText(doc.body) : ''}`
  return INTERCEPT_TEXT.some((w) => pageText.includes(w))
}

type WallKind = 'NeedLogin' | 'Paywall' | 'Intercepted'

/** 一处判定，extractPage / extractBody 共用；顺序即优先级。 */
function classifyWall(doc: Document, text: string): WallKind | null {
  if (isLoginWall(doc, text)) return 'NeedLogin'
  if (isPaywall(doc, text)) return 'Paywall'
  if (isInterceptedPage(doc, text)) return 'Intercepted'
  return null
}

function wallFail(kind: WallKind, pageKind: PageKind): ExtractResult {
  return { ok: false, pageKind, failCode: kind, failMessage: FAIL_CODE_ZH[kind] }
}

function bodyWallFail(kind: WallKind): { body: string; ok: boolean; failCode: FailCode; failMessage: string } {
  return { body: '', ok: false, failCode: kind, failMessage: FAIL_CODE_ZH[kind] }
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
 * @param rule 可选站点规则；0 命中 / 非法 CSS / 短正文回退通用路径
 */
export function extractPage(html: string, pageUrl: string, catalogHint?: string, rule?: SiteRule): ExtractResult {
  const dom = new JSDOM(html, { url: pageUrl })
  const doc = dom.window.document

  const ruledCatalog = tryCatalogFromRule(doc, pageUrl, rule)
  if (ruledCatalog && ruledCatalog.chapters.length >= 2) {
    return {
      ok: true,
      pageKind: 'catalog',
      bootstrap: {
        pageKind: 'catalog',
        bookTitle: ruledCatalog.bookTitle,
        author: ruledCatalog.author,
        coverUrl: ruledCatalog.coverUrl,
        chapters: ruledCatalog.chapters,
      },
    }
  }

  // Try catalog first
  const catalog = tryCatalogFromDoc(doc, pageUrl)
  if (catalog && catalog.chapters.length >= 5) {
    return {
      ok: true,
      pageKind: 'catalog',
      bootstrap: {
        pageKind: 'catalog',
        bookTitle: bookTitleWithRule(doc, rule) || catalog.bookTitle,
        author: authorWithRule(doc, rule) || catalog.author,
        coverUrl: catalog.coverUrl,
        chapters: catalog.chapters,
      },
    }
  }

  const ruledBody = tryBodyFromRule(doc, rule)
  if (ruledBody) {
    const wall = classifyWall(doc, ruledBody)
    if (wall) return wallFail(wall, 'chapter')
    const catalogUrl = findCatalogLink(doc, pageUrl)
    return {
      ok: true,
      pageKind: 'chapter',
      bootstrap: {
        pageKind: 'chapter',
        bookTitle: bookTitleWithRule(doc, rule),
        author: authorWithRule(doc, rule),
        catalogUrl: catalogUrl || catalogHint || undefined,
        chapters: [],
      },
      body: ruledBody,
    }
  }

  // Try body extraction (likely a chapter page)
  const { body, ok: bodyOk, partialText } = tryExtractBody(doc)
  if (bodyOk) {
    const wall = classifyWall(doc, body)
    if (wall) return wallFail(wall, 'chapter')
    // This looks like a chapter page - try to find catalog link
    const catalogUrl = findCatalogLink(doc, pageUrl)
    return {
      ok: true,
      pageKind: 'chapter',
      bootstrap: {
        pageKind: 'chapter',
        bookTitle: bookTitleWithRule(doc, rule),
        author: authorWithRule(doc, rule),
        catalogUrl: catalogUrl || catalogHint || undefined,
        chapters: [], // will be filled after fetching catalog
      },
      body,
    }
  }

  // Body too short / empty — a wall (login, paywall, captcha) explains why
  if (partialText.length > 0) {
    const wall = classifyWall(doc, partialText)
    if (wall) return wallFail(wall, 'unknown')
    return { ok: false, pageKind: 'unknown', failCode: 'BodyEmpty', failMessage: '正文为空或过短' }
  }

  // No body found at all — the surrounding page text may say why
  const wall = classifyWall(doc, '')
  if (wall) return wallFail(wall, 'unknown')

  return { ok: false, pageKind: 'unknown', failCode: 'UnknownPage', failMessage: '无法识别为书' }
}

/**
 * 从目录页 HTML 提取章节列表。
 */
export function extractCatalog(html: string, catalogUrl: string, rule?: SiteRule): CatalogChapter[] {
  const dom = new JSDOM(html, { url: catalogUrl })
  const doc = dom.window.document
  const ruled = tryCatalogFromRule(doc, catalogUrl, rule)
  if (ruled && ruled.chapters.length >= 2) return ruled.chapters
  const hit = tryCatalogFromDoc(doc, catalogUrl)
  return hit?.chapters ?? []
}

/**
 * 从章页 HTML 提取正文。
 */
export function extractBody(
  html: string,
  pageUrl: string,
  rule?: SiteRule,
): { body: string; bodyRaw?: string; ok: boolean; failCode?: FailCode; failMessage?: string } {
  const dom = new JSDOM(html, { url: pageUrl })
  const doc = dom.window.document
  const ruledBody = tryBodyFromRule(doc, rule)
  if (ruledBody) {
    const wall = classifyWall(doc, ruledBody)
    if (wall) return bodyWallFail(wall)
    return { body: cleanAdParagraphs(ruledBody), bodyRaw: ruledBody, ok: true }
  }
  const { body, ok, partialText } = tryExtractBody(doc)
  if (!ok) {
    const wall = classifyWall(doc, partialText)
    if (wall) return bodyWallFail(wall)
    return { body: '', ok: false, failCode: 'BodyEmpty', failMessage: '正文为空或过短' }
  }
  const wall = classifyWall(doc, body)
  if (wall) return bodyWallFail(wall)
  return { body: cleanAdParagraphs(body), bodyRaw: body, ok: true }
}
