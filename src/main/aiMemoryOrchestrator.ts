import type { AiMemoryBase, AiMemoryFile, AiMemoryUpdateResult, ChapterStatus } from '../shared/types'
import { AI_INPUT_CHARACTER_BUDGET, countTextCharacters } from './aiBudget'
import { MEMORY_BATCH_CHAPTERS } from './aiMaterial'
import {
  applyAiMemoryExtraction,
  buildAiMemoryCandidates,
  type AiMemoryCandidate,
} from './aiMemory'

export interface MemoryChapterInput {
  id: string
  index: number
  title: string
  status: ChapterStatus | string
  body?: string
}

export interface MemoryChapterSelection {
  batches: MemoryChapterInput[][]
  /** 章数上限之后仍未处理的已读章节数；重建恒为 0。 */
  remainingChapters: number
  eligibleChapterIds: string[]
}

export interface MemoryPromptRequest {
  prompt: string
  candidates: AiMemoryCandidate[]
  reviewItemIds: Set<string>
}

export type MemoryCompletion = (request: MemoryPromptRequest, signal?: AbortSignal) => Promise<unknown>

function chapterPosition(chapters: MemoryChapterInput[], chapterId?: string | null): number {
  return chapterId ? chapters.findIndex((chapter) => chapter.id === chapterId) : -1
}

export function selectMemoryChapterBatches(
  chapters: MemoryChapterInput[],
  requestedUptoChapterId: string,
  progressChapterId: string | null | undefined,
  previousUptoChapterId: string | undefined,
  mode: 'update' | 'rebuild',
  maxChaptersPerRun = Number.POSITIVE_INFINITY,
): MemoryChapterSelection {
  const ordered = [...chapters].sort((left, right) => left.index - right.index)
  const requestedPosition = chapterPosition(ordered, requestedUptoChapterId)
  if (requestedPosition < 0) throw new Error('章节不存在')
  const progressPosition = chapterPosition(ordered, progressChapterId)
  if (progressPosition < 0) return { batches: [], remainingChapters: 0, eligibleChapterIds: [] }
  const cutoffPosition = Math.min(requestedPosition, progressPosition)
  const eligible = ordered.filter((chapter, position) =>
    position <= cutoffPosition && chapter.status === 'ready')
  const previousPosition = mode === 'update' ? chapterPosition(ordered, previousUptoChapterId) : -1
  const pending = mode === 'update' && previousPosition >= 0
    ? eligible.filter((chapter) => chapterPosition(ordered, chapter.id) > previousPosition)
    : eligible
  // 重建是一次性的，跑不完就等于没重建；只有增量更新按单次运行的章数截断。
  const runLimit = mode === 'update' && Number.isFinite(maxChaptersPerRun) && maxChaptersPerRun > 0
    ? Math.floor(maxChaptersPerRun)
    : pending.length
  const running = pending.slice(0, runLimit)
  const batches: MemoryChapterInput[][] = []
  for (let index = 0; index < running.length; index += MEMORY_BATCH_CHAPTERS) {
    batches.push(running.slice(index, index + MEMORY_BATCH_CHAPTERS))
  }
  return {
    batches,
    remainingChapters: Math.max(0, pending.length - running.length),
    eligibleChapterIds: eligible.map((chapter) => chapter.id),
  }
}

function allMemoryItems(memory: AiMemoryFile): AiMemoryBase[] {
  return [...memory.characters, ...memory.relations, ...memory.foreshadows, ...memory.events]
}

function reviewItems(memory: AiMemoryFile | null): AiMemoryBase[] {
  return memory ? allMemoryItems(memory).filter((item) => item.accuracy === 'review') : []
}

