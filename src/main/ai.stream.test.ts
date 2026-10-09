import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamAiTaskCompletion } from './ai'
import { AiQueue } from './aiScheduler'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('streamAiTaskCompletion', () => {
  it('parses split SSE data frames and requests stream mode', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      expect(init?.body).toContain('"stream":true')
      return new Response(body, { status: 200 })
    }))
    const deltas: string[] = []
    const result = await streamAiTaskCompletion(
      { baseUrl: 'https://example.invalid/v1', model: 'm', apiKey: 'k' },
      [{ role: 'user', content: '测试' }],
      new AbortController().signal,
      (delta: string) => deltas.push(delta),
      { task: 'recap' },
    )
    expect(deltas).toEqual(['你', '好'])
    expect(result.text).toBe('你好')
  })
})

describe('车道队列的排队与取消', () => {
  it('queues a second job, and cancel aborts only the matching job', async () => {
    const queue = new AiQueue()
    let release!: () => void
    let signal!: AbortSignal
    const first = queue.start(async (_id, nextSignal) => {
      signal = nextSignal
      await new Promise<void>((resolve) => { release = resolve })
    }, { lane: 'interactive', bookId: 'b1', cls: 'qa' })
    expect(first.ok).toBe(true)
    await Promise.resolve()
    let secondStarted = false
    const second = queue.start(async () => { secondStarted = true }, { lane: 'interactive', bookId: 'b1', cls: 'qa' })
    expect(second.ok).toBe(true)
    await vi.waitFor(() => expect(secondStarted, '同车道应一次只跑一个任务').toBe(false))
    queue.cancel('other')
    expect(signal.aborted).toBe(false)
    queue.cancel(first.jobId)
    expect(signal.aborted).toBe(true)
    release()
    await vi.waitFor(() => expect(queue.hasInFlight()).toBe(false))
  })

  it('shares the same lane with non-streaming AI work', async () => {
    const queue = new AiQueue()
    let release!: () => void
    const first = queue.start(async () => {
      await new Promise<void>((resolve) => { release = resolve })
    }, { lane: 'interactive', bookId: 'b1', cls: 'clean' })
    expect(first.ok).toBe(true)
    await Promise.resolve()
    const second = queue.runExclusive(async () => '第二个', { lane: 'interactive', bookId: 'b1', cls: 'clean' })
    expect(queue.hasInFlight()).toBe(true)
    release()
    await expect(second).resolves.toEqual({ ok: true, value: '第二个' })
    await vi.waitFor(() => expect(queue.hasInFlight()).toBe(false))
  })
})
