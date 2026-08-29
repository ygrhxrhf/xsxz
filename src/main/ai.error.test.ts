import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  clipChatMessages,
  formatAiRequestError,
  formatAiTransportError,
  testConnection,
} from './ai'
import type { AiChatMessage } from '../shared/types'

describe('AI error copy', () => {
  it('maps 401 / 429 / 5xx / timeout to Chinese', () => {
    expect(formatAiRequestError(401)).toMatch(/API Key/)
    expect(formatAiRequestError(402)).toMatch(/余额/)
    expect(formatAiRequestError(403)).toMatch(/API Key/)
    expect(formatAiRequestError(429)).toMatch(/频繁|额度/)
    expect(formatAiRequestError(408)).toMatch(/超时/)
    expect(formatAiRequestError(503)).toMatch(/暂时不可用/)
    expect(formatAiRequestError(400, 'bad model')).toContain('400')
  })

  it('maps abort / network errors', () => {
    expect(formatAiTransportError({ name: 'AbortError', message: 'aborted' })).toMatch(/超时/)
    expect(formatAiTransportError(new Error('Failed to fetch'))).toMatch(/无法连接/)
    expect(formatAiTransportError(new Error('ENOTFOUND'))).toMatch(/无法连接/)
  })

  it('clips chat history and drops system turns', () => {
    const msgs: AiChatMessage[] = [
      { role: 'system', content: 'no' },
      ...Array.from({ length: 12 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `m${i}`,
      })),
    ]
    const clipped = clipChatMessages(msgs, 8)
    expect(clipped).toHaveLength(8)
    expect(clipped[0].content).toBe('m4')
    expect(clipped.every((m) => m.role !== 'system')).toBe(true)
  })
})

describe('testConnection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('posts a tiny chat completion and returns the model text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        expect(String(url)).toContain('/chat/completions')
        expect(String(init?.body ?? '')).toContain('只回复 ok')
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        }
      }),
    )
    const text = await testConnection({
      baseUrl: 'https://example.invalid/v1/',
      model: 'm',
      apiKey: 'k',
    })
    expect(text).toBe('ok')
  })

  it('surfaces 401 as key invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
      })),
    )
    await expect(
      testConnection({ baseUrl: 'https://example.invalid/v1', model: 'm', apiKey: 'bad' }),
    ).rejects.toThrow(/API Key/)
  })
})
