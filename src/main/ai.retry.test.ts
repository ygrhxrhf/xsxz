import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseRetryAfterMs,
  runAiTaskCompletion,
  type AiConfig,
} from './ai'

const config: AiConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  apiKey: 'test-key',
  provider: 'deepseek',
  thinkingEnabled: true,
}
const messages = [{ role: 'user' as const, content: 'json：测试' }]
const success = () => new Response(JSON.stringify({
  choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
}), { status: 200 })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Retry-After parsing', () => {
  it('supports seconds and HTTP dates while rejecting invalid values', () => {
    expect(parseRetryAfterMs('1.5', 0)).toBe(1_500)
    expect(parseRetryAfterMs('0', 0)).toBe(0)
    expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:03 GMT', 1_000)).toBe(2_000)
    expect(parseRetryAfterMs('invalid', 0)).toBeUndefined()
    expect(parseRetryAfterMs('   ', 0)).toBeUndefined()
    expect(parseRetryAfterMs(null, 0)).toBeUndefined()
  })
})

describe('bounded transient retries', () => {
  it('prefers Retry-After then uses 1s/2s bounded backoff with one total timeout signal', async () => {
    const responses = [
      new Response('busy', { status: 429, headers: { 'Retry-After': '0.01' } }),
      new Response('server error', { status: 500 }),
      success(),
    ]
    const signals: AbortSignal[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal)
      return responses.shift()!
    })
    vi.stubGlobal('fetch', fetchMock)
    const delays: number[] = []

    const result = await runAiTaskCompletion(config, messages, {
      task: 'memory',
      hooks: {
        random: () => 0,
        sleep: async (delayMs) => { delays.push(delayMs) },
      },
    })

    expect(result.json).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([10, 2_000])
    expect(signals[0]).toBe(signals[1])
    expect(signals[1]).toBe(signals[2])
  })

  it('stops after two retries for 503', async () => {
    const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const delays: number[] = []

    await expect(runAiTaskCompletion(config, messages, {
      task: 'memory',
      hooks: { random: () => 0, sleep: async (delayMs) => { delays.push(delayMs) } },
    })).rejects.toThrow(/暂时不可用/)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([1_000, 2_000])
  })

  it.each([401, 402, 403])('never retries status %s', async (status) => {
    const fetchMock = vi.fn(async () => new Response('denied', { status }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(runAiTaskCompletion(config, messages, {
      task: 'memory',
      hooks: { sleep: async () => { throw new Error('must not sleep') } },
    })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborts an in-progress backoff without sending another request', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => new Response('busy', {
      status: 429,
      headers: { 'Retry-After': '10' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(runAiTaskCompletion(config, messages, {
      task: 'memory',
      signal: controller.signal,
      hooks: {
        sleep: async (_delayMs, signal) => {
          controller.abort()
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        },
      },
    })).rejects.toThrow(/超时/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('single compatibility downgrade', () => {
  it('removes JSON/reasoning extensions after one 400 without consuming transient retries', async () => {
    const bodies: Record<string, unknown>[] = []
    const responses = [new Response('unsupported parameter', { status: 400 }), success()]
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return responses.shift()!
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runAiTaskCompletion(config, messages, {
      task: 'memory',
      hooks: { sleep: async () => { throw new Error('downgrade must not sleep') } },
    })

    expect(result.json).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodies[0]).toMatchObject({
      reasoning_effort: 'high',
      response_format: { type: 'json_object' },
    })
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
    expect(bodies[1]).not.toHaveProperty('response_format')
    expect(bodies[1].max_tokens).toBe(3_000)
  })

  it('performs at most one compatibility downgrade', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response('still unsupported', { status: 400 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(runAiTaskCompletion(config, messages, { task: 'memory' })).rejects.toThrow(/400/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodies[0]).toHaveProperty('response_format')
    expect(bodies[1]).not.toHaveProperty('response_format')
  })

  it('does not downgrade or retry a 422 when no compatibility extension was sent', async () => {
    const fetchMock = vi.fn(async () => new Response('bad input', { status: 422 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(runAiTaskCompletion({ ...config, thinkingEnabled: false }, messages, {
      task: 'characterCard',
    })).rejects.toThrow(/422/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('downgrades streaming extensions before any chunks are consumed', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n'))
        controller.close()
      },
    })
    const bodies: Record<string, unknown>[] = []
    const responses = [new Response('unsupported', { status: 422 }), new Response(stream, { status: 200 })]
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return responses.shift()!
    }))
    const deltas: string[] = []
    const result = await runAiTaskCompletion(config, messages, {
      task: 'recap',
      stream: true,
      onDelta: (delta) => deltas.push(delta),
    })
    expect(result.text).toBe('完成')
    expect(deltas).toEqual(['完成'])
    expect(bodies[0]).toHaveProperty('reasoning_effort')
    expect(bodies[0]).toHaveProperty('stream_options')
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
    expect(bodies[1]).not.toHaveProperty('stream_options')
  })
})
