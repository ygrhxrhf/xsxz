import { describe, expect, it } from 'vitest'
import {
  buildExcerpt,
  decorateText,
  paraIndexOfOffset,
  paragraphRanges,
  relocateRange,
  segmentParagraphText,
} from './paragraphSearch'

describe('paragraphRanges', () => {
  it('mirrors the reader split: blank lines separate paragraphs, empties dropped', () => {
    const body = '第一段\n\n第二段\n\n\n\n第三段'
    const ranges = paragraphRanges(body)
    expect(ranges.map((r) => body.slice(r.start, r.end))).toEqual(['第一段', '第二段', '第三段'])
    expect(ranges.map((r) => r.index)).toEqual([0, 1, 2])
  })

  it('handles leading blank lines and empty bodies', () => {
    expect(paragraphRanges('\n\n只有一段')).toHaveLength(1)
    expect(paragraphRanges('')).toEqual([])
    expect(paragraphRanges('\n\n\n')).toEqual([])
  })

  it('maps an offset to the containing paragraph', () => {
    const body = '甲乙丙\n\n丁戊己庚\n\n辛'
    const ranges = paragraphRanges(body)
    expect(paraIndexOfOffset(ranges, 0)).toBe(0)
    expect(paraIndexOfOffset(ranges, body.indexOf('丁'))).toBe(1)
    expect(paraIndexOfOffset(ranges, body.indexOf('辛'))).toBe(2)
    expect(paraIndexOfOffset(ranges, body.length + 5)).toBe(-1)
  })
})

describe('buildExcerpt', () => {
  it('keeps about twenty chars of context and marks truncation', () => {
    const long = '一'.repeat(50) + '关键词' + '二'.repeat(50)
    const excerpt = buildExcerpt(long, long.indexOf('关键词'), 3)
    expect(excerpt.startsWith('…')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt).toContain('关键词')
  })

  it('does not add ellipses at the edges and flattens line breaks', () => {
    expect(buildExcerpt('开头关键词结尾', 2, 3)).toBe('开头关键词结尾')
    const withBreak = '前一句。\n\n这里有关键词在中间'
    const excerpt = buildExcerpt(withBreak, withBreak.indexOf('关键词'), 3, 6)
    expect(excerpt).not.toContain('\n')
  })
})

describe('segmentParagraphText', () => {
  it('marks every case-insensitive hit and keeps surrounding text', () => {
    expect(segmentParagraphText('He said Hello, HELLO! hello?', 'hello')).toEqual([
      { text: 'He said ', hit: false },
      { text: 'Hello', hit: true },
      { text: ', ', hit: false },
      { text: 'HELLO', hit: true },
      { text: '! ', hit: false },
      { text: 'hello', hit: true },
      { text: '?', hit: false },
    ])
  })

  it('returns one plain segment when nothing matches or query is blank', () => {
    expect(segmentParagraphText('纯文本一段', '不存在的词')).toEqual([{ text: '纯文本一段', hit: false }])
    expect(segmentParagraphText('纯文本一段', '   ')).toEqual([{ text: '纯文本一段', hit: false }])
  })
})

describe('decorateText', () => {
  it('overlays search hits and highlight ranges simultaneously', () => {
    const text = '月光照在墙上，月光下有人走过。'
    const segs = decorateText(text, '月光', [
      { start: 0, end: 2 },
      { start: 8, end: 10 },
    ])
    expect(segs.map((s) => s.text).join('')).toBe(text)
    expect(segs[0]).toEqual({ text: '月光', hit: true, hl: true })
    // 第二处「月光」被划线区间切成三段：月 / 光 / 下
    expect(segs.filter((s) => s.hit)).toHaveLength(3)
    expect(segs.find((s) => s.hl && !s.hit)).toEqual({ text: '下', hit: false, hl: true })
  })

  it('clips out-of-range highlight intervals and ignores empty text', () => {
    expect(decorateText('', 'x', [{ start: 0, end: 5 }])).toEqual([])
    const segs = decorateText('只有一段', '', [{ start: -3, end: 2 }, { start: 99, end: 120 }])
    expect(segs[0]).toEqual({ text: '只有', hit: false, hl: true })
    expect(decorateText('纯文本', '', [])).toEqual([{ text: '纯文本', hit: false, hl: false }])
  })
})

describe('relocateRange（划线漂移校正）', () => {
  it('keeps offsets when the excerpt still matches in place', () => {
    const body = '前缀文字，窗外月光如水，后缀继续。'
    expect(relocateRange(body, 5, 9, '窗外月光')).toEqual({ start: 5, end: 9 })
  })

  it('relocates by excerpt when offsets drifted after AI cleaning', () => {
    const body = '清理后的新开头。窗外月光如水。结尾'
    expect(relocateRange(body, 100, 104, '窗外月光')).toEqual({
      start: body.indexOf('窗外月光'),
      end: body.indexOf('窗外月光') + 4,
    })
  })

  it('returns null when the excerpt is gone and validates bad input', () => {
    expect(relocateRange('完全不同了', 0, 2, '窗外月光')).toBeNull()
    expect(relocateRange('任意正文', -1, -1, '')).toBeNull()
  })
})
