import { describe, expect, it } from 'vitest'
import {
  CHALLENGE_COOKIE_NAME,
  CHALLENGE_MAX_RELOAD,
  CHALLENGE_POLL_BUDGET_MS,
  CHALLENGE_POLL_INTERVAL_MS,
  detectChallengePage,
  waitForChallengeClearance,
} from './challengePage'

/** 真实站点（www.uaa001.com）被 CF 拦住时拿到的挑战页骨架，取自实测。 */
const CLOUDFLARE_CHALLENGE_HTML = `<!DOCTYPE html><html lang="zh"><head>
<title>请稍候…</title>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=abc123"></script>
<script src="https://challenges.cloudflare.com/turnstile/v0/b/d0d7f3571048/api.js?onload=x&render=explicit"></script>
</head><body>
<div id="challenge-stage"><div class="cb-c"><div class="cb-i">正在进行安全验证</div></div></div>
<p>本网站使用安全服务防护恶意自动程序。在验证您不是自动程序期间，将显示此页面。</p>
<p>Ray ID: a542577c8bbd02b2</p>
</body></html>`

/** 正常内容页：正文够长，不该被判成挑战页。 */
const NORMAL_PAGE_HTML = `<!DOCTYPE html><html><head><title>第1章 调教温家赘婿</title></head><body>
<article>${'李斌沮丧的取下眼镜丢在桌子上。从口袋里摸出一包软白沙抽出一根，用打火机点上。'.repeat(60)}</article>
<a href="/novel/chapter?id=132039">第1章</a>
</body></html>`

describe('detectChallengePage：识别站点验证挑战页', () => {
  it('Cloudflare 挑战脚本是最硬信号，命中', () => {
    const verdict = detectChallengePage(CLOUDFLARE_CHALLENGE_HTML)
    expect(verdict.challenge).toBe(true)
    expect(verdict.reason).toBe('script:challenges.cloudflare.com')
  })

  it('只引 cdn-cgi 挑战脚本也认（CF 换域名时仍能命中）', () => {
    const html = '<html><head><title>x</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/x.js"></script></body></html>'
    expect(detectChallengePage(html).reason).toBe('script:cdn-cgi/challenge-platform')
  })

  it('无挑战脚本时，靠标题特征识别短页面', () => {
    const html = '<html><head><title>Just a moment...</title></head><body><p>等待中</p></body></html>'
    const verdict = detectChallengePage(html)
    expect(verdict.challenge).toBe(true)
    expect(verdict.reason).toBe('title:just a moment')
  })

  it('无挑战脚本时，靠正文话术识别短页面', () => {
    const html = '<html><head><title>提示</title></head><body><p>正在验证您是否是真人</p></body></html>'
    expect(detectChallengePage(html).challenge).toBe(true)
  })

  it('中文「安全验证」标题不算挑战页（站点拦截残页也用它，误判会白等一次重载）', () => {
    const html = `<html><head><title>安全验证</title></head><body>
      <div>请完成人机验证。检测到异常访问。点击按钮继续。Cloudflare Access Denied。
      这段文字不是小说正文，而是拦截提示页上的说明，用来把有效字数堆过八十字门槛。</div></body></html>`
    expect(detectChallengePage(html).challenge).toBe(false)
  })

  it('正常长正文页不判成挑战页', () => {
    expect(detectChallengePage(NORMAL_PAGE_HTML).challenge).toBe(false)
  })

  it('正文够长的页面即使出现挑战话术也不算（技术博客 / 免责声明不该被误伤）', () => {
    const html = `<html><head><title>如何在 Cloudflare 后面抓页面</title></head><body>
      <article>${'本文讨论 Cloudflare 的工作原理与绕过思路，正文很长。'.repeat(80)}
      <p>Cloudflare 会返回 Just a moment...</p></article></body></html>`
    expect(detectChallengePage(html).challenge).toBe(false)
  })

  it('空白 HTML 不当挑战页（导航失败走别的分支）', () => {
    expect(detectChallengePage('').challenge).toBe(false)
    expect(detectChallengePage('   ').challenge).toBe(false)
  })

  it('script 里的挑战关键字不影响正文长度判定（剥掉 script 再量）', () => {
    const html = `<html><head><title>正常</title></head><body>
      <script>var t = '正在进行安全验证';</script>
      <article>${'真实正文内容。'.repeat(400)}</article></body></html>`
    expect(detectChallengePage(html).challenge).toBe(false)
  })
})

describe('挑战重试参数', () => {
  it('只重载一次，避免对判死的站反复撞', () => {
    expect(CHALLENGE_MAX_RELOAD).toBe(1)
  })

  it('放行 cookie 名字是 cf_clearance（CF 的唯一可靠信号）', () => {
    expect(CHALLENGE_COOKIE_NAME).toBe('cf_clearance')
  })

  it('预算覆盖实测的 11 秒放行时间', () => {
    expect(CHALLENGE_POLL_BUDGET_MS).toBeGreaterThanOrEqual(15000)
    expect(CHALLENGE_POLL_BUDGET_MS).toBeLessThanOrEqual(60000)
  })

  it('轮询间隔足够密，不至于放过 cookie', () => {
    expect(CHALLENGE_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(500)
    expect(CHALLENGE_POLL_INTERVAL_MS).toBeLessThanOrEqual(3000)
  })
})

describe('waitForChallengeClearance：等 CF 放行', () => {
  /** 假时钟：wait 推进时间但不真睡，让预算判定可测。 */
  function fakeClock(startMs = 0) {
    let now = startMs
    return {
      now: () => now,
      async wait(ms: number) { now += ms },
    }
  }

  it('cookie 一开始就在，立刻返回 true（已放行的会话不用白等）', async () => {
    const waits: number[] = []
    const ok = await waitForChallengeClearance({
      hasClearance: async () => true,
      wait: async (ms) => { waits.push(ms) },
    })
    expect(ok).toBe(true)
    expect(waits).toEqual([])
  })

  it('cookie 第 3 次轮询才出现，返回 true（模拟实测的十来秒）', async () => {
    let polls = 0
    const clock = fakeClock()
    const ok = await waitForChallengeClearance({
      hasClearance: async () => ++polls >= 3,
      wait: clock.wait,
      now: clock.now,
      budgetMs: 20000,
      intervalMs: 1000,
    })
    expect(ok).toBe(true)
    expect(polls).toBe(3)
  })

  it('一直不出现时按预算耗尽返回 false，不会无限等', async () => {
    let polls = 0
    const clock = fakeClock()
    const ok = await waitForChallengeClearance({
      hasClearance: async () => { polls++; return false },
      wait: clock.wait,
      now: clock.now,
      budgetMs: 5000,
      intervalMs: 1000,
    })
    expect(ok).toBe(false)
    // 5 秒预算 / 1 秒间隔 → 5 次左右，不该爆炸
    expect(polls).toBeLessThanOrEqual(6)
    expect(polls).toBeGreaterThanOrEqual(4)
  })

  it('读 cookie 抛错时继续等，而不是把下载打断', async () => {
    let polls = 0
    const clock = fakeClock()
    const ok = await waitForChallengeClearance({
      hasClearance: async () => { polls++; if (polls === 1) throw new Error('cookie store 忙'); return polls >= 3 },
      wait: clock.wait,
      now: clock.now,
      budgetMs: 20000,
      intervalMs: 1000,
    })
    expect(ok).toBe(true)
    expect(polls).toBe(3)
  })
})
