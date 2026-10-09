import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderedParagraphs } from '../shared/aiText'
import type { AiMemoryFile } from '../shared/types'
import { syncTimeline, timelineView } from './aiTimeline'
import {
  createBookFromBootstrap, markChapterStatus, readAiMemory, setLibraryPath, writeAiMemory,
  writeChapterFile,
} from './library'
import { markReadFrontier } from './readFrontier'

const sha = (body: string) => createHash('sha256').update(body).digest('hex')

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'spbf-timeline-'))
  await setLibraryPath(directory)
})

afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

const EXCERPT_SUFFIX = '，一路风餐露宿跋山涉水历经千辛万苦不畏艰难险阻日夜兼程前行穿越了无数山川河流走过了漫漫长路终于看到了远方的那道曙光胜利就在眼前使命终将完成。'

async function seedBook() {
  const book = await createBookFromBootstrap({
    bookId: 'i_timeline', title: '时间线测试', author: '', importType: 'txt',
    chapterTitles: ['第一章', '第二章'],
  })
  for (const chapter of book.chapters) {
    await writeChapterFile(book.id, chapter.id, {
      title: chapter.title, body: `${chapter.title}，主角继续北上${EXCERPT_SUFFIX}\n\n${chapter.title}内容。`, status: 'ready',
    })
    await markChapterStatus(book.id, chapter.id, 'ready')
  }
  return book
}

async function markFullyRead(bookId: string, chapterId: string, body: string) {
  const paragraphs = renderedParagraphs(body)
  await markReadFrontier(bookId, chapterId, paragraphs.length - 1, paragraphs.at(-1)!.length)
}

function memoryWithCharacter(): AiMemoryFile {
  return {
    version: 1, updatedAt: '2026-01-01T00:00:00.000Z', uptoChapterId: 'c0001',
    characters: [{
      id: 'ch1', name: '主角', aliases: [], role: '旅人', status: '北上中',
      summary: '继续北上', accuracy: 'normal', updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [{ id: 's1', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: `第一章，主角继续北上${EXCERPT_SUFFIX}` }],
    }],
    relations: [], foreshadows: [], events: [],
  }
}

describe('syncTimeline', () => {
  it('creates timeline entries from memory for fully-read chapters', async () => {
    const book = await seedBook()
    const body = `第一章，主角继续北上${EXCERPT_SUFFIX}\n\n第一章内容。`
    await markFullyRead(book.id, 'c0001', body)
    const memory = memoryWithCharacter()
    await syncTimeline(book.id, null, memory)
    const view = await timelineView(book.id)
    const entries = view.entries.filter((entry) => entry.phase !== '当前状态')
    expect(entries.length).toBeGreaterThanOrEqual(1)
    const charEntry = entries.find((entry) => entry.name === '主角')
    expect(charEntry).toBeDefined()
    expect(charEntry!.phase).toBe('出现')
    expect(charEntry!.kind).toBe('character')
  })

  it('marks entries as changed when state differs from prior memory', async () => {
    const book = await seedBook()
    const body = `第一章，主角继续北上${EXCERPT_SUFFIX}\n\n第一章内容。`
    await markFullyRead(book.id, 'c0001', body)
    const prior = memoryWithCharacter()
    await syncTimeline(book.id, null, prior)
    const updated: AiMemoryFile = {
      ...prior,
      characters: [{ ...prior.characters[0]!, status: '已到达', summary: '到达目的地' }],
    }
    await syncTimeline(book.id, prior, updated)
    const view = await timelineView(book.id)
    const phases = view.entries.filter((entry) => entry.name === '主角' && entry.phase !== '当前状态').map((entry) => entry.phase)
    expect(phases).toContain('出现')
    expect(phases).toContain('变化')
  })

  it('rebuilds from a specific chapter when fromChapterId is given', async () => {
    const book = await seedBook()
    const body1 = `第一章，主角继续北上${EXCERPT_SUFFIX}\n\n第一章内容。`
    const body2 = `第二章，主角继续北上${EXCERPT_SUFFIX}\n\n第二章内容。`
    await markFullyRead(book.id, 'c0001', body1)
    await markFullyRead(book.id, 'c0002', body2)
    const excerpt2 = `第二章，主角继续北上${EXCERPT_SUFFIX}`
    const initial: AiMemoryFile = {
      version: 1, updatedAt: '', uptoChapterId: 'c0002',
      characters: [{
        id: 'ch1', name: '主角', aliases: [], role: '', status: '北上', summary: '旅行',
        accuracy: 'normal', updatedAt: '',
        sources: [{ id: 's2', chapterId: 'c0002', chapterTitle: '第二章', paragraphIndex: 0, excerpt: excerpt2 }],
      }],
      relations: [], foreshadows: [], events: [],
    }
    await syncTimeline(book.id, null, initial)
    const updated: AiMemoryFile = {
      ...initial,
      characters: [{ ...initial.characters[0]!, status: '已到', summary: '完成' }],
    }
    await syncTimeline(book.id, initial, updated, 'c0002')
    const view = await timelineView(book.id)
    const charEntries = view.entries.filter((entry) => entry.name === '主角' && entry.phase !== '当前状态')
    expect(charEntries.some((entry) => entry.phase === '变化' && entry.source.chapterId === 'c0002')).toBe(true)
  })
})

describe('timelineView', () => {
  it('shows stale flag when a source chapter is no longer fully read', async () => {
    const book = await seedBook()
    const body = `第一章，主角继续北上${EXCERPT_SUFFIX}\n\n第一章内容。`
    await markFullyRead(book.id, 'c0001', body)
    await syncTimeline(book.id, null, memoryWithCharacter())
    const view = await timelineView(book.id)
    expect(view.stale).toBe(false)
    expect(view.entries.length).toBeGreaterThan(0)
  })

  it('returns a helpful message when there are no entries', async () => {
    const { id: bookId } = await seedBook()
    const view = await timelineView(bookId)
    expect(view.entries).toHaveLength(0)
    expect(view.message).toContain('还没有')
  })

  it('includes current state entries from the latest memory', async () => {
    const book = await seedBook()
    const body = `第一章，主角继续北上${EXCERPT_SUFFIX}\n\n第一章内容。`
    await markFullyRead(book.id, 'c0001', body)
    const memory = memoryWithCharacter()
    await writeAiMemory(book.id, memory)
    await syncTimeline(book.id, null, memory)
    const view = await timelineView(book.id)
    const current = view.entries.filter((entry) => entry.phase === '当前状态')
    expect(current.length).toBeGreaterThanOrEqual(1)
    expect(current.some((entry) => entry.name === '主角')).toBe(true)
  })
})
