import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { browserAdCss } from './browserAds'

describe('browserAdCss', () => {
  it('hides explicit ad containers by default without hiding login dialogs or chapter content', () => {
    const css = browserAdCss()
    expect(css).toContain('ins.adsbygoogle { display: none !important; }')
    expect(css).toContain('[class~="ad-overlay"] { display: none !important; }')
    expect(css).not.toMatch(/(?:login|chapter|content|modal)/i)
  })

  it('supports per-site opt-out and isolated custom selectors', () => {
    expect(browserAdCss({ host: 'example.com', adFilterEnabled: false, adHideSelectors: '.promo' })).toBe('')
    const css = browserAdCss({ host: 'example.com', adHideSelectors: '.promo\nbody\n.bad { color:red }\n#floating-ad' })
    expect(css).toContain('.promo { display: none !important; }')
    expect(css).toContain('#floating-ad { display: none !important; }')
    expect(css).not.toContain('body {')
    expect(css).not.toContain('.bad {')
  })

  it('hides an ad added after load while leaving a login dialog visible, and reverses on removal', () => {
    const dom = new JSDOM('<html><head></head><body><div class="login-dialog">登录</div></body></html>')
    const style = dom.window.document.createElement('style')
    style.textContent = browserAdCss()
    dom.window.document.head.append(style)
    const ad = dom.window.document.createElement('div')
    ad.className = 'ad-overlay'
    dom.window.document.body.append(ad)
    expect(dom.window.getComputedStyle(ad).display).toBe('none')
    expect(dom.window.getComputedStyle(dom.window.document.querySelector('.login-dialog')!).display).not.toBe('none')
    style.remove()
    expect(dom.window.getComputedStyle(ad).display).not.toBe('none')
  })
})
