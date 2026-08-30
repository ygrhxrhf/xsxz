import { describe, expect, it } from 'vitest'
import { locateMemorySourceParagraph, normalizeMemorySourceText } from './memorySourceLocator'

describe('memory source paragraph relocation', () => {
  it('accepts the original coordinate when normalized paragraph contains the excerpt', () => {
    expect(locateMemorySourceParagraph(['前文', '顾清  推开了门。\n风从里面吹来。'], 1, '顾清推开了门。 风从里面吹来。'))
      .toEqual({ paragraphIndex: 1, mode: 'exact' })
  })

  it('relocates a drifted source to the nearest matching paragraph', () => {
    const paragraphs = ['相同摘录内容', '新增段落', '相同摘录内容', '尾声']
    expect(locateMemorySourceParagraph(paragraphs, 3, '相同 摘录内容'))
      .toEqual({ paragraphIndex: 2, mode: 'relocated' })
    expect(locateMemorySourceParagraph(paragraphs, 1, '相同摘录内容'))
      .toEqual({ paragraphIndex: 0, mode: 'relocated' })
  })

  it('relocates a generated excerpt spanning adjacent paragraphs to its starting paragraph', () => {
    const paragraphs = ['序章', `甲${'风'.repeat(50)}`, `${'雨'.repeat(50)}乙`, '尾声']
    const excerpt = `${'风'.repeat(40)}\n\n${'雨'.repeat(40)}`
    expect(locateMemorySourceParagraph(paragraphs, 0, excerpt))
      .toEqual({ paragraphIndex: 1, mode: 'relocated' })
  })

  it('falls back to chapter start for missing or empty excerpts', () => {
    expect(locateMemorySourceParagraph(['正文'], 9, '没有出现')).toEqual({ paragraphIndex: 0, mode: 'fallback' })
    expect(locateMemorySourceParagraph(['正文'], 0, ' \n ')).toEqual({ paragraphIndex: 0, mode: 'fallback' })
  })

  it('handles invalid indices deterministically without mutating Unicode input', () => {
    const paragraphs = ['序', '“甲😀！”', '尾']
    const snapshot = [...paragraphs]
    expect(locateMemorySourceParagraph(paragraphs, Number.NaN, '甲😀！'))
      .toEqual({ paragraphIndex: 1, mode: 'relocated' })
    expect(locateMemorySourceParagraph(paragraphs, -2, '甲😀！'))
      .toEqual({ paragraphIndex: 1, mode: 'relocated' })
    expect(paragraphs).toEqual(snapshot)
  })

  it('normalizes all whitespace without changing other text', () => {
    expect(normalizeMemorySourceText('甲\n 乙\t丙')).toBe('甲乙丙')
  })
})
