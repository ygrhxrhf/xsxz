import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bookDir, createBookFromBootstrap, setLibraryPath } from './library'
import {
  MANUAL_PLACE_ID_PREFIX,
  addManualPlace,
  buildManualPlace,
  isManualPlaceId,
  manualPlaceId,
  mergeManualPlace,
  validateManualPlace,
} from './mapManualPlace'
import { readPlaces } from './mapPlaces'
import type { AiPlaceGeo } from '../shared/types'

/**
 * 手工标注的契约：
 *   - 坐标由本人给定，**不消耗腾讯配额**（本模块不发任何网络请求）；
 *   - 纬度 -90–90、经度 -180–180、地名非空，越界一律中文错误；
 *   - 正文锚点可选，给了就能从地图跳回正文；
 *   - 与自动抽取的地名写在同一份按书存储里，互不覆盖。
 */
describe('mapManualPlace 手工标注', () => {
  it('坐标越界、名字为空都给出中文错误', () => {
    expect(validateManualPlace({ name: '  ', latitude: 0, longitude: 0 }))
      .toEqual({ ok: false, message: '地名不能为空' })
    expect(validateManualPlace({ name: '长安', latitude: 91, longitude: 0 }))
      .toEqual({ ok: false, message: '纬度须在 -90 到 90 之间' })
    expect(validateManualPlace({ name: '长安', latitude: -90.1, longitude: 0 }))
      .toEqual({ ok: false, message: '纬度须在 -90 到 90 之间' })
    expect(validateManualPlace({ name: '长安', latitude: 0, longitude: 181 }))
      .toEqual({ ok: false, message: '经度须在 -180 到 180 之间' })
    expect(validateManualPlace({ name: '长安', latitude: 0, longitude: -180.1 }))
      .toEqual({ ok: false, message: '经度须在 -180 到 180 之间' })
    expect(validateManualPlace({ name: '长安', latitude: 'abc', longitude: 0 }))
      .toEqual({ ok: false, message: '纬度必须是数字' })
    expect(validateManualPlace({ name: '长安', latitude: 0, longitude: 'abc' }))
      .toEqual({ ok: false, message: '经度必须是数字' })
  })

  it('边界值合法：纬度 ±90、经度 ±180 都放行', () => {
    const north = validateManualPlace({ name: '北极', latitude: 90, longitude: 180 })
    expect(north.ok).toBe(true)
    if (!north.ok) return
    expect(north.latitude).toBe(90)
    expect(north.longitude).toBe(180)

    const south = validateManualPlace({ name: '南极', latitude: -90, longitude: -180 })
    expect(south.ok).toBe(true)
    if (!south.ok) return
    expect(south.latitude).toBe(-90)
    expect(south.longitude).toBe(-180)
  })

  it('类型缺省为 other，非法类型也回落到 other', () => {
    const fallback = validateManualPlace({ name: '某处', latitude: 1, longitude: 2 })
    expect(fallback.ok).toBe(true)
    if (fallback.ok) expect(fallback.kind).toBe('other')

    const city = validateManualPlace({ name: '长安', latitude: 1, longitude: 2, kind: 'city' })
    expect(city.ok).toBe(true)
    if (city.ok) expect(city.kind).toBe('city')

    const bogus = validateManualPlace({ name: '长安', latitude: 1, longitude: 2, kind: 'moon' })
    expect(bogus.ok).toBe(true)
    if (bogus.ok) expect(bogus.kind).toBe('other')
  })

  it('正文锚点可选：给了段号就带偏移，没给就没有锚点', () => {
    const anchored = validateManualPlace({ name: '长安', latitude: 34.2, longitude: 108.9, paragraphIndex: 3, paragraphOffset: 12 })
    expect(anchored.ok).toBe(true)
    if (!anchored.ok) return
    expect(anchored.paragraphIndex).toBe(3)
    expect(anchored.paragraphOffset).toBe(12)

    // 只给段号：段内偏移缺省 0，跳到段首。
    const onlyIndex = validateManualPlace({ name: '长安', latitude: 34.2, longitude: 108.9, paragraphIndex: 3 })
    expect(onlyIndex.ok).toBe(true)
    if (onlyIndex.ok) {
      expect(onlyIndex.paragraphIndex).toBe(3)
      expect(onlyIndex.paragraphOffset).toBe(0)
    }

    // 完全不给锚点：这条地名只作地图标记，跳不回正文。
    const free = validateManualPlace({ name: '长安', latitude: 34.2, longitude: 108.9 })
    expect(free.ok).toBe(true)
    if (free.ok) expect(free.paragraphIndex).toBeUndefined()
  })

  it('锚点必须是非负整数', () => {
    expect(validateManualPlace({ name: '长安', latitude: 1, longitude: 2, paragraphIndex: -1 }))
      .toEqual({ ok: false, message: '正文段号必须是非负整数' })
    expect(validateManualPlace({ name: '长安', latitude: 1, longitude: 2, paragraphIndex: 1.5 }))
      .toEqual({ ok: false, message: '正文段号必须是非负整数' })
    expect(validateManualPlace({ name: '长安', latitude: 1, longitude: 2, paragraphIndex: 1, paragraphOffset: -2 }))
      .toEqual({ ok: false, message: '段内偏移必须是非负整数' })
  })

  it('id 规则与既有 AiPlace.id 风格一致：手工项有固定前缀', () => {
    expect(manualPlaceId({ paragraphIndex: 2, paragraphOffset: 5 })).toBe(`${MANUAL_PLACE_ID_PREFIX}anchor-2-5`)
    expect(isManualPlaceId(manualPlaceId({ paragraphIndex: 2, paragraphOffset: 5 }))).toBe(true)
    expect(isManualPlaceId('place-c1-0-8')).toBe(false)

    // 无锚点的手工项按已有条数递增，不与别的条目撞号。
    const previous = [
      { id: `${MANUAL_PLACE_ID_PREFIX}free-0` },
      { id: 'place-c1-0-8' },
    ] as AiPlaceGeo[]
    expect(manualPlaceId({}, previous)).toBe(`${MANUAL_PLACE_ID_PREFIX}free-1`)
    expect(manualPlaceId({})).toBe(`${MANUAL_PLACE_ID_PREFIX}free-0`)
  })

  it('构造的地名词条带坐标且直接算已定位', () => {
    const validated = validateManualPlace({ name: '长安', latitude: 34.2, longitude: 108.9, paragraphIndex: 1, paragraphOffset: 4 })
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    const place = buildManualPlace(validated, `${MANUAL_PLACE_ID_PREFIX}anchor-1-4`)
    expect(place).toMatchObject({
      id: `${MANUAL_PLACE_ID_PREFIX}anchor-1-4`,
      name: '长安',
      kind: 'other',
      paragraphIndex: 1,
      paragraphOffset: 4,
      geocodeStatus: 'resolved',
    })
    expect(place.location).toMatchObject({ latitude: 34.2, longitude: 108.9 })
  })

  it('合并进既有列表：不同 id 追加，同 id 覆盖，既有条目不动', () => {
    const existing: AiPlaceGeo[] = [{
      id: 'place-c1-0-8',
      name: '长安',
      aliases: [],
      kind: 'city',
      chapterId: 'c1',
      chapterTitle: '第一章',
      paragraphIndex: 0,
      paragraphOffset: 8,
      excerpt: '东行至长安',
      geocodeStatus: 'resolved',
      location: { latitude: 34.2, longitude: 108.9 },
    }]
    const manual = buildManualPlace(
      { ok: true, name: '洛阳', latitude: 34.6, longitude: 112.4, kind: 'other' },
      `${MANUAL_PLACE_ID_PREFIX}free-0`,
    )
    const merged = mergeManualPlace(existing, manual)
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual(existing[0])
    expect(merged[1]!.id).toBe(`${MANUAL_PLACE_ID_PREFIX}free-0`)

    // 同 id 再标一次 = 改坐标，不新增条目。
    const updated = buildManualPlace(
      { ok: true, name: '洛阳', latitude: 34.7, longitude: 112.5, kind: 'other' },
      `${MANUAL_PLACE_ID_PREFIX}free-0`,
    )
    const again = mergeManualPlace(merged, updated)
    expect(again).toHaveLength(2)
    expect(again[1]!.location).toMatchObject({ latitude: 34.7, longitude: 112.5 })
  })
})

