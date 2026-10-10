/**
 * 付费墙正文恢复（站点通用，不绑站）。
 *
 * 只处理「正文已经发到浏览器、只是被页面挡住」这一类付费墙：
 *   1. 站点规则指定解锁容器（用户/规则市场直给）
 *   2. 被 CSS 类名、内联样式、hidden / aria-hidden 藏起来的全文节点
 *   3. 内联 JSON / JSON-LD / 脚本变量 / data-* 属性里的正文
 *   4. 上面这些串里的 \uXXXX 转义、百分号编码、base64 载荷
 *   5. 被藏起来的续页 / 整页链接（只回候选 URL，抓取交给下载器）
 *
 * 服务端根本不下发的内容不在这里找回：不冒充会员凭证、不伪造支付、
 * 不猜接口签名。这条路走不通时仍按原来的付费墙暂停等人处理。
 */
import { JSDOM } from 'jsdom'
import type { SiteRule, UnlockMethod } from '../shared/types'
import { bodyText, cjkLength, cleanBodyText, effectiveLength, linkDensity, visibleText } from './bodyText'

/** 恢复出的正文至少要有这么多有效字符，才敢当「解锁成功」。 */
export const MIN_UNLOCK_CHARS = 200

/** 恢复结果必须比页面上已经可见的正文多出这么多字符，否则只是把试读搬了一遍。 */
const MIN_GAIN_CHARS = 40

/** 一个页面最多扫多少个内联脚本 / 元素属性，防超大页拖慢下载。 */
const MAX_SCRIPT_SCAN = 120
const MAX_ATTR_SCAN = 4000

/** 单个候选串超过这个长度就不看，避免把整页 JS 当正文。 */
const MAX_CANDIDATE_CHARS = 200_000

/** 最少中文字数：小说正文的中文占比高，用它挡掉 JS/CSS 噪声。 */
const MIN_CJK_CHARS = 120

export interface UnlockHit {
  body: string
  method: UnlockMethod
  /** 怎么找到的：选择器、脚本位置、属性名，进日志和审计。 */
  detail: string
  /** 被站点藏起来的续页 / 整页链接，按页面顺序。 */
  continuationUrls?: string[]
}

export interface UnlockAttempt {
  ok: boolean
  hit?: UnlockHit
  /** 失败原因：给日志与界面一句话，不含正文。 */
  reason?: string
  /** 试过哪些路子，用于排查。 */
  tried?: string[]
}

export interface UnlockOptions {
  /** 页面上已经能看见的正文（截断的试读部分）；用于判定是否真的多出内容。 */
  visibleBody?: string
  /** 是否附加收集隐藏续页链接，默认 true。 */
  continuation?: boolean
  /** 调用方已有的 DOM（extract 传同一个 jsdom 实例，省掉一次整页解析）。 */
  doc?: Document
}

/** 站点规则是否允许自动解锁；缺省开启。 */
export function unlockAllowed(rule?: SiteRule): boolean {
  return rule?.paywallUnlock !== false
}

