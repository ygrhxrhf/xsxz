import type { AiCitation, AiMemoryFile, AiSummaries, ChapterStatus } from '../shared/types'
import { normalizeSearchView, normalizedTerm, renderedParagraphs, retrievalTerms, scanViewTokens, type SearchView } from '../shared/aiText'

/** 阅读进度缺失时的统一文案；剪枝编排也要抛同一条，不能让调用方看到两种说法。 */
export const EVIDENCE_NO_PROGRESS_MESSAGE = '还没有阅读进度，先阅读一章再使用已读内容分析。'

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
  memory?: AiMemoryFile | null
  summaries?: AiSummaries | null
  /** 读者的划线与笔记所在段：只提升排序，绝不作为剧情事实。 */
  readerNotes?: readonly EvidenceReaderNote[]
}

export interface EvidenceReaderNote {
  chapterId: string
  paragraphIndex: number
}

interface Paragraph {
  text: string
  index: number
}

interface Candidate {
  citation: AiCitation
  score: number
  chapterIndex: number
}

/** 只靠词面重叠入围的段落：排序要等全库 df 统计完成，先存下裁摘录需要的坐标。 */
interface Overlap {
  chapterId: string
  chapterTitle: string
  chapterPosition: number
  chapterIndex: number
  paragraphIndex: number
  displayText: string
  matchUtf16: number
  length: number
  terms: Array<{ term: string; tf: number }>
}

const MAX_OVERLAPS = 256

function codePointLength(text: string): number {
  return Array.from(text).length
}

function paragraphList(body: string): Paragraph[] {
  return renderedParagraphs(body).map((text, index) => ({ text, index }))
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.trunc(value!)))
}

function aliasExpansions(memory: AiMemoryFile | null | undefined, question: string): string[] {
  if (!memory) return []
  const normalizedQuestion = normalizedTerm(question)
  const expansions: string[] = []
  const seen = new Set<string>()
  for (const character of memory.characters) {
    if (character.accuracy !== 'normal') continue
    const names = [character.name, ...character.aliases]
      .map((label) => label.trim())
      .filter((label) => codePointLength(label) >= 2)
    const matched = names.some((label) => normalizedQuestion.includes(normalizedTerm(label)))
    if (!matched) continue
    for (const label of names) {
      const term = normalizedTerm(label)
      if (seen.has(term) || normalizedQuestion.includes(term)) continue
      seen.add(term)
      expansions.push(term)
    }
  }
  return expansions
}

/** Memory is only a locator. The returned evidence still comes from a ready, read chapter. */
function memoryParagraphHints(memory: AiMemoryFile | null | undefined, question: string): Map<string, Map<number, string[]>> {
  const hints = new Map<string, Map<number, string[]>>()
  if (!memory) return hints
  const normalizedQuestion = normalizedTerm(`${question} ${aliasExpansions(memory, question).join(' ')}`)
  const items = [...memory.characters, ...memory.relations, ...memory.foreshadows, ...memory.events]
  for (const item of items) {
    if (item.accuracy !== 'normal') continue
    const labels = 'name' in item ? [item.name, ...item.aliases]
      : 'from' in item ? [item.from, item.to]
      : 'desc' in item ? [item.desc]
      : [item.title]
    if (!labels.some((label) => codePointLength(label.trim()) >= 2 && normalizedQuestion.includes(normalizedTerm(label)))) continue
    for (const source of item.sources) {
      const positions = hints.get(source.chapterId) ?? new Map<number, string[]>()
      positions.set(source.paragraphIndex, [...(positions.get(source.paragraphIndex) ?? []), source.excerpt])
      hints.set(source.chapterId, positions)
    }
  }
  return hints
}

