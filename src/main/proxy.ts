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
const PROXY_MODES: readonly ProxyMode[] = ['off', 'system', 'manual', 'subscription']

const MAX_HOST_LENGTH = 255
const MAX_BYPASS_LENGTH = 2000

/** 判定「这台机器的代理地址是否合法」时不许出现协议前缀，避免拼出 `http://http://x`。 */
const HOST_PATTERN = /^[a-zA-Z0-9._-]+$|^\[[0-9a-fA-F:]+\]$/

function isProxyProtocol(value: unknown): value is ProxyProtocol {
  return PROXY_PROTOCOLS.includes(value as ProxyProtocol)
}

function isProxyMode(value: unknown): value is ProxyMode {
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
    subscriptionUrl: normalizeSubscriptionUrl(raw.subscriptionUrl),
    subscriptionCached: raw.subscriptionCached === true,
    nodeIndex: normalizeNodeIndex(raw.nodeIndex),
  }
}

/**
 * 订阅地址只收 http(s)。订阅里含节点凭据，允许 `file://` 或裸路径等于让别人
 * 通过改 settings.json 读本机文件，没有正当用途。
 */
function normalizeSubscriptionUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.toString()
  } catch {
    return ''
  }
}

/** 节点序号：非负整数，非法回退 0（0 永远是安全的兜底）。 */
function normalizeNodeIndex(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
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
  if (prefs.mode === 'subscription') return normalizeSubscriptionUrl(prefs.subscriptionUrl).length > 0
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
  if (prefs.mode === 'subscription') {
    // 订阅模式由内核托管，实际端口在运行时才知道；这里只表达「应该走代理」。
    return ''
  }
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
  if (prefs.mode === 'subscription') {
    return prefs.subscriptionUrl ? '内置内核（订阅）' : '订阅地址未填'
  }
  if (!isProxyConfigured(prefs)) return '代理地址未填完整'
  const auth = prefs.username ? '（已带认证）' : ''
  return `${prefs.protocol}://${prefs.host}:${prefs.port}${auth}`
}

interface ProxyApplyResult {
  ok: boolean
  message?: string
}

interface ProxySessionLike {
  setProxy(config: {
    mode: 'direct' | 'system' | 'fixed_servers'
    proxyRules?: string
    proxyBypassRules?: string
  }): Promise<void>
  closeAllConnections?(): Promise<void>
}

/**
 * 换代理后、断旧连接前的等待时间。
 *
 * **为什么需要它**（实测 2026-11-03，Electron 43 / Chrome 150）：
 * 当代理指向一个**已经死掉**的本地进程（内核被 kill 了但配置还指着它）时，
 * 网络层积压着大量到死端口的连接。这时「改代理 + 立刻 closeAllConnections」
 * 会让 network service 崩掉（`Network service crashed or was terminated`），
 * 会话随即不可用——用户看到的是「整个软件的网络坏了」。
 *
 * 复现矩阵（起真 sing-box → kill 内核 → 三种收尾，各跑一次）：
 * - 只 close、不改代理：不崩
 * - 改 direct、不 close：不崩
 * - 改 direct + **立刻** close：崩 2 次
 *
 * 所以顺序是：先 setProxy，再等一小段让指向旧出口的连接自然失败，最后才断连。
 */
export const PROXY_SETTLE_BEFORE_CLOSE_MS = 300

interface ApplyProxyOptions {
  /** 覆盖默认等待；测试传 0 保持同步。 */
  settleMs?: number
  /** 等待实现，测试可注入。 */
  sleep?(ms: number): Promise<void>
}

/**
 * 应用代理到会话。
 *
 * 改完要断开已在途的连接：Chromium 的 setProxy 只影响**之后**建立的连接，
 * 已经连着的老连接会继续走原来的出口。用户改完设置却发现「还是要开系统代理」，
 * 十有八九就是没断旧连接。
 *
 * 但断得太急会把 network service 弄崩（见 `PROXY_SETTLE_BEFORE_CLOSE_MS`），
 * 所以中间插一段等待，并且断连失败不当作换代理失败——代理已经切过去了。
 */
export async function applyProxyToSession(
  ses: ProxySessionLike,
  prefs: ProxyPrefs,
  options: ApplyProxyOptions = {},
): Promise<ProxyApplyResult> {
  if (!isProxyConfigured(prefs)) {
    return { ok: false, message: '代理地址没填完整，已保持原设置不变' }
  }
  // 订阅模式由内核托管（proxyRuntime），这里不能直接 setProxy 到不存在的端口。
  if (prefs.mode === 'subscription') return { ok: true }

  const mode = prefs.mode === 'off' ? 'direct' : prefs.mode === 'system' ? 'system' : 'fixed_servers'
  const config: { mode: 'direct' | 'system' | 'fixed_servers'; proxyRules?: string; proxyBypassRules?: string } = { mode }
  if (mode === 'fixed_servers') {
    config.proxyRules = buildProxyRules(prefs)
    config.proxyBypassRules = buildProxyBypassList(prefs.bypass)
  }

  try {
    await ses.setProxy(config)
  } catch (e) {
    return { ok: false, message: `切换代理失败：${e instanceof Error ? e.message : String(e)}` }
  }

  if (ses.closeAllConnections) {
    const settle = options.settleMs ?? PROXY_SETTLE_BEFORE_CLOSE_MS
    if (settle > 0) {
      const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
      try {
        await sleep(settle)
      } catch {
        /* 等待被打断也继续；断连不是必须成功的步骤 */
      }
    }
    try {
      await ses.closeAllConnections()
    } catch {
      /* 断连失败不影响「代理已切换」这个结论：新连接会走新代理 */
    }
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
