/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/atlas/catalog.ts，Apache-2.0。已修改：类型改从 ./types 取、去掉 .ts 扩展名、接入 spbf。
 * 许可文本见 third_party/infinite-reader/LICENSE，地图数据署名见 src/renderer/public/atlas/README.md。
 */
import type { AtlasPlace, BookMap } from './types'

/** Reviewed pilot maps. Recognition is exact image identity, never a filename or page-number guess. */
export const BOOK_MAPS: BookMap[] = [
  {
    id: 'fateful-choices-western-europe', title: '西欧', period: '1940', number: '01',
    bounds: [[-12, 35.5], [16, 64]], center: [2, 49],
    image: { sha256: '92e47a663e34d2b18cd305f5819788b68a0a57b31dd57f94b6d4144869d00305', bytes: 122492 },
    places: [
      { id: 'london', name: '伦敦', modernName: 'London', coordinates: [-0.118668, 51.501941], imagePoint: [0.523, 0.491] },
      { id: 'paris', name: '巴黎', modernName: 'Paris', coordinates: [2.352992, 48.858092], imagePoint: [0.590, 0.586] },
      { id: 'berlin', name: '柏林', modernName: 'Berlin', coordinates: [13.399603, 52.523764], imagePoint: [0.962, 0.479] },
      { id: 'brussels', name: '布鲁塞尔', modernName: 'Brussels', coordinates: [4.331371, 50.835263], imagePoint: [0.647, 0.522] },
      { id: 'dublin', name: '都柏林', modernName: 'Dublin', coordinates: [-6.25698, 53.346731], imagePoint: [0.355, 0.409] },
      { id: 'bern', name: '伯尔尼', modernName: 'Bern', coordinates: [7.466976, 46.916683], imagePoint: [0.756, 0.646] },
      { id: 'madrid', name: '马德里', modernName: 'Madrid', coordinates: [-3.685297, 40.401972], imagePoint: [0.319, 0.842] },
      { id: 'lisbon', name: '里斯本', modernName: 'Lisbon', coordinates: [-9.146812, 38.724669], imagePoint: [0.080, 0.864] },
      { id: 'rome', name: '罗马', modernName: 'Rome', coordinates: [12.481313, 41.897902], imagePoint: [0.906, 0.836] },
    ],
  },
  {
    id: 'fateful-choices-balkans', title: '巴尔干地区', period: '1940—1941', number: '02',
    bounds: [[12, 34.5], [30, 48.5]], center: [21, 42],
    image: { sha256: '72d17d479651b1fec2f492e323e3df68660044565f1d9cc35e72050f5633ce51', bytes: 122112 },
    places: [
      { id: 'budapest', name: '布达佩斯', modernName: 'Budapest', coordinates: [19.081375, 47.501952], imagePoint: [0.437, 0.058] },
      { id: 'zagreb', name: '萨格勒布', modernName: 'Zagreb', coordinates: [15.999995, 45.800007], imagePoint: [0.158, 0.158] },
      { id: 'belgrade', name: '贝尔格莱德', modernName: 'Belgrade', coordinates: [20.466045, 44.820591], imagePoint: [0.550, 0.281] },
      { id: 'sofia', name: '索非亚', modernName: 'Sofia', coordinates: [23.314708, 42.685295], imagePoint: [0.759, 0.457] },
      { id: 'tirana', name: '地拉那', modernName: 'Tirana', coordinates: [19.818883, 41.327541], imagePoint: [0.491, 0.553] },
      { id: 'athens', name: '雅典', modernName: 'Athens', coordinates: [23.731375, 37.985272], imagePoint: [0.822, 0.834] },
    ],
  },
]

export function mapForDigest(digest: string) {
  return BOOK_MAPS.find((map) => map.image.sha256 === digest) ?? null
}

export async function identifyBookMap(image: Blob, maps: readonly BookMap[] = BOOK_MAPS): Promise<BookMap | null> {
  if (!maps.some((map) => map.image.bytes === image.size)) return null
  const digest = await crypto.subtle.digest('SHA-256', await image.arrayBuffer())
  const hex = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('')
  return maps.find((map) => map.image.sha256 === hex) ?? null
}
