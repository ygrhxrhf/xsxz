/**
 * Agent 桥接的 Electron 侧：命名管道服务器、令牌文件、能力分发。
 *
 * - 只监听命名管道，不占 TCP 端口。Node 无法自定义管道 DACL（nodejs/node#47086），
 *   所以"能连上"不等于"能调用"：首帧必须带令牌，见 agentBridgeCore。
 * - 令牌每次启动随机生成，写入 userData/agent-bridge.json（仅当前用户可读），
 *   同一管道名连续 5 次鉴权失败就轮换令牌并重建管道，防暴力猜。
 * - 分发复用既有 ipcMain handler：安装期包一层注册表，handler 体不动，
 *   因此 agent 与界面跑的是同一段业务逻辑。
 * - Key 边界：settings_get 的返回值剥掉所有 *Enc 密文；settings_set 与 ai_test
 *   拒绝携带任何 Key/密码字段。明文 Key 从不出主进程，也不经 MCP 返回。
 */

import { app, ipcMain } from 'electron'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:net'
import { createServer } from 'node:net'
import { join } from 'node:path'
import {
  capabilityForTool,
  capabilitiesForToolset,
  type ToolsetName,
} from '../shared/agentCapabilities'
import {
  createBridgeSession,
  encodeFrame,
  stableStringify,
  type BridgeDispatchResult,
  type BridgeSession,
  type BridgeToolInfo,
  type BridgeToolset,
} from './agentBridgeCore'
import { AGENT_JOB_TOOLS, agentJobCancel, agentJobStatus, agentJobTool, agentJobWait } from './agentJobs'
import { recordAgentAudit } from './agentAudit'
import { validateAgentPaths } from './agentPaths'
import { isLibraryRestoring } from './libraryMaintenance'

const AUTH_FAILURE_LIMIT = 5
const CONFIRM_TOKEN_TTL_MS_DEFAULT = 10 * 60 * 1000
const WRITE_QUEUE_WAIT_MS_DEFAULT = 120_000

/** 这两个上限只在测试里缩短；生产值见上面的常量（设计 §5.2、§6.3）。 */
let confirmTokenTtlMs = CONFIRM_TOKEN_TTL_MS_DEFAULT
let writeQueueWaitMs = WRITE_QUEUE_WAIT_MS_DEFAULT

export function setAgentBridgeTimeoutsForTests(options: {
  confirmTtlMs?: number
  writeQueueWaitMs?: number
}): void {
  if (options.confirmTtlMs !== undefined) confirmTokenTtlMs = options.confirmTtlMs
  if (options.writeQueueWaitMs !== undefined) writeQueueWaitMs = options.writeQueueWaitMs
}

/** 调用方不得提交的设置字段：Key 与代理密码只能由用户在界面里改。 */
const FORBIDDEN_SETTING_KEYS = [
  'apiKey',
  'embeddingApiKey',
  'ttsApiKey',
  'tierSenseApiKey',
  'proxyPassword',
]

const handlerRegistry = new Map<string, unknown>()
const confirmTokens = new Map<string, { tool: string; argsHash: string; expires: number }>()
let registryInstalled = false

/** 当前连接的客户端标识（hello 里带的 client.name），只进审计，不进业务。 */
let activeClient = 'unknown'

interface BridgeState {
  server?: Server
  session?: BridgeSession
  pipeName?: string
  token?: string
  authFailures: number
}

const state: BridgeState = { authFailures: 0 }

/**
 * 让既有 `ipcMain.handle(频道, 处理器)` 的调用同时登记进注册表。
 * 必须在 `registerIpc()` 之前调用；handler 体不动，
 * preload 契约测试依赖的 `ipcMain.handle('<频道>'` 源码文本也原样保留。
 */
export function installAgentRegistry(): void {
  if (registryInstalled) return
  registryInstalled = true
  const ipc = ipcMain as unknown as {
    handle: (channel: string, listener: (event: unknown, payload: unknown) => unknown) => void
  }
  const original = ipc.handle.bind(ipcMain)
  ipc.handle = (channel, listener) => {
    handlerRegistry.set(channel, listener)
    return original(channel, listener)
  }
}

