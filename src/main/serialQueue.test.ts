import { describe, expect, it } from 'vitest'
import { createSerialQueue } from './serialQueue'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('createSerialQueue', () => {
  it('按调用顺序逐个执行，不重叠', async () => {
    const enqueue = createSerialQueue()
    const events: string[] = []
    const first = enqueue(async () => {
      events.push('a:start')
      await delay(30)
      events.push('a:end')
      return 'a'
    })
    const second = enqueue(async () => {
      events.push('b:start')
      await delay(5)
      events.push('b:end')
      return 'b'
    })
    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b'])
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('前一个失败不会卡住队列，异常只回到自己的调用方', async () => {
    const enqueue = createSerialQueue()
    const failed = enqueue(async () => {
      throw new Error('boom')
    })
    const next = enqueue(async () => 'ok')
    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
  })

  it('同步抛错也当作该任务失败处理', async () => {
    const enqueue = createSerialQueue()
    const failed = enqueue(() => {
      throw new Error('sync')
    })
    const next = enqueue(async () => 'still works')
    await expect(failed).rejects.toThrow('sync')
    await expect(next).resolves.toBe('still works')
  })
})
