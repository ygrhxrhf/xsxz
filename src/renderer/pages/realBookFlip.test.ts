import { describe, expect, it } from 'vitest'
import {
  FLIP_MAX_BEND_DEG,
  FLIP_SLICE_COUNT,
  flipAngles,
  flipBackOpacity,
  flipContentOpacity,
  flipFaceVisible,
  flipFacing,
  flipPoses,
  flipSheetLift,
} from './realBookFlip'

/**
 * 卷页几何的纯函数测试：形状规则都在这里钉住，不必靠截图比对。
 *
 * 重点是四条不变量——起止必须是一张直的纸、中段必须有弧度、外缘必须领跑、
 * 折线必须首尾相接。任何一条破了都会表现成「翻页跳一下」「纸条之间有缝」
 * 或「像一块板子在转」。
 */
const WIDTH = 600

function pose(progress: number) {
  return flipPoses(progress, { width: WIDTH, fromDeg: -8, toDeg: -172 })
}

/** 竖带从书脊侧（index 0）排到外缘侧（末条）。 */
function spineSide(poses: ReturnType<typeof pose>): number {
  return poses[0]!.angle
}

function outerSide(poses: ReturnType<typeof pose>): number {
  return poses[poses.length - 1]!.angle
}

describe('卷页几何', () => {
  it('起翻角与落位角贴在两半页各自的折角上', () => {
    expect(flipAngles(1, 8)).toEqual({ from: -8, to: -172 })
    expect(flipAngles(-1, 8)).toEqual({ from: -172, to: -8 })
    // 折角是纯视觉量，非法值按平放处理，不能把翻页角算成 NaN。
    const flat = flipAngles(1, Number.NaN)
    expect(flat.to).toBe(-180)
    expect(flat.from).toBeCloseTo(0, 6)
  })

  it('进度 0 与 1 都是一张直的纸', () => {
    for (const progress of [0, 1]) {
      const poses = pose(progress)
      const first = poses[0]!.angle
      for (const item of poses) expect(item.angle).toBeCloseTo(first, 6)
    }
  })

  it('中段有弧度：整页的转角沿页宽拉开，纸是被弯着的不是刚体', () => {
    const angles = pose(0.5).map((item) => item.angle)
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(20)
  })

  it('外缘领跑：外缘比书脊侧更早离开桌面', () => {
    // 起手后不久，外缘已经甩出去，书脊侧还几乎没动。
    const poses = pose(0.3)
    expect(Math.abs(spineSide(poses) + 8)).toBeLessThan(Math.abs(outerSide(poses) + 8))
    // 进度越靠后，两者越接近：纸落定时整张纸是平的。
    const late = pose(0.95)
    expect(Math.abs(spineSide(late) - outerSide(late))).toBeLessThan(
      Math.abs(spineSide(poses) - outerSide(poses)),
    )
  })

  it('外缘那一段真的被甩过去了：外缘的转角先过半', () => {
    const poses = pose(0.25)
    // 外缘已过 −90°（正对观者的那一侧），书脊侧还没到。
    expect(outerSide(poses)).toBeLessThan(-90)
    expect(spineSide(poses)).toBeGreaterThan(-90)
  })

  it('正反面的显隐由转角决定：任何一条带都不会两面同时画', () => {
    // 显隐规则交给几何算（浏览器自带的 backface-visibility 在带裁剪的 3D 层里不可靠，
    // 实测转过 90° 之后正面照旧在画、背面从不露面，两层内容叠成一片糊字）。
    expect(flipFaceVisible(0)).toEqual({ showFront: true, showBack: false })
    expect(flipFaceVisible(-90)).toEqual({ showFront: true, showBack: false })
    expect(flipFaceVisible(-91)).toEqual({ showFront: false, showBack: true })
    expect(flipFaceVisible(-180)).toEqual({ showFront: false, showBack: true })
    // 非法转角不能两面都不画：那样纸上会多一道空缝。
    expect(flipFaceVisible(Number.NaN)).toEqual({ showFront: true, showBack: false })
    for (const visible of [flipFaceVisible(0), flipFaceVisible(-120)]) {
      expect(visible.showFront && visible.showBack).toBe(false)
      expect(visible.showFront || visible.showBack).toBe(true)
    }
  })

  it('翻页途中正面作废、背面接力：没有哪一帧两面同时可见', () => {
    // 整段行程扫一遍：每一帧都是「正面、背面恰好一面可见」。
    for (let step = 0; step <= 40; step += 1) {
      const poses = pose(step / 40)
      for (const item of poses) {
        const visible = flipFaceVisible(item.angle)
        expect(visible.showFront && visible.showBack).toBe(false)
        expect(visible.showFront || visible.showBack).toBe(true)
      }
    }
  })

  it('纸的弯度有上限：一页宽之内不会卷成一圈', () => {
    const bendAt = (progress: number) => {
      const angles = pose(progress).map((item) => item.angle)
      return Math.max(...angles) - Math.min(...angles)
    }
    expect(bendAt(0.5)).toBeGreaterThan(20)
    // 上限是纸的挺度：弯过头就成了塑料片。
    expect(bendAt(0.5)).toBeLessThanOrEqual(FLIP_MAX_BEND_DEG + 1e-6)
    expect(bendAt(1)).toBeCloseTo(0, 6)
  })

  it('折线首尾相接：下一条的起点就是上一条的终点', () => {
    const poses = pose(0.37)
    for (let index = 0; index < poses.length - 1; index += 1) {
      const current = poses[index]!
      const next = poses[index + 1]!
      const rad = current.angle * Math.PI / 180
      expect(current.x + current.width * Math.cos(rad)).toBeCloseTo(next.x, 6)
      expect(current.z - current.width * Math.sin(rad)).toBeCloseTo(next.z, 6)
    }
  })

  it('竖带在纸上首尾相接，且纸角那一侧分得更细', () => {
    const poses = pose(0.4)
    // 纸上的覆盖区间要连成整页，不重不漏。
    let cursor = 0
    for (const item of poses) {
      expect(item.offset).toBeCloseTo(cursor, 6)
      expect(item.width).toBeGreaterThan(0)
      cursor += item.width
    }
    expect(cursor).toBeCloseTo(WIDTH, 6)
    // 纸角那侧（末尾）的带宽必须比书脊那侧窄：曲率大就分得更细，
    // 等宽分带在纸角那截会露出折线，纸就读成「一叠等宽的板子」。
    expect(poses[poses.length - 1]!.width).toBeLessThan(poses[0]!.width)
  })

  it('曲率集中在纸角：最外一段的转角增量大于纸面中段', () => {
    const poses = pose(0.4)
    const step = (index: number) => Math.abs(poses[index + 1]!.angle - poses[index]!.angle)
    const mid = step(Math.floor(poses.length / 2))
    const edge = step(poses.length - 2)
    // 纸角那一段额外卷过去（FLIP_EDGE_CURL_DEG），所以那里的弯得比纸面中段急。
    // 没有这道卷曲，纸再弯也只是一张微微起拱的板——设计图里那一下「纸角翻过去」就没了。
    expect(edge).toBeGreaterThan(mid)
  })

  it('卷曲计入弯度上限：整页的最大转角差仍不超过纸的挺度', () => {
    const bendAt = (progress: number) => {
      const angles = pose(progress).map((item) => item.angle)
      return Math.max(...angles) - Math.min(...angles)
    }
    // 上限要覆盖「弓」与「纸角卷曲」两项之和：超了就成铁皮。
    expect(bendAt(0.35)).toBeLessThanOrEqual(FLIP_MAX_BEND_DEG + 1e-6)
    expect(bendAt(0.65)).toBeLessThanOrEqual(FLIP_MAX_BEND_DEG + 1e-6)
  })

  it('纵深随翻动离开纸面：翻到一半时纸片已经抬到观者这一侧', () => {
    const poses = pose(0.5)
    expect(Math.max(...poses.map((item) => item.z))).toBeGreaterThan(0)
  })

  it('纸面会整体离桌：起手与落定时纸贴着桌面', () => {
    // 离桌的量作用在整张纸上，不在单条竖带上（否则页脚会变成锯齿）。
    expect(flipSheetLift(0).lift).toBeCloseTo(0, 6)
    expect(flipSheetLift(1).lift).toBeCloseTo(0, 6)
    // 中段纸离桌面最高。
    expect(flipSheetLift(0.5).lift).toBeGreaterThan(10)
  })

  it('非法输入回退而不炸：进度越界钳制、条数与宽度回退', () => {
    expect(pose(-1)).toHaveLength(FLIP_SLICE_COUNT)
    const clamped = pose(2)
    const over = pose(1)
    expect(clamped.map((item) => item.angle)).toEqual(over.map((item) => item.angle))

    const custom = flipPoses(0.5, { width: WIDTH, fromDeg: 0, toDeg: -180, slices: 3 })
    expect(custom).toHaveLength(3)

    const fallback = flipPoses(0, { width: Number.NaN, fromDeg: 0, toDeg: -180, slices: 0 })
    expect(fallback).toHaveLength(FLIP_SLICE_COUNT)
    expect(fallback.every((item) => Number.isFinite(item.x) && Number.isFinite(item.z))).toBe(true)
  })

  it('cos 淡出：纸面侧对观者时正文淡出，正对时清晰', () => {
    // 正视程度就是 |cos θ|：正对观者为 1，侧对为 0。
    expect(flipFacing(0)).toBeCloseTo(1, 6)
    expect(flipFacing(90)).toBeCloseTo(0, 6)
    expect(flipFacing(-90)).toBeCloseTo(0, 6)
    expect(flipFacing(180)).toBeCloseTo(1, 6)
    // 非法转角按 0 处理（正对），不能算出 NaN 把整条带变成透明。
    expect(flipFacing(Number.NaN)).toBeCloseTo(1, 6)

    // 正对时正文清晰；侧对到 90° 时完全交给纸面明暗（正文全隐）。
    expect(flipContentOpacity(0)).toBeCloseTo(1, 6)
    expect(flipContentOpacity(90)).toBeCloseTo(0, 6)
    expect(flipContentOpacity(-90)).toBeCloseTo(0, 6)
    // 淡出是单调的：越侧对越淡，中间没有反复。
    let previous = flipContentOpacity(0)
    for (let step = 1; step <= 40; step += 1) {
      const opacity = flipContentOpacity((step / 40) * 90)
      expect(opacity).toBeLessThanOrEqual(previous)
      previous = opacity
    }
    // 淡出阈值高：稍微侧过去一点就已经在淡。
    expect(flipContentOpacity(60)).toBeLessThan(1)
  })

  it('cos 淡出：背面字影留得比正面多，但始终只是淡淡一层', () => {
    // 纸翻过去的那一半不能成一片素净的灰板：灰板与字面之间那道直边是「机械」最扎眼的地方。
    // 判据取「正面已经淡尽、但纸还没转到底」的角度（60° 与 120°）：那里背面仍要留一点字影。
    for (const angle of [60, 120]) {
      expect(flipContentOpacity(angle)).toBeCloseTo(0, 6)
      expect(flipBackOpacity(angle)).toBeGreaterThan(flipContentOpacity(angle))
    }
    // 但背面不是正文，只是纸里透过来的淡淡字影：上限压得很低。
    expect(flipBackOpacity(0)).toBeLessThanOrEqual(0.18)
    expect(flipBackOpacity(Number.NaN)).toBeLessThanOrEqual(0.18)
    // 正对观者时背面最厚（纸翻过来了），但仍不超过 0.18。
    expect(flipBackOpacity(180)).toBeLessThanOrEqual(0.18)
    // 侧对到底（90°）时正反两面都看不见字影。
    expect(flipBackOpacity(90)).toBeCloseTo(0, 6)
    expect(flipContentOpacity(90)).toBeCloseTo(0, 6)
  })

  it('竖带连续曲面：整段行程每一条带都连着前一条，首尾相接', () => {
    // 竖带是折线积分摆出来的：下一条的起点必须正好是上一条的终点。
    // 这条不变量破了，纸上就会有一道缝或一个台阶——那正是「硬卡片」的样子。
    for (let step = 0; step <= 20; step += 1) {
      const poses = pose(step / 20)
      for (let index = 0; index < poses.length - 1; index += 1) {
        const current = poses[index]!
        const next = poses[index + 1]!
        const rad = current.angle * Math.PI / 180
        expect(current.x + current.width * Math.cos(rad)).toBeCloseTo(next.x, 6)
        expect(current.z - current.width * Math.sin(rad)).toBeCloseTo(next.z, 6)
      }
      // 带宽还要与它在纸上的区间对齐：偏移量连续，不重不漏。
      let cursor = 0
      for (const item of poses) {
        expect(item.offset).toBeCloseTo(cursor, 6)
        cursor += item.width
      }
      expect(cursor).toBeCloseTo(WIDTH, 6)
    }
  })

  it('竖带连续曲面：转角沿页宽连续变化，没有跳变', () => {
    // 相邻两条带的转角差不能突然变大——那是折面而不是曲面的读感。
    // 允许的最大台阶就是外缘卷曲那一段的增量，其余地方必须平顺。
    const poses = pose(0.45)
    const steps = poses.slice(0, -1).map((item, index) => Math.abs(poses[index + 1]!.angle - item.angle))
    const maxStep = Math.max(...steps)
    const average = steps.reduce((sum, value) => sum + value, 0) / steps.length
    // 最陡的一段也不能超过平均的十倍：否则就是硬折。
    expect(maxStep).toBeLessThan(average * 10)
    // 角度本身必须单调变化：纸弯出去是一路弯的，不该来回折返。
    const angles = poses.map((item) => item.angle)
    const descending = angles.every((value, index) => index === 0 || value <= angles[index - 1]!)
    const ascending = angles.every((value, index) => index === 0 || value >= angles[index - 1]!)
    expect(descending || ascending).toBe(true)
  })
})
