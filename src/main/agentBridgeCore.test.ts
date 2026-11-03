import { describe, expect, it, vi } from 'vitest'
import {
  createBridgeSession,
  createFrameDecoder,
  encodeFrame,
  stableStringify,
  type BridgeDispatchResult,
  type BridgeHost,
} from './agentBridgeCore'

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf-8')
}

interface Harness {
  session: ReturnType<typeof createBridgeSession>
  sent: unknown[]
  failures: () => number
  closeReason: () => string
}

function drive(token: string, host: BridgeHost = { tools: () => [], call: async () => ({ ok: true, data: {} }) }): Harness {
  const sent: unknown[] = []
  let failures = 0
  let reason = ''
  const session = createBridgeSession({
    host,
    verifyToken: (candidate) => candidate === token,
    onAuthFailure: () => {
      failures += 1
    },
    onSend: (data) => sent.push(data),
    onClose: (why) => {
      reason = why
    },
  })
  return { session, sent, failures: () => failures, closeReason: () => reason }
}

describe('bridge 帧编码', () => {
  it('4 字节小端长度 + JSON 载荷', () => {
    const frame = encodeFrame({ id: 1 })
    expect(frame.readUInt32LE(0)).toBe(json({ id: 1 }).length)
    expect(frame.subarray(4).toString('utf-8')).toBe('{"id":1}')
  })

  it('一帧跨多个 chunk 时按缓冲拼接还原', () => {
    const frames: unknown[] = []
    const decoder = createFrameDecoder((value) => frames.push(value), () => {})
    const payload = encodeFrame({ id: 7, op: 'hello' })
    decoder(payload.subarray(0, 3))
    decoder(payload.subarray(3))
    expect(frames).toEqual([{ id: 7, op: 'hello' }])
  })

  it(' stableStringify 与键序无关', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })
})

describe('bridge 会话鉴权', () => {
  it('正确令牌握手成功', () => {
    const { session, sent, closeReason } = drive('secret')
    session.feed(encodeFrame({ id: 1, op: 'hello', token: 'secret' }))
    expect(sent).toEqual([{ id: 1, ok: true, app: 'spbf', pid: process.pid, protocol: 1 }])
    expect(closeReason()).toBe('')
  })

  it('错误令牌：拒绝、计数并断开', () => {
    const { session, sent, failures, closeReason } = drive('secret')
    session.feed(encodeFrame({ id: 2, op: 'hello', token: 'wrong' }))
    expect(sent).toEqual([{ id: 2, ok: false, code: 'UNAUTHORIZED', message: '令牌无效' }])
    expect(failures()).toBe(1)
    expect(closeReason()).toBe('令牌错误')
  })

  it('未握手就调用：拒绝并断开', () => {
    const { session, sent, closeReason } = drive('secret')
    session.feed(encodeFrame({ id: 3, op: 'call', tool: 'library_list', args: {} }))
    expect(sent).toEqual([{ id: 3, ok: false, code: 'UNAUTHORIZED', message: '请先携带令牌完成 hello 握手' }])
    expect(closeReason()).toBe('未握手就发请求')
  })

  it('非对象帧与缺 id 的帧都会断开连接', () => {
    const first = drive('secret')
    first.session.feed(encodeFrame(null))
    expect(first.closeReason()).toBe('帧必须是 JSON 对象')

    const second = drive('secret')
    second.session.feed(encodeFrame({ op: 'hello', token: 'secret' }))
    expect(second.closeReason()).toBe('帧缺少 id 或 op')
  })
})

describe('bridge 会话路由', () => {
  it('call 把参数原样交给 host 并回传结果', async () => {
    const host = {
      tools: () => [],
      call: vi.fn(async (): Promise<BridgeDispatchResult> => ({ ok: true, data: { books: [] } })),
    }
    const { session, sent } = drive('secret', host)
    session.feed(encodeFrame({ id: 1, op: 'hello', token: 'secret' }))
    session.feed(encodeFrame({ id: 2, op: 'call', tool: 'library_list', args: { limit: 5 } }))
    await vi.waitFor(() => expect(sent.length).toBe(2))
    expect(host.call).toHaveBeenCalledWith('library_list', { limit: 5 }, { dryRun: false, confirmToken: undefined })
    expect(sent[1]).toEqual({ id: 2, ok: true, data: { books: [] } })
  })

  it('host 抛错时回 INTERNAL 而不是崩掉连接', async () => {
    const host = {
      tools: () => [],
      call: async (): Promise<BridgeDispatchResult> => {
        throw new Error('书库正在恢复')
      },
    }
    const { session, sent, closeReason } = drive('secret', host)
    session.feed(encodeFrame({ id: 1, op: 'hello', token: 'secret' }))
    session.feed(encodeFrame({ id: 2, op: 'call', tool: 'library_list', args: {} }))
    await vi.waitFor(() => expect(sent.length).toBe(2))
    expect(sent[1]).toEqual({ id: 2, ok: false, code: 'INTERNAL', message: '书库正在恢复' })
    expect(closeReason()).toBe('')
  })

  it('连接关闭后排队的调用不再执行', async () => {
    let release!: (value: BridgeDispatchResult) => void
    const first = new Promise<BridgeDispatchResult>((resolve) => {
      release = resolve
    })
    const executed: string[] = []
    const host = {
      tools: () => [],
      call: vi.fn(async (tool: string): Promise<BridgeDispatchResult> => {
        executed.push(tool)
        return first
      }),
    }
    const { session, sent } = drive('secret', host)
    session.feed(encodeFrame({ id: 1, op: 'hello', token: 'secret' }))
    session.feed(encodeFrame({ id: 2, op: 'call', tool: 'library_list', args: {} }))
    session.feed(encodeFrame({ id: 3, op: 'call', tool: 'settings_get', args: {} }))
    await vi.waitFor(() => expect(executed).toEqual(['library_list']))
    session.end()
    release({ ok: true, data: {} })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(executed).toEqual(['library_list'])
    expect(sent.filter((item) => (item as { id?: number }).id === 3)).toEqual([])
  })
})
