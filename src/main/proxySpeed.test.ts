import { describe, expect, it } from 'vitest'
import {
  describeProbeFailure,
  probeNodeSpeed,
  probeNodes,
  summarizeSpeedTest,
  type SpeedNodeTarget,
} from './proxySpeed'

/**
 * 多节点测速。
 *
 * 探测全部注入，所以这些用例不碰网络；重点是「一个节点失败不影响其它节点」
 * 和「最快的节点算对」。
 */

const NODES: SpeedNodeTarget[] = [
  { name: '日本', protocol: 'vless', server: 'jp.example.com', port: 443 },
  { name: '美国', protocol: 'hysteria2', server: 'us.example.com', port: 443 },
  { name: '新加坡', protocol: 'tuic', server: 'sg.example.com', port: 443 },
]

describe('probeNodeSpeed', () => {
  it('成功时给出毫秒数', async () => {
    const result = await probeNodeSpeed(NODES[0]!, 0, async () => 120.4)
    expect(result).toMatchObject({ index: 0, name: '日本', protocol: 'vless', latencyMs: 120, ok: true, message: '' })
  })

  it('失败时记 -1 并带中文原因', async () => {
    const result = await probeNodeSpeed(NODES[1]!, 1, async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(result.ok).toBe(false)
    expect(result.latencyMs).toBe(-1)
    expect(result.message).toContain('连接失败')
    expect(result.message).toContain('ECONNREFUSED')
  })

  it('超时给专门的文案', async () => {
    const result = await probeNodeSpeed(NODES[2]!, 2, async () => {
      const error = new Error('x') as NodeJS.ErrnoException
      error.code = 'ETIMEDOUT'
      throw error
    })
    expect(result.message).toBe('连接超时')
  })

  it('探测返回非法值时不算成功', async () => {
    const result = await probeNodeSpeed(NODES[0]!, 0, async () => Number.NaN)
    expect(result.ok).toBe(false)
    expect(result.message).toBe('探测结果无效')
  })
})

describe('probeNodes', () => {
  it('单个节点失败不影响其它节点', async () => {
    const nodes = await probeNodes(NODES, async (node) => {
      if (node.name === '美国') throw new Error('连不上')
      return node.name === '日本' ? 50 : 90
    })
    expect(nodes).toHaveLength(3)
    expect(nodes[0]).toMatchObject({ ok: true, latencyMs: 50 })
    expect(nodes[1]).toMatchObject({ ok: false, latencyMs: -1 })
    expect(nodes[2]).toMatchObject({ ok: true, latencyMs: 90 })
  })

  it('结果按节点序号升序，不受完成先后影响', async () => {
    const nodes = await probeNodes(NODES, async (node) => {
      // 故意让第一个节点最慢
      await new Promise((resolve) => setTimeout(resolve, node.name === '日本' ? 20 : 1))
      return 10
    })
    expect(nodes.map((node) => node.index)).toEqual([0, 1, 2])
    expect(nodes.map((node) => node.name)).toEqual(['日本', '美国', '新加坡'])
  })

  it('空列表不报错', async () => {
    expect(await probeNodes([], async () => 1)).toEqual([])
  })
})

describe('summarizeSpeedTest', () => {
  it('数出成功数与最快节点', () => {
    const result = summarizeSpeedTest([
      { index: 0, name: 'A', protocol: 'vless', latencyMs: 300, ok: true, message: '' },
      { index: 1, name: 'B', protocol: 'vless', latencyMs: 120, ok: true, message: '' },
      { index: 2, name: 'C', protocol: 'vless', latencyMs: -1, ok: false, message: '连接失败' },
    ])
    expect(result.succeeded).toBe(2)
    expect(result.total).toBe(3)
    expect(result.fastestIndex).toBe(1)
  })

  it('没有成功节点时 fastestIndex 为 -1', () => {
    const result = summarizeSpeedTest([
      { index: 0, name: 'A', protocol: 'vless', latencyMs: -1, ok: false, message: '连接失败' },
      { index: 1, name: 'B', protocol: 'vless', latencyMs: -1, ok: false, message: '连接超时' },
    ])
    expect(result.succeeded).toBe(0)
    expect(result.total).toBe(2)
    expect(result.fastestIndex).toBe(-1)
  })

  it('空结果也是 -1', () => {
    expect(summarizeSpeedTest([])).toEqual({ nodes: [], succeeded: 0, total: 0, fastestIndex: -1 })
  })
})

describe('describeProbeFailure', () => {
  it('非异常也能给出中文原因', () => {
    expect(describeProbeFailure('炸了')).toContain('连接失败')
  })
})
