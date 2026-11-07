/**
 * 卷页几何：把翻动的那一页切成若干竖带，按弧线摆位，近似出真实翻页的弧面。
 *
 * 为什么不是整页绕书脊旋转：那样画面上就是一块硬卡片在摆，不像纸。真实翻页是
 * **一道连续弯曲的纸**：靠近书脊的那一片还平躺在书上，越往外弯得越急，
 * 最后甩到对面压下去。弯是一个连续量，没有「平的一段 + 折一下 + 平的一段」。
 *
 * ## 一条时间线拆成三条
 *
 * 一次翻页里同时发生三件事，各有各的时间线，合起来才是「翻一张纸」：
 *
 *   1. **纸角行程**（`tipProgress`）：被捏住的纸角甩到了全程的百分之多少。
 *      它领跑——先越过正对观者的位置，再落向对面。
 *   2. **书脊侧行程**（`rootProgress`）：还连在书上的那一端走到哪了。
 *      它**晚起**：纸角已经在飞了，书脊这一片还贴在书上。
 *   3. **纸面离桌**（`liftEnvelope`）：整张纸离开桌面、上缘朝观者倾过去的量。
 *
 * 纸角的行程与书脊侧的行程之差，就是纸弯出来的那个弓。弯度自己起自己落，
 * 不需要额外维护。
 *
 * ## 曾经踩过的坑：钳制弯度会把纸角钉死
 *
 * 早先的写法是「弯度一旦超过纸的挺度上限，就压住纸角不让它再转」。
 * 结果是纸角在行程的 30%–62% 之间被钉在 −90° 一动不动，直到后段才一次性甩到
 * 落位角。画面上就是纸的外缘卡住、只有里侧在转——那正是「僵硬、机械」的读感。
 *
 * 现在弯度上限退化成一条**护栏**：几何按自己的曲线走，正常行程下峰值弯度
 * （约 57°）远低于上限，护栏根本不触发；即便触发，也是整条曲线一起压缩，
 * 不会出现某一段被钉住。三条时间线全程单调：纸角一旦回摆，画面上就是纸在抖。
 */

/**
 * 默认切成几条竖带：条数越多弧面越顺，但每条都要画一份整页内容。
 * 12 条在正常行程里每条差 10° 上下，正文的断行只在带边界处拐一下，看不出折线；
 * 再往上加（24 条 = 48 份整页内容）换不来肉眼可见的改善，只换来翻页起手的卡顿。
 */
export const FLIP_SLICE_COUNT = 12

/**
 * 翻页总时长（ms）。真书翻一页大约 0.6–0.9 秒：甩起来要时间，落下去也要时间。
 * 短于 0.5 秒读成甩硬卡片，长于 1 秒会被当成界面卡住。
 */
export const FLIP_DURATION_MS = 700

/**
 * 纸的弯度上限（deg）：书脊侧与外缘之间的角度差最多这么多。
 *
 * 这是「纸能弯，但弯不成铁皮」的护栏。真实书页在翻动中是**弓起来的**，
 * 不是卷成筒。
 *
 * 峰值取 64°：正常行程下的峰值弯度约 57°，离上限还有余量，护栏平时不触发；
 * 万一触发也是整条曲线一起压缩——不会出现某一段被钉住不动的情况
 * （那正是早先实现「僵硬、机械」的根源）。
 */
export const FLIP_MAX_BEND_DEG = 64

/**
 * 纸角外翻的额外卷曲（deg）：最外那一段再往回卷一点。
 *
 * 摊开的纸是一张弓；被手指甩出去的纸角是**卷**着的——外缘不再是纸的边，
 * 而是一小段翻回来的卷边。没有这道卷曲，纸再弯也读成一块微微起拱的板，
 * 设计图里那一下明显的「纸角翻过去」就没了。
 *
 * 卷曲只加在最外一小段纸宽上（见 FLIP_CURL_SHAPE_START），纸面中段仍是连续的弧。
 */
const FLIP_EDGE_CURL_DEG = 9

/** 卷曲从纸宽的 86% 处开始，到外缘达到全额。 */
const FLIP_CURL_SHAPE_START = 0.86

