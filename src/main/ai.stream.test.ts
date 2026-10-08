import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiJobSlot, streamChatCompletion } from './ai'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('streamChatCompletion', () => {
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
    const text = await streamChatCompletion(
      { baseUrl: 'https://example.invalid/v1', model: 'm', apiKey: 'k' },
      [{ role: 'user', content: '测试' }],
      new AbortController().signal,
      (delta) => deltas.push(delta),
    )
    expect(deltas).toEqual(['你', '好'])
    expect(text).toBe('你好')
  })
})

describe('AiJobSlot', () => {
  it('queues a second job, and cancel aborts only the matching job', async () => {
    const slot = new AiJobSlot()
    let release!: () => void
    let signal!: AbortSignal
    const first = slot.start(async (_id, nextSignal) => {
      signal = nextSignal
      await new Promise<void>((resolve) => { release = resolve })
    })
    expect(first.ok).toBe(true)
    await Promise.resolve()
    let secondStarted = false
    const second = slot.start(async () => { secondStarted = true })
    expect(second.ok).toBe(true)
    await vi.waitFor(() => expect(secondStarted, '同车道应一次只跑一个任务').toBe(false))
    slot.cancel('other')
    expect(signal.aborted).toBe(false)
    if (first.ok) slot.cancel(first.jobId)
    expect(signal.aborted).toBe(true)
    release()
    await vi.waitFor(() => expect(slot.busy).toBe(false))
  })

  it('shares the same lane with non-streaming AI work', async () => {
    const slot = new AiJobSlot()
    let release!: () => void
    const first = slot.start(async () => {
      await new Promise<void>((resolve) => { release = resolve })
    })
    expect(first.ok).toBe(true)
    await Promise.resolve()
    const second = slot.runExclusive(async () => '第二个')
    expect(slot.busy).toBe(true)
    release()
    await expect(second).resolves.toEqual({ ok: true, value: '第二个' })
    await vi.waitFor(() => expect(slot.busy).toBe(false))
  })
})
