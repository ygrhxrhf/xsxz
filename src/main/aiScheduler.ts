import type { AiJobStart } from '../shared/types'

/**
 * interactive = 用户亲自点开的任务；background = 概览、追剧、索引这类自动任务。
 * 两条车道各并发 1，后台车道必须等交互车道完全空闲才取活。
 */
export type AiLane = 'interactive' | 'background'

export interface AiJobPolicy {
  lane: AiLane
  /** 记忆、追剧、笔记等整文件替换写入共享同一资源键，交错执行会丢写。 */
  resource?: string
  bookId?: string
  cls?: string
  /** 仅 start 生效：同一 bookId + 类别 + 章节重复提交时复用已在跑或已在排队的工作。 */
  dedupeKey?: string
  /** 排队期间被取消不会有模型结果，调用方必须补发终态，否则界面永远转圈。 */
  onCancelled?: (jobId: string) => void
}

/**
 * 队列不再拒绝，所以排队信息挂在成功分支上；失败仍只由调用方自己的前置检查给出。
 * `position` 是同车道等待队列里的位次（从 1 开始），已经开跑则为 0。
 */
export type AiStartResult = Extract<AiJobStart, { ok: true }> & { queued: boolean; position: number }

export type AiExclusiveResult<T> = { ok: true; value: T } | { ok: false; message: string }

type QueueRunner = (jobId: string, signal: AbortSignal) => Promise<unknown>

interface QueueEntry {
  jobId: string
  policy: AiJobPolicy
  run: QueueRunner
  controller: AbortController
  started: boolean
  outcome: Promise<AiExclusiveResult<unknown>>
  resolve: (result: AiExclusiveResult<unknown>) => void
  /** 模型错误必须原样抛给等待方，由频道自己的中文文案接住，队列不得替换成通用失败。 */
  reject: (error: unknown) => void
}

let nextQueueJobId = 0

export function createAiJobId(): string {
  return `ai-${Date.now()}-${++nextQueueJobId}`
}

const CANCELLED_WHILE_QUEUED = '已从队列取消'

/** 主进程 AI 车道队列：只排队，不再因为「已有任务」直接拒绝。 */
export class AiQueue {
  private readonly waiting: QueueEntry[] = []
  private readonly running = new Map<AiLane, QueueEntry>()

  start(run: QueueRunner, policy: AiJobPolicy = { lane: 'interactive' }): AiStartResult {
    const existing = this.find(policy.dedupeKey)
    if (existing) return this.describe(existing)
    const entry = this.createEntry(run, policy)
    this.waiting.push(entry)
    this.pump()
    return this.describe(entry)
  }

  async runExclusive<T>(
    run: (signal: AbortSignal, jobId: string) => Promise<T>,
    policy: AiJobPolicy = { lane: 'interactive' },
  ): Promise<AiExclusiveResult<T>> {
    // 连点同一个独占任务时复用已在跑或已在排队的那个结果，不再重复花额度；dedupeKey 必须含类别名以免串到别的任务。
    const existing = this.find(policy.dedupeKey)
    if (existing) return await existing.outcome as AiExclusiveResult<T>
    const entry = this.createEntry(
      (jobId, signal) => run(signal, jobId).then((value) => { entry.resolve({ ok: true, value }) }),
      policy,
    )
    this.waiting.push(entry)
    this.pump()
    // 该 entry 的成功分支只会写入上面的 value: T，因此可以安全收回调用方的类型。
    return await entry.outcome as AiExclusiveResult<T>
  }

  cancel(jobId?: string): void {
    if (jobId) {
      const queued = this.waiting.find((entry) => entry.jobId === jobId)
      if (queued) {
        this.drop(queued)
        return
      }
      for (const entry of this.running.values()) if (entry.jobId === jobId) entry.controller.abort()
      return
    }
    // 省略 jobId = 用户按「停止」：只收交互车道，自动任务不该被用户的手动停止误杀。
    for (const entry of [...this.waiting]) if (entry.policy.lane === 'interactive') this.drop(entry)
    this.running.get('interactive')?.controller.abort()
  }