/**
 * 卷曲的包络：起翻后很快出现，落定前收回。
 *
 * 包络在进度 0 与 1 都必须是 0——静止的纸是一张平的纸，
 * 若卷曲一直留着，页面在翻页前后就不是平的纸，落定时会看到一个歪掉的纸角。
 */
function curlEnvelope(t: number): number {
  if (t <= 0.1) return smootherstep(t / 0.1)
  if (t <= 0.55) return 1
  return 1 - smootherstep((t - 0.55) / 0.18)
}

/**
 * 翻动页浮在下面那页之上的纵深（px）。
 *
 * 翻动页的平躺那一段与它下面的页面在同一块区域（下面已经换成了下一页的正文），
 * 不抬开一点就会 z-fighting：两页的字叠在一起闪。
 */
const FLIP_SHEET_CLEARANCE_PX = 3

/** 纸面飘起来的高度（px）：整张纸在飞行中离桌面多远。 */
const FLIP_SAIL_PX = 26

export interface FlipSlicePose {
  /** 该竖带相对观者平面的转角（deg，负值向外翻） */
  angle: number
  /** 该竖带左缘的转角（deg）：相邻两条的边界角，纸面的明暗按它连续变化 */
  startAngle: number
  /** 该竖带右缘的转角（deg） */
  endAngle: number
  /** 该竖带左缘的横向位置（px，0 = 书脊） */
  x: number
  /** 该竖带左缘的纵深（px，负值向后，正值朝观者） */
  z: number
  /** 该竖带在纸上的起点（px，从书脊算起）：内容窗按它横向错开 */
  offset: number
  /** 该竖带的宽度（px） */
  width: number
}

/**
 * 纸面在某个转角下的明暗（0 = 全黑，1 = 最亮）。
 *
 * 真实纸卷起来时，明暗沿弧面连续变：正对观者的部分最亮，侧过去就暗，
 * 转到 90° 附近有一道镜面高光。按条带平涂会在纸上留下一条条竖纹，
 * 所以这里给出的是「边界角 → 明暗」，每条带用它两端的值做渐变，接起来就是连续光。
 */
export function flipLight(angleDeg: number): number {
  const rad = (angleDeg * Math.PI) / 180
  const absolute = Math.abs(angleDeg)
  // 正对观者的程度：侧过去的部分变暗，但不会黑到看不见纸。
  const facing = Math.abs(Math.cos(rad))
  const base = 0.5 + 0.5 * Math.pow(facing, 0.7)
  // 侧对时的一道高光：纸面把光反射回观者。窄带，只在接近垂直的那一段。
  const gloss = Math.max(0, 1 - Math.abs(absolute - 90) / 22) * 0.2
  // 纸翻过 90° 之后，朝上的是纸的**里子**：它背对着上方来的光，
  // 所以要明显暗下来。少了这一层，折回来的那一片仍然是亮的，
  // 读起来像一张平贴的纸片，而不是从光里翻过去的纸。
  const verso = absolute > 90 ? 1 - 0.5 * Math.min(1, (absolute - 90) / 80) : 1
  return Math.min(1, (base + gloss) * verso)
}

export interface FlipPoseOptions {
  /** 整页宽度（px） */
  width: number
  /** 起翻角（deg）：翻动页在起翻时所处半页的折角 */
  fromDeg: number
  /** 落位角（deg）：翻到对面后应贴合的折角 */
  toDeg: number
  /** 竖带条数；非法值回退到默认条数 */
  slices?: number
}

/**
 * 起翻 / 落位角：必须落在两半页各自的折角上。
 *
 * 起点用所属半页的折角、终点用对面半页的折角，否则动画首尾会与静态页面差一个
 * 折角（8° 在 600px 宽的页上就是 80px 的错位），落定瞬间会看到页面跳一下。
 */
export function flipAngles(direction: 1 | -1, bendDeg: number): { from: number; to: number } {
  const bend = Number.isFinite(bendDeg) ? Math.min(45, Math.max(0, Math.abs(bendDeg))) : 0
  // 落位角 −(180−bend)：翻过去的那一面贴到对面半页（对面半页是 +bend）。
  return direction === 1
    ? { from: -bend, to: -(180 - bend) }
    : { from: -(180 - bend), to: -bend }
}

