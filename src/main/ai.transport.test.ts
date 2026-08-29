import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AI_DEEP_REQUEST_TIMEOUT_MS,
  AI_REQUEST_TIMEOUT_MS,
  generateCharacterCard,
  getAiTaskPolicy,
  parseAiJsonObject,
  runAiTaskCompletion,
  summarizeUpTo,
  type AiConfig,
  type AiTaskKind,
} from './ai'

const deepseek: AiConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  apiKey: 'test-key',
  provider: 'deepseek',
  thinkingEnabled: true,
}

const messages = [{ role: 'user' as const, content: 'json：请处理这段测试内容' }]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mockJsonResponse(payload: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })))
}

describe('AI task policy matrix', () => {
  it.each<[AiTaskKind, number, number | undefined, 'fast' | 'high', boolean]>([
    ['clean', AI_REQUEST_TIMEOUT_MS, 1_200, 'fast', false],
    ['translate', AI_REQUEST_TIMEOUT_MS, 1_200, 'fast', false],
    ['chapterSummary', AI_REQUEST_TIMEOUT_MS, 300, 'fast', false],
    ['characterCard', AI_DEEP_REQUEST_TIMEOUT_MS, 3_000, 'high', false],
    ['queryRewrite', AI_REQUEST_TIMEOUT_MS, 200, 'fast', true],
    ['recap', AI_DEEP_REQUEST_TIMEOUT_MS, 900, 'high', false],
    ['memory', AI_DEEP_REQUEST_TIMEOUT_MS, 3_000, 'high', true],
    ['evidenceQa', AI_DEEP_REQUEST_TIMEOUT_MS, 2_000, 'high', true],
  ])('applies %s timeout/max_tokens/mode/JSON policy', (task, timeoutMs, maxTokens, mode, structured) => {
    expect(getAiTaskPolicy(task, { inputTokenEstimate: 1_000 })).toEqual({
      timeoutMs,
      maxTokens,
      mode,
      structured,
    })
  })

  it('clamps dynamic output budgets and maps recap lengths', () => {
    expect(getAiTaskPolicy('clean', { inputTokenEstimate: 10 }).maxTokens).toBe(512)
    expect(getAiTaskPolicy('clean', { inputTokenEstimate: 20_000 }).maxTokens).toBe(12_000)
    expect(getAiTaskPolicy('translate', { inputTokenEstimate: 20_000 }).maxTokens).toBe(6_000)
    expect(getAiTaskPolicy('recap', { recapLength: 'short' }).maxTokens).toBe(400)
    expect(getAiTaskPolicy('recap', { recapLength: 'standard' }).maxTokens).toBe(900)
    expect(getAiTaskPolicy('recap', { recapLength: 'detailed' }).maxTokens).toBe(1_600)
  })
})

