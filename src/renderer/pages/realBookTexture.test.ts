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

  it('纹理签名随字体/页内容变化，用于避免无谓重绘', () => {
    const first = textureStyleSignature(page(), STYLE)
    const second = textureStyleSignature(page(), { ...STYLE, fontSize: 20 })
    expect(first).not.toBe(second)
  })
})