function splitLines(value?: string): string[] {
  return (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function querySafe(doc: Document, selector: string): Element | null {
  try {
    return doc.querySelector(selector)
  } catch {
    return null
  }
}

function queryAllSafe(root: Element | Document, selector: string): Element[] {
  try {
    return [...root.querySelectorAll(selector)]
  } catch {
    return []
  }
}

/** template 的内容在 content fragment 里，textContent 走 childNodes 拿不到。 */
function nodeText(el: Element): string {
  if (el.tagName === 'TEMPLATE') {
    const fragment = (el as HTMLTemplateElement).content
    return fragment ? (fragment.textContent ?? '') : ''
  }
  return bodyText(el)
}

/**
 * 恢复出来的正文里常留着一行「本章剩余内容需要付费阅读」：那是站点提示，不是正文。
 * 只删**单独成段**且很短的提示行，正文里聊到付费的句子一律留着。
 */
const PAYWALL_NOTICE_RE =
  /(?:本章|全文|后续|剩余)[^。！？\n]{0,24}(?:付费|会员|订阅|购买|解锁|VIP)|(?:付费|购买本章|开通会员|订阅|解锁)[^。！？\n]{0,24}(?:阅读|解锁|可读|章节|后续)/i

/** 单行提示最多这么长；超过就当正文句子，不动。 */
const NOTICE_MAX_CHARS = 60

function stripPaywallNotices(text: string): string {
  let removed = 0
  const kept: string[] = []
  for (const paragraph of text.split(/\n{2,}/)) {
    const line = paragraph.trim()
    if (!line) continue
    if (effectiveLength(line) <= NOTICE_MAX_CHARS && PAYWALL_NOTICE_RE.test(line)) {
      removed++
      continue
    }
    kept.push(line)
  }
  if (removed === 0) return text
  const cleaned = kept.join('\n\n').trim()
  return effectiveLength(cleaned) >= MIN_UNLOCK_CHARS ? cleaned : text
}

/** 私用区（PUA）码点：站点拿自定义字体把字换成这批码点时，正文在 DOM 里就是乱码。 */
const PUA_RE = /[\ue000-\uf8ff]/g

export function looksFontObfuscated(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  if (compact.length < 40) return false
  const hits = compact.match(PUA_RE)
  return Boolean(hits) && hits!.length / compact.length > 0.3
}

/**
 * 一段串够不够格当「被解锁的正文」。
 * 返回清洗后的正文，或 null。
 */
function acceptCandidate(raw: string, visible: string): string | null {
  if (!raw) return null
  const text = cleanBodyText(raw)
  if (!text) return null
  // 字体混淆的乱码不能当正文入库：宁可报墙，也不要把乱码写进书库
  if (looksFontObfuscated(text)) return null
  const len = effectiveLength(text)
  if (len < MIN_UNLOCK_CHARS) return null
  // 中文小说：中文太少说明抓到的多半是脚本/样式/导航
  if (cjkLength(text) < MIN_CJK_CHARS && len < MIN_UNLOCK_CHARS * 4) return null
  const visibleLen = effectiveLength(visible)
  if (visibleLen > 0 && len <= visibleLen + MIN_GAIN_CHARS) return null
  return stripPaywallNotices(text)
}

interface Candidate {
  text: string
  detail: string
  method: UnlockMethod
}

function attrCandidates(doc: Document, out: Array<{ text: string; detail: string }>): void {
  const names = [
    'data-content',
    'data-body',
    'data-text',
    'data-chapter',
    'data-fulltext',
    'data-full',
    'data-original',
    'data-novel',
    'data-src',
  ]
  for (const name of names) {
    const nodes = queryAllSafe(doc, `[${name}]`).slice(0, 200)
    for (const el of nodes) {
      const value = el.getAttribute(name)
      if (!value || value.length < 40) continue
      out.push({ text: value, detail: `属性 ${name}` })
    }
  }
}

function scriptTexts(doc: Document): Array<{ source: string; detail: string }> {
  const out: Array<{ source: string; detail: string }> = []
  const scripts = [...doc.querySelectorAll('script')].slice(0, MAX_SCRIPT_SCAN)
  for (let i = 0; i < scripts.length; i++) {
    const el = scripts[i]
    const source = el.textContent ?? ''
    if (!source.trim()) continue
    const id = el.id || el.getAttribute('data-name') || el.getAttribute('data-id')
    out.push({ source, detail: id ? `脚本 #${id}` : `脚本 #${i + 1}` })
  }
  return out
}

/** 从任意 JSON 值里抽最长的字符串。 */
function collectJsonStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return
  if (typeof value === 'string') {
    if (value.length >= 60 && value.length <= MAX_CANDIDATE_CHARS) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectJsonStrings(item, out, depth + 1)
  }
}

const QUOTED_STRING_RE = /"((?:[^"\\]|\\.){60,})"/g
const SINGLE_QUOTED_RE = /'((?:[^'\\\n]|\\.){60,})'/g
const RAW_CJK_RUN_RE = /[\u3400-\u9fff][\u3400-\u9fff\s，。！？、：；“”‘’…—·（）]{100,}/g

function unescapeJson(input: string): string | null {
  try {
    return JSON.parse(`"${input.replace(/\n/g, '\\n')}"`) as string
  } catch {
    return null
  }
}

/** 接口返回 HTML 片段时先去掉标签：段落边界保留，正文才连得起来。 */
function stripTags(source: string): string {
  return source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
}

