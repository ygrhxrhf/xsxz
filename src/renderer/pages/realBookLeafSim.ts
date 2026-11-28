/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/engine/leafSim.ts，Apache-2.0。已修改：文件改名，接入 spbf 的真实书籍场景。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
/**
 * Position-based simulation of a paper leaf hinged at the book's spine.
 *
 * The leaf is a grid of R rows (along the spine, y) by N nodes (spine -> fore-edge, arclength u).
 * Every row is an inextensible, stiff 2D rod in the (x,z) plane. Rows are weakly coupled so the page
 * stays a smooth surface, which lets a grabbed corner lead while the rest of the sheet trails behind.
 * Air drag acts on the velocity normal to the sheet, so a fast flick makes the page float and flutter
 * down instead of dropping like a rigid plate.
 */

export interface SimEnv {
  /** collision surface height at book-local x */
  surface(x: number): number
  rootZ: number
  /** physically-flavoured constants */
  gravity: number
}

interface Pin {
  /** material coordinate (0..1 of page width) where the page is held */
  u: number
  /** row (0..1) of the hand */
  v: number
  sigma: number
  x: number
  z: number
  strength: number
  /** when set, the sheet is shaped into the symmetric turn curl (see curlAngles) while it is held */
  shape?: CurlShape
}

interface CurlShape {
  /** chord angle of the leaf from +x (0 = flat right, PI = flat left) */
  phi: number
  fromSide: 1 | -1
  /** extra edge-lead from paper flex (grows with turning speed, may ring negative on landing) */
  flex: number
}

/**
 * Half-bend (radians) of the sheet at its strongest (chord at 45 degrees from either stack): total bend over the page is twice this
 * (curl radius ~ W / 2A).
 */
const CURL_LEAD = 0.4
/** how much the rows far from the hand trail the grabbed row (radians at mid-turn) */
const ROW_LAG = 0.2

/**
 * Tangent-angle profile of a turning leaf: a single smooth arc (constant curvature) whose chord sits at `phi`.
 *
 * The profile is time-reversal symmetric about the vertical. Measured from the stack the leaf is leaving (angle q, 0 = flat there),
 * the half-bend is `CURL_LEAD * sin(2q)`: in the first half (q < 90 deg) the fore-edge is the part that rises first and curls over
 * the flat, pinned spine; the bend fades out so the sheet is a straight plane at the vertical and the tip tangent never passes it.
 * After the vertical the sign flips (the edge trails, lifted off the stack it is about to land on) and the bend fades to zero again as
 * the sheet lies flat: the descent is the exact mirror image of the lift. The tangent therefore stays inside [0, 90 deg] in the first
 * half and [90 deg, 180 deg] in the second, so a row never folds over itself.
 *
 * Rows away from the hand `vg` trail it (towards the start stack) with a smooth falloff and bend a little less.
 * `flex` (paper flex from turning speed) scales the same curve up or down.
 */
function curlAngles(phi: number, fromSide: 1 | -1, vg: number, v: number, flex: number) {
  const q0 = Math.min(Math.PI, Math.max(0, fromSide === 1 ? phi : Math.PI - phi))
  const dv = (v - vg) / 0.5
  const far = Math.min(dv * dv, 1.2)
  const q = Math.min(Math.PI, Math.max(0, q0 - ROW_LAG * far * Math.sin(q0)))
  let delta = (CURL_LEAD + flex) * Math.sin(2 * q)
  delta *= 0.62 + 0.38 * Math.exp(-dv * dv)
  const lim = Math.min(q, Math.PI - q, Math.abs(Math.PI / 2 - q))
  delta = Math.max(-lim, Math.min(lim, delta))
  return { mid: fromSide === 1 ? q : Math.PI - q, delta: delta * fromSide }
}

/** position of the held material point at arclength fraction `u` on the hand's row */
export function curlReach(phi: number, fromSide: 1 | -1, vg: number, u: number, W: number) {
  const { mid, delta } = curlAngles(phi, fromSide, vg, vg, 0)
  const n = 20
  let x = 0
  let z = 0
  const ds = (W * u) / n
  for (let j = 0; j < n; j++) {
    const xi = ((j + 0.5) / n) * u
    const th = mid + delta * (2 * xi - 1)
    x += Math.cos(th) * ds
    z += Math.sin(th) * ds
  }
  return { x, z }
}

export class LeafSim {
  readonly N: number
  readonly R: number
  readonly W: number
  readonly H: number
  readonly ds: number
  x: Float32Array
  z: Float32Array
  px: Float32Array
  pz: Float32Array
  pin: Pin | null = null
  private tgx: Float32Array
  private tgz: Float32Array
  private restAngles: Float32Array
  /** extra gentle lift applied to specific rows at the free edge (hover peel) */
  peel = 0
  peelV = 0.5
  side: 1 | -1 = 1
  kb1 = 0.34
  kb2 = 0.12

