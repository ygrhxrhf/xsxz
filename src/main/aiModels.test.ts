import { describe, expect, it, vi, afterEach } from 'vitest'
import { listAiModels, AI_MODELS_TIMEOUT_MS } from './aiModels'

describe('listAiModels', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads /models and keeps only usable ids', async () => {
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(String(url)).toBe('https://example.invalid/v1/models')
      expect(init?.headers?.Authorization).toBe('Bearer k')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'nexusvai/deepseek-v4.1-flash-1017-open' }, { id: '  deepseek-chat  ' }, {}, { id: 42 }],
        }),
      }
    })
    const result = await listAiModels({ baseUrl: 'https://example.invalid/v1/', apiKey: 'k' }, fetchMock)
    expect(result).toEqual({
      ok: true,
      models: ['nexusvai/deepseek-v4.1-flash-1017-open', 'deepseek-chat'],
    })
    expect(AI_MODELS_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('reports HTTP failures without throwing', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    const result = await listAiModels({ baseUrl: 'https://example.invalid/v1' }, fetchMock)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('500')
  })

  it('rejects a non-JSON body', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    }))
    const result = await listAiModels({ baseUrl: 'https://example.invalid/v1' }, fetchMock)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/JSON|无法识别/)
  })

  it('rejects a payload without data[]', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ object: 'list' }) }))
    const result = await listAiModels({ baseUrl: 'https://example.invalid/v1' }, fetchMock)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/格式/)
  })

  it('rejects an empty model list', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }))
    const result = await listAiModels({ baseUrl: 'https://example.invalid/v1' }, fetchMock)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/没有返回任何模型/)
  })

  it('maps an aborted request to a timeout message', async () => {
    const fetchMock = vi.fn(async () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    })
    const result = await listAiModels({ baseUrl: 'https://example.invalid/v1' }, fetchMock)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/超时/)
  })

  it('maps other transport errors to a readable message', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('Failed to fetch')
    })
    const result = await listAiModels({ baseUrl: 'https://example.invalid/v1' }, fetchMock)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('Failed to fetch')
  })

  it('refuses an empty base url', async () => {
    const fetchMock = vi.fn()
    const result = await listAiModels({ baseUrl: '' }, fetchMock)
    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
