import { describe, expect, it, vi } from 'vitest'
import type { AiCitation } from '../shared/types'
import {
  EVIDENCE_REWRITE_SKIP_MIN_SCORE,
  MAX_EVIDENCE_QUOTE_CHARACTERS,
  NO_LOCAL_EVIDENCE_MESSAGE,
  UNSUPPORTED_ANSWER_MESSAGE,
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

  it('提示词把引文规则写死：逐字复制、10 至 120 字、找不到原句就不写这条结论', () => {
    const [system] = buildEvidenceAnswerMessages('账册在哪里？', [citation], '仅根据证据回答。')
    // 按关键词断言而不是整段比较：提示词会继续微调，但这些约束一条都不能丢
    expect(system!.content).toContain('quote')
    expect(system!.content).toContain('逐字')
    expect(system!.content).toContain('10')
    expect(system!.content).toContain('120')
    expect(system!.content).toContain('找不到能逐字引用的原句就不要写这条结论')
  })

  it('带 quote 的结论解析出引文，超长的按没给处理，没给的旧形状不报错', () => {
    const withQuote = parseEvidenceAnswer({
      answer: '她带走了玉印。',
      claims: [{ text: '她带走了玉印。', citationIds: [citation.id], quote: '顾清在码头找到账册' }],
    }, [citation])
    expect(withQuote.claims[0]).toEqual({
      text: '她带走了玉印。', citationIds: [citation.id], quote: '顾清在码头找到账册',
    })
    // 五百字以上的「引文」已经是重写过的正文：按没给处理，免得白花一次判定请求
    const tooLong = parseEvidenceAnswer({
      answer: '她带走了玉印。',
      claims: [{
        text: '她带走了玉印。', citationIds: [citation.id],
        quote: '顾'.repeat(MAX_EVIDENCE_QUOTE_CHARACTERS + 1),
      }],
    }, [citation])
    expect(tooLong.claims[0]).not.toHaveProperty('quote')
    // 边界值仍然收下：上限是「不超过」，不是「小于」
    const edge = '顾'.repeat(MAX_EVIDENCE_QUOTE_CHARACTERS)
    expect(parseEvidenceAnswer({
      answer: '她带走了玉印。',
      claims: [{ text: '她带走了玉印。', citationIds: [citation.id], quote: edge }],
    }, [citation]).claims[0]!.quote).toBe(edge)
    // 旧模型完全不给 quote：不能因为格式升级把一次跑通的问答判成失败
    expect(parseEvidenceAnswer({
      answer: '回答', claims: [{ text: '回答', citationIds: [citation.id] }],
    }, [citation]).claims[0]).not.toHaveProperty('quote')
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

/**
 * 两道闸的合流：引文对不上原文就删结论（不花钱），judge 判不支持也删结论（花一次请求）。
 * 这里只验证「删了什么」与「标签怎么标」：标签一旦把「没跑成」说成「已核验」，
 * 读者就会把模型写的剧情当成原文背过的书。
 */
describe('evidence QA verification', () => {
  const dock: AiCitation = {
    id: 'qa-c1-p2', chapterId: 'c1', chapterTitle: '第一章', paragraphIndex: 2,
    excerpt: '顾清在码头找到账册。',
  }
  const ledger: AiCitation = {
    id: 'qa-c1-p3', chapterId: 'c1', chapterTitle: '第一章', paragraphIndex: 3,
    excerpt: '封皮上写着顾氏两个字。',
  }
  const seal: AiCitation = {
    id: 'qa-c1-p4', chapterId: 'c1', chapterTitle: '第一章', paragraphIndex: 4,
    excerpt: '她把玉印交给了码头的账房先生。',
  }
  const evidence = [dock, ledger, seal]

  /** 两条结论，引文都能在各自的原段里逐字找到。 */
  const quotedAnswer = {
    answer: '顾清找到了账册。\n账册上写着顾氏。',
    claims: [
      { text: '顾清找到了账册。', citationIds: [dock.id], quote: '顾清在码头找到账册' },
      { text: '账册上写着顾氏。', citationIds: [ledger.id], quote: '封皮上写着顾氏两个字' },
    ],
  }

  /**
   * 原句检索已经拿到三条依据且最强那段足够强：不再走改写，只留「检索 + 提问」两段。
   * rewrite 必填但不会跑到：真被调到就说明跳过改写的判断坏了（stages 会多出 rewriting）。
   */
  const baseOptions = {
    question: '玉印给了谁？',
    taskInstruction: '仅根据证据回答。',
    stopped: () => false,
    onStage: () => {},
    rewrite: async () => { throw new Error('原句检索已经拿到依据，不该再请求模型') },
    search: async () => ({ citations: evidence, uptoChapterId: 'c1', topScore: 120 }),
    answer: async () => completion(quotedAnswer),
  }

  function answerResult(result: Awaited<ReturnType<typeof executeEvidenceQaPipeline>>) {
    if (result.kind !== 'answer') throw new Error(`预期是回答，实际是 ${result.kind}`)
    return result
  }

  it('引文对不上原文的结论被删掉；全删光时直说找不到能逐字支撑的原文', async () => {
    const verify = vi.fn(async () => completion({ verdicts: [{ index: 0, supported: true }] }))
    const stages: string[] = []
    const result = await executeEvidenceQaPipeline({
      ...baseOptions,
      onStage: (stage) => stages.push(stage),
      answer: async () => completion({
        answer: '她带走了玉印。\n账房先生接手了码头。',
        claims: [
          // 两段引文都是改写过的、在原段里找不到的「伪逐字引用」
          { text: '她带走了玉印。', citationIds: [dock.id], quote: '她把玉印揣进了怀里' },
          { text: '账房先生接手了码头。', citationIds: [seal.id], quote: '玉印后来落到了陌生人手里' },
        ],
      }),
      verify,
    })
    expect(result).toEqual({
      kind: 'unsupported', text: UNSUPPORTED_ANSWER_MESSAGE, citations: [], uptoChapterId: 'c1',
      usage: { inputTokens: 1, outputTokens: 2 },
    })
    // 引文一条都没落地，judge 已经无可判定：不能再花一次请求，也不能上报「正在核验」
    expect(verify).not.toHaveBeenCalled()
    expect(stages).toEqual(['searching', 'requesting'])
  })

  it('judge 判否的结论被删掉，剩下的标成 partial 并说清删了几条', async () => {
    const verify = vi.fn(async () => completion({
      verdicts: [{ index: 0, supported: true }, { index: 1, supported: false }],
    }))
    const stages: string[] = []
    const result = answerResult(await executeEvidenceQaPipeline({
      ...baseOptions,
      onStage: (stage) => stages.push(stage),
      verify,
    }))
    expect(stages).toContain('verifying')
    expect(result.verification).toBe('partial')
    expect(result.droppedClaims).toBe(1)
    // 幸存结论按原顺序重拼正文：界面是按 claims 逐条渲染的，两者必须一致
    expect(result.text).toBe('顾清找到了账册。')
    expect(result.text).toBe(result.claims.map((claim) => claim.text).join('\n'))
    expect(result.claims).toEqual([
      { text: '顾清找到了账册。', citationIds: [dock.id], quote: '顾清在码头找到账册' },
    ])
    // 被删结论的依据不能再留在「依据」块里充当无主段落
    expect(result.citations).toEqual([dock])
  })

  it('judge 抛错或返回非法格式时结论全部保留，只标成未校验', async () => {
    const failures: Array<[string, () => Promise<ReturnType<typeof completion>>]> = [
      ['请求失败', async () => { throw new Error('judge 超时') }],
      ['返回非法格式', async () => completion({ note: '我觉得都对' })],
    ]
    for (const [label, verify] of failures) {
      const stages: string[] = []
      const result = answerResult(await executeEvidenceQaPipeline({
        ...baseOptions,
        onStage: (stage) => stages.push(stage),
        verify,
      }))
      expect(stages, label).toContain('verifying')
      // 校验是加分项：挂掉不能把已经生成好、引用也合规的回答吞掉
      expect(result.claims, label).toHaveLength(2)
      expect(result.verification, label).toBe('not_run')
      expect(result.droppedClaims, label).toBe(0)
      expect(result.text, label).toBe(quotedAnswer.answer)
    }
  })

  it('每条结论都带逐字引文且 judge 全判支持时标成 verified', async () => {
    const verify = vi.fn(async () => completion({
      verdicts: [{ index: 0, supported: true }, { index: 1, supported: true }],
    }))
    const result = answerResult(await executeEvidenceQaPipeline({ ...baseOptions, verify }))
    expect(result.verification).toBe('verified')
    expect(result.droppedClaims).toBe(0)
    expect(result.claims).toHaveLength(2)
    expect(result.citations).toEqual([dock, ledger])
    // judge 的 token 也要记进账：它跟回答一起构成这一轮的真实花销
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 4 })
  })

  it('模型完全不给引文又没有校验回调时结论全部保留，但只说未校验', async () => {
    const result = answerResult(await executeEvidenceQaPipeline({
      ...baseOptions,
      // 旧形状：只有结论与引用 id，没有 quote
      answer: async () => completion({
        answer: '顾清找到了账册。\n账册上写着顾氏。',
        claims: [
          { text: '顾清找到了账册。', citationIds: [dock.id] },
          { text: '账册上写着顾氏。', citationIds: [ledger.id] },
        ],
      }),
    }))
    expect(result.claims).toHaveLength(2)
    expect(result.droppedClaims).toBe(0)
    expect(result.verification).toBe('not_run')
  })

  /**
   * 读者关掉「回答后核对原文」时的两条底线：
   * 一、真的不再发那个核验请求（这是关它的唯一理由）；
   * 二、结果必须标成 disabled，不能伪装成 not_run（故障）或 partial（核过但删了结论）。
   */
  it('设置里关掉核验时不发 verify 请求，结论带引文的结果标成 disabled', async () => {
    const verify = vi.fn(async () => completion({
      verdicts: [{ index: 0, supported: true }, { index: 1, supported: true }],
    }))
    const stages: string[] = []
    const result = answerResult(await executeEvidenceQaPipeline({
      ...baseOptions,
      onStage: (stage) => stages.push(stage),
      // 故意把 verify 也递进去：读者关掉的开关必须比调用方的传参优先，
      // 否则“关掉核验却还在花钱”这种最难察觉的回归就没人拦。
      verify,
      verifyDisabled: true,
    }))
    expect(verify).not.toHaveBeenCalled()
    expect(stages).not.toContain('verifying')
    expect(result.verification).toBe('disabled')
    // 关掉核验不等于删结论：引文本地已经对上了，结论必须原样留下
    expect(result.claims).toHaveLength(2)
    expect(result.droppedClaims).toBe(0)
    expect(result.text).toBe(quotedAnswer.answer)
  })

  it('关掉核验但模型没给引文时仍标 not_run：连引文都没有，说成「已关闭核验」是在替它开脱', async () => {
    const result = answerResult(await executeEvidenceQaPipeline({
      ...baseOptions,
      verifyDisabled: true,
      answer: async () => completion({
        answer: '顾清找到了账册。',
        claims: [{ text: '顾清找到了账册。', citationIds: [dock.id] }],
      }),
    }))
    expect(result.verification).toBe('not_run')
  })

  it('开着核验时 verifyDisabled 缺省不影响原有判定', async () => {
    const verify = vi.fn(async () => completion({
      verdicts: [{ index: 0, supported: true }, { index: 1, supported: true }],
    }))
    const result = answerResult(await executeEvidenceQaPipeline({ ...baseOptions, verify }))
    expect(verify).toHaveBeenCalledTimes(1)
    expect(result.verification).toBe('verified')
  })
})
