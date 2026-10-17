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

export function extractBrowseReadingPage(html: string, url: string, rule?: SiteRule): { ok: true; page: BrowseReadingPage } | { ok: false; message: string } {
  const result = extractBody(html, url, rule)
  if (!result.ok) return { ok: false, message: result.failMessage ?? '当前网页未识别出章节正文' }
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
