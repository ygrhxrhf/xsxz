/**
 * Agent 桥接的核心协议层：分帧、握手状态机、请求路由。
 *
 * 刻意不 import electron——这一层要能在 vitest 里用假 host 直接驱动，
 * 鉴权失败计数与拒绝行为才可测。Electron 侧的管道服务器在 `agentBridge.ts`。
 *
 * 线格式：4 字节小端长度 + UTF-8 JSON，一帧一请求一响应。
 * 首帧必须是 `op:'hello'` 且带令牌；未握手就发其他 op，或令牌错误，
 * 一律回 `UNAUTHORIZED` 并断开——这是"无鉴权的本机端点"不存在的保证。
 */

export type BridgeToolset = 'core' | 'all'

export interface BridgeToolInfo {
  channel: string
  tool: string
  title: string
  description: string
  tier: 'read' | 'write' | 'destructive'
  confirm: 'none' | 'dry-run' | 'token'
  deps: readonly string[]
  params: unknown
  result: string
  coreToolset: boolean
}

export interface BridgeDispatchResult {
  ok: boolean
  data?: unknown
  code?: string
  message?: string
  hint?: string
  plan?: unknown
  confirmToken?: string
}

export interface BridgeHost {
  tools(toolset?: BridgeToolset): BridgeToolInfo[]
  call(
    tool: string,
    args: unknown,
    options: { dryRun?: boolean; confirmToken?: string },
  ): Promise<BridgeDispatchResult>
}

interface BridgeSessionOptions {
  host: BridgeHost
  /** 令牌校验；由宿主提供，便于测试注入。 */
  verifyToken(token: unknown): boolean
  /** 握手成功后回调一次，宿主可记录 client 标识用于审计。 */
  onHello?(frame: { client?: unknown }): void
  /** 每次鉴权失败回调一次；宿主据此计数并在达到阈值时轮换。 */
  onAuthFailure(): void
  onSend(data: unknown): void
  onClose(reason: string): void
}

/** 单帧上限：正文类返回可能到兆级，16 MiB 足够且防止恶意超大帧。 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024

export function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf-8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length, 0)
  return Buffer.concat([header, payload])
}

export function createFrameDecoder(onFrame: (value: unknown) => void, onViolation: (reason: string) => void): (chunk: Buffer) => void {
  let buffer: Buffer = Buffer.alloc(0)
  return (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0)
      if (length > MAX_FRAME_BYTES) {
        onViolation(`帧长 ${length} 超过上限`)
        return
      }
      if (buffer.length < 4 + length) break
      const payload = buffer.subarray(4, 4 + length)
      buffer = buffer.subarray(4 + length)
      let value: unknown
      try {
        value = JSON.parse(payload.toString('utf-8'))
      } catch {
        onViolation('帧不是合法 JSON')
        return
      }
      onFrame(value)
    }
  }
}

/** 与键序无关的字符串化，用于把 confirmToken 绑定到具体参数。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

interface BridgeRequest {
  id?: unknown
  op?: unknown
  token?: unknown
  client?: unknown
  tool?: unknown
  args?: unknown
  dryRun?: unknown
  confirmToken?: unknown
  toolset?: unknown
}

export interface BridgeSession {
  feed(chunk: Buffer): void
  end(): void
}

export function createBridgeSession(options: BridgeSessionOptions): BridgeSession {
  let authenticated = false
  let closed = false
  // 同一连接内按序处理：call 可能要几百毫秒，乱序响应会让客户端对不上 id。
  let tail: Promise<void> = Promise.resolve()

  const send = (data: unknown): void => {
    if (!closed) options.onSend(data)
  }
  const fail = (id: number, code: string, message: string): void => {
    send({ id, ok: false, code, message })
  }
  const close = (reason: string): void => {
    if (closed) return
    closed = true
    options.onClose(reason)
  }

  const handleFrame = (raw: unknown): void => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      close('帧必须是 JSON 对象')
      return
    }
    const request = raw as BridgeRequest
    if (typeof request.id !== 'number' || typeof request.op !== 'string') {
      close('帧缺少 id 或 op')
      return
    }
    const id = request.id

    if (request.op === 'hello') {
      if (authenticated) {
        fail(id, 'ALREADY_AUTHENTICATED', '已握手，不要重复 hello')
        return
      }
      if (!options.verifyToken(request.token)) {
        options.onAuthFailure()
        send({ id, ok: false, code: 'UNAUTHORIZED', message: '令牌无效' })
        close('令牌错误')
        return
      }
      authenticated = true
      options.onHello?.({ client: request.client })
      send({ id, ok: true, app: 'spbf', pid: process.pid, protocol: 1 })
      return
    }

    if (!authenticated) {
      send({ id, ok: false, code: 'UNAUTHORIZED', message: '请先携带令牌完成 hello 握手' })
      close('未握手就发请求')
      return
    }

    if (request.op === 'list') {
      const toolset = request.toolset === 'all' ? 'all' : 'core'
      send({ id, ok: true, tools: options.host.tools(toolset) })
      return
    }

    if (request.op === 'call') {
      if (typeof request.tool !== 'string') {
        fail(id, 'BAD_ARGS', 'call 需要 tool 字段')
        return
      }
      const args = request.args ?? {}
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        fail(id, 'BAD_ARGS', 'args 必须是对象')
        return
      }
      const callOptions = {
        dryRun: request.dryRun === true,
        confirmToken: typeof request.confirmToken === 'string' ? request.confirmToken : undefined,
      }
      const tool = request.tool
      tail = tail.then(async () => {
        // 客户端断开后不再执行：写操作的副作用不能发给已经离开的调用者。
        if (closed) return
        try {
          const result = await options.host.call(tool, args, callOptions)
          send({ id, ...result })
        } catch (error) {
          send({
            id,
            ok: false,
            code: 'INTERNAL',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
      return
    }

    fail(id, 'BAD_OP', `未知 op：${String(request.op)}`)
  }

  // 解码器持有跨 chunk 的缓冲：一帧跨多个 data 事件时前半段不能丢。
  const decoder = createFrameDecoder(handleFrame, (reason) => close(reason))

  return {
    feed(chunk: Buffer): void {
      if (closed) return
      decoder(chunk)
    },
    end(): void {
      close('连接结束')
    },
  }
}
