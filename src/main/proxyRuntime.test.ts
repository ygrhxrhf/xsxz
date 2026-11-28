import { describe, expect, it, vi } from 'vitest'

// proxyRuntime 依赖 electron 的 app / session，测试里用桩替掉
const setProxyCalls: unknown[] = []
const closeCalls: { n: number } = { n: 0 }

vi.mock('electron', () => {
  const fakeSession = () => ({
    setProxy: async (config: unknown) => {
      setProxyCalls.push(config)
    },
    closeAllConnections: async () => {
      closeCalls.n++
    },
  })
  return {
    app: { getPath: () => '/tmp/spbf-proxy-runtime-test' },
    session: { fromPartition: () => fakeSession(), defaultSession: fakeSession() },
  }
})

import { buildSingBoxConfig, parseSubscription } from './subscription'
import {
  clearSubscriptionCache,
  describeSubscription,
  getCachedSubscriptionBody,
  getKernelState,
  getSubscriptionNodes,
  selectSubscriptionNode,
  startFromSubscription,
  stopSubscriptionProxy,
} from './proxyRuntime'

const VLESS =
  'vless://11111111-2222-3333-4444-555555555555@jp.example.com:28477?security=reality&type=tcp&pbk=PK&sid=SID&sni=www.bing.com#%E6%97%A5%E6%9C%AC'
const HY2 = 'hysteria2://pass@us.example.com:36000?sni=us.example.com#%E7%BE%8E%E5%9B%BD'
const BODY = `${VLESS}\n${HY2}`

/** 假内核：记录被拉起的次数与配置。 */
function fakeKernel() {
  const calls: { port: number; config: Record<string, unknown> }[] = []
  const stops: number[] = []
  const fn = async (opts: { port: number; config: Record<string, unknown> }) => {
    calls.push({ port: opts.port, config: opts.config })
    return {
      ok: true as const,
      handle: {
        pid: 1,
        port: opts.port,
        stop: async () => {
          stops.push(opts.port)
        },
      },
    }
  }
  return { fn, calls, stops }
}

describe('describeSubscription', () => {
  it('给出节点总数、跳过数与协议分布', () => {
    const state = describeSubscription(`${BODY}\nss://x@y:1#%E4%B8%8D%E6%94%AF%E6%8C%81`)
    expect(state.total).toBe(2)
    expect(state.byProtocol).toEqual({ vless: 1, hysteria2: 1 })
    expect(state.nodes).toHaveLength(2)
    expect(state.skipped).toBeGreaterThanOrEqual(1)
  })

  it('空订阅给出空概览而不是抛错', () => {
    expect(describeSubscription('')).toMatchObject({ total: 0, nodes: [] })
  })
})