  constructor(W: number, H: number, N = 40, R = 8) {
    this.W = W
    this.H = H
    this.N = N
    this.R = R
    this.ds = W / (N - 1)
    const n = N * R
    this.x = new Float32Array(n)
    this.z = new Float32Array(n)
    this.px = new Float32Array(n)
    this.pz = new Float32Array(n)
    this.tgx = new Float32Array(n)
    this.tgz = new Float32Array(n)
    this.restAngles = new Float32Array(N)
  }

  idx(r: number, i: number) {
    return r * this.N + i
  }

  /** place the leaf flat on a stack (side=1 right, -1 left) following surface() */
  rest(side: 1 | -1, env: SimEnv, lift = 0) {
    this.side = side
    const { N, R } = this
    for (let r = 0; r < R; r++) {
      // lay nodes along the surface, preserving arclength
      let ux = 0
      let prevX = 0
      let prevZ = env.surface(0) + lift
      for (let i = 0; i < N; i++) {
        const k = this.idx(r, i)
        if (i === 0) {
          this.x[k] = 0
          this.z[k] = prevZ
        } else {
          // march in x so that segment length == ds
          let lo = 0
          let hi = this.ds * 1.5
          for (let it = 0; it < 14; it++) {
            const mid = (lo + hi) / 2
            const zz = env.surface(side * (ux + mid)) + lift
            const d = Math.hypot(mid, zz - prevZ)
            if (d < this.ds) lo = mid
            else hi = mid
          }
          ux += (lo + hi) / 2
          prevX = ux
          prevZ = env.surface(side * ux) + lift
          this.x[k] = side * prevX
          this.z[k] = prevZ
        }
        this.px[k] = this.x[k]
        this.pz[k] = this.z[k]
      }
    }
    for (let i = 1; i < N; i++) {
      this.restAngles[i] = Math.atan2(this.z[i] - this.z[i - 1], side * (this.x[i] - this.x[i - 1]))
    }
  }

  /** average hinge angle (0 = flat right, PI = flat left) from nodes at mid-span */
  progress(): number {
    const { N, R } = this
    const i = Math.floor(N * 0.55)
    let a = 0
    for (let r = 0; r < R; r++) {
      const k = this.idx(r, i)
      const ang = Math.atan2(this.z[k] - this.z[this.idx(r, 0)], this.x[k] - this.x[this.idx(r, 0)])
      a += ang
    }
    a /= R
    return Math.min(1, Math.max(0, a / Math.PI))
  }

  tipAngle(): number {
    const { N, R } = this
    let a = 0
    for (let r = 0; r < R; r++) {
      const k = this.idx(r, N - 1)
      const k0 = this.idx(r, 0)
      a += Math.atan2(this.z[k] - this.z[k0], this.x[k] - this.x[k0])
    }
    return a / R
  }

  kineticEnergy(dt: number): number {
    let e = 0
    let cnt = 0
    for (let r = 0; r < this.R; r++) {
      for (let i = 1; i < this.N; i++) {
        const k = r * this.N + i
        const vx = (this.x[k] - this.px[k]) / dt
        const vz = (this.z[k] - this.pz[k]) / dt
        e += vx * vx + vz * vz
        cnt++
      }
    }
    return e / cnt
  }

