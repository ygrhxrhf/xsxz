import { describe, expect, it, vi } from 'vitest'
import type { AiCitation } from '../shared/types'
import {
  EVIDENCE_REWRITE_SKIP_MIN_SCORE,
  NO_LOCAL_EVIDENCE_MESSAGE,
  buildEvidenceAnswerMessages,
  executeEvidenceQaPipeline,
  parseEvidenceAnswer,
  planEvidenceChapterReads,
  shouldSkipQueryRewrite,
} from './aiEvidenceQa'

const citation: AiCitation = {
  id: 'qa-c1-p2', chapterId: 'c1', chapterTitle: '第一章', paragraphIndex: 2, excerpt: '顾清在码头找到账册。',
}

function completion(json: Record<string, unknown>, usage: { inputTokens: number; outputTokens?: number; cacheHitTokens?: number } = { inputTokens: 1, outputTokens: 2 }) {
  return { text: JSON.stringify(json), json, usage, truncated: false }
}

describe('evidence QA prompts and citation whitelist', () => {
  it('keeps the fixed no-evidence copy', () => {
    expect(NO_LOCAL_EVIDENCE_MESSAGE).toBe('在已读内容中未找到可核验依据。请换一种问法或使用更具体的人名、地点和事件。')
  })
  it('sends only the question and candidate evidence to the final request', () => {
    const messages = buildEvidenceAnswerMessages('账册在哪里？', [citation], '仅根据证据回答。')
    expect(messages[1]!.content).toBe(JSON.stringify({
      question: '账册在哪里？',
      evidence: [{ id: citation.id, title: citation.chapterTitle, excerpt: citation.excerpt }],
    }))
    // v2 契约：回答拆成逐条结论，每条只挂支持它的候选 id
    expect(messages[0]!.content).toContain('citationIds 只能取支持这一条结论的候选 id')
  })

  it('rejects fabricated ids, missing claims, and empty citation lists while accepting the legacy shape', () => {
    // v2 契约：逐条结论各自带 citationIds
    expect(() => parseEvidenceAnswer({ answer: '回答', claims: [{ text: '回答', citationIds: ['invented'] }] }, [citation]))
      .toThrow('候选范围外')
    expect(() => parseEvidenceAnswer({ answer: '回答' }, [citation])).toThrow('没有按结论返回证据')
    expect(() => parseEvidenceAnswer({ answer: '回答', claims: [] }, [citation])).toThrow('没有按结论返回证据')
    expect(() => parseEvidenceAnswer({ answer: '回答', claims: [{ text: '回答', citationIds: [] }] }, [citation]))
      .toThrow('缺少证据引用')
    // v1 形状（answer + citations）仍被接受：只保留候选范围内、去重后的 id
    expect(parseEvidenceAnswer({ answer: '回答', citations: [citation.id, citation.id] }, [citation]))
      .toMatchObject({ answer: '回答', citations: [citation] })
  })
})

describe('evidence chapter read planning', () => {
  it('sorts catalog metadata before clamping and never includes unread positions in the read slice', () => {
    const plan = planEvidenceChapterReads([
      { id: 'c3', index: 3 }, { id: 'c2', index: 2 }, { id: 'c1', index: 1 },
    ], 'c2')
    expect(plan.ordered.map((item) => item.id)).toEqual(['c1', 'c2', 'c3'])
    expect(plan.ordered.slice(0, plan.progressPosition + 1).map((item) => item.id)).toEqual(['c1', 'c2'])
  })
})

