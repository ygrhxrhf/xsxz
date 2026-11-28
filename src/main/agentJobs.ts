/**
 * Agent 任务注册表（设计 §3.6）：把推给渲染进程的长任务事件转成可查询状态。
 *
 * 注册表不产生业务逻辑，只是 `webContents.send` 的一个旁路消费者：
 * 每条 ai.* / download.* / mirror.* 事件按 jobId 归档成状态快照，
 * 供桥接层的 job_status / job_wait / job_cancel 三个工具查询。
 * 不新增渲染进程 IPC，频道的名字与语义完全不变。
 */

import type { WebContents } from 'electron'
import type { BridgeToolInfo } from './agentBridgeCore'

type AgentJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

interface AgentJobSnapshot {
  jobId: string
  kind: 'ai' | 'download' | 'mirror'
  state: AgentJobState
  stage?: string
  progress?: unknown
  awaitingHuman?: boolean
  message?: string
  /** AI 流式文本的累计（上限 64 KiB，超出只保留头尾）。 */
  text?: string
  truncated?: boolean
  /** 终态时附带完整事件载荷（ai.done 的 citations / saveToken 等）。 */
  result?: unknown
  updatedAt: string
}

interface AgentJob extends AgentJobSnapshot {
  terminalAt?: number
}

const MAX_TEXT = 64 * 1024
const KEEP_HEAD = 32 * 1024
const MAX_JOBS = 200
const TERMINAL_TTL_MS = 30 * 60 * 1000
const POLL_MS = 200
const WAIT_DEFAULT_MS = 30_000
const WAIT_MAX_MS = 120_000

const jobs = new Map<string, AgentJob>()

function now(): number {
  return Date.now()
}

function snapshot(job: AgentJob): AgentJobSnapshot {
  const { terminalAt, ...rest } = job
  return rest
}

function upsert(jobId: string, kind: AgentJob['kind'], patch: Partial<AgentJob>): void {
  const existing = jobs.get(jobId)
  const job: AgentJob = existing ?? {
    jobId, kind, state: 'running', text: '', truncated: false, updatedAt: new Date().toISOString(),
  }
  Object.assign(job, patch, { kind, jobId })
  job.updatedAt = new Date().toISOString()
  // LRU：删了再插，让 Map 的插入序就是最近使用序。
  jobs.delete(jobId)
  jobs.set(jobId, job)
  evict(now())
}

/** 终态保留 30 分钟，总量超过 200 条按最久未更新淘汰。 */
function evict(nowMs: number): void {
  for (const [id, job] of jobs) {
    if (isTerminal(job.state) && job.terminalAt !== undefined && nowMs - job.terminalAt > TERMINAL_TTL_MS) {
      jobs.delete(id)
    }
  }
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value
    if (oldest === undefined) break
    jobs.delete(oldest)
  }
}

function isTerminal(state: AgentJobState): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled'
}

/** 累积流式文本：超过 64 KiB 只保留头尾，并打 truncated 标记。 */
function appendChunk(job: AgentJob, delta: string): void {
  const current = job.text ?? ''
  if (current.length + delta.length <= MAX_TEXT) {
    job.text = current + delta
    return
  }
  const merged = current + delta
  const head = merged.slice(0, KEEP_HEAD)
  const tail = merged.slice(-KEEP_HEAD)
  job.text = `${head}\n…[中间内容被截断]…\n${tail}`
  job.truncated = true
}

function jobIdOf(payload: Record<string, unknown>, fallback: string): string {
  return typeof payload.jobId === 'string' && payload.jobId ? payload.jobId : fallback
}

/**
 * 事件入口：只认识已知的推送频道，其它一律忽略。
 * payload 形状以 `docs/ipc-contract.md` 的主→渲染表为准。
 */
export function recordJobEvent(channel: string, payload: unknown): void {
  if (!payload || typeof payload !== 'object') return
  const data = payload as Record<string, unknown>
  switch (channel) {
    case 'ai.stage': {
      const jobId = jobIdOf(data, '')
      if (!jobId) return
      upsert(jobId, 'ai', {
        state: data.stage === 'queued' ? 'queued' : 'running',
        stage: typeof data.stage === 'string' ? data.stage : undefined,
        message: typeof data.detail === 'string' ? data.detail : undefined,
      })
      return
    }
    case 'ai.chunk': {
      const jobId = jobIdOf(data, '')
      if (!jobId || typeof data.delta !== 'string') return
      const existing = jobs.get(jobId)
      upsert(jobId, 'ai', {})
      const job = jobs.get(jobId)
      if (!job) return
      if (existing?.text !== undefined) appendChunk(job, data.delta)
      else job.text = data.delta.slice(0, MAX_TEXT)
      return
    }
    case 'ai.done': {
      const jobId = jobIdOf(data, '')
      if (!jobId) return
      const message = typeof data.message === 'string' ? data.message : undefined
      const state: AgentJobState = data.ok === true ? 'done' : message === '已从队列取消' ? 'cancelled' : 'failed'
      const terminalAt = now()
      upsert(jobId, 'ai', { state, message, result: data, terminalAt })
      return
    }
    case 'ai.budget': {
      const jobId = jobIdOf(data, '')
      if (!jobId) return
      upsert(jobId, 'ai', { progress: data.budget })
      return
    }
    case 'download.progress': {
      const jobId = jobIdOf(data, typeof data.bookId === 'string' ? `download:${data.bookId}` : 'download')
      upsert(jobId, 'download', { state: 'running', progress: data })
      return
    }
    case 'download.blocked': {
      const jobId = jobIdOf(data, typeof data.bookId === 'string' ? `download:${data.bookId}` : 'download')
      upsert(jobId, 'download', {
        state: 'running',
        awaitingHuman: true,
        message: typeof data.message === 'string' ? data.message : undefined,
        progress: data,
      })
      return
    }
    case 'mirror.progress': {
      upsert(jobIdOf(data, 'mirror'), 'mirror', { state: 'running', progress: data })
      return
    }
    default:
  }
}

