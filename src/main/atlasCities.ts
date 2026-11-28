/**
 * 书中地图识别用的城市坐标库（Natural Earth 1:10m populated places）。
 *
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * `worker/src/atlas/recognition.ts` 与 `worker/src/atlas/data/cities.json`，Apache-2.0；
 * 数据为 Natural Earth（公共领域）。许可与数据出处见 third_party/infinite-reader/NOTICE
 * 与 resources/atlas-cities.json 的来源说明。
 *
 * 模型只给出地名与现代国家代码，坐标一律由这里的人名库匹配；匹配不到的地点保留在
 * `unresolved` 里，绝不使用模型臆造坐标。行格式：
 * `[ne_id, name, iso_a2, longitude, latitude, aliases]`。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BookMap } from '../shared/atlas'

type CityRow = [string, string, string, number, number, string[]]
export type Bounds = BookMap['bounds']

/** 打包后的资源目录与开发态的工作目录；与 OCR 语言包的查找方式一致。 */
function candidateRoots(): string[] {
  const roots: string[] = []
  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (resources) roots.push(join(resources, 'resources'), resources)
  roots.push(join(process.cwd(), 'resources'), process.cwd())
  return roots
}

const FILE = 'atlas-cities.json'

let loadPromise: Promise<CityRow[] | null> | null = null

async function loadRows(): Promise<CityRow[] | null> {
  for (const root of candidateRoots()) {
    try {
      const text = await readFile(join(root, FILE), 'utf-8')
      const parsed: unknown = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed as CityRow[]
    } catch {
      // 换下一个候选目录；都没有就返回 null，识别照常进行但所有地点都未匹配。
    }
  }
  return null
}

/**
 * 只有「国家 + 规范化地名」的唯一匹配才算定位。同名城市（例如同国多个 Springfield）
 * 保持未定位，不按人口或知名度挑一个。
 */
const normalize = (value: string): string =>
  value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

let indexPromise: Promise<Map<string, CityRow[]> | null> | null = null

async function cityIndex(): Promise<Map<string, CityRow[]> | null> {
  indexPromise ??= (async () => {
    const rows = await (loadPromise ??= loadRows())
    if (!rows) return null
    const index = new Map<string, CityRow[]>()
    for (const city of rows) {
      if (!Array.isArray(city) || city.length < 6) continue
      const aliases = Array.isArray(city[5]) ? city[5] : []
      for (const name of new Set([city[1], ...aliases].map(normalize).filter(Boolean))) {
        const key = `${city[2]}:${name}`
        const bucket = index.get(key)
        if (bucket) bucket.push(city)
        else index.set(key, [city])
      }
    }
    return index
  })()
  return indexPromise
}

/** 仅供测试注入城市库，避免依赖打包资源；不改变生产路径。 */
export function setAtlasCitiesForTests(rows: CityRow[] | null): void {
  loadPromise = Promise.resolve(rows)
  indexPromise = null
}

const unwrap = (lon: number, west: number, east: number): number =>
  lon + 360 * Math.round(((west + east) / 2 - lon) / 360)

function inBounds(lon: number, lat: number, [[west, south], [east, north]]: Bounds): boolean {
  const unwrapped = unwrap(lon, west, east)
  return unwrapped >= west && unwrapped <= east && lat >= south && lat <= north
}

/**
 * 名称匹配只验证坐标在区域里；它不验证模型对图上文字的 OCR。
 *
 * 区域是模型对图幅的估计，可能略漏掉边缘城市：唯一候选时先把框向外扩 15%
 * （至少 2 度）再判断，命中后再由调用方把范围扩到该城市。
 */
export async function locateCity(name: string, country: string, bounds: Bounds | null): Promise<CityRow | null> {
  const index = await cityIndex()
  if (!index) return null
  const candidates = index.get(`${country}:${normalize(name)}`) ?? []
  let searchBounds = bounds
  if (bounds && candidates.length === 1) {
    const [[west, south], [east, north]] = bounds
    const dx = Math.max(2, (east - west) * 0.15)
    const dy = Math.max(2, (north - south) * 0.15)
    searchBounds = [[west - dx, south - dy], [east + dx, north + dy]]
  }
  const matches = searchBounds
    ? candidates.filter((city) => inBounds(city[3], city[4], searchBounds))
    : candidates
  return matches.length === 1 ? matches[0]! : null
}

/** 城市行 → `AtlasPlace` 需要的坐标与名称。 */
export function cityCoordinates(city: CityRow): [number, number] {
  return [city[3], city[4]]
}

export function cityId(city: CityRow): string {
  return city[0]
}

export function cityNames(city: CityRow): { name: string; modernName: string } {
  return { name: city[1], modernName: city[1] }
}
