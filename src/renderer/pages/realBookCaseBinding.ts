/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/engine/binding.ts，Apache-2.0。已修改：文件改名，接入 spbf 的真实书籍场景。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
import * as THREE from 'three'

const SECTIONS = 48
const RING = 8

function strip(rows: number, wrap = false) {
  const geo = new THREE.BufferGeometry()
  const count = (SECTIONS + 1) * rows
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage))
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage))
  const indices: number[] = []
  for (let j = 0; j < (wrap ? rows : rows - 1); j++) for (let i = 0; i < SECTIONS; i++) {
    const a = i * rows + j, b = i * rows + (j + 1) % rows
    indices.push(a, a + rows, b, b, a + rows, b + rows)
  }
  geo.setIndex(indices)
  return geo
}

/** A cloth case with flexible joints, a recessed lining, and small woven head/tail bands.
 * Its shoulders stay attached to the boards, including when the book lies fully open.
 * Page geometry and the text-selection coordinate system remain independent of the case.
 */
export class CaseBinding {
  readonly group = new THREE.Group()
  readonly joint: number
  readonly cloth: THREE.MeshStandardMaterial
  private shell = strip(RING, true)
  private lining = strip(2)
  private band = strip(RING, true)
  private liningMat: THREE.MeshStandardMaterial
  private bandMat: THREE.MeshStandardMaterial
  private grain: THREE.DataTexture
  private height: number
  private overhang: number
  private board: number
  private radius: number

