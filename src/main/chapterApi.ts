/**
 * 章节接口旁路：首屏只有试读时，走站点自己的接口把正文拿回来。
 *
 * 铁律：请求**必须**在页面上下文里发（隐藏视图当前就停在这一章，
 * cookie、referer、UA、站点自埋的指纹全都在），绝不在主进程裸 fetch。
 * 我们只是替用户把「他这台浏览器本来就能发的那个请求」发出去，不提升任何权限：
 * 不伪造会员凭证、不猜接口签名、不构造付费参数。站点不给的，这里也拿不到。
 *
 * 何时才走这条路：DOM 内恢复（隐藏节点 / 内嵌数据 / 续页）已经失败、且判定为付费墙。
 * 候选最多两个，之间隔一次下载档位节流，失败不重试。
 */
import type { SiteRule } from '../shared/types'

export interface ChapterApiCandidate {
  url: string
  method: 'GET' | 'POST'
  /** POST 请求体（JSON 文本）。 */
  body?: string
  /** 这条线索从哪来：站点规则 / 页面脚本 / 页面属性。 */
  detail: string
}

export interface ChapterApiResponse {
  url: string
  status?: number
  text?: string
  error?: string
}

/** 一次最多试几个接口：多了既是浪费，也是给站点送风控特征。 */
export const MAX_API_CANDIDATES = 2

/** 接口响应最多带回多少字符（正文通常几 KB，留足余量）。 */
const MAX_API_TEXT = 400_000

