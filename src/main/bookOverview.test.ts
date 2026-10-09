import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_PREFS, DEFAULT_APPEARANCE_PREFS, DEFAULT_READER_PREFS, DEFAULT_TTS_PREFS, type Settings } from '../shared/types'

const mocks = vi.hoisted(() => ({ complete: vi.fn(), settings: null as Settings | null }))

vi.mock('./settings', () => ({
  getSettings: async () => mocks.settings,
  getApiKey: async () => 'test-key',
  assertTrustedAiEndpoint: () => {},
  resolveEffectiveAiProvider: () => 'deepseek',
}))
vi.mock('./ai', async (original) => {
  const actual = await original<typeof import('./ai')>()
  return { ...actual, runAiTaskCompletion: mocks.complete }
})

import { AiQueue } from './aiScheduler'
import { BookOverviewService } from './bookOverview'
import { createBookFromBootstrap, listBooks, markChapterStatus, readAiUsage, setLibraryPath, updateChapterBody, writeChapterFile, refreshBookStatus } from './library'

let directory = ''
let service: BookOverviewService

async function view() {
  const [item] = await service.decorate(await listBooks(), mocks.settings!)
  return item!.overview!
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'spbf-overview-'))
  await setLibraryPath(directory)
  mocks.settings = {
    libraryPath: directory, baseUrl: 'https://api.deepseek.com/v1', model: 'test', apiKeyConfigured: true,
    tierSenseKeyConfigured: false,
    reader: DEFAULT_READER_PREFS, tts: DEFAULT_TTS_PREFS, appearance: DEFAULT_APPEARANCE_PREFS,
    ai: { ...DEFAULT_AI_PREFS, autoBookOverview: true }, downloadPace: 'standard',
  }
  mocks.complete.mockReset().mockResolvedValue({ text: '主角寻宝，最终归来。', truncated: false, usage: { inputTokens: 9, outputTokens: 5 } })
  service = new BookOverviewService(new AiQueue(), () => {})
})

afterEach(async () => {
  service.stop()
  await rm(directory, { recursive: true, force: true })
})

async function seed(): Promise<string> {
  const book = await createBookFromBootstrap({
    bookId: 'i_overview', title: '测试书', author: '', importType: 'txt', chapterTitles: ['第一章', '第二章'],
  })
  for (const chapter of book.chapters) {
    await writeChapterFile(book.id, chapter.id, { title: chapter.title, body: `${chapter.title}，主角出发。`, status: 'ready' })
    await markChapterStatus(book.id, chapter.id, 'ready')
  }
  await refreshBookStatus(book.id)
  return book.id
}

describe('automatic full-book overview', () => {
  it('summarizes every chapter, persists the result, and avoids duplicate calls after restart', async () => {
    const bookId = await seed()
    service.start()
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') })
    expect(mocks.complete).toHaveBeenCalledTimes(3)
    const file = JSON.parse(await readFile(join(directory, bookId, 'ai', 'bookOverview.json'), 'utf-8'))
    expect(Object.keys(file.chapterSummaries)).toEqual(['c0001', 'c0002'])
    expect((await readAiUsage(bookId)).calls).toBe(3)
    service.stop()
    service = new BookOverviewService(new AiQueue(), () => {})
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.complete).toHaveBeenCalledTimes(3)
  })

  it('keeps the old overview visible and regenerates only changed chapter summaries', async () => {
    const bookId = await seed()
    service.start()
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') })
    service.stop()
    await updateChapterBody(bookId, 'c0002', '第二章，主角改变了目标。')
    expect((await view()).status).toBe('stale')
    expect((await view()).text).toContain('主角寻宝')
    service = new BookOverviewService(new AiQueue(), () => {})
    service.start()
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') })
    expect(mocks.complete).toHaveBeenCalledTimes(5)
  })

  it('does not call the model until the user enables automatic generation', async () => {
    await seed()
    mocks.settings!.ai = { ...DEFAULT_AI_PREFS, autoBookOverview: false }
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.complete).not.toHaveBeenCalled()
    expect((await view()).status).toBe('off')
    mocks.settings!.ai = { ...DEFAULT_AI_PREFS, autoBookOverview: true }
    service.settingsChanged(true)
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') })
  })

  it('waits for all chapters to be ready', async () => {
    await createBookFromBootstrap({ bookId: 'i_partial', title: '未完成', author: '', importType: 'txt', chapterTitles: ['第一章'] })
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await view()).status).toBe('waiting')
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('waits for an API Key without sending book content', async () => {
    await seed()
    mocks.settings!.apiKeyConfigured = false
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await view()).message).toBe('等待配置 API Key')
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('preserves a failure and resumes after an explicit retry', async () => {
    const bookId = await seed()
    mocks.complete.mockRejectedValueOnce(new Error('服务暂不可用'))
    service.start()
    await vi.waitFor(async () => { expect((await view()).status).toBe('failed') })
    expect((await view()).message).toContain('服务暂不可用')
    await service.retry(bookId)
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') })
  })
})
