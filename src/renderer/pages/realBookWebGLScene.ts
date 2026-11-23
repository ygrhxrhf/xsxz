/**
 * 参考站的书体与阅读场景（Infinite Reader，Apache-2.0）。
 *
 * 这里的书不再由 spbf 自己拼平面页 + 方块书垛：`BookModel` 直接来自参考站
 * `web/src/engine/book.ts`，负责静态页的 LeafSim 铺纸、书垛曲面、布面书壳、
 * 封面/书板、开合弹簧、飞页、落定与阴影。本文件只保留参考站 `scene.ts` 里与
 * 阅读有关的部分：相机取景、桌面 shader、灯光、指针到书页坐标的换算，以及把
 * spbf 的分页结果做成页面纹理交给 BookModel。
 *
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */

import * as THREE from 'three'
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
  BOOK_WIDTH,
  CAMERA_FOV,
  DEFAULT_TILT_RAD,
  DEFAULT_ZOOM,
  fitDistance,
  degreesToTilt,
  type RealBookDesk,
  type RealBookEndpaper,
} from './realBookWebGLModel'
import type { PageScreenQuad } from './realBookTextLayer'
import { BookModel } from './realBookBookModel'
import { makeCover, type CoverSet } from './realBookCover'
import { createDesk, type DeskHandle } from './realBookDesk'
import { shadowRig } from './realBookPaperMaterial'

interface RealBookScenePages {
  left: RealBookTexturePage | null
  right: RealBookTexturePage | null
}

/** 旧翻页 run 的类型仍被舞台引用；BookModel 自己管飞页，这些字段不再驱动几何。 */
export interface RealBookSceneFlip {
  id: number
  direction: 1 | -1
  progress: number
  follow: boolean
  cancel?: boolean
  u?: number
  v?: number
  grabV?: number
  pointerV?: number
  front: RealBookTexturePage | null
  back: RealBookTexturePage | null
}

interface RealBookSceneOptions {
  style: RealBookTextureStyle
  pages: RealBookScenePages
  /** 任意页的纹理页对象：BookModel 会按需取 2k / 2k+1。 */
  pageAt?: (index: number) => RealBookTexturePage | null
  /** 当前摊开的叶序号（左页数）。 */
  turned?: number
  desk: RealBookDesk
  endpaper: RealBookEndpaper
  singlePage?: boolean
  tiltDeg: number
  zoom: number
  open: boolean
  pageCount: number
  bookTitle: string
  bookAuthor: string
}

interface BookScreenRect {
  left: number
  top: number
  width: number
  height: number
}

/** 与参考站 BookModel.zoneAt 的返回值同形。 */
interface BookZone {
  zone: 'page' | 'cover'
  side: 1 | -1
  u: number
  v: number
}

const COVER_FONT = '"LXGW WenKai Screen", "Noto Serif SC", "EB Garamond", serif'
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