function harvestStrings(source: string, out: string[], depth = 0): void {
  const trimmed = source.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const jsonStrings: string[] = []
      collectJsonStrings(parsed, jsonStrings)
      for (const item of jsonStrings) out.push(item)
      if (jsonStrings.length > 0) return
    } catch {
      /* 不是完整 JSON，继续按正则抽 */
    }
  }

  // HTML 片段：剥掉标签再来一遍，正文段落之间才连得起来
  if (depth < 2 && trimmed.includes('<') && trimmed.includes('>')) {
    const stripped = stripTags(trimmed)
    if (stripped.trim() && stripped.trim() !== trimmed) harvestStrings(stripped, out, depth + 1)
  }

  QUOTED_STRING_RE.lastIndex = 0
  for (const match of source.matchAll(QUOTED_STRING_RE)) {
    const decoded = unescapeJson(match[1])
    if (decoded) out.push(decoded)
  }

  SINGLE_QUOTED_RE.lastIndex = 0
  for (const match of source.matchAll(SINGLE_QUOTED_RE)) {
    const decoded = unescapeJson(match[1].replace(/\\'/g, "'"))
    if (decoded) out.push(decoded)
  }

  RAW_CJK_RUN_RE.lastIndex = 0
  for (const match of source.matchAll(RAW_CJK_RUN_RE)) {
    if (effectiveLength(match[0]) >= MIN_UNLOCK_CHARS) out.push(match[0])
  }
}

// ---------------------------------------------------------------------------
// 编码载荷
// ---------------------------------------------------------------------------

const BASE64_RE = /^[A-Za-z0-9+/\r\n=]{64,}$/

function decodeEscapes(input: string): string | null {
  if (!/\\u[0-9a-fA-F]{4}|\\n|\\t/.test(input)) return null
  return unescapeJson(input)
}

function decodePercent(input: string): string | null {
  if (!/%[0-9a-fA-F]{2}/.test(input)) return null
  try {
    const decoded = decodeURIComponent(input)
    return decoded === input ? null : decoded
  } catch {
    return null
  }
}

function decodeBase64(input: string): string | null {
  const compact = input.replace(/\s+/g, '')
  if (compact.length < 256 || !BASE64_RE.test(compact)) return null
  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf8')
    if (!decoded || decoded.includes('\u0000') || decoded.includes('\ufffd')) return null
    return decoded
  } catch {
    return null
  }
}

/** 对一段候选跑解码链；只保留「解码后中文更多」的结果，避免把正常文本解坏。 */
function decodeVariants(input: string): string[] {
  const out: string[] = []
  const base = cjkLength(input)
  const steps = [decodeEscapes, decodePercent, decodeBase64]
  let layer = [input]
  for (let round = 0; round < 2; round++) {
    const next: string[] = []
    for (const current of layer) {
      for (const step of steps) {
        const decoded = step(current)
        if (!decoded || decoded === current || decoded.length > MAX_CANDIDATE_CHARS) continue
        if (cjkLength(decoded) <= Math.max(base, cjkLength(current))) continue
        out.push(decoded)
        next.push(decoded)
      }
    }
    if (next.length === 0) break
    layer = next.slice(0, 8)
  }
  return out
}

// ---------------------------------------------------------------------------
// 隐藏节点
// ---------------------------------------------------------------------------

const HIDDEN_SELECTORS = [
  '[hidden]',
  '[aria-hidden="true"]',
  'template',
  '[style*="display:none"]',
  '[style*="display: none"]',
  '[style*="visibility:hidden"]',
  '[style*="visibility: hidden"]',
  '[style*="opacity:0"]',
  '[style*="opacity: 0"]',
  '[style*="font-size:0"]',
  '[style*="font-size: 0"]',
  '[style*="text-indent:-9999"]',
  '[style*="left:-9999"]',
  '.hidden',
  '.hide',
  '.is-hidden',
  '.d-none',
  '.mask',
  '.masked',
  '.blur',
  '.blurred',
  '.fold',
  '.collapsed',
  '.paywall',
  '.vip-hide',
  '.vipHide',
  '.vip-content',
  '.locked',
  '.unlock',
  '.unlocked',
  '.fulltext',
  '#fulltext',
  '.full-content',
  '.chapter-full',
  '.content-full',
  '.complete',
]

