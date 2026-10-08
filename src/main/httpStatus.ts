/**
 * 下载时读取 HTTP 状态码。
 *
 * webContents.loadURL 只告诉我们「导航结束了」，不返回状态码；
 * 429 / 403 / 503 的 HTML 看起来也是「一页文字」，会被当成正文存下来。
 * 这里用 webRequest 观察主框架状态码，给下载循环一个明确结论。
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

/** 状态码 → 结论。未知（没观察到）一律放行，不能因为观察不到就卡住下载。 */
export function classifyHttpStatus(
  status: number | undefined,
  opts?: { testing?: boolean },
): HttpStatusVerdict {
  if (status === undefined || status < 400) return { action: 'ok' }
  const scale = opts?.testing ? 0 : 1
  if (status === 429) return { action: 'throttle', code: 'NavFailed', backoffMs: RATE_LIMIT_BACKOFF_MS * scale }
  if (status >= 500) return { action: 'throttle', code: 'NavFailed', backoffMs: SERVER_ERROR_BACKOFF_MS * scale }
  if (status === 402) return { action: 'fail', code: 'Paywall' }
  if (status === 401 || status === 403) return { action: 'fail', code: 'Intercepted' }
  if (status === 404 || status === 410) return { action: 'fail', code: 'NavFailed' }
  return { action: 'fail', code: 'Intercepted' }
}

export class HttpStatusError extends Error {
  constructor(
    readonly code: FailCode,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpStatusError'
  }
}

const statusByUrl = new Map<string, number>()
let observerInstalled = false

function statusKey(url: string): string {
  try {
    return canonicalizeUrl(url)
  } catch {
    return url.split('#')[0] ?? url
  }
}

function record(url: string, status: number): void {
  if (!url || status <= 0) return
  if (statusByUrl.size >= MAX_TRACKED_URLS) statusByUrl.delete(statusByUrl.keys().next().value as string)
  statusByUrl.set(statusKey(url), status)
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
  } catch {
    observerInstalled = false
  }
}

export function mainFrameStatus(url: string): number | undefined {
  return statusByUrl.get(statusKey(url))
}

/** 测试用：直接登记某地址的主框架状态码，传 undefined 撤销。 */
export function setMainFrameStatusForTests(url: string, status: number | undefined): void {
  const key = statusKey(url)
  if (status === undefined) statusByUrl.delete(key)
  else statusByUrl.set(key, status)
}

/** 测试与隔离用：清空观察结果，避免用例间串状态。 */
export function resetHttpStatusObservationForTests(): void {
  statusByUrl.clear()
  observerInstalled = false
}
