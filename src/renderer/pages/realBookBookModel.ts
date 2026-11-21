/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/engine/book.ts，Apache-2.0。已修改：文件改名；CoverSet/衬纸色板改从
 * spbf 的模块取，其余书体、书垛、开合、飞页与落定逻辑保持上游实现。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { CaseBinding } from './realBookCaseBinding'
import { GutterFold } from './realBookGutterFold'
import { LeafSim, curlReach, type SimEnv } from './realBookLeafSim'
import { GRID_V, LeafMesh } from './realBookLeafMesh'
import { SH_COLS, SH_ROWS, SH_SLOTS, shadowRig } from './realBookPaperMaterial'
import { StackBlock } from './realBookStack'
import type { CoverSet } from './realBookCover'
import { BOARD_THICKNESS, BOOK_HEIGHT, BOOK_WIDTH, COVER_OVERHANG, ENDPAPER_PALETTES, type RealBookEndpaper } from './realBookWebGLModel'
import { PHONE_CURL_TRAVEL, phoneTurnCommits } from './realBookPhoneCurl'

export const BOOK = { W: BOOK_WIDTH, H: BOOK_HEIGHT, OH: COVER_OVERHANG, TB: BOARD_THICKNESS }

interface QuickTurn {
  startAngle: number
  startAge: number
  duration: number
  handoff: boolean
}

interface Flyer {
  k: number
  sim: LeafSim
  mesh: LeafMesh
  mode: 'drag' | 'auto' | 'free'
  quick?: QuickTurn
  landing?: { side: 1 | -1; height: number; x: Float32Array; z: Float32Array }
  phi: number
  phiVel: number
  targetPhi: number
  fromSide: 1 | -1
  u: number
  v: number
  held: boolean
  pointerPhi: number
  pointerV: number
  grabV: number
  flex: number
  flexVel: number
  peel: number
  peelV: number
  delay: number
  age: number
  rank: number
  moved: boolean
  phoneRelease?: { from: number; time: number; duration: number }
}

export interface BookOptions {
  singlePage?: boolean
  pageHeight?: number
  leafCount: number
  turned: number
  open: boolean
  getTexture: (page: number) => THREE.Texture
  cover: CoverSet
  endpaper?: RealBookEndpaper
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const smooth = (x: number) => x * x * (3 - 2 * x)
// Moving and resting leaves sample the curved gutter at different x positions. Keep their linear
// mesh segments separated as well as their vertices, especially when a thick book has very thin leaves.
const TURN_CLEARANCE = 0.004
const QUICK_TURN_SECONDS = 0.4
const HANDOFF_SECONDS = 0.18
const quickProgress = (age: number, quick: QuickTurn) => (age - quick.startAge) / quick.duration
const quickLandingAmount = (f: Flyer) => {
  if (!f.quick) return 0
  return smooth(clamp((quickProgress(f.age, f.quick) - 0.6) / 0.3, 0, 1))
}

export class BookModel {
  readonly group = new THREE.Group()
  readonly W = BOOK.W
  readonly H: number
  readonly singlePage: boolean
  readonly OH = BOOK.OH
  readonly tb = BOOK.TB
  readonly N: number
  readonly t: number
  readonly zh: number

  private rightGroup = new THREE.Group()
  private leftPivot = new THREE.Group()
  private leftContent = new THREE.Group()
  private blockR: StackBlock
  private blockL: StackBlock
  private binding: CaseBinding
  private frontBoard: THREE.Mesh
  private backBoard: THREE.Mesh
  private innerMat: THREE.MeshStandardMaterial

  private st: Uint8Array
  private nL: number
  private nR: number
  private flyers: Flyer[] = []
  private pool: LeafMesh[] = []
  private used = new Map<number, LeafMesh>()
  private tmpSim: LeafSim
  private getTexture: (page: number) => THREE.Texture

  psi: number
  psiTarget: number
  private psiVel = 0
  private psiHeld = false
  private restDirty = true
  private lastPsi = -1
  private acc = 0
  private lightDirV = new THREE.Vector3(0, 0, 1)
  private peelTarget = 0
  private peel = 0
  private peelSide: 1 | -1 = 1
  private peelV = 0.5
  private peelTargetV = 0.5
  onSettle?: (turned: number, open: boolean) => void
  private wasStatic = true

