import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderedParagraphs } from '../shared/aiText'
import type { AiCitation } from '../shared/types'
import { parseResumeCard, readResumeCard, resumeContext, writeResumeCard } from './aiResumeCard'
import {
  createBookFromBootstrap, markChapterStatus, setLibraryPath, writeChapterFile,
} from './library'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'spbf-resume-'))
  await setLibraryPath(directory)
})

afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function seedBook() {
  const book = await createBookFromBootstrap({
    bookId: 'i_resume', title: '续读测试', author: '', importType: 'txt',
    chapterTitles: ['第一章', '第二章', '第三章'],
  })
  for (const chapter of book.chapters) {
    await writeChapterFile(book.id, chapter.id, {
      title: chapter.title, body: `${chapter.title}，主角继续北上。\n\n${chapter.title}内容。`, status: 'ready',
    })
    await markChapterStatus(book.id, chapter.id, 'ready')
  }
  return book
}

function endPosition(body: string) {
  const paragraphs = renderedParagraphs(body)
  return { paragraphIndex: paragraphs.length - 1, characterOffset: paragraphs.at(-1)!.length, bodyHash: sha(body), updatedAt: '' }
}

describe('resumeContext', () => {
  it('returns null when there are no sessions', async () => {
    const { id: bookId } = await seedBook()
    await writeFile(join(directory, bookId, 'reading-frontier.json'), JSON.stringify({
      version: 1, legacyConfirmed: true, chapters: {}, sessions: [],
    }), 'utf-8')
    const { context, reason } = await resumeContext(bookId)
    expect(context).toBeNull()
    expect(reason).toContain('还没有')
  })

  it('returns null when the gap since last session is under 24 hours', async () => {
    const { id: bookId } = await seedBook()
    const now = Date.now()
    await writeFile(join(directory, bookId, 'reading-frontier.json'), JSON.stringify({
      version: 1, legacyConfirmed: true, chapters: {},
      sessions: [{
        startedAt: new Date(now - 2 * 3600_000).toISOString(),
        lastActivityAt: new Date(now - 1 * 3600_000).toISOString(),
        fromChapterId: 'c0001', toChapterId: 'c0001',
      }],
    }), 'utf-8')
    const { context, reason } = await resumeContext(bookId)
    expect(context).toBeNull()
    expect(reason).toContain('不足 24 小时')
  })

  it('builds context from the prior session when the latest is recent', async () => {
    const book = await seedBook()
    const bodies = new Map<string, string>()
    for (const chapter of book.chapters) {
      bodies.set(chapter.id, `${chapter.title}，主角继续北上。\n\n${chapter.title}内容。`)
    }
    const now = Date.now()
    const chapters: Record<string, unknown> = {}
    for (const id of ['c0001', 'c0002', 'c0003']) {
      const body = bodies.get(id) ?? ''
      const pos = endPosition(body)
      chapters[id] = { ...pos, updatedAt: new Date(now - 48 * 3600_000).toISOString() }
    }
    const frontier = {
      version: 1, legacyConfirmed: true, chapters,
      sessions: [
        { startedAt: new Date(now - 50 * 3600_000).toISOString(), lastActivityAt: new Date(now - 48 * 3600_000).toISOString(), fromChapterId: 'c0001', toChapterId: 'c0002' },
        { startedAt: new Date(now - 20 * 3600_000).toISOString(), lastActivityAt: new Date(now - 10 * 3600_000).toISOString(), fromChapterId: 'c0003', toChapterId: 'c0003' },
      ],
    }
    await writeFile(join(directory, book.id, 'reading-frontier.json'), JSON.stringify(frontier), 'utf-8')
    const { context, reason } = await resumeContext(book.id)
    expect(context).not.toBeNull()
    expect(reason).toBe('')
    expect(context!.chapters.length).toBeGreaterThan(0)
    expect(context!.citations.length).toBeGreaterThan(0)
    expect(context!.sourceHash).toBeTruthy()
  })
})

