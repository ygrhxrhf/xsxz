import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { extractPage, extractCatalog, extractBody } from './extract'
import type { SiteRule } from '../shared/types'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '../../fixtures', name), 'utf-8')
const publicVal = (name: string) =>
  readFileSync(join(import.meta.dirname, '../renderer/public/spbf-val', name), 'utf-8')
const ruleSite = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../fixtures/rule-site', name), 'utf-8')

const RULE_SITE = {
  catalog: 'http://127.0.0.1:5176/catalog.html',
  c1: 'http://127.0.0.1:5176/c1.html',
  c2: 'http://127.0.0.1:5176/c2.html',
}

const matchingRule: SiteRule = {
  host: '127.0.0.1',
  title: '#spbf-title',
  author: '#spbf-author',
  catalog: '#spbf-toc',
  body: '#spbf-body',
}

function effectiveLength(text: string): number {
  return text.replace(/[\s\p{P}]/gu, '').length
}

describe('extractPage — catalog page', () => {
  it('detects catalog and extracts 6 chapters', () => {
    const html = fixture('catalog.html')
    const result = extractPage(html, 'https://example.com/book/index.html')
    expect(result.ok).toBe(true)
    expect(result.pageKind).toBe('catalog')
    expect(result.bootstrap!.chapters.length).toBe(6)
    expect(result.bootstrap!.bookTitle).toContain('万古神帝')
    expect(result.bootstrap!.author).toBe('飞天鱼')
  })
})

describe('extractPage — chapter page', () => {
  it('detects chapter and extracts body', () => {
    const html = fixture('chapter.html')
    const result = extractPage(html, 'https://example.com/book/1.html')
    expect(result.ok).toBe(true)
    expect(result.pageKind).toBe('chapter')
    expect(result.body!).toContain('张若尘从梦中惊醒')
    expect(result.body!).not.toContain('上一章')
    expect(result.body!).not.toContain('返回目录')
    expect(result.bootstrap!.catalogUrl).toBeTruthy()
  })

  it('returns NeedLogin for login wall', () => {
    const html = fixture('login-wall.html')
    const result = extractPage(html, 'https://example.com/book/2.html')
    expect(result.ok).toBe(false)
    expect(result.failCode).toBe('NeedLogin')
    expect(result.failCode).not.toBe('UnknownPage')
    expect(result.failMessage).toBe('需要登录后才能看')
  })

  it('recovers catalog URL from a chapter page without treating it as a one-chapter book', () => {
    const html = fixture('chapter.html')
    const result = extractPage(html, 'https://example.com/book/1.html')
    expect(result.ok).toBe(true)
    expect(result.pageKind).toBe('chapter')
    expect(result.bootstrap!.chapters).toEqual([])
    expect(result.bootstrap!.catalogUrl).toMatch(/\/book\/?$/)
    expect(result.bootstrap!.catalogUrl).not.toContain('1.html')
  })

  it('returns BodyEmpty when body is too short', () => {
    const html = fixture('chapter-empty.html')
    const result = extractPage(html, 'https://example.com/book/2.html')
    expect(result.ok).toBe(false)
    expect(result.failCode).toBe('BodyEmpty')
  })

  it('returns Intercepted for a long captcha-like page, not NeedLogin or BodyEmpty', () => {
    const html = fixture('intercepted.html')
    const result = extractPage(html, 'https://example.com/book/7.html')
    expect(result.ok).toBe(false)
    expect(result.failCode).toBe('Intercepted')
    expect(result.failMessage).toBe('页面不像正文（拦截或残页）')
  })
})

describe('extractCatalog', () => {
  it('extracts chapter list from catalog HTML', () => {
    const html = fixture('catalog.html')
    const chapters = extractCatalog(html, 'https://example.com/book/index.html')
    expect(chapters.length).toBe(6)
    expect(chapters[0].title).toContain('第一章')
    expect(chapters[0].url).toContain('1.html')
    expect(chapters[5].title).toContain('第六章')
  })
})