  constructor(opts: BookOptions) {
    this.H = opts.pageHeight ?? BOOK.H
    this.singlePage = opts.singlePage ?? false
    const { W, H, OH, tb } = this
    this.N = opts.leafCount
    this.getTexture = opts.getTexture
    const block = clamp(this.N * 0.0105, 0.14, 1.15)
    this.t = block / this.N
    this.zh = tb + block / 2
    this.st = new Uint8Array(this.N)
    this.nL = clamp(opts.turned, 0, this.N)
    this.nR = this.N - this.nL
    for (let k = 0; k < this.nL; k++) this.st[k] = 1
    this.psi = this.psiTarget = opts.open ? Math.PI : 0
    this.tmpSim = new LeafSim(W, H)

    const Wb = W + OH
    const Hb = H + OH * 2
    const outerMat = new THREE.MeshStandardMaterial({
      map: opts.cover.outer,
      bumpMap: opts.cover.outerBump,
      bumpScale: opts.cover.glossy ? 0.4 : 2.2,
      roughness: opts.cover.glossy ? 0.38 : 0.62,
      metalness: 0,
    })
    this.innerMat = new THREE.MeshStandardMaterial({
      map: opts.cover.inner,
      color: ENDPAPER_PALETTES[opts.endpaper ?? 'ivory'].swatch,
      roughness: 0.96,
    })
    this.binding = new CaseBinding(H, OH, tb, block, opts.cover.cloth, this.innerMat)
    const clothMat = this.binding.cloth
    // mirror inner texture so it reads correctly on the left board
    // Leave room for a flexible cloth joint; the paper keeps its existing hinge coordinates.
    const boardWidth = Wb - this.binding.joint
    const boardGeo = new RoundedBoxGeometry(boardWidth, Hb, tb, 2, 0.018)
    // order: +x, -x, +y, -y, +z (top / inner), -z (bottom / outer)
    this.frontBoard = new THREE.Mesh(boardGeo, [clothMat, clothMat, clothMat, clothMat, this.innerMat, outerMat])
    this.backBoard = new THREE.Mesh(boardGeo, [clothMat, clothMat, clothMat, clothMat, this.innerMat, clothMat])
    for (const m of [this.frontBoard, this.backBoard]) {
      m.castShadow = true
      m.receiveShadow = true
    }
    this.frontBoard.position.set(-(Wb + this.binding.joint) / 2, 0, tb / 2)
    this.backBoard.position.set((Wb + this.binding.joint) / 2, 0, tb / 2)
    // fix UV orientation of the outer cover (seen from above after the board is flipped)
    this.fixBoardUV(boardGeo, boardWidth)

    this.blockR = new StackBlock(1, W, H, this.t)
    this.blockL = new StackBlock(-1, W, H, this.t)

    this.rightGroup.add(this.backBoard, this.blockR.mesh)
    this.leftContent.add(this.frontBoard, this.blockL.mesh)
    this.leftContent.position.z = -this.zh
    this.leftPivot.position.set(0, 0, this.zh)
    this.leftPivot.add(this.leftContent)

    this.group.add(this.rightGroup, this.leftPivot, this.binding.group)
    if (this.singlePage) {
      this.frontBoard.visible = this.backBoard.visible = this.binding.group.visible = false
    }
    this.applyPsi(true)
  }

  /** Both inner faces and their exposed margins share this material; no texture allocation on a tint change. */
  setEndpaper(id: RealBookEndpaper) {
    this.innerMat.color.set(ENDPAPER_PALETTES[id].swatch)
  }

  private fixBoardUV(geo: THREE.BufferGeometry, width: number) {
    // The BoxGeometry -z face has u running toward -x, v running toward -y... we want, after flipping the
    // board about the spine, an upright, unmirrored image. Rewrite the UVs of that face explicitly.
    const uv = geo.attributes.uv as THREE.BufferAttribute
    const pos = geo.attributes.position as THREE.BufferAttribute
    const nor = geo.attributes.normal as THREE.BufferAttribute
    const Hb = this.H + this.OH * 2
    for (let i = 0; i < uv.count; i++) {
      const nz = nor.getZ(i)
      if (Math.abs(nz) > 0.5) {
        const x = pos.getX(i)
        const y = pos.getY(i)
        const du = (x + width / 2) / width // 0 at outer edge, 1 at spine edge
        const dv = (y + Hb / 2) / Hb
        if (nz < 0) uv.setXY(i, 1 - du, dv)
        else uv.setXY(i, du, dv)
      }
    }
    uv.needsUpdate = true
  }

  /* -------------------------------- geometry -------------------------------- */

  get open01() {
    return this.psi / Math.PI
  }

  dip(h: number, ax: number) {
    const f = this.open01
    const dm = f * f * 0.62 * Math.max(0, h - this.tb - 0.01)
    return dm * Math.exp(-ax / 0.95)
  }

  profile(h: number, ax: number) {
    // Phone pages share a fixed reading plane; their height must not depend on book length.
    if (this.singlePage) return this.tb
    return h - this.dip(h, ax)
  }

  private flyerRank(f: Flyer) {
    return f.rank * 0.012
  }

  private envFor(f: Flyer): SimEnv {
    const hR = this.tb + this.t * (this.nR + 1) + this.flyerRank(f)
    const hL = this.tb + this.t * (this.nL + 1) + this.flyerRank(f)
    return {
      gravity: 85,
      rootZ: 0,
      surface: (x) => (x >= 0 ? this.profile(hR, x) : this.profile(hL, -x)) + TURN_CLEARANCE,
    }
  }

