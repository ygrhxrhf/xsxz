import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { extractPage, extractCatalog, extractBody } from './extract'
import { bookIdFromUrl, mergeIncomingChapters, normalizeChapterUrl } from './library'
import { canonicalizeUrl } from '../shared/urlHash'
import type { Book, SiteRule } from '../shared/types'

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

const BQG_ORIGIN = 'https://www.bqg858.cc/'
const BQG_CATALOG = 'https://www.bqg858.cc/#/book/65/'
const BQG_HOST = 'www.bqg858.cc'

function emptyBook(partial?: Partial<Book>): Book {
  return {
    id: 'd_test',
    title: '测',
    author: '',
    importType: 'download',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'partial',
    progress: null,
    chapters: [],
    ...partial,
  }
}

function chapterUrlLooksInPageOrJs(url: string): boolean {
  const lower = url.toLowerCase()
  if (lower.startsWith('javascript:')) return true
  try {
    const u = new URL(url)
    if (u.origin + '/' === BQG_ORIGIN && (!u.hash || u.hash === '#')) return true
    const hash = u.hash
    if (!hash || hash === '#' || hash === '#top' || hash === '#content' || hash === '#list') return true
    if (hash.startsWith('#top') || hash.startsWith('#content') || hash.startsWith('#list')) return true
  } catch {
    if (url === '#' || url === '#top' || url === '#content' || url === '#list') return true
  }
  return false
}

function bqgCatalogHtml(extraLinks = ''): string {
  return `<!DOCTYPE html>
<html>
<head><title>这个大佬画风不对 - 笔趣阁</title>
<meta property="og:title" content="这个大佬画风不对">
<meta property="og:novel:author" content="墨泠">
</head>
<body>
<h1 id="title">这个大佬画风不对</h1>
<div id="author">作者：墨泠</div>
<div class="nav">
  <a href="#top">顶部</a>
  <a href="#content">正文</a>
  <a href="#">本页</a>
  <a href="#list">目录锚点</a>
  <a href="javascript:void(0)">收藏</a>
</div>
<div id="list">
<dl>
<dt>正文</dt>
<dd><a href="#/book/65/1.html">第1章 千金攻略（1）</a></dd>
<dd><a href="/#/book/65/2.html">第2章 千金攻略（2）</a></dd>
<dd><a href="https://www.bqg858.cc/#/book/65/3.html">第3章 千金攻略（3）</a></dd>
<dd><a href="#/book/65/4.html">第4章 千金攻略（4）</a></dd>
<dd><a href="#/book/65/5.html">第5章 千金攻略（5）</a></dd>
${extraLinks}
</dl>
</div>
<div id="content">占位</div>
</body>
</html>`
}

function bqgChapterHtml(catalogHref: string): string {
  const filler =
    '张若尘从梦中惊醒，发现自己身处一间简陋的房间之中。窗外月光如水，照在斑驳的墙壁上。他低头看了看自己的双手，年轻、有力，却不是他记忆中的样子。这个少年来自一个偏远的小城，自幼父母双亡，靠邻居接济长大。他站起身来，走到窗前，望着远处连绵的山峦。这个世界比地球更加广阔，充满了未知的危险和机遇。既然老天给了我第二次生命，我一定要活出个样子来。他握紧了拳头，眼中闪过坚定的光芒。'
  return `<!DOCTYPE html>
<html>
<head><title>第1章 千金攻略（1） - 这个大佬画风不对</title></head>
<body>
<h1 id="title">第1章 千金攻略（1）</h1>
<div id="chaptercontent">
${filler}
上一章 | <a href="${catalogHref}">返回目录</a> | 下一章
</div>
</body>
</html>`
}

function aliceLikeCatalogHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><title>三国杀同人短篇合集 目录</title>
<meta property="og:title" content="三国杀同人短篇合集">
</head>
<body>
<h1>三国杀同人短篇合集</h1>
<a href="#top">顶部</a>
<ul>
  <li><a href="https://www.alicesw.com/book/46268/9c5ec36414c68.html">第一章 序</a></li>
  <li><a href="https://www.alicesw.com/book/46268/77281b2336468.html">第二章 同人短篇</a></li>
  <li><a href="https://www.alicesw.com/book/46268/49003fd028942.html">第三章 续写</a></li>
  <li><a href="https://www.alicesw.com/book/46268/aaa1111111111.html">第四章 第四篇</a></li>
  <li><a href="https://www.alicesw.com/book/46268/bbb2222222222.html">第五章 第五篇</a></li>
</ul>
</body>
</html>`
}

describe('hash-route catalog extract (VAL-IDENT-004..009 / 024 / 025)', () => {
  it('keeps hash-route catalog links and skips in-page anchors', () => {
    const html = bqgCatalogHtml()
    const page = extractPage(html, BQG_CATALOG)
    expect(page.ok).toBe(true)
    expect(page.pageKind).toBe('catalog')
    const chapters = page.bootstrap!.chapters
    expect(chapters.length).toBeGreaterThanOrEqual(3)
    const urls = chapters.map((c) => c.url)
    expect(chapters.every((c) => c.title.length > 0)).toBe(true)
    expect(urls.some((u) => u.includes('#/book/65/1.html'))).toBe(true)
    expect(urls.some((u) => u.includes('#/book/65/2.html'))).toBe(true)
    expect(urls.some((u) => u.includes('#/book/65/3.html'))).toBe(true)
    expect(chapters.filter((c) => chapterUrlLooksInPageOrJs(c.url))).toHaveLength(0)
    expect(urls.every((u) => !/#top|#content|#list|javascript:/i.test(u) || /#\/book\//.test(u))).toBe(true)
  })

  it('site rule #list collects hash-route a and omits #top', () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>这个大佬画风不对</title></head>
<body>
<h1 id="title">这个大佬画风不对</h1>
<div id="author">墨泠</div>
<a href="#/book/65/99.html">第99章 容器外</a>
<div id="list">
  <a href="#top">顶部</a>
  <a href="#/book/65/1.html">第1章 千金攻略（1）</a>
  <a href="#/book/65/2.html">第2章 千金攻略（2）</a>
</div>
</body>
</html>`
    const rule: SiteRule = { host: BQG_HOST, catalog: '#list' }
    const page = extractPage(html, BQG_CATALOG, undefined, rule)
    expect(page.ok).toBe(true)
    expect(page.pageKind).toBe('catalog')
    const chapters = page.bootstrap!.chapters
    expect(chapters.length).toBeGreaterThanOrEqual(2)
    expect(chapters.some((c) => c.url.includes('#/book/65/1.html'))).toBe(true)
    expect(chapters.some((c) => c.url.includes('#/book/65/2.html'))).toBe(true)
    expect(chapters.some((c) => /#top/.test(c.url) && !c.url.includes('#/book/'))).toBe(false)
    expect(chapters.every((c) => /#\/book\//.test(c.url))).toBe(true)
    expect(chapters.some((c) => c.url.includes('99.html'))).toBe(false)
  })

  it('relative and absolute #/book/65/1.html trio dedupes to one resolved URL', () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>这个大佬画风不对</title></head>
<body>
<div id="list">
<dl>
<dd><a href="#/book/65/1.html">第1章 千金攻略（1）</a></dd>
<dd><a href="/#/book/65/1.html">第1章 千金攻略（1）</a></dd>
<dd><a href="https://www.bqg858.cc/#/book/65/1.html">第1章 千金攻略（1）</a></dd>
<dd><a href="#/book/65/2.html">第2章 千金攻略（2）</a></dd>
<dd><a href="#/book/65/3.html">第3章 千金攻略（3）</a></dd>
<dd><a href="#/book/65/4.html">第4章 千金攻略（4）</a></dd>
<dd><a href="#/book/65/5.html">第5章 千金攻略（5）</a></dd>
</dl>
</div>
</body>
</html>`
    const chapters = extractCatalog(html, BQG_CATALOG)
    const ones = chapters.filter((c) => /#\/book\/65\/1\.html/.test(c.url))
    expect(ones).toHaveLength(1)
    expect(ones[0].url).toBe('https://www.bqg858.cc/#/book/65/1.html')
  })

  it('N distinct hash chapter links do not collapse to origin', () => {
    const n = 5
    const extra = Array.from({ length: n }, (_, i) => {
      const k = i + 1
      return `<dd><a href="#/book/65/${k}.html">第${k}章 千金攻略（${k}）</a></dd>`
    }).join('\n')
    const html = `<!DOCTYPE html>
<html><head><title>这个大佬画风不对</title></head>
<body>
<div id="list"><dl>${extra}</dl></div>
</body></html>`
    const chapters = extractCatalog(html, BQG_CATALOG)
    expect(chapters.length).toBe(n)
    const urls = chapters.map((c) => c.url)
    expect(new Set(urls).size).toBe(n)
    expect(urls.every((u) => u !== BQG_ORIGIN && u !== 'https://www.bqg858.cc')).toBe(true)
    expect(urls.every((u) => u.includes('#/book/65/'))).toBe(true)
  })

  it('classic Alice /book/ catalog still collects path links and skips #top', () => {
    const html = aliceLikeCatalogHtml()
    const catalogUrl = 'https://www.alicesw.com/other/chapters/id/44828.html'
    const page = extractPage(html, catalogUrl)
    expect(page.ok).toBe(true)
    expect(page.pageKind).toBe('catalog')
    const chapters = page.bootstrap!.chapters
    expect(chapters.length).toBeGreaterThanOrEqual(2)
    expect(chapters.every((c) => c.url.includes('/book/46268/'))).toBe(true)
    expect(chapters.some((c) => /#top/.test(c.url))).toBe(false)
    expect(chapters.some((c) => /#\//.test(c.url))).toBe(false)
  })

  it('extract seen keys agree with normalizeChapterUrl and merge adds N not 1', () => {
    const extra = Array.from({ length: 5 }, (_, i) => {
      const k = i + 1
      return `<dd><a href="#/book/65/${k}.html">第${k}章 千金攻略（${k}）</a></dd>`
    }).join('\n')
    const html = bqgCatalogHtml(extra)
    const chapters = extractCatalog(html, BQG_CATALOG)
    expect(chapters.length).toBeGreaterThanOrEqual(5)
    const keys = chapters.map((c) => canonicalizeUrl(c.url))
    expect(new Set(keys).size).toBe(chapters.length)
    for (const ch of chapters) {
      expect(normalizeChapterUrl(ch.url)).toBe(normalizeChapterUrl(canonicalizeUrl(ch.url)))
      expect(normalizeChapterUrl(ch.url)).toContain('#/book/65/')
      expect(normalizeChapterUrl(ch.url)).not.toBe(normalizeChapterUrl(BQG_ORIGIN))
    }
    const incoming = chapters.map((c) => ({
      title: c.title,
      url: c.url,
      index: c.index,
    }))
    const { added } = mergeIncomingChapters(emptyBook(), incoming)
    expect(added).toBe(chapters.length)
    expect(added).not.toBe(1)
  })

  it('chapter page recovers hash catalogUrl from 返回目录', () => {
    const chapterUrl = 'https://www.bqg858.cc/#/book/65/1.html'
    for (const href of ['#/book/65/', '/#/book/65/', 'https://www.bqg858.cc/#/book/65/']) {
      const page = extractPage(bqgChapterHtml(href), chapterUrl)
      expect(page.ok).toBe(true)
      expect(page.pageKind).toBe('chapter')
      const catalogUrl = page.bootstrap!.catalogUrl
      expect(catalogUrl).toBeTruthy()
      expect(catalogUrl).toContain('#/book/65')
      expect(catalogUrl).not.toBe(BQG_ORIGIN)
      expect(catalogUrl).not.toContain('1.html')
      expect(catalogUrl!.startsWith('https://www.bqg858.cc/')).toBe(true)
      expect(bookIdFromUrl(BQG_HOST, catalogUrl!)).toBe(bookIdFromUrl(BQG_HOST, BQG_CATALOG))
    }

    const classicChapter = extractPage(fixture('chapter.html'), 'https://www.alicesw.com/book/46268/9c5ec36414c68.html')
    expect(classicChapter.ok).toBe(true)
    expect(classicChapter.pageKind).toBe('chapter')
    expect(classicChapter.bootstrap!.catalogUrl).toMatch(/\/book\/?$/)
    expect(classicChapter.bootstrap!.catalogUrl).not.toMatch(/#\//)
  })

  it('query + path-like hash seen key agrees with normalize and merge added===0', () => {
    const clean = 'https://www.bqg858.cc/#/book/65/1.html'
    const utm = 'https://www.bqg858.cc/?utm_source=x#/book/65/1.html'
    const pageQ = 'https://www.bqg858.cc/?page=2#/book/65/1.html'
    const ch2 = 'https://www.bqg858.cc/#/book/65/2.html'
    const leftoverCatalog = 'https://www.bqg858.cc/?#/book/65/'

    const html = `<!DOCTYPE html>
<html><head><title>这个大佬画风不对</title></head>
<body>
<div id="list">
<dl>
<dd><a href="${utm}">第1章 千金攻略（1）</a></dd>
<dd><a href="${pageQ}">第1章 千金攻略（1）</a></dd>
<dd><a href="${clean}">第1章 千金攻略（1）</a></dd>
<dd><a href="${ch2}">第2章 千金攻略（2）</a></dd>
<dd><a href="#/book/65/3.html">第3章 千金攻略（3）</a></dd>
<dd><a href="#/book/65/4.html">第4章 千金攻略（4）</a></dd>
<dd><a href="#/book/65/5.html">第5章 千金攻略（5）</a></dd>
</dl>
</div>
</body></html>`
    const chapters = extractCatalog(html, leftoverCatalog)
    const ones = chapters.filter((c) => canonicalizeUrl(c.url) === canonicalizeUrl(clean))
    expect(ones.length).toBe(1)
    expect(chapters.some((c) => canonicalizeUrl(c.url) === canonicalizeUrl(ch2))).toBe(true)
    expect(chapters.every((c) => canonicalizeUrl(c.url) !== canonicalizeUrl(BQG_ORIGIN))).toBe(true)

    expect(normalizeChapterUrl(utm)).toBe(normalizeChapterUrl(clean))
    expect(normalizeChapterUrl(pageQ)).toBe(normalizeChapterUrl(clean))
    expect(normalizeChapterUrl(utm)).not.toBe(normalizeChapterUrl(ch2))
    expect(bookIdFromUrl(BQG_HOST, leftoverCatalog)).toBe(bookIdFromUrl(BQG_HOST, BQG_CATALOG))

    const existing = emptyBook({
      chapters: [
        {
          id: 'c0001',
          index: 1,
          title: '第1章 千金攻略（1）',
          url: clean,
          file: 'chapters/0001.json',
          status: 'ready',
        },
      ],
    })
    const { added } = mergeIncomingChapters(existing, [
      { title: '第1章 千金攻略（1）', url: utm, index: 1 },
      { title: '第1章 千金攻略（1）', url: pageQ, index: 1 },
    ])
    expect(added).toBe(0)
    expect(existing.chapters).toHaveLength(1)
    expect(existing.chapters[0].status).toBe('ready')
  })
})
