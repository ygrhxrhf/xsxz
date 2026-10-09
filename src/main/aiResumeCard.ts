import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderedParagraphs } from '../shared/aiText'
import type { AiCitation, AiResumeCard, AiResumeCardView } from '../shared/types'
import { atomicWriteText, bookDir, getBook, readChapter } from './library'
import { getReadFrontier, isFullyRead, readableCitations } from './readFrontier'

const DAY_MS = 24 * 60 * 60_000
const pathFor = (bookId: string) => join(bookDir(bookId), 'ai', 'resume-card.json')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

export interface ResumeContext {
  sessionEndedAt: string
  sourceHash: string
  chapters: Array<{ id: string; title: string }>
  citations: AiCitation[]
  prompt: string
}

export async function resumeContext(bookId: string, now = Date.now()): Promise<{ context: ResumeContext | null; reason: string }> {
  const [book, frontier] = await Promise.all([getBook(bookId), getReadFrontier(bookId)])
  const sessions = frontier.sessions
  const latest = sessions.at(-1)
  if (!latest) return { context: null, reason: '还没有可用于续读的阅读会话' }
  const latestEnd = Date.parse(latest.lastActivityAt)
  const prior = now - latestEnd >= DAY_MS ? latest : sessions.at(-2)
  if (!prior || (prior !== latest && Date.parse(latest.startedAt) - Date.parse(prior.lastActivityAt) < DAY_MS)) {
    return { context: null, reason: '距上次阅读尚不足 24 小时' }
  }
  const ordered = [...book.chapters].sort((a, b) => a.index - b.index)
  const endIndex = ordered.findIndex((chapter) => chapter.id === prior.toChapterId)
  if (endIndex < 0) return { context: null, reason: '上次阅读的章节已不存在' }
  const selected: Array<{ id: string; title: string; body: string }> = []
  for (let index = endIndex; index >= 0 && selected.length < 10; index--) {
    const meta = ordered[index]!
    if (meta.status !== 'ready') continue
    const chapter = await readChapter(bookId, meta.id)
    if (isFullyRead(chapter.body, frontier.chapters[meta.id])) selected.unshift({ id: meta.id, title: meta.title, body: chapter.body })
  }
  if (!selected.length) return { context: null, reason: '上次会话附近没有已读完的章节' }
  const citations: AiCitation[] = []
  const samples: Array<{ id: string; title: string; excerpts: Array<{ id: string; text: string }> }> = []
  for (const chapter of selected) {
    const paragraphs = renderedParagraphs(chapter.body)
    const indexes = [...new Set([0, 1, paragraphs.length - 3, paragraphs.length - 2, paragraphs.length - 1])]
      .filter((index) => index >= 0 && index < paragraphs.length)
    const excerpts: Array<{ id: string; text: string }> = []
    for (const index of indexes) {
      const excerpt = paragraphs[index]!.slice(0, 300).trim()
      if (!excerpt) continue
      const id = `resume-${chapter.id}-${index}`
      citations.push({ id, chapterId: chapter.id, chapterTitle: chapter.title, paragraphIndex: index, excerpt })
      excerpts.push({ id, text: excerpt })
    }
    samples.push({ id: chapter.id, title: chapter.title, excerpts })
  }
  const sourceHash = sha(JSON.stringify({ ended: prior.lastActivityAt, bodies: selected.map(({ id, body }) => [id, sha(body)]) }))
  return { context: {
    sessionEndedAt: prior.lastActivityAt, sourceHash,
    chapters: selected.map(({ id, title }) => ({ id, title })), citations,
    prompt: JSON.stringify(samples),
  }, reason: '' }
}

export async function readResumeCard(bookId: string): Promise<AiResumeCardView> {
  const { context, reason } = await resumeContext(bookId)
  if (!context) return { available: false, reason, stale: false, card: null }
  try {
    const card = JSON.parse(await readFile(pathFor(bookId), 'utf-8')) as AiResumeCard
    if (card.sourceHash === context.sourceHash && card.sessionEndedAt === context.sessionEndedAt &&
      Array.isArray(card.changes) && Array.isArray(card.conflicts) && Array.isArray(card.questions)) {
      const sources = [...card.changes, ...card.conflicts, ...card.questions].flatMap((item) => item.sources)
      if ((await readableCitations(bookId, sources)).length === sources.length) {
        return { available: true, reason: '', stale: false, card }
      }
    }
    return { available: true, reason: '来源或已读范围已变化，请重新生成', stale: true, card: null }
  } catch {
    return { available: true, reason: '尚未生成续读卡', stale: false, card: null }
  }
}

export function parseResumeCard(raw: Record<string, unknown>, context: ResumeContext): AiResumeCard {
  const allowed = new Map(context.citations.map((source) => [source.id, source]))
  const parse = (value: unknown): Array<{ text: string; sources: AiCitation[] }> => {
    if (!Array.isArray(value) || value.length > 6) throw new Error('续读卡结构无效')
    return value.map((entry) => {
      if (!entry || typeof entry !== 'object') throw new Error('续读卡条目无效')
      const item = entry as { text?: unknown; citationIds?: unknown }
      if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 500 || !Array.isArray(item.citationIds) || !item.citationIds.length) throw new Error('续读卡条目缺少原文来源')
      const sources = item.citationIds.map((id) => allowed.get(id))
      if (sources.some((source) => !source)) throw new Error('续读卡引用超出已读原文')
      return { text: item.text.trim(), sources: sources as AiCitation[] }
    })
  }
  const card: AiResumeCard = {
    generatedAt: new Date().toISOString(), sessionEndedAt: context.sessionEndedAt,
    sourceHash: context.sourceHash, chapters: context.chapters,
    changes: parse(raw.changes), conflicts: parse(raw.conflicts), questions: parse(raw.questions),
  }
  if (!card.changes.length && !card.conflicts.length && !card.questions.length) throw new Error('续读卡没有可核验内容')
  return card
}

export async function writeResumeCard(bookId: string, card: AiResumeCard): Promise<void> {
  await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
  await atomicWriteText(pathFor(bookId), JSON.stringify(card, null, 2))
}