  private rootZ(f: Flyer, p: number) {
    const hR = this.tb + this.t * (this.nR + 1) + this.flyerRank(f)
    const hL = this.tb + this.t * (this.nL + 1) + this.flyerRank(f)
    const zr = this.profile(hR, 0) + 0.006 + TURN_CLEARANCE
    const zl = this.profile(hL, 0) + 0.006 + TURN_CLEARANCE
    // Keep the hinge above the taller stack until the leaf has crossed the spine. Blending down
    // immediately buries the pinned edge in resting pages, exposing vertical strips through the leaf.
    const blend = zr > zl ? (p - 0.5) * 2 : p * 2
    return zr + (zl - zr) * smooth(clamp(blend, 0, 1))
  }

  /* -------------------------------- leaves -------------------------------- */

  private acquire(k: number): LeafMesh {
    let lm = this.used.get(k)
    if (lm) return lm
    lm = this.pool.pop() || new LeafMesh(this.W, this.H)
    lm.mesh.visible = true
    lm.key = k
    lm.uniforms.uLightDirV.value.copy(this.lightDirV)
    // spbf 的页面纹理已经把纸色和中缝阴影画进去了；不再让 shader 叠一层中缝压暗。
    lm.uniforms.uGutter.value = 0
    if (this.singlePage) { lm.uniforms.uShowThrough.value = 0; lm.uniforms.uPhone.value = 1 }
    lm.setTextures(this.getTexture(2 * k), this.getTexture(2 * k + 1))
    this.used.set(k, lm)
    return lm
  }

  refreshTextures() {
    for (const [k, lm] of this.used) lm.setTextures(this.getTexture(2 * k), this.getTexture(2 * k + 1))
  }

  private release(k: number) {
    const lm = this.used.get(k)
    if (!lm) return
    lm.mesh.visible = false
    lm.mesh.parent?.remove(lm.mesh)
    this.used.delete(k)
    this.pool.push(lm)
  }

  private restList(side: 1 | -1, count: number) {
    const out: number[] = []
    if (side === 1) {
      for (let k = 0; k < this.N && out.length < count; k++) if (this.st[k] === 0) out.push(k)
    } else {
      for (let k = this.N - 1; k >= 0 && out.length < count; k--) if (this.st[k] === 1) out.push(k)
    }
    return out
  }

  private rebuildRest() {
    const fold = this.psi > 0 && this.psi < Math.PI ? new GutterFold(Math.PI - this.psi, this.zh) : undefined
    const needed = new Set<number>()
    // A phone only exposes the top right sheet and any flyer. Compressed stacks can
    // quantize to the same GPU depth, letting the second/third sheet overwrite its ink.
    const R = this.restList(1, this.singlePage ? 1 : 3)
    const L = this.singlePage ? [] : this.restList(-1, 3)
    R.forEach((k) => needed.add(k))
    L.forEach((k) => needed.add(k))
    for (const f of this.flyers) needed.add(f.k)
    for (const k of [...this.used.keys()]) if (!needed.has(k)) this.release(k)

    const place = (list: number[], side: 1 | -1) => {
      const stackN = side === 1 ? this.nR : this.nL
      list.forEach((k, rank) => {
        const lm = this.acquire(k)
        ;(side === 1 ? this.rightGroup : this.leftContent).add(lm.mesh)
        const h = this.tb + this.t * (stackN - rank)
        const env: SimEnv = { gravity: 0, rootZ: 0, surface: (x) => this.profile(h, Math.abs(x)) }
        this.tmpSim.rest(side, env, 0.006)
        // replicate row 0 across rows (resting leaves are straight along y)
        const s = this.tmpSim
        for (let r = 1; r < s.R; r++) {
          for (let i = 0; i < s.N; i++) {
            s.x[r * s.N + i] = s.x[i]
            s.z[r * s.N + i] = s.z[i]
          }
        }
        const peelHere = rank === 0 && side === this.peelSide ? this.peel : 0
        lm.write(s, peelHere, this.peelV, side === -1 ? fold : undefined)
      })
    }
    place(R, 1)
    place(L, -1)

    // fractional contribution of leaves that are in flight keeps thickness continuous
    let fly = 0
    for (const f of this.flyers) fly += this.singlePage ? f.phi / Math.PI : f.sim.progress()
    const flyCount = this.flyers.length
    const hR = this.tb + this.t * (this.nR + (flyCount - fly))
    const hL = this.tb + this.t * (this.nL + fly)
    this.blockR.update(this.tb, (ax) => this.profile(hR, ax) - 0.001)
    this.blockL.update(this.tb, (ax) => this.profile(hL, ax) - 0.001, fold)
    this.blockR.mesh.visible = !this.singlePage && hR > this.tb + 1e-6
    this.blockL.mesh.visible = !this.singlePage && hL > this.tb + 1e-6
    this.binding.update(Math.PI - this.psi, this.profile(hR, this.binding.joint), this.profile(hL, this.binding.joint))
    this.restDirty = false
  }

  /* ------------------------------- open / close ------------------------------ */

  private applyPsi(force = false) {
    if (!force && Math.abs(this.psi - this.lastPsi) < 1e-5) return
    this.lastPsi = this.psi
    const theta = Math.PI - this.psi
    this.leftPivot.rotation.y = theta
    this.group.position.x = -(this.W / 2 + this.zh * 0.1) * (1 - this.open01) * 1
    this.restDirty = true
  }

