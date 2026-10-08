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

export function extractBrowseReadingPage(html: string, url: string, rule?: SiteRule): { ok: true; page: BrowseReadingPage } | { ok: false; message: string } {
  const result = extractBody(html, url, rule)
  if (!result.ok) return { ok: false, message: result.failMessage ?? '当前网页未识别出章节正文' }
  const doc = new JSDOM(html, { url }).window.document
  let title = ''
  if (rule?.title) {
    try { title = doc.querySelector(rule.title)?.textContent?.trim() ?? '' } catch { /* invalid selector */ }
  }
  title ||= doc.querySelector('h1, h2, .chapter-title, .read-title')?.textContent?.trim() ?? ''
  title ||= doc.title || '当前章节'
  return { ok: true, page: { url, title: title.replace(/\s+/g, ' ').slice(0, 160), body: result.body } }
}
