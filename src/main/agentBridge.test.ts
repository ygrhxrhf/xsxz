import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BridgeDispatchResult } from './agentBridgeCore'
import { createFrameDecoder, encodeFrame } from './agentBridgeCore'
import {
  callCapability,
  installAgentRegistry,
  invokeRegisteredHandler,
  setAgentBridgeTimeoutsForTests,
  startAgentBridge,
  stopAgentBridge,
} from './agentBridge'
import { beginLibraryRestore } from './libraryMaintenance'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), userDataPath: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataPath, setName: () => {} },
  ipcMain: { handle: mocks.handle },
}))

let tempDir = ''

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'spbf-agent-bridge-'))
  mocks.userDataPath = tempDir
  installAgentRegistry()
})

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function register(channel: string, handler: unknown): void {
  ;(ipcMainAlias as unknown as { handle: (channel: string, listener: unknown) => void }).handle(
    channel,
    handler,
  )
}

// import 放在 vi.mock 之后由提升保证；这里拿到的是被 mock 的 ipcMain。
import { ipcMain as ipcMainAlias } from 'electron'

describe('handler 注册表', () => {
  it('ipcMain.handle 同时登记进注册表，桥接用同一段业务逻辑', async () => {
    const handler = vi.fn(async (_event: unknown, payload: { bookId: string }) => ({
      ok: true,
      bookId: payload.bookId,
    }))
    register('library.get', handler)

    const result = await invokeRegisteredHandler('library.get', { bookId: 'b1' })
    expect(result).toEqual({ ok: true, bookId: 'b1' })
    // handler 收到的 event 是占位对象：桥接调用没有真实 sender。
    expect(handler).toHaveBeenCalledWith({ sender: null }, { bookId: 'b1' })
    // 原始 ipcMain.handle 也被调到，preload/渲染进程的通道不受影响。
    expect(mocks.handle).toHaveBeenCalledWith('library.get', handler)
  })

  it('installAgentRegistry 幂等：重复安装不会二次包裹', () => {
    const before = mocks.handle.mock.calls.length
    installAgentRegistry()
    installAgentRegistry()
    expect(mocks.handle.mock.calls.length).toBe(before)
  })
})

