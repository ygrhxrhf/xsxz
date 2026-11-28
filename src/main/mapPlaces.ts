/**
 * 书中地名的坐标解析与缓存（腾讯 WebService 地理编码）。
 *
 * Key 只在主进程内存里拼进请求地址，不写日志、不进返回值；请求失败只回中文说明，
 * 不回显带 Key 的 URL。同一本书里同名地点只请求一次，已解析的结果随地名一起落盘，
 * 重开应用或重新抽取都不必再花配额。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AiPlace,
  AiPlaceCandidate,
  AiPlaceCandidateView,
  AiPlaceGeo,
  AiPlaceGeocodeStatus,
  AiPlaceGeocodeView,
  AiPlaceLocation,
} from '../shared/types'
import { atomicWriteText, bookDir } from './library'
import { getTencentMapKey } from './settings'

interface PlaceFile {
  version: 1
  places: AiPlaceGeo[]
}

const GEOCODER_ENDPOINT = 'https://apis.map.qq.com/ws/geocoder/v1/'
const DISTRICT_ENDPOINT = 'https://apis.map.qq.com/ws/district/v1/search'
const PLACE_SEARCH_ENDPOINT = 'https://apis.map.qq.com/ws/place/v1/search'
const GEOCODE_TIMEOUT_MS = 10_000
/** 顺序请求之间留一点间隔，避免撞到 WebService 的 QPS 限制。 */
const GEOCODE_GAP_MS = 120

const AUTH_STATUSES = new Set([110, 111, 120, 121, 125])
/**
 * 腾讯可信度是 1–10；低于 6 视为需要人确认的歧义结果。
 * 坐标照常返回，但先不落成“已定位”，由用户在列表里确认或忽略。
 */
const AMBIGUOUS_RELIABILITY = 6
const STATUS_MESSAGES: Record<number, string> = {
  110: '腾讯地图 Key 未授权 WebService API，请在地图控制台开启该服务并检查来源限制',
  111: '腾讯地图 Key 格式不正确',
  120: '腾讯地图 WebService 配额已用尽',
  121: '腾讯地图 WebService 调用频率超限，请稍后再试',
  125: '腾讯地图 Key 未绑定有效来源',
  306: '腾讯地图地理编码请求参数有误',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pathFor(bookId: string): string {
  return join(bookDir(bookId), 'ai', 'places.json')
}

function stringField(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function normalizedName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ')
}

export function buildGeocoderUrl(name: string, key: string, region = ''): string {
  const params = new URLSearchParams({ address: name, key, output: 'json' })
  if (region.trim()) params.set('region', region.trim())
  return `${GEOCODER_ENDPOINT}?${params.toString()}`
}

interface GeocodeResult {
  ok: boolean
  location?: AiPlaceLocation
  /** 失败时的中文说明；成功时为空。 */
  message: string
  /** Key 未授权 / 配额 / 频率类错误：继续请求没有意义。 */
  fatal?: boolean
}

/**
 * 国家/地区名没有可解析的门牌地址，地理编码与行政区划都查不到时退回中心点。
 * 只用于国家级名称，坐标标为低可信度，必须由用户确认。
 */
const COUNTRY_CENTROIDS: Record<string, { latitude: number; longitude: number }> = {
  '中国': { latitude: 35.8617, longitude: 104.1954 },
  '中华人民共和国': { latitude: 35.8617, longitude: 104.1954 },
  '美国': { latitude: 39.9042, longitude: -98.5795 },
  '日本': { latitude: 36.2048, longitude: 138.2529 },
  '英国': { latitude: 54.0, longitude: -2.0 },
  '法国': { latitude: 46.2276, longitude: 2.2137 },
  '德国': { latitude: 51.1657, longitude: 10.4515 },
  '俄罗斯': { latitude: 61.524, longitude: 105.3188 },
}

export function parseGeocoderResponse(raw: unknown): GeocodeResult {
  if (!isRecord(raw)) return { ok: false, message: '腾讯地理编码返回格式无法识别' }
  const status = typeof raw.status === 'number' ? raw.status : -1
  if (status !== 0) {
    const detail = typeof raw.message === 'string' && raw.message.trim() ? `（${raw.message.trim()}）` : ''
    return {
      ok: false,
      fatal: AUTH_STATUSES.has(status),
      message: `${STATUS_MESSAGES[status] ?? '腾讯地理编码返回异常'}${detail}`,
    }
  }
  const result = isRecord(raw.result) ? raw.result : null
  const location = result && isRecord(result.location) ? result.location : null
  const latitude = Number(location?.lat)
  const longitude = Number(location?.lng)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, message: '腾讯地理编码没有返回坐标' }
  }
  const reliability = Number(result?.reliability)
  const level = typeof result?.level === 'string' && result.level.trim() ? result.level.trim() : undefined
  const components = isRecord(result?.address_components) ? result.address_components
    : isRecord(result?.ad_info) ? result.ad_info : null
  const regionText = components && (stringField(components.city) || stringField(components.province))
  return {
    ok: true,
    message: '',
    location: {
      latitude,
      longitude,
      ...(Number.isFinite(reliability) ? { reliability } : {}),
      ...(level ? { level } : {}),
      ...(regionText ? { region: regionText } : {}),
    },
  }
}

