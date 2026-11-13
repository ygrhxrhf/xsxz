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
  spineValleyPoses,
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
    // 弯度峰值出现在中段的纸角附近（约 34%）。弧度只需几十度：一页书纸的挺度
    // 只允许它在纸角那一小段弯一点——弯到 45° 以上整页就成了打开的折扇。
    const angles = pose(0.34).map((item) => item.angle)
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(12)
    expect(Math.max(...angles) - Math.min(...angles)).toBeLessThanOrEqual(FLIP_MAX_BEND_DEG + 1e-6)
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

  it('整页绕书脊掀过去：外缘只比书脊侧早一点越过正对观者的位置', () => {
    const poses = pose(0.5)
    // 50% 时整页都已越过 −90°：转轴在书脊，书脊侧不可能还贴在桌上。
    expect(outerSide(poses)).toBeLessThan(-90)
    expect(spineSide(poses)).toBeLessThan(-90)
    // 外缘仍领跑，但只早一个弯度量级——再大就是折扇，不是一页纸。
    expect(Math.abs(outerSide(poses) - spineSide(poses))).toBeLessThanOrEqual(FLIP_MAX_BEND_DEG + 1e-6)
    expect(Math.abs(outerSide(poses) - spineSide(poses))).toBeGreaterThan(8)
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
    // 30%–60% 的窗口里纸角走 38°：弯度上限是软护栏，压缩增速但不阻断。
    expect(travelled).toBeGreaterThan(30)
    // 窗口内不能有任何一小段几乎不动：被钳制钉死时这里是 0。
    let minStep = Infinity
    for (let step = 12; step <= 24; step += 1) {
      const progress = step / 40
      minStep = Math.min(minStep, Math.abs(sample(progress) - sample(progress - 1 / 40)))
    }
    expect(minStep).toBeGreaterThan(0.3)
  })

  it('书脊侧只晚一小拍：书脊那一段已经跟着掀起来，整页仍绕书脊转', () => {
    const poses = pose(0.3)
    // 30% 时书脊侧已经离开桌面十几度——转轴一直在书脊上，不是钉死在桌上。
    expect(Math.abs(spineSide(poses) + 8)).toBeGreaterThan(12)
    // 外缘照样领跑，但只领先一个弯度量级。
    expect(Math.abs(outerSide(poses) + 8)).toBeGreaterThan(Math.abs(spineSide(poses) + 8))
    expect(Math.abs(outerSide(poses) - spineSide(poses))).toBeLessThanOrEqual(FLIP_MAX_BEND_DEG + 1e-6)
  })

  it('翻动页贴着书脊转：起手时纸身没有被推到观者面前', () => {
    // 这一条是「页面像被撕下来」的回归钉。早先书脊侧晚起半程、弯度放开到 120°，
    // 最外一条竖带在起手 10% 就已经离桌面 120px、到 60% 时超过 380px，
    // 透视把整页放大三成，纸伸出书的轮廓——看着就是一张纸被从书里揭了下来。
    for (let step = 1; step <= 10; step += 1) {
      const poses = pose(step / 100)
      expect(poses[0]!.z).toBeLessThan(6)
      expect(Math.abs(poses.at(-1)!.z)).toBeLessThan(170)
    }
    // 起手 10%：纸角只掀起二十度上下，纸身还贴着书。
    expect(Math.abs(outerSide(pose(0.1)) + 8)).toBeLessThan(24)
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
    expect(bendAt(0.34)).toBeGreaterThan(12)
    expect(bendAt(0.5)).toBeGreaterThan(8)
    // 上限是纸的挺度：弯过头就成了塑料片。
    expect(bendAt(0.5)).toBeLessThanOrEqual(FLIP_MAX_BEND_DEG + 1e-6)
    expect(bendAt(1)).toBeCloseTo(0, 6)
    // 峰值弯度发生在中段（纸弯成弓的那一刻），不是全程拉满。
    const peak = Math.max(...Array.from({ length: 21 }, (_, i) => bendAt(i / 20)))
    expect(peak).toBeGreaterThan(14)
    expect(peak).toBeLessThanOrEqual(FLIP_MAX_BEND_DEG + 1e-6)
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
    // 中段纸离桌面最高，但只抬十几像素：纸是绕书脊转，不是从书上揭起来举到空中。
    expect(flipSheetLift(0.5).lift).toBeGreaterThan(4)
    expect(flipSheetLift(0.5).lift).toBeLessThanOrEqual(17)
    // 仰角同样要收住：早先 19° 让纸的上缘朝观者压过来，透视下整页读成一块斜板。
    expect(flipSheetLift(0.5).tilt).toBeLessThanOrEqual(9)
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

    // 正文只在纸几乎侧立时才收干净：60° 以前满字，86° 才到 0。
    // 早先 57° 就清零，中段整张纸是无字纸板，压在左页上被读成「撕开一条」。
    expect(flipContentOpacity(0)).toBeCloseTo(1, 6)
    expect(flipContentOpacity(40)).toBeCloseTo(1, 6)
    expect(flipContentOpacity(60)).toBeCloseTo(1, 6)
    expect(flipContentOpacity(70)).toBeGreaterThan(0.5)
    expect(flipContentOpacity(70)).toBeLessThan(1)
    expect(flipContentOpacity(80)).toBeGreaterThan(0)
    expect(flipContentOpacity(80)).toBeLessThan(0.3)
    expect(flipContentOpacity(86)).toBeCloseTo(0, 6)
    expect(flipContentOpacity(90)).toBeCloseTo(0, 6)
    expect(flipContentOpacity(-90)).toBeCloseTo(0, 6)
    // 淡出是单调的：越侧对越淡，不能在中间反复。
    let previous = flipContentOpacity(0)
    for (let step = 1; step <= 40; step += 1) {
      const opacity = flipContentOpacity((step / 40) * 90)
      expect(opacity).toBeLessThanOrEqual(previous + 1e-9)
      previous = opacity
    }
  })

  it('cos 淡出：背面字影留得比正面多，但始终只是淡淡一层', () => {
    for (const angle of [85, 88]) {
      expect(flipBackOpacity(angle)).toBeLessThanOrEqual(0.08)
    }
    expect(flipBackOpacity(0)).toBeLessThanOrEqual(0.08)
    expect(flipBackOpacity(Number.NaN)).toBeLessThanOrEqual(0.08)
    expect(flipBackOpacity(180)).toBeLessThanOrEqual(0.08)
    expect(flipBackOpacity(90)).toBeCloseTo(0, 6)
  })

  it('正文只在纸几乎侧立时收干净：整张纸不会变成无字纸板', () => {
    const drawn = (angle: number) => (flipFaceVisible(angle).showFront
      ? flipContentOpacity(angle)
      : flipBackContentOpacity(angle))

    // 只有一条带真正侧立（|cos θ| ≈ 0）时才是 0。
    for (const angle of [-90, 90]) expect(drawn(angle)).toBeCloseTo(0, 6)
    // 80° 以前和 104° 以后都得有字：那时投影还有页宽的三成以上。
    for (const angle of [0, 20, 40, 60, 75, 108, 120, 140, 180]) {
      expect(drawn(angle)).toBeGreaterThan(0.3)
    }
    // 换面点两侧都是 0：不会出现一面有字一面没字的竖向硬切。
    expect(drawn(90)).toBeCloseTo(0, 6)
    expect(drawn(89.6)).toBeLessThan(0.1)
    // 非法转角按已经翻过来的纸处理。
    expect(flipBackContentOpacity(Number.NaN)).toBeCloseTo(1, 6)
  })

  it('整段翻页里每一帧都有字可读：不存在整张纸同时无字的相位', () => {
    // 这一条是「撕页」观的回归钉：中段无字纸板压在邻页上，就是用户看到的「撕开一条」。
    for (let step = 0; step <= 40; step += 1) {
      const poses = pose(step / 40)
      let best = 0
      for (const item of poses) {
        const visible = flipFaceVisible(item.angle).showFront
          ? flipContentOpacity(item.angle)
          : flipBackContentOpacity(item.angle)
        expect(Number.isFinite(visible)).toBe(true)
        expect(visible).toBeGreaterThanOrEqual(0)
        expect(visible).toBeLessThanOrEqual(1)
        best = Math.max(best, visible)
      }
      // 每一帧至少有一条带满字：纸扇面铺开，总有正对观者的那一段。
      expect(best).toBeGreaterThanOrEqual(0.3)
    }
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

  it('书脊的谷：谷底最深、外缘摊平，条带首尾相接', () => {
    const strips = spineValleyPoses({ valleyWidth: 120, valleyDeg: 14, slices: 6 })
    expect(strips).toHaveLength(6)
    // 书脊侧倾角最大，外缘归零：谷是连续的一条弧。
    expect(strips[0]!.angle).toBeGreaterThan(strips[strips.length - 1]!.angle)
    expect(strips[strips.length - 1]!.angle).toBeLessThan(1)
    // 条带在谷方向上首尾相接，不重不漏。
    let cursor = 0
    for (const strip of strips) {
      expect(strip.offset).toBeCloseTo(cursor, 6)
      cursor += strip.width
    }
    expect(cursor).toBeCloseTo(120, 6)
    // 相邻条带的纵深从书脊向外逐步前移，形成连续曲面。
    for (let index = 0; index < strips.length - 1; index += 1) {
      const current = strips[index]!
      const next = strips[index + 1]!
      const rad = (current.angle * Math.PI) / 180
      expect(current.x + current.width * Math.cos(rad)).toBeCloseTo(next.x, 6)
      expect(current.z + current.width * Math.sin(rad)).toBeCloseTo(next.z, 6)
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