const ID_PARAM_RE = /[?&](?:chapterid|chapter_id|cid|chapterId|contentid|nid|id)=(\d{1,10})/i
const HTML_FILE_ID_RE = /\/(\d{1,10})\.html?(?:[?#]|$)/i
const ID_ATTR_RE = /\bdata-(?:cid|chapter-?id|nid|chapterid)\s*=\s*["'](\d{1,10})["']/gi
const ID_SCRIPT_RE =
  /["']?\b(?:chapter[cC]?[iI]d|chapter_id|chapterNo|chapter_no|cid)\b["']?\s*[:=]\s*["']?(\d{1,10})/g

/** 从当前页 URL 与 HTML 里挖「章节 id」线索，先 URL 再属性/脚本。 */
export function chapterIdHints(html: string, pageUrl: string): string[] {
  const out: string[] = []
  const push = (value: string | undefined): void => {
    if (!value) return
    const trimmed = value.trim()
    if (!/^\d{1,10}$/.test(trimmed) || out.includes(trimmed)) return
    out.push(trimmed)
  }
  const queryHit = ID_PARAM_RE.exec(pageUrl)
  push(queryHit?.[1])
  const fileHit = HTML_FILE_ID_RE.exec(pageUrl)
  push(fileHit?.[1])
  for (const match of html.matchAll(ID_ATTR_RE)) push(match[1])
  for (const match of html.matchAll(ID_SCRIPT_RE)) push(match[1])
  return out.slice(0, 6)
}

const PAGE_API_RE =
  /["'`(=]\s*((?:https?:\/\/[^"'`\s<>]+|\/)[\w\-./]*(?:ajax|api|interface)[\w\-./]*(?:\?[^"'`\s<>)]*)?)/gi

/** 页面脚本里现成的接口路径，只留带章节/正文关键词、不带占位变量的。 */
export function pageApiTemplates(html: string): string[] {
  const out: string[] = []
  for (const match of html.matchAll(PAGE_API_RE)) {
    const raw = (match[1] ?? '').trim()
    if (!raw || raw.length > 160) continue
    if (!/[\w\-./?=&]*(chapter|content|read|novel|book|text)[\w\-./?=&]*/i.test(raw)) continue
    if (/[$%{}]/.test(raw)) continue
    // 参数值为空说明地址是拼接出来的（`"?cid=" + cid`），猜不出真实值
    if (/[?&][\w\-%]*=(?:&|$)/.test(raw)) continue
    const normalized = normalizeTemplate(raw)
    if (!normalized) continue
    if (!out.includes(normalized)) out.push(normalized)
    if (out.length >= 8) break
  }
  return out
}

/** 路径里的章节号换成 `{id}`；`?id=123` 同理。 */
function normalizeTemplate(raw: string): string | null {
  let value = raw
  value = value.replace(/([?&](?:id|cid|chapterid|chapter_id|nid)=)\d{1,10}/i, '$1{id}')
  value = value.replace(/\/(\d{1,10})(?=[/?#]|$)/, '/{id}')
  return value
}

/**
 * 页面里出现过的 id 参数名，用来给「没有占位符」的接口模板补一个参数。
 * 先看脚本（那才是接口相关的），全局兜底时不认裸 `id`——`<div id="content">` 到处都是。
 */
export function idParamName(html: string): string | null {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1] ?? '').join('\n')
  const inScript = /\b(cid|chapterid|chapter_id|chapterId|contentid|nid|id)["']?\s*[=:]/i.exec(scripts)
  if (inScript) return inScript[1].toLowerCase()
  const anywhere = /\b(cid|chapterid|chapter_id|chapterId|contentid|nid)["']?\s*[=:]/i.exec(html)
  return anywhere ? anywhere[1].toLowerCase() : null
}

function ruleCandidate(rule?: SiteRule): ChapterApiCandidate | null {
  const template = (rule?.chapterApi ?? '').trim()
  if (!template) return null
  const method = rule?.chapterApiMethod === 'POST' && rule?.chapterApiBody ? 'POST' : 'GET'
  return {
    url: template,
    method,
    body: method === 'POST' ? (rule?.chapterApiBody ?? '').trim() : undefined,
    detail: '站点规则 chapterApi',
  }
}

/**
 * 只替换占位符，不做 URL 解析：请求体模板也要用同一套替换。
 * 缺 id 或还剩未知占位符时返回 null。
 */
export function substitutePlaceholders(template: string, ids: string[], pageUrl: string): string | null {
  const id = ids[0]
  let missing = false
  const filled = template.replace(/\{(id|cid|chapterId|chapter_id|page|url|nid)\}/g, (_whole, key: string) => {
    if (key === 'page') return '1'
    if (key === 'url') return encodeURIComponent(pageUrl)
    if (!id) {
      missing = true
      return ''
    }
    return id
  })
  if (missing || /\{\w+\}/.test(filled)) return null
  return filled
}

/** 把 `{id}` / `{cid}` / `{chapterId}` / `{page}` / `{url}` 填成当前页的线索，并解析成绝对地址。 */
export function fillTemplate(template: string, ids: string[], pageUrl: string): string | null {
  const filled = substitutePlaceholders(template, ids, pageUrl)
  if (filled === null) return null
  try {
    return new URL(filled, pageUrl).href
  } catch {
    return null
  }
}

function sameOrigin(url: string, pageUrl: string): boolean {
  try {
    return new URL(url).hostname === new URL(pageUrl).hostname
  } catch {
    return false
  }
}

/**
 * 找出最多 `limit` 个值得一试的章节接口。
 * 没有 id 线索时不给「页面模板」硬凑，免得拿无参请求去打站点。
 */
export function findChapterApiCandidates(
  html: string,
  pageUrl: string,
  rule?: SiteRule,
  limit = MAX_API_CANDIDATES,
): ChapterApiCandidate[] {
  const ids = chapterIdHints(html, pageUrl)
  const out: ChapterApiCandidate[] = []
  const add = (candidate: ChapterApiCandidate | null): void => {
    if (!candidate || out.length >= limit) return
    if (out.some((item) => item.url === candidate.url)) return
    out.push(candidate)
  }

  const fromRule = ruleCandidate(rule)
  if (fromRule) {
    const url = fillTemplate(fromRule.url, ids, pageUrl)
    if (url && sameOrigin(url, pageUrl)) {
      const body = fromRule.body ? (substitutePlaceholders(fromRule.body, ids, pageUrl) ?? fromRule.body) : undefined
      add({ ...fromRule, url, body })
    }
  }

  if (ids.length === 0) return out

  const param = idParamName(html)
  const withIdParam = (url: string): string => {
    if (!param) return url
    const joiner = url.includes('?') ? '&' : '?'
    return `${url}${joiner}${param}=${ids[0]}`
  }

  for (const template of pageApiTemplates(html)) {
    if (out.length >= limit) break
    const hasPlaceholder = /\{\w+\}/.test(template)
    const filled = fillTemplate(template, ids, pageUrl)
    if (!filled || !sameOrigin(filled, pageUrl)) continue
    // 模板里没有占位符：只有站点自己写过 id 参数名时，才按这个约定补一个，别硬凑
    const url = hasPlaceholder || !param ? filled : withIdParam(filled)
    if (!sameOrigin(url, pageUrl)) continue
    add({ url, method: 'GET', detail: `页面线索 ${template}` })
  }
  return out
}

/**
 * 在页面上下文里跑这段脚本：带 cookie 发请求，把响应原样带回来。
 * 用的是页面自己的 `fetch`，所以 referer / UA / 站点指纹与用户本人点击时一致。
 */
export function buildChapterApiScript(candidates: ChapterApiCandidate[]): string {
  const payload = JSON.stringify(
    candidates.map((candidate) => ({ url: candidate.url, method: candidate.method, body: candidate.body })),
  ).replace(/\$\{/g, '\\${')
  return `(async () => {
  var reqs = ${payload};
  var out = [];
  for (var i = 0; i < reqs.length; i++) {
    var r = reqs[i];
    try {
      var init = { method: r.method || 'GET', credentials: 'include', cache: 'no-store', headers: { 'X-Requested-With': 'XMLHttpRequest' } };
      if (r.body) { init.body = r.body; init.headers['Content-Type'] = 'application/json'; }
      var res = await fetch(r.url, init);
      var text = await res.text();
      out.push({ url: r.url, status: res.status, text: String(text).slice(0, ${MAX_API_TEXT}) });
    } catch (e) {
      out.push({ url: r.url, error: String(e) });
    }
  }
  return JSON.stringify(out);
})()`
}

/** 解析页面脚本带回来的响应；坏 JSON 当空结果，绝不让它打断下载。 */
export function parseChapterApiPayload(payload: string): ChapterApiResponse[] {
  const raw = (payload ?? '').trim()
  if (!raw || !raw.startsWith('[')) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        url: typeof item.url === 'string' ? item.url : '',
        status: typeof item.status === 'number' ? item.status : undefined,
        text: typeof item.text === 'string' ? item.text : undefined,
        error: typeof item.error === 'string' ? item.error : undefined,
      }))
  } catch {
    return []
  }
}

/** 把多个接口响应拼成一份待扫描的文本。 */
export function joinApiPayload(responses: ChapterApiResponse[]): string {
  return responses
    .map((response) => response.text ?? '')
    .filter((text) => text.trim().length > 0)
    .join('\n\n')
}
