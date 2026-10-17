/**
 * 通用小说提取器（不绑站点）。
 *
 * 对当前页 HTML 跑一套启发式，按得分选最优。
 * 不写站点插件；失败返回 FailCode。
 */
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import type { CatalogChapter, ExtractBootstrap, FailCode, PageKind, SiteRule, UnlockMethod } from '../shared/types'
import { FAIL_CODE_ZH } from '../shared/types'
import { canonicalizeUrl, isPathLikeHash } from '../shared/urlHash'
import { bodyText, cleanBodyText, effectiveLength, linkDensity, looksGarbled, visibleText } from './bodyText'
import { unlockAllowed, unlockPaywalledBody } from './paywallUnlock'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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

const CHAPTER_RE =
  /第[0-9一二三四五六七八九十百千万零〇两壹贰叁肆伍陆柒捌玖拾佰仟]+[章节卷回部集]|chapter\s*\d+|^(?:楔子|序章|序言|前言|引子|尾声|终章|后记|番外)/i
// 「001 背叛」「002重获新生」「3179」都算章名：数字后可以没有分隔符，也可以直接跟正文。
const SEQ_RE = /^\s*\d{1,5}\s*(?:[.、:：\s]|$|[\u4e00-\u9fff“”"「」])/u

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
    // 短篇 / 试读站的目录只有几章：门槛放到 2，靠下面的「像不像目录」兜住误判
    if (links.length < 2) continue
    if (!best || links.length > best.links.length) {
      best = { container, links }
    }
  }
  if (!best) return null

  // Biquge 类站点常把「最新章节」块和正文卷放在同一个 <dl> 里：
  // 前者是倒序的少量重复链接，后者才是完整目录。按 DT 分节后，
  // 与主节大量重叠的小节只补主节没有的新链接，且按「最新在前」倒序放回末尾。
  const urlOf = (a: HTMLAnchorElement): string =>
    resolveCatalogHref((a.getAttribute('href') || '').trim(), pageUrl, a.href)
  const keyOf = (a: HTMLAnchorElement): string => catalogSeenKey(urlOf(a))

  const sections = new Map<Element, HTMLAnchorElement[]>()
  for (const a of best.links) {
    let heading: Element | null = null
    if (/^DL$/i.test(best.container.tagName)) {
      const item = a.closest('dd, dt')
      heading = item && item.parentElement === best.container ? item : null
      while (heading && !/^DT$/i.test(heading.tagName)) heading = heading.previousElementSibling
    }
    const key = heading || best.container
    const arr = sections.get(key) || []
    arr.push(a)
    sections.set(key, arr)
  }

  const sectionKeys = new Map<Element, Set<string>>()
  for (const [section, links] of sections) sectionKeys.set(section, new Set(links.map(keyOf)))
  const main = [...sections.entries()].reduce((a, b) => (b[1].length > a[1].length ? b : a))
  const mainKeys = sectionKeys.get(main[0])!

  const seen = new Set<string>()
  const chapters: CatalogChapter[] = []
  let index = 0
  const push = (a: HTMLAnchorElement): void => {
    const url = urlOf(a)
    const key = catalogSeenKey(url)
    if (seen.has(key)) return
    seen.add(key)
    index++
    chapters.push({ title: visibleText(a), url, index })
  }

  const duplicateSections: HTMLAnchorElement[][] = []
  for (const [section, links] of sections) {
    if (section === main[0]) {
      for (const a of links) push(a)
      continue
    }
    const keys = sectionKeys.get(section)!
    let overlap = 0
    for (const key of keys) if (mainKeys.has(key)) overlap++
    if (keys.size > 0 && overlap / keys.size >= 0.5) duplicateSections.push(links)
    else for (const a of links) push(a)
  }
  for (const links of duplicateSections) for (const a of [...links].reverse()) push(a)

  if (chapters.length < 2) return null

  // 章节多的容器已经足够可信；只有短目录才要求它「长得像目录」，
  // 否则章节页侧栏的「最新更新 / 推荐阅读」散链会被当成整本书的目录。
  if (chapters.length < 5) {
    if (chapterTitleRatio(chapters) < 0.6) return null
    if (siblingPathRatio(chapters.map((c) => c.url)) < 0.6) return null
  }

  return {
    bookTitle: extractBookTitle(doc),
    author: extractAuthor(doc),
    chapters,
  }
}

