import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bookDir, loadBook, withBookLock } from './library'
import type { Annotation, AnnotationNoteSource, AnnotationUpdate } from '../shared/types'

interface AnnotationsFile {
  version: number
  items: Annotation[]
}

const EMPTY: AnnotationsFile = { version: 1, items: [] }

/** 备注出处只有两种合法取值；其余（含外部塞进来的脏值）一律按缺省处理。 */
function normalizeNoteSource(value: unknown): AnnotationNoteSource | undefined {
  return value === 'user' || value === 'ai' ? value : undefined
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
  await writeFile(fileFor(bookId), JSON.stringify(data, null, 2), 'utf-8')
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
