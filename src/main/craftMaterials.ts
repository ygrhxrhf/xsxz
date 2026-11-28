import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AiChapterNote, AiMemoryFile, Annotation, Book } from '../shared/types'
import { listChapterNotes } from './aiChapterNotes'
import { listAnnotations } from './annotations'
import { bookDir, getBook, readAiMemory } from './library'

/**
 * 一本书要推给 Crafty 的材料：元数据 + 读书产物，不含正文。
 *
 * 概览直接读 `ai/bookOverview.json` 的 `text`（`BookOverviewService` 的实例状态不适合在这里
 * 复现）：文件缺失、损坏、还没生成都只是「没有概览」，不影响推送其余部分。
 */
export interface CraftMaterials {
  book: Book
  overview: string
  memory: AiMemoryFile | null
  notes: AiChapterNote[]
  annotations: Annotation[]
}

async function readOverview(bookId: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(join(bookDir(bookId), 'ai', 'bookOverview.json'), 'utf-8')) as Record<string, unknown>
    return typeof raw?.text === 'string' ? raw.text : ''
  } catch {
    return ''
  }
}

export async function loadCraftMaterials(bookId: string): Promise<CraftMaterials> {
  const book = await getBook(bookId)
  const [overview, memory, notes, annotations] = await Promise.all([
    readOverview(bookId),
    readAiMemory(bookId),
    listChapterNotes(bookId),
    listAnnotations(bookId),
  ])
  return { book, overview, memory, notes, annotations }
}
