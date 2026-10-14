import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderedParagraphs } from '../shared/aiText'
import type { AiCitation, AiMemoryFile, ReadFrontier, ReadFrontierPosition, ReadingProgress } from '../shared/types'
import { atomicWriteText, bookDir, getBook, readChapter, registerBodyChangeHook, withBookLock } from './library'

interface FrontierFile {
  version: 1
  legacyConfirmed: boolean
  chapters: Record<string, ReadFrontierPosition>
  sessions: { startedAt: string; lastActivityAt: string; fromChapterId: string; toChapterId: string }[]
}

const SESSION_GAP_MS = 30 * 60_000
const MAX_SESSIONS = 12

function pathFor(bookId: string): string { return join(bookDir(bookId), 'reading-frontier.json') }
function empty(): FrontierFile { return { version: 1, legacyConfirmed: false, chapters: {}, sessions: [] } }
function hash(body: string): string { return createHash('sha256').update(body).digest('hex') }

async function readFileSafe(bookId: string): Promise<FrontierFile> {
  try {
    const raw = JSON.parse(await readFile(pathFor(bookId), 'utf-8')) as Partial<FrontierFile>
    if (raw.version !== 1 || typeof raw.chapters !== 'object' || !raw.chapters) return empty()
    return {
      version: 1,
      legacyConfirmed: raw.legacyConfirmed === true,
      chapters: raw.chapters,
      sessions: Array.isArray(raw.sessions) ? raw.sessions.slice(-MAX_SESSIONS) : [],
    }
  } catch { return empty() }
}

async function save(bookId: string, file: FrontierFile): Promise<void> {
  await mkdir(bookDir(bookId), { recursive: true })
  await atomicWriteText(pathFor(bookId), JSON.stringify(file, null, 2))
}

function boundedPosition(body: string, value: Pick<ReadFrontierPosition, 'paragraphIndex' | 'characterOffset'>): ReadFrontierPosition | null {
  const paragraphs = renderedParagraphs(body)
  const { paragraphIndex, characterOffset } = value
  if (!Number.isSafeInteger(paragraphIndex) || !Number.isSafeInteger(characterOffset) || paragraphIndex < 0 || paragraphIndex >= paragraphs.length) return null
  const length = paragraphs[paragraphIndex]!.length
  if (characterOffset < 0 || characterOffset > length) return null
  return { paragraphIndex, characterOffset, bodyHash: hash(body), updatedAt: new Date().toISOString() }
}

function farther(a: ReadFrontierPosition, b: ReadFrontierPosition): boolean {
  return a.paragraphIndex > b.paragraphIndex || (a.paragraphIndex === b.paragraphIndex && a.characterOffset > b.characterOffset)
}

function recordSession(file: FrontierFile, chapterId: string, at: string): void {
  const last = file.sessions.at(-1)
  if (last && Date.parse(at) - Date.parse(last.lastActivityAt) < SESSION_GAP_MS) {
    last.lastActivityAt = at
    last.toChapterId = chapterId
  } else {
    file.sessions.push({ startedAt: at, lastActivityAt: at, fromChapterId: chapterId, toChapterId: chapterId })
    file.sessions = file.sessions.slice(-MAX_SESSIONS)
  }
}

export async function markReadFrontier(bookId: string, chapterId: string, paragraphIndex: number, characterOffset: number): Promise<ReadFrontierPosition> {
  const book = await getBook(bookId)
  const meta = book.chapters.find((chapter) => chapter.id === chapterId)
  if (!meta || meta.status !== 'ready') throw new Error('章节尚不可读')
  const chapter = await readChapter(bookId, chapterId)
  const next = boundedPosition(chapter.body, { paragraphIndex, characterOffset })
  if (!next) throw new Error('已读位置无效')
  return withBookLock(bookId, async () => {
    const file = await readFileSafe(bookId)
    const prior = file.chapters[chapterId]
    if (!prior || prior.bodyHash !== next.bodyHash || farther(next, prior)) file.chapters[chapterId] = next
    recordSession(file, chapterId, next.updatedAt)
    await save(bookId, file)
    return file.chapters[chapterId]!
  })
}