describe('extractBody', () => {
  it('extracts body from chapter HTML', () => {
    const html = fixture('chapter.html')
    const result = extractBody(html, 'https://example.com/book/1.html')
    expect(result.ok).toBe(true)
    expect(result.body).toContain('张若尘')
    expect(result.body).not.toContain('本站所有小说')
  })

  it('returns fail for empty body', () => {
    const html = fixture('chapter-empty.html')
    const result = extractBody(html, 'https://example.com/book/2.html')
    expect(result.ok).toBe(false)
    expect(result.failCode).toBe('BodyEmpty')
  })

  it('returns Intercepted for intercepted.html', () => {
    const html = fixture('intercepted.html')
    const result = extractBody(html, 'https://example.com/book/7.html')
    expect(result.ok).toBe(false)
    expect(result.failCode).toBe('Intercepted')
    expect(result.failMessage).toBe('页面不像正文（拦截或残页）')
  })
})

describe('public spbf-val fixtures (VAL-DL-010 / VAL-CROSS-002 / VAL-CROSS-009)', () => {
  it('public intercepted.html classifies the same as fixtures/intercepted.html', () => {
    const disk = extractPage(fixture('intercepted.html'), 'https://example.com/book/7.html')
    const pub = extractPage(publicVal('intercepted.html'), 'http://127.0.0.1:5175/spbf-val/intercepted.html')
    const pubBody = extractBody(publicVal('intercepted.html'), 'http://127.0.0.1:5175/spbf-val/intercepted.html')
    expect(disk.failCode).toBe('Intercepted')
    expect(pub.ok).toBe(false)
    expect(pub.failCode).toBe('Intercepted')
    expect(pub.failMessage).toBe('页面不像正文（拦截或残页）')
    expect(pub.failCode).toBe(disk.failCode)
    expect(pub.failMessage).toBe(disk.failMessage)
    expect(pubBody.ok).toBe(false)
    expect(pubBody.failCode).toBe('Intercepted')
    expect(pubBody.failMessage).toBe('页面不像正文（拦截或残页）')
  })

  it('mixed-catalog.html has an intercepted chapter and a 第x章 link to c1.html', () => {
    const url = 'http://127.0.0.1:5175/spbf-val/mixed-catalog.html'
    const page = extractPage(publicVal('mixed-catalog.html'), url)
    expect(page.ok).toBe(true)
    expect(page.pageKind).toBe('catalog')
    const chapters = extractCatalog(publicVal('mixed-catalog.html'), url)
    expect(chapters.length).toBeGreaterThanOrEqual(2)
    expect(chapters.some((c) => /intercepted\.html(?:[?#].*)?$/.test(c.url))).toBe(true)
    expect(chapters.some((c) => /c1\.html(?:[?#].*)?$/.test(c.url) && /第[0-9一二三四五六七八九十]+章/.test(c.title))).toBe(
      true,
    )
  })

  it('nav.html has a same-site link to ok-catalog.html', () => {
    expect(publicVal('nav.html')).toMatch(/href=["']ok-catalog\.html["']/)
  })
})

describe('site-rule extract — hostile 5176 fixture (VAL-RULE-001/002)', () => {
  it('generic extract cannot parse rule-site catalog or chapter pages', () => {
    const catalogPage = extractPage(ruleSite('catalog.html'), RULE_SITE.catalog)
    expect(catalogPage.ok && catalogPage.pageKind === 'catalog').toBe(false)
    expect(catalogPage.bootstrap?.bookTitle ?? '').not.toBe('SPBF_RULE_TITLE')
    expect(catalogPage.bootstrap?.author ?? '').not.toBe('SPBF_RULE_AUTHOR')
    const catalogTitles = (catalogPage.bootstrap?.chapters ?? []).map((c) => c.title)
    expect(catalogTitles).not.toContain('Alpha')
    expect(catalogTitles).not.toContain('Beta')

    const chapters = extractCatalog(ruleSite('catalog.html'), RULE_SITE.catalog)
    expect(chapters.map((c) => c.title)).not.toContain('Alpha')
    expect(chapters.map((c) => c.title)).not.toContain('Beta')
    expect(chapters.length).toBeLessThan(2)

    for (const [file, url, marker] of [
      ['c1.html', RULE_SITE.c1, 'SPBF_RULE_BODY_ALPHA'],
      ['c2.html', RULE_SITE.c2, 'SPBF_RULE_BODY_BETA'],
    ] as const) {
      const page = extractPage(ruleSite(file), url)
      expect(page.body ?? '').not.toContain(marker)
      const body = extractBody(ruleSite(file), url)
      expect(body.body ?? '').not.toContain(marker)
      expect(body.ok && (body.body ?? '').includes(marker)).toBe(false)
    }
  })

  it('matching #spbf-* rule extracts title, author, catalog, and long bodies', () => {
    const page = extractPage(ruleSite('catalog.html'), RULE_SITE.catalog, undefined, matchingRule)
    expect(page.ok).toBe(true)
    expect(page.pageKind).toBe('catalog')
    expect(page.bootstrap!.bookTitle).toBe('SPBF_RULE_TITLE')
    expect(page.bootstrap!.author).toBe('SPBF_RULE_AUTHOR')
    expect(page.bootstrap!.chapters.length).toBeGreaterThanOrEqual(2)
    const titles = page.bootstrap!.chapters.map((c) => c.title)
    expect(titles).toEqual(expect.arrayContaining(['Alpha', 'Beta']))
    for (const ch of page.bootstrap!.chapters) {
      expect(new URL(ch.url).hostname).toBe('127.0.0.1')
    }

    const catalog = extractCatalog(ruleSite('catalog.html'), RULE_SITE.catalog, matchingRule)
    expect(catalog.length).toBeGreaterThanOrEqual(2)
    expect(catalog.map((c) => c.title)).toEqual(expect.arrayContaining(['Alpha', 'Beta']))

    for (const [file, url, marker] of [
      ['c1.html', RULE_SITE.c1, 'SPBF_RULE_BODY_ALPHA'],
      ['c2.html', RULE_SITE.c2, 'SPBF_RULE_BODY_BETA'],
    ] as const) {
      const chapterPage = extractPage(ruleSite(file), url, undefined, matchingRule)
      expect(chapterPage.ok).toBe(true)
      expect(chapterPage.pageKind).toBe('chapter')
      expect(chapterPage.body).toContain(marker)
      expect(chapterPage.bootstrap!.catalogUrl).toMatch(/catalog\.html/)

      const body = extractBody(ruleSite(file), url, matchingRule)
      expect(body.ok).toBe(true)
      expect(body.body).toContain(marker)
      expect(body.body).not.toContain('DECOY_BANNER_CLICK')
      expect(effectiveLength(body.body)).toBeGreaterThanOrEqual(80)
    }
  })
})

describe('site-rule extract — empty / miss / illegal / short fall through (VAL-RULE-004)', () => {
  const goldenCatalogUrl = 'https://example.com/book/index.html'
  const goldenChapterUrl = 'https://example.com/book/1.html'
  const fallbackRules: Array<SiteRule | undefined> = [
    undefined,
    { host: 'example.com' },
    { host: 'example.com', title: '', author: '', catalog: '', body: '' },
    {
      host: 'example.com',
      title: '#no-such-spbf',
      author: '#no-such-spbf',
      catalog: '#no-such-spbf',
      body: '#no-such-spbf',
    },
    { host: 'example.com', title: '##', author: '[[[', catalog: '##', body: '[[[' },
    { host: 'example.com', catalog: 'h1', body: '.header' },
  ]

  it.each(fallbackRules)('still parses golden fixtures with rule %j', (rule) => {
    const page = extractPage(fixture('catalog.html'), goldenCatalogUrl, undefined, rule)
    expect(page.ok).toBe(true)
    expect(page.pageKind).toBe('catalog')
    expect(page.bootstrap!.chapters.length).toBe(6)
    expect(page.bootstrap!.bookTitle).toContain('万古神帝')

    const chapters = extractCatalog(fixture('catalog.html'), goldenCatalogUrl, rule)
    expect(chapters.length).toBe(6)
    expect(chapters[0].title).toContain('第一章')

    const body = extractBody(fixture('chapter.html'), goldenChapterUrl, rule)
    expect(body.ok).toBe(true)
    expect(body.body).toContain('张若尘')
  })
})

describe('public growable-catalog fixture (VAL-LIB-017)', () => {
  const catalogFile = 'growable-catalog.html'
  const base = 'http://127.0.0.1:5175/spbf-val/growable-catalog.html'

  function snapshotStorage(storage: Storage): Record<string, string> {
    const out: Record<string, string> = {}
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key) out[key] = storage.getItem(key) ?? ''
    }
    return out
  }

  function renderCatalog(search: string, prior: Record<string, string> = {}) {
    const url = `${base}${search}`
    const html = publicVal(catalogFile)
    const dom = new JSDOM(html, {
      url,
      runScripts: 'dangerously',
      beforeParse(window) {
        for (const [key, value] of Object.entries(prior)) {
          window.localStorage.setItem(key, value)
        }
      },
    })
    const serialized = `<!DOCTYPE html>${dom.window.document.documentElement.outerHTML}`
    return {
      serialized,
      storage: snapshotStorage(dom.window.localStorage),
      chapters: extractCatalog(serialized, url),
    }
  }

  it('c7.html is extractable plain text of at least 80 effective characters', () => {
    const url = 'http://127.0.0.1:5175/spbf-val/c7.html'
    const html = publicVal('c7.html')
    const page = extractPage(html, url)
    const body = extractBody(html, url)
    expect(page.ok).toBe(true)
    expect(page.pageKind).toBe('chapter')
    expect(body.ok).toBe(true)
    expect(body.body).toBeTruthy()
    expect(effectiveLength(body.body!)).toBeGreaterThanOrEqual(80)
    expect(body.body!).not.toMatch(/<(?:html|p|div|script)\b/i)
  })

  it('derives a unique localStorage key from location.search', () => {
    const src = publicVal(catalogFile)
    expect(src).toMatch(/location\.search/)
    expect(src).toMatch(/localStorage/)
  })

  it('static catalog HTML without running scripts only lists c1-c6', () => {
    const url = `${base}?case=static-check`
    const chapters = extractCatalog(publicVal(catalogFile), url)
    expect(chapters).toHaveLength(6)
    expect(chapters.every((c) => /c[1-6]\.html(?:[?#].*)?$/.test(c.url))).toBe(true)
    expect(chapters.some((c) => /c7\.html(?:[?#].*)?$/.test(c.url))).toBe(false)
  })

  it('same ?case first render is 6 chapters and second render appends only c7', () => {
    const search = '?case=11111111-2222-3333-4444-555555555555'
    const first = renderCatalog(search)
    expect(first.chapters).toHaveLength(6)
    expect(first.chapters.some((c) => /c7\.html(?:[?#].*)?$/.test(c.url))).toBe(false)

    const second = renderCatalog(search, first.storage)
    expect(second.chapters).toHaveLength(7)
    expect(second.chapters.filter((c) => /c7\.html(?:[?#].*)?$/.test(c.url))).toHaveLength(1)
    expect(second.chapters[6].title).toMatch(/第七章/)

    const third = renderCatalog(search, second.storage)
    expect(third.chapters).toHaveLength(7)
    expect(third.chapters.filter((c) => /c7\.html(?:[?#].*)?$/.test(c.url))).toHaveLength(1)
  })

  it('a different query does not inherit another case growth', () => {
    const a = '?case=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const b = '?case=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const a1 = renderCatalog(a)
    const a2 = renderCatalog(a, a1.storage)
    expect(a2.chapters).toHaveLength(7)

    const b1 = renderCatalog(b, a2.storage)
    expect(b1.chapters).toHaveLength(6)
    expect(b1.chapters.some((c) => /c7\.html(?:[?#].*)?$/.test(c.url))).toBe(false)
  })
})