/** handler 都忽略 event 参数；桥接调用没有真实 sender，给最小占位。 */
const STUB_EVENT = { sender: null }

function stableArgsHash(args: unknown): string {
  return createHash('sha256').update(stableStringify(args)).digest('hex')
}

function issueConfirmToken(tool: string, args: unknown): string {
  const token = randomBytes(24).toString('hex')
  confirmTokens.set(token, { tool, argsHash: stableArgsHash(args), expires: Date.now() + confirmTokenTtlMs })
  // 过期令牌多留一个 TTL 再清：这样"用得太晚"能报成 TOKEN_EXPIRED，
  // 而不是和"猜的令牌"一起混成 CONFIRM_REQUIRED（设计 §3.3）。
  const now = Date.now()
  for (const [key, entry] of confirmTokens) {
    if (entry.expires + confirmTokenTtlMs < now) confirmTokens.delete(key)
  }
  return token
}

type ConfirmOutcome = 'ok' | 'invalid' | 'expired'

function consumeConfirmToken(tool: string, token: string, args: unknown): ConfirmOutcome {
  const entry = confirmTokens.get(token)
  if (!entry) return 'invalid'
  if (entry.tool !== tool || entry.argsHash !== stableArgsHash(args)) {
    confirmTokens.delete(token)
    return 'invalid'
  }
  if (entry.expires <= Date.now()) {
    confirmTokens.delete(token)
    return 'expired'
  }
  confirmTokens.delete(token)
  return 'ok'
}

/** settings.get 的返回值进白名单：密文字段与任何明文凭据字段一律剥掉。 */
export function sanitizeSettingsPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSettingsPayload)
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/Enc$/.test(key) || FORBIDDEN_SETTING_KEYS.includes(key)) continue
      output[key] = sanitizeSettingsPayload(item)
    }
    return output
  }
  return value
}

function carriesForbiddenCredential(args: Record<string, unknown>): string | null {
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_SETTING_KEYS.includes(key)) return key
  }
  return null
}

async function invokeHandler(channel: string, args: unknown): Promise<BridgeDispatchResult> {
  const handler = handlerRegistry.get(channel)
  if (!handler) return { ok: false, code: 'NOT_REGISTERED', message: `频道未注册：${channel}` }
  try {
    const data = await (handler as (event: unknown, payload: unknown) => unknown)(STUB_EVENT, args)
    const payload = channel === 'settings.get' ? sanitizeSettingsPayload(data) : data
    return upstreamFailure(payload) ?? { ok: true, data: payload }
  } catch (error) {
    return {
      ok: false,
      code: 'UPSTREAM_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 业务 handler 用 `{ok:false, message}` 表达失败：桥接必须原样报错，
 * 不能包成成功（设计 §3.7：不把失败翻译成"成功但空"）。
 * 下载类失败原因在 `failCode` 里，优先透出它作为 code。
 */
function upstreamFailure(payload: unknown): BridgeDispatchResult | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as { ok?: unknown; code?: unknown; failCode?: unknown; message?: unknown }
  if (record.ok !== false) return null
  const code =
    typeof record.code === 'string' && record.code
      ? record.code
      : typeof record.failCode === 'string' && record.failCode
        ? record.failCode
        : 'UPSTREAM_FAILED'
  return {
    ok: false,
    code,
    message: typeof record.message === 'string' && record.message ? record.message : '调用失败',
    data: payload,
  }
}

// 写操作全局串行：书库的单写者约束要求 agent 与界面不会并发写（设计 §6.3）。
// 排队超过上限返回 BUSY 并取消这次执行——先告诉调用方"忙"、事后又偷偷执行，
// 等于让一个已放弃的请求产生副作用。
let writeTail: Promise<unknown> = Promise.resolve()
const writeQueue: Array<{ tool: string; cancelled: boolean }> = []

function enqueueWrite(tool: string, work: () => Promise<BridgeDispatchResult>): Promise<BridgeDispatchResult> {
  const entry = { tool, cancelled: false }
  writeQueue.push(entry)
  const busy = (): BridgeDispatchResult => ({
    ok: false,
    code: 'BUSY',
    message: `写队列繁忙：当前正在执行 ${writeQueue[0]?.tool ?? '未知任务'}`,
    hint: '等当前写操作结束后重试；不要重复提交同一操作',
  })
  return new Promise<BridgeDispatchResult>((resolve) => {
    // 计时只管"排队等多久"：一旦轮到本次执行，写操作本身可以更长（下载、备份都远超 120s）。
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      entry.cancelled = true
      resolve(busy())
    }, writeQueueWaitMs)
    const run = () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      return entry.cancelled ? Promise.resolve(busy()) : work()
    }
    const next = writeTail.then(run, run)
    writeTail = next.then(() => {}, () => {})
    next.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        resolve({ ok: false, code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) })
      },
    )
  }).finally(() => {
    const index = writeQueue.indexOf(entry)
    if (index >= 0) writeQueue.splice(index, 1)
  })
}

