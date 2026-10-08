import { describe, expect, it } from 'vitest'
import {
  classifyHttpStatus,
  mainFrameRetryAfter,
  mainFrameStatus,
  observeHttpStatus,
  parseRetryAfter,
  resetHttpStatusObservationForTests,
  setMainFrameStatusForTests,
} from './httpStatus'

describe('HTTP 状态码分类', () => {
  it('放行 2xx 与 3xx：重定向由 Chromium 处理，最终页仍是正文', () => {
    for (const status of [undefined, 200, 204, 301, 302, 399]) {
      expect(classifyHttpStatus(status)).toEqual({ action: 'ok' })
    }
  })

  it('429 与 503 是限流：退避后按 RateLimited 重试，其余 5xx 仍是导航失败', () => {
    expect(classifyHttpStatus(429)).toEqual({ action: 'throttle', code: 'RateLimited', backoffMs: 30_000 })
    expect(classifyHttpStatus(503)).toEqual({ action: 'throttle', code: 'RateLimited', backoffMs: 30_000 })
    expect(classifyHttpStatus(500)).toEqual({ action: 'throttle', code: 'NavFailed', backoffMs: 5_000 })
    expect(classifyHttpStatus(429, { testing: true })).toMatchObject({ backoffMs: 0 })
  })

  it('站点给了 Retry-After 就用它，不给才用默认退避', () => {
    expect(classifyHttpStatus(429, { retryAfterMs: 8_000 })).toEqual({
      action: 'throttle',
      code: 'RateLimited',
      backoffMs: 8_000,
    })
    expect(classifyHttpStatus(503, { retryAfterMs: 0 })).toEqual({
      action: 'throttle',
      code: 'RateLimited',
      backoffMs: 0,
    })
    // testing 缩放仍然生效：用例里不许真的睡
    expect(classifyHttpStatus(429, { retryAfterMs: 8_000, testing: true })).toMatchObject({ backoffMs: 0 })
  })

  it('把收费与权限状态码分到对应失败码', () => {
    expect(classifyHttpStatus(402)).toEqual({ action: 'fail', code: 'Paywall' })
    expect(classifyHttpStatus(401)).toEqual({ action: 'fail', code: 'Intercepted' })
    expect(classifyHttpStatus(403)).toEqual({ action: 'fail', code: 'Intercepted' })
    expect(classifyHttpStatus(451)).toEqual({ action: 'fail', code: 'Intercepted' })
    expect(classifyHttpStatus(404)).toEqual({ action: 'fail', code: 'NavFailed' })
    expect(classifyHttpStatus(410)).toEqual({ action: 'fail', code: 'NavFailed' })
  })
})

describe('Retry-After 解析', () => {
  const now = 1_700_000_000_000

  it('延迟秒数按毫秒取，负数按 0', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000)
    expect(parseRetryAfter(' 7 ', now)).toBe(7_000)
    expect(parseRetryAfter('0', now)).toBe(0)
    expect(parseRetryAfter('-5', now)).toBe(0)
  })

  it('HTTP-date 取与当前时间的差，已过期的按 0', () => {
    expect(parseRetryAfter(new Date(now + 15_000).toUTCString(), now)).toBe(15_000)
    expect(parseRetryAfter(new Date(now - 60_000).toUTCString(), now)).toBe(0)
  })

  it('超过 120 秒的要求截断，不能让下载钉死一小时', () => {
    expect(parseRetryAfter('3600', now)).toBe(120_000)
    expect(parseRetryAfter(new Date(now + 3_600_000).toUTCString(), now)).toBe(120_000)
  })

  it('缺失与无法识别的值返回 undefined，交给默认退避', () => {
    expect(parseRetryAfter(undefined, now)).toBeUndefined()
    expect(parseRetryAfter('', now)).toBeUndefined()
    expect(parseRetryAfter('tomorrow maybe', now)).toBeUndefined()
    expect(parseRetryAfter('1.5', now)).toBeUndefined()
  })
})

