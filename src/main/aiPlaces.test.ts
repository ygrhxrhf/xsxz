import { describe, expect, it } from 'vitest'
import { getAiTaskPolicy } from './ai'
import {
  buildPlaceCandidates,
  buildPlaceUserPrompt,
  parsePlaceExtraction,
  PLACE_SYSTEM_PROMPT,
} from './aiPlaces'

const BODY = '洛阳城外，东行至长安。\n\n长安城内，再往洛阳。'

describe('aiPlaces 候选段落', () => {
  it('段号与阅读器一致，候选 id 稳定可引用', () => {
    const candidates = buildPlaceCandidates('c1', '第一章', BODY)
    expect(candidates.map((candidate) => candidate.paragraphIndex)).toEqual([0, 1])
    expect(candidates[0]!.id).toBe('p-c1-0')
    expect(candidates[1]!.text).toBe('长安城内，再往洛阳。')
    expect(candidates.every((candidate) => candidate.clipped === false)).toBe(true)
  })

  it('超长段落从段首截断并标记 clipped，偏移仍以段首为零点', () => {
    const long = '甲'.repeat(900)
    const candidates = buildPlaceCandidates('c1', '第一章', long)
    expect(candidates[0]!.clipped).toBe(true)
    expect(Array.from(candidates[0]!.text)).toHaveLength(800)
  })

  it('用户提示只带候选 id、章节名与原文，不带坐标', () => {
    const user = buildPlaceUserPrompt(buildPlaceCandidates('c1', '第一章', BODY))
    expect(user).toContain('p-c1-0')
    expect(user).toContain('第一章')
    expect(user).not.toContain('经纬')
  })

  it('系统提示明确禁止坐标与虚构地名', () => {
    expect(PLACE_SYSTEM_PROMPT).toContain('严禁输出经纬度')
    expect(PLACE_SYSTEM_PROMPT).toContain('candidateId')
    expect(PLACE_SYSTEM_PROMPT).toContain('逐字')
  })

  it('地名任务不强制结构化参数，兼容不支持 response_format 的模型', () => {
    const policy = getAiTaskPolicy('places')
    expect(policy.structured).toBe(false)
    expect(policy.mode).toBe('fast')
    expect(policy.maxTokens).toBe(3_000)
  })
})

describe('aiPlaces 解析与锚点', () => {
  const candidates = buildPlaceCandidates('c1', '第一章', BODY)

  it('按引文在段内的真实位置算出段内偏移', () => {
    const places = parsePlaceExtraction({
      places: [{
        candidateId: 'p-c1-0',
        name: '长安',
        kind: 'city',
        quote: '东行至长安',
      }],
    }, candidates)
    expect(places).toEqual([{
      id: 'place-c1-0-8',
      name: '长安',
      aliases: [],
      kind: 'city',
      chapterId: 'c1',
      chapterTitle: '第一章',
      paragraphIndex: 0,
      paragraphOffset: 8,
      excerpt: '东行至长安',
    }])
  })

  it('正名不在引文里时用别名定位，但仍保留正名', () => {
    const withAlias = buildPlaceCandidates('c2', '第二章', '洛城内外，人声鼎沸。')
    const places = parsePlaceExtraction({
      places: [{ candidateId: 'p-c2-0', name: '洛阳', aliases: ['洛城'], kind: 'city', quote: '洛城内外' }],
    }, withAlias)
    expect(places).toHaveLength(1)
    expect(places[0]).toMatchObject({ name: '洛阳', aliases: ['洛城'], paragraphOffset: 0 })
  })

  it('引文必须逐字出现在候选段落里', () => {
    const places = parsePlaceExtraction({
      places: [{ candidateId: 'p-c1-0', name: '长安', kind: 'city', quote: '并不存在的引文' }],
    }, candidates)
    expect(places).toEqual([])
  })

  it('地点名必须出现在引文里，编造的名字直接丢弃', () => {
    const places = parsePlaceExtraction({
      places: [{ candidateId: 'p-c1-0', name: '撒马尔罕', kind: 'city', quote: '东行至长安' }],
    }, candidates)
    expect(places).toEqual([])
  })

  it('候选 id 不认识时整条丢弃', () => {
    const places = parsePlaceExtraction({
      places: [{ candidateId: 'p-other-0', name: '长安', kind: 'city', quote: '东行至长安' }],
    }, candidates)
    expect(places).toEqual([])
  })

  it('未知 kind 回退 other，并按段落与偏移排序', () => {
    const places = parsePlaceExtraction({
      places: [
        { candidateId: 'p-c1-1', name: '洛阳', kind: 'planet', quote: '再往洛阳' },
        { candidateId: 'p-c1-0', name: '洛阳', kind: 'city', quote: '洛阳城外' },
      ],
    }, candidates)
    expect(places.map((place) => [place.paragraphIndex, place.paragraphOffset, place.kind])).toEqual([
      [0, 0, 'city'],
      [1, 7, 'other'],
    ])
  })

  it('同一段同一偏移只保留一条', () => {
    const places = parsePlaceExtraction({
      places: [
        { candidateId: 'p-c1-0', name: '长安', kind: 'city', quote: '东行至长安' },
        { candidateId: 'p-c1-0', name: '长安', kind: 'other', quote: '东行至长安' },
      ],
    }, candidates)
    expect(places).toHaveLength(1)
  })

  it('结构不是 places 数组时抛错', () => {
    expect(() => parsePlaceExtraction({}, candidates)).toThrow('地名 JSON 无法识别')
  })
})
