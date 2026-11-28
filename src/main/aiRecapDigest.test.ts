import { describe, expect, it } from 'vitest'
import type { AiMemoryCharacter, AiMemoryEvent, AiMemoryForeshadow, AiMemoryFile } from '../shared/types'
import { countTextCharacters } from './aiBudget'
import {
  activeEntityTerms,
  buildRecapDigest,
  groupSummaryWindows,
  pickWindowHighlights,
} from './aiRecapDigest'

const source = [{ id: 'ev-c0001-p0-s1', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '摘' }]

function character(name: string, aliases: string[] = []): AiMemoryCharacter {
  return {
    id: `character-${name}`, name, aliases, role: '角色', status: '在场',
    summary: '说明', accuracy: 'normal', updatedAt: '2026-01-01T00:00:00.000Z', sources: source,
  }
}

function foreshadow(desc: string, status: AiMemoryForeshadow['status']): AiMemoryForeshadow {
  return {
    id: `foreshadow-${desc}`, desc, status,
    summary: '说明', accuracy: 'normal', updatedAt: '2026-01-01T00:00:00.000Z', sources: source,
  }
}

function event(title: string, participants: string[], updatedAt: string): AiMemoryEvent {
  return {
    id: `event-${title}`, title, participants, result: '结果',
    summary: '说明', accuracy: 'normal', updatedAt, sources: source,
  }
}

