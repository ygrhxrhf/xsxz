import { describe, expect, it } from 'vitest'
import { textBookMap, textMapExtent, textPlacesFrom } from './mapPins'
import type { AiPlaceGeo } from '@shared/types'

function place(overrides: Partial<AiPlaceGeo> & { id: string; name: string }): AiPlaceGeo {
  return {
    aliases: [],
    kind: 'city',
    chapterId: 'c1',
    chapterTitle: '第一章',
    paragraphIndex: 0,
    paragraphOffset: 0,
    excerpt: '',
    geocodeStatus: 'resolved',
    location: { latitude: 48.85, longitude: 2.35 },
    ...overrides,
  }
}

describe('textPlacesFrom', () => {
  it('只取已确认定位且坐标合法的地点，按 id 去重', () => {
    const places: AiPlaceGeo[] = [
      place({ id: 'a', name: '巴黎' }),
      place({ id: 'a', name: '巴黎（重复）' }),
      place({ id: 'b', name: '未定位', geocodeStatus: 'not-found', location: undefined }),
      place({ id: 'c', name: '已忽略', geocodeStatus: 'ignored', location: undefined }),
      place({ id: 'd', name: '待确认', geocodeStatus: 'ambiguous', location: { latitude: 35, longitude: 139 } }),
      place({ id: 'e', name: '越界', location: { latitude: 200, longitude: 0 } }),
    ]
    const out = textPlacesFrom(places)
    expect(out.map((item) => item.id)).toEqual(['a'])
    expect(out[0]).toMatchObject({ name: '巴黎', latitude: 48.85, longitude: 2.35 })
  })

  it('没有坐标的解析结果不进入地图', () => {
    expect(textPlacesFrom([place({ id: 'x', name: '无坐标', location: undefined })])).toEqual([])
  })
})

describe('textMapExtent', () => {
  it('单点也能给出可用的最小范围', () => {
    const extent = textMapExtent([[2.35, 48.85]])
    expect(extent.bounds[0][1]).toBeLessThan(48.85)
    expect(extent.bounds[1][1]).toBeGreaterThan(48.85)
    expect(extent.center[1]).toBeCloseTo(48.85, 5)
  })

  it('跨日期变更线时取短弧而不是绕全球', () => {
    const extent = textMapExtent([[179, 10], [-179, -10]])
    const width = extent.bounds[1][0] - extent.bounds[0][0]
    expect(width).toBeLessThan(10)
  })
})

describe('textBookMap', () => {
  it('没有地点时返回 null，避免画一张空地图', () => {
    expect(textBookMap([])).toBeNull()
    expect(textBookMap([place({ id: 'n', name: '未定位', geocodeStatus: 'not-found', location: undefined })])).toBeNull()
  })

  it('把地点转成没有原图的地图，范围覆盖所有点', () => {
    const map = textBookMap([place({ id: 'a', name: '巴黎' }), place({ id: 'b', name: '柏林', location: { latitude: 52.52, longitude: 13.4 } })])
    expect(map).not.toBeNull()
    expect(map!.id).toBe('text-book')
    expect(map!.image).toEqual({ sha256: '', bytes: 0 })
    expect(map!.places.map((item) => item.id)).toEqual(['a', 'b'])
    expect(map!.places.every((item) => item.imagePoint === null)).toBe(true)
    const [[west, south], [east, north]] = map!.bounds
    expect(west).toBeLessThanOrEqual(2.35)
    expect(east).toBeGreaterThanOrEqual(13.4)
    expect(south).toBeLessThanOrEqual(48.85)
    expect(north).toBeGreaterThanOrEqual(52.52)
  })
})