  get isOpen() {
    return this.psiTarget > Math.PI * 0.5
  }

  get fullyOpen() {
    return this.psi > Math.PI - 0.01
  }

  setOpen(open: boolean) {
    if (this.flyers.length) return
    this.psiTarget = open ? Math.PI : 0
  }

  /** Seek the existing binding geometry without running the interactive cover spring. */
  seekOpening(fraction: number) {
    this.psi = this.psiTarget = clamp(fraction, 0, 1) * Math.PI
    this.psiVel = 0
    this.psiHeld = false
    this.applyPsi()
  }

  /** hinge angle for the cover tip at book-local x (cover dragging) */
  coverAngleForX(x: number) {
    const Wb = this.W + this.OH
    const theta = Math.acos(clamp(-x / Wb, -1, 1))
    return Math.PI - theta
  }

  beginCoverDrag() {
    this.psiHeld = true
    this.psiTarget = this.psi
  }

  moveCoverDrag(x: number) {
    this.psiTarget = this.coverAngleForX(x)
  }

  endCoverDrag(vx: number, moved: boolean) {
    this.psiHeld = false
    const openish = this.psiTarget > Math.PI * 0.5 || vx < -2.5
    const closeish = vx > 2.5
    if (!moved) this.psiTarget = this.psi > Math.PI * 0.5 ? 0 : Math.PI
    else this.psiTarget = closeish ? 0 : openish ? Math.PI : 0
  }

  /* ------------------------------- turning ------------------------------- */

  get turned() {
    let c = this.nL
    for (const f of this.flyers) if (f.targetPhi > Math.PI / 2) c++
    return c
  }

  get settledTurned() {
    return this.nL
  }

  /**
   * 目标叶序号：把在飞的纸按 targetPhi 算进去。
   *
   * spbf 的页表会因字体分片晚到而重排，重排时必须知道「这次翻页原本要去哪」，
   * 否则正在飞的纸会被按旧的 settledTurned 重建，翻页看起来被吞掉。
   */
  get targetTurned() {
    let count = this.nL
    for (const f of this.flyers) count += f.targetPhi > Math.PI / 2 ? 1 : -1
    return Math.max(0, Math.min(this.N, count))
  }

  get hasHeldLeaf() {
    return this.flyers.some((f) => f.held)
  }

  get coverHeld() {
    return this.psiHeld
  }

  /** a cover drag that was never completed: settle on the nearest rest angle instead of hovering half-open */
  abortCoverDrag() {
    if (!this.psiHeld) return
    this.psiHeld = false
    this.psiTarget = this.psiTarget > Math.PI * 0.5 ? Math.PI : 0
  }

  get busy() {
    return this.flyers.length > 0 || Math.abs(this.psi - this.psiTarget) > 0.002 || this.psiHeld
  }

  get isStatic() {
    return !this.busy && Math.abs(this.peel - this.peelTarget) < 0.002
      && (this.peel === 0 || Math.abs(this.peelV - this.peelTargetV) < 0.001)
  }

  private spawnFlyer(k: number, fromSide: 1 | -1): Flyer {
    const mesh = this.acquire(k)
    this.group.add(mesh.mesh)
    const sim = new LeafSim(this.W, this.H)
    const f: Flyer = {
      k,
      sim,
      mesh,
      mode: 'auto',
      phi: fromSide === 1 ? 0 : Math.PI,
      phiVel: 0,
      targetPhi: fromSide === 1 ? Math.PI : 0,
      fromSide,
      u: 0.9,
      v: 0.5,
      held: false,
      pointerPhi: 0,
      pointerV: 0.5,
      grabV: 0.5,
      flex: 0,
      flexVel: 0,
      peel: 0,
      peelV: this.peelV,
      delay: 0,
      age: 0,
      rank: this.flyers.length,
      moved: false,
    }
    // remove from resting stacks
    if (fromSide === 1) {
      this.st[k] = 2
      this.nR--
    } else {
      this.st[k] = 2
      this.nL--
    }
    this.flyers.push(f)
    // The hover/flutter peel belongs to the leaf that was on top of the stack, which is exactly the leaf now in flight.
    // Hand it over and clear it here; otherwise rebuildRest keeps applying it to the leaf underneath, whose lifted
    // edge pokes through the flyer for the first frames (the "page underneath flashes on mouse-down" bug).
    if (this.peelSide === fromSide) {
      if (this.peel > 0) {
        f.peel = this.peel
        f.peelV = this.peelV
      }
      this.peel = 0
      this.peelTarget = 0
    }
    const env = this.envFor(f)
    const stackN = fromSide === 1 ? this.nR : this.nL
    const h = this.tb + this.t * (stackN + 1) + this.flyerRank(f)
    // Inherit the departing stack even at x=0, where the two-sided collision surface
    // chooses the right stack. Otherwise a left leaf starts from the wrong hinge height.
    sim.rest(fromSide, { ...env, surface: (x) => this.profile(h, Math.abs(x)) + TURN_CLEARANCE }, 0.006)
    if (this.singlePage) mesh.writePhoneCurl(f.phi / Math.PI, f.grabV, f.v, this.tb + .006 + TURN_CLEARANCE)
    else mesh.write(sim, f.peel, f.peelV)
    this.restDirty = true
    this.rebuildRest()
    return f
  }

