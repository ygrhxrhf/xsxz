import { describe, expect, it, vi } from 'vitest'
import { AiJobSlot } from './ai'
import { AiQueue } from './aiScheduler'

function latch() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  return { release, wait }
}

const idle = Promise.resolve()

describe('AiQueue 车道调度', () => {
  it('第二个任务排队而不是被拒绝', async () => {
    const queue = new AiQueue()
    const hold = latch()
    const started = queue.start(async () => { await hold.wait }, { lane: 'interactive' })
    const queued = queue.start(async () => {}, { lane: 'interactive' })
    expect(started).toMatchObject({ ok: true, queued: false, position: 0 })
    expect(queued).toMatchObject({ ok: true, queued: true, position: 1 })
    expect(queued.jobId).not.toBe(started.jobId)
    expect(queue.laneDepth('interactive')).toBe(2)
    hold.release()
    await vi.waitFor(() => expect(queue.hasInFlight()).toBe(false))
  })

  it('自动任务已在跑时用户任务照样起跑，两条车道最多两个在飞', async () => {
    const queue = new AiQueue()
    const hold = latch()
    const seen: string[] = []
    queue.start(async () => { seen.push('background'); await hold.wait }, { lane: 'background' })
    await vi.waitFor(() => expect(seen).toEqual(['background']))
    queue.start(async () => { seen.push('interactive'); await hold.wait }, { lane: 'interactive' })
    await vi.waitFor(() => expect(seen).toEqual(['background', 'interactive']))
    expect(queue.hasInFlight()).toBe(true)
    hold.release()
    await vi.waitFor(() => expect(queue.hasInFlight()).toBe(false))
  })

  it('后台任务必须等交互车道完全空闲，包括排在后面的交互任务', async () => {
    const queue = new AiQueue()
    const hold = latch()
    const order: string[] = []
    queue.start(async () => { order.push('qa1'); await hold.wait }, { lane: 'interactive' })
    queue.start(async () => { order.push('background') }, { lane: 'background' })
    queue.start(async () => { order.push('qa2') }, { lane: 'interactive' })
    await Promise.resolve()
    expect(order, '后台不得插到排队中的用户任务前面').toEqual(['qa1'])
    hold.release()
    await vi.waitFor(() => expect(order).toEqual(['qa1', 'qa2', 'background']))
  })

  it('同一写入资源串行，交错会丢写', async () => {
    const queue = new AiQueue()
    const hold = latch()
    const log: string[] = []
    const job = (name: string, gate: Promise<void>) => async () => {
      log.push(`start:${name}`)
      await gate
      log.push(`end:${name}`)
    }
    queue.start(job('memoryA', hold.wait), { lane: 'interactive', resource: 'b1:write' })
    queue.start(job('memoryB', idle), { lane: 'interactive', resource: 'b1:write' })
    await Promise.resolve()
    expect(log).toEqual(['start:memoryA'])
    hold.release()
    await vi.waitFor(() => expect(log).toEqual(['start:memoryA', 'end:memoryA', 'start:memoryB', 'end:memoryB']))
  })

  it('用户任务不与自动任务抢写入锁：自动任务被打断让位', async () => {
    const queue = new AiQueue()
    const hold = latch()
    let backgroundAborted = false
    queue.start(async (_jobId, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { backgroundAborted = true; resolve() }, { once: true })
      })
    }, { lane: 'background', resource: 'b1:write' })
    await Promise.resolve()
    let userSignal!: AbortSignal
    queue.start(async (_jobId, signal) => {
      userSignal = signal
      await hold.wait
    }, { lane: 'interactive', resource: 'b1:write' })
    await vi.waitFor(() => expect(backgroundAborted).toBe(true))
    expect(userSignal.aborted).toBe(false)
    hold.release()
    await vi.waitFor(() => expect(queue.hasInFlight()).toBe(false))
  })

  it('重复提交同一本书同一章复用已有任务，不再报忙', async () => {
    const queue = new AiQueue()
    const hold = latch()
    const first = queue.start(async () => { await hold.wait }, { lane: 'interactive', dedupeKey: 'b1:clean:c1' })
    const again = queue.start(async () => {}, { lane: 'interactive', dedupeKey: 'b1:clean:c1' })
    expect(again).toMatchObject({ ok: true, jobId: first.ok ? first.jobId : '', queued: false, position: 0 })
    expect(queue.laneDepth('interactive')).toBe(1)
    hold.release()
    await vi.waitFor(() => expect(queue.hasInFlight()).toBe(false))
  })

  it('排队中的任务取消后补发终态并立刻放行下一个', async () => {
    const queue = new AiQueue()
    const hold = latch()
    const notices: string[] = []
    const running = queue.start(async () => { await hold.wait }, { lane: 'interactive' })
    const queued = queue.start(async () => { notices.push('不该执行') }, {
      lane: 'interactive',
      onCancelled: (jobId) => notices.push(jobId),
    })
    queue.cancel(queued.ok ? queued.jobId : '')
    expect(notices).toEqual([queued.ok ? queued.jobId : ''])
    expect(queue.laneDepth('interactive')).toBe(1)
    hold.release()
    await vi.waitFor(() => expect(queue.hasInFlight()).toBe(false))
    expect(notices).toHaveLength(1)
    expect(running.ok).toBe(true)
  })

  it('runExclusive 等待而不是拒绝，并把模型错误原样交给调用方', async () => {
    const queue = new AiQueue()
    const hold = latch()
    const running = queue.runExclusive(async () => { await hold.wait; return '第一批' })
    await Promise.resolve()
    let secondStarted = false
    const second = queue.runExclusive(async () => { secondStarted = true; return '第二批' })
    expect(secondStarted, '第二个独占任务只能等待，不能被拒绝').toBe(false)
    hold.release()
    expect(await running).toEqual({ ok: true, value: '第一批' })
    expect(await second).toEqual({ ok: true, value: '第二批' })
    await expect(queue.runExclusive(async () => { throw new Error('API Key 无效或无权限，请到设置页核对') }))
      .rejects.toThrow('API Key 无效或无权限，请到设置页核对')
  })

  it('停止交互车道时未起跑的独占任务出队并给出中文失败', async () => {
    const queue = new AiQueue()
    const hold = latch()
    const running = queue.runExclusive(async () => { await hold.wait; return '第一批' })
    await Promise.resolve()
    let queuedRan = false
    const queued = queue.runExclusive(async () => { queuedRan = true; return '不该跑' })
    queue.cancel()
    await expect(queued).resolves.toEqual({ ok: false, message: '已从队列取消' })
    hold.release()
    await expect(running).resolves.toEqual({ ok: true, value: '第一批' })
    expect(queuedRan).toBe(false)
  })

  it('取消落在任务体起跑之前时绝不启动新工作，也不让调用方悬等', async () => {
    const queue = new AiQueue()
    const cancelled: string[] = []
    let ran = false
    const pending = queue.runExclusive(async () => { ran = true; return '不该跑' }, {
      lane: 'interactive', onCancelled: (jobId) => cancelled.push(jobId),
    })
    queue.cancel()
    expect(await pending).toEqual({ ok: false, message: '已从队列取消' })
    expect(ran, '已经取消的任务不能再发起请求或写盘').toBe(false)
    expect(cancelled).toHaveLength(1)
    await vi.waitFor(() => expect(queue.hasInFlight()).toBe(false))
  })

  it('省略 jobId 只收交互车道，取消全部则连自动任务一起停', async () => {
    const queue = new AiQueue()
    const hang = () => new Promise<void>(() => {})
    const signals: Record<string, AbortSignal> = {}
    queue.start(async (_jobId, signal) => { signals.background = signal; await hang() }, { lane: 'background' })
    await vi.waitFor(() => expect(signals.background).toBeTruthy())
    queue.start(async (_jobId, signal) => { signals.interactive = signal; await hang() }, { lane: 'interactive' })
    await vi.waitFor(() => expect(signals.interactive).toBeTruthy())
    queue.cancel()
    expect(signals.interactive.aborted).toBe(true)
    expect(signals.background.aborted).toBe(false)
    queue.cancelAll()
    expect(signals.background.aborted).toBe(true)
  })

  it('busyFor 按书判断，别书的后台任务不该挡住本书的记忆修正', async () => {
    const queue = new AiQueue()
    const hold = latch()
    queue.start(async () => { await hold.wait }, { lane: 'interactive', bookId: 'b1', cls: 'memory' })
    expect(queue.busyFor('b1', ['memory', 'follow'])).toBe(true)
    expect(queue.busyFor('b2', ['memory', 'follow'])).toBe(false)
    expect(queue.busyFor('b1', ['follow'])).toBe(false)
    hold.release()
    await vi.waitFor(() => expect(queue.busyFor('b1', ['memory', 'follow'])).toBe(false))
  })

  it('兼容壳保持旧签名：busy 即在飞，第二个任务排队', async () => {
    const queue = new AiQueue()
    const slot = new AiJobSlot(queue)
    const hold = latch()
    expect(slot.busy).toBe(false)
    expect(slot.start(async () => { await hold.wait })).toMatchObject({ ok: true })
    expect(slot.start(async () => {})).toMatchObject({ ok: true })
    expect(slot.busy).toBe(true)
    hold.release()
    await vi.waitFor(() => expect(slot.busy).toBe(false))
  })

  it('默认构造的旧式独占槽仍保持互斥语义：独占任务串行执行', async () => {
    const slot = new AiJobSlot()
    const order: string[] = []
    const first = slot.runExclusive(async () => { order.push('a') })
    const second = slot.runExclusive(async () => { order.push('b') })
    await Promise.all([first, second])
    expect(order).toEqual(['a', 'b'])
    await vi.waitFor(() => expect(slot.busy).toBe(false))
  })
})
