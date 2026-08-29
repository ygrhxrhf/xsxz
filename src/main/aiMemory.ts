import type {
  AiCitation,
  AiMemoryBase,
  AiMemoryCharacter,
  AiMemoryEvent,
  AiMemoryFile,
  AiMemoryForeshadow,
  AiMemoryRelation,
} from '../shared/types'
import { stableAiMemoryId } from './library'

export interface AiMemoryCandidate extends AiCitation {
  text: string
}

export interface ApplyMemoryExtractionOptions {
  uptoChapterId?: string
  updatedAt?: string
  reviewItemIds?: ReadonlySet<string>
}

export interface ApplyMemoryExtractionResult {
  memory: AiMemoryFile
  changedItems: number
  acceptedItems: number
  rejectedItems: number
  reviewedItemIds: string[]
}

type MemoryCollection = 'characters' | 'relations' | 'foreshadows' | 'events'

function textCharacters(text: string): string[] {
  return Array.from(text)
}

function normalizeParagraphs(body: string): string[] {
  return body.replace(/\r\n?/g, '\n').split(/\n\s*\n+/).map((item) => item.trim()).filter(Boolean)
}

export function buildAiMemoryCandidates(
  chapterId: string,
  chapterTitle: string,
  body: string,
): AiMemoryCandidate[] {
  const paragraphs = normalizeParagraphs(body)
  const units: Array<{ char: string; paragraphIndex: number }> = []
  paragraphs.forEach((paragraph, paragraphIndex) => {
    if (paragraphIndex > 0) {
      units.push({ char: '\n', paragraphIndex }, { char: '\n', paragraphIndex })
    }
    for (const char of textCharacters(paragraph)) units.push({ char, paragraphIndex })
  })
  if (units.length < 80) return []

  const chunkCount = Math.ceil(units.length / 160)
  const baseSize = Math.floor(units.length / chunkCount)
  const remainder = units.length % chunkCount
  const candidates: AiMemoryCandidate[] = []
  let offset = 0
  for (let index = 0; index < chunkCount; index += 1) {
    const size = baseSize + (index < remainder ? 1 : 0)
    const chunk = units.slice(offset, offset + size)
    const paragraphIndex = chunk[0]!.paragraphIndex
    const excerpt = chunk.map((unit) => unit.char).join('')
    const id = `ev-${chapterId}-p${paragraphIndex}-s${index + 1}`
    candidates.push({ id, chapterId, chapterTitle, paragraphIndex, excerpt, text: excerpt })
    offset += size
  }
  return candidates
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
}

function sourcesFromIds(value: unknown, candidates: ReadonlyMap<string, AiMemoryCandidate>): AiCitation[] | null {
  const ids = stringArray(value)
  if (!ids?.length) return null
  const sources: AiCitation[] = []
  for (const id of ids) {
    const candidate = candidates.get(id)
    if (!candidate) return null
    const { text: _text, ...citation } = candidate
    sources.push(citation)
  }
  return sources
}

function normalizedKey(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ')
}

function itemKey(collection: MemoryCollection, item: Record<string, unknown>): string | null {
  if (collection === 'characters') return stringValue(item.name)
  if (collection === 'relations') {
    const from = stringValue(item.from)
    const to = stringValue(item.to)
    const relation = stringValue(item.relation)
    return from && to && relation ? `${from}\0${to}\0${relation}` : null
  }
  if (collection === 'foreshadows') return stringValue(item.desc)
  return stringValue(item.title)
}

function collectionKind(collection: MemoryCollection): 'character' | 'relation' | 'foreshadow' | 'event' {
  return collection === 'characters' ? 'character'
    : collection === 'relations' ? 'relation'
      : collection === 'foreshadows' ? 'foreshadow'
        : 'event'
}

function sameKey(collection: MemoryCollection, item: Record<string, unknown>, key: string): boolean {
  const existingKey = itemKey(collection, item)
  return existingKey !== null && normalizedKey(existingKey) === normalizedKey(key)
}

function mergeSources(current: AiCitation[], incoming: AiCitation[]): AiCitation[] {
  const map = new Map(current.map((source) => [source.id, source]))
  for (const source of incoming) map.set(source.id, source)
  return [...map.values()]
}

function parseItem(
  collection: MemoryCollection,
  raw: unknown,
  candidates: ReadonlyMap<string, AiMemoryCandidate>,
  updatedAt: string,
): (AiMemoryCharacter | AiMemoryRelation | AiMemoryForeshadow | AiMemoryEvent) | null {
  if (!isRecord(raw)) return null
  const key = itemKey(collection, raw)
  const summary = stringValue(raw.summary)
  const sources = sourcesFromIds(raw.citationIds, candidates)
  if (!key || !summary || !sources) return null
  const base: AiMemoryBase = {
    id: stableAiMemoryId(collectionKind(collection), key, sources[0]!.id),
    summary,
    sources,
    accuracy: 'normal',
    updatedAt,
  }
  if (collection === 'characters') {
    const name = stringValue(raw.name)
    const aliases = stringArray(raw.aliases)
    const role = stringValue(raw.role)
    const status = stringValue(raw.status)
    return name && aliases && role && status ? { ...base, name, aliases, role, status } : null
  }
  if (collection === 'relations') {
    const from = stringValue(raw.from)
    const to = stringValue(raw.to)
    const relation = stringValue(raw.relation)
    const status = stringValue(raw.status)
    return from && to && relation && status ? { ...base, from, to, relation, status } : null
  }
  if (collection === 'foreshadows') {
    const desc = stringValue(raw.desc)
    const status = raw.status
    return desc && (status === 'open' || status === 'resolved' || status === 'uncertain')
      ? { ...base, desc, status }
      : null
  }
  const title = stringValue(raw.title)
  const participants = stringArray(raw.participants)
  const result = stringValue(raw.result)
  return title && participants && result ? { ...base, title, participants, result } : null
}

