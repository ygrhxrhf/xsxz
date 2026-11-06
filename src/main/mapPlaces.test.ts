import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bookDir, createBookFromBootstrap, setLibraryPath } from './library'
import {
  boundaryForPlace,
  buildGeocoderUrl,
  choosePlaceCandidate,
  confirmPlace,
  geocodeStatusFor,
  mergePlaceGeo,
  MANUAL_PLACE_ID_PREFIX,
  parseDistrictResponse,
  parseGeocoderResponse,
  parsePlaceSearchResponse,
  readPlaces,
  resolvePlace,
} from './mapPlaces'
import type { AiPlace, AiPlaceGeo } from '../shared/types'

const PLACE: AiPlace = {
  id: 'place-c1-0-8',
  name: '长安',
  aliases: [],
  kind: 'city',
  chapterId: 'c1',
  chapterTitle: '第一章',
  paragraphIndex: 0,
  paragraphOffset: 8,
  excerpt: '东行至长安',
}

describe('mapPlaces 地理编码', () => {
  it('地址与 Key 都经 URL 编码，可选 region 进查询参数', () => {
    const url = new URL(buildGeocoderUrl('长安 城', 'test-key', '陕西省'))
    expect(url.origin + url.pathname).toBe('https://apis.map.qq.com/ws/geocoder/v1/')
    expect(url.searchParams.get('address')).toBe('长安 城')
    expect(url.searchParams.get('key')).toBe('test-key')
    expect(url.searchParams.get('region')).toBe('陕西省')
    expect(url.searchParams.get('output')).toBe('json')
  })

  it('解析成功响应里的坐标、可信度与精度', () => {
    expect(parseGeocoderResponse({
      status: 0,
      result: { location: { lat: 34.2, lng: 108.9 }, reliability: 8, level: '城市' },
    })).toEqual({
      ok: true,
      message: '',
      location: { latitude: 34.2, longitude: 108.9, reliability: 8, level: '城市' },
    })
  })

  it('Key 未授权 WebService 时给出可照做的提示并标记 fatal', () => {
    const result = parseGeocoderResponse({ status: 110, message: '请求来源未被授权' })
    expect(result.ok).toBe(false)
    expect(result.fatal).toBe(true)
    expect(result.message).toContain('WebService API')
  })

  it('配额用尽 / 频率超限分别给出中文说明', () => {
    expect(parseGeocoderResponse({ status: 120 }).message).toContain('配额')
    expect(parseGeocoderResponse({ status: 121 }).message).toContain('频率')
  })

  it('没有坐标时不算解析成功', () => {
    const result = parseGeocoderResponse({ status: 0, result: { location: {} } })
    expect(result.ok).toBe(false)
  })

  it('行政区划接口返回省/市中心点，国家级结果可信度低', () => {
    const province = parseDistrictResponse({
      status: 0,
      result: [[{ name: '江苏', fullname: '江苏省', level: 'province', location: { lat: 32.06, lng: 118.79 } }]],
    })
    expect(province).toMatchObject({
      ok: true,
      location: { latitude: 32.06, longitude: 118.79, level: 'province', reliability: 8, source: 'district' },
    })
    const country = parseDistrictResponse({
      status: 0,
      result: [[{ name: '中国', fullname: '中国', level: 'country', location: { lat: 35.86, lng: 104.19 } }]],
    })
    expect(country.ok).toBe(true)
    if (country.ok) expect(country.location?.reliability).toBe(4)
    expect(parseDistrictResponse({ status: 0, result: [] }).ok).toBe(false)
    expect(parseDistrictResponse({ status: 110 }).fatal).toBe(true)
  })

  it('回退链：地址解析无结果时改走行政区划', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('/district/')) {
        return { ok: true, json: async () => ({ status: 0, result: [[{ name: '江苏', level: 'province', location: { lat: 32.06, lng: 118.79 } }]] }) }
      }
      return { ok: true, json: async () => ({ status: 311, message: 'no result' }) }
    }) as unknown as typeof fetch
    const result = await resolvePlace('江苏', 'test-key', fetchImpl)
    expect(result.ok).toBe(true)
    expect(result.location).toMatchObject({ latitude: 32.06, longitude: 118.79, source: 'district' })
  })

  it('回退链：国名用中心点，标为低可信度待确认', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ status: 311, message: 'no result' }) })) as unknown as typeof fetch
    const result = await resolvePlace('中国', 'test-key', fetchImpl)
    expect(result.ok).toBe(true)
    expect(result.location).toMatchObject({ latitude: 35.8617, longitude: 104.1954, source: 'country', reliability: 3 })
    expect(geocodeStatusFor(result)).toBe('ambiguous')
  })

  it('解析地点搜索候选，跳过缺坐标条目', () => {
    const candidates = parsePlaceSearchResponse({
      status: 0,
      data: [
        { id: 'poi-1', title: '常州站', address: '江苏省常州市', location: { lat: 31.79, lng: 119.97 }, category: '交通' },
        { id: 'poi-2', title: '缺坐标', address: '' },
      ],
    })
    expect(candidates).toEqual([{
      id: 'poi-1', title: '常州站', address: '江苏省常州市', latitude: 31.79, longitude: 119.97, category: '交通',
    }])
    expect(() => parsePlaceSearchResponse({ status: 110 })).toThrow('WebService API')
  })

  it('boundary 优先用自身城市，其次最近有城市的地点，最后用最近坐标 nearby', () => {
    const self = { ...PLACE, geocodeStatus: 'resolved' as const, location: { latitude: 31, longitude: 121, region: '上海市' } }
    expect(boundaryForPlace(self, [self])).toBe('region(上海市,0)')

    const noRegion = { ...PLACE, id: 'a', geocodeStatus: 'resolved' as const, location: { latitude: 31, longitude: 121 } }
    const withRegion = { ...PLACE, id: 'b', geocodeStatus: 'resolved' as const, location: { latitude: 32, longitude: 119, region: '江苏省' } }
    expect(boundaryForPlace(noRegion, [noRegion, withRegion])).toBe('region(江苏省,0)')

    const near = { ...PLACE, id: 'c', geocodeStatus: 'resolved' as const, location: { latitude: 30, longitude: 120 } }
    expect(boundaryForPlace(noRegion, [noRegion, near])).toBe('nearby(30,120,50000,1)')
    expect(boundaryForPlace(noRegion, [noRegion])).toBeNull()

    const country = { ...PLACE, id: 'd', geocodeStatus: 'ambiguous' as const, location: { latitude: 35.8, longitude: 104.1, level: 'country', source: 'country' as const } }
    expect(boundaryForPlace(country, [country])).toBeNull()
  })

  it('可信度低于 6 标为待确认，6 及以上直接算已定位', () => {
    expect(geocodeStatusFor({ ok: true, message: '', location: { latitude: 1, longitude: 2, reliability: 5 } })).toBe('ambiguous')
    expect(geocodeStatusFor({ ok: true, message: '', location: { latitude: 1, longitude: 2, reliability: 6 } })).toBe('resolved')
    expect(geocodeStatusFor({ ok: true, message: '', location: { latitude: 1, longitude: 2 } })).toBe('resolved')
    expect(geocodeStatusFor({ ok: false, message: 'no' })).toBe('not-found')
  })

  it('重新抽取时按地名 id 保留已解析坐标，新条目保持待定位', () => {
    const previous: AiPlaceGeo[] = [{
      ...PLACE,
      geocodeStatus: 'resolved',
      location: { latitude: 34.2, longitude: 108.9 },
    }]
    const next: AiPlace[] = [PLACE, { ...PLACE, id: 'place-c1-1-0', paragraphIndex: 1, paragraphOffset: 0 }]
    const merged = mergePlaceGeo(previous, next)
    expect(merged[0]).toMatchObject({
      geocodeStatus: 'resolved',
      location: { latitude: 34.2, longitude: 108.9 },
    })
    expect(merged[1]!.geocodeStatus).toBe('pending')
    expect(merged[1]!.location).toBeUndefined()
  })

  it('重新抽取时保留手工标注的条目：模型没提到它也不能被抹掉', () => {
    const manual: AiPlaceGeo = {
      id: `${MANUAL_PLACE_ID_PREFIX}free-0`,
      name: '长安',
      aliases: [],
      kind: 'city',
      chapterId: '',
      chapterTitle: '手工标注',
      paragraphIndex: 0,
      paragraphOffset: 0,
      excerpt: '',
      geocodeStatus: 'resolved',
      location: { latitude: 34.2, longitude: 108.9 },
    }
    const previous: AiPlaceGeo[] = [{ ...PLACE, geocodeStatus: 'resolved' }, manual]
    // 模型这次只抽出了另一个地名，压根没提手工标的那条
    const next: AiPlace[] = [{ ...PLACE, id: 'place-c1-1-0', paragraphIndex: 1, paragraphOffset: 0 }]
    const merged = mergePlaceGeo(previous, next)
    expect(merged.map((place) => place.id)).toContain(manual.id)
    expect(merged.find((place) => place.id === manual.id)).toEqual(manual)
  })

  it('重新抽取时手工标注与模型条目 id 相撞，以模型那次为准', () => {
    const id = `${MANUAL_PLACE_ID_PREFIX}anchor-1-4`
    const previous: AiPlaceGeo[] = [{
      ...PLACE,
      id,
      geocodeStatus: 'resolved',
      location: { latitude: 1, longitude: 2 },
    }]
    const next: AiPlace[] = [{ ...PLACE, id }]
    const merged = mergePlaceGeo(previous, next)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.id).toBe(id)
  })
})

