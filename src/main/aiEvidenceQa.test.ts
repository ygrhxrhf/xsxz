import { describe, expect, it, vi } from 'vitest'
import type { AiCitation } from '../shared/types'
import {
  NO_LOCAL_EVIDENCE_MESSAGE,
  buildEvidenceAnswerMessages,
  executeEvidenceQaPipeline,
  parseEvidenceAnswer,
  planEvidenceChapterReads,
} from './aiEvidenceQa'

const citation: AiCitation = {
  id: 'qa-c1-p2', chapterId: 'c1', chapterTitle: '第一章', paragraphIndex: 2, excerpt: '顾清在码头找到账册。',
}

function completion(json: Record<string, unknown>, usage = { inputTokens: 1, outputTokens: 2 }) {
  return { text: JSON.stringify(json), json, usage, truncated: false }
}

describe('evidence QA prompts and citation whitelist', () => {
  it('sends only the question and candidate evidence to the final request', () => {
    const messages = buildEvidenceAnswerMessages('账册在哪里？', [citation], '仅根据证据回答。')
    expect(messages[1]!.content).toBe(JSON.stringify({
      question: '账册在哪里？',
      evidence: [{ id: citation.id, title: citation.chapterTitle, excerpt: citation.excerpt }],
    }))
    expect(messages[0]!.content).toContain('citations 只能填写候选证据中存在的 id')
  })

  it('rejects fabricated, missing, or empty citations and deduplicates valid ids', () => {
    expect(() => parseEvidenceAnswer({ answer: '回答', citations: ['invented'] }, [citation])).toThrow('候选范围外')
    expect(() => parseEvidenceAnswer({ answer: '回答' }, [citation])).toThrow('有效证据引用')
    expect(() => parseEvidenceAnswer({ answer: '回答', citations: [] }, [citation])).toThrow('缺少证据引用')
    expect(parseEvidenceAnswer({ answer: '回答', citations: [citation.id, citation.id] }, [citation]))
      .toEqual({ answer: '回答', citations: [citation] })
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
  it('falls back to the original question when rewrite fails', async () => {
    const search = vi.fn(async (query) => ({ citations: [citation], uptoChapterId: 'c1', query }))
    const answer = vi.fn(async () => completion({ answer: '在码头。', citations: [citation.id] }))
    const result = await executeEvidenceQaPipeline({
      question: '账册在哪里？', taskInstruction: '仅根据证据回答。', stopped: () => false,
      onStage: () => {}, rewrite: async () => { throw new Error('rewrite') }, search, answer,
    })
    expect(search).toHaveBeenCalledWith({ originalQuestion: '账册在哪里？' })
    expect(result).toMatchObject({ kind: 'answer', text: '在码头。', citations: [citation], uptoChapterId: 'c1' })
  })

  it('does not make the final model request when local evidence is empty', async () => {
    const answer = vi.fn()
    const stages: string[] = []
    const result = await executeEvidenceQaPipeline({
      question: '谁？', taskInstruction: '仅根据证据回答。', stopped: () => false,
      onStage: (stage) => stages.push(stage),
      rewrite: async () => completion({ corePhrase: '无人', keywords: [] }),
      search: async () => ({ citations: [], uptoChapterId: 'c2' }), answer,
    })
    expect(answer).not.toHaveBeenCalled()
    expect(stages).toEqual(['rewriting', 'searching'])
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
      search: async () => ({ citations: [citation], uptoChapterId: 'c1' }),
      answer: async () => completion({ answer: '在码头。', citations: [citation.id] }, { inputTokens: 3, outputTokens: 4 }),
    })
    expect(stages).toEqual(['rewriting', 'searching', 'requesting'])
    expect(result).toEqual({
      kind: 'answer', text: '在码头。', citations: [citation], uptoChapterId: 'c1', truncated: false,
      usage: { inputTokens: 5, outputTokens: 4, cacheHitTokens: 1 },
    })
  })

  it('stops between stages without searching or answering', async () => {
    let stopped = false
    const search = vi.fn()
    const answer = vi.fn()
    const result = await executeEvidenceQaPipeline({
      question: '问题', taskInstruction: '规则', stopped: () => stopped, onStage: () => {},
      rewrite: async () => { stopped = true; return completion({ corePhrase: '问题' }) }, search, answer,
    })
    expect(result).toEqual({ kind: 'stopped' })
    expect(search).not.toHaveBeenCalled()
    expect(answer).not.toHaveBeenCalled()
  })
})