function quotedSelectionAnchor(question: string): string {
  const selected = /「([^」]{2,})」/u.exec(question)?.[1]
  return selected ? Array.from(normalizedTerm(selected)).slice(0, 30).join('') : ''
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

function clipAround(text: string, utf16Position: number, limit: number): string {
  const before = text.slice(0, Math.max(0, utf16Position))
  const position = codePointLength(before)
  const characters = Array.from(text)
  const start = Math.max(0, Math.min(characters.length - limit, position - Math.floor(limit / 2)))
  return characters.slice(start, start + limit).join('').trim()
}

function makeCitation(
  chapterId: string,
  chapterTitle: string,
  paragraphIndex: number,
  displayText: string,
  matchUtf16: number,
  excerptLimit: number,
): AiCitation {
  return {
    id: `qa-${chapterId}-p${paragraphIndex}`,
    chapterId,
    chapterTitle,
    paragraphIndex,
    excerpt: clipAround(displayText, matchUtf16, excerptLimit),
  }
}

/** 二元组与拉丁词才是可用词形：单字重叠太密，会让「不存在的人名」也命中整章。 */
function significantTerms(text: string): Set<string> {
  const terms = new Set<string>()
  for (const token of scanViewTokens(text)) if (token.term.length >= 2) terms.add(token.term)
  return terms
}

function queryOverlapTerms(searchTerms: { corePhrase: string; keywords: readonly string[] }, aliases: readonly string[]): Set<string> {
  const query = new Set<string>()
  for (const phrase of [searchTerms.corePhrase, ...searchTerms.keywords, ...aliases]) {
    for (const term of significantTerms(phrase)) query.add(term)
  }
  return query
}

interface OverlapMatch {
  terms: Array<{ term: string; tf: number }>
  firstAt: number
}

function matchOverlap(view: SearchView, wanted: Set<string>): OverlapMatch | null {
  if (!wanted.size) return null
  const counts = new Map<string, number>()
  let firstAt = -1
  for (const token of scanViewTokens(view.text)) {
    if (token.term.length < 2 || !wanted.has(token.term)) continue
    counts.set(token.term, (counts.get(token.term) ?? 0) + 1)
    if (firstAt < 0 || token.at < firstAt) firstAt = token.at
  }
  if (!counts.size) return null
  return { terms: [...counts.entries()].map(([term, tf]) => ({ term, tf })), firstAt }
}

function firstLiteralPosition(view: SearchView, matchingKeywords: readonly string[]): number {
  return matchingKeywords.reduce((best, term) => {
    const found = view.text.indexOf(term)
    return best < 0 || (found >= 0 && found < best) ? found : best
  }, -1)
}

/**
 * 摘录以命中处为中心；段落太短会缺上下文，此时并入相邻渲染段落一起裁，
 * 但 paragraphIndex 仍是命中段本身，跳转坐标不受影响。
 */
function displayContext(paragraphs: readonly Paragraph[], index: number): { text: string; prefixLength: number } {
  const current = paragraphs[index]?.text ?? ''
  if (codePointLength(current) >= 120 || paragraphs.length < 2) return { text: current, prefixLength: 0 }
  const previous = paragraphs[index - 1]?.text
  const next = paragraphs[index + 1]?.text
  const prefix = previous ? `${previous}\n\n` : ''
  const suffix = next ? `\n\n${next}` : ''
  return { text: `${prefix}${current}${suffix}`, prefixLength: prefix.length }
}

interface EvidenceQueryPlan {
  cutoffPosition: number
  uptoChapterId: string
  currentPosition: number
  /** 别名扩张之前的原始词面：aliasOnlyMatch 要靠它区分「只有别名命中」。 */
  baseTerms: { corePhrase: string; keywords: string[]; fallback: boolean }
  searchTerms: { corePhrase: string; keywords: string[] }
  expandedAliases: string[]
  memoryHints: Map<string, Map<number, string[]>>
  summaryHints: Set<string>
  selectedAnchor: string
  overlapWanted: Set<string>
  noteParagraphs: Map<string, Set<number>>
  noteChapterIds: Set<string>
}

/** 只依赖章节目录与记忆/摘要，不碰正文：读盘前的剪枝决策与读盘后的打分共用同一份准备结果。 */
function planEvidenceQuery(
  ordered: readonly { id: string; index: number }[],
  query: EvidenceSearchQuery,
  options: EvidenceSearchOptions,
): EvidenceQueryPlan {
  const requestedPosition = ordered.findIndex((chapter) => chapter.id === options.requestedUptoChapterId)
  const progressPosition = ordered.findIndex((chapter) => chapter.id === options.progressChapterId)
  if (requestedPosition < 0 || progressPosition < 0) throw new Error(EVIDENCE_NO_PROGRESS_MESSAGE)
  const cutoffPosition = Math.min(requestedPosition, progressPosition)
  const uptoChapterId = ordered[cutoffPosition]!.id
  const currentPosition = ordered.findIndex((chapter) => chapter.id === options.currentChapterId)
  const terms = normalizeEvidenceSearchTerms(query)
  const expandedAliases = aliasExpansions(options.memory, `${query.originalQuestion} ${query.corePhrase ?? ''} ${(query.keywords ?? []).join(' ')}`)
  const keywords = [...terms.keywords]
  for (const alias of expandedAliases) {
    if (keywords.includes(alias) || alias === terms.corePhrase || keywords.length >= 8) continue
    keywords.push(alias)
  }
  const searchTerms = { corePhrase: terms.corePhrase, keywords }
  const memoryHints = memoryParagraphHints(options.memory, query.originalQuestion)
  const selectedAnchor = quotedSelectionAnchor(query.originalQuestion)
  const summaryHints = new Set(Object.entries(options.summaries?.byChapter ?? {})
    .filter(([, summary]) => {
      const text = normalizedTerm(summary)
      return (searchTerms.corePhrase && text.includes(searchTerms.corePhrase)) ||
        searchTerms.keywords.some((term) => text.includes(term))
    }).map(([chapterId]) => chapterId))
  const noteParagraphs = new Map<string, Set<number>>()
  const noteChapterIds = new Set<string>()
  for (const note of options.readerNotes ?? []) {
    noteChapterIds.add(note.chapterId)
    const set = noteParagraphs.get(note.chapterId) ?? new Set<number>()
    set.add(note.paragraphIndex)
    noteParagraphs.set(note.chapterId, set)
  }
  const overlapWanted = queryOverlapTerms(searchTerms, expandedAliases)
  return {
    cutoffPosition, uptoChapterId, currentPosition, baseTerms: terms, searchTerms, expandedAliases,
    memoryHints, summaryHints, selectedAnchor, overlapWanted, noteParagraphs, noteChapterIds,
  }
}

/**
 * 读盘前的剪枝依据：可测词形集合 + 必须读的章。
 * prunable=false 时调用方必须全扫——问句或「」引用里出现单字面短语时，二元词形测不出它，
 * 宁可慢也不能漏引用。
 */
export function evidenceReadHints(
  chapters: readonly { id: string; index: number }[],
  query: EvidenceSearchQuery,
  options: EvidenceSearchOptions,
): { cutoffPosition: number; uptoChapterId: string; currentIndex: number | undefined; prunable: boolean; terms: Set<string>; mandatory: Set<string> } {
  const ordered = [...chapters].sort((left, right) => left.index - right.index)
  const plan = planEvidenceQuery(ordered, query, options)
  const literals = [
    plan.searchTerms.corePhrase,
    ...plan.searchTerms.keywords,
    ...plan.expandedAliases,
    plan.selectedAnchor,
  ].filter((phrase) => phrase.length > 0)
  const terms = new Set<string>()
  for (const phrase of literals) {
    for (const term of retrievalTerms(phrase)) terms.add(term)
  }
  const shortLiteral = literals.some((phrase) => codePointLength(phrase) < 2)
  const mandatory = new Set<string>([
    ...plan.memoryHints.keys(),
    ...plan.summaryHints,
    ...(plan.currentPosition >= 0 ? [ordered[plan.currentPosition]!.id] : []),
    ordered[plan.cutoffPosition]!.id,
  ])
  return {
    cutoffPosition: plan.cutoffPosition,
    uptoChapterId: plan.uptoChapterId,
    currentIndex: plan.currentPosition >= 0 ? ordered[plan.currentPosition]!.index : undefined,
    prunable: !shortLiteral && terms.size > 0,
    terms,
    mandatory,
  }
}

export function selectLocalEvidence(
  chapters: readonly EvidenceSearchChapter[],
  query: EvidenceSearchQuery,
  options: EvidenceSearchOptions,
): { citations: AiCitation[]; fallbackQuery: boolean; uptoChapterId: string; topScore: number } {
  const chapterIds = new Set<string>()
  for (const chapter of chapters) {
    if (chapterIds.has(chapter.id)) throw new Error('章节 ID 重复，无法生成唯一证据坐标')
    chapterIds.add(chapter.id)
  }
  const ordered = [...chapters].sort((left, right) => left.index - right.index)
  const plan = planEvidenceQuery(ordered, query, options)
  const { cutoffPosition, uptoChapterId, currentPosition, baseTerms, searchTerms, expandedAliases, memoryHints, summaryHints, selectedAnchor, overlapWanted, noteParagraphs, noteChapterIds } = plan
  if (!searchTerms.corePhrase && !searchTerms.keywords.length && !memoryHints.size && !selectedAnchor && !overlapWanted.size) {
    return { citations: [], fallbackQuery: baseTerms.fallback, uptoChapterId, topScore: 0 }
  }
  const excerptLimit = boundedInteger(options.excerptCharacters, 300, 80, 600)
  const candidates: Candidate[] = []
  const overlaps: Overlap[] = []
  const documentFrequency = new Map<string, number>()
  let chapterCount = 0
  let paragraphCount = 0
  let paragraphLengthTotal = 0

  ordered.forEach((chapter, position) => {
    if (position > cutoffPosition || chapter.status !== 'ready' || !chapter.body.trim()) return
    const title = normalizedTerm(chapter.title)
    const paragraphs = paragraphList(chapter.body)
    const chapterTerms = new Set<string>()
    paragraphCount += paragraphs.length
    chapterCount += 1
    paragraphs.forEach((paragraph) => {
      const view = normalizeSearchView(paragraph.text)
      paragraphLengthTotal += codePointLength(view.text)
      const corePosition = searchTerms.corePhrase ? view.text.indexOf(searchTerms.corePhrase) : -1
      const selectedPosition = selectedAnchor ? view.text.indexOf(selectedAnchor) : -1
      const matchingKeywords = searchTerms.keywords.filter((term) => view.text.includes(term))
      const aliasOnlyMatch = expandedAliases.some((term) => view.text.includes(term)) &&
        !(baseTerms.corePhrase && view.text.includes(baseTerms.corePhrase)) &&
        !baseTerms.keywords.some((term) => view.text.includes(term))
      const hinted = memoryHints.get(chapter.id)?.get(paragraph.index)?.some((excerpt) =>
        Boolean(excerpt.trim()) && view.text.includes(normalizedTerm(excerpt))) === true
      const literalHit = corePosition >= 0 || selectedPosition >= 0 || matchingKeywords.length > 0 || hinted
      const overlap = matchOverlap(view, overlapWanted)
      if (overlap) for (const entry of overlap.terms) chapterTerms.add(entry.term)
      const context = displayContext(paragraphs, paragraph.index)
      if (!literalHit) {
        if (!overlap) return
        overlaps.push({
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          chapterPosition: position,
          chapterIndex: chapter.index,
          paragraphIndex: paragraph.index,
          displayText: context.text,
          matchUtf16: context.prefixLength + (view.originalOffsets[Math.max(0, overlap.firstAt)] ?? 0),
          length: codePointLength(view.text),
          terms: overlap.terms,
        })
        return
      }
      let score = corePosition >= 0 ? 100 : 0
      if (selectedPosition >= 0) score += 150
      score += matchingKeywords.length * 20
      if (hinted) score += 80
      if (aliasOnlyMatch) score += 70
      if (summaryHints.has(chapter.id)) score += 25
      if (searchTerms.corePhrase && title.includes(searchTerms.corePhrase)) score += 15
      score += searchTerms.keywords.filter((term) => title.includes(term)).length * 5
      if (noteParagraphs.get(chapter.id)?.has(paragraph.index)) score += 60
      else if (noteChapterIds.has(chapter.id)) score += 20
      if (chapter.id === options.currentChapterId) score += 30
      if (currentPosition >= 0) score += Math.max(0, 10 - Math.abs(position - currentPosition))
      const literalPosition = selectedPosition >= 0 ? selectedPosition : corePosition >= 0 ? corePosition : firstLiteralPosition(view, matchingKeywords)
      candidates.push({
        citation: makeCitation(
          chapter.id, chapter.title, paragraph.index, context.text,
          context.prefixLength + (view.originalOffsets[Math.max(0, literalPosition)] ?? 0),
          excerptLimit,
        ),
        score,
        chapterIndex: chapter.index,
      })
    })
    for (const term of chapterTerms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
  })

  const averageLength = paragraphCount ? Math.max(1, paragraphLengthTotal / paragraphCount) : 1
  overlaps.sort((left, right) => right.terms.length - left.terms.length || left.chapterIndex - right.chapterIndex)
  for (const overlap of overlaps.slice(0, MAX_OVERLAPS)) {
    let score = 30
    for (const { term, tf } of overlap.terms) {
      const df = documentFrequency.get(term) ?? 1
      const idf = Math.log(1 + (chapterCount - df + 0.5) / (df + 0.5))
      const lengthNorm = 1.2 * (0.25 + 0.75 * (overlap.length / averageLength))
      score += Math.max(0, idf) * ((tf * 2.2) / (tf + lengthNorm))
    }
    if (summaryHints.has(overlap.chapterId)) score += 25
    if (noteParagraphs.get(overlap.chapterId)?.has(overlap.paragraphIndex)) score += 60
    else if (noteChapterIds.has(overlap.chapterId)) score += 20
    if (overlap.chapterId === options.currentChapterId) score += 30
    if (currentPosition >= 0) score += Math.max(0, 10 - Math.abs(overlap.chapterPosition - currentPosition))
    candidates.push({
      citation: makeCitation(
        overlap.chapterId, overlap.chapterTitle, overlap.paragraphIndex,
        overlap.displayText, overlap.matchUtf16, excerptLimit,
      ),
      // 上限 95：没有原文短语可核验的改述候选，永远排在 corePhrase 字面命中（+100 起）之后。
      score: Math.min(95, score),
      chapterIndex: overlap.chapterIndex,
    })
  }

  candidates.sort((left, right) =>
    right.score - left.score || right.chapterIndex - left.chapterIndex ||
    left.citation.paragraphIndex - right.citation.paragraphIndex || left.citation.id.localeCompare(right.citation.id))
  const maxResults = boundedInteger(options.maxResults, 8, 1, 8)
  const maxChapters = boundedInteger(options.maxChapters, 6, 1, 6)
  const topScore = candidates[0]?.score ?? 0
  const selectedChapterIds = new Set<string>()
  const citations: AiCitation[] = []
  for (const candidate of candidates) {
    const isNewChapter = !selectedChapterIds.has(candidate.citation.chapterId)
    if (isNewChapter && selectedChapterIds.size >= maxChapters) continue
    citations.push(candidate.citation)
    selectedChapterIds.add(candidate.citation.chapterId)
    if (citations.length === maxResults) break
  }
  return { citations, fallbackQuery: baseTerms.fallback, uptoChapterId, topScore }
}
