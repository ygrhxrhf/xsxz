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

  it('批注块紧跟锚定段落的最后一个文本片段', () => {
    const pager = createRealBookPaginator(
      ['aa', 'bb'],
      fixedLines,
      LAYOUT,
      [{ id: 'n1', paragraph: 0, anchorOffset: 2, height: 40 }],
    )
    pager.ensure(1)
    const pages = pager.pages
    expect(pages[0]!.items.map((item) => item.kind)).toEqual(['text', 'note'])
    expect(pages[0]!.items[1]).toMatchObject({ kind: 'note', noteId: 'n1', paragraph: 0, height: 40 })
  })

  it('批注插在划线结束所在行的后面，而不是整段末尾', () => {
    // 一行一个字符：锚点 offset=2 落在第 2 行（字符 1 的行尾），
    // 批注必须跟在这一行之后，后面还有正文继续排。
    const pager = createRealBookPaginator(
      ['abcdef'],
      fixedLines,
      LAYOUT,
      [{ id: 'n1', paragraph: 0, anchorOffset: 2, height: 40 }],
    )
    pager.ensure(0)
    const page = pager.pages[0]!
    expect(page.items.map((item) => item.kind)).toEqual(['text', 'note', 'text'])
    expect(page.items[0]).toMatchObject({ kind: 'text', start: 0, end: 2, continued: false })
    expect(page.items[1]).toMatchObject({ kind: 'note', noteId: 'n1' })
    expect(page.items[2]).toMatchObject({ kind: 'text', start: 2, continued: true })
  })

  it('批注切开后的后半段跨页时仍标 continued，不再缩进', () => {
    const pager = createRealBookPaginator(
      ['abcdef'],
      fixedLines,
      LAYOUT,
      [{ id: 'n1', paragraph: 0, anchorOffset: 2, height: 40 }],
    )
    pager.ensure(2)
    const tail = pager.pages.flatMap((page) => page.items)
      .find((item) => item.kind === 'text' && item.start >= 2)
    expect(tail).toMatchObject({ start: 2, continued: true })
  })

  it('当前页放不下批注时整张移到下一页，不拆卡片', () => {
    // 第一段 3 行（60），批注 60：本页只剩 40，必须先把本页封掉。
    const pager = createRealBookPaginator(
      ['aaa'],
      fixedLines,
      LAYOUT,
      [{ id: 'n1', paragraph: 0, anchorOffset: 3, height: 60 }],
    )
    pager.ensure(1)
    const pages = pager.pages
    expect(pages[0]!.items.map((item) => item.kind)).toEqual(['text'])
    expect(pages[1]!.items[0]).toMatchObject({ kind: 'note', noteId: 'n1' })
  })

  it('同一段的多条批注按传入顺序连续堆叠', () => {
    const pager = createRealBookPaginator(
      ['aa'],
      fixedLines,
      LAYOUT,
      [
        { id: 'n1', paragraph: 0, anchorOffset: 2, height: 20 },
        { id: 'n2', paragraph: 0, anchorOffset: 2, height: 20 },
      ],
    )
    pager.ensure(1)
    expect(pager.pages[0]!.items.map((item) => item.kind === 'note' ? item.noteId : item.kind))
      .toEqual(['text', 'n1', 'n2'])
  })

  it('纯批注页用锚定段落偏移作为页首锚点', () => {
    const pager = createRealBookPaginator(
      ['', 'aa'],
      fixedLines,
      LAYOUT,
      [{ id: 'n1', paragraph: 0, anchorOffset: 7, height: 30 }],
    )
    pager.ensure(1)
    const page = pager.pages[0]!
    expect(page.items[0]?.kind).toBe('note')
    expect(page.paragraph).toBe(0)
    expect(page.offset).toBe(7)
  })

  it('带批注后查页仍只认文本片段', () => {
    const pager = createRealBookPaginator(
      ['aa', 'bb', 'cc'],
      fixedLines,
      LAYOUT,
      [{ id: 'n1', paragraph: 1, anchorOffset: 2, height: 60 }],
    )
    pager.ensure(5)
    const pages = pager.pages
    expect(findPageForInput(pages, 1, 0)).toBe(0)
    expect(findPageForInput(pages, 2, 0)).toBe(pages.length - 1)
  })
})