/** 章节标题的常见写法：给「短目录」判定用，避免把侧栏推荐当目录。 */
const CHAPTER_TITLE_HINT_RE =
  /^\s*(?:第\s*[0-9一二三四五六七八九十百千万零〇两]+\s*[章节回]|正文|楔子|序章|序言|前言|番外|外传|后记|尾声|终章|\d{1,4}\s*[.、:：)）]?\s*\S)/

function chapterTitleRatio(chapters: Array<{ title: string }>): number {
  if (chapters.length === 0) return 0
  const hits = chapters.filter((c) => CHAPTER_TITLE_HINT_RE.test(c.title)).length
  return hits / chapters.length
}

/** 同一目录下的兄弟链接占比：目录页的链接地址几乎都长在同一个父路径下。 */
function siblingPathRatio(urls: string[]): number {
  if (urls.length < 2) return 0
  const parentOf = (u: string): string => {
    try {
      const parsed = new URL(u)
      // hash 路由的目录页（#/book/65/1.html）父路径在 hash 里，不能只看 pathname
      const path = `${parsed.pathname}${parsed.hash}`
      return path.slice(0, path.lastIndexOf('/'))
    } catch {
      return ''
    }
  }
  const counts = new Map<string, number>()
  for (const u of urls) {
    const key = parentOf(u)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  let max = 0
  for (const n of counts.values()) if (n > max) max = n
  return max / urls.length
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

const AD_PARAGRAPHS = [
  /^(?:最新网址|最新地址|本站网址|本书地址|小说最新地址).{0,100}(?:https?:\/\/|www\.|\.(?:com|net|cn|cc|org)|请收藏|搜索)/i,
  /^(?:请|记得)(?:先)?(?:收藏|关注)(?:本站|本书|本网站|我们的)?(?:网址|地址|域名|微信公众号|公众号|QQ群).{0,100}$/,
  /^(?:广告|推广|友情提示)[:：]\s*.{5,120}(?:点击|下载|关注|访问|网址|公众号|扫码|注册)/,
  // 站点声明：正文没删干净时每章末尾都挂着，阅读时极其扎眼
  /^(?:本书|本站|本网站)?[^\n]{0,30}(?:所有小说|所有章节|本站内容|本书内容)[^\n]{0,20}(?:转载|网友上传|来自互联网|收集整理|仅供)[^\n]{0,90}$/,
  /^[^\n]{0,40}(?:均为网友上传|由网友上传|仅为宣传本书|只为大家能|请支持正版|如有侵权请)[^\n]{0,70}$/,
  // 「一秒记住【笔趣阁】biquge365.net，更新快，无弹窗！」这类章首站名水印
  /^一秒记住[^\n]{0,80}$/,
  /^[^\n]{0,20}(?:记住|收藏)(?:本书|本站|本网站)[^\n]{0,80}(?:更新快|无弹窗|不迷路|请记住|域名|网址)[^\n]{0,40}$/,
]

/** 章内导航噪音：整段就是站点按钮或提示时删掉，正文段落不受影响。 */
const NAV_PARAGRAPHS = [
  /^(?:上一[章节回]|下一[章节回]|返回目录|回目录|章节目录|目录|书页|加入书架|加入书签|投推荐票|投月票|推荐本书|手机阅读|电脑阅读|字体大小|背景颜色|护眼模式|自动滚屏|本章未完|未完待续|点击下一页|翻页|下载本书)(?:\s*[（(【\[].{0,40}[）)】\]])?$/,
  /^(?:本站|小说网|顶点小说|笔趣|全文阅读|无弹窗|免费阅读|请记住本书首发域名)[^\n]{0,60}(?:https?:\/\/|www\.|\.[a-z]{2,6}\b|收藏|域名|地址)/i,
  /^(?:相关推荐|推荐阅读|猜你喜欢|热门推荐|其它作品|作者其他作品|喜欢本站|友情链接|精彩推荐)[:：]?$/,
  /^(?:章节错误|内容有误|举报本章|报错|意见反馈|商务合作|广告投放)[:：]?\s*.{0,40}$/,
  // 章节页的分页标记：「第190章 先生早晨(第1/2页)」整段只是标题+页码时删掉
  /^[^\n]{0,60}[（(]\s*第\s*\d+\s*\/\s*\d+\s*页\s*[）)]$/,
]

/** 完全相同的长段落只留一次：站点把正文连发两遍时清掉重复。 */
const REPEAT_PARAGRAPH_MIN_LENGTH = 12
const BODY_CLEAN_LINE_LIMIT = 200
const BODY_CLEAN_MAX_LINES = 20

/** 站点规则里的正文噪音正则：每行一条，非法行与超限行忽略，不抛错。 */
export function parseBodyCleanPatterns(value: string | undefined): RegExp[] {
  if (typeof value !== 'string' || !value.trim()) return []
  const patterns: RegExp[] = []
  for (const line of value.split('\n')) {
    const text = line.trim()
    if (!text || text.length > BODY_CLEAN_LINE_LIMIT) continue
    try { patterns.push(new RegExp(text, 'i')) } catch { /* 非法正则只忽略这一行 */ }
    if (patterns.length >= BODY_CLEAN_MAX_LINES) break
  }
  return patterns
}

/** 章内噪音与重复段清理：噪音删太多时整体放弃，避免把正文一起删掉。 */
function cleanAdParagraphs(raw: string, rule?: SiteRule): string {
  const extra = parseBodyCleanPatterns(rule?.bodyCleanPatterns)
  const isNoise = (text: string): boolean => {
    if (!text) return false
    if (text.length <= 160 && [...AD_PARAGRAPHS, ...NAV_PARAGRAPHS].some((pattern) => pattern.test(text))) return true
    return extra.length > 0 && extra.some((pattern) => pattern.test(text))
  }

  const paragraphs = raw.split(/\n{2,}/)
  let noiseRemoved = 0
  const noiseKept = paragraphs.filter((paragraph) => {
    const text = paragraph.trim()
    if (!text || !isNoise(text)) return true
    noiseRemoved++
    return false
  })

  let base = raw
  if (noiseRemoved) {
    const candidate = noiseKept.join('\n\n').trim()
    const rawLength = effectiveLength(raw)
    const candidateLength = effectiveLength(candidate)
    if (candidateLength >= 80 && candidateLength >= rawLength * 0.7) base = candidate
  }

  // 站点把同一段正文连发两遍时只留一次；去重可靠，不参与上面的回退判定。
  const seen = new Set<string>()
  const deduped = base.split(/\n{2,}/).filter((paragraph) => {
    const text = paragraph.trim()
    if (!text || text.length < REPEAT_PARAGRAPH_MIN_LENGTH) return true
    if (seen.has(text)) return false
    seen.add(text)
    return true
  })
  if (deduped.length === paragraphs.length) return base
  if (deduped.length === base.split(/\n{2,}/).length) return base
  const cleaned = deduped.join('\n\n').trim()
  return effectiveLength(cleaned) >= 80 ? cleaned : base
}

/** 文本从哪来的：正文容器里的截断章文才能用弱档付费词。 */
type BodySource = 'container' | 'fallback' | 'none'

function tryExtractBody(doc: Document): {
  body: string
  ok: boolean
  partialText: string
  source: BodySource
  /** 抽到的候选是乱码 / 字形替换：调用方据此报 BodyGarbled 而不是 BodyEmpty。 */
  garbled: boolean
} {
  // 1. Common selectors
  for (const sel of BODY_SELECTORS) {
    const el = doc.querySelector(sel)
    if (!el) continue
    const text = cleanBodyText(bodyText(el))
    const garbled = looksGarbled(text)
    if (effectiveLength(text) >= 80 && !garbled) return { body: text, ok: true, partialText: text, source: 'container', garbled: false }
    if (text.length > 0) return { body: '', ok: false, partialText: text, source: 'container', garbled }
  }

  // 2. Readability
  try {
    const article = new Readability(doc).parse()
    if (article && article.textContent) {
      const articleDoc = doc.createElement('div')
      articleDoc.innerHTML = article.content ?? ''
      const text = cleanBodyText(bodyText(articleDoc))
      const garbled = looksGarbled(text)
      if (effectiveLength(text) >= 80 && !garbled) return { body: text, ok: true, partialText: text, source: 'fallback', garbled: false }
      if (text.length > 0) return { body: '', ok: false, partialText: text, source: 'fallback', garbled }
    }
  } catch { /* skip */ }

  // 3. Largest text block
  const blocks = doc.querySelectorAll('div, section, article')
  let best: { el: Element; len: number } | null = null
  let sawGarbledBlock = false
  for (const el of blocks) {
    if (linkDensity(el) > 0.35) continue
    const text = bodyText(el)
    // 乱码块不能当候选：它的尺寸通常更大，选它等于把乱码写进书库
    if (looksGarbled(text)) {
      if (effectiveLength(text) >= 80) sawGarbledBlock = true
      continue
    }
    const len = effectiveLength(text)
    if (len >= 80 && (!best || len > best.len)) {
      best = { el, len }
    }
  }
  if (best) {
    const text = cleanBodyText(bodyText(best.el))
    return { body: text, ok: true, partialText: text, source: 'fallback', garbled: false }
  }

  return { body: '', ok: false, partialText: '', source: 'none', garbled: sawGarbledBlock }
}

function isLoginWall(doc: Document, bodyText: string): boolean {
  const indicators = ['请登录', '登录后阅读', '需要登录']
  const title = doc.title || ''
  // Check body text
  if (bodyText.length < 200 && indicators.some((w) => bodyText.includes(w))) return true
  // Check title: 站点页头常把「登录」两个字挂进 title，只算登录页那几种写法
  if (bodyText.length < 200 && /(请登录|用户登录|登录本站|login)/i.test(title)) return true
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
/** 明确的解锁话术：出现即说明这一章没打算白给。 */
const PAYWALL_STRONG = [
  '购买本章',
  '本章需要付费',
  '本章需付费',
  '付费解锁',
  '订阅后可读',
  '订阅后阅读',
  '请输入订阅密码',
  '解锁本章',
  '解锁后续',
  '打赏解锁',
  '本章试读',
  '剩余章节需',
]
/** 页头页脚常见入口文案：单独出现不足以证明这一章对你关闭。 */
const PAYWALL_AMBIGUOUS = ['付费阅读', '付费章节', 'VIP章节', '会员后可读']

function hitsPaywall(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w))
}

function isPaywall(doc: Document, bodyText: string, fromContainer: boolean): boolean {
  if (effectiveLength(bodyText) > PAYWALL_MAX_EFFECTIVE) return false
  const title = doc.title || ''
  const pageText = bodyText.length > 0 ? '' : doc.body ? visibleText(doc.body) : ''
  const haystack = `${title} ${bodyText}${pageText}`
  if (hitsPaywall(haystack, PAYWALL_STRONG)) return true
  // 弱档词站点到处都写：只有从正文容器截到一段被拦下的章文时，它才说明这一章对你关闭
  return fromContainer && hitsPaywall(bodyText, PAYWALL_AMBIGUOUS)
}

const INTERCEPT_TITLE = ['安全验证', '人机验证', 'Access Denied', 'Just a moment', 'Attention Required']
const INTERCEPT_TEXT = ['请完成人机验证', '检测到异常访问', '点击按钮继续', 'Cloudflare', 'Access Denied']

/**
 * 正文长到这个程度就当真：页面里再冒出拦截话术，也只是站点脚本 / 页脚的噪音。
 * 真正的验证页没有正文，长度天然上不去。
 */
const INTERCEPT_TRUST_MIN_EFFECTIVE = 400

function isInterceptedPage(doc: Document, body: string): boolean {
  if (isLoginWall(doc, body)) return false
  const title = doc.title || ''
  // 硬信号：标题本身就是验证页标题
  if (INTERCEPT_TITLE.some((w) => title.includes(w))) return true
  // 正文已经抽全：不再根据别处的关键词把这一章判成拦截页
  if (effectiveLength(body) >= INTERCEPT_TRUST_MIN_EFFECTIVE) return false
  // 软信号：只扫跳过 script / style 的页面文本，`<script>var x='Access Denied'` 不算证据
  const pageText = doc.body ? bodyText(doc.body) : ''
  return INTERCEPT_TEXT.some((w) => pageText.includes(w))
}

type WallKind = 'NeedLogin' | 'Paywall' | 'Intercepted'

/** 一处判定，extractPage / extractBody 共用；顺序即优先级。 */
function classifyWall(doc: Document, text: string, fromContainer: boolean): WallKind | null {
  if (isLoginWall(doc, text)) return 'NeedLogin'
  if (isPaywall(doc, text, fromContainer)) return 'Paywall'
  if (isInterceptedPage(doc, text)) return 'Intercepted'
  return null
}

function wallFail(kind: WallKind, pageKind: PageKind): ExtractResult {
  return { ok: false, pageKind, failCode: kind, failMessage: FAIL_CODE_ZH[kind] }
}

interface BodyWallFail {
  body: string
  ok: boolean
  failCode: FailCode
  failMessage: string
  /** 付费墙自动恢复的结论；没有试过时为 undefined。 */
  unlockReason?: string
}

function bodyWallFail(kind: WallKind, unlockReason?: string): BodyWallFail {
  const fail: BodyWallFail = { body: '', ok: false, failCode: kind, failMessage: FAIL_CODE_ZH[kind] }
  if (unlockReason) fail.unlockReason = unlockReason
  return fail
}

export interface UnlockMeta {
  unlockedBy: UnlockMethod
  unlockDetail: string
  continuationUrls?: string[]
}

/**
 * 撞付费墙时的第一反应：正文可能已经在页面里，只是被站点挡着。
 * 恢复失败才退回原来的「按墙暂停」，语义与顺序都不变。
 */
function tryUnlockPaywall(
  html: string,
  pageUrl: string,
  rule: SiteRule | undefined,
  visibleBody: string,
  doc?: Document,
  /** 失败时把「为什么没救回来」回填给调用方，进人工提示。 */
  out?: { reason?: string },
): { body: string; meta: UnlockMeta } | null {
  if (!unlockAllowed(rule)) {
    if (out) out.reason = '本站已关闭自动解锁'
    return null
  }
  const attempt = unlockPaywalledBody(html, pageUrl, rule, { visibleBody, doc })
  if (!attempt.ok || !attempt.hit) {
    if (out) out.reason = attempt.reason
    return null
  }
  return {
    body: cleanAdParagraphs(attempt.hit.body, rule),
    meta: {
      unlockedBy: attempt.hit.method,
      unlockDetail: attempt.hit.detail,
      continuationUrls: attempt.hit.continuationUrls,
    },
  }
}

function chapterBootstrap(
  doc: Document,
  rule: SiteRule | undefined,
  pageUrl: string,
  catalogHint?: string,
): ExtractBootstrap {
  const catalogUrl = findCatalogLink(doc, pageUrl)
  return {
    pageKind: 'chapter',
    bookTitle: bookTitleWithRule(doc, rule),
    author: authorWithRule(doc, rule),
    catalogUrl: catalogUrl || catalogHint || undefined,
    chapters: [],
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export interface ExtractResult extends Partial<UnlockMeta> {
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

  // 页面整体已经明显是乱码时，优先报告编码问题；否则目录页会被误报成「没有目录」。
  // bodyText 会跳过 script/style，避免把站点脚本里的编码样例当成页面正文。
  const pageText = doc.body ? bodyText(doc.body) : ''
  if (looksGarbled(pageText)) {
    return { ok: false, pageKind: 'unknown', failCode: 'BodyGarbled', failMessage: FAIL_CODE_ZH.BodyGarbled }
  }

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
    const wall = classifyWall(doc, ruledBody, true)
    if (wall === 'Paywall') {
      const unlocked = tryUnlockPaywall(html, pageUrl, rule, ruledBody, doc)
      if (unlocked) {
        return {
          ok: true,
          pageKind: 'chapter',
          bootstrap: chapterBootstrap(doc, rule, pageUrl, catalogHint),
          body: unlocked.body,
          ...unlocked.meta,
        }
      }
    }
    if (wall) return wallFail(wall, 'chapter')
    return {
      ok: true,
      pageKind: 'chapter',
      bootstrap: chapterBootstrap(doc, rule, pageUrl, catalogHint),
      body: ruledBody,
    }
  }

  // Try body extraction (likely a chapter page)
  const { body, ok: bodyOk, partialText, source, garbled } = tryExtractBody(doc)
  const fromContainer = source === 'container'
  if (bodyOk) {
    const wall = classifyWall(doc, body, fromContainer)
    if (wall === 'Paywall') {
      const unlocked = tryUnlockPaywall(html, pageUrl, rule, body, doc)
      if (unlocked) {
        return {
          ok: true,
          pageKind: 'chapter',
          bootstrap: chapterBootstrap(doc, rule, pageUrl, catalogHint),
          body: unlocked.body,
          ...unlocked.meta,
        }
      }
    }
    if (wall) return wallFail(wall, 'chapter')
    // This looks like a chapter page - try to find catalog link
    return {
      ok: true,
      pageKind: 'chapter',
      bootstrap: chapterBootstrap(doc, rule, pageUrl, catalogHint),
      body,
    }
  }

  // Body too short / empty — a wall (login, paywall, captcha) explains why
  if (partialText.length > 0) {
    const wall = classifyWall(doc, partialText, fromContainer)
    if (wall === 'Paywall') {
      const unlocked = tryUnlockPaywall(html, pageUrl, rule, partialText, doc)
      if (unlocked) {
        return {
          ok: true,
          pageKind: 'chapter',
          bootstrap: chapterBootstrap(doc, rule, pageUrl, catalogHint),
          body: unlocked.body,
          ...unlocked.meta,
        }
      }
    }
    if (wall) return wallFail(wall, 'unknown')
    if (garbled) return { ok: false, pageKind: 'unknown', failCode: 'BodyGarbled', failMessage: FAIL_CODE_ZH.BodyGarbled }
    return { ok: false, pageKind: 'unknown', failCode: 'BodyEmpty', failMessage: '正文为空或过短' }
  }

  // No body found at all — the surrounding page text may say why
  const wall = classifyWall(doc, '', false)
  if (wall === 'Paywall') {
    const unlocked = tryUnlockPaywall(html, pageUrl, rule, '', doc)
    if (unlocked) {
      return {
        ok: true,
        pageKind: 'chapter',
        bootstrap: chapterBootstrap(doc, rule, pageUrl, catalogHint),
        body: unlocked.body,
        ...unlocked.meta,
      }
    }
  }
  if (wall) return wallFail(wall, 'unknown')

  if (garbled) return { ok: false, pageKind: 'unknown', failCode: 'BodyGarbled', failMessage: FAIL_CODE_ZH.BodyGarbled }
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

export interface ExtractBodyResult extends Partial<UnlockMeta> {
  body: string
  bodyRaw?: string
  ok: boolean
  failCode?: FailCode
  failMessage?: string
  /** 撞付费墙且自动恢复失败时的一句话原因。 */
  unlockReason?: string
}

/**
 * 从章页 HTML 提取正文。撞付费墙时先尝试页面内恢复（见 paywallUnlock.ts）。
 */
export function extractBody(html: string, pageUrl: string, rule?: SiteRule): ExtractBodyResult {
  const dom = new JSDOM(html, { url: pageUrl })
  const doc = dom.window.document
  const unlockOut: { reason?: string } = {}
  const ruledBody = tryBodyFromRule(doc, rule)
  if (ruledBody) {
    if (looksGarbled(ruledBody)) return { body: '', ok: false, failCode: 'BodyGarbled', failMessage: FAIL_CODE_ZH.BodyGarbled }
    const wall = classifyWall(doc, ruledBody, true)
    if (wall === 'Paywall') {
      const unlocked = tryUnlockPaywall(html, pageUrl, rule, ruledBody, doc, unlockOut)
      if (unlocked) return { body: unlocked.body, bodyRaw: unlocked.body, ok: true, ...unlocked.meta }
    }
    if (wall) return bodyWallFail(wall, unlockOut.reason)
    return { body: cleanAdParagraphs(ruledBody, rule), bodyRaw: ruledBody, ok: true }
  }
  const { body, ok, partialText, source, garbled } = tryExtractBody(doc)
  const fromContainer = source === 'container'
  if (!ok) {
    const wall = classifyWall(doc, partialText, fromContainer)
    if (wall === 'Paywall') {
      const unlocked = tryUnlockPaywall(html, pageUrl, rule, partialText, doc, unlockOut)
      if (unlocked) return { body: unlocked.body, bodyRaw: unlocked.body, ok: true, ...unlocked.meta }
    }
    if (wall) return bodyWallFail(wall, unlockOut.reason)
    if (garbled) return { body: '', ok: false, failCode: 'BodyGarbled', failMessage: FAIL_CODE_ZH.BodyGarbled }
    return { body: '', ok: false, failCode: 'BodyEmpty', failMessage: '正文为空或过短' }
  }
  const wall = classifyWall(doc, body, fromContainer)
  if (wall === 'Paywall') {
    const unlocked = tryUnlockPaywall(html, pageUrl, rule, body, doc, unlockOut)
    if (unlocked) return { body: unlocked.body, bodyRaw: unlocked.body, ok: true, ...unlocked.meta }
  }
  if (wall) return bodyWallFail(wall, unlockOut.reason)
  return { body: cleanAdParagraphs(body, rule), bodyRaw: body, ok: true }
}
