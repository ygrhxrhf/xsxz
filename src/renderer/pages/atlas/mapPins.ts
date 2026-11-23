/**
 * 把书里已定位的地名（`AiPlaceGeo`，坐标来自地理编码）转成 3D 地图可用的 `BookMap`。
 *
 * 与精选/图片地图的区别：这张「文字地点」地图不是某本书里的一张图，
 * 它的范围由地点自身的经纬度算出来（含跨日期变更线的短弧），
 * 没有原图，所以 `image` 用一个固定的空指纹占位，`imagePoint` 为 null。
 *
 * 范围算法取自 Infinite Reader 的 `shared/textAtlas.ts`（Apache-2.0），
 * 只保留本项目需要的部分；低可信度待确认的地点不进地图，留给左侧列表处理。
 * 纯函数，不依赖地图库，方便单测。
 */
import type { AiPlaceGeo } from '@shared/types'
import type { BookMap } from './types'

/** 文字地点的固定地图 id。 */
const TEXT_MAP_ID = 'text-book'

interface TextPlaceInput {
  id: string
  name: string
  latitude: number
  longitude: number
  kind?: string
}

/** 日期变更线安全的最短经度弧与范围；与参考站的 `textMapExtent` 同一算法。 */
export function textMapExtent(points: Array<[number, number]>): Pick<BookMap, 'bounds' | 'center'> {
  const xs = points.map((point) => (point[0] + 360) % 360).sort((a, b) => a - b)
  let gap = -1
  let start = 0
  for (let index = 0; index < xs.length; index += 1) {
    const next = (index + 1) % xs.length
    const distance = xs[next]! + (next === 0 ? 360 : 0) - xs[index]!
    if (distance > gap) {
      gap = distance
      start = next
    }
  }
  const wrap = (value: number): number => ((value + 180) % 360 + 360) % 360 - 180
  const west = wrap(xs[start]!)
  const east = west + 360 - gap
  const ys = points.map((point) => Math.max(-85, Math.min(85, point[1])))
  const south = Math.min(...ys)
  const north = Math.max(...ys)
  const dx = Math.max(0.08, (east - west) * 0.15)
  const dy = Math.max(0.06, (north - south) * 0.15)
  const left = wrap(west - dx)
  return {
    bounds: [
      [left, Math.max(-85, south - dy)],
      [left + Math.min(359.99, east - west + 2 * dx), Math.min(85, north + dy)],
    ],
    center: [wrap((west + east) / 2), (south + north) / 2],
  }
}

/** 已确认定位的书内地名 → 文字地点列表（低可信度待确认的留给左侧列表处理）。 */
export function textPlacesFrom(places: readonly AiPlaceGeo[]): TextPlaceInput[] {
  const out: TextPlaceInput[] = []
  const seen = new Set<string>()
  for (const place of places) {
    if (place.geocodeStatus !== 'resolved') continue
    const location = place.location
    if (!location) continue
    if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) continue
    if (Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180) continue
    if (seen.has(place.id)) continue
    seen.add(place.id)
    out.push({
      id: place.id,
      name: place.name,
      latitude: location.latitude,
      longitude: location.longitude,
      kind: place.kind,
    })
  }
  return out
}

/** 文字地点列表 → 一张可交给 3D 地图的 `BookMap`；没有地点时返回 null。 */
export function textBookMap(places: readonly AiPlaceGeo[]): BookMap | null {
  const items = textPlacesFrom(places)
  if (!items.length) return null
  const extent = textMapExtent(items.map((item) => [item.longitude, item.latitude]))
  return {
    id: TEXT_MAP_ID,
    title: '书中文字地点',
    period: '',
    number: '',
    ...extent,
    // 文字地图没有原图；空指纹保证它永远不会被图片识别误判。
    image: { sha256: '', bytes: 0 },
    places: items.map((item) => ({
      id: item.id,
      name: item.name,
      modernName: item.name,
      coordinates: [item.longitude, item.latitude],
      imagePoint: null,
    })),
  }
}