  /** Begin a physical drag on the top leaf of a side. */
  beginDrag(side: 1 | -1, u: number, v: number): boolean {
    if (!this.fullyOpen || this.psiTarget < Math.PI - 0.01) return false
    if (!this.canStartTurn(side)) return false
    const list = this.restList(side, 1)
    if (!list.length) return false
    this.setPeel(0, side, 0.5)
    const f = this.spawnFlyer(list[0], side)
    f.mode = 'drag'
    f.held = true
    f.u = clamp(u, 0.55, 0.97)
    // fingers pinch the middle of the fore-edge unless the grab clearly started at a corner
    const k = smooth(clamp((Math.abs(v - 0.5) - 0.2) / 0.2, 0, 1))
    f.grabV = clamp(0.5 + (v - 0.5) * (0.35 + 0.65 * k), 0.04, 0.96)
    if (this.singlePage) f.grabV = clamp(v, .04, .96)
    f.v = f.grabV
    f.pointerV = f.grabV
    f.pointerPhi = f.phi
    return true
  }

  moveDrag(x: number, y: number) {
    const f = this.flyers.find((q) => q.held)
    if (!f) return
    const d = this.W * f.u
    // solve phi from pointer x: the held point sits at the end of the curled arc, which is monotone in phi
    let lo = 0
    let hi = Math.PI
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2
      if (curlReach(mid, f.fromSide, f.v, f.u, this.W).x > x) lo = mid
      else hi = mid
    }
    const phi = (lo + hi) / 2
    // The exact "tip follows the pointer" angle is hypersensitive near the page plane (a few pixels lift the sheet
    // far), so blend it with a linear travel mapping; both agree at rest, at the vertical and when fully turned.
    const lin = Math.PI * clamp((d - x) / (2 * d), 0, 1)
    f.pointerPhi = 0.5 * phi + 0.5 * lin
    f.pointerV = clamp(f.grabV + 0.3 * ((y + this.H / 2) / this.H - f.grabV), 0.04, 0.96)
    f.moved = true
  }

  movePhoneDrag(dx: number, pointerV: number) {
    const f = this.flyers.find(q => q.held)
    if (!f || !this.singlePage) return
    const start = f.fromSide === 1 ? 0 : Math.PI
    f.pointerPhi = clamp(start - dx / PHONE_CURL_TRAVEL * Math.PI, 0, Math.PI)
    f.pointerV = clamp(pointerV, 0, 1)
    f.moved = true
  }

  endDrag(vx: number, moved: boolean, motion: 'natural' | 'quick' = 'natural') {
    const f = this.flyers.find((q) => q.held)
    if (!f) return
    f.held = false
    f.mode = 'auto'
    // choose destination from position and flick
    const forward = f.fromSide === 1
    const progress = forward ? f.pointerPhi : Math.PI - f.pointerPhi
    if (this.singlePage) {
      f.phi = f.pointerPhi; f.v = f.pointerV
      const commit = phoneTurnCommits(progress / Math.PI * PHONE_CURL_TRAVEL, -vx * f.fromSide / 12)
      f.targetPhi = commit ? (forward ? Math.PI : 0) : forward ? 0 : Math.PI
      return
    }
    let toOther = progress > Math.PI * 0.46
    if (!moved) toOther = true
    else {
      const flick = forward ? vx < -6 : vx > 6
      const back = forward ? vx > 9 : vx < -9
      if (flick && progress > 0.12) toOther = true
      if (back) toOther = false
    }
    f.targetPhi = toOther ? (forward ? Math.PI : 0) : forward ? 0 : Math.PI
    if (!moved && motion === 'quick') this.startQuickTurn(f)
  }

  cancelDrag() {
    const f = this.flyers.find(q => q.held)
    if (!f) return
    f.held = false
    f.mode = 'auto'
    f.targetPhi = f.fromSide === 1 ? 0 : Math.PI
  }

  private startQuickTurn(f: Flyer, handoff = false) {
    f.mode = 'auto'
    f.quick = {
      startAngle: f.phi,
      startAge: f.age,
      duration: handoff ? HANDOFF_SECONDS : QUICK_TURN_SECONDS,
      handoff,
    }
  }

  /** Turn n leaves in direction (+1 forward, -1 backward), with a short stagger. */
  turn(dir: 1 | -1, count = 1, motion: 'natural' | 'quick' = 'natural'): number {
    if (!this.fullyOpen) return 0
    // Keyboard input should not wait for the natural spring's long settling tail.
    // Finish released mouse/toolbar leaves from their current angle, then admit
    // the queued key. Keep the ordering barrier until they land (also on reversal).
    if (motion === 'quick' && this.flyers.some(f => !f.quick || f.quick.handoff)) {
      if (!this.hasHeldLeaf && !this.psiHeld) {
        for (const f of this.flyers) {
          if (f.quick) continue
          this.startQuickTurn(f, true)
          f.delay = 0
        }
      }
      return 0
    }
    let done = 0
    for (let i = 0; i < count; i++) {
      const side: 1 | -1 = dir === 1 ? 1 : -1
      if (!this.canStartTurn(side)) break
      const list = this.restList(side, 1)
      if (!list.length) break
      const f = this.spawnFlyer(list[0], side)
      if (motion === 'quick') this.startQuickTurn(f)
      f.delay = i * 0.07
      f.u = 0.95
      f.v = 0.5
      f.sim.pin = null
      done++
    }
    return done
  }

