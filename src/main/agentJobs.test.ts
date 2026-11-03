import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOB_TOOLS,
  agentJobStatus,
  agentJobWait,
  agentJobCancel,
  installJobEventTap,
  recordJobEvent,
  resetAgentJobsForTests,
} from './agentJobs'

function tap(): { sent: Array<{ channel: string; payload: unknown }> } {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const wc = {
    __spbfJobTap: false,
    send(channel: string, payload?: unknown) {
      sent.push({ channel, payload })
    },
  } as never
  installJobEventTap(wc)
  return { sent }
}

describe('agent 任务注册表', () => {
  it('ai 事件驱动状态机：stage → chunk → done，done 带完整载荷', async () => {
    resetAgentJobsForTests()
    recordJobEvent('ai.stage', { jobId: 'j1', stage: 'queued', detail: '排队中' })
    expect(agentJobStatus('j1')).toMatchObject({ state: 'queued', stage: 'queued' })

    recordJobEvent('ai.stage', { jobId: 'j1', stage: 'requesting', detail: '生成中' })
    recordJobEvent('ai.chunk', { jobId: 'j1', delta: '你好' })
    recordJobEvent('ai.done', { jobId: 'j1', ok: true, text: '你好', citations: [{ id: 'c1' }] })

    const job = agentJobStatus('j1')
    expect(job).toMatchObject({ state: 'done', kind: 'ai', text: '你好' })
    expect(job?.result).toMatchObject({ ok: true, citations: [{ id: 'c1' }] })
  })

  it('ok:false 且不是队列取消记为 failed；队列取消记为 cancelled', () => {
    resetAgentJobsForTests()
    recordJobEvent('ai.done', { jobId: 'j2', ok: false, message: '服务超时' })
    recordJobEvent('ai.done', { jobId: 'j3', ok: false, message: '已从队列取消' })
    expect(agentJobStatus('j2')?.state).toBe('failed')
    expect(agentJobStatus('j3')?.state).toBe('cancelled')
  })

  it('流式文本超 64 KiB 只保留头尾并标记 truncated', () => {
    resetAgentJobsForTests()
    const piece = 'x'.repeat(40 * 1024)
    recordJobEvent('ai.chunk', { jobId: 'j4', delta: piece })
    recordJobEvent('ai.chunk', { jobId: 'j4', delta: piece })
    const job = agentJobStatus('j4')
    expect(job?.truncated).toBe(true)
    expect(job?.text?.length).toBeLessThanOrEqual(64 * 1024 + 64)
    expect(job?.text).toContain('中间内容被截断')
  })

  it('download.blocked 呈 awaitingHuman；download/mirror 按 kind 落点', () => {
    resetAgentJobsForTests()
    recordJobEvent('download.blocked', { bookId: 'b1', url: 'https://x/y', message: '需要登录' })
    recordJobEvent('mirror.progress', { jobId: 'm1', done: 3 })
    expect(agentJobStatus('download:b1')).toMatchObject({ kind: 'download', awaitingHuman: true, message: '需要登录' })
    expect(agentJobStatus('m1')).toMatchObject({ kind: 'mirror', state: 'running' })
  })

  it('未知频道与非对象载荷被忽略，不影响原推送', () => {
    resetAgentJobsForTests()
    const { sent } = tap()
    recordJobEvent('ai.memoryUpdated', { bookId: 'b' })
    recordJobEvent('ai.chunk', '不是对象')
    expect(agentJobStatus('b')).toBeUndefined()
    expect(sent).toEqual([])
  })

  it('job_wait 到终态返回；超时返回 running 快照而不是错误', async () => {
    resetAgentJobsForTests()
    recordJobEvent('ai.stage', { jobId: 'w1', stage: 'requesting' })
    setTimeout(() => recordJobEvent('ai.done', { jobId: 'w1', ok: true, text: '完成' }), 300)
    const done = await agentJobWait('w1', 5000)
    expect(done?.state).toBe('done')

    recordJobEvent('ai.stage', { jobId: 'w2', stage: 'requesting' })
    const timedOut = await agentJobWait('w2', 450)
    expect(timedOut?.state).toBe('running')
  }, 10000)

  it('job_wait 查不到任务返回 undefined', async () => {
    resetAgentJobsForTests()
    await expect(agentJobWait('nope', 100)).resolves.toBeUndefined()
  })

  it('job_cancel 按任务类型转发：ai / download / mirror', async () => {
    resetAgentJobsForTests()
    recordJobEvent('download.progress', { bookId: 'b9' })
    const calls: Array<[string, unknown]> = []
    const invoke = async (channel: string, args: unknown) => {
      calls.push([channel, args])
      return { ok: true }
    }
    await agentJobCancel('ai-job-1', invoke)
    await agentJobCancel('download:b9', invoke)
    await agentJobCancel('mirror', invoke)
    expect(calls).toEqual([
      ['ai.cancel', { jobId: 'ai-job-1' }],
      ['download.cancel', { bookId: 'b9' }],
      ['mirror.cancel', {}],
    ])
    await expect(agentJobCancel('x', async () => ({ ok: false, message: '没有在跑的任务' }))).resolves.toMatchObject({ ok: false })
  })

  it('终态任务超 200 条按最久未更新淘汰', () => {
    resetAgentJobsForTests()
    for (let i = 0; i < 260; i += 1) recordJobEvent('ai.done', { jobId: `bulk-${i}`, ok: true })
    expect(agentJobStatus('bulk-0')).toBeUndefined()
    expect(agentJobStatus('bulk-259')).toMatchObject({ state: 'done' })
  })

  it('三个工具定义：schema 必填 jobId、分级正确、core 与 all 都带', () => {
    expect(AGENT_JOB_TOOLS.map((tool) => tool.tool)).toEqual(['job_status', 'job_wait', 'job_cancel'])
    for (const tool of AGENT_JOB_TOOLS) {
      expect((tool.params as { required?: string[] }).required).toContain('jobId')
    }
    expect(AGENT_JOB_TOOLS.filter((tool) => tool.tier === 'write').map((tool) => tool.tool)).toEqual(['job_cancel'])
    expect(AGENT_JOB_TOOLS.every((tool) => tool.coreToolset)).toBe(true)
  })

  it('tap 不改变 send 行为，只旁路记录', () => {
    resetAgentJobsForTests()
    const { sent } = tap()
    const originalSend = vi.fn()
    const wc = { __spbfJobTap: false, send: originalSend } as never
    installJobEventTap(wc)
    ;(wc as unknown as { send: (channel: string, payload: unknown) => void }).send('ai.stage', { jobId: 'tap1', stage: 'queued' })
    expect(originalSend).toHaveBeenCalledWith('ai.stage', { jobId: 'tap1', stage: 'queued' })
    expect(agentJobStatus('tap1')).toMatchObject({ state: 'queued' })
    expect(sent).toEqual([])
  })
})
