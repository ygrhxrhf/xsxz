import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiPendingSaveStore,
  aiCompletionDoneEvent,
  aiStoppedDoneEvent,
  streamAiTaskCompletion,
} from './ai'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AI done event helpers', () => {
  it('preserves usage and truncation metadata without exposing reasoning', () => {
    expect(aiCompletionDoneEvent('job-1', {
      text: '正文',
      usage: { inputTokens: 12, outputTokens: 3, cacheHitTokens: 5 },
      finishReason: 'length',
      truncated: true,
    })).toEqual({
      jobId: 'job-1',
      ok: true,
      text: '正文',
      usage: { inputTokens: 12, outputTokens: 3, cacheHitTokens: 5 },
      truncated: true,
    })
  })

  it('marks stopped output as a successful terminal event', () => {
    expect(aiStoppedDoneEvent('job-2', '已有部分')).toEqual({
      jobId: 'job-2',
      ok: true,
      text: '已有部分',
      stopped: true,
    })
  })

  it('returns structured stream metadata while keeping the text-only wrapper compatible', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{"content":"部分","reasoning_content":"secret"},"finish_reason":"length"}]}\n\n'
          + 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_cache_hit_tokens":4}}\n\n'
          + 'data: [DONE]\n',
        ))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })))
    const deltas: string[] = []
    const result = await streamAiTaskCompletion(
      { baseUrl: 'https://example.invalid/v1', model: 'm', apiKey: 'k', provider: 'custom' },
      [{ role: 'user', content: '测试' }],
      new AbortController().signal,
      (delta) => deltas.push(delta),
    )
    expect(result).toMatchObject({
      text: '部分',
      usage: { inputTokens: 10, outputTokens: 2, cacheHitTokens: 4 },
      finishReason: 'length',
      truncated: true,
    })
    expect(deltas).toEqual(['部分'])
    expect(result.text).not.toContain('secret')
  })
})

describe('AiPendingSaveStore', () => {
  it('consumes a token only after a successful save', async () => {
    const store = new AiPendingSaveStore()
    const save = vi.fn(async () => {})
    const token = store.register(save)
    expect(store.size).toBe(1)
    await expect(store.retry(token)).resolves.toEqual({ ok: true })
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.size).toBe(0)
    await expect(store.retry(token)).resolves.toMatchObject({ ok: false })
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('retains failed saves, returns a sanitized message, and retries without model work', async () => {
    const store = new AiPendingSaveStore()
    let fail = true
    const save = vi.fn(async () => {
      if (fail) throw new Error('secret path /private/book')
    })
    const token = store.register(save)
    const failed = await store.retry(token)
    expect(failed).toEqual({ ok: false, message: '仍然无法保存，请检查磁盘空间和权限' })
    expect(JSON.stringify(failed)).not.toContain('/private/book')
    expect(store.size).toBe(1)
    fail = false
    await expect(store.retry(token)).resolves.toEqual({ ok: true })
    expect(save).toHaveBeenCalledTimes(2)
    expect(store.size).toBe(0)
  })

  it('prevents concurrent duplicate saves for the same token', async () => {
    const store = new AiPendingSaveStore()
    let release!: () => void
    const save = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const token = store.register(save)
    const first = store.retry(token)
    await Promise.resolve()
    await expect(store.retry(token)).resolves.toEqual({ ok: false, message: '正在重试保存，请稍候' })
    release()
    await expect(first).resolves.toEqual({ ok: true })
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('keeps independent tokens valid for the lifetime of the process store', async () => {
    const store = new AiPendingSaveStore()
    const firstSave = vi.fn(async () => {})
    const secondSave = vi.fn(async () => {})
    const first = store.register(firstSave)
    const second = store.register(secondSave)
    expect(store.size).toBe(2)
    await expect(store.retry(first)).resolves.toEqual({ ok: true })
    await expect(store.retry(second)).resolves.toEqual({ ok: true })
    expect(firstSave).toHaveBeenCalledTimes(1)
    expect(secondSave).toHaveBeenCalledTimes(1)
  })
})