/** 审计包装：所有经桥接的工具调用都记一行；参数只留哈希前缀，不留值。 */
export async function callCapability(
  tool: string,
  rawArgs: unknown,
  options: { dryRun?: boolean; confirmToken?: string },
): Promise<BridgeDispatchResult> {
  const startedAt = Date.now()
  const result = await dispatchCapability(tool, rawArgs, options)
  const capability = capabilityForTool(tool)
  await recordAgentAudit({
    ts: new Date().toISOString(),
    client: activeClient,
    tool,
    channel: capability?.channel ?? '',
    tier: capability?.tier ?? 'unknown',
    dryRun: options.dryRun === true,
    confirmed: result.ok && (options.dryRun === true || options.confirmToken !== undefined),
    ok: result.ok,
    ...(result.code ? { code: result.code } : {}),
    ms: Date.now() - startedAt,
    argsHash: createHash('sha256').update(stableStringify(rawArgs ?? {})).digest('hex').slice(0, 16),
  })
  return result
}

async function dispatchCapability(
  tool: string,
  rawArgs: unknown,
  options: { dryRun?: boolean; confirmToken?: string },
): Promise<BridgeDispatchResult> {
  const capability = capabilityForTool(tool)
  // job_* 是桥接层工具：元数据取自注册表模块，不查能力清单。
  const jobTool = agentJobTool(tool)
  const meta = capability ?? jobTool
  if (!meta) return { ok: false, code: 'UNKNOWN_TOOL', message: `未知工具：${tool}` }

  // dryRun / confirmToken 是桥接层的公共参数，不属于业务参数：必须从 args 里剔掉
  // 再算哈希，否则「dryRun 拿令牌 → 带 confirmToken 重发」会因 args 变化而令牌失效。
  const argsObject = { ...((rawArgs ?? {}) as Record<string, unknown>) }
  delete argsObject.dryRun
  delete argsObject.confirmToken
  if (tool === 'ai_test') {
    const forbidden = carriesForbiddenCredential(argsObject)
    if (forbidden) {
      return {
        ok: false,
        code: 'BAD_ARGS',
        message: '不允许通过 agent 提交 apiKey；请先在应用设置里配置',
        hint: '去掉 apiKey 字段后重试，将使用已保存的 Key',
      }
    }
  }
  if (tool === 'settings_set') {
    const forbidden = carriesForbiddenCredential(argsObject)
    if (forbidden) {
      return {
        ok: false,
        code: 'BAD_ARGS',
        message: `不允许通过 agent 修改 ${forbidden}；请在应用设置里操作`,
      }
    }
  }

  // 路径参数统一预检（设计 §5.5）：dryRun 也走这一步，agent 在拿令牌之前就能
  // 知道路径不可用，而不是拿到令牌、执行到一半才失败。
  const pathIssues = await validateAgentPaths(argsObject)
  if (pathIssues.length > 0) {
    return {
      ok: false,
      code: 'BAD_ARGS',
      message: pathIssues.map((issue) => issue.message).join('；'),
      hint: '路径必须是被调用方给出的绝对路径；不接受设备路径或 UNC 网络路径',
    }
  }

  if (options.dryRun) {
    const plan = { tool, channel: meta.channel, tier: meta.tier, args: argsObject }
    const confirmToken = meta.tier === 'read' ? undefined : issueConfirmToken(tool, argsObject)
    return { ok: true, plan, ...(confirmToken ? { confirmToken } : {}) }
  }

  // 门槛看两点：破坏性分级，或清单里标了任何确认方式。两者都要求
  // 先 dryRun 拿一次性令牌再执行——令牌就是给 agent 的显式确认参数。
  const needsConfirm = meta.tier === 'destructive' || meta.confirm !== 'none'
  if (needsConfirm) {
    const outcome = options.confirmToken
      ? consumeConfirmToken(tool, options.confirmToken, argsObject)
      : 'invalid'
    if (outcome !== 'ok') {
      return {
        ok: false,
        code: outcome === 'expired' ? 'TOKEN_EXPIRED' : 'CONFIRM_REQUIRED',
        message:
          outcome === 'expired'
            ? '确认令牌已过期，请重新 dryRun 获取'
            : '破坏性操作必须先 dryRun 获取一次性令牌，再携带 confirmToken 执行',
        hint: '先对同一工具、同一参数调用 dryRun:true，取得 plan 与 confirmToken',
        plan: { tool, channel: meta.channel, tier: meta.tier },
      }
    }
  }

  // job_* 不落 handler：状态查询/等待在注册表，取消按类型转发到真实频道。
  if (jobTool) return runJobTool(tool, argsObject)

  // 恢复期间的写请求直接报 LIBRARY_RESTORING，不进队列：排队会让 agent 以为卡死，
  // 而恢复是整库交换，写进去的内容本来也会落在被丢弃的旧库上（设计 §6.3）。
  if (capability!.tier !== 'read' && isLibraryRestoring()) {
    return {
      ok: false,
      code: 'LIBRARY_RESTORING',
      message: '书库正在恢复或迁移，暂时不能写入',
      hint: '等恢复结束后重试；此前发起的写请求不会被执行',
    }
  }

  const run = () => invokeHandler(capability!.channel, argsObject)
  return capability!.tier === 'read' ? run() : enqueueWrite(tool, run)
}

