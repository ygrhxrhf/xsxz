/**
 * 下载时读取 HTTP 状态码。
 *
 * webContents.loadURL 只告诉我们「导航结束了」，不返回状态码；
 * 429 / 403 / 503 的 HTML 看起来也是「一页文字」，会被当成正文存下来。
 * 这里用 webRequest 观察主框架状态码和 Retry-After，给下载循环一个明确结论。
 */
import type { FailCode } from '../shared/types'
import { canonicalizeUrl } from '../shared/urlHash'

export type HttpStatusVerdict =
  | { action: 'ok' }
  | { action: 'throttle'; code: FailCode; backoffMs: number }
  | { action: 'fail'; code: FailCode }

const RATE_LIMIT_BACKOFF_MS = 30_000
const SERVER_ERROR_BACKOFF_MS = 5_000
const MAX_TRACKED_URLS = 512
/** 站点可以要求等很久，但下载循环不能被钉死：再多也只等这么长。 */
const RETRY_AFTER_MAX_MS = 120_000

/** 状态码 → 结论。未知（没观察到）一律放行，不能因为观察不到就卡住下载。 */
export function classifyHttpStatus(
  status: number | undefined,
  opts?: { testing?: boolean; retryAfterMs?: number },
): HttpStatusVerdict {
  if (status === undefined || status < 400) return { action: 'ok' }
  const scale = opts?.testing ? 0 : 1
  if (status === 429 || status === 503) {
    const backoff = opts?.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS
    return { action: 'throttle', code: 'RateLimited', backoffMs: backoff * scale }
  }
  if (status >= 500) return { action: 'throttle', code: 'NavFailed', backoffMs: SERVER_ERROR_BACKOFF_MS * scale }
  if (status === 402) return { action: 'fail', code: 'Paywall' }
  if (status === 401 || status === 403) return { action: 'fail', code: 'Intercepted' }
  if (status === 404 || status === 410) return { action: 'fail', code: 'NavFailed' }
  return { action: 'fail', code: 'Intercepted' }
}

/**
 * Retry-After 的两种写法：延迟秒数或 HTTP-date。
 * 负数与已过期的时间点按 0；超过上限截断；认不出来时返回 undefined，让调用方用默认退避。
 */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  if (/^-?\d+$/.test(raw)) {
    return clampRetryAfter(Number(raw) * 1000)
  }
  // 只按 HTTP-date 认带年份的值：Date.parse 会把「1.5」这类畸形值解成过去时间，
  // 变成 0 退避反而让下载对已被限流的站零间隔硬撞。
  if (!/\d{4}/.test(raw)) return undefined
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  return clampRetryAfter(at - nowMs)
}

function clampRetryAfter(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.min(ms, RETRY_AFTER_MAX_MS)
}

export class HttpStatusError extends Error {
  constructor(
    readonly code: FailCode,
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'HttpStatusError'
  }
}

const statusByUrl = new Map<string, number>()
const retryAfterByUrl = new Map<string, number>()
let observerInstalled = false

function statusKey(url: string): string {
  try {
    return canonicalizeUrl(url)
  } catch {
    return url.split('#')[0] ?? url
  }
}

/** 两张表同进同退，超容量时按插入顺序淘汰，避免只清一半导致状态错配。 */
function track(key: string, value: Map<string, number>, next?: number): void {
  if (next === undefined) {
    value.delete(key)
    return
  }
  if (value.size >= MAX_TRACKED_URLS && !value.has(key)) {
    const oldest = value.keys().next().value
    if (oldest !== undefined) value.delete(oldest)
  }
  value.set(key, next)
}

function record(url: string, status: number): void {
  if (!url || status <= 0) return
  track(statusKey(url), statusByUrl, status)
}

function recordRetryAfter(url: string, headers?: Record<string, string[]>): void {
  if (!url || !headers) return
  const key = statusKey(url)
  // Chromium 把响应头按原名交回来，Retry-After / retry-after 都得认。
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')
  const ms = parseRetryAfter(entry?.[1]?.[0], Date.now())
  track(key, retryAfterByUrl, ms)
}

/** 只观察、不拦截；同一分区上的浏览页也会经过这里。 */
export function observeHttpStatus(ses: Electron.Session | undefined): void {
  const webRequest = ses?.webRequest
  if (!webRequest?.onCompleted || observerInstalled) return
  observerInstalled = true
  try {
    webRequest.onCompleted({ urls: ['<all_urls>'], types: ['mainFrame'] }, (details) =>
      record(details.url, details.statusCode),
    )
    // 状态码在 onCompleted 才有，但响应头只在 onResponseStarted 暴露。
    webRequest.onResponseStarted?.({ urls: ['<all_urls>'], types: ['mainFrame'] }, (details) =>
      recordRetryAfter(details.url, details.responseHeaders as Record<string, string[]> | undefined),
    )
  } catch {
    observerInstalled = false
  }
}

export function mainFrameStatus(url: string): number | undefined {
  return statusByUrl.get(statusKey(url))
}

export function mainFrameRetryAfter(url: string): number | undefined {
  return retryAfterByUrl.get(statusKey(url))
}

/** 测试用：直接登记某地址的主框架状态码与 Retry-After，传 undefined 撤销。 */
export function setMainFrameStatusForTests(
  url: string,
  status: number | undefined,
  retryAfterMs?: number,
): void {
  const key = statusKey(url)
  if (status === undefined) {
    statusByUrl.delete(key)
    retryAfterByUrl.delete(key)
    return
  }
  track(key, statusByUrl, status)
  track(key, retryAfterByUrl, retryAfterMs)
}

/** 测试与隔离用：清空观察结果，避免用例间串状态。 */
export function resetHttpStatusObservationForTests(): void {
  statusByUrl.clear()
  retryAfterByUrl.clear()
  observerInstalled = false
}
