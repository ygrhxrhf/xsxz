import { describe, expect, it } from 'vitest'
import { normalizeEvidenceSearchTerms, selectLocalEvidence } from './aiEvidenceSearch'

function chapter(id: string, index: number, body: string, status = 'ready') {
  return { id, index, title: `第${index}章 顾清`, status, body }
}

const chapters = [
  chapter('c0001', 1, `开场。\n\n顾清发现旧账册，决定追查失踪案。${'甲'.repeat(320)}`),
  chapter('c0002', 2, `推进。\n\n顾清在码头询问账册来源。${'乙'.repeat(320)}`),
  chapter('c0003', 3, '未读秘密：顾清已经找到真凶。'),
  chapter('c0004', 4, '失败章秘密：账册来自王城。', 'failed'),
]

describe('evidence query normalization', () => {
  it('keeps one core phrase and at most five unique 2–20 character keywords', () => {
    expect(normalizeEvidenceSearchTerms({
      originalQuestion: '原问题', corePhrase: ' 顾清 ',
      keywords: ['账册', '账册', '顾清', '码头', '失踪案', '王城', '追查', '甲', '超'.repeat(21)],
    })).toEqual({ corePhrase: '顾清', keywords: ['账册', '码头', '失踪案', '王城', '追查'], fallback: false })
  })

  it('falls back to the original question when rewrite output is empty or invalid', () => {
    expect(normalizeEvidenceSearchTerms({ originalQuestion: ' 顾清在哪里 ', keywords: ['甲'] }))
      .toEqual({ corePhrase: '顾清在哪里', keywords: [], fallback: true })
  })
})

