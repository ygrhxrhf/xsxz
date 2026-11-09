import { describe, expect, it } from 'vitest'
import {
  FLIP_MAX_BEND_DEG,
  FLIP_SLICE_COUNT,
  flipAngles,
  flipBackContentOpacity,
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
    // 弯度峰值在纸角刚越过正对位置、书脊侧还没跟上时（约 34%）。
    const angles = pose(0.34).map((item) => item.angle)
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(45)
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
    const poses = pose(0.4)
    // 外缘已过 −90°（正对观者的那一侧），书脊侧还没到。
    expect(outerSide(poses)).toBeLessThan(-90)
    expect(spineSide(poses)).toBeGreaterThan(-90)
  })

  it('纸角全程不回摆：角度单调，绝不出现纸在抖', () => {
    // 纸角一旦回头（角度回摆），画面上就是纸在抖——比慢更刺眼。
    for (const step of [0, 1, 2]) {
      const angles = pose(step / 3).map((item) => item.angle)
      const descending = angles.every((value, index) => index === 0 || value <= angles[index - 1]!)
      expect(descending).toBe(true)
    }
  })

  it('纸角不被钳制钉死：中段仍在明显前进', () => {
    // 早先的写法在弯度超限时「压住纸角」，纸角在行程 35%–55% 被钉在 −92° 不动，
    // 整整五分之一的行程纸的外缘卡住、只有里侧在转——那正是「僵硬、机械」的根源。
    // 这里钉住这条回归：甩到一半那一段，纸角必须一路都在明显前进。
    const sample = (progress: number) => outerSide(pose(progress))
    // 窗口取 30%–60%（甩的末段与弯度峰值区），旧实现在这里总位移只有 16°。
    const travelled = Math.abs(sample(0.6) - sample(0.3))
    expect(travelled).toBeGreaterThan(40)
    // 窗口内不能有任何一小段几乎不动：被钳制钉死时这里是 0。
    let minStep = Infinity
    for (let step = 12; step <= 24; step += 1) {
      const progress = step / 40
      minStep = Math.min(minStep, Math.abs(sample(progress) - sample(progress - 1 / 40)))
    }
    expect(minStep).toBeGreaterThan(0.3)
  })

  it('书脊侧晚起：纸角已经甩出去时，书脊那一片还贴在书上', () => {
    const poses = pose(0.25)
    // 纸角已经走了 −65° 左右，书脊侧几乎还没动。
    expect(Math.abs(spineSide(poses) + 8)).toBeLessThan(14)
    expect(Math.abs(outerSide(poses) + 8)).toBeGreaterThan(40)
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
    expect(bendAt(0.34)).toBeGreaterThan(45)
    expect(bendAt(0.5)).toBeGreaterThan(30)
    // 上限是纸的挺度：弯过头就成了塑料片。
    expect(bendAt(0.5)).toBeLessThanOrEqual(FLIP_MAX_BEND_DEG + 1e-6)
    expect(bendAt(1)).toBeCloseTo(0, 6)
    // 峰值弯度发生在中段（纸弯成弓的那一刻），不是全程拉满。
    const peak = Math.max(...Array.from({ length: 21 }, (_, i) => bendAt(i / 20)))
    expect(peak).toBeGreaterThan(50)
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

  it('曲率集中在纸角：外缘单位纸宽上的转角增量大于纸面中段', () => {
    const poses = pose(0.4)
    // 外缘的竖带更窄，单条的绝对转角增量不一定更大；按单位纸宽比较，
    // 才能确认曲率真的集中在纸角，而不是靠一条额外的折边硬折出来。
    const perWidth = (index: number) =>
      Math.abs(poses[index + 1]!.angle - poses[index]!.angle) / poses[index]!.width
    const mid = perWidth(Math.floor(poses.length / 2))
    const edge = perWidth(poses.length - 2)
    expect(edge).toBeGreaterThan(mid)
  })

  it('弯度上限：整页的最大转角差仍不超过纸的挺度', () => {
    const bendAt = (progress: number) => {
      const angles = pose(progress).map((item) => item.angle)
      return Math.max(...angles) - Math.min(...angles)
    }
    // 整页沿纸宽连续弯曲，峰值不能超过纸的挺度：超了就成铁皮。
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

  it('整张纸有方向性的侧滚：左右翻页镜像，而不是一条直线扇动', () => {
    expect(flipSheetLift(0, 1).roll).toBeCloseTo(0, 6)
    expect(flipSheetLift(1, 1).roll).toBeCloseTo(0, 6)
    expect(flipSheetLift(0.5, 1).roll).toBeGreaterThan(0)
    expect(flipSheetLift(0.5, -1).roll).toBeCloseTo(-flipSheetLift(0.5, 1).roll, 6)
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
    // 但背面不是正文，只是纸里透过来的极淡字影：上限压得很低。
    expect(flipBackOpacity(0)).toBeLessThanOrEqual(0.08)
    expect(flipBackOpacity(Number.NaN)).toBeLessThanOrEqual(0.08)
    // 正对观者时背面最厚（纸翻过来了），但仍不超过 0.08。
    expect(flipBackOpacity(180)).toBeLessThanOrEqual(0.08)
    // 侧对到底（90°）时正反两面都看不见字影。
    expect(flipBackOpacity(90)).toBeCloseTo(0, 6)
    expect(flipContentOpacity(90)).toBeCloseTo(0, 6)
  })

  it('纸背正文在 90° 边界淡入：不留下竖着换字的撕缝', () => {
    // 90° 处纸背正侧对观者，正文必须完全隐去；否则正面/背面会在竖带边界
    // 从旧页正文直接切成另一页正文，纸上出现一条竖缝。
    expect(flipBackContentOpacity(0)).toBeCloseTo(0, 6)
    expect(flipBackContentOpacity(90)).toBeCloseTo(0, 6)
    expect(flipBackContentOpacity(-90)).toBeCloseTo(0, 6)
    // 转过 90° 后单调淡入，约 130° 才完整露出。
    let previous = 0
    for (let angle = 91; angle <= 180; angle += 1) {
      const opacity = flipBackContentOpacity(angle)
      expect(opacity).toBeGreaterThanOrEqual(previous)
      previous = opacity
    }
    expect(flipBackContentOpacity(120)).toBeGreaterThan(0.6)
    expect(flipBackContentOpacity(130)).toBeCloseTo(1, 6)
    expect(flipBackContentOpacity(180)).toBeCloseTo(1, 6)
    // 非法转角按已经翻过来的纸处理，不能把纸背正文算成 NaN/透明。
    expect(flipBackContentOpacity(Number.NaN)).toBeCloseTo(1, 6)
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
    // 外缘竖带更窄，单条角度增量可以略大；但不能超过平均值十倍。
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
