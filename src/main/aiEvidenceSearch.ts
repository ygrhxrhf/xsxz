import type { AiCitation, ChapterStatus } from '../shared/types'

export interface EvidenceSearchChapter {
  id: string
  index: number
  title: string
  status: ChapterStatus | string
  body: string
}

export interface EvidenceSearchQuery {
  originalQuestion: string
  corePhrase?: string
  keywords?: readonly string[]
}

export interface EvidenceSearchOptions {
  requestedUptoChapterId: string
  progressChapterId: string
  currentChapterId?: string
  maxResults?: number
  maxChapters?: number
  excerptCharacters?: number
}

interface Candidate {
  citation: AiCitation
  score: number
  chapterIndex: number
}

function codePointLength(text: string): number {
  return Array.from(text).length
}

interface SearchView {
  text: string
  originalOffsets: number[]
}

function normalizedSearchView(text: string): SearchView {
  let normalized = ''
  const originalOffsets: number[] = []
  let pendingWhitespaceOffset: number | null = null
  let utf16Offset = 0
  for (const character of text) {
    if (/\s/u.test(character)) {
      if (normalized && pendingWhitespaceOffset === null) pendingWhitespaceOffset = utf16Offset
      utf16Offset += character.length
      continue
    }
    if (pendingWhitespaceOffset !== null) {
      normalized += ' '
      originalOffsets.push(pendingWhitespaceOffset)
      pendingWhitespaceOffset = null
    }
    const lowered = character.toLocaleLowerCase()
    normalized += lowered
    for (let index = 0; index < lowered.length; index += 1) originalOffsets.push(utf16Offset)
    utf16Offset += character.length
  }
  return { text: normalized, originalOffsets }
}

function normalizedTerm(text: string): string {
  return normalizedSearchView(text).text
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.trunc(value!)))
}

export function normalizeEvidenceSearchTerms(query: EvidenceSearchQuery): {
  corePhrase: string
  keywords: string[]
  fallback: boolean
} {
  const original = normalizedTerm(query.originalQuestion)
  const core = normalizedTerm(query.corePhrase ?? '')
  const seen = new Set<string>()
  const keywords: string[] = []
  for (const raw of query.keywords ?? []) {
    const term = normalizedTerm(raw)
    const length = codePointLength(term)
    if (length < 2 || length > 20 || seen.has(term) || term === core) continue
    seen.add(term)
    keywords.push(term)
    if (keywords.length === 5) break
  }
  if (core || keywords.length) return { corePhrase: core, keywords, fallback: false }
  return { corePhrase: original, keywords: [], fallback: true }
}

function paragraphRanges(body: string): Array<{ text: string; start: number; index: number }> {
  const result: Array<{ text: string; start: number; index: number }> = []
  let cursor = 0
  body.split(/\n{2,}/).filter(Boolean).forEach((text, index) => {
    const start = body.indexOf(text, cursor)
    result.push({ text, start: Math.max(0, start), index })
    cursor = Math.max(cursor, start + text.length)
  })
  return result
}

function clipAround(text: string, utf16Position: number, limit: number): string {
  const before = text.slice(0, Math.max(0, utf16Position))
  const position = codePointLength(before)
  const characters = Array.from(text)
  const start = Math.max(0, Math.min(characters.length - limit, position - Math.floor(limit / 2)))
  return characters.slice(start, start + limit).join('').trim()
}

export function selectLocalEvidence(
  chapters: readonly EvidenceSearchChapter[],
  query: EvidenceSearchQuery,
  options: EvidenceSearchOptions,
): { citations: AiCitation[]; fallbackQuery: boolean; uptoChapterId: string } {
  const chapterIds = new Set<string>()
  for (const chapter of chapters) {
    if (chapterIds.has(chapter.id)) throw new Error('章节 ID 重复，无法生成唯一证据坐标')
    chapterIds.add(chapter.id)
  }
  const ordered = [...chapters].sort((left, right) => left.index - right.index)
  const requestedPosition = ordered.findIndex((chapter) => chapter.id === options.requestedUptoChapterId)
  const progressPosition = ordered.findIndex((chapter) => chapter.id === options.progressChapterId)
  if (requestedPosition < 0 || progressPosition < 0) throw new Error('还没有阅读进度，先阅读一章再使用已读内容分析。')
  const cutoffPosition = Math.min(requestedPosition, progressPosition)
  const uptoChapterId = ordered[cutoffPosition]!.id
  const currentPosition = ordered.findIndex((chapter) => chapter.id === options.currentChapterId)
  const terms = normalizeEvidenceSearchTerms(query)
  if (!terms.corePhrase && !terms.keywords.length) return { citations: [], fallbackQuery: terms.fallback, uptoChapterId }
  const excerptLimit = boundedInteger(options.excerptCharacters, 300, 80, 600)
  const candidates: Candidate[] = []

  ordered.forEach((chapter, position) => {
    if (position > cutoffPosition || chapter.status !== 'ready' || !chapter.body.trim()) return
    const title = normalizedSearchView(chapter.title).text
    paragraphRanges(chapter.body).forEach((paragraph) => {
      const view = normalizedSearchView(paragraph.text)
      const corePosition = terms.corePhrase ? view.text.indexOf(terms.corePhrase) : -1
      const matchingKeywords = terms.keywords.filter((term) => view.text.includes(term))
      if (corePosition < 0 && !matchingKeywords.length) return
      const firstKeywordPosition = matchingKeywords.reduce((best, term) => {
        const found = view.text.indexOf(term)
        return best < 0 || (found >= 0 && found < best) ? found : best
      }, -1)
      const paragraphMatchPosition = corePosition >= 0 ? corePosition : firstKeywordPosition
      const originalMatchOffset = view.originalOffsets[Math.max(0, paragraphMatchPosition)] ?? 0
      let score = corePosition >= 0 ? 100 : 0
      score += matchingKeywords.length * 20
      if (terms.corePhrase && title.includes(terms.corePhrase)) score += 15
      score += terms.keywords.filter((term) => title.includes(term)).length * 5
      if (chapter.id === options.currentChapterId) score += 30
      if (currentPosition >= 0) score += Math.max(0, 10 - Math.abs(position - currentPosition))
      candidates.push({
        citation: {
          id: `qa-${chapter.id}-p${paragraph.index}`,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          paragraphIndex: paragraph.index,
          excerpt: clipAround(paragraph.text, originalMatchOffset, excerptLimit),
        },
        score,
        chapterIndex: chapter.index,
      })
    })
  })

  candidates.sort((left, right) =>
    right.score - left.score || right.chapterIndex - left.chapterIndex ||
    left.citation.paragraphIndex - right.citation.paragraphIndex || left.citation.id.localeCompare(right.citation.id))
  const maxResults = boundedInteger(options.maxResults, 8, 1, 8)
  const maxChapters = boundedInteger(options.maxChapters, 6, 1, 6)
  const selectedChapterIds = new Set<string>()
  const citations: AiCitation[] = []
  for (const candidate of candidates) {
    const isNewChapter = !selectedChapterIds.has(candidate.citation.chapterId)
    if (isNewChapter && selectedChapterIds.size >= maxChapters) continue
    citations.push(candidate.citation)
    selectedChapterIds.add(candidate.citation.chapterId)
    if (citations.length === maxResults) break
  }
  return { citations, fallbackQuery: terms.fallback, uptoChapterId }
}
