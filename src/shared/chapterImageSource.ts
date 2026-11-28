/**
 * 站点章节里的配图：从 HTML 里识别正文图、注入/解析正文标记。
 *
 * 正文是纯文本、又可能来自选择器 / Readability / 付费墙恢复三条路径，
 * 直接把「第几张图」映射回文本偏移不可靠。这里换个方向：在抽取前把每个
 * 合格的 `<img>` 换成一段可识别的文本标记，抽取出来的正文天然带着标记；
 * 下载器之后按标记原位换成 `[图]` 段落。
 */

export interface ChapterImageCandidate {
  url: string
  alt: string
}

const MAX_IMAGES = 20
const IMG_TAG = /<img\b[^>]*>/gi
const IMAGE_ATTR = /\b(?:data-original|data-src|data-lazy-src|src)\s*=\s*["']([^"']+)["']/i
const UI_IMAGE = /(logo|avatar|icon|banner|advert|ads?[-_/]|tracking|pixel|spacer|blank|loading|qrcode|weixin|weibo|social|emoji|smiley)/i

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)
  return match ? match[1]! : null
}

/** 单个 `<img>` 标签 → 可用的图片地址；站标/广告/占位/声明尺寸过小的返回 null。 */
function imageCandidateFromTag(tag: string, pageUrl: string): ChapterImageCandidate | null {
  let base: URL
  try {
    base = new URL(pageUrl)
  } catch {
    return null
  }
  const raw = IMAGE_ATTR.exec(tag)?.[1]
  if (!raw || /^(?:data:|blob:)/i.test(raw)) return null
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (UI_IMAGE.test(url.pathname) || UI_IMAGE.test(url.search)) return null
  if (UI_IMAGE.test(attr(tag, 'alt') ?? '') || UI_IMAGE.test(attr(tag, 'class') ?? '')) return null
  const width = Number(attr(tag, 'width') ?? '')
  const height = Number(attr(tag, 'height') ?? '')
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width < 120 && height < 120) return null
  return { url: url.toString(), alt: (attr(tag, 'alt') ?? '').trim() }
}

export function collectChapterImageCandidates(html: string, pageUrl: string): ChapterImageCandidate[] {
  const out: ChapterImageCandidate[] = []
  const seen = new Set<string>()
  IMG_TAG.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMG_TAG.exec(html)) !== null) {
    const candidate = imageCandidateFromTag(match[0], pageUrl)
    if (!candidate || seen.has(candidate.url)) continue
    seen.add(candidate.url)
    out.push(candidate)
    if (out.length >= MAX_IMAGES) break
  }
  return out
}

const TOKEN_PREFIX = '[[SPBFIMG|'
const TOKEN_RE = /\[\[SPBFIMG\|([^|\]]*)\|([^\]]*)\]\]/g

export function imageToken(url: string, alt: string): string {
  return `${TOKEN_PREFIX}${encodeURIComponent(url)}|${encodeURIComponent(alt)}]]`
}

interface ParsedImageToken {
  url: string
  alt: string
  raw: string
}

function parseImageToken(token: string): ParsedImageToken | null {
  const match = /^\[\[SPBFIMG\|([^|\]]*)\|([^\]]*)\]\]$/.exec(token)
  if (!match) return null
  try {
    return { url: decodeURIComponent(match[1]!), alt: decodeURIComponent(match[2]!), raw: token }
  } catch {
    return null
  }
}

/** 找出正文里所有图片标记（按出现顺序）。 */
export function findImageTokens(text: string): ParsedImageToken[] {
  const out: ParsedImageToken[] = []
  for (const match of text.matchAll(TOKEN_RE)) {
    const parsed = parseImageToken(match[0])
    if (parsed) out.push(parsed)
  }
  return out
}

/** 预览/原文视图用：把标记清掉，不让人看到内部记号。 */
export function stripImageTokens(text: string): string {
  return text.replace(TOKEN_RE, '').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 抽取前注入：把合格 `<img>` 换成文本标记。
 *
 * 只替换真正会被收集的图片；被过滤的标签原样保留（抽取时仍会被剥掉）。
 */
export function injectImageTokens(html: string, pageUrl: string): { html: string; count: number } {
  let count = 0
  const next = html.replace(IMG_TAG, (tag) => {
    const candidate = imageCandidateFromTag(tag, pageUrl)
    if (!candidate) return tag
    count += 1
    return ` ${imageToken(candidate.url, candidate.alt)} `
  })
  return { html: next, count }
}