export class RealBookWebGLScene {
  private readonly host: HTMLElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 4, 900)
  private readonly desk: DeskHandle
  private readonly lightDir = new THREE.Vector3(-11, 13, 36).normalize()
  private readonly viewLightDir = new THREE.Vector3()
  private readonly point = new THREE.Vector3()

  private readonly rasterizer: RealBookTextureRasterizer
  private book: BookModel | null = null
  private cover: CoverSet | null = null
  private pageAt: ((index: number) => RealBookTexturePage | null) | null = null
  private style: RealBookTextureStyle
  private deskId: RealBookDesk
  private endpaperId: RealBookEndpaper
  private singlePage: boolean
  private pageHeightWorld: number
  private pageCount: number
  private openState: boolean
  private turned = 0
  private tilt = DEFAULT_TILT_RAD
  private zoom = DEFAULT_ZOOM
  private title: string
  private author: string
  private frame = 0
  private lastFrame = 0
  private disposed = false
  private resizeObserver: ResizeObserver | null = null
  private hover: { side: 1 | -1; target: number; amount: number; v: number } | null = null
  private readonly solidPapers = new Map<string, THREE.Texture>()

  onSettle?: (turned: number, open: boolean) => void

  constructor(host: HTMLElement, options: RealBookSceneOptions) {
    this.host = host
    this.style = options.style
    this.pageAt = options.pageAt ?? null
    this.deskId = options.desk
    this.endpaperId = options.endpaper
    this.singlePage = options.singlePage ?? false
    this.pageHeightWorld = BOOK_WIDTH * (options.style.pageHeight ?? PAGE_TEXTURE_HEIGHT) / (options.style.pageWidth ?? PAGE_TEXTURE_WIDTH)
    this.pageCount = Math.max(1, options.pageCount)
    this.openState = options.open
    this.turned = options.turned ?? 0
    this.tilt = degreesToTilt(options.tiltDeg)
    this.zoom = options.zoom
    this.title = options.bookTitle
    this.author = options.bookAuthor

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    const neutral = (THREE as unknown as { NeutralToneMapping?: THREE.ToneMapping }).NeutralToneMapping
    this.renderer.toneMapping = neutral ?? THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.domElement.className = 'real-book-webgl-canvas'
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.renderer.domElement.style.touchAction = 'none'
    host.appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color(this.singlePage ? '#f7f3e8' : '#0b0705')
    this.camera.up.set(0, 1, 0)
    this.desk = createDesk()
    this.desk.setSurface(this.deskId)
    this.desk.mesh.visible = !this.singlePage
    this.scene.add(this.desk.mesh)

    // 灯与参考站 scene.ts 完全一致：暖白灯池 + 中性半球 + 冷色轮廓光。
    const spot = new THREE.SpotLight(0xffe9cf, 3.3, 0, 0.62, 1, 0)
    spot.position.set(-11, 13, 36)
    spot.target.position.set(0, 0, 0)
    spot.castShadow = true
    spot.shadow.mapSize.set(2048, 2048)
    spot.shadow.camera.near = 12
    spot.shadow.camera.far = 80
    spot.shadow.bias = -0.0007
    spot.shadow.normalBias = 0
    spot.shadow.radius = 11
    spot.shadow.intensity = 0.55
    this.scene.add(spot, spot.target)
    shadowRig.uLampW.value.copy(spot.position)
    this.scene.add(new THREE.HemisphereLight(0xfff3e2, 0x20140c, 0.55))
    const rim = new THREE.DirectionalLight(0xc8d8ff, 0.18)
    rim.position.set(14, -10, 20)
    this.scene.add(rim)
    this.lightDir.copy(spot.position).normalize()

    this.rasterizer = new RealBookTextureRasterizer({
      onReady: () => this.book?.refreshTextures(),
      maxAnisotropy: this.renderer.capabilities.getMaxAnisotropy(),
    })

    this.createBook()
    this.resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize())
    this.resizeObserver?.observe(host)
    this.resize()
    this.lastFrame = performance.now()
    this.loop(this.lastFrame)
  }

  /* ------------------------------- book -------------------------------- */

  private leafCount(): number {
    return Math.max(1, this.singlePage ? this.pageCount : Math.ceil(this.pageCount / 2))
  }

  private createBook(): void {
    if (this.cover) {
      for (const texture of [this.cover.outer, this.cover.outerBump, this.cover.inner]) texture.dispose()
    }
    this.cover = makeCover(this.title || '未命名', this.author || '', null, COVER_FONT)
    const book = new BookModel({
      singlePage: this.singlePage,
      pageHeight: this.singlePage ? this.pageHeightWorld : undefined,
      leafCount: this.leafCount(),
      turned: clamp(Math.round(this.turned), 0, this.leafCount()),
      open: this.openState,
      getTexture: (page) => this.pageTexture(page),
      cover: this.cover,
      endpaper: this.endpaperId,
    })
    book.onSettle = (turned, open) => {
      this.turned = turned
      this.onSettle?.(turned, open)
    }
    this.scene.add(book.group)
    this.book = book
  }

  private disposeBook(): void {
    if (!this.book) return
    this.scene.remove(this.book.group)
    this.book.dispose()
    this.book = null
  }

  private rebuildBook(turned = this.book?.settledTurned ?? this.turned): void {
    this.disposeBook()
    this.turned = turned
    this.createBook()
  }

  /** 页面纹理：正文/页眉页脚/批注/图片都画进纹理，DOM 层只做透明选字。 */
  private pageTexture(pageIndex: number): THREE.Texture {
    const index = this.singlePage ? Math.floor(pageIndex / 2) : pageIndex
    const page = this.pageAt?.(index) ?? null
    const side: 'left' | 'right' = this.singlePage || index % 2 === 0 ? 'right' : 'left'
    return this.textureFor(page, side, false) ?? this.solidPaperTexture(this.style.paper)
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
    return this.rasterizer.get(key, plan, style, PAGE_TEXTURE_SCALE, this.solidPaperTexture(this.style.paper))
  }

  private solidPaperTexture(color: string | undefined): THREE.Texture {
    const key = color || '#f4ecd8'
    const cached = this.solidPapers.get(key)
    if (cached) return cached
    if (typeof document === 'undefined') return new THREE.Texture()
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const ctx = canvas.getContext('2d')
    if (!ctx) return new THREE.Texture()
    ctx.fillStyle = key
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    this.solidPapers.set(key, texture)
    return texture
  }

  /* ------------------------------- pages ------------------------------- */

  setPageSource(
    pageAt: ((index: number) => RealBookTexturePage | null) | null,
    pageCount: number,
    singlePage: boolean,
    turned: number,
  ): void {
    const countChanged = pageCount !== this.pageCount || singlePage !== this.singlePage
    this.pageAt = pageAt
    this.pageCount = Math.max(1, pageCount)
    if (singlePage !== this.singlePage) {
      this.singlePage = singlePage
      this.scene.background = new THREE.Color(singlePage ? '#f7f3e8' : '#0b0705')
      this.desk.mesh.visible = !singlePage
    }
    if (countChanged) {
      // 页表重排不能吞掉正在进行的翻页：按飞页的目标叶序号重建，
      // 并把新的页号回报给父层（父层的 turned 还停在旧值）。
      const keep = this.book?.busy && !this.book.hasHeldLeaf ? this.book.targetTurned : turned
      this.rebuildBook(keep)
      if (keep !== turned) this.onSettle?.(keep, this.openState)
      return
    }
    this.turned = turned
    if (this.book && this.book.settledTurned !== turned && !this.book.busy) this.book.jumpTo(turned)
    this.book?.refreshTextures()
  }

  setPages(_pages: RealBookScenePages, style = this.style): void {
    this.style = style
    this.book?.refreshTextures()
  }

  setSinglePage(singlePage: boolean, pageWidth: number, pageHeight: number): void {
    const nextHeight = BOOK_WIDTH * pageHeight / Math.max(1, pageWidth)
    if (singlePage === this.singlePage && Math.abs(nextHeight - this.pageHeightWorld) < 1e-6) return
    this.singlePage = singlePage
    this.pageHeightWorld = nextHeight
    this.scene.background = new THREE.Color(singlePage ? '#f7f3e8' : '#0b0705')
    this.desk.mesh.visible = !singlePage
    this.rebuildBook(this.turned)
  }

  setAppearance(desk: RealBookDesk, endpaper: RealBookEndpaper): void {
    this.deskId = desk
    this.desk.setSurface(desk)
    this.endpaperId = endpaper
    this.book?.setEndpaper(endpaper)
  }

  /** 页数变化统一走 setPageSource；这里只保留兼容签名。 */
  setProgress(_progress: number, _totalChars: number, _pageCount: number): void {}

  /* ------------------------------- view --------------------------------- */

  setView(tiltDeg: number, zoom: number): void {
    this.tilt = degreesToTilt(tiltDeg)
    this.zoom = clamp(zoom, 0.12, 7)
    this.updateCamera()
  }

  setOpen(open: boolean, animate = true): void {
    this.openState = open
    if (!this.book) return
    if (animate) this.book.setOpen(open)
    else this.book.seekOpening(open ? 1 : 0)
  }

  get isOpen(): boolean {
    return this.book?.isOpen ?? this.openState
  }

  get busy(): boolean {
    return this.book?.busy ?? false
  }

  get settledTurned(): number {
    return this.book?.settledTurned ?? this.turned
  }

  get fullyOpen(): boolean {
    return this.book?.fullyOpen ?? false
  }

  canTurn(dir: 1 | -1): boolean {
    if (!this.book || !this.book.fullyOpen) return false
    if (dir === 1) return this.book.settledTurned < this.leafCount()
    return this.book.settledTurned > 0
  }

  turn(dir: 1 | -1, count = 1, quick = true): boolean {
    if (!this.book) return false
    if (!this.book.isOpen) {
      if (dir === 1) this.setOpen(true, true)
      return true
    }
    if (!this.canTurn(dir) && !this.book.busy) return false
    return this.book.turn(dir, count, quick ? 'quick' : 'natural') > 0
  }

  jumpTo(turned: number): void {
    const target = clamp(Math.round(turned), 0, this.leafCount())
    if (this.book) this.book.jumpTo(target)
    this.turned = target
  }

  /* ------------------------------ pointer ------------------------------- */

  private unproject(clientX: number, clientY: number, z: number): { x: number; y: number } {
    this.updateCamera()
    const rect = this.host.getBoundingClientRect()
    const ndc = new THREE.Vector3(
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -(((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1),
      0.5,
    ).unproject(this.camera)
    const origin = this.camera.position
    const dir = ndc.sub(origin)
    const t = (z - origin.z) / dir.z
    return { x: origin.x + dir.x * t, y: origin.y + dir.y * t }
  }

  /** 书本地坐标（与参考站 localPoint 同一套，扣掉合上时的 group 偏移）。 */
  bookPoint(clientX: number, clientY: number, z = 0.8): { x: number; y: number } {
    const p = this.unproject(clientX, clientY, z)
    return { x: p.x - (this.book?.group.position.x ?? 0), y: p.y }
  }

  zoneAt(clientX: number, clientY: number): BookZone | null {
    if (!this.book) return null
    const p = this.bookPoint(clientX, clientY)
    return this.book.zoneAt(p.x, p.y) as BookZone | null
  }

  /** 参考站 scene.ts 的 inGrabZone：只有外缘（非正文版心）才起拖，正文区留给选字。 */
  private inGrabZone(zone: BookZone): boolean {
    const pageW = Math.max(1, this.style.pageWidth ?? PAGE_TEXTURE_WIDTH)
    const pageH = Math.max(1, this.style.pageHeight ?? PAGE_TEXTURE_HEIGHT)
    const inner = this.style.marginInner ?? 80
    const outer = this.style.marginOuter ?? 58
    const top = this.style.marginTop ?? 78
    const bottom = this.style.marginBottom ?? 100
    const textL = inner / pageW
    const textR = 1 - outer / pageW
    const textB = bottom / pageH
    const textT = 1 - top / pageH
    const inText = zone.u > textL && zone.u < textR && zone.v > textB && zone.v < textT
    return !inText && zone.u > 0.5
  }

  /** 光标在可抓的外缘时返回该侧与行号（参考站 hover 里的 setPeel(1, side, v)）。 */
  hoverZoneAt(clientX: number, clientY: number): { side: 1 | -1; v: number } | null {
    const zone = this.zoneAt(clientX, clientY)
    if (!zone || zone.zone !== 'page' || !this.inGrabZone(zone)) return null
    if (!this.book || this.book.busy) return null
    const turnable = zone.side === 1 ? this.book.turned < this.leafCount() : this.book.settledTurned > 0
    return turnable ? { side: zone.side, v: zone.v } : null
  }

  beginDragAt(clientX: number, clientY: number): boolean {
    const zone = this.zoneAt(clientX, clientY)
    if (!zone || zone.zone !== 'page' || !this.inGrabZone(zone)) return false
    return this.book?.beginDrag(zone.side, zone.u, zone.v) ?? false
  }

  moveDragAt(clientX: number, clientY: number): void {
    const p = this.bookPoint(clientX, clientY)
    this.book?.moveDrag(p.x, p.y)
  }

  endDrag(velocity: number, moved: boolean, quick: boolean): void {
    this.book?.endDrag(velocity, moved, quick ? 'quick' : 'natural')
  }

  cancelDrag(): void {
    this.book?.cancelDrag()
  }

  noteInteraction(): void {}

  setHoverPeel(side: 'left' | 'right' | null, amount: number, corner: 1 | -1, v = 0.5): void {
    void corner
    if (!side) {
      this.hover = null
      this.book?.setPeel(0, 1, 0.5)
      return
    }
    const signed: 1 | -1 = side === 'right' ? 1 : -1
    const targetV = clamp(v, 0, 1)
    this.hover = { side: signed, target: clamp(amount, 0, 1), amount: this.hover?.amount ?? 0, v: targetV }
  }

  /* ------------------------------- geometry ----------------------------- */

  private pageQuad(side: 1 | -1): PageScreenQuad | null {
    const surface = this.book?.pageSurface(side)
    if (!surface) return null
    surface.mesh.updateWorldMatrix(true, false)
    const rect = this.host.getBoundingClientRect()
    const toScreen = (u: number, v: number) => {
      surface.pointAt(u, v, this.point).applyMatrix4(surface.mesh.matrixWorld).project(this.camera)
      return { x: (this.point.x + 1) / 2 * rect.width, y: (1 - this.point.y) / 2 * rect.height }
    }
    return side === 1
      ? [toScreen(0, 1), toScreen(1, 1), toScreen(1, 0), toScreen(0, 0)]
      : [toScreen(1, 1), toScreen(0, 1), toScreen(0, 0), toScreen(1, 0)]
  }

  getPageScreenQuad(side: 'left' | 'right'): PageScreenQuad {
    this.updateCamera()
    const quad = this.pageQuad(side === 'right' ? 1 : -1)
    if (quad) return quad
    const rect = this.host.getBoundingClientRect()
    const z = this.book?.stackTop(side === 'right' ? 1 : -1) ?? 0.3
    const x0 = side === 'right' ? 0 : -BOOK_WIDTH
    const x1 = side === 'right' ? BOOK_WIDTH : 0
    const y0 = -this.pageHeightWorld / 2
    const y1 = this.pageHeightWorld / 2
    const project = (x: number, y: number) => {
      const p = new THREE.Vector3(x, y, z).project(this.camera)
      return { x: (p.x + 1) / 2 * rect.width, y: (1 - p.y) / 2 * rect.height }
    }
    return [project(x0, y1), project(x1, y1), project(x1, y0), project(x0, y0)]
  }

  getBookScreenRect(): BookScreenRect {
    this.updateCamera()
    // 合上时没有可读的 pageSurface：用书体的世界包围盒投影，封面仍然点得到。
    if (!this.isOpen && this.book) {
      const group = this.book.group
      group.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(group)
      const rect = this.host.getBoundingClientRect()
      const points: Array<{ x: number; y: number }> = []
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            const p = new THREE.Vector3(x, y, z).project(this.camera)
            points.push({ x: (p.x + 1) / 2 * rect.width, y: (1 - p.y) / 2 * rect.height })
          }
        }
      }
      const minX = Math.min(...points.map((p) => p.x))
      const maxX = Math.max(...points.map((p) => p.x))
      const minY = Math.min(...points.map((p) => p.y))
      const maxY = Math.max(...points.map((p) => p.y))
      return { left: minX, top: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
    }
    const right = this.pageQuad(1)
    const left = this.singlePage ? null : this.pageQuad(-1)
    const points = [...(right ?? []), ...(left ?? [])]
    if (!points.length) {
      points.push(...this.getPageScreenQuad('right'))
      if (!this.singlePage) points.push(...this.getPageScreenQuad('left'))
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of points) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    return { left: minX, top: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
  }

  /* ------------------------------- camera ------------------------------- */

  private updateCamera(): void {
    const rect = this.host.getBoundingClientRect()
    const width = Math.max(1, rect.width)
    const height = Math.max(1, rect.height)
    this.camera.aspect = width / height
    if (this.singlePage && this.book) {
      const distance = Math.max(this.book.H / 2, this.book.W / this.camera.aspect / 2) / Math.tan(CAMERA_FOV * Math.PI / 360)
        + this.book.stackTop(1) + 0.006
      this.camera.position.set(this.book.W / 2, 0, distance)
      this.camera.lookAt(this.book.W / 2, 0, 0)
      this.camera.near = Math.max(1, distance * 0.3)
      this.camera.far = distance * 4 + 200
    } else {
      const distance = fitDistance(this.camera.aspect, false, this.pageHeightWorld) / this.zoom
      this.camera.position.set(0, -distance * Math.sin(this.tilt), distance * Math.cos(this.tilt))
      this.camera.lookAt(0, 0, 0)
      this.camera.near = Math.max(1, distance * 0.3)
      this.camera.far = distance * 4 + 200
      const deskScale = distance * 9 + 140
      this.desk.mesh.scale.set(deskScale, deskScale, 1)
      this.desk.mesh.position.set(0, 0, 0)
    }
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()
  }

  resize(): void {
    // 与旧场景同一条测量：舞台在 flex 列里，clientHeight 给出可用高度；
    // 首帧拿不到时退回 960×720，避免 canvas 的默认 2:1 内在比例把布局撑歪。
    const width = Math.max(1, this.host.clientWidth || 960)
    const height = Math.max(1, this.host.clientHeight || 720)
    this.renderer.setSize(width, height, false)
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.updateCamera()
  }

  private loop = (now: number): void => {
    if (this.disposed) return
    this.frame = requestAnimationFrame(this.loop)
    const dt = this.lastFrame ? Math.min(0.05, Math.max(0, (now - this.lastFrame) / 1000)) : 1 / 60
    this.lastFrame = now
    if (this.book) {
      this.book.update(dt)
      this.book.setLightDir(this.viewLightDir.copy(this.lightDir).transformDirection(this.camera.matrixWorldInverse))
    }
    if (this.hover) {
      this.hover.amount += (this.hover.target - this.hover.amount) * (1 - Math.exp(-dt * 12))
      if (this.book && !this.book.busy) this.book.setPeel(this.hover.amount, this.hover.side, this.hover.v)
    }
    this.updateCamera()
    this.renderer.render(this.scene, this.camera)
  }

  /* ------------------------------- compat ------------------------------- */

  /** BookModel 自己管飞页；旧的翻页 run 不再驱动几何。 */
  setFlips(_entries: RealBookSceneFlip[]): void {}

  sampleFlipPage(
    _index: number,
    _u: number,
    _v: number,
    _out: { x: number; y: number; facing: number },
  ): boolean {
    return false
  }

  probeFlipState(): Array<Record<string, number>> {
    return []
  }

  /** 自动化/观感复核：书体是否在飞、当前叶序号与开合状态。 */
  probeBook(): Record<string, number | boolean> {
    return {
      busy: this.book?.busy ?? false,
      settled: this.book?.settledTurned ?? -1,
      turned: this.book?.turned ?? -1,
      open: this.book?.isOpen ?? false,
      fullyOpen: this.book?.fullyOpen ?? false,
      leafCount: this.leafCount(),
      pageCount: this.pageCount,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.disposeBook()
    this.rasterizer.dispose()
    for (const texture of this.solidPapers.values()) texture.dispose()
    this.solidPapers.clear()
    if (this.cover) {
      for (const texture of [this.cover.outer, this.cover.outerBump, this.cover.inner]) texture.dispose()
      this.cover = null
    }
    this.desk.mesh.geometry.dispose()
    ;(this.desk.mesh.material as THREE.Material).dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
