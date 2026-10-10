import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractBody, extractPage } from './extract'
import { findContinuationUrls, unlockAllowed, unlockPaywalledBody } from './paywallUnlock'
import type { SiteRule } from '../shared/types'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '../../fixtures', name), 'utf-8')

const PAGE_URL = 'https://example.com/book/32.html'

/** 页面上已经能看见的试读部分（短，带付费话术）。 */
const TEASER =
  '石阶尽头的石门半开，门缝里透出一线昏黄的灯。林舟把伞收拢，抖落肩上的雪，抬脚踏进去时，脚下那块青砖发出一声闷响，像是从很深的地方传上来的回声。他知道自己只走到这里便会被拦下。'

function effectiveLength(text: string): number {
  return text.replace(/[\s\p{P}]/gu, '').length
}

describe('付费墙自动解锁 — 页面内藏着的全文', () => {
  it('从隐藏节点里拿回全文', () => {
    const attempt = unlockPaywalledBody(fixture('paywall-hidden-dom.html'), PAGE_URL, undefined, {
      visibleBody: TEASER,
    })
    expect(attempt.ok).toBe(true)
    expect(attempt.hit?.method).toBe('hiddenDom')
    expect(attempt.hit?.body).toContain('他数着那盏灯晃动的次数')
    expect(effectiveLength(attempt.hit!.body)).toBeGreaterThan(effectiveLength(TEASER) + 200)
  })

  it('从内联 JSON 里拿回全文，段落边界保留', () => {
    const attempt = unlockPaywalledBody(fixture('paywall-embedded-json.html'), PAGE_URL, undefined, {
      visibleBody: TEASER,
    })
    expect(attempt.ok).toBe(true)
    expect(attempt.hit?.method).toBe('embeddedJson')
    expect(attempt.hit?.body).toContain('长廊尽头传来钟声')
    expect(attempt.hit!.body).toContain('\n\n')
  })

  it('从 base64 载荷里拿回全文', () => {
    const attempt = unlockPaywalledBody(fixture('paywall-base64.html'), PAGE_URL, undefined, {
      visibleBody: TEASER,
    })
    expect(attempt.ok).toBe(true)
    expect(attempt.hit?.method).toBe('encoded')
    expect(attempt.hit?.body).toContain('剑鞘上的铜钉')
  })

  it('站点规则给的解锁容器优先于猜测', () => {
    const html = `<html><body><div id="free">${TEASER}</div><div id="locked-body"><p>${'林舟把伞靠在石墙上，慢慢开口。'.repeat(
      24,
    )}</p></div></body></html>`
    const rule: SiteRule = { host: 'example.com', unlockSelectors: '#locked-body' }
    const attempt = unlockPaywalledBody(html, PAGE_URL, rule, { visibleBody: TEASER })
    expect(attempt.ok).toBe(true)
    expect(attempt.hit?.method).toBe('rule')
    expect(attempt.hit?.detail).toContain('#locked-body')
  })

  it('解锁容器选择器不合法时不炸，继续走通用路径', () => {
    const rule: SiteRule = { host: 'example.com', unlockSelectors: '#(((' }
    const attempt = unlockPaywalledBody(fixture('paywall-hidden-dom.html'), PAGE_URL, rule, {
      visibleBody: TEASER,
    })
    expect(attempt.ok).toBe(true)
    expect(attempt.hit?.method).toBe('hiddenDom')
    expect(attempt.tried?.some((line) => line.includes('#((('))).toBe(true)
  })

  it('恢复出来的正文里单独成段的付费提示会被清掉', () => {
    const html = `<html><body><div id="free">${TEASER}</div><div class="vip-hide" style="display:none">
      <p>${'林舟把伞靠在石墙上，慢慢开口，风从门缝里灌进来，灯焰一矮。'.repeat(12)}</p>
      <p>——本章剩余内容需要付费阅读，购买本章或开通会员后可解锁后续章节。</p>
      </div></body></html>`
    const attempt = unlockPaywalledBody(html, PAGE_URL, undefined, { visibleBody: TEASER })
    expect(attempt.ok).toBe(true)
    expect(attempt.hit?.body).not.toContain('需要付费阅读')
    expect(attempt.hit?.body).toContain('林舟把伞靠在石墙上')
  })

  it('noscript 里的全文也能拿回来', () => {
    const body = '值夜弟子把灯提到胸前，照见石阶上那道极浅的刻痕，摸到一个归字的下半截。'.repeat(12)
    const html = `<html><body><div id="content">${TEASER}</div>
      <noscript><div id="full">${body}</div></noscript></body></html>`
    const attempt = unlockPaywalledBody(html, PAGE_URL, undefined, { visibleBody: TEASER })
    expect(attempt.ok).toBe(true)
    expect(attempt.hit?.method).toBe('hiddenDom')
    expect(attempt.hit?.detail).toContain('noscript')
    expect(attempt.hit?.body).toContain('摸到一个归字的下半截')
  })

  it('私用区码点占多数的正文不当正文（字体混淆）', () => {
    const gibberish = `${'\ue001\ue002\ue003\ue004\ue005'.repeat(60)}`
    const html = `<html><body><div class="vip-hide" style="display:none">${gibberish}</div></body></html>`
    const attempt = unlockPaywalledBody(html, PAGE_URL, undefined, { visibleBody: TEASER })
    expect(attempt.ok).toBe(false)
    expect(attempt.reason).toContain('字体')
  })

  it('站点关掉自动解锁时直接放弃', () => {
    const rule: SiteRule = { host: 'example.com', paywallUnlock: false }
    const attempt = unlockPaywalledBody(fixture('paywall-hidden-dom.html'), PAGE_URL, rule, {
      visibleBody: TEASER,
    })
    expect(attempt.ok).toBe(false)
    expect(attempt.reason).toBe('本站已关闭自动解锁')
    expect(unlockAllowed(rule)).toBe(false)
    expect(unlockAllowed(undefined)).toBe(true)
  })

  it('恢复出来的内容不比试读多时不认账', () => {
    const attempt = unlockPaywalledBody(fixture('paywall-hidden-dom.html'), PAGE_URL, undefined, {
      visibleBody: fixture('paywall-hidden-dom.html').replace(/<[^>]+>/g, ' '),
    })
    expect(attempt.ok).toBe(false)
    expect(attempt.reason).toBeTruthy()
  })

  it('页面里没有可恢复内容时给可读原因', () => {
    const attempt = unlockPaywalledBody(fixture('paywall-vip.html'), 'https://example.com/book/3.html', undefined, {
      visibleBody: '',
    })
    expect(attempt.ok).toBe(false)
    expect(attempt.reason).toBe('页面里没有藏起来的正文')
  })
})

