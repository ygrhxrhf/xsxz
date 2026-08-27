import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_BUSY_MESSAGE, AiJobSlot, streamChatCompletion } from './ai'

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
  it('rejects a second job, and cancel aborts only the matching job', async () => {
    const slot = new AiJobSlot()
    let release!: () => void
    let signal!: AbortSignal
    const first = slot.start(async (_id, nextSignal) => {
      signal = nextSignal
      await new Promise<void>((resolve) => { release = resolve })
    })
    expect(first.ok).toBe(true)
    await Promise.resolve()
    expect(slot.start(async () => {})).toEqual({ ok: false, message: AI_BUSY_MESSAGE })
    slot.cancel('other')
    expect(signal.aborted).toBe(false)
    if (first.ok) slot.cancel(first.jobId)
    expect(signal.aborted).toBe(true)
    release()
    await vi.waitFor(() => expect(slot.busy).toBe(false))
  })

  it('shares the same slot with non-streaming AI work', async () => {
    const slot = new AiJobSlot()
    let release!: () => void
    const first = slot.runExclusive(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return '完成'
    })
    await Promise.resolve()
    expect(slot.start(async () => {})).toEqual({ ok: false, message: AI_BUSY_MESSAGE })
    expect(await slot.runExclusive(async () => '第二个')).toEqual({ ok: false, message: AI_BUSY_MESSAGE })
    release()
    await expect(first).resolves.toEqual({ ok: true, value: '完成' })
    expect(slot.busy).toBe(false)
  })
})
