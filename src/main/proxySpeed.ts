import { connect } from 'node:net'
import type { ProxyNodeSpeed, ProxySpeedTestResult } from '../shared/types'

/**
 * 多节点测速。
 *
 * 测的是「这个节点有多快能连上」：并发对每个节点做一次 TCP 握手计时，
 * 谁先握上手谁快。单个节点失败不影响别的节点——一个节点不通不该让整张
 * 列表变成一片问号。
 *
 * 诚实说明：这里量的是到节点服务器端口的握手时间，不是「走完代理再打开网页」
 * 的端到端时间。后者要每个节点各起一条完整链路，代价太大；握手时间足以
 * 区分「这个节点还活着」和「这个节点已经废了」。
 */

/** 测速需要的节点信息。 */
export interface SpeedNodeTarget {
  name: string
  protocol: string
  server: string
  port: number
}

/** 延迟探测实现；返回毫秒数，抛错视为该节点失败。 */
export type LatencyProbe = (node: SpeedNodeTarget) => Promise<number>

/** 默认并发数：一次开太多连接反而会挤占带宽、让延迟数据失真。 */
export const DEFAULT_PROBE_CONCURRENCY = 8

/** 把异常翻译成一句中文原因。 */
export function describeProbeFailure(error: unknown): string {
  const code = (error as { code?: string } | null)?.code ?? ''
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT') return '连接超时'
  const detail = error instanceof Error ? error.message : String(error)
  return detail ? `连接失败：${detail}` : '连接失败'
}

/** 测一个节点；失败记 `latencyMs: -1` 并带上中文原因。 */
export async function probeNodeSpeed(
  node: SpeedNodeTarget,
  index: number,
  probe: LatencyProbe,
): Promise<ProxyNodeSpeed> {
  try {
    const latency = await probe(node)
    if (!Number.isFinite(latency) || latency < 0) {
      return { index, name: node.name, protocol: node.protocol, latencyMs: -1, ok: false, message: '探测结果无效' }
    }
    return {
      index,
      name: node.name,
      protocol: node.protocol,
      latencyMs: Math.round(latency),
      ok: true,
      message: '',
    }
  } catch (error) {
    return {
      index,
      name: node.name,
      protocol: node.protocol,
      latencyMs: -1,
      ok: false,
      message: describeProbeFailure(error),
    }
  }
}

/**
 * 并发测所有节点。
 *
 * 结果按节点序号升序返回——界面按下标取节点，不能因为并发完成顺序不同就乱序。
 */
export async function probeNodes(
  nodes: SpeedNodeTarget[],
  probe: LatencyProbe,
  options: { concurrency?: number } = {},
): Promise<ProxyNodeSpeed[]> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_PROBE_CONCURRENCY, nodes.length || 1))
  const results: ProxyNodeSpeed[] = new Array(nodes.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= nodes.length) return
      const node = nodes[index]!
      results[index] = await probeNodeSpeed(node, index, probe)
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, nodes.length) }, () => worker())
  await Promise.all(workers)
  return results
}

/** 汇总一次测速：成功数、总数、最快节点序号。 */
export function summarizeSpeedTest(nodes: ProxyNodeSpeed[]): ProxySpeedTestResult {
  let succeeded = 0
  let fastestIndex = -1
  let best = Number.POSITIVE_INFINITY
  for (const node of nodes) {
    if (!node.ok) continue
    succeeded += 1
    if (node.latencyMs < best) {
      best = node.latencyMs
      fastestIndex = node.index
    }
  }
  return { nodes, succeeded, total: nodes.length, fastestIndex }
}

/**
 * 默认探测：对节点服务器端口做一次 TCP 握手，量握手耗时。
 *
 * 只连一次，量到「连接建立」为止，然后立刻断开——测速不该长期占着节点的连接数。
 */
export function tcpProbeLatency(node: SpeedNodeTarget, timeoutMs = 3000): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const started = Date.now()
    const socket = connect({ host: node.server, port: node.port })
    const timer = setTimeout(() => {
      socket.destroy()
      const error = new Error('连接超时') as NodeJS.ErrnoException
      error.code = 'ETIMEDOUT'
      reject(error)
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      const elapsed = Date.now() - started
      socket.destroy()
      resolve(elapsed)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
