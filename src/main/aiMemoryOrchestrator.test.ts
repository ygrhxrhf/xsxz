import { describe, expect, it, vi } from 'vitest'
import type { AiMemoryFile } from '../shared/types'
import { isAiMemoryFile } from './library'
import {
  executeMemoryOrchestration,
  planMemoryPromptRequests,
  selectMemoryChapterBatches,
  type MemoryChapterInput,
} from './aiMemoryOrchestrator'
import { buildAiMemoryCandidates } from './aiMemory'
import { countTextCharacters } from './aiBudget'

function chapters(count: number): MemoryChapterInput[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `c${String(index + 1).padStart(4, '0')}`,
    index: index + 1,
    title: `第${index + 1}章`,
    status: 'ready',
    body: `${String(index + 1)}${'正文'.repeat(100)}`,
  }))
}

function rawCharacter(candidateId: string, name = '顾清'): Record<string, unknown> {
  return {
    characters: [{ name, aliases: [], role: '主角', status: '调查', summary: `${name}正在调查。`, citationIds: [candidateId] }],
    relations: [], foreshadows: [], events: [], reviewDecisions: [],
  }
}

describe('memory chapter selection', () => {
  it('clamps to reading progress and takes the earliest five chapters after the previous cutoff', () => {
    const all = chapters(12).reverse()
    const selected = selectMemoryChapterBatches(all, 'c0012', 'c0010', 'c0002', 'update')
    expect(selected.batches[0]?.map((item) => item.id)).toEqual(['c0003', 'c0004', 'c0005', 'c0006', 'c0007'])
    expect(selected.remainingChapters).toBe(3)
    expect(selected.eligibleChapterIds.at(-1)).toBe('c0010')
  })

  it('excludes non-ready chapters and returns no material without reading progress', () => {
    const all = chapters(4)
    all[1]!.status = 'failed'
    expect(selectMemoryChapterBatches(all, 'c0004', 'c0004', undefined, 'update').batches[0]?.map((item) => item.id))
      .toEqual(['c0001', 'c0003', 'c0004'])
    expect(selectMemoryChapterBatches(all, 'c0004', null, undefined, 'update')).toEqual({
      batches: [], remainingChapters: 0, eligibleChapterIds: [],
    })
  })

  it('partitions rebuild from the first ready chapter into groups of five', () => {
    const selected = selectMemoryChapterBatches(chapters(12), 'c0012', 'c0012', 'c0008', 'rebuild')
    expect(selected.batches.map((batch) => batch.length)).toEqual([5, 5, 2])
    expect(selected.batches[0]?.[0]?.id).toBe('c0001')
    expect(selected.remainingChapters).toBe(0)
  })
})

describe('memory prompt planning', () => {
  it('keeps every complete prompt within 30000 characters and preserves every candidate once', () => {
    const body = '甲'.repeat(50_000)
    const candidates = buildAiMemoryCandidates('c0001', '长章', body)
    const requests = planMemoryPromptRequests('测试书', '抽取可信记忆。', candidates, null, false)
    expect(requests.length).toBeGreaterThan(1)
    expect(requests.every((request) => countTextCharacters(request.prompt) <= 30_000)).toBe(true)
    expect(requests.flatMap((request) => request.candidates).map((item) => item.id))
      .toEqual(candidates.map((item) => item.id))
  })

  it('rejects a custom instruction that leaves no room for one evidence candidate', () => {
    const candidates = buildAiMemoryCandidates('c0001', '第一章', '甲'.repeat(100))
    expect(() => planMemoryPromptRequests('测试书', '要求'.repeat(20_000), candidates, null, false))
      .toThrow('记忆请求提示词和必要证据过长，无法在 30000 字预算内发送')
  })
})