  /** All entry points share the same ordering rule: sheets in flight cannot cross each other. */
  private canStartTurn(side: 1 | -1) {
    if (this.singlePage && this.flyers.length) return false
    if (this.singlePage && side === 1 && this.nR <= 1) return false
    return !this.hasHeldLeaf && !this.psiHeld && this.flyers.length < 6 &&
      this.flyers.every((f) => f.fromSide === side && f.targetPhi === (side === 1 ? Math.PI : 0))
  }

  /** instantly rebase the book so that `turned` leaves lie on the left (no animation). */
  jumpTo(turned: number) {
    for (const f of this.flyers) this.release(f.k)
    this.flyers = []
    const T = clamp(turned, 0, this.singlePage ? this.N - 1 : this.N)
    for (let k = 0; k < this.N; k++) this.st[k] = k < T ? 1 : 0
    this.nL = T
    this.nR = this.N - T
    this.restDirty = true
  }

  setPeel(amount: number, side: 1 | -1, v: number) {
    this.peelTarget = amount
    if (amount > 0) {
      const targetV = clamp(v, 0, 1)
      // A fresh hover starts under the pointer; an existing lift follows it smoothly.
      if (this.peelSide !== side || this.peel === 0) {
        this.peelV = targetV
        this.restDirty = true
      }
      this.peelSide = side
      this.peelTargetV = targetV
    }
  }

  get peelAmount() {
    return this.peelTarget
  }

  setLightDir(v: THREE.Vector3) {
    this.lightDirV.copy(v)
    for (const lm of [...this.used.values(), ...this.pool]) lm.uniforms.uLightDirV.value.copy(v)
  }

  /* -------------------------------- stepping ------------------------------- */

  update(dt: number) {
    dt = Math.min(dt, 1 / 20)

    // cover hinge: critically damped spring
    if (Math.abs(this.psi - this.psiTarget) > 1e-4 || Math.abs(this.psiVel) > 1e-3) {
      const k = this.psiHeld ? 220 : 46
      const c = this.psiHeld ? 28 : 9.5
      const sub = 4
      const h = dt / sub
      for (let i = 0; i < sub; i++) {
        this.psiVel += (k * (this.psiTarget - this.psi) - c * this.psiVel) * h
        this.psi = clamp(this.psi + this.psiVel * h, 0, Math.PI)
        if (this.psi === 0 || this.psi === Math.PI) this.psiVel *= 0.3
      }
      if (Math.abs(this.psi - this.psiTarget) < 1e-3 && Math.abs(this.psiVel) < 0.01) {
        this.psi = this.psiTarget
        this.psiVel = 0
      }
      this.applyPsi()
    }

    // hover peel easing
    const wasPeel = this.peel
    const wasPeelV = this.peelV
    this.peel += (this.peelTarget - this.peel) * (1 - Math.exp(-dt * 12))
    if (Math.abs(this.peel - this.peelTarget) < 0.002) this.peel = this.peelTarget
    this.peelV += (this.peelTargetV - this.peelV) * (1 - Math.exp(-dt * 18))
    if (Math.abs(this.peelV - this.peelTargetV) < 0.001) this.peelV = this.peelTargetV
    if ((this.peel !== wasPeel || this.peelV !== wasPeelV) && this.flyers.length === 0) this.restDirty = true

    // leaves
    if (this.flyers.length) {
      if (this.singlePage) this.stepPhoneFlyers(dt)
      else {
        this.acc += dt
        const h = 1 / 240
        let steps = 0
        while (this.acc >= h && steps < 12) {
          this.stepFlyers(h)
          this.acc -= h
          steps++
        }
        if (steps === 12) this.acc = 0
      }
      this.finishFlyers()
      for (const f of this.flyers) {
        if (this.singlePage) {
          f.mesh.writePhoneCurl(f.phi / Math.PI, f.grabV, f.v, this.tb + .006 + TURN_CLEARANCE)
          continue
        }
        if (f.peel > 0 && (!f.held || f.moved)) {
          f.peel *= Math.exp(-dt * 9)
          if (f.peel < 0.003) f.peel = 0
        }
        // the carried peel is a local lift of the flat leaf, so it fades as soon as the leaf leaves the stack
        const q = f.fromSide === 1 ? f.phi : Math.PI - f.phi
        const gate = f.peel > 0 ? clamp(1 - q / 0.5, 0, 1) : 0
        f.mesh.write(f.sim, f.peel * gate, f.peelV)
      }
      this.restDirty = true
    }
    if (this.restDirty) this.rebuildRest()

    this.syncShadowRig()

    const stat = this.isStatic
    if (stat && !this.wasStatic) this.onSettle?.(this.nL, this.psi > Math.PI * 0.5)
    this.wasStatic = stat
  }

