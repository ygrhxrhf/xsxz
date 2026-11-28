import { describe, expect, it } from 'vitest'
import {
  PAGE_TEXTURE_HEIGHT,
  PAGE_TEXTURE_MARGIN_INNER,
  PAGE_TEXTURE_MARGIN_OUTER,
  PAGE_TEXTURE_WIDTH,
  buildPageTexturePlan,
  textureStyleSignature,
  type RealBookTexturePage,
  type RealBookTextureStyle,
  type RealBookTextureTextItem,
} from './realBookTexture'

const STYLE: RealBookTextureStyle = {
  fontSize: 18,
  lineHeight: 27,
  fontFamily: 'serif',
  paragraphGap: 8,
  paper: '#f1dbbe',
  ink: '#241c15',
  muted: 'rgba(36,28,21,0.52)',
  searchQuery: '文',
}

function page(partial: Partial<RealBookTexturePage> = {}): RealBookTexturePage {
  return {
    pageNumber: 3,
    chapterTitle: '第一章 测试',
    items: [{
      kind: 'text',
      text: '第一段文字。',
      originalIndex: 2,
      start: 0,
      end: 6,
      continued: false,
      lines: [{ start: 0, end: 3 }, { start: 3, end: 6 }],
      highlights: [{ start: 1, end: 5, color: 'yellow' }],
      noteMarks: [4],
    }],
    ...partial,
  }
}

