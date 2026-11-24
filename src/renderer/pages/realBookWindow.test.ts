import { describe, expect, it } from 'vitest'
import type { ChapterMeta, ChapterStatus } from '@shared/types'
import {
  buildRealBookWindow,
  localOfMerged,
  mergedWindowParagraphs,
  windowIndexOf,
} from './realBookWindow'

type Status = ChapterStatus
function ch(index: number, status: Status = 'ready'): ChapterMeta {
  return { id: `c${index}`, index, title: `第 ${index + 1} 章`, status, file: `c${index}.txt` }
}

/** 每章 3 段：段落文本 = 「章号.段号」，原始下标 = 章号*100 + 段号（章间不冲突）。 */
function inputOf(meta: ChapterMeta) {
  const base = meta.index * 100
  return {
    paragraphs: [0, 1, 2].map((n) => `${meta.index}.${n}`),
    paragraphIndexes: [0, 1, 2].map((n) => base + n),
  }
}

describe('realBookWindow（整本连排窗口）', () => {
  it('取包含当前章的连续 ready 段，中间一断就收住', () => {
    // 1 ready, 2 ready, 3 pending, 4 ready：当前=2 → 窗口只含 1,2（3 断了）。
    const chapters = [ch(0), ch(1), ch(2), ch(3, 'pending'), ch(4)]
    const win = buildRealBookWindow(chapters, { id: 'c2' }, inputOf)!
    // c0,c1,c2 都 ready，c3 断 → 窗口=连续段 c0..c2（当前 c2 在尾部）。
    expect(win.chapters.map((c) => c.meta.id)).toEqual(['c0', 'c1', 'c2'])
    expect(win.currentIndex).toBe(2)
    expect(win.length).toBe(9)
  })

  it('当前章未 ready 就没有窗口', () => {
    const chapters = [ch(0), ch(1, 'pending'), ch(2)]
    expect(buildRealBookWindow(chapters, { id: 'c1' }, inputOf)).toBeNull()
  })

  it('前后都不 ready 时退化成单章窗口', () => {
    const chapters = [ch(0, 'pending'), ch(1), ch(2, 'pending')]
    const win = buildRealBookWindow(chapters, { id: 'c1' }, inputOf)!
    expect(win.chapters.map((c) => c.meta.id)).toEqual(['c1'])
    expect(win.length).toBe(3)
  })

  it('maxChapters 封顶：优先前向', () => {
    const chapters = [ch(0), ch(1), ch(2), ch(3), ch(4), ch(5), ch(6)]
    // 当前=3，maxChapters=3：前向塞满优先（4,5,6 够 3 章吗？当前+前向=3 章：3,4,5）
    const win = buildRealBookWindow(chapters, { id: 'c3' }, inputOf, { maxChapters: 3 })!
    const ids = win.chapters.map((c) => c.meta.id)
    expect(ids).toContain('c3')
    // 前向优先：3 章 = 当前(3) + 后向(4,5)，不再回头补前向(2,1)
    expect(ids).toEqual(['c3', 'c4', 'c5'])
  })

  it('maxParagraphs 封顶：当前章必进，前向优先塞，塞不下就停', () => {
    const chapters = [ch(0), ch(1), ch(2), ch(3), ch(4)]
    // 每章 3 段；maxParagraphs=7 → 当前(3)+后向(4)=6 段，再塞前向(2)就 9>7，停。
    const win = buildRealBookWindow(chapters, { id: 'c2' }, inputOf, { maxParagraphs: 7 })!
    const ids = win.chapters.map((c) => c.meta.id)
    expect(ids).toContain('c2')
    // 当前章(2)+后向(3)已 6 段；(4) 再 +3=9>7 不进。回头补前向 (1)=+3=9>7 不进，(0) 不进。
    expect(ids).toEqual(['c2', 'c3'])
  })

  it('windowIndexOf / localOfMerged 按 start 边界定位', () => {
    const chapters = [ch(0), ch(1), ch(2)]
    const win = buildRealBookWindow(chapters, { id: 'c1' }, inputOf)!
    expect(win.length).toBe(9)
    expect(win.chapters[0]?.start).toBe(0)
    expect(win.chapters[1]?.start).toBe(3)
    expect(win.chapters[2]?.start).toBe(6)
    // 合并下标 4 落在第 2 章（start=3），局部下标 = 4-3 = 1
    expect(windowIndexOf(win, 4)).toBe(1)
    expect(localOfMerged(win, 4)).toEqual({ win: 1, local: 1 })
    // 合并下标 0 → 第 0 章，局部 0
    expect(localOfMerged(win, 0)).toEqual({ win: 0, local: 0 })
    // 越界小值夹到 0，越界大值落在最后一章
    expect(localOfMerged(win, -1)).toEqual({ win: 0, local: 0 })
    expect(localOfMerged(win, 100)).toEqual({ win: 2, local: 100 - 6 })
  })

  it('mergedWindowParagraphs 首尾相接且原始下标同步', () => {
    const chapters = [ch(0), ch(1)]
    const win = buildRealBookWindow(chapters, { id: 'c0' }, inputOf)!
    const merged = mergedWindowParagraphs(win)
    expect(merged.paragraphs).toEqual(['0.0', '0.1', '0.2', '1.0', '1.1', '1.2'])
    expect(merged.paragraphIndexes).toEqual([0, 1, 2, 100, 101, 102])
    expect(merged.paragraphs.length).toBe(win.length)
  })

  it('bodyAvailable 断窗口：正文取不到就当断', () => {
    const chapters = [ch(0), ch(1), ch(2)]
    // 第 2 章正文取不到 → 窗口收在 1 之前。
    const win = buildRealBookWindow(
      chapters,
      { id: 'c0' },
      inputOf,
      { bodyAvailable: (meta) => meta.index !== 2 },
    )!
    expect(win.chapters.map((c) => c.meta.id)).toEqual(['c0', 'c1'])
  })

  it('跨章翻页：越过上一章末段即进入下一章（合并下标不重排）', () => {
    const chapters = [ch(0), ch(1)]
    const win = buildRealBookWindow(chapters, { id: 'c0' }, inputOf)!
    const c1Start = win.chapters[1]!.start
    const c0Last = c1Start - 1
    // c0 的末段（合并下标 c0Last）仍属 c0；下一页 c1Start 已属 c1。
    expect(localOfMerged(win, c0Last)).toEqual({ win: 0, local: 2 })
    expect(windowIndexOf(win, c1Start)).toBe(1)
    expect(localOfMerged(win, c1Start)).toEqual({ win: 1, local: 0 })
  })

  it('连排不变式：合并数组是各章段落的纯拼接，无章间插页', () => {
    const chapters = [ch(0), ch(1), ch(2)]
    const win = buildRealBookWindow(chapters, { id: 'c1' }, inputOf)!
    const merged = mergedWindowParagraphs(win)
    // 各章 start 严格首尾相接，块长 = total，总长 = 各章 total 之和。
    let cursor = 0
    for (const c of win.chapters) {
      expect(c.start).toBe(cursor)
      for (let k = 0; k < c.total; k += 1) {
        expect(merged.paragraphs[c.start + k]).toBe('' + c.meta.index + '.' + k)
        expect(merged.paragraphIndexes[c.start + k]).toBe(c.meta.index * 100 + k)
      }
      cursor += c.total
    }
    expect(merged.paragraphs.length).toBe(cursor)
    expect(merged.paragraphs.length).toBe(win.length)
  })
})
