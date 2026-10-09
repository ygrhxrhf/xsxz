import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderedParagraphs } from '../shared/aiText'
import type { AiCitation, AiMemoryFile } from '../shared/types'
import {
  clipReadBody, confirmLegacyReadRange, getReadFrontier, isFullyRead, markReadFrontier,
  readableCitations, readClippedChapter, visibleMemory,
} from './readFrontier'
import {
  createBookFromBootstrap, markChapterStatus, setLibraryPath, setProgress, writeAiMemory,
  writeChapterFile,
} from './library'

const sha = (body: string) => createHash('sha256').update(body).digest('hex')

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'spbf-frontier-'))
  await setLibraryPath(directory)
})

afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function seedBook(chapters: string[]): Promise<string> {
  const book = await createBookFromBootstrap({
    bookId: 'i_frontier', title: '测试书', author: '', importType: 'txt', chapterTitles: chapters,
  })
  for (const chapter of book.chapters) {
    await writeChapterFile(book.id, chapter.id, {
      title: chapter.title, body: `${chapter.title}，主角继续北上。\n\n${chapter.title}内容。`, status: 'ready',
    })
    await markChapterStatus(book.id, chapter.id, 'ready')
  }
  return book.id
}

describe('clipReadBody', () => {
  const body = '第一段文字。\n\n第二段文字。'

  it('returns empty for undefined position', () => {
    expect(clipReadBody(body, undefined)).toBe('')
  })

  it('returns empty when bodyHash mismatches', () => {
    expect(clipReadBody(body, { paragraphIndex: 0, characterOffset: 3, bodyHash: 'wrong', updatedAt: '' })).toBe('')
  })

  it('clips to the specified paragraph and character offset', () => {
    const paragraphs = renderedParagraphs(body)
    const pos = { paragraphIndex: 1, characterOffset: 3, bodyHash: sha(body), updatedAt: '' }
    const clipped = clipReadBody(body, pos)
    expect(clipped).toBe(`${paragraphs[0]}\n\n${paragraphs[1]!.slice(0, 3)}`)
  })

  it('returns full body when position is at the end', () => {
    const paragraphs = renderedParagraphs(body)
    const lastPara = paragraphs.at(-1)!
    const pos = { paragraphIndex: paragraphs.length - 1, characterOffset: lastPara.length, bodyHash: sha(body), updatedAt: '' }
    expect(clipReadBody(body, pos)).toBe(body)
  })

  it('returns empty for out-of-range paragraph index', () => {
    expect(clipReadBody(body, { paragraphIndex: 99, characterOffset: 0, bodyHash: sha(body), updatedAt: '' })).toBe('')
  })
})

describe('isFullyRead', () => {
  const body = '第一段。\n\n第二段。'

  it('returns false for undefined position', () => { expect(isFullyRead(body, undefined)).toBe(false) })
  it('returns false when bodyHash mismatches', () => {
    expect(isFullyRead(body, { paragraphIndex: 1, characterOffset: 99, bodyHash: 'wrong', updatedAt: '' })).toBe(false)
  })
  it('returns true only at the exact end of the last paragraph', () => {
    const paragraphs = renderedParagraphs(body)
    const end = { paragraphIndex: paragraphs.length - 1, characterOffset: paragraphs.at(-1)!.length, bodyHash: sha(body), updatedAt: '' }
    expect(isFullyRead(body, end)).toBe(true)
  })
  it('returns false for a mid-chapter position', () => {
    expect(isFullyRead(body, { paragraphIndex: 0, characterOffset: 2, bodyHash: sha(body), updatedAt: '' })).toBe(false)
  })
})

describe('markReadFrontier / getReadFrontier', () => {
  it('saves and retrieves a valid read position', async () => {
    const bookId = await seedBook(['第一章', '第二章'])
    const pos = await markReadFrontier(bookId, 'c0001', 0, 3)
    expect(pos.paragraphIndex).toBe(0)
    expect(pos.characterOffset).toBe(3)
    const frontier = await getReadFrontier(bookId)
    expect(frontier.chapters.c0001).toBeDefined()
    expect(frontier.chapters.c0001!.paragraphIndex).toBe(0)
    expect(frontier.legacyConfirmed).toBe(false)
  })

  it('only advances the position monotonically for the same body', async () => {
    const bookId = await seedBook(['第一章'])
    await markReadFrontier(bookId, 'c0001', 1, 4)
    await markReadFrontier(bookId, 'c0001', 0, 2)
    const frontier = await getReadFrontier(bookId)
    expect(frontier.chapters.c0001!.paragraphIndex).toBe(1)
  })

  it('rejects invalid chapter or position', async () => {
    const bookId = await seedBook(['第一章'])
    await expect(markReadFrontier(bookId, 'c9999', 0, 0)).rejects.toThrow()
    await expect(markReadFrontier(bookId, 'c0001', 99, 0)).rejects.toThrow('已读位置无效')
  })

  it('records sessions with 30-minute gap detection', async () => {
    const bookId = await seedBook(['第一章'])
    await markReadFrontier(bookId, 'c0001', 0, 1)
    await markReadFrontier(bookId, 'c0001', 0, 2)
    const frontier = await getReadFrontier(bookId)
    expect(frontier.sessions).toHaveLength(1)
    expect(frontier.sessions[0]!.fromChapterId).toBe('c0001')
  })
})

