import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProxyAutoUpdatePrefs } from '../shared/types'

/**
 * 订阅的定时重拉。
 *
 * 这里只做一件事：**定期把订阅正文重新拉一遍**，让节点列表保持新鲜。
 *
 * 刻意不做的事：**不自动换节点**。换节点要重启内置内核，而重启会把正在进行的
 * 下载掐断（内核端口一换，在途连接全断）。所以自动更新只更新「有哪些节点」，
 * 换成哪个节点仍然由本人点——这一点是设计上的取舍，不是没做完。
 *
 * 状态（开关 / 间隔 / 上次成功时间 / 上次失败原因）落在主进程自己的目录里，
 * 目录、时钟、fetch、订阅地址都从 deps 注入，单元测试不必联网也不必碰磁盘。
 */

/** 间隔下限（分钟）：一分钟一次已经是最勤的了。 */
const MIN_INTERVAL_MINUTES = 1
/** 间隔上限（分钟）：一天一次。 */
const MAX_INTERVAL_MINUTES = 1440
/** 非法间隔的回退值：默认一小时一次。 */
export const DEFAULT_INTERVAL_MINUTES = 60

/** 状态文件名（放在注入的目录里）。 */
const PREFS_FILE = 'proxy-auto-update.json'

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/**
 * 间隔归一化到 1–1440 的整数分钟。
 *
 * 非法值（非数字、非整数、越界）一律回退到 60，而不是夹到边界：
 * 夹边界的语义是「用户想要更频繁/更稀疏」，而回退的语义是「这个输入我没看懂，
 * 给我一个稳妥的默认值」——后者才是输入非法时该做的。
 */
export function normalizeIntervalMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return DEFAULT_INTERVAL_MINUTES
  if (value < MIN_INTERVAL_MINUTES || value > MAX_INTERVAL_MINUTES) return DEFAULT_INTERVAL_MINUTES
  return value
}

/** 把任意来源（磁盘、IPC 入参）读成一份合法的偏好。 */
export function normalizeAutoUpdatePrefs(value: unknown): ProxyAutoUpdatePrefs {
  const raw = readRecord(value)
  return {
    enabled: raw.enabled === true,
    intervalMinutes: normalizeIntervalMinutes(raw.intervalMinutes),
    lastUpdatedAt: typeof raw.lastUpdatedAt === 'string' ? raw.lastUpdatedAt : '',
    lastError: typeof raw.lastError === 'string' ? raw.lastError : '',
  }
}

/**
 * 下次该重拉的时刻（ISO 字符串）。
 *
 * 基准是**上次成功**的时间；从没成功过就以现在为基准。关掉开关时没有下次，
 * 返回空串。
 */
export function computeNextRefreshAt(prefs: ProxyAutoUpdatePrefs, now: Date): string {
  if (!prefs.enabled) return ''
  const last = Date.parse(prefs.lastUpdatedAt)
  const base = Number.isFinite(last) ? last : now.getTime()
  return new Date(base + prefs.intervalMinutes * 60_000).toISOString()
}

/** 到期了吗：开着开关，且下次重拉时刻已经不晚于现在。 */
export function isAutoUpdateDue(prefs: ProxyAutoUpdatePrefs, now: Date): boolean {
  if (!prefs.enabled) return false
  const next = Date.parse(computeNextRefreshAt(prefs, now))
  if (!Number.isFinite(next)) return false
  return next <= now.getTime()
}

/** 主进程 net.fetch 的最小形状（避免把 electron 类型引进纯逻辑）。 */
type NetLike = {
  fetch: (
    url: string,
    init?: { headers?: Record<string, string> },
  ) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>
}

/**
 * 取 electron 的 net.fetch；单测环境里没有 electron，退回 Node 的 fetch。
 *
 * 走 net 而不是渲染层 fetch，是为了绕开 CORS：订阅接口大多不发 CORS 头。
 */
