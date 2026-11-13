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
 *      它只比纸角**晚一小拍**：书纸有挺度，书脊那一段被纸角拽着一起掀起，
 *      但整页的转轴始终在书脊上。
 *   3. **纸面离桌**（`liftEnvelope`）：整张纸离开桌面、上缘朝观者倾过去的量。
 *
 * 纸角的行程与书脊侧的行程之差，就是纸弯出来的那个弓。弯度自己起自己落，
 * 不需要额外维护。
 *
 * ## 翻动页必须**绕着书脊**转
 *
 * 早先书脊侧要晚起半程（ROOT_DELAY = 0.55），同时把弯度上限放到 120°。
 * 于是书脊侧钉在桌上不动，外缘已经甩到接近正对观者，整页被拉成一个打开的折扇；
 * 每一根竖带还按自己的转角把纵深推向观者，最外一条离桌面 300px 以上，
 * 在透视里被放大三成——纸的上下缘都伸出书的轮廓，读起来就是「页面被从书里撕下来」。
 *
 * 现在转轴回到书脊：书脊侧只晚 0.14，弯度上限 20°（一页纸的挺度），
 * 离桌量 12px。整页是一张略弯的硬纸绕书脊掀起、越过正对观者的位置、落到对面，
 * 任何一帧都不会比静止页大出一圈。弯度只负责让纸不像塑料板。
 *
 * ## 曾经踩过的坑：钳制弯度会把纸角钉死
 *
 * 早先的写法是「弯度一旦超过纸的挺度上限，就压住纸角不让它再转」。
 * 结果是纸角在行程的 30%–62% 之间被钉在 −90° 一动不动，直到后段才一次性甩到
 * 落位角。画面上就是纸的外缘卡住、只有里侧在转——那正是「僵硬、机械」的读感。
 *
 * 现在弯度上限是一条**软护栏**：几何按自己的曲线走，接近上限时用 tanh 压缩，
 * 增速变缓但不会停住。书脊侧与纸角的相位差始终在变，不会出现某一段被钉死。
 * 三条时间线全程单调：纸角一旦回摆，画面上就是纸在抖。
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
export const FLIP_DURATION_MS = 820

/**
 * 纸的弯度上限（deg）：书脊侧与外缘之间的角度差最多这么多。
 *
 * 这是「纸能弯，但弯不成铁皮」的护栏。真实书页在翻动中是**弓起来的**，
 * 不是卷成筒。
 *
 * 取 20°：一页书纸是**有挺度**的，翻动中最多在纸角那一小段弯出二十度上下。
 * 早先放到 120° 时，中段的纸被弯成一把打开的折扇：书脊侧还贴在桌上，
 * 外缘已经甩到 90°，整页沿宽度摊开成一个大扇面，每一帧都像一张被揭下来的纸。
 * 现在弯度上限压到纸的挺度量级，整页像一张略弯的硬纸绕着书脊转，
 * 弯度只负责让它不像塑料板，不负责把纸折成扇子。
 */
export const FLIP_MAX_BEND_DEG = 20

/**
 * 翻动页浮在下面那页之上的纵深（px）。
 *
 * 翻动页的平躺那一段与它下面的页面在同一块区域（下面已经换成了下一页的正文），
 * 不抬开一点就会 z-fighting：两页的字叠在一起闪。
 */
const FLIP_SHEET_CLEARANCE_PX = 3

/**
 * 纸面飘起来的高度（px）：整张纸在飞行中离桌面多远。
 *
 * 只取 12px：翻页是纸**绕书脊转**，不是把纸从书上揭起来举到空中。
 * 早先取 46px 时，整张纸被平移到观者面前，透视把纸放大了三成，
 * 纸的上下缘都伸到书的轮廓之外——读起来就是「页面被撕下来了」。
 * 留一点离桌量只为脱离 z-fighting，并给投影一点余地。
 */
