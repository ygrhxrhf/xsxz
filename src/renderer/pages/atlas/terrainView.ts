/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/atlas/terrainView.ts，Apache-2.0。已修改：类型改从 ./types 取、去掉 .ts 扩展名、接入 spbf。
 * 许可文本见 third_party/infinite-reader/LICENSE，地图数据署名见 src/renderer/public/atlas/README.md。
 */
import type { BookMap } from './types'

export const TERRAIN_VIEW = { zoom: 10.5, pitch: 65, exaggeration: 1.25 }
export const TERRAIN_DETAIL_ZOOM = 14
export const ATLAS_MAX_ZOOM = 14

type Coordinates = [number, number]
type Elevation = (point: Coordinates) => number | null

/** Find relief in this book map, using already loaded DEMs, without another geocoding service. */
export function findTerrainFocus(bounds: BookMap['bounds'], elevation: Elevation, fallback: Coordinates, near?: Coordinates): Coordinates {
  const [[west, south], [rawEast, north]] = bounds
  const east = rawEast < west ? rawEast + 360 : rawEast
  const wrap = (lng: number) => ((lng + 180) % 360 + 360) % 360 - 180
  const sample = (x: number, y: number) => {
    const value = elevation([wrap(Math.max(west, Math.min(east, x))), Math.max(south, Math.min(north, y))])
    return value !== null && Number.isFinite(value) ? value : 0
  }
  let focus: Coordinates = fallback
  const nearLng = near && near[0] < west ? near[0] + 360 : near?.[0]
  let area = near && nearLng !== undefined
    ? [Math.max(west, nearLng - 2), Math.max(south, near[1] - 1.5), Math.min(east, nearLng + 2), Math.min(north, near[1] + 1.5)]
    : [west, south, east, north]
  // Refine the best coarse cell once; keeping the search bounded also handles large ocean maps.
  for (let pass = 0; pass < 2; pass++) {
    const [left, bottom, right, top] = area
    const dx = (right - left) / 16, dy = (top - bottom) / 12
    let best = 0
    let candidate: Coordinates | null = null
    for (let row = 0; row <= 12; row++) for (let col = 0; col <= 16; col++) {
      const x = left + col * dx, y = bottom + row * dy
      const height = sample(x, y)
      if (height < 100) continue
      const neighbors = [sample(x - dx / 2, y), sample(x + dx / 2, y), sample(x, y - dy / 2), sample(x, y + dy / 2)]
      // Favor elevated ridges; negative seabed is not mountain relief.
      const relief = height - Math.max(0, Math.min(...neighbors))
      const score = height + relief * 0.3
      if (score > best) { best = score; candidate = [x, y] }
    }
    if (!candidate) break
    focus = [wrap(candidate[0]), candidate[1]]
    area = [Math.max(west, candidate[0] - dx), Math.max(south, candidate[1] - dy), Math.min(east, candidate[0] + dx), Math.min(north, candidate[1] + dy)]
  }
  return focus
}