  private shadowActive = false

  /** publish the sections of the (up to two) most upright flying leaves for the soft page shadow in the paper shader */
  private syncShadowRig() {
    const fl = this.flyers
    if (!fl.length) {
      if (this.shadowActive) {
        this.shadowActive = false
        shadowRig.uShN.value = 0
        shadowRig.uShOpacity.value.fill(0)
        for (const lm of this.used.values()) {
          lm.uniforms.uShRecv.value = 0
          lm.uniforms.uShSelf.value = -1
        }
      }
      return
    }
    this.shadowActive = true
    const tex = shadowRig.uShTex.value!
    const data = tex.image.data as Float32Array
    const pick = fl
      .filter((f) => f.delay <= 0)
      .sort((a, b) => Math.abs(a.phi - Math.PI / 2) - Math.abs(b.phi - Math.PI / 2))
      .slice(0, SH_SLOTS)
    const rows = [0, GRID_V >> 1, GRID_V - 1]
    shadowRig.uShOpacity.value.fill(0)
    pick.forEach((f, s) => {
      // Fade each caster with its own landing, before its slot is removed.
      shadowRig.uShOpacity.value[s] = 1 - quickLandingAmount(f)
      f.mesh.mesh.updateWorldMatrix(true, false)
      rows.forEach((j, r) => f.mesh.exportRow(data, (s * SH_ROWS + r) * SH_COLS, SH_COLS, j, f.mesh.mesh.matrixWorld))
    })
    tex.needsUpdate = true
    shadowRig.uShN.value = pick.length
    const topR = this.restList(1, 1)[0]
    const topL = this.restList(-1, 1)[0]
    const flying = new Map<number, number>()
    pick.forEach((f, s) => flying.set(f.k, s))
    for (const [k, lm] of this.used) {
      const slot = flying.get(k)
      lm.uniforms.uShSelf.value = slot ?? -1
      lm.uniforms.uShRecv.value = k === topR || k === topL || fl.some((f) => f.k === k) ? 1 : 0
    }
  }

  private stepFlyers(h: number) {
    for (const f of this.flyers) {
      if (f.delay > 0) {
        f.delay -= h
        continue
      }
      f.age += h
      const env = this.envFor(f)
      const p = f.sim.progress()
      const rootZ = this.rootZ(f, f.fromSide === 1 ? p : p)
      env.rootZ = rootZ
      if (f.mode === 'drag') {
        const a = Math.min(1, h * 24)
        const prev = f.phi
        f.phi += (f.pointerPhi - f.phi) * a
        f.phiVel = (f.phi - prev) / h
        f.v += (f.pointerV - f.v) * Math.min(1, h * 14)
      } else if (f.mode === 'auto' && f.quick) {
        // Discrete turns follow a short fixed curve from the leaf's current angle.
        const { startAngle: start, duration } = f.quick
        const t = clamp(quickProgress(f.age, f.quick), 0, 1)
        const travel = f.targetPhi - start
        f.phi = start + travel * (1 - (1 - t) ** 3)
        f.phiVel = travel * 3 * (1 - t) ** 2 / duration
      } else if (f.mode === 'auto') {
        const k = 22
        // firmer damping on the last stretch so the leaf glides down instead of dropping
        const c = 6.4 + 3.4 * (1 - clamp(Math.abs(f.targetPhi - f.phi) / 1.1, 0, 1))
        f.phiVel += (k * (f.targetPhi - f.phi) - c * f.phiVel) * h
        f.phi += f.phiVel * h
        if (Math.abs(f.phi - f.targetPhi) < 0.07 && Math.abs(f.phiVel) < 1) {
          f.mode = 'free'
          f.sim.pin = null
        }
      }
      if (f.mode !== 'free') {
        // paper flex: the sheet bows further the faster it is carried, and rings once when it stops
        const travel = f.phiVel * f.fromSide
        const flexTarget = clamp(travel * 0.035, -0.12, 0.26)
        const wf = 22
        f.flexVel += (wf * wf * (flexTarget - f.flex) - 2 * 0.4 * wf * f.flexVel) * h
        f.flex += f.flexVel * h
        const phi = clamp(f.phi, -0.02, Math.PI + 0.02)
        const d = this.W * f.u * (1 - 0.07 * Math.sin(phi))
        f.sim.pin = {
          u: f.u,
          v: f.v,
          sigma: f.mode === 'drag' ? 0.62 : 0.8,
          x: d * Math.cos(phi),
          z: rootZ + d * Math.sin(phi),
          strength: f.mode === 'drag' ? 0.8 : 0.62,
          shape: { phi, fromSide: f.fromSide, flex: f.quick ? f.flex * Math.sin(phi) : f.flex },
        }
      }
      f.sim.step(h, env, rootZ)
      if (f.quick) this.blendQuickLanding(f)
    }
  }

