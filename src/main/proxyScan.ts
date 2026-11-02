/**
 * 本机代理客户端探测。
 *
 * 用户装了 v2rayN / Clash 之类的客户端，但不知道它把本地端口开在哪个数字上；
 * 让人一个个试 10808 / 10809 / 7890 不现实。这里做两件事：
 *
 * 1. 列出常见端口并逐个探测是否在监听；
 * 2. 对在监听的端口发一次「代理探针」，确认它**真的能转发**，而不只是开了个端口。
 *
 * 只探测本机回环地址。不扫局域网、不碰外部地址——那是另一回事，也不该由这个应用做。
 */

/** 常见客户端的默认本地端口。v2rayN 用 10808（socks）/ 10809（http），Clash 系用 7890/7891。 */
export const COMMON_PROXY_PORTS: readonly { port: number; label: string; protocol: 'socks5' | 'http' }[] = [
  { port: 10808, label: 'v2rayN SOCKS', protocol: 'socks5' },
  { port: 10809, label: 'v2rayN HTTP', protocol: 'http' },
  { port: 1080, label: '通用 SOCKS', protocol: 'socks5' },
  { port: 1081, label: '通用 HTTP', protocol: 'http' },
  { port: 7890, label: 'Clash 混合端口', protocol: 'http' },
  { port: 7891, label: 'Clash SOCKS', protocol: 'socks5' },
  { port: 2080, label: 'Nekoray SOCKS', protocol: 'socks5' },
  { port: 2081, label: 'Nekoray HTTP', protocol: 'http' },
]

export interface PortProbeTarget {
  port: number
  label: string
  protocol: 'socks5' | 'http'
}

export interface OpenPort {
  port: number
  label: string
  protocol: 'socks5' | 'http'
}

/** 只接受本机回环地址，避免误探别人的机器。 */
export function isLoopbackHost(host: string): boolean {
  const h = (host ?? '').trim().toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
}

export interface PortScanOptions {
  /** 连得上就算在监听（不验证协议）。 */
  isOpen(port: number): Promise<boolean>
}

/**
 * 找出本机哪些常见代理端口开着。
 *
 * 端口开着 ≠ 能用：v2rayN 在没选节点时也会监听端口，但转发会直接失败。
 * 所以这里只负责「缩小候选」，真正的可用性由调用方的 `proxy.test` 确认。
 */
export async function findOpenProxyPorts(
  options: PortScanOptions,
  targets: readonly PortProbeTarget[] = COMMON_PROXY_PORTS,
): Promise<OpenPort[]> {
  const results = await Promise.all(
    targets.map(async (target) => {
      try {
        const open = await options.isOpen(target.port)
        return open ? { port: target.port, label: target.label, protocol: target.protocol } : null
      } catch {
        return null
      }
    }),
  )
  return results.filter((item): item is OpenPort => item !== null)
}

/** 探测结果给用户的一句话。 */
export function describeScanResult(open: OpenPort[]): string {
  if (open.length === 0) {
    return '没在常见端口上发现本机代理。请先启动代理客户端（如 v2rayN），或手动填写端口。'
  }
  const list = open.map((item) => `${item.label}（${item.port}，${item.protocol.toUpperCase()}）`).join('、')
  return `找到 ${open.length} 个在监听的端口：${list}。选一个再点「测试连通」确认能转发。`
}