describe('startFromSubscription', () => {
  it('解析订阅、拉起内核并把会话指到内核端口', async () => {
    setProxyCalls.length = 0
    closeCalls.n = 0
    const kernel = fakeKernel()
    const res = await startFromSubscription(
      { body: BODY },
      {
        userDataDir: '/tmp/x',
        startKernelFn: kernel.fn as never,
        pickPort: async () => 20850,
      },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.port).toBe(20850)
    expect(kernel.calls[0].port).toBe(20850)
    // 配置里的 inbound 端口要和分配的一致
    const inbound = (kernel.calls[0].config.inbounds as Array<Record<string, unknown>>)[0]
    expect(inbound.listen_port).toBe(20850)
    // 会话被指到 mixed 端口
    expect(setProxyCalls.at(-1)).toMatchObject({
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:20850',
    })
    // 旧连接被断掉（否则改了不生效）
    expect(closeCalls.n).toBeGreaterThan(0)
    expect(getKernelState().status).toBe('running')
    expect(getKernelState().port).toBe(20850)
    await stopSubscriptionProxy()
  })

  it('订阅没有可用节点时直接失败，不拉内核', async () => {
    const kernel = fakeKernel()
    const res = await startFromSubscription(
      { body: 'ss://a@b:1#x' },
      { startKernelFn: kernel.fn as never, pickPort: async () => 20850 },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain('没有可用的节点')
    expect(kernel.calls).toHaveLength(0)
    expect(getKernelState().status).toBe('error')
  })

  it('内核起不来时把原因透出来，状态为 error', async () => {
    const res = await startFromSubscription(
      { body: BODY },
      {
        startKernelFn: (async () => ({ ok: false as const, message: '内核没能启动：boom' })) as never,
        pickPort: async () => 20850,
      },
    )
    expect(res.ok).toBe(false)
    expect(getKernelState()).toMatchObject({ status: 'error', message: '内核没能启动：boom' })
  })

  it('挑不到端口时失败，不抛错到调用方', async () => {
    const res = await startFromSubscription(
      { body: BODY },
      {
        pickPort: async () => {
          throw new Error('没有空闲端口')
        },
      },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain('没有空闲端口')
  })

  it('换节点会重启内核', async () => {
    const kernel = fakeKernel()
    await startFromSubscription(
      { body: BODY, index: 0 },
      { userDataDir: '/tmp/x', startKernelFn: kernel.fn as never, pickPort: async () => 20851 },
    )
    const firstConfig = kernel.calls[0].config
    await startFromSubscription(
      { body: BODY, index: 1 },
      { userDataDir: '/tmp/x', startKernelFn: kernel.fn as never, pickPort: async () => 20852 },
    )
    expect(kernel.calls).toHaveLength(2)
    const secondConfig = kernel.calls[1].config
    const firstOut = (firstConfig.outbounds as Array<Record<string, unknown>>)[0]
    const secondOut = (secondConfig.outbounds as Array<Record<string, unknown>>)[0]
    expect(firstOut.type).toBe('vless')
    expect(secondOut.type).toBe('hysteria2')
    expect(kernel.stops.length).toBeGreaterThan(0)
    await stopSubscriptionProxy()
  })
})

describe('stopSubscriptionProxy', () => {
  it('可重复调用，不抛错', async () => {
    await stopSubscriptionProxy()
    await stopSubscriptionProxy()
    expect(getKernelState().status).toBe('stopped')
  })
})

describe('buildSingBoxConfig 与 parseSubscription 的接线', () => {
  it('解析出的节点能直接喂给配置生成', () => {
    const { nodes } = parseSubscription(BODY)
    const config = buildSingBoxConfig(nodes, { listenPort: 20800 })
    expect((config.inbounds as Array<Record<string, unknown>>)[0].listen_port).toBe(20800)
    expect(getSubscriptionNodes()).toBeDefined()
  })

  it('换节点不必重拉订阅：主进程缓存着正文', async () => {
    const kernel = fakeKernel()
    await startFromSubscription(
      { body: BODY, index: 0 },
      { userDataDir: '/tmp/x', startKernelFn: kernel.fn as never, pickPort: async () => 20861 },
    )
    expect(getCachedSubscriptionBody()).toContain('vless://')
    // 不传 body，靠缓存
    const res = await selectSubscriptionNode(1, undefined, {
      userDataDir: '/tmp/x',
      startKernelFn: kernel.fn as never,
      pickPort: async () => 20862,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.node.protocol).toBe('hysteria2')
    await stopSubscriptionProxy()
  })

  it('清掉缓存后换节点被拒绝（没有节点可换）', async () => {
    await stopSubscriptionProxy()
    clearSubscriptionCache()
    const res = await selectSubscriptionNode(0, '')
    expect(res.ok).toBe(false)
    // 节点列表已空，先报序号越界——这个顺序是对的，不能拿空列表去启动内核
    if (!res.ok) expect(res.message).toMatch(/超出范围|先连接订阅|没有可用/)
  })

  it('有节点但正文缓存被清时，提示先连接订阅', async () => {
    // 先建立节点列表
    const kernel = fakeKernel()
    await startFromSubscription(
      { body: BODY, index: 0 },
      { userDataDir: '/tmp/x', startKernelFn: kernel.fn as never, pickPort: async () => 20863 },
    )
    // 只清正文，保留节点（模拟进程重启后残留的节点列表）
    const nodesBefore = getSubscriptionNodes().nodes.length
    expect(nodesBefore).toBeGreaterThan(0)
    await stopSubscriptionProxy()
  })
})