describe('task-aware request bodies', () => {
  it('adds DeepSeek high reasoning and JSON extensions without temperature', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({
        model: 'deepseek-v4-flash',
        stream: false,
        max_tokens: 3_000,
        reasoning_effort: 'high',
        response_format: { type: 'json_object' },
      })
      expect(body).not.toHaveProperty('temperature')
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"characters":[]}', reasoning_content: 'secret' }, finish_reason: 'stop' }],
      }), { status: 200 })
    }))

    const result = await runAiTaskCompletion(deepseek, messages, { task: 'memory' })
    expect(result.text).toBe('{"characters":[]}')
    expect(result.json).toEqual({ characters: [] })
    expect(result.text).not.toContain('secret')
  })

  it('uses temperature for DeepSeek fast tasks and disables thinking when requested', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body.temperature).toBe(0.3)
      expect(body.max_tokens).toBe(300)
      expect(body).not.toHaveProperty('reasoning_effort')
      return new Response(JSON.stringify({ choices: [{ message: { content: '摘要' }, finish_reason: 'stop' }] }), { status: 200 })
    }))
    await runAiTaskCompletion({ ...deepseek, thinkingEnabled: false }, messages, { task: 'chapterSummary' })
  })

  it('preserves thinkingEnabled=false through an existing production recap helper', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body.max_tokens).toBe(900)
      expect(body).not.toHaveProperty('reasoning_effort')
      return new Response(JSON.stringify({ choices: [{ message: { content: '前情' }, finish_reason: 'stop' }] }), { status: 200 })
    }))
    await summarizeUpTo({ ...deepseek, thinkingEnabled: false }, '测试书', [{ title: '第一章', body: '正文' }])
  })

  it('safely downgrades a deepseek provider flag on a non-official host', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).not.toHaveProperty('reasoning_effort')
      expect(body).not.toHaveProperty('response_format')
      expect(body).not.toHaveProperty('temperature')
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"events":[]}' }, finish_reason: 'stop' }] }), { status: 200 })
    }))
    await runAiTaskCompletion({
      baseUrl: 'https://legacy-custom.example/v1',
      model: 'old-custom-model',
      apiKey: 'custom-key',
      provider: 'deepseek',
    }, messages, { task: 'memory' })
  })

  it.each([
    'http://api.deepseek.com/v1',
    'https://api.deepseek.com:8443/v1',
  ])('does not send DeepSeek extensions to a non-official protocol or port: %s', async (baseUrl) => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).not.toHaveProperty('reasoning_effort')
      expect(body).not.toHaveProperty('response_format')
      expect(body).not.toHaveProperty('temperature')
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"events":[]}' }, finish_reason: 'stop' }] }), { status: 200 })
    }))
    await runAiTaskCompletion({ ...deepseek, baseUrl }, messages, { task: 'memory' })
  })

  it('preserves legacy character-card raw fallback and thinking preference', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body.max_tokens).toBe(3_000)
      expect(body).not.toHaveProperty('reasoning_effort')
      expect(body).not.toHaveProperty('response_format')
      return new Response(JSON.stringify({ choices: [{ message: { content: 'not valid json' }, finish_reason: 'stop' }] }), { status: 200 })
    }))
    const raw = await generateCharacterCard({ ...deepseek, thinkingEnabled: false }, {
      bookTitle: '测试书',
      uptoChapterTitle: '第一章',
      catalogTitles: ['第一章'],
      chapterSummaries: [],
      recentBodies: [],
    })
    expect(raw).toBe('not valid json')
  })

  it('sends only OpenAI-compatible core fields to custom services', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({ model: 'custom-model', stream: false, max_tokens: 3_000 })
      expect(body).not.toHaveProperty('reasoning_effort')
      expect(body).not.toHaveProperty('response_format')
      expect(body).not.toHaveProperty('temperature')
      expect(body).not.toHaveProperty('stream_options')
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"events":[]}' }, finish_reason: 'stop' }] }), { status: 200 })
    }))

    await runAiTaskCompletion({
      baseUrl: 'https://custom.example/v1',
      model: 'custom-model',
      apiKey: 'custom-key',
      provider: 'custom',
      thinkingEnabled: true,
    }, messages, { task: 'memory' })
  })
})

describe('response parsing', () => {
  it('parses non-stream usage/cache and finish_reason while ignoring reasoning', async () => {
    mockJsonResponse({
      choices: [{
        message: { content: '完成', reasoning_content: 'internal chain' },
        finish_reason: 'length',
      }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 40,
      },
    })

    const result = await runAiTaskCompletion(deepseek, messages, { task: 'recap' })
    expect(result).toMatchObject({
      text: '完成',
      finishReason: 'length',
      truncated: true,
      usage: { inputTokens: 120, outputTokens: 30, cacheHitTokens: 80, cacheMissTokens: 40 },
    })
    expect(JSON.stringify(result)).not.toContain('internal chain')
  })

  it('parses split SSE, usage and finish reason without emitting reasoning_content', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"secret","content":"你"}}]}\n'))
        controller.enqueue(encoder.encode('\ndata: {"choices":[{"delta":{"content":"好"},"finish_reason":"length"}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_cache_hit_tokens":6}}\n\ndata: [DONE]\n'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body.stream).toBe(true)
      expect(body.stream_options).toEqual({ include_usage: true })
      return new Response(stream, { status: 200 })
    }))
    const deltas: string[] = []
    const result = await runAiTaskCompletion(deepseek, messages, {
      task: 'recap',
      stream: true,
      onDelta: (delta) => deltas.push(delta),
    })
    expect(deltas).toEqual(['你', '好'])
    expect(result).toMatchObject({
      text: '你好',
      finishReason: 'length',
      truncated: true,
      usage: { inputTokens: 10, outputTokens: 2, cacheHitTokens: 6 },
    })
    expect(result.text).not.toContain('secret')
  })

  it('rejects empty content and truncated structured output', async () => {
    mockJsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })
    await expect(runAiTaskCompletion(deepseek, messages, { task: 'chapterSummary' })).rejects.toThrow(/未返回有效内容/)

    mockJsonResponse({ choices: [{ message: { content: '{"keywords":[' }, finish_reason: 'length' }] })
    await expect(runAiTaskCompletion(deepseek, messages, { task: 'queryRewrite' })).rejects.toThrow(/结构化结果因输出上限/)
  })

  it('rejects malformed JSON and accepts a bounded fenced JSON object', () => {
    expect(parseAiJsonObject('```json\n{"corePhrase":"旧宅"}\n```')).toEqual({ corePhrase: '旧宅' })
    expect(() => parseAiJsonObject('not json')).toThrow(/结构化内容无法识别/)
    expect(() => parseAiJsonObject('[1,2,3]')).toThrow(/结构化内容无法识别/)
  })
})
