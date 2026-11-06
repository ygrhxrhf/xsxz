import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from './atomicFile'
import { bookDir, loadBook, withBookLock } from './library'
import type {
  Annotation,
  AnnotationColor,
  AnnotationNoteSource,
  AnnotationUpdate,
} from '../shared/types'

interface AnnotationsFile {
  version: number
  items: Annotation[]
}

const EMPTY: AnnotationsFile = { version: 1, items: [] }

/** 备注出处只有两种合法取值；其余（含外部塞进来的脏值）一律按缺省处理。 */
function normalizeNoteSource(value: unknown): AnnotationNoteSource | undefined {
  return value === 'user' || value === 'ai' ? value : undefined
}

const ANNOTATION_COLORS: readonly AnnotationColor[] = ['yellow', 'green', 'blue', 'red', 'purple']
const MAX_TAGS = 50
const MAX_TAG_LENGTH = 32

/** 颜色白名单；非法值返回 undefined，由调用方决定是否保留旧值。 */
function normalizeColor(value: unknown): AnnotationColor | undefined {
  return ANNOTATION_COLORS.find((color) => color === value)
}

/**
 * `#tag` 归一：去掉开头的 `#`、去除首尾空白、小写，去空、去重。
 * 非数组（含字符串化后的脏数据）一律当作未提供。
 */
function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().replace(/^#+/, '').trim().toLowerCase().slice(0, MAX_TAG_LENGTH)
    if (!tag) continue
    seen.add(tag)
    if (seen.size >= MAX_TAGS) break
  }
  return [...seen]
}

function fileFor(bookId: string): string {
  return join(bookDir(bookId), 'annotations.json')
}

async function readAll(bookId: string): Promise<AnnotationsFile> {
  try {
    const raw = JSON.parse(await readFile(fileFor(bookId), 'utf-8')) as Partial<AnnotationsFile>
    if (!Array.isArray(raw.items)) return { version: 1, items: [] }
    return { version: 1, items: raw.items.filter(Boolean) }
  } catch {
    return { ...EMPTY, items: [] }
  }
}

async function writeAll(bookId: string, data: AnnotationsFile): Promise<void> {
  await mkdir(bookDir(bookId), { recursive: true })
  // 走原子写（临时文件 + fsync + rename）：标记是读者手工产出，崩溃或断电时不能只剩半截
  // JSON 把所有书签划线一起带走。书库里的其它落盘也都是这条路。
  await atomicWriteText(fileFor(bookId), JSON.stringify(data, null, 2))
}

export async function listAnnotations(bookId: string): Promise<Annotation[]> {
  const data = await readAll(bookId)
  return [...data.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function addAnnotation(
  draft: Omit<Annotation, 'id' | 'createdAt'>,
): Promise<Annotation> {
  const book = await loadBook(draft.bookId)
  if (!book.chapters.some((c) => c.id === draft.chapterId)) {
    throw new Error('章节不存在，无法保存标记')
  }
  if (draft.kind !== 'highlight' && draft.kind !== 'bookmark') {
    throw new Error('标记类型不合法')
  }
  if (draft.kind === 'highlight') {
    if (!(Number.isInteger(draft.start) && Number.isInteger(draft.end) && draft.end > draft.start)) {
      throw new Error('划线位置不合法')
    }
    if (!draft.excerpt) throw new Error('划线缺少原文摘录')
  }
  const annotation: Annotation = {
    ...draft,
    start: Math.max(0, draft.start),
    end: Math.max(0, draft.end),
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  }
  const source = normalizeNoteSource(draft.noteSource)
  if (!annotation.note || !source) delete annotation.noteSource
  else annotation.noteSource = source
  // 旧客户端与新字段混用：只保存可识别的内容，空白标签不落盘。
  const tags = normalizeTags(draft.tags)
  if (tags && tags.length) annotation.tags = tags
  else delete annotation.tags
  const color = normalizeColor(draft.color)
  if (color) annotation.color = color
  else delete annotation.color
  await withBookLock(draft.bookId, async () => {
    const data = await readAll(draft.bookId)
    data.items.push(annotation)
    await writeAll(draft.bookId, data)
  })
  return annotation
}

export async function updateAnnotation(
  bookId: string,
  annotationId: string,
  patch: AnnotationUpdate,
): Promise<Annotation | null> {
  let updated: Annotation | null = null
  await withBookLock(bookId, async () => {
    const data = await readAll(bookId)
    const item = data.items.find((a) => a.id === annotationId)
    if (!item) return
    if (typeof patch.note === 'string' && patch.note.trim()) {
      item.note = patch.note.trim()
      // 文本换了就是新的作者：没明说出处就按读者手写算，AI 的上一轮结论不再冒充事实。
      item.noteSource = normalizeNoteSource(patch.noteSource) ?? 'user'
    } else if (patch.note !== undefined) {
      delete item.note
      delete item.noteSource
    }
    if (
      typeof patch.start === 'number' &&
      typeof patch.end === 'number' &&
      Number.isInteger(patch.start) &&
      Number.isInteger(patch.end) &&
      patch.end >= patch.start
    ) {
      item.start = patch.start
      item.end = patch.end
    }
    if (patch.tags !== undefined) {
      const tags = normalizeTags(patch.tags)
      // 显式传空数组就是清空；非法（非数组）不覆盖旧值。
      if (tags && tags.length) item.tags = tags
      else if (tags) delete item.tags
    }
    if (patch.color !== undefined) {
      const color = normalizeColor(patch.color)
      if (color) item.color = color
    }
    updated = item
    await writeAll(bookId, data)
  })
  return updated
}

export async function removeAnnotation(bookId: string, annotationId: string): Promise<void> {
  await withBookLock(bookId, async () => {
    const data = await readAll(bookId)
    const next = data.items.filter((a) => a.id !== annotationId)
    if (next.length === data.items.length) return
    await writeAll(bookId, { version: 1, items: next })
  })
}