const FLIP_SAIL_PX = 12

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
  // 纸背是同一张纸的另一面，只比正面略暗。压到 0.5 会让翻过去的那张纸变成
  // 一块灰板——落定前它盖在左页上，读起来就是「一张别的纸贴在上面」。
  const verso = absolute > 90 ? 1 - 0.16 * Math.min(1, (absolute - 90) / 80) : 1
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
 * 静态书页的弧面几何：把摊开的一页当成一张**真的弯下去**的纸。
 *
 * ## 为什么不用「一块平面绕书脊转 9°」
 *
 * 那样得到的书脊是一道折角：两页各自是一块刚体纸，内缘在中线碰成一个尖。
 * 参考图里的书脊是连续的——靠脊那一条纸弯下去，弯量从书脊向外渐渐变小，
 * 到外缘几乎摊平。纸心因此读成「一本摊开的书」，而不是「两张纸拼在一起」。
 *
 * ## 曲线怎么取
 *
 * 与翻页竖带同一套折线积分（`flipPoses` 的算法），只是两端角度反过来：
 * 翻页是从书脊到纸角弯，静态页是从书脊到**外缘**弯。
 *
 * 转角沿页宽的分布用幂函数 θ(s) = 书脊角 − Δ·s^k：
 *   - 书脊侧（s=0）角度最大：那一段弯得最急，正是折缝谷底；
 *   - 外缘（s=1）角度回到 0：纸在外缘摊平，与桌面平行。
 *
 * 指数 k 控制弯量的分布：k 小则弯量集中在靠脊一小段（谷很急、外缘很平），
 * k 大则整页均匀弯。真实摊开的书是**前一种**——书心那一小段塌进去，
 * 越往外越平。所以取 1.6 附近。
 *
 * 静态页与翻页必须用同一个「摊平角」：翻动页起手时的角度要等于它所在半页
 * 的弯角，否则起手瞬间纸与下面的静态页差一个角，落定时会跳。
 */
export interface SpineValleyOptions {
  /** 谷的宽度（px）：从书脊向外这一段纸是弯的 */
  valleyWidth: number
  /** 谷底角度（deg）：书脊处的倾角，越大谷越深 */
  valleyDeg: number
  /** 竖带条数 */
  slices?: number
}

export interface SpineValleyStrip {
  /** 第几条带 */
  index: number
  /** 沿谷方向的投影位置（px，从书脊算起） */
  x: number
  /** 纵深（px，负值向后退，即谷越深越靠后） */
  z: number
  /** 该带的倾角（deg） */
  angle: number
  /** 该带在纸面上的宽度（px，未投影） */
  width: number
  /** 该带的投影宽度（px） */
  projectedWidth: number
  /** 该带在谷方向上的起点（px，从书脊算起） */
  offset: number
}

/** 谷的角度分布指数：越大越平缓，越小越集中在书脊那一小段。 */
const VALLEY_ANGLE_EXPONENT = 1.5
/** 谷的条带密度指数（<1）：靠书脊那几条更窄，那里曲率最大。 */
const VALLEY_DENSITY_EXPONENT = 0.75

/**
 * 书脊的「谷」：摊开的书，书脊那一小段纸是塌进书里的。
 *
 * ## 为什么要有谷
 *
 * 摊开的书不是两张平纸对折：书心那一段纸向下弯，弯量从书脊向外渐渐变小，
 * 到离书脊约一掌宽就摊平了。整个书因此是一个**连续曲面**，书心读成一条谷。
 *
 * 只让两页各转 9°（一块平面绕书脊转）得到的是**折角**：两页在中线碰成一个尖，
 * 纸心是硬的，读成两张纸拼在一起。有谷才是「一本摊开的书」。
 *
 * ## 曲线怎么取
 *
 * 倾角沿谷方向 θ(u) = 谷底角 · (1 − u/谷宽)^1.5：
 *   - u=0（书脊）：倾角最大，纸面在这里最陡；
 *   - u=谷宽：倾角归零，纸摊平，与桌面平行。
 *
 * 纵深由折线积分给出（与卷页同一套算法）：每条带按自己的倾角推进一段，
 * 于是谷是一个真正的曲面，而不是几块斜面拼的台阶。
 */
