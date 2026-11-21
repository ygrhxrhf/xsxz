/**
 * Three.js 真实书籍场景。
 *
 * 造型目标来自 ereader.space/bk_bw60tk：深色书桌上摊着一本厚书，双页贴图来自
 * 分页结果，灯光从左上照下，书脊与页堆有实体厚度。这里不追求把目标站每个
 * shader 逐行搬过来，而是先复刻构图、材质、开合和翻页这些读者能直接感到的部分。
 */

import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import {
  buildPageTexturePlan,
  PAGE_TEXTURE_HEIGHT,
  PAGE_TEXTURE_SCALE,
  PAGE_TEXTURE_WIDTH,
  textureStyleSignature,
  type RealBookTexturePage,
  type RealBookTextureStyle,
} from './realBookTexture'
import { RealBookTextureRasterizer } from './realBookTextureRasterizer'
import {
  BOOK_HEIGHT,
  BOOK_WIDTH,
  BOARD_THICKNESS,
  COVER_OVERHANG,
  CAMERA_FOV,
  DEFAULT_TILT_RAD,
  DEFAULT_ZOOM,
  DESK_PALETTES,
  ENDPAPER_PALETTES,
  MAX_ZOOM,
  MIN_ZOOM,
  bookOffsetX,
  bookThickness,
  cameraPose,
  degreesToTilt,
  type RealBookDesk,
  type RealBookEndpaper,
} from './realBookWebGLModel'
import type { PageScreenQuad } from './realBookTextLayer'
import { flyerFacePages } from './realBookFlyerText'
import { idleFlutterAmount, pageCornerPeel } from './realBookPeel'
// 飞行页的物理来自 Infinite Reader（Apache-2.0）的 BookModel：LeafSim 的 PBD 网格
// 直接解算纸的卷曲（curlAngles 的对称弧面 + 行滞后 + 空气阻力 + flex 弹簧），
// 不再另铺一层解析弧面/布料滤波器。
import { GRID_V, LeafMesh } from './realBookLeafMesh'
import { LeafSim } from './realBookLeafSim'
import {
  advanceFlyer,
  createFlyerMotion,
  flyerEnv,
  releaseFlyer,
  setDragPhase,
  setDragPointerRow,
  setQuickPhase,
  type FlyerMotionState,
} from './realBookLeafMotion'
import { BLANK_TEXTURE, createPaperMaterial, shadowRig, SH_COLS, SH_ROWS, SH_SLOTS, type PaperUniforms } from './realBookPaperMaterial'
import { CaseBinding } from './realBookCaseBinding'

export interface RealBookScenePages {
  left: RealBookTexturePage | null
  right: RealBookTexturePage | null
  flipFront: RealBookTexturePage | null
  flipBack: RealBookTexturePage | null
}

/**
 * 一张正在飞的纸。
 *
 * 快速连翻时会有好几张同时在飞，所以这里按「一张纸」而不是「一次翻页」描述：
 * `front` 是纸正面（起手朝上的那一面）该印的页，`back` 是纸背（落定后朝上的那一面）。
 * 两面各自用哪一版页心由 `direction` 推出来，不需要调用方再指定。
 */
export interface RealBookSceneFlip {
  /** 同一次翻页在多帧之间复用它，纸才不会每帧从零开始重算布料。 */
  id: number
  front: RealBookTexturePage | null
  back: RealBookTexturePage | null
  direction: 1 | -1
  /** 0–1（允许略过 1，弹簧会回弹到 1） */
  progress: number
  /** 拖页中：进度严格跟手，不走惯性 */
  follow: boolean
  /** 拖页取消：纸按参考站的自然弹簧回到出发侧，页面内容不变。 */
  cancel?: boolean
  /** 起拖时手捏在纸上的横向位置（页宽 0–1）：参考站的 beginDrag(u)，决定纸绕哪一点卷。 */
  u?: number
  /** 起拖时手捏在纸上的纵向位置（0–1，页顶为 0）：参考站的 beginDrag(v)。 */
  v?: number
  /** 当前手指/起拖的纵向位置（0–1）：窄屏卷页的折线按它倾斜。 */
  grabV?: number
  /** 当前手指纵向位置（0–1）：手指沿页高移动时折线跟着转。 */
  pointerV?: number
}

/**
 * 飞页网格由 LeafMesh 固定为 40 列 × 26 行（GRID_U × GRID_V）。
 * 页间软影不再用单独的网格，改由纸质 shader 的 `shadowRig` 沿灯光射线解析求交。
 */

/** 桌面高度：书壳、书垛和书页都从这个基准往上叠（略高于桌面，避免与桌/影平面共面）。 */
const BOOK_BASE_Z = -0.215

/** 与参考站相同的三次平滑；beginDrag 的抓点映射要用它。 */
const smoothstep01 = (x: number): number => {
  const value = Math.max(0, Math.min(1, x))
  return value * value * (3 - 2 * value)
}

/** 同时在飞的纸上限（含正在落定的那张）。 */
export const MAX_FLIP_SHEETS = 6

/**
 * 纸与书页之间的距离比例。
 *
 * 参考站的页宽 6.4 / 页高 9.2 与逻辑页（640×920 px）一一对应，纸自己从书脊
 * 走到对面。我们这里沿用同一套书页坐标，只把纸抬离纸面一点点，避免与静态页
 * 共面时 z-fighting。
 */
const FLIP_SHEET_LIFT = 0.004

/** 一个飞页槽位的全部渲染状态。 */
interface FlipSheetRuntime {
  group: THREE.Group
  /** 双面纸质网格：正面/背面由 gl_FrontFacing 选纹理，透字与透光也在这层材质里。 */
  leaf: LeafMesh
  /** 纸的 PBD 网格：每帧由 `realBookLeafMotion` 解算，LeafMesh 直接读它的 x/z 与曲率。 */
  sim: LeafSim
  /** 这一张纸的运动状态（参考站 BookModel.flyers 的字段）。 */
  motion: FlyerMotionState | null
  /** 当前占用的翻页 id；0 表示空槽。 */
  id: number
  direction: 1 | -1
  /** 最新的翻页进度（驱动 quick 时钟）。 */
  progress: number
  follow: boolean
  /** 窄屏卷页的手指纵向位置（0–1）：折线随手指倾斜，而不是永远横过页心。 */
  grabV: number
  pointerV: number
  /** 窄屏松手时纸所在的相位：参考站 stepPhoneFlyers 的三次曲线从这里出发。 */
  phoneEaseFrom: number
  /**
   * 只给最上面那张纸用的开关：正文由 DOM 文本层贴上去（跟着卷曲走、字更清楚），
   * 纹理里只留纸面、标记、注卡和图片。
   *
   * 同时飞好几张时只有最上面那张走 DOM：DOM 永远在 canvas 之上，
   * 下面那张的字会画到上面那张的纸面上，宁可退回纹理。
   */
  domText: boolean
  frontPage: RealBookTexturePage | null
  backPage: RealBookTexturePage | null
}

export interface RealBookSceneOptions {
  style: RealBookTextureStyle
  pages: RealBookScenePages
  desk: RealBookDesk
  endpaper: RealBookEndpaper
  /** 窄屏单页模式：只显示当前页，页高按视口比例。 */
  singlePage?: boolean
  tiltDeg: number
  zoom: number
  open: boolean
  totalChars: number
  pageCount: number
  progress: number
  bookTitle: string
  bookAuthor: string
}

export interface BookScreenRect {
  left: number
  top: number
  width: number
  height: number
}

function disposeMaterial(material: THREE.Material | THREE.Material[] | undefined): void {
  if (!material) return
  if (Array.isArray(material)) {
    material.forEach(disposeMaterial)
    return
  }
  const map = (material as THREE.MeshStandardMaterial).map
  if (map) map.dispose()
  material.dispose()
}

/** 封面标题断行：优先在中文标点后断开，否则按两半均分。 */
function coverTitleLines(title: string): string[] {
  const text = String(title || '未命名').trim().replace(/\s+/g, ' ') || '未命名'
  if (text.length <= 12) return [text]
  const breakpoints = [...text.matchAll(/[）)、，。·—】」』]/g)]
    .map((match) => (match.index ?? 0) + 1)
    .filter((index) => index > 2 && index < text.length - 2)
  const half = text.length / 2
  const cut = breakpoints.reduce((best, index) => (
    best < 0 || Math.abs(index - half) < Math.abs(best - half) ? index : best
  ), -1)
  const at = cut > 0 ? cut : Math.ceil(text.length / 2)
  return [text.slice(0, at), text.slice(at)]
}

/**
 * 封面：参考站是深蓝布面、没有边框，标题是大号烫金中文，下面一行小字副题。
 * 早先的金色双线框会把封面读成「笔记本」，而且固定 44px 会把长书名从中间切开；
 * 这里按封面宽度反算字号，并在标点处断行。
 */