describe('evidence QA pipeline', () => {
  const many = [citation, { ...citation, id: 'qa-c1-p3', paragraphIndex: 3 }, { ...citation, id: 'qa-c1-p4', paragraphIndex: 4 }]

  it('原句检索已经拿到足够依据时不再花一次改写往返', async () => {
    const rewrite = vi.fn(async () => { throw new Error('不该再请求模型') })
    const search = vi.fn(async () => ({ citations: many, uptoChapterId: 'c1', topScore: 120 }))
    const stages: string[] = []
    const result = await executeEvidenceQaPipeline({
      question: '玉印给了谁？', taskInstruction: '规则', stopped: () => false,
      onStage: (stage) => stages.push(stage), rewrite, search,
      answer: async () => completion({ answer: '给了账房。', citations: [citation.id] }),
    })
    expect(rewrite).not.toHaveBeenCalled()
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith({ originalQuestion: '玉印给了谁？' })
    expect(stages).toEqual(['searching', 'requesting'])
    expect(result).toMatchObject({ kind: 'answer', text: '给了账房。', usage: { inputTokens: 1, outputTokens: 2 } })
  })

  it('候选不够或最强那段只是词面重叠时仍走改写、再检索一次', () => {
    expect(shouldSkipQueryRewrite({ citations: many, topScore: EVIDENCE_REWRITE_SKIP_MIN_SCORE })).toBe(true)
    expect(shouldSkipQueryRewrite({ citations: many, topScore: EVIDENCE_REWRITE_SKIP_MIN_SCORE - 1 })).toBe(false)
    expect(shouldSkipQueryRewrite({ citations: many.slice(0, 2), topScore: 999 })).toBe(false)
    expect(shouldSkipQueryRewrite({ citations: [], topScore: 0 })).toBe(false)
  })

  it('改写换来更少依据时沿用原句检索的结果', async () => {
    const onEvidenceSelected = vi.fn()
    const result = await executeEvidenceQaPipeline({
      question: '账册在哪里？', taskInstruction: '规则', stopped: () => false, onStage: () => {}, onEvidenceSelected,
      rewrite: async () => completion({ corePhrase: '无人', keywords: [] }),
      search: async (query) => query.corePhrase
        ? { citations: [citation], uptoChapterId: 'c9', topScore: 0 }
        : { citations: many, uptoChapterId: 'c1', topScore: 39 },
      answer: async () => completion({ answer: '在码头。', citations: [citation.id] }),
    })
    expect(onEvidenceSelected).toHaveBeenCalledWith(many, 'c1')
    expect(result).toMatchObject({ kind: 'answer', citations: [citation], uptoChapterId: 'c1' })
  })

  it('falls back to the original question when rewrite fails', async () => {
    const search = vi.fn(async (query) => ({ citations: [citation], uptoChapterId: 'c1', topScore: 0, query }))
    const onRewriteStarted = vi.fn()
    const answer = vi.fn(async () => completion({ answer: '在码头。', citations: [citation.id] }))
    const result = await executeEvidenceQaPipeline({
      question: '账册在哪里？', taskInstruction: '仅根据证据回答。', stopped: () => false,
      onStage: () => {}, onRewriteStarted,
      rewrite: async () => { throw new Error('rewrite') }, search, answer,
    })
    expect(onRewriteStarted).toHaveBeenCalledOnce()
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith({ originalQuestion: '账册在哪里？' })
    expect(result).toMatchObject({ kind: 'answer', text: '在码头。', citations: [citation], uptoChapterId: 'c1' })
  })

  it('does not make the final model request when local evidence is empty', async () => {
    const answer = vi.fn()
    const onEvidenceSelected = vi.fn()
    const stages: string[] = []
    const result = await executeEvidenceQaPipeline({
      question: '谁？', taskInstruction: '仅根据证据回答。', stopped: () => false,
      onStage: (stage) => stages.push(stage),
      rewrite: async () => completion({ corePhrase: '无人', keywords: [] }),
      search: async () => ({ citations: [], uptoChapterId: 'c2', topScore: 0 }), onEvidenceSelected, answer,
    })
    expect(answer).not.toHaveBeenCalled()
    expect(onEvidenceSelected).toHaveBeenCalledWith([], 'c2')
    expect(stages).toEqual(['searching', 'rewriting', 'searching'])
    expect(result).toEqual({
      kind: 'noEvidence', text: NO_LOCAL_EVIDENCE_MESSAGE, citations: [], uptoChapterId: 'c2',
      usage: { inputTokens: 1, outputTokens: 2 },
    })
  })

  it('uses fixed stages, validates final ids, and merges both request usages', async () => {
    const stages: string[] = []
    const result = await executeEvidenceQaPipeline({
      question: '账册在哪里？', taskInstruction: '仅根据证据回答。', stopped: () => false,
      onStage: (stage) => stages.push(stage),
      rewrite: async () => completion({ corePhrase: '账册', keywords: ['码头'] }, { inputTokens: 2, cacheHitTokens: 1 }),
      search: async () => ({ citations: [citation], uptoChapterId: 'c1', topScore: 0 }),
      answer: async () => completion({ answer: '在码头。', citations: [citation.id] }, { inputTokens: 3, outputTokens: 4 }),
    })
    expect(stages).toEqual(['searching', 'rewriting', 'searching', 'requesting'])
    expect(result).toMatchObject({
      kind: 'answer', text: '在码头。', citations: [citation], uptoChapterId: 'c1', truncated: false,
      usage: { inputTokens: 5, outputTokens: 4, cacheHitTokens: 1 },
    })
  })

  it('改写途中按下停止就不再二次检索、不再提问', async () => {
    let stopped = false
    const search = vi.fn(async () => ({ citations: [], uptoChapterId: 'c1', topScore: 0 }))
    const answer = vi.fn()
    const result = await executeEvidenceQaPipeline({
      question: '问题', taskInstruction: '规则', stopped: () => stopped, onStage: () => {},
      rewrite: async () => { stopped = true; return completion({ corePhrase: '问题' }) }, search, answer,
    })
    expect(result).toEqual({ kind: 'stopped' })
    expect(search).toHaveBeenCalledTimes(1)
    expect(answer).not.toHaveBeenCalled()
  })
})