  cancelAll(): void {
    for (const entry of [...this.waiting]) this.drop(entry)
    for (const entry of this.running.values()) entry.controller.abort()
  }

  hasInFlight(): boolean {
    return this.waiting.length > 0 || this.running.size > 0
  }

  /** 某本书是否已有指定类别的任务在跑或排队，用于按书而非全局的判断。 */
  busyFor(bookId: string, classes: readonly string[]): boolean {
    return this.entries().some((entry) =>
      entry.policy.bookId === bookId && Boolean(entry.policy.cls) && classes.includes(entry.policy.cls!))
  }

  laneDepth(lane: AiLane): number {
    return this.waiting.filter((entry) => entry.policy.lane === lane).length + (this.running.has(lane) ? 1 : 0)
  }

  private createEntry(run: QueueRunner, policy: AiJobPolicy): QueueEntry {
    let resolve: (result: AiExclusiveResult<unknown>) => void = () => {}
    let reject: (error: unknown) => void = () => {}
    const outcome = new Promise<AiExclusiveResult<unknown>>((done, fail) => { resolve = done; reject = fail })
    // 流式任务没人等待结果，先挂一个空 handler，避免模型错误变成 unhandled rejection。
    outcome.catch(() => {})
    return { jobId: createAiJobId(), policy, run, controller: new AbortController(), started: false, outcome, resolve, reject }
  }

  private describe(entry: QueueEntry): AiStartResult {
    // 界面要说「前面还有几个」，跨车道统计会把交互队列里的活算到后台任务头上。
    const waiting = this.waiting.filter((candidate) => candidate.policy.lane === entry.policy.lane)
    const index = waiting.indexOf(entry)
    return { ok: true, jobId: entry.jobId, queued: !entry.started, position: index < 0 ? 0 : index + 1 }
  }

  private entries(): QueueEntry[] {
    return [...this.running.values(), ...this.waiting]
  }

  private find(dedupeKey?: string): QueueEntry | undefined {
    if (!dedupeKey) return undefined
    return this.entries().find((entry) => entry.policy.dedupeKey === dedupeKey)
  }

  private drop(entry: QueueEntry): void {
    const index = this.waiting.indexOf(entry)
    if (index < 0) return
    this.waiting.splice(index, 1)
    entry.policy.onCancelled?.(entry.jobId)
    entry.resolve({ ok: false, message: CANCELLED_WHILE_QUEUED })
    this.pump()
  }

  private blocked(entry: QueueEntry): boolean {
    if (!entry.policy.resource) return false
    for (const [lane, holder] of this.running) {
      if (holder.policy.resource !== entry.policy.resource) continue
      // 自动任务可以被打断重做，用户任务不能反过来等它。
      if (lane === 'background' && entry.policy.lane === 'interactive') {
        holder.controller.abort()
        return false
      }
      return true
    }
    return false
  }

  private pump(): void {
    for (const lane of ['interactive', 'background'] as AiLane[]) {
      if (this.running.has(lane)) continue
      if (lane === 'background' && this.laneDepth('interactive') > 0) continue
      const index = this.waiting.findIndex((entry) => entry.policy.lane === lane)
      if (index < 0 || this.blocked(this.waiting[index]!)) continue
      const [entry] = this.waiting.splice(index, 1)
      this.begin(entry!)
    }
  }

  private begin(entry: QueueEntry): void {
    entry.started = true
    this.running.set(entry.policy.lane, entry)
    void Promise.resolve()
      .then(() => {
        // 取消可能落在 run 真正开始之前的这个微任务窗口里：此时绝不启动新工作，也不能让调用方永远等下去。
        if (entry.controller.signal.aborted) {
          entry.policy.onCancelled?.(entry.jobId)
          entry.resolve({ ok: false, message: CANCELLED_WHILE_QUEUED })
          return
        }
        return entry.run(entry.jobId, entry.controller.signal)
      })
      .then(
        () => entry.resolve({ ok: true, value: undefined }),
        (error: unknown) => entry.reject(error),
      )
      .finally(() => {
        if (this.running.get(entry.policy.lane) === entry) this.running.delete(entry.policy.lane)
        this.pump()
      })
  }
}
