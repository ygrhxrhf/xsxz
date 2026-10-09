import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderedParagraphs } from '../shared/aiText'
import { DEFAULT_AI_PREFS, DEFAULT_APPEARANCE_PREFS, DEFAULT_READER_PREFS, DEFAULT_TTS_PREFS, type Settings } from '../shared/types'

const mocks = vi.hoisted(() => ({
  settings: null as Settings | null,
  embeddingKey: '',
}))

vi.mock('./settings', () => ({
  getSettings: async () => mocks.settings,
  getEmbeddingApiKey: async () => mocks.embeddingKey,
  assertTrustedAiEndpoint: () => {},
}))

import { findScenes, semanticStatus, setSemanticEnabled } from './semanticSearch'
import {
  createBookFromBootstrap, markChapterStatus, setLibraryPath, setProgress, writeChapterFile,
} from './library'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

let directory = ''

function baseSettings(): Settings {
  return {
    libraryPath: directory, baseUrl: 'https://api.deepseek.com/v1', model: 'test', apiKeyConfigured: true,
    tierSenseKeyConfigured: false,
    reader: DEFAULT_READER_PREFS, tts: DEFAULT_TTS_PREFS, appearance: DEFAULT_APPEARANCE_PREFS,
    ai: { ...DEFAULT_AI_PREFS }, downloadPace: 'standard',
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'spbf-semantic-'))
  await setLibraryPath(directory)
  mocks.settings = baseSettings()
  mocks.embeddingKey = ''
})

afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function seedBook(): Promise<string> {
  const book = await createBookFromBootstrap({
    bookId: 'i_semantic', title: '语义测试', author: '', importType: 'txt',
    chapterTitles: ['第一章', '第二章'],
  })
  for (const chapter of book.chapters) {
    await writeChapterFile(book.id, chapter.id, {
      title: chapter.title, body: `${chapter.title}，主角继续北上。\n\n${chapter.title}内容。`, status: 'ready',
    })
    await markChapterStatus(book.id, chapter.id, 'ready')
  }
  await setProgress(book.id, { chapterId: 'c0001', scrollRatio: 1, updatedAt: '2026-01-01T00:00:00.000Z' })
  return book.id
}

describe('findScenes', () => {
  it('falls back to local mode when semantic is not enabled', async () => {
    const bookId = await seedBook()
    const result = await findScenes(bookId, '主角')
    expect(result.mode).toBe('local')
    expect(result.message).toContain('语义索引未开启')
  })

  it('throws for empty question', async () => {
    const bookId = await seedBook()
    await expect(findScenes(bookId, '')).rejects.toThrow()
  })

  it('throws for question exceeding 500 characters', async () => {
    const bookId = await seedBook()
    await expect(findScenes(bookId, 'a'.repeat(501))).rejects.toThrow('500')
  })

  it('throws when there is no reading progress', async () => {
    const book = await createBookFromBootstrap({
      bookId: 'i_noprog', title: '无进度', author: '', importType: 'txt', chapterTitles: ['第一章'],
    })
    await expect(findScenes(book.id, '问题')).rejects.toThrow('阅读进度')
  })
})

describe('semanticStatus', () => {
  it('reports disabled with a helpful message when embedding is not configured', async () => {
    const bookId = await seedBook()
    const status = await semanticStatus(bookId)
    expect(status.enabled).toBe(false)
    expect(status.message).toContain('向量服务尚未配置')
  })
})

describe('setSemanticEnabled', () => {
  it('throws when enabling without embedding configuration', async () => {
    const bookId = await seedBook()
    await expect(setSemanticEnabled(bookId, true)).rejects.toThrow('向量服务')
  })

  it('writes disabled setting without requiring embedding config', async () => {
    const bookId = await seedBook()
    await setSemanticEnabled(bookId, false)
    const status = await semanticStatus(bookId)
    expect(status.enabled).toBe(false)
  })
})