describe('confirmLegacyReadRange', () => {
  it('converts old progress into confirmed frontier positions', async () => {
    const bookId = await seedBook(['第一章', '第二章', '第三章'])
    await setProgress(bookId, { chapterId: 'c0002', scrollRatio: 0.5, paragraphIndex: 1, paragraphOffset: 3, updatedAt: '2026-01-01T00:00:00.000Z' })
    const result = await confirmLegacyReadRange(bookId)
    expect(result.legacyConfirmed).toBe(true)
    expect(result.legacyProposal).toBeNull()
    expect(result.chapters.c0001).toBeDefined()
    expect(result.chapters.c0002).toBeDefined()
    expect(result.chapters.c0002!.paragraphIndex).toBe(1)
    expect(result.chapters.c0002!.characterOffset).toBe(3)
    expect(result.chapters.c0003).toBeUndefined()
  })

  it('does not overwrite existing farther positions', async () => {
    const bookId = await seedBook(['第一章', '第二章'])
    await markReadFrontier(bookId, 'c0001', 1, renderedParagraphs('第一章，主角继续北上。\n\n第一章内容。').at(-1)!.length)
    await setProgress(bookId, { chapterId: 'c0001', scrollRatio: 0.1, updatedAt: '2026-01-01T00:00:00.000Z' })
    const result = await confirmLegacyReadRange(bookId)
    expect(result.chapters.c0001!.paragraphIndex).toBe(1)
  })
})

describe('readClippedChapter', () => {
  it('returns clipped body and full flag', async () => {
    const bookId = await seedBook(['第一章'])
    await markReadFrontier(bookId, 'c0001', 0, 3)
    const { body, full } = await readClippedChapter(bookId, 'c0001')
    expect(body.length).toBeGreaterThan(0)
    expect(full).toBe(false)
  })
})

describe('readableCitations', () => {
  it('accepts citations within the read range and rejects those outside', async () => {
    const bookId = await seedBook(['第一章', '第二章'])
    await markReadFrontier(bookId, 'c0001', 1, renderedParagraphs('第一章，主角继续北上。\n\n第一章内容。')[1]!.length)
    const inRange: AiCitation = {
      id: 'c1', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '第一章，主角继续北上。',
    }
    const outOfRange: AiCitation = {
      id: 'c2', chapterId: 'c0002', chapterTitle: '第二章', paragraphIndex: 0, excerpt: '第二章，主角继续北上。',
    }
    const wrongExcerpt: AiCitation = {
      id: 'c3', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '不存在的内容',
    }
    const result = await readableCitations(bookId, [inRange, outOfRange, wrongExcerpt])
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('c1')
  })
})

describe('visibleMemory', () => {
  it('filters memory items whose sources fall outside the read range', async () => {
    const bookId = await seedBook(['第一章', '第二章'])
    await markReadFrontier(bookId, 'c0001', 1, renderedParagraphs('第一章，主角继续北上。\n\n第一章内容。')[1]!.length)
    const memory: AiMemoryFile = {
      version: 1, updatedAt: '', uptoChapterId: 'c0001',
      characters: [{
        id: 'ch1', name: '主角', aliases: [], role: '', status: '活跃', summary: '北上',
        accuracy: 'normal', updatedAt: '',
        sources: [{ id: 's1', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '第一章，主角继续北上。' }],
      }, {
        id: 'ch2', name: '配角', aliases: [], role: '', status: '未知', summary: '未出现',
        accuracy: 'normal', updatedAt: '',
        sources: [{ id: 's2', chapterId: 'c0002', chapterTitle: '第二章', paragraphIndex: 0, excerpt: '第二章，主角继续北上。' }],
      }],
      relations: [], foreshadows: [], events: [],
    }
    const result = await visibleMemory(bookId, memory)
    expect(result).not.toBeNull()
    expect(result!.characters).toHaveLength(1)
    expect(result!.characters[0]!.name).toBe('主角')
  })

  it('returns null for null memory', async () => {
    const bookId = await seedBook(['第一章'])
    expect(await visibleMemory(bookId, null)).toBeNull()
  })
})
