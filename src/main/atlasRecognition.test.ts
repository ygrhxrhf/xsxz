import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bookDir, createBookFromBootstrap, setLibraryPath } from './library'
import { setMapImage } from './mapImage'
import { setAtlasCitiesForTests, locateCity, type Bounds } from './atlasCities'
import {
  parseVisionResult,
  readMatchingRecognition,
  resolveRecognition,
  reusableRecognition,
  recognizeOriginalMap,
} from './atlasRecognition'
import type { AtlasRecognition } from '../shared/atlas'

/**
 * 书中原图自动识别：模型只给地名与现代国家代码，坐标一律来自注入的城市库。
 * 这里用合成的城市数据钉住「唯一匹配才落点」「不采信模型坐标」「缓存不重复花钱」，
 * 不发真实请求。
 */

const CITIES = [
  ['1159112629', 'London', 'GB', -0.118668, 51.501941, ['London']],
  ['1159112647', 'Paris', 'FR', 2.352992, 48.858092, ['Paris']],
  ['1159112663', 'Springfield', 'US', -89.65, 39.79, ['Springfield']],
  ['1159112679', 'Springfield', 'US', -72.52, 42.11, ['Springfield']],
  ['1159112703', 'Tokyo', 'JP', 139.7, 35.68, ['Tokyo']],
] as Array<[string, string, string, number, number, string[]]>

function vision(overrides: Record<string, unknown> = {}) {
  return {
    isMap: true,
    confidence: 0.97,
    title: '西欧',
    period: '1940',
    number: '1',
    bounds: [[-12, 35], [16, 64]] as Bounds,
    places: [
      { name: '伦敦', modernName: 'London', countryCode: 'GB', confidence: 0.96, imagePoint: [0.5, 0.4] },
      { name: '巴黎', modernName: 'Paris', countryCode: 'FR', confidence: 0.98, imagePoint: [0.6, 0.6] },
      { name: '不明小镇', modernName: 'Made Up Town', countryCode: 'FR', confidence: 0.9, imagePoint: null },
    ],
    ...overrides,
  }
}

const OK_COMPLETION = (content: unknown) => ({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
  usage: { prompt_tokens: 2000, completion_tokens: 300, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 1900 },
})

beforeEach(() => setAtlasCitiesForTests(CITIES))
afterEach(() => setAtlasCitiesForTests(null))

describe('parseVisionResult', () => {
  it('拒绝不合法的国家代码、越界区域与非数字 confidence', () => {
    expect(parseVisionResult(null)).toBeNull()
    expect(parseVisionResult({ isMap: 'yes', confidence: 0.9, places: [] })).toBeNull()
    const invalidCountry = { ...vision(), places: [{ ...vision().places[0]!, countryCode: 'United Kingdom' }] }
    expect(parseVisionResult(invalidCountry)?.places).toEqual([])
    expect(parseVisionResult({ ...vision(), bounds: [[0, -95], [20, 50]] })?.bounds).toBeNull()
    expect(parseVisionResult({ ...vision(), bounds: [[0, 40], [0, 50]] })?.bounds).toBeNull()
    expect(parseVisionResult({ ...vision(), confidence: '0.9' })).toBeNull()
  })

  it('保留缺失的图名与年代为空串，并对候选数量设上限', () => {
    const parsed = parseVisionResult({ ...vision(), title: null, period: null, number: null })
    expect(parsed).toMatchObject({ title: '', period: '', number: '' })
    const many = { ...vision(), places: Array.from({ length: 80 }, () => vision().places[0]) }
    expect(parseVisionResult(many)?.places.length).toBe(64)
  })
})