function runJobTool(tool: string, args: Record<string, unknown>): Promise<BridgeDispatchResult> {
  const jobId = typeof args.jobId === 'string' ? args.jobId : ''
  if (!jobId) return Promise.resolve({ ok: false, code: 'BAD_ARGS', message: 'jobId 必须是非空字符串' })
  if (tool === 'job_status') {
    const job = agentJobStatus(jobId)
    return Promise.resolve(job
      ? { ok: true, data: { job } }
      : { ok: false, code: 'NOT_FOUND', message: `找不到任务 ${jobId}（可能已按保留期淘汰）` })
  }
  if (tool === 'job_wait') {
    const timeoutMs = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined
    return agentJobWait(jobId, timeoutMs).then((job) => job
      ? { ok: true, data: { job, ...(isRunning(job.state) ? { timedOut: true } : {}) } }
      : { ok: false, code: 'NOT_FOUND', message: `找不到任务 ${jobId}（可能已按保留期淘汰）` })
  }
  return agentJobCancel(jobId, invokeHandler).then((result) =>
    result.ok ? { ok: true, data: { ok: true } } : { ok: false, code: 'CANCEL_FAILED', message: result.message })
}

function isRunning(state: string): boolean {
  return state === 'running' || state === 'queued'
}

function toolsFor(toolset: BridgeToolset): BridgeToolInfo[] {
  const capabilityTools = capabilitiesForToolset(toolset as ToolsetName).map((capability) => ({
    channel: capability.channel,
    tool: capability.tool!,
    title: capability.title,
    description: capability.description,
    tier: capability.tier,
    confirm: capability.confirm,
    deps: [...capability.deps],
    params: capability.params,
    result: capability.result,
    coreToolset: capability.coreToolset,
  }))
  // job_* 是桥接层工具（不在能力清单里）：设计 §8.1 明确 core 数量之外另加这三个。
  return [...capabilityTools, ...AGENT_JOB_TOOLS]
}

