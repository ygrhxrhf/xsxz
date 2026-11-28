import { describe, expect, it, vi } from 'vitest'
import type { AiCitation, AiEvidenceClaim } from '../shared/types'
import type { EvidenceVerifyMessage } from './aiEvidenceVerify'
import {
  applyQuoteCheck,
  buildEvidenceVerifyMessages,
  findQuoteCitation,
  normalizeEvidenceText,
  parseEvidenceVerdicts,
  verifyEvidenceClaims,
} from './aiEvidenceVerify'

/**
 * 引文校验是「答案可信度闭环」里唯一不花钱的一半：本地子串比对。
 * 它必须只做一件事——判断引文是不是真的来自原文——所以这里把边界都钉死：
 * 空白不算差异，引号与首尾标点不算差异，中间改一个字就必须判不中。
 */

const dock: AiCitation = {
  id: 'qa-c1-p2', chapterId: 'c1', chapterTitle: '第一章', paragraphIndex: 2,
  excerpt: '顾清在码头找到账册，封皮上写着顾氏两个字。',
}
const ledger: AiCitation = {
  id: 'qa-c1-p3', chapterId: 'c1', chapterTitle: '第一章', paragraphIndex: 3,
  excerpt: '她把玉印交给了码头的账房先生。',
}

function claim(text: string, citationIds: string[], quote?: string): AiEvidenceClaim {
  return { text, citationIds, ...(quote ? { quote } : {}) }
}

function verdicts(...items: Array<{ index: number; supported: unknown }>) {
  return { verdicts: items }
}

describe('normalizeEvidenceText', () => {
  it('去掉换行、半角空格与全角空格，保留标点与文字', () => {
    expect(normalizeEvidenceText('顾清 在码头\n找到\u3000账册，')).toBe('顾清在码头找到账册，')
    // 标点必须原样留下：归一化只处理「排版差异」，不处理「用词差异」
    expect(normalizeEvidenceText('顾清在码头找到账册，')).toContain('，')
    expect(normalizeEvidenceText('')).toBe('')
  })
})

describe('findQuoteCitation', () => {
  it('命中原文的连续一段就返回那条 citation', () => {
    expect(findQuoteCitation('顾清在码头找到账册', [dock, ledger])).toBe(dock.id)
    expect(findQuoteCitation('她把玉印交给了码头的账房先生', [dock, ledger])).toBe(ledger.id)
  })

  it('空白与首尾引号、句号不算差异', () => {
    // 模型抄原文时常把句子连标点一起抄，还爱加引号
    expect(findQuoteCitation('「顾清在码头找到账册，封皮上写着顾氏两个字。」', [dock])).toBe(dock.id)
    expect(findQuoteCitation('顾清 在码头\n找到账册', [dock])).toBe(dock.id)
    expect(findQuoteCitation('她把玉印交给了码头的账房先生。', [ledger])).toBe(ledger.id)
  })

  it('改写、省略、跨段拼接一律返回 null', () => {
    expect(findQuoteCitation('顾清在码头捡到账册', [dock, ledger])).toBeNull()
    expect(findQuoteCitation('顾清在码头……写着顾氏两个字', [dock, ledger])).toBeNull()
    // 跨两段拼接的「引文」在每一段里都不是子串：这正是要拦住的伪造
    expect(findQuoteCitation('顾清在码头找到账册她把玉印交给了账房先生', [dock, ledger])).toBeNull()
    // 全是标点的引文没有可核对的内容
    expect(findQuoteCitation('（）', [dock])).toBeNull()
    expect(findQuoteCitation('', [dock])).toBeNull()
  })
})

describe('applyQuoteCheck', () => {
  it('把 citationIds 收窄到真的包含引文的那几条', () => {
    const checked = applyQuoteCheck([
      claim('顾清找到了账册', [ledger.id, dock.id], '顾清在码头找到账册'),
    ], [dock, ledger])
    expect(checked.claims).toEqual([claim('顾清找到了账册', [dock.id], '顾清在码头找到账册')])
    expect(checked).toMatchObject({ dropped: 0, quoted: 1, unquoted: 0 })
  })

  it('引文一处都对不上就删掉这条结论', () => {
    const checked = applyQuoteCheck([
      claim('她烧了账册', [dock.id], '她烧掉了账册'),
      claim('她拿到了玉印', [ledger.id], '她把玉印交给了码头的账房先生'),
    ], [dock, ledger])
    expect(checked.claims.map((item) => item.text)).toEqual(['她拿到了玉印'])
    expect(checked).toMatchObject({ dropped: 1, quoted: 1 })
  })

  it('没给 quote 的结论原样保留但记为未引证', () => {
    // 旧模型完全不返回 quote：这时删结论等于因为格式升级清空回答，只能标成「未校验」
    const checked = applyQuoteCheck([claim('在码头。', [dock.id])], [dock, ledger])
    expect(checked.claims).toEqual([claim('在码头。', [dock.id])])
    expect(checked).toMatchObject({ dropped: 0, quoted: 0, unquoted: 1 })
  })

  it('引文都对不上时全部删掉，由上层回「没有能逐字支撑的原文」', () => {
    const checked = applyQuoteCheck([
      claim('她烧了账册', [dock.id], '她烧掉了账册'),
      claim('玉印沉了', [ledger.id], '玉印沉进江里'),
    ], [dock, ledger])
    expect(checked.claims).toEqual([])
    expect(checked).toMatchObject({ dropped: 2, quoted: 0 })
  })
})

