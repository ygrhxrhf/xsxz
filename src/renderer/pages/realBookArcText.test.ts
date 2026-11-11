import { describe, expect, it } from 'vitest'
import {
  arcAngleAt,
  arcHighlightFill,
  arcLineSegments,
  arcProjectedAt,
  layoutArcRuns,
  splitLineBySegments,
} from './realBookArcText'

/**
 * 弧面分段必须满足的一条硬不变量：所有段的屏幕宽度之和**正好**等于页宽。
 *
 * 3D 竖带方案在真实渲染里两次失败于此：投影宽度比纸面短，端点贴不到中线，
 * 内缘到中线之间露出背景。这里用纯二维积分 + 整体补偿把它变成可证的等式。
 */
describe('书脊弧面二维分段', () => {
  it('单段倾角：书脊处最大，离开谷区归零', () => {
    expect(arcAngleAt(0, 200, 30)).toBeCloseTo(30, 6)
    expect(arcAngleAt(100, 200, 30)).toBeGreaterThan(0)
    expect(arcAngleAt(200, 200, 30)).toBeCloseTo(0, 6)
    expect(arcAngleAt(300, 200, 30)).toBeCloseTo(0, 6)
    // 非法输入按摊平处理，不能算出 NaN 把整行变成空白。
    expect(arcAngleAt(Number.NaN, 200, 30)).toBeCloseTo(0, 6)
    expect(arcAngleAt(10, Number.NaN, 30)).toBeCloseTo(0, 6)
  })

  it('投影长度单调增，且不超过页宽', () => {
    const args = [600, 250, 30, 'left' as const] as const
    let previous = -1
    for (let a = 0; a <= 600; a += 50) {
      const value = arcProjectedAt(a, ...args)
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
    // 倾斜会把纸压短：整页投影必然严格小于页宽。
    expect(arcProjectedAt(600, ...args)).toBeLessThan(600)
  })

  it('分段宽度之和正好等于页宽：书脊不会露出背景', () => {
    for (const spineAt of ['left', 'right'] as const) {
      for (const segments of [4, 8, 12]) {
        const bands = arcLineSegments({ pageWidth: 461, valleyWidth: 194, valleyDeg: 30, segments, spineAt })
        expect(bands).toHaveLength(segments)
        let sum = 0
        for (const band of bands) {
          expect(band.width).toBeGreaterThan(0)
          sum += band.width
        }
        expect(sum).toBeCloseTo(461, 6)
        // 首段从页左缘开始，末段到页右缘结束。
        expect(bands[0]!.x).toBeCloseTo(0, 6)
        expect(bands[bands.length - 1]!.x + bands[bands.length - 1]!.width).toBeCloseTo(461, 6)
      }
    }
  })

  it('纸面比例之和为 1，且逐段首尾相接', () => {
    const bands = arcLineSegments({ pageWidth: 500, valleyWidth: 200, valleyDeg: 25, segments: 10, spineAt: 'right' })
    let share = 0
    for (let index = 0; index < bands.length; index += 1) {
      share += bands[index]!.share
      if (index > 0) expect(bands[index]!.x).toBeCloseTo(bands[index - 1]!.x + bands[index - 1]!.width, 6)
    }
    expect(share).toBeCloseTo(1, 6)
  })

  it('基线在谷区下沉：书脊侧最深，页缘不沉', () => {
    const left = arcLineSegments({ pageWidth: 500, valleyWidth: 200, valleyDeg: 30, dipPx: 12, segments: 10, spineAt: 'left' })
    expect(left[0]!.dip).toBeGreaterThan(left[left.length - 1]!.dip)
    expect(Math.max(...left.map((band) => band.dip))).toBeCloseTo(12, 6)
    expect(left[left.length - 1]!.dip).toBeCloseTo(0, 6)

    // 镜像：书脊在右时，下沉最深的是最后一段。
    const right = arcLineSegments({ pageWidth: 500, valleyWidth: 200, valleyDeg: 30, dipPx: 12, segments: 10, spineAt: 'right' })
    expect(right[right.length - 1]!.dip).toBeGreaterThan(right[0]!.dip)
    expect(right[0]!.dip).toBeCloseTo(0, 6)
  })

  it('非法输入回退而不炸：页宽为 0 返回空，倾角超界钳制', () => {
    expect(arcLineSegments({ pageWidth: 0, valleyWidth: 100, valleyDeg: 30, spineAt: 'left' })).toEqual([])
    expect(arcLineSegments({ pageWidth: Number.NaN, valleyWidth: 100, valleyDeg: 30, spineAt: 'left' })).toEqual([])
    const clamped = arcLineSegments({ pageWidth: 300, valleyWidth: 9999, valleyDeg: 999, segments: 4, spineAt: 'left' })
    expect(clamped).toHaveLength(4)
    expect(clamped.every((band) => Number.isFinite(band.width) && Number.isFinite(band.dip))).toBe(true)
  })

  it('切字：拼起来与原文完全一致，一个字都不丢', () => {
    const text = '这是一行用来验证弧面切分的中文正文，长度不整齐也没关系。'
    for (const segments of [1, 5, 8, 16]) {
      const parts = splitLineBySegments(text, segments)
      expect(parts).toHaveLength(segments)
      expect(parts.join('')).toBe(text)
    }
    // 空行也要返回固定段数，避免调用方按下标取值时越界。
    expect(splitLineBySegments('', 6)).toHaveLength(6)
  })

  it('高亮与命中：切点取并集，拼回去仍与原文一致', () => {
    const bands = arcLineSegments({ pageWidth: 400, valleyWidth: 160, valleyDeg: 25, segments: 6, spineAt: 'left' })
    const text = '这是一行用来验证高亮切分的中文正文，划线可能跨过弧面分段边界。'
    const runs = layoutArcRuns(text, 0, bands, [
      { start: 3, end: 12, kind: 'hl', color: 'green' },
      { start: 10, end: 14, kind: 'hit' },
    ])
    expect(runs.length).toBeGreaterThan(bands.length)
    expect(runs.map((run) => run.text).join('')).toBe(text)
    // hit 范围是第 10–14 字，与分段边界取并集后会被切成独立的片段。
    const hitRun = runs.find((run) => run.kind === 'hit')
    expect(hitRun).toBeDefined()
    expect(hitRun!.text).toBe(text.slice(10, 12))
    // hl 范围 3–12 与 hit 重叠的 10–11 两字归 hit，其余仍是带颜色的 hl。
    const hlRuns = runs.filter((run) => run.kind === 'hl')
    expect(hlRuns.map((run) => run.text).join('')).toBe(text.slice(3, 10))
    expect(hlRuns.every((run) => run.color === 'green')).toBe(true)
  })

  it('高亮后各片段宽度之和仍严格等于页宽：不漏背景', () => {
    const bands = arcLineSegments({ pageWidth: 461, valleyWidth: 194, valleyDeg: 30, segments: 8, spineAt: 'right' })
    const text = '字'.repeat(72)
    const runs = layoutArcRuns(text, 0, bands, [
      { start: 5, end: 30, kind: 'hl' },
      { start: 40, end: 44, kind: 'hit' },
    ])
    const sum = runs.reduce((total, run) => total + run.width, 0)
    expect(sum).toBeCloseTo(461, 6)
    // 片段首尾相接，既不留缝也不重叠。
    for (let index = 1; index < runs.length; index += 1) {
      expect(runs[index]!.x).toBeCloseTo(runs[index - 1]!.x + runs[index - 1]!.width, 6)
    }
    expect(runs[0]!.x).toBeCloseTo(0, 6)
    // 逐片段的下沉量必须真的不同，否则整行被拉平（曾因统一取 band[0].dip 出过这个回归）。
    expect(new Set(runs.map((run) => run.dip)).size).toBeGreaterThan(1)
  })

  it('高亮只覆盖行的一部分：范围外的字仍是 plain', () => {
    const bands = arcLineSegments({ pageWidth: 400, valleyWidth: 160, valleyDeg: 25, segments: 4, spineAt: 'left' })
    const text = '字'.repeat(40)
    const runs = layoutArcRuns(text, 0, bands, [{ start: 10, end: 20, kind: 'hl' }])
    expect(runs[0]!.kind).toBe('plain')
    expect(runs[runs.length - 1]!.kind).toBe('plain')
    const covered = runs.filter((run) => run.kind === 'hl')
    expect(covered.reduce((sum, run) => sum + run.text.length, 0)).toBe(10)
  })

  it('行内坐标按段落偏移对齐：同一段后半行也能上高亮', () => {
    const bands = arcLineSegments({ pageWidth: 400, valleyWidth: 160, valleyDeg: 25, segments: 4, spineAt: 'left' })
    const text = '字'.repeat(20)
    // 这一行是段落的第 30–50 个字
    const runs = layoutArcRuns(text, 30, bands, [{ start: 32, end: 36, kind: 'hl', color: 'blue' }])
    const covered = runs.filter((run) => run.kind === 'hl')
    expect(covered.reduce((sum, run) => sum + run.text.length, 0)).toBe(4)
    expect(covered[0]!.color).toBe('blue')
    // 落在本行之外的高亮不能上色。
    const outside = layoutArcRuns(text, 30, bands, [{ start: 0, end: 10, kind: 'hl' }])
    expect(outside.every((run) => run.kind === 'plain')).toBe(true)
  })

  it('非法输入回退而不炸：空行、无分段、越界高亮', () => {
    const bands = arcLineSegments({ pageWidth: 300, valleyWidth: 120, valleyDeg: 20, segments: 5, spineAt: 'left' })
    expect(layoutArcRuns('', 0, bands)).toEqual([])
    expect(layoutArcRuns('文字', 0, [])).toEqual([])
    const runs = layoutArcRuns('文字文字', 0, bands, [{ start: 999, end: 1000, kind: 'hl' }])
    expect(runs.map((run) => run.text).join('')).toBe('文字文字')
    expect(runs.every((run) => run.kind === 'plain')).toBe(true)
  })

  it('划线颜色映射到弧面上的填充色，未知颜色回退到黄色', () => {
    expect(arcHighlightFill('green')).toContain('rgba')
    expect(arcHighlightFill('blue')).toContain('rgba')
    expect(arcHighlightFill('pink')).toContain('rgba')
    expect(arcHighlightFill(undefined)).toContain('rgba')
    expect(arcHighlightFill('unknown')).toBe(arcHighlightFill(undefined))
  })
})
