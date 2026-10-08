import { describe, expect, it } from 'vitest'
import { renderedParagraphs, retrievalTerms } from '../shared/aiText'
import { EVIDENCE_NO_PROGRESS_MESSAGE, evidenceReadHints, normalizeEvidenceSearchTerms, selectLocalEvidence } from './aiEvidenceSearch'

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

  it('改述提问没有字面短语时仍按词面重叠召回', () => {
    const paraphrased = [
      chapter('c0001', 1, '夜色里的码头没有人。'),
      chapter('c0002', 2, '她把玉印交给了码头的账房先生，转身离开。'),
    ]
    const query = { originalQuestion: '玉印交给谁了', corePhrase: '玉印交给谁' }
    expect(paraphrased[1]!.body).not.toContain('玉印交给谁')
    const result = selectLocalEvidence(paraphrased, query, {
      requestedUptoChapterId: 'c0002', progressChapterId: 'c0002',
    })
    expect(result.citations[0]?.chapterId).toBe('c0002')
    expect(result.citations[0]?.excerpt).toContain('她把玉印交给了码头的账房先生')
  })

  it('改述候选分数封顶，压不过 corePhrase 字面命中', () => {
    const mixed = [
      chapter('c0001', 1, '账房先生问过玉印的下落，没有人答话。'),
      chapter('c0002', 2, '她把玉印交给了码头的人。'),
    ]
    const result = selectLocalEvidence(mixed, { originalQuestion: '玉印的下落', corePhrase: '玉印的下落' }, {
      requestedUptoChapterId: 'c0002', progressChapterId: 'c0002', currentChapterId: 'c0002',
    })
    expect(result.citations.map((item) => item.chapterId)).toEqual(['c0001', 'c0002'])
    expect(result.citations[1]?.excerpt).toContain('她把玉印交给了码头的人')
  })

  it('段号与渲染段号一致，空行里的空白也算一段', () => {
    const body = '第一段\n\n　\n\n第二段里有玉印'
    const rendered = renderedParagraphs(body)
    expect(rendered).toHaveLength(3)
    const result = selectLocalEvidence([chapter('c0001', 1, body)], { originalQuestion: '玉印', corePhrase: '玉印' }, {
      requestedUptoChapterId: 'c0001', progressChapterId: 'c0001',
    })
    expect(result.citations[0]?.paragraphIndex).toBe(2)
    expect(rendered[result.citations[0]!.paragraphIndex]).toContain('玉印')
  })

  it('命中段过短并邻段补进摘录，坐标仍指向命中段', () => {
    const body = '她把玉印收进袖中。\n\n账房先生追问了很久。\n\n第二天码头开船。'
    const result = selectLocalEvidence([chapter('c0001', 1, body)], {
      originalQuestion: '账房先生追问', corePhrase: '账房先生追问',
    }, { requestedUptoChapterId: 'c0001', progressChapterId: 'c0001', excerptCharacters: 80 })
    expect(result.citations[0]?.paragraphIndex).toBe(1)
    expect(result.citations[0]?.excerpt).toContain('她把玉印收进袖中')
    expect(result.citations[0]?.excerpt).toContain('第二天码头开船')
  })

  it('读者的划线只提升排序，不改变可引用的正文范围', () => {
    const noted = [
      chapter('c0001', 1, '甲段提到码头。\n\n乙段也提到码头。'),
      chapter('c0002', 2, '丙段提到码头。'),
    ]
    const base = selectLocalEvidence(noted, { originalQuestion: '码头', corePhrase: '码头' }, {
      requestedUptoChapterId: 'c0002', progressChapterId: 'c0002',
    })
    const lifted = selectLocalEvidence(noted, { originalQuestion: '码头', corePhrase: '码头' }, {
      requestedUptoChapterId: 'c0002', progressChapterId: 'c0002',
      readerNotes: [{ chapterId: 'c0001', paragraphIndex: 1 }],
    })
    expect(lifted.citations[0]).toMatchObject({ chapterId: 'c0001', paragraphIndex: 1 })
    expect(base.citations[0]?.paragraphIndex).not.toBe(1)
  })
})