/**
 * 翻页的总节奏（0–1）：把手上的时间换成纸的时间。
 *
 * 真书翻页不是匀速的：手先把纸角捏起来（慢），然后一甩（快），
 * 纸落到对面时被手按住（再慢下来）。直接用线性时间驱动几何，
 * 纸会「啪」地一下窜到对面再慢慢摊平——读起来像被弹出去的纸片。
 *
 * 用余弦做总节奏：两端斜率为 0，中段最快。
 *
 * 这一层是**整条动画链的唯一时间源**：竖带几何、纸面离桌、书的随动、投影
 * 都吃同一个缓动后的进度，动画才是一个整体——不然纸慢了书还在晃，
 * 读起来就像几段各走各的动画拼在一起。
 */
export function flipEase(progress: number): number {
  const t = clamp01(progress)
  return 0.5 - 0.5 * Math.cos(Math.PI * t)
}
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/** 平滑阶跃：一阶、二阶导数在两端都归零，用来做加速与减速的衔接。 */
function smootherstep(value: number): number {
  const t = clamp01(value)
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/**
 * 纸角的行程（0–1）：被捏住的纸角甩到了全程的百分之多少。
 *
 * 这是**主时间线**：纸角领跑，它决定整张纸此刻在哪儿。其余两条时间线
 * （书脊侧行程、纸面离桌）都由它派生，纸与影子与书的随动才不会各走各的。
 *
 * 两段行程拼成一条曲线：
 *   1. **甩**（0 → FLING_END）：纸角被甩出去。用 2u²−u³ 而不是 u：
 *      起点斜率为 0（纸不是一上来就在动，是被捏起来的那一下带动的），
 *      终点斜率最大（正甩到劲头上）。这一段结束时纸角已越过正对观者的位置。
 *   2. **落**（FLING_END → 1）：纸角被按向对面。用 v − v²/2：
 *      起手斜率与上一段末端的斜率**连续**（两段的系数由 FLING_END 推出），
 *      终点斜率为 0（纸贴住了）。
 *
 * 两段的斜率连续很关键：接缝处若有一处速度突变，画面上就是纸「顿一下」——
 * 那比慢更刺眼。
 */
const FLING_END = 0.34
const FLING_FRACTION = 0.58
const FLING_JOIN_SPEED = 1.5

/** 单段 Hermite 行程：端点位置和端点速度都可控，避免分段曲线在接缝处顿一下。 */
function hermiteSegment(progress: number, start: number, end: number, startTangent: number, endTangent: number): number {
  const u = clamp01(progress)
  const u2 = u * u
  const u3 = u2 * u
  const smooth = 3 * u2 - 2 * u3
  const tangent = u3 - u2
  return start + (end - start) * smooth + (startTangent * (u3 - 2 * u2 + u) + endTangent * tangent)
}

function tipProgress(t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  if (t < FLING_END) {
    // 甩段与落段共享同一个物理角速度，接缝处不会突然加速或刹停。
    return hermiteSegment(t / FLING_END, 0, FLING_FRACTION, 0, FLING_JOIN_SPEED * FLING_END)
  }
  return hermiteSegment(
    (t - FLING_END) / (1 - FLING_END),
    FLING_FRACTION,
    1,
    FLING_JOIN_SPEED * (1 - FLING_END),
    0,
  )
}

/**
 * 书脊侧的行程（0–1）：还连在书上的那一端走到哪了。
 *
 * 它**晚起**：真实翻页是捏着外角往回拽，靠近书脊的那一片几乎还躺在书上，
 * 直到纸快落定才跟着压平。这条滞后是「纸在卷」与「板子在转」的分界——
 * 书脊侧若跟着一起转，整张纸就成了一个刚体，卷不出弧面。
 *
 * 晚起的方式是**整体延后**：把纸角的行程曲线按 ROOT_DELAY 往后挪一段，
 * 再重新归一化。延后而不是压缩，是为了让书脊侧的曲线与纸角**形状相同**——
 * 同一族曲线取不同的时间偏移，两端速度都连续，不会出现新的接缝。
 */
const ROOT_DELAY = 0.18

function rootProgress(t: number): number {
  if (t <= ROOT_DELAY) return 0
  if (t >= 1) return 1
  return tipProgress((t - ROOT_DELAY) / (1 - ROOT_DELAY))
}

/**
 * 纸面转角沿页宽的分布指数（>1）：越往外弯得越急。
 *
 * 真纸被甩起来时曲率就集中在纸角那一小段，所以纸角卷得最急、像纸卷。
 *
 * 指数随时间**回落**：起手时纸弯得急（纸角那一小截卷起来），
 * 落定途中弯度摊开成一张宽面。指数从 1.75 降到 1.05，
 * 末段接近 1 就是「整张纸一起摊平」——真纸落位时不是一折一折地压，是整片落下去。
 */
const FLIP_CURL_EXPONENT_START = 1.45
const FLIP_CURL_EXPONENT_END = 1.05

function curlExponent(t: number): number {
  return FLIP_CURL_EXPONENT_START
    + (FLIP_CURL_EXPONENT_END - FLIP_CURL_EXPONENT_START) * smootherstep(t / 0.55)
}

export interface FlipPhases {
  /** 纸角的行程进度（0–1） */
  tip: number
  /** 书脊侧的行程进度（0–1） */
  root: number
}

/**
 * 翻页此刻的相位。
 *
 * 渲染层（影子、离桌、书的随动）与几何共用这一组相位，
 * 纸与影子才不会各走各的——那正是「几段动画拼在一起」的读感。
 */
export function flipPhases(progress: number): FlipPhases {
  const t = clamp01(progress)
  return { tip: tipProgress(t), root: rootProgress(t) }
}

/**
 * 竖带的分布指数（<1）：越靠纸角，竖带越窄。
 *
 * 纸的曲率沿页宽是变的：θ(s) = 书脊侧角 + Δ·s^k 里，转角随位置的变化率
 * dθ/ds = Δ·k·s^(k−1)，在纸角那一端最大——那里纸弯得最急。
 *
 * 竖带等宽就等于在曲率最大的地方也只用同样的精度去近似：
 * 画面上纸角那一段被切成几个等宽的梯形，接缝处的折线一眼可见，
 * 整张纸读成「一叠等宽的板子」，而不是一张卷起来的纸。
 *
 * 让带宽跟着曲率走（指数 <1 → 纸角处带更窄）后，纸角那一段分得更细，
 * 折痕被抹平，纸就读成连续的一片。
 */
const FLIP_STRIP_DENSITY_EXPONENT = 0.8

/**
 * 给定进度（0–1）与版面，算出每条竖带的角度与位置。
 *
 * 进度 0 与 1 必须回到「一张平的纸」：否则翻页起止会带一个永久折角，
 * 落定后与静态页面对不上。
 */
export function flipPoses(progress: number, options: FlipPoseOptions): FlipSlicePose[] {
  const width = Number.isFinite(options.width) && options.width > 0 ? options.width : 0
  const slices = Number.isFinite(options.slices) && (options.slices as number) >= 1
    ? Math.min(24, Math.floor(options.slices as number))
    : FLIP_SLICE_COUNT
  const from = Number.isFinite(options.fromDeg) ? options.fromDeg : 0
  const to = Number.isFinite(options.toDeg) ? options.toDeg : 0
  const t = clamp01(progress)
  const span = to - from
  // 甩动方向：卷曲要顺着甩的方向加，反了就成折回去。
  const swing = Math.sign(span) || -1

  // 三条时间线：纸角领跑、书脊侧晚起，两者的差就是纸弯出的那个弓。
  const tip = tipProgress(t)
  const root = rootProgress(t)
  const rootAngle = from + span * root
  const tipAngle = from + span * tip
  // 弯度超上限时整条曲线一起压缩：早先的写法是「压住纸角」，
  // 那一压就把纸角钉死在某个角度上不动了，画面上纸的外缘卡住、只有里侧在转。
  // 压缩不改变任何一条时间线的形状，纸角全程照旧在走。
  const gap = tipAngle - rootAngle
  const bendCap = Math.min(FLIP_MAX_BEND_DEG, Math.abs(span) * 0.9)
  const scaledGap = Math.abs(gap) > bendCap ? Math.sign(gap) * bendCap : gap
  // 外缘卷曲的强度：起翻后很快出现（纸角被甩得卷起来），落定前收回。
  const curl = curlEnvelope(t)
  // 弯度沿页宽的分布指数：起手时弯得急，落定途中摊平成一张宽面。
  const exponent = curlExponent(t)

  /** 某一页宽位置 s 处的转角。 */
  const angleAt = (s: number): number => {
    const s01 = clamp01(s)
    // 外缘卷曲：只在最外一段额外翻过去，读成纸角卷起来的一小截。
    const curlShape = smootherstep((s01 - FLIP_CURL_SHAPE_START) / (1 - FLIP_CURL_SHAPE_START))
    return rootAngle
      + scaledGap * Math.pow(s01, exponent)
      + swing * FLIP_EDGE_CURL_DEG * curlShape * curl
  }
  const sliceWidth = width / slices
  // 竖带在纸上的边界：越靠纸角越窄。
  const boundaries: number[] = []
  for (let index = 0; index <= slices; index += 1) {
    boundaries.push(Math.pow(index / slices, FLIP_STRIP_DENSITY_EXPONENT) * width)
  }

  const poses: FlipSlicePose[] = []
  let x = 0
  let z = 0
  for (let index = 0; index < slices; index += 1) {
    const offset = boundaries[index]!
    const stripWidth = boundaries[index + 1]! - offset
    const s0 = width > 0 ? offset / width : 0
    const s1 = width > 0 ? boundaries[index + 1]! / width : 0
    const s = (s0 + s1) / 2
    const angle = angleAt(s)
    const startAngle = angleAt(s0)
    const endAngle = angleAt(s1)
    poses.push({ angle, startAngle, endAngle, x, z: z + FLIP_SHEET_CLEARANCE_PX, offset, width: stripWidth })
    const rad = angle * Math.PI / 180
    // rotateY(angle) 把条带的局部 +x 指向 (cos, 0, −sin)。
    x += stripWidth * Math.cos(rad)
    z -= stripWidth * Math.sin(rad)
  }
  return poses
}

/**
 * 纸面正反面的显隐：由竖带自己的转角决定。
 *
 * 浏览器自带的 backface-visibility 在带裁剪的 3D 层里不可靠：实测纸面转过 90°
 * 之后正面照旧在画、背面从不露面，两层内容叠在同一张纸上就是一片糊字。
 * 所以显隐不交给浏览器，交给几何自己算——转角没过半画正面，过了就画背面。
 *
 * 边界取 90°（含）：正侧对观者的那一刻两面都近乎不可见，画哪一面都无妨；
 * 但必须与浏览器实测的转向一致，不能一个分支算 90 另一个算 91，
 * 否则某几条带会在同一帧里既不画正面也不画背面，纸上多一道空缝。
 */
export function flipFaceVisible(angleDeg: number): { showFront: boolean; showBack: boolean } {
  const angle = Number.isFinite(angleDeg) ? Math.abs(angleDeg) : 0
  const showFront = angle <= 90
  return { showFront, showBack: !showFront }
}

/**
 * 纸面正对观者的程度（0–1）。
 *
 * 正对观者时为 1，侧对时为 0：判据是 |cos θ|。
 * 竖带是按平面拼的，越侧对投影越窄，正文被压成一条条竖着的色带——
 * 那不是字，是乱码，看着像贴图在转。淡出量就按这个「正视程度」给。
 */
export function flipFacing(angleDeg: number): number {
  const angle = Number.isFinite(angleDeg) ? angleDeg : 0
  return Math.abs(Math.cos((angle * Math.PI) / 180))
}

/**
 * 正面正文的淡出系数（0–1）。
 *
 * 阈值要**高**：一条带侧过去以后，投影宽度按 |cos θ| 缩，窗口里那一段版面被压成
 * 几十像素宽——正文此时不是字，是一排竖着的色带。只有正视程度接近 1 时才让它保持
 * 清晰；到 0.9 以下就开始淡出，到 0.5 以下完全交给纸面自己的明暗。
 * 淡出得不够快，纸边上就会挂着一截被压扁的竖字，看着像贴图在转。
 */
export function flipContentOpacity(angleDeg: number): number {
  const facing = flipFacing(angleDeg)
  return Math.min(1, Math.max(0, (facing - 0.5) / 0.4))
}

/**
 * 背面（纸的里子）的淡出系数（0–0.08）。
 *
 * 背面要**比正面留得多**：背面若跟着正面一起淡掉，纸翻过去的那一半就成了
 * 一片素净的灰板——灰板与字面之间那道直边是「机械」最扎眼的地方。
 *
 * 但背面不是正文：翻过去看到的是纸的**里子**，里子上只有透过来的淡淡字影，
 * 所以上限压得很低。
 */
export function flipBackOpacity(angleDeg: number): number {
  const facing = flipFacing(angleDeg)
  return Math.min(1, Math.max(0, (facing - 0.15) / 0.5)) * 0.08
}

/**
 * 每条竖带此刻的角速度（deg/ms），已归一化到 0–1。
 *
 * 真实翻书时纸在空中的那一下是糊的，匀速的机械动画无论多快都每帧清晰——
 * 清晰就读成「贴图在转」，不是「纸在飞」。渲染层用它给高速段加一点动态模糊。
 *
 * 归一化是必需的：调用方要的是「这条带比最慢的那条快多少」，
 * 而不是角速度的绝对值（绝对值一大就全都糊成一片，纸上的字反而看不清）。
 */
export function flipSliceSpeeds(progress: number, options: FlipPoseOptions): number[] {
  const dt = 0.015
  const before = flipPoses(Math.max(0, progress - dt), options)
  const after = flipPoses(Math.min(1, progress + dt), options)
  const count = Math.min(before.length, after.length)
  const speeds: number[] = []
  for (let index = 0; index < count; index += 1) {
    speeds.push(Math.abs(after[index]!.angle - before[index]!.angle) / (2 * dt))
  }
  const peak = speeds.reduce((max, value) => Math.max(max, value), 0)
  if (peak <= 0) return speeds.map(() => 0)
  return speeds.map((value) => value / peak)
}

export interface FlipSheetLift {
  /** 整张纸离桌面的高度（px） */
  lift: number
  /** 整张纸的上缘朝观者倾多少（deg）：纸在飞行中「帆」起来 */
  tilt: number
}

/**
 * 整张纸离桌的程度。
 *
 * 纸面不能靠「每条带各自往上抬」来离桌：那样页脚会变成锯齿状的阶梯。
 * 真实翻页是整张纸一起离开桌面、上缘朝观者倾过去——所以位移与倾角都作用在
 * 整张纸上，各竖带只负责弯。
 *
 * 包络吃的是**纸角行程**而不是另设一条曲线：纸被甩起来的时候它才离桌，
 * 纸角贴到对面时它落回桌面。纸与影子共用同一个行程，影子才不会提前出现。
 */
export function flipSheetLift(progress: number): FlipSheetLift {
  const t = clamp01(progress)
  const rise = Math.sin(Math.PI * tipProgress(t))
  return {
    lift: FLIP_SAIL_PX * rise,
    tilt: 9 * rise,
  }
}

export interface FlipSway {
  /** 整本书此刻的侧倾（deg）：手推书页时书自己也会跟着晃一下 */
  rotateY: number
  /** 整本书离桌面的高度（px）：书被手托起来的量 */
  lift: number
}

/**
 * 整本书的随动：翻页不是只有纸在动。
 *
 * 真书是用手指把纸角甩过去，书身会被这一推带得微微侧倾、离桌一下；
 * 纸落定后书还有一点余颤。缺了这一层，即便纸卷得再像，书仍是钉在桌上的两块板——
 * 那就是「机械感」的来源。
 *
 * 随动吃的是**纸角行程**：书被手推的时机与纸被甩出去的时机是同一件事。
 * 余颤接在落定之后，幅度越来越小。
 */
export function flipSway(progress: number, direction: 1 | -1): FlipSway {
  const t = clamp01(progress)
  // 抬起：书被托起来又落回桌面，跟纸角行程同步。
  const lift = Math.sin(Math.PI * tipProgress(t))
  // 落定后的余颤：越来越小的一次摆动。
  const settle = t > 0.82 ? (t - 0.82) / 0.18 : 0
  const wobble = t > 0.82 ? Math.sin(settle * Math.PI * 2.5) * (1 - settle) * 1.4 : 0
  return {
    rotateY: direction * (2.2 * Math.pow(lift, 1.1) + wobble),
    lift: 11 * Math.pow(lift, 1.2) + wobble * 3,
  }
}
