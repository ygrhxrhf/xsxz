import type { ProxyAutoUpdatePrefs, ProxySubscriptionState } from '../shared/types'
import { parseSubscription } from './subscription'
import { probeNodes, summarizeSpeedTest, tcpProbeLatency, type LatencyProbe } from './proxySpeed'

/**
 * 代理订阅域的 IPC 注册。
 *
 * 四个频道：读自动更新状态、设自动更新、立刻重拉订阅、多节点测速。
 * 频道名、请求与响应形状必须与 `src/preload/index.ts` 和
 * `docs/ipc-contract.md` 逐字一致。
 *
 * 依赖全部从 `deps` 注入：主进程接线的人决定「偏好存在哪」「订阅正文缓存在哪」
 * 「测速用哪种探测」，这里只负责把频道与业务对上。
 */

/** 主进程 IPC 注册器：把 core 模块和 Electron 解耦，测试里可传入假实现。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 与 ipcMain.handle 的 ...args: any[] 对齐
type IpcRegistrar = (channel: string, listener: (...args: any[]) => unknown) => void

interface ProxyAutoUpdateService {
  readPrefs(): Promise<ProxyAutoUpdatePrefs>
  setPrefs(patch: { enabled?: boolean; intervalMinutes?: number }): Promise<ProxyAutoUpdatePrefs>
  refresh(): Promise<{ ok: boolean; message?: string; body?: string }>
}

interface ProxyIpcDeps {
  /** 订阅自动更新服务。 */
  autoUpdate: ProxyAutoUpdateService
  /** 取当前缓存的订阅正文；测速与概览都从它解析。 */
  getCachedBody(): string
  /** 测速用的探测实现；不传则用 TCP 握手计时。 */
  probe?: LatencyProbe
}

/** 订阅正文 → 概览（与 `proxyRuntime.describeSubscription` 同形）。 */
function describeSubscriptionBody(body: string): ProxySubscriptionState {
  const parsed = parseSubscription(body)
  const byProtocol: Record<string, number> = {}
  for (const node of parsed.nodes) byProtocol[node.protocol] = (byProtocol[node.protocol] ?? 0) + 1
  return {
    total: parsed.nodes.length,
    skipped: parsed.skipped,
    byProtocol,
    nodes: parsed.nodes.map((node) => ({ name: node.name, protocol: node.protocol })),
  }
}

/**
 * 注册代理订阅的四个频道。
 *
 * 「重拉」与「测速」都**不切换当前节点**：换节点要重启内核，会掐断在途下载，
 * 所以这两件事只提供信息，动手仍然由本人来。
 */
export function registerProxyIpc(register: IpcRegistrar, deps: ProxyIpcDeps): void {
  const { autoUpdate, getCachedBody } = deps

  register('proxy.autoUpdateState', async () => {
    // 读偏好失败不该让界面炸掉：退成一份默认偏好，界面照样能用。
    try {
      return { ok: true, prefs: await autoUpdate.readPrefs() }
    } catch {
      return { ok: true, prefs: { enabled: false, intervalMinutes: 60, lastUpdatedAt: '', lastError: '' } }
    }
  })

  register(
    'proxy.setAutoUpdate',
    async (_e, payload: { enabled?: boolean; intervalMinutes?: number } | undefined) => {
      if (payload !== undefined && (payload === null || typeof payload !== 'object')) {
        return { ok: false, message: '自动更新参数无效' }
      }
      if (payload?.enabled !== undefined && typeof payload.enabled !== 'boolean') {
        return { ok: false, message: '自动更新开关必须是布尔值' }
      }
      if (payload?.intervalMinutes !== undefined && typeof payload.intervalMinutes !== 'number') {
        return { ok: false, message: '重拉间隔必须是数字（分钟）' }
      }
      try {
        const prefs = await autoUpdate.setPrefs({
          enabled: payload?.enabled,
          intervalMinutes: payload?.intervalMinutes,
        })
        return { ok: true, prefs }
      } catch (error) {
        return {
          ok: false,
          message: `保存订阅自动更新设置失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  )

  register('proxy.refreshSubscription', async () => {
    const result = await autoUpdate.refresh()
    if (!result.ok) {
      return { ok: false, message: result.message ?? '订阅重拉失败' }
    }
    const body = result.body ?? getCachedBody()
    const overview = describeSubscriptionBody(body)
    if (overview.total === 0) {
      return {
        ok: false,
        message: `订阅里没有可用的节点${overview.skipped ? `（跳过 ${overview.skipped} 条）` : ''}`,
      }
    }
    const prefs = await autoUpdate.readPrefs()
    return { ok: true, overview, prefs }
  })

  register('proxy.speedTest', async () => {
    const body = getCachedBody()
    if (!body.trim()) return { ok: false, message: '还没有可测速的订阅，请先连接订阅' }
    const parsed = parseSubscription(body)
    if (parsed.nodes.length === 0) return { ok: false, message: '订阅里没有可测速的节点' }
    const probe = deps.probe ?? ((node) => tcpProbeLatency(node))
    const nodes = await probeNodes(
      parsed.nodes.map((node) => ({
        name: node.name,
        protocol: node.protocol,
        server: node.server,
        port: node.port,
      })),
      probe,
    )
    return { ok: true, result: summarizeSpeedTest(nodes) }
  })
}