const HIDDEN_CONTAINER_SKIP = /^(NAV|FOOTER|HEADER|FORM|ASIDE|SCRIPT|STYLE|TEMPLATE|BUTTON|SELECT|SVG)$/

function hiddenNodeCandidates(doc: Document): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<Element>()
  for (const selector of HIDDEN_SELECTORS) {
    for (const el of queryAllSafe(doc, selector)) {
      if (seen.has(el) || out.length >= 60) continue
      seen.add(el)
      if (HIDDEN_CONTAINER_SKIP.test(el.tagName)) continue
      if (linkDensity(el) > 0.35) continue
      const text = nodeText(el)
      if (effectiveLength(text) < MIN_UNLOCK_CHARS) continue
      out.push({ text, detail: `隐藏节点 ${selector}`, method: 'hiddenDom' })
    }
  }
  return out
}

/**
 * `<noscript>` 里的全文：不少站点把正文塞在这儿，赌抓取脚本拿到的是标签源码。
 * 这里把这份源码当 HTML 再解析一遍取文本。
 */
function noscriptCandidates(doc: Document): Candidate[] {
  const out: Candidate[] = []
  for (const el of queryAllSafe(doc, 'noscript')) {
    const raw = el.textContent ?? ''
    if (raw.length < 120) continue
    const inner = parseDom(raw, 'https://noscript.invalid/')
    const text = inner ? (inner.window.document.body?.textContent ?? '') : raw
    if (effectiveLength(text) < MIN_UNLOCK_CHARS) continue
    out.push({ text, detail: 'noscript 全文', method: 'hiddenDom' })
  }
  return out
}

/** 节点自身或近祖先被藏起来；用于判断分页链接是不是「不想让人点」。 */
function looksHidden(el: Element): boolean {
  let cursor: Element | null = el
  for (let depth = 0; cursor && depth < 4; depth++) {
    if (cursor.hasAttribute('hidden')) return true
    if (cursor.getAttribute('aria-hidden') === 'true') return true
    const style = cursor.getAttribute('style') ?? ''
    if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![\d.])|height\s*:\s*0(?![\d.])/i.test(style)) {
      return true
    }
    const cls = cursor.getAttribute('class') ?? ''
    if (/(^|[\s_-])(hide|hidden|is-hidden|d-none|mask(ed)?|collapsed?|fold|sr-only)([\s_-]|$)/i.test(cls)) return true
    cursor = cursor.parentElement
  }
  return false
}

// ---------------------------------------------------------------------------
// 续页 / 整页链接
// ---------------------------------------------------------------------------

const PAGE_TEXT_RE = /下一页|下页|后一页|下一\s*页|第\s*\d+\s*页|\d+\s*\/\s*\d+\s*页|全文阅读|完整版|无删减|后续|剩余章节/
/**
 * 分页/整页的 URL 特征。**不收**裸 `\d+\.html`：那正是章节页自己的命名，
 * 会把「下一章」当续页抓进来。
 */
const PAGE_HREF_RE = /[?&](?:page|p|pg)=\d+|[?&](?:all|full|whole)=1|\/(?:all|readall|full)\.html?$|_\d+\.html?$/i

export interface ContinuationCandidate {
  url: string
  /** 从哪找到的：给人话，便于在界面提示。 */
  detail: string
}

/** 收集同域、被藏起来或指向「整页/后续页」的链接。只回候选，不抓。 */
export function findContinuationUrls(html: string, pageUrl: string, limit = 5): string[] {
  const parsed = parseDom(html, pageUrl)
  if (!parsed) return []
  return collectContinuations(parsed.window.document, pageUrl, limit)
}

