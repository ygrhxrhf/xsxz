import type { AiBookUsage, AiMaterialCoverage, AiMemoryBase, AiMemoryCharacter, AiMemoryFile, AiUsage, ChapterStatus } from '../shared/types'

export interface CoverageChapter {
  id: string
  index: number
  title: string
  status: ChapterStatus | string
}

const ALIAS_LIMIT = 12

function normalizedAlias(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

export function correctCharacterAliases(
  memory: AiMemoryFile,
  itemId: string,
  aliases: readonly string[],
  updatedAt: string,
): { memory: AiMemoryFile; character: AiMemoryCharacter; affectedChapterIds: string[] } {
  const character = memory.characters.find((item) => item.id === itemId)
  if (!character) throw new Error('记忆条目不存在')
  const seen = new Set<string>()
  const next: string[] = []
  for (const raw of aliases) {
    const alias = normalizedAlias(raw)
    const key = alias.toLocaleLowerCase('zh-CN')
    if (!alias || key === normalizedAlias(character.name).toLocaleLowerCase('zh-CN') || seen.has(key)) continue
    if (Array.from(alias).length > 20) throw new Error('别名过长，请控制在 20 字以内')
    seen.add(key)
    next.push(alias)
    if (next.length > ALIAS_LIMIT) throw new Error(`别名最多 ${ALIAS_LIMIT} 个`)
  }
  character.aliases = next
  character.userEditedAliases = true
  character.updatedAt = updatedAt
  memory.updatedAt = updatedAt
  return {
    memory,
    character,
    affectedChapterIds: [...new Set(character.sources.map((source) => source.chapterId))],
  }
}

export type MemoryItemKind = 'character' | 'relation' | 'foreshadow' | 'event'

const memoryCollections = {
  character: 'characters', relation: 'relations', foreshadow: 'foreshadows', event: 'events',
} as const

export function correctMemorySummary(
  memory: AiMemoryFile,
  kind: MemoryItemKind,
  itemId: string,
  summary: string,
  updatedAt: string,
): { memory: AiMemoryFile; item: AiMemoryBase; affectedChapterIds: string[] } {
  const item = (memory[memoryCollections[kind]] as AiMemoryBase[]).find((entry) => entry.id === itemId)
  if (!item) throw new Error('记忆条目不存在')
  const value = summary.trim()
  if (!value || Array.from(value).length > 500) throw new Error('修正内容须为 1 至 500 字')
  item.summary = value
  item.userEditedSummary = true
  item.accuracy = 'normal'
  item.updatedAt = updatedAt
  memory.updatedAt = updatedAt
  return { memory, item, affectedChapterIds: [...new Set(item.sources.map((source) => source.chapterId))] }
}

/** Keep only facts whose original evidence predates the chapter being regenerated. */
export function seedMemoryBeforeChapter(
  memory: AiMemoryFile | null,
  chapters: readonly CoverageChapter[],
  fromChapterId: string,
): AiMemoryFile | null {
  if (!memory) return null
  const ordered = [...chapters].sort((a, b) => a.index - b.index)
  const fromPosition = ordered.findIndex((chapter) => chapter.id === fromChapterId)
  if (fromPosition < 0) throw new Error('来源章节不存在')
  const earlier = new Set(ordered.slice(0, fromPosition).map((chapter) => chapter.id))
  const keep = <T extends AiMemoryBase>(items: T[]): T[] => items
    .map((item) => ({ ...item, sources: item.sources.filter((source) => earlier.has(source.chapterId)) }))
    .filter((item) => item.sources.length > 0)
  const priorReady = ordered.slice(0, fromPosition).filter((chapter) => chapter.status === 'ready').at(-1)
  return {
    ...memory,
    ...(priorReady ? { uptoChapterId: priorReady.id } : { uptoChapterId: undefined }),
    characters: keep(memory.characters),
    relations: keep(memory.relations),
    foreshadows: keep(memory.foreshadows),
    events: keep(memory.events),
  }
}

/** 一批送模型的记忆章节数：再大提示词容易顶到 30000 字预算，再小则调用次数失控。 */
export const MEMORY_BATCH_CHAPTERS = 5

export function selectRebuildBatches<T extends { id: string; index: number }>(
  eligible: readonly T[],
  fromChapterId: string,
  allChapters: readonly T[],
): T[][] {
  const from = allChapters.find((chapter) => chapter.id === fromChapterId)
  const cutoff = eligible.at(-1)
  if (!from || !cutoff || from.index > cutoff.index) throw new Error('来源章节超出已读范围')
  const selected = eligible.filter((chapter) => chapter.index >= from.index)
  const batches: T[][] = []
  for (let index = 0; index < selected.length; index += MEMORY_BATCH_CHAPTERS) {
    batches.push(selected.slice(index, index + MEMORY_BATCH_CHAPTERS))
  }
  return batches
}

/** A rebuild may change generated wording; explicit reader corrections take precedence. */
export function preserveUserMemoryCorrections(generated: AiMemoryFile, previous: AiMemoryFile | null): AiMemoryFile {
  if (!previous) return generated
  const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
  const overlay = <T extends AiMemoryBase>(
    next: T[], old: T[], key: (item: T) => string,
    copyExtra?: (target: T, source: T) => void,
  ) => {
    for (const prior of old) {
      const edited = prior.userEditedSummary || ('userEditedAliases' in prior && prior.userEditedAliases === true)
      if (!edited) continue
      const item = next.find((entry) => entry.id === prior.id || normalized(key(entry)) === normalized(key(prior)))
      if (!item) {
        next.push({ ...prior, accuracy: 'review' })
        continue
      }
      if (prior.userEditedSummary) {
        item.summary = prior.summary
        item.userEditedSummary = true
      }
      copyExtra?.(item, prior)
    }
  }
  overlay(generated.characters, previous.characters, (item) => item.name, (item, prior) => {
    if (prior.userEditedAliases) {
      item.aliases = [...prior.aliases]
      item.userEditedAliases = true
    }
  })
  overlay(generated.relations, previous.relations, (item) => `${item.from}\0${item.to}\0${item.relation}`)
  overlay(generated.foreshadows, previous.foreshadows, (item) => item.desc)
  overlay(generated.events, previous.events, (item) => item.title)
  return generated
}

/** 纯本地的材料覆盖视图；`AiMaterialCoverage.follow` 是运行状态，由持有追剧服务的调用方补齐。 */
export function describeMaterialCoverage(
  chapters: readonly CoverageChapter[],
  progressChapterId: string | null | undefined,
  summarizedChapterIds: ReadonlySet<string>,
): Omit<AiMaterialCoverage, 'follow'> | null {
  if (!progressChapterId) return null
  const ordered = [...chapters].sort((left, right) => left.index - right.index)
  const progressPosition = ordered.findIndex((chapter) => chapter.id === progressChapterId)
  if (progressPosition < 0) return null
  const ready = ordered.filter((chapter, position) => position <= progressPosition && chapter.status === 'ready')
  const missing = ready
    .filter((chapter) => !summarizedChapterIds.has(chapter.id))
    .map((chapter) => ({ chapterId: chapter.id, title: chapter.title }))
  const cutoff = ordered[progressPosition]!
  return {
    uptoChapterId: cutoff.id,
    uptoChapterTitle: cutoff.title,
    readyChapters: ready.length,
    summarizedChapters: ready.length - missing.length,
    missing,
  }
}

export function addBookUsage(current: AiBookUsage | null, usage: AiUsage | undefined, updatedAt: string): AiBookUsage {
  const base = current ?? {
    calls: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, updatedAt,
  }
  return {
    calls: base.calls + 1,
    inputTokens: base.inputTokens + (usage?.inputTokens ?? 0),
    outputTokens: base.outputTokens + (usage?.outputTokens ?? 0),
    cacheHitTokens: base.cacheHitTokens + (usage?.cacheHitTokens ?? 0),
    cacheMissTokens: base.cacheMissTokens + (usage?.cacheMissTokens ?? 0),
    updatedAt,
  }
}
