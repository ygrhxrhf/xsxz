/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/engine/stack.ts，Apache-2.0。已修改：文件改名并接入 spbf 的真实书籍场景。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
import * as THREE from 'three'
import type { GutterFold } from './realBookGutterFold'
import { LeafSim } from './realBookLeafSim'

const SEG = 28

let stripeTex: THREE.CanvasTexture | null = null
function getStripes() {
  if (stripeTex) return stripeTex
  const H = 512
  const c = document.createElement('canvas')
  c.width = 4
  c.height = H
  const g = c.getContext('2d')!
  let seed = 7
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const band = new Float32Array(H / 16 + 2).map(() => rnd() * 16 - 8)
  for (let y = 0; y < H; y++) {
    // 8 rows per leaf: a soft shadow between leaves, slight dirt variation, and occasional gathering lines
    const inLeaf = y % 8
    let v = 236 + band[Math.floor(y / 16)] - rnd() * 9 - (inLeaf === 0 ? 16 : inLeaf === 1 ? 7 : 0)
    if (y % 96 === 0) v -= 26
    g.fillStyle = `rgb(${v},${v * 0.955},${v * 0.845})`
    g.fillRect(0, y, 4, 1)
  }
  stripeTex = new THREE.CanvasTexture(c)
  stripeTex.wrapT = THREE.RepeatWrapping
  stripeTex.colorSpace = THREE.SRGBColorSpace
  stripeTex.anisotropy = 16
  return stripeTex
}

/**
 * A stack of pages seen as a solid block: fore-edge, head and tail walls follow the gutter profile
 * so that the thickness of each side changes continuously while leaves move between stacks.
 */
export class StackBlock {
  readonly mesh: THREE.Mesh
  private geo = new THREE.BufferGeometry()
  private pos: Float32Array
  private nor: Float32Array
  private uv: Float32Array
  private side: 1 | -1
  private W: number
  private H: number
  private t: number
  private section: LeafSim

  dispose() {
    this.geo.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    // The stripe texture is shared by every book and stays cached.
  }

  constructor(side: 1 | -1, W: number, H: number, leafT: number) {
    this.side = side
    this.W = W
    this.H = H
    this.t = leafT
    // One row of the same arc-length solver used by the resting paper leaves.
    this.section = new LeafSim(W, H, undefined, 1)
    // head wall + tail wall: strips along x (2 verts per column) ; fore-edge wall: 1 quad ; top face hidden under leaves
    const walls = 2 * (SEG + 1) * 2 + 4 + (SEG + 1) * 2
    this.pos = new Float32Array(walls * 3)
    this.nor = new Float32Array(walls * 3)
    this.uv = new Float32Array(walls * 2)
    const idx: number[] = []
    let base = 0
    for (let w = 0; w < 2; w++) {
      for (let i = 0; i < SEG; i++) {
        const a = base + i * 2
        const flip = (w === 0) !== (side === 1)
        if (flip) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
        else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
      }
      base += (SEG + 1) * 2
    }
    // fore wall
    const f = base
    if (side === 1) idx.push(f, f + 1, f + 2, f + 1, f + 3, f + 2)
    else idx.push(f, f + 2, f + 1, f + 1, f + 2, f + 3)
    base += 4
    // underside/top cap (dark, hides gaps seen through the gutter)
    for (let i = 0; i < SEG; i++) {
      const a = base + i * 2
      if (side === 1) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
      else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    this.geo.setIndex(idx)
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage))
    const mat = new THREE.MeshStandardMaterial({
      map: getStripes(),
      emissiveMap: getStripes(),
      emissive: new THREE.Color(0.42, 0.4, 0.34),
      roughness: 0.92,
      color: 0xffffff,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
    })
    this.mesh = new THREE.Mesh(this.geo, mat)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
  }

  /** @param profile top surface height as a function of |x| */
  update(zBottom: number, profile: (ax: number) => number, fold?: GutterFold) {
    const { pos, nor, uv, W, H, t, side } = this
    // A curved sheet reaches less far horizontally than a flat one. Keep the
    // cap under that sheet instead of exposing a full-width, brightly lit strip.
    this.section.rest(1, { gravity: 0, rootZ: 0, surface: profile })
    const topW = this.section.x[this.section.N - 1]
    const stripeScale = 1 / (t * 64)
    let o = 0
    let u = 0
    const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, v: number) => {
      const folded = fold?.point(x, z)
      pos[o] = folded?.x ?? x
      pos[o + 1] = y
      pos[o + 2] = folded?.z ?? z
      nor[o] = nx
      nor[o + 1] = ny
      nor[o + 2] = nz
      uv[u] = 0.5
      uv[u + 1] = v
      o += 3
      u += 2
    }
    for (let w = 0; w < 2; w++) {
      const y = w === 0 ? -H / 2 : H / 2
      const ny = w === 0 ? -1 : 1
      for (let i = 0; i <= SEG; i++) {
        const ax = (i / SEG) * W
        const topX = (i / SEG) * topW
        const zt = profile(topX)
        put(side * ax, y, zBottom, 0, ny, 0, 0)
        put(side * topX, y, zt, 0, ny, 0, (zt - zBottom) * stripeScale)
      }
    }
    const zt = profile(topW)
    const length = Math.hypot(zt - zBottom, W - topW) || 1
    const nx = side * (zt - zBottom) / length, nz = (W - topW) / length
    put(side * W, -H / 2, zBottom, nx, 0, nz, 0)
    put(side * topW, -H / 2, zt, nx, 0, nz, (zt - zBottom) * stripeScale)
    put(side * W, H / 2, zBottom, nx, 0, nz, 0)
    put(side * topW, H / 2, zt, nx, 0, nz, (zt - zBottom) * stripeScale)
    // cap just below the top leaf
    for (let i = 0; i <= SEG; i++) {
      const ax = (i / SEG) * topW
      const z = profile(ax) - t * 1.6
      put(side * ax, -H / 2, z, 0, 0, 1, 0.5)
      put(side * ax, H / 2, z, 0, 0, 1, 0.5)
    }
    this.geo.attributes.position.needsUpdate = true
    this.geo.attributes.normal.needsUpdate = true
    this.geo.attributes.uv.needsUpdate = true
    if (fold) this.geo.computeVertexNormals()
    this.geo.computeBoundingSphere()
  }
}
