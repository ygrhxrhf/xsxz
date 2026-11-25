import { describe, expect, it } from 'vitest'
import type { AiCitation } from '@shared/types'
import { appendChatStep, claimCitationLines, evidenceVerificationLabel } from './readerChatMessage'

function citation(id: string): AiCitation {
  return { id, chapterId: 'c1', chapterTitle: '第一章', paragraphIndex: 0, excerpt: `第 ${id} 段` }
}

describe('思考链（appendChatStep）', () => {
  it('第一步进链时是 running', () => {
    expect(appendChatStep(undefined, '查目录'))
      .toEqual([{ label: '查目录', state: 'running' }])
  })

  it('上一步在新一步到来时翻成 done，只留最后一步在跑', () => {
    const steps = appendChatStep(appendChatStep(undefined, '查目录'), '读第二章')
    expect(steps).toEqual([
      { label: '查目录', state: 'done' },
      { label: '读第二章', state: 'running' },
    ])
  })

  it('同一个 label 连续重复时合并，不刷流水账', () => {
    const first = appendChatStep(undefined, '检索原文')
    const again = appendChatStep(first, '检索原文')
    expect(again).toEqual([{ label: '检索原文', state: 'running' }])
    // 隔了一步之后同名 label 是新的一步，不能被合并掉
    expect(appendChatStep(appendChatStep(again, '读原文'), '检索原文')).toEqual([
      { label: '检索原文', state: 'done' },
      { label: '读原文', state: 'done' },
      { label: '检索原文', state: 'running' },
    ])
  })

  it('空 label 只收尾：running 翻终态，链本身保留', () => {
    const steps = appendChatStep(appendChatStep(undefined, '查目录'), '读原文')
    expect(appendChatStep(steps, '')).toEqual([
      { label: '查目录', state: 'done' },
      { label: '读原文', state: 'done' },
    ])
    // 失败收尾能把还在跑的那一步标成 error
    expect(appendChatStep(steps, '  ', 'error')).toEqual([
      { label: '查目录', state: 'done' },
      { label: '读原文', state: 'error' },
    ])
  })

  it('没有可收尾的步骤时保持原样，空链返回 undefined', () => {
    expect(appendChatStep(undefined, '')).toBeUndefined()
    expect(appendChatStep([], '')).toBeUndefined()
    const settled = [{ label: '查目录', state: 'done' as const }]
    expect(appendChatStep(settled, '')).toEqual(settled)
  })

  it('不改调用方传进来的数组（Vue 里要能触发响应式更新）', () => {
    const original = [{ label: '查目录', state: 'running' as const }]
    const next = appendChatStep(original, '读原文')
    expect(original).toEqual([{ label: '查目录', state: 'running' }])
    expect(next).not.toBe(original)
  })
})

describe('内联引用角标（claimCitationLines）', () => {
  it('角标序号取引用在 citations 里的位置，从 1 开始', () => {
    const lines = claimCitationLines({
      citations: [citation('a'), citation('b'), citation('c')],
      claims: [
        { text: '她把玉印交了出去。', citationIds: ['b', 'c'] },
        { text: '码头的账房先生接手。', citationIds: ['a'] },
      ],
    })
    expect(lines.map((line) => line.text)).toEqual(['她把玉印交了出去。', '码头的账房先生接手。'])
    expect(lines[0]!.badges.map((badge) => badge.label)).toEqual([2, 3])
    expect(lines[1]!.badges.map((badge) => badge.label)).toEqual([1])
    expect(lines[0]!.badges[0]!.citation.id).toBe('b')
  })

  it('没有 claims 或没有 citations 时给空列表，界面据此走原文渲染', () => {
    expect(claimCitationLines({})).toEqual([])
    expect(claimCitationLines({ claims: [{ text: '结论', citationIds: ['a'] }] }))
      .toEqual([{ text: '结论', badges: [] }])
    expect(claimCitationLines({ claims: [], citations: [citation('a')] })).toEqual([])
  })

  it('找不到的引用 id 与重复 id 都不产出角标', () => {
    const lines = claimCitationLines({
      citations: [citation('a')],
      claims: [{ text: '结论', citationIds: ['missing', 'a', 'a'] }],
    })
    expect(lines[0]!.badges).toEqual([{ label: 1, citation: citation('a') }])
  })
})

/**
 * 徽标文案是可信度的唯一出口：说错一个词，读者就会把模型的推测当成原文背过的书。
 * 重点盯住「没核」的两种原因不能混——disabled 是读者自己关的（省钱选择），
 * not_run 是核验没跑成（故障）。
 */
describe('可信度徽标（evidenceVerificationLabel）', () => {
  it('disabled 写「已关闭原文核验」，不能用故障性的 not_run 那套说法', () => {
    const label = evidenceVerificationLabel({ verification: 'disabled', claims: [{ text: '结论', citationIds: ['a'] }] })
    expect(label).toContain('已关闭原文核验')
    expect(label).not.toContain('未运行校验')
    expect(label).not.toContain('校验请求失败')
  })

  it('not_run 仍是「未运行校验」，不能说成已关闭或已核验', () => {
    const label = evidenceVerificationLabel({ verification: 'not_run', claims: [{ text: '结论', citationIds: ['a'] }] })
    expect(label).toContain('未运行校验')
    expect(label).not.toContain('已关闭')
    expect(label).not.toContain('已核验')
  })

  it('旧记录没有 verification 时返回空串：界面不显示任何徽标', () => {
    expect(evidenceVerificationLabel({ claims: [{ text: '结论', citationIds: ['a'] }] })).toBe('')
  })
})