function emptyMemory(updatedAt: string): AiMemoryFile {
  return { version: 1, characters: [], relations: [], foreshadows: [], events: [], updatedAt }
}

function cloneMemory(memory: AiMemoryFile): AiMemoryFile {
  return structuredClone(memory)
}

function itemSignature(item: Record<string, unknown> & AiMemoryBase): string {
  const { updatedAt: _updatedAt, ...semantic } = item
  return JSON.stringify(semantic)
}

function mergeItem(
  memory: AiMemoryFile,
  collection: MemoryCollection,
  incoming: AiMemoryCharacter | AiMemoryRelation | AiMemoryForeshadow | AiMemoryEvent,
  updatedAt: string,
): { id: string; changed: boolean } {
  const target = memory[collection] as Array<Record<string, unknown> & AiMemoryBase>
  const key = itemKey(collection, incoming as unknown as Record<string, unknown>)!
  const existing = target.find((item) => sameKey(collection, item, key))
  if (!existing) {
    target.push(incoming as unknown as Record<string, unknown> & AiMemoryBase)
    return { id: incoming.id, changed: true }
  }
  const before = itemSignature(existing)
  const previousUpdatedAt = existing.updatedAt
  const conservativeAccuracy = existing.accuracy === 'normal' ? incoming.accuracy : existing.accuracy
  const id = existing.id
  const sources = mergeSources(existing.sources, incoming.sources)
  const extra = collection === 'characters'
    ? { aliases: [...new Set([...(existing.aliases as string[]), ...(incoming as AiMemoryCharacter).aliases])] }
    : collection === 'events'
      ? { participants: [...new Set([...(existing.participants as string[]), ...(incoming as AiMemoryEvent).participants])] }
      : {}
  Object.assign(existing, incoming, extra, { id, sources, accuracy: conservativeAccuracy })
  const changed = itemSignature(existing) !== before
  existing.updatedAt = changed ? updatedAt : previousUpdatedAt
  return { id, changed }
}

export function applyAiMemoryExtraction(
  existingMemory: AiMemoryFile | null,
  raw: unknown,
  candidates: readonly AiMemoryCandidate[],
  options: ApplyMemoryExtractionOptions = {},
): ApplyMemoryExtractionResult {
  if (!isRecord(raw)) throw new Error('模型返回的记忆 JSON 无法识别，原有记忆未改变')
  const collections: MemoryCollection[] = ['characters', 'relations', 'foreshadows', 'events']
  if (collections.some((collection) => !Array.isArray(raw[collection])) || !Array.isArray(raw.reviewDecisions)) {
    throw new Error('模型返回的记忆 JSON 无法识别，原有记忆未改变')
  }
  const updatedAt = options.updatedAt ?? new Date().toISOString()
  const memory = existingMemory ? cloneMemory(existingMemory) : emptyMemory(updatedAt)
  const candidateMap = new Map<string, AiMemoryCandidate>()
  for (const candidate of candidates) {
    if (candidateMap.has(candidate.id)) throw new Error('记忆候选来源 ID 重复，原有记忆未改变')
    candidateMap.set(candidate.id, candidate)
  }
  const changed = new Set<string>()
  let acceptedItems = 0
  let rejectedItems = 0
  let rawItemCount = 0

  for (const collection of collections) {
    for (const rawItem of raw[collection] as unknown[]) {
      rawItemCount += 1
      const parsed = parseItem(collection, rawItem, candidateMap, updatedAt)
      if (!parsed) {
        rejectedItems += 1
        continue
      }
      const merged = mergeItem(memory, collection, parsed, updatedAt)
      if (merged.changed) changed.add(merged.id)
      acceptedItems += 1
    }
  }

  const reviewedItemIds: string[] = []
  const decidedItemIds = new Set<string>()
  for (const decision of raw.reviewDecisions as unknown[]) {
    rawItemCount += 1
    if (!isRecord(decision) || typeof decision.confirmed !== 'boolean') {
      rejectedItems += 1
      continue
    }
    const itemId = stringValue(decision.itemId)
    if (!itemId || !options.reviewItemIds?.has(itemId) || decidedItemIds.has(itemId)) {
      rejectedItems += 1
      continue
    }
    decidedItemIds.add(itemId)
    const item = [...memory.characters, ...memory.relations, ...memory.foreshadows, ...memory.events]
      .find((candidate) => candidate.id === itemId)
    if (!item || item.accuracy !== 'review') {
      rejectedItems += 1
      continue
    }
    item.accuracy = decision.confirmed ? 'normal' : 'uncertain'
    item.updatedAt = updatedAt
    changed.add(item.id)
    reviewedItemIds.push(item.id)
    acceptedItems += 1
  }

  if (rawItemCount > 0 && acceptedItems === 0) {
    throw new Error('模型返回的记忆来源均无效，原有记忆未改变')
  }
  if (options.uptoChapterId) memory.uptoChapterId = options.uptoChapterId
  if (changed.size > 0 || options.uptoChapterId) memory.updatedAt = updatedAt
  return { memory, changedItems: changed.size, acceptedItems, rejectedItems, reviewedItemIds }
}