function collectContinuations(doc: Document, pageUrl: string, limit = 5): string[] {
  const current = normalizeUrl(pageUrl)
  const out: string[] = []
  const push = (raw: string): void => {
    if (!raw || out.length >= limit || /^javascript:/i.test(raw)) return
    let resolved: string
    try {
      resolved = new URL(raw, pageUrl).href
    } catch {
      return
    }
    if (resolved === current) return
    try {
      if (new URL(resolved).hostname !== new URL(pageUrl).hostname) return
    } catch {
      return
    }
    if (!out.includes(resolved)) out.push(resolved)
  }

  for (const el of queryAllSafe(doc, 'a[href]')) {
    if (out.length >= limit) break
    const anchor = el as HTMLAnchorElement
    const raw = (anchor.getAttribute('href') ?? '').trim()
    const text = visibleText(anchor)
    const hitText = PAGE_TEXT_RE.test(text)
    const hitHref = PAGE_HREF_RE.test(raw)
    if (!hitText && !hitHref) continue
    // 只当真被藏起来、或确实像分页/整页的链接：正常的「下一章」不能当续页
    if (!looksHidden(anchor) && !hitHref) continue
    push(raw)
  }

  // 「展开剩余」「下一页」按钮常把目标塞在 data-* 上，只认带分页特征的值
  const DATA_ATTRS = ['data-url', 'data-href', 'data-src', 'data-next', 'data-page-url', 'data-link']
  for (const el of queryAllSafe(doc, `link[rel~="next"][href], ${DATA_ATTRS.map((a) => `[${a}]`).join(', ')}`)) {
    if (out.length >= limit) break
    // href 可能是 javascript:void(0)，所以逐个属性找到第一个「像分页」的值
    const values = [el.getAttribute('href'), ...DATA_ATTRS.map((a) => el.getAttribute(a))]
    const raw = (values.find((value) => value && PAGE_HREF_RE.test(value)) ?? '').trim()
    if (!raw) continue
    push(raw)
  }

  // 跳页下拉：<select><option value="2.html">
  for (const option of queryAllSafe(doc, 'select option[value]')) {
    if (out.length >= limit) break
    const raw = (option.getAttribute('value') ?? '').trim()
    if (!raw || !PAGE_HREF_RE.test(raw)) continue
    push(raw)
  }

  return out
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href
  } catch {
    return url
  }
}