describe('读盘剪枝提示', () => {
  const headers = chapters.map((item) => ({ id: item.id, index: item.index }))

  it('必选集含当前章与截止章，正文词面是否重叠都在所不问', () => {
    const hints = evidenceReadHints(headers, { originalQuestion: '王城', corePhrase: '王城' }, {
      requestedUptoChapterId: 'c0002', progressChapterId: 'c0002', currentChapterId: 'c0001',
      summaries: { version: 1, byChapter: { c0001: '王城的账册来路' }, updatedAt: '2026-10-08T00:00:00.000Z' },
    })
    expect(hints.cutoffPosition).toBe(1)
    expect(hints.currentIndex).toBe(1)
    expect(hints.prunable, '两个字的短语有二元窗，可以剪枝').toBe(true)
    expect([...hints.mandatory].sort()).toEqual(['c0001', 'c0002'])
  })

  it('记忆指向的章与当前章都进必选集，越界与否由读盘计划按截止章筛掉', () => {
    const hints = evidenceReadHints(headers, { originalQuestion: '顾清', corePhrase: '顾清' }, {
      requestedUptoChapterId: 'c0003', progressChapterId: 'c0002', currentChapterId: 'c0003',
      memory: {
        version: 1, characters: [{
          id: 'ch1', name: '顾清', aliases: [], role: '', status: '', summary: '', accuracy: 'normal',
          updatedAt: '2026-10-08T00:00:00.000Z',
          sources: [{ id: 's1', chapterId: 'c0004', chapterTitle: '第4章', paragraphIndex: 0, excerpt: '王城' }],
        }], relations: [], foreshadows: [], events: [], updatedAt: '2026-10-08T00:00:00.000Z',
      },
    })
    expect(hints.uptoChapterId).toBe('c0002')
    expect([...hints.mandatory].sort()).toEqual(['c0002', 'c0003', 'c0004'])
  })

  it('单字面短语测不出词形，直接取消剪枝资格', () => {
    const hints = evidenceReadHints(headers, { originalQuestion: '玉', corePhrase: '玉' }, {
      requestedUptoChapterId: 'c0002', progressChapterId: 'c0002',
    })
    expect([...hints.terms]).toEqual([])
    expect(hints.prunable).toBe(false)
  })

  it('「」引用被归一化压成单字时同样取消剪枝资格', () => {
    const hints = evidenceReadHints(headers, { originalQuestion: '「玉 」是什么意思' }, {
      requestedUptoChapterId: 'c0002', progressChapterId: 'c0002',
    })
    expect(hints.terms.size, '整句仍给出词形，挡不住的是单字引用').toBeGreaterThan(0)
    expect(hints.prunable).toBe(false)
  })

  it('剪枝词形是打分词面的超集：字面短语、关键词、别名、引用锚都在内', () => {
    const memory = {
      version: 1, characters: [{
        id: 'ch1', name: '顾清', aliases: ['账房小姐'], role: '', status: '', summary: '', accuracy: 'normal',
        updatedAt: '2026-10-08T00:00:00.000Z', sources: [],
      }], relations: [], foreshadows: [], events: [], updatedAt: '2026-10-08T00:00:00.000Z',
    } as const
    const hints = evidenceReadHints(headers, {
      originalQuestion: '「旧账册」里顾清最先发现什么', corePhrase: '旧账册', keywords: ['码头'],
    }, { requestedUptoChapterId: 'c0002', progressChapterId: 'c0002', memory: memory as never })
    for (const phrase of ['旧账册', '码头', '账房小姐']) {
      for (const term of retrievalTerms(phrase)) expect(hints.terms.has(term), `${phrase} 的词形 ${term} 缺失`).toBe(true)
    }
  })

  it('阅读进度缺失时与打分同一处报错', () => {
    expect(() => evidenceReadHints(headers, { originalQuestion: '顾清' }, {
      requestedUptoChapterId: 'missing', progressChapterId: 'missing',
    })).toThrow(EVIDENCE_NO_PROGRESS_MESSAGE)
  })
})