function makeCoverTexture(title: string, author: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 736
  const ctx = canvas.getContext('2d')!
  // 布面：左上受光、右下压暗。
  const gradient = ctx.createLinearGradient(0, 0, canvas.width * 0.85, canvas.height)
  gradient.addColorStop(0, '#1b3552')
  gradient.addColorStop(0.55, '#0f2438')
  gradient.addColorStop(1, '#071422')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  // 织纹：细横纹 + 稀疏竖纹，只在近看时出现。
  for (let y = 0; y < canvas.height; y += 3) {
    ctx.fillStyle = y % 6 === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.03)'
    ctx.fillRect(0, y, canvas.width, 1)
  }
  for (let i = 0; i < 90; i += 1) {
    const x = (i * 37.7) % canvas.width
    ctx.fillStyle = 'rgba(255,255,255,0.018)'
    ctx.fillRect(x, 0, 1, canvas.height)
  }
  // 装订侧的铰链：左侧一条暗缝 + 一点受光的布面凸起。
  const hinge = ctx.createLinearGradient(0, 0, 46, 0)
  hinge.addColorStop(0, 'rgba(0,0,0,0.46)')
  hinge.addColorStop(0.12, 'rgba(0,0,0,0.26)')
  hinge.addColorStop(0.42, 'rgba(255,255,255,0.07)')
  hinge.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = hinge
  ctx.fillRect(0, 0, 46, canvas.height)

  const lines = coverTitleLines(title)
  const usable = canvas.width - 104
  const longest = Math.max(...lines.map((line) => line.length), 1)
  const titleSize = Math.max(30, Math.min(76, Math.floor((usable / longest) * 0.98)))
  const titleLineHeight = titleSize * 1.22
  const blockTop = canvas.height * 0.325 - ((lines.length - 1) * titleLineHeight) / 2
  ctx.fillStyle = '#e7cb8b'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `500 ${titleSize}px "LXGW WenKai Screen", "Noto Serif SC", "Songti SC", serif`
  lines.forEach((line, index) => {
    ctx.fillText(line, canvas.width / 2, blockTop + index * titleLineHeight)
  })
  const subtitle = String(author || '').trim()
  if (subtitle) {
    ctx.fillStyle = 'rgba(231, 203, 139, 0.72)'
    ctx.font = 'italic 21px "EB Garamond", "Noto Serif SC", serif'
    const spaced = subtitle.length <= 18 ? [...subtitle].join(' ') : subtitle
    ctx.fillText(spaced, canvas.width / 2, blockTop + lines.length * titleLineHeight + 20)
  }
  // 顶部一道极淡的受光，封面才不是一个平涂的色块。
  const sheen = ctx.createLinearGradient(0, 0, canvas.width, canvas.height * 0.6)
  sheen.addColorStop(0, 'rgba(255,255,255,0.04)')
  sheen.addColorStop(0.45, 'rgba(255,255,255,0)')
  ctx.fillStyle = sheen
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}


/**
 * 桌面贴图在 440×440 的桌面上平铺的次数。
 *
 * 可见桌区只有三十来个场景单位；按 1 次铺满整块桌面的话，屏幕里看到的是贴图
 * 中央很小的一块，木纹和明暗全被拉平——桌面读成一块纯色板。16 次之后，
 * 可见区域大约是一张完整的木纹，颗粒和深浅才回得来。
 */
const DESK_TILE_REPEAT = 16

const DESK_ASSET_URLS: Record<RealBookDesk, string> = {
  walnut: new URL('../assets/realbook/desk-walnut.webp', import.meta.url).href,
  linen: new URL('../assets/realbook/desk-ash.webp', import.meta.url).href,
  graphite: new URL('../assets/realbook/desk-ink.webp', import.meta.url).href,
  sage: new URL('../assets/realbook/desk-baize.webp', import.meta.url).href,
  limestone: new URL('../assets/realbook/desk-stone.webp', import.meta.url).href,
}

