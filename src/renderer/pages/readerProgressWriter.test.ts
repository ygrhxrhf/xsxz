import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReaderProgressWriter, type CapturedProgressWrite } from './readerProgressWriter'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createReaderProgressWriter', () => {
  let writes: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    writes = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('连续滚动只在安静 1 秒后写一次，写的是最后抓的那份位置', async () => {
    const captured: string[] = []
    const machine = createReaderProgressWriter(() => {
      const label = `#${captured.length + 1}`
      captured.push(label)
      return async () => { writes.push(label) }
    })

    machine.schedule()
    machine.schedule()
    machine.schedule()
    expect(captured).toEqual(['#1', '#2', '#3'])
    await vi.advanceTimersByTimeAsync(999)
    expect(writes).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(writes).toEqual(['#3'])
  })

  it('写盘串行：上一条还没落地时，新位置排在它后面，不会并发覆盖', async () => {
    const gate = deferred()
    const order: string[] = []
    let index = 0
    const machine = createReaderProgressWriter((): CapturedProgressWrite => {
      const label = `w${++index}`
      return async () => {
        order.push(`${label}:start`)
        if (label === 'w1') await gate.promise
        writes.push(label)
        order.push(`${label}:end`)
      }
    })

    machine.schedule()
    await vi.advanceTimersByTimeAsync(1000)
    expect(order).toEqual(['w1:start'])

    void machine.writeNow()
    void machine.writeNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['w1:start'])

    gate.resolve()
    await vi.advanceTimersByTimeAsync(1000)
    expect(order).toEqual(['w1:start', 'w1:end', 'w2:start', 'w2:end', 'w3:start', 'w3:end'])
    expect(writes).toEqual(['w1', 'w2', 'w3'])
  })

  it('writeNow 撤掉待触发的排期：换章后旧定时器不会再抓一次位置', async () => {
    const captured: string[] = []
    const machine = createReaderProgressWriter(() => {
      const label = `#${captured.length + 1}`
      captured.push(label)
      return async () => { writes.push(label) }
    })

    machine.schedule()
    expect(await machine.writeNow()).toBe('saved')
    await vi.advanceTimersByTimeAsync(5000)
    expect(captured).toEqual(['#1', '#2'])
    expect(writes).toEqual(['#2'])
  })

  it('抓不到位置时什么都不写：返回 skipped', async () => {
    let canCapture = true
    const machine = createReaderProgressWriter(() => {
      if (!canCapture) return null
      return async () => { writes.push('ok') }
    })

    machine.schedule()
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toEqual(['ok'])

    canCapture = false
    machine.schedule()
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toEqual(['ok'])
    expect(await machine.writeNow()).toBe('skipped')
  })

  it('抓不到位置时 writeNow 仍把已排期那份写出去，不丢最后的进度', async () => {
    let canCapture = true
    const machine = createReaderProgressWriter(() => {
      if (!canCapture) return null
      return async () => { writes.push('pending') }
    })

    machine.schedule()
    canCapture = false
    expect(await machine.writeNow()).toBe('saved')
    expect(writes).toEqual(['pending'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(writes).toEqual(['pending'])
  })

  it('写失败只算这一条：返回 failed，之后的写入照常落地', async () => {
    let shouldFail = true
    const machine = createReaderProgressWriter(() => async () => {
      if (shouldFail) {
        shouldFail = false
        throw new Error('disk busy')
      }
      writes.push('ok')
    })

    expect(await machine.writeNow()).toBe('failed')
    expect(writes).toEqual([])
    expect(await machine.writeNow()).toBe('saved')
    expect(writes).toEqual(['ok'])
  })

  it('writeNow 等在飞的那条写完，把它的结果告诉调用方', async () => {
    const gate = deferred()
    let remaining = 1
    const machine = createReaderProgressWriter(() => {
      if (!remaining--) return null
      return async () => {
        await gate.promise
        writes.push('done')
      }
    })

    machine.schedule()
    await vi.advanceTimersByTimeAsync(1000)
    const pending = machine.writeNow()
    expect(writes).toEqual([])
    gate.resolve()
    expect(await pending).toBe('saved')
    expect(writes).toEqual(['done'])
  })
})
