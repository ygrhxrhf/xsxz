import { describe, expect, it } from 'vitest'
import { applyAiMemoryExtraction, buildAiMemoryCandidates } from './aiMemory'
import { isAiMemoryFile } from './library'

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { characters: [], relations: [], foreshadows: [], events: [], reviewDecisions: [], ...overrides }
}

const BODY = `${'甲'.repeat(73)}第一段。\n\n${'乙'.repeat(170)}第二段。\n\n${'丙'.repeat(91)}第三段。`

describe('memory evidence candidates', () => {
  it('partitions all normalized chapter text into stable 80–160 code-point citations', () => {
    const candidates = buildAiMemoryCandidates('c0001', '第一章', BODY)
    expect(candidates.length).toBeGreaterThan(1)
    expect(candidates.every((item) => Array.from(item.excerpt).length >= 80 && Array.from(item.excerpt).length <= 160)).toBe(true)
    expect(candidates.map((item) => item.text).join('')).toBe(BODY)
    expect(candidates.every((item) => item.chapterId === 'c0001' && item.chapterTitle === '第一章')).toBe(true)
    expect(new Set(candidates.map((item) => item.id)).size).toBe(candidates.length)
    expect(buildAiMemoryCandidates('c0001', '第一章', BODY)).toEqual(candidates)
  })

  it.each([
    [80, [80]],
    [160, [160]],
    [161, [81, 80]],
    [320, [160, 160]],
    [321, [107, 107, 107]],
  ])('balances %i Unicode characters without invalid chunk lengths', (count, expected) => {
    expect(buildAiMemoryCandidates('c-edge', '边界章', '😀'.repeat(count))
      .map((item) => Array.from(item.excerpt).length)).toEqual(expected)
  })

  it('counts surrogate pairs as one character and omits chapters too short for a valid citation', () => {
    expect(buildAiMemoryCandidates('c0003', '短章', '短'.repeat(79))).toEqual([])
  })
})

