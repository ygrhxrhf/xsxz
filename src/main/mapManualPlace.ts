/**
 * 手工标注地点坐标（M5）。
 *
 * 与 `mapPlaces` 的地理编码路径相反：这里的坐标由本人给定，**不消耗腾讯地图配额**，
 * 也不发起任何网络请求。手工标注与自动抽取的地名写在同一个按书的地点存储里
 * （`bookDir/<bookId>/ai/places.json`），因此地图页的列表、标记与「跳到原文」
 * 对两类来源一视同仁。
 *
 * 校验规则（不合法一律给中文错误，不写盘）：
 *   - 地名非空；
 *   - 纬度 -90–90，经度 -180–180；
 *   - 正文锚点（段号 / 段内偏移）可选，给了就存下来，地图上点了能跳回正文；
 *   - 类型缺省 `other`。
 *
 * 地点 id 沿用既有 `AiPlace.id` 的风格（`place-…`），手工项用 `place-manual-` 前缀：
 *   - 带正文锚点：`place-manual-anchor-<段号>-<段内偏移>`；
 *   - 不带锚点：`place-manual-free-<序号>`。
 * 这个前缀是渲染层识别「这是手工标注」的依据（地图页据此决定要不要给「原文」入口）。
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiPlaceGeo, AiPlaceKind } from '../shared/types'
import { atomicWriteText, bookDir } from './library'
import { MANUAL_PLACE_ID_PREFIX, readPlaces } from './mapPlaces'

/**
 * 手工标注地点 id 的前缀。渲染层按它识别手工项。
 *
 * 常量本身定义在 `mapPlaces.ts`（那边不依赖本模块，避免循环导入），这里原样再导出，
 * 调用方只用 `mapManualPlace` 的写法不用改。
 */
export { MANUAL_PLACE_ID_PREFIX }

/** 手工标注的章节标题：手工项不隶属于任何一章。 */
const MANUAL_CHAPTER_TITLE = '手工标注'

export interface ManualPlaceInput {
  name?: unknown
  latitude?: unknown
  longitude?: unknown
  kind?: unknown
  paragraphIndex?: unknown
  paragraphOffset?: unknown
}

export interface ValidatedManualPlace {
  ok: true
  name: string
  latitude: number
  longitude: number
  kind: AiPlaceKind
  /** 正文锚点：给了段号就有，段内偏移缺省 0（跳到段首）。 */
  paragraphIndex?: number
  paragraphOffset?: number
}

export interface ManualPlaceError {
  ok: false
  /** 中文原因，直接给界面显示。 */
  message: string
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim()) return Number(value)
  return Number.NaN
}

/**
 * 校验手工标注入参。坐标越界、名字为空都返回中文原因，不抛异常——
 * 界面要把它原样显示给人看。
 */
export function validateManualPlace(input: ManualPlaceInput): ValidatedManualPlace | ManualPlaceError {
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  if (!name) return { ok: false, message: '地名不能为空' }

  const latitude = toNumber(input?.latitude)
  if (!Number.isFinite(latitude)) return { ok: false, message: '纬度必须是数字' }
  if (latitude < -90 || latitude > 90) return { ok: false, message: '纬度须在 -90 到 90 之间' }

  const longitude = toNumber(input?.longitude)
  if (!Number.isFinite(longitude)) return { ok: false, message: '经度必须是数字' }
  if (longitude < -180 || longitude > 180) return { ok: false, message: '经度须在 -180 到 180 之间' }

  const kind: AiPlaceKind = input?.kind === 'city' || input?.kind === 'region' || input?.kind === 'landmark'
    ? input.kind
    : 'other'

  const result: ValidatedManualPlace = { ok: true, name, latitude, longitude, kind }
  const paragraphIndex = toNumber(input?.paragraphIndex)
  const paragraphOffset = toNumber(input?.paragraphOffset)
  if (Number.isFinite(paragraphIndex)) {
    if (!Number.isSafeInteger(paragraphIndex) || paragraphIndex < 0) {
      return { ok: false, message: '正文段号必须是非负整数' }
    }
    result.paragraphIndex = paragraphIndex
    result.paragraphOffset = Number.isFinite(paragraphOffset) ? paragraphOffset : 0
    if (!Number.isSafeInteger(result.paragraphOffset) || result.paragraphOffset < 0) {
      return { ok: false, message: '段内偏移必须是非负整数' }
    }
  }
  return result
}