/** 真实桌面贴图的兜底：图片加载前/失败时仍有一块同色桌面。 */
function makeDeskCanvasTexture(desk: RealBookDesk): THREE.CanvasTexture {
  const palette = DESK_PALETTES[desk] ?? DESK_PALETTES.walnut
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 1024
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height)
  gradient.addColorStop(0, palette.light)
  gradient.addColorStop(0.52, palette.swatch)
  gradient.addColorStop(1, palette.dark)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  // 木纹/织物的低频颗粒；不用随机数，避免每次重开书桌纹理明显跳动。
  for (let i = 0; i < 700; i += 1) {
    const x = (i * 97.31) % canvas.width
    const y = (i * 53.77) % canvas.height
    const alpha = 0.018 + (i % 7) * 0.004
    ctx.fillStyle = i % 2 ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`
    ctx.fillRect(x, y, 1 + (i % 3), 1 + (i % 5))
  }
  const vignette = ctx.createRadialGradient(canvas.width / 2, canvas.height * 0.4, 80, canvas.width / 2, canvas.height * 0.4, canvas.width * 0.72)
  vignette.addColorStop(0, 'rgba(255,255,255,0)')
  vignette.addColorStop(1, 'rgba(0,0,0,0.22)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(DESK_TILE_REPEAT, DESK_TILE_REPEAT)
  return texture
}

function makePageEdgeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 512
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#e6d3b6'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  for (let y = 0; y < canvas.height; y += 3) {
    ctx.fillStyle = y % 6 === 0 ? 'rgba(116,91,60,0.18)' : 'rgba(255,248,232,0.12)'
    ctx.fillRect(0, y, canvas.width, 1)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(1, 1.4)
  return texture
}

function makeShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(128, 128, 16, 128, 128, 128)
  gradient.addColorStop(0, 'rgba(0,0,0,0.5)')
  gradient.addColorStop(0.42, 'rgba(0,0,0,0.21)')
  gradient.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 256, 256)
  return new THREE.CanvasTexture(canvas)
}

const PAGE_SEGMENTS_X = 40
const PAGE_SEGMENTS_Y = 26

/**
 * 静态页沿页宽方向的曲率，供纸质 shader 的曲率暗化读取。
 *
 * 与 `LeafMesh` 用同一套符号约定：取相邻三点的切线，`atan2(cross, dot)` 得到
 * 单位长度的转角。只在预掀/还原改写顶点后调用，静止页不会每帧重算。
 */
function writePageCurvature(geometry: THREE.PlaneGeometry): void {
  const position = geometry.attributes.position as THREE.BufferAttribute
  const curvature = geometry.attributes.aCurv as THREE.BufferAttribute | undefined
  if (!curvature) return
  const stride = PAGE_SEGMENTS_X + 1
  for (let row = 0; row <= PAGE_SEGMENTS_Y; row += 1) {
    const base = row * stride
    for (let column = 0; column <= PAGE_SEGMENTS_X; column += 1) {
      const index = base + column
      if (column === 0 || column === PAGE_SEGMENTS_X) {
        curvature.setX(index, 0)
        continue
      }
      const previous = index - 1
      const next = index + 1
      const t1x = position.getX(index) - position.getX(previous)
      const t1z = position.getZ(index) - position.getZ(previous)
      const t2x = position.getX(next) - position.getX(index)
      const t2z = position.getZ(next) - position.getZ(index)
      const cross = t1x * t2z - t1z * t2x
      const dot = t1x * t2x + t1z * t2z
      const length = Math.hypot(t1x, t1z) || 1
      curvature.setX(index, Math.atan2(cross, dot) / length)
    }
  }
  curvature.needsUpdate = true
}

/**
 * 纸面在离书脊 `ax`（世界单位）处的高度：书脊侧压平，外缘微微翘起。
 *
 * 左右两页必须镜像：右页的 u=1 是外口，左页的 u=0 才是外口。早先两页共用同一份
 * 几何，左页的书脊侧反而翘起、外缘是平的，合起来不仅中缝差一个高度，飞页落到
 * 左页时也会陷进静态页里。现在按 `mirror` 把 z 面翻到正确的一侧，飞页的碰撞面
 * 直接复用同一条曲线（`leafEnv`），起手和落定都贴着真实的纸面。
 */
function pageProfile(ax: number): number {
  const u = Math.max(0, Math.min(1, ax / BOOK_WIDTH))
  return 0.008 * Math.sin(u * Math.PI) + 0.018 * Math.exp(-(1 - u) * 9)
}

function makePageGeometry(mirror = false): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(BOOK_WIDTH, BOOK_HEIGHT, PAGE_SEGMENTS_X, PAGE_SEGMENTS_Y)
  const positions = geometry.attributes.position
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index)
    const raw = (x + BOOK_WIDTH / 2) / BOOK_WIDTH
    const ax = Math.max(0, Math.min(1, mirror ? 1 - raw : raw))
    positions.setZ(index, pageProfile(ax * BOOK_WIDTH))
  }
  geometry.setAttribute('aCurv', new THREE.BufferAttribute(new Float32Array(positions.count), 1))
  geometry.computeVertexNormals()
  writePageCurvature(geometry)
  return geometry
}

/**
 * 飞页纸背由 LeafMesh 的 `uBack`（按 1-u 采样）负责，不再需要单独建一份翻转 U 的几何。
 * 静态页仍是单面 PlaneGeometry，纸背不可见。
 */


export class RealBookWebGLScene {
  private readonly host: HTMLElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 500)
  private readonly bookGroup = new THREE.Group()
  private readonly pageLeft: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  private readonly pageRight: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  /** 静态页与飞页共用纸质 shader：落页前后材质一致，不会在落定瞬间换一种亮度。 */
  private readonly pageUniformsLeft: PaperUniforms
  private readonly pageUniformsRight: PaperUniforms
  private readonly pageGeometryLeft: THREE.PlaneGeometry
  private readonly pageGeometryRight: THREE.PlaneGeometry
  private readonly pageRestLeft: Float32Array
  private readonly pageRestRight: Float32Array
  /** 当前被预掀弯过的那一页；换边或落回时要还原它的静止顶点。 */
  private peeledSide: 'left' | 'right' | null = null
  private peelCorner: 1 | -1 = 1
  private peelApplied = false
  private peelAmount = 0
  /** 悬停预掀：指针停在外角时把那一角抬起来（参考站的 setPeel）。 */
  private hoverPeel = {
    side: null as 'left' | 'right' | null,
    target: 0,
    corner: 1 as 1 | -1,
  }
  /** 悬停/空闲两条来源各自的当前强度，取大者作为这一帧的预掀量。 */
  private hoverAmount = 0
  private idleAmount = 0
  private lastInteraction = typeof performance !== 'undefined' ? performance.now() : 0
  private readonly blockLeft: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial[]>
  private readonly blockRight: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial[]>
  private readonly blockGeometry = new THREE.BoxGeometry(BOOK_WIDTH, BOOK_HEIGHT + 0.04, 1)
  private readonly coverPivot = new THREE.Group()
  private readonly cover: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]>
  private readonly backBoard: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]>
  /** 布面书壳：柔性接缝、凹槽衬里和头/尾布条，绕书脊包住书垛。 */
  private readonly binding: CaseBinding
  /** 书垛厚度（不含两块书板），在场景创建时固定；书页/书垛/书脊都按它对齐。 */
  private readonly blockTotal: number
  /** 书页所在高度：桌面 + 书板 + 书垛。 */
  private readonly pagePlaneZ: number
  /** 同时在飞的纸：固定 3 个槽位，按上层给的顺序占用。 */
  private readonly flipSheets: FlipSheetRuntime[] = []
  private flipEntries: RealBookSceneFlip[] = []
  /** 页面样式/批注变了：飞页纹理要在下一次拿到新页对象时重画。 */
  private sheetsNeedRefresh = true
  private readonly desk: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private readonly coverMaterial: THREE.MeshStandardMaterial
  private readonly innerMaterial: THREE.MeshStandardMaterial
  private readonly pageEdgeMaterial: THREE.MeshStandardMaterial
  private readonly desks = new Map<RealBookDesk, THREE.Texture>()
  /** 页面纹理的光栅化器：Worker 画布 + LRU，主线程只拿 ImageBitmap 上传。 */
  private readonly rasterizer: RealBookTextureRasterizer
  /** 空白飞页面的纯纸色贴图：上游用 shader 纸色，我们的纹理已带纸色，这里按色缓存。 */
  private readonly solidPapers = new Map<string, THREE.CanvasTexture>()
  /** 主光的世界方向与它在相机空间的投影，供纸质 shader 的背光/包裹漫反射用。 */
  private readonly lampPosition = new THREE.Vector3(-11, 13, 36)
  private readonly lightDir = new THREE.Vector3(-11, 13, 36).normalize()
  private readonly viewLightDir = new THREE.Vector3()
  private style: RealBookTextureStyle
  private pages: RealBookScenePages
  private deskId: RealBookDesk
  private endpaperId: RealBookEndpaper
  private singlePage: boolean
  private pageHeightWorld: number
  private tilt = DEFAULT_TILT_RAD
  private zoom = DEFAULT_ZOOM
  private open01 = 1
  private openTarget = 1
  private totalChars = 0
  private pageCount = 0
  private progress = 0
  /** 飞页贴面取样的临时向量：每帧要取上百个点，热路径里不能再分配对象。 */
  private readonly flipSampleA = new THREE.Vector3()
  private readonly flipSampleB = new THREE.Vector3()
  private readonly flipSampleC = new THREE.Vector3()
  private readonly flipSampleView = new THREE.Vector3()
  private readonly flipSampleProjected = new THREE.Vector3()
  /** 本帧真实间隔（秒），由 loop 写入，供 PBD 子步用。 */
  private frameDelta = 1 / 60
  /**
   * 飞页的碰撞环境：碰撞面就是静态页的外缘翘起曲线，飞页的落点因此不会陷进纸里。
   * 左右页镜像后的高度是同一个 |x| 函数，所以一张环境对象可以给所有纸共用。
   */
  private readonly leafEnv = flyerEnv((x) => pageProfile(Math.abs(x)))
  private frame = 0
  private disposed = false
  private resizeObserver: ResizeObserver | null = null
  /** 上一帧的时间戳（ms）。three r187 的 `Clock` 已废弃，直接用 rAF 时间戳。 */
  private lastFrameTime = 0

  constructor(host: HTMLElement, options: RealBookSceneOptions) {
    this.host = host
    this.style = options.style
    this.pages = options.pages
    this.deskId = options.desk
    this.endpaperId = options.endpaper
    this.tilt = degreesToTilt(options.tiltDeg)
    this.zoom = options.zoom
    this.open01 = options.open ? 1 : 0
    this.openTarget = this.open01
    this.totalChars = options.totalChars
    this.pageCount = Math.max(1, options.pageCount)
    this.progress = options.progress
    this.singlePage = options.singlePage ?? false
    const stylePageWidth = options.style.pageWidth ?? PAGE_TEXTURE_WIDTH
    const stylePageHeight = options.style.pageHeight ?? PAGE_TEXTURE_HEIGHT
    this.pageHeightWorld = BOOK_WIDTH * stylePageHeight / stylePageWidth

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    const maybeNeutral = (THREE as unknown as { NeutralToneMapping?: THREE.ToneMapping }).NeutralToneMapping
    this.renderer.toneMapping = maybeNeutral ?? THREE.ACESFilmicToneMapping
    // 参考站的纸面在屏幕上是 #EDD7BA 上下；这里用略高于 1 的曝光把纸和桌面一起提亮，
    // 单靠调纸色会把纹理推到接近纯白，暗部反而先死。
    this.renderer.toneMappingExposure = 1.06
    this.renderer.shadowMap.enabled = true
    // r187 移除了 PCFSoftShadowMap（会被静默降级并打警告）；纸面的软影靠 flipShadow 补。
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.domElement.className = 'real-book-webgl-canvas'
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.renderer.domElement.style.touchAction = 'none'
    host.appendChild(this.renderer.domElement)
    this.scene.background = new THREE.Color('#0b0705')

    this.camera.up.set(0, 1, 0)
    this.camera.fov = CAMERA_FOV
    this.camera.near = 0.1
    this.camera.far = 500

    this.coverMaterial = new THREE.MeshStandardMaterial({ color: '#16273b', roughness: 0.86, metalness: 0 })
    this.innerMaterial = new THREE.MeshStandardMaterial({ color: ENDPAPER_PALETTES[this.endpaperId].swatch, roughness: 0.96, metalness: 0 })
    this.pageEdgeMaterial = new THREE.MeshStandardMaterial({ map: makePageEdgeTexture(), roughness: 1, metalness: 0 })

    // 垂直堆叠：桌面 → 后书板 → 书垛 → 书页；合上时前封面落在书垛顶上。
    const initialThickness = bookThickness(this.pageCount, this.totalChars, this.progress)
    const blockTotal = initialThickness.total
    this.blockTotal = blockTotal
    this.pagePlaneZ = BOOK_BASE_Z + BOARD_THICKNESS + blockTotal
    const zh = BOARD_THICKNESS + blockTotal / 2

    this.binding = new CaseBinding(
      BOOK_HEIGHT,
      COVER_OVERHANG,
      BOARD_THICKNESS,
      blockTotal,
      this.coverMaterial.color.clone(),
      this.innerMaterial,
    )
    this.binding.group.position.z = BOOK_BASE_Z
    // 书板向内收 joint，给柔性接缝留出位置；书壳的两肩就能落在书板上。
    const joint = this.binding.joint
    const boardWidth = BOOK_WIDTH + COVER_OVERHANG - joint
    const coverTexture = makeCoverTexture(options.bookTitle, options.bookAuthor)
    const outerMaterial = new THREE.MeshStandardMaterial({ map: coverTexture, roughness: 0.62, metalness: 0 })

    this.coverPivot.position.set(0, 0, BOOK_BASE_Z + zh)
    this.cover = new THREE.Mesh(
      new RoundedBoxGeometry(boardWidth, BOOK_HEIGHT + COVER_OVERHANG * 2, BOARD_THICKNESS, 2, 0.018),
      [this.coverMaterial, this.coverMaterial, this.coverMaterial, this.coverMaterial, outerMaterial, this.innerMaterial],
    )
    // 局部 z = zh - tb/2：打开时绕书脊转到桌面，合上时落到书垛顶。
    this.cover.position.set((BOOK_WIDTH + COVER_OVERHANG + joint) / 2, 0, zh - BOARD_THICKNESS / 2)
    this.cover.castShadow = true
    this.cover.receiveShadow = true
    this.coverPivot.add(this.cover)
    this.backBoard = new THREE.Mesh(
      new RoundedBoxGeometry(boardWidth, BOOK_HEIGHT + COVER_OVERHANG * 2, BOARD_THICKNESS, 2, 0.018),
      [this.coverMaterial, this.coverMaterial, this.coverMaterial, this.coverMaterial, this.innerMaterial, this.coverMaterial],
    )
    this.backBoard.position.set((BOOK_WIDTH + COVER_OVERHANG + joint) / 2, 0, BOOK_BASE_Z + BOARD_THICKNESS / 2)
    this.backBoard.castShadow = true
    this.backBoard.receiveShadow = true

    // 左右页各一份几何：悬停预掀只弯被指到的那一页，共用一份几何会两页一起翘。
    this.pageGeometryLeft = makePageGeometry(true)
    this.pageGeometryRight = makePageGeometry(false)
    this.pageRestLeft = new Float32Array(this.pageGeometryLeft.attributes.position.array)
    this.pageRestRight = new Float32Array(this.pageGeometryRight.attributes.position.array)
    const leftPaper = createPaperMaterial()
    const rightPaper = createPaperMaterial()
    this.pageUniformsLeft = leftPaper.uniforms
    this.pageUniformsRight = rightPaper.uniforms
    // 静态页的纸色/中缝已经画在纹理里：不再叠 shader 的中缝压暗，也不透出纸背。
    for (const uniforms of [this.pageUniformsLeft, this.pageUniformsRight]) {
      uniforms.uShowThrough.value = 0
      uniforms.uGutter.value = 0
    }
    this.pageLeft = new THREE.Mesh(this.pageGeometryLeft, leftPaper.material)
    this.pageRight = new THREE.Mesh(this.pageGeometryRight, rightPaper.material)
    const pageScaleY = this.pageHeightWorld / BOOK_HEIGHT
    this.pageLeft.position.set(-BOOK_WIDTH / 2, 0, this.pagePlaneZ)
    this.pageRight.position.set(this.singlePage ? 0 : BOOK_WIDTH / 2, 0, this.pagePlaneZ)
    this.pageLeft.scale.y = pageScaleY
    this.pageRight.scale.y = pageScaleY
    this.pageLeft.visible = !this.singlePage
    this.pageLeft.receiveShadow = true
    this.pageRight.receiveShadow = true

    this.blockLeft = new THREE.Mesh(this.blockGeometry, this.blockMaterials('left'))
    this.blockRight = new THREE.Mesh(this.blockGeometry, this.blockMaterials('right'))
    this.blockLeft.position.set(-BOOK_WIDTH / 2, 0, 0)
    this.blockRight.position.set(BOOK_WIDTH / 2, 0, 0)
    this.blockLeft.castShadow = true
    this.blockRight.castShadow = true
    this.blockLeft.receiveShadow = true
    this.blockRight.receiveShadow = true

    this.bookGroup.add(
      this.pageLeft,
      this.pageRight,
      this.blockLeft,
      this.blockRight,
      this.coverPivot,
      this.backBoard,
      this.binding.group,
    )
    for (let slot = 0; slot < MAX_FLIP_SHEETS; slot += 1) this.flipSheets.push(this.createFlipSheet(slot))
    this.scene.add(this.bookGroup)

    this.desk = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: this.deskTexture(this.deskId), roughness: DESK_PALETTES[this.deskId].roughness, metalness: 0 }),
    )
    this.desk.position.z = -0.22
    this.desk.receiveShadow = true
    this.desk.scale.set(440, 440, 1)
    this.scene.add(this.desk)

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: makeShadowTexture(), transparent: true, opacity: 0.8, depthWrite: false }),
    )
    this.shadow.position.z = -0.218
    this.shadow.scale.set(BOOK_WIDTH * 2 + 1.4, BOOK_HEIGHT + 1.2, 1)
    this.scene.add(this.shadow)

    // 参考站的灯是暖白而不是琥珀色：早先 #ffe9cf 会把纸和桌面一起染橙，
    // 纸面蓝通道被压掉两成，怎么调纸色都回不到参考图的米白。
    const spot = new THREE.SpotLight('#fff6ec', 3.5, 0, 0.62, 1, 0)
    spot.position.copy(this.lampPosition)
    spot.target.position.set(0, 0, 0)
    spot.castShadow = true
    spot.shadow.mapSize.set(2048, 2048)
    spot.shadow.bias = -0.0007
    spot.shadow.radius = 11
    spot.shadow.camera.near = 12
    spot.shadow.camera.far = 80
    this.scene.add(spot, spot.target)
    // 解析软影用同一盏灯的位置：页面上被飞页挡住的灯射线由 shader 求交。
    shadowRig.uLampW.value.copy(this.lampPosition)
    // 环境光取中性：暖环境光叠在暖色灯的上面，会把纸和桌面一起推回橙色。
    this.scene.add(new THREE.HemisphereLight('#f6f3ee', '#241a12', 0.6))
    // 右前方补光：主光偏左上，右侧外口原本比左侧暗一截，纸面读起来半边脏。
    const fill = new THREE.DirectionalLight('#f2ecdf', 0.32)
    fill.position.set(14, -10, 20)
    this.scene.add(fill)

    this.resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize())
    this.resizeObserver?.observe(host)
    // 纹理光栅化在 Worker 里做；占位图先上，画完再贴一次。
    this.rasterizer = new RealBookTextureRasterizer({
      onReady: () => this.applyPages(),
      maxAnisotropy: this.renderer.capabilities.getMaxAnisotropy(),
    })
    this.resize()
    this.applyPages()
    this.applyProgress()
    this.applyOpen(true)
    this.loop(performance.now())
  }

  /** 造一张飞页：双面纸质网格 + 布料。软影由 shadowRig 统一发布，不再单独建影子网格。 */
  private createFlipSheet(_slot: number): FlipSheetRuntime {
    // LeafMesh 自带 40×26 顶点、双面材质、曲率属性；正/背面在 shader 里由 gl_FrontFacing 选纹理。
    const leaf = new LeafMesh(BOOK_WIDTH, BOOK_HEIGHT)
    // 飞页的纸色与中缝同样来自页面纹理。
    leaf.uniforms.uGutter.value = 0
    // 顶点每帧被布料改写，包围球一算就是旧的；关掉视锥剔除，免得纸飞到半边突然被裁掉。
    leaf.mesh.frustumCulled = false
    const group = new THREE.Group()
    group.add(leaf.mesh)
    group.visible = false
    group.scale.y = this.pageHeightWorld / BOOK_HEIGHT
    this.bookGroup.add(group)
    return {
      group,
      leaf,
      sim: new LeafSim(BOOK_WIDTH, BOOK_HEIGHT),
      motion: null,
      id: 0,
      direction: 1,
      progress: 0,
      follow: false,
      grabV: 0.5,
      pointerV: 0.5,
      phoneEaseFrom: 0,
      domText: false,
      frontPage: null,
      backPage: null,
    }
  }

  private blockMaterials(innerSide: 'left' | 'right'): THREE.MeshStandardMaterial[] {
    // BoxGeometry 材质顺序：+x、-x、+y、-y、+z、-z。
    // 书脊侧不能用浅色纸边：那条边正好露在中缝，会在两页之间形成一道毛糙白边。
    return [
      innerSide === 'left' ? this.coverMaterial : this.pageEdgeMaterial,
      innerSide === 'right' ? this.coverMaterial : this.pageEdgeMaterial,
      this.pageEdgeMaterial,
      this.pageEdgeMaterial,
      this.innerMaterial,
      this.coverMaterial,
    ]
  }

  /**
   * 采集图 → 桌面纹理：降饱和、提亮，再按可见桌区平铺。
   *
   * 采集的胡桃木偏红偏暗，参考站的桌面是偏灰、被环境光托起来的胡桃木；
   * 只用灯光调会把纸和桌面一起推亮，所以先在贴图上压饱和度、抬中间调。
   */
  private conditionedDeskTexture(source: THREE.Texture): THREE.CanvasTexture | null {
    const image = source.image as CanvasImageSource | null
    if (!image || typeof document === 'undefined') return null
    const canvas = document.createElement('canvas')
    canvas.width = 1024
    canvas.height = 1024
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // 一次做完降饱和与提亮：采集的胡桃木比参考站更红更暗。
    // 用 canvas filter 而不是叠色，免得把木纹的明暗层次也一起抹平。
    ctx.filter = 'saturate(0.55) brightness(1.16)'
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    ctx.filter = 'none'
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(DESK_TILE_REPEAT, DESK_TILE_REPEAT)
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    return texture
  }

  private deskTexture(desk: RealBookDesk): THREE.Texture {
    const cached = this.desks.get(desk)
    if (cached) return cached
    const fallback = makeDeskCanvasTexture(desk)
    this.desks.set(desk, fallback)
    const url = DESK_ASSET_URLS[desk]
    if (!url) return fallback
    const loader = new THREE.TextureLoader()
    loader.load(
      url,
      (texture) => {
        if (this.disposed) {
          texture.dispose()
          return
        }
        const treated = this.conditionedDeskTexture(texture) ?? texture
        if (treated !== texture) texture.dispose()
        this.desks.set(desk, treated)
        if (this.deskId === desk) {
          this.desk.material.map = treated
          this.desk.material.needsUpdate = true
        }
        fallback.dispose()
      },
      undefined,
      () => {
        // 加载失败时保留同色 Canvas 兜底。
      },
    )
    return fallback
  }

  private textureFor(
    page: RealBookTexturePage | null,
    side: 'left' | 'right',
    omitBodyText: boolean,
  ): THREE.Texture | null {
    if (!page) return null
    const style = { ...this.style, side, omitBodyText }
    const key = `${side}:${omitBodyText ? 'dom' : 'paper'}:${textureStyleSignature(page, style)}`
    const plan = buildPageTexturePlan(page, style)
    // 等待期间先给同色纸，纹理就绪后 onReady 会重新贴一次。
    return this.rasterizer.get(key, plan, style, PAGE_TEXTURE_SCALE, this.solidPaperTexture(this.style.paper))
  }

  setPages(pages: RealBookScenePages, style = this.style): void {
    this.pages = pages
    this.style = style
    this.applyPages()
  }

  private applyPages(): void {
    // 静态页正文交给 DOM 文本层：纹理只画纸、批注、图片、页眉页脚。
    this.applyPageTexture(this.pageUniformsLeft, this.pages.left, 'left')
    this.applyPageTexture(this.pageUniformsRight, this.pages.right, 'right')
    // 页面样式（字号/纸张色）或批注变了，飞页上的纹理也要跟着重画。
    // 这里拿到的页对象还是上一次的，所以只打标记，等下一次 setFlips 拿到新对象再画。
    this.sheetsNeedRefresh = true
    for (const sheet of this.flipSheets) {
      if (sheet.frontPage || sheet.backPage) this.applySheetPages(sheet)
    }
  }

  /** 静态页只有正面：uFront 换成这一页的纹理；没有页时铺纯纸色，避免亮成一块白纸。 */
  private applyPageTexture(
    uniforms: PaperUniforms,
    page: RealBookTexturePage | null,
    side: 'left' | 'right',
  ): void {
    uniforms.uFront.value = this.textureFor(page, side, true) ?? this.solidPaperTexture(this.style.paper)
  }

  /** 纯纸色贴图：飞页某一面没有页（书首/书尾的空白面）时用它，避免 shader 的白色默认值亮出一块白纸。 */
  private solidPaperTexture(color: string | undefined): THREE.Texture {
    const key = color || '#f4ecd8'
    const cached = this.solidPapers.get(key)
    if (cached) return cached
    if (typeof document === 'undefined') return BLANK_TEXTURE
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const ctx = canvas.getContext('2d')
    if (!ctx) return BLANK_TEXTURE
    ctx.fillStyle = key
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    this.solidPapers.set(key, texture)
    return texture
  }

  /** 把槽位上的两页画成纹理交给 LeafMesh：正面印右页、纸背印左页，与 DOM 贴面层同一套分配。 */
  private applySheetPages(sheet: FlipSheetRuntime): void {
    // 正反面该印哪一页由 `flyerFacePages` 统一决定（往回翻时两页互换），
    // DOM 贴面层用的是同一个函数，两层不会各印一页。
    const faces = flyerFacePages<RealBookTexturePage>(sheet.direction, sheet.frontPage, sheet.backPage)
    const paper = this.solidPaperTexture(this.style.paper)
    const front = this.textureFor(faces[0].page, faces[0].side, sheet.domText) ?? paper
    const back = this.textureFor(faces[1].page, faces[1].side, sheet.domText) ?? paper
    // LeafMesh 的 uFront 是 gl_FrontFacing 那一面（右页），uBack 用 1-u 采样（左页）。
    sheet.leaf.setTextures(front, back)
  }

  setSinglePage(singlePage: boolean, pageWidth: number, pageHeight: number): void {
    const nextHeight = BOOK_WIDTH * pageHeight / Math.max(1, pageWidth)
    if (this.singlePage === singlePage && Math.abs(this.pageHeightWorld - nextHeight) < 1e-6) return
    this.singlePage = singlePage
    this.pageHeightWorld = nextHeight
    const scaleY = this.pageHeightWorld / BOOK_HEIGHT
    this.pageLeft.visible = !singlePage
    this.pageRight.position.x = singlePage ? 0 : BOOK_WIDTH / 2
    this.pageLeft.scale.y = scaleY
    this.pageRight.scale.y = scaleY
    this.binding.group.visible = !singlePage
    for (const sheet of this.flipSheets) sheet.group.scale.y = scaleY
    this.updateCamera()
  }

  setAppearance(desk: RealBookDesk, endpaper: RealBookEndpaper): void {
    if (desk !== this.deskId) {
      this.deskId = desk
      const material = this.desk.material
      material.map = this.deskTexture(desk)
      material.roughness = DESK_PALETTES[desk].roughness
      material.needsUpdate = true
    }
    this.endpaperId = endpaper
    this.innerMaterial.color.set(ENDPAPER_PALETTES[endpaper].swatch)
  }

  setView(tiltDeg: number, zoom: number): void {
    this.tilt = degreesToTilt(tiltDeg)
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom))
    this.noteInteraction()
  }

  setOpen(open: boolean, immediate = false): void {
    this.noteInteraction()
    this.openTarget = open ? 1 : 0
    if (immediate) {
      this.open01 = this.openTarget
      this.applyOpen(true)
    }
  }

  /**
   * 悬停预掀：指针停在外角时把那一角先掀起一点（参考站的 setPeel）。
   * `side` 为 null 或 amount 归零时，纸角落回。
   */
  setHoverPeel(side: 'left' | 'right' | null, amount: number, corner: 1 | -1): void {
    this.hoverPeel.side = side
    this.hoverPeel.target = side ? Math.max(0, Math.min(1, amount)) : 0
    this.hoverPeel.corner = corner >= 0 ? 1 : -1
    if (side) this.noteInteraction()
  }

  /** 指针动过就算交互：空闲飘动要等没有操作时才起。 */
  noteInteraction(): void {
    this.lastInteraction = performance.now()
    this.idleAmount = 0
  }

  get isOpen(): boolean {
    return this.openTarget > 0.5
  }

  /**
   * 上层给到「此刻在飞的纸」，按顺序从旧到新。
   *
   * 一张纸的身份用 `id` 认：同一个 id 会一直落在同一个槽位上，布料和弹簧的状态
   * 才不会每帧清零；id 变了说明这是一张新纸，直接从它的起始进度接管。
   */
  setFlips(entries: RealBookSceneFlip[]): void {
    this.noteInteraction()
    this.flipEntries = entries.slice(0, MAX_FLIP_SHEETS)
    for (let index = 0; index < this.flipSheets.length; index += 1) {
      const sheet = this.flipSheets[index]!
      const entry = this.flipEntries[index]
      if (!entry) {
        sheet.id = 0
        sheet.motion = null
        sheet.group.visible = false
        continue
      }
      const target = Math.max(0, Math.min(1, Number.isFinite(entry.progress) ? entry.progress : 0))
      // 卷页折线按手指在纸上的纵向位置倾斜；自动翻页没有手指，固定过页心。
      const grabV = Math.max(0, Math.min(1, entry.grabV ?? 0.5))
      const pointerV = Math.max(0, Math.min(1, entry.pointerV ?? grabV))
      // 只有最上面那张纸的正文走 DOM：它在 canvas 之上不会挡住别的纸。
      // 窄屏卷页的纸会卷成筒，DOM 小段在卷曲处会叠成一团，改由纹理带字。
      const domText = index === 0 && !this.singlePage
      if (sheet.id !== entry.id) {
        // 新纸：按出发页堆的形状铺平，再接管它自己的进度。
        sheet.id = entry.id
        sheet.direction = entry.direction
        sheet.progress = target
        sheet.phoneEaseFrom = target
        sheet.follow = entry.follow
        sheet.grabV = grabV
        sheet.pointerV = pointerV
        sheet.domText = domText
        sheet.frontPage = entry.front
        sheet.backPage = entry.back
        // 参考站的起手位置：手捏在外缘（u 默认 0.95），行靠近页心；拖页时用父层给的抓点。
        // v 由参考站的 beginDrag 再收一次：手指明显在页角附近时才让纸角领得多。
        const grabU = Math.max(0.55, Math.min(0.97, entry.u ?? 0.95))
        const rawV = Math.max(0.04, Math.min(0.96, entry.v ?? 0.5))
        const corner = smoothstep01((Math.abs(rawV - 0.5) - 0.2) / 0.2)
        const grabVv = this.singlePage ? rawV : Math.max(0.04, Math.min(0.96, 0.5 + (rawV - 0.5) * (0.35 + 0.65 * corner)))
        sheet.motion = this.singlePage
          ? null
          : createFlyerMotion(sheet.sim, entry.direction, grabU, grabVv, this.leafEnv)
        if (sheet.motion) {
          if (entry.follow) setDragPhase(sheet.motion, target)
          else setQuickPhase(sheet.motion, target)
        }
        this.applySheetPages(sheet)
        continue
      }
      // 上层每帧都会重算页对象，不能拿对象身份当「换页了」的判据：
      // 页码变了才是真的换了内容；样式/批注这类改动由 applyPages 打标记补上。
      const pageChanged = sheet.frontPage?.pageNumber !== entry.front?.pageNumber
        || sheet.backPage?.pageNumber !== entry.back?.pageNumber
        || sheet.direction !== entry.direction
        || sheet.domText !== domText
        || this.sheetsNeedRefresh
      if (pageChanged) {
        sheet.frontPage = entry.front
        sheet.backPage = entry.back
        sheet.direction = entry.direction
        sheet.domText = domText
        this.applySheetPages(sheet)
      }
      const releasing = sheet.follow && !entry.follow
      const wasProgress = sheet.progress
      if (releasing) sheet.phoneEaseFrom = wasProgress
      sheet.follow = entry.follow
      sheet.grabV = grabV
      sheet.pointerV = pointerV
      // 纸的进度只决定 quick 时钟或手指角度；几何由 PBD 网格自己解算。
      sheet.progress = target
      if (!sheet.motion) continue
      if (entry.follow) {
        // 拖页：纸捏在手指上，角度严格跟手（参考站 moveDrag 写的是同一个量）。
        setDragPhase(sheet.motion, target)
        // 手指纵向位置换到页底为 0，并按参考站的方式只取 30% 的跟随量。
        const rawPointer = Math.max(0.04, Math.min(0.96, 1 - pointerV))
        const followV = Math.max(0.04, Math.min(0.96, sheet.motion.grabV + 0.3 * (rawPointer - sheet.motion.grabV)))
        setDragPointerRow(sheet.motion, followV)
      } else {
        // 松手：从当前角度接着走参考站的自然弹簧；同一次翻页里进度回头也要跟着回。
        if (releasing) releaseFlyer(sheet.motion)
        // 取消：回到出发侧（参考站的 cancelDrag 把 targetPhi 设回起手角）。
        sheet.motion.targetPhi = entry.cancel
          ? (sheet.direction === 1 ? 0 : Math.PI)
          : (sheet.direction === 1 ? Math.PI : 0)
        if (sheet.motion.mode === 'quick') setQuickPhase(sheet.motion, target)
      }
    }
    this.sheetsNeedRefresh = false
  }

  setProgress(progress: number, totalChars: number, pageCount: number): void {
    this.progress = Math.max(0, Math.min(1, progress))
    this.totalChars = Math.max(0, totalChars)
    this.pageCount = Math.max(1, pageCount)
    this.applyProgress()
  }

  private applyProgress(): void {
    // 书垛总厚度在场景创建时固定；进度只把纸从右垛连续转移到左垛。
    const total = this.blockTotal
    const left = total * Math.max(0, Math.min(1, this.progress))
    const right = total - left
    this.blockLeft.scale.z = Math.max(0.012, left)
    this.blockRight.scale.z = Math.max(0.012, right)
    // 书垛顶面比书页低 2mm：两者共面会在中缝闪出一条锯齿状的白边。
    const top = this.pagePlaneZ - 0.002
    this.blockLeft.position.z = top - left / 2
    this.blockRight.position.z = top - right / 2
    this.blockLeft.visible = left > 0.01
    this.blockRight.visible = right > 0.01
    this.bookGroup.position.x = bookOffsetX(this.open01, BOARD_THICKNESS + total / 2, this.singlePage)
    this.binding.update(Math.PI * (1 - this.open01), BOARD_THICKNESS + total, BOARD_THICKNESS + total)
  }

  private applyOpen(immediate = false): void {
    const open = this.open01
    this.coverPivot.rotation.y = -Math.PI * open
    this.pageLeft.visible = !this.singlePage && open > 0.02
    this.pageRight.visible = open > 0.02
    this.blockLeft.visible = open > 0.02 && this.blockLeft.scale.z > 0.012
    this.blockRight.visible = this.blockRight.scale.z > 0.012
    this.binding.group.visible = !this.singlePage
    this.binding.update(Math.PI * (1 - open), BOARD_THICKNESS + this.blockTotal, BOARD_THICKNESS + this.blockTotal)
    this.bookGroup.position.x = bookOffsetX(open, BOARD_THICKNESS + this.blockTotal / 2, this.singlePage)
    this.shadow.material.opacity = 0.46 + 0.34 * open
    // 书壳现在只在原位旋转，整本书始终贴着桌面；不再给 bookGroup 加抬升。
    this.bookGroup.position.z = 0
    void immediate
  }

  resize(): void {
    if (this.disposed) return
    const width = Math.max(1, this.host.clientWidth || 960)
    const height = Math.max(1, this.host.clientHeight || 720)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.updateCamera()
  }

  private updateCamera(): void {
    // 合上时把俯仰收小：参考站的合上封面接近正对，打开后再回到用户设定的视角。
    // 用 open01 连续过渡，开合动画里镜头是跟着书一起抬起来的，不会切一刀。
    const tilt = this.tilt * (0.28 + 0.72 * this.open01)
    const pose = cameraPose(tilt, this.zoom, 0, 0, this.camera.aspect, this.singlePage, this.pageHeightWorld)
    this.camera.position.set(...pose.position)
    this.camera.lookAt(...pose.lookAt)
    this.camera.updateMatrixWorld()
  }

  /** 主光在相机空间的方向：纸质 shader 的包裹漫反射/背光透射读它。 */
  private updatePaperLighting(): void {
    this.viewLightDir.copy(this.lightDir).transformDirection(this.camera.matrixWorldInverse)
    this.pageUniformsLeft.uLightDirV.value.copy(this.viewLightDir)
    this.pageUniformsRight.uLightDirV.value.copy(this.viewLightDir)
    for (const sheet of this.flipSheets) {
      sheet.leaf.uniforms.uLightDirV.value.copy(this.viewLightDir)
    }
  }

  /**
   * 写飞页网格。
   *
   * 双页：`sim` 已经被 `realBookLeafMotion` 的 PBD 解算推进过，LeafMesh 直接读
   * 它的 x/z（40 行 × 40 列），再按 40×26 顶点写出法线与曲率。参考站的纸是
   * 一整张连续曲面，没有「解析弧面 + 布料低通」两层几何。
   *
   * 窄屏：仍然是参考站的 `phoneCurl` 滚动折（纸绕一条会走的折线卷起），
   * 单页只有一张纸，不走 PBD 网格。
   */
  private writeFlipGeometry(sheet: FlipSheetRuntime, t: number): void {
    if (this.singlePage) {
      let phase = Math.max(0, Math.min(1, t))
      if (!sheet.follow) {
        // 参考站 stepPhoneFlyers：松手后从当前相位三次曲线落到目标；quick 的起点是 0。
        const from = Math.max(0, Math.min(1, sheet.phoneEaseFrom))
        const span = 1 - from
        if (span > 1e-6) {
          const raw = Math.max(0, Math.min(1, (phase - from) / span))
          phase = from + span * (1 - (1 - raw) ** 3)
        }
      }
      const curlT = sheet.direction === 1 ? phase : 1 - phase
      sheet.leaf.writePhoneCurl(curlT, sheet.grabV, sheet.pointerV, 0)
      return
    }
    if (!sheet.motion) return
    // LeafMesh 一次写出顶点、法线与曲率；纸面的暗部、透光与中缝都读这份数据。
    sheet.leaf.write(sheet.sim)
  }

  /**
   * 把这一帧飞行纸的截面发布给纸质 shader 的解析软影。
   *
   * 每张纸沿页高取五条截面（20 个采样点），写进共享的浮点纹理；
   * 接收纸面在 shader 里沿灯光射线与这些截面求交，得到跟着纸形走的软影与半影。
   * 只发布最上面的两张（`SH_SLOTS`），透明度随落定包络衰减。
   */
  private syncShadowRig(): void {
    const count = Math.min(this.flipEntries.length, this.flipSheets.length)
    const active: FlipSheetRuntime[] = []
    for (let index = 0; index < count; index += 1) active.push(this.flipSheets[index]!)
    // 参考站只让「最立起来」的两张纸投影，越接近落点透明度越低（落定混合已把纸按到页堆上）。
    const casters = active
      .filter((sheet) => sheet.motion !== null)
      .sort((a, b) => Math.abs(a.motion!.phi - Math.PI / 2) - Math.abs(b.motion!.phi - Math.PI / 2))
      .slice(0, SH_SLOTS)
      .map((sheet) => ({
        sheet,
        opacity: Math.max(0, 1 - sheet.motion!.landingAmount),
      }))
      .filter((item) => item.opacity > 0.01)
    const texture = shadowRig.uShTex.value
    if (!casters.length || !texture) {
      shadowRig.uShN.value = 0
      shadowRig.uShOpacity.value.fill(0)
      this.pageUniformsLeft.uShRecv.value = 0
      this.pageUniformsRight.uShRecv.value = 0
      for (const sheet of this.flipSheets) {
        sheet.leaf.uniforms.uShRecv.value = 0
        sheet.leaf.uniforms.uShSelf.value = -1
      }
      return
    }
    const data = texture.image.data as Float32Array
    // 与 LeafMesh 的行对齐：页脚、下四分之一、页心、上四分之一、页眉五条截面。
    const rows = Array.from({ length: SH_ROWS }, (_, index) => Math.round((index / (SH_ROWS - 1)) * (GRID_V - 1)))
    shadowRig.uShOpacity.value.fill(0)
    casters.forEach(({ sheet, opacity }, slot) => {
      shadowRig.uShOpacity.value[slot] = opacity
      sheet.leaf.mesh.updateWorldMatrix(true, false)
      const matrix = sheet.leaf.mesh.matrixWorld
      rows.forEach((row, index) => {
        sheet.leaf.exportRow(data, (slot * SH_ROWS + index) * SH_COLS, SH_COLS, row, matrix)
      })
    })
    texture.needsUpdate = true
    shadowRig.uShN.value = casters.length
    // 静态页永远是接收面；飞行纸既可能被上面那张遮住，也可能自己当投射源。
    this.pageUniformsLeft.uShRecv.value = 1
    this.pageUniformsRight.uShRecv.value = 1
    const slots = new Map<FlipSheetRuntime, number>()
    casters.forEach(({ sheet }, slot) => slots.set(sheet, slot))
    for (const sheet of this.flipSheets) {
      const slot = slots.get(sheet)
      sheet.leaf.uniforms.uShSelf.value = slot ?? -1
      sheet.leaf.uniforms.uShRecv.value = active.includes(sheet) ? 1 : 0
    }
  }

  /**
   * 逐帧推进所有在飞的纸。
   *
   * 多张纸同时飞的时候，每张纸各有自己的 PBD 网格与运动状态；层次上先起的纸在**上面**——
   * 后来那张是从它底下抽出来的，两人的落点还叠在一起时，谁压谁必须固定，否则会闪。
   * 页间软影由 `syncShadowRig` 统一发布，不再有单独的影子网格。
   */
  private updateFlip(): void {
    const count = this.flipEntries.length
    for (let index = 0; index < this.flipSheets.length; index += 1) {
      const sheet = this.flipSheets[index]!
      const active = index < count
      sheet.group.visible = active
      if (!active) continue
      this.stepFlipMotion(sheet)
      // 纸页 pose 已包含绕脊旋转，组本身不再重复旋转；页心高度就是书页所在平面。
      // 单页卷页的网格局部 x 是 0..W，需要整体左移半页，才能与居中的书页对齐。
      sheet.group.position.set(this.singlePage ? -BOOK_WIDTH / 2 : 0, 0, this.pagePlaneZ + (count - index) * FLIP_SHEET_LIFT)
      this.writeFlipGeometry(sheet, sheet.progress)
    }
    // 网格写完再发布截面：软影读的就是这一帧的纸面形状。
    this.syncShadowRig()
  }

  /**
   * 推进一张纸的物理。
   *
   * 参考站把运动固定步长积分（1/240，单帧最多 12 步）再渲染：纸的解算是刚性的，
   * 用帧间隔直接积分会在掉帧时改变轨迹。这里照同一套子步与预算（12 × 1/240 = 50ms，
   * 与参考站的 `dt = min(dt, 1/20)` 同一上限），单帧走不完的部分就丢掉，不补积。
   */
  private stepFlipMotion(sheet: FlipSheetRuntime): void {
    const motion = sheet.motion
    if (!motion) return
    const frame = Math.min(this.frameDelta, 1 / 20)
    let remaining = frame
    let steps = 0
    const h = 1 / 240
    // quick 时钟由父层的 rAF 时钟每帧写入一次；一个渲染帧内的子步共用这个角度，
    // 与参考站按 age 推进只在字面上一帧之差（240Hz 子步的分辨率远低于 60Hz 画面）。
    while (remaining > 1e-6 && steps < 12) {
      advanceFlyer(motion, h, this.leafEnv)
      remaining -= h
      steps += 1
    }
  }

  /**
   * 诊断快照：当前所有在飞纸的角度、网格关键点与帧状态。
   *
   * 只在 `window` 上挂一个只读探针（`window.__rbSceneProbe`）时使用；
   * 截图与观感复核脚本用它读「纸现在转到哪、卷成什么样」，不参与渲染。
   */
  probeFlipState(): Array<Record<string, number>> {
    return this.flipSheets
      .filter((sheet) => sheet.group.visible && sheet.motion)
      .map((sheet) => {
        const motion = sheet.motion!
        const sim = sheet.sim
        return {
          phi: motion.phi,
          mode: motion.mode === 'quick' ? 0 : motion.mode === 'drag' ? 1 : motion.mode === 'auto' ? 2 : 3,
          flex: motion.flex,
          landing: motion.landingAmount,
          tipX: sim.x[sim.N - 1]!,
          midX: sim.x[Math.floor(sim.N * 0.6)]!,
          rootX: sim.x[0]!,
          tipZ: sim.z[sim.N - 1]!,
          midZ: sim.z[Math.floor(sim.N * 0.6)]!,
          progress: sheet.progress,
        }
      })
  }

  getBookScreenRect(): BookScreenRect {
    this.updateCamera()
    const rect = this.host.getBoundingClientRect()
    const open = this.open01
    const edgeMinX = this.singlePage ? -BOOK_WIDTH / 2 : -BOOK_WIDTH * open
    const edgeMaxX = this.singlePage ? BOOK_WIDTH / 2 : BOOK_WIDTH
    const halfY = this.pageHeightWorld / 2
    const points = [
      [edgeMinX, -halfY, this.pagePlaneZ],
      [edgeMaxX, -halfY, this.pagePlaneZ],
      [edgeMinX, halfY, this.pagePlaneZ],
      [edgeMaxX, halfY, this.pagePlaneZ],
    ] as const
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const point of points) {
      const projected = new THREE.Vector3(...point).project(this.camera)
      const x = (projected.x + 1) / 2 * rect.width
      const y = (1 - projected.y) / 2 * rect.height
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY }
  }

  /** 飞页纸面上的一点：取 LeafMesh 实际渲染的三角面，再换到世界坐标。 */
  private sheetSurface(sheet: FlipSheetRuntime, u: number, v: number, out: THREE.Vector3): void {
    sheet.leaf.pointAt(u, v, out)
    sheet.group.localToWorld(out)
  }

  /**
   * 飞页纸面上某一点的屏幕投影与朝向，供 DOM 文本层贴面用。
   *
   * `u` 沿页宽（0 = 书脊）、`v` 沿页高（0 = 下缘），取样的是布料**当前**的形状，
   * 所以字跟着纸的卷曲和惯性走，不需要上层再传一次进度。
   * 返回 false 表示这一点此刻不该画（纸不在、点在镜头后面）。
   * `facing > 0` 是纸的正面朝镜头，`< 0` 是纸背——与正反面两个材质同一套判定。
   */
  sampleFlipPage(
    index: number,
    u: number,
    v: number,
    out: { x: number; y: number; facing: number },
  ): boolean {
    const sheet = this.flipSheets[index]
    if (!sheet || !sheet.group.visible || sheet.id === 0) return false
    sheet.group.updateWorldMatrix(true, false)
    this.camera.updateMatrixWorld()
    const rect = this.host.getBoundingClientRect()
    // 取样步长只用来求切向：太大在卷得急的地方会切进相邻段，太小会被浮点噪声放大。
    const step = 0.002
    const a = this.flipSampleA
    const b = this.flipSampleB
    const c = this.flipSampleC
    this.sheetSurface(sheet, u, v, a)
    this.sheetSurface(sheet, Math.min(1, u + step), v, b)
    this.sheetSurface(sheet, u, Math.min(1, v + step), c)
    const view = this.flipSampleView.copy(a).applyMatrix4(this.camera.matrixWorldInverse)
    // Three 的相机看 −z：z 不小于 0 的点在镜头后面，投影会翻到画面另一侧。
    if (view.z > -0.05) return false
    const projected = this.flipSampleProjected.copy(a).project(this.camera)
    out.x = (projected.x + 1) / 2 * rect.width
    out.y = (1 - projected.y) / 2 * rect.height
    const ux = b.x - a.x
    const uy = b.y - a.y
    const uz = b.z - a.z
    const vx = c.x - a.x
    const vy = c.y - a.y
    const vz = c.z - a.z
    // 法向 = ∂p/∂u × ∂p/∂v；静止时（u 向右、v 向上）正好是 +z，与正面材质同向。
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const toCameraX = this.camera.position.x - a.x
    const toCameraY = this.camera.position.y - a.y
    const toCameraZ = this.camera.position.z - a.z
    out.facing = nx * toCameraX + ny * toCameraY + nz * toCameraZ
    return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.facing)
  }

  /** 页角的屏幕投影：逻辑页坐标 (0,0)-(W,H) → 宿主像素。 */
  getPageScreenQuad(side: 'left' | 'right'): PageScreenQuad {
    this.updateCamera()
    this.bookGroup.updateMatrixWorld()
    const page = side === 'left' ? this.pageLeft : this.pageRight
    const rect = this.host.getBoundingClientRect()
    const corners = [
      [0, 0],
      [BOOK_WIDTH, 0],
      [BOOK_WIDTH, BOOK_HEIGHT],
      [0, BOOK_HEIGHT],
    ] as const
    return corners.map(([x, y]) => {
      const local = new THREE.Vector3(-BOOK_WIDTH / 2 + x, BOOK_HEIGHT / 2 - y, 0)
      const world = page.localToWorld(local)
      const projected = world.project(this.camera)
      return { x: (projected.x + 1) / 2 * rect.width, y: (1 - projected.y) / 2 * rect.height }
    }) as PageScreenQuad
  }

  private loop = (now = 0): void => {
    if (this.disposed) return
    this.frame = requestAnimationFrame(this.loop)
    const elapsed = this.lastFrameTime ? (now - this.lastFrameTime) / 1000 : 1 / 60
    this.lastFrameTime = now
    const delta = Math.min(0.05, elapsed > 0 ? elapsed : 1 / 60)
    this.frameDelta = delta
    if (Math.abs(this.open01 - this.openTarget) > 0.0005) {
      this.open01 += (this.openTarget - this.open01) * (1 - Math.exp(-delta * 7))
      this.applyOpen()
    } else if (this.open01 !== this.openTarget) {
      this.open01 = this.openTarget
      this.applyOpen(true)
    }
    this.updateCamera()
    this.updatePaperLighting()
    this.updateFlip()
    this.updatePeel(delta, now)
    this.shadow.scale.x = BOOK_WIDTH * 2 + 1.4 + Math.sin(this.open01 * Math.PI) * 0.25
    this.renderer.render(this.scene, this.camera)
  }

  /**
   * 预掀（悬停 + 空闲飘动）统一在这里求值并只弯被指到的那一页。
   *
   * 悬停与空闲是同一个几何效果的两条来源，取强度大者；页面只有 40×26 个顶点，
   * 强度变化幅度小于阈值时跳过重写法线，指针停住/一轮飘动内的重复值不会空转。
   */
  private updatePeel(delta: number, now: number): void {
    const busy = !this.isOpen || this.flipEntries.length > 0
    const hoverTarget = busy ? 0 : (this.hoverPeel.side ? this.hoverPeel.target : 0)
    this.hoverAmount += (hoverTarget - this.hoverAmount) * (1 - Math.exp(-Math.max(0, delta) * 16))

    // 空闲飘动：只在打开、双页、没有悬停/翻页时启动，单页（手机）不参与。
    const idleTarget = busy || this.hoverPeel.side || this.singlePage
      ? 0
      : idleFlutterAmount(now - this.lastInteraction)
    this.idleAmount += (idleTarget - this.idleAmount) * (1 - Math.exp(-Math.max(0, delta) * 10))

    const amount = Math.max(this.hoverAmount, this.idleAmount)
    if (amount < 0.002) {
      this.hoverAmount = 0
      this.idleAmount = 0
      this.restorePeel()
      return
    }
    const useHover = this.hoverAmount >= this.idleAmount
    const side: 'left' | 'right' = useHover ? this.hoverPeel.side! : 'right'
    const corner: 1 | -1 = useHover ? this.hoverPeel.corner : -1
    if (this.peelApplied && (this.peeledSide !== side || this.peelCorner !== corner)) this.restorePeel()
    // 强度几乎没变时不要重写顶点/法线。
    if (this.peelApplied && this.peeledSide === side && this.peelCorner === corner
      && Math.abs(amount - this.peelAmount) < 0.0005) return
    this.applyCornerPeel(side, corner, amount)
  }

  private applyCornerPeel(side: 'left' | 'right', corner: 1 | -1, amount: number): void {
    const geometry = side === 'left' ? this.pageGeometryLeft : this.pageGeometryRight
    const rest = side === 'left' ? this.pageRestLeft : this.pageRestRight
    const attribute = geometry.attributes.position as THREE.BufferAttribute
    const array = attribute.array as Float32Array
    const outerAtU1 = side === 'right'
    for (let index = 0; index < attribute.count; index += 1) {
      const offset = index * 3
      const rx = rest[offset]!
      const ry = rest[offset + 1]!
      const rz = rest[offset + 2]!
      const peel = pageCornerPeel(
        (rx + BOOK_WIDTH / 2) / BOOK_WIDTH,
        ry / BOOK_HEIGHT,
        { amount, corner, outerAtU1 },
      )
      array[offset] = rx + peel.x
      array[offset + 1] = ry + peel.y
      array[offset + 2] = rz + peel.z
    }
    attribute.needsUpdate = true
    geometry.computeVertexNormals()
    writePageCurvature(geometry)
    this.peeledSide = side
    this.peelCorner = corner
    this.peelApplied = true
    this.peelAmount = amount
  }

  private restorePeel(): void {
    if (!this.peelApplied) return
    if (this.peeledSide) this.restorePageRest(this.peeledSide)
    this.peelApplied = false
    this.peelAmount = 0
  }

  private restorePageRest(side: 'left' | 'right'): void {
    const geometry = side === 'left' ? this.pageGeometryLeft : this.pageGeometryRight
    const rest = side === 'left' ? this.pageRestLeft : this.pageRestRight
    const attribute = geometry.attributes.position as THREE.BufferAttribute
    ;(attribute.array as Float32Array).set(rest)
    attribute.needsUpdate = true
    geometry.computeVertexNormals()
    writePageCurvature(geometry)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.rasterizer.dispose()
    this.solidPapers.forEach((texture) => texture.dispose())
    this.solidPapers.clear()
    this.desks.forEach((texture) => texture.dispose())
    this.desks.clear()
    // 书壳的布纹 DataTexture 不在材质 map 上，交给 CaseBinding 自己释放；
    // 先从场景摘掉，避免下面的 traverse 再释放一次几何/材质。
    this.bookGroup.remove(this.binding.group)
    this.binding.dispose()
    this.scene.traverse((object: THREE.Object3D) => {
      const mesh = object as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose?.()
      disposeMaterial(mesh.material)
    })
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
