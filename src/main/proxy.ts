import type { ProxyMode, ProxyPrefs, ProxyProtocol } from '../shared/types'
import { DEFAULT_PROXY_PREFS } from '../shared/types'

/**
 * 内置浏览 / 下载的代理配置。
 *
 * 为什么放在应用里而不是让用户开系统代理：整机代理会把所有软件（含系统更新、
 * 其它应用）都绕出去，而用户通常只想让这个小说浏览器走那条线。这里只作用于
 * `persist:novel` 分区，浏览页与下载页共用同一条出口，行为一致。
 *
 * 实现走 Electron `session.setProxy`——即 Chromium 自己的代理栈，因此 http / https /
 * socks 的认证弹窗、PAC、bypass 语义都与浏览器一致，不用自己写隧道。
 */

const PROXY_PROTOCOLS: readonly ProxyProtocol[] = ['http', 'https', 'socks4', 'socks5']
const PROXY_MODES: readonly ProxyMode[] = ['off', 'system', 'manual']

const MAX_HOST_LENGTH = 255
const MAX_BYPASS_LENGTH = 2000

/** 判定「这台机器的代理地址是否合法」时不许出现协议前缀，避免拼出 `http://http://x`。 */
const HOST_PATTERN = /^[a-zA-Z0-9._-]+$|^\[[0-9a-fA-F:]+\]$/

export function isProxyProtocol(value: unknown): value is ProxyProtocol {
  return PROXY_PROTOCOLS.includes(value as ProxyProtocol)
}

export function isProxyMode(value: unknown): value is ProxyMode {
  return PROXY_MODES.includes(value as ProxyMode)
}

/**
 * 规范化代理配置。非法字段回退默认，不整份丢弃——
 * 用户只改错一个端口，不该把地址和 bypass 一起清空。
 */
export function normalizeProxyPrefs(value: unknown): ProxyPrefs {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    mode: isProxyMode(raw.mode) ? raw.mode : DEFAULT_PROXY_PREFS.mode,
    protocol: isProxyProtocol(raw.protocol) ? raw.protocol : DEFAULT_PROXY_PREFS.protocol,
    host: normalizeProxyHost(raw.host),
    port: normalizeProxyPort(raw.port),
    username: typeof raw.username === 'string' ? raw.username.trim().slice(0, 200) : '',
    passwordConfigured: raw.passwordConfigured === true,
    bypass: typeof raw.bypass === 'string' ? raw.bypass.trim().slice(0, MAX_BYPASS_LENGTH) : '',
  }
}

/** 主机名只留裸地址：用户常把 `http://127.0.0.1:7890` 整串粘进来。 */
export function normalizeProxyHost(value: unknown): string {
  if (typeof value !== 'string') return ''
  let host = value.trim()
  if (!host) return ''
  // 容忍粘贴整条 URL：剥掉协议与路径，只留 hostname
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname
    } catch {
      return ''
    }
  }
  // 去掉误粘的 user:pass@ 前缀
  const at = host.lastIndexOf('@')
  if (at >= 0) host = host.slice(at + 1)
  // 去掉误粘的端口
  if (!host.startsWith('[')) {
    const colon = host.lastIndexOf(':')
    if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon)
  }
  host = host.trim()
  if (!host || host.length > MAX_HOST_LENGTH) return ''
  return HOST_PATTERN.test(host) ? host : ''
}

export function normalizeProxyPort(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) return DEFAULT_PROXY_PREFS.port
  return n
}

/**
 * `manual` 模式是否配全了。
 *
 * 地址是空的、或者 host 规范化后丢了，都不算配好——否则 setProxy 会把整机
 * 的网络指到一个不存在的地方，用户会以为「整个软件都坏了」。
 */
export function isProxyConfigured(prefs: ProxyPrefs): boolean {
  if (prefs.mode !== 'manual') return true
  return prefs.host.trim().length > 0 && Number.isSafeInteger(prefs.port) && prefs.port >= 1 && prefs.port <= 65535
}

