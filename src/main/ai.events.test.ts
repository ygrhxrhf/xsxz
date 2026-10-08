import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiJobSlot,
  AiPendingSaveStore,
  aiCompletionDoneEvent,
  aiStoppedDoneEvent,
  finalizeAiSave,
  runAiSaveStage,
  streamAiTaskCompletion,
} from './ai'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AI exclusive slot cancellation', () => {
  it('cancels the running interactive job only for the matching job or a bare stop', async () => {
    const slot = new AiJobSlot()
    let streamSignal: AbortSignal | undefined
    const started = slot.start(async (_jobId, signal) => {
      streamSignal = signal
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    expect(started.ok).toBe(true)
    await vi.waitFor(() => expect(streamSignal).toBeDefined())
    slot.cancel('other')
    expect(streamSignal?.aborted).toBe(false)
    // 停止清正文这类调用拿不到 jobId，必须能收掉交互车道上正在跑的流。
    slot.cancel()
    expect(streamSignal?.aborted).toBe(true)
  })

  it('passes the shared abort signal into non-stream work', async () => {
    const slot = new AiJobSlot()
    let started = false
    const running = slot.runExclusive((signal) => new Promise<string>((_resolve, reject) => {
      started = true
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    await vi.waitFor(() => expect(started).toBe(true))
    slot.cancel()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(slot.busy).toBe(false)
  })
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

describe('AI save finalization', () => {
  it('turns a pre-commit story cancellation into one stopped result without saving', async () => {
    const store = new AiPendingSaveStore()
    const controller = new AbortController()
    controller.abort()
    const save = vi.fn(async () => {})
    const done = await finalizeAiSave(
      store,
      { jobId: 'story', ok: true, text: '完整' },
      save,
      { signal: controller.signal, stoppedEvent: aiStoppedDoneEvent('story', '部分') },
    )
    expect(done).toEqual({ jobId: 'story', ok: true, text: '部分', stopped: true })
    expect(save).not.toHaveBeenCalled()
    expect(store.size).toBe(0)
  })

  it('saves chat partial after cancellation during the atomic commit preparation', async () => {
    const store = new AiPendingSaveStore()
    const controller = new AbortController()
    const primarySave = vi.fn(async () => {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    })
    const stoppedSave = vi.fn(async () => {})
    const done = await finalizeAiSave(
      store,
      { jobId: 'chat', ok: true, text: '完整' },
      primarySave,
      {
        signal: controller.signal,
        stoppedEvent: aiStoppedDoneEvent('chat', '已有部分'),
        saveStopped: stoppedSave,
      },
    )
    expect(done).toEqual({ jobId: 'chat', ok: true, text: '已有部分', stopped: true })
    expect(primarySave).toHaveBeenCalledTimes(1)
    expect(stoppedSave).toHaveBeenCalledTimes(1)
  })

  it('emits saving then exactly one stopped done when cancellation wins before commit', async () => {
    const store = new AiPendingSaveStore()
    const controller = new AbortController()
    controller.abort()
    const events: unknown[] = []
    await runAiSaveStage(
      store,
      'story',
      { jobId: 'story', ok: true, text: '完整' },
      async () => { throw new Error('must not save') },
      { signal: controller.signal, stoppedEvent: aiStoppedDoneEvent('story', '部分') },
      (jobId, stage) => events.push({ jobId, stage }),
      (done) => events.push(done),
    )
    expect(events).toEqual([
      { jobId: 'story', stage: 'saving' },
      { jobId: 'story', ok: true, text: '部分', stopped: true },
    ])
  })

  it('retries an ordinary failed save without the completed job signal', async () => {
    const store = new AiPendingSaveStore()
    const controller = new AbortController()
    const primarySave = vi.fn(async () => { throw new Error('disk full') })
    const retrySave = vi.fn(async () => {})
    const done = await finalizeAiSave(
      store,
      { jobId: 'recap', ok: true, text: '已验证前情' },
      primarySave,
      { signal: controller.signal, retrySave },
    )
    expect(done.saveToken).toMatch(/^save-/)
    controller.abort()
    await expect(store.retry(done.saveToken!)).resolves.toEqual({ ok: true })
    expect(primarySave).toHaveBeenCalledOnce()
    expect(retrySave).toHaveBeenCalledOnce()
  })

  it('keeps a stopped chat result and save token when partial persistence fails', async () => {
    const store = new AiPendingSaveStore()
    const controller = new AbortController()
    controller.abort()
    const stoppedSave = vi.fn(async () => { throw new Error('/private/path') })
    const done = await finalizeAiSave(
      store,
      { jobId: 'chat', ok: true, text: '完整' },
      async () => {},
      {
        signal: controller.signal,
        stoppedEvent: aiStoppedDoneEvent('chat', '已有部分'),
        saveStopped: stoppedSave,
      },
    )
    expect(done).toMatchObject({ jobId: 'chat', ok: true, text: '已有部分', stopped: true })
    expect(done.saveToken).toMatch(/^save-/)
    expect(JSON.stringify(done)).not.toContain('/private/path')
    expect(store.size).toBe(1)
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
