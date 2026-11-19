/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * shared/atlas.ts，Apache-2.0。已修改：类型改从 ./types 取、去掉 .ts 扩展名、接入 spbf。
 * 许可文本见 third_party/infinite-reader/LICENSE，地图数据署名见 src/renderer/public/atlas/README.md。
 */
export interface AtlasPlace {
  id: string
  name: string
  modernName: string
  coordinates: [number, number]
  /** Location in the original, unrotated image. AI anchors are approximate. */
  imagePoint: [number, number] | null
}

export interface BookMap {
  id: string
  title: string
  period: string
  number: string
  bounds: [[number, number], [number, number]]
  center: [number, number]
  image: { sha256: string; bytes: number }
  places: AtlasPlace[]
  recognition?: { model: string; unresolved: string[] }
}

export interface AtlasRecognition {
  status: 'recognized' | 'not_map' | 'uncertain'
  map: BookMap | null
  message: string
  model: string
  recognizedAt: number
  cached: boolean
}