/**
 * 把偏好翻成 Chromium `setProxy` 的 `proxyRules`。
 *
 * - `off` 用 `direct://`，语义是「一律直连」，连系统代理也不走；
 * - `system` 返回空串，等于 Chromium 默认（跟随系统）；
 * - `manual` 拼 `<scheme>://<host>:<port>`，并按需附上 bypass 列表。
 *
 * 注意 Chromium 的 `socks5://` 会同时代理 DNS（远端解析）。对需要代理才能访问的站，
 * 这正是我们要的：本地 DNS 已经被污染，必须让代理侧去解析。
 */
export function buildProxyRules(prefs: ProxyPrefs): string {
  if (prefs.mode === 'off') return 'direct://'
  if (prefs.mode === 'system') return ''
  return `${prefs.protocol}://${prefs.host}:${prefs.port}`
}

/**
 * bypass 列表。Chromium 要的是英文逗号分隔、不带空格的单个字符串；
 * 用户更容易按「每行一条」来写，这里两种分隔都认。
 */
export function buildProxyBypassList(bypass: string): string {
  const parts = (bypass ?? '')
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  // Chromium 里 `<local>` 表示所有无点主机名（内网短名），是跳过代理的常用默认
  return ['<local>', ...parts].join(',')
}

/** 给界面看的「当前生效出口」一句话。 */
export function describeProxy(prefs: ProxyPrefs): string {
  if (prefs.mode === 'off') return '直连（不走代理）'
  if (prefs.mode === 'system') return '跟随系统代理'
  if (!isProxyConfigured(prefs)) return '代理地址未填完整'
  const auth = prefs.username ? '（已带认证）' : ''
  return `${prefs.protocol}://${prefs.host}:${prefs.port}${auth}`
}

export interface ProxyApplyResult {
  ok: boolean
  message?: string
}

export interface ProxySessionLike {
  setProxy(config: {
    mode: 'direct' | 'system' | 'fixed_servers'
    proxyRules?: string
    proxyBypassRules?: string
  }): Promise<void>
  closeAllConnections?(): Promise<void>
}

/**
 * 应用代理到会话。
 *
 * 改完必须断开已在途的连接：Chromium 的 setProxy 只影响**之后**建立的连接，
 * 已经连着的老连接会继续走原来的出口。用户改完设置却发现「还是要开系统代理」，
 * 十有八九就是没断旧连接。
 */
export async function applyProxyToSession(
  ses: ProxySessionLike,
  prefs: ProxyPrefs,
): Promise<ProxyApplyResult> {
  if (!isProxyConfigured(prefs)) {
    return { ok: false, message: '代理地址没填完整，已保持原设置不变' }
  }

  const mode = prefs.mode === 'off' ? 'direct' : prefs.mode === 'system' ? 'system' : 'fixed_servers'
  const config: { mode: 'direct' | 'system' | 'fixed_servers'; proxyRules?: string; proxyBypassRules?: string } = { mode }
  if (mode === 'fixed_servers') {
    config.proxyRules = buildProxyRules(prefs)
    config.proxyBypassRules = buildProxyBypassList(prefs.bypass)
  }
  await ses.setProxy(config)
  // 旧连接还挂在原出口上，必须断掉才会真正生效。
  try {
    await ses.closeAllConnections?.()
  } catch {
    /* 断连失败不影响新连接走新代理 */
  }
  return { ok: true }
}

/**
 * 代理是否让「需要它的站」真的能通。
 *
 * 判定只认一件事：目标地址是否返回了 HTTP 响应。挑战页、403、404 都算通——
 * 那证明 TCP + TLS + DNS 都过了，剩下的属于站点自己的策略，不是代理的问题。
 */
export function judgeProxyProbe(result: { ok: boolean; status?: number; error?: string }): {
  ok: boolean
  message: string
} {
  if (result.ok && typeof result.status === 'number') {
    return { ok: true, message: `代理可用（目标返回 HTTP ${result.status}）` }
  }
  const reason = result.error ? `：${result.error}` : ''
  return { ok: false, message: `代理没通${reason}` }
}