describe('主框架状态码观察', () => {
  it('只记主框架，并按规范化地址查询', () => {
    resetHttpStatusObservationForTests()
    let listener: ((details: { url: string; statusCode: number }) => void) | undefined
    observeHttpStatus({
      webRequest: {
        onCompleted: (_filters: unknown, cb: typeof listener) => {
          listener = cb
        },
      },
    } as unknown as Electron.Session)

    listener?.({ url: 'https://e.com/book/1.html', statusCode: 429 })
    expect(mainFrameStatus('https://e.com/book/1.html#frag')).toBe(429)
    expect(mainFrameStatus('https://e.com/book/1.html/')).toBe(429)
    expect(mainFrameStatus('https://e.com/book/2.html')).toBeUndefined()
    // 非法地址不能把观察器打断
    expect(() => listener?.({ url: 'not a url', statusCode: 500 })).not.toThrow()
    resetHttpStatusObservationForTests()
  })

  it('从响应头记下 Retry-After，头名大小写不定也能取到', () => {
    resetHttpStatusObservationForTests()
    let started:
      | ((details: { url: string; responseHeaders?: Record<string, string[]> }) => void)
      | undefined
    observeHttpStatus({
      webRequest: {
        onCompleted: () => {},
        onResponseStarted: (_filters: unknown, cb: typeof started) => {
          started = cb
        },
      },
    } as unknown as Electron.Session)

    started?.({ url: 'https://e.com/book/9.html', responseHeaders: { 'Retry-After': ['45'] } })
    expect(mainFrameRetryAfter('https://e.com/book/9.html#x')).toBe(45_000)
    started?.({ url: 'https://e.com/book/9.html', responseHeaders: { 'retry-after': ['2'] } })
    expect(mainFrameRetryAfter('https://e.com/book/9.html')).toBe(2_000)
    // 没带该头的地址不能被编出退避时长
    expect(mainFrameRetryAfter('https://e.com/book/8.html')).toBeUndefined()
    // 非法地址同样不打断观察器
    expect(() => started?.({ url: 'not a url', responseHeaders: { 'Retry-After': ['5'] } })).not.toThrow()
    resetHttpStatusObservationForTests()
  })

  it('测试注入可写可撤', () => {
    resetHttpStatusObservationForTests()
    setMainFrameStatusForTests('https://e.com/c/1.html', 403)
    expect(mainFrameStatus('https://e.com/c/1.html')).toBe(403)
    setMainFrameStatusForTests('https://e.com/c/1.html', undefined)
    expect(mainFrameStatus('https://e.com/c/1.html')).toBeUndefined()
  })

  it('测试注入可以带上 Retry-After 提示，撤销时一起清掉', () => {
    resetHttpStatusObservationForTests()
    setMainFrameStatusForTests('https://e.com/c/2.html', 429, 3_000)
    expect(classifyHttpStatus(mainFrameStatus('https://e.com/c/2.html'), { retryAfterMs: mainFrameRetryAfter('https://e.com/c/2.html') })).toEqual({
      action: 'throttle',
      code: 'RateLimited',
      backoffMs: 3_000,
    })
    setMainFrameStatusForTests('https://e.com/c/2.html', undefined)
    expect(mainFrameRetryAfter('https://e.com/c/2.html')).toBeUndefined()
  })

  it('没有 webRequest 的会话直接跳过，不抛错', () => {
    resetHttpStatusObservationForTests()
    expect(() => observeHttpStatus(undefined)).not.toThrow()
    expect(() => observeHttpStatus({} as Electron.Session)).not.toThrow()
  })

  it('只有 onCompleted 的旧会话也能装观察器，不因缺 onResponseStarted 抛错', () => {
    resetHttpStatusObservationForTests()
    expect(() =>
      observeHttpStatus({
        webRequest: { onCompleted: () => {} },
      } as unknown as Electron.Session),
    ).not.toThrow()
    resetHttpStatusObservationForTests()
  })
})