describe('local read-range evidence selection', () => {
  it('clamps to stored progress and excludes unread or non-ready chapter text', () => {
    const result = selectLocalEvidence(chapters, { originalQuestion: '顾清账册', corePhrase: '顾清', keywords: ['账册'] }, {
      requestedUptoChapterId: 'c0004', progressChapterId: 'c0002', currentChapterId: 'c0002',
    })
    expect(result.uptoChapterId).toBe('c0002')
    expect(result.citations.map((item) => item.chapterId)).toEqual(['c0002', 'c0001'])
    const payload = JSON.stringify(result.citations)
    expect(payload).not.toContain('真凶')
    expect(payload).not.toContain('王城')
  })

  it('prioritizes the current chapter while retaining stable paragraph coordinates', () => {
    const result = selectLocalEvidence(chapters, { originalQuestion: '账册', corePhrase: '账册' }, {
      requestedUptoChapterId: 'c0002', progressChapterId: 'c0002', currentChapterId: 'c0002',
    })
    expect(result.citations[0]).toMatchObject({
      id: 'qa-c0002-p1', chapterId: 'c0002', chapterTitle: '第2章 顾清', paragraphIndex: 1,
    })
    expect(Array.from(result.citations[0]!.excerpt).length).toBeLessThanOrEqual(300)
    expect(result.citations[0]!.excerpt).toContain('账册')
  })

  it('selects no more than eight results across no more than six chapters', () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      chapter(`c${String(index + 1).padStart(4, '0')}`, index + 1, `目标词 段一\n\n目标词 段二`))
    const result = selectLocalEvidence(many, { originalQuestion: '目标词', corePhrase: '目标词' }, {
      requestedUptoChapterId: 'c0010', progressChapterId: 'c0010', currentChapterId: 'c0010',
    })
    expect(result.citations).toHaveLength(8)
    expect(new Set(result.citations.map((item) => item.chapterId)).size).toBeLessThanOrEqual(6)
  })

  it('deduplicates one candidate per paragraph and produces deterministic output', () => {
    const query = { originalQuestion: '顾清账册', corePhrase: '顾清', keywords: ['账册', '顾清', '账册'] }
    const options = { requestedUptoChapterId: 'c0002', progressChapterId: 'c0002', currentChapterId: 'c0001' }
    const first = selectLocalEvidence(chapters, query, options)
    const second = selectLocalEvidence(chapters, query, options)
    expect(second).toEqual(first)
    expect(new Set(first.citations.map((item) => item.id)).size).toBe(first.citations.length)
  })

  it('matches collapsed whitespace and maps lowercase expansion back to the original excerpt', () => {
    const special = [
      chapter('c0001', 1, '顾清   找到\t账册'),
      chapter('c0002', 2, `${'İ'.repeat(220)}TARGET${'😀'.repeat(120)}`),
    ]
    const whitespace = selectLocalEvidence(special, { originalQuestion: '顾清 找到 账册', corePhrase: '顾清 找到 账册' }, {
      requestedUptoChapterId: 'c0002', progressChapterId: 'c0002', currentChapterId: 'c0001', excerptCharacters: 80,
    })
    expect(whitespace.citations[0]?.excerpt).toContain('顾清   找到\t账册')
    const expanded = selectLocalEvidence(special, { originalQuestion: 'target', corePhrase: 'target' }, {
      requestedUptoChapterId: 'c0002', progressChapterId: 'c0002', currentChapterId: 'c0002', excerptCharacters: 80,
    })
    expect(expanded.citations[0]?.excerpt).toContain('TARGET')
    expect(Array.from(expanded.citations[0]!.excerpt).length).toBeLessThanOrEqual(80)
  })

  it('keeps paragraph coordinates and excerpts in the same paragraph at a boundary match', () => {
    const boundary = chapter('c0001', 1, `${'上一段标记'.repeat(80)}\n\nTARGET${'本段'.repeat(120)}`)
    const result = selectLocalEvidence([boundary], { originalQuestion: 'target', corePhrase: 'target' }, {
      requestedUptoChapterId: 'c0001', progressChapterId: 'c0001', excerptCharacters: 80,
    })
    expect(result.citations[0]).toMatchObject({ paragraphIndex: 1 })
    expect(result.citations[0]!.excerpt).toContain('TARGET')
    expect(result.citations[0]!.excerpt).not.toContain('上一段标记')
  })

  it('keeps a normal long core phrase complete when it fits the excerpt limit', () => {
    const phrase = '核心短语'.repeat(30)
    const result = selectLocalEvidence([chapter('c0001', 1, `开头${phrase}结尾`)], {
      originalQuestion: phrase, corePhrase: phrase,
    }, { requestedUptoChapterId: 'c0001', progressChapterId: 'c0001' })
    expect(result.citations[0]!.excerpt).toContain(phrase)
  })

  it('falls back from non-finite option values while preserving the 8-result and 6-chapter caps', () => {
    const many = Array.from({ length: 10 }, (_, index) => chapter(
      `c${String(index + 1).padStart(4, '0')}`, index + 1, '目标词',
    ))
    const result = selectLocalEvidence(many, { originalQuestion: '目标词', corePhrase: '目标词' }, {
      requestedUptoChapterId: 'c0010', progressChapterId: 'c0010', maxResults: Number.NaN,
      maxChapters: Number.POSITIVE_INFINITY, excerptCharacters: Number.NaN,
    })
    expect(result.citations).toHaveLength(6)
    expect(new Set(result.citations.map((item) => item.chapterId)).size).toBe(6)
  })

  it('rejects duplicate chapter ids before producing ambiguous citation ids', () => {
    expect(() => selectLocalEvidence([
      chapter('duplicate', 1, '目标词'), chapter('duplicate', 2, '目标词'),
    ], { originalQuestion: '目标词' }, {
      requestedUptoChapterId: 'duplicate', progressChapterId: 'duplicate',
    })).toThrow('章节 ID 重复')
  })

  it('returns an empty local result without model behavior when nothing matches', () => {
    expect(selectLocalEvidence(chapters, { originalQuestion: '不存在的人名' }, {
      requestedUptoChapterId: 'c0002', progressChapterId: 'c0002', currentChapterId: 'c0002',
    })).toEqual({ citations: [], fallbackQuery: true, uptoChapterId: 'c0002' })
  })

  it('expands a canonical name to a stored alias and still cites the original paragraph', () => {
    const memory = {
      version: 1 as const, uptoChapterId: 'c0002', updatedAt: '', relations: [], foreshadows: [], events: [],
      characters: [{
        id: 'person-1', name: '顾清', aliases: ['账房先生'], role: '', status: '', summary: '',
        accuracy: 'normal' as const, updatedAt: '',
        sources: [{ id: 'source-1', chapterId: 'c0002', chapterTitle: '第2章 顾清', paragraphIndex: 1, excerpt: '顾清在码头询问账册来源' }],
      }],
    }
    const aliased = [
      chapter('c0001', 1, '开场。\n\n顾清发现旧账册，决定追查失踪案。'),
      chapter('c0002', 2, '推进。\n\n账房先生在码头询问来源，没有再提本名。'),
      chapter('c0003', 3, '未读秘密：账房先生已经找到真凶。'),
    ]
    const result = selectLocalEvidence(aliased, { originalQuestion: '顾清后来去了码头吗？', corePhrase: '码头' }, {
      requestedUptoChapterId: 'c0003', progressChapterId: 'c0002', memory,
    })
    expect(result.citations[0]).toMatchObject({ chapterId: 'c0002', paragraphIndex: 1 })
    expect(result.citations[0]?.excerpt).toContain('账房先生在码头')
    expect(JSON.stringify(result.citations)).not.toContain('真凶')
  })

  it('uses an established character alias to locate a read original paragraph', () => {
    const memory = {
      version: 1 as const, uptoChapterId: 'c0002', updatedAt: '', relations: [], foreshadows: [], events: [],
      characters: [{
        id: 'person-1', name: '顾清', aliases: ['阿清'], role: '', status: '', summary: '',
        accuracy: 'normal' as const, updatedAt: '',
        sources: [{ id: 'source-1', chapterId: 'c0001', chapterTitle: '第1章 顾清', paragraphIndex: 1, excerpt: '顾清发现旧账册' }],
      }],
    }
    const result = selectLocalEvidence(chapters, { originalQuestion: '阿清发现了什么？', corePhrase: '阿清' }, {
      requestedUptoChapterId: 'c0003', progressChapterId: 'c0002', memory,
    })
    expect(result.citations[0]).toMatchObject({ chapterId: 'c0001', paragraphIndex: 1 })
    expect(result.citations[0]?.excerpt).toContain('顾清发现旧账册')
    expect(JSON.stringify(result.citations)).not.toContain('真凶')
  })

  it('grounds a selected-text question in the quoted original even when rewritten terms miss', () => {
    const result = selectLocalEvidence(chapters, {
      originalQuestion: '这段话是什么意思？「顾清发现旧账册，决定追查失踪案。」',
      corePhrase: '不存在的改写词',
    }, {
      requestedUptoChapterId: 'c0003', progressChapterId: 'c0002', currentChapterId: 'c0001',
    })
    expect(result.citations[0]).toMatchObject({ chapterId: 'c0001', paragraphIndex: 1 })
    expect(result.citations[0]?.excerpt).toContain('顾清发现旧账册')
  })

  it('uses a read chapter summary to rank matching original passages', () => {
    const result = selectLocalEvidence(chapters, { originalQuestion: '账册', corePhrase: '账册' }, {
      requestedUptoChapterId: 'c0002', progressChapterId: 'c0002',
      summaries: { version: 2, byChapter: { c0001: '顾清发现账册' }, updatedAt: '' },
    })
    expect(result.citations[0]?.chapterId).toBe('c0001')
    expect(result.citations[0]?.excerpt).toContain('账册')
  })

  it('rejects missing progress coordinates', () => {
    expect(() => selectLocalEvidence(chapters, { originalQuestion: '顾清' }, {
      requestedUptoChapterId: 'c0002', progressChapterId: 'missing',
    })).toThrow('还没有阅读进度')
  })
})
