import { describe, expect, it } from 'vitest'
import {
  CLEAN_PARAGRAPH_SEGMENT_LIMIT,
  aiBudgetWarning,
  countTextCharacters,
  estimateAiTokens,
  normalizeAiParagraphs,
} from './aiBudget'

describe('AI request budgeting', () => {
  it('counts Unicode code points instead of UTF-16 units', () => {
    expect(countTextCharacters('甲😀乙')).toBe(3)
  })

  it('estimates CJK and other characters with the frozen formula', () => {
    // ceil(((3 / 1.5) + (4 / 4)) * 1.1) = ceil(3.3) = 4
    expect(estimateAiTokens('中文本abcd')).toBe(4)
    expect(estimateAiTokens('')).toBe(0)
  })

  it('normalizes blank lines and splits a single oversized paragraph', () => {
    const paragraphs = normalizeAiParagraphs(`  第一段\r\n\r\n\n第二段  \n\n${'甲'.repeat(8_001)}`)
    expect(paragraphs.slice(0, 2)).toEqual(['第一段', '第二段'])
    expect(paragraphs[2]).toHaveLength(CLEAN_PARAGRAPH_SEGMENT_LIMIT)
    expect(paragraphs[3]).toBe('甲')
  })

  it('ignores multiple empty paragraphs without creating empty targets', () => {
    expect(normalizeAiParagraphs('\n\n \n\n正文\n\n\n')).toEqual(['正文'])
  })

  it('warns at the configured token threshold', () => {
    const budget = { originalCharacters: 1200, sentCharacters: 1200, estimatedTokens: 8000, chapterCount: 1, paragraphCount: 3, batchCount: 1, range: '本章' }
    expect(aiBudgetWarning(budget, 8001)).toBeNull()
    expect(aiBudgetWarning(budget, 8000)).toContain('8000 tokens')
  })
})
