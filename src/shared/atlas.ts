/**
 * 书中地图的共享类型：主进程的原图识别与渲染层的 3D 地图共用同一份定义。
 *
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * `shared/atlas.ts`，Apache-2.0。已修改：注释与文件位置适配 spbf，字段保持不变。
 * 许可文本见 third_party/infinite-reader/LICENSE。
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

/** 一次原图识别的结果。`cached` 为 true 表示直接复用了上次的结论，没有重新调用模型。 */
export interface AtlasRecognition {
  status: 'recognized' | 'not_map' | 'uncertain'
  map: BookMap | null
  message: string
  model: string
  recognizedAt: number
  cached: boolean
}
