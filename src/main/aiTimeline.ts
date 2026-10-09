import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiMemoryCharacter, AiMemoryFile, AiMemoryForeshadow, AiTimelineEntry, AiTimelineView } from '../shared/types'
import { atomicWriteText, bookDir, getBook, readAiMemory } from './library'
import { getReadFrontier, readClippedChapter, readableCitations } from './readFrontier'

interface TimelineFile { version: 1; entries: AiTimelineEntry[] }
const pathFor = (bookId: string) => join(bookDir(bookId), 'ai', 'timeline.json')

async function read(bookId: string): Promise<TimelineFile> {
  try {
    const value = JSON.parse(await readFile(pathFor(bookId), 'utf-8')) as TimelineFile
    if (value.version === 1 && Array.isArray(value.entries)) return value
  } catch { /* cache can be rebuilt */ }
  return { version: 1, entries: [] }
}

type Item = (AiMemoryCharacter | AiMemoryForeshadow) & { kind: 'character' | 'foreshadow'; name: string; state: string }
function items(memory: AiMemoryFile | null): Item[] {
  if (!memory) return []
  return [
    ...memory.characters.map((item) => ({ ...item, kind: 'character' as const, name: item.name, state: item.status })),
    ...memory.foreshadows.map((item) => ({ ...item, kind: 'foreshadow' as const, name: item.desc, state: item.status })),
  ]
}

export async function syncTimeline(bookId: string, previous: AiMemoryFile | null, current: AiMemoryFile, fromChapterId?: string): Promise<void> {
  const book = await getBook(bookId)
  const order = new Map(book.chapters.map((chapter) => [chapter.id, chapter.index]))
  const frontier = await getReadFrontier(bookId)
  const full = new Set<string>()
  for (const chapter of book.chapters) {
    if (chapter.status === 'ready' && (await readClippedChapter(bookId, chapter.id, frontier)).full) full.add(chapter.id)
  }
  const file = await read(bookId)
  const fromIndex = fromChapterId ? order.get(fromChapterId) : undefined
  const validExisting: AiTimelineEntry[] = []
  for (const entry of file.entries) {
    if (fromIndex !== undefined && (order.get(entry.source.chapterId) ?? Infinity) >= fromIndex) continue
    if (!full.has(entry.source.chapterId)) continue
    if ((await readableCitations(bookId, [entry.source], frontier)).length) validExisting.push(entry)
  }
  const prior = new Map(items(previous).map((item) => [item.id, item]))
  const added: AiTimelineEntry[] = []
  for (const item of items(current)) {
    const source = item.sources.find((candidate) => full.has(candidate.chapterId))
    if (!source || !(await readableCitations(bookId, [source], frontier)).length) continue
    const old = prior.get(item.id)
    if (old && old.state === item.state && old.summary === item.summary) continue
    const phase = old ? '变化' : '出现'
    added.push({
      id: `${item.id}:${phase}:${source.id}:${item.updatedAt}`,
      kind: item.kind, name: item.name, phase,
      text: `${item.state}：${item.summary}`,
      uncertain: item.accuracy !== 'normal', userEdited: item.userEditedSummary === true,
      source,
    })
  }
  const deduped = [...new Map([...validExisting, ...added].map((entry) => [entry.id, entry])).values()]
    .sort((a, b) => (order.get(a.source.chapterId) ?? 0) - (order.get(b.source.chapterId) ?? 0))
  await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
  await atomicWriteText(pathFor(bookId), JSON.stringify({ version: 1, entries: deduped }, null, 2))
}

export async function timelineView(bookId: string): Promise<AiTimelineView> {
  const [file, memory, frontier, book] = await Promise.all([read(bookId), readAiMemory(bookId), getReadFrontier(bookId), getBook(bookId)])
  const order = new Map(book.chapters.map((chapter) => [chapter.id, chapter.index]))
  const valid: AiTimelineEntry[] = []
  let stale = false
  for (const entry of file.entries) {
    const clipped = await readClippedChapter(bookId, entry.source.chapterId, frontier).catch(() => ({ full: false }))
    if (!clipped.full || !(await readableCitations(bookId, [entry.source], frontier)).length) { stale = true; continue }
    valid.push(entry)
  }
  for (const item of items(memory)) {
    const source = item.sources.find((candidate) => valid.some((entry) => entry.source.chapterId === candidate.chapterId && entry.source.id === candidate.id))
      ?? item.sources[0]
    if (!source) continue
    const clipped = await readClippedChapter(bookId, source.chapterId, frontier).catch(() => ({ full: false }))
    if (!clipped.full || !(await readableCitations(bookId, [source], frontier)).length) continue
    valid.push({
      id: `current:${item.id}`, kind: item.kind, name: item.name, phase: '当前状态',
      text: `${item.state}：${item.summary}`, uncertain: item.accuracy !== 'normal',
      userEdited: item.userEditedSummary === true || ('userEditedAliases' in item && item.userEditedAliases === true), source,
    })
  }
  valid.sort((a, b) => (order.get(a.source.chapterId) ?? 0) - (order.get(b.source.chapterId) ?? 0) ||
    (a.phase === '当前状态' ? 1 : 0) - (b.phase === '当前状态' ? 1 : 0))
  return { entries: valid, stale, message: stale ? '来源章节已变化，受影响记录已隐藏；请从该章重建记忆' : valid.length ? '' : '还没有已读完章节的人物或伏笔变化' }
}
