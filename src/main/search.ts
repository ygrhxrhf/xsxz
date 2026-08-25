import { loadBook, readChapter } from './library'
import { buildExcerpt, paraIndexOfOffset, paragraphRanges } from '../shared/paragraphSearch'
import type { BookSearchHit } from '../shared/types'

/**
 * 本书内全文搜索：只扫 ready 章节的正文，大小写不敏感。
 * 返回按章节顺序排列的命中列表。
 */
export async function searchInBook(bookId: string, rawQuery: string): Promise<BookSearchHit[]> {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return []
  const book = await loadBook(bookId)
  const hits: BookSearchHit[] = []
  for (const meta of book.chapters) {
    if (meta.status !== 'ready') continue
    let body = ''
    try {
      body = (await readChapter(bookId, meta.id)).body || ''
    } catch {
      continue
    }
    if (!body) continue

    const lower = body.toLowerCase()
    let count = 0
    let first = -1
    for (let pos = lower.indexOf(q); pos >= 0; pos = lower.indexOf(q, pos + Math.max(1, q.length))) {
      count++
      if (first < 0) first = pos
    }
    if (first < 0) continue

    hits.push({
      chapterId: meta.id,
      chapterIndex: meta.index,
      chapterTitle: meta.title,
      count,
      excerpt: buildExcerpt(body, first, q.length),
      paraIndex: Math.max(0, paraIndexOfOffset(paragraphRanges(body), first)),
    })
  }
  return hits
}