  private stepPhoneFlyers(dt: number) {
    for (const f of this.flyers) {
      f.age += dt
      if (f.held) {
        // Direct manipulation: no spring lag, overshoot, or geometry changes while held still.
        f.phi = f.pointerPhi
        f.v = f.pointerV
      } else {
        f.phoneRelease ??= { from: f.phi, time: 0, duration: .18 + .12 * Math.abs(f.targetPhi - f.phi) / Math.PI }
        const release = f.phoneRelease
        release.time += dt
        const t = clamp(release.time / release.duration, 0, 1)
        f.phi = release.from + (f.targetPhi - release.from) * (1 - (1 - t) ** 3)
      }
    }
  }

  /** Match the destination gutter before replacing a flying leaf with resting ink. */
  private blendQuickLanding(f: Flyer) {
    const blend = quickLandingAmount(f)
    if (!blend) return
    f.peel *= 1 - blend
    const side = f.targetPhi > Math.PI / 2 ? -1 : 1
    // Earlier leaves land underneath this one, including simultaneous key presses.
    const incoming = this.flyers.filter(q => q.targetPhi === f.targetPhi && (side === -1 ? q.k <= f.k : q.k >= f.k)).length
    const height = this.tb + this.t * ((side === -1 ? this.nL : this.nR) + incoming)
    if (f.landing?.side !== side || f.landing.height !== height) {
      this.tmpSim.rest(side, { gravity: 0, rootZ: 0, surface: x => this.profile(height, Math.abs(x)) }, 0.006)
      f.landing = { side, height, x: this.tmpSim.x.slice(0, this.tmpSim.N), z: this.tmpSim.z.slice(0, this.tmpSim.N) }
    }
    const { sim, landing } = f
    for (let i = 0; i < sim.x.length; i++) {
      const col = i % sim.N
      const dx = (landing.x[col] - sim.x[i]) * blend
      const dz = (landing.z[col] - sim.z[i]) * blend
      sim.x[i] += dx; sim.px[i] += dx
      sim.z[i] += dz; sim.pz[i] += dz
    }
  }

  private finishFlyers() {
    let changed = false
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i]
      const quickDone = f.quick && quickProgress(f.age, f.quick) >= 1
      const phoneDone = this.singlePage && !f.held && Math.abs(f.phi - f.targetPhi) < 1e-6
      if (this.singlePage ? !phoneDone : !quickDone && f.mode !== 'free') continue
      const p = f.sim.progress()
      const calm = f.sim.kineticEnergy(1 / 240) < 0.25
      if (phoneDone || quickDone || (calm && (p > 0.985 || p < 0.015)) || f.age > 3.5) {
        const side: 1 | -1 = f.targetPhi > Math.PI / 2 ? -1 : 1
        this.st[f.k] = side === -1 ? 1 : 0
        if (side === -1) this.nL++
        else this.nR++
        this.flyers.splice(i, 1)
        this.flyers.forEach((q, r) => (q.rank = r))
        changed = true
        this.group.remove(f.mesh.mesh)
      }
    }
    if (changed) {
      this.restDirty = true
      this.rebuildRest()
    }
  }

  /** surface height of the top leaf of a stack near the middle of the page */
  stackTop(side: 1 | -1) {
    const n = side === 1 ? this.nR : this.nL
    return this.profile(this.tb + this.t * n, this.W * 0.5)
  }

  /** The visible resting sheet, including its curved gutter and any hover lift. */
  pageSurface(side: 1 | -1) {
    const key = this.restList(side, 1)[0]
    return key === undefined ? null : this.used.get(key) ?? null
  }

  /** pages visible on the open spread (left, right) given settled state */
  spreadLeaves() {
    return { left: this.nL - 1, right: this.nL }
  }

  /* ------------------------------ hit testing ------------------------------ */

  /** Convert book-local group coordinates (after the group offset) into zones. */
  zoneAt(x: number, y: number) {
    const { W, H } = this
    if (this.psi < 0.05 && !this.busy) {
      const Wb = W + this.OH
      const Hb = H + this.OH * 2
      if (x >= -this.zh && x <= Wb && Math.abs(y) <= Hb / 2) return { zone: 'cover' as const, side: 1 as const, u: x / Wb, v: (y + H / 2) / H }
      return null
    }
    if (!this.fullyOpen) return null
    const inY = Math.abs(y) <= H / 2 + 0.35
    if (!inY) return null
    const side: 1 | -1 = x >= 0 ? 1 : -1
    const ax = Math.abs(x)
    if (ax > W + 0.5) return null
    return { zone: 'page' as const, side, u: ax / W, v: (y + H / 2) / H }
  }

  dispose() {
    this.jumpTo(this.nL)
    this.syncShadowRig()
    for (const lm of [...this.used.values(), ...this.pool]) lm.dispose()
    this.blockL.dispose()
    this.blockR.dispose()
    this.binding.dispose()
    this.frontBoard.geometry.dispose()
    this.innerMat.dispose()
    ;(this.frontBoard.material as THREE.Material[])[5].dispose()
  }
}