describe('readResumeCard', () => {
  it('reports not-yet-generated when no card file exists', async () => {
    const book = await seedBook()
    const now = Date.now()
    const bodies = new Map<string, string>()
    for (const chapter of book.chapters) {
      bodies.set(chapter.id, `${chapter.title}，主角继续北上。\n\n${chapter.title}内容。`)
    }
    const chapters: Record<string, unknown> = {}
    for (const id of ['c0001', 'c0002']) {
      const body = bodies.get(id) ?? ''
      const pos = endPosition(body)
      chapters[id] = { ...pos, updatedAt: new Date(now - 48 * 3600_000).toISOString() }
    }
    const frontier = {
      version: 1, legacyConfirmed: true, chapters,
      sessions: [
        { startedAt: new Date(now - 50 * 3600_000).toISOString(), lastActivityAt: new Date(now - 48 * 3600_000).toISOString(), fromChapterId: 'c0001', toChapterId: 'c0001' },
        { startedAt: new Date(now - 20 * 3600_000).toISOString(), lastActivityAt: new Date(now - 10 * 3600_000).toISOString(), fromChapterId: 'c0002', toChapterId: 'c0002' },
      ],
    }
    await writeFile(join(directory, book.id, 'reading-frontier.json'), JSON.stringify(frontier), 'utf-8')
    const view = await readResumeCard(book.id)
    expect(view.available).toBe(true)
    expect(view.stale).toBe(false)
    expect(view.card).toBeNull()
    expect(view.reason).toContain('尚未生成')
  })
})

describe('parseResumeCard', () => {
  const citation: AiCitation = {
    id: 'resume-c0001-0', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '主角出现。',
  }
  const context = {
    sessionEndedAt: '2026-01-01T00:00:00.000Z',
    sourceHash: 'hash',
    chapters: [{ id: 'c0001', title: '第一章' }],
    citations: [citation],
    prompt: '[]',
  }

  it('accepts a valid card with whitelisted citation ids', () => {
    const card = parseResumeCard({
      changes: [{ text: '主角出现了', citationIds: ['resume-c0001-0'] }],
      conflicts: [], questions: [],
    }, context)
    expect(card.changes).toHaveLength(1)
    expect(card.changes[0]!.sources[0]!.id).toBe('resume-c0001-0')
  })

  it('rejects unknown citation ids', () => {
    expect(() => parseResumeCard({
      changes: [{ text: '主角出现了', citationIds: ['unknown-id'] }],
      conflicts: [], questions: [],
    }, context)).toThrow('超出已读原文')
  })

  it('rejects entries without text or citation ids', () => {
    expect(() => parseResumeCard({
      changes: [{ text: '', citationIds: ['resume-c0001-0'] }],
      conflicts: [], questions: [],
    }, context)).toThrow()
    expect(() => parseResumeCard({
      changes: [{ text: '有文字', citationIds: [] }],
      conflicts: [], questions: [],
    }, context)).toThrow()
  })

  it('rejects when all sections are empty', () => {
    expect(() => parseResumeCard({ changes: [], conflicts: [], questions: [] }, context)).toThrow('没有可核验')
  })
})

describe('writeResumeCard', () => {
  it('persists and can be read back', async () => {
    const { id: bookId } = await seedBook()
    const card = {
      generatedAt: new Date().toISOString(), sessionEndedAt: '2026-01-01T00:00:00.000Z',
      sourceHash: 'h', chapters: [{ id: 'c0001', title: '第一章' }],
      changes: [{ text: '变化', sources: [citation()] }],
      conflicts: [], questions: [],
    }
    await writeResumeCard(bookId, card)
    const { readFile } = await import('node:fs/promises')
    const raw = JSON.parse(await readFile(join(directory, bookId, 'ai', 'resume-card.json'), 'utf-8'))
    expect(raw.changes).toHaveLength(1)
  })
})

function citation(): AiCitation {
  return { id: 's1', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '主角出现。' }
}
