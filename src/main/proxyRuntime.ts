import { app, session } from 'electron'
import type { ProxyKernelState, ProxySubscriptionState } from '../shared/types'
import { parseSubscription, buildSingBoxConfig, type ParsedNode } from './subscription'
import {
  pickFreePort,
  startKernel,
  type KernelHandle,
} from './proxyKernel'
import { applyProxyToSession } from './proxy'
import { DEFAULT_PROXY_PREFS } from '../shared/types'

/**
 * 订阅代理的运行时：订阅 → 节点 → 内核 → 会话。
 *
 * 这是「贴一条订阅链接就能上网」那条路的执行体。它和 `proxy.ts` 里手填
 * 地址的模式是并列的两种来源：
 * - `manual` / `system` / `off`：连用户已有的本地代理（比如他自己开的 v2rayN）；
 * - `subscription`：本应用自己拉内核，不依赖任何外部客户端。
 *
 * 内核托管在这里而不是散在 index.ts 里，是因为它有生命周期（启动 / 换节点 / 退出清理），
 * 需要一个所有者。
 */

let handle: KernelHandle | null = null
let nodes: ParsedNode[] = []
let selectedIndex = 0
let state: ProxyKernelState = { status: 'stopped' }
/**
 * 最近一次成功的订阅正文。
 *
 * 换节点要重启内核，重启需要重新生成配置，而重新生成需要正文。
 * 存在主进程而不是让渲染层传回来：机场订阅接口通常有频率限制，
 * 每换一次节点就重拉一遍很容易被限流。
 */
let cachedBody = ''

export function getCachedSubscriptionBody(): string {
  return cachedBody
}

/**
 * 只更新缓存的订阅正文，**不动节点、不重启内核**。
 *
 * 订阅自动更新用的就是这条：机场的订阅会换节点，但换节点要重启内核，
 * 而重启会掐断正在进行的下载。自动更新只保证「下次换节点时拿到的是新正文」，
 * 换不换仍然由本人点。
 */
export function cacheSubscriptionBody(body: string): void {
  if (typeof body !== 'string' || !body.trim()) return
  cachedBody = body
}

/** 测试与「断开订阅」共用：清掉缓存节点，避免拿旧正文换节点。 */
export function clearSubscriptionCache(): void {
  cachedBody = ''
  nodes = []
  selectedIndex = 0
}

function setState(next: ProxyKernelState): void {
  state = next
  emit?.()
}

let emit: (() => void) | null = null

export function getKernelState(): ProxyKernelState {
  return state
}

export function getSubscriptionNodes(): { nodes: ParsedNode[]; selectedIndex: number } {
  return { nodes, selectedIndex }
}

/** 停止内核。可重复调用；退出时一定要走这里，否则会留下孤儿进程。 */
export async function stopSubscriptionProxy(): Promise<void> {
  const current = handle
  handle = null
  if (current) {
    try {
      await current.stop()
    } catch {
      /* 进程可能已经没了 */
    }
  }
  if (state.status !== 'stopped') setState({ status: 'stopped' })
}

export interface StartFromSubscriptionOptions {
  /** 订阅正文（已经过网络拉取；本模块不负责下载）。 */
  body: string
  /** 选第几个节点；缺省沿用上次或 0。 */
  index?: number
  /** 是否把结果应用到共用会话。 */
  applyToSession?: boolean
}

export type StartFromSubscriptionResult =
  | { ok: true; port: number; node: { name: string; protocol: string } }
  | { ok: false; message: string }

/**
 * 用订阅正文启动内核。
 *
 * 流程：解析 → 选节点 → 挑端口 → 生成配置 → 拉起 → 等端口 → 把会话指过去。
 * 任何一步失败都会把内核停掉，不留半启动状态。
 */
export async function startFromSubscription(
  options: StartFromSubscriptionOptions,
  deps: {
    userDataDir?: string
    startKernelFn?: typeof startKernel
    pickPort?: () => Promise<number>
    isListening?: (port: number) => Promise<boolean>
  } = {},
): Promise<StartFromSubscriptionResult> {
  setState({ status: 'starting' })
  await stopSubscriptionProxy()

  const parsed = parseSubscription(options.body)
  if (parsed.nodes.length === 0) {
    const why = parsed.reasons.length > 0 ? `（${parsed.reasons.join('；')}）` : ''
    setState({ status: 'error', message: `订阅里没有可用的节点${why}` })
    return { ok: false, message: `订阅里没有可用的节点${why}` }
  }

  nodes = parsed.nodes
  cachedBody = options.body
  const index = Number.isSafeInteger(options.index) ? Number(options.index) : selectedIndex
  selectedIndex = index >= 0 && index < nodes.length ? index : 0

  const userDataDir = deps.userDataDir ?? app.getPath('userData')
  let port: number
  try {
    port = await (deps.pickPort ?? (() => pickFreePort()))()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    setState({ status: 'error', message })
    return { ok: false, message }
  }

  const config = buildSingBoxConfig(nodes, { listenPort: port, selectedIndex })
  const started = await (deps.startKernelFn ?? startKernel)(
    { userDataDir, config, port },
    {},
  )
  if (!started.ok) {
    setState({ status: 'error', message: started.message })
    return { ok: false, message: started.message }
  }

  handle = started.handle

  // 把浏览与下载共用的会话指到内核上
  if (options.applyToSession !== false) {
    try {
      const ses = session.fromPartition('persist:novel')
      // 走 applyProxyToSession 而不是裸 setProxy：它带着「先等再断连」的保护，
      // 否则内核刚换过时留在死端口上的连接会把 network service 打崩。
      const applied = await applyProxyToSession(ses as never, {
        ...DEFAULT_PROXY_PREFS,
        mode: 'manual',
        protocol: 'http',
        host: '127.0.0.1',
        port,
        bypass: '',
      })
      if (!applied.ok) throw new Error(applied.message ?? '切换代理失败')
    } catch (e) {
      await stopSubscriptionProxy()
      const message = `内核已启动但会话没能切过去：${e instanceof Error ? e.message : String(e)}`
      setState({ status: 'error', message })
      return { ok: false, message }
    }
  }

  const node = nodes[selectedIndex]
  setState({ status: 'running', port, nodeName: node.name, nodeProtocol: node.protocol })
  return { ok: true, port, node: { name: node.name, protocol: node.protocol } }
}

/** 换节点：重启内核（几百毫秒），比维护热重载状态机可靠。 */
export async function selectSubscriptionNode(
  index: number,
  body?: string,
  deps: Parameters<typeof startFromSubscription>[1] = {},
): Promise<StartFromSubscriptionResult> {
  if (index < 0 || index >= nodes.length) {
    return { ok: false, message: '节点序号超出范围' }
  }
  const source = body && body.trim() ? body : cachedBody
  if (!source.trim()) return { ok: false, message: '还没有可用的订阅，请先连接订阅' }
  selectedIndex = index
  return startFromSubscription({ body: source, index }, deps)
}

/** 订阅概览：给界面显示「有多少节点、都能用哪些协议」。 */
export function describeSubscription(body: string): ProxySubscriptionState {
  const parsed = parseSubscription(body)
  const byProtocol: Record<string, number> = {}
  for (const node of parsed.nodes) {
    byProtocol[node.protocol] = (byProtocol[node.protocol] ?? 0) + 1
  }
  return {
    total: parsed.nodes.length,
    skipped: parsed.skipped,
    byProtocol,
    nodes: parsed.nodes.map((node) => ({ name: node.name, protocol: node.protocol })),
  }
}
