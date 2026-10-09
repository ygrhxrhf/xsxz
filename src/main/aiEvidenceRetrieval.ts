/**
 * 已读正文的证据检索编排：先问索引「哪些章一定没有」，只读剩下的章，再把正文交给打分。
 * 打分本身仍是 aiEvidenceSearch 的纯函数，这里只管读盘，因此越界章节、读盘预算、索引降级都在一处。
 */
import type { AiCitation, ChapterStatus } from '../shared/types'
import { renderedParagraphs } from '../shared/aiText'
import {
  evidenceReadHints,
  selectLocalEvidence,
  type EvidenceReaderNote,
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

/**
 * 把读者划线原文定位到段号，只用于排序加分。
 * 本次没读正文的章、或正文改写后找不到原句的划线，一律当没有：批注永远不可能少给引用。
 */
export function resolveReaderNoteHints(
  chapters: readonly EvidenceSearchChapter[],
  hints: readonly { chapterId: string; excerpt: string }[] | undefined,
): EvidenceReaderNote[] {
  if (!hints?.length) return []
  const bodies = new Map(chapters.filter((chapter) => chapter.body).map((chapter) => [chapter.id, chapter.body]))
  const notes: EvidenceReaderNote[] = []
  const seen = new Set<string>()
  for (const hint of hints) {
    const body = bodies.get(hint.chapterId)
    // 跨段选区的首段仍能整段命中，取首段即可定位读者真正指的那一段。
    const probe = hint.excerpt.split(/\n{2,}/)[0]?.trim()
    if (!body || !probe) continue
    const paragraphIndex = renderedParagraphs(body).findIndex((paragraph) => paragraph.includes(probe))
    if (paragraphIndex < 0) continue
    const key = `${hint.chapterId}:${paragraphIndex}`
    if (seen.has(key)) continue
    seen.add(key)
    notes.push({ chapterId: hint.chapterId, paragraphIndex })
  }
  return notes
}

export async function retrieveLocalEvidence(input: {
  bookId: string
  chapters: readonly EvidenceChapterHeader[]
  query: EvidenceSearchQuery
  options: EvidenceSearchOptions
  readBody: (chapterId: string) => Promise<{ body: string; status: ChapterStatus | string }>
  maxChapterReads?: number
  stopped?: () => boolean
  /** 读盘之前回报剪枝计划：索引还没建完时界面要说「本次通读全部已读正文」，不能让人以为卡住了。 */
  onProgress?: (progress: EvidenceReads) => void
  /** 读者划线原文：段号只能在正文读进来之后定位，所以 hint 与 resolved 分两步。 */
  readerNoteHints?: readonly { chapterId: string; excerpt: string }[]
}): Promise<{ citations: AiCitation[]; fallbackQuery: boolean; uptoChapterId: string; topScore: number; reads: EvidenceReads }> {
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
  input.onProgress?.({ indexed: plan.indexed, total: plan.total, read: plan.readIds.size })

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
  const readerNotes = resolveReaderNoteHints(searchChapters, input.readerNoteHints)
  const result = selectLocalEvidence(searchChapters, input.query, { ...input.options, readerNotes })
  return { ...result, reads }
}
