/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/engine/leafMesh.ts，Apache-2.0。已修改：文件改名，接入 spbf 的真实书籍场景。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
import * as THREE from 'three'
import { BLANK_TEXTURE, createPaperMaterial, type PaperUniforms } from './realBookPaperMaterial'
import type { LeafSim } from './realBookLeafSim'
import type { GutterFold } from './realBookGutterFold'
import { phoneCurl, curlPoint } from './realBookPhoneCurl'

export const GRID_U = 40
export const GRID_V = 26

const indexCache = new Map<string, THREE.BufferAttribute>()
function gridIndex(nu: number, nv: number) {
  const key = nu + 'x' + nv
  let a = indexCache.get(key)
  if (!a) {
    const idx = new Uint16Array((nu - 1) * (nv - 1) * 6)
    let p = 0
    for (let j = 0; j < nv - 1; j++) {
      for (let i = 0; i < nu - 1; i++) {
        const a0 = j * nu + i
        const b = a0 + 1
        const c = b + nu
        const d = a0 + nu
        idx[p++] = a0
        idx[p++] = b
        idx[p++] = c
        idx[p++] = a0
        idx[p++] = c
        idx[p++] = d
      }
    }
    a = new THREE.BufferAttribute(idx, 1)
    indexCache.set(key, a)
  }
  return a
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

/** One paper leaf rendered as a deformable double-sided sheet. */
export class LeafMesh {
  readonly mesh: THREE.Mesh
  readonly geo: THREE.BufferGeometry
  readonly uniforms: PaperUniforms
  readonly material: THREE.MeshStandardMaterial
  key = -999
  private pos: Float32Array
  private nor: Float32Array
  private curv: Float32Array
  private H: number
  private W: number
  private peelLift = new Float32Array(GRID_U)
  private peelShrink = new Float32Array(GRID_U)

  constructor(W: number, H: number) {
    this.W = W
    this.H = H
    const n = GRID_U * GRID_V
    this.pos = new Float32Array(n * 3)
    this.nor = new Float32Array(n * 3)
    this.curv = new Float32Array(n)
    const uv = new Float32Array(n * 2)
    for (let j = 0; j < GRID_V; j++) {
      for (let i = 0; i < GRID_U; i++) {
        uv[(j * GRID_U + i) * 2] = i / (GRID_U - 1)
        uv[(j * GRID_U + i) * 2 + 1] = j / (GRID_V - 1)
      }
    }
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    this.geo.setAttribute('aCurv', new THREE.BufferAttribute(this.curv, 1).setUsage(THREE.DynamicDrawUsage))
    this.geo.setIndex(gridIndex(GRID_U, GRID_V))
    const { material, uniforms } = createPaperMaterial()
    this.material = material
    this.uniforms = uniforms
    this.mesh = new THREE.Mesh(this.geo, material)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = false
    this.mesh.frustumCulled = false
  }

  setTextures(front: THREE.Texture | null, back: THREE.Texture | null) {
    this.uniforms.uFront.value = front || BLANK_TEXTURE
    this.uniforms.uBack.value = back || BLANK_TEXTURE
  }

  /** Phone paper rolls around a local diagonal fold; untouched text never tilts. */
  writePhoneCurl(progress: number, grabV: number, pointerV: number, height: number) {
    const fold = phoneCurl(this.W, this.H, progress, grabV, pointerV)
    for (let j = 0; j < GRID_V; j++) for (let i = 0; i < GRID_U; i++) {
      const k = j * GRID_U + i, o = k * 3
      const p = curlPoint(i / (GRID_U - 1) * this.W, (j / (GRID_V - 1) - .5) * this.H, fold)
      this.pos[o] = p.x; this.pos[o + 1] = p.y; this.pos[o + 2] = height + p.z
      this.nor[o] = p.nx; this.nor[o + 1] = p.ny; this.nor[o + 2] = p.nz
      this.curv[k] = p.curvature
    }
    this.geo.attributes.position.needsUpdate = true
    this.geo.attributes.normal.needsUpdate = true
    this.geo.attributes.aCurv.needsUpdate = true
  }

  /** Sample the same triangle surface used to render the page, in leaf-local coordinates. */
  pointAt(u: number, v: number, target: THREE.Vector3) {
    const x = Math.max(0, Math.min(1, u)) * (GRID_U - 1)
    const y = Math.max(0, Math.min(1, v)) * (GRID_V - 1)
    const i = Math.min(GRID_U - 2, Math.floor(x))
    const j = Math.min(GRID_V - 2, Math.floor(y))
    const fx = x - i, fy = y - j
    const a = (j * GRID_U + i) * 3
    const c = a + (GRID_U + 1) * 3
    const b = fy <= fx ? a + 3 : a + GRID_U * 3
    const wa = 1 - Math.max(fx, fy), wb = Math.abs(fx - fy), wc = Math.min(fx, fy)
    return target.set(
      this.pos[a] * wa + this.pos[b] * wb + this.pos[c] * wc,
      this.pos[a + 1] * wa + this.pos[b + 1] * wb + this.pos[c + 1] * wc,
      this.pos[a + 2] * wa + this.pos[b + 2] * wb + this.pos[c + 2] * wc,
    )
  }

  /**
   * Fill vertex buffers from a sim grid. `peel` adds a soft fore-edge lift centered on `peelV`.
   */
  write(sim: LeafSim, peel = 0, peelV = 0.5, fold?: GutterFold) {
    const { N, R } = sim
    const { pos, nor, curv, H } = this
    const NU = GRID_U
    const NV = GRID_V
    // sample sim rows with catmull-rom into GRID_V rows
    for (let j = 0; j < NV; j++) {
      const s = (j / (NV - 1)) * (R - 1)
      const r1 = Math.min(R - 2, Math.floor(s))
      const f = s - r1
      const r0 = Math.max(0, r1 - 1)
      const r2 = r1 + 1
      const r3 = Math.min(R - 1, r2 + 1)
      const y = -H / 2 + (j / (NV - 1)) * H
      const v = j / (NV - 1)
      const pv = Math.max(0, Math.min(1, peelV))
      const pk = peel > 0 ? Math.exp(-(((v - pv) / 0.32) ** 2)) * peel : 0
      if (pk > 0) {
        // a lifted fore-edge: gentle large-radius arc from the spine, no kink; the chord shortens as it rises
        let shrink = 0
        let prevLift = 0
        for (let i = 0; i < NU; i++) {
          const u = i / (NU - 1)
          const lift = pk * 1.15 * Math.pow(u, 2.3)
          if (i > 0) {
            const dh = lift - prevLift
            const seg = this.W / (NU - 1)
            shrink += seg - Math.sqrt(Math.max(seg * seg - dh * dh, 0))
          }
          prevLift = lift
          this.peelLift[i] = lift
          this.peelShrink[i] = shrink
        }
      }
      for (let i = 0; i < NU; i++) {
        const o = (j * NU + i) * 3
        const k0 = r0 * N + i
        const k1 = r1 * N + i
        const k2 = r2 * N + i
        const k3 = r3 * N + i
        let px = catmull(sim.x[k0], sim.x[k1], sim.x[k2], sim.x[k3], f)
        let pz = catmull(sim.z[k0], sim.z[k1], sim.z[k2], sim.z[k3], f)
        if (pk > 0) {
          pz += this.peelLift[i]
          px -= sim.side * this.peelShrink[i]
        }
        const folded = fold?.point(px, pz)
        pos[o] = folded?.x ?? px
        pos[o + 1] = y
        pos[o + 2] = folded?.z ?? pz
      }
    }
    // normals + curvature
    for (let j = 0; j < NV; j++) {
      const jm = Math.max(0, j - 1)
      const jp = Math.min(NV - 1, j + 1)
      for (let i = 0; i < NU; i++) {
        const im = Math.max(0, i - 1)
        const ip = Math.min(NU - 1, i + 1)
        const a = (j * NU + im) * 3
        const b = (j * NU + ip) * 3
        const c = (jm * NU + i) * 3
        const d = (jp * NU + i) * 3
        const ux = pos[b] - pos[a]
        const uy = pos[b + 1] - pos[a + 1]
        const uz = pos[b + 2] - pos[a + 2]
        const vx = pos[d] - pos[c]
        const vy = pos[d + 1] - pos[c + 1]
        const vz = pos[d + 2] - pos[c + 2]
        let nx = uy * vz - uz * vy
        let ny = uz * vx - ux * vz
        let nz = ux * vy - uy * vx
        const l = Math.hypot(nx, ny, nz) || 1
        nx /= l
        ny /= l
        nz /= l
        const o = (j * NU + i) * 3
        nor[o] = nx
        nor[o + 1] = ny
        nor[o + 2] = nz
      }
      // curvature along u: signed turning angle per unit length
      for (let i = 1; i < NU - 1; i++) {
        const a = (j * NU + i - 1) * 3
        const b = (j * NU + i) * 3
        const c = (j * NU + i + 1) * 3
        const t1x = pos[b] - pos[a]
        const t1z = pos[b + 2] - pos[a + 2]
        const t2x = pos[c] - pos[b]
        const t2z = pos[c + 2] - pos[b + 2]
        const cross = t1x * t2z - t1z * t2x
        const dot = t1x * t2x + t1z * t2z
        const len = Math.hypot(t1x, t1z) || 1
        curv[j * NU + i] = Math.atan2(cross, dot) / len
      }
      curv[j * NU] = curv[j * NU + 1]
      curv[j * NU + NU - 1] = curv[j * NU + NU - 2]
    }
    this.geo.attributes.position.needsUpdate = true
    this.geo.attributes.normal.needsUpdate = true
    this.geo.attributes.aCurv.needsUpdate = true
  }

  /**
   * Write a polyline of the sheet along u at grid row `j` into `dst` as RGBA texels
   * (world x, world z, world y, 1), `cols` samples evenly spread over the grid.
   * Returns the highest world z written.
   *
   * 与上游一致：书页在 x-y 平面、z 朝镜头；软影 shader 用 (x, z) 当水平面、
   * y 当高度，所以这里按 (x, z, y) 的顺序写纹素。
   */
  exportRow(dst: Float32Array, texel: number, cols: number, j: number, m: THREE.Matrix4): number {
    const e = m.elements
    const { pos } = this
    let zmax = -Infinity
    for (let c = 0; c < cols; c++) {
      const i = Math.round((c / (cols - 1)) * (GRID_U - 1))
      const o = (j * GRID_U + i) * 3
      const x = pos[o]!
      const y = pos[o + 1]!
      const z = pos[o + 2]!
      const wz = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!
      const t = (texel + c) * 4
      dst[t] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!
      dst[t + 1] = wz
      dst[t + 2] = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!
      dst[t + 3] = 1
      if (wz > zmax) zmax = wz
    }
    return zmax
  }

  dispose() {
    this.geo.dispose()
    this.material.dispose()
  }
}