/** id 是否是手工标注。 */
export function isManualPlaceId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(MANUAL_PLACE_ID_PREFIX)
}

/**
 * 手工标注的 id：
 *   - 有正文锚点 → `place-manual-anchor-<段号>-<段内偏移>`（同锚点再标一次就是改坐标）；
 *   - 没有锚点 → `place-manual-free-<序号>`（序号按已有的无锚点手工项递增）。
 */
export function manualPlaceId(
  place: { paragraphIndex?: number; paragraphOffset?: number },
  previous: readonly AiPlaceGeo[] = [],
): string {
  if (Number.isSafeInteger(place.paragraphIndex) && (place.paragraphIndex as number) >= 0) {
    return `${MANUAL_PLACE_ID_PREFIX}anchor-${place.paragraphIndex}-${place.paragraphOffset ?? 0}`
  }
  let sequence = 0
  for (const item of previous) {
    if (item.id.startsWith(`${MANUAL_PLACE_ID_PREFIX}free-`)) sequence += 1
  }
  return `${MANUAL_PLACE_ID_PREFIX}free-${sequence}`
}

/** 构造一条手工标注的地名词条。 */
export function buildManualPlace(validated: ValidatedManualPlace, id: string): AiPlaceGeo {
  const anchored = Number.isSafeInteger(validated.paragraphIndex)
  return {
    id,
    name: validated.name,
    aliases: [],
    kind: validated.kind,
    // 手工标注不隶属某章：锚点是当前正文坐标，章节留空。
    chapterId: '',
    chapterTitle: MANUAL_CHAPTER_TITLE,
    paragraphIndex: anchored ? validated.paragraphIndex! : 0,
    paragraphOffset: anchored ? validated.paragraphOffset ?? 0 : 0,
    excerpt: '',
    // 坐标是本人给的，不需要再解析，也不需要人确认。
    geocodeStatus: 'resolved',
    location: {
      latitude: validated.latitude,
      longitude: validated.longitude,
      reliability: 10,
    },
  }
}

/**
 * 合并进既有地点列表：同 id 覆盖（重新标一次就是改坐标），不同 id 追加在末尾。
 * 既有条目一条不动——手工标注不能动别人抽出来的地名。
 */
export function mergeManualPlace(previous: readonly AiPlaceGeo[], place: AiPlaceGeo): AiPlaceGeo[] {
  const index = previous.findIndex((item) => item.id === place.id)
  if (index < 0) return [...previous, place]
  const next = previous.slice()
  next[index] = place
  return next
}

/**
 * 写入一条手工标注。
 *
 * 不合法入参抛中文错误（调用方是 IPC 层，负责把它翻成 `{ ok: false, message }`）。
 */
export async function addManualPlace(
  bookId: string,
  input: ManualPlaceInput,
): Promise<{ places: AiPlaceGeo[]; place: AiPlaceGeo }> {
  const validated = validateManualPlace(input)
  if (!validated.ok) throw new Error(validated.message)
  const previous = await readPlaces(bookId)
  const id = manualPlaceId(validated, previous)
  const place = buildManualPlace(validated, id)
  const places = mergeManualPlace(previous, place)
  await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
  await atomicWriteText(
    join(bookDir(bookId), 'ai', 'places.json'),
    JSON.stringify({ version: 1, places }, null, 2),
  )
  return { places, place }
}