function emptyRaw(): Record<string, unknown> {
  return { characters: [], relations: [], foreshadows: [], events: [], reviewDecisions: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function filterReviewDecisions(raw: unknown, reviewItemIds: ReadonlySet<string>): unknown {
  if (!reviewItemIds.size || !isRecord(raw) || !Array.isArray(raw.reviewDecisions)) return raw
  return {
    ...raw,
    reviewDecisions: raw.reviewDecisions.filter((decision) =>
      isRecord(decision) && typeof decision.itemId === 'string' &&
      typeof decision.confirmed === 'boolean' && reviewItemIds.has(decision.itemId.trim())),
  }
}

function promptText(
  bookTitle: string,
  instruction: string,
  candidates: AiMemoryCandidate[],
  review: AiMemoryBase | null,
): string {
  const candidatePayload = candidates.map((candidate) => ({
    id: candidate.id,
    chapterId: candidate.chapterId,
    chapterTitle: candidate.chapterTitle,
    paragraphIndex: candidate.paragraphIndex,
    text: candidate.text,
  }))
  return `用户任务要求：\n${instruction}\n\n固定规则：只能使用“候选证据”中的文字；所有新条目 citationIds 必须只取候选证据 id；禁止补充未提供章节、坐标或事实；没有可靠事实时返回空数组；只返回 JSON 对象，不返回推理过程。\n\n书名：《${bookTitle}》\n\n待复核条目：\n${review ? JSON.stringify(review) : 'null'}\n\n候选证据：\n${JSON.stringify(candidatePayload)}\n\nJSON schema：\n{"characters":[{"name":"","aliases":[],"role":"","status":"","summary":"","citationIds":[]}],"relations":[{"from":"","to":"","relation":"","status":"","summary":"","citationIds":[]}],"foreshadows":[{"desc":"","status":"open|resolved|uncertain","summary":"","citationIds":[]}],"events":[{"title":"","participants":[],"result":"","summary":"","citationIds":[]}],"reviewDecisions":[{"itemId":"","confirmed":true}]}`
}

function assertPromptBudget(prompt: string): void {
  if (countTextCharacters(prompt) > AI_INPUT_CHARACTER_BUDGET) {
    throw new Error('记忆请求提示词和必要证据过长，无法在 30000 字预算内发送')
  }
}

export function planMemoryPromptRequests(
  bookTitle: string,
  instruction: string,
  candidates: readonly AiMemoryCandidate[],
  memory: AiMemoryFile | null,
  includeReviews: boolean,
  reviewChapterIds?: ReadonlySet<string>,
): MemoryPromptRequest[] {
  const requests: MemoryPromptRequest[] = []
  if (includeReviews) {
    for (const item of reviewItems(memory)) {
      if (reviewChapterIds && item.sources.some((source) => !reviewChapterIds.has(source.chapterId))) continue
      const sources = [...new Map(item.sources.map((source) => [source.id, source])).values()]
        .map((source) => ({ ...source, text: source.excerpt }))
      const prompt = promptText(bookTitle, instruction, sources, item)
      assertPromptBudget(prompt)
      requests.push({ prompt, candidates: sources, reviewItemIds: new Set([item.id]) })
    }
  }

  let group: AiMemoryCandidate[] = []
  for (const candidate of candidates) {
    const proposed = [...group, candidate]
    const prompt = promptText(bookTitle, instruction, proposed, null)
    if (countTextCharacters(prompt) <= AI_INPUT_CHARACTER_BUDGET) {
      group = proposed
      continue
    }
    if (!group.length) assertPromptBudget(prompt)
    const committedPrompt = promptText(bookTitle, instruction, group, null)
    assertPromptBudget(committedPrompt)
    requests.push({ prompt: committedPrompt, candidates: group, reviewItemIds: new Set() })
    group = [candidate]
  }
  if (group.length) {
    const prompt = promptText(bookTitle, instruction, group, null)
    assertPromptBudget(prompt)
    requests.push({ prompt, candidates: group, reviewItemIds: new Set() })
  }
  return requests
}

function itemMap(memory: AiMemoryFile | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!memory) return map
  for (const item of allMemoryItems(memory)) {
    const { updatedAt: _updatedAt, ...semantic } = item
    map.set(item.id, JSON.stringify(semantic))
  }
  return map
}

function changedItemCount(before: AiMemoryFile | null, after: AiMemoryFile): number {
  const previous = itemMap(before)
  const current = itemMap(after)
  const ids = new Set([...previous.keys(), ...current.keys()])
  let count = 0
  for (const id of ids) if (previous.get(id) !== current.get(id)) count += 1
  return count
}

function markUnresolvedReviewUncertain(memory: AiMemoryFile, itemId: string, updatedAt: string): void {
  const item = allMemoryItems(memory).find((candidate) => candidate.id === itemId)
  if (item?.accuracy === 'review') {
    item.accuracy = 'uncertain'
    item.updatedAt = updatedAt
    memory.updatedAt = updatedAt
  }
}

export async function executeMemoryOrchestration(
  bookTitle: string,
  initialMemory: AiMemoryFile | null,
  chapterBatches: readonly (readonly MemoryChapterInput[])[],
  remainingChapters: number,
  instruction: string,
  complete: MemoryCompletion,
  options: {
    includeReviews?: boolean
    reviewChapterIds?: ReadonlySet<string>
    signal?: AbortSignal
    updatedAt?: string
  } = {},
): Promise<AiMemoryUpdateResult> {
  const updatedAt = options.updatedAt ?? new Date().toISOString()
  let memory = initialMemory ? structuredClone(initialMemory) : null
  let processedChapters = 0

  const applyRequests = async (requests: MemoryPromptRequest[]) => {
    for (const request of requests) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const raw = await complete(request, options.signal)
      const trustedRaw = filterReviewDecisions(raw, request.reviewItemIds)
      const applied = applyAiMemoryExtraction(memory, trustedRaw, request.candidates, {
        reviewItemIds: request.reviewItemIds,
        updatedAt,
      })
      memory = applied.memory
      for (const itemId of request.reviewItemIds) {
        if (!applied.reviewedItemIds.includes(itemId)) markUnresolvedReviewUncertain(memory, itemId, updatedAt)
      }
    }
  }

  if (options.includeReviews === true) {
    await applyRequests(planMemoryPromptRequests(
      bookTitle, instruction, [], memory, true, options.reviewChapterIds,
    ))
  }

  const batches = chapterBatches
  for (const batch of batches) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const candidates = batch.flatMap((chapter) =>
      buildAiMemoryCandidates(chapter.id, chapter.title, chapter.body ?? ''))
    await applyRequests(planMemoryPromptRequests(
      bookTitle, instruction, candidates, memory, false, options.reviewChapterIds,
    ))
    processedChapters += batch.length
    const uptoChapterId = batch.at(-1)?.id
    if (uptoChapterId) {
      memory = applyAiMemoryExtraction(memory, emptyRaw(), [], { uptoChapterId, updatedAt }).memory
    }
  }

  if (!memory) {
    memory = applyAiMemoryExtraction(null, emptyRaw(), [], { updatedAt }).memory
  }
  return {
    memory,
    processedChapters,
    changedItems: changedItemCount(initialMemory, memory),
    remainingChapters,
  }
}
