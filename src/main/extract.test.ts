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

  it('drops a duplicated latest-chapters block and keeps reading order', () => {
    const numbers = Array.from({ length: 12 }, (_, i) => i + 1)
    const item = (n: number) => `<dd><a href="${n}.html">第${n}章 夜行</a></dd>`
    const latest = [...numbers].reverse().slice(0, 3).map(item).join('')
    const full = numbers.map(item).join('')
    const html = `<html><head><title>测试书 - 某站</title></head><body><div id="list"><dl><dt>最新章节</dt>${latest}<dt>正文卷</dt>${full}</dl></div></body></html>`
    const chapters = extractCatalog(html, 'https://example.com/book/1/')
    expect(chapters.map((c) => c.title)).toEqual(numbers.map((n) => `第${n}章 夜行`))
    expect(chapters.map((c) => c.index)).toEqual(numbers)
  })

  it('appends chapters that only exist in the latest block', () => {
    const numbers = Array.from({ length: 12 }, (_, i) => i + 1)
    const item = (n: number) => `<dd><a href="${n}.html">第${n}章 夜行</a></dd>`
    const latest = [13, 12].map(item).join('')
    const full = numbers.map(item).join('')
    const html = `<html><head><title>测试书 - 某站</title></head><body><div id="list"><dl><dt>最新章节</dt>${latest}<dt>正文卷</dt>${full}</dl></div></body></html>`
    const chapters = extractCatalog(html, 'https://example.com/book/1/')
    expect(chapters.map((c) => c.title)).toEqual([...numbers, 13].map((n) => `第${n}章 夜行`))
  })

  it('keeps every volume when sections hold distinct chapters', () => {
    const html = `<html><head><title>测试书 - 某站</title></head><body><div id="list"><dl><dt>第一卷</dt><dd><a href="/1.html">第1章</a></dd><dd><a href="/2.html">第2章</a></dd><dt>第二卷</dt><dd><a href="/3.html">第3章</a></dd><dd><a href="/4.html">第4章</a></dd></dl></div></body></html>`
    const chapters = extractCatalog(html, 'https://example.com/book/')
    expect(chapters.map((c) => c.title)).toEqual(['第1章', '第2章', '第3章', '第4章'])
  })

  it('accepts number-first titles without a separator and standalone chapter names', () => {
    const html = `<html><head><title>测试书 - 某站</title></head><body><div id="list"><dl><dd><a href="/1.html">001 背叛</a></dd><dd><a href="/2.html">002重获新生</a></dd><dd><a href="/3.html">3179</a></dd><dd><a href="/4.html">4385“他”终于出现了（一）</a></dd><dd><a href="/5.html">楔子</a></dd><dd><a href="/6.html">番外 新春小剧场</a></dd><dd><a href="/7.html">第7章 夜行</a></dd></dl></div></body></html>`
    const chapters = extractCatalog(html, 'https://example.com/book/')
    expect(chapters.map((c) => c.title)).toEqual([
      '001 背叛',
      '002重获新生',
      '3179',
      '4385“他”终于出现了（一）',
      '楔子',
      '番外 新春小剧场',
      '第7章 夜行',
    ])
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

  it('does not read a bare 登录 word in the site title as a login wall', () => {
    const story =
      '夜风吹过城墙，林舟看见远处的灯火，想起昨夜在山路上听到的脚步声。他没有回头，只把信收进袖中，沿着石阶继续前行。'
    const html = `<html><head><title>第一章 起风 - 登录 - 某小说网</title></head><body><div id="content"><p>${story.repeat(
      20,
    )}</p></div></body></html>`
    expect(extractBody(html, 'https://example.com/book/1.html').ok).toBe(true)
    expect(extractPage(html, 'https://example.com/book/1.html').failCode).toBeUndefined()
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

  it('returns BodyGarbled when the page text is an encoding mojibake payload', () => {
    const mojibake = 'æµ‹è¯•æ–‡æœ¬锟斤拷'.repeat(12)
    const html = `<html><head><title>目录页</title></head><body><div id="content">${mojibake}</div></body></html>`
    const result = extractPage(html, 'https://example.com/book/index.html')
    expect(result.ok).toBe(false)
    expect(result.failCode).toBe('BodyGarbled')
    expect(result.failMessage).toBe('正文疑似乱码或字形替换，未入库')
  })

  it('does not classify normal CJK catalog text as garbled', () => {
    const html = `<html><body><ul>${Array.from({ length: 6 }, (_, i) => `<li><a href="${i + 1}.html">第${i + 1}章 夜行</a></li>`).join('')}</ul></body></html>`
    const result = extractPage(html, 'https://example.com/book/index.html')
    expect(result.ok).toBe(true)
    expect(result.pageKind).toBe('catalog')
  })

  it('returns Intercepted for a long captcha-like page, not NeedLogin or BodyEmpty', () => {
    const html = fixture('intercepted.html')
    const result = extractPage(html, 'https://example.com/book/7.html')
    expect(result.ok).toBe(false)
    expect(result.failCode).toBe('Intercepted')
    expect(result.failMessage).toBe('页面不像正文（拦截或残页）')
  })
})

describe('paywall detection', () => {
  const shortStory =
    '夜风吹过城墙，林舟看见远处的灯火，想起昨夜在山路上听到的脚步声。他没有回头，只把信收进袖中，沿着石阶继续前行。'

  it('classifies a short VIP teaser as Paywall instead of a ready chapter', () => {
    const html = fixture('paywall-vip.html')
    const page = extractPage(html, 'https://example.com/book/3.html')
    expect(page.ok).toBe(false)
    expect(page.failCode).toBe('Paywall')
    expect(page.failMessage).toBe('本章需要付费或会员')
    const body = extractBody(html, 'https://example.com/book/3.html')
    expect(body.ok).toBe(false)
    expect(body.failCode).toBe('Paywall')
  })

  it('keeps a full chapter even when the tail sells membership', () => {
    const html = `<html><head><title>第三十一章 出关</title></head><body><div id="content"><p>${shortStory.repeat(
      20,
    )}</p><p>开通会员可解锁后续章节。</p></div></body></html>`
    const result = extractBody(html, 'https://example.com/book/4.html')
    expect(effectiveLength(result.body)).toBeGreaterThan(800)
    expect(result.ok).toBe(true)
  })

  it('is not triggered by a VIP link in the site header', () => {
    const html = `<html><head><title>第三十二章 旧桥</title></head><body><div class="top"><a href="/vip/">开通会员</a></div><div id="content"><p>${shortStory.repeat(
      3,
    )}</p></div></body></html>`
    expect(extractBody(html, 'https://example.com/book/5.html').ok).toBe(true)
    expect(extractPage(html, 'https://example.com/book/5.html').failCode).toBeUndefined()
  })

  it('does not call an empty body a paywall because the header sells VIP', () => {
    const html = fixture('vip-nav-empty.html')
    const body = extractBody(html, 'https://example.com/book/31.html')
    expect(body.ok).toBe(false)
    expect(body.failCode).toBe('BodyEmpty')
    const page = extractPage(html, 'https://example.com/book/31.html')
    expect(page.failCode).toBe('BodyEmpty')
  })

  it('keeps a purchased chapter that carries the VIP badge in its own body', () => {
    const html = fixture('vip-purchased-long.html')
    const body = extractBody(html, 'https://example.com/book/31.html')
    expect(body.ok).toBe(true)
    expect(effectiveLength(body.body)).toBeGreaterThan(800)
    expect(extractPage(html, 'https://example.com/book/31.html').ok).toBe(true)
  })

  it('still calls an empty page with an explicit unlock sentence a paywall', () => {
    const html =
      '<html><head><title>第四十章 断崖</title></head><body><div id="content"></div><p>本章需付费，购买本章后可解锁后续章节。</p></body></html>'
    expect(extractBody(html, 'https://example.com/book/40.html').failCode).toBe('Paywall')
  })
})

describe('chapter ad paragraph cleanup', () => {
  const story = '夜风吹过城墙，林舟看见远处的灯火，想起昨夜在山路上听到的脚步声。他没有回头，只把信收进袖中，沿着石阶继续前行。'
  const storyTwo = '第二天清晨，船终于靠岸。众人商量好入城的路线，又把行李分给同行的伙伴，约定天黑前在旧桥旁会合。'

  it('keeps paragraph breaks and raw text while dropping a standalone site address ad', () => {
    const html = `<html><body><div id="content"><p>${story}</p><p>最新网址：www.example.com，请收藏本站网址以便继续阅读</p><p>${storyTwo}</p><p>作者有话说：感谢大家阅读，明天继续更新。</p></div></body></html>`
    const result = extractBody(html, 'https://example.com/book/1.html', { host: 'example.com', body: '#content' })
    expect(result.ok).toBe(true)
    expect(result.bodyRaw).toContain('最新网址')
    expect(result.body).not.toContain('最新网址')
    expect(result.body).toContain(`${story}\n\n${storyTwo}`)
    expect(result.body).toContain('作者有话说')
  })

  it('keeps ambiguous story text containing a website address', () => {
    const html = `<html><body><div id="content"><p>${story}</p><p>她在纸上写下网址：www.example.com，随后把它交给守门人。</p><p>最新网址：www.example.com，请收藏本站网址以便继续阅读</p></div></body></html>`
    const result = extractBody(html, 'https://example.com/book/2.html', { host: 'example.com', body: '#content' })
    expect(result.ok).toBe(true)
    expect(result.body).toContain('她在纸上写下网址')
    expect(result.bodyRaw).toContain('最新网址')
  })

  it('falls back to the raw chapter if ad removal would cut too much text', () => {
    const largeNotice = `最新网址：www.example.com，请收藏本站网址以便继续阅读。${'请记住我们的地址以便访问。'.repeat(6)}`
    const html = `<html><body><div id="content"><p>${story}${storyTwo}</p><p>${largeNotice}</p></div></body></html>`
    const result = extractBody(html, 'https://example.com/book/3.html', { host: 'example.com', body: '#content' })
    expect(result.ok).toBe(true)
    expect(result.body).toBe(result.bodyRaw)
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
    tags: [],
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

  it('Alice chapter recovers /other/chapters catalogUrl; novel may not (VAL-IDENT-018/021)', () => {
    const filler =
      '张若尘从梦中惊醒，发现自己身处一间简陋的房间之中。窗外月光如水，照在斑驳的墙壁上。他低头看了看自己的双手，年轻、有力，却不是他记忆中的样子。这个少年来自一个偏远的小城，自幼父母双亡，靠邻居接济长大。他站起身来，走到窗前，望着远处连绵的山峦。这个世界比地球更加广阔，充满了未知的危险和机遇。既然老天给了我第二次生命，我一定要活出个样子来。他握紧了拳头，眼中闪过坚定的光芒。'
    const chapterUrl = 'https://www.alicesw.com/book/46268/9c5ec36414c68.html'
    const chaptersCatalog = 'https://www.alicesw.com/other/chapters/id/44828.html'
    const novelUrl = 'https://www.alicesw.com/novel/44828.html'
    const chapterHtml = `<!DOCTYPE html>
<html>
<head><title>序 - 三国杀同人短篇合集</title></head>
<body>
<div id="content">
${filler}
上一章 | <a href="/other/chapters/id/44828.html">返回目录</a> | 下一章
</div>
</body>
</html>`
    const novelHtml = `<!DOCTYPE html>
<html>
<head><title>三国杀同人短篇合集</title></head>
<body>
<h1>三国杀同人短篇合集</h1>
<div id="intro">${filler}</div>
<a href="/other/chapters/id/44828.html">查看所有章节</a>
<ul>
  <li><a href="/book/46268/9c5ec36414c68.html">第一章 序</a></li>
  <li><a href="/book/46268/77281b2336468.html">第二章 同人短篇</a></li>
</ul>
</body>
</html>`

    const chapterPage = extractPage(chapterHtml, chapterUrl)
    expect(chapterPage.ok).toBe(true)
    expect(chapterPage.pageKind).toBe('chapter')
    expect(chapterPage.bootstrap!.catalogUrl).toBe(chaptersCatalog)
    expect(chapterPage.bootstrap!.catalogUrl).not.toMatch(/#\//)
    expect(bookIdFromUrl('www.alicesw.com', chapterPage.bootstrap!.catalogUrl!)).toBe(
      bookIdFromUrl('www.alicesw.com', chaptersCatalog),
    )

    const novelPage = extractPage(novelHtml, novelUrl)
    const recovered = novelPage.bootstrap?.catalogUrl
    if (recovered && recovered.includes('/other/chapters/id/44828.html')) {
      expect(bookIdFromUrl('www.alicesw.com', recovered)).toBe(
        bookIdFromUrl('www.alicesw.com', chaptersCatalog),
      )
    } else {
      // Novel landing does not recover the chapters catalog. Live tests must
      // paste only https://www.alicesw.com/other/chapters/id/44828.html (VAL-DL-001).
      expect(bookIdFromUrl('www.alicesw.com', novelUrl)).not.toBe(
        bookIdFromUrl('www.alicesw.com', chaptersCatalog),
      )
    }
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

describe('extractBody — 正文噪音净化', () => {
  const NOISY_URL = 'https://example.com/book/7.html'

  it('drops site navigation and repeated paragraphs', () => {
    const result = extractBody(fixture('noisy-chapter.html'), NOISY_URL)
    expect(result.ok).toBe(true)
    expect(result.body).not.toContain('请记住本书首发域名')
    expect(result.body).not.toContain('加入书架')
    expect(result.body).not.toContain('\n 上一章')
    // 站点特有的水印不在内置规则里，留给站点规则处理
    expect(result.body).toContain('编号 A-2291')
    expect(result.body.match(/越过这道垭口/g)).toHaveLength(1)
    expect(result.body).toContain('风从山口压下来')
  })

  it('applies the site rule bodyCleanPatterns on top of the built-in rules', () => {
    const rule: SiteRule = { host: 'example.com', bodyCleanPatterns: 'A-2291' }
    const result = extractBody(fixture('noisy-chapter.html'), NOISY_URL, rule)
    expect(result.ok).toBe(true)
    expect(result.body).not.toContain('编号 A-2291')
    expect(result.body).toContain('风从山口压下来')
  })

  it('ignores an invalid clean pattern instead of dropping the body', () => {
    const rule: SiteRule = { host: 'example.com', bodyCleanPatterns: '这不是正则([' }
    const result = extractBody(fixture('noisy-chapter.html'), NOISY_URL, rule)
    expect(result.ok).toBe(true)
    expect(result.body).toContain('编号 A-2291')
    expect(result.body).toContain('风从山口压下来')
  })

  it('keeps every prose paragraph when the noise is small', () => {
    const first = '风从山口压下来，把整片草场按出一道长长的波纹。她记得父亲说过，越过这道垭口就是另一重天地，可真正站在垭口上时只看见云在脚下翻滚，远处的雷声一点点近起来。'
    const second = '林昭把缰绳绕在手腕上，一步一步朝那片翻滚的云里走去。她没有回头，只是把斗篷勒得更紧，心里清楚地知道今天是回不去了。'
    const html = `<html><body><div id="content"><p>${first}</p><p>${second}</p></div>
      <div>加入书架</div><div>上一章</div><div>下一章</div>
      <div>请记住本书首发域名：www.example.com</div></body></html>`
    const result = extractBody(html, NOISY_URL)
    expect(result.ok).toBe(true)
    expect(result.body).toContain('越过这道垭口就是另一重天地')
    expect(result.body).toContain('心里清楚地知道今天是回不去了')
  })

  it('drops the chapter-start site watermark and the page marker', () => {
    const first = '该高端航模机构引进国外高端航模技术，制造出了一架一比一可真实还原的战机模型，它不但可以真实起飞，而且飞机里面还可以坐一个人。'
    const second = '民间那些热火朝天的航模爱好者准备研发高仿的发动机，核心部分准备研发一款超高仿真的航模飞行器，还要给它架构民间版本的雷达与操控系统。'
    const html = `<html><body><div id="content">
      <p>一秒记住【笔趣阁】biquge365.net，更新快，无弹窗！</p>
      <p>第190章 先生早晨(粤语)(第1/2页)</p>
      <p>${first}</p><p>${second}</p></div></body></html>`
    const result = extractBody(html, NOISY_URL)
    expect(result.ok).toBe(true)
    expect(result.body).not.toContain('一秒记住')
    expect(result.body).not.toContain('(第1/2页)')
    expect(result.body).toContain('该高端航模机构引进国外高端航模技术')
    expect(result.body).toContain('民间那些热火朝天的航模爱好者')
  })
})

describe('extractPage — 书名清洗与目录链接过滤', () => {
  it('strips the site suffix from og:title, h1, and <title>', () => {
    const story = '风从山口压下来，把整片草场按出一道长长的波纹。她记得父亲说过，越过这道垭口就是另一重天地。'.repeat(4)
    const html = `<html><head>
      <meta property="og:title" content="万古神帝 - 笔趣阁">
      <title>万古神帝_笔趣阁</title>
    </head><body><div id="content"><p>${story}</p></div></body></html>`
    const result = extractPage(html, 'https://example.com/book/1.html')
    expect(result.ok).toBe(true)
    expect(result.bootstrap!.bookTitle).toBe('万古神帝')
  })

  it('falls back to h1 for the title when og:title is absent, still stripping the suffix', () => {
    const story = '风从山口压下来，把整片草场按出一道长长的波纹。她记得父亲说过，越过这道垭口就是另一重天地。'.repeat(4)
    const html = `<html><head><title>某小说网</title></head><body>
      <h1>万古神帝 - 某小说网</h1>
      <div id="list"><dl><dd><a href="/1.html">第一章</a></dd><dd><a href="/2.html">第二章</a></dd></dl></div>
      <div id="content"><p>${story}</p></div>
    </body></html>`
    const result = extractPage(html, 'https://example.com/book/index.html')
    expect(result.ok).toBe(true)
    expect(result.bootstrap!.bookTitle).toBe('万古神帝')
  })

  it('skips javascript:, bare in-page anchors, and cross-domain chapter links in the catalog', () => {
    const html = `<html><head><title>测试书 - 某站</title></head><body><div id="list"><dl>
      <dd><a href="javascript:void(0)">收藏</a></dd>
      <dd><a href="#top">顶部</a></dd>
      <dd><a href="#content">正文</a></dd>
      <dd><a href="https://other.example.net/book/9.html">第九章 外链</a></dd>
      <dd><a href="/1.html">第一章 归来</a></dd>
      <dd><a href="/2.html">第二章 苏醒</a></dd>
    </dl></div></body></html>`
    const chapters = extractCatalog(html, 'https://example.com/book/index.html')
    expect(chapters.map((c) => c.title)).toEqual(['第一章 归来', '第二章 苏醒'])
    expect(chapters.map((c) => c.url)).toEqual(['https://example.com/1.html', 'https://example.com/2.html'])
  })
})