describe('付费墙自动解锁 — 藏起来的续页', () => {
  it('收集被藏起来的分页与整页链接', () => {
    const html = `<html><body><div id="content">${TEASER}</div>
      <a href="/book/32.html?page=2" style="display:none">下一页</a>
      <a href="https://other-site.com/book/32.html?page=2">全文阅读</a>
      <a href="/book/33.html" >下一章</a>
      <a href="${PAGE_URL}">本页</a>
      <a href="#top">顶部</a>
      </body></html>`
    const urls = findContinuationUrls(html, PAGE_URL)
    expect(urls).toEqual(['https://example.com/book/32.html?page=2'])
  })

  it('找不到续页时返回空数组', () => {
    expect(findContinuationUrls(fixture('paywall-hidden-dom.html'), PAGE_URL)).toEqual([])
  })

  it('data-url 按钮与跳页下拉里的分页地址也算续页', () => {
    const html = `<html><body><div id="content">${TEASER}</div>
      <a href="javascript:void(0)" data-url="32.html?page=2" class="more">展开剩余</a>
      <select><option value="32.html?page=3">第 3 页</option><option value="/book/32.html">本页</option></select>
      </body></html>`
    const urls = findContinuationUrls(html, PAGE_URL)
    expect(urls).toContain('https://example.com/book/32.html?page=2')
    expect(urls).toContain('https://example.com/book/32.html?page=3')
  })

  it('data-url 里没有分页特征的地址不收（懒加载图片之类）', () => {
    const html = `<html><body><div id="content">${TEASER}</div>
      <img data-url="/img/cover-32.jpg"><img data-src="https://cdn.example.com/a.png">
      </body></html>`
    expect(findContinuationUrls(html, PAGE_URL)).toEqual([])
  })
})

describe('付费墙自动解锁 — 接进抽取器', () => {
  it('隐藏节点解锁后 extractBody 直接给正文', () => {
    const result = extractBody(fixture('paywall-hidden-dom.html'), PAGE_URL)
    expect(result.ok).toBe(true)
    expect(result.unlockedBy).toBe('hiddenDom')
    expect(result.body).toContain('他数着那盏灯晃动的次数')
    expect(result.bodyRaw).toBe(result.body)
  })

  it('内嵌数据解锁后 extractPage 也认这是一章', () => {
    const page = extractPage(fixture('paywall-embedded-json.html'), PAGE_URL)
    expect(page.ok).toBe(true)
    expect(page.pageKind).toBe('chapter')
    expect(page.unlockedBy).toBe('embeddedJson')
    expect(page.body).toContain('长廊尽头传来钟声')
  })

  it('站点关掉自动解锁后仍按付费墙暂停', () => {
    const rule: SiteRule = { host: 'example.com', paywallUnlock: false }
    const result = extractBody(fixture('paywall-hidden-dom.html'), PAGE_URL, rule)
    expect(result.ok).toBe(false)
    expect(result.failCode).toBe('Paywall')
    expect(result.unlockedBy).toBeUndefined()
  })

  it('真墙（页面里没有正文）仍旧报付费墙', () => {
    const result = extractBody(fixture('paywall-vip.html'), 'https://example.com/book/3.html')
    expect(result.ok).toBe(false)
    expect(result.failCode).toBe('Paywall')
  })
})