describe('mapManualPlace 落盘', () => {
  let lib = ''

  beforeEach(async () => {
    lib = await mkdtemp(join(tmpdir(), 'spbf-map-manual-lib-'))
    await setLibraryPath(lib)
    await createBookFromBootstrap({ bookId: 'd_manual', title: '手工', author: '', importType: 'txt', chapterTitles: ['第一章'] })
  })

  afterEach(async () => {
    await rm(lib, { recursive: true, force: true })
  })

  it('写入按书地点存储，与自动抽取的地名共存', async () => {
    const extracted: AiPlaceGeo = {
      id: 'place-c1-0-8',
      name: '长安',
      aliases: [],
      kind: 'city',
      chapterId: 'c1',
      chapterTitle: '第一章',
      paragraphIndex: 0,
      paragraphOffset: 8,
      excerpt: '东行至长安',
      geocodeStatus: 'pending',
    }
    await writeFile(
      join(bookDir('d_manual'), 'ai', 'places.json'),
      JSON.stringify({ version: 1, places: [extracted] }),
      'utf-8',
    )

    const result = await addManualPlace('d_manual', {
      name: '洛阳',
      latitude: 34.6,
      longitude: 112.4,
      paragraphIndex: 2,
      paragraphOffset: 6,
    })
    expect(result.place.id).toBe(`${MANUAL_PLACE_ID_PREFIX}anchor-2-6`)
    expect(result.place.location).toMatchObject({ latitude: 34.6, longitude: 112.4 })
    expect(result.places).toHaveLength(2)
    // 原有条目原样保留：手工标注不动别人抽出来的地名。
    expect(result.places[0]).toEqual(extracted)

    const stored = await readPlaces('d_manual')
    expect(stored).toHaveLength(2)
    const manual = stored.find((place) => place.id === `${MANUAL_PLACE_ID_PREFIX}anchor-2-6`)
    expect(manual?.location).toMatchObject({ latitude: 34.6, longitude: 112.4 })
    expect(manual?.geocodeStatus).toBe('resolved')
    // 落盘文件仍是既有 places.json 的形状。
    const raw = JSON.parse(await readFile(join(bookDir('d_manual'), 'ai', 'places.json'), 'utf-8')) as { version: number; places: unknown[] }
    expect(raw.version).toBe(1)
    expect(raw.places).toHaveLength(2)
  })

  it('非法入参不写盘', async () => {
    await expect(addManualPlace('d_manual', { name: '', latitude: 0, longitude: 0 }))
      .rejects.toThrow('地名不能为空')
    await expect(addManualPlace('d_manual', { name: '长安', latitude: 91, longitude: 0 }))
      .rejects.toThrow('纬度须在 -90 到 90 之间')
    // 没有写过就没有 places.json。
    await expect(readFile(join(bookDir('d_manual'), 'ai', 'places.json'), 'utf-8')).rejects.toThrow()
  })

  it('同一锚点重复标注就是改坐标，不新增条目', async () => {
    const first = await addManualPlace('d_manual', { name: '长安', latitude: 34.2, longitude: 108.9, paragraphIndex: 1, paragraphOffset: 2 })
    const second = await addManualPlace('d_manual', { name: '长安', latitude: 34.3, longitude: 109.0, paragraphIndex: 1, paragraphOffset: 2 })
    expect(second.place.id).toBe(first.place.id)
    expect(second.places).toHaveLength(1)
    expect(second.places[0]!.location).toMatchObject({ latitude: 34.3, longitude: 109.0 })
  })
})