/**
 * 正文被改写（清正文 / 重下 / 手工修复）后把已读位置搬到新正文上。
 * 读者「读到章末」这件事不该因为站点换了正文而作废，否则追剧会静默断档。
 * 原来的位置在旧正文末尾时，新位置也落在新正文末尾；否则按段落比例就近落点。
 */
export async function migrateReadFrontier(
  bookId: string,
  chapterId: string,
  oldBody: string,
  newBody: string,
): Promise<void> {
  const file = await readFileSafe(bookId)
  const prior = file.chapters[chapterId]
  if (!prior || prior.bodyHash !== hash(oldBody)) return
  const oldParagraphs = renderedParagraphs(oldBody)
  const newParagraphs = renderedParagraphs(newBody)
  if (!newParagraphs.length) return
  const atEnd = prior.paragraphIndex === oldParagraphs.length - 1
    && prior.characterOffset === (oldParagraphs.at(-1)?.length ?? 0)
  const ratio = oldParagraphs.length
    ? (prior.paragraphIndex + prior.characterOffset / Math.max(1, oldParagraphs[prior.paragraphIndex]?.length ?? 1)) / oldParagraphs.length
    : 0
  const target = Math.min(newParagraphs.length - 1, Math.max(0, Math.floor(ratio * newParagraphs.length)))
  const next: ReadFrontierPosition = {
    paragraphIndex: atEnd ? newParagraphs.length - 1 : target,
    characterOffset: atEnd
      ? newParagraphs.at(-1)!.length
      : Math.min(newParagraphs[target]!.length, prior.characterOffset),
    bodyHash: hash(newBody),
    updatedAt: new Date().toISOString(),
  }
  await withBookLock(bookId, async () => {
    const fresh = await readFileSafe(bookId)
    fresh.chapters[chapterId] = next
    await save(bookId, fresh)
  })
}

// 模块加载即注册：library 的正文改写路径要回到这里迁移已读位置
registerBodyChangeHook(migrateReadFrontier)

export async function getReadFrontier(bookId: string): Promise<ReadFrontier> {
  const book = await getBook(bookId)
  const file = await readFileSafe(bookId)
  return {
    chapters: file.chapters,
    legacyConfirmed: file.legacyConfirmed,
    legacyProposal: !file.legacyConfirmed && book.progress ? book.progress : null,
    sessions: file.sessions,
  }
}

/** Old progress is a proposal only. No historical chapter becomes evidence until the reader accepts it. */
export async function confirmLegacyReadRange(bookId: string): Promise<ReadFrontier> {
  const book = await getBook(bookId)
  // Prepare reads before taking the write lock: readChapter may itself repair metadata.
  const prepared = new Map<string, ReadFrontierPosition>()
  const ordered = [...book.chapters].sort((a, b) => a.index - b.index)
  const current = ordered.findIndex((chapter) => chapter.id === book.progress?.chapterId)
  if (book.progress && current >= 0) {
    for (const [index, meta] of ordered.entries()) {
      if (index > current || meta.status !== 'ready') continue
      const chapter = await readChapter(bookId, meta.id)
      const paragraphs = renderedParagraphs(chapter.body)
      if (!paragraphs.length) continue
      const point = index < current
        ? { paragraphIndex: paragraphs.length - 1, characterOffset: paragraphs.at(-1)!.length }
        : legacyPosition(book.progress, paragraphs)
      const next = boundedPosition(chapter.body, point)
      if (next) prepared.set(meta.id, next)
    }
  }
  return withBookLock(bookId, async () => {
    const file = await readFileSafe(bookId)
    if (!file.legacyConfirmed) {
      for (const [chapterId, next] of prepared) {
        const prior = file.chapters[chapterId]
        if (!prior || prior.bodyHash !== next.bodyHash || farther(next, prior)) file.chapters[chapterId] = next
      }
    }
    file.legacyConfirmed = true
    await save(bookId, file)
    return { chapters: file.chapters, legacyConfirmed: true, legacyProposal: null, sessions: file.sessions }
  })
}

