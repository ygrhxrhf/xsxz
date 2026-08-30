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

function normalizedTerm(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
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
  const ordered = [...chapters].sort((left, right) => left.index - right.index)
  const requestedPosition = ordered.findIndex((chapter) => chapter.id === options.requestedUptoChapterId)
  const progressPosition = ordered.findIndex((chapter) => chapter.id === options.progressChapterId)
  if (requestedPosition < 0 || progressPosition < 0) throw new Error('还没有阅读进度，先阅读一章再使用已读内容分析。')
  const cutoffPosition = Math.min(requestedPosition, progressPosition)
  const uptoChapterId = ordered[cutoffPosition]!.id
  const currentPosition = ordered.findIndex((chapter) => chapter.id === options.currentChapterId)
  const terms = normalizeEvidenceSearchTerms(query)
  if (!terms.corePhrase && !terms.keywords.length) return { citations: [], fallbackQuery: terms.fallback, uptoChapterId }
  const excerptLimit = Math.max(80, Math.min(600, options.excerptCharacters ?? 300))
  const candidates: Candidate[] = []

  ordered.forEach((chapter, position) => {
    if (position > cutoffPosition || chapter.status !== 'ready' || !chapter.body.trim()) return
    const title = chapter.title.toLocaleLowerCase()
    paragraphRanges(chapter.body).forEach((paragraph) => {
      const haystack = paragraph.text.toLocaleLowerCase()
      const corePosition = terms.corePhrase ? haystack.indexOf(terms.corePhrase) : -1
      const matchingKeywords = terms.keywords.filter((term) => haystack.includes(term))
      if (corePosition < 0 && !matchingKeywords.length) return
      const firstKeywordPosition = matchingKeywords.reduce((best, term) => {
        const found = haystack.indexOf(term)
        return best < 0 || (found >= 0 && found < best) ? found : best
      }, -1)
      const paragraphMatchPosition = corePosition >= 0 ? corePosition : firstKeywordPosition
      const bodyPosition = paragraph.start + Math.max(0, paragraphMatchPosition)
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
          excerpt: clipAround(chapter.body, bodyPosition, excerptLimit),
        },
        score,
        chapterIndex: chapter.index,
      })
    })
  })

  candidates.sort((left, right) =>
    right.score - left.score || right.chapterIndex - left.chapterIndex ||
    left.citation.paragraphIndex - right.citation.paragraphIndex || left.citation.id.localeCompare(right.citation.id))
  const maxResults = Math.max(1, Math.min(8, options.maxResults ?? 8))
  const maxChapters = Math.max(1, Math.min(6, options.maxChapters ?? 6))
  const chapterIds = new Set<string>()
  const citations: AiCitation[] = []
  for (const candidate of candidates) {
    const isNewChapter = !chapterIds.has(candidate.citation.chapterId)
    if (isNewChapter && chapterIds.size >= maxChapters) continue
    citations.push(candidate.citation)
    chapterIds.add(candidate.citation.chapterId)
    if (citations.length === maxResults) break
  }
  return { citations, fallbackQuery: terms.fallback, uptoChapterId }
}
