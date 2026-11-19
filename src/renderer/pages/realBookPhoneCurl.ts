/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/engine/phoneCurl.ts，Apache-2.0。已修改：文件改名，接入 spbf 的真实书籍场景。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
export const PHONE_CURL_TRAVEL = 2

/** A rolling fold, measured in page widths. The grabbed edge follows horizontal travel 1:1. */
export function phoneCurl(width: number, height: number, progress: number, grabV: number, pointerV = grabV) {
  const travel = clamp(progress, 0, 1) * PHONE_CURL_TRAVEL
  const envelope = Math.min(travel / .15, 1, (PHONE_CURL_TRAVEL - travel) / .25)
  const slope = clamp((grabV - .5) * .36 + (pointerV - grabV) * .5, -.24, .24) * envelope
  const nx = 1 / Math.hypot(1, slope), ny = slope * nx
  const radius = width * .065 * envelope
  const displacement = travel * width / nx
  // d - R sin(d/R) is the free edge displacement through the cylindrical section.
  let d = (displacement + Math.PI * radius) / 2
  if (radius > 0 && displacement < Math.PI * radius) {
    let lo = 0, hi = Math.PI
    for (let i = 0; i < 24; i++) { const a = (lo + hi) / 2; if (radius * (a - Math.sin(a)) < displacement) lo = a; else hi = a }
    d = radius * (lo + hi) / 2
  }
  return { nx, ny, radius, crease: nx * width + ny * (grabV - .5) * height - d }
}

export function curlPoint(x: number, y: number, fold: ReturnType<typeof phoneCurl>) {
  const { nx, ny, radius, crease } = fold
  const d = nx * x + ny * y - crease
  if (d <= 0) return { x, y, z: 0, nx: 0, ny: 0, nz: 1, curvature: 0 }
  const angle = radius > 1e-6 ? Math.min(d / radius, Math.PI) : Math.PI
  const q = d < Math.PI * radius ? radius * Math.sin(angle) : Math.PI * radius - d
  return { x: x + nx * (q - d), y: y + ny * (q - d), z: radius * (1 - Math.cos(angle)),
    nx: -nx * Math.sin(angle), ny: -ny * Math.sin(angle), nz: Math.cos(angle),
    curvature: d < Math.PI * radius ? 1 / radius : 0 }
}

/** Distance commits a deliberate drag; the latest reverse flick always cancels it. */
export function phoneTurnCommits(distance: number, velocity: number) {
  if (velocity < -.35) return false
  return distance >= .28 || (distance >= .035 && velocity > .55)
}