/**
 * 手工标注地点 id 的前缀。
 *
 * 定义在这里而不是 `mapManualPlace.ts`：那个模块已经 import 本模块的 `readPlaces`，
 * 反向再 import 会形成循环依赖。两边共用这一个常量，
 * `mapManualPlace.ts` 原样再导出，调用方不用改。
 */
export const MANUAL_PLACE_ID_PREFIX = 'place-manual-'

/**
 * 重新抽取后按地名 id 保留已经解析过的坐标，避免重复花配额。
 *
 * 手工标注（`place-manual-` 前缀）另有待遇：它不是模型抽出来的，
 * 重新点「抽取已读地名」时模型不会提到它，若只映射 `next` 就会把手工标的坐标整条抹掉。
 * 所以这里把 previous 里未被本次抽取覆盖的手工条目原样追加回去。
 */
export function mergePlaceGeo(previous: readonly AiPlaceGeo[], next: readonly AiPlace[]): AiPlaceGeo[] {
  const old = new Map(previous.map((place) => [place.id, place]))
  const merged = next.map((place) => {
    const prior = old.get(place.id)
    if (!prior) return { ...place, geocodeStatus: 'pending' as const }
    return {
      ...place,
      ...(prior.location ? { location: prior.location } : {}),
      geocodeStatus: prior.geocodeStatus,
    }
  })
  const nextIds = new Set(next.map((place) => place.id))
  for (const prior of previous) {
    if (!prior.id.startsWith(MANUAL_PLACE_ID_PREFIX)) continue
    if (nextIds.has(prior.id)) continue
    merged.push(prior)
  }
  return merged
}

function validStatus(value: unknown): AiPlaceGeocodeStatus {
  return value === 'resolved' || value === 'ambiguous' || value === 'not-found' || value === 'ignored'
    ? value
    : 'pending'
}

