import { describe, expect, it } from 'vitest'
import {
  createRealBookPaginator,
  findPageForInput,
  pageForAnchor,
  pageIndexFromRatio,
  pageRatio,
  type RealBookLine,
} from './realBookPager'

/**
 * 分页引擎是纯函数，所以能直接测断页规则——这是真实书籍渲染层的地基：
 * 页表错了，锚点恢复、划线落位、进度互换全都会错。
 */

/** 把一段文字切成每行 1 个字符的假行。 */
function fixedLines(text: string): RealBookLine[] {
  const lines: RealBookLine[] = []
  for (let start = 0; start < text.length; start += 1) {
    lines.push({ start, end: Math.min(text.length, start + 1) })
  }
  return lines
}

/** 页高 100、行高 20：每页 5 行。 */
const LAYOUT = { pageHeight: 100, lineHeight: 20, paragraphGap: 0 }

describe('realBookPager（真实书籍分页）', () => {
  it('本页放不下的整段整体挪到下一页，不在页尾腰斩', () => {
    // 第一段 3 行（占掉 3 行），第二段 3 行：本页只剩 2 行，第二段整体挪到第二页。
    const pager = createRealBookPaginator(['aaa', 'bbb'], fixedLines, LAYOUT)
    pager.ensure(1)
    const pages = pager.pages
    expect(pages).toHaveLength(2)
    expect(pages[0]!.items).toHaveLength(1)
    expect(pages[0]!.items[0]).toMatchObject({ paragraph: 0, start: 0, end: 3, continued: false })
    expect(pages[1]!.items).toHaveLength(1)
    expect(pages[1]!.items[0]).toMatchObject({ paragraph: 1, start: 0, end: 3, continued: false })
  })

  it('比一整页还高的超长段按行切开续排，续页片段标 continued', () => {
    const pager = createRealBookPaginator(['abcdefgh'], fixedLines, LAYOUT)
    pager.ensure(1)
    const pages = pager.pages
    expect(pages).toHaveLength(2)
    expect(pages[0]!.items[0]).toMatchObject({ paragraph: 0, start: 0, end: 5, continued: false })
    expect(pages[1]!.items[0]).toMatchObject({ paragraph: 0, start: 5, end: 8, continued: true })
  })

  it('段间距只在两段之间计一次', () => {
    // 页高 100、行高 20、段间距 20：两段各 2 行（40 + 20 + 40 = 100）正好放满一页。
    const pager = createRealBookPaginator(['ab', 'cd'], fixedLines, {
      pageHeight: 100,
      lineHeight: 20,
      paragraphGap: 20,
    })
    pager.ensure(0)
    const pages = pager.pages
    expect(pages).toHaveLength(1)
    expect(pages[0]!.items.map((item) => item.paragraph)).toEqual([0, 1])
  })

  it('惰性排版：只排到要求的页，不提前排完整章', () => {
    const paragraphs = Array.from({ length: 20 }, () => 'xx')
    let measured = 0
    const pager = createRealBookPaginator(
      paragraphs,
      (text) => {
        measured += 1
        return fixedLines(text)
      },
      LAYOUT,
    )
    pager.ensure(0)
    expect(measured).toBeLessThan(paragraphs.length)
    const before = measured
    pager.ensure(9)
    expect(measured).toBeGreaterThan(before)
  })

  it('最后一页不满页也算一页，排完标记 complete', () => {
    const pager = createRealBookPaginator(['abcde', 'de'], fixedLines, LAYOUT)
    pager.ensure(5)
    const pages = pager.pages
    expect(pages).toHaveLength(2)
    expect(pages[1]!.items[0]).toMatchObject({ paragraph: 1, start: 0, end: 2 })
    expect(pager.complete).toBe(true)
  })

  it('锚点能查回所在页', () => {
    const pager = createRealBookPaginator(['aaaa', 'bbbb', 'cccc'], fixedLines, LAYOUT)
    pager.ensure(2)
    const pages = pager.pages
    expect(pages).toHaveLength(3)
    expect(findPageForInput(pages, 0, 0)).toBe(0)
    expect(findPageForInput(pages, 1, 0)).toBe(1)
    expect(findPageForInput(pages, 2, 0)).toBe(2)
  })

  it('pageForAnchor 用原始段落下标查页', () => {
    const pager = createRealBookPaginator(['aaaa', 'bbbb'], fixedLines, LAYOUT)
    pager.ensure(1)
    const pages = pager.pages
    expect(pageForAnchor(pages, { paragraph: 0, offset: 0 })).toBe(0)
    expect(pageForAnchor(pages, { paragraph: 1, offset: 0 })).toBe(1)
  })

  it('页码与比例互相换算', () => {
    expect(pageRatio(0, 5)).toBe(0)
    expect(pageRatio(4, 5)).toBe(1)
    expect(pageRatio(2, 5)).toBe(0.5)
    expect(pageIndexFromRatio(0.5, 5)).toBe(2)
    expect(pageIndexFromRatio(1, 5)).toBe(4)
    // 只有一页时比例恒为 0，避免除零。
    expect(pageRatio(0, 1)).toBe(0)
    expect(pageIndexFromRatio(0.5, 1)).toBe(0)
  })

  it('空正文不产生页', () => {
    const pager = createRealBookPaginator([], () => [], LAYOUT)
    pager.ensure(0)
    expect(pager.pages).toHaveLength(0)
  })
})