function memoryOf(overrides: Partial<AiMemoryFile>): AiMemoryFile {
  return {
    version: 1,
    characters: [],
    relations: [],
    foreshadows: [],
    events: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function summaryItem(index: number, text: string) {
  return { chapterId: `c${String(index).padStart(4, '0')}`, title: `第${index}章`, text }
}

describe('recap digest windows', () => {
  it('切窗用数组下标，整除时正好装满，末窗不足也保留', () => {
    const items = Array.from({ length: 40 }, (_, index) => summaryItem(index + 1, '内容'))
    const windows = groupSummaryWindows(items, 20)
    expect(windows.map((window) => [window.start, window.end])).toEqual([[0, 19], [20, 39]])
    expect(windows.map((window) => window.items.length)).toEqual([20, 20])
    expect(windows[1]!.items[0]).toBe(items[20])

    const remainder = groupSummaryWindows([...items, summaryItem(41, '余数')], 20)
    expect(remainder.map((window) => [window.start, window.end])).toEqual([[0, 19], [20, 39], [40, 40]])
    expect(remainder[2]!.items).toHaveLength(1)
  })

  it('默认每窗 20 章，空输入没有窗口', () => {
    const items = Array.from({ length: 25 }, (_, index) => summaryItem(index + 1, '内容'))
    expect(groupSummaryWindows(items).map((window) => [window.start, window.end])).toEqual([[0, 19], [20, 24]])
    expect(groupSummaryWindows([])).toEqual([])
  })

  it('拒绝非法窗宽，避免死循环', () => {
    expect(() => groupSummaryWindows([summaryItem(1, '内容')], 0)).toThrow('摘要窗口大小必须是正整数')
    expect(() => groupSummaryWindows([summaryItem(1, '内容')], 2.5)).toThrow('摘要窗口大小必须是正整数')
    expect(() => groupSummaryWindows([summaryItem(1, '内容')], Number.NaN)).toThrow('摘要窗口大小必须是正整数')
  })
})

describe('active entity terms', () => {
  it('收人物名与别名、未回收伏笔、最近事件，并去掉单字与重复', () => {
    const memory = memoryOf({
      characters: [character('顾清', ['小清', '清', '顾清'])],
      foreshadows: [
        foreshadow('旧账册', 'open'),
        foreshadow('玉印来历', 'uncertain'),
        foreshadow('已了结的婚约', 'resolved'),
      ],
      events: [event('渡口交货', ['顾清', '周勉'], '2026-01-02T00:00:00.000Z')],
    })
    expect(activeEntityTerms(memory)).toEqual(['顾清', '小清', '旧账册', '玉印来历', '渡口交货', '周勉'])
  })

  it('只取最近 10 条事件的标题与参与者', () => {
    const memory = memoryOf({
      events: Array.from({ length: 12 }, (_, index) =>
        event(`事件${index + 1}`, [`参与者${index + 1}`], `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`)),
    })
    const terms = activeEntityTerms(memory)
    expect(terms).toContain('事件12')
    expect(terms).toContain('参与者3')
    expect(terms).not.toContain('事件1')
    expect(terms).not.toContain('事件2')
  })

  it('词表最多 80 个，没有记忆时为空', () => {
    const memory = memoryOf({
      characters: Array.from({ length: 100 }, (_, index) => character(`角色${String(index).padStart(2, '0')}`)),
    })
    expect(activeEntityTerms(memory)).toHaveLength(80)
    expect(activeEntityTerms(null)).toEqual([])
  })
})

describe('window highlights', () => {
  const terms = ['顾清', '玉印', '旧账册', '周勉']

  it('按命中词数打分，同分保持章节原顺序', () => {
    const items = [
      summaryItem(1, '顾清在雨里等了整夜。玉印的纹路她看不懂。'),
      summaryItem(2, '周勉赶回城。'),
      summaryItem(3, '这一章只写了天气。'),
      summaryItem(4, '玉印再次出现，顾清没认出它。'),
      summaryItem(5, '顾清又想起旧账册。'),
    ]
    const highlights = pickWindowHighlights({ start: 0, end: items.length - 1, items }, terms)
    // 第 1、4、5 章都命中两个词（3 分），按原顺序取前三；第 2 章只命中一个词排后。
    expect(highlights.map((item) => item.chapterId)).toEqual(['c0001', 'c0004', 'c0005'])
    expect(highlights.map((item) => item.excerpt)).toEqual(['顾清在雨里等了整夜', '玉印再次出现，顾清没认出它', '顾清又想起旧账册'])
  })

  it('同一个词只算一次命中，命中多个词再加一分', () => {
    const items = [
      summaryItem(1, '顾清走了。顾清又回来了。顾清还在。'),
      summaryItem(2, '顾清与周勉在渡口碰面。'),
    ]
    const highlights = pickWindowHighlights({ start: 0, end: 1, items }, terms)
    // 第 2 章命中两个词（3 分）高于第 1 章只命中一个词（1 分）。
    expect(highlights.map((item) => item.chapterId)).toEqual(['c0002', 'c0001'])
  })

  it('摘第一句，超过 80 字截断并补省略号', () => {
    const long = `${'顾'.concat('清'.repeat(100))}。第二句不再取。`
    const highlights = pickWindowHighlights(
      { start: 0, end: 0, items: [summaryItem(1, long)] },
      terms,
    )
    expect(highlights[0]!.excerpt.endsWith('…')).toBe(true)
    expect(countTextCharacters(highlights[0]!.excerpt)).toBe(81)
    const short = pickWindowHighlights({ start: 0, end: 0, items: [summaryItem(2, '顾清。玉印还在。')] }, terms)
    expect(short[0]!.excerpt).toBe('顾清')
  })

  it('没有命中就不硬凑，perWindow 限制条数', () => {
    const items = [summaryItem(1, '只写天气。'), summaryItem(2, '只写下雪。')]
    expect(pickWindowHighlights({ start: 0, end: 1, items }, terms)).toEqual([])
    const hitting = [summaryItem(1, '顾清'), summaryItem(2, '玉印'), summaryItem(3, '周勉'), summaryItem(4, '旧账册')]
    expect(pickWindowHighlights({ start: 0, end: 3, items: hitting }, terms, 1)).toHaveLength(1)
    expect(pickWindowHighlights({ start: 0, end: 3, items: hitting }, terms)).toHaveLength(3)
  })
})

describe('recap digest assembly', () => {
  const terms = ['顾清', '玉印']
  const windows = groupSummaryWindows([
    summaryItem(1, '顾清在渡口丢了货。'),
    summaryItem(2, '顾清查到了玉印。'),
  ], 1)

  it('最旧的窗先装，超出预算就停在上一窗', () => {
    const oldestBlock = '【第1章】顾清在渡口丢了货'
    expect(countTextCharacters(oldestBlock)).toBe(13)
    const onlyOldest = buildRecapDigest(windows, terms, 20)
    expect(onlyOldest.windows).toBe(1)
    expect(onlyOldest.chapters).toBe(1)
    expect(onlyOldest.text).toBe(oldestBlock)

    const both = buildRecapDigest(windows, terms, 100)
    expect(both.windows).toBe(2)
    expect(both.chapters).toBe(2)
    expect(both.text.indexOf('第1章')).toBeLessThan(both.text.indexOf('第2章'))
    expect(both.text).toContain('\n\n')
  })

  it('预算不够就什么都不放，没命中的窗跳过不计数', () => {
    expect(buildRecapDigest(windows, terms, 0)).toEqual({ text: '', windows: 0, chapters: 0 })
    expect(buildRecapDigest(windows, [], 1_000)).toEqual({ text: '', windows: 0, chapters: 0 })
    const mixed = groupSummaryWindows([
      summaryItem(1, '顾清出场。'),
      summaryItem(2, '只写天气。'),
      summaryItem(3, '玉印出现。'),
    ], 1)
    const digest = buildRecapDigest(mixed, terms, 1_000)
    expect(digest.windows).toBe(2)
    expect(digest.chapters).toBe(2)
    expect(digest.text).not.toContain('只写天气')
  })
})