describe('resolveRecognition', () => {
  const image = { sha256: 'a'.repeat(64), bytes: 100 }

  it('确定的非地图单独返回，不建地图', async () => {
    const parsed = parseVisionResult({ isMap: false, confidence: 0.99, places: [] })!
    const result = await resolveRecognition(parsed, image, 'test-model')
    expect(result).toMatchObject({ status: 'not_map', map: null })
  })

  it('区域不可靠时给 uncertain，不用模型坐标补齐', async () => {
    const parsed = parseVisionResult(vision({ confidence: 0.5 }))!
    expect((await resolveRecognition(parsed, image, 'test-model')).status).toBe('uncertain')
    const onlyUnmatched = vision({ places: [vision().places[2]] })
    expect((await resolveRecognition(parseVisionResult(onlyUnmatched)!, image, 'test-model')).status).toBe('uncertain')
  })

  it('只按城市库落点，列出未匹配地名', async () => {
    const result = await resolveRecognition(parseVisionResult(vision())!, image, 'test-model')
    expect(result.status).toBe('recognized')
    const map = result.map!
    expect(map.places.map((place) => place.name)).toEqual(['伦敦', '巴黎'])
    expect(map.places[0]!.coordinates).toEqual([-0.118668, 51.501941])
    expect(map.recognition?.unresolved).toEqual(['不明小镇'])
    expect(map.image).toEqual(image)
    expect(map.title).toBe('西欧')
  })

  it('同名城市保持未定位，不按人口或知名度挑一个', async () => {
    const ambiguous = vision({ places: [
      { name: '春田', modernName: 'Springfield', countryCode: 'US', confidence: 0.95, imagePoint: [0.4, 0.5] },
    ] })
    const result = await resolveRecognition(parseVisionResult(ambiguous)!, image, 'test-model')
    expect(result.status).toBe('uncertain')
  })

  it('跨日期变更线的图幅不交换经纬度', async () => {
    const pacific = vision({
      bounds: [[120, -50], [250, 65]],
      places: [{ name: '东京', modernName: 'Tokyo', countryCode: 'JP', confidence: 0.98, imagePoint: [0.1, 0.2] }],
    })
    const result = await resolveRecognition(parseVisionResult(pacific)!, image, 'test-model')
    expect(result.status).toBe('recognized')
    expect(result.map!.center).toEqual([-175, 7.5])
  })
})

describe('locateCity', () => {
  it('区域外的唯一候选不算匹配，边缘城市先扩框再判断', async () => {
    expect(await locateCity('Tokyo', 'JP', [[-12, 35], [16, 64]])).toBeNull()
    expect((await locateCity('London', 'GB', [[-12, 35], [16, 64]]))?.[1]).toBe('London')
  })

  it('国家不符时匹配不到', async () => {
    expect(await locateCity('Paris', 'US', [[-12, 35], [16, 64]])).toBeNull()
    expect(await locateCity('Invented', 'FR', null)).toBeNull()
  })
})

describe('reusableRecognition', () => {
  const result: AtlasRecognition = {
    status: 'recognized',
    map: null,
    message: '',
    model: 'test-model',
    recognizedAt: 0,
    cached: false,
  }

  it('成功结果 30 天、不确定结果 1 天、确定的非地图长期有效', () => {
    expect(reusableRecognition(result, true, 29 * 86_400_000)).toBe(true)
    expect(reusableRecognition(result, true, 31 * 86_400_000)).toBe(false)
    expect(reusableRecognition(result, false, 0)).toBe(false)
    expect(reusableRecognition({ ...result, status: 'uncertain' }, true, 2 * 86_400_000)).toBe(false)
    expect(reusableRecognition({ ...result, status: 'not_map' }, false, 400 * 86_400_000)).toBe(true)
  })
})

