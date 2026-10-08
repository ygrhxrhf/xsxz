export interface MemoryBookPayload {
  bookId: string
}

export interface MemoryRunPayload extends MemoryBookPayload {
  uptoChapterId: string
}

export interface MemoryRebuildFromPayload extends MemoryRunPayload {
  fromChapterId: string
}

export interface MemoryMarkPayload extends MemoryBookPayload {
  kind: 'character' | 'relation' | 'foreshadow' | 'event'
  itemId: string
}

export interface MemorySummaryPayload extends MemoryMarkPayload {
  summary: string
}

export interface MemoryAliasPayload extends MemoryBookPayload {
  itemId: string
  aliases: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBookId(value: unknown): value is string {
  return typeof value === 'string' && /^[di]_[0-9a-f]{16}$/.test(value)
}

function isChapterId(value: unknown): value is string {
  return typeof value === 'string' && /^c\d{4,12}$/.test(value)
}

function isMemoryItemId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:character|relation|foreshadow|event)-[0-9a-f]{16}$/.test(value)
}

export function parseMemoryBookPayload(payload: unknown): MemoryBookPayload {
  if (!isRecord(payload) || !isBookId(payload.bookId)) throw new Error('书籍不存在')
  return { bookId: payload.bookId }
}

export function parseMemoryRunPayload(payload: unknown): MemoryRunPayload {
  const { bookId } = parseMemoryBookPayload(payload)
  if (!isRecord(payload) || !isChapterId(payload.uptoChapterId)) throw new Error('章节不存在')
  return { bookId, uptoChapterId: payload.uptoChapterId }
}

export function parseMemoryRebuildFromPayload(payload: unknown): MemoryRebuildFromPayload {
  const base = parseMemoryRunPayload(payload)
  if (!isRecord(payload) || !isChapterId(payload.fromChapterId)) throw new Error('来源章节不存在')
  return { ...base, fromChapterId: payload.fromChapterId }
}

export function parseMemoryMarkPayload(payload: unknown): MemoryMarkPayload {
  const { bookId } = parseMemoryBookPayload(payload)
  if (!isRecord(payload) || !isMemoryItemId(payload.itemId)) throw new Error('记忆条目不存在')
  let kind: MemoryMarkPayload['kind']
  switch (payload.kind) {
    case 'character': kind = 'character'; break
    case 'relation': kind = 'relation'; break
    case 'foreshadow': kind = 'foreshadow'; break
    case 'event': kind = 'event'; break
    default: throw new Error('记忆类型无效')
  }
  if (!payload.itemId.startsWith(`${kind}-`)) throw new Error('记忆条目不存在')
  return { bookId, kind, itemId: payload.itemId }
}

export function parseMemoryAliasPayload(payload: unknown): MemoryAliasPayload {
  const { bookId } = parseMemoryBookPayload(payload)
  if (!isRecord(payload) || !isMemoryItemId(payload.itemId) || !payload.itemId.startsWith('character-')) {
    throw new Error('记忆条目不存在')
  }
  if (!Array.isArray(payload.aliases) || payload.aliases.length > 12 || payload.aliases.some((alias) => typeof alias !== 'string')) {
    throw new Error('别名格式无效')
  }
  return { bookId, itemId: payload.itemId, aliases: payload.aliases }
}

export function parseMemorySummaryPayload(payload: unknown): MemorySummaryPayload {
  const base = parseMemoryMarkPayload(payload)
  if (!isRecord(payload) || typeof payload.summary !== 'string') throw new Error('修正内容格式无效')
  const summary = payload.summary.trim()
  if (!summary || Array.from(summary).length > 500) throw new Error('修正内容须为 1 至 500 字')
  return { ...base, summary }
}
