import { describe, expect, it } from 'vitest'
import {
  COMMON_PROXY_PORTS,
  describeScanResult,
  findOpenProxyPorts,
  isLoopbackHost,
} from './proxyScan'

describe('isLoopbackHost', () => {
  it('认出常见的本机写法', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('  LOCALHOST  ')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
  })

  it('外部地址一律不算（不误探别人的机器）', () => {
    expect(isLoopbackHost('192.168.1.1')).toBe(false)
    expect(isLoopbackHost('example.com')).toBe(false)
    expect(isLoopbackHost('')).toBe(false)
  })
})

describe('findOpenProxyPorts', () => {
  it('只返回在监听的端口，并带上标签与协议', async () => {
    const open = await findOpenProxyPorts({
      isOpen: async (port) => port === 10808 || port === 7890,
    })
    expect(open.map((o) => o.port).sort((a, b) => a - b)).toEqual([7890, 10808])
    expect(open.find((o) => o.port === 10808)?.protocol).toBe('socks5')
    expect(open.find((o) => o.port === 7890)?.protocol).toBe('http')
  })

  it('一个都没开时返回空数组', async () => {
    expect(await findOpenProxyPorts({ isOpen: async () => false })).toEqual([])
  })

  it('单个端口探测抛错不影响其它端口', async () => {
    const open = await findOpenProxyPorts({
      isOpen: async (port) => {
        if (port === 1080) throw new Error('EACCES')
        return port === 10809
      },
    })
    expect(open.map((o) => o.port)).toEqual([10809])
  })

  it('可以只扫指定端口（界面按需缩小范围）', async () => {
    const open = await findOpenProxyPorts(
      { isOpen: async (port) => port === 9999 },
      [{ port: 9999, label: '自定义', protocol: 'http' }],
    )
    expect(open).toEqual([{ port: 9999, label: '自定义', protocol: 'http' }])
  })
})

describe('describeScanResult', () => {
  it('一个都没有时说清下一步该做什么', () => {
    const text = describeScanResult([])
    expect(text).toContain('没在常见端口上发现')
    expect(text).toContain('启动代理客户端')
  })

  it('找到时列出端口与协议，并提醒还要验证转发', () => {
    const text = describeScanResult([
      { port: 10808, label: 'v2rayN SOCKS', protocol: 'socks5' },
      { port: 7890, label: 'Clash 混合端口', protocol: 'http' },
    ])
    expect(text).toContain('找到 2 个')
    expect(text).toContain('10808')
    expect(text).toContain('SOCKS5')
    expect(text).toContain('测试连通')
  })
})

describe('COMMON_PROXY_PORTS', () => {
  it('覆盖 v2rayN / Clash / Nekoray 的默认端口', () => {
    const ports = COMMON_PROXY_PORTS.map((p) => p.port)
    for (const expected of [10808, 10809, 7890, 1080, 2080]) {
      expect(ports).toContain(expected)
    }
  })

  it('端口不重复', () => {
    const ports = COMMON_PROXY_PORTS.map((p) => p.port)
    expect(new Set(ports).size).toBe(ports.length)
  })
})
