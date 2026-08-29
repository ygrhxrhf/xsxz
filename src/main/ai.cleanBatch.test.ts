import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanChapterBody, planCleanChapterRequest } from './ai'
import { AI_INPUT_CHARACTER_BUDGET, countTextCharacters } from './aiBudget'

function paragraphs(count: number, size: number): string {
  return Array.from({ length: count }, (_, index) => `第${index + 1}段${'甲'.repeat(size)}`).join('\n\n')
}

describe('long chapter cleaning plan', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps every request within budget with one previous and next read-only paragraph', () => {
    const plan = planCleanChapterRequest('长章', paragraphs(8, 7_000))
    expect(plan.requiresConfirmation).toBe(true)
    expect(plan.batches.length).toBeGreaterThan(1)
    expect(plan.batches.every((batch) => countTextCharacters(batch.prompt) <= AI_INPUT_CHARACTER_BUDGET)).toBe(true)
    expect(plan.batches[0]!.prompt).toContain('只读前文：\n（无）')
    expect(plan.batches[0]!.prompt).toContain('只读后文：\n第')
    expect(plan.batches[1]!.prompt).toContain('只读前文：\n第')
    expect(plan.budget.paragraphCount).toBe(8)
    expect(plan.budget.batchCount).toBe(plan.batches.length)
  })

  it('sends batches sequentially and merges only returned targets after all succeed', async () => {
    const plan = planCleanChapterRequest('长章', paragraphs(8, 7_000))
    let request = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1
      return new Response(JSON.stringify({
        choices: [{ message: { content: `清理结果${request}` }, finish_reason: 'stop' }],
      }), { status: 200 })
    }))
    const result = await cleanChapterBody({
      baseUrl: 'https://custom.example/v1', model: 'model', apiKey: 'key', provider: 'custom',
    }, '长章', paragraphs(8, 7_000), undefined, undefined, plan)
    expect(request).toBe(plan.batches.length)
    expect(result.cleaned).toBe(Array.from({ length: request }, (_, index) => `清理结果${index + 1}`).join('\n\n'))
  })

  it('stops before producing a preview when cancellation reaches a batch request', async () => {
    const plan = planCleanChapterRequest('长章', paragraphs(8, 7_000))
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return new Response('{}', { status: 200 })
    }))
    await expect(cleanChapterBody({
      baseUrl: 'https://custom.example/v1', model: 'model', apiKey: 'key', provider: 'custom',
    }, '长章', paragraphs(8, 7_000), undefined, controller.signal, plan))
      .rejects.toThrow('AI 请求超时，请稍后重试')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('fails the whole preview on any truncated batch', async () => {
    const plan = planCleanChapterRequest('长章', paragraphs(8, 7_000))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '部分结果' }, finish_reason: 'length' }],
    }), { status: 200 })))
    await expect(cleanChapterBody({
      baseUrl: 'https://custom.example/v1', model: 'model', apiKey: 'key', provider: 'custom',
    }, '长章', paragraphs(8, 7_000), undefined, undefined, plan))
      .rejects.toThrow('模型输出被截断，未生成可应用的清理预览')
  })
})