describe('能力分发门槛', () => {
  it('未知工具拒绝', async () => {
    const result = await callCapability('no_such_tool', {}, {})
    expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_TOOL' })
  })

  it('dryRun 不执行 handler，但签发一次性令牌', async () => {
    const handler = vi.fn(async () => {
      throw new Error('dryRun 不应该执行业务逻辑')
    })
    register('library.delete', handler)

    const plan = await callCapability('library_delete', { bookId: 'b1' }, { dryRun: true })
    expect(plan.ok).toBe(true)
    expect(plan.plan).toMatchObject({ tool: 'library_delete', channel: 'library.delete', tier: 'destructive' })
    expect(typeof plan.confirmToken).toBe('string')
    expect(handler).not.toHaveBeenCalled()
  })

  it('破坏性操作缺令牌被挡下', async () => {
    const handler = vi.fn(async () => ({ ok: true }))
    register('library.delete', handler)

    const result = await callCapability('library_delete', { bookId: 'b1' }, {})
    expect(result).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('令牌一次性：用过即失效', async () => {
    const handler = vi.fn(async () => ({ ok: true }))
    register('library.delete', handler)

    const plan = await callCapability('library_delete', { bookId: 'b1' }, { dryRun: true })
    const first = await callCapability('library_delete', { bookId: 'b1' }, { confirmToken: plan.confirmToken })
    expect(first.ok).toBe(true)
    const second = await callCapability('library_delete', { bookId: 'b1' }, { confirmToken: plan.confirmToken })
    expect(second).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' })
  })

  it('令牌绑定参数：换参数即失效', async () => {
    const handler = vi.fn(async () => ({ ok: true }))
    register('library.delete', handler)

    const plan = await callCapability('library_delete', { bookId: 'b1' }, { dryRun: true })
    const wrong = await callCapability('library_delete', { bookId: 'b2' }, { confirmToken: plan.confirmToken })
    expect(wrong).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' })
  })

  it('ai_test 拒绝调用方提交的 Key', async () => {
    const result = await callCapability('ai_test', { apiKey: 'sk-smoke' }, {})
    expect(result).toMatchObject({ ok: false, code: 'BAD_ARGS' })
  })

  it('settings_set 拒绝改 Key 与代理密码', async () => {
    const forApiKey = await callCapability('settings_set', { apiKey: 'sk-smoke' }, {})
    expect(forApiKey).toMatchObject({ ok: false, code: 'BAD_ARGS' })
    const forPassword = await callCapability('settings_set', { proxyPassword: 'pw' }, {})
    expect(forPassword).toMatchObject({ ok: false, code: 'BAD_ARGS' })
  })

  it('settings.get 结果脱敏：密文与明文凭据都不返回', async () => {
    register(
      'settings.get',
      vi.fn(async () => ({
        apiKeyEnc: 'cipher',
        apiKey: 'plain',
        apiKeyConfigured: true,
        proxy: { passwordConfigured: true },
        tts: { onlineKeyConfigured: false },
      })),
    )
    const result = await callCapability('settings_get', {}, {})
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({
      apiKeyConfigured: true,
      proxy: { passwordConfigured: true },
      tts: { onlineKeyConfigured: false },
    })
  })
})

describe('错误模型与写队列', () => {
  afterEach(() => {
    setAgentBridgeTimeoutsForTests({ confirmTtlMs: 10 * 60 * 1000, writeQueueWaitMs: 120_000 })
  })

  it('handler 返回 {ok:false} 时桥接报错，不包成成功（设计 §3.7）', async () => {
    register('library.get', vi.fn(async () => ({ ok: false, message: '书籍不存在', failCode: 'NeedLogin' })))
    const result = await callCapability('library_get', { bookId: 'nope' }, {})
    expect(result).toMatchObject({ ok: false, code: 'NeedLogin', message: '书籍不存在' })
  })

  it('过期令牌报 TOKEN_EXPIRED，而不是笼统的 CONFIRM_REQUIRED', async () => {
    setAgentBridgeTimeoutsForTests({ confirmTtlMs: 1 })
    const handler = vi.fn(async () => ({ ok: true }))
    register('library.delete', handler)

    const plan = await callCapability('library_delete', { bookId: 'b9' }, { dryRun: true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const result = await callCapability('library_delete', { bookId: 'b9' }, { confirmToken: plan.confirmToken })
    expect(result).toMatchObject({ ok: false, code: 'TOKEN_EXPIRED' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('恢复期间的写请求直接 LIBRARY_RESTORING，不进队列也不执行（设计 §6.3）', async () => {
    const handler = vi.fn(async () => ({ ok: true }))
    register('library.setProgress', handler)
    const release = beginLibraryRestore()
    try {
      const result = await callCapability('library_set_progress', { bookId: 'b1', progress: 1 }, {})
      expect(result).toMatchObject({ ok: false, code: 'LIBRARY_RESTORING' })
      expect(handler).not.toHaveBeenCalled()
    } finally {
      release()
    }
  })

  it('写队列超过等待上限回 BUSY，且排队那次不会事后执行', async () => {
    setAgentBridgeTimeoutsForTests({ writeQueueWaitMs: 30 })
    const slow = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      return { ok: true }
    })
    register('library.setProgress', slow)

    const first = callCapability('library_set_progress', { bookId: 'b1', progress: 1 }, {})
    const second = await callCapability('library_set_progress', { bookId: 'b1', progress: 2 }, {})
    expect(second).toMatchObject({ ok: false, code: 'BUSY' })
    expect(await first).toMatchObject({ ok: true })
    expect(slow).toHaveBeenCalledTimes(1)
  })

  it('路径参数在执行前被拦下：相对路径与 UNC 都不交给 handler（设计 §5.5）', async () => {
    const handler = vi.fn(async () => ({ ok: true }))
    register('library.import', handler)

    const relative = await callCapability('library_import', { filePath: 'books/a.txt' }, { dryRun: true })
    expect(relative).toMatchObject({ ok: false, code: 'BAD_ARGS' })
    const unc = await callCapability('library_import', { filePath: '\\\\nas\\share\\a.txt' }, { dryRun: true })
    expect(unc).toMatchObject({ ok: false, code: 'BAD_ARGS' })
    expect(handler).not.toHaveBeenCalled()
  })
})

/** 直连真实管道的测试客户端（与 scripts/agent-bridge-smoke.mjs 同一套线格式）。 */
class RawClient {
  responses = new Map<number, unknown>()
  closedPromise: Promise<boolean>
  #decoder: (chunk: Buffer) => void

  constructor(pipe: string) {
    let closed = false
    let notifyClosed: (() => void) | undefined
    this.closedPromise = new Promise<boolean>((resolve) => {
      notifyClosed = () => {
        if (!closed) {
          closed = true
          resolve(true)
        }
      }
    })
    const handleFrame = (value: unknown) => {
      const frame = value as { id?: number }
      if (typeof frame.id === 'number') this.responses.set(frame.id, value)
    }
    this.#decoder = createFrameDecoder(handleFrame, () => notifyClosed?.())
    this.socket = net.connect(pipe)
    this.socket.on('data', (chunk: Buffer | string) =>
      this.#decoder(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    )
    this.socket.on('close', () => notifyClosed?.())
    this.socket.on('error', () => notifyClosed?.())
  }

  socket: net.Socket

  request(frame: Record<string, unknown>, id = nextId()): Promise<BridgeDispatchResult & { id: number }> {
    return new Promise((resolve) => {
      this.responses.delete(id)
      this.socket.write(encodeFrame({ id, ...frame }))
      const started = Date.now()
      const poll = () => {
        const response = this.responses.get(id)
        if (response) return resolve(response as BridgeDispatchResult & { id: number })
        if (Date.now() - started > 5000) throw new Error('等待桥接响应超时')
        setTimeout(poll, 20)
      }
      poll()
    })
  }

  end() {
    this.socket.end()
  }
}

let idCounter = 100
function nextId(): number {
  return idCounter++
}

describe('真实管道集成（mock 掉 electron 的 app/ipcMain）', () => {
  it('未鉴权连接被拒，有效令牌完成握手、清单与门槛调用', async () => {
    await startAgentBridge()
    const infoPath = join(tempDir, 'agent-bridge.json')
    let info: { pipe?: string; token?: string } | undefined
    for (let attempt = 0; attempt < 50 && !info; attempt += 1) {
      if (existsSync(infoPath)) info = JSON.parse(readFileSync(infoPath, 'utf-8'))
      else await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(info?.pipe, '桥接信息文件应包含管道名').toBeTruthy()
    expect(info?.token, '桥接信息文件应包含令牌').toBeTruthy()

    // 无令牌：拒绝且连接被关。
    const anonymous = new RawClient(info!.pipe!)
    const rejected = await anonymous.request({ op: 'hello' })
    expect(rejected).toMatchObject({ ok: false, code: 'UNAUTHORIZED' })
    expect(await anonymous.closedPromise).toBe(true)
    anonymous.end()

    // 错误令牌：拒绝且连接被关。
    const intruder = new RawClient(info!.pipe!)
    const wrong = await intruder.request({ op: 'hello', token: 'not-the-token' })
    expect(wrong).toMatchObject({ ok: false, code: 'UNAUTHORIZED' })
    expect(await intruder.closedPromise).toBe(true)
    intruder.end()

    // 有效令牌：握手成功，能列工具；破坏性调用缺令牌被挡。
    const client = new RawClient(info!.pipe!)
    const hello = await client.request({ op: 'hello', token: info!.token })
    expect(hello.ok).toBe(true)
    const list = await client.request({ op: 'list', toolset: 'all' })
    expect(list.ok).toBe(true)
    expect((list as unknown as { tools: unknown[] }).tools.length).toBeGreaterThan(0)
    const gated = await client.request({ op: 'call', tool: 'library_purge_trash', args: {} })
    expect(gated).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' })
    client.end()

    await stopAgentBridge()
    expect(existsSync(infoPath)).toBe(false)
  }, 30_000)
})
