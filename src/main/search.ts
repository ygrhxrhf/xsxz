import { loadBook, readChapter } from './library'
import { buildExcerpt, paraIndexOfOffset, paragraphRanges } from '../shared/paragraphSearch'
import type { BookSearchHit } from '../shared/types'

/** 单章搜索：只读正文、返回该章命中（无命中返回 null）。 */
async function searchChapter(bookId: string, meta: { id: string; index: number; title: string }, q: string): Promise<BookSearchHit | null> {
  let body = ''
  try {
    body = (await readChapter(bookId, meta.id)).body || ''
  } catch {
    return null
  }
  if (!body) return null

  const lower = body.toLowerCase()
  let count = 0
  let first = -1
  for (let pos = lower.indexOf(q); pos >= 0; pos = lower.indexOf(q, pos + Math.max(1, q.length))) {
    count++
    if (first < 0) first = pos
  }
  if (first < 0) return null

  return {
    chapterId: meta.id,
    chapterIndex: meta.index,
    chapterTitle: meta.title,
    count,
    excerpt: buildExcerpt(body, first, q.length),
    paraIndex: Math.max(0, paraIndexOfOffset(paragraphRanges(body), first)),
  }
}

/** 并发上限：千章的书逐章串行读盘会明显卡，这里限制同时打开的文件数，别把磁盘打满。 */
const SEARCH_CONCURRENCY = 8

/**
 * 本书内全文搜索：只扫 ready 章节的正文，大小写不敏感。
 * 返回按章节顺序排列的命中列表。
 *
 * 各章互不依赖，用有界并发读盘（保持顺序）；命中按目录序输出，与逐章串行结果一致。
 */
export async function searchInBook(bookId: string, rawQuery: string): Promise<BookSearchHit[]> {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return []
  const book = await loadBook(bookId)
  const targets = book.chapters.filter((meta) => meta.status === 'ready')
  const results = new Array<BookSearchHit | null>(targets.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= targets.length) return
      results[i] = await searchChapter(bookId, targets[i]!, q)
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, targets.length) }, worker))
  return results.filter((hit): hit is BookSearchHit => hit !== null)
}