describe('memory orchestration', () => {
  it('does not call the model when there are no new chapters and no review items', async () => {
    const complete = vi.fn()
    const result = await executeMemoryOrchestration('测试书', null, [], 0, '抽取记忆。', complete, {
      includeReviews: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(complete).not.toHaveBeenCalled()
    expect(result.processedChapters).toBe(0)
    expect(result.changedItems).toBe(0)
    expect(isAiMemoryFile(result.memory)).toBe(true)
  })

  it('waits to review flagged items until a later batch has a new ready chapter', async () => {
    const candidate = buildAiMemoryCandidates('c0001', '第一章', '甲'.repeat(100))[0]!
    const initial = (await executeMemoryOrchestration('测试书', null, [[{
      id: 'c0001', index: 1, title: '第一章', status: 'ready', body: '甲'.repeat(100),
    }]], 0, '抽取记忆。', async () => rawCharacter(candidate.id))).memory
    initial.characters[0]!.accuracy = 'review'
    const complete = vi.fn()
    const result = await executeMemoryOrchestration('测试书', initial, [], 0, '复核记忆。', complete, {
      includeReviews: true,
    })
    expect(complete).not.toHaveBeenCalled()
    expect(result.memory.characters[0]?.accuracy).toBe('review')
  })

  it('processes short chapters without a model call and still advances the durable cutoff', async () => {
    const complete = vi.fn()
    const result = await executeMemoryOrchestration('测试书', null, [[{
      id: 'c0001', index: 1, title: '短章', status: 'ready', body: '短'.repeat(79),
    }]], 2, '抽取记忆。', complete, { updatedAt: '2026-01-01T00:00:00.000Z' })
    expect(complete).not.toHaveBeenCalled()
    expect(result.processedChapters).toBe(1)
    expect(result.remainingChapters).toBe(2)
    expect(result.memory.uptoChapterId).toBe('c0001')
  })

  it('merges request results and reports unique semantic changes', async () => {
    const complete = vi.fn(async (request: { candidates: Array<{ id: string }> }) =>
      rawCharacter(request.candidates[0]!.id))
    const result = await executeMemoryOrchestration('测试书', null, [[chapters(1)[0]!]], 0, '抽取记忆。', complete, {
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(complete).toHaveBeenCalled()
    expect(result.memory.characters).toHaveLength(1)
    expect(result.changedItems).toBe(1)
    expect(result.processedChapters).toBe(1)
    expect(result.memory.uptoChapterId).toBe('c0001')
  })

  it('turns a review item uncertain when the explicit review request cannot confirm it', async () => {
    const firstCandidate = buildAiMemoryCandidates('c0001', '第一章', '甲'.repeat(100))[0]!
    const initial = (await executeMemoryOrchestration('测试书', null, [[{
      id: 'c0001', index: 1, title: '第一章', status: 'ready', body: '甲'.repeat(100),
    }]], 0, '抽取记忆。', async () => rawCharacter(firstCandidate.id))).memory
    initial.characters[0]!.accuracy = 'review'
    const complete = vi.fn(async () => ({
      characters: [], relations: [], foreshadows: [], events: [],
      reviewDecisions: [{ itemId: 'character-forged', confirmed: true }],
    }))
    const result = await executeMemoryOrchestration('测试书', initial, [[{
      id: 'c0002', index: 2, title: '短章', status: 'ready', body: '短'.repeat(79),
    }]], 0, '复核记忆。', complete, {
      includeReviews: true,
      updatedAt: '2026-02-01T00:00:00.000Z',
    })
    expect(complete).toHaveBeenCalledOnce()
    expect(result.processedChapters).toBe(1)
    expect(result.memory.characters[0]?.accuracy).toBe('uncertain')
    expect(result.changedItems).toBe(1)
  })

  it('checks cancellation between request groups and does not start another model call', async () => {
    const controller = new AbortController()
    const complete = vi.fn(async () => {
      controller.abort()
      return { characters: [], relations: [], foreshadows: [], events: [], reviewDecisions: [] }
    })
    await expect(executeMemoryOrchestration('测试书', null, [[{
      id: 'c0001', index: 1, title: '长章', status: 'ready', body: '甲'.repeat(50_000),
    }]], 0, '抽取记忆。', complete, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(complete).toHaveBeenCalledOnce()
  })

  it('leaves the caller memory unchanged when a later request fails', async () => {
    const candidate = buildAiMemoryCandidates('c0001', '第一章', '甲'.repeat(100))[0]!
    const initialResult = await executeMemoryOrchestration('测试书', null, [[{
      id: 'c0001', index: 1, title: '第一章', status: 'ready', body: '甲'.repeat(100),
    }]], 0, '抽取记忆。', async () => rawCharacter(candidate.id))
    const initial: AiMemoryFile = initialResult.memory
    const snapshot = structuredClone(initial)
    let calls = 0
    const complete = vi.fn(async (request: { candidates: Array<{ id: string }> }) => {
      calls += 1
      if (calls === 1) return rawCharacter(request.candidates[0]!.id, '新人物')
      throw new Error('network failed')
    })
    await expect(executeMemoryOrchestration('测试书', initial, [[{
      id: 'c0002', index: 2, title: '第二章', status: 'ready', body: '乙'.repeat(50_000),
    }]], 0, '抽取记忆。', complete)).rejects.toThrow('network failed')
    expect(complete).toHaveBeenCalledTimes(2)
    expect(initial).toEqual(snapshot)
  })
})
