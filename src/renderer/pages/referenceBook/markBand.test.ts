// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { markBand } from './pageRender'
import type { LayoutConfig, Line } from './layout'

/**
 * 高亮带必须贴住字形：上下沿来自真实字形的 ascent/descent，
 * 而不是「字号 × 固定系数」。回归点是「色块在字上偏一截」。
 */
const CFG = {
  pageW: 900, pageH: 1300, marginTop: 90, marginBottom: 90,
  marginInner: 80, marginOuter: 58, fontSize: 20,
  lineHeight: 1.8, family: 'serif',
} as unknown as LayoutConfig

function line(y: number, baseline: number, text: string): Line {
  return {
    y,
    h: 36,
    baseline,
    words: [{ s: 0, e: text.length, text, x: 0, w: 200, font: '20px serif' }],
  } as unknown as Line
}

describe('高亮带的垂直范围', () => {
  it('上沿在基线上方、下沿在基线下方，且包含基线本身', () => {
    const band = markBand(line(100, 26, '唧唧咋咋'), 20, 'highlight', CFG)
    expect(band.top).toBeLessThan(100 + 26)
    expect(band.bot).toBeGreaterThan(100 + 26)
  })

  it('带高比字框略细，既不粗重溢出也不至于细成单线', () => {
    const band = markBand(line(100, 26, '唧唧咋咋'), 20, 'highlight', CFG)
    const height = band.bot - band.top
    expect(height).toBeGreaterThan(20 * 0.55)
    expect(height).toBeLessThan(20 * 0.9)
  })

  it('下划线比高亮多延伸一截，保证笔画在线下', () => {
    const highlight = markBand(line(100, 26, '唧唧咋咋'), 20, 'highlight', CFG)
    const underline = markBand(line(100, 26, '唧唧咋咋'), 20, 'underline', CFG)
    expect(underline.bot).toBeGreaterThan(highlight.bot - 0.001)
  })

  it('没有 cfg / 没有 words 时也不抛错，仍有合理范围', () => {
    const bare = markBand({ y: 100, baseline: 26 }, 20)
    expect(bare.bot).toBeGreaterThan(bare.top)
    expect(Number.isFinite(bare.top)).toBe(true)
    expect(Number.isFinite(bare.bot)).toBe(true)
  })

  it('带高随字号缩放，不是写死的常数', () => {
    const small = markBand(line(100, 20, '字'), 14, 'highlight', CFG)
    const large = markBand(line(100, 40, '字'), 32, 'highlight', CFG)
    expect(large.bot - large.top).toBeGreaterThan(small.bot - small.top)
  })
})