describe('strict memory extraction whitelist and merge', () => {
  const candidates = buildAiMemoryCandidates('c0001', '第一章', BODY)
  const first = candidates[0]!
  const second = candidates[1]!

  it('resolves all four memory kinds only through request-local citation ids', () => {
    const result = applyAiMemoryExtraction(null, raw({
      characters: [{ name: '顾清', aliases: ['阿清'], role: '主角', status: '调查中', summary: '顾清返回旧宅。', citationIds: [first.id] }],
      relations: [{ from: '顾清', to: '顾远', relation: '父女', status: '失联', summary: '父亲失踪。', citationIds: [first.id] }],
      foreshadows: [{ desc: '旧账册', status: 'open', summary: '账册尚未找到。', citationIds: [second.id] }],
      events: [{ title: '返回旧宅', participants: ['顾清'], result: '开始调查', summary: '顾清开始调查。', citationIds: [first.id, second.id] }],
    }), candidates, { uptoChapterId: 'c0001', updatedAt: '2026-01-01T00:00:00.000Z' })
    expect(result.memory.characters).toHaveLength(1)
    expect(result.memory.relations).toHaveLength(1)
    expect(result.memory.foreshadows).toHaveLength(1)
    expect(result.memory.events).toHaveLength(1)
    expect(result.memory.events[0]?.sources.map((item) => item.id)).toEqual([first.id, second.id])
    expect(result.memory.events[0]?.sources[0]).not.toHaveProperty('text')
    expect(result.memory.uptoChapterId).toBe('c0001')
    expect(isAiMemoryFile(result.memory)).toBe(true)
    expect(result.changedItems).toBe(4)
  })

  it('rejects an item with any unknown citation but keeps independently valid items', () => {
    const result = applyAiMemoryExtraction(null, raw({
      characters: [
        { name: '虚构者', aliases: [], role: '未知', status: '未知', summary: '无真实来源。', citationIds: ['ev-fake'] },
        { name: '顾清', aliases: [], role: '主角', status: '调查中', summary: '有真实来源。', citationIds: [first.id] },
      ],
    }), candidates)
    expect(result.memory.characters.map((item) => item.name)).toEqual(['顾清'])
    expect(result.acceptedItems).toBe(1)
    expect(result.rejectedItems).toBe(1)
  })

  it('fails the entire extraction when every returned entry has an invalid source', () => {
    expect(() => applyAiMemoryExtraction(null, raw({
      events: [{ title: '虚构事件', participants: [], result: '无', summary: '无真实来源。', citationIds: ['ev-unread-p1'] }],
    }), candidates)).toThrow('模型返回的记忆来源均无效，原有记忆未改变')
  })

  it('merges same-key duplicates locally, preserves the first stable id and unions real sources', () => {
    const result = applyAiMemoryExtraction(null, raw({
      characters: [
        { name: ' 顾清 ', aliases: ['阿清'], role: '主角', status: '归来', summary: '先归来。', citationIds: [first.id] },
        { name: '顾清', aliases: ['清姐'], role: '主角', status: '调查', summary: '后调查。', citationIds: [second.id] },
      ],
    }), candidates, { updatedAt: '2026-01-01T00:00:00.000Z' })
    expect(result.memory.characters).toHaveLength(1)
    expect(result.memory.characters[0]?.id).toContain('character-')
    expect(result.memory.characters[0]?.sources.map((item) => item.id)).toEqual([first.id, second.id])
    expect(result.memory.characters[0]?.aliases).toEqual(['阿清', '清姐'])
    expect(result.memory.characters[0]?.summary).toBe('后调查。')
    expect(result.changedItems).toBe(1)
  })

  it('does not count a semantically identical merge as changed or rewrite its timestamp', () => {
    const extraction = raw({
      characters: [{ name: '顾清', aliases: [], role: '主角', status: '归来', summary: '旧摘要。', citationIds: [first.id] }],
    })
    const initial = applyAiMemoryExtraction(null, extraction, candidates, {
      updatedAt: '2026-01-01T00:00:00.000Z',
    }).memory
    const repeated = applyAiMemoryExtraction(initial, extraction, candidates, {
      updatedAt: '2026-02-01T00:00:00.000Z',
    })
    expect(repeated.changedItems).toBe(0)
    expect(repeated.memory.characters[0]?.updatedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('does not let ordinary model items overwrite review or uncertain accuracy', () => {
    const initial = applyAiMemoryExtraction(null, raw({
      characters: [{ name: '顾清', aliases: [], role: '主角', status: '归来', summary: '旧摘要。', citationIds: [first.id] }],
    }), candidates).memory
    initial.characters[0]!.accuracy = 'review'
    const reviewed = applyAiMemoryExtraction(initial, raw({
      characters: [{ name: '顾清', aliases: [], role: '主角', status: '调查', summary: '新摘要。', citationIds: [second.id] }],
    }), candidates)
    expect(reviewed.memory.characters[0]?.accuracy).toBe('review')
    initial.characters[0]!.accuracy = 'uncertain'
    const uncertain = applyAiMemoryExtraction(initial, raw({
      characters: [{ name: '顾清', aliases: [], role: '主角', status: '调查', summary: '新摘要。', citationIds: [second.id] }],
    }), candidates)
    expect(uncertain.memory.characters[0]?.accuracy).toBe('uncertain')
  })

  it('accepts review decisions only for the explicit review whitelist', () => {
    const initial = applyAiMemoryExtraction(null, raw({
      characters: [{ name: '顾清', aliases: [], role: '主角', status: '归来', summary: '旧摘要。', citationIds: [first.id] }],
    }), candidates).memory
    const id = initial.characters[0]!.id
    initial.characters[0]!.accuracy = 'review'
    const confirmed = applyAiMemoryExtraction(initial, raw({
      reviewDecisions: [{ itemId: id, confirmed: true }, { itemId: 'character-fake', confirmed: false }],
    }), candidates, { reviewItemIds: new Set([id]), updatedAt: '2026-01-02T00:00:00.000Z' })
    expect(confirmed.memory.characters[0]?.accuracy).toBe('normal')
    expect(confirmed.reviewedItemIds).toEqual([id])
    expect(confirmed.rejectedItems).toBe(1)
  })

  it('rejects malformed top-level JSON without changing the input memory', () => {
    const initial = applyAiMemoryExtraction(null, raw(), candidates).memory
    expect(() => applyAiMemoryExtraction(initial, { characters: [] }, candidates))
      .toThrow('模型返回的记忆 JSON 无法识别，原有记忆未改变')
    expect(initial.characters).toEqual([])
  })
})