async function loadNetFetch(): Promise<((url: string) => Promise<string>) | null> {
  try {
    const mod = (await import('electron')) as unknown as { net?: NetLike }
    const net = mod.net
    if (net && typeof net.fetch === 'function') {
      return async (url: string) => {
        const res = await net.fetch!(url, { headers: { 'user-agent': 'spbf/0.1' } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.text()
      }
    }
  } catch {
    /* 没有 electron 运行时时用 Node 的 fetch */
  }
  return null
}

async function defaultFetch(url: string): Promise<string> {
  const net = await loadNetFetch()
  if (net) return net(url)
  const res = await globalThis.fetch(url, { headers: { 'user-agent': 'spbf/0.1' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

interface ProxyAutoUpdateDeps {
  /** 状态文件所在目录（主进程给 userData 下的子目录）。 */
  dir: string
  /** 读取已保存的订阅地址。 */
  readSubscriptionUrl: () => Promise<string> | string
  /** 拉订阅正文；失败请抛出异常，错误信息会写进 `lastError`。 */
  fetch?: (url: string) => Promise<string>
  /** 当前时间。 */
  now?: () => Date
  /**
   * 把新正文交给主进程缓存。
   *
   * 这个回调**只更新缓存的订阅正文**，不允许重启内核或切换节点——自动更新
   * 一旦换节点就会掐断在途下载。
   */
  applyBody?: (body: string) => void | Promise<void>
  /** 定时器注入点；测试可换成假实现。 */
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface ProxyAutoUpdateRefreshResult {
  ok: boolean
  /** 失败时的中文原因。 */
  message?: string
  /** 成功时拉到的订阅正文。 */
  body?: string
}

export interface ProxyAutoUpdateRuntime {
  /** 读偏好（永远不抛错，读不到就给默认值）。 */
  readPrefs(): Promise<ProxyAutoUpdatePrefs>
  /** 改偏好并落盘；间隔非法时按 60 回退。 */
  setPrefs(patch: { enabled?: boolean; intervalMinutes?: number }): Promise<ProxyAutoUpdatePrefs>
  /** 立刻重拉一次订阅正文（不换节点）。 */
  refresh(): Promise<ProxyAutoUpdateRefreshResult>
  /** 开始按间隔定时重拉。 */
  start(): Promise<void>
  /** 停止定时重拉。 */
  stop(): void
  /** 到期就跑一次；没到期什么都不做。返回是否真的重拉了。 */
  runDue(): Promise<boolean>
  /** 下次重拉时刻（ISO），关着开关时是空串。 */
  nextRefreshAt(): Promise<string>
}

/** 创建自动更新运行时。 */
export function createProxyAutoUpdate(deps: ProxyAutoUpdateDeps): ProxyAutoUpdateRuntime {
  const now = deps.now ?? (() => new Date())
  const setTimer = deps.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout))
  const file = join(deps.dir, PREFS_FILE)

  let prefs: ProxyAutoUpdatePrefs | null = null
  let timer: unknown = null

  async function loadPrefs(): Promise<ProxyAutoUpdatePrefs> {
    if (prefs) return prefs
    try {
      prefs = normalizeAutoUpdatePrefs(JSON.parse(await readFile(file, 'utf-8')))
    } catch {
      prefs = normalizeAutoUpdatePrefs(null)
    }
    return prefs
  }

  async function savePrefs(next: ProxyAutoUpdatePrefs): Promise<ProxyAutoUpdatePrefs> {
    prefs = next
    await mkdir(deps.dir, { recursive: true })
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
    return next
  }

  async function fail(current: ProxyAutoUpdatePrefs, message: string): Promise<ProxyAutoUpdateRefreshResult> {
    // 失败不清掉 lastUpdatedAt：那是「上次成功」的时间，失败不该篡改它。
    await savePrefs({ ...current, lastError: message })
    return { ok: false, message }
  }

  function reschedule(): void {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    const current = prefs
    if (!current || !current.enabled) return
    const next = Date.parse(computeNextRefreshAt(current, now()))
    if (!Number.isFinite(next)) return
    // 下限 1 秒：定时的最小粒度，再密也没有意义。
    const delay = Math.max(1000, next - now().getTime())
    timer = setTimer(() => {
      void runDue()
    }, delay)
  }

  async function refresh(): Promise<ProxyAutoUpdateRefreshResult> {
    const current = await loadPrefs()
    const url = String((await deps.readSubscriptionUrl()) ?? '').trim()
    if (!url) return fail(current, '还没有填写订阅地址')
    let body = ''
    try {
      body = await (deps.fetch ?? defaultFetch)(url)
    } catch (error) {
      return fail(current, `订阅拉取失败：${errorDetail(error)}`)
    }
    if (!body.trim()) return fail(current, '订阅内容为空')
    // 只更新正文缓存；不重启内核、不换节点。
    try {
      await deps.applyBody?.(body)
    } catch {
      /* 缓存更新失败不影响本次重拉的结果 */
    }
    await savePrefs({ ...current, lastUpdatedAt: now().toISOString(), lastError: '' })
    return { ok: true, body }
  }

  async function runDue(): Promise<boolean> {
    const current = await loadPrefs()
    if (!isAutoUpdateDue(current, now())) {
      reschedule()
      return false
    }
    const result = await refresh()
    reschedule()
    return result.ok
  }

  return {
    readPrefs: loadPrefs,
    async setPrefs(patch) {
      const current = await loadPrefs()
      const next: ProxyAutoUpdatePrefs = { ...current }
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
      if (patch.intervalMinutes !== undefined) next.intervalMinutes = normalizeIntervalMinutes(patch.intervalMinutes)
      const saved = await savePrefs(next)
      reschedule()
      return saved
    },
    refresh,
    async start() {
      await loadPrefs()
      reschedule()
    },
    stop() {
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
    },
    runDue,
    async nextRefreshAt() {
      const current = await loadPrefs()
      return computeNextRefreshAt(current, now())
    },
  }
}
