import { describe, expect, it } from 'vitest'
import { imageBlockLayout, type PageBlockTools } from './realBookBlocks'
import type { PageTextureImageBox } from './realBookTexture'

/** 固定字宽 10px/字，断行由测试自己给，避免依赖 canvas。 */
const tools: PageBlockTools = {
  measure: (text) => text.length * 10,
  wrap: () => ['第一行', '第二行', '第三行', '第四行（不该出现）'],
}

const style = { fontSize: 22, lineHeight: 33 }

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