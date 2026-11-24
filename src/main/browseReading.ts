import { JSDOM } from 'jsdom'
import type { BrowseChapterLink, BrowseReadingPage, SiteRule } from '../shared/types'
import { extractBody } from './extract'

const LABELS = {
  previous: /(?:上一[章节回]|上[一]?章|prev(?:ious)?\s*chapter)/i,
  next: /(?:下一[章节回]|下[一]?章|next\s*chapter)/i,
}

function chapterLink(el: Element | null, pageUrl: string): BrowseChapterLink | undefined {
  const anchor = el?.closest('a[href]') ?? el?.querySelector('a[href]')
  if (!anchor) return undefined
  const href = anchor.getAttribute('href') ?? ''
  if (!href || /^javascript:/i.test(href)) return undefined
  try {
    const url = new URL(href, pageUrl)
    const current = new URL(pageUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== current.origin || url.href === current.href) return undefined
    const title = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim()
    return { url: url.href, title: title.slice(0, 100) || '章节链接' }
  } catch { return undefined }
}

export function discoverChapterLinks(html: string, pageUrl: string, rule?: SiteRule): { previous?: BrowseChapterLink; next?: BrowseChapterLink } {
  const doc = new JSDOM(html, { url: pageUrl }).window.document
  const find = (direction: 'previous' | 'next'): BrowseChapterLink | undefined => {
    const selector = direction === 'previous' ? rule?.previousChapter : rule?.nextChapter
    if (selector?.trim()) {
      try { return chapterLink(doc.querySelector(selector), pageUrl) } catch { return undefined }
    }
    const rel = direction === 'previous' ? 'prev' : 'next'
    for (const el of doc.querySelectorAll(`a[rel~="${rel}"]`)) {
      if (!LABELS[direction].test((el.textContent ?? '') + ' ' + (el.getAttribute('title') ?? ''))) continue
      const result = chapterLink(el, pageUrl)
      if (result) return result
    }
    for (const el of doc.querySelectorAll('a[href]')) {
      if (!LABELS[direction].test((el.textContent ?? '').trim())) continue
      const result = chapterLink(el, pageUrl)
      if (result) return result
    }
    return undefined
  }
  return { previous: find('previous'), next: find('next') }
}

/** 隐藏容器里的标题不算数：站点常把「阅读记录」等弹层的 h2 留在 DOM 里。 */
function isHidden(el: Element): boolean {
  if (el.closest('[hidden], [aria-hidden="true"]')) return true
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = (node as HTMLElement).style
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return true
  }
  return false
}

function firstVisibleText(doc: Document, selector: string): string {
  for (const el of doc.querySelectorAll(selector)) {
    if (isHidden(el)) continue
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text) return text
  }
  return ''
}

/**
 * 这一页是不是「书页 / 目录页」而不是章节页。
 *
 * 只认一个硬信号：目录容器识别器能直接拿出 ≥2 章目录。
 *
 * 故意不叠加「有没有上一章/下一章链接」「有没有章节链接」这类附加条件——
 * 纯章节页也可能没有导航链接、正文也可能很短，加条件就会把能读的章误拒。
 * 命中的目录页继续当章节读只会渲染出简介/书名，永远停在「已经是最后一章」。
 */
function looksLikeCatalogPage(html: string, url: string, rule?: SiteRule, api?: CatalogDetect): boolean {
  if (!api) return false
  const doc = new JSDOM(html, { url }).window.document
  return api.hasCatalog(doc, url, rule)
}

/**
 * 目录识别能力由 inject 注入：extract.ts 里那两条目录启发式不对外，
 * 直接 import 会把 extract.ts 的模块初始化带进这条只读路径。
 */
export interface CatalogDetect {
  hasCatalog(doc: Document, url: string, rule?: SiteRule): boolean
  hasChapterLinks(doc: Document, url: string): boolean
}

export function extractBrowseReadingPage(
  html: string,
  url: string,
  rule?: SiteRule,
  detect?: CatalogDetect,
): { ok: true; page: BrowseReadingPage } | { ok: false; message: string; isCatalog?: boolean } {
  const result = extractBody(html, url, rule)
  // 目录页上开阅读模式：没有章节正文可读，也不能拿书名冒充章节。
  // 正文本身读不出来时也走这里——先给 isCatalog，入口处才能改成「从第一章开始」
  // 而不是丢一句「正文为空」这种看不出下一步的错。
  const isCatalog = looksLikeCatalogPage(html, url, rule, detect)
  if (!result.ok) {
    return isCatalog
      ? { ok: false, isCatalog: true, message: '这是书页，不是章节。先点开第一章再进阅读模式。' }
      : { ok: false, message: result.failMessage ?? '当前网页未识别出章节正文' }
  }
  // 正文能读出来但它其实是整本书页：同样当目录页处理，别把简介当章节。
  if (isCatalog) {
    return { ok: false, isCatalog: true, message: '这是书页，不是章节。先点开第一章再进阅读模式。' }
  }
  const doc = new JSDOM(html, { url }).window.document
  let title = ''
  if (rule?.title) {
    try { title = firstVisibleText(doc, rule.title) } catch { /* invalid selector */ }
  }
  // h1 优先于 h2：h2 常被站点弹层占用（如「阅读记录」）。
  title ||= firstVisibleText(doc, 'h1')
  title ||= firstVisibleText(doc, '.chapter-title, .read-title, h2')
  title ||= doc.title || '当前章节'
  return { ok: true, page: { url, title: title.replace(/\s+/g, ' ').slice(0, 160), body: result.body } }
}