export function spineValleyPoses(options: SpineValleyOptions): SpineValleyStrip[] {
  const valleyWidth = Number.isFinite(options.valleyWidth) && options.valleyWidth > 0 ? options.valleyWidth : 0
  const slices = Number.isFinite(options.slices) && (options.slices as number) >= 1
    ? Math.min(12, Math.floor(options.slices as number))
    : 4
  const valleyDeg = Number.isFinite(options.valleyDeg) ? Math.min(45, Math.max(0, options.valleyDeg)) : 0

  /** 谷方向上 u 处的倾角。 */
  const angleAt = (u: number): number => {
    if (valleyWidth <= 0) return 0
    const t = Math.max(0, Math.min(1, u / valleyWidth))
    return valleyDeg * Math.pow(1 - t, VALLEY_ANGLE_EXPONENT)
  }

  // 条带边界：靠书脊那几条更窄（曲率最大）。
  const boundaries: number[] = []
  for (let index = 0; index <= slices; index += 1) {
    boundaries.push(Math.pow(index / slices, VALLEY_DENSITY_EXPONENT) * valleyWidth)
  }

  const strips: SpineValleyStrip[] = []
  // 先算出每条带的抬升量（rise）：谷底（书脊）在最深处，向外缘抬回桌面。
  const rises: number[] = []
  const angles: number[] = []
  for (let index = 0; index < slices; index += 1) {
    const offset = boundaries[index]!
    const width = boundaries[index + 1]! - offset
    const angle = angleAt(offset + width / 2)
    const rad = (angle * Math.PI) / 180
    angles.push(angle)
    rises.push(width * Math.sin(rad))
  }
  // 总抬升：书脊比外缘低这么多。把它摊到每条带上，
  // 于是第一条带在谷底（最靠后），最后一条带回到桌面高度。
  const totalRise = rises.reduce((sum, value) => sum + value, 0)
  let x = 0
  let rise = 0
  for (let index = 0; index < slices; index += 1) {
    const offset = boundaries[index]!
    const width = boundaries[index + 1]! - offset
    const angle = angles[index]!
    const rad = (angle * Math.PI) / 180
    strips.push({
      index,
      x,
      // 纵深是相对谷底：谷底最深（最靠后），外缘回到 0。
      z: rise - totalRise,
      angle,
      width,
      projectedWidth: width * Math.cos(rad),
      offset,
    })
    x += width * Math.cos(rad)
    rise += rises[index]!
  }
  return strips
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
 *
 * 0.14 意味着书脊侧只比纸角晚一小拍：整页几乎是一起绕书脊掀起来的。
 * 早先延后到 0.55 时，前一半行程里书脊侧钉在桌上一动没动，外缘却已经甩到
 * 正对观者的位置——纸被弯成一个固定的扇面，转轴从书脊跑到了纸面中间，
 * 那一帧看起来就像有人捏着纸角把页面从书里揭下来。真书翻页的转轴始终在书脊，
 * 书脊侧只比纸角晚一点点（纸在那里被压弯），不会晚到半程。
 */
const ROOT_DELAY = 0.14

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
 * 落定途中弯度摊开成一张宽面。指数从 1.28 降到 1.04，
 * 末段接近 1 就是「整张纸一起摊平」——真纸落位时不是一折一折地压，是整片落下去。
 */
const FLIP_CURL_EXPONENT_START = 1.28
const FLIP_CURL_EXPONENT_END = 1.04

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
const FLIP_STRIP_DENSITY_EXPONENT = 0.72

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
  // 三条时间线：纸角领跑、书脊侧晚起，两者的差就是纸弯出的那个弓。
  const tip = tipProgress(t)
  const root = rootProgress(t)
  const rootAngle = from + span * root
  const tipAngle = from + span * tip
  // 弯度超上限时整条曲线一起压缩：早先的写法是「压住纸角」，
  // 那一压就把纸角钉死在某个角度上不动了，画面上纸的外缘卡住、只有里侧在转。
  // 压缩不改变任何一条时间线的形状，纸角全程照旧在走。
  const gap = tipAngle - rootAngle
  const bendCap = Math.max(0, Math.min(FLIP_MAX_BEND_DEG, Math.abs(span) * 0.9))
  // 用 tanh 软压缩而不是硬截断：纸弯到接近挺度上限时增速变缓，但**不会停住**。
  // 硬截断会让外缘在书脊侧追上来之前被钉在同一个角度上——那正是「僵硬」的读感。
  const scaledGap = bendCap > 0 ? bendCap * Math.tanh(gap / bendCap) : gap
  // 弯度沿页宽的分布指数：起手时弯得急，落定途中摊平成一张宽面。
  const exponent = curlExponent(t)

  /** 某一页宽位置 s 处的转角。 */
  const angleAt = (s: number): number => {
    const s01 = clamp01(s)
    return rootAngle + scaledGap * Math.pow(s01, exponent)
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
    poses.push({
      angle,
      startAngle,
      endAngle,
      x,
      z: z + FLIP_SHEET_CLEARANCE_PX,
      offset,
      width: stripWidth,
    })
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
 * 正文开始退 / 完全隐去的正视程度（|cos θ|）。
 *
 * 只有纸**真的侧立**时才把字收干净：0.07（约 86°）才到 0。
 *
 * ## 曾经踩过的坑：57°–123° 一律清零，整张纸成了无字纸板
 *
 * 早先按 |cos| ≤ 0.55 一票否决。可是书脊侧又晚起，中段整页的带子全落在那段角域里：
 * 那一帧的翻动页上**一个字也没有**，它又已经扫到左页上方，左页正文在纸的轮廓处
 * 被硬切一刀——读者看到的就是「页面被撕开一条」。
 */
const FLIP_CONTENT_CLEAR_FACING = 0.5
const FLIP_CONTENT_BLANK_FACING = 0.07

export function flipContentOpacity(angleDeg: number): number {
  const facing = flipFacing(angleDeg)
  if (facing >= FLIP_CONTENT_CLEAR_FACING) return 1
  if (facing <= FLIP_CONTENT_BLANK_FACING) return 0
  const t = (facing - FLIP_CONTENT_BLANK_FACING) / (FLIP_CONTENT_CLEAR_FACING - FLIP_CONTENT_BLANK_FACING)
  return t * t * (3 - 2 * t)
}

/**
 * 背面（纸的里子）的字影：上限压得很低，只在纸侧立时收掉。
 */
export function flipBackOpacity(angleDeg: number): number {
  const facing = flipFacing(angleDeg)
  return Math.min(1, Math.max(0, (facing - 0.05) / 0.42)) * 0.08
}

/**
 * 纸背正文的淡入：纸背转过 90° 才参与合成，所以 90° 起淡、108° 露全——
 * 那时投影已有页宽的三成，字能读了。
 */
export function flipBackContentOpacity(angleDeg: number): number {
  const angle = Number.isFinite(angleDeg) ? Math.abs(angleDeg) : 180
  if (angle <= 90) return 0
  const full = 108
  if (angle >= full) return 1
  const t = (angle - 90) / (full - 90)
  return t * t * (3 - 2 * t)
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
  /** 整张纸在屏幕平面内朝翻页方向滚多少（deg）：纸角被捏住后不会左右完全对称 */
  roll: number
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
export function flipSheetLift(progress: number, direction: 1 | -1 = 1): FlipSheetLift {
  const t = clamp01(progress)
  const rise = Math.sin(Math.PI * tipProgress(t))
  return {
    lift: FLIP_SAIL_PX * rise,
    // 倾角只取 6°：纸绕书脊转，不需要整页向后仰。早先 19° 让纸的上缘朝观者
    // 压过来十几度，透视下纸的上半张被放大、向下缘收缩，整页读成一块斜插在书上的板。
    tilt: 6 * rise,
    // 右页向左翻时纸角在右侧，先抬右下角；左页反向时镜像。
    roll: direction * 1.2 * rise,
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
  const wobble = t > 0.82 ? Math.sin(settle * Math.PI * 2.5) * (1 - settle) * 0.7 : 0
  // 侧倾只取 1.6°：整本书跟着晃一下就够了。早先 3.2° 会把右半页推到观者面前，
  // 再被透视放大——翻页时半本书看起来比另一半大一圈，那也是一层「纸被揭开」的错觉。
  return {
    rotateY: direction * (1.6 * Math.pow(lift, 1.1) + wobble),
    lift: 6 * Math.pow(lift, 1.2) + wobble * 2,
  }
}
