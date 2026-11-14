/**
 * Three.js 真实书籍场景。
 *
 * 造型目标来自 ereader.space/bk_bw60tk：深色书桌上摊着一本厚书，双页贴图来自
 * 分页结果，灯光从左上照下，书脊与页堆有实体厚度。这里不追求把目标站每个
 * shader 逐行搬过来，而是先复刻构图、材质、开合和翻页这些读者能直接感到的部分。
 */

import * as THREE from 'three'
import {
  buildPageTexturePlan,
  drawPageTexture,
  PAGE_TEXTURE_SCALE,
  textureStyleSignature,
  type RealBookTexturePage,
  type RealBookTextureStyle,
} from './realBookTexture'
import {
  BOOK_HEIGHT,
  BOOK_WIDTH,
  BOARD_THICKNESS,
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

export interface RealBookScenePages {
  left: RealBookTexturePage | null
  right: RealBookTexturePage | null
  flipFront: RealBookTexturePage | null
  flipBack: RealBookTexturePage | null
}

export interface RealBookSceneOptions {
  style: RealBookTextureStyle
  pages: RealBookScenePages
  desk: RealBookDesk
  endpaper: RealBookEndpaper
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

function makeCoverTexture(title: string, author: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 736
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
  gradient.addColorStop(0, '#1d3148')
  gradient.addColorStop(1, '#0e1b2b')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = 'rgba(211, 180, 117, 0.5)'
  ctx.lineWidth = 2
  ctx.strokeRect(18, 18, canvas.width - 36, canvas.height - 36)
  ctx.fillStyle = '#e6c987'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = '600 44px "LXGW WenKai", "Noto Serif SC", serif'
  const lines = String(title || '未命名').match(/.{1,8}/g) ?? ['未命名']
  lines.slice(0, 4).forEach((line, index) => {
    ctx.fillText(line, canvas.width / 2, canvas.height * 0.33 + index * 54)
  })
  ctx.fillStyle = 'rgba(230, 201, 135, 0.75)'
  ctx.font = 'italic 22px "EB Garamond", "Noto Serif SC", serif'
  ctx.fillText(author || '真实书籍', canvas.width / 2, canvas.height * 0.78)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

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

function makePageGeometry(): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(BOOK_WIDTH, BOOK_HEIGHT, 40, 26)
  const positions = geometry.attributes.position
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index)
    const u = (x + BOOK_WIDTH / 2) / BOOK_WIDTH
    // 书脊侧压平，外缘微微翘起；幅度很小，只负责让纸面不至于像一块塑料板。
    const z = 0.008 * Math.sin(u * Math.PI) + 0.018 * Math.exp(-(1 - u) * 9)
    positions.setZ(index, z)
  }
  geometry.computeVertexNormals()
  return geometry
}

function setTextureOnMaterial(material: THREE.MeshStandardMaterial, texture: THREE.Texture | null): void {
  if (material.map === texture) return
  material.map = texture
  material.needsUpdate = true
}

