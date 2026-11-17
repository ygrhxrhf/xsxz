import { describe, expect, it } from 'vitest'
import { imageBlockLayout, noteBlockLayout, type PageBlockTools } from './realBookBlocks'
import type { PageTextureImageBox, PageTextureNoteBox } from './realBookTexture'

/** 固定字宽 10px/字，断行由测试自己给，避免依赖 canvas。 */
const tools: PageBlockTools = {
  measure: (text) => text.length * 10,
  wrap: () => ['第一行', '第二行', '第三行', '第四行（不该出现）'],
}

const noteBox: PageTextureNoteBox = {
  x: 80,
  y: 200,
  width: 480,
  height: 90,
  note: {
    id: 'n1',
    paragraph: 3,
    offset: 12,
    text: '这是一条很长很长的批注，用来检查断行与三行上限。',
    source: 'ai',
    tags: ['人物', '伏笔'],
    createdAt: '2026-01-01T00:00:00.000Z',
  },
}

const style = { fontSize: 22, lineHeight: 33 }

describe('noteBlockLayout', () => {
  it('标签、正文、tag 行按纹理同一套字号与基线排出来', () => {
    const layout = noteBlockLayout(noteBox, style, tools)
    expect(layout.id).toBe('n1')
    expect(layout.x).toBe(80)
    expect(layout.width).toBe(480)
    // 标签：AI 批注带「· AI」，字号 0.56em。
    const label = layout.runs[0]!
    expect(label.role).toBe('note-label')
    expect(label.text).toBe('笔记 · AI')
    expect(label.x).toBe(90)
    expect(label.fontSize).toBeCloseTo(22 * 0.56)
    expect(label.baseline).toBeCloseTo(200 + 22 * 0.8)
    // 正文只取前三行，行距 0.95em，首行 1.55em。
    const body = layout.runs.filter((run) => run.role === 'note-body')
    expect(body.map((run) => run.text)).toEqual(['第一行', '第二行', '第三行'])
    expect(body[0]!.baseline).toBeCloseTo(200 + 22 * 1.55)
    expect(body[1]!.baseline - body[0]!.baseline).toBeCloseTo(22 * 0.95)
    expect(body[0]!.fontSize).toBeCloseTo(22 * 0.82)
    // tag 行贴在卡片底边往上 8px。
    const tags = layout.runs.at(-1)!
    expect(tags.role).toBe('note-tags')
    expect(tags.text).toBe('#人物 #伏笔')
    expect(tags.baseline).toBe(noteBox.y + noteBox.height - 8)
  })

  it('没有 tag 时不多出空行', () => {
    const layout = noteBlockLayout({
      ...noteBox,
      note: { ...noteBox.note, source: 'user', tags: undefined },
    }, style, tools)
    expect(layout.runs.some((run) => run.role === 'note-tags')).toBe(false)
    expect(layout.runs[0]!.text).toBe('笔记')
  })
})

describe('imageBlockLayout', () => {
  const imageBox: PageTextureImageBox = {
    file: 'c0001-1.png',
    caption: '插图一',
    x: 80,
    y: 300,
    width: 480,
    height: 240,
  }

  it('图注居中排在图片块下方 0.72 行处', () => {
    const layout = imageBlockLayout(imageBox, style, tools)
    expect(layout.file).toBe('c0001-1.png')
    expect(layout.width).toBe(480)
    const run = layout.captionRun!
    // 3 个字 × 10px：在 480 宽里居中。
    expect(run.x).toBeCloseTo(80 + (480 - 30) / 2)
    expect(run.baseline).toBeCloseTo(300 + 240 + 33 * 0.72)
    expect(run.fontSize).toBeCloseTo(22 * 0.6)
    expect(run.role).toBe('image-caption')
  })

  it('没有图注时不生成文字行', () => {
    expect(imageBlockLayout({ ...imageBox, caption: '' }, style, tools).captionRun).toBeNull()
  })
})