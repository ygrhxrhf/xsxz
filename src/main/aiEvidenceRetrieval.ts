/**
 * 已读正文的证据检索编排：先问索引「哪些章一定没有」，只读剩下的章，再把正文交给打分。
 * 打分本身仍是 aiEvidenceSearch 的纯函数，这里只管读盘，因此越界章节、读盘预算、索引降级都在一处。
 */
import type { AiCitation, ChapterStatus } from '../shared/types'
import {
  evidenceReadHints,
  selectLocalEvidence,
  type EvidenceSearchChapter,
  type EvidenceSearchOptions,
  type EvidenceSearchQuery,
} from './aiEvidenceSearch'
import { planEvidenceReads, wakeEvidenceIndex } from './aiEvidenceIndex'

/** 剪枝后最多读盘这么多章：必选集与索引不可用的章不受此限，宁可多读也不能漏引用。 */
export const MAX_EVIDENCE_CHAPTER_READS = 24

export interface EvidenceChapterHeader {
  id: string
  index: number
  title: string
  status: ChapterStatus | string
  file: string
}

export interface EvidenceReads {
  indexed: number
  total: number
  read: number
}

export async function retrieveLocalEvidence(input: {
  bookId: string
  chapters: readonly EvidenceChapterHeader[]
  query: EvidenceSearchQuery
  options: EvidenceSearchOptions
  readBody: (chapterId: string) => Promise<{ body: string; status: ChapterStatus | string }>
  maxChapterReads?: number
  stopped?: () => boolean
}): Promise<{ citations: AiCitation[]; fallbackQuery: boolean; uptoChapterId: string; reads: EvidenceReads }> {
  const ordered = [...input.chapters].sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
  const hints = evidenceReadHints(ordered, input.query, input.options)
  const refs = ordered.slice(0, hints.cutoffPosition + 1)
    .map((chapter) => ({ id: chapter.id, index: chapter.index, file: chapter.file }))
  void wakeEvidenceIndex(input.bookId)
  const plan = hints.prunable
    ? await planEvidenceReads({
      bookId: input.bookId,
      refs,
      terms: hints.terms,
      mandatory: hints.mandatory,
      currentIndex: hints.currentIndex,
      maxRead: input.maxChapterReads ?? MAX_EVIDENCE_CHAPTER_READS,
    })
    : { readIds: new Set(refs.map((ref) => ref.id)), indexed: 0, total: refs.length }

  const searchChapters: EvidenceSearchChapter[] = []
  for (const [position, chapter] of ordered.entries()) {
    if (input.stopped?.()) break
    if (position > hints.cutoffPosition || !plan.readIds.has(chapter.id)) {
      searchChapters.push({ ...chapter, body: '' })
      continue
    }
    const local = await input.readBody(chapter.id)
    searchChapters.push({
      id: chapter.id,
      index: chapter.index,
      title: chapter.title,
      status: local.status,
      body: local.body,
    })
  }
  const reads: EvidenceReads = { indexed: plan.indexed, total: plan.total, read: searchChapters.filter((chapter) => chapter.body).length }
  const result = selectLocalEvidence(searchChapters, input.query, input.options)
  return { ...result, reads }
}