  step(dt: number, env: SimEnv, rootZ: number) {
    const { N, R, x, z, px, pz, ds } = this
    const g = env.gravity
    const pin = this.pin

    // --- integrate
    for (let r = 0; r < R; r++) {
      for (let i = 1; i < N; i++) {
        const k = r * N + i
        let vx = (x[k] - px[k]) * 0.9985
        let vz = (z[k] - pz[k]) * 0.9985
        const ia = i < N - 1 ? i + 1 : i
        const ib = i - 1
        let tx = x[r * N + ia] - x[r * N + ib]
        let tz = z[r * N + ia] - z[r * N + ib]
        const tl = Math.hypot(tx, tz) || 1
        tx /= tl
        tz /= tl
        const nx = -tz
        const nz = tx
        const vn = vx * nx + vz * nz
        const vt = vx * tx + vz * tz
        // quadratic drag on the normal component, light friction along the sheet
        const sp = Math.abs(vn) / dt
        const dragN = Math.min(0.95, (2.2 + 0.55 * sp) * dt)
        const dragT = Math.min(0.5, 0.25 * dt)
        const nvn = vn * (1 - dragN)
        const nvt = vt * (1 - dragT)
        vx = nx * nvn + tx * nvt
        vz = nz * nvn + tz * nvt
        px[k] = x[k]
        pz[k] = z[k]
        x[k] += vx
        z[k] += vz - g * dt * dt
      }
    }

    const shape = pin?.shape
    if (shape && pin) {
      const { phi, fromSide, flex } = shape
      for (let r = 0; r < R; r++) {
        const v = r / (R - 1)
        const { mid, delta } = curlAngles(phi, fromSide, pin.v, v, flex)
        // Start with the stack's curved gutter, not a flat rod: flattening it at mouse-down
        // expands the leaf horizontally and shifts every printed word toward the fore-edge.
        // Blend out that resting bend during lift-off, preserving each segment's arclength.
        const lift = Math.min(1, Math.max(0, (fromSide === 1 ? mid : Math.PI - mid) / 0.35))
        const restWeight = 1 - lift * lift * (3 - 2 * lift)
        let cx = 0
        let cz = rootZ
        const base = r * N
        this.tgx[base] = 0
        this.tgz[base] = rootZ
        for (let i = 1; i < N; i++) {
          const xi = (i - 0.5) / (N - 1)
          const th = mid + delta * (2 * xi - 1) + fromSide * this.restAngles[i] * restWeight
          cx += Math.cos(th) * ds
          cz += Math.sin(th) * ds
          this.tgx[base + i] = cx
          this.tgz[base + i] = cz
        }
      }
      const ig = Math.min(N - 1, Math.max(1, Math.round(pin.u * (N - 1))))
      const rr = Math.min(R - 1, Math.max(0, Math.round(pin.v * (R - 1))))
      pin.x = this.tgx[rr * N + ig]
      pin.z = this.tgz[rr * N + ig]
    }

    // --- constraints
    const iterations = 14
    for (let it = 0; it < iterations; it++) {
      for (let r = 0; r < R; r++) {
        const base = r * N
        x[base] = 0
        z[base] = rootZ
        // distance constraints (Gauss-Seidel, alternate direction)
        for (let i = 0; i < N - 1; i++) {
          const a = base + i
          const b = a + 1
          const dx = x[b] - x[a]
          const dz = z[b] - z[a]
          const d = Math.hypot(dx, dz) || 1e-6
          const diff = (d - ds) / d
          const wa = i === 0 ? 0 : 0.5
          const wb = i === 0 ? 1 : 0.5
          x[a] += dx * diff * wa
          z[a] += dz * diff * wa
          x[b] -= dx * diff * wb
          z[b] -= dz * diff * wb
        }
        // bending stiffness: pull each node toward the chord of its neighbours (wide stencil)
        for (let i = 1; i < N - 1; i++) {
          const k = base + i
          const tx = (x[k - 1] + x[k + 1]) * 0.5
          const tz = (z[k - 1] + z[k + 1]) * 0.5
          x[k] += (tx - x[k]) * this.kb1
          z[k] += (tz - z[k]) * this.kb1
        }
        for (let i = 2; i < N - 2; i++) {
          const k = base + i
          const tx = (x[k - 2] + x[k + 2]) * 0.5
          const tz = (z[k - 2] + z[k + 2]) * 0.5
          x[k] += (tx - x[k]) * this.kb2
          z[k] += (tz - z[k]) * this.kb2
        }
      }
      if (shape) {
        const pull = 0.5
        for (let r = 0; r < R; r++) {
          for (let i = 1; i < N; i++) {
            const k = r * N + i
            x[k] += (this.tgx[k] - x[k]) * pull
            z[k] += (this.tgz[k] - z[k]) * pull
          }
        }
      }
      // couple rows
      for (let i = 1; i < N; i++) {
        for (let r = 0; r < R; r++) {
          const k = r * N + i
          const a = r > 0 ? k - N : k + N
          const b = r < R - 1 ? k + N : k - N
          x[k] += ((x[a] + x[b]) * 0.5 - x[k]) * 0.22
          z[k] += ((z[a] + z[b]) * 0.5 - z[k]) * 0.22
        }
      }

      // hand
      if (pin) {
        const ig = Math.min(N - 1, Math.max(1, Math.round(pin.u * (N - 1))))
        for (let r = 0; r < R; r++) {
          const v = r / (R - 1)
          const dv = (v - pin.v) / pin.sigma
          const w = Math.exp(-dv * dv) * pin.strength
          if (w < 0.01) continue
          const kg = r * N + ig
          // with a curl shape every row is held at its own target so rows blend smoothly instead of being dragged to the hand row
          const hx = shape ? this.tgx[kg] : pin.x
          const hz = shape ? this.tgz[kg] : pin.z
          const dx = (hx - x[kg]) * w
          const dz = (hz - z[kg]) * w
          for (let o = -1; o <= 1; o++) {
            const i = ig + o
            if (i < 1 || i >= N) continue
            const k = r * N + i
            const ww = o === 0 ? 1 : 0.5
            x[k] += dx * ww
            z[k] += dz * ww
          }
        }
      }

      // collision with the stacks
      for (let r = 0; r < R; r++) {
        for (let i = 1; i < N; i++) {
          const k = r * N + i
          const s = env.surface(x[k]) + 0.006
          if (z[k] < s) {
            const fall = Math.max(0, pz[k] - z[k])
            z[k] = s
            pz[k] = s + fall * 0.3
            px[k] += (x[k] - px[k]) * 0.35
          }
        }
      }
    }

    if (shape) {
      // the solver's own stiffness / row coupling / collisions must not bend the sheet away from the symmetric turn curl
      // (they used to leave a crease near the fore-edge of the outer rows), so finish by settling onto the curl
      for (let r = 0; r < R; r++) {
        for (let i = 1; i < N; i++) {
          const k = r * N + i
          x[k] += (this.tgx[k] - x[k]) * 0.85
          z[k] += (this.tgz[k] - z[k]) * 0.85
          const floor = env.surface(x[k]) + 0.006
          if (z[k] < floor) z[k] = floor
        }
      }
    }
  }
}