describe('buildEvidenceVerifyMessages', () => {
  it('一次请求带上每条结论与它引用的原文段，并写清判定规则', () => {
    const messages = buildEvidenceVerifyMessages([
      claim('顾清找到了账册', [dock.id], '顾清在码头找到账册'),
      claim('她把玉印交了出去', [ledger.id], '她把玉印交给了码头的账房先生'),
    ], [dock, ledger])
    expect(messages).toHaveLength(2)
    const system = messages[0]!.content
    // 只判「这段原文是否支持这条结论」，不评价结论本身
    expect(system).toContain('只判断该段原文是否支持该结论')
    expect(system).toContain('不评价结论本身对不对')
    // 书外知识不能当依据，否则核查器自己就开始编
    expect(system).toContain('不使用引文之外的知识')
    expect(system).toContain('{"verdicts":[{"index":0,"supported":true}]}')
    expect(JSON.parse(messages[1]!.content)).toEqual({
      items: [
        { index: 0, claim: '顾清找到了账册', evidence: [{ title: '第一章', excerpt: dock.excerpt }] },
        { index: 1, claim: '她把玉印交了出去', evidence: [{ title: '第一章', excerpt: ledger.excerpt }] },
      ],
    })
  })
})

describe('parseEvidenceVerdicts', () => {
  it('按下标还原布尔数组', () => {
    expect(parseEvidenceVerdicts(verdicts({ index: 1, supported: false }, { index: 0, supported: true }), 2))
      .toEqual([true, false])
  })

  it('条数不符、下标越界或重复、判定不是布尔都算不合法', () => {
    expect(() => parseEvidenceVerdicts({ verdicts: 'yes' }, 1)).toThrow('缺少 verdicts')
    expect(() => parseEvidenceVerdicts(verdicts({ index: 0, supported: true }), 2)).toThrow('条数')
    expect(() => parseEvidenceVerdicts(verdicts({ index: 2, supported: true }, { index: 3, supported: true }), 2))
      .toThrow('下标越界')
    expect(() => parseEvidenceVerdicts(verdicts({ index: 0, supported: true }, { index: 0, supported: false }), 2))
      .toThrow('下标重复')
    expect(() => parseEvidenceVerdicts(verdicts({ index: 0, supported: 'true' }), 1)).toThrow('布尔判定')
    expect(() => parseEvidenceVerdicts({ verdicts: [null] }, 1)).toThrow('格式无效')
  })
})

describe('verifyEvidenceClaims', () => {
  const claims = [
    claim('顾清找到了账册', [dock.id], '顾清在码头找到账册'),
    claim('她把玉印交了出去', [ledger.id], '她把玉印交给了码头的账房先生'),
  ]

  it('只提交带引文的结论，其余位置填 true 而不是判否', async () => {
    // 参数写成具体类型：否则 mock 的 calls 推成空元组，取 messages[1] 时 tsc 会报越界。
    const request = vi.fn(async (_messages: EvidenceVerifyMessage[]) => ({
      text: '{}', json: verdicts({ index: 0, supported: true }), truncated: false,
      usage: { inputTokens: 9, outputTokens: 2 },
    }))
    const result = await verifyEvidenceClaims({ request }, [
      claims[0]!,
      claim('没有引文的结论', [dock.id]),
    ], [dock, ledger])
    expect(request).toHaveBeenCalledOnce()
    const sent = JSON.parse(request.mock.calls[0]![0][1]!.content) as { items: Array<{ claim: string }> }
    expect(sent.items.map((item) => item.claim)).toEqual(['顾清找到了账册'])
    expect(result).toEqual({ supported: [true, true], usage: { inputTokens: 9, outputTokens: 2 } })
  })

  it('没有可判定的结论时不发请求', async () => {
    const request = vi.fn()
    await expect(verifyEvidenceClaims({ request }, [claim('没有引文', [dock.id])], [dock]))
      .resolves.toEqual({ supported: null })
    expect(request).not.toHaveBeenCalled()
  })

  it('请求失败、格式不合法、已停止都返回 null，绝不抛给上层', async () => {
    await expect(verifyEvidenceClaims({ request: async () => { throw new Error('网络断了') } }, claims, [dock, ledger]))
      .resolves.toEqual({ supported: null })
    await expect(verifyEvidenceClaims({
      request: async () => ({ text: '随便说说', json: { note: '我觉得都对' }, truncated: false }),
    }, claims, [dock, ledger])).resolves.toEqual({ supported: null })
    const controller = new AbortController()
    controller.abort()
    const request = vi.fn()
    await expect(verifyEvidenceClaims({ request }, claims, [dock, ledger], controller.signal))
      .resolves.toEqual({ supported: null })
    expect(request, '已经停止就别再花一次请求').not.toHaveBeenCalled()
  })

  it('判定结果作废时仍带回已经花掉的用量', async () => {
    // 请求成功了、token 真花了，只是返回格式不对：钱不能不记
    await expect(verifyEvidenceClaims({
      request: async () => ({
        text: '{}', json: { verdicts: [] }, truncated: false, usage: { inputTokens: 7, outputTokens: 1 },
      }),
    }, claims, [dock, ledger])).resolves.toEqual({ supported: null, usage: { inputTokens: 7, outputTokens: 1 } })
  })

  it('judge 判否的结论在下标上能被准确找到', async () => {
    const result = await verifyEvidenceClaims({
      request: async () => ({
        text: '{}', truncated: false,
        json: verdicts({ index: 0, supported: true }, { index: 1, supported: false }),
      }),
    }, claims, [dock, ledger])
    expect(result.supported).toEqual([true, false])
  })
})