function legacyPosition(progress: ReadingProgress, paragraphs: string[]): { paragraphIndex: number; characterOffset: number } {
  if (Number.isSafeInteger(progress.paragraphIndex) && progress.paragraphIndex! >= 0 && progress.paragraphIndex! < paragraphs.length) {
    const index = progress.paragraphIndex!
    return { paragraphIndex: index, characterOffset: Math.max(0, Math.min(paragraphs[index]!.length, progress.paragraphOffset ?? 0)) }
  }
  const index = Math.max(0, Math.min(paragraphs.length - 1, Math.floor(progress.scrollRatio * paragraphs.length)))
  return { paragraphIndex: index, characterOffset: 0 }
}

export function clipReadBody(body: string, position: ReadFrontierPosition | undefined): string {
  if (!position || position.bodyHash !== hash(body)) return ''
  const paragraphs = renderedParagraphs(body)
  if (!Number.isSafeInteger(position.paragraphIndex) || position.paragraphIndex < 0 || position.paragraphIndex >= paragraphs.length) return ''
  return [...paragraphs.slice(0, position.paragraphIndex), paragraphs[position.paragraphIndex]!.slice(0, position.characterOffset)]
    .filter(Boolean).join('\n\n')
}

export function isFullyRead(body: string, position: ReadFrontierPosition | undefined): boolean {
  if (!position || position.bodyHash !== hash(body)) return false
  const paragraphs = renderedParagraphs(body)
  return paragraphs.length > 0 && position.paragraphIndex === paragraphs.length - 1 && position.characterOffset === paragraphs.at(-1)!.length
}

export async function readClippedChapter(bookId: string, chapterId: string, frontier?: ReadFrontier): Promise<{ body: string; full: boolean }> {
  const file = await readChapter(bookId, chapterId)
  const current = frontier ?? await getReadFrontier(bookId)
  const position = current.chapters[chapterId]
  return { body: clipReadBody(file.body, position), full: isFullyRead(file.body, position) }
}

export async function readableCitations(bookId: string, citations: readonly AiCitation[], frontier?: ReadFrontier): Promise<AiCitation[]> {
  const current = frontier ?? await getReadFrontier(bookId)
  const bodies = new Map<string, string>()
  const accepted: AiCitation[] = []
  for (const citation of citations) {
    if (!bodies.has(citation.chapterId)) {
      const clipped = await readClippedChapter(bookId, citation.chapterId, current).catch(() => ({ body: '' }))
      bodies.set(citation.chapterId, clipped.body)
    }
    const body = bodies.get(citation.chapterId) ?? ''
    const paragraph = renderedParagraphs(body)[citation.paragraphIndex]
    const excerpt = citation.excerpt.trim()
    const start = excerpt.split(/\r?\n/)[0]?.trim() ?? ''
    if (paragraph && start && paragraph.includes(start) && body.includes(excerpt)) accepted.push(citation)
  }
  return accepted
}

export async function visibleMemory(bookId: string, memory: AiMemoryFile | null, frontier?: ReadFrontier): Promise<AiMemoryFile | null> {
  if (!memory) return null
  const current = frontier ?? await getReadFrontier(bookId)
  const filter = async <T extends { sources: AiCitation[] }>(items: T[]): Promise<T[]> => {
    const filtered = await Promise.all(items.map(async (item) => ({ ...item, sources: await readableCitations(bookId, item.sources, current) })))
    return filtered.filter((item) => item.sources.length > 0)
  }
  const [characters, relations, foreshadows, events] = await Promise.all([
    filter(memory.characters), filter(memory.relations), filter(memory.foreshadows), filter(memory.events),
  ])
  return { ...memory, characters, relations, foreshadows, events }
}