/**
 * 把一个 webContents 的 send 变成注册表的数据源。
 * 在 createWindow 里对主窗口调用一次即可：ai.* / download.* / mirror.*
 * 的推送都经过主窗口（download.ts 经 ownerWindow，mirror.progress 同）。
 */
export function installJobEventTap(wc: WebContents): void {
  if ((wc as { __spbfJobTap?: boolean }).__spbfJobTap) return
  ;(wc as { __spbfJobTap?: boolean }).__spbfJobTap = true
  const original = wc.send.bind(wc)
  wc.send = (channel: string, ...args: unknown[]) => {
    try {
      recordJobEvent(channel, args[0])
    } catch {
      // 审计旁路绝不影响正常推送。
    }
    return original(channel, ...(args as [unknown]))
  }
}

/** 仅供测试：清空注册表。 */
export function resetAgentJobsForTests(): void {
  jobs.clear()
}

export function agentJobStatus(jobId: string): AgentJobSnapshot | undefined {
  const job = jobs.get(jobId)
  if (!job) return undefined
  evict(now())
  return snapshot(jobs.get(jobId) ?? job)
}

/** 阻塞至终态或超时；超时返回当前快照（state 仍为 running），不报错。 */
export async function agentJobWait(jobId: string, timeoutMs = WAIT_DEFAULT_MS): Promise<AgentJobSnapshot | undefined> {
  const deadline = now() + Math.min(Math.max(timeoutMs, 0), WAIT_MAX_MS)
  for (;;) {
    const status = agentJobStatus(jobId)
    if (!status) return undefined
    if (isTerminal(status.state) || now() >= deadline) return status
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/** job_cancel 的落点：按任务类型映射到既有频道（不新增 IPC）。 */
export async function agentJobCancel(
  jobId: string,
  invoke: (channel: string, args: unknown) => Promise<unknown>,
): Promise<{ ok: boolean; message?: string }> {
  const status = agentJobStatus(jobId)
  const kind = status?.kind ?? (/^download:/.test(jobId) ? 'download' : jobId === 'mirror' ? 'mirror' : 'ai')
  const [channel, args] = kind === 'download'
    ? ['download.cancel', { bookId: jobId.slice('download:'.length) }]
    : kind === 'mirror' ? ['mirror.cancel', {}] : ['ai.cancel', { jobId }]
  try {
    const result = await invoke(channel, args) as { ok?: boolean; message?: string } | undefined
    if (result && result.ok === false) return { ok: false, message: result.message }
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 桥接层的三个 agent 专用工具：不在能力清单里，core 与 all 工具集都带。 */
export const AGENT_JOB_TOOLS: readonly BridgeToolInfo[] = [
  {
    channel: 'bridge.job.status',
    tool: 'job_status',
    title: '查询长任务状态',
    description: '按 jobId 查询 AI 生成、下载或镜像任务的状态、阶段与累计文本。轮询进度的首选。',
    tier: 'read',
    confirm: 'none',
    deps: [],
    params: { type: 'object', properties: { jobId: { type: 'string', description: '任务 ID（由 ai.chatStream / mirror.start 等返回）' } }, required: ['jobId'] },
    result: "{ ok: true; job: AgentJobSnapshot } 或 { ok: false; code: 'NOT_FOUND' }",
    coreToolset: true,
  },
  {
    channel: 'bridge.job.wait',
    tool: 'job_wait',
    title: '等待长任务结束',
    description: '阻塞至任务到终态或超时；超时返回 state=running 的快照而不是错误。终态时附带完整结果载荷。',
    tier: 'read',
    confirm: 'none',
    deps: [],
    params: {
      type: 'object',
      properties: { jobId: { type: 'string', description: '任务 ID' }, timeoutMs: { type: 'number', description: '最长等待毫秒数，≤ 120000，默认 30000' } },
      required: ['jobId'],
    },
    result: '{ ok: true; job: AgentJobSnapshot; timedOut?: boolean }',
    coreToolset: true,
  },
  {
    channel: 'bridge.job.cancel',
    tool: 'job_cancel',
    title: '取消长任务',
    description: '按任务类型转发到 ai.cancel / download.cancel / mirror.cancel。成功后任务收到取消事件。',
    tier: 'write',
    confirm: 'none',
    deps: [],
    params: { type: 'object', properties: { jobId: { type: 'string', description: '任务 ID' } }, required: ['jobId'] },
    result: '{ ok: true } 或 { ok: false; message }',
    coreToolset: true,
  },
]

export function agentJobTool(tool: string): BridgeToolInfo | undefined {
  return AGENT_JOB_TOOLS.find((def) => def.tool === tool)
}