describe('buildPageTexturePlan', () => {
  it('固定为参考站的 640×920 逻辑页，并按行区间落字', () => {
    const plan = buildPageTexturePlan(page(), STYLE)
    expect(plan.width).toBe(PAGE_TEXTURE_WIDTH)
    expect(plan.height).toBe(PAGE_TEXTURE_HEIGHT)
    expect(plan.lines.map((line) => line.text)).toEqual(['第一段', '文字。'])
    // pageNumber=3 是左页，起排用外口边距 58；首行缩进 2em=36。
    expect(plan.lines[0]!.x).toBe(PAGE_TEXTURE_MARGIN_OUTER + 36)
    expect(plan.lines[1]!.x).toBe(PAGE_TEXTURE_MARGIN_OUTER)
    expect(plan.lines[0]!.firstLine).toBe(true)
    expect(plan.lines[1]!.firstLine).toBe(false)
    expect(plan.lines[0]!.paragraphIndex).toBe(2)
  })

  it('页眉优先用页面自己的 header：左页书名、右页章节名', () => {
    expect(buildPageTexturePlan(page({ header: '智人之后' }), STYLE).header).toBe('智人之后')
    expect(buildPageTexturePlan(page({ header: undefined }), STYLE).header).toBe('第一章 测试')
    expect(textureStyleSignature(page({ header: '甲' }), STYLE))
      .not.toBe(textureStyleSignature(page({ header: '乙' }), STYLE))
  })

  it('页眉页脚的字号与基线随计划给出，DOM 文本层按同一组数值贴字', () => {
    const plan = buildPageTexturePlan(page({ header: '书名', pageNumber: 12 }), STYLE)
    expect(plan.headerFontSize).toBeCloseTo(18 * 0.62)
    expect(plan.headerBaseline).toBe(plan.marginTop - 10)
    expect(plan.footer).toBe('12')
    expect(plan.footerFontSize).toBeCloseTo(18 * 0.62)
    // 与画布页脚同一套基线：页底页边距往上留一个字号的高度。
    expect(plan.footerBaseline).toBeCloseTo(plan.height - plan.marginBottom + 18 * 0.8)
    // 空页不印页码，但页眉（书名/章节名）照旧。
    const blank = buildPageTexturePlan(page({ pageNumber: 0, items: [] }), STYLE)
    expect(blank.footer).toBe('')
    expect(blank.header).toBe('第一章 测试')
  })

  it('划线按字符区间映射到行内坐标，搜索命中单独叠加', () => {
    const plan = buildPageTexturePlan(page(), STYLE)
    expect(plan.lines[0]!.marks).toContainEqual(expect.objectContaining({ start: 1, end: 3 }))
    expect(plan.lines[1]!.marks).toContainEqual(expect.objectContaining({ start: 0, end: 2 }))
    expect(plan.lines[1]!.marks.some((mark) => mark.color.includes('0.42'))).toBe(true)
  })

  it('红色/紫色划线使用各自颜色，不回落成默认黄色', () => {
    const base = page().items[0] as RealBookTextureTextItem
    const red = buildPageTexturePlan(page({
      items: [{ ...base, highlights: [{ start: 1, end: 5, color: 'red' }] }],
    }), STYLE)
    const purple = buildPageTexturePlan(page({
      items: [{ ...base, highlights: [{ start: 1, end: 5, color: 'purple' }] }],
    }), STYLE)
    expect(red.lines[0]!.marks[0]!.color).not.toBe('rgba(240, 185, 90, 0.34)')
    expect(purple.lines[0]!.marks[0]!.color).not.toBe('rgba(240, 185, 90, 0.34)')
  })

  it('「注」标记只落在包含锚点的行', () => {
    const plan = buildPageTexturePlan(page(), STYLE)
    expect(plan.lines[0]!.noteMarks).toEqual([])
    expect(plan.lines[1]!.noteMarks).toEqual([1])
  })

  it('批注卡保留分页器给出的高度，并排在正文之后', () => {
    const plan = buildPageTexturePlan(page({
      items: [
        ...page().items,
        {
          kind: 'note',
          height: 80,
          continued: false,
          continues: true,
          lines: [{ y: 0, h: 20, baseline: 15, words: [{ text: '页内批注', x: 0, w: 40, font: '14px serif', size: 14, s: -1, e: -1 }] }],
          textColor: 'default',
          note: {
            id: 'n1',
            paragraph: 2,
            offset: 4,
            text: '这是一条页内批注',
            source: 'user',
            createdAt: '2026-11-14T00:00:00.000Z',
          },
        },
      ],
    }), STYLE)
    expect(plan.notes).toHaveLength(1)
    // 片段字段原样进入 note box，lines 非空才能让上游 renderPage 画出真实文本行。
    expect(plan.notes[0]!.continues).toBe(true)
    expect(plan.notes[0]!.continued).toBe(false)
    expect(plan.notes[0]!.lines.length).toBeGreaterThan(0)
    expect(plan.notes[0]!.width).toBe(PAGE_TEXTURE_WIDTH - PAGE_TEXTURE_MARGIN_INNER - PAGE_TEXTURE_MARGIN_OUTER)
    expect(plan.notes[0]!.height).toBe(80)
    expect(plan.notes[0]!.y).toBeGreaterThan(plan.lines.at(-1)!.y)
  })

  it('旧分页快照没有 lines 时仍保留整段文字', () => {
    const plan = buildPageTexturePlan(page({
      items: [{
        kind: 'text',
        text: '没有行区间',
        originalIndex: 0,
        start: 0,
        end: 5,
        continued: false,
        lines: [],
        highlights: [],
        noteMarks: [],
      }],
    }), STYLE)
    expect(plan.lines).toHaveLength(1)
    expect(plan.lines[0]!.text).toBe('没有行区间')
  })

  it('同一条便签的不同片段纹理签名不同，不共用缓存', () => {
    const note = {
      id: 'n1',
      paragraph: 2,
      offset: 4,
      text: '一条很长的便签',
      source: 'user' as const,
      createdAt: '2026-11-14T00:00:00.000Z',
    }
    const line = (text: string) => ({
      y: 0, h: 20, baseline: 15,
      words: [{ text, x: 0, w: 40, font: '14px serif', size: 14, s: -1, e: -1 }],
    })
    const fragment = (continued: boolean, continues: boolean, text: string) => page({
      items: [{ kind: 'note', note, height: 60, continued, continues, lines: [line(text)], textColor: 'default' }],
    })
    const first = textureStyleSignature(fragment(false, true, '前半'), STYLE)
    const second = textureStyleSignature(fragment(true, false, '后半'), STYLE)
    expect(first).not.toBe(second)
  })

  it('纹理签名随字体/页内容变化，用于避免无谓重绘', () => {
    const first = textureStyleSignature(page(), STYLE)
    const second = textureStyleSignature(page(), { ...STYLE, fontSize: 20 })
    expect(first).not.toBe(second)
  })
})