describe('mapPlaces 歧义确认落盘', () => {
  let lib = ''

  beforeEach(async () => {
    lib = await mkdtemp(join(tmpdir(), 'spbf-map-places-lib-'))
    await setLibraryPath(lib)
    await createBookFromBootstrap({ bookId: 'd_map', title: '地图', author: '', importType: 'txt', chapterTitles: ['第一章'] })
    const places = [
      { ...PLACE, geocodeStatus: 'ambiguous', location: { latitude: 34.2, longitude: 108.9, reliability: 5 } },
      { ...PLACE, id: 'place-c1-1-0', paragraphIndex: 1, paragraphOffset: 0, geocodeStatus: 'ambiguous', location: { latitude: 31.2, longitude: 121.5, reliability: 4 } },
    ]
    await writeFile(join(bookDir('d_map'), 'ai', 'places.json'), JSON.stringify({ version: 1, places }), 'utf-8')
  })

  afterEach(async () => {
    await rm(lib, { recursive: true, force: true })
  })

  it('确认保留坐标并改为 resolved，忽略则撤点并记为 ignored', async () => {
    const accepted = await confirmPlace('d_map', PLACE.id, true)
    expect(accepted?.place.geocodeStatus).toBe('resolved')
    expect(accepted?.place.location?.latitude).toBe(34.2)

    const ignored = await confirmPlace('d_map', 'place-c1-1-0', false)
    expect(ignored?.place.geocodeStatus).toBe('ignored')
    expect(ignored?.place.location).toBeUndefined()

    const stored = await readPlaces('d_map')
    expect(stored.find((place) => place.id === PLACE.id)?.geocodeStatus).toBe('resolved')
    expect(stored.find((place) => place.id === 'place-c1-1-0')?.geocodeStatus).toBe('ignored')
    expect(await readFile(join(bookDir('d_map'), 'ai', 'places.json'), 'utf-8')).toContain('ignored')
  })

  it('读取缓存时保留 region 与 source，候选 boundary 才能复用城市', async () => {
    await writeFile(join(bookDir('d_map'), 'ai', 'places.json'), JSON.stringify({
      version: 1,
      places: [{
        ...PLACE,
        geocodeStatus: 'resolved',
        location: { latitude: 31.8, longitude: 119.9, reliability: 7, level: 'city', region: '常州市', source: 'geocoder' },
      }],
    }), 'utf-8')
    const stored = await readPlaces('d_map')
    expect(stored[0]!.location).toMatchObject({ region: '常州市', source: 'geocoder' })
  })

  it('选择候选后写入坐标并标为已定位', async () => {
    const result = await choosePlaceCandidate('d_map', PLACE.id, { latitude: 32.06, longitude: 118.79 })
    expect(result?.place.geocodeStatus).toBe('resolved')
    expect(result?.place.location).toMatchObject({ latitude: 32.06, longitude: 118.79, reliability: 9, source: 'search' })
    const stored = await readPlaces('d_map')
    expect(stored.find((place) => place.id === PLACE.id)?.location).toMatchObject({ latitude: 32.06, longitude: 118.79 })
    expect(await choosePlaceCandidate('d_map', PLACE.id, { latitude: 999, longitude: 0 })).toBeNull()
  })

  it('没有坐标的地点不能确认', async () => {
    await writeFile(join(bookDir('d_map'), 'ai', 'places.json'), JSON.stringify({
      version: 1,
      places: [{ ...PLACE, geocodeStatus: 'pending' }],
    }), 'utf-8')
    expect(await confirmPlace('d_map', PLACE.id, true)).toBeNull()
  })
})