describe('recognizeOriginalMap', () => {
  let lib = ''
  let source = ''

  beforeEach(async () => {
    lib = await mkdtemp(join(tmpdir(), 'spbf-atlas-lib-'))
    source = await mkdtemp(join(tmpdir(), 'spbf-atlas-src-'))
    await setLibraryPath(lib)
    await createBookFromBootstrap({ bookId: 'd_atlas', title: '地图书', author: '', importType: 'txt', chapterTitles: ['第一章'] })
  })

  afterEach(async () => {
    await rm(lib, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  })

  it('没有原图时不发请求', async () => {
    const fetchImpl = vi.fn()
    const result = await recognizeOriginalMap('d_atlas', { config: { baseUrl: 'https://llm.test/v1', model: 'm', apiKey: 'k' }, bookTitle: '地图书', fetchImpl })
    expect(result).toMatchObject({ ok: false, message: '还没有书中原图，请先选择图片' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('识别成功写缓存，第二次直接复用不再请求；refresh 绕过缓存', async () => {
    const png = join(source, 'map.png')
    // 最小 PNG 魔数足够让 imageMime 认出位图。
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]))
    expect((await setMapImage('d_atlas', png)).ok).toBe(true)
    const config = { baseUrl: 'https://llm.test/v1', model: 'deepseek-flash', apiKey: 'k' }
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: unknown }> }
      expect(body.messages[1]!.content).toMatchObject([{ type: 'text' }, { type: 'image_url' }])
      return new Response(JSON.stringify(OK_COMPLETION(vision())), { status: 200 })
    }) as unknown as typeof fetch
    const first = await recognizeOriginalMap('d_atlas', { config, bookTitle: '地图书', fetchImpl })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.recognition.status).toBe('recognized')
    expect(first.recognition.cached).toBe(false)
    expect(first.usage).toMatchObject({ inputTokens: 2000, outputTokens: 300 })
    expect((vi.mocked(fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls)).toHaveLength(1)

    const second = await recognizeOriginalMap('d_atlas', { config, bookTitle: '地图书', fetchImpl })
    expect(second.ok && second.recognition.cached).toBe(true)
    expect((vi.mocked(fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls)).toHaveLength(1)

    const refreshed = await recognizeOriginalMap('d_atlas', { config, bookTitle: '地图书', fetchImpl, refresh: true })
    expect(refreshed.ok && refreshed.recognition.cached).toBe(false)
    expect((vi.mocked(fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls)).toHaveLength(2)
  })

  it('失败与截断的结果不写缓存，重试时会重新请求', async () => {
    const png = join(source, 'map.png')
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]))
    await setMapImage('d_atlas', png)
    const config = { baseUrl: 'https://llm.test/v1', model: 'm', apiKey: 'k' }
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('upstream details', { status: 500 })
      if (calls === 2) return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }), { status: 200 })
      return new Response(JSON.stringify(OK_COMPLETION(vision())), { status: 200 })
    }) as unknown as typeof fetch

    expect((await recognizeOriginalMap('d_atlas', { config, bookTitle: '地图书', fetchImpl })).ok).toBe(false)
    expect((await recognizeOriginalMap('d_atlas', { config, bookTitle: '地图书', fetchImpl })).ok).toBe(false)
    const third = await recognizeOriginalMap('d_atlas', { config, bookTitle: '地图书', fetchImpl })
    expect(third.ok).toBe(true)
    expect(calls).toBe(3)
    expect(third.ok && third.recognition.cached).toBe(false)
  })

  it('缓存跟着原图指纹走：换了图就不再复用旧结论', async () => {
    const config = { baseUrl: 'https://llm.test/v1', model: 'm', apiKey: 'k' }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(OK_COMPLETION(vision())), { status: 200 })) as unknown as typeof fetch
    const first = join(source, 'a.png')
    await writeFile(first, Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1]))
    await setMapImage('d_atlas', first)
    expect((await recognizeOriginalMap('d_atlas', { config, bookTitle: '地图书', fetchImpl })).ok).toBe(true)
    expect((await readMatchingRecognition('d_atlas'))?.status).toBe('recognized')

    const second = join(source, 'b.png')
    await writeFile(second, Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 2]))
    await setMapImage('d_atlas', second)
    // 换图后，界面只读到的结论必须为空：不能把上一张图的地名画到新图上。
    expect(await readMatchingRecognition('d_atlas')).toBeNull()
    const after = await recognizeOriginalMap('d_atlas', { config, bookTitle: '地图书', fetchImpl })
    expect(after.ok && after.recognition.cached).toBe(false)
    expect((await readMatchingRecognition('d_atlas'))?.status).toBe('recognized')
    expect(bookDir('d_atlas')).toContain('d_atlas')
  })
})