  constructor(height: number, overhang: number, board: number, block: number, color: THREE.Color, endpaper?: THREE.Material) {
    this.height = height
    this.overhang = overhang
    this.board = board
    this.radius = board + block / 2
    this.joint = 0.12 + block * 0.16

    // A small repeating bump map gives the cloth a matte weave without painted stripes.
    const size = 64, pixels = new Uint8Array(size * size)
    let seed = 29
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      pixels[y * size + x] = 122 + (seed >>> 29) + ((x % 4 === 0) !== (y % 4 === 0) ? 12 : 0)
    }
    this.grain = new THREE.DataTexture(pixels, size, size, THREE.RedFormat)
    this.grain.wrapS = this.grain.wrapT = THREE.RepeatWrapping
    this.grain.repeat.set((Math.PI * this.radius + this.joint * 2) * 2, height * 2)
    this.grain.magFilter = THREE.LinearFilter
    this.grain.minFilter = THREE.LinearMipmapLinearFilter
    this.grain.generateMipmaps = true
    this.grain.needsUpdate = true
    this.cloth = new THREE.MeshStandardMaterial({ color, roughness: 0.86, bumpMap: this.grain, bumpScale: 0.012, side: THREE.DoubleSide })
    this.liningMat = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.55), roughness: 1, side: THREE.DoubleSide })
    this.bandMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, side: THREE.DoubleSide })

    const uv = new Float32Array((SECTIONS + 1) * RING * 2)
    const colors = new Float32Array((SECTIONS + 1) * RING * 3)
    const yarn = new THREE.Color('#c6baa0')
    const thread = color.clone().lerp(yarn, 0.28)
    for (let i = 0; i <= SECTIONS; i++) for (let j = 0; j < RING; j++) {
      const k = i * RING + j
      uv[k * 2] = i / SECTIONS
      uv[k * 2 + 1] = j === 0 || j >= 5 ? 0 : 1
      const c = i % 4 < 2 ? yarn : thread
      colors.set([c.r, c.g, c.b], k * 3)
    }
    this.shell.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    this.band.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    // The endpaper continues over the flexible inner joint; only its outer wrap is cloth.
    this.shell.addGroup(0, SECTIONS * 6 * 4, 0)
    this.shell.addGroup(SECTIONS * 6 * 4, SECTIONS * 6, 1)
    this.shell.addGroup(SECTIONS * 6 * 5, SECTIONS * 6 * 3, 0)
    const shell = new THREE.Mesh(this.shell, [this.cloth, endpaper ?? this.cloth])
    shell.name = 'case-spine'
    this.group.add(shell)
    for (const side of [-1, 1]) {
      const lining = new THREE.Mesh(this.lining, this.liningMat)
      const band = new THREE.Mesh(this.band, this.bandMat)
      lining.name = side < 0 ? 'tail-lining' : 'head-lining'
      band.name = side < 0 ? 'tail-band' : 'head-band'
      lining.scale.y = band.scale.y = side
      this.group.add(lining, band)
    }
    for (const child of this.group.children) {
      child.castShadow = child.receiveShadow = true
      child.frustumCulled = false
    }
  }

  private point(q: number, theta: number, inset: number, lift = 0) {
    const a = q * theta, s = Math.sin(a), c = Math.cos(a)
    return {
      x: -this.radius * s + this.joint * ((1 - q) - q * Math.cos(theta)) + (inset + lift) * s,
      z: this.radius - this.radius * c + this.joint * q * Math.sin(theta) + (inset + lift) * c,
    }
  }

  /** Heights are sampled at the joint from the same gutter profile as the resting pages. */
  update(theta: number, rightHeight: number, leftHeight: number) {
    const open = 1 - theta / Math.PI
    const hb = (this.height + this.overhang * 2) / 2
    const bevel = 0.009
    const shell = this.shell.attributes.position as THREE.BufferAttribute
    const lining = this.lining.attributes.position as THREE.BufferAttribute
    const band = this.band.attributes.position as THREE.BufferAttribute
    const bandRadius = Math.min(0.016, this.radius * 0.055)
    const bandPoint = (q: number) => {
      // Stay below both page stacks: interpolating their unequal heights draws a diagonal
      // cord across the thinner stack at the beginning/end of a thick book.
      const rise = Math.max(0, Math.min(rightHeight, leftHeight) - this.board - 0.055) * 0.72
      return this.point(q, theta, this.board + 0.018 + rise * Math.sin(q * Math.PI) ** 2 * open * open)
    }
    for (let i = 0; i <= SECTIONS; i++) {
      const q = i / SECTIONS
      const lift = this.board * 0.56 * Math.sin(q * Math.PI) ** 2 * open * open
      const thickness = 0.03 + (this.board - 0.03) * (Math.exp(-q / 0.065) + Math.exp(-(1 - q) / 0.065))
      const levels = [0, 0, bevel, thickness - bevel, thickness, thickness, thickness - bevel, bevel]
      const ys = [-hb + bevel, hb - bevel, hb, hb, hb - bevel, -hb + bevel, -hb, -hb]
      for (let j = 0; j < RING; j++) {
        const p = this.point(q, theta, levels[j], lift)
        shell.setXYZ(i * RING + j, p.x, ys[j], p.z)
      }

      const lower = this.point(q, theta, thickness, lift)
      const upper = bandPoint(q)
      // The lining sits behind the endband, leaving a visible depth at the spine's ends.
      lining.setXYZ(i * 2, lower.x, this.height / 2 - 0.012, lower.z)
      lining.setXYZ(i * 2 + 1, upper.x, this.height / 2 - 0.012, upper.z)
      const prev = bandPoint(Math.max(0, q - 0.001))
      const next = bandPoint(Math.min(1, q + 0.001))
      const dx = next.x - prev.x, dz = next.z - prev.z
      const length = Math.hypot(dx, dz) || 1
      for (let j = 0; j < RING; j++) {
        const angle = j / RING * Math.PI * 2
        const offset = Math.cos(angle) * bandRadius
        band.setXYZ(i * RING + j,
          upper.x - dz / length * offset,
          this.height / 2 + 0.028 + Math.sin(angle) * bandRadius,
          upper.z + dx / length * offset)
      }
    }
    // Keep the narrow head/tail edges from inheriting the large top face's normal;
    // area-weighted smoothing would make the cloth edge look like a bright metal tab.
    const normals = this.shell.attributes.normal as THREE.BufferAttribute
    for (let i = 0; i <= SECTIONS; i++) for (let j = 0; j < RING; j++) {
      const k = i * RING + j
      if (j === 2 || j === 3 || j === 6 || j === 7) {
        normals.setXYZ(k, 0, j < 4 ? 1 : -1, 0)
      } else {
        const p = Math.max(0, i - 1) * RING + j, n = Math.min(SECTIONS, i + 1) * RING + j
        const dx = shell.getX(n) - shell.getX(p), dz = shell.getZ(n) - shell.getZ(p)
        const length = Math.hypot(dx, dz) || 1, sign = j < 2 ? -1 : 1
        normals.setXYZ(k, sign * dz / length, 0, -sign * dx / length)
      }
    }
    normals.needsUpdate = true
    for (const geo of [this.shell, this.lining, this.band]) {
      geo.attributes.position.needsUpdate = true
      if (geo !== this.shell) geo.computeVertexNormals()
      geo.computeBoundingSphere()
    }
  }

  dispose() {
    for (const geo of [this.shell, this.lining, this.band]) geo.dispose()
    this.cloth.dispose()
    this.liningMat.dispose()
    this.bandMat.dispose()
    this.grain.dispose()
  }
}