function bridgeInfoPath(): string {
  const override = process.env.SPBF_AGENT_BRIDGE_INFO
  return override || join(app.getPath('userData'), 'agent-bridge.json')
}

async function writeBridgeInfo(): Promise<void> {
  const info = {
    version: 1,
    pipe: state.pipeName,
    token: state.token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }
  await writeFile(bridgeInfoPath(), JSON.stringify(info, null, 2), 'utf-8')
}

function pipeNameFor(): string {
  const override = process.env.SPBF_AGENT_PIPE
  if (override) return override
  return `\\\\.\\pipe\\spbf-agent-${randomBytes(16).toString('hex')}`
}

function rotateCredentials(): void {
  state.authFailures = 0
  state.token = randomBytes(32).toString('hex')
  state.pipeName = pipeNameFor()
  state.server?.close()
  listen()
  void writeBridgeInfo().catch((error) => {
    console.error('无法更新 agent-bridge.json：', error)
  })
}

function listen(): void {
  const server = createServer((socket) => {
    const session = createBridgeSession({
      host: { tools: toolsFor, call: callCapability },
      // 常量时间比较：先比长度（timingSafeEqual 要求等长），再逐字节比。
      verifyToken: (candidate) => {
        if (typeof candidate !== 'string' || !state.token) return false
        const provided = Buffer.from(candidate, 'utf-8')
        const expected = Buffer.from(state.token, 'utf-8')
        return provided.length === expected.length && timingSafeEqual(provided, expected)
      },
      onHello: (frame) => {
        // 设计写的是"连续 5 次失败"：一次成功握手就把计数清零，否则长时间运行会
        // 被历史失败慢慢攒到阈值，把一次误配当成攻击。
        state.authFailures = 0
        const client = frame.client
        activeClient = client && typeof client === 'object' && 'name' in client
          ? String((client as { name: unknown }).name).slice(0, 80)
          : 'unknown'
      },
      onAuthFailure: () => {
        state.authFailures += 1
        if (state.authFailures >= AUTH_FAILURE_LIMIT) rotateCredentials()
      },
      onSend: (data) => socket.write(encodeFrame(data)),
      onClose: () => socket.end(),
    })
    socket.on('data', (chunk: Buffer | string) => session.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    socket.on('error', () => session?.end())
    socket.on('close', () => session?.end())
  })
  state.server = server
  server.listen(state.pipeName)
}

/** 应用就绪后调用：建管道、写令牌文件。设置 SPBF_DISABLE_AGENT_BRIDGE 可整体关闭。 */
export async function startAgentBridge(): Promise<void> {
  if (process.env.SPBF_DISABLE_AGENT_BRIDGE) return
  state.authFailures = 0
  state.token = randomBytes(32).toString('hex')
  state.pipeName = pipeNameFor()
  listen()
  try {
    await writeBridgeInfo()
  } catch (error) {
    console.error('无法写 agent-bridge.json，agent 桥接不可用：', error)
  }
}

/** 退出前调用：关服务器、删令牌文件，避免留下指向已死进程的信息。 */
export async function stopAgentBridge(): Promise<void> {
  state.server?.close()
  state.server = undefined
  confirmTokens.clear()
  try {
    await rm(bridgeInfoPath(), { force: true })
  } catch {
    // 文件已不存在或被占用都不阻塞退出。
  }
}

/** 仅供测试：直接驱动注册表里的 handler。 */
export async function invokeRegisteredHandler(channel: string, args: unknown): Promise<unknown> {
  const handler = handlerRegistry.get(channel)
  if (!handler) throw new Error(`频道未注册：${channel}`)
  return (handler as (event: unknown, payload: unknown) => unknown)(STUB_EVENT, args)
}