function sanitizePlace(value: unknown): AiPlaceGeo | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || typeof value.name !== 'string' || !value.name.trim()) return null
  if (typeof value.chapterId !== 'string' || typeof value.chapterTitle !== 'string') return null
  if (!Number.isSafeInteger(value.paragraphIndex) || (value.paragraphIndex as number) < 0) return null
  if (!Number.isSafeInteger(value.paragraphOffset) || (value.paragraphOffset as number) < 0) return null
  if (typeof value.excerpt !== 'string') return null
  const location = isRecord(value.location) ? value.location : null
  const latitude = Number(location?.latitude)
  const longitude = Number(location?.longitude)
  const hasLocation = Number.isFinite(latitude) && Number.isFinite(longitude)
  return {
    id: value.id,
    name: value.name.trim(),
    aliases: Array.isArray(value.aliases) ? value.aliases.filter((alias): alias is string => typeof alias === 'string') : [],
    kind: value.kind === 'city' || value.kind === 'region' || value.kind === 'landmark' ? value.kind : 'other',
    chapterId: value.chapterId,
    chapterTitle: value.chapterTitle,
    paragraphIndex: value.paragraphIndex as number,
    paragraphOffset: value.paragraphOffset as number,
    excerpt: value.excerpt,
    geocodeStatus: hasLocation
      ? (validStatus(value.geocodeStatus) === 'ambiguous' ? 'ambiguous' : 'resolved')
      : validStatus(value.geocodeStatus),
    ...(hasLocation ? {
      location: {
        latitude,
        longitude,
        ...(Number.isFinite(Number(location?.reliability)) ? { reliability: Number(location?.reliability) } : {}),
        ...(typeof location?.level === 'string' ? { level: location.level } : {}),
        ...(typeof location?.region === 'string' && location.region.trim() ? { region: location.region.trim() } : {}),
        ...(location?.source === 'geocoder' || location?.source === 'district' || location?.source === 'search' || location?.source === 'country'
          ? { source: location.source }
          : {}),
      },
    } : {}),
  }
}

function buildDistrictUrl(name: string, key: string): string {
  return `${DISTRICT_ENDPOINT}?keyword=${encodeURIComponent(name)}&key=${encodeURIComponent(key)}`
}

/** 行政区划接口：省/市/区县名直接返回中心点；国家级结果为低可信度。 */
export function parseDistrictResponse(raw: unknown): GeocodeResult {
  if (!isRecord(raw)) return { ok: false, message: '腾讯行政区划返回格式无法识别' }
  const status = typeof raw.status === 'number' ? raw.status : -1
  if (status !== 0) {
    const detail = typeof raw.message === 'string' && raw.message.trim() ? `（${raw.message.trim()}）` : ''
    return {
      ok: false,
      fatal: AUTH_STATUSES.has(status),
      message: `${STATUS_MESSAGES[status] ?? '腾讯行政区划查询异常'}${detail}`,
    }
  }
  const groups = Array.isArray(raw.result) ? raw.result : []
  const flat = groups.flatMap((group) => Array.isArray(group) ? group : [group])
  const hit = flat.find((item) => isRecord(item)
    && isRecord(item.location)
    && Number.isFinite(Number(item.location.lat))
    && Number.isFinite(Number(item.location.lng)))
  if (!hit || !isRecord(hit.location)) return { ok: false, message: '腾讯行政区划没有找到这个地名' }
  const level = typeof hit.level === 'string' ? hit.level : ''
  return {
    ok: true,
    message: '',
    location: {
      latitude: Number(hit.location.lat),
      longitude: Number(hit.location.lng),
      level,
      reliability: level === 'country' ? 4 : 8,
      source: 'district',
      ...(typeof hit.fullname === 'string' && hit.fullname.trim() ? { region: hit.fullname.trim() } : {}),
    },
  }
}

function buildPlaceSearchUrl(name: string, key: string, boundary: string): string {
  const params = new URLSearchParams({
    keyword: name,
    boundary,
    page_size: '8',
    output: 'json',
    key,
  })
  return `${PLACE_SEARCH_ENDPOINT}?${params.toString()}`
}

