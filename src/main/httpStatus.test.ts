import { describe, expect, it } from 'vitest'
import {
  classifyHttpStatus,
  mainFrameStatus,
  observeHttpStatus,
  resetHttpStatusObservationForTests,
  setMainFrameStatusForTests,
} from './httpStatus'

describe('HTTP 状态码分类', () => {
  it('放行 2xx 与 3xx：重定向由 Chromium 处理，最终页仍是正文', () => {
    for (const status of [undefined, 200, 204, 301, 302, 399]) {
      expect(classifyHttpStatus(status)).toEqual({ action: 'ok' })
    }
  })

  it('限流与服务端错误退避后按导航失败重试', () => {
    expect(classifyHttpStatus(429)).toEqual({ action: 'throttle', code: 'NavFailed', backoffMs: 30_000 })
    expect(classifyHttpStatus(503)).toEqual({ action: 'throttle', code: 'NavFailed', backoffMs: 5_000 })
    expect(classifyHttpStatus(429, { testing: true })).toMatchObject({ backoffMs: 0 })
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

  it('测试注入可写可撤', () => {
    resetHttpStatusObservationForTests()
    setMainFrameStatusForTests('https://e.com/c/1.html', 403)
    expect(mainFrameStatus('https://e.com/c/1.html')).toBe(403)
    setMainFrameStatusForTests('https://e.com/c/1.html', undefined)
    expect(mainFrameStatus('https://e.com/c/1.html')).toBeUndefined()
  })

  it('没有 webRequest 的会话直接跳过，不抛错', () => {
    resetHttpStatusObservationForTests()
    expect(() => observeHttpStatus(undefined)).not.toThrow()
    expect(() => observeHttpStatus({} as Electron.Session)).not.toThrow()
  })
})