function parseDom(html: string, pageUrl: string): JSDOM | null {
  try {
    return new JSDOM(html, { url: pageUrl })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function pickBest(candidates: Candidate[], visible: string): { hit: UnlockHit } | { tried: string[] } {
  const tried: string[] = []
  let best: { hit: UnlockHit; score: number } | null = null
  const ranked = [...candidates].sort((a, b) => effectiveLength(b.text) - effectiveLength(a.text))
  for (const candidate of ranked) {
    const accepted = acceptCandidate(candidate.text, visible)
    if (!accepted) {
      tried.push(`${candidate.detail}：${effectiveLength(candidate.text)} 字，不够或与试读重合`)
      continue
    }
    const score = scoreCompletion(accepted, visible)
    if (!best || score > best.score) {
      best = { hit: { body: accepted, method: candidate.method, detail: candidate.detail }, score }
    }
  }
  if (best) return { hit: best.hit }
  return { tried }
}

/**
 * 恢复质量打分：长度只是底噪，「结尾完整 + 与试读衔接」才是像真章的证据。
 * 多路都拿到正文时用它选，而不是盲目取最长的那个。
 */
function scoreCompletion(text: string, visible: string): number {
  const trimmed = text.trim()
  let score = effectiveLength(trimmed)
  if (/[。！？…”』」）]$/.test(trimmed)) score += 120
  if (/(?:\.{3,}|…{2,}|未完待续|点击下一页)\s*$/.test(trimmed)) score -= 300
  const tail = visible.trim().replace(/\s+/g, '').slice(-24)
  if (tail && trimmed.replace(/\s+/g, '').includes(tail)) score += 200
  return score
}

/** 从一段（接口响应或内联数据）文本里恢复出的正文。 */
export interface RecoveredBody {
  body: string
  method: UnlockMethod
  detail: string
}

/**
 * 把一整段候选正文按同一套判据规范化（OCR 结果也走这里）：
 * 长度、中文占比、字体乱码一律按页面的规矩来，合格才返回。
 */
export function normalizeRecoveredBody(text: string): string | null {
  return acceptCandidate(text, '')
}

/**
 * 从任意一段文本里恢复正文：接口响应、内联数据、脚本片段都走同一套判据
 * （长度、中文占比、编码解码、不与试读重合、拒绝字体乱码）。
 */
export function recoverBodyFromText(
  payload: string,
  visible = '',
  opts?: { method?: UnlockMethod; detail?: string },
): RecoveredBody | null {
  if (!payload || payload.length < MIN_UNLOCK_CHARS) return null
  const strings: string[] = []
  harvestStrings(payload, strings)
  const candidates: Candidate[] = []
  for (const text of strings) {
    if (cjkLength(text) >= MIN_CJK_CHARS) {
      candidates.push({ text, detail: opts?.detail ?? '内联数据', method: opts?.method ?? 'embeddedJson' })
    }
    for (const decoded of decodeVariants(text)) {
      candidates.push({ text: decoded, detail: `${opts?.detail ?? '内联数据'}（解码后）`, method: 'encoded' })
    }
  }
  const hit = pickBest(candidates, visible)
  if (!('hit' in hit)) return null
  return {
    body: hit.hit.body,
    method: opts?.method ?? hit.hit.method,
    detail: opts?.detail ?? hit.hit.detail,
  }
}

/**
 * 尝试从付费墙页里恢复正文。
 *
 * @param html 章页 HTML
 * @param pageUrl 章页 URL
 * @param rule 站点规则；`unlockSelectors` 为每行一个解锁容器选择器
 * @param opts visibleBody 传入页面上已可见的试读正文，用于判定是否真的解锁
 */
export function unlockPaywalledBody(
  html: string,
  pageUrl: string,
  rule?: SiteRule,
  opts?: UnlockOptions,
): UnlockAttempt {
  if (!unlockAllowed(rule)) return { ok: false, reason: '本站已关闭自动解锁' }
  const doc = opts?.doc ?? parseDom(html, pageUrl)?.window.document
  if (!doc) return { ok: false, reason: '页面解析失败' }
  const visible = opts?.visibleBody ?? ''
  const tried: string[] = []
  const withContinuation = (hit: UnlockHit): UnlockHit => {
    if (opts?.continuation === false) return hit
    const urls = collectContinuations(doc, pageUrl)
    return urls.length > 0 ? { ...hit, continuationUrls: urls } : hit
  }

  // 1. 站点规则直取
  for (const selector of splitLines(rule?.unlockSelectors)) {
    const el = querySafe(doc, selector)
    if (!el) {
      tried.push(`规则容器 ${selector}：没找到`)
      continue
    }
    const accepted = acceptCandidate(nodeText(el), visible)
    if (accepted) return { ok: true, hit: withContinuation({ body: accepted, method: 'rule', detail: `规则容器 ${selector}` }), tried }
    tried.push(`规则容器 ${selector}：内容不够或与试读重合`)
  }

  // 2. 页面里藏起来的全文（含 noscript）
  const hidden = pickBest([...hiddenNodeCandidates(doc), ...noscriptCandidates(doc)], visible)
  if ('hit' in hidden) return { ok: true, hit: withContinuation(hidden.hit), tried }
  tried.push(...hidden.tried)

  // 3. 内嵌数据 + 4. 编码载荷
  const sources: Array<{ text: string; detail: string }> = []
  attrCandidates(doc, sources)
  for (const script of scriptTexts(doc)) {
    const strings: string[] = []
    harvestStrings(script.source, strings)
    for (const text of strings) sources.push({ text, detail: script.detail })
  }
  const embedded: Candidate[] = []
  const encoded: Candidate[] = []
  let attrScanned = 0
  for (const source of sources) {
    if (attrScanned++ > MAX_ATTR_SCAN) break
    if (cjkLength(source.text) >= MIN_CJK_CHARS) {
      embedded.push({ text: source.text, detail: source.detail, method: 'embeddedJson' })
    }
    for (const decoded of decodeVariants(source.text)) {
      encoded.push({ text: decoded, detail: `${source.detail}（解码后）`, method: 'encoded' })
    }
  }
  const embeddedHit = pickBest([...embedded, ...encoded], visible)
  if ('hit' in embeddedHit) return { ok: true, hit: withContinuation(embeddedHit.hit), tried }
  tried.push(...embeddedHit.tried)

  // 页面文本本身就是私用区乱码：站点用自定义字体做了字形替换，静态文本这条路走不通
  if (looksFontObfuscated(doc.body?.textContent ?? '')) {
    return { ok: false, reason: '正文疑似自定义字体做字形替换（字体混淆），页面文本是乱码', tried }
  }

  return {
    ok: false,
    reason: tried.length > 0 ? '页面里没有可恢复的正文' : '页面里没有藏起来的正文',
    tried,
  }
}