export function parsePlaceSearchResponse(raw: unknown): AiPlaceCandidate[] {
  if (!isRecord(raw)) throw new Error('腾讯地点搜索返回格式无法识别')
  const status = typeof raw.status === 'number' ? raw.status : -1
  if (status !== 0) {
    const detail = typeof raw.message === 'string' && raw.message.trim() ? `（${raw.message.trim()}）` : ''
    throw new Error(`${STATUS_MESSAGES[status] ?? '腾讯地点搜索返回异常'}${detail}`)
  }
  const data = Array.isArray(raw.data) ? raw.data : []
  const candidates: AiPlaceCandidate[] = []
  for (const [index, item] of data.entries()) {
    if (!isRecord(item) || !isRecord(item.location)) continue
    const title = stringField(item.title)
    const latitude = Number(item.location.lat)
    const longitude = Number(item.location.lng)
    if (!title || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue
    candidates.push({
      id: stringField(item.id) ?? `candidate-${index}`,
      title,
      address: stringField(item.address) ?? '',
      latitude,
      longitude,
      ...(stringField(item.category) ? { category: stringField(item.category)! } : {}),
    })
  }
  return candidates
}

function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180
  const dLat = (b.latitude - a.latitude) * rad
  const dLng = (b.longitude - a.longitude) * rad
  const lat1 = a.latitude * rad
  const lat2 = b.latitude * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * 为同名地点推断搜索范围：优先用自己的城市；否则用最近一个有城市的已解析地点；
 * 都没有城市时，用最近地点的坐标做 500km 附近的 nearby 搜索。
 */
export function boundaryForPlace(
  target: AiPlaceGeo,
  places: readonly AiPlaceGeo[],
): string | null {
  // 国家中心点没有城市语义，用附近 POI 搜“中国”只会得到银行/公司名，不做候选。
  if (target.location?.level === 'country' || target.location?.source === 'country') return null
  if (target.location?.region) return `region(${target.location.region},0)`
  const others = places.filter((place) => place.id !== target.id && place.location)
  if (!others.length) return null
  const base = target.location ?? { latitude: 34.0, longitude: 108.0 }
  const sorted = [...others].sort((left, right) => {
    const a = distanceKm(base, left.location!)
    const b = distanceKm(base, right.location!)
    return a - b
  })
  const withRegion = sorted.find((place) => place.location?.region)
  if (withRegion) return `region(${withRegion.location!.region},0)`
  const nearest = sorted[0]!.location!
  return `nearby(${nearest.latitude},${nearest.longitude},50000,1)`
}

export function geocodeStatusFor(result: GeocodeResult): AiPlaceGeocodeStatus {
  if (!result.ok || !result.location) return 'not-found'
  const reliability = result.location.reliability
  return typeof reliability === 'number' && reliability < AMBIGUOUS_RELIABILITY ? 'ambiguous' : 'resolved'
}

export async function readPlaces(bookId: string): Promise<AiPlaceGeo[]> {
  try {
    const raw = JSON.parse(await readFile(pathFor(bookId), 'utf-8')) as Partial<PlaceFile>
    if (raw.version !== 1 || !Array.isArray(raw.places)) return []
    return raw.places.map(sanitizePlace).filter((place): place is AiPlaceGeo => place !== null)
  } catch {
    return []
  }
}

export async function savePlaces(bookId: string, places: readonly AiPlace[]): Promise<AiPlaceGeo[]> {
  const previous = await readPlaces(bookId)
  const merged = mergePlaceGeo(previous, places)
  await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
  await atomicWriteText(pathFor(bookId), JSON.stringify({ version: 1, places: merged }, null, 2))
  return merged
}

async function requestGeocode(name: string, key: string, fetchImpl: typeof fetch): Promise<GeocodeResult> {
  try {
    const response = await fetchImpl(buildGeocoderUrl(name, key), {
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    })
    if (!response.ok) return { ok: false, message: `腾讯地理编码请求失败（HTTP ${response.status}）` }
    return parseGeocoderResponse(await response.json().catch(() => null))
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return { ok: false, message: timedOut ? '腾讯地理编码请求超时，请检查网络' : '腾讯地理编码请求失败，请检查网络' }
  }
}

async function requestDistrict(name: string, key: string, fetchImpl: typeof fetch): Promise<GeocodeResult> {
  try {
    const response = await fetchImpl(buildDistrictUrl(name, key), {
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    })
    if (!response.ok) return { ok: false, message: `腾讯行政区划请求失败（HTTP ${response.status}）` }
    return parseDistrictResponse(await response.json().catch(() => null))
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return { ok: false, message: timedOut ? '腾讯行政区划请求超时，请检查网络' : '腾讯行政区划请求失败，请检查网络' }
  }
}

/**
 * 地名解析回退链：地址解析 → 行政区划 → 加省/市后缀再解析 → 国家中心点。
 * 后三步只在前一步「查无结果」时触发；Key 未授权/配额类错误直接返回，不继续烧请求。
 */
export async function resolvePlace(
  name: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GeocodeResult> {
  const primary = await requestGeocode(name, key, fetchImpl)
  if (primary.ok || primary.fatal) return primary
  const district = await requestDistrict(name, key, fetchImpl)
  if (district.ok || district.fatal) return district
  for (const suffix of ['省', '市']) {
    if (name.trim().endsWith(suffix)) continue
    const retry = await requestGeocode(`${name.trim()}${suffix}`, key, fetchImpl)
    if (retry.ok || retry.fatal) return retry
  }
  const country = COUNTRY_CENTROIDS[name.trim()]
  if (country) {
    return {
      ok: true,
      message: '',
      location: { ...country, level: 'country', reliability: 3, source: 'country' },
    }
  }
  return primary
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface GeocodeOptions {
  /** 测试注入；生产不传。 */
  fetchImpl?: typeof fetch
  /** 测试注入；生产不传。 */
  gapMs?: number
  /** 用户显式重试时，跳过“未找到”缓存再查一次；“已忽略”的条目永不重试。 */
  retryNotFound?: boolean
}

/**
 * 给已保存的地名补坐标。已解析与已判定“未找到”的条目直接复用，不重复花配额；
 * 同名地点只请求一次。网络或授权类错误会停止后续请求，但已拿到的结果仍会写盘。
 */
export async function geocodePlaces(bookId: string, options: GeocodeOptions = {}): Promise<AiPlaceGeocodeView> {
  const key = await getTencentMapKey()
  if (!key) throw new Error('请先在设置中填写腾讯地图 Key（并开启 WebService API）')
  const places = await readPlaces(bookId)
  if (!places.length) {
    return { places, resolved: 0, ambiguous: 0, notFound: 0, cached: 0, message: '还没有抽取地名，请先抽取已读地名' }
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const gapMs = options.gapMs ?? GEOCODE_GAP_MS
  const retryNotFound = options.retryNotFound === true
  const byName = new Map<string, GeocodeResult>()
  for (const place of places) {
    if ((place.geocodeStatus === 'resolved' || place.geocodeStatus === 'ambiguous') && place.location) {
      byName.set(normalizedName(place.name), { ok: true, message: '', location: place.location })
    } else if (place.geocodeStatus === 'not-found' && !retryNotFound) {
      byName.set(normalizedName(place.name), { ok: false, message: '' })
    }
  }

  let resolved = 0
  let ambiguous = 0
  let notFound = 0
  let cached = 0
  let fatalMessage = ''

  for (const place of places) {
    if ((place.geocodeStatus === 'resolved' || place.geocodeStatus === 'ambiguous') && place.location) {
      if (place.geocodeStatus === 'resolved') resolved += 1
      else ambiguous += 1
      cached += 1
      continue
    }
    if (place.geocodeStatus === 'ignored') { cached += 1; continue }
    if (place.geocodeStatus === 'not-found' && !retryNotFound) {
      notFound += 1
      cached += 1
      continue
    }
    const nameKey = normalizedName(place.name)
    let result = byName.get(nameKey)
    if (!result) {
      if (gapMs > 0) await sleep(gapMs)
      result = await resolvePlace(place.name, key, fetchImpl)
      byName.set(nameKey, result)
      if (result.fatal) { fatalMessage = result.message; break }
    }
    const status = geocodeStatusFor(result)
    if (status === 'resolved') {
      place.location = result.location
      place.geocodeStatus = 'resolved'
      resolved += 1
    } else if (status === 'ambiguous') {
      place.location = result.location
      place.geocodeStatus = 'ambiguous'
      ambiguous += 1
    } else {
      place.geocodeStatus = 'not-found'
      notFound += 1
    }
  }

  await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
  await atomicWriteText(pathFor(bookId), JSON.stringify({ version: 1, places }, null, 2))

  const parts: string[] = []
  if (resolved) parts.push(`已定位 ${resolved} 个地点`)
  if (ambiguous) parts.push(`${ambiguous} 个待确认`)
  if (notFound) parts.push(`${notFound} 个未找到`)
  if (cached) parts.push(`${cached} 个使用已有结果`)
  return {
    places,
    resolved,
    ambiguous,
    notFound,
    cached,
    message: fatalMessage || parts.join('，') || '没有可解析的地名',
  }
}

interface PlaceSearchOptions {
  /** 测试注入；生产不传。 */
  fetchImpl?: typeof fetch
}

/** 用邻近已解析地点的城市/坐标推断统计范围，返回腾讯地点搜索的同名候选。 */
export async function searchPlaceCandidates(
  bookId: string,
  placeId: string,
  options: PlaceSearchOptions = {},
): Promise<AiPlaceCandidateView> {
  const key = await getTencentMapKey()
  if (!key) throw new Error('请先在设置中填写腾讯地图 Key（并开启 WebService API）')
  const places = await readPlaces(bookId)
  const target = places.find((place) => place.id === placeId)
  if (!target) throw new Error('地名词条不存在')
  if (target.location?.level === 'country' || target.location?.source === 'country') {
    return { candidates: [], boundary: '', message: '国家级名称不适合 POI 候选，请用国家中心点确认' }
  }
  const fetchImpl = options.fetchImpl ?? fetch
  // 旧缓存只有坐标没有城市：搜索前补一次城市，避免用“最近的其它地点”乱猜范围。
  if (target.location && !target.location.region) {
    const resolved = await resolvePlace(target.name, key, fetchImpl)
    if (resolved.ok && resolved.location?.region) {
      target.location.region = resolved.location.region
      await atomicWriteText(pathFor(bookId), JSON.stringify({ version: 1, places }, null, 2))
    }
  }
  const boundary = boundaryForPlace(target, places)
  if (!boundary) {
    return { candidates: [], boundary: '', message: '没有可用于推断搜索范围的邻近地点' }
  }
  let raw: unknown
  try {
    const response = await fetchImpl(buildPlaceSearchUrl(target.name, key, boundary), {
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`腾讯地点搜索请求失败（HTTP ${response.status}）`)
    raw = await response.json().catch(() => null)
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new Error(timedOut ? '腾讯地点搜索超时，请检查网络' : (error instanceof Error ? error.message : '腾讯地点搜索失败'))
  }
  const candidates = parsePlaceSearchResponse(raw)
  return {
    candidates,
    boundary,
    message: candidates.length ? '' : '这个范围内没有找到候选地点',
  }
}

/** 用户点选候选后写入坐标；这是人确认过的点，直接算已定位。 */
export async function choosePlaceCandidate(
  bookId: string,
  placeId: string,
  candidate: Pick<AiPlaceCandidate, 'latitude' | 'longitude'>,
): Promise<{ places: AiPlaceGeo[]; place: AiPlaceGeo } | null> {
  const latitude = Number(candidate?.latitude)
  const longitude = Number(candidate?.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null
  const places = await readPlaces(bookId)
  const place = places.find((item) => item.id === placeId)
  if (!place) return null
  place.location = { latitude, longitude, reliability: 9, level: 'poi', source: 'search' }
  place.geocodeStatus = 'resolved'
  await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
  await atomicWriteText(pathFor(bookId), JSON.stringify({ version: 1, places }, null, 2))
  return { places, place }
}

/** 用户对低可信度结果的处理：确认保留坐标，忽略则撤点且不再重复请求。 */
export async function confirmPlace(
  bookId: string,
  placeId: string,
  accepted: boolean,
): Promise<{ places: AiPlaceGeo[]; place: AiPlaceGeo } | null> {
  const places = await readPlaces(bookId)
  const place = places.find((item) => item.id === placeId)
  if (!place || !place.location) return null
  if (accepted) {
    place.geocodeStatus = 'resolved'
  } else {
    delete place.location
    place.geocodeStatus = 'ignored'
  }
  await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
  await atomicWriteText(pathFor(bookId), JSON.stringify({ version: 1, places }, null, 2))
  return { places, place }
}