export class RealBookWebGLScene {
  private readonly host: HTMLElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 500)
  private readonly bookGroup = new THREE.Group()
  private readonly pageLeft: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  private readonly pageRight: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  private readonly pageGeometry: THREE.PlaneGeometry
  private readonly blockLeft: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial[]>
  private readonly blockRight: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial[]>
  private readonly blockGeometry = new THREE.BoxGeometry(BOOK_WIDTH, BOOK_HEIGHT + 0.04, 1)
  private readonly coverPivot = new THREE.Group()
  private readonly cover: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial[]>
  private readonly backBoard: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial[]>
  private readonly spine: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial[]>
  private readonly flipGroup = new THREE.Group()
  private readonly flipGeometry = new THREE.PlaneGeometry(BOOK_WIDTH, BOOK_HEIGHT, 40, 26)
  private readonly flipRestPositions = new Float32Array(this.flipGeometry.attributes.position.array)
  private readonly flipFront: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  private readonly flipBack: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  private readonly desk: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private readonly coverMaterial: THREE.MeshStandardMaterial
  private readonly innerMaterial: THREE.MeshStandardMaterial
  private readonly pageEdgeMaterial: THREE.MeshStandardMaterial
  private readonly desks = new Map<RealBookDesk, THREE.Texture>()
  private readonly pageTextures = new Map<string, THREE.CanvasTexture>()
  private style: RealBookTextureStyle
  private pages: RealBookScenePages
  private deskId: RealBookDesk
  private endpaperId: RealBookEndpaper
  private tilt = DEFAULT_TILT_RAD
  private zoom = DEFAULT_ZOOM
  private open01 = 1
  private openTarget = 1
  private totalChars = 0
  private pageCount = 0
  private progress = 0
  private flipping = false
  private flipProgress = 0
  private flipDirection: 1 | -1 = 1
  private frame = 0
  private disposed = false
  private resizeObserver: ResizeObserver | null = null
  private readonly clock = new THREE.Clock()

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

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    const maybeNeutral = (THREE as unknown as { NeutralToneMapping?: THREE.ToneMapping }).NeutralToneMapping
    this.renderer.toneMapping = maybeNeutral ?? THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
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

    const coverTexture = makeCoverTexture(options.bookTitle, options.bookAuthor)
    const outerMaterial = new THREE.MeshStandardMaterial({ map: coverTexture, roughness: 0.38, metalness: 0 })
    const coverGeo = new THREE.BoxGeometry(BOOK_WIDTH + 0.15, BOOK_HEIGHT + 0.3, BOARD_THICKNESS)
    this.cover = new THREE.Mesh(coverGeo, [this.coverMaterial, this.coverMaterial, this.coverMaterial, this.coverMaterial, outerMaterial, this.innerMaterial])
    this.cover.position.set((BOOK_WIDTH + 0.15) / 2, 0, BOARD_THICKNESS / 2)
    this.cover.castShadow = true
    this.cover.receiveShadow = true
    this.coverPivot.add(this.cover)
    this.backBoard = new THREE.Mesh(
      new THREE.BoxGeometry(BOOK_WIDTH + 0.15, BOOK_HEIGHT + 0.3, BOARD_THICKNESS),
      [this.coverMaterial, this.coverMaterial, this.coverMaterial, this.coverMaterial, this.innerMaterial, this.coverMaterial],
    )
    this.backBoard.position.set((BOOK_WIDTH + 0.15) / 2, 0, -BOARD_THICKNESS / 2)
    this.backBoard.castShadow = true
    this.backBoard.receiveShadow = true

    this.spine = new THREE.Mesh(
      new THREE.BoxGeometry(0.075, BOOK_HEIGHT + 0.26, 1),
      [this.coverMaterial, this.coverMaterial, this.coverMaterial, this.coverMaterial, this.coverMaterial, this.coverMaterial],
    )
    this.spine.position.set(0, 0, 0.035)

    this.pageGeometry = makePageGeometry()
    this.pageLeft = new THREE.Mesh(this.pageGeometry, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 }))
    this.pageRight = new THREE.Mesh(this.pageGeometry, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 }))
    this.pageLeft.position.set(-BOOK_WIDTH / 2, 0, 0.1)
    this.pageRight.position.set(BOOK_WIDTH / 2, 0, 0.1)
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

    this.flipFront = new THREE.Mesh(this.flipGeometry, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: THREE.FrontSide }))
    this.flipBack = new THREE.Mesh(this.flipGeometry, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: THREE.BackSide }))
    this.flipFront.position.x = BOOK_WIDTH / 2
    this.flipBack.position.x = BOOK_WIDTH / 2
    this.flipFront.receiveShadow = true
    this.flipBack.receiveShadow = true
    this.flipFront.castShadow = true
    this.flipBack.castShadow = true
    this.flipGroup.add(this.flipFront, this.flipBack)
    this.flipGroup.position.z = 0.105
    this.flipGroup.visible = false

    this.bookGroup.add(this.pageLeft, this.pageRight, this.blockLeft, this.blockRight, this.coverPivot, this.backBoard, this.spine, this.flipGroup)
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
    this.shadow.position.z = -0.21
    this.shadow.scale.set(BOOK_WIDTH * 2 + 1.4, BOOK_HEIGHT + 1.2, 1)
    this.scene.add(this.shadow)

    const spot = new THREE.SpotLight('#ffe9cf', 3.3, 0, 0.62, 1, 0)
    spot.position.set(-11, 13, 36)
    spot.target.position.set(0, 0, 0)
    spot.castShadow = true
    spot.shadow.mapSize.set(2048, 2048)
    spot.shadow.bias = -0.0007
    spot.shadow.radius = 11
    spot.shadow.camera.near = 12
    spot.shadow.camera.far = 80
    this.scene.add(spot, spot.target)
    this.scene.add(new THREE.HemisphereLight('#fff3e2', '#20140c', 0.55))
    const fill = new THREE.DirectionalLight('#c8d8ff', 0.18)
    fill.position.set(14, -10, 20)
    this.scene.add(fill)

    this.resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize())
    this.resizeObserver?.observe(host)
    this.resize()
    this.applyPages()
    this.applyProgress()
    this.applyOpen(true)
    this.loop()
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
        texture.colorSpace = THREE.SRGBColorSpace
        texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
        this.desks.set(desk, texture)
        if (this.deskId === desk) {
          this.desk.material.map = texture
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

  private textureFor(page: RealBookTexturePage | null, side: 'left' | 'right'): THREE.CanvasTexture | null {
    if (!page) return null
    const style = { ...this.style, side }
    const key = `${side}:${textureStyleSignature(page, style)}`
    const cached = this.pageTextures.get(key)
    if (cached) return cached
    const plan = buildPageTexturePlan(page, style)
    const canvas = drawPageTexture(plan, style, PAGE_TEXTURE_SCALE)
    if (!canvas) return null
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.generateMipmaps = true
    this.pageTextures.set(key, texture)
    return texture
  }

  setPages(pages: RealBookScenePages, style = this.style): void {
    this.pages = pages
    this.style = style
    this.applyPages()
  }

  private applyPages(): void {
    const apply = (mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>, page: RealBookTexturePage | null, side: 'left' | 'right'): void => {
      const texture = this.textureFor(page, side)
      setTextureOnMaterial(mesh.material, texture)
      // 空白页没有纹理，材质不能保持纯白；否则标题页左侧会亮成一块白纸。
      mesh.material.color.set(texture ? '#ffffff' : this.style.paper)
    }
    apply(this.pageLeft, this.pages.left, 'left')
    apply(this.pageRight, this.pages.right, 'right')
    apply(this.flipFront, this.pages.flipFront, this.flipDirection === -1 ? 'left' : 'right')
    apply(this.flipBack, this.pages.flipBack, this.flipDirection === -1 ? 'right' : 'left')
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
  }

  setOpen(open: boolean, immediate = false): void {
    this.openTarget = open ? 1 : 0
    if (immediate) {
      this.open01 = this.openTarget
      this.applyOpen(true)
    }
  }

  get isOpen(): boolean {
    return this.openTarget > 0.5
  }

  setFlip(flipping: boolean, progress: number, direction: 1 | -1): void {
    this.flipping = flipping
    this.flipProgress = Math.max(0, Math.min(1, progress))
    const changedDirection = direction !== this.flipDirection
    this.flipDirection = direction
    if (changedDirection) this.applyPages()
    this.flipGroup.visible = flipping
  }

  setProgress(progress: number, totalChars: number, pageCount: number): void {
    this.progress = Math.max(0, Math.min(1, progress))
    this.totalChars = Math.max(0, totalChars)
    this.pageCount = Math.max(1, pageCount)
    this.applyProgress()
  }

  private applyProgress(): void {
    const thickness = bookThickness(this.pageCount, this.totalChars, this.progress)
    this.spine.scale.z = Math.max(0.05, thickness.total)
    this.spine.position.z = 0.035 - thickness.total / 2
    this.blockLeft.scale.z = Math.max(0.012, thickness.left)
    this.blockRight.scale.z = Math.max(0.012, thickness.right)
    this.blockLeft.position.z = 0.085 - Math.max(0.012, thickness.left) / 2
    this.blockRight.position.z = 0.085 - Math.max(0.012, thickness.right) / 2
    this.blockLeft.visible = thickness.left > 0.01
    this.blockRight.visible = thickness.right > 0.01
    this.bookGroup.position.x = bookOffsetX(this.open01, thickness.hingeZ)
  }

  private applyOpen(immediate = false): void {
    const open = this.open01
    this.coverPivot.rotation.y = -Math.PI * open
    this.coverPivot.position.z = 0.115 - 0.03 * open
    this.pageLeft.visible = open > 0.02
    this.pageRight.visible = open > 0.02
    this.blockLeft.visible = open > 0.02 && this.blockLeft.scale.z > 0.012
    this.blockRight.visible = this.blockRight.scale.z > 0.012
    const thickness = bookThickness(this.pageCount, this.totalChars, this.progress)
    this.bookGroup.position.x = bookOffsetX(open, thickness.hingeZ)
    this.shadow.material.opacity = 0.46 + 0.34 * open
    if (!immediate) this.bookGroup.position.z = Math.sin(open * Math.PI) * 0.015
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
    const pose = cameraPose(this.tilt, this.zoom, 0, 0, this.camera.aspect)
    this.camera.position.set(...pose.position)
    this.camera.lookAt(...pose.lookAt)
    this.camera.updateMatrixWorld()
  }

  private updateFlip(): void {
    if (!this.flipping) {
      this.flipGroup.visible = false
      this.bookGroup.position.z = 0
      return
    }
    const t = this.flipProgress
    this.flipGroup.visible = true
    this.flipGroup.rotation.y = this.flipDirection === 1 ? -Math.PI * t : -Math.PI * (1 - t)
    this.flipGroup.position.z = 0.105 + Math.sin(Math.PI * t) * 0.15
    const positions = this.flipGeometry.attributes.position
    const rest = this.flipRestPositions
    const wave = Math.sin(Math.PI * t)
    for (let index = 0; index < positions.count; index += 1) {
      const rx = rest[index * 3]!
      const ry = rest[index * 3 + 1]!
      const u = (rx + BOOK_WIDTH / 2) / BOOK_WIDTH
      const edge = this.flipDirection === 1 ? u : 1 - u
      // 连续弧面：书脊侧保持贴近，离脊越远弯得越急；x 向内收一点，翻起时像纸被卷起来。
      const bend = Math.sin(Math.PI * edge) * wave
      positions.setXYZ(index, rx - bend * 0.16 * edge, ry, bend * 0.34)
    }
    positions.needsUpdate = true
    this.flipGeometry.computeVertexNormals()
    this.bookGroup.position.z = Math.sin(Math.PI * t) * 0.02
  }

  getBookScreenRect(): BookScreenRect {
    this.updateCamera()
    const rect = this.host.getBoundingClientRect()
    const open = this.open01
    const points = [
      [-BOOK_WIDTH * open, -BOOK_HEIGHT / 2, 0.1],
      [BOOK_WIDTH, -BOOK_HEIGHT / 2, 0.1],
      [-BOOK_WIDTH * open, BOOK_HEIGHT / 2, 0.1],
      [BOOK_WIDTH, BOOK_HEIGHT / 2, 0.1],
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

  private loop = (): void => {
    if (this.disposed) return
    this.frame = requestAnimationFrame(this.loop)
    const delta = Math.min(0.05, this.clock.getDelta())
    if (Math.abs(this.open01 - this.openTarget) > 0.0005) {
      this.open01 += (this.openTarget - this.open01) * (1 - Math.exp(-delta * 7))
      this.applyOpen()
    } else if (this.open01 !== this.openTarget) {
      this.open01 = this.openTarget
      this.applyOpen(true)
    }
    this.updateCamera()
    this.updateFlip()
    this.shadow.scale.x = BOOK_WIDTH * 2 + 1.4 + Math.sin(this.open01 * Math.PI) * 0.25
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.pageTextures.forEach((texture) => texture.dispose())
    this.pageTextures.clear()
    this.desks.forEach((texture) => texture.dispose())
    this.desks.clear()
    this.scene.traverse((object: THREE.Object3D) => {
      const mesh = object as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose?.()
      disposeMaterial(mesh.material)
    })
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
