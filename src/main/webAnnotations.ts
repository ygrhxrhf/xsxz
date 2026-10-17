import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from './atomicFile'
import { canonicalizeUrl } from '../shared/urlHash'
import type { WebAnnotation, WebAnnotationUpdate } from '../shared/types'

/**
 * 网页阅读模式的标注：按**规范化章节地址**存划线 / 书签 / 备注。
 *
 * 本地阅读器的标记挂在 `bookId` 上（书库条目），网页阅读模式没有书库条目，
 * 所以另立一份按 URL 归属的存储，沿用 `browse-state.json` 的先例（同用
 * `canonicalizeUrl` 归一地址）。坐标空间与本地一致：规范化正文。
 *
 * 磁盘格式见 `docs/disk-schema.md` 的「web-annotations.json」。
 */
const FILE_VERSION = 1
export const WEB_ANNOTATION_LIMIT = 5000

interface WebAnnotationsFile {
  version: number
  items: WebAnnotation[]
}

let state: WebAnnotationsFile | null = null
let pending: Promise<void> = Promise.resolve()
let overrideDir: string | null = null

export function setWebAnnotationsDirForTests(dir: string | null): void {
  overrideDir = dir
  state = null
  pending = Promise.resolve()
}

function filePath(): string {
  return join(overrideDir ?? app.getPath('userData'), 'web-annotations.json')
}

/** 地址归一：与阅读位置同一个键，非法地址返回 null。 */
export function webAnnotationKey(url: string): string | null {
  if (typeof url !== 'string') return null
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return canonicalizeUrl(url)
  } catch {
    return null
  }
}

function normalizeNoteSource(value: unknown): 'user' | 'ai' | undefined {
  return value === 'user' || value === 'ai' ? value : undefined
}

function isValidItem(value: unknown): value is WebAnnotation {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.url === 'string' && webAnnotationKey(item.url) !== null
    && (item.kind === 'highlight' || item.kind === 'bookmark')
    && typeof item.start === 'number' && typeof item.end === 'number'
    && typeof item.excerpt === 'string' && typeof item.createdAt === 'string'
}

async function load(): Promise<WebAnnotationsFile> {
  if (state) return state
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(filePath(), 'utf-8'))
  } catch {
    raw = {}
  }
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const items = Array.isArray(input.items) ? input.items.filter(isValidItem) : []
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  state = { version: FILE_VERSION, items: items.slice(-WEB_ANNOTATION_LIMIT) }
  return state
}

function save(): Promise<void> {
  pending = pending.catch(() => {}).then(async () => {
    await mkdir(join(filePath(), '..'), { recursive: true })
    await atomicWriteText(filePath(), JSON.stringify(state, null, 2))
  })
  return pending
}

export async function listWebAnnotations(url: string): Promise<WebAnnotation[]> {
  const key = webAnnotationKey(url)
  if (!key) return []
  return (await load()).items.filter((item) => item.url === key)
}

export async function addWebAnnotation(
  draft: Omit<WebAnnotation, 'id' | 'createdAt'>,
): Promise<WebAnnotation> {
  const key = webAnnotationKey(draft.url)
  if (!key) throw new Error('地址不合法，无法保存标记')
  if (draft.kind !== 'highlight' && draft.kind !== 'bookmark') throw new Error('标记类型不合法')
  if (draft.kind === 'highlight') {
    if (!(Number.isInteger(draft.start) && Number.isInteger(draft.end) && draft.end > draft.start)) {
      throw new Error('划线位置不合法')
    }
    if (!draft.excerpt) throw new Error('划线缺少原文摘录')
  }
  const annotation: WebAnnotation = {
    ...draft,
    url: key,
    start: Math.max(0, draft.start),
    end: Math.max(0, draft.end),
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  }
  const source = normalizeNoteSource(draft.noteSource)
  if (!annotation.note || !source) delete annotation.noteSource
  else annotation.noteSource = source
  const data = await load()
  data.items.push(annotation)
  if (data.items.length > WEB_ANNOTATION_LIMIT) data.items = data.items.slice(-WEB_ANNOTATION_LIMIT)
  await save()
  return annotation
}

export async function updateWebAnnotation(
  url: string,
  annotationId: string,
  patch: WebAnnotationUpdate,
): Promise<WebAnnotation | null> {
  const key = webAnnotationKey(url)
  if (!key) return null
  const data = await load()
  const item = data.items.find((a) => a.id === annotationId && a.url === key)
  if (!item) return null
  if (typeof patch.note === 'string' && patch.note.trim()) {
    item.note = patch.note.trim()
    item.noteSource = normalizeNoteSource(patch.noteSource) ?? 'user'
  } else if (patch.note !== undefined) {
    delete item.note
    delete item.noteSource
  }
  if (
    typeof patch.start === 'number' && typeof patch.end === 'number'
    && Number.isInteger(patch.start) && Number.isInteger(patch.end) && patch.end >= patch.start
  ) {
    item.start = patch.start
    item.end = patch.end
  }
  await save()
  return item
}

export async function removeWebAnnotation(url: string, annotationId: string): Promise<boolean> {
  const key = webAnnotationKey(url)
  if (!key) return false
  const data = await load()
  const next = data.items.filter((a) => !(a.id === annotationId && a.url === key))
  if (next.length === data.items.length) return false
  data.items = next
  await save()
  return true
}